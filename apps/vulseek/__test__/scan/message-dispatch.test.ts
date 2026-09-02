import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeTaskJobOutput } from "../../../../packages/server/src/services/scan/artifacts/job-output-artifacts";
import { buildCandidateResultPatch } from "../../../../packages/server/src/services/scan/persistence/candidate-result";
import {
	computeScanJobSettlement,
	createMemoryMessageStore,
	nextClaimableMessages,
	type MemoryTaskRecord,
	type MessageRecord,
} from "../../../../packages/server/src/services/scan/persistence/message-store";
import {
	syncVulnerabilityCandidatesFromMessageWithDeps,
	type PersistedVulnerabilityCandidateInput,
} from "../../../../packages/server/src/services/scan/persistence/candidate-sync";
import {
	createDownstreamChildIdentity,
	dispatchClaimedMessage,
	settleCompletedAgentTask,
	stampUnstampedResearchFindings,
} from "../../../../packages/server/src/services/scan/pipeline/message-dispatch";
import type { Task } from "../../../../packages/server/src/services/scan/types";
import { createTaskIdForSource } from "../../../../packages/server/src/services/scan/task-id";

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
	threadId: null,
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

const candidate = (id: string) => ({
	id,
	functionId: "fn",
	title: id,
	description: id,
	filePath: "a.ts",
	line: 1,
	vulnerabilityType: "xss",
	confidence: 0.9,
	score: 9,
	claim: id,
	rootCauseKey: id,
	evidence: [],
	attackerControl: "q",
	affectedSink: "innerHTML",
	preconditions: [],
	quickDisproofAttempt: "n",
	needsFuzzing: false,
	needsManualAnalysis: true,
});

