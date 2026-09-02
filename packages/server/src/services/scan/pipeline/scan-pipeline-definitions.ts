import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const SCAN_PIPELINE_IDS = {
	full: "full",
	delta: "delta",
	research: "research",
	"tob-goal": "tob-goal",
} as const;

const stageRoleSchema = z.enum(["scan", "analysis", "verification"]);
const stageRuntimeConfigSchema = z
	.object({
		agentProfile: z.string().min(1).nullable().optional(),
		goalSession: z.enum(["shared", "per-task"]).optional(),
		persistent: z.boolean().nullable().optional(),
		reuseContainer: z.boolean().nullable().optional(),
		nullableOutput: z.boolean().nullable().optional(),
		cwd: z.string().min(1).nullable().optional(),
		skills: z.array(z.string().min(1)).nullable().optional(),
		mcp: z.array(z.string().min(1)).nullable().optional(),
		prompt: z.string().nullable().optional(),
		promptFile: z.string().min(1).nullable().optional(),
		inputDelivery: z.enum(["prompt", "poll"]).optional(),
		pollPrompt: z.string().min(1).nullable().optional(),
		messageNotification: z.boolean().optional(),
		outputSuffix: z.enum(["include", "omit"]).optional(),
		inputArtifacts: z.record(z.unknown()).nullable().optional(),
		outputSchema: z.record(z.unknown()).nullable().optional(),
		prepareRepository: z.boolean().default(false),
		/** When true, append Security Policy file path instruction to the agent prompt. */
		includePolicy: z.boolean().default(false),
	})
	.default({});

const stageConfigSchema = z.object({
	key: z.string().min(1),
	name: z.string().min(1),
	role: stageRoleSchema,
	group: z.string().min(1),
	concurrency: z.number().int().min(1),
	maxConcurrency: z.number().int().min(1).optional(),
	disableable: z.boolean().default(true),
	goal: z.boolean().default(false),
	goalPreserving: z.boolean().default(false),
	description: z.string().optional(),
	inputSchema: z.record(z.unknown()).optional(),
	outputSchema: z.record(z.unknown()).optional(),
	runtimeConfig: stageRuntimeConfigSchema,
	inputArtifacts: z
		.array(
			z.object({
				from: z.string().min(1),
				to: z.string().min(1),
				inputField: z.string().min(1).optional(),
				required: z.boolean().optional().default(true),
			}),
		)
		.default([]),
	outputArtifacts: z
		.array(
			z.object({
				from: z.string().min(1),
				to: z.string().min(1),
				inputField: z.string().min(1).optional(),
				required: z.boolean().optional().default(true),
			}),
		)
		.default([]),
	jobOutput: z.boolean().default(false),
	effects: z
		.array(
			z.discriminatedUnion("type", [
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
					operation: z.enum([
						"persist-candidate",
						"apply-judge",
						"apply-dedup",
					]),
				}),
			]),
		)
		.default([]),
	report: z
		.object({
			path: z.string().min(1),
			required: z.boolean().default(true),
		})
		.optional(),
	taskName: z.string().min(1).optional(),
	containerNameParts: z.array(z.string()).default([]),
	allowAgentExit: z.boolean().default(false),
	promptValues: z.record(z.unknown()).default({}),
});

const edgeConfigSchema = z.object({
	name: z.string().min(1),
	from: z.string().min(1),
	to: z.string().min(1),
	fork: z.boolean().default(false),
	mode: z.enum(["map", "fanOut"]).optional(),
	foreach: z.string().min(1).optional(),
	input: z.unknown().optional(),
	outputSchema: z.record(z.unknown()).optional(),
	route: z
		.object({
			key: z.string().min(1),
			default: z.boolean().optional(),
			description: z.string().optional(),
		})
		.optional(),
	artifacts: z
		.array(
			z.object({
				from: z.string().min(1),
				to: z.string().min(1),
				inputField: z.string().min(1).optional(),
				required: z.boolean().optional().default(true),
			}),
		)
		.default([]),
});

const groupConfigSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	leader: z.string().min(1),
	members: z.array(z.string().min(1)).default([]),
});

const pipelineConfigSchema = z.object({
	name: z.string().min(1),
	root: z.string().min(1),
	stages: z.array(z.string().min(1)).min(1),
	edges: z.array(edgeConfigSchema).default([]),
	groups: z.array(groupConfigSchema).default([]),
});

const scanPipelineDefinitionsSourceSchema = z.object({
	version: z.number().int().min(1).default(2),
	schemas: z.record(z.record(z.unknown())).default({}),
	stages: z.record(stageConfigSchema),
	pipelines: z
		.record(pipelineConfigSchema)
		.refine(
			(pipelines) =>
				Boolean(pipelines.full && pipelines.delta && pipelines.research),
			{
				message: "pipelines must define full, delta, and research",
			},
		),
});

export type ScanStageRole = z.infer<typeof stageRoleSchema>;

