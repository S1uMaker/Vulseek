import { randomUUID } from "node:crypto";
import { relations, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	real,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { compose } from "./compose";
import {
	buildDefaultEvaluateConfig,
	type EvaluateConfig,
	type ScanRuntimeSettings,
	ScanRuntimeSettingsSchema,
} from "./shared";

export type TaskAgentProfileSnapshot = {
	agentProfileId: string | null;
	name: string | null;
	provider: "codex" | "claude_code" | null;
	authMode: "api_key" | "host_home" | null;
	homePath: string | null;
	baseUrl: string | null;
	model: string | null;
	pricingProvider: string | null;
	thinkingLevel: string | null;
	thinkingLevelEnabled?: boolean | null;
};

export type ScanJobOutputArtifact = {
	path: string;
};

export type ScanJobOutput = {
	taskId: string;
	stageName: string;
	artifacts: ScanJobOutputArtifact[];
};

export const scanJobStatusEnum = pgEnum("scanJobStatus", [
	"pending",
	"running",
	"paused",
	"finalizing",
	"finished",
	"partially_finished",
	"failed",
	"canceled",
]);
export const scanEvaluateStatusEnum = pgEnum("scanEvaluateStatus", [
	"pending",
	"running",
	"completed",
	"failed",
]);
export const taskStatusEnum = pgEnum("taskStatus", [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
	"completed",
	"failed",
	"exited",
	"canceled",
]);

/**
 * Organization-level pipeline. A pipeline owns a single shared draft plus an
 * immutable append-only version history (`scanPipelineVersions`). Only
 * published versions can run.
 */
export const scanPipelines = pgTable(
	"scan_pipelines",
	{
		pipelineId: text("pipelineId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		// Single organization-shared draft. `draftYaml` stores the raw text
		// verbatim (comments and layout included); `draftRevision` is the
		// optimistic-lock counter bumped on every save.
		draftYaml: text("draftYaml"),
		draftRevision: integer("draftRevision").notNull().default(0),
		draftBaseVersionId: text("draftBaseVersionId"),
		currentPublishedVersionId: text("currentPublishedVersionId"),
		archivedAt: text("archivedAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		createdBy: text("createdBy"),
		updatedBy: text("updatedBy"),
	},
	(table) => ({
		organizationSlugUnique: uniqueIndex("scan_pipelines_org_slug_unique").on(
			table.organizationId,
			table.slug,
		),
	}),
);

/**
 * Immutable published version of a pipeline. Rows are only ever inserted —
 * never updated or deleted — so running jobs and evaluations stay
 * reproducible no matter what happens to the pipeline afterwards.
 */
export const scanPipelineVersions = pgTable(
	"scan_pipeline_versions",
	{
		pipelineVersionId: text("pipelineVersionId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		pipelineId: text("pipelineId")
			.notNull()
			.references(() => scanPipelines.pipelineId, { onDelete: "cascade" }),
		versionNumber: integer("versionNumber").notNull(),
		// Raw YAML exactly as published (the audit-able source of truth).
		yaml: text("yaml").notNull(),
		contentHash: text("contentHash").notNull(),
		compiledDefinition: jsonb("compiledDefinition"),
		publishedBy: text("publishedBy"),
		publishedAt: text("publishedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pipelineVersionUnique: uniqueIndex(
			"scan_pipeline_versions_pipeline_number_unique",
		).on(table.pipelineId, table.versionNumber),
		contentHashUnique: uniqueIndex("scan_pipeline_versions_content_hash_unique")
			.on(table.pipelineId, table.contentHash)
			.where(sql`${table.contentHash} is not null`),
	}),
);

/** Organization-scoped runtime presets for a published pipeline. */
export const scanPipelineProfiles = pgTable(
	"scan_pipeline_profiles",
	{
		pipelineProfileId: text("pipelineProfileId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		pipelineId: text("pipelineId")
			.notNull()
			.references(() => scanPipelines.pipelineId, { onDelete: "cascade" }),
		pipelineVersionId: text("pipelineVersionId")
			.notNull()
			.references(() => scanPipelineVersions.pipelineVersionId, { onDelete: "cascade" }),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		settings: jsonb("settings")
			.$type<ScanRuntimeSettings>()
			.notNull()
			.default({}),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pipelineNameUnique: uniqueIndex("scan_pipeline_profiles_pipeline_name_unique").on(
			table.pipelineId,
			table.name,
		),
		organizationPipelineIndex: index("scan_pipeline_profiles_org_pipeline_idx").on(
			table.organizationId,
			table.pipelineId,
		),
	}),
);

export const scanJobs = pgTable(
	"scan_jobs",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		title: text("title").notNull().default("Scan Job"),
		description: text("description"),
		note: text("note"),
		status: scanJobStatusEnum("status").notNull().default("pending"),
		triggerSource: text("triggerSource").notNull().default("manual"),
		commitSha: text("commitSha"),
		baseSha: text("baseSha"),
		targetRef: text("targetRef"),
		targetTag: text("targetTag"),
		scanRuntimeSettings: jsonb("scanRuntimeSettings")
			.$type<ScanRuntimeSettings>()
			.notNull()
			.default({}),
		scanPipelineDefinitionSnapshot: jsonb("scanPipelineDefinitionSnapshot")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		outputs: jsonb("outputs")
			.$type<ScanJobOutput[]>()
			.notNull()
			.default([]),
		commitWindow: integer("commitWindow").notNull().default(3),
		inputTokens: bigint("input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		outputTokens: bigint("output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		thoughtTokens: bigint("thought_tokens", { mode: "number" })
			.notNull()
			.default(0),
		totalTokens: bigint("total_tokens", { mode: "number" })
			.notNull()
			.default(0),
		cachedReadTokens: bigint("cached_read_tokens", { mode: "number" })
			.notNull()
			.default(0),
		cachedWriteTokens: bigint("cached_write_tokens", { mode: "number" })
			.notNull()
			.default(0),
		estimatedCost: real("estimated_cost").notNull().default(0),
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{
				onDelete: "cascade",
			},
		),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "cascade",
		}),
		// Dataset evaluations use a trial as their scan target. The foreign key is
		// installed by the dataset migration to avoid a circular schema declaration.
		datasetEvaluationTrialId: text("datasetEvaluationTrialId"),
		// Frozen pipeline linkage for V3 runs: the exact version and its
		// snapshots make the job reproducible after version switches/archival.
		pipelineId: text("pipelineId")
			.notNull()
			.references(
			() => scanPipelines.pipelineId,
			{ onDelete: "restrict" },
			),
		pipelineVersionId: text("pipelineVersionId").references(
			() => scanPipelineVersions.pipelineVersionId,
			{ onDelete: "set null" },
		),
		pipelineYamlSnapshot: text("pipelineYamlSnapshot"),
		pipelineCompiledSnapshot: jsonb("pipelineCompiledSnapshot").$type<unknown>(),
		// Loop-safety limits; persisted so worker restarts cannot reset them.
		maxTasks: integer("maxTasks"),
		deadlineAt: text("deadlineAt"),
		taskCount: integer("taskCount").notNull().default(0),
		terminationReason: text("terminationReason").$type<string | null>(),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		errorMessage: text("errorMessage"),
		scanningThreadId: text("scanningThreadId"),
	},
	(table) => ({
		datasetEvaluationTrialUnique: uniqueIndex("scan_jobs_dataset_trial_unique")
			.on(table.datasetEvaluationTrialId)
			.where(sql`${table.datasetEvaluationTrialId} is not null`),
	}),
);

