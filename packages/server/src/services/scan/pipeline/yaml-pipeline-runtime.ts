import { z } from "zod";

const expressionSchema = z.string().min(1);

const artifactMappingSchema = z.object({
	from: expressionSchema,
	to: z.string().min(1),
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

const reportSchema = z.object({
	path: z.string().min(1),
	required: z.boolean().default(true),
});

const runtimeSchema = z.object({
	agentProfile: z.string().min(1).nullable().optional(),
	goalSession: z.enum(["shared", "per-task"]).optional(),
	persistent: z.boolean().nullable().optional(),
	reuseContainer: z.boolean().nullable().optional(),
	nullableOutput: z.boolean().nullable().optional(),
	cwd: z.string().min(1).nullable().optional(),
	skills: z.array(z.string().min(1)).nullable().optional(),
	prompt: z.string().nullable().optional(),
	promptFile: z.string().min(1).nullable().optional(),
	prepareRepository: z.boolean().optional().default(false),
	/** When true, append Security Policy file path instruction to the agent prompt. */
	includePolicy: z.boolean().optional().default(false),
});

const stageSchema = z.object({
	name: z.string().min(1),
	role: z.enum(["scan", "analysis", "verification"]),
	concurrency: z.number().int().min(1),
	maxConcurrency: z.number().int().min(1).optional(),
	disableable: z.boolean().optional().default(true),
	goal: z.boolean().optional().default(false),
	goalPreserving: z.boolean().optional().default(false),
	description: z.string().optional(),
	runtime: runtimeSchema,
	inputSchema: z.record(z.unknown()).optional(),
	outputSchema: z.record(z.unknown()).optional(),
	inputArtifacts: z.array(artifactMappingSchema).optional().default([]),
	outputArtifacts: z.array(artifactMappingSchema).optional().default([]),
	jobOutput: z.boolean().optional().default(false),
	effects: z.array(effectSchema).optional().default([]),
	report: reportSchema.optional(),
	taskName: expressionSchema.optional(),
	containerNameParts: z.array(z.string()).optional().default([]),
	allowAgentExit: z.boolean().optional().default(false),
	promptValues: z.record(z.unknown()).optional().default({}),
});

const edgeSchema = z.object({
	name: z.string().min(1),
	from: z.string().min(1),
	to: z.string().min(1),
	fork: z.boolean().optional().default(false),
	mode: z.enum(["map", "fanOut"]).optional().default("map"),
	foreach: expressionSchema.optional(),
	input: z.unknown().optional().default({}),
	artifacts: z.array(artifactMappingSchema).optional().default([]),
	outputSchema: z.record(z.unknown()).optional(),
	route: z
		.object({
			key: z.string().min(1),
			default: z.boolean().optional(),
			description: z.string().optional(),
		})
		.optional(),
});

const yamlPipelineSchema = z.object({
	version: z.literal(2),
	name: z.string().min(1),
	root: z.string().min(1),
	schemas: z.record(z.record(z.unknown())).optional().default({}),
	stages: z.record(stageSchema),
	edges: z.array(edgeSchema).optional().default([]),
});

export type YamlPipelineEffect = z.infer<typeof effectSchema>;
export type YamlPipelineReport = z.infer<typeof reportSchema>;
export type YamlPipelineArtifactMapping = z.infer<typeof artifactMappingSchema>;
export type YamlPipelineStage = z.infer<typeof stageSchema> & { id: string };
export type YamlPipelineEdge = z.infer<typeof edgeSchema>;
export type YamlPipelineDefinition = Omit<
	z.infer<typeof yamlPipelineSchema>,
	"stages"
> & {
	stages: Record<string, YamlPipelineStage>;
};

const assertUnique = (values: string[], label: string) => {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`duplicate ${label}: ${value}`);
		}
		seen.add(value);
	}
};

const assertExpression = (expression: string, label: string) => {
	if (
		expression === "$item" ||
		expression.startsWith("$item.") ||
		expression.startsWith("$input.") ||
		expression.startsWith("$ctx.") ||
		expression.startsWith("$computed.") ||
		expression === "$output" ||
		expression.startsWith("$output.") ||
		expression.startsWith("$.") ||
		expression.startsWith("$file(")
	) {
		return;
	}
	throw new Error(`unsupported ${label} expression: ${expression}`);
};

export const validateYamlPipelineDefinition = (
	input: unknown,
): YamlPipelineDefinition => {
	const parsed = yamlPipelineSchema.parse(input);
	const stageIds = Object.keys(parsed.stages);
	assertUnique(stageIds, "stage id");
	if (!parsed.stages[parsed.root]) {
		throw new Error(`unknown root stage: ${parsed.root}`);
	}

	for (const [id, stage] of Object.entries(parsed.stages)) {
		if (stage.runtime.prompt?.trim() === "" && !stage.runtime.promptFile) {
			throw new Error(`stage ${id} must define a prompt or promptFile`);
		}
		for (const artifact of [
			...stage.inputArtifacts,
			...stage.outputArtifacts,
		]) {
			assertExpression(artifact.from, "artifact");
		}
		if (stage.taskName) {
			assertExpression(stage.taskName, "taskName");
		}
	}

	assertUnique(
		parsed.edges.map((edge) => edge.name),
		"edge name",
	);
	for (const edge of parsed.edges) {
		if (!parsed.stages[edge.from]) {
			throw new Error(`unknown edge source stage: ${edge.from}`);
		}
		if (!parsed.stages[edge.to]) {
			throw new Error(`unknown edge target stage: ${edge.to}`);
		}
		if (edge.mode === "fanOut" && !edge.foreach) {
			throw new Error(`fanOut edge ${edge.name} requires foreach`);
		}
		if (edge.foreach) {
			assertExpression(edge.foreach, "foreach");
		}
		for (const artifact of edge.artifacts) {
			assertExpression(artifact.from, "artifact");
		}
	}

	return {
		...parsed,
		stages: Object.fromEntries(
			Object.entries(parsed.stages).map(([id, stage]) => [id, { id, ...stage }]),
		),
	};
};

export const parseYamlPipelineDefinition = (input: unknown) =>
	validateYamlPipelineDefinition(input);

export const YAML_PIPELINE_EFFECT_TYPES = [
	"sync-candidates",
	"project-candidate-result",
	"research-registry",
	"tob-goal-registry",
] as const;
