import { z } from "zod";
import { pipelinePresentationSchema } from "./pipeline-job-tabs";

/**
 * Pipeline Document V3 — the single, frontend/backend-shared contract for a
 * pipeline definition. Everything a pipeline needs (stages, edges, schemas,
 * groups, limits, layout) lives in one document; the split V2 definitions
 * (pipelines/*.yaml + stages/*.yaml + schemas/*.yaml) exist only as a legacy
 * source and are converted by `pipeline-v2-converter.ts`.
 *
 * Rules enforced across the system:
 * - Stage / Edge / Schema / Group ids are stable slugs.
 * - Schemas are standard JSON Schema; internal references are `#/schemas/<id>`.
 * - Stage and edge schema properties may be inline or `$ref`.
 * - `ui` only stores node positions and edge bend points; the compiler ignores it.
 * - Prompts are inline `prompt` strings; `promptFile` is rejected in V3.
 * - `runtime.plugins` must be drawn from the server-registered safe plugin list.
 * - `effects` come from the existing safe whitelist (candidates, research
 *   registry, tob-goal registry); arbitrary JS / shell / module paths are banned.
 */

export const PIPELINE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const PIPELINE_SUPPORTED_TARGETS = ["project", "evaluation"] as const;
export const PIPELINE_STAGE_ROLES = ["scan", "analysis", "verification"] as const;
export const PIPELINE_PREPARE_MODES = ["none", "target", "diff"] as const;

export const ALLOWED_RUNTIME_PLUGINS = [
	"research-track",
	"research-deadline",
] as const;

export const ALLOWED_EFFECT_TYPES = [
	"sync-candidates",
	"project-candidate-result",
	"research-registry",
	"tob-goal-registry",
] as const;

export const PIPELINE_DEFAULT_LIMITS = {
	maxTasks: 10_000,
	maxDurationSeconds: 24 * 60 * 60,
} as const;

export const PIPELINE_HARD_LIMITS = {
	maxTasks: 100_000,
	maxDurationSeconds: 7 * 24 * 60 * 60,
} as const;

export const PIPELINE_MAX_YAML_BYTES = 1 * 1024 * 1024;
export const PIPELINE_MAX_YAML_ALIASES = 50;

// ---------------------------------------------------------------------------
// Zod schemas — the authoritative parse path for untrusted YAML.
// ---------------------------------------------------------------------------

const slugSchema = z
	.string()
	.regex(PIPELINE_SLUG_PATTERN, "must be a stable slug (^[a-z][a-z0-9_-]{0,63}$)");

export const jsonSchemaSchema = z.record(z.unknown());

const artifactMappingSchema = z.object({
	from: z.string().min(1),
	to: z.string().min(1),
	inputField: z.string().min(1).optional(),
	required: z.boolean().optional().default(true),
});

const effectSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("sync-candidates") }),
	z.object({
		type: z.literal("project-candidate-result"),
		resultStage: z.enum(["analyze", "critique", "verify", "triage"]),
	}),
	z.object({
		type: z.literal("research-registry"),
		operation: z.enum([
			"persist-scope",
			"persist-track-plan",
			"apply-track-review",
			"record-discovery",
			"record-finding-validation",
			"record-finding-review",
			"persist-chain",
			"apply-chain-review",
			"record-exploit-validation",
			"apply-exploit-review",
			"persist-report",
		]),
	}),
	z.object({
		type: z.literal("tob-goal-registry"),
		operation: z.enum(["persist-candidate", "apply-judge", "apply-dedup"]),
	}),
]);

const runtimeSchema = z
	.object({
		kind: z.literal("agent").default("agent"),
	agentProfileId: z.string().min(1).nullable().optional(),
		goalSession: z.enum(["shared", "per-task"]).optional(),
		persistent: z.boolean().optional(),
	reuseContainer: z.boolean().optional(),
	nullableOutput: z.boolean().optional(),
	cwd: z.string().min(1).optional(),
	/** Installed agent skill names. Copied into the sandbox and injected into the generated prompt. */
	skills: z.array(z.string().min(1)).optional(),
	prompt: z.string().min(1),
	prepareRepository: z.enum(PIPELINE_PREPARE_MODES).optional().default("none"),
	includePolicy: z.boolean().optional().default(false),
		plugins: z
			.array(z.enum(ALLOWED_RUNTIME_PLUGINS))
			.optional()
			.default([]),
	})
	.strict();

const stageSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	role: z.enum(PIPELINE_STAGE_ROLES),
	group: z.string().min(1),
	concurrency: z.number().int().min(1),
	maxConcurrency: z.number().int().min(1).optional(),
	disableable: z.boolean().optional().default(true),
	goal: z.boolean().optional(),
	/** Only valid when runtime.persistent is true. */
	goalPreserving: z.boolean().optional(),
	runtime: runtimeSchema,
	inputSchema: jsonSchemaSchema.optional(),
	outputSchema: jsonSchemaSchema.optional(),
	inputArtifacts: z.array(artifactMappingSchema).optional().default([]),
	outputArtifacts: z.array(artifactMappingSchema).optional().default([]),
	jobOutput: z.boolean().optional().default(false),
	effects: z.array(effectSchema).optional().default([]),
	report: z
		.object({
			path: z.string().min(1),
			required: z.boolean().optional().default(true),
		})
		.optional(),
	taskName: z.string().min(1).optional(),
	containerNameParts: z.array(z.string()).optional().default([]),
	allowAgentExit: z.boolean().optional().default(false),
	promptValues: z.record(z.unknown()).optional().default({}),
}).strict();

