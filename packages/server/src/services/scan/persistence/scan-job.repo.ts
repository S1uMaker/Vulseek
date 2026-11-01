import { TRPCError } from "@trpc/server";
import { db } from "@vulseek/server/db";
import type {
	ScanJobOutput,
	ScanRuntimeSettings,
} from "@vulseek/server/db/schema";
import { messages, scanJobs, tasks } from "@vulseek/server/db/schema";
import { and, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import {
	normalizeLegacyVerificationSchema,
	normalizePipelineDefinitionSnapshot,
	type ScanPipelineDefinitions,
} from "../pipeline/scan-pipeline-definitions";
import {
	normalizeScanRuntimeSettings,
	normalizeScanRuntimeSettingsForStages,
} from "../runtime-settings";

const scanJobRootStageName = sql<string>`
	coalesce(
		${scanJobs.pipelineCompiledSnapshot}->>'root',
		jsonb_extract_path_text(
			${scanJobs.scanPipelineDefinitionSnapshot},
			VARIADIC ARRAY['pipelines', ${scanJobs.pipelineId}::text, 'rootStageId']::text[]
		)
	)`;

const latestRepositoryTaskId = sql<string>`(
	select "taskId"
	from "tasks"
	where "scanJobId" = ${scanJobs.scanJobId}
	  and "stageName" = ${scanJobRootStageName}
	order by "createdAt" desc, "taskId" desc
	limit 1
)`;

const selectScanJobWithRepositoryTaskStatus = {
	scanJobId: scanJobs.scanJobId,
	title: scanJobs.title,
	description: scanJobs.description,
	note: scanJobs.note,
	pipelineId: scanJobs.pipelineId,
	pipelineSlug: sql<string | null>`(
		select "slug" from "scan_pipelines"
		where "pipelineId" = ${scanJobs.pipelineId}
	)`,
	pipelineName: sql<string | null>`(
		select "name" from "scan_pipelines"
		where "pipelineId" = ${scanJobs.pipelineId}
	)`,
	status: scanJobs.status,
	triggerSource: scanJobs.triggerSource,
	commitSha: scanJobs.commitSha,
	baseSha: scanJobs.baseSha,
	targetRef: scanJobs.targetRef,
	targetTag: scanJobs.targetTag,
	scanRuntimeSettings: scanJobs.scanRuntimeSettings,
	scanPipelineDefinitionSnapshot: scanJobs.scanPipelineDefinitionSnapshot,
	outputs: scanJobs.outputs,
	commitWindow: scanJobs.commitWindow,
	applicationId: scanJobs.applicationId,
	composeId: scanJobs.composeId,
	datasetEvaluationTrialId: scanJobs.datasetEvaluationTrialId,
	pipelineVersionId: scanJobs.pipelineVersionId,
	pipelineVersionNumber: sql<number | null>`(
		select "versionNumber" from "scan_pipeline_versions"
		where "pipelineVersionId" = ${scanJobs.pipelineVersionId}
	)`,
	pipelineProfileId: scanJobs.pipelineProfileId,
	pipelineProfileName: sql<string | null>`(
		select "name" from "scan_pipeline_profiles"
		where "pipelineProfileId" = ${scanJobs.pipelineProfileId}
	)`,
	pipelineYamlSnapshot: scanJobs.pipelineYamlSnapshot,
	pipelineCompiledSnapshot: scanJobs.pipelineCompiledSnapshot,
	maxTasks: scanJobs.maxTasks,
	deadlineAt: scanJobs.deadlineAt,
	taskCount: scanJobs.taskCount,
	terminationReason: scanJobs.terminationReason,
	tokenBudget: scanJobs.tokenBudget,
	timeBudgetSeconds: scanJobs.timeBudgetSeconds,
	createdAt: scanJobs.createdAt,
	startedAt: scanJobs.startedAt,
	finishedAt: scanJobs.finishedAt,
	errorMessage: scanJobs.errorMessage,
	scanningThreadId: scanJobs.scanningThreadId,
	inputTokens: scanJobs.inputTokens,
	outputTokens: scanJobs.outputTokens,
	thoughtTokens: scanJobs.thoughtTokens,
	totalTokens: scanJobs.totalTokens,
	cachedReadTokens: scanJobs.cachedReadTokens,
	cachedWriteTokens: scanJobs.cachedWriteTokens,
	estimatedCost: scanJobs.estimatedCost,
	repositoryTaskId: tasks.taskId,
	repositoryTaskStatus: sql<
		typeof tasks.$inferSelect.status
	>`coalesce(${tasks.status}, 'pending')`,
};

export const deleteScanJobByIdRepo = async (scanJobId: string) => {
	await db.delete(scanJobs).where(eq(scanJobs.scanJobId, scanJobId));
};

export const findScanJobByIdRepo = async (scanJobId: string) => {
	const scanJob = await db
		.select(selectScanJobWithRepositoryTaskStatus)
		.from(scanJobs)
		.leftJoin(
			tasks,
			and(
				eq(tasks.scanJobId, scanJobs.scanJobId),
				eq(tasks.stageName, scanJobRootStageName),
				eq(tasks.taskId, latestRepositoryTaskId),
			),
		)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]);

	if (!scanJob) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	return scanJob;
};