export const tasks = pgTable(
	"tasks",
	{
		taskId: text("taskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => randomUUID().replace(/-/g, "").slice(0, 8)),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		vulnerabilityCandidateId: text("vulnerabilityCandidateId"),
		parentTaskId: text("parentTaskId").references(
			(): AnyPgColumn => tasks.taskId,
			{
				onDelete: "set null",
			},
		),
		name: text("name").notNull(),
		stageName: text("stageName").notNull(),
		status: taskStatusEnum("status").notNull().default("pending"),
		downstreamDispatchStatus: text("downstreamDispatchStatus")
			.$type<"pending" | "dispatching" | "completed">()
			.notNull()
			.default("pending"),
		downstreamRouteKey: text("downstreamRouteKey"),
		downstreamDispatchedAt: text("downstreamDispatchedAt"),
		dispatchKey: text("dispatchKey"),
		priority: integer("priority"),
		attempt: integer("attempt").notNull().default(0),
		agentProfile: jsonb(
			"agentProfile",
		).$type<TaskAgentProfileSnapshot | null>(),
		containerName: text("containerName"),
		containerIndex: integer("containerIndex"),
		threadId: text("threadId"),
		runtimeMode: text("runtimeMode").$type<
			"new_session" | "fork_session" | null
		>(),
		forkedFromTaskId: text("forkedFromTaskId").references(
			(): AnyPgColumn => tasks.taskId,
			{
				onDelete: "set null",
			},
		),
		forkedFromThreadId: text("forkedFromThreadId"),
		stageGroupInstanceId: text("stageGroupInstanceId"),
		input: jsonb("input").$type<unknown | null>(),
		output: jsonb("output").$type<unknown | null>(),
		inputTokens: bigint("input_tokens", { mode: "number" }),
		outputTokens: bigint("output_tokens", { mode: "number" }),
		thoughtTokens: bigint("thought_tokens", { mode: "number" }),
		totalTokens: bigint("total_tokens", { mode: "number" }),
		cachedReadTokens: bigint("cached_read_tokens", { mode: "number" }),
		cachedWriteTokens: bigint("cached_write_tokens", { mode: "number" }),
		estimatedCost: real("estimated_cost"),
		errorMessage: text("errorMessage"),
		exitReason: text("exitReason").$type<"agent_exit" | "leader_exit" | null>(),
		exitNote: text("exitNote"),
		startedAt: text("startedAt"),
		completedAt: text("completedAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		scanJobIdx: index("tasks_scan_job_idx").on(table.scanJobId),
		scanJobCandidateIdx: index("tasks_scan_job_candidate_idx").on(
			table.scanJobId,
			table.vulnerabilityCandidateId,
			table.stageName,
			table.createdAt,
		),
		parentTaskIdx: index("tasks_parent_task_idx").on(table.parentTaskId),
		forkedFromTaskIdx: index("tasks_forked_from_task_idx").on(
			table.forkedFromTaskId,
		),
		forkedFromThreadIdx: index("tasks_forked_from_thread_idx").on(
			table.forkedFromThreadId,
		),
		scanJobStatusIdx: index("tasks_scan_job_status_idx").on(
			table.scanJobId,
			table.status,
		),
		dispatchStatusIdx: index("tasks_downstream_dispatch_status_idx").on(
			table.scanJobId,
			table.downstreamDispatchStatus,
		),
		scanJobCreatedAtIdx: index("tasks_scan_job_created_at_idx").on(
			table.scanJobId,
			table.createdAt,
		),
		scanJobFinishedAtIdx: index("tasks_scan_job_finished_at_idx").on(
			table.scanJobId,
			sql`coalesce(${table.completedAt}, ${table.updatedAt}) desc`,
			sql`${table.taskId} desc`,
		),
		stageStatusIdx: index("tasks_stage_status_idx").on(
			table.stageName,
			table.status,
		),
		threadIdx: index("tasks_thread_idx").on(table.threadId),
		containerIdx: index("tasks_container_idx").on(table.containerName),
		containerIndexIdx: index("tasks_container_index_idx").on(
			table.scanJobId,
			table.stageName,
			table.containerIndex,
		),
	}),
);

export const scanStageLaneRuntimes = pgTable(
	"scan_stage_lane_runtimes",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		stageName: text("stageName").notNull(),
		laneIndex: integer("laneIndex").notNull(),
		containerName: text("containerName"),
		threadId: text("threadId"),
		driverPid: integer("driverPid"),
		initialGoalPrompt: text("initialGoalPrompt"),
		activeTaskId: text("activeTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		forkedFromTaskId: text("forkedFromTaskId").references(
			(): AnyPgColumn => tasks.taskId,
			{
				onDelete: "set null",
			},
		),
		forkedFromThreadId: text("forkedFromThreadId"),
		status: text("status")
			.$type<"idle" | "active" | "exiting">()
			.notNull()
			.default("idle"),
		lastExitTaskId: text("lastExitTaskId"),
		lastExitAt: text("lastExitAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.stageName, table.laneIndex],
		}),
		scanJobStageIdx: index("scan_stage_lane_scan_job_stage_idx").on(
			table.scanJobId,
			table.stageName,
		),
		activeTaskIdx: index("scan_stage_lane_active_task_idx").on(
			table.activeTaskId,
		),
		containerIdx: index("scan_stage_lane_container_idx").on(
			table.containerName,
		),
	}),
);

