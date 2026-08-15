import {
	loadScanJobPipelineCompiledSnapshotRepo,
	loadScanJobPipelineDefinitionSnapshotRepo,
} from "../persistence/scan-job.repo";
import { findCompiledStageRuntimeSnapshot } from "../stages/compiled-stage-concurrency";
import {
	createStageRuntimeConfigWithDeps,
	type StageRuntimeConfigDeps,
} from "./scan-pipeline-definitions";

export type StageRuntimeConfig = ReturnType<
	typeof createStageRuntimeConfigWithDeps
>;

export const createStageRuntimeConfig = (
	scanJobId: string,
	stageName: string,
	deps?: StageRuntimeConfigDeps,
) => {
	const legacyConfig = createStageRuntimeConfigWithDeps({
		scanJobId,
		stageName,
		loadScanJobPipelineDefinitionSnapshot:
			deps?.loadScanJobPipelineDefinitionSnapshot ??
			loadScanJobPipelineDefinitionSnapshotRepo,
	});
	if (deps) return legacyConfig;

	const loadCompiledStage = async () => {
		const snapshot = await loadScanJobPipelineCompiledSnapshotRepo(scanJobId);
		const stage = findCompiledStageRuntimeSnapshot(snapshot, stageName);
		if (stage === null) {
			throw new Error(
				`Stage ${stageName} not found in compiled pipeline snapshot`,
			);
		}
		return stage;
	};
	const fromCompiledOrLegacy = async <T>(
		readCompiled: (
			stage: NonNullable<Awaited<ReturnType<typeof loadCompiledStage>>>,
		) => T,
		readLegacy: () => Promise<T>,
	) => {
		const stage = await loadCompiledStage();
		return stage ? readCompiled(stage) : await readLegacy();
	};

	return {
		getConcurrency: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.concurrency,
				legacyConfig.getConcurrency,
			),
		getAgentProfile: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.agentProfileId,
				legacyConfig.getAgentProfile,
			),
		getGoalSession: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.goalSession,
				legacyConfig.getGoalSession,
			),
		getPersistent: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.persistent,
				legacyConfig.getPersistent,
			),
		getReuseContainer: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.reuseContainer,
				legacyConfig.getReuseContainer,
			),
		getNullableOutput: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.nullableOutput,
				legacyConfig.getNullableOutput,
			),
		getCwd: async () =>
			await fromCompiledOrLegacy((stage) => stage.cwd, legacyConfig.getCwd),
		getSkills: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.skills,
				legacyConfig.getSkills,
			),
		getPrompt: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.prompt,
				legacyConfig.getPrompt,
			),
		getInputArtifacts: async () =>
			await fromCompiledOrLegacy(() => null, legacyConfig.getInputArtifacts),
		getOutputSchema: async () =>
			await fromCompiledOrLegacy(
				(stage) => stage.outputSchema,
				legacyConfig.getOutputSchema,
			),
	};
};
