import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	collectDownstreamStageNames,
	computeAvailableSlots,
	queryDownstreamCapacity,
	queryDownstreamCapacityForRequest,
	ScanRuntimeApiError,
} from "../../../../../packages/server/src/services/scan/runtime/downstream-capacity";
import {
	queryRunningTasks,
	queryRunningTasksForRequest,
} from "../../../../../packages/server/src/services/scan/runtime/running-tasks";
import {
	issueScanRuntimeToken,
	parseBearerToken,
	verifyScanRuntimeToken,
} from "../../../../../packages/server/src/services/scan/runtime/scan-runtime-api-auth";

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
		{ id: "orchestrator", concurrency: 1 },
		{ id: "hunter", concurrency: 8 },
		{ id: "verify-finding", concurrency: 1 },
		{ id: "triage-finding", concurrency: 1 },
	],
	edges: [
		{ from: "orchestrator", to: "hunter" },
		{ from: "hunter", to: "orchestrator" },
		{ from: "orchestrator", to: "verify-finding" },
		{ from: "verify-finding", to: "triage-finding" },
	],
};

const depsForOrch = (overrides?: {
	active?: Record<string, number>;
	disabled?: string[];
	concurrency?: Record<string, number>;
}) => ({
	findTaskById: async () => ({
		taskId: "orch-task",
		scanJobId: "job-1",
		stageName: "orchestrator",
	}),
	findScanJobById: async () => ({
		scanJobId: "job-1",
		pipelineCompiledSnapshot: orchHuntSnapshot,
	}),
	resolveConcurrency: async (_job: string, stageName: string, fallback: number) =>
		overrides?.concurrency?.[stageName] ?? fallback,
	countActiveTasks: async (_job: string, stageName: string) =>
		overrides?.active?.[stageName] ?? 0,
	isStageActive: async (_job: string, stageName: string) =>
		!(overrides?.disabled ?? []).includes(stageName),
	now: () => "2026-08-23T00:00:00.000Z",
});

describe("downstream capacity math", () => {
	it("lists unique outgoing stages in edge order", () => {
		expect(
			collectDownstreamStageNames(orchHuntSnapshot.edges, "orchestrator"),
		).toEqual(["hunter", "verify-finding"]);
		expect(
			collectDownstreamStageNames(orchHuntSnapshot.edges, "hunter"),
		).toEqual(["orchestrator"]);
		expect(
			collectDownstreamStageNames(orchHuntSnapshot.edges, "triage-finding"),
		).toEqual([]);
	});

	it("never returns negative slots", () => {
		expect(computeAvailableSlots(8, 3)).toBe(5);
		expect(computeAvailableSlots(8, 8)).toBe(0);
		expect(computeAvailableSlots(8, 11)).toBe(0);
	});
});

describe("HMAC runtime token", () => {
	it("accepts a job-scoped token and rejects mismatches", () => {
		const secret = "test-runtime-secret";
		const token = issueScanRuntimeToken("job-1", secret);
		expect(token).toBe(
			createHmac("sha256", secret).update("job-1").digest("hex"),
		);
		expect(
			verifyScanRuntimeToken({ scanJobId: "job-1", token, secret }),
		).toBe(true);
		expect(
			verifyScanRuntimeToken({
				scanJobId: "job-2",
				token,
				secret,
			}),
		).toBe(false);
		expect(
			verifyScanRuntimeToken({
				scanJobId: "job-1",
				token: "00",
				secret,
			}),
		).toBe(false);
		expect(parseBearerToken("Bearer abc")).toBe("abc");
		expect(parseBearerToken("basic abc")).toBeNull();
	});
});

describe("queryDownstreamCapacity", () => {
	it("reports hunter and verify slots for orchestrator", async () => {
		const result = await queryDownstreamCapacity({
			scanJobId: "job-1",
			taskId: "orch-task",
			deps: depsForOrch({ active: { hunter: 3, "verify-finding": 0 } }),
		});
		expect(result).toEqual({
			ok: true,
			scanJobId: "job-1",
			currentStage: "orchestrator",
			generatedAt: "2026-08-23T00:00:00.000Z",
			stages: [
				{
					stageName: "hunter",
					concurrency: 8,
					activeTasks: 3,
					availableSlots: 5,
				},
				{
					stageName: "verify-finding",
					concurrency: 1,
					activeTasks: 0,
					availableSlots: 1,
				},
			],
		});
	});

	it("filters to --to-stage hunter", async () => {
		const result = await queryDownstreamCapacity({
			scanJobId: "job-1",
			taskId: "orch-task",
			toStage: "hunter",
			deps: depsForOrch({ active: { hunter: 3 } }),
		});
		expect(result.stages.map((stage) => stage.stageName)).toEqual(["hunter"]);
		expect(result.stages[0]?.availableSlots).toBe(5);
	});

	it("returns 0 slots for a disabled downstream stage", async () => {
		const result = await queryDownstreamCapacity({
			scanJobId: "job-1",
			taskId: "orch-task",
			toStage: "hunter",
			deps: depsForOrch({ active: { hunter: 0 }, disabled: ["hunter"] }),
		});
		expect(result.stages[0]?.availableSlots).toBe(0);
	});

	it("rejects a task from another job", async () => {
		await expect(
			queryDownstreamCapacity({
				scanJobId: "job-1",
				taskId: "other",
				deps: {
					...depsForOrch(),
					findTaskById: async () => ({
						taskId: "other",
						scanJobId: "job-2",
						stageName: "orchestrator",
					}),
				},
			}),
		).rejects.toMatchObject({ status: 403 });
	});
});