const edgeSchema = z.object({
	id: slugSchema,
	name: z.string().min(1),
	from: slugSchema,
	to: slugSchema,
	fork: z.boolean().optional().default(false),
	mode: z.enum(["map", "fanOut"]).optional().default("map"),
	foreach: z.string().min(1).optional(),
	input: z.unknown().optional(),
	artifacts: z.array(artifactMappingSchema).optional().default([]),
	outputSchema: jsonSchemaSchema.optional(),
	route: z
		.object({
			key: z.string().min(1),
			default: z.boolean().optional(),
			description: z.string().optional(),
		})
		.optional(),
}).strict();

const groupSchema = z.object({
	id: slugSchema,
	name: z.string().min(1),
	leader: slugSchema,
	members: z.array(slugSchema).optional().default([]),
}).strict();

const uiSchema = z
	.object({
		// Layout version marker: layouts without it (or older) are treated
		// as legacy and their stale positions are ignored for the initial
		// transient preview. Runtime compilation ignores all `ui` fields.
		layoutVersion: z.number().int().min(1).optional(),
		// Saved layout orientation; the editor defaults to DOWN.
		direction: z.enum(["DOWN", "RIGHT"]).optional(),
		nodes: z.record(
			z.object({ x: z.number(), y: z.number() }),
		),
		edges: z
			.record(
				z.object({
					bendPoints: z.array(z.object({ x: z.number(), y: z.number() })),
					// Persist ELK's selected ports with its bend points. Re-deriving a
					// port after reload changes the endpoints and invalidates the route.
					sourceHandle: z
						.enum([
							"top-source",
							"bottom-source",
							"left-source",
							"right-source",
						])
						.optional(),
					targetHandle: z
						.enum([
							"top-target",
							"bottom-target",
							"left-target",
							"right-target",
						])
						.optional(),
				}),
			)
			.optional(),
	})
	.optional();

export const pipelineDocumentV3Schema = z.object({
	version: z.literal(3),
	name: z.string().min(1),
	description: z.string().optional(),
	supportedTargets: z.array(z.enum(PIPELINE_SUPPORTED_TARGETS)),
	root: slugSchema,
	limits: z
		.object({
			maxTasks: z.number().int().min(1),
			maxDurationSeconds: z.number().int().min(1),
		})
		.optional()
		.default(PIPELINE_DEFAULT_LIMITS),
	schemas: z.record(slugSchema, jsonSchemaSchema).optional().default({}),
	stages: z.record(slugSchema, stageSchema),
	edges: z.array(edgeSchema).optional().default([]),
	groups: z.array(groupSchema).optional().default([]),
	presentation: pipelinePresentationSchema.optional(),
	ui: uiSchema,
}).strict();

export type PipelineDocumentV3 = z.infer<typeof pipelineDocumentV3Schema>;
export type PipelineStageV3 = z.infer<typeof stageSchema>;
export type PipelineEdgeV3 = z.infer<typeof edgeSchema>;
export type PipelineGroupV3 = z.infer<typeof groupSchema>;
export type PipelineRuntimeV3 = z.infer<typeof runtimeSchema>;
export type PipelineArtifactMappingV3 = z.infer<typeof artifactMappingSchema>;
export type PipelineEffectV3 = z.infer<typeof effectSchema>;
export type PipelineUiV3 = z.infer<typeof uiSchema>;
export type PipelinePresentationV3 = NonNullable<
	PipelineDocumentV3["presentation"]
>;
export type AllowedRuntimePlugin = (typeof ALLOWED_RUNTIME_PLUGINS)[number];

// ---------------------------------------------------------------------------
// Diagnostics — shared shape returned by client- and server-side validation.
// ---------------------------------------------------------------------------

export const pipelineDiagnosticSchema = z.object({
	severity: z.enum(["error", "warning"]),
	code: z.string().min(1),
	message: z.string().min(1),
	path: z.array(z.union([z.string(), z.number()])).optional(),
	entity: z
		.object({
			type: z.enum(["pipeline", "stage", "edge", "schema", "group"]),
			id: z.string().min(1),
		})
		.optional(),
	location: z
		.object({ line: z.number().int().min(1), column: z.number().int().min(1) })
		.optional(),
});

export type PipelineDiagnostic = z.infer<typeof pipelineDiagnosticSchema>;

export type PipelineParseResult = {
	document: PipelineDocumentV3 | null;
	diagnostics: PipelineDiagnostic[];
};

/** How far parsing got; drafts keep the raw text and best-effort diagnostics. */
export type PipelineDocumentParseStatus =
	| { kind: "ok"; document: PipelineDocumentV3 }
	| { kind: "syntax-error"; diagnostics: PipelineDiagnostic[] }
	| { kind: "invalid"; diagnostics: PipelineDiagnostic[] };
