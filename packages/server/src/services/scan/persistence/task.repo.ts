import { TRPCError } from "@trpc/server";
import { db } from "@vulseek/server/db";
import {
	scanJobs,
	type TaskAgentProfileSnapshot,
	type taskStatusEnum,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import {
	and,
	asc,
	count,
	desc,
	eq,
	ilike,
	inArray,
	or,
	sql,
} from "drizzle-orm";
import {
	analysisSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import { computePatchedTaskCost, computeTaskCost } from "../cost";
import {
	getOrchHuntRunningTaskPresentation,
	getResearchRunningTaskPresentation,
	mapRunningTaskStage,
	RUNNING_TASK_VIEW_STATUSES,
	type RunningTaskStage,
} from "../running-task-stage";
import { createShortTaskId, createTaskIdForDispatchKey } from "../task-id";
import type {
	AnalysisResult,
	TriageResult,
	VerificationResult,
} from "../types";
import {
	type CandidateProjectionResultStage,
	upsertCandidateResultProjectionTx,
} from "./candidate-result-projection.repo";
import { readCandidateIdFromTaskInputArtifact } from "./task-artifact-resolver";
import { buildTaskStatusTransitionPatch } from "./task-status-transition";
import {
	ALL_TASK_EXECUTION_STATUSES,
	getAllowedJobStatusesForTaskTransition,
	type ScanJobExecutionStatus,
	type TaskExecutionStatus,
} from "./task-status-policy";

const CANDIDATE_PRODUCER_STAGE_NAMES = new Set(["scan-target"]);

export type TaskStatusTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

type ScanJobStatus = ScanJobExecutionStatus;
type TaskStatus = (typeof taskStatusEnum.enumValues)[number];

export type TaskStatusTransitionOutcome =
	| "updated"
	| "job_paused"
	| "job_stopped"
	| "stale_task"
	| "not_found";

export type TaskStatusTransitionResult = {
	outcome: TaskStatusTransitionOutcome;
	task: typeof tasks.$inferSelect | null;
	jobStatus: ScanJobStatus | null;
};

export class ScanJobExecutionNotAllowedError extends Error {
	constructor(
		public readonly scanJobId: string,
		public readonly jobStatus: ScanJobStatus,
	) {
		super(
			`Scan job ${scanJobId} is ${jobStatus}; new tasks may only be created while running`,
		);
		this.name = "ScanJobExecutionNotAllowedError";
	}
}

const resolveCandidateProjectionResultStage = async (
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	task: typeof tasks.$inferSelect,
): Promise<CandidateProjectionResultStage | undefined> => {
	const row = await tx
		.select({ snapshot: scanJobs.scanPipelineDefinitionSnapshot })
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, task.scanJobId))
		.limit(1)
		.then((rows) => rows[0]);
	const snapshot = row?.snapshot;
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
		return undefined;
	}
	const stages = (snapshot as { stages?: unknown }).stages;
	if (!Array.isArray(stages)) return undefined;
	const stage = stages.find(
		(value) =>
			value &&
			typeof value === "object" &&
			(value as { id?: unknown }).id === task.stageName,
	);
	if (!stage || typeof stage !== "object") return undefined;
	const effects = (stage as { effects?: unknown }).effects;
	if (!Array.isArray(effects)) return undefined;
	const effect = effects.find(
		(value) =>
			value &&
			typeof value === "object" &&
			(value as { type?: unknown }).type === "project-candidate-result",
	);
	const resultStage =
		effect && typeof effect === "object"
			? (effect as { resultStage?: unknown }).resultStage
			: undefined;
	return resultStage === "analyze" ||
		resultStage === "verify" ||
		resultStage === "triage"
		? resultStage
		: undefined;
};

const findProducerTaskIdForCandidateDescendantTask = async (
	task: typeof tasks.$inferSelect,
) => {
	let currentTask: typeof tasks.$inferSelect | null = task;
	const seenTaskIds = new Set<string>();
	while (currentTask) {
		if (seenTaskIds.has(currentTask.taskId)) {
			return null;
		}
		seenTaskIds.add(currentTask.taskId);
		if (CANDIDATE_PRODUCER_STAGE_NAMES.has(currentTask.stageName)) {
			return currentTask.taskId;
		}
		currentTask = currentTask.parentTaskId
			? await findTaskByIdRepo(currentTask.parentTaskId).catch(() => null)
			: null;
	}
	return null;
};

const tokenUsageKeys = [
	"inputTokens",
	"outputTokens",
	"thoughtTokens",
	"totalTokens",
	"cachedReadTokens",
	"cachedWriteTokens",
] as const;

const taskCostUsageKeys = [
	"inputTokens",
	"outputTokens",
	"cachedReadTokens",
	"cachedWriteTokens",
] as const;

type TaskTokenUsageKey = (typeof tokenUsageKeys)[number];
type TaskRecord = typeof tasks.$inferSelect;

const hasTokenUsagePatch = (patch: Partial<typeof tasks.$inferSelect>) =>
	tokenUsageKeys.some((key) => key in patch);

const hasTaskCostPatch = (patch: Partial<typeof tasks.$inferSelect>) =>
	taskCostUsageKeys.some((key) => key in patch) || "agentProfile" in patch;

const requiresTaskUsageTransaction = (
	patch: Partial<typeof tasks.$inferSelect>,
) => hasTokenUsagePatch(patch) || "agentProfile" in patch;

const toTokenCount = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

const tokenUsageDelta = (
	before: Pick<typeof tasks.$inferSelect, TaskTokenUsageKey>,
	after: Pick<typeof tasks.$inferSelect, TaskTokenUsageKey>,
) => ({
	inputTokens:
		toTokenCount(after.inputTokens) - toTokenCount(before.inputTokens),
	outputTokens:
		toTokenCount(after.outputTokens) - toTokenCount(before.outputTokens),
	thoughtTokens:
		toTokenCount(after.thoughtTokens) - toTokenCount(before.thoughtTokens),
	totalTokens:
		toTokenCount(after.totalTokens) - toTokenCount(before.totalTokens),
	cachedReadTokens:
		toTokenCount(after.cachedReadTokens) -
		toTokenCount(before.cachedReadTokens),
	cachedWriteTokens:
		toTokenCount(after.cachedWriteTokens) -
		toTokenCount(before.cachedWriteTokens),
});

const hasNonZeroTokenUsageDelta = (delta: ReturnType<typeof tokenUsageDelta>) =>
	Object.values(delta).some((value) => value !== 0);

