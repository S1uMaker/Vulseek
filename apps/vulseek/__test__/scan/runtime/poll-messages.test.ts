import { describe, expect, it } from "vitest";
import {
	appendPollInputPrompt,
	shouldRemoveStageQueueJob,
} from "../../../../../packages/server/src/services/scan/pipeline/stage-input-delivery";
import {
	asWaitingMessageQueueJob,
	listAllQueueJobs,
	parseStageQueueJob,
	shouldLaunchStageTask,
} from "../../../../../packages/server/src/services/scan/pipeline/message-queue";
import {
	completeMessages,
	pollMessages,
	queryMessages,
} from "../../../../../packages/server/src/services/scan/runtime/poll-messages";

const snapshot = {
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
	],
	edges: [
		{ from: "orchestrator", to: "hunter" },
		{ from: "hunter", to: "orchestrator" },
	],
};

const queuedHunterFollowUp = {
	messageId: "to-hunter-1",
	edgeName: "hunter-to-orchestrator",
	itemIndex: 0,
	createdAt: "2026-08-28T00:00:00.000Z",
	remove: async () => {},
};

describe("stage queue job payload", () => {
	it("parses Message jobs and drops Task tickets", () => {
		expect(
			parseStageQueueJob({
				messageId: "to-1",
				edgeName: "hunter-to-orchestrator",
				itemIndex: 2,
			}),
		).toEqual({
			type: "message",
			messageId: "to-1",
			edgeName: "hunter-to-orchestrator",
			itemIndex: 2,
		});
		expect(parseStageQueueJob({ type: "task", taskId: "root-1" })).toBeNull();
		expect(parseStageQueueJob("root-1")).toBeNull();
	});

	it("keeps inbound hunter Message jobs and drops Task tickets", () => {
		const redisPayload =
			'{"type":"message","messageId":"to-hunter-1","edgeName":"hunter-to-orchestrator","itemIndex":0}';
		expect(asWaitingMessageQueueJob(redisPayload)).toEqual({
			type: "message",
			messageId: "to-hunter-1",
			edgeName: "hunter-to-orchestrator",
			itemIndex: 0,
		});
		expect(
			asWaitingMessageQueueJob({
				type: "message",
				messageId: "to-hunter-1",
				edgeName: "hunter-to-orchestrator",
				itemIndex: 0,
			}),
		).toMatchObject({ type: "message", messageId: "to-hunter-1" });
		expect(
			asWaitingMessageQueueJob({ type: "output", taskOutputId: "legacy" }),
		).toBeNull();
		expect(asWaitingMessageQueueJob({ type: "task", taskId: "root-1" })).toBeNull();
	});

	it("pages through every waiting queue job", async () => {
		const pages = [
			[{ id: "1" }, { id: "2" }],
			[{ id: "3" }],
		];
		let calls = 0;
		const jobs = await listAllQueueJobs(
			{
				getJobs: async (_types, start) => {
					calls += 1;
					return pages[start === 0 ? 0 : 1] ?? [];
				},
			},
			["waiting"],
			2,
		);
		expect(calls).toBe(2);
		expect(jobs.map((job) => job.id)).toEqual(["1", "2", "3"]);
	});
});

describe("stage input delivery", () => {
	it("removes prompt Messages after launch, but not poll inbox Messages", () => {
		expect(
			shouldRemoveStageQueueJob({
				inputDelivery: "prompt",
			}),
		).toBe(true);
		expect(
			shouldRemoveStageQueueJob({
				inputDelivery: "poll",
			}),
		).toBe(false);
	});

	it("launches a task from persistent×active×concurrency, not delivery mode", () => {
		expect(
			shouldLaunchStageTask({
				persistent: false,
				activeCount: 0,
				concurrency: 8,
			}),
		).toBe(true);
		expect(
			shouldLaunchStageTask({
				persistent: true,
				activeCount: 0,
				concurrency: 1,
			}),
		).toBe(true);
		expect(
			shouldLaunchStageTask({
				persistent: true,
				activeCount: 1,
				concurrency: 1,
			}),
		).toBe(false);
		expect(
			shouldLaunchStageTask({
				persistent: false,
				activeCount: 8,
				concurrency: 8,
			}),
		).toBe(false);
	});

	it("injects poll-messages instructions for poll stages only", () => {
		expect(
			appendPollInputPrompt({
				prompt: "Hunt.",
				stageName: "hunter",
				inputDelivery: "prompt",
			}),
		).toBe("Hunt.");
		const pollPrompt = appendPollInputPrompt({
			prompt: "Coordinate hunts.",
			stageName: "orchestrator",
			inputDelivery: "poll",
		});
		expect(pollPrompt).toContain("Coordinate hunts.");
		expect(pollPrompt).toContain("poll-messages --stage orchestrator");
		expect(pollPrompt).toContain(
			"complete-messages --message-id MESSAGE_ID",
		);
		expect(pollPrompt).toContain("expected wait state");
		expect(pollPrompt).not.toContain("stage-outputs --stage hunter");
		expect(pollPrompt).toContain(
			"every currently waiting Message in one batch",
		);
	});
});

