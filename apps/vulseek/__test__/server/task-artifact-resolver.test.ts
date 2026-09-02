import { expect, it } from "vitest";
import {
	extractCandidateIdFromInputArtifact,
	readCandidateIdFromTaskInputArtifact,
} from "@vulseek/server/services/scan/persistence/task-artifact-resolver";

it("reads candidate.id from candidate.json, dispatch.json, and task-input.json", () => {
	expect(
		extractCandidateIdFromInputArtifact("/task/inputs/candidate.json", {
			id: "C-212",
			title: "pending hash",
		}),
	).toBe("C-212");
	expect(
		extractCandidateIdFromInputArtifact("/task/inputs/dispatch.json", {
			candidate: { id: "C-301" },
		}),
	).toBe("C-301");
	expect(
		extractCandidateIdFromInputArtifact("/task/inputs/task-input.json", {
			candidate: { id: "C-9" },
		}),
	).toBe("C-9");
	expect(
		extractCandidateIdFromInputArtifact("/task/inputs/dispatch.json", {
			id: "not-nested",
		}),
	).toBeNull();
});


it("returns null when candidate artifacts are missing", async () => {
	const candidateId = await readCandidateIdFromTaskInputArtifact({
		taskId: "task-1",
		scanJobId: "job-1",
		name: "Analyze",
		stageName: "analyze-finding",
		lifecycle: "turn",
		status: "completed",
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
		startedAt: null,
		completedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});

	expect(candidateId).toBeNull();
});