const applyScanJobTokenUsageDelta = async (
	tx: typeof db,
	scanJobId: string,
	delta: ReturnType<typeof tokenUsageDelta>,
) => {
	if (!hasNonZeroTokenUsageDelta(delta)) {
		return;
	}
	await tx
		.update(scanJobs)
		.set({
			inputTokens: sql`${scanJobs.inputTokens} + ${delta.inputTokens}`,
			outputTokens: sql`${scanJobs.outputTokens} + ${delta.outputTokens}`,
			thoughtTokens: sql`${scanJobs.thoughtTokens} + ${delta.thoughtTokens}`,
			totalTokens: sql`${scanJobs.totalTokens} + ${delta.totalTokens}`,
			cachedReadTokens: sql`${scanJobs.cachedReadTokens} + ${delta.cachedReadTokens}`,
			cachedWriteTokens: sql`${scanJobs.cachedWriteTokens} + ${delta.cachedWriteTokens}`,
		})
		.where(eq(scanJobs.scanJobId, scanJobId));
};

const applyScanJobEstimatedCostDelta = async (
	tx: typeof db,
	scanJobId: string,
	previousCost: number | null | undefined,
	nextCost: number | null | undefined,
) => {
	const delta = (nextCost ?? 0) - (previousCost ?? 0);
	if (delta === 0) {
		return;
	}
	await tx
		.update(scanJobs)
		.set({ estimatedCost: sql`${scanJobs.estimatedCost} + ${delta}` })
		.where(eq(scanJobs.scanJobId, scanJobId));
};

const calculateTaskCost = (
	task: Pick<
		TaskRecord,
		| "inputTokens"
		| "outputTokens"
		| "cachedReadTokens"
		| "cachedWriteTokens"
		| "agentProfile"
	>,
) =>
	computeTaskCost({
		inputTokens: task.inputTokens,
		outputTokens: task.outputTokens,
		cachedReadTokens: task.cachedReadTokens,
		cachedWriteTokens: task.cachedWriteTokens,
		agentProfile: task.agentProfile,
	});

const calculatePatchedTaskCost = (
	task: TaskRecord,
	patch: Partial<TaskRecord>,
) => computePatchedTaskCost(task, patch);

const buildAnalysisTaskResultView = async (
	task: typeof tasks.$inferSelect,
): Promise<AnalysisResult | null> => {
	const parsedOutput = analysisSchema.safeParse(task.output);
	if (!parsedOutput.success) {
		return null;
	}

	const vulnerabilityCandidateId =
		await readCandidateIdFromTaskInputArtifact(task);
	if (!vulnerabilityCandidateId) {
		return null;
	}
	const producerTaskId =
		await findProducerTaskIdForCandidateDescendantTask(task);
	if (!producerTaskId) {
		return null;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		producerTaskId,
		result: parsedOutput.data.result,
		confidence: parsedOutput.data.confidence,
		score: parsedOutput.data.score,
		reportPath: parsedOutput.data.reportPath,
		runtimeSeconds: parsedOutput.data.runtimeSeconds,
		threadId: task.threadId,
		summary: parsedOutput.data.summary,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		status: parsedOutput.data.status ?? task.status,
	};
};

const buildVerificationTaskResultView = async (
	task: typeof tasks.$inferSelect,
): Promise<VerificationResult | null> => {
	const parsedOutput = verificationSchema.safeParse(task.output);
	if (!parsedOutput.success) {
		return null;
	}

	const vulnerabilityCandidateId =
		await readCandidateIdFromTaskInputArtifact(task);
	if (!vulnerabilityCandidateId) {
		return null;
	}
	const producerTaskId =
		await findProducerTaskIdForCandidateDescendantTask(task);
	if (!producerTaskId) {
		return null;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		producerTaskId,
		result: parsedOutput.data.result,
		confidence: parsedOutput.data.confidence,
		score: parsedOutput.data.score,
		reportPath: parsedOutput.data.reportPath,
		runtimeSeconds: parsedOutput.data.runtimeSeconds,
		threadId: task.threadId,
		summary: parsedOutput.data.summary,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		status: parsedOutput.data.status ?? task.status,
	};
};

const buildTriageTaskResultView = async (
	task: typeof tasks.$inferSelect,
): Promise<TriageResult | null> => {
	const parsedOutput = triageSchema.safeParse(task.output);
	if (!parsedOutput.success) {
		return null;
	}

	const vulnerabilityCandidateId =
		await readCandidateIdFromTaskInputArtifact(task);
	if (!vulnerabilityCandidateId) {
		return null;
	}
	const producerTaskId =
		await findProducerTaskIdForCandidateDescendantTask(task);
	if (!producerTaskId) {
		return null;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		producerTaskId,
		result: parsedOutput.data.result,
		disqualifier: parsedOutput.data.disqualifier,
		disqualifierReason: parsedOutput.data.disqualifierReason,
		securityClassification: parsedOutput.data.securityClassification,
		isSecurityIssue: parsedOutput.data.isSecurityIssue,
		impactType: parsedOutput.data.impactType,
		cvssVector: parsedOutput.data.cvssVector,
		cvssScore: parsedOutput.data.cvssScore,
		cvssSeverity: parsedOutput.data.cvssSeverity,
		exploitability: parsedOutput.data.exploitability,
		isExploitable: parsedOutput.data.isExploitable,
		commonTriggerConditions: parsedOutput.data.commonTriggerConditions,
		hardeningOrRobustness: parsedOutput.data.hardeningOrRobustness,
		epssProbability30d: parsedOutput.data.epssProbability30d,
		epssSource: parsedOutput.data.epssSource,
		confidence: null,
		score: parsedOutput.data.cvssScore,
		reportPath: parsedOutput.data.reportPath,
		runtimeSeconds: parsedOutput.data.runtimeSeconds,
		threadId: task.threadId,
		summary: parsedOutput.data.summary,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		status: parsedOutput.data.status ?? task.status,
	};
};

