import {
	loadScanPipelineDefinitions,
	type ScanPipelineConfig,
	type ScanPipelineDefinitions,
	type ScanPipelineEdgeConfig,
	type ScanPipelineStageConfig,
} from "../scan-pipeline-definitions";
import {
	PIPELINE_DEFAULT_LIMITS,
	type PipelineDocumentV3,
	type PipelineEffectV3,
} from "./pipeline-document-v3";
import {
	RESEARCH_JOB_TABS,
	TOB_GOAL_JOB_TABS,
	VULNERABILITY_CANDIDATES_TAB,
} from "./pipeline-job-tabs";

/**
 * V2 → V3 conversion.
 *
 * The legacy filesystem definitions (pipelines/*.yaml + stages/*.yaml +
 * schemas/*.yaml) are the only V2 source still read at runtime; every new
 * pipeline is authored and stored as a single V3 document. This converter is
 * used to seed the built-in pipelines (`slug = full|delta|research|tob-goal`)
 * per organization when no matching pipeline exists.
 *
 * Conversion rules:
 * - Stage id = legacy stage file name (kebab-case slug).
 * - Prompts are inlined: `loadScanPipelineDefinitions` hydrates
 *   `runtimeConfig.prompt` from prompt files, so V3 always carries inline
 *   prompts and never `promptFile`.
 * - `prepareRepository` derives from the pipeline kind: full/research/
 *   tob-goal → `target` on the root stage, delta → `diff`.
 * - research-specific runtime behaviors become explicit plugins on the
 *   stages that owned them (research → research-track/research-deadline).
 * - Edge `name` is kept as both `id` (stable slug when possible) and `name`.
 */

export type PipelineKind = "full" | "delta" | "research" | "tob-goal";

export const PIPELINE_KINDS: readonly PipelineKind[] = [
	"full",
	"delta",
	"research",
	"tob-goal",
] as const;

const toSlug = (value: string): string =>
	value
		.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

const SCHEMA_REF_PATTERN = /#\/schemas\/[A-Za-z0-9_]+/g;

/**
 * V2 schema ids are PascalCase (`ScanTargetStageInput`) but V3 requires
 * stable slugs. Rewrite every internal `#/schemas/<id>` reference (including
 * `$pathOf` values and nested JSON Schema positions) to the slug form.
 */
const buildSchemaRefRewriter = (
	schemas: Record<string, unknown>,
): {
	schemas: Record<string, unknown>;
	rewrite: (value: string) => string;
	rewriteRefsDeep: (value: unknown) => unknown;
} => {
	const idMap = new Map<string, string>();
	for (const id of Object.keys(schemas)) {
		idMap.set(id, toSlug(id));
	}
	const rewrite = (value: string): string =>
		value.replace(SCHEMA_REF_PATTERN, (match) => {
			const refId = match.slice("#/schemas/".length);
			const slug = idMap.get(refId);
			return slug ? `#/schemas/${slug}` : match;
		});
	const rewriteRefsDeep = (value: unknown): unknown => {
		if (typeof value === "string") {
			if (value.startsWith("#/schemas/")) return rewrite(value);
			return value;
		}
		if (Array.isArray(value)) return value.map(rewriteRefsDeep);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(
					([key, nested]) => [key, rewriteRefsDeep(nested)],
				),
			);
		}
		return value;
	};
	return {
		schemas: Object.fromEntries(
			Object.entries(schemas).map(([id, schema]) => [
				toSlug(id),
				rewriteRefsDeep(schema),
			]),
		),
		rewrite,
		rewriteRefsDeep,
	};
};

const prepareModeForKind = (kind: PipelineKind) =>
	kind === "delta" ? "diff" : "target";

const pluginsForStage = (
	kind: PipelineKind,
	stageId: string,
	effects: PipelineEffectV3[],
): string[] => {
	const plugins: string[] = [];
	if (kind === "research") {
		const hasRegistry = effects.some(
			(effect) => effect.type === "research-registry",
		);
		if (hasRegistry) {
			if (stageId === "research-scope") plugins.push("research-track");
			plugins.push("research-deadline");
		}
	}
	return plugins;
};

type SchemaRefRewriter = ReturnType<typeof buildSchemaRefRewriter>;

