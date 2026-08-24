import assert from "node:assert/strict";
import test from "node:test";
import {
	type PersistedVulnerabilityCandidateInput,
	syncVulnerabilityCandidatesFromProducerTaskWithDeps,
} from "./candidate-sync";
import type { Task } from "../types";

const makeProducerTask = (overrides?: Partial<Task>): Task => ({
	taskId: "producer-1",
		scanJobId: "scan-job-1",
		vulnerabilityCandidateId: null,
	parentTaskId: null,
	name: "Scan Target",
	stageName: "scan-target",
	status: "completed",
	downstreamDispatchStatus: "completed",
	downstreamRouteKey: null,
	downstreamDispatchedAt: null,
	dispatchKey: null,
	priority: null,
	attempt: 0,
	agentProfile: null,
	containerName: null,
	containerIndex: null,
	threadId: null,
	runtimeMode: "new_session",
	forkedFromTaskId: null,
	forkedFromThreadId: null,
	stageGroupInstanceId: null,
	input: null,
	output: {
		candidates: [
			{
				id: "candidate-1",
				functionId: "parse_request",
				title: "Unchecked redirect URI",
				description: "OAuth redirect URI is accepted without HTTPS.",
				filePath: "app/oauth.ts",
				line: 42,
				vulnerabilityType: "oauth",
				confidence: 0.8,
				score: 8,
				claim: "HTTP redirect URI can be registered.",
				rootCauseKey: "oauth-redirect-http",
				targetId: "target-1",
				targetKind: "function",
				evidence: [],
				attackerControl: "redirect_uri parameter",
				affectedSink: "OAuth callback registration",
				preconditions: ["attacker can create an OAuth integration"],
				quickDisproofAttempt: "checked registration validation",
				needsFuzzing: false,
				needsManualAnalysis: true,
			},
			"/task/candidates/candidate-2.json",
		],
	},
	inputTokens: null,
	outputTokens: null,
	thoughtTokens: null,
	totalTokens: null,
	cachedReadTokens: null,
	cachedWriteTokens: null,
	estimatedCost: null,
	errorMessage: null,
	exitReason: null,
	exitNote: null,
	startedAt: "2026-07-07T01:00:00.000Z",
	completedAt: "2026-07-07T01:05:00.000Z",
	createdAt: "2026-07-07T01:00:00.000Z",
	updatedAt: "2026-07-07T01:05:00.000Z",
	...overrides,
});

test("syncVulnerabilityCandidatesFromProducerTaskWithDeps upserts parsed candidates and deletes stale rows for the producer task", async () => {
	const upserted: PersistedVulnerabilityCandidateInput[] = [];
	const deleted: string[] = [];
	const task = makeProducerTask();

	const result = await syncVulnerabilityCandidatesFromProducerTaskWithDeps(
		task.taskId,
		{
			findTaskById: async () => task,
			readTaskJsonArtifact: async (_task, containerPath) => {
				assert.equal(containerPath, "/task/candidates/candidate-2.json");
				return {
					id: "candidate-2",
					functionId: null,
					title: "Bulk import arbitrary IDs",
					description: "Import history page loads arbitrary IDs.",
					filePath: "app/imports.ts",
					line: null,
					vulnerabilityType: "authorization",
					confidence: null,
					score: null,
					claim: "Import history lookup lacks ownership scoping.",
					rootCauseKey: null,
					evidence: [],
					attackerControl: null,
					affectedSink: null,
					preconditions: [],
					quickDisproofAttempt: null,
					needsFuzzing: false,
					needsManualAnalysis: true,
				};
			},
			upsertCandidates: async (candidates) => {
				upserted.push(...candidates);
			},
			deleteStaleCandidatesForProducerTask: async (input) => {
				assert.equal(input.producerTaskId, "producer-1");
				deleted.push(...input.keepCandidateIds);
			},
		},
	);

	assert.equal(result.synced, 2);
	assert.equal(upserted.length, 2);
	assert.deepEqual(
		upserted.map((candidate) => ({
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			producerTaskId: candidate.producerTaskId,
			producerStageName: candidate.producerStageName,
		})),
		[
			{
				vulnerabilityCandidateId: "candidate-1",
				producerTaskId: "producer-1",
				producerStageName: "scan-target",
			},
			{
				vulnerabilityCandidateId: "candidate-2",
				producerTaskId: "producer-1",
				producerStageName: "scan-target",
			},
		],
	);
	assert.deepEqual(deleted, ["candidate-1", "candidate-2"]);
});

test("syncVulnerabilityCandidatesFromProducerTaskWithDeps clears stale rows for non-producer tasks without upserting", async () => {
	const task = makeProducerTask({
		taskId: "analysis-1",
		stageName: "analyze-finding",
		output: null,
	});
	let upsertCalled = false;
	let deletedProducerTaskId = "";
	let keepCandidateIds: string[] | null = null;

	const result = await syncVulnerabilityCandidatesFromProducerTaskWithDeps(
		task.taskId,
		{
			findTaskById: async () => task,
			readTaskJsonArtifact: async () => {
				throw new Error("non-producer task should not read artifacts");
			},
			upsertCandidates: async () => {
				upsertCalled = true;
			},
			deleteStaleCandidatesForProducerTask: async (input) => {
				deletedProducerTaskId = input.producerTaskId;
				keepCandidateIds = input.keepCandidateIds;
			},
		},
	);

	assert.equal(result.synced, 0);
	assert.equal(upsertCalled, false);
	assert.equal(deletedProducerTaskId, "analysis-1");
	assert.deepEqual(keepCandidateIds, []);
});

test("syncVulnerabilityCandidatesFromProducerTaskWithDeps deletes stale rows when producer output has no candidates", async () => {
	const task = makeProducerTask({
		output: {
			candidates: [],
		},
	});
	const deleted: Array<{ producerTaskId: string; keepCandidateIds: string[] }> =
		[];

	const result = await syncVulnerabilityCandidatesFromProducerTaskWithDeps(
		task.taskId,
		{
			findTaskById: async () => task,
			readTaskJsonArtifact: async () => {
				throw new Error("empty candidate output should not read artifacts");
			},
			upsertCandidates: async (candidates) => {
				assert.equal(candidates.length, 0);
			},
			deleteStaleCandidatesForProducerTask: async (input) => {
				deleted.push(input);
			},
		},
	);

	assert.equal(result.synced, 0);
	assert.deepEqual(deleted, [
		{
			producerTaskId: "producer-1",
			keepCandidateIds: [],
		},
	]);
});

test("syncVulnerabilityCandidatesFromProducerTaskWithDeps accepts a single Hunter candidate", async () => {
	const sourceOutput = makeProducerTask().output as { candidates: unknown[] };
	const task = makeProducerTask({
		stageName: "hunter",
		output: { candidate: sourceOutput.candidates[0] },
	});
	let synced: PersistedVulnerabilityCandidateInput[] = [];

	const result = await syncVulnerabilityCandidatesFromProducerTaskWithDeps(
		task.taskId,
		{
			findTaskById: async () => task,
			readTaskJsonArtifact: async () => {
				throw new Error("inline Hunter candidates should not read artifacts");
			},
			upsertCandidates: async (candidates) => {
				synced = candidates;
			},
			deleteStaleCandidatesForProducerTask: async ({ keepCandidateIds }) => {
				assert.deepEqual(keepCandidateIds, ["candidate-1"]);
			},
		},
	);

	assert.equal(result.synced, 1);
	assert.equal(synced[0]?.vulnerabilityCandidateId, "candidate-1");
});