export const createTaskRepo = async (input: {
	taskId?: string;
	scanJobId: string;
	vulnerabilityCandidateId?: string | null;
	parentTaskId?: string | null;
	name: string;
	stageName: string;
	dispatchKey?: string | null;
	status?: (typeof taskStatusEnum.enumValues)[number];
	priority?: number | null;
	attempt?: number;
	agentProfile?: typeof tasks.$inferSelect.agentProfile;
	containerName?: string | null;
	containerIndex?: number | null;
	threadId?: string | null;
	runtimeMode?: typeof tasks.$inferSelect.runtimeMode;
	forkedFromTaskId?: string | null;
	forkedFromThreadId?: string | null;
	input?: typeof tasks.$inferSelect.input;
	output?: typeof tasks.$inferSelect.output;
	inputTokens?: number | null;
	outputTokens?: number | null;
	thoughtTokens?: number | null;
	totalTokens?: number | null;
	cachedReadTokens?: number | null;
	cachedWriteTokens?: number | null;
	errorMessage?: string | null;
	exitReason?: typeof tasks.$inferSelect.exitReason;
	exitNote?: string | null;
	stageGroupInstanceId?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	allowedJobStatuses?: ScanJobStatus[];
}) => {
	const hasExplicitTaskId = Boolean(input.taskId);
	let created: Array<typeof tasks.$inferSelect> = [];
	let lastError: unknown = null;
	const allowedJobStatuses = input.allowedJobStatuses ?? ["running"];
	await db.transaction(async (tx) => {
		const job = await tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, input.scanJobId))
			.for("share")
			.limit(1)
			.then((rows) => rows[0] ?? null);
		if (!job) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Scan job ${input.scanJobId} not found`,
			});
		}
		if (!allowedJobStatuses.includes(job.status)) {
			throw new ScanJobExecutionNotAllowedError(input.scanJobId, job.status);
		}
		if (input.dispatchKey) {
			const existing = await tx
				.select()
				.from(tasks)
				.where(eq(tasks.dispatchKey, input.dispatchKey))
				.limit(1)
				.then((rows) => rows[0] || null);
			if (existing) {
				created = [existing];
				return;
			}
		}
		await consumeScanJobTaskBudgetWithExecutor(tx, input.scanJobId);
		for (let attempt = 0; attempt < (hasExplicitTaskId ? 1 : 5); attempt += 1) {
			try {
				created = await tx
					.insert(tasks)
				.values({
					taskId:
						input.taskId ||
						(input.dispatchKey
							? createTaskIdForDispatchKey(input.dispatchKey)
							: createShortTaskId()),
					scanJobId: input.scanJobId,
					vulnerabilityCandidateId: input.vulnerabilityCandidateId ?? null,
					parentTaskId: input.parentTaskId ?? null,
					name: input.name,
					stageName: input.stageName,
					dispatchKey: input.dispatchKey ?? null,
					status: input.status ?? "pending",
					priority: input.priority ?? null,
					attempt: input.attempt ?? 0,
					agentProfile: input.agentProfile ?? null,
					containerName: input.containerName ?? null,
					containerIndex: input.containerIndex ?? null,
					threadId: input.threadId ?? null,
					runtimeMode: input.runtimeMode ?? "new_session",
					forkedFromTaskId: input.forkedFromTaskId ?? null,
					forkedFromThreadId: input.forkedFromThreadId ?? null,
					input: input.input ?? null,
					output: input.output ?? null,
					inputTokens: input.inputTokens ?? null,
					outputTokens: input.outputTokens ?? null,
					thoughtTokens: input.thoughtTokens ?? null,
					totalTokens: input.totalTokens ?? null,
					cachedReadTokens: input.cachedReadTokens ?? null,
					cachedWriteTokens: input.cachedWriteTokens ?? null,
					estimatedCost: calculateTaskCost({
						inputTokens: input.inputTokens ?? null,
						outputTokens: input.outputTokens ?? null,
						cachedReadTokens: input.cachedReadTokens ?? null,
						cachedWriteTokens: input.cachedWriteTokens ?? null,
						agentProfile: input.agentProfile ?? null,
					}),
					errorMessage: input.errorMessage ?? null,
					exitReason: input.exitReason ?? null,
					exitNote: input.exitNote ?? null,
					stageGroupInstanceId: input.stageGroupInstanceId ?? null,
					startedAt: input.startedAt ?? null,
					completedAt: input.completedAt ?? null,
					})
					.returning();
				lastError = null;
				break;
			} catch (error) {
				lastError = error;
				if (
					hasExplicitTaskId ||
					!error ||
					typeof error !== "object" ||
					(error as { code?: string }).code !== "23505"
				) {
					throw error;
				}
			}
		}
		if (!created[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Error creating task${lastError ? `: ${String(lastError)}` : ""}`,
			});
		}

		if (hasTokenUsagePatch(input)) {
			await applyScanJobTokenUsageDelta(
				tx,
				created[0].scanJobId,
				tokenUsageDelta(
					{
						inputTokens: null,
						outputTokens: null,
						thoughtTokens: null,
						totalTokens: null,
						cachedReadTokens: null,
						cachedWriteTokens: null,
					},
					created[0],
				),
			);
		}
		await applyScanJobEstimatedCostDelta(
			tx,
			created[0].scanJobId,
			0,
			created[0].estimatedCost,
		);
	});

	return created[0]!;
};

export const findTaskByIdRepo = async (taskId: string) => {
	const task = await db
		.select()
		.from(tasks)
		.where(eq(tasks.taskId, taskId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (!task) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return task;
};

export type TaskSessionRuntimeMetadata = {
	taskId: string;
	scanJobId: string;
	stageName: string;
	name: string;
	status: (typeof taskStatusEnum.enumValues)[number];
	containerName: string | null;
	threadId: string | null;
	agentProfile: TaskAgentProfileSnapshot | null;
	createdAt: string;
	updatedAt: string;
};

export const listTaskSessionRuntimeMetadataByThreadRepo = async (input: {
	scanJobId: string;
	stageName: string;
	threadId: string;
}): Promise<TaskSessionRuntimeMetadata[]> =>
	await db
		.select({
			taskId: tasks.taskId,
			scanJobId: tasks.scanJobId,
			stageName: tasks.stageName,
			name: tasks.name,
			status: tasks.status,
			containerName: tasks.containerName,
			threadId: tasks.threadId,
			agentProfile: tasks.agentProfile,
			createdAt: tasks.createdAt,
			updatedAt: tasks.updatedAt,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
				eq(tasks.threadId, input.threadId),
			),
		)
		.orderBy(asc(tasks.createdAt), asc(tasks.taskId));

export const listTasksByScanJobIdRepo = async (scanJobId: string) =>
	await db
		.select()
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.orderBy(desc(tasks.createdAt));

export const listActiveTasksByScanJobIdRepo = async (scanJobId: string) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, ["launching", "launched", "starting", "running"]),
			),
		)
		.orderBy(desc(tasks.updatedAt));

