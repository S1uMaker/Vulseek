import { TRPCError } from "@trpc/server";
import { db } from "@vulseek/server/db";
import {
	messages,
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
	getOrchHuntRunningTaskPresentation,
	getResearchRunningTaskPresentation,
	mapRunningTaskStage,
	RUNNING_TASK_VIEW_STATUSES,
	type RunningTaskStage,
} from "../running-task-stage";
import { createShortTaskId, createTaskIdForSource } from "../task-id";
import type {
	AnalysisResult,
	TriageResult,
	VerificationResult,
} from "../types";
import { findCandidateByIdWithResultsRepo } from "./candidate-list.repo";
import {
	applyCandidateStageResultTx,
	type CandidateResultStage,
} from "./candidate-result.repo";
import { readCandidateIdFromTaskInputArtifact } from "./task-artifact-resolver";
import {
	ALL_TASK_EXECUTION_STATUSES,
	getAllowedJobStatusesForTaskTransition,
	type ScanJobExecutionStatus,
	type TaskExecutionStatus,
} from "./task-status-policy";
import { buildTaskStatusTransitionPatch } from "./task-status-transition";

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

const resolveCandidateResultStage = async (
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	task: typeof tasks.$inferSelect,
): Promise<CandidateResultStage | undefined> => {
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

const tokenUsageKeys = [
	"inputTokens",
	"outputTokens",
	"thoughtTokens",
	"totalTokens",
	"cachedReadTokens",
	"cachedWriteTokens",
] as const;

type TaskTokenUsageKey = (typeof tokenUsageKeys)[number];

const hasTokenUsagePatch = (patch: Partial<typeof tasks.$inferSelect>) =>
	tokenUsageKeys.some((key) => key in patch);

const requiresTaskUsageTransaction = (
	patch: Partial<typeof tasks.$inferSelect>,
) =>
	hasTokenUsagePatch(patch) ||
	"estimatedCost" in patch ||
	"agentProfile" in patch;

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

export const syncScanJobTokenUsageFromTasksRepo = async (scanJobId: string) => {
	const [totals] = await db
		.select({
			inputTokens: sql<number>`coalesce(sum(${tasks.inputTokens}), 0)`,
			outputTokens: sql<number>`coalesce(sum(${tasks.outputTokens}), 0)`,
			thoughtTokens: sql<number>`coalesce(sum(${tasks.thoughtTokens}), 0)`,
			totalTokens: sql<number>`coalesce(sum(${tasks.totalTokens}), 0)`,
			cachedReadTokens: sql<number>`coalesce(sum(${tasks.cachedReadTokens}), 0)`,
			cachedWriteTokens: sql<number>`coalesce(sum(${tasks.cachedWriteTokens}), 0)`,
			estimatedCost: sql<number>`coalesce(sum(${tasks.estimatedCost}), 0)`,
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId));
	await db
		.update(scanJobs)
		.set({
			inputTokens: Number(totals?.inputTokens ?? 0),
			outputTokens: Number(totals?.outputTokens ?? 0),
			thoughtTokens: Number(totals?.thoughtTokens ?? 0),
			totalTokens: Number(totals?.totalTokens ?? 0),
			cachedReadTokens: Number(totals?.cachedReadTokens ?? 0),
			cachedWriteTokens: Number(totals?.cachedWriteTokens ?? 0),
			estimatedCost: Number(totals?.estimatedCost ?? 0),
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

export const createTaskRepo = async (input: {
	taskId?: string;
	scanJobId: string;
	name: string;
	stageName: string;
	lifecycle?: "turn" | "goal";
	sourceMessageId?: string | null;
	sourceEdgeName?: string | null;
	sourceItemIndex?: number | null;
	rerunOfTaskId?: string | null;
	status?: (typeof taskStatusEnum.enumValues)[number];
	priority?: number | null;
	attempt?: number;
	agentProfile?: typeof tasks.$inferSelect.agentProfile;
	containerName?: string | null;
	containerIndex?: number | null;
	threadId?: string | null;
	runtimeMode?: typeof tasks.$inferSelect.runtimeMode;
	forkedFromTaskId?: string | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	thoughtTokens?: number | null;
	totalTokens?: number | null;
	cachedReadTokens?: number | null;
	cachedWriteTokens?: number | null;
	estimatedCost?: number | null;
	errorMessage?: string | null;
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
		if (
			input.sourceMessageId &&
			input.sourceEdgeName &&
			input.sourceItemIndex != null &&
			!input.rerunOfTaskId
		) {
			const existing = await tx
				.select()
				.from(tasks)
				.where(
					and(
						eq(tasks.sourceMessageId, input.sourceMessageId),
						eq(tasks.sourceEdgeName, input.sourceEdgeName),
						eq(tasks.sourceItemIndex, input.sourceItemIndex),
					),
				)
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
							(input.sourceMessageId &&
							input.sourceEdgeName &&
							input.sourceItemIndex != null &&
							!input.rerunOfTaskId
								? createTaskIdForSource({
										sourceMessageId: input.sourceMessageId,
										sourceEdgeName: input.sourceEdgeName,
										sourceItemIndex: input.sourceItemIndex,
									})
								: createShortTaskId()),
						scanJobId: input.scanJobId,
						name: input.name,
						stageName: input.stageName,
						lifecycle: input.lifecycle ?? "turn",
						sourceMessageId: input.sourceMessageId ?? null,
						sourceEdgeName: input.sourceEdgeName ?? null,
						sourceItemIndex: input.sourceItemIndex ?? null,
						rerunOfTaskId: input.rerunOfTaskId ?? null,
						status: input.status ?? "pending",
						priority: input.priority ?? null,
						attempt: input.attempt ?? 0,
						agentProfile: input.agentProfile ?? null,
						containerName: input.containerName ?? null,
						containerIndex: input.containerIndex ?? null,
						threadId: input.threadId ?? null,
						runtimeMode: input.runtimeMode ?? "new_session",
						forkedFromTaskId: input.forkedFromTaskId ?? null,
						inputTokens: input.inputTokens ?? null,
						outputTokens: input.outputTokens ?? null,
						thoughtTokens: input.thoughtTokens ?? null,
						totalTokens: input.totalTokens ?? null,
						cachedReadTokens: input.cachedReadTokens ?? null,
						cachedWriteTokens: input.cachedWriteTokens ?? null,
						estimatedCost: input.estimatedCost ?? 0,
						errorMessage: input.errorMessage ?? null,
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
	sourceEdgeName: string | null;
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
			sourceEdgeName: tasks.sourceEdgeName,
			stageGroupInstanceId: tasks.stageGroupInstanceId,
		})
		.from(tasks)
		.where(and(eq(tasks.scanJobId, scanJobId), eq(tasks.status, "pending")));

export const hasActiveCandidateAnalysisTaskRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
}) => {
	const active = await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, "analyze-finding"),
				inArray(tasks.status, [
					"pending",
					"launching",
					"launched",
					"starting",
					"running",
				]),
			),
		);
	for (const task of active) {
		const candidateId = await readCandidateIdFromTaskInputArtifact(task).catch(
			() => null,
		);
		if (candidateId === input.vulnerabilityCandidateId) {
			return true;
		}
	}
	return false;
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
	name: string;
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
			name: tasks.name,
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
	const result = await db
		.select({
			taskId: tasks.taskId,
			name: tasks.name,
			stageName: tasks.stageName,
			startedAt: tasks.startedAt,
			updatedAt: tasks.updatedAt,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, [...RUNNING_TASK_VIEW_STATUSES]),
			),
		)
		.orderBy(desc(tasks.updatedAt), desc(tasks.taskId));

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
			lifecycle: tasks.lifecycle,
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
		.select({ task: tasks })
		.from(tasks)
		.innerJoin(messages, eq(tasks.sourceMessageId, messages.messageId))
		.where(eq(messages.sourceTaskId, parentTaskId))
		.orderBy(desc(tasks.createdAt))
		.then((rows) => rows.map((row) => row.task));

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
		.select({ task: tasks })
		.from(tasks)
		.innerJoin(messages, eq(tasks.sourceMessageId, messages.messageId))
		.where(
			and(
				eq(messages.sourceTaskId, input.parentTaskId),
				eq(tasks.stageName, input.stageName),
			),
		)
		.orderBy(desc(tasks.createdAt))
		.then((rows) => rows.map((row) => row.task));

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

	return await db.transaction(
		async (tx): Promise<TaskStatusTransitionResult> => {
			const job = await tx
				.select({ status: scanJobs.status })
				.from(scanJobs)
				.where(
					eq(
						scanJobs.scanJobId,
						sql`(
				select "scanJobId" from "tasks" where "taskId" = ${input.taskId}
			)`,
					),
				)
				.for("share")
				.limit(1)
				.then((rows) => rows[0] ?? null);
			if (!job) {
				return { outcome: "not_found", task: null, jobStatus: null };
			}
			if (!allowedJobStatuses.includes(job.status)) {
				return {
					outcome: job.status === "paused" ? "job_paused" : "job_stopped",
					task: null,
					jobStatus: job.status,
				};
			}
			const previous = await tx
				.select()
				.from(tasks)
				.where(
					and(
						eq(tasks.taskId, input.taskId),
						inArray(tasks.status, input.from),
					),
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
				})
				.where(
					and(
						eq(tasks.taskId, input.taskId),
						inArray(tasks.status, input.from),
					),
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
				const resultStage = await resolveCandidateResultStage(tx, updatedTask);
				await applyCandidateStageResultTx(
					tx,
					updatedTask,
					undefined,
					resultStage,
				);
			}
			await input.afterUpdate?.(tx, updatedTask);
			return { outcome: "updated", task: updatedTask, jobStatus: job.status };
		},
	);
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