export const scanStageGroupInstances = pgTable(
	"scan_stage_group_instances",
	{
		groupInstanceId: text("groupInstanceId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		groupName: text("groupName").notNull(),
		leaderStageName: text("leaderStageName").notNull(),
		leaderLaneIndex: integer("leaderLaneIndex").notNull(),
		leaderTaskId: text("leaderTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		status: text("status")
			.$type<"active" | "exited">()
			.notNull()
			.default("active"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		scanJobGroupIdx: index("scan_stage_group_instance_scan_job_group_idx").on(
			table.scanJobId,
			table.groupName,
		),
		leaderIdx: index("scan_stage_group_instance_leader_idx").on(
			table.scanJobId,
			table.leaderStageName,
			table.leaderLaneIndex,
		),
	}),
);

export const scanStageGroupLaneMemberships = pgTable(
	"scan_stage_group_lane_memberships",
	{
		groupInstanceId: text("groupInstanceId")
			.notNull()
			.references(() => scanStageGroupInstances.groupInstanceId, {
				onDelete: "cascade",
			}),
		stageName: text("stageName").notNull(),
		laneIndex: integer("laneIndex").notNull(),
		role: text("role").$type<"leader" | "member">().notNull(),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.groupInstanceId, table.stageName],
		}),
		groupIdx: index("scan_stage_group_lane_membership_group_idx").on(
			table.groupInstanceId,
		),
		stageLaneIdx: index("scan_stage_group_lane_membership_stage_lane_idx").on(
			table.stageName,
			table.laneIndex,
		),
	}),
);