export type PendingTaskQueueMetadata = {
	taskId: string;
	scanJobId: string;
	name: string;
	stageName: string;
	status: (typeof taskStatusEnum.enumValues)[number];
	stageGroupInstanceId: string | null;
};

export const listPendingTaskQueueMetadataByScanJobIdRepo = async (
	scanJobId: string,
): Promise<PendingTaskQueueMetadata[]> =>
	await db
		.select({
			taskId: tasks.taskId,
			scanJobId: tasks.scanJobId,
			name: tasks.name,
			stageName: tasks.stageName,
			status: tasks.status,
			stageGroupInstanceId: tasks.stageGroupInstanceId,
		})
		.from(tasks)
		.where(and(eq(tasks.scanJobId, scanJobId), eq(tasks.status, "pending")));

export const hasActiveCandidateAnalysisTaskRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
}) => {
	const [row] = await db
		.select({ taskId: tasks.taskId })
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.vulnerabilityCandidateId, input.vulnerabilityCandidateId),
				eq(tasks.stageName, "analyze-finding"),
				inArray(tasks.status, [
					"pending",
					"launching",
					"launched",
					"starting",
					"running",
				]),
			),
		)
		.limit(1);
	return Boolean(row);
};

export const listTaskRuntimeIntervalsByScanJobIdRepo = async (
	scanJobId: string,
) =>
	await db
		.select({
			status: tasks.status,
			createdAt: tasks.createdAt,
			startedAt: tasks.startedAt,
			completedAt: tasks.completedAt,
			updatedAt: tasks.updatedAt,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, [
					"launching",
					"launched",
					"starting",
					"running",
					"completed",
					"failed",
					"exited",
					"canceled",
				]),
			),
		);

export const listTasksByScanJobAndStatusesRepo = async (input: {
	scanJobId: string;
	statuses: Array<(typeof taskStatusEnum.enumValues)[number]>;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				inArray(tasks.status, input.statuses),
			),
		)
		.orderBy(desc(tasks.updatedAt));

export const listRunningTaskRuntimeMetadataRepo = async (scanJobId: string) =>
	await db
		.select({
			taskId: tasks.taskId,
			scanJobId: tasks.scanJobId,
			stageName: tasks.stageName,
			name: tasks.name,
			status: tasks.status,
			containerName: tasks.containerName,
			threadId: tasks.threadId,
			agentProfile: tasks.agentProfile,
			updatedAt: tasks.updatedAt,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, ["launching", "launched", "starting", "running"]),
			),
		)
		.orderBy(desc(tasks.updatedAt));

export type RunningStageTaskRepoRow = {
	taskId: string;
	stageName: string;
	title: string;
	status: (typeof RUNNING_TASK_VIEW_STATUSES)[number];
	startedAt: string | null;
	updatedAt: string;
};

export const listRunningTaskViewsByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}): Promise<RunningStageTaskRepoRow[]> => {
	const rows = await db
		.select({
			taskId: tasks.taskId,
			stageName: tasks.stageName,
			title: tasks.name,
			status: tasks.status,
			startedAt: tasks.startedAt,
			updatedAt: tasks.updatedAt,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
				inArray(tasks.status, [...RUNNING_TASK_VIEW_STATUSES]),
			),
		)
		.orderBy(desc(tasks.updatedAt), desc(tasks.taskId));
	return rows.map((row) => ({
		...row,
		status: row.status as RunningStageTaskRepoRow["status"],
	}));
};

export type RunningTaskViewRepoRow = {
	id: string;
	taskId: string;
	taskName: string;
	title: string;
	subtitle: string;
	stage: RunningTaskStage;
	startedAt: string | null;
	updatedAt: string;
};

