import { db } from "@vulseek/server/db";
import {
	messages,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { readCandidateIdFromTaskInputArtifact } from "./task-artifact-resolver";
import {
	analysisSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import {
	buildCandidateResultPatch,
	compareCandidateResultVersions,
	normalizeCandidateResultStageOutput,
} from "./candidate-result";

export const CANDIDATE_RESULT_STAGE_NAMES = [
	"analyze-finding",
	"verify-finding",
	"triage-finding",
] as const;

export type CandidateResultStageName =
	(typeof CANDIDATE_RESULT_STAGE_NAMES)[number];

export type CandidateResultStage = "analyze" | "verify" | "triage";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TaskRecord = typeof tasks.$inferSelect;

const stageColumns = {
	"analyze-finding": {
		taskId: "analysisTaskId",
		resultAt: "analysisResultAt",
	},
	"verify-finding": {
		taskId: "verificationTaskId",
		resultAt: "verificationResultAt",
	},
	"triage-finding": {
		taskId: "triageTaskId",
		resultAt: "triageResultAt",
	},
} as const;

const parseStageOutput = (stageName: string, output: unknown) => {
	const normalizedOutput = normalizeCandidateResultStageOutput(
		stageName,
		output,
	);
	if (stageName === "analyze-finding") {
		return analysisSchema.safeParse(normalizedOutput);
	}
	if (stageName === "verify-finding") {
		return verificationSchema.safeParse(normalizedOutput);
	}
	if (stageName === "triage-finding") {
		return triageSchema.safeParse(normalizedOutput);
	}
	return { success: false as const };
};

const resolveResultStageName = (
	task: TaskRecord,
	resultStage?: CandidateResultStage,
): CandidateResultStageName | null => {
	if (resultStage === "analyze") {
		return "analyze-finding";
	}
	if (resultStage === "verify") {
		return "verify-finding";
	}
	if (resultStage === "triage") {
		return "triage-finding";
	}
	return CANDIDATE_RESULT_STAGE_NAMES.includes(
		task.stageName as CandidateResultStageName,
	)
		? (task.stageName as CandidateResultStageName)
		: null;
};

const latestResultAt = (
	row: typeof vulnerabilityCandidates.$inferSelect,
	patch: Record<string, unknown>,
	resultAt: string,
) => {
	const values = [
		row.analysisResultAt,
		row.verificationResultAt,
		row.triageResultAt,
		patch.analysisResultAt,
		patch.verificationResultAt,
		patch.triageResultAt,
		resultAt,
	].filter((value): value is string => typeof value === "string");
	return (
		values.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ||
		resultAt
	);
};

export const applyCandidateStageResultTx = async (
	tx: DbTransaction,
	task: TaskRecord,
	vulnerabilityCandidateId?: string | null,
	resultStage?: CandidateResultStage,
	taskOutput?: { messageId: string; output: unknown } | null,
) => {
	const stageName = resolveResultStageName(task, resultStage);
	if (!stageName) {
		return false;
	}

	const candidateId =
		vulnerabilityCandidateId ||
		(await readCandidateIdFromTaskInputArtifact(task));
	if (!candidateId) {
		throw new Error(
			`Candidate id missing for ${stageName} task ${task.taskId} in scan job ${task.scanJobId}`,
		);
	}

	const [latestOutput] = taskOutput
		? [{ output: taskOutput.output, messageId: taskOutput.messageId }]
		: await tx
				.select({
					output: messages.payload,
					messageId: messages.messageId,
				})
				.from(messages)
				.where(eq(messages.sourceTaskId, task.taskId))
				.orderBy(desc(messages.sequence))
				.limit(1);
	const parsedOutput = parseStageOutput(stageName, latestOutput?.output);
	if (!parsedOutput.success) {
		return false;
	}

	const existing = await tx
		.select()
		.from(vulnerabilityCandidates)
		.where(
			and(
				eq(vulnerabilityCandidates.scanJobId, task.scanJobId),
				eq(
					vulnerabilityCandidates.vulnerabilityCandidateId,
					candidateId,
				),
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);
	if (!existing) {
		throw new Error(
			`Candidate ${candidateId} not found for scan job ${task.scanJobId}`,
		);
	}

	const resultAt = task.completedAt || task.updatedAt || task.createdAt;
	const columns = stageColumns[stageName];
	const oldTaskId = existing[columns.taskId];
	const oldResultAt = existing[columns.resultAt];
	if (
		typeof oldTaskId === "string" &&
		typeof oldResultAt === "string" &&
		compareCandidateResultVersions(
			{ resultAt, taskId: task.taskId },
			{ resultAt: oldResultAt, taskId: oldTaskId },
		) < 0
	) {
		return false;
	}

	const patch = buildCandidateResultPatch({
		taskId: task.taskId,
		messageId: latestOutput?.messageId ?? null,
		stageName,
		output: parsedOutput.data,
		resultAt,
	});
	await tx
		.update(vulnerabilityCandidates)
		.set({
			...patch,
			latestResultAt: latestResultAt(existing, patch, resultAt),
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(vulnerabilityCandidates.scanJobId, task.scanJobId),
				eq(
					vulnerabilityCandidates.vulnerabilityCandidateId,
					candidateId,
				),
			),
		);
	return true;
};

export const validateCandidateResultOutput = (
	stageName: string,
	output: unknown,
) => parseStageOutput(stageName, output).success;