export const candidateMetadata = pgTable(
	"candidate_metadata",
	{
		vulnerabilityCandidateId: text("vulnerabilityCandidateId").notNull(),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		note: text("note").notNull().default(""),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
		}),
		scanJobIdx: index("candidate_metadata_scan_job_idx").on(table.scanJobId),
	}),
);

export const vulnerabilityCandidates = pgTable(
	"vulnerability_candidates",
	{
		vulnerabilityCandidateId: text("vulnerabilityCandidateId").notNull(),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		producerTaskId: text("producerTaskId")
			.notNull()
			.references(() => tasks.taskId, {
				onDelete: "cascade",
			}),
		producerStageName: text("producerStageName").notNull(),
		functionId: text("functionId"),
		title: text("title").notNull(),
		description: text("description"),
		filePath: text("filePath"),
		line: integer("line"),
		vulnerabilityType: text("vulnerabilityType"),
		confidence: real("confidence"),
		score: real("score"),
		targetId: text("targetId"),
		targetKind: text("targetKind"),
		claim: text("claim").notNull(),
		rootCauseKey: text("rootCauseKey"),
		evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
		attackerControl: text("attackerControl"),
		affectedSink: text("affectedSink"),
		preconditions: jsonb("preconditions")
			.$type<string[]>()
			.notNull()
			.default([]),
		quickDisproofAttempt: text("quickDisproofAttempt"),
		needsFuzzing: boolean("needsFuzzing").notNull().default(false),
		needsManualAnalysis: boolean("needsManualAnalysis")
			.notNull()
			.default(false),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
		}),
		scanJobIdx: index("vulnerability_candidates_scan_job_idx").on(
			table.scanJobId,
		),
		producerTaskIdx: index("vulnerability_candidates_producer_task_idx").on(
			table.producerTaskId,
		),
		producerStageIdx: index("vulnerability_candidates_producer_stage_idx").on(
			table.producerStageName,
		),
		createdAtIdx: index("vulnerability_candidates_created_at_idx").on(
			table.createdAt,
		),
	}),
);