export const listRunningTaskViewsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<RunningTaskViewRepoRow[]> => {
	const activeStatuses = RUNNING_TASK_VIEW_STATUSES.map(
		(status) => sql`${status}`,
	);
	const result = await db.execute(sql`
		SELECT
			t."taskId",
			t."name",
			t."stageName",
			t."startedAt",
			t."updatedAt",
			vc."title" AS "candidateTitle",
			vc."filePath" AS "candidateFilePath",
			vc."line" AS "candidateLine",
			vc."vulnerabilityType" AS "candidateVulnerabilityType",
			t."input"->>'moduleName' AS "moduleName",
			t."input"->>'moduleId' AS "moduleId",
			t."input"->'module'->>'name' AS "moduleObjectName",
			t."input"->'module'->>'moduleId' AS "moduleObjectId",
			t."input"->>'targetName' AS "targetName",
			t."input"->>'targetId' AS "targetId",
			t."input"->'target'->>'targetName' AS "targetObjectName",
			t."input"->'target'->>'targetId' AS "targetObjectId",
			t."input"->>'functionName' AS "functionName",
			t."input"->>'functionId' AS "functionId",
			t."input"->'function'->>'functionName' AS "functionObjectName",
			t."input"->'function'->>'functionId' AS "functionObjectId",
			t."input"->>'filePath' AS "filePath",
			t."input"->>'line' AS "line",
			t."input"->'target'->>'filePath' AS "targetFilePath",
			t."input"->'target'->>'line' AS "targetLine",
			t."input"->'function'->>'filePath' AS "functionFilePath",
			t."input"->'function'->>'line' AS "functionLine",
			t."input"->'module'->>'name' AS "functionModuleName",
			t."input"->'target'->>'moduleName' AS "targetModuleName",
			t."input"->'function'->>'moduleName' AS "functionModuleNameNested"
		FROM "tasks" t
		LEFT JOIN "vulnerability_candidates" vc
			ON vc."scanJobId" = t."scanJobId"
			AND vc."vulnerabilityCandidateId" = t."vulnerabilityCandidateId"
		WHERE t."scanJobId" = ${scanJobId}
			AND t."status" IN (${sql.join(activeStatuses, sql`, `)})
		ORDER BY t."updatedAt" DESC
	`);

	return result
		.map((row) => {
			const value = row as Record<string, unknown>;
			const stageName = String(value.stageName || "");
			const candidateTitle = String(value.candidateTitle || value.name || "");
			const candidateLocation = [value.candidateFilePath, value.candidateLine]
				.filter((part) => part !== null && part !== undefined && part !== "")
				.join(":");
			const candidateSubtitle =
				[candidateLocation, value.candidateVulnerabilityType]
					.filter(Boolean)
					.join(" · ") || "-";
			const first = (...keys: string[]) =>
				keys
					.map((key) => value[key])
					.find((item) => item !== null && item !== undefined && item !== "") ??
				null;
			const location = (filePath: unknown, line: unknown) =>
				[filePath, line]
					.filter((part) => part !== null && part !== undefined && part !== "")
					.join(":");
			let title = String(value.name || "");
			let subtitle = "-";
			const researchPresentation = getResearchRunningTaskPresentation(
				stageName,
				String(value.name || ""),
			);
			const orchHuntPresentation = getOrchHuntRunningTaskPresentation(
				stageName,
				String(value.name || ""),
			);
			const stage =
				researchPresentation?.stage ??
				orchHuntPresentation?.stage ??
				mapRunningTaskStage(stageName);
			if (!stage) {
				return null;
			}
			if (researchPresentation) {
				title = researchPresentation.title;
				subtitle = researchPresentation.subtitle;
			} else if (orchHuntPresentation) {
				title = orchHuntPresentation.title;
				subtitle = orchHuntPresentation.subtitle;
			} else if (stageName === "delta-scope") {
				title = "Delta Scope";
				subtitle = "Diff impact function scoping";
			} else if (stageName === "repository-profile") {
				title = "Repository Profile";
				subtitle = "Repository-wide planner and module partitioning";
			} else if (stageName === "attack-surface-model") {
				title = String(first("moduleName") || value.name || "");
				subtitle = String(first("moduleId") || "-");
			} else if (stageName === "identify-target") {
				title = String(
					first("moduleName", "moduleObjectName") || value.name || "",
				);
				subtitle = String(first("moduleId", "moduleObjectId") || "-");
			} else if (stageName === "scan-target") {
				title = String(
					first(
						"targetName",
						"targetId",
						"targetObjectName",
						"targetObjectId",
						"functionName",
						"functionId",
						"functionObjectName",
						"functionObjectId",
					) ||
						value.name ||
						"",
				);
				subtitle =
					[
						first(
							"moduleName",
							"moduleObjectName",
							"targetModuleName",
							"functionModuleName",
							"functionModuleNameNested",
						),
						location(
							first("filePath", "targetFilePath", "functionFilePath"),
							first("line", "targetLine", "functionLine"),
						),
					]
						.filter(Boolean)
						.join(" · ") || "-";
			} else {
				title = candidateTitle;
				subtitle = candidateSubtitle;
			}
			return {
				id: `${stageName}-${String(value.taskId)}`,
				taskId: String(value.taskId),
				taskName: String(value.name || ""),
				title,
				subtitle,
				stage,
				startedAt: value.startedAt ? String(value.startedAt) : null,
				updatedAt: String(value.updatedAt || ""),
			};
		})
		.filter((row): row is RunningTaskViewRepoRow => row !== null);
};

export const listTaskStatusCountsByScanJobIdRepo = async (scanJobId: string) =>
	await db
		.select({
			stageName: tasks.stageName,
			status: tasks.status,
			count: count(),
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.groupBy(tasks.stageName, tasks.status);

export const listTerminalTasksPageByScanJobIdRepo = async (input: {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	stageName?: string;
	status?: (typeof taskStatusEnum.enumValues)[number];
}) => {
	const pageSize = Math.max(1, Math.min(100, input.pageSize));
	const requestedPage = Math.max(1, input.page);
	const terminalStatuses: Array<(typeof taskStatusEnum.enumValues)[number]> = [
		"completed",
		"failed",
		"exited",
		"canceled",
	];
	const trimmedQuery = input.query?.trim() || "";
	const conditions = [
		eq(tasks.scanJobId, input.scanJobId),
		inArray(tasks.status, terminalStatuses),
		input.stageName ? eq(tasks.stageName, input.stageName) : undefined,
		input.status ? eq(tasks.status, input.status) : undefined,
		trimmedQuery
			? or(
					ilike(tasks.taskId, `%${trimmedQuery}%`),
					ilike(tasks.name, `%${trimmedQuery}%`),
					ilike(tasks.stageName, `%${trimmedQuery}%`),
					ilike(tasks.errorMessage, `%${trimmedQuery}%`),
				)
			: undefined,
	].filter(Boolean);
	const where = and(...conditions);
	const [{ total = 0 } = { total: 0 }] = await db
		.select({ total: count() })
		.from(tasks)
		.where(where);
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(requestedPage, totalPages);
	const items = await db
		.select({
			taskId: tasks.taskId,
			name: tasks.name,
			stageName: tasks.stageName,
			status: tasks.status,
			input: tasks.input,
			errorMessage: tasks.errorMessage,
			startedAt: tasks.startedAt,
			completedAt: tasks.completedAt,
			updatedAt: tasks.updatedAt,
		})
		.from(tasks)
		.where(where)
		.orderBy(
			desc(sql<string>`coalesce(${tasks.completedAt}, ${tasks.updatedAt})`),
			desc(tasks.taskId),
		)
		.limit(pageSize)
		.offset((page - 1) * pageSize);

	return {
		items,
		total,
		page,
		pageSize,
		totalPages,
	};
};

export const listChildTasksByParentTaskIdRepo = async (parentTaskId: string) =>
	await db
		.select()
		.from(tasks)
		.where(eq(tasks.parentTaskId, parentTaskId))
		.orderBy(desc(tasks.createdAt));

export const listCandidateDescendantTasksByProducerTaskIdRepo = async (input: {
	producerTaskId: string;
	vulnerabilityCandidateId: string;
}) => {
	const directChildren = await listChildTasksByParentTaskIdRepo(
		input.producerTaskId,
	);
	const candidateRoots: Array<typeof tasks.$inferSelect> = [];
	for (const task of directChildren) {
		const candidateId = await readCandidateIdFromTaskInputArtifact(task).catch(
			() => null,
		);
		if (candidateId === input.vulnerabilityCandidateId) {
			candidateRoots.push(task);
		}
	}

	const descendants: Array<typeof tasks.$inferSelect> = [];
	const queue = [...candidateRoots];
	const seenTaskIds = new Set<string>();
	while (queue.length > 0) {
		const task = queue.shift();
		if (!task || seenTaskIds.has(task.taskId)) {
			continue;
		}
		seenTaskIds.add(task.taskId);
		descendants.push(task);
		const children = await listChildTasksByParentTaskIdRepo(task.taskId);
		for (const child of children) {
			if (!seenTaskIds.has(child.taskId)) {
				queue.push(child);
			}
		}
	}

	return descendants.sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);
};

export const listChildTasksByParentTaskIdAndStageRepo = async (input: {
	parentTaskId: string;
	stageName: string;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.parentTaskId, input.parentTaskId),
				eq(tasks.stageName, input.stageName),
			),
		)
		.orderBy(desc(tasks.createdAt));