export type ScanPipelineStageConfig = {
	id: string;
	key: string;
	name: string;
	role: ScanStageRole;
	group: string;
	concurrency: number;
	maxConcurrency: number | null;
	disableable: boolean;
	goal: boolean;
	goalPreserving?: boolean;
	description: string | null;
	inputSchema: Record<string, unknown> | null;
	outputSchema: Record<string, unknown> | null;
	runtimeConfig: ScanStageRuntimeConfig | null;
	inputArtifacts: Array<{ from: string; to: string; inputField?: string; required: boolean }>;
	outputArtifacts: Array<{ from: string; to: string; inputField?: string; required: boolean }>;
	jobOutput: boolean;
	effects: Array<
		| { type: "sync-candidates" }
		| {
				type: "project-candidate-result";
				resultStage: "analyze" | "critique" | "verify" | "triage";
			}
		| {
				type: "research-registry";
				operation:
					| "persist-scope"
					| "persist-track-plan"
					| "apply-track-review"
					| "record-discovery"
					| "record-finding-validation"
					| "record-finding-review"
					| "persist-chain"
					| "apply-chain-review"
					| "record-exploit-validation"
					| "apply-exploit-review"
					| "persist-report";
			}
		| {
				type: "tob-goal-registry";
				operation: "persist-candidate" | "apply-judge" | "apply-dedup";
			}
	>;
	report: { path: string; required: boolean } | null;
	taskName: string | null;
	promptValues: Record<string, unknown>;
	containerNameParts: string[];
	allowAgentExit: boolean;
};

export type ScanStageRuntimeConfig = {
	agentProfile: string | null;
	goalSession?: "shared" | "per-task";
	persistent: boolean | null;
	reuseContainer: boolean | null;
	nullableOutput: boolean | null;
	cwd: string | null;
	skills: string[] | null;
	mcp: string[] | null;
	prompt: string | null;
	promptFile: string | null;
	inputDelivery?: "prompt" | "poll";
	pollPrompt?: string | null;
	messageNotification?: boolean;
	outputSuffix?: "include" | "omit";
	inputArtifacts: Record<string, unknown> | null;
	outputSchema: Record<string, unknown> | null;
	prepareRepository?: boolean;
	/** When true, append Security Policy file path instruction to the agent prompt. */
	includePolicy?: boolean;
};

export type ScanPipelineEdgeConfig = {
	id: string;
	name: string;
	from: string;
	to: string;
	fork: boolean;
	mode: "map" | "fanOut" | null;
	foreach: string | null;
	input: unknown;
	outputSchema: Record<string, unknown> | null;

	artifacts: Array<{ from: string; to: string; inputField?: string; required: boolean }>;
	route: {
		key: string;
		default?: boolean;
		description?: string;
	} | null;
};

export type ScanPipelineGroupConfig = {
	id: string;
	name: string;
	leader: string;
	members: string[];
};

export type ScanPipelineConfig = {
	id: string;
	name: string;
	rootStageId: string;
	stageIds: string[];
	edges: ScanPipelineEdgeConfig[];
	groups: ScanPipelineGroupConfig[];
};

export type ScanPipelineMap = {
	full: ScanPipelineConfig;
	delta: ScanPipelineConfig;
	research: ScanPipelineConfig;
	"tob-goal"?: ScanPipelineConfig;
} & Record<string, ScanPipelineConfig>;

export type ScanPipelineDefinitions = {
	version: number;
	pipelineIds: Record<string, string>;
	schemas: Record<string, Record<string, unknown>>;
	stageIds: string[];
	stages: ScanPipelineStageConfig[];
	stageMetadata: Record<string, { id: string; name: string }>;
	stageMetadataById: Record<string, { key: string; id: string; name: string }>;
	stageSettings: Record<
		string,
		{
			stageName: string;
			label: string;
			role: ScanStageRole;
			group: string;
			concurrency: number;
			maxConcurrency: number;
			disableable: boolean;
			description: string;
			inputSchema: Record<string, unknown> | null;
			outputSchema: Record<string, unknown> | null;
			runtimeConfig: ScanStageRuntimeConfig | null;
		}
	>;
	pipelines: ScanPipelineMap;
};

export type ScanPipelineDefinitionsSource = z.infer<
	typeof scanPipelineDefinitionsSourceSchema
>;