export const findScanJobRuntimeControlRepo = async (scanJobId: string) =>
	await db
		.select({
			status: scanJobs.status,
			scanRuntimeSettings: scanJobs.scanRuntimeSettings,
			tokenBudget: scanJobs.tokenBudget,
			timeBudgetSeconds: scanJobs.timeBudgetSeconds,
			totalTokens: scanJobs.totalTokens,
			startedAt: scanJobs.startedAt,
			createdAt: scanJobs.createdAt,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0] ?? null);

const OPEN_TASK_STATUSES = [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
] as const;

const CANCELLABLE_JOB_STATUSES = ["pending", "running", "paused"] as const;

export type ScanJobStatus = (typeof scanJobs.$inferSelect)["status"];

export type ScanJobStatusTransitionResult = {
	updated: boolean;
	job: typeof scanJobs.$inferSelect | null;
};

export type CancelScanJobRepoResult = {
	outcome: "canceled" | "already_stopped" | "not_found";
	jobStatus: (typeof scanJobs.$inferSelect)["status"] | null;
	tasksToStop: Array<typeof tasks.$inferSelect>;
	stoppedDispatchTaskIds: string[];
};

export const cancelScanJobRepo = async (input: {
	scanJobId: string;
	errorMessage: string;
	terminationReason: string;
}): Promise<CancelScanJobRepoResult> => {
	const now = new Date().toISOString();
	return await db.transaction(async (tx) => {
		const job = await tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, input.scanJobId))
			.for("update")
			.limit(1)
			.then((rows) => rows[0] ?? null);
		if (!job) {
			return {
				outcome: "not_found",
				jobStatus: null,
				tasksToStop: [],
				stoppedDispatchTaskIds: [],
			};
		}
		if (!CANCELLABLE_JOB_STATUSES.some((status) => status === job.status)) {
			return {
				outcome: "already_stopped",
				jobStatus: job.status,
				tasksToStop: [],
				stoppedDispatchTaskIds: [],
			};
		}

		const tasksToStop = await tx
			.update(tasks)
			.set({
				status: "canceled",
				errorMessage: input.errorMessage,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(tasks.scanJobId, input.scanJobId),
					inArray(tasks.status, [...OPEN_TASK_STATUSES]),
				),
			)
			.returning();

		const producerIds = await tx
			.select({ taskId: tasks.taskId })
			.from(tasks)
			.where(eq(tasks.scanJobId, input.scanJobId));
		const stoppedDispatches =
			producerIds.length === 0
				? []
				: await tx
						.update(messages)
						.set({
							dispatchStatus: "failed",
							errorMessage: "Scan job canceled",
							updatedAt: now,
						})
						.where(
							and(
								inArray(
									messages.sourceTaskId,
									producerIds.map((row) => row.taskId),
								),
								inArray(messages.status, ["pending", "processing"]),
							),
						)
						.returning({ taskId: messages.sourceTaskId });

		await tx
			.update(scanJobs)
			.set({
				status: "canceled",
				finishedAt: now,
				terminationReason: input.terminationReason,
				errorMessage: input.errorMessage,
			})
			.where(
				and(
					eq(scanJobs.scanJobId, input.scanJobId),
					inArray(scanJobs.status, [...CANCELLABLE_JOB_STATUSES]),
				),
			)
			.returning({ scanJobId: scanJobs.scanJobId });
		return {
			outcome: "canceled",
			jobStatus: "canceled",
			tasksToStop,
			stoppedDispatchTaskIds: stoppedDispatches.map((row) => row.taskId),
		};
	});
};

/**
 * Atomically changes a job state when its current state is one of `from`.
 * Queue workers use this instead of an unconditional status write so a
 * cancellation committed concurrently remains the execution authority.
 */