describe("Message dispatch rules", () => {
	it("dispatches one Task's outputs in sequence and different Tasks concurrently", () => {
		const pending = [
			{ sourceTaskId: "a", sequence: 2, messageId: "a2" },
			{ sourceTaskId: "b", sequence: 1, messageId: "b1" },
			{ sourceTaskId: "a", sequence: 1, messageId: "a1" },
		];
		const firstWave = nextClaimableMessages(pending, []);
		expect(firstWave.map((item) => item.messageId)).toEqual(["a1", "b1"]);
		const secondWave = nextClaimableMessages(pending, ["a", "b"]);
		expect(secondWave).toEqual([]);
		const afterACompleted = nextClaimableMessages(
			pending.filter((item) => item.messageId !== "a1"),
			["b"],
		);
		expect(afterACompleted.map((item) => item.messageId)).toEqual(["a2"]);
	});

	it("skips a Task while an earlier output is still processing", () => {
		const pending = [
			{ sourceTaskId: "a", sequence: 2, messageId: "a2" },
			{ sourceTaskId: "b", sequence: 1, messageId: "b1" },
		];
		expect(
			nextClaimableMessages(pending, ["a"]).map((item) => item.messageId),
		).toEqual(["b1"]);
	});

	it("claims every pending output from a poll producer in one wave", () => {
		const pending = [
			{ sourceTaskId: "orch", sequence: 3, messageId: "o3" },
			{ sourceTaskId: "hunter", sequence: 1, messageId: "h1" },
			{ sourceTaskId: "orch", sequence: 1, messageId: "o1" },
			{ sourceTaskId: "orch", sequence: 2, messageId: "o2" },
			{ sourceTaskId: "hunter", sequence: 2, messageId: "h2" },
		];
		expect(
			nextClaimableMessages(pending, ["orch"], {
				allowMultipleSourceTaskIds: ["orch"],
			}).map((item) => item.messageId),
		).toEqual(["h1", "o1", "o2", "o3"]);
	});

	it("pause retains pending outputs and claim only runs while the Job is running", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask()],
		});
		await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k1",
			routeKey: "hunt",
			payload: { huntTasks: ["one"] },
		});
		store.pauseJob("job-1");
		expect(store.outputs[0]?.status).toBe("pending");
		expect(await store.claimNext("job-1")).toEqual([]);
		store.jobs.get("job-1")!.status = "running";
		const claimed = await store.claimNext("job-1");
		expect(claimed.map((row) => row.sequence)).toEqual([1]);
	});

	it("cancel/termination closes pending and processing outputs", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask()],
		});
		await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k1",
			routeKey: "hunt",
			payload: { huntTasks: ["one"] },
		});
		await store.claimNext("job-1");
		await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k2",
			routeKey: "hunt",
			payload: { huntTasks: ["two"] },
		});
		const closed = store.cancelJob("job-1");
		expect(closed).toBe(2);
		expect(
			store.outputs.every((row) => row.status === "failed"),
		).toBe(true);
	});

	it("reuses child identity instead of creating a duplicate", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask()],
		});
		const created = await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k1",
			routeKey: "hunt",
			payload: { huntTasks: ["one"] },
		});
		const identity = createDownstreamChildIdentity({
			sourceMessageId: created.record.messageId,
			sourceEdgeName: "dispatch-hunters",
			sourceItemIndex: 0,
		});
		const upsert = () => {
			const existing = [...store.tasks.values()].find(
				(task) =>
					task.sourceMessageId === identity.sourceMessageId &&
					task.sourceEdgeName === identity.sourceEdgeName &&
					task.sourceItemIndex === identity.sourceItemIndex &&
					!task.rerunOfTaskId,
			);
			if (existing) {
				return existing;
			}
			return store.createChild({
				scanJobId: "job-1",
				stageName: "hunter",
				...identity,
			});
		};
		const first = upsert();
		const second = upsert();
		expect(first.taskId).toBe(second.taskId);
		expect(first.taskId).toBe(identity.taskId);
		expect(first.taskId).toBe(createTaskIdForSource(identity));
		expect(
			[...store.tasks.values()].filter((task) => task.stageName === "hunter"),
		).toHaveLength(1);
	});

	it("keeps accepted outputs after the producer later fails", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask()],
		});
		const created = await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k1",
			routeKey: "hunt",
			payload: { huntTasks: ["one"] },
		});
		created.record.status = "completed";
		store.failProducer("orch-1");
		expect(store.tasks.get("orch-1")?.status).toBe("failed");
		expect(store.outputs[0]?.status).toBe("completed");
		expect(
			computeScanJobSettlement({
				tasks: [...store.tasks.values()],
				outputs: store.outputs,
			}).unsettledDispatchCount,
		).toBe(0);
	});

	it("assigns unique increasing sequences under concurrent inserts", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask()],
		});
		const results = await Promise.all(
			["a", "b", "c", "d"].map((key) =>
				store.insertPending({
					sourceTaskId: "orch-1",
					submissionKey: key,
					routeKey: "hunt",
					payload: { huntTasks: [key] },
				}),
			),
		);
		const sequences = results
			.map((result) => result.record.sequence)
			.sort((left, right) => left - right);
		expect(sequences).toEqual([1, 2, 3, 4]);
		expect(new Set(results.map((result) => result.record.messageId)).size).toBe(
			4,
		);
	});

	it("fails a normal ACP completion when the Task has 0 Message rows", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask({ lifecycle: "turn", status: "running" })],
		});
		const persistTerminalFailure = async (error: Error) => {
			const task = store.tasks.get("orch-1");
			if (
				!task ||
				(task.status !== "launching" &&
					task.status !== "starting" &&
					task.status !== "running")
			) {
				return false;
			}
			task.status = "failed";
			(task as MemoryTaskRecord & { errorMessage?: string }).errorMessage =
				error.message;
			return true;
		};
		const persistTerminalSuccess = async () => {
			store.tasks.get("orch-1")!.status = "completed";
			return true;
		};
		const settlement = await settleCompletedAgentTask({
			taskId: "orch-1",
			countMessagesByProducerTaskId: async (taskId) =>
				store.outputs.filter((row) => row.sourceTaskId === taskId).length,
			persistTerminalFailure,
			persistTerminalSuccess,
		});
		expect(settlement.outcome).toBe("protocol-failure");
		expect(store.tasks.get("orch-1")?.status).toBe("failed");
		expect(
			(store.tasks.get("orch-1") as MemoryTaskRecord & { errorMessage?: string })
				.errorMessage,
		).toMatch(/Protocol failure/);
		expect(store.outputs).toHaveLength(0);

		await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k1",
			routeKey: null,
			payload: { ok: true },
		});
		store.tasks.get("orch-1")!.status = "running";
		const withOutput = await settleCompletedAgentTask({
			taskId: "orch-1",
			countMessagesByProducerTaskId: async (taskId) =>
				store.outputs.filter((row) => row.sourceTaskId === taskId).length,
			persistTerminalFailure,
			persistTerminalSuccess,
		});
		expect(withOutput.outcome).toBe("completed");
		expect(store.tasks.get("orch-1")?.status).toBe("completed");
	});

	it("creates further children from a second Goal output while the Goal stays running", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask()],
		});
		const dispatch = async (output: MessageRecord) =>
			dispatchClaimedMessage({
				output,
				findTaskById: async (taskId) => {
					const task = store.tasks.get(taskId);
					if (!task) {
						throw new Error(`missing task ${taskId}`);
					}
					return task;
				},
				createDownstreamTasks: async ({ producerTask, taskOutput }) => {
					const huntTasks =
						taskOutput.payload &&
						typeof taskOutput.payload === "object" &&
						"huntTasks" in taskOutput.payload &&
						Array.isArray(taskOutput.payload.huntTasks)
							? taskOutput.payload.huntTasks
							: [];
					const childIds: string[] = [];
					for (const [sourceItemIndex] of huntTasks.entries()) {
						const identity = createDownstreamChildIdentity({
							sourceMessageId: taskOutput.messageId,
							sourceEdgeName: "dispatch-hunters",
							sourceItemIndex,
						});
						if (!store.tasks.has(identity.taskId)) {
							store.createChild({
								scanJobId: producerTask.scanJobId,
								stageName: "hunter",
								...identity,
							});
						}
						childIds.push(identity.taskId);
					}
					return childIds;
				},
				completeDispatch: async (messageId) => {
					const row = store.outputs.find(
						(item) => item.messageId === messageId,
					);
					if (row) {
						row.status = "completed";
					}
				},
			});

		const first = await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k1",
			routeKey: "hunt",
			payload: { huntTasks: ["alpha"] },
		});
		const [claimedFirst] = await store.claimNext("job-1");
		expect(claimedFirst?.messageId).toBe(first.record.messageId);
		const firstResult = await dispatch(claimedFirst!);
		expect(firstResult.producerStatus).toBe("running");
		expect(firstResult.producerLifecycle).toBe("goal");
		expect(firstResult.childTaskIds).toHaveLength(1);
		expect(store.tasks.get("orch-1")?.status).toBe("running");

		const second = await store.insertPending({
			sourceTaskId: "orch-1",
			submissionKey: "k2",
			routeKey: "hunt",
			payload: { huntTasks: ["beta"] },
		});
		const [claimedSecond] = await store.claimNext("job-1");
		expect(claimedSecond?.messageId).toBe(second.record.messageId);
		const secondResult = await dispatch(claimedSecond!);
		expect(secondResult.childTaskIds).toHaveLength(1);
		expect(secondResult.childTaskIds[0]).not.toBe(firstResult.childTaskIds[0]);
		expect(
			[...store.tasks.values()].filter((task) => task.stageName === "hunter"),
		).toHaveLength(2);
		expect(store.tasks.get("orch-1")?.status).toBe("running");
		expect(store.tasks.get("orch-1")?.lifecycle).toBe("goal");
	});

	it("materializes and appends job output for a dispatched Message", async () => {
		const taskDir = await mkdtemp(path.join(os.tmpdir(), "vulseek-dispatch-job-output-"));
		await writeFile(path.join(taskDir, "report.md"), "# Report");
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [makeTask({ taskId: "report-1", stageName: "report", lifecycle: "turn" })],
		});
		const created = await store.insertPending({
			sourceTaskId: "report-1",
			submissionKey: "k1",
			routeKey: null,
			payload: { reportPath: "/task/report.md" },
		});
		const [claimed] = await store.claimNext("job-1");
		const appended: Array<{ scanJobId: string; output: { messageId: string } }> =
			[];
		const result = await dispatchClaimedMessage({
			output: claimed!,
			findTaskById: async (taskId) => store.tasks.get(taskId)!,
			materializeJobOutput: async (args) =>
				materializeTaskJobOutput({
					taskDir,
					taskId: args.task.taskId,
					messageId: args.messageId,
					stageName: args.task.stageName,
					output: args.output,
				}),
			appendJobOutput: async (args) => {
				appended.push(args);
			},
			createDownstreamTasks: async () => [],
			completeDispatch: async (messageId) => {
				const row = store.outputs.find((item) => item.messageId === messageId);
				if (row) {
					row.status = "completed";
				}
			},
		});
		expect(result.jobOutput).toMatchObject({
			messageId: created.record.messageId,
			stageName: "report",
			artifacts: [{ path: "/task/job-output/report.md" }],
		});
		expect(appended).toEqual([
			{
				scanJobId: "job-1",
				output: result.jobOutput,
			},
		]);
	});

	it("stamps dispatched Message id onto unstamped research findings", async () => {
		const store = createMemoryMessageStore({
			jobs: [{ scanJobId: "job-1", status: "running" }],
			tasks: [
				makeTask({
					taskId: "discovery-1",
					stageName: "discovery",
					lifecycle: "turn",
				}),
			],
		});
		const findings = [
			{
				producerTaskId: "discovery-1",
				messageId: null as string | null,
				findingId: "f-1",
			},
			{
				producerTaskId: "other-1",
				messageId: null as string | null,
				findingId: "f-other",
			},
		];
		await store.insertPending({
			sourceTaskId: "discovery-1",
			submissionKey: "k1",
			routeKey: null,
			payload: { findingIds: ["f-1"] },
		});
		const [claimed] = await store.claimNext("job-1");
		const result = await dispatchClaimedMessage({
			output: claimed!,
			findTaskById: async (taskId) => store.tasks.get(taskId)!,
			stampResearchFindings: async (args) =>
				stampUnstampedResearchFindings(findings, args),
			createDownstreamTasks: async () => [],
			completeDispatch: async (messageId) => {
				const row = store.outputs.find((item) => item.messageId === messageId);
				if (row) {
					row.status = "completed";
				}
			},
		});
		expect(result.stampedFindingCount).toBe(1);
		expect(findings[0]?.messageId).toBe(claimed!.messageId);
		expect(findings[1]?.messageId).toBeNull();
	});

	it("writes candidate result provenance from the dispatched Message id", () => {
		const patch = buildCandidateResultPatch({
			taskId: "verify-1",
			messageId: "to-9",
			stageName: "verify-finding",
			output: { result: "true" },
			resultAt: "2026-08-26T00:00:00.000Z",
		});
		expect(patch).toMatchObject({
			verificationTaskId: "verify-1",
			verificationMessageId: "to-9",
			verificationResult: "true",
		});
	});

	it("does not delete candidates belonging to another Message", async () => {
		const rows = new Map<string, PersistedVulnerabilityCandidateInput>();
		const deletes: Array<{ messageId: string; keepCandidateIds: string[] }> =
			[];
		const task = makeTask({
			taskId: "hunter-1",
			stageName: "hunter",
			lifecycle: "turn",
		});
		const deps = {
			findTaskById: async () => task,
			readTaskJsonArtifact: async () => {
				throw new Error("inline candidates");
			},
			upsertCandidates: async (
				candidates: PersistedVulnerabilityCandidateInput[],
			) => {
				for (const item of candidates) {
					rows.set(
						`${item.messageId}:${item.vulnerabilityCandidateId}`,
						item,
					);
				}
			},
			deleteStaleCandidatesForMessage: async (input: {
				producerTaskId: string;
				messageId: string;
				keepCandidateIds: string[];
			}) => {
				deletes.push(input);
				for (const key of [...rows.keys()]) {
					if (
						key.startsWith(`${input.messageId}:`) &&
						!input.keepCandidateIds.includes(key.slice(input.messageId.length + 1))
					) {
						rows.delete(key);
					}
				}
			},
		};
		await syncVulnerabilityCandidatesFromMessageWithDeps(
			{
				taskId: task.taskId,
				messageId: "to-1",
				output: { candidates: [candidate("c1")] },
			},
			deps,
		);
		await syncVulnerabilityCandidatesFromMessageWithDeps(
			{
				taskId: task.taskId,
				messageId: "to-2",
				output: { candidates: [candidate("c2")] },
			},
			deps,
		);
		expect([...rows.keys()].sort()).toEqual(["to-1:c1", "to-2:c2"]);
		expect(deletes.map((item) => item.messageId)).toEqual(["to-1", "to-2"]);
	});

	it("backfills historical outputs without reading downstreamRouteKey", () => {
		const sql = readFileSync(
			path.resolve(process.cwd(), "drizzle/0238_task_outputs.sql"),
			"utf8",
		);
		expect(sql).not.toMatch(/t\."downstreamRouteKey"/);
		expect(sql).not.toMatch(/p\."downstreamRouteKey"/);
		expect(sql).toMatch(/information_schema\.columns/);
		expect(sql).toMatch(/'legacy:' \|\| t\."taskId"/);
	});
});