export const normalizePipelineDefinitionSnapshot = (
	value: unknown,
	options: { useBaseline?: boolean } = {},
): ScanPipelineDefinitions => {
	const useBaseline = options.useBaseline ?? true;
	if (!value || typeof value !== "object") {
		throw new Error("Invalid scan pipeline definition snapshot");
	}
	const snapshot = value as Partial<ScanPipelineDefinitions> & {
		stages?: unknown;
		pipelines?: unknown;
	};
	if (!snapshot.stages || !snapshot.pipelines) {
		throw new Error("Invalid scan pipeline definition snapshot");
	}
	if (
		!Array.isArray(snapshot.stages) ||
		!isRecord(snapshot.pipelines)
	) {
		throw new Error(
			"Invalid scan pipeline definition snapshot: stages and pipelines have invalid shapes",
		);
	}
	const stages = (snapshot.stages as ScanPipelineStageConfig[]).map((stage) => ({
		...stage,
		inputArtifacts: stage.inputArtifacts ?? [],
		outputArtifacts: stage.outputArtifacts ?? [],
		jobOutput: stage.jobOutput ?? false,
		goal: stage.goal ?? false,
		goalPreserving: stage.goalPreserving ?? false,
		effects: stage.effects ?? [],
		report: stage.report ?? null,
		promptValues: stage.promptValues ?? {},
		containerNameParts: stage.containerNameParts ?? [],
		allowAgentExit: stage.allowAgentExit ?? false,
	}));
	const pipelines = Object.fromEntries(
		Object.entries(snapshot.pipelines as ScanPipelineMap).map(([id, pipeline]) => [
			id,
			{
				...pipeline,
				edges: pipeline.edges.map((edge) => ({
					...edge,
					artifacts: edge.artifacts ?? [],
				})),
				groups: pipeline.groups ?? [],
			},
		]),
	) as ScanPipelineMap;
	const baseline = useBaseline ? loadScanPipelineDefinitions() : null;
	const baselineStages = new Map(
		baseline?.stages.map((stage) => [stage.id, stage]) ?? [],
	);
	const mergedStages = stages.map((stage) => {
		const defaults = baselineStages.get(stage.id);
		if (!defaults) return stage;
		return {
			...defaults,
			...stage,
			runtimeConfig: {
				...(defaults.runtimeConfig ?? {}),
				...(stage.runtimeConfig ?? {}),
			},
			inputArtifacts:
				stage.inputArtifacts.length > 0
					? stage.inputArtifacts
					: defaults.inputArtifacts,
			outputArtifacts:
				stage.outputArtifacts.length > 0
					? stage.outputArtifacts
					: defaults.outputArtifacts,
			effects: stage.effects.length > 0 ? stage.effects : defaults.effects,
			report: stage.report ?? defaults.report,
			promptValues:
				Object.keys(stage.promptValues).length > 0
					? stage.promptValues
					: defaults.promptValues,
		} as ScanPipelineStageConfig;
	});
	const baselinePipelines: ScanPipelineMap = baseline?.pipelines ?? {
		full: pipelines.full,
		delta: pipelines.delta,
		research: pipelines.research,
	};
	const mergedPipelines = Object.fromEntries(
		Object.entries(pipelines).map(([id, pipeline]) => {
			const defaults = baselinePipelines[id];
			if (!defaults) return [id, pipeline];
			const defaultEdges = new Map(defaults.edges.map((edge) => [edge.name, edge]));
			return [
				id,
				{
					...defaults,
					...pipeline,
					edges: pipeline.edges.map((edge) => {
						const defaultEdge = defaultEdges.get(edge.name);
						return defaultEdge && edge.artifacts.length === 0
							? { ...defaultEdge, ...edge, artifacts: defaultEdge.artifacts }
							: edge;
					}),
				},
			];
		}),
	) as ScanPipelineMap;
	const source = {
		version: 2,
		schemas: snapshot.schemas ?? baseline?.schemas ?? {},
		stages: Object.fromEntries(
			(mergedStages as ScanPipelineStageConfig[]).map((stage) => [stage.id, {
				key: stage.key,
				name: stage.name,
				role: stage.role,
				group: stage.group,
				concurrency: stage.concurrency,
				maxConcurrency: stage.maxConcurrency ?? undefined,
				disableable: stage.disableable,
				description: stage.description ?? undefined,
				inputSchema: stage.inputSchema ?? undefined,
				outputSchema: stage.outputSchema ?? undefined,
				runtimeConfig: stage.runtimeConfig ?? {},
				inputArtifacts: stage.inputArtifacts,
				outputArtifacts: stage.outputArtifacts,
				jobOutput: stage.jobOutput,
				goal: stage.goal,
				goalPreserving: stage.goalPreserving,
				effects: stage.effects,
				report: stage.report ?? undefined,
				taskName: stage.taskName ?? undefined,
				promptValues: stage.promptValues,
				containerNameParts: stage.containerNameParts,
				allowAgentExit: stage.allowAgentExit,
			}]),
		),
		pipelines: Object.fromEntries(
			Object.entries(mergedPipelines).map(([id, pipeline]) => [id, {
				name: pipeline.name,
				root: pipeline.rootStageId,
				stages: pipeline.stageIds,
				edges: pipeline.edges.map((edge) => ({
					name: edge.name,
					from: edge.from,
					to: edge.to,
					fork: edge.fork,
					mode: edge.mode ?? undefined,
					foreach: edge.foreach ?? undefined,
					input: edge.input ?? undefined,
					outputSchema: edge.outputSchema ?? undefined,
					route: edge.route ?? undefined,
					artifacts: edge.artifacts,
				})),
				groups: pipeline.groups,
			}]),
		),
	};
	return parseScanPipelineDefinitionsSource(source);
};