export const listTasksByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
			),
		)
		.orderBy(desc(tasks.createdAt));

export const listActiveTasksByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
				inArray(tasks.status, ["launching", "launched", "starting", "running"]),
			),
		)
		.orderBy(asc(tasks.createdAt));

export const countActiveTasksByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}) => {
	const row = await db
		.select({ count: count() })
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
				inArray(tasks.status, ["launching", "launched", "starting", "running"]),
			),
		)
		.then((rows) => rows[0]);
	return row?.count ?? 0;
};

export const transitionTaskStatusResultRepo = async (input: {
	taskId: string;
	from: TaskStatus[];
	to: TaskStatus;
	patch?: Partial<typeof tasks.$inferSelect>;
	terminalRouteKey?: string | null;
	allowedJobStatuses?: ScanJobStatus[];
	afterUpdate?: (
		tx: TaskStatusTransaction,
		updatedTask: typeof tasks.$inferSelect,
	) => Promise<void>;
}) => {
	const now = new Date().toISOString();
	const allowedJobStatuses =
		input.allowedJobStatuses ??
		getAllowedJobStatusesForTaskTransition(input.to as TaskExecutionStatus);
	const patch = buildTaskStatusTransitionPatch({
		to: input.to,
		now,
		patch: input.patch,
		terminalRouteKey: input.terminalRouteKey,
	});

	return await db.transaction(async (tx): Promise<TaskStatusTransitionResult> => {
		const job = await tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, sql`(
				select "scanJobId" from "tasks" where "taskId" = ${input.taskId}
			)`))
			.for("share")
			.limit(1)
			.then((rows) => rows[0] ?? null);
		if (!job) {
			return { outcome: "not_found", task: null, jobStatus: null };
		}
		if (!allowedJobStatuses.includes(job.status)) {
			return {
				outcome:
					job.status === "paused" ? "job_paused" : "job_stopped",
				task: null,
				jobStatus: job.status,
			};
		}
		const previous = await tx
			.select()
			.from(tasks)
			.where(
				and(eq(tasks.taskId, input.taskId), inArray(tasks.status, input.from)),
			)
			.limit(1)
			.then((rows) => rows[0] || null);
		if (!previous) {
			const current = await tx
				.select({ status: tasks.status })
				.from(tasks)
				.where(eq(tasks.taskId, input.taskId))
				.limit(1)
				.then((rows) => rows[0] ?? null);
			return {
				outcome: current ? "stale_task" : "not_found",
				task: null,
				jobStatus: job.status,
			};
		}
		const rows = await tx
			.update(tasks)
			.set({
				...patch,
				...(hasTaskCostPatch(patch)
					? { estimatedCost: calculatePatchedTaskCost(previous, patch) }
					: {}),
			})
			.where(
				and(eq(tasks.taskId, input.taskId), inArray(tasks.status, input.from)),
			)
			.returning();
		const updatedTask = rows[0] || null;
		if (!updatedTask) {
			return {
				outcome: "stale_task",
				task: null,
				jobStatus: job.status,
			};
		}
		await applyScanJobTokenUsageDelta(
			tx,
			updatedTask.scanJobId,
			tokenUsageDelta(previous, updatedTask),
		);
		await applyScanJobEstimatedCostDelta(
			tx,
			updatedTask.scanJobId,
			previous.estimatedCost,
			updatedTask.estimatedCost,
		);
		if (input.to === "completed" || input.to === "exited") {
			const resultStage = await resolveCandidateProjectionResultStage(
				tx,
				updatedTask,
			);
			await upsertCandidateResultProjectionTx(
				tx,
				updatedTask,
				undefined,
				resultStage,
			);
		}
		await input.afterUpdate?.(tx, updatedTask);
		return { outcome: "updated", task: updatedTask, jobStatus: job.status };
	});
};

export const transitionTaskStatusRepo = async (input: {
	taskId: string;
	from: TaskStatus[];
	to: TaskStatus;
	patch?: Partial<typeof tasks.$inferSelect>;
	terminalRouteKey?: string | null;
	allowedJobStatuses?: ScanJobStatus[];
	afterUpdate?: (
		tx: TaskStatusTransaction,
		updatedTask: typeof tasks.$inferSelect,
	) => Promise<void>;
}) => {
	const result = await transitionTaskStatusResultRepo(input);
	return result.task;
};


export const updateTaskRepo = async (
	taskId: string,
	patch: Partial<typeof tasks.$inferSelect>,
) => {
	if (patch.status !== undefined) {
		return await updateTaskStatusRepo({
			taskId,
			status: patch.status,
			errorMessage: patch.errorMessage,
		});
	}
	const nextPatch = {
		...patch,
		updatedAt: new Date().toISOString(),
	};
	const updated = requiresTaskUsageTransaction(patch)
		? await db.transaction(async (tx) => {
				const previous = await tx
					.select()
					.from(tasks)
					.where(eq(tasks.taskId, taskId))
					.limit(1)
					.then((rows) => rows[0] || null);
				if (!previous) {
					return null;
				}
				const rows = await tx
					.update(tasks)
					.set({
						...nextPatch,
						...(hasTaskCostPatch(patch)
							? { estimatedCost: calculatePatchedTaskCost(previous, patch) }
							: {}),
					})
					.where(eq(tasks.taskId, taskId))
					.returning();
				const updatedTask = rows[0] || null;
				if (!updatedTask) {
					return null;
				}
				await applyScanJobTokenUsageDelta(
					tx,
					updatedTask.scanJobId,
					tokenUsageDelta(previous, updatedTask),
				);
				await applyScanJobEstimatedCostDelta(
					tx,
					updatedTask.scanJobId,
					previous.estimatedCost,
					updatedTask.estimatedCost,
				);
				return updatedTask;
			})
		: await db
				.update(tasks)
				.set(nextPatch)
				.where(eq(tasks.taskId, taskId))
				.returning()
				.then((rows) => rows[0] || null);

	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated;
};