export const candidateResultProjections = pgTable(
	"candidate_result_projections",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		vulnerabilityCandidateId: text("vulnerabilityCandidateId").notNull(),
		analysisTaskId: text("analysisTaskId"),
		analysisOutput: jsonb("analysisOutput").$type<unknown | null>(),
		analysisResult: text("analysisResult"),
		analysisRank: integer("analysisRank"),
		analysisResultAt: text("analysisResultAt"),
		verificationTaskId: text("verificationTaskId"),
		verificationOutput: jsonb("verificationOutput").$type<unknown | null>(),
		verificationResult: text("verificationResult"),
		verificationRank: integer("verificationRank"),
		verificationResultAt: text("verificationResultAt"),
		triageTaskId: text("triageTaskId"),
		triageOutput: jsonb("triageOutput").$type<unknown | null>(),
		triageResult: text("triageResult"),
		triageRank: integer("triageRank"),
		triageResultAt: text("triageResultAt"),
		latestResultAt: text("latestResultAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
		}),
		candidateFk: foreignKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
			foreignColumns: [
				vulnerabilityCandidates.scanJobId,
				vulnerabilityCandidates.vulnerabilityCandidateId,
			],
			name: "candidate_result_projection_candidate_fk",
		}),
		scanJobIdx: index("candidate_result_projection_scan_job_idx").on(
			table.scanJobId,
		),
		analysisResultIdx: index("candidate_result_projection_analysis_idx").on(
			table.scanJobId,
			table.analysisResult,
		),
		verificationResultIdx: index(
			"candidate_result_projection_verification_idx",
		).on(table.scanJobId, table.verificationResult),
		triageResultIdx: index("candidate_result_projection_triage_idx").on(
			table.scanJobId,
			table.triageResult,
		),
		latestResultIdx: index("candidate_result_projection_latest_idx").on(
			table.scanJobId,
			table.latestResultAt,
		),
	}),
);

export const candidateResultProjectionBackfills = pgTable(
	"candidate_result_projection_backfills",
	{
		backfillId: text("backfillId").primaryKey(),
		status: text("status")
			.$type<"pending" | "running" | "completed">()
			.notNull()
			.default("pending"),
		processedCount: integer("processedCount").notNull().default(0),
		skippedCount: integer("skippedCount").notNull().default(0),
		skippedTasks: jsonb("skippedTasks")
			.$type<Array<Record<string, string>>>()
			.notNull()
			.default([]),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		completedAt: text("completedAt"),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
);

export const scanJobCostBackfills = pgTable("scan_job_cost_backfills", {
	backfillId: text("backfill_id").primaryKey(),
	status: text("status").$type<"pending" | "running" | "completed">().notNull(),
	processedCount: integer("processed_count").notNull().default(0),
	skippedCount: integer("skipped_count").notNull().default(0),
	skippedTasks: jsonb("skipped_tasks").$type<unknown[]>().notNull().default([]),
	updatedAt: text("updated_at").notNull(),
});

export const scanEvaluateResults = pgTable(
	"scan_evaluate_results",
	{
		evaluateResultId: text("evaluateResultId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		applicationId: text("applicationId")
			.notNull()
			.references(() => applications.applicationId, {
				onDelete: "cascade",
			}),
		status: scanEvaluateStatusEnum("status").notNull().default("pending"),
		configSnapshot: jsonb("configSnapshot")
			.$type<EvaluateConfig>()
			.notNull()
			.default(buildDefaultEvaluateConfig()),
		realVulnCsvPath: text("realVulnCsvPath"),
		result: jsonb("result").$type<Record<string, unknown> | null>(),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		scanJobIdx: index("scan_evaluate_results_scan_job_idx").on(table.scanJobId),
		applicationIdx: index("scan_evaluate_results_application_idx").on(
			table.applicationId,
		),
		scanJobCreatedAtIdx: index("scan_evaluate_results_scan_job_created_idx").on(
			table.scanJobId,
			table.createdAt,
		),
	}),
);

export const candidateTags = pgTable("candidate_tags", {
	name: text("name").notNull().primaryKey(),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updatedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const scanJobsRelations = relations(scanJobs, ({ one, many }) => ({
	application: one(applications, {
		fields: [scanJobs.applicationId],
		references: [applications.applicationId],
	}),
	compose: one(compose, {
		fields: [scanJobs.composeId],
		references: [compose.composeId],
	}),
	pipeline: one(scanPipelines, {
		fields: [scanJobs.pipelineId],
		references: [scanPipelines.pipelineId],
	}),
	pipelineVersion: one(scanPipelineVersions, {
		fields: [scanJobs.pipelineVersionId],
		references: [scanPipelineVersions.pipelineVersionId],
	}),
	tasks: many(tasks),
	candidateMetadata: many(candidateMetadata),
	vulnerabilityCandidates: many(vulnerabilityCandidates),
	evaluateResults: many(scanEvaluateResults),
}));

export const scanPipelinesRelations = relations(
	scanPipelines,
	({ one, many }) => ({
		versions: many(scanPipelineVersions),
		currentPublishedVersion: one(scanPipelineVersions, {
			fields: [scanPipelines.currentPublishedVersionId],
			references: [scanPipelineVersions.pipelineVersionId],
		}),
	}),
);

export const scanPipelineVersionsRelations = relations(
	scanPipelineVersions,
	({ one }) => ({
		pipeline: one(scanPipelines, {
			fields: [scanPipelineVersions.pipelineId],
			references: [scanPipelines.pipelineId],
		}),
	}),
);

export const tasksRelations = relations(tasks, ({ one, many }) => ({
	scanJob: one(scanJobs, {
		fields: [tasks.scanJobId],
		references: [scanJobs.scanJobId],
	}),
	parentTask: one(tasks, {
		fields: [tasks.parentTaskId],
		references: [tasks.taskId],
		relationName: "task_parent",
	}),
	childTasks: many(tasks, {
		relationName: "task_parent",
	}),
}));

export const candidateMetadataRelations = relations(
	candidateMetadata,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [candidateMetadata.scanJobId],
			references: [scanJobs.scanJobId],
		}),
	}),
);