export const normalizeLegacyVerificationSchema = (
	definitions: ScanPipelineDefinitions,
): ScanPipelineDefinitions => {
	const verification = definitions.schemas.Verification;
	const properties = verification?.properties;
	const result =
		properties && typeof properties === "object"
			? (properties as Record<string, unknown>).result
			: null;
	const values =
		result && typeof result === "object"
			? (result as { enum?: unknown }).enum
			: null;
	if (
		!Array.isArray(values) ||
		values.length !== 3 ||
		values[0] !== true ||
		values[1] !== "likely" ||
		values[2] !== false
	) {
		return definitions;
	}
	return {
		...definitions,
		schemas: {
			...definitions.schemas,
			Verification: {
				...verification,
				properties: {
					...(properties as Record<string, unknown>),
					result: {
						...(result as Record<string, unknown>),
						enum: ["true", "likely", "false"],
					},
				},
			},
		},
	};
};

export const SCAN_PIPELINE_DEFINITIONS_PATH_ENV =
	"VULSEEK_SCAN_PIPELINE_DEFINITIONS_PATH";

const isTestRuntime = () =>
	process.env.NODE_ENV === "test" ||
	process.env.NODE === "test" ||
	process.env.VITEST === "true" ||
	process.argv.includes("--test") ||
	process.execArgv.includes("--test");

export const resolveScanPipelineResourceRoot = (
	configuredPath = process.env[SCAN_PIPELINE_DEFINITIONS_PATH_ENV],
) => {
	if (configuredPath?.trim()) {
		return resolve(configuredPath.trim());
	}
	if (isTestRuntime() || process.env.NODE_ENV !== "production") {
		return resolve(dirname(fileURLToPath(import.meta.url)), "..");
	}
	throw new Error(
		`${SCAN_PIPELINE_DEFINITIONS_PATH_ENV} must point to the external scan pipeline resource directory`,
	);
};

export const resolveScanPipelineDefinitionsDir = (
	moduleUrl: string,
	runtimeRoot = process.cwd(),
	configuredPath = process.env[SCAN_PIPELINE_DEFINITIONS_PATH_ENV],
) => {
	const resourceRoot = configuredPath?.trim()
		? resolve(configuredPath.trim())
		: isTestRuntime()
			? join(dirname(fileURLToPath(moduleUrl)), "..")
			: resolveScanPipelineResourceRoot(configuredPath);
	const candidates = [
		resourceRoot,
		join(resourceRoot, "pipeline", "definitions"),
		join(resourceRoot, "definitions"),
	];
	const definitionsDir = candidates.find((candidate) =>
		existsSync(join(candidate, "schemas")),
	);
	if (definitionsDir) {
		return definitionsDir;
	}
	if (!configuredPath && isTestRuntime()) {
		return join(runtimeRoot, "dist", "definitions");
	}
	throw new Error(
		`Scan pipeline definitions directory not found under ${resourceRoot}`,
	);
};

const yamlFileExtensions = new Set([".yaml", ".yml"]);

const listDefinitionYamlFiles = (directory: string) =>
	readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && yamlFileExtensions.has(extname(entry.name)))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
		.map((fileName) => join(directory, fileName));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);


const readDefinitionSection = (
	sectionName: "schemas" | "stages" | "pipelines",
	definitionsDir = resolveScanPipelineDefinitionsDir(import.meta.url),
): Record<string, unknown> => {
	const sectionDir = join(definitionsDir, sectionName);
	const merged: Record<string, unknown> = {};
	for (const filePath of listDefinitionYamlFiles(sectionDir)) {
		const parsed = parseYaml(readFileSync(filePath, "utf-8")) as unknown;
		if (!isRecord(parsed)) {
			throw new Error(
				`Scan pipeline ${sectionName} definition ${basename(filePath)} must be a YAML object`,
			);
		}
		for (const [key, value] of Object.entries(parsed)) {
			if (key in merged) {
				throw new Error(
					`Duplicate scan pipeline ${sectionName} definition ${key} in ${basename(filePath)}`,
				);
			}
			merged[key] = value;
		}
	}
	return merged;
};

export const readScanPipelineDefinitionsSource = (
	definitionsDir = resolveScanPipelineDefinitionsDir(import.meta.url),
) => ({
	version: 2,
	schemas: readDefinitionSection("schemas", definitionsDir),
	stages: readDefinitionSection("stages", definitionsDir),
	pipelines: readDefinitionSection("pipelines", definitionsDir),
});

export const readScanPipelineDefinitionsYaml = (
	definitionsDir = resolveScanPipelineDefinitionsDir(import.meta.url),
) => stringifyYaml(readScanPipelineDefinitionsSource(definitionsDir));

const toObjectKey = (stageId: string) =>
	stageId.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());

const normalizeStageRuntimeConfig = (
	config: z.infer<typeof stageRuntimeConfigSchema>,
): ScanStageRuntimeConfig => ({
	agentProfile: config.agentProfile ?? null,
	...(config.goalSession ? { goalSession: config.goalSession } : {}),
	persistent: config.persistent ?? null,
	reuseContainer: config.reuseContainer ?? null,
	nullableOutput: config.nullableOutput ?? null,
	cwd: config.cwd ?? null,
	skills: config.skills ?? null,
	mcp: config.mcp ?? null,
	prompt: config.prompt ?? null,
	promptFile: config.promptFile ?? null,
	...(config.inputDelivery ? { inputDelivery: config.inputDelivery } : {}),
	...(config.pollPrompt ? { pollPrompt: config.pollPrompt } : {}),
	...(config.messageNotification
		? { messageNotification: true }
		: {}),
	outputSuffix: config.outputSuffix === "omit" ? "omit" : "include",
	inputArtifacts: config.inputArtifacts ?? null,
	outputSchema: config.outputSchema ?? null,
	prepareRepository: config.prepareRepository ?? false,
	includePolicy: config.includePolicy ?? false,
});