export const updateTaskStatusRepo = async (input: {
	taskId: string;
	status: (typeof taskStatusEnum.enumValues)[number];
	errorMessage?: string | null;
}) => {
	const patch: Partial<typeof tasks.$inferSelect> = {
		status: input.status,
		errorMessage: input.errorMessage ?? null,
	};

	if (
		input.status === "launching" ||
		input.status === "launched" ||
		input.status === "starting" ||
		input.status === "running"
	) {
		patch.startedAt = new Date().toISOString();
		patch.completedAt = null;
	}

	if (
		input.status === "completed" ||
		input.status === "failed" ||
		input.status === "exited" ||
		input.status === "canceled"
	) {
		patch.completedAt = new Date().toISOString();
	}

	const result = await transitionTaskStatusResultRepo({
		taskId: input.taskId,
		from: ALL_TASK_EXECUTION_STATUSES as TaskStatus[],
		to: input.status,
		patch,
	});
	if (result.outcome === "not_found") {
		throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
	}
	return result.task;
};

export const bindTaskRuntimeRepo = async (input: {
	taskId: string;
	containerName?: string | null;
	containerIndex?: number | null;
	threadId?: string | null;
	agentProfile?: typeof tasks.$inferSelect.agentProfile;
}) =>
	await updateTaskRepo(input.taskId, {
		containerName: input.containerName,
		...(input.containerIndex !== undefined
			? { containerIndex: input.containerIndex }
			: {}),
		threadId: input.threadId,
		agentProfile: input.agentProfile,
	});

export const storeTaskInputRepo = async (
	taskId: string,
	input: typeof tasks.$inferSelect.input,
) => await updateTaskRepo(taskId, { input });

export const storeTaskOutputRepo = async (
	taskId: string,
	output: typeof tasks.$inferSelect.output,
) => await updateTaskRepo(taskId, { output });

export const resetFailedTaskForRetryRepo = async (taskId: string) => {
	const updated = await db.transaction(async (tx) => {
		const previous = await tx
			.select()
			.from(tasks)
			.where(eq(tasks.taskId, taskId))
			.limit(1)
			.then((rows) => rows[0] || null);
		if (!previous) {
			return null;
		}
		const job = await tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, previous.scanJobId))
			.for("share")
			.limit(1)
			.then((rows) => rows[0] ?? null);
		if (!job) return null;
		if (job.status !== "running" && job.status !== "pending") {
			throw new ScanJobExecutionNotAllowedError(
				previous.scanJobId,
				job.status,
			);
		}
		const rows = await tx
			.update(tasks)
			.set({
				status: "pending",
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				containerName: null,
				containerIndex: null,
				threadId: null,
				output: null,
				inputTokens: null,
				outputTokens: null,
				thoughtTokens: null,
				totalTokens: null,
				cachedReadTokens: null,
				cachedWriteTokens: null,
				estimatedCost: null,
				attempt: sql`${tasks.attempt} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(tasks.taskId, taskId))
			.returning();
		const updatedTask = rows[0] || null;
		if (!updatedTask) {
			return null;
		}
		await applyScanJobTokenUsageDelta(
			tx,
			updatedTask.scanJobId,
			tokenUsageDelta(previous, updatedTask),
		);
		await applyScanJobEstimatedCostDelta(
			tx,
			updatedTask.scanJobId,
			previous.estimatedCost,
			updatedTask.estimatedCost,
		);
		await tx
			.delete(vulnerabilityCandidates)
			.where(eq(vulnerabilityCandidates.producerTaskId, taskId));
		return updatedTask;
	});

	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated;
};

export const requeueTaskRepo = async (taskId: string) => {
	const updated = await db.transaction(async (tx) => {
		const previous = await tx
			.select()
			.from(tasks)
			.where(eq(tasks.taskId, taskId))
			.limit(1)
			.then((rows) => rows[0] || null);
		if (!previous) {
			return null;
		}
		const job = await tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, previous.scanJobId))
			.for("share")
			.limit(1)
			.then((rows) => rows[0] ?? null);
		if (!job) return null;
		if (job.status !== "running") {
			throw new ScanJobExecutionNotAllowedError(
				previous.scanJobId,
				job.status,
			);
		}
		const rows = await tx
			.update(tasks)
			.set({
				status: "pending",
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				containerName: null,
				containerIndex: null,
				threadId: null,
				output: null,
				inputTokens: null,
				outputTokens: null,
				thoughtTokens: null,
				totalTokens: null,
				cachedReadTokens: null,
				cachedWriteTokens: null,
				estimatedCost: null,
				attempt: sql`${tasks.attempt} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(tasks.taskId, taskId))
			.returning();
		const updatedTask = rows[0] || null;
		if (!updatedTask) {
			return null;
		}
		await applyScanJobTokenUsageDelta(
			tx,
			updatedTask.scanJobId,
			tokenUsageDelta(previous, updatedTask),
		);
		await applyScanJobEstimatedCostDelta(
			tx,
			updatedTask.scanJobId,
			previous.estimatedCost,
			updatedTask.estimatedCost,
		);
		return updatedTask;
	});

	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated;
};

export const listAnalysisResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<AnalysisResult[]> => {
	const analysisTasks = await listTasksByScanJobAndStageRepo({
		scanJobId,
		stageName: "analyze-finding",
	});
	return (
		await Promise.all(analysisTasks.map(buildAnalysisTaskResultView))
	).filter((item): item is AnalysisResult => Boolean(item));
};

export const listVerificationResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<VerificationResult[]> => {
	const verificationTasks = await listTasksByScanJobAndStageRepo({
		scanJobId,
		stageName: "verify-finding",
	});
	return (
		await Promise.all(verificationTasks.map(buildVerificationTaskResultView))
	).filter((item): item is VerificationResult => Boolean(item));
};

export const listTriageResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<TriageResult[]> => {
	const triageTasks = await listTasksByScanJobAndStageRepo({
		scanJobId,
		stageName: "triage-finding",
	});
	return (await Promise.all(triageTasks.map(buildTriageTaskResultView))).filter(
		(item): item is TriageResult => Boolean(item),
	);
};

