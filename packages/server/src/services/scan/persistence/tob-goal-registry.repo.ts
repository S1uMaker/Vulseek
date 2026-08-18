import type { TobGoalCandidateContent } from "../../../db/schema/tob-goal";
import {
	updateTobGoalCandidateStatusRepo,
	upsertTobGoalCandidateRepo,
} from "./tob-goal-candidate.repo";
import { upsertTobGoalFindingRepo } from "./tob-goal-finding.repo";
import { resolvePersistCandidate } from "./tob-goal-persist";

export { resolvePersistCandidate } from "./tob-goal-persist";

export type TobGoalRegistryOperation =
	| "persist-candidate"
	| "apply-judge"
	| "apply-dedup";

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const readString = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : null;

export const applyTobGoalRegistryEffect = async (input: {
	scanJobId: string;
	taskId: string;
	operation: TobGoalRegistryOperation;
	stageOutput: unknown;
	stageInput?: unknown;
}) => {
	const output = asRecord(input.stageOutput) ?? {};
	const stageInput = asRecord(input.stageInput) ?? {};

	if (input.operation === "persist-candidate") {
		const resolved = resolvePersistCandidate({
			stageOutput: input.stageOutput,
			stageInput: input.stageInput,
		});
		if (!resolved.ok) {
			return { applied: false as const, reason: resolved.reason };
		}
		await upsertTobGoalCandidateRepo({
			scanJobId: input.scanJobId,
			candidateId: resolved.candidateId,
			huntGoalId: resolved.huntGoalId,
			huntTaskId: input.taskId,
			status: "discovered",
			title: resolved.title,
			summary: resolved.summary,
			content: resolved.content as TobGoalCandidateContent,
		});
		return { applied: true as const, candidateId: resolved.candidateId };
	}

	if (input.operation === "apply-judge") {
		const candidateId =
			readString(output.candidateId) ||
			readString(asRecord(stageInput.candidate)?.candidateId);
		const decision = readString(output.decision);
		if (!candidateId || !decision) {
			return { applied: false as const, reason: "incomplete-judge" };
		}
		const status =
			decision === "confirmed"
				? "judging"
				: decision === "rejected"
					? "rejected_judge"
					: "needs_more_evidence";
		await updateTobGoalCandidateStatusRepo({
			scanJobId: input.scanJobId,
			candidateId,
			status,
		});
		return { applied: true as const, candidateId, status };
	}

	if (input.operation === "apply-dedup") {
		const candidateId =
			readString(output.candidateId) ||
			readString(asRecord(stageInput.candidate)?.candidateId);
		const novelty = readString(output.novelty);
		if (!candidateId || !novelty) {
			return { applied: false as const, reason: "incomplete-dedup" };
		}
		if (novelty !== "novel") {
			await updateTobGoalCandidateStatusRepo({
				scanJobId: input.scanJobId,
				candidateId,
				status: "rejected_dedup",
			});
			return { applied: true as const, candidateId, novelty };
		}

		const candidate = asRecord(stageInput.candidate) ?? {};
		const huntGoalId =
			readString(candidate.huntGoalId) ||
			readString(asRecord(stageInput.huntGoal)?.huntGoalId) ||
			"unknown";
		const title = readString(candidate.title) || candidateId;
		const findingId = `${candidateId}:novel`;
		const references = Array.isArray(output.references)
			? output.references.filter((item): item is string => typeof item === "string")
			: [];

		await updateTobGoalCandidateStatusRepo({
			scanJobId: input.scanJobId,
			candidateId,
			status: "promoted",
		});
		await upsertTobGoalFindingRepo({
			scanJobId: input.scanJobId,
			findingId,
			sourceCandidateId: candidateId,
			huntGoalId,
			status: "novel",
			title,
			summary: readString(output.summary) ?? title,
			content: {
				...(candidate as TobGoalCandidateContent),
				candidateId,
				huntGoalId,
				title,
				description:
					readString(candidate.description) ||
					readString(output.summary) ||
					title,
				location:
					(asRecord(candidate.location) as TobGoalCandidateContent["location"]) || {
						filePath: "unknown",
					},
				claim: readString(candidate.claim) || title,
				rootCauseKey: readString(candidate.rootCauseKey) || candidateId,
				findingId,
				sourceCandidateId: candidateId,
				novelty,
				references,
			},
			dedupRefs: references,
		});
		return { applied: true as const, candidateId, findingId, novelty };
	}

	return { applied: false as const, reason: "unknown-operation" };
};