const convertStage = (
	kind: PipelineKind,
	stage: ScanPipelineStageConfig,
	rootStageId: string,
	rewriter: SchemaRefRewriter,
): { id: string; stage: PipelineDocumentV3["stages"][string] } => {
	const runtimeConfig = stage.runtimeConfig;
	const effects: PipelineEffectV3[] = stage.effects;
	const preparesRepository =
		runtimeConfig?.prepareRepository === true ||
		stage.promptValues?.prepareRepository === true;
	return {
		id: stage.id,
		stage: {
			name: stage.name,
			...(stage.description ? { description: stage.description } : {}),
			role: stage.role,
			group: stage.group,
			concurrency: stage.concurrency,
			...(stage.maxConcurrency != null
				? { maxConcurrency: stage.maxConcurrency }
				: {}),
			disableable: stage.disableable,
			goal: stage.goal,
			...(stage.goalPreserving ? { goalPreserving: true } : {}),
				runtime: {
					kind: "agent",
					...(runtimeConfig?.agentProfile
						? { agentProfileId: runtimeConfig.agentProfile }
						: {}),
					...(runtimeConfig?.goalSession
						? { goalSession: runtimeConfig.goalSession }
						: {}),
				...(runtimeConfig?.persistent != null
					? { persistent: runtimeConfig.persistent }
					: {}),
				...(runtimeConfig?.reuseContainer != null
					? { reuseContainer: runtimeConfig.reuseContainer }
					: {}),
				...(runtimeConfig?.nullableOutput != null
					? { nullableOutput: runtimeConfig.nullableOutput }
					: {}),
				...(runtimeConfig?.cwd ? { cwd: runtimeConfig.cwd } : {}),
				...(runtimeConfig?.skills?.length
					? { skills: runtimeConfig.skills }
					: {}),
				prompt: runtimeConfig?.prompt ?? "",
				prepareRepository:
					stage.id === rootStageId && preparesRepository
						? prepareModeForKind(kind)
						: "none",
				includePolicy: runtimeConfig?.includePolicy ?? false,
				plugins: pluginsForStage(
					kind,
					stage.id,
					effects,
				) as PipelineDocumentV3["stages"][string]["runtime"]["plugins"],
			},
			...(stage.inputSchema
				? {
						inputSchema: rewriter.rewriteRefsDeep(
							stage.inputSchema,
						) as Record<string, unknown>,
					}
				: {}),
			...(stage.outputSchema
				? {
						outputSchema: rewriter.rewriteRefsDeep(
							stage.outputSchema,
						) as Record<string, unknown>,
					}
				: {}),
			inputArtifacts: stage.inputArtifacts,
			outputArtifacts: stage.outputArtifacts,
			jobOutput: stage.jobOutput,
			effects,
			...(stage.report ? { report: stage.report } : {}),
			...(stage.taskName ? { taskName: stage.taskName } : {}),
			containerNameParts: stage.containerNameParts,
			allowAgentExit: stage.allowAgentExit,
			promptValues: stage.promptValues,
		},
	};
};

const convertEdge = (
	edge: ScanPipelineEdgeConfig,
	rewriter: SchemaRefRewriter,
): PipelineDocumentV3["edges"][number] => ({
	id: toSlug(edge.name) || edge.name,
	name: edge.name,
	from: edge.from,
	to: edge.to,
	fork: edge.fork,
	mode: edge.mode ?? "map",
	...(edge.foreach ? { foreach: edge.foreach } : {}),
	...(edge.input != null ? { input: edge.input } : {}),
	artifacts: edge.artifacts,
	...(edge.outputSchema
		? {
				outputSchema: rewriter.rewriteRefsDeep(
					edge.outputSchema,
				) as Record<string, unknown>,
			}
		: {}),
	...(edge.route ? { route: edge.route } : {}),
});

const convertPipeline = (
	kind: PipelineKind,
	pipeline: ScanPipelineConfig,
	definitions: ScanPipelineDefinitions,
): PipelineDocumentV3 => {
	const rewriter = buildSchemaRefRewriter(definitions.schemas);
	const stagesById = new Map(
		definitions.stages.map((stage) => [stage.id, stage] as const),
	);
	const convertedStages: PipelineDocumentV3["stages"] = {};
	for (const stageId of pipeline.stageIds) {
		const stage = stagesById.get(stageId);
		if (!stage) continue;
		const { id, stage: converted } = convertStage(
			kind,
			stage,
			pipeline.rootStageId,
			rewriter,
		);
		convertedStages[id] = converted;
	}

	return {
		version: 3,
		name: pipeline.name,
		supportedTargets: ["project", "evaluation"],
		root: pipeline.rootStageId,
		limits: { ...PIPELINE_DEFAULT_LIMITS },
		schemas: rewriter.schemas as PipelineDocumentV3["schemas"],
		stages: convertedStages,
		edges: pipeline.edges.map((edge) => convertEdge(edge, rewriter)),
		groups: pipeline.groups.map((group) => ({
			id: group.id,
			name: group.name,
			leader: group.leader,
			members: group.members,
		})),
		presentation: {
			jobTabs:
				kind === "research"
					? RESEARCH_JOB_TABS
					: kind === "tob-goal"
						? TOB_GOAL_JOB_TABS
						: [VULNERABILITY_CANDIDATES_TAB],
		},
	};
};

export type V2ConversionResult = {
	documents: Partial<Record<PipelineKind, PipelineDocumentV3>>;
	skipped: Array<{ kind: PipelineKind; reason: string }>;
};

/**
 * Convert the four built-in V2 pipelines into V3 documents.
 * `source` defaults to the live filesystem definitions; tests may inject a
 * parsed definitions object.
 */
export const convertV2DefinitionsToV3 = (
	source?: ScanPipelineDefinitions,
): V2ConversionResult => {
	const definitions = source ?? loadScanPipelineDefinitions();
	const documents: V2ConversionResult["documents"] = {};
	const skipped: V2ConversionResult["skipped"] = [];

	for (const kind of PIPELINE_KINDS) {
		const pipeline = definitions.pipelines[kind];
		if (!pipeline) {
			skipped.push({ kind, reason: "not present in definitions" });
			continue;
		}
		documents[kind] = convertPipeline(kind, pipeline, definitions);
	}
	return { documents, skipped };
};