export const findLatestAnalysisResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}): Promise<AnalysisResult | null> => {
	if (input.producerTaskId) {
		const candidateTasks =
			await listCandidateDescendantTasksByProducerTaskIdRepo({
				producerTaskId: input.producerTaskId,
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			});
		for (const task of candidateTasks) {
			if (task.stageName !== "analyze-finding") {
				continue;
			}
			const result = await buildAnalysisTaskResultView(task);
			if (result?.vulnerabilityCandidateId === input.vulnerabilityCandidateId) {
				return result;
			}
		}
		return null;
	}

	return (
		(await listAnalysisResultsByScanJobIdRepo(input.scanJobId)).find(
			(result) =>
				result.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		) || null
	);
};

export const findLatestVerificationResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}): Promise<VerificationResult | null> => {
	if (input.producerTaskId) {
		const candidateTasks =
			await listCandidateDescendantTasksByProducerTaskIdRepo({
				producerTaskId: input.producerTaskId,
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			});
		for (const task of candidateTasks) {
			if (task.stageName !== "verify-finding") {
				continue;
			}
			const result = await buildVerificationTaskResultView(task);
			if (result?.vulnerabilityCandidateId === input.vulnerabilityCandidateId) {
				return result;
			}
		}
		return null;
	}

	return (
		(await listVerificationResultsByScanJobIdRepo(input.scanJobId)).find(
			(result) =>
				result.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		) || null
	);
};

export const findLatestTriageResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}): Promise<TriageResult | null> => {
	if (input.producerTaskId) {
		const candidateTasks =
			await listCandidateDescendantTasksByProducerTaskIdRepo({
				producerTaskId: input.producerTaskId,
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			});
		for (const task of candidateTasks) {
			if (task.stageName !== "triage-finding") {
				continue;
			}
			const result = await buildTriageTaskResultView(task);
			if (result?.vulnerabilityCandidateId === input.vulnerabilityCandidateId) {
				return result;
			}
		}
		return null;
	}

	return (
		(await listTriageResultsByScanJobIdRepo(input.scanJobId)).find(
			(result) =>
				result.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		) || null
	);
};

export const countTasksByScanJobAndStatusRepo = async (scanJobId: string) =>
	await db
		.select({
			status: tasks.status,
			count: sql<number>`count(*)::int`,
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.groupBy(tasks.status);

export const countOpenTasksByScanJobIdRepo = async (scanJobId: string) => {
	const [row] = await db
		.select({
			count: sql<number>`count(*)::int`,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, [
					"pending",
					"launching",
					"launched",
					"starting",
					"running",
				]),
			),
		);
	return Number(row?.count || 0);
};

export const cancelOpenTasksByScanJobIdRepo = async (
	scanJobId: string,
	errorMessage?: string | null,
) =>
	await db.transaction(async (tx) => {
		const job = await tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, scanJobId))
			.for("update")
			.limit(1)
			.then((rows) => rows[0] ?? null);
		if (!job) return [];
		const canceled = await tx
			.update(tasks)
			.set({
				status: "canceled",
				errorMessage: errorMessage ?? null,
				completedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(tasks.scanJobId, scanJobId),
					inArray(tasks.status, [
						"pending",
						"launching",
						"launched",
						"starting",
						"running",
					]),
				),
			)
			.returning();
		await tx
			.update(tasks)
			.set({
				downstreamDispatchStatus: "completed",
				downstreamDispatchedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(tasks.scanJobId, scanJobId),
					inArray(tasks.downstreamDispatchStatus, ["pending", "dispatching"]),
				),
			)
		return canceled;
	});

export const countTasksByScanJobStageAndStatusRepo = async (
	scanJobId: string,
) =>
	await db
		.select({
			stageName: tasks.stageName,
			status: tasks.status,
			count: sql<number>`count(*)::int`,
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.groupBy(tasks.stageName, tasks.status);


/**
 * V3 loop-safety: atomically claim one task slot against the job's persisted
 * `maxTasks` / `deadlineAt` budget. The counter lives on scan_jobs so worker
 * restarts and retries cannot reset it. Jobs without `maxTasks` (legacy
 * scanType runs) are unlimited and pass through untouched.
 *
 * Throws `ScanJobBudgetExceededError` when the budget is exhausted; the
 * caller stops dispatching and the worker marks the job failed with a
 * `terminationReason`.
 */
export class ScanJobBudgetExceededError extends Error {
	constructor(
		public readonly scanJobId: string,
		public readonly reason: "task_limit" | "duration_limit",
	) {
		super(
			reason === "task_limit"
				? `Scan job ${scanJobId} exceeded its task limit`
				: `Scan job ${scanJobId} exceeded its duration limit`,
		);
		this.name = "ScanJobBudgetExceededError";
	}
}

const consumeScanJobTaskBudgetWithExecutor = async (
	executor: TaskStatusTransaction,
	scanJobId: string,
) => {
	const now = new Date().toISOString();
	const claimed = await executor
		.update(scanJobs)
		.set({ taskCount: sql`${scanJobs.taskCount} + 1` })
		.where(
			and(
				eq(scanJobs.scanJobId, scanJobId),
				or(
					sql`${scanJobs.maxTasks} is null`,
					sql`${scanJobs.taskCount} < ${scanJobs.maxTasks}`,
				),
				or(
					sql`${scanJobs.deadlineAt} is null`,
					sql`${scanJobs.deadlineAt} > ${now}`,
				),
			),
		)
		.returning({ taskCount: scanJobs.taskCount });

	if (claimed.length > 0) {
		return claimed[0]!.taskCount;
	}

	// Budget exhausted — determine why and record the termination reason so
	// the run detail page can explain the failure.
	const scanJob = await executor
		.select({
			maxTasks: scanJobs.maxTasks,
			taskCount: scanJobs.taskCount,
			deadlineAt: scanJobs.deadlineAt,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]);
	const reason: "task_limit" | "duration_limit" =
		scanJob &&
		scanJob.maxTasks != null &&
		scanJob.taskCount >= scanJob.maxTasks
			? "task_limit"
			: "duration_limit";
	await executor
		.update(scanJobs)
		.set({ terminationReason: reason })
		.where(
			and(
				eq(scanJobs.scanJobId, scanJobId),
				or(
					sql`${scanJobs.terminationReason} is null`,
					sql`${scanJobs.terminationReason} != ${reason}`,
				),
			),
		);
	throw new ScanJobBudgetExceededError(scanJobId, reason);
};

export const consumeScanJobTaskBudget = async (scanJobId: string) =>
	await db.transaction((tx) =>
		consumeScanJobTaskBudgetWithExecutor(tx, scanJobId),
	);