export const storeTaskInputRepo = async (_taskId: string, _input: unknown) => {
	throw new Error("tasks.input has been removed; reconstruct from Message");
};

export const storeMessageRepo = async (_taskId: string, _output: unknown) => {
	throw new Error("tasks.output has been removed; submit a Message");
};

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
			throw new ScanJobExecutionNotAllowedError(previous.scanJobId, job.status);
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
			throw new ScanJobExecutionNotAllowedError(previous.scanJobId, job.status);
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

const loadCandidateResults = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}) =>
	await findCandidateByIdWithResultsRepo({
		scanJobId: input.scanJobId,
		vulnerabilityCandidateId: input.vulnerabilityCandidateId,
		producerTaskId: input.producerTaskId ?? undefined,
	});

export const findLatestAnalysisResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}): Promise<AnalysisResult | null> =>
	(await loadCandidateResults(input))?.latestAnalysisResult ?? null;

export const findLatestVerificationResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}): Promise<VerificationResult | null> =>
	(await loadCandidateResults(input))?.latestVerificationResult ?? null;

export const findLatestTriageResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}): Promise<TriageResult | null> =>
	(await loadCandidateResults(input))?.latestTriageResult ?? null;

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
 * `maxTasks` / `deadlineAt` / `tokenBudget` limits. The counter lives on
 * scan_jobs so worker restarts and retries cannot reset it. Jobs without
 * `maxTasks` (legacy scanType runs) are unlimited and pass through untouched.
 *
 * Throws `ScanJobBudgetExceededError` when the budget is exhausted; the
 * caller stops dispatching and the worker marks the job failed with a
 * `terminationReason`.
 */
export class ScanJobBudgetExceededError extends Error {
	constructor(
		public readonly scanJobId: string,
		public readonly reason: "task_limit" | "duration_limit" | "token_budget",
	) {
		super(
			reason === "task_limit"
				? `Scan job ${scanJobId} exceeded its task limit`
				: reason === "token_budget"
					? `Scan job ${scanJobId} exceeded its token usage budget`
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
				or(
					sql`${scanJobs.tokenBudget} is null`,
					sql`${scanJobs.totalTokens} < ${scanJobs.tokenBudget}`,
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
			tokenBudget: scanJobs.tokenBudget,
			totalTokens: scanJobs.totalTokens,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]);
	const reason: "task_limit" | "duration_limit" | "token_budget" =
		scanJob &&
		scanJob.tokenBudget != null &&
		scanJob.totalTokens >= scanJob.tokenBudget
			? "token_budget"
			: scanJob &&
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