export const transitionScanJobStatusRepo = async (input: {
	scanJobId: string;
	from: ScanJobStatus[];
	to: ScanJobStatus;
	errorMessage?: string | null;
	terminationReason?: string | null;
}): Promise<ScanJobStatusTransitionResult> => {
	const now = new Date().toISOString();
	const patch: Partial<typeof scanJobs.$inferSelect> = {
		status: input.to,
	};
	if (input.to === "running") {
		patch.startedAt = now;
		patch.finishedAt = null;
	}
	if (
		input.to === "finished" ||
		input.to === "partially_finished" ||
		input.to === "failed" ||
		input.to === "canceled"
	) {
		patch.finishedAt = now;
	}
	if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage;
	if (input.terminationReason !== undefined) {
		patch.terminationReason = input.terminationReason;
	}

	const updated = await db
		.update(scanJobs)
		.set(patch)
		.where(
			and(
				eq(scanJobs.scanJobId, input.scanJobId),
				inArray(scanJobs.status, input.from),
			),
		)
		.returning();
	if (updated[0]) return { updated: true, job: updated[0] };

	const current = await db
		.select()
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, input.scanJobId))
		.limit(1)
		.then((rows) => rows[0] ?? null);
	return { updated: false, job: current };
};

type ScanJobOutputTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

export const appendScanJobOutputTx = async (
	tx: ScanJobOutputTransaction,
	input: { scanJobId: string; output: ScanJobOutput },
) => {
	const currentOutputs = sql`coalesce(${scanJobs.outputs}, '[]'::jsonb)`;
	const serializedOutput = JSON.stringify([input.output]);
	await tx
		.update(scanJobs)
		.set({
			outputs: sql<ScanJobOutput[]>`
				case
					when exists (
						select 1
						from jsonb_array_elements(${currentOutputs}) as entry
						where entry->>'messageId' = ${input.output.messageId}
					) then ${currentOutputs}
					else ${currentOutputs} || ${serializedOutput}::jsonb
				end
			`,
		})
		.where(eq(scanJobs.scanJobId, input.scanJobId));
};

export type ScanJobListPageInput = {
	page: number;
	pageSize: number;
	search?: string;
	status?:
		| "pending"
		| "running"
		| "paused"
		| "finalizing"
		| "finished"
		| "partially_finished"
		| "failed"
		| "canceled";
};

const buildScanJobListConditions = (
	baseCondition: SQL,
	input: ScanJobListPageInput,
) => {
	const conditions: Array<SQL<unknown> | undefined> = [baseCondition];
	if (input.status) conditions.push(eq(scanJobs.status, input.status));
	if (input.search) {
		const pattern = `%${input.search}%`;
		conditions.push(
			or(ilike(scanJobs.description, pattern), ilike(scanJobs.note, pattern)),
		);
	}
	return conditions;
};

export const listScanJobsByApplicationIdPageRepo = async (
	applicationId: string,
	input: ScanJobListPageInput,
) => {
	const conditions = buildScanJobListConditions(
		eq(scanJobs.applicationId, applicationId),
		input,
	);
	const [items, total] = await Promise.all([
		db
			.select(selectScanJobWithRepositoryTaskStatus)
			.from(scanJobs)
			.leftJoin(
				tasks,
				and(
					eq(tasks.scanJobId, scanJobs.scanJobId),
					eq(tasks.stageName, scanJobRootStageName),
					eq(tasks.taskId, latestRepositoryTaskId),
				),
			)
			.where(and(...conditions))
			.orderBy(desc(scanJobs.createdAt))
			.limit(input.pageSize)
			.offset((input.page - 1) * input.pageSize),
		db
			.select({ count: sql<number>`count(*)` })
			.from(scanJobs)
			.where(and(...conditions))
			.then((rows) => Number(rows[0]?.count ?? 0)),
	]);
	return { items, total };
};

export const listScanJobsByComposeIdPageRepo = async (
	composeId: string,
	input: ScanJobListPageInput,
) => {
	const conditions = buildScanJobListConditions(
		eq(scanJobs.composeId, composeId),
		input,
	);
	const [items, total] = await Promise.all([
		db
			.select(selectScanJobWithRepositoryTaskStatus)
			.from(scanJobs)
			.leftJoin(
				tasks,
				and(
					eq(tasks.scanJobId, scanJobs.scanJobId),
					eq(tasks.stageName, scanJobRootStageName),
					eq(tasks.taskId, latestRepositoryTaskId),
				),
			)
			.where(and(...conditions))
			.orderBy(desc(scanJobs.createdAt))
			.limit(input.pageSize)
			.offset((input.page - 1) * input.pageSize),
		db
			.select({ count: sql<number>`count(*)` })
			.from(scanJobs)
			.where(and(...conditions))
			.then((rows) => Number(rows[0]?.count ?? 0)),
	]);
	return { items, total };
};

