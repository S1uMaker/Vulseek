import assert from "node:assert/strict";
import test from "node:test";
import { buildDefaultScanStageSettings } from "../../db/schema/shared";
import {
	buildCompleteScanRuntimeSettings,
	buildEffectiveDisabledStageSet,
	createRuntimeSettingsFunctions,
	createRuntimeSettingsPolicy,
	DELTA_SCAN_STAGE_IDS,
	FULL_SCAN_STAGE_IDS,
	getRuntimeStageConcurrency,
	getRuntimeStageSetting,
	isRuntimeStageDisableable,
	normalizeScanRuntimeSettings,
	RESEARCH_SCAN_STAGE_IDS,
} from "./runtime-settings";
import { loadScanPipelineDefinitions } from "./pipeline/scan-pipeline-definitions";

test("runtime settings operations load pipeline definitions once per call", () => {
	const definitions = loadScanPipelineDefinitions();
	let loadCount = 0;
	const runtimeSettings = createRuntimeSettingsFunctions(() => {
		loadCount += 1;
		return definitions;
	});

	runtimeSettings.normalize({
		stages: Object.fromEntries(
			RESEARCH_SCAN_STAGE_IDS.map((stageName) => [
				stageName,
				{ disabled: false, concurrency: 1 },
			]),
		),
	});
	assert.equal(loadCount, 1);

	loadCount = 0;
	runtimeSettings.buildEffectiveDisabledStageSet({
		settings: {},
		edges: definitions.pipelines.research.edges.map((edge) => ({
			source: edge.from,
		target: edge.to,
	})),
		stageNames: definitions.pipelines.research.stageIds,
		rootStageName: definitions.pipelines.research.rootStageId,
	});
	assert.equal(loadCount, 1);

	loadCount = 0;
	runtimeSettings.buildComplete({ pipelineId: "research" });
	assert.equal(loadCount, 1);
});

test("preloaded research stage policy builds without YAML parsing overhead", () => {
	const definitions = loadScanPipelineDefinitions();
	const policy = createRuntimeSettingsPolicy(definitions);
	const startedAt = performance.now();
	for (let index = 0; index < 100; index += 1) {
		policy.buildEffectiveDisabledStageSet({
			settings: {},
			edges: definitions.pipelines.research.edges.map((edge) => ({
			source: edge.from,
			target: edge.to,
		})),
			stageNames: definitions.pipelines.research.stageIds,
			rootStageName: definitions.pipelines.research.rootStageId,
		});
	}
	const averageElapsedMs = (performance.now() - startedAt) / 100;

	assert.ok(
		averageElapsedMs < 5,
		`expected preloaded policy under 5ms, got ${averageElapsedMs.toFixed(2)}ms`,
	);
});

test("runtime stage ids and defaults are derived from YAML definitions", () => {
	assert.deepEqual(FULL_SCAN_STAGE_IDS, [
		"repository-profile",
		"attack-surface-model",
		"identify-target",
		"scan-target",
		"analyze-finding",
		"critique-finding",
		"verify-finding",
		"triage-finding",
	]);
	assert.deepEqual(DELTA_SCAN_STAGE_IDS, [
		"delta-scope",
		"scan-target",
		"analyze-finding",
		"critique-finding",
		"verify-finding",
		"triage-finding",
	]);
	assert.equal(getRuntimeStageConcurrency("scan-target"), 4);
	assert.equal(getRuntimeStageConcurrency("triage-finding"), 1);
	assert.equal(getRuntimeStageConcurrency("unknown-stage"), 1);
});

test("default scan stage settings include every research stage", () => {
	const settings = buildDefaultScanStageSettings("research-profile");
	const expectedConcurrency: Record<string, number> = {
		"research-scope": 1,
		"surface-map": 1,
		"track-plan": 1,
		"vulnerability-discovery": 4,
		"track-review": 1,
		"finding-validation": 4,
		"finding-review": 4,
		"chain-synthesis": 1,
		"chain-review": 4,
		"exploit-validation": 4,
		"exploit-review": 4,
		"research-report": 1,
	};

	for (const stageName of RESEARCH_SCAN_STAGE_IDS) {
		assert.deepEqual(settings[stageName], {
			agentProfileId: "research-profile",
			concurrency: expectedConcurrency[stageName],
		});
	}
});

