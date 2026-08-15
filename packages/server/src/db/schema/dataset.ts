import { sql } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import type { ScanRuntimeSettings } from "./shared";
import {
	scanPipelineProfiles,
	scanPipelines,
	scanPipelineVersions,
} from "./scan";

const timestamp = () => new Date().toISOString();

export type DatasetSource = { type: "local"; path: string };

export type DatasetManifest = {
	version: 1;
	samples: Array<{
		id: string;
		title?: string;
		repositoryPath: string;
		groundTruthArtifacts: string[];
		metadata?: Record<string, unknown>;
	}>;
};

export const datasetSourceSchema = z.object({
	type: z.literal("local"),
	path: z
		.string()
		.trim()
		.min(1)
		.refine(
			(value) => value.startsWith("/"),
			"Local dataset path must be absolute",
		),
});

export const datasets = pgTable(
	"datasets",
	{
		datasetId: text("datasetId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		source: jsonb("source").$type<DatasetSource>().notNull(),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		organizationIdx: index("datasets_organization_idx").on(
			table.organizationId,
		),
		organizationNameUnique: uniqueIndex("datasets_organization_name_unique").on(
			table.organizationId,
			table.name,
		),
	}),
);

export const datasetProfiles = pgTable(
	"dataset_profiles",
	{
		profileId: text("profileId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		datasetId: text("datasetId")
			.notNull()
			.references(() => datasets.datasetId, { onDelete: "cascade" }),
		profileKey: text("profileKey").notNull(),
		status: text("status")
			.$type<"preparing" | "ready" | "failed">()
			.notNull()
			.default("preparing"),
		hostRoot: text("hostRoot").notNull(),
		sourceDigest: text("sourceDigest"),
		toolsImageTag: text("toolsImageTag"),
		toolsImageDigest: text("toolsImageDigest"),
		configSnapshot: jsonb("configSnapshot")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		selectedSampleIds: jsonb("selectedSampleIds")
			.$type<string[]>()
			.notNull()
			.default([]),
		errorMessage: text("errorMessage"),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		datasetIdx: index("dataset_profiles_dataset_idx").on(
			table.datasetId,
			table.createdAt,
		),
		datasetKeyUnique: uniqueIndex("dataset_profiles_dataset_key_unique").on(
			table.datasetId,
			table.profileKey,
		),
		statusIdx: index("dataset_profiles_status_idx").on(table.status),
	}),
);

export const datasetSamples = pgTable(
	"dataset_samples",
	{
		sampleId: text("sampleId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		profileId: text("profileId")
			.notNull()
			.references(() => datasetProfiles.profileId, { onDelete: "cascade" }),
		id: text("id").notNull(),
		title: text("title").notNull().default(""),
		repositoryPath: text("repositoryPath").notNull(),
		groundTruthArtifacts: jsonb("groundTruthArtifacts")
			.$type<string[]>()
			.notNull()
			.default([]),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		ordinal: integer("ordinal").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		profileIdx: index("dataset_samples_profile_idx").on(
			table.profileId,
			table.ordinal,
		),
		profileSampleIdUnique: uniqueIndex("dataset_samples_profile_id_unique").on(
			table.profileId,
			table.id,
		),
	}),
);

export const datasetEvaluations = pgTable(
	"dataset_evaluations",
	{
		evaluationId: text("evaluationId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		datasetId: text("datasetId")
			.notNull()
			.references(() => datasets.datasetId, { onDelete: "cascade" }),
		profileId: text("profileId")
			.notNull()
			.references(() => datasetProfiles.profileId, { onDelete: "restrict" }),
		name: text("name").notNull(),
		pipelineId: text("pipelineId")
			.notNull()
			.references(() => scanPipelines.pipelineId, { onDelete: "restrict" }),
		pipelineProfileId: text("pipelineProfileId").references(
			() => scanPipelineProfiles.pipelineProfileId,
			{ onDelete: "set null" },
		),
		pipelineVersionId: text("pipelineVersionId").references(
			() => scanPipelineVersions.pipelineVersionId,
			{ onDelete: "set null" },
		),
		pipelineYamlSnapshot: text("pipelineYamlSnapshot"),
		pipelineCompiledSnapshot: jsonb("pipelineCompiledSnapshot").$type<unknown>(),
		sampleIds: jsonb("sampleIds").$type<string[]>().notNull().default([]),
		repetitions: integer("repetitions").notNull().default(1),
		timeBudgetSeconds: integer("timeBudgetSeconds"),
		scanRuntimeSettings: jsonb("scanRuntimeSettings")
			.$type<ScanRuntimeSettings>()
			.notNull()
			.default({}),
		scanPipelineDefinitionSnapshot: jsonb("scanPipelineDefinitionSnapshot")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		status: text("status")
			.$type<
				| "pending"
				| "running"
				| "paused"
				| "completed"
				| "completed_with_errors"
				| "failed"
				| "canceled"
			>()
			.notNull()
			.default("pending"),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		datasetIdx: index("dataset_evaluations_dataset_idx").on(
			table.datasetId,
			table.createdAt,
		),
		profileIdx: index("dataset_evaluations_profile_idx").on(table.profileId),
		statusIdx: index("dataset_evaluations_status_idx").on(table.status),
	}),
);