describe("queryMessages", () => {
	it("lists waiting Messages on the current stage queue with reconstructed input", async () => {
		const result = await queryMessages({
			scanJobId: "job-1",
			taskId: "orch-running",
			stageName: "orchestrator",
			deps: {
				findTaskById: async () => ({
					taskId: "orch-running",
					scanJobId: "job-1",
					stageName: "orchestrator",
					status: "running",
				}),
				findScanJobById: async () => ({
					scanJobId: "job-1",
					pipelineCompiledSnapshot: snapshot,
				}),
				listWaitingOutputJobs: async () => [queuedHunterFollowUp],
				reconstructInput: async () => ({
					name: "xmlrpc-unauth",
					feedback: "no chain",
				}),
				now: () => "2026-08-28T00:00:00.000Z",
			},
		});
		expect(result.messages).toEqual([
			{
				messageId: "to-hunter-1",
				edgeName: "hunter-to-orchestrator",
				itemIndex: 0,
				stageName: "orchestrator",
				name: "xmlrpc-unauth",
				status: "queued",
				sourceEdgeName: "hunter-to-orchestrator",
				input: { name: "xmlrpc-unauth", feedback: "no chain" },
				createdAt: "2026-08-28T00:00:00.000Z",
				updatedAt: "2026-08-28T00:00:00.000Z",
			},
		]);
	});

	it("rejects polling another stage's queue", async () => {
		await expect(
			queryMessages({
				scanJobId: "job-1",
				taskId: "orch-running",
				stageName: "hunter",
				deps: {
					findTaskById: async () => ({
						taskId: "orch-running",
						scanJobId: "job-1",
						stageName: "orchestrator",
						status: "running",
					}),
					findScanJobById: async () => ({
						scanJobId: "job-1",
						pipelineCompiledSnapshot: snapshot,
					}),
				},
			}),
		).rejects.toMatchObject({
			status: 403,
			message: expect.stringContaining("current stage queue"),
		});
	});
});

describe("pollMessages", () => {
	it("takes waiting Messages off Redis and returns only this poll batch", async () => {
		const removed: string[] = [];
		const result = await pollMessages({
			scanJobId: "job-1",
			taskId: "orch-running",
			stageName: "orchestrator",
			deps: {
				findTaskById: async () => ({
					taskId: "orch-running",
					scanJobId: "job-1",
					stageName: "orchestrator",
					status: "running",
				}),
				findScanJobById: async () => ({
					scanJobId: "job-1",
					pipelineCompiledSnapshot: snapshot,
				}),
				listWaitingOutputJobs: async () => [
					{
						...queuedHunterFollowUp,
						remove: async () => {
							removed.push(queuedHunterFollowUp.messageId);
						},
					},
				],
				reconstructInput: async () => ({
					name: "xmlrpc-unauth",
					feedback: "no chain",
				}),
				now: () => "2026-08-28T00:00:00.000Z",
				incrementProcessed: async () => {},
			},
		});
		expect(removed).toEqual(["to-hunter-1"]);
		expect(result.messages).toHaveLength(1);
		expect(result.messages).toEqual([
			{
				messageId: "to-hunter-1",
				edgeName: "hunter-to-orchestrator",
				itemIndex: 0,
				stageName: "orchestrator",
				name: "xmlrpc-unauth",
				status: "polled",
				sourceEdgeName: "hunter-to-orchestrator",
				input: { name: "xmlrpc-unauth", feedback: "no chain" },
				createdAt: "2026-08-28T00:00:00.000Z",
				updatedAt: "2026-08-28T00:00:00.000Z",
			},
		]);
	});

	it("returns every waiting Message in one poll", async () => {
		const removed: string[] = [];
		const second = {
			...queuedHunterFollowUp,
			messageId: "to-hunter-2",
			itemIndex: 1,
		};
		const result = await pollMessages({
			scanJobId: "job-1",
			taskId: "orch-running",
			stageName: "orchestrator",
			deps: {
				findTaskById: async () => ({
					taskId: "orch-running",
					scanJobId: "job-1",
					stageName: "orchestrator",
					status: "running",
				}),
				findScanJobById: async () => ({
					scanJobId: "job-1",
					pipelineCompiledSnapshot: snapshot,
				}),
				listWaitingOutputJobs: async () => [
					{
						...queuedHunterFollowUp,
						remove: async () => {
							removed.push(queuedHunterFollowUp.messageId);
						},
					},
					{
						...second,
						remove: async () => {
							removed.push(second.messageId);
						},
					},
				],
				reconstructInput: async (item) => ({
					name: item.messageId,
					feedback: "done",
				}),
				now: () => "2026-08-28T00:00:00.000Z",
				incrementProcessed: async () => {},
			},
		});
		expect(removed).toEqual(["to-hunter-1", "to-hunter-2"]);
		expect(result.messages.map((item) => item.messageId)).toEqual([
			"to-hunter-1",
			"to-hunter-2",
		]);
	});
});

describe("completeMessages", () => {
	it("removes leftover Redis jobs for the requested Messages", async () => {
		const removed: string[] = [];
		const result = await completeMessages({
			scanJobId: "job-1",
			taskId: "orch-running",
			stageName: "orchestrator",
			messageIds: ["to-hunter-1"],
			deps: {
				findTaskById: async () => ({
					taskId: "orch-running",
					scanJobId: "job-1",
					stageName: "orchestrator",
					status: "running",
				}),
				findScanJobById: async () => ({
					scanJobId: "job-1",
					pipelineCompiledSnapshot: snapshot,
				}),
				listWaitingOutputJobs: async () => [
					{
						...queuedHunterFollowUp,
						remove: async () => {
							removed.push(queuedHunterFollowUp.messageId);
						},
					},
				],
			},
		});
		expect(result.completedMessageIds).toEqual(["to-hunter-1"]);
		expect(removed).toEqual(["to-hunter-1"]);
	});
});