const assertUnique = (values: string[], label: string) => {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`Duplicate ${label}: ${value}`);
		}
		seen.add(value);
	}
};

const validatePipelineTopology = (
	pipelineId: string,
	pipeline: ScanPipelineConfig,
	allStageIds: Set<string>,
) => {
	const pipelineStageIds = new Set(pipeline.stageIds);
	if (!allStageIds.has(pipeline.rootStageId)) {
		throw new Error(
			`Pipeline ${pipelineId} references unknown root stage ${pipeline.rootStageId}`,
		);
	}
	if (!pipelineStageIds.has(pipeline.rootStageId)) {
		throw new Error(
			`Pipeline ${pipelineId} root stage ${pipeline.rootStageId} is not listed in stages`,
		);
	}
	for (const stageId of pipeline.stageIds) {
		if (!allStageIds.has(stageId)) {
			throw new Error(
				`Pipeline ${pipelineId} references unknown stage ${stageId}`,
			);
		}
	}
	assertUnique(
		pipeline.edges.map((edge) => edge.name),
		`${pipelineId} edge name`,
	);
	for (const edge of pipeline.edges) {
		if (!pipelineStageIds.has(edge.from)) {
			throw new Error(
				`Pipeline ${pipelineId} edge ${edge.name} references unknown source stage ${edge.from}`,
			);
		}
		if (!pipelineStageIds.has(edge.to)) {
			throw new Error(
				`Pipeline ${pipelineId} edge ${edge.name} references unknown target stage ${edge.to}`,
			);
		}
	}
	for (const group of pipeline.groups) {
		if (!pipelineStageIds.has(group.leader)) {
			throw new Error(
				`Pipeline ${pipelineId} group ${group.id} references unknown leader stage ${group.leader}`,
			);
		}
		for (const member of group.members) {
			if (!pipelineStageIds.has(member)) {
				throw new Error(
					`Pipeline ${pipelineId} group ${group.id} references unknown member stage ${member}`,
				);
			}
		}
	}

	const edgesBySource = new Map<string, ScanPipelineEdgeConfig[]>();
	for (const edge of pipeline.edges) {
		edgesBySource.set(edge.from, [...(edgesBySource.get(edge.from) ?? []), edge]);
	}
	for (const [source, edges] of edgesBySource) {
		if (!edges.some((edge) => edge.route)) {
			continue;
		}
		if (edges.some((edge) => !edge.route)) {
			throw new Error(
				`Pipeline ${pipelineId} stage ${source} mixes routed and non-routed downstream edges`,
			);
		}
		const defaultCount = edges.filter((edge) => edge.route?.default).length;
		if (defaultCount !== 1) {
			throw new Error(
				`Pipeline ${pipelineId} stage ${source} must define exactly one default route`,
			);
		}
		// Same route key may fan to multiple targets (e.g. candidate → judge + surface).
		// Defaults must still identify a single route key.
		const defaultKeys = new Set(
			edges
				.filter((edge) => edge.route?.default)
				.map((edge) => edge.route?.key)
				.filter((key): key is string => Boolean(key)),
		);
		if (defaultKeys.size !== 1) {
			throw new Error(
				`Pipeline ${pipelineId} stage ${source} default routes must share one route key`,
			);
		}
	}
};

const validateJsonSchemaReferences = (
	schema: unknown,
	schemas: Record<string, Record<string, unknown>>,
) => {
	if (!schema || typeof schema !== "object") {
		return;
	}
	if (Array.isArray(schema)) {
		for (const item of schema) {
			validateJsonSchemaReferences(item, schemas);
		}
		return;
	}

	const record = schema as Record<string, unknown>;
	for (const key of ["$ref", "$pathOf"]) {
		const ref = record[key];
		if (typeof ref !== "string") {
			continue;
		}
		const prefix = "#/schemas/";
		if (!ref.startsWith(prefix)) {
			throw new Error(`Unsupported schema reference ${ref}`);
		}
		if (!schemas[ref.slice(prefix.length)]) {
			throw new Error(`Unknown schema reference ${ref}`);
		}
	}

	for (const value of Object.values(record)) {
		validateJsonSchemaReferences(value, schemas);
	}
};

const validateDefinitionsSchemaReferences = (
	stages: ScanPipelineStageConfig[],
	pipelines: Record<string, ScanPipelineConfig>,
	schemas: Record<string, Record<string, unknown>>,
) => {
	for (const stage of stages) {
		validateJsonSchemaReferences(stage.inputSchema, schemas);
		validateJsonSchemaReferences(stage.outputSchema, schemas);
	}
	for (const pipeline of Object.values(pipelines)) {
		for (const edge of pipeline.edges) {
			validateJsonSchemaReferences(edge.outputSchema, schemas);
		}
	}
	for (const schema of Object.values(schemas)) {
		validateJsonSchemaReferences(schema, schemas);
	}
};