export const datasetEvaluationTrials = pgTable(
	"dataset_evaluation_trials",
	{
		trialId: text("trialId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		evaluationId: text("evaluationId")
			.notNull()
			.references(() => datasetEvaluations.evaluationId, {
				onDelete: "cascade",
			}),
		sampleId: text("sampleId")
			.notNull()
			.references(() => datasetSamples.sampleId, { onDelete: "restrict" }),
		repetition: integer("repetition").notNull(),
		ordinal: integer("ordinal").notNull(),
		status: text("status")
			.$type<
				| "pending"
				| "preparing"
				| "running"
				| "completed"
				| "scan_failed"
				| "scoring_failed"
				| "timed_out"
				| "canceled"
			>()
			.notNull()
			.default("pending"),
		scanJobId: text("scanJobId"),
		postScanStatus: text("postScanStatus")
			.$type<"pending" | "running" | "completed" | "failed">()
			.notNull()
			.default("pending"),
		postScanResult: jsonb("postScanResult").$type<Record<string, unknown> | null>(),
		durationMs: integer("durationMs"),
		inputTokens: bigint("inputTokens", { mode: "number" }).notNull().default(0),
		outputTokens: bigint("outputTokens", { mode: "number" })
			.notNull()
			.default(0),
		thoughtTokens: bigint("thoughtTokens", { mode: "number" })
			.notNull()
			.default(0),
		totalTokens: bigint("totalTokens", { mode: "number" }).notNull().default(0),
		estimatedCost: real("estimatedCost").notNull().default(0),
		result: jsonb("result").$type<Record<string, unknown> | null>(),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		evaluationIdx: index("dataset_evaluation_trials_evaluation_idx").on(
			table.evaluationId,
			table.ordinal,
		),
		sampleIdx: index("dataset_evaluation_trials_sample_idx").on(table.sampleId),
		evaluationSampleRepetitionUnique: uniqueIndex(
			"dataset_evaluation_trials_sample_repetition_unique",
		).on(table.evaluationId, table.sampleId, table.repetition),
		activeEvaluationUnique: uniqueIndex(
			"dataset_evaluation_active_trial_unique",
		)
			.on(table.evaluationId)
			.where(sql`${table.status} in ('preparing', 'running')`),
		statusIdx: index("dataset_evaluation_trials_status_idx").on(table.status),
	}),
);

export const apiDatasetId = z.object({ datasetId: z.string().min(1) });
export const apiDatasetProfileId = z.object({ profileId: z.string().min(1) });
export const apiDatasetProfileCheckoutId = z.object({
	checkoutId: z.string().min(1),
});
export const apiUpdateDatasetProfileSamples = apiDatasetProfileId.extend({
	sampleIds: z.array(z.string().min(1)).max(100_000),
});
export const apiDatasetEvaluationId = z.object({
	evaluationId: z.string().min(1),
});
export const apiDatasetTrialId = z.object({ trialId: z.string().min(1) });

export const apiCreateDataset = z.object({
	name: z.string().trim().min(1).max(160),
	description: z.string().max(4000).optional().default(""),
	source: datasetSourceSchema.optional().default({ type: "local", path: "/" }),
});

export const apiUpdateDataset = apiDatasetId.extend({
	name: z.string().trim().min(1).max(160).optional(),
	description: z.string().max(4000).optional(),
	source: datasetSourceSchema.optional(),
});

export const apiCreateDatasetProfile = apiDatasetId.extend({
	profileKey: z.string().trim().min(1).max(160),
});

export const apiUpdateDatasetProfileHostRoot = apiDatasetProfileId.extend({
	hostRoot: datasetSourceSchema.shape.path,
});

export const apiListDatasetSamples = apiDatasetProfileId.extend({
	search: z.string().optional(),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(25),
});

/** Server-side paginated dataset listing (shared contract with CollectionView). */
export const apiListDatasets = z.object({
	search: z.string().trim().max(200).optional(),
	sortKey: z.enum(["name", "createdAt", "updatedAt"]).default("updatedAt"),
	sortDirection: z.enum(["asc", "desc"]).default("desc"),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(12),
});

/** Server-side paginated profiles within a dataset. */
export const apiListDatasetProfiles = apiDatasetId.extend({
	search: z.string().trim().max(200).optional(),
	status: z.enum(["preparing", "ready", "failed"]).optional(),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(12),
});

/** Server-side paginated evaluations, scoped by dataset and/or profile. */
export const apiListDatasetEvaluations = z.object({
	datasetId: z.string().min(1).optional(),
	profileId: z.string().min(1).optional(),
	search: z.string().trim().max(200).optional(),
	status: z
		.enum([
			"pending",
			"running",
			"paused",
			"completed",
			"completed_with_errors",
			"failed",
			"canceled",
		])
		.optional(),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(12),
});

/** Server-side paginated trials for an evaluation. */
export const apiListDatasetTrials = apiDatasetEvaluationId.extend({
	search: z.string().trim().max(200).optional(),
	status: z
		.enum([
			"pending",
			"preparing",
			"running",
			"completed",
			"scan_failed",
			"scoring_failed",
			"timed_out",
			"canceled",
		])
		.optional(),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(12),
});

export const apiCreateDatasetEvaluation = apiDatasetId.extend({
	profileId: z.string().min(1),
	name: z.string().trim().min(1).max(160),
	pipelineId: z.string().min(1),
	pipelineProfileId: z.string().min(1).nullable().optional(),
	sampleIds: z.array(z.string().min(1)).min(1),
	repetitions: z.number().int().min(1).max(100),
	timeBudgetSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
	scanRuntimeSettings: z.record(z.unknown()).optional().default({}),
});

export type DatasetManifestInput = z.infer<typeof datasetSourceSchema>;
