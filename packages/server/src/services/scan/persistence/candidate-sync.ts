import { candidateSchema } from "../artifacts/contracts/domain-object.contract";
import type { Candidate, Task, VulnerabilityCandidate } from "../types";

export const CANDIDATE_PRODUCER_STAGE_NAMES = [
	"scan-target",
	"orchestrator",
	"hunter",
] as const;

export type CandidateProducerStageName =
	(typeof CANDIDATE_PRODUCER_STAGE_NAMES)[number];

export type PersistedVulnerabilityCandidateInput = Omit<
	VulnerabilityCandidate,
	"note" | "tags"
>;

export type CandidateSyncDeps = {
	findTaskById: (taskId: string) => Promise<Task>;
	readTaskJsonArtifact: (task: Task, containerPath: string) => Promise<unknown>;
	upsertCandidates: (
		candidates: PersistedVulnerabilityCandidateInput[],
	) => Promise<void>;
	deleteStaleCandidatesForMessage: (input: {
		producerTaskId: string;
		messageId: string;
		keepCandidateIds: string[];
	}) => Promise<void>;
};

const isCandidateProducerStage = (
	stageName: string,
): stageName is CandidateProducerStageName =>
	(CANDIDATE_PRODUCER_STAGE_NAMES as readonly string[]).includes(stageName);

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const toPersistedCandidate = (
	task: Task,
	producerStageName: CandidateProducerStageName,
	candidate: Candidate,
	messageId: string,
): PersistedVulnerabilityCandidateInput => ({
	vulnerabilityCandidateId: candidate.id,
	scanJobId: task.scanJobId,
	producerTaskId: task.taskId,
	messageId,
	producerStageName,
	functionId: candidate.functionId,
	title: candidate.title,
	description: candidate.description || "",
	filePath: candidate.filePath,
	line: candidate.line,
	vulnerabilityType: candidate.vulnerabilityType,
	confidence: candidate.confidence,
	score: candidate.score,
	targetId: candidate.targetId ?? null,
	targetKind: candidate.targetKind ?? null,
	claim: candidate.claim,
	rootCauseKey: candidate.rootCauseKey,
	evidence: candidate.evidence,
	attackerControl: candidate.attackerControl,
	affectedSink: candidate.affectedSink,
	preconditions: candidate.preconditions,
	quickDisproofAttempt: candidate.quickDisproofAttempt,
	needsFuzzing: candidate.needsFuzzing,
	needsManualAnalysis: candidate.needsManualAnalysis,
	createdAt: task.createdAt,
	updatedAt: task.updatedAt,
});

const parseCandidateOutput = async (
	task: Task,
	rawCandidate: unknown,
	deps: Pick<CandidateSyncDeps, "readTaskJsonArtifact">,
) => {
	const candidate =
		typeof rawCandidate === "string"
			? await deps.readTaskJsonArtifact(task, rawCandidate)
			: rawCandidate;
	return candidateSchema.parse(candidate);
};

export const syncVulnerabilityCandidatesFromMessageWithDeps = async (
	input: {
		taskId: string;
		messageId: string;
		output: unknown;
	},
	deps: CandidateSyncDeps,
) => {
	const task = await deps.findTaskById(input.taskId);
	const producerStageName = task.stageName;
	if (!isCandidateProducerStage(producerStageName)) {
		return { synced: 0 };
	}

	const output = asRecord(input.output);
	const rawCandidates = Array.isArray(output?.candidates)
		? output.candidates
		: output?.candidate
			? [output.candidate]
			: [];
	const candidates = await Promise.all(
		rawCandidates.map((rawCandidate) =>
			parseCandidateOutput(task, rawCandidate, deps),
		),
	);
	const persistedCandidates = candidates.map((candidate) =>
		toPersistedCandidate(
			task,
			producerStageName,
			candidate,
			input.messageId,
		),
	);
	await deps.upsertCandidates(persistedCandidates);
	await deps.deleteStaleCandidatesForMessage({
		producerTaskId: task.taskId,
		messageId: input.messageId,
		keepCandidateIds: persistedCandidates.map(
			(candidate) => candidate.vulnerabilityCandidateId,
		),
	});
	return { synced: persistedCandidates.length };
};

export const syncVulnerabilityCandidatesFromProducerTaskWithDeps = async (
	taskId: string,
	deps: CandidateSyncDeps & {
		getOutput?: (task: Task) => Promise<unknown> | unknown;
		getMessageId?: (task: Task) => Promise<string | null> | string | null;
		deleteStaleCandidatesForProducerTask?: (input: {
			producerTaskId: string;
			keepCandidateIds: string[];
		}) => Promise<void>;
	},
) => {
	const task = await deps.findTaskById(taskId);
	if (!isCandidateProducerStage(task.stageName)) {
		await deps.deleteStaleCandidatesForProducerTask?.({
			producerTaskId: task.taskId,
			keepCandidateIds: [],
		});
		return { synced: 0 };
	}
	const rawOutput = deps.getOutput ? await deps.getOutput(task) : null;
	const messageId = deps.getMessageId
		? await deps.getMessageId(task)
		: null;
	if (!messageId) {
		return { synced: 0 };
	}
	return syncVulnerabilityCandidatesFromMessageWithDeps(
		{ taskId, messageId, output: rawOutput },
		deps,
	);
};
