import assert from "node:assert/strict";
import test from "node:test";
import {
	createStageRuntimeConfigWithDeps,
	type ScanPipelineDefinitions,
} from "./scan-pipeline-definitions";

const makeDefinitions = (concurrency: number): ScanPipelineDefinitions => ({
	version: 2,
	pipelineIds: { full: "full", delta: "delta", research: "research" },
	schemas: {},
	stageIds: ["scan-target"],
	stages: [
		{
			id: "scan-target",
			key: "scanTarget",
			name: "Scan Target",
			role: "scan",
			group: "scan",
			concurrency,
			maxConcurrency: null,
			disableable: true,
			goal: false,
			description: null,
			inputSchema: null,
			outputSchema: null,
		 runtimeConfig: {
				agentProfile: "agent-a",
				persistent: true,
				reuseContainer: false,
				nullableOutput: true,
				cwd: "/workspace/repo",
				skills: ["scan-skill"],
				mcp: null,
				prompt: "Scan target now",
				promptFile: null,
				inputArtifacts: null,
				outputSchema: null,
		 },
		inputArtifacts: [],
		outputArtifacts: [],
		jobOutput: false,
		effects: [],
		report: null,
		taskName: null,
		promptValues: {},
		containerNameParts: [],
		allowAgentExit: false,
	},
	],
	stageMetadata: {
		scanTarget: { id: "scan-target", name: "Scan Target" },
	},
	stageMetadataById: {
		"scan-target": { key: "scanTarget", id: "scan-target", name: "Scan Target" },
	},
	stageSettings: {
		scanTarget: {
			stageName: "scan-target",
			label: "Scan Target",
			role: "scan",
			group: "scan",
			concurrency,
			maxConcurrency: 128,
			disableable: true,
			description: "Scan Target",
			inputSchema: null,
			outputSchema: null,
			runtimeConfig: null,
		},
	},
	pipelines: {
		full: {
			id: "full",
			name: "full",
			rootStageId: "scan-target",
			stageIds: ["scan-target"],
			edges: [],
			groups: [],
		},
		delta: {
			id: "delta",
			name: "delta",
			rootStageId: "scan-target",
			stageIds: ["scan-target"],
			edges: [],
			groups: [],
		},
		research: {
			id: "research",
			name: "research",
			rootStageId: "scan-target",
			stageIds: ["scan-target"],
			edges: [],
			groups: [],
		},
	},
});

test("stage runtime config getters read the latest job snapshot", async () => {
	let definitions = makeDefinitions(2);
	const runtimeConfig = createStageRuntimeConfigWithDeps({
		scanJobId: "scan-job-1",
		stageName: "scan-target",
		loadScanJobPipelineDefinitionSnapshot: async () => definitions,
	});

	assert.equal(await runtimeConfig.getConcurrency(), 2);
	assert.equal(await runtimeConfig.getAgentProfile(), "agent-a");
	assert.equal(await runtimeConfig.getPrompt(), "Scan target now");
	assert.deepEqual(await runtimeConfig.getSkills(), ["scan-skill"]);
	assert.deepEqual(await runtimeConfig.getMcp(), []);

	definitions = makeDefinitions(7);
	definitions.stages[0] = {
		...definitions.stages[0]!,
		runtimeConfig: {
			...definitions.stages[0]!.runtimeConfig!,
			agentProfile: "agent-b",
			prompt: "Scan target after update",
			skills: ["updated-skill"],
		},
	};

	assert.equal(await runtimeConfig.getConcurrency(), 7);
	assert.equal(await runtimeConfig.getAgentProfile(), "agent-b");
	assert.equal(await runtimeConfig.getPrompt(), "Scan target after update");
	assert.deepEqual(await runtimeConfig.getSkills(), ["updated-skill"]);
});

test("Stage Graph prompt takes precedence over promptFile and ignores blank prompt", async () => {
	let definitions = makeDefinitions(1);
	definitions.stages[0] = {
		...definitions.stages[0]!,
		runtimeConfig: {
			...definitions.stages[0]!.runtimeConfig!,
			prompt: "  Graph prompt wins  ",
			promptFile: "repository-profile.prompt.md",
		},
	};
	const runtimeConfig = createStageRuntimeConfigWithDeps({
		scanJobId: "scan-job-1",
		stageName: "scan-target",
		loadScanJobPipelineDefinitionSnapshot: async () => definitions,
	});

	assert.equal(await runtimeConfig.getPrompt(), "  Graph prompt wins  ");

	definitions.stages[0] = {
		...definitions.stages[0]!,
		runtimeConfig: {
			...definitions.stages[0]!.runtimeConfig!,
			prompt: "   ",
			promptFile: null,
		},
	};
	assert.equal(await runtimeConfig.getPrompt(), null);
});

test("Stage Graph promptFile is loaded when no direct prompt is configured", async () => {
	const definitions = makeDefinitions(1);
	definitions.stages[0] = {
		...definitions.stages[0]!,
		runtimeConfig: {
			...definitions.stages[0]!.runtimeConfig!,
			prompt: null,
			promptFile: "repository-profile.prompt.md",
		},
	};
	const runtimeConfig = createStageRuntimeConfigWithDeps({
		scanJobId: "scan-job-1",
		stageName: "scan-target",
		loadScanJobPipelineDefinitionSnapshot: async () => definitions,
	});

	const prompt = await runtimeConfig.getPrompt();
	assert.ok(prompt);
	assert.match(prompt, /repository-profile skill/);
});

test("Stage Graph prompt is absent when neither source is configured", async () => {
	const definitions = makeDefinitions(1);
	definitions.stages[0] = {
		...definitions.stages[0]!,
		runtimeConfig: {
			...definitions.stages[0]!.runtimeConfig!,
			prompt: null,
			promptFile: null,
		},
	};
	const runtimeConfig = createStageRuntimeConfigWithDeps({
		scanJobId: "scan-job-1",
		stageName: "scan-target",
		loadScanJobPipelineDefinitionSnapshot: async () => definitions,
	});

	assert.equal(await runtimeConfig.getPrompt(), null);
});
