import { z } from "zod";
import { PIPELINE_SLUG_PATTERN } from "../../services/scan/pipeline/document-v3";
import { ScanRuntimeSettingsSchema } from "./shared";

export const apiPipelineId = z.object({
	pipelineId: z.string().min(1),
});

export const apiPipelineVersionId = z.object({
	pipelineVersionId: z.string().min(1),
});

export const apiPipelineSlug = z
	.string()
	.regex(PIPELINE_SLUG_PATTERN, "Slug must be a stable slug (^[a-z][a-z0-9_-]{0,63}$)");

export const apiCreatePipeline = z.object({
	slug: apiPipelineSlug,
	name: z.string().trim().min(1).max(160),
	description: z.string().max(400).nullable().optional(),
	initialYaml: z.string().max(2 * 1024 * 1024).nullable().optional(),
});

export const apiSavePipelineDraft = apiPipelineId.extend({
	expectedRevision: z.number().int().min(0),
	yaml: z.string().max(2 * 1024 * 1024),
});

export const apiPublishPipeline = apiPipelineId.extend({
	expectedRevision: z.number().int().min(0).nullable().optional(),
	yaml: z.string().max(2 * 1024 * 1024).nullable().optional(),
});

export const apiCopyVersionToDraft = apiPipelineId.merge(apiPipelineVersionId);

export const apiSetCurrentVersion = apiPipelineId.merge(apiPipelineVersionId);

export const apiDuplicatePipeline = apiPipelineId.extend({
	slug: apiPipelineSlug,
	name: z.string().trim().min(1).max(160).nullable().optional(),
});

export const apiArchivePipeline = apiPipelineId;
export const apiUnarchivePipeline = apiPipelineId;
export const apiDeletePipelineDraft = apiPipelineId;

export const apiPipelineProfileId = z.object({
	pipelineProfileId: z.string().min(1),
});

export const apiCreatePipelineProfile = apiPipelineId.extend({
	pipelineVersionId: z.string().min(1),
	name: z.string().trim().min(1).max(120),
	description: z.string().max(400).nullable().optional(),
	settings: ScanRuntimeSettingsSchema,
});

export const apiUpdatePipelineProfile = apiPipelineProfileId.extend({
	name: z.string().trim().min(1).max(120),
	description: z.string().max(400).nullable().optional(),
	settings: ScanRuntimeSettingsSchema,
});

export const apiValidatePipelineYaml = z.object({
	yaml: z.string().max(2 * 1024 * 1024),
});

export const apiPublishedPipelineOptions = z.object({
	targetType: z.enum(["project", "evaluation"]),
});

export const apiCreatePipelineRun = z.object({
	target: z.discriminatedUnion("type", [
		z.object({ type: z.literal("application"), applicationId: z.string().min(1) }),
		z.object({ type: z.literal("compose"), composeId: z.string().min(1) }),
		z.object({ type: z.literal("datasetTrial"), trialId: z.string().min(1) }),
	]),
	pipelineId: z.string().min(1),
	pipelineVersionId: z.string().min(1).optional(),
	pipelineProfileId: z.string().min(1).optional(),
	repository: z
		.object({
			targetRef: z.string().optional(),
			targetTag: z.string().optional(),
			commitSha: z.string().optional(),
			baseSha: z.string().optional(),
			commitWindow: z.number().int().min(1).max(100).optional(),
		})
		.optional(),
	title: z.string().max(200).optional(),
	description: z.string().max(1000).optional(),
	tokenBudget: z.number().int().positive().nullable().optional(),
	timeBudgetSeconds: z
		.number()
		.int()
		.positive()
		.max(30 * 24 * 60 * 60)
		.nullable()
		.optional(),
	stageOverrides: z
		.record(
			z.string(),
			z.object({
				enabled: z.boolean().optional(),
				concurrency: z.number().int().min(1).optional(),
				agentProfileId: z.string().min(1).nullable().optional(),
			}),
		)
		.optional(),
});