describe("queryDownstreamCapacityForRequest", () => {
	it("requires a valid bearer token bound to the job", async () => {
		const secret = "test-runtime-secret";
		const token = issueScanRuntimeToken("job-1", secret);
		const deps = depsForOrch({ active: { hunter: 3 } });
		const result = await queryDownstreamCapacityForRequest({
			authorization: `Bearer ${token}`,
			scanJobId: "job-1",
			taskId: "orch-task",
			toStage: "hunter",
			deps,
			verifyToken: (input) =>
				verifyScanRuntimeToken({ ...input, secret }),
		});
		expect(result.stages[0]?.availableSlots).toBe(5);

		await expect(
			queryDownstreamCapacityForRequest({
				authorization: "Bearer no",
				scanJobId: "job-1",
				taskId: "orch-task",
				deps,
				verifyToken: (input) =>
					verifyScanRuntimeToken({ ...input, secret }),
			}),
		).rejects.toBeInstanceOf(ScanRuntimeApiError);
	});

	it("returns 404 for an unknown toStage", async () => {
		await expect(
			queryDownstreamCapacity({
				scanJobId: "job-1",
				taskId: "orch-task",
				toStage: "scan-target",
				deps: depsForOrch(),
			}),
		).rejects.toMatchObject({ status: 404 });
	});
});

describe("queryRunningTasks", () => {
	const runningTasks = [
		{
			taskId: "hunter-1",
			stageName: "hunter",
			title: "Hunt REST routes",
			status: "running" as const,
			startedAt: "2026-08-23T00:00:00.000Z",
			updatedAt: "2026-08-23T00:01:00.000Z",
		},
	];

	it("returns active tasks for any defined stage", async () => {
		const result = await queryRunningTasks({
			scanJobId: "job-1",
			taskId: "orch-task",
			stageName: "hunter",
			deps: {
				...depsForOrch(),
				listRunningTasks: async ({ stageName }) =>
					stageName === "hunter" ? runningTasks : [],
				now: () => "2026-08-23T00:02:00.000Z",
			},
		});
		expect(result).toEqual({
			ok: true,
			scanJobId: "job-1",
			currentStage: "orchestrator",
			stageName: "hunter",
			generatedAt: "2026-08-23T00:02:00.000Z",
			tasks: runningTasks,
		});

		const otherStage = await queryRunningTasks({
			scanJobId: "job-1",
			taskId: "orch-task",
			stageName: "verify-finding",
			deps: {
				...depsForOrch(),
				listRunningTasks: async () => [],
			},
		});
		expect(otherStage.tasks).toEqual([]);
	});

	it("rejects an undefined stage and a task from another job", async () => {
		await expect(
			queryRunningTasks({
				scanJobId: "job-1",
				taskId: "orch-task",
				stageName: "missing-stage",
				deps: depsForOrch(),
			}),
		).rejects.toMatchObject({ status: 404 });

		await expect(
			queryRunningTasks({
				scanJobId: "job-1",
				taskId: "other",
				stageName: "hunter",
				deps: {
					...depsForOrch(),
					findTaskById: async () => ({
						taskId: "other",
						scanJobId: "job-2",
						stageName: "orchestrator",
					}),
				},
			}),
		).rejects.toMatchObject({ status: 403 });
	});

	it("requires a valid job-scoped token", async () => {
		const secret = "test-runtime-secret";
		const token = issueScanRuntimeToken("job-1", secret);
		const result = await queryRunningTasksForRequest({
			authorization: `Bearer ${token}`,
			scanJobId: "job-1",
			taskId: "orch-task",
			stageName: "hunter",
			deps: {
				...depsForOrch(),
				listRunningTasks: async () => runningTasks,
			},
			verifyToken: (input) =>
				verifyScanRuntimeToken({ ...input, secret }),
		});
		expect(result.tasks).toEqual(runningTasks);

		await expect(
			queryRunningTasksForRequest({
				authorization: "Bearer invalid",
				scanJobId: "job-1",
				taskId: "orch-task",
				stageName: "hunter",
				verifyToken: (input) =>
					verifyScanRuntimeToken({ ...input, secret }),
			}),
		).rejects.toBeInstanceOf(ScanRuntimeApiError);
	});
});
