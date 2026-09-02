import type {
	PipelineContext,
	StageContext,
} from "../stages/full-scan-stage.runtime";
import type { StructuredOutputSchemaSource } from "./scan-pipeline-schema-contracts";
import type { StageDefinition } from "./stage-definition";

export type PipelineStageName = string;

export type AnyStageDefinition<TPipelineContext extends PipelineContext> =
	StageDefinition<TPipelineContext, any, any, any>;

export type StageInputOf<TStage> = TStage extends StageDefinition<
	any,
	infer TInput,
	any,
	any
>
	? TInput
	: never;

export type StageOutputOf<TStage> = TStage extends StageDefinition<
	any,
	any,
	infer TOutput,
	any
>
	? TOutput
	: never;

export type FirstStageOf<TStages extends readonly unknown[]> =
	TStages extends readonly [infer TFirst, ...unknown[]] ? TFirst : never;

export type FirstStageInputOf<TStages extends readonly unknown[]> =
	StageInputOf<FirstStageOf<TStages>>;

export type PipelineEdge<
	TPipelineContext extends PipelineContext,
	TFromStage extends AnyStageDefinition<TPipelineContext>,
	TToStageInputObject,
	TToStage extends StageDefinition<
		TPipelineContext,
		TToStageInputObject,
		any,
		StageContext
	> = StageDefinition<TPipelineContext, TToStageInputObject, any, StageContext>,
	TSelectedOutput = StageOutputOf<TFromStage>,
> = {
	name: string;
	from: TFromStage;
	to: TToStage;
	fork?: boolean;
	route?: {
		key: string;
		default?: boolean;
		description?: string;
	};
	outputSchema?: StructuredOutputSchemaSource;
	transformOutput?: (input: {
		ctx: TPipelineContext;
		fromTaskId: string;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: TSelectedOutput;
	}) => Promise<TToStageInputObject[]>;
	createTasks?: (input: {
		ctx: TPipelineContext;
		fromTaskId: string;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: TSelectedOutput;
		nextInputObjects: TToStageInputObject[];
		sourceMessageId: string;
		sourceEdgeName: string;
		sourceItemIndexes?: number[];
	}) => Promise<string[]>;
};

export type PipelineStageGroup<
	TPipelineContext extends PipelineContext = PipelineContext,
> = {
	name: string;
	leader: AnyStageDefinition<TPipelineContext>;
	members: readonly AnyStageDefinition<TPipelineContext>[];
};

export type PipelineDefinition<
	TPipelineContext extends PipelineContext,
	TStages extends
		readonly AnyStageDefinition<TPipelineContext>[] = readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[] = readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[],
> = {
	name: string;
	stages: TStages;
	edges: TEdges;
	groups?: readonly PipelineStageGroup<TPipelineContext>[];
};

export const createPipelineEdge = <
	TPipelineContext extends PipelineContext,
	TFromStage extends AnyStageDefinition<TPipelineContext>,
	TToStageInputObject,
	TToStage extends StageDefinition<
		TPipelineContext,
		TToStageInputObject,
		any,
		StageContext
	> = StageDefinition<TPipelineContext, TToStageInputObject, any, StageContext>,
	TSelectedOutput = StageOutputOf<TFromStage>,
>(
	edge: PipelineEdge<
		TPipelineContext,
		TFromStage,
		TToStageInputObject,
		TToStage,
		TSelectedOutput
	>,
) => edge;

export const createPipelineDefinition = <
	TPipelineContext extends PipelineContext,
	TStages extends readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[],
>(pipeline: {
	name: string;
	stages: TStages;
	edges: TEdges;
	groups?: readonly PipelineStageGroup<TPipelineContext>[];
}): PipelineDefinition<TPipelineContext, TStages, TEdges> => pipeline;

export const getPipelineStage = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
) => pipeline.stages.find((stage) => stage.id === stageName);

export const getDownstreamEdges = <
	TPipelineContext extends PipelineContext,
	TStages extends readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[],
>(
	pipeline: PipelineDefinition<TPipelineContext, TStages, TEdges>,
	stageName: PipelineStageName,
) => pipeline.edges.filter((edge) => edge.from.id === stageName);

export const getStageGroup = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
) =>
	pipeline.groups?.find(
		(group) =>
			group.leader.id === stageName ||
			group.members.some((stage) => stage.id === stageName),
	) || null;