const resolveSchemaObject = (
	schema: Record<string, unknown> | null | undefined,
	schemas: Record<string, Record<string, unknown>>,
): Record<string, unknown> | null => {
	if (!schema) {
		return null;
	}
	const ref = schema.$ref;
	if (typeof ref === "string") {
		const prefix = "#/schemas/";
		return schemas[ref.slice(prefix.length)] ?? null;
	}
	return schema;
};

const getSchemaProperties = (
	schema: Record<string, unknown> | null | undefined,
	schemas: Record<string, Record<string, unknown>>,
): Record<string, unknown> => {
	const resolved = resolveSchemaObject(schema, schemas);
	if (!resolved) {
		return {};
	}
	if (resolved.properties && typeof resolved.properties === "object") {
		return resolved.properties as Record<string, unknown>;
	}
	if (Array.isArray(resolved.allOf)) {
		return Object.assign(
			{},
			...resolved.allOf.map((item) =>
				typeof item === "object" && item
					? getSchemaProperties(item as Record<string, unknown>, schemas)
					: {},
			),
		);
	}
	return {};
};

const collectTransformExpressions = (value: unknown): string[] => {
	if (typeof value === "string" && value.startsWith("$")) {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(collectTransformExpressions);
	}
	if (value && typeof value === "object") {
		return Object.values(value).flatMap(collectTransformExpressions);
	}
	return [];
};

const readFirstField = (expression: string, prefix: string) => {
	const tail = expression.slice(prefix.length);
	const normalized = tail.endsWith("[*]") ? tail.slice(0, -3) : tail;
	return normalized.split(".")[0] || "";
};

const validatePathExpressionPrefix = (input: {
	expression: string;
	edge: ScanPipelineEdgeConfig;
	sourceStage: ScanPipelineStageConfig;
	schemas: Record<string, Record<string, unknown>>;
	allowForEachSuffix: boolean;
}) => {
	const { expression, edge, sourceStage, schemas, allowForEachSuffix } = input;
	if (expression === "$item") {
		if (edge.mode !== "fanOut") {
			throw new Error(`Edge ${edge.name} uses $item outside fanOut mode`);
		}
		return;
	}
	if (/^\$item\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		if (edge.mode !== "fanOut") {
			throw new Error(`Edge ${edge.name} uses $item outside fanOut mode`);
		}
		return;
	}
	if (/^\$ctx\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		return;
	}
	if (/^\$computed\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		return;
	}
	if (
		expression === "$output" ||
		/^\$output\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)
	) {
		return;
	}
	const outputPattern = allowForEachSuffix
		? /^\$\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(\[\*\])?$/
		: /^\$\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
	if (outputPattern.test(expression)) {
		const field = readFirstField(expression, "$.");
		const properties = getSchemaProperties(sourceStage.outputSchema, schemas);
		if (Object.keys(properties).length > 0 && !(field in properties)) {
			throw new Error(
				`Edge ${edge.name} references unknown output field ${field}`,
			);
		}
		return;
	}
	if (/^\$input\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		const field = readFirstField(expression, "$input.");
		const properties = getSchemaProperties(sourceStage.inputSchema, schemas);
		if (Object.keys(properties).length > 0 && !(field in properties)) {
			throw new Error(
				`Edge ${edge.name} references unknown input field ${field}`,
			);
		}
		return;
	}
	throw new Error(`Unsupported transform expression: ${expression}`);
};

const validateFileExpression = (input: {
	expression: string;
	edge: ScanPipelineEdgeConfig;
	sourceStage: ScanPipelineStageConfig;
	schemas: Record<string, Record<string, unknown>>;
	requireForEach: boolean;
}) => {
	const match = input.expression.match(
		/^\$file\((.+?)\)((?:\.[A-Za-z0-9_-]+)*)(\[\*\])?$/,
	);
	if (!match) {
		throw new Error(
			`Unsupported transform expression: ${input.expression}`,
		);
	}
	const pathExpr = match[1] ?? "";
	const hasForEach = Boolean(match[3]);
	if (input.requireForEach && !hasForEach) {
		throw new Error(
			`Edge ${input.edge.name} fanOut foreach $file expression must end with [*]`,
		);
	}
	if (!input.requireForEach && hasForEach) {
		throw new Error(
			`Edge ${input.edge.name} uses foreach [*] outside fanOut foreach`,
		);
	}
	validatePathExpressionPrefix({
		expression: pathExpr,
		edge: input.edge,
		sourceStage: input.sourceStage,
		schemas: input.schemas,
		allowForEachSuffix: false,
	});
};

const validateTransformExpression = (input: {
	expression: string;
	edge: ScanPipelineEdgeConfig;
	sourceStage: ScanPipelineStageConfig;
	schemas: Record<string, Record<string, unknown>>;
	isForEach?: boolean;
}) => {
	const { expression, edge, sourceStage, schemas, isForEach = false } = input;
	if (expression.startsWith("$file(")) {
		validateFileExpression({
			expression,
			edge,
			sourceStage,
			schemas,
			requireForEach: isForEach,
		});
		return;
	}
	validatePathExpressionPrefix({
		expression,
		edge,
		sourceStage,
		schemas,
		allowForEachSuffix: isForEach,
	});
};

