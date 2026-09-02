import { describe, expect, it } from "vitest";
import type { Task } from "../../../../../packages/server/src/services/scan/types";
import { ScanRuntimeApiError } from "../../../../../packages/server/src/services/scan/runtime/scan-runtime-api-error";
import {
	handleMessagesHttp,
	resolveSubmitRouteKey,
	submitMessage,
} from "../../../../../packages/server/src/services/scan/runtime/submit-message";
import {
	issueScanRuntimeToken,
	verifyScanRuntimeToken,
} from "../../../../../packages/server/src/services/scan/runtime/scan-runtime-api-auth";
import { reconstructRootTaskInput, reconstructTaskInput } from "../../../../../packages/server/src/services/scan/runtime/reconstruct-task-input";
import { stableJsonEqual } from "../../../../../packages/server/src/services/scan/runtime/stable-json";
import { createMemoryMessageStore } from "../../../../../packages/server/src/services/scan/persistence/message-store";

const orchHuntSnapshot = {
	version: 3 as const,
	pipelineId: "orch-hunt",
	name: "orchestrator-hunt-programmatic",
	supportedTargets: ["project" as const],
	root: "orchestrator",
	limits: { maxTasks: 10000, maxDurationSeconds: 86400 },
	prepareRepository: "target" as const,
	presentation: { jobTabs: [] },
	schemas: {},
	groups: [],
	stages: [
		{
			id: "orchestrator",
			name: "Orchestrator",
			outputSchema: {
				type: "object",
				required: ["huntTasks"],
				properties: {
					huntTasks: { type: "array" },
				},
				additionalProperties: true,
			},
		},
		{ id: "hunter", name: "Hunter" },
	],
	edges: [
		{
			id: "orch-to-hunt",
			name: "dispatch-hunters",
			from: "orchestrator",
			to: "hunter",
			mode: "fanOut" as const,
			foreach: "$.huntTasks[*]",
			input: { name: "$item.name", goalPrompt: "$item.goalPrompt" },
			route: { key: "hunt", default: true },
		},
	],
} as any;

const makeTask = (overrides?: Partial<Task>): Task => ({
	taskId: "orch-1",
	scanJobId: "job-1",
	name: "Orchestrator",
	stageName: "orchestrator",
	lifecycle: "goal",
	status: "running",
	sourceMessageId: null,
	sourceEdgeName: null,
	sourceItemIndex: null,
	rerunOfTaskId: null,
	priority: null,
	attempt: 0,
	agentProfile: null,
	containerName: null,
	containerIndex: null,
	threadId: "thread-1",
	runtimeMode: "new_session",
	forkedFromTaskId: null,
	stageGroupInstanceId: null,
	inputTokens: null,
	outputTokens: null,
	thoughtTokens: null,
	totalTokens: null,
	cachedReadTokens: null,
	cachedWriteTokens: null,
	estimatedCost: null,
	errorMessage: null,
	startedAt: "2026-08-26T00:00:00.000Z",
	completedAt: null,
	createdAt: "2026-08-26T00:00:00.000Z",
	updatedAt: "2026-08-26T00:00:00.000Z",
	...overrides,
});

const makeOutput = (
	overrides?: Partial<{
		messageId: string;
		payload: unknown;
		sequence: number;
		submissionKey: string;
		routeKey: string | null;
	}>,
) => ({
	messageId: "to-1",
	scanJobId: "job-1",
	sourceTaskId: "orch-1",
	sequence: 1,
	submissionKey: "sub-1",
	routeKey: "hunt",
	payload: { huntTasks: [{ title: "a" }] },
	status: "pending" as const,
	dispatchAttempt: 0,
	claimedAt: null,
	dispatchedAt: null,
	errorMessage: null,
	createdAt: "2026-08-26T00:00:00.000Z",
	updatedAt: "2026-08-26T00:00:00.000Z",
	...overrides,
});

const runtimeSecret = "test-runtime-secret";
const orchTask = () => makeTask();