export const listUnfinishedScanJobsRepo = async () =>
	await db
		.select(selectScanJobWithRepositoryTaskStatus)
		.from(scanJobs)
		.leftJoin(
			tasks,
			and(
				eq(tasks.scanJobId, scanJobs.scanJobId),
				eq(tasks.stageName, scanJobRootStageName),
				eq(tasks.taskId, latestRepositoryTaskId),
			),
		)
		.where(sql`${scanJobs.status} in ('pending', 'running', 'finalizing')`);

export const createScanJobRepo = async (input: {
	applicationId?: string | null;
	composeId?: string | null;
	datasetEvaluationTrialId?: string | null;
	title?: string | null;
	description?: string | null;
	triggerSource?: string | null;
	commitSha?: string | null;
	baseSha?: string | null;
	targetRef?: string | null;
	targetTag?: string | null;
	scanRuntimeSettings?: ScanRuntimeSettings | null;
	researchScope?: Record<string, unknown> | null;
	scanPipelineDefinitionSnapshot?: Record<string, unknown> | null;
	threatDirection?: {
		focus: string;
		attackerModel: string;
		nonGoals?: string[];
		notes?: string;
	} | null;
	commitWindow?: number | null;
	defaultDeltaCommitWindow: number;
	// V3 snapshot linkage (frozen at run creation).
	pipelineId: string;
	pipelineVersionId?: string | null;
	pipelineProfileId?: string | null;
	pipelineYamlSnapshot?: string | null;
	pipelineCompiledSnapshot?: Record<string, unknown> | null;
	maxTasks?: number | null;
	deadlineAt?: string | null;
	tokenBudget?: number | null;
	timeBudgetSeconds?: number | null;
	runtimeStageIds?: readonly string[];
}) => {
	const created = await db
		.insert(scanJobs)
		.values({
			applicationId: input.applicationId,
			composeId: input.composeId,
			datasetEvaluationTrialId: input.datasetEvaluationTrialId,
			title: input.title || "Pipeline Scan Job",
			description: input.description || "",
			triggerSource: input.triggerSource || "manual",
			commitSha: input.commitSha,
			baseSha: input.baseSha,
			targetRef: input.targetRef,
			targetTag: input.targetTag,
			scanRuntimeSettings: normalizeScanRuntimeSettingsForStages(
				input.scanRuntimeSettings ?? {},
				input.runtimeStageIds ?? [],
			),
			scanPipelineDefinitionSnapshot:
				input.scanPipelineDefinitionSnapshot ?? {},
			commitWindow: input.commitWindow || input.defaultDeltaCommitWindow,
			pipelineId: input.pipelineId,
			pipelineVersionId: input.pipelineVersionId ?? null,
			pipelineProfileId: input.pipelineProfileId ?? null,
			pipelineYamlSnapshot: input.pipelineYamlSnapshot ?? null,
			pipelineCompiledSnapshot: input.pipelineCompiledSnapshot ?? null,
			maxTasks: input.maxTasks ?? null,
			deadlineAt: input.deadlineAt ?? null,
			tokenBudget: input.tokenBudget ?? null,
			timeBudgetSeconds: input.timeBudgetSeconds ?? null,
			status: "pending",
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating scan job",
		});
	}

	return created[0];
};

export const updateScanJobRuntimeSettingsRepo = async (
	scanJobId: string,
	scanRuntimeSettings: ScanRuntimeSettings,
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			scanRuntimeSettings: normalizeScanRuntimeSettings(scanRuntimeSettings),
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}

	return updated[0];
};

const hasUsableScanPipelineDefinitionSnapshot = (
	value: unknown,
): value is ScanPipelineDefinitions =>
	Boolean(
		value &&
			typeof value === "object" &&
			"stages" in value &&
			"pipelines" in value,
	);

export const loadScanJobPipelineDefinitionSnapshotRepo = async (
	scanJobId: string,
) => {
	const [row] = await db
		.select({
			scanPipelineDefinitionSnapshot: scanJobs.scanPipelineDefinitionSnapshot,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1);
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	if (
		hasUsableScanPipelineDefinitionSnapshot(row.scanPipelineDefinitionSnapshot)
	) {
		return normalizePipelineDefinitionSnapshot(
			normalizeLegacyVerificationSchema(row.scanPipelineDefinitionSnapshot),
			{ useBaseline: false },
		);
	}
	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: "Scan job pipeline definition snapshot is missing or invalid",
	});
};