const validateDefinitionsEdgeTransformExpressions = (
	stages: ScanPipelineStageConfig[],
	pipelines: Record<string, ScanPipelineConfig>,
	schemas: Record<string, Record<string, unknown>>,
) => {
	const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
	for (const pipeline of Object.values(pipelines)) {
		for (const edge of pipeline.edges) {
			if (edge.mode === "fanOut") {
				if (!edge.foreach) {
					throw new Error(`Edge ${edge.name} fanOut requires foreach`);
				}
				validateTransformExpression({
					expression: edge.foreach,
					edge,
					sourceStage: stagesById.get(edge.from)!,
					schemas,
					isForEach: true,
				});
			}
			for (const expression of collectTransformExpressions(edge.input)) {
				validateTransformExpression({
					expression,
					edge,
					sourceStage: stagesById.get(edge.from)!,
					schemas,
					isForEach: false,
				});
			}
		}
	}
};

export const parseScanPipelineDefinitionsSource = (
	source: unknown,
): ScanPipelineDefinitions => {
	const parsed = scanPipelineDefinitionsSourceSchema.parse(source);
	const stageIds = Object.keys(parsed.stages);
	assertUnique(stageIds, "stage id");
	assertUnique(
		Object.values(parsed.stages).map((stage) => stage.key),
		"stage key",
	);

	const stages = Object.entries(parsed.stages).map(
		([id, stage]): ScanPipelineStageConfig => {
			return {
				id,
				key: stage.key,
				name: stage.name,
				role: stage.role,
				group: stage.group,
				concurrency: stage.concurrency,
				maxConcurrency: stage.maxConcurrency ?? null,
				disableable: stage.disableable,
				description: stage.description ?? null,
				inputSchema: stage.inputSchema ?? null,
				outputSchema: stage.outputSchema ?? null,
				runtimeConfig: normalizeStageRuntimeConfig(stage.runtimeConfig),
				inputArtifacts: stage.inputArtifacts,
				outputArtifacts: stage.outputArtifacts,
				jobOutput: stage.jobOutput,
				goal: stage.goal,
				goalPreserving: stage.goalPreserving,
				effects: stage.effects,
				report: stage.report ?? null,
				taskName: stage.taskName ?? null,
				promptValues: stage.promptValues,
				containerNameParts: stage.containerNameParts,
				allowAgentExit: stage.allowAgentExit,
			};
		},
	);
	const allStageIds = new Set(stageIds);
	const buildPipeline = ([id, pipeline]: [string, z.infer<typeof pipelineConfigSchema>]): ScanPipelineConfig => {
		return {
			id,
			name: pipeline.name,
			rootStageId: pipeline.root,
			stageIds: [...pipeline.stages],
			edges: pipeline.edges.map((edge) => ({
				id: edge.name,
				name: edge.name,
				from: edge.from,
				to: edge.to,
				fork: edge.fork,
				mode: edge.mode ?? null,
				foreach: edge.foreach ?? null,
				input: edge.input ?? null,
				outputSchema: edge.outputSchema ?? null,
				artifacts: edge.artifacts.map((artifact) => ({
					from: artifact.from,
					to: artifact.to,
					inputField: artifact.inputField,
					required: artifact.required,
				})),
					route: edge.route
					? {
							key: edge.route.key,
							default: edge.route.default,
							description: edge.route.description,
						}
					: null,
			})),
			groups: pipeline.groups.map((group) => ({
				id: group.id,
				name: group.name,
				leader: group.leader,
				members: [...group.members],
			})),
		};
	};
	const pipelines = Object.fromEntries(
		Object.entries(parsed.pipelines).map((entry) => [entry[0], buildPipeline(entry)]),
	) as ScanPipelineMap;
	for (const [pipelineId, pipeline] of Object.entries(pipelines)) {
		validatePipelineTopology(pipelineId, pipeline, allStageIds);
	}
	validateDefinitionsSchemaReferences(stages, pipelines, parsed.schemas);
	validateDefinitionsEdgeTransformExpressions(stages, pipelines, parsed.schemas);

	return {
		version: parsed.version,
		pipelineIds: Object.fromEntries(
			Object.keys(pipelines).map((pipelineId) => [pipelineId, pipelineId]),
		),
		schemas: parsed.schemas,
		stageIds,
		stages,
		stageMetadata: Object.fromEntries(
			stages.map((stage) => [stage.key, { id: stage.id, name: stage.name }]),
		),
		stageMetadataById: Object.fromEntries(
			stages.map((stage) => [
				stage.id,
				{ key: stage.key, id: stage.id, name: stage.name },
			]),
		),
		stageSettings: Object.fromEntries(
			stages.map((stage) => [
				toObjectKey(stage.id),
				{
					stageName: stage.id,
					label: stage.name,
					role: stage.role,
					group: stage.group,
					concurrency: stage.concurrency,
					maxConcurrency: stage.maxConcurrency ?? 128,
					disableable: stage.disableable,
					description: stage.description ?? stage.name,
					inputSchema: stage.inputSchema,
					outputSchema: stage.outputSchema,
					runtimeConfig: stage.runtimeConfig,
				},
			]),
		),
		pipelines,
	};
};

