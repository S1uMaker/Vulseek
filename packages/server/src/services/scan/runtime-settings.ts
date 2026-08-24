import {
	 type ScanRuntimeSettings,
	type ScanStageSettings,
	ScanRuntimeSettingsSchema,
} from "../../db/schema/shared";
import { loadScanPipelineDefinitions } from "./pipeline/scan-pipeline-definitions";

export const FULL_SCAN_STAGE_IDS = [
	"repository-profile",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"triage-finding",
];

export const DELTA_SCAN_STAGE_IDS = [
	"delta-scope",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"triage-finding",
];

export const RESEARCH_SCAN_STAGE_IDS = [
	"research-scope",
	"surface-map",
	"track-plan",
	"vulnerability-discovery",
	"track-review",
	"finding-validation",
	"finding-review",
	"chain-synthesis",
	"chain-review",
	"exploit-validation",
	"exploit-review",
	"research-report",
];

export const TOB_GOAL_SCAN_STAGE_IDS = [
	"goal-craft",
	"goal-surface",
	"goal-hunt",
	"goal-judge",
	"goal-dedup",
];

const RUNTIME_STAGE_IDS = [
	...FULL_SCAN_STAGE_IDS,
	...DELTA_SCAN_STAGE_IDS,
	...RESEARCH_SCAN_STAGE_IDS,
	...TOB_GOAL_SCAN_STAGE_IDS,
];

export const FULL_SCAN_STAGE_ID_SET = new Set<string>(FULL_SCAN_STAGE_IDS);
export const RUNTIME_STAGE_ID_SET = new Set<string>(RUNTIME_STAGE_IDS);

export type ScanRuntimeStageState = {
	disabled: boolean;
	effectiveDisabled: boolean;
	concurrency: number | null;
	agentProfileId: string | null;
};

type RuntimeDefinitions = ReturnType<typeof loadScanPipelineDefinitions>;

type EffectiveDisabledStageInput = {
	settings: unknown;
	edges: Array<{ source: string; target: string }>;
	stageNames?: string[];
	rootStageName?: string;
};

const createRuntimeStageMetadata = (definitions: RuntimeDefinitions) => {
	const stageById = new Map(definitions.stages.map((stage) => [stage.id, stage]));
	const runtimeStageIds = new Set([
		...definitions.pipelines.full.stageIds,
		...definitions.pipelines.delta.stageIds,
		...definitions.pipelines.research.stageIds,
		...(definitions.pipelines["tob-goal"]?.stageIds ?? []),
	]);
	const allStageIds = [
		...definitions.pipelines.full.stageIds,
		...definitions.pipelines.delta.stageIds,
		...definitions.pipelines.research.stageIds,
		...(definitions.pipelines["tob-goal"]?.stageIds ?? []),
	];

	return { allStageIds, runtimeStageIds, stageById };
};