const createSubmitHarness = () => {
	const task = orchTask();
	const store = createMemoryMessageStore({
		jobs: [{ scanJobId: "job-1", status: "running" }],
		tasks: [task],
	});
	let woken = 0;
	const deps = {
		findTaskById: async (taskId: string) => store.tasks.get(taskId) as Task,
		findScanJobById: async () =>
			({
				scanJobId: "job-1",
				status: store.jobs.get("job-1")?.status ?? "running",
				pipelineCompiledSnapshot: orchHuntSnapshot,
			}) as never,
		insertPending: store.insertPending,
		readArtifact: async (taskRecord: Task, containerPath: string) => {
			throw new Error(`missing artifact: ${containerPath}`);
		},
		wakeJob: (scanJobId: string) => {
			expect(scanJobId).toBe("job-1");
			woken += 1;
		},
	};
	const token = issueScanRuntimeToken("job-1", runtimeSecret);
	const post = (body: unknown, headers?: Record<string, string>) =>
		handleMessagesHttp({
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"x-vulseek-scan-job-id": "job-1",
				"x-vulseek-task-id": task.taskId,
				...headers,
			},
			body,
			deps,
			verifyToken: (input) =>
				verifyScanRuntimeToken({ ...input, secret: runtimeSecret }),
		});
	return { store, task, deps, post, woken: () => woken };
};