export const getStageLeaderGroup = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
) => pipeline.groups?.find((group) => group.leader.id === stageName) || null;

export const isStageInGroup = <TPipelineContext extends PipelineContext>(
	group: PipelineStageGroup<TPipelineContext>,
	stageName: PipelineStageName,
) =>
	group.leader.id === stageName ||
	group.members.some((stage) => stage.id === stageName);

export const getStageRouteOutputSchemas = <
	TPipelineContext extends PipelineContext,
>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
): StageContext["routeOutputSchemas"] => {
	const edges = getDownstreamEdges(pipeline, stageName);
	const stageOutputSchema = getPipelineStage(pipeline, stageName)?.outputSchema;
	const routedEdges = edges.filter((edge) => edge.route);
	if (routedEdges.length === 0) {
		return undefined;
	}
	return routedEdges.map((edge) => {
		const schema = edge.outputSchema ?? stageOutputSchema;
		if (!schema) {
			throw new Error(
				`Routed stage ${stageName} route ${edge.route!.key} has no edge or stage output schema`,
			);
		}
		return {
			routeKey: edge.route!.key,
			...(edge.route?.description?.trim()
				? { description: edge.route.description.trim() }
				: {}),
			schema,
			default: edge.route?.default,
		};
	});
};

const stableJson = (value: unknown) => JSON.stringify(value);

export const validatePipelineRouteConfiguration = <
	TPipelineContext extends PipelineContext,
>(
	pipeline: PipelineDefinition<TPipelineContext>,
) => {
	for (const stage of pipeline.stages) {
		const edges = getDownstreamEdges(pipeline, stage.id);
		if (!edges.some((edge) => edge.route)) {
			continue;
		}
		if (edges.some((edge) => !edge.route)) {
			throw new Error(
				`Stage ${stage.name} mixes routed and non-routed downstream edges`,
			);
		}
		// Same route key may fan out to multiple targets (e.g. candidate → judge + surface).
		// Only require that exactly one default route key exists among downstream edges.
		const defaultKeys = new Set(
			edges
				.filter((edge) => edge.route?.default)
				.map((edge) => edge.route!.key),
		);
		if (defaultKeys.size !== 1) {
			throw new Error(
				`Stage ${stage.name} must define exactly one default route key`,
			);
		}
		const routeSchemas = new Map<string, string>();
		const routeDescriptions = new Map<string, string>();
		for (const edge of edges) {
			const route = edge.route!;
			const schema = edge.outputSchema ?? stage.outputSchema;
			if (schema) {
				const serialized = stableJson(schema);
				const previous = routeSchemas.get(route.key);
				if (previous && previous !== serialized) {
					throw new Error(
						`Stage ${stage.name} defines conflicting output schemas for route ${route.key}`,
					);
				}
				routeSchemas.set(route.key, serialized);
			}
			const description = route.description?.trim();
			if (description) {
				const previous = routeDescriptions.get(route.key);
				if (previous && previous !== description) {
					throw new Error(
						`Stage ${stage.name} defines conflicting descriptions for route ${route.key}`,
					);
				}
				routeDescriptions.set(route.key, description);
			}
		}
	}
};

export const selectDownstreamEdgesForRoute = <
	TPipelineContext extends PipelineContext,
>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
	routeKey?: string | null,
) => {
	const downstreamEdges = getDownstreamEdges(pipeline, stageName);
	const hasRoutedEdges = downstreamEdges.some((edge) => edge.route);
	if (!hasRoutedEdges) {
		return {
			edges: downstreamEdges,
			selectedRouteKey: null,
			fallback: false,
		};
	}

	const routedEdges = downstreamEdges.filter((edge) => edge.route);
	const matched = routedEdges.filter((edge) => edge.route?.key === routeKey);
	const fallbackEdge =
		routeKey == null
			? routedEdges.find((edge) => edge.route?.default)
			: undefined;
	const selectedEdges =
		matched.length > 0
			? matched
			: fallbackEdge
				? routedEdges.filter(
						(edge) => edge.route?.key === fallbackEdge.route?.key,
					)
				: [];
	if (selectedEdges.length === 0) {
		throw new Error(
			routeKey == null
				? `No default route configured for stage ${stageName}`
				: `Invalid route key ${routeKey} for stage ${stageName}`,
		);
	}

	return {
		edges: selectedEdges,
		selectedRouteKey: selectedEdges[0]?.route?.key ?? null,
		fallback: matched.length === 0,
	};
};