export const vulnerabilityCandidatesRelations = relations(
	vulnerabilityCandidates,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [vulnerabilityCandidates.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		producerTask: one(tasks, {
			fields: [vulnerabilityCandidates.producerTaskId],
			references: [tasks.taskId],
		}),
	}),
);

export const scanEvaluateResultsRelations = relations(
	scanEvaluateResults,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [scanEvaluateResults.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		application: one(applications, {
			fields: [scanEvaluateResults.applicationId],
			references: [applications.applicationId],
		}),
	}),
);

export const apiFindScanJobsByApplication = z
	.object({
		applicationId: z.string().min(1),
	})
	.required();

export const apiFindScanJobsByCompose = z
	.object({
		composeId: z.string().min(1),
	})
	.required();

const scanJobListPageFields = {
	search: z.string().trim().max(200).optional(),
	status: z
		.enum([
			"pending",
			"running",
			"paused",
			"finalizing",
			"finished",
			"partially_finished",
			"failed",
			"canceled",
		])
		.optional(),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(20),
} as const;

export const apiListScanJobsByApplication = apiFindScanJobsByApplication.extend(
	scanJobListPageFields,
);

export const apiListScanJobsByCompose = apiFindScanJobsByCompose.extend(
	scanJobListPageFields,
);

export const apiFindOneScanJob = z
	.object({
		scanJobId: z.string().min(1),
	})
	.required();

export const apiUpdateScanJobNote = z
	.object({
		scanJobId: z.string().min(1),
		note: z.string().max(4000).nullable(),
	})
	.required();

export const apiFindVulnerabilityCandidatesByScanJob = z
	.object({
		scanJobId: z.string().min(1),
	})
	.required();

export const apiCheckoutScanEnvironment = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
	})
	.refine(
		(value) => Boolean(value.applicationId) !== Boolean(value.composeId),
		{
			message: "Provide exactly one target: applicationId or composeId",
			path: ["applicationId"],
		},
	);

export const apiFindCheckoutStatus = z
	.object({
		checkoutId: z.string().min(1),
	})
	.required();

export const apiFindRunningCheckout = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
	})
	.refine(
		(value) => Boolean(value.applicationId) !== Boolean(value.composeId),
		{
			message: "Provide exactly one target: applicationId or composeId",
			path: ["applicationId"],
		},
	);