export const loadScanJobPipelineCompiledSnapshotRepo = async (
	scanJobId: string,
) => {
	const [row] = await db
		.select({ pipelineCompiledSnapshot: scanJobs.pipelineCompiledSnapshot })
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1);
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	return row.pipelineCompiledSnapshot;
};

export const updateScanJobPipelineDefinitionSnapshotRepo = async (
	scanJobId: string,
	scanPipelineDefinitionSnapshot: ScanPipelineDefinitions,
) => {
	const updated = await db
		.update(scanJobs)
		.set({ scanPipelineDefinitionSnapshot })
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();
	if (!updated[0]) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	return updated[0];
};

export const updateScanJobNoteRepo = async (
	scanJobId: string,
	note: string | null,
) => {
	const updated = await db
		.update(scanJobs)
		.set({ note })
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}

	return updated[0];
};

export const updateScanJobStatusRepo = async (
	scanJobId: string,
	status: typeof scanJobs.$inferSelect.status,
	errorMessage?: string,
) => {
	const patch: Partial<typeof scanJobs.$inferSelect> = {
		status,
	};

	if (status === "running") {
		patch.startedAt = new Date().toISOString();
		patch.finishedAt = null;
	}

	if (
		status === "finished" ||
		status === "partially_finished" ||
		status === "failed" ||
		status === "canceled"
	) {
		patch.finishedAt = new Date().toISOString();
	}

	if (errorMessage) {
		patch.errorMessage = errorMessage;
	}

	const updated = await db
		.update(scanJobs)
		.set(patch)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}

	return updated[0];
};

export const resetScanJobForRetryRepo = async (
	scanJobId: string,
	input?: {
		status?: typeof scanJobs.$inferSelect.status;
		errorMessage?: string | null;
		repositoryTaskStatus?: typeof tasks.$inferSelect.status;
	},
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			status: input?.status || "pending",
			errorMessage:
				input && "errorMessage" in input ? (input.errorMessage ?? null) : null,
			finishedAt: null,
			startedAt: null,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}

	if (input?.repositoryTaskStatus) {
		await db
			.update(tasks)
			.set({
				status: input.repositoryTaskStatus,
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(tasks.taskId, scanJobId));
	}

	return updated[0];
};

export const updateScanJobRepositoryTaskStatusRepo = async (
	scanJobId: string,
	repositoryTaskStatus: typeof tasks.$inferSelect.status,
) => {
	const repositoryTaskPatch: Partial<typeof tasks.$inferSelect> = {
		status: repositoryTaskStatus,
		updatedAt: new Date().toISOString(),
	};
	if (
		repositoryTaskStatus === "launching" ||
		repositoryTaskStatus === "launched" ||
		repositoryTaskStatus === "starting" ||
		repositoryTaskStatus === "running"
	) {
		repositoryTaskPatch.startedAt = new Date().toISOString();
		repositoryTaskPatch.completedAt = null;
	}
	if (
		repositoryTaskStatus === "completed" ||
		repositoryTaskStatus === "failed" ||
		repositoryTaskStatus === "exited" ||
		repositoryTaskStatus === "canceled"
	) {
		repositoryTaskPatch.completedAt = new Date().toISOString();
	}
	await db
		.update(tasks)
		.set(repositoryTaskPatch)
		.where(eq(tasks.taskId, scanJobId));
	return await findScanJobByIdRepo(scanJobId);
};

export const updateScanJobScanningThreadIdRepo = async (
	scanJobId: string,
	scanningThreadId: string,
) => {
	const updated = await db
		.update(scanJobs)
		.set({ scanningThreadId })
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();
	await db
		.update(tasks)
		.set({
			threadId: scanningThreadId,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(tasks.taskId, scanJobId));
	return updated[0] || null;
};

export const updateScanJobTargetContextRepo = async (
	scanJobId: string,
	input: {
		targetRef?: string | null;
		targetTag?: string | null;
		commitSha?: string | null;
		baseSha?: string | null;
		commitWindow?: number | null;
	},
) => {
	const patch: Partial<typeof scanJobs.$inferSelect> = {};
	if (input.targetRef !== undefined) patch.targetRef = input.targetRef || null;
	if (input.targetTag !== undefined) patch.targetTag = input.targetTag || null;
	if (input.commitSha !== undefined) patch.commitSha = input.commitSha || null;
	if (input.baseSha !== undefined) patch.baseSha = input.baseSha || null;
	if (typeof input.commitWindow === "number")
		patch.commitWindow = input.commitWindow;
	const updated = await db
		.update(scanJobs)
		.set(patch)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();
	return updated[0] || null;
};