export const parseScanPipelineDefinitionsFromYaml = (rawYaml: string) =>
	parseScanPipelineDefinitionsSource(parseYaml(rawYaml));

export type StageRuntimeConfigDeps = {
	loadScanJobPipelineDefinitionSnapshot: (
		scanJobId: string,
	) => Promise<ScanPipelineDefinitions>;
};

export function resolvePromptFileContent(
	promptFile: string,
	resourceRoot = resolveScanPipelineResourceRoot(),
) {
	const fileName = basename(promptFile);
	if (fileName !== promptFile) {
		throw new Error(`Invalid prompt file name: ${promptFile}`);
	}
	for (const promptDir of ["stages", "prompts"]) {
		try {
			return readFileSync(join(resourceRoot, promptDir, fileName), "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}
	throw new Error(`Prompt file not found: ${promptFile}`);
}

export const validateStagePromptConfiguration = (
	stages: ScanPipelineStageConfig[],
	resourceRoot = resolveScanPipelineResourceRoot(),
) => {
	for (const stage of stages) {
		const runtimeConfig = stage.runtimeConfig;
		if (!runtimeConfig?.prompt?.trim() && !runtimeConfig?.promptFile) {
			throw new Error(
				`Stage ${stage.id} must configure runtimeConfig.prompt or runtimeConfig.promptFile`,
			);
		}
		if (runtimeConfig.promptFile) {
			resolvePromptFileContent(runtimeConfig.promptFile, resourceRoot);
		}
	}
};

const hydrateStagePromptContent = (
	definitions: ScanPipelineDefinitions,
	resourceRoot: string,
): ScanPipelineDefinitions => ({
	...definitions,
	stages: definitions.stages.map((stage) => {
		const promptFile = stage.runtimeConfig?.promptFile;
		if (!promptFile || stage.runtimeConfig?.prompt?.trim()) {
			return stage;
		}
		return {
			...stage,
			runtimeConfig: {
				...stage.runtimeConfig,
				prompt: resolvePromptFileContent(promptFile, resourceRoot),
			} as ScanStageRuntimeConfig,
		};
	}),
});

export const loadScanPipelineDefinitions = (
	configuredPath = process.env[SCAN_PIPELINE_DEFINITIONS_PATH_ENV],
) => {
	const resourceRoot = resolveScanPipelineResourceRoot(configuredPath);
	const definitionsDir = resolveScanPipelineDefinitionsDir(
		import.meta.url,
		process.cwd(),
		configuredPath,
	);
	const definitions = parseScanPipelineDefinitionsSource(
		readScanPipelineDefinitionsSource(definitionsDir),
	);
	validateStagePromptConfiguration(definitions.stages, resourceRoot);
	return hydrateStagePromptContent(definitions, resourceRoot);
};

export const createStageRuntimeConfigWithDeps = (input: {
	scanJobId: string;
	stageName: string;
	loadScanJobPipelineDefinitionSnapshot: StageRuntimeConfigDeps["loadScanJobPipelineDefinitionSnapshot"];
}) => {
	const loadStage = async () => {
		const definitions = await input.loadScanJobPipelineDefinitionSnapshot(
			input.scanJobId,
		);
		const stage = definitions.stages.find((item) => item.id === input.stageName);
		if (!stage) {
			throw new Error(
				`Stage ${input.stageName} not found in scan job pipeline definition snapshot`,
			);
		}
		return stage;
	};
	const loadRuntimeConfig = async () => (await loadStage()).runtimeConfig;
	return {
		getConcurrency: async () => (await loadStage()).concurrency,
		getAgentProfile: async () =>
			(await loadRuntimeConfig())?.agentProfile ?? null,
		getGoalSession: async () =>
			(await loadRuntimeConfig())?.goalSession ?? null,
		getPersistent: async () => (await loadRuntimeConfig())?.persistent ?? null,
		getReuseContainer: async () =>
			(await loadRuntimeConfig())?.reuseContainer ?? null,
		getNullableOutput: async () =>
			(await loadRuntimeConfig())?.nullableOutput ?? null,
		getCwd: async () => (await loadRuntimeConfig())?.cwd ?? null,
		getSkills: async () => (await loadRuntimeConfig())?.skills ?? [],
		getMcp: async () => (await loadRuntimeConfig())?.mcp ?? [],
		getPrompt: async () => {
			const runtimeConfig = await loadRuntimeConfig();
			if (runtimeConfig?.prompt?.trim()) {
				return runtimeConfig.prompt;
			}
			if (runtimeConfig?.promptFile) {
				return resolvePromptFileContent(runtimeConfig.promptFile);
			}
			return null;
		},
		getInputArtifacts: async () =>
			(await loadRuntimeConfig())?.inputArtifacts ?? null,
		getOutputSchema: async () =>
			(await loadRuntimeConfig())?.outputSchema ??
			(await loadStage()).outputSchema ??
			null,
	};
};