test("normalizeScanRuntimeSettings honors disableable=false from YAML", () => {
	const normalized = normalizeScanRuntimeSettings({
		stages: {
			"repository-profile": { disabled: true, concurrency: 3 },
			"delta-scope": { disabled: true, concurrency: 2 },
			"scan-target": { disabled: true, concurrency: 7 },
			"unknown-stage": { disabled: true, concurrency: 99 },
		},
	});

	assert.equal(isRuntimeStageDisableable("repository-profile"), false);
	assert.equal(isRuntimeStageDisableable("delta-scope"), false);
	assert.equal(isRuntimeStageDisableable("scan-target"), true);
	assert.deepEqual(normalized.stages, {
		"repository-profile": {
			disabled: false,
			concurrency: 3,
			agentProfileId: null,
		},
		"delta-scope": {
			disabled: false,
			concurrency: 2,
			agentProfileId: null,
		},
		"scan-target": {
			disabled: true,
			concurrency: 7,
			agentProfileId: null,
		},
	});
});

test("runtime stage lookup preserves custom pipeline stages", () => {
	assert.deepEqual(
		getRuntimeStageSetting(
			{
				stages: {
					orchestrator: {
						disabled: false,
						concurrency: 1,
						agentProfileId: "luna-profile",
					},
				},
			},
			"orchestrator",
		),
		{
			disabled: false,
			concurrency: 1,
			agentProfileId: "luna-profile",
		},
	);
});

test("buildEffectiveDisabledStageSet uses YAML root and disableable settings", () => {
	const disabled = buildEffectiveDisabledStageSet({
		settings: {
			stages: {
				"repository-profile": { disabled: true },
				"scan-target": { disabled: true },
			},
		},
		edges: [
			{ source: "repository-profile", target: "scan-target" },
			{ source: "scan-target", target: "analyze-finding" },
		],
		stageNames: ["repository-profile", "scan-target", "analyze-finding"],
		rootStageName: "repository-profile",
	});

	assert.deepEqual([...disabled].sort(), [
		"analyze-finding",
		"scan-target",
	]);
});

test("buildCompleteScanRuntimeSettings snapshots target settings and YAML defaults", () => {
	const settings = buildCompleteScanRuntimeSettings({
		pipelineId: "full",
		targetStageSettings: {
			"scan-target": {
				agentProfileId: "target-scan-profile",
				concurrency: 9,
			},
			"analyze-finding": {
				agentProfileId: "target-analysis-profile",
			},
		},
		runtimeOverrides: {
			stages: {
				"scan-target": {
					disabled: true,
					agentProfileId: null,
					concurrency: 11,
				},
				"verify-finding": {
					agentProfileId: "override-verify-profile",
				},
				"unknown-stage": {
					agentProfileId: "ignored",
					concurrency: 99,
				},
			},
		},
	});

	assert.deepEqual(Object.keys(settings.stages ?? {}), FULL_SCAN_STAGE_IDS);
	assert.deepEqual(settings.stages?.["repository-profile"], {
		disabled: false,
		agentProfileId: null,
		concurrency: 1,
	});
	assert.deepEqual(settings.stages?.["scan-target"], {
		disabled: true,
		agentProfileId: "target-scan-profile",
		concurrency: 11,
	});
	assert.deepEqual(settings.stages?.["analyze-finding"], {
		disabled: false,
		agentProfileId: "target-analysis-profile",
		concurrency: 2,
	});
	assert.deepEqual(settings.stages?.["verify-finding"], {
		disabled: false,
		agentProfileId: "override-verify-profile",
		concurrency: 1,
	});
});

test("buildCompleteScanRuntimeSettings uses only the selected pipeline stages", () => {
	const settings = buildCompleteScanRuntimeSettings({
		pipelineId: "delta",
		targetStageSettings: {
			"repository-profile": {
				agentProfileId: "repo-profile",
				concurrency: 7,
			},
			"delta-scope": {
				agentProfileId: "delta-profile",
				concurrency: 3,
			},
		},
		runtimeOverrides: {
			stages: {
				"delta-scope": {
					disabled: true,
				},
			},
		},
	});

	assert.deepEqual(Object.keys(settings.stages ?? {}), DELTA_SCAN_STAGE_IDS);
	assert.deepEqual(settings.stages?.["delta-scope"], {
		disabled: false,
		agentProfileId: "delta-profile",
		concurrency: 3,
	});
	assert.equal(settings.stages?.["repository-profile"], undefined);
});