describe("submitMessage", () => {
	it("assigns increasing sequence and wakes dispatch via the shipped insert", async () => {
		const harness = createSubmitHarness();
		const first = await submitMessage({
			scanJobId: "job-1",
			taskId: "orch-1",
			output: { huntTasks: [{ title: "one" }] },
			submissionKey: "k1",
			deps: harness.deps,
		});
		const second = await submitMessage({
			scanJobId: "job-1",
			taskId: "orch-1",
			output: { huntTasks: [{ title: "two" }] },
			submissionKey: "k2",
			deps: harness.deps,
		});
		expect(first.message.sequence).toBe(1);
		expect(second.message.sequence).toBe(2);
		expect(first.message.status).toBe("pending");
		expect(harness.woken()).toBe(2);
		expect(harness.store.outputs.map((row) => row.sequence)).toEqual([1, 2]);
		expect(harness.task.lifecycle).toBe("goal");
		expect(harness.task.status).toBe("running");
	});

	it("is idempotent for the same submissionKey and content", async () => {
		const harness = createSubmitHarness();
		const payload = { huntTasks: [{ title: "one" }] };
		const first = await submitMessage({
			scanJobId: "job-1",
			taskId: "orch-1",
			output: payload,
			submissionKey: "k1",
			deps: harness.deps,
		});
		const second = await submitMessage({
			scanJobId: "job-1",
			taskId: "orch-1",
			output: payload,
			submissionKey: "k1",
			deps: harness.deps,
		});
		expect(second.idempotent).toBe(true);
		expect(second.message.messageId).toBe(first.message.messageId);
		expect(harness.woken()).toBe(1);
		expect(harness.store.outputs).toHaveLength(1);
	});

	it("returns 409 when submissionKey is reused with different content", async () => {
		const harness = createSubmitHarness();
		await submitMessage({
			scanJobId: "job-1",
			taskId: "orch-1",
			output: { huntTasks: [{ title: "one" }] },
			submissionKey: "k1",
			deps: harness.deps,
		});
		await expect(
			submitMessage({
				scanJobId: "job-1",
				taskId: "orch-1",
				output: { huntTasks: [{ title: "other" }] },
				submissionKey: "k1",
				deps: harness.deps,
			}),
		).rejects.toMatchObject({ status: 409 } satisfies Partial<ScanRuntimeApiError>);
		expect(harness.store.outputs).toHaveLength(1);
	});

	it("rejects invalid schema, invalid route, and missing artifacts before insert", async () => {
		const harness = createSubmitHarness();
		await expect(
			submitMessage({
				scanJobId: "job-1",
				taskId: "orch-1",
				output: { notHuntTasks: true },
				deps: harness.deps,
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(() =>
			resolveSubmitRouteKey({
				snapshot: orchHuntSnapshot,
				stageName: "orchestrator",
				requestedRouteKey: "nope",
			}),
		).toThrow(/Invalid route key/);

		const artifactSnapshot = {
			...orchHuntSnapshot,
			schemas: {
				Report: {
					type: "object",
					required: ["ok"],
					properties: { ok: { type: "boolean" } },
				},
			},
			stages: [
				{
					...orchHuntSnapshot.stages[0],
					outputSchema: {
						type: "object",
						required: ["report"],
						properties: {
							report: { $pathOf: "#/schemas/Report" },
						},
					},
				},
			],
			edges: [],
		};
		await expect(
			submitMessage({
				scanJobId: "job-1",
				taskId: "orch-1",
				output: { report: "/task/missing.json" },
				deps: {
					...harness.deps,
					findScanJobById: async () =>
						({
							scanJobId: "job-1",
							status: "running",
							pipelineCompiledSnapshot: artifactSnapshot,
						}) as never,
				},
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(harness.store.outputs).toHaveLength(0);
	});

	it("validates array outputs against the data schema", async () => {
		const harness = createSubmitHarness();
		const arraySnapshot = {
			...orchHuntSnapshot,
			stages: [
				{
					...orchHuntSnapshot.stages[0],
					outputSchema: {
						type: "array",
						items: { type: "string" },
					},
				},
			],
			edges: [],
		};
		const deps = {
			...harness.deps,
			findScanJobById: async () =>
				({
					scanJobId: "job-1",
					status: "running",
					pipelineCompiledSnapshot: arraySnapshot,
				}) as never,
		};

		const accepted = await submitMessage({
			scanJobId: "job-1",
			taskId: "orch-1",
			output: [],
			deps,
		});
		expect(accepted.ok).toBe(true);
		await expect(
			submitMessage({
				scanJobId: "job-1",
				taskId: "orch-1",
				output: {},
				deps,
			}),
		).rejects.toMatchObject({ status: 400 });
	});

	it("keeps a Goal Task active after accepted outputs", async () => {
		const harness = createSubmitHarness();
		const result = await submitMessage({
			scanJobId: "job-1",
			taskId: harness.task.taskId,
			output: { huntTasks: [] },
			deps: harness.deps,
		});
		expect(result.ok).toBe(true);
		expect(harness.store.tasks.get("orch-1")?.status).toBe("running");
		expect(harness.store.tasks.get("orch-1")?.lifecycle).toBe("goal");
	});

	it("rejects hunter output whose name does not match the assigned hunt", async () => {
		const harness = createSubmitHarness();
		const hunter = makeTask({
			taskId: "hunt-1",
			stageName: "hunter",
			lifecycle: "goal",
			name: "xmlrpc-unauth",
		});
		harness.store.tasks.set("hunt-1", hunter);
		await expect(
			submitMessage({
				scanJobId: "job-1",
				taskId: "hunt-1",
				output: { name: "other", feedback: "nope" },
				deps: {
					...harness.deps,
					findTaskById: async () => hunter,
					reconstructTaskInput: async () => ({
						name: "xmlrpc-unauth",
						goalPrompt: "look at xmlrpc",
					}),
				},
			}),
		).rejects.toMatchObject({ status: 400 });
	});

});

describe("POST /api/internal/scan/runtime/messages", () => {
	it("inserts with HMAC, increasing sequence, 409, and a second Goal output", async () => {
		const harness = createSubmitHarness();
		const first = await harness.post({
			output: { huntTasks: ["one"] },
			submissionKey: "k1",
			routeKey: "hunt",
		});
		expect(first.status).toBe(201);
		const firstBody = first.body as {
			message: { sequence: number; messageId: string };
			idempotent: boolean;
		};
		expect(firstBody.message.sequence).toBe(1);
		expect(harness.woken()).toBe(1);

		const replay = await harness.post({
			output: { huntTasks: ["one"] },
			submissionKey: "k1",
			routeKey: "hunt",
		});
		expect(replay.status).toBe(200);
		expect((replay.body as { idempotent: boolean }).idempotent).toBe(true);

		const conflict = await harness.post({
			output: { huntTasks: ["other"] },
			submissionKey: "k1",
			routeKey: "hunt",
		});
		expect(conflict.status).toBe(409);

		const second = await harness.post({
			output: { huntTasks: ["two"] },
			submissionKey: "k2",
			routeKey: "hunt",
		});
		expect(second.status).toBe(201);
		expect(
			(second.body as { message: { sequence: number } }).message.sequence,
		).toBe(2);
		expect(harness.store.tasks.get("orch-1")?.status).toBe("running");
		expect(harness.store.outputs).toHaveLength(2);

		const unauthorized = await harness.post(
			{ huntTasks: ["nope"] },
			{ authorization: "Bearer deadbeef" },
		);
		expect(unauthorized.status).toBe(401);

	});
});

describe("reconstructTaskInput", () => {
	it("rebuilds root input from job context", () => {
		const input = reconstructRootTaskInput({
			scanJobId: "job-1",
			title: "WordPress",
			triggerSource: "manual",
			applicationId: "app-1",
			composeId: null,
			datasetEvaluationTrialId: null,
			targetRef: "main",
			targetTag: null,
			commitSha: "abc",
			baseSha: null,
			commitWindow: 3,
			maxTasks: 10,
			deadlineAt: null,
		});
		expect(input.run.scanJobId).toBe("job-1");
		expect(input.target.applicationId).toBe("app-1");
		expect(input.repository.commitSha).toBe("abc");
	});

	it("rebuilds downstream and rerun input from Message + Edge + snapshot", async () => {
		const producer = makeTask();
		const hunter = makeTask({
			taskId: "hunt-1",
			stageName: "hunter",
			lifecycle: "turn",
			sourceMessageId: "to-1",
			sourceEdgeName: "dispatch-hunters",
			sourceItemIndex: 0,
		});
		const rerun = makeTask({
			taskId: "hunt-1-rerun",
			stageName: "hunter",
			rerunOfTaskId: "hunt-1",
			sourceMessageId: "to-1",
			sourceEdgeName: "dispatch-hunters",
			sourceItemIndex: 0,
		});
		const sourceOutput = makeOutput({
			payload: {
				huntTasks: [
					{ name: "auth-bypass", goalPrompt: "auth bypass" },
					{ name: "other", goalPrompt: "other" },
				],
			},
		});
		const reconstructed = await reconstructTaskInput(hunter, {
			findTaskById: async (taskId) => {
				if (taskId === "hunt-1") return hunter;
				return producer;
			},
			findMessageById: async () => sourceOutput,
			findScanJobById: async () =>
				({
					scanJobId: "job-1",
					pipelineCompiledSnapshot: orchHuntSnapshot,
				}) as never,
		});
		expect(reconstructed).toEqual({
			name: "auth-bypass",
			goalPrompt: "auth bypass",
		});
		const rerunInput = await reconstructTaskInput(rerun, {
			findTaskById: async (taskId) => {
				if (taskId === "hunt-1-rerun") return rerun;
				if (taskId === "hunt-1") return hunter;
				return producer;
			},
			findMessageById: async () => sourceOutput,
			findScanJobById: async () =>
				({
					scanJobId: "job-1",
					pipelineCompiledSnapshot: orchHuntSnapshot,
				}) as never,
		});
		expect(rerunInput).toEqual({
			name: "auth-bypass",
			goalPrompt: "auth bypass",
		});
	});
});

describe("stableJsonEqual", () => {
	it("treats key order as insignificant", () => {
		expect(stableJsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(stableJsonEqual({ a: 1 }, { a: 2 })).toBe(false);
	});
});
