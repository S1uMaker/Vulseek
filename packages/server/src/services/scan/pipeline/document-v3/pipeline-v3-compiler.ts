import type {
	PipelineDocumentV3,
	PipelineStageV3,
	PipelineEdgeV3,
} from "./pipeline-document-v3";
import {
	inferJobTabsFromStages,
	type PipelinePresentation,
} from "./pipeline-job-tabs";

/**
 * Compiles a validated PipelineDocumentV3 into the immutable
 * `CompiledPipelineDefinition` frozen onto scan jobs and evaluations.
 *
 * The compiled shape is the *runtime* contract: the runner consumes it (via
 * `buildPipelineFromCompiled`) instead of re-parsing YAML. Job result tabs
 * come from `presentation.jobTabs`.
 */

export type CompiledStageV3 = PipelineStageV3 & {
	id: string;
};

export type CompiledEdgeV3 = PipelineEdgeV3;

export type CompiledPipelineDefinition = {
	version: 3;
	pipelineId: string;
	name: string;
	description?: string;
	supportedTargets: PipelineDocumentV3["supportedTargets"];
	root: string;
	limits: PipelineDocumentV3["limits"];
	prepareRepository: "none" | "target" | "diff";
	presentation: PipelinePresentation;
	schemas: PipelineDocumentV3["schemas"];
	stages: CompiledStageV3[];
	edges: CompiledEdgeV3[];
	groups: PipelineDocumentV3["groups"];
	/**
	 * Stage overrides applied at run creation (enabled/concurrency/profile).
	 * Kept in the snapshot so a rerun of a finished job uses the same shape.
	 */
	stageOverrides?: Record<
		string,
		{ enabled?: boolean; concurrency?: number; agentProfileId?: string | null }
	>;
};

const resolvePrepareRepository = (
	document: PipelineDocumentV3,
): CompiledPipelineDefinition["prepareRepository"] =>
	document.stages[document.root]?.runtime.prepareRepository ?? "none";

export const compilePipelineDocumentV3 = (
	document: PipelineDocumentV3,
	options: { pipelineId?: string } = {},
): CompiledPipelineDefinition => ({
	version: 3,
	pipelineId: options.pipelineId ?? document.name,
	name: document.name,
	...(document.description ? { description: document.description } : {}),
	supportedTargets: document.supportedTargets,
	root: document.root,
	limits: document.limits,
	prepareRepository: resolvePrepareRepository(document),
	presentation: {
		jobTabs: document.presentation
			? document.presentation.jobTabs
			: inferJobTabsFromStages(
					Object.entries(document.stages).map(([id, stage]) => ({
						...stage,
						id,
					})),
				),
	},
	schemas: document.schemas,
	stages: Object.entries(document.stages).map(([id, stage]) => ({
		...stage,
		id,
	})),
	edges: document.edges,
	groups: document.groups ?? [],
});