export const createRuntimeSettingsPolicy = (definitions: RuntimeDefinitions) => {
	const { allStageIds, runtimeStageIds, stageById } =
		createRuntimeStageMetadata(definitions);

	const isStageDisableable = (stageName: string) =>
		stageById.get(stageName)?.disableable ?? true;

	const getStageConcurrency = (stageName: string) =>
		stageById.get(stageName)?.concurrency ?? 1;

	const normalize = (
		value: unknown,
		additionalStageIds: ReadonlySet<string> = new Set(),
	): ScanRuntimeSettings => {
		const parsed = ScanRuntimeSettingsSchema.catch({}).parse(value);
		const stages: NonNullable<ScanRuntimeSettings["stages"]> = {};
		for (const [stageName, setting] of Object.entries(parsed.stages ?? {})) {
			if (!runtimeStageIds.has(stageName) && !additionalStageIds.has(stageName)) continue;
			stages[stageName] = {
				disabled: isStageDisableable(stageName)
					? setting.disabled === true
					: false,
				concurrency:
					typeof setting.concurrency === "number" ? setting.concurrency : null,
				agentProfileId: setting.agentProfileId || null,
			};
		}
		return {
			stages,
			...(parsed.threatDirection
				? { threatDirection: parsed.threatDirection }
				: {}),
		};
	};

	const buildComplete = (input: {
		pipelineId: string;
		stageIds?: string[];
		targetStageSettings?: ScanStageSettings | null;
		runtimeOverrides?: ScanRuntimeSettings | null;
	}): ScanRuntimeSettings => {
		const stageIds = input.stageIds ?? definitions.pipelines[input.pipelineId]?.stageIds ?? [];
		const overrides = normalize(input.runtimeOverrides ?? {});
		const stages: NonNullable<ScanRuntimeSettings["stages"]> = {};

		for (const stageName of stageIds) {
			const stageDefinition = stageById.get(stageName);
			const targetSetting = input.targetStageSettings?.[stageName] ?? {};
			const override = overrides.stages?.[stageName] ?? {};
			stages[stageName] = {
				disabled: isStageDisableable(stageName)
					? override.disabled === true
					: false,
				agentProfileId:
					override.agentProfileId ||
					targetSetting.agentProfileId ||
					stageDefinition?.runtimeConfig?.agentProfile ||
					null,
				concurrency:
					override.concurrency ||
					targetSetting.concurrency ||
					stageDefinition?.concurrency ||
					1,
			};
		}

		return normalize({
			stages,
			...(overrides.threatDirection
				? { threatDirection: overrides.threatDirection }
				: {}),
		});
	};

	const buildEffectiveDisabled = (input: EffectiveDisabledStageInput) => {
		const settings = normalize(input.settings);
		const stageNames = input.stageNames ?? allStageIds;
		const rootStageName = input.rootStageName ?? stageNames[0] ?? "";
		const explicitDisabled = new Set(
			Object.entries(settings.stages ?? {})
				.filter(([, setting]) => setting.disabled === true)
				.map(([stageName]) => stageName),
		);
		for (const stageName of Array.from(explicitDisabled)) {
			if (!isStageDisableable(stageName)) explicitDisabled.delete(stageName);
		}

		const bySource = new Map<string, string[]>();
		for (const edge of input.edges) {
			if (explicitDisabled.has(edge.source) || explicitDisabled.has(edge.target)) {
				continue;
			}
			bySource.set(edge.source, [
				...(bySource.get(edge.source) ?? []),
				edge.target,
			]);
		}

		const reachable = new Set<string>();
		const queue: string[] = [rootStageName];
		while (queue.length > 0) {
			const stageName = queue.shift();
			if (!stageName || reachable.has(stageName) || explicitDisabled.has(stageName)) {
				continue;
			}
			reachable.add(stageName);
			for (const next of bySource.get(stageName) ?? []) {
				if (!reachable.has(next)) queue.push(next);
			}
		}

		return new Set(
			stageNames.filter(
				(stageName) => explicitDisabled.has(stageName) || !reachable.has(stageName),
			),
		);
	};

	return {
		normalize,
		buildComplete,
		buildEffectiveDisabled: buildEffectiveDisabled,
		buildEffectiveDisabledStageSet: buildEffectiveDisabled,
		getStageConcurrency,
		isStageDisableable,
		getStageSetting: (settings: unknown, stageName: string) =>
			normalize(settings, new Set([stageName])).stages?.[stageName] ?? {},
	};
};

export const createRuntimeSettingsFunctions = (
	loadDefinitions: () => RuntimeDefinitions = loadScanPipelineDefinitions,
) => ({
	normalize: (
		value: unknown,
		additionalStageIds?: ReadonlySet<string>,
	) => createRuntimeSettingsPolicy(loadDefinitions()).normalize(value, additionalStageIds),
	buildComplete: (input: {
		pipelineId: string;
		stageIds?: string[];
		targetStageSettings?: ScanStageSettings | null;
		runtimeOverrides?: ScanRuntimeSettings | null;
	}) => createRuntimeSettingsPolicy(loadDefinitions()).buildComplete(input),
	buildEffectiveDisabledStageSet: (input: EffectiveDisabledStageInput) =>
		createRuntimeSettingsPolicy(loadDefinitions()).buildEffectiveDisabled(input),
	getRuntimeStageConcurrency: (stageName: string) =>
		createRuntimeSettingsPolicy(loadDefinitions()).getStageConcurrency(stageName),
	isRuntimeStageDisableable: (stageName: string) =>
		createRuntimeSettingsPolicy(loadDefinitions()).isStageDisableable(stageName),
	getRuntimeStageSetting: (settings: unknown, stageName: string) =>
		createRuntimeSettingsPolicy(loadDefinitions()).getStageSetting(settings, stageName),
});

const runtimeSettingsFunctions = createRuntimeSettingsFunctions();

export const normalizeScanRuntimeSettings = runtimeSettingsFunctions.normalize;
export const normalizeScanRuntimeSettingsForStages = (
	value: unknown,
	stageIds: readonly string[],
) => normalizeScanRuntimeSettings(value, new Set(stageIds));
export const buildCompleteScanRuntimeSettings = runtimeSettingsFunctions.buildComplete;
export const buildEffectiveDisabledStageSet =
	runtimeSettingsFunctions.buildEffectiveDisabledStageSet;
export const getRuntimeStageConcurrency =
	runtimeSettingsFunctions.getRuntimeStageConcurrency;
export const isRuntimeStageDisableable =
	runtimeSettingsFunctions.isRuntimeStageDisableable;
export const getRuntimeStageSetting = runtimeSettingsFunctions.getRuntimeStageSetting;
