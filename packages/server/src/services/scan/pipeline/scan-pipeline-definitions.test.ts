import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseScanPipelineDefinitionsFromYaml,
	loadScanPipelineDefinitions,
	normalizePipelineDefinitionSnapshot,
	resolveScanPipelineDefinitionsDir,
	resolveScanPipelineResourceRoot,
	validateStagePromptConfiguration,
} from "./scan-pipeline-definitions";

const SCAN_PIPELINE_DEFINITIONS = loadScanPipelineDefinitions();

test("normalizes a legacy pipeline snapshot to version 2", () => {
	const legacy = JSON.parse(JSON.stringify(SCAN_PIPELINE_DEFINITIONS)) as Record<
		string,
		unknown
	>;
	delete legacy.version;

	const normalized = normalizePipelineDefinitionSnapshot(legacy);

	assert.equal(normalized.version, 2);
	assert.deepEqual(normalized.pipelines.full.stageIds, [
		...SCAN_PIPELINE_DEFINITIONS.pipelines.full.stageIds,
	]);
});

test("materializes missing legacy stage and edge fields from the YAML baseline", () => {
	const legacy = JSON.parse(JSON.stringify(SCAN_PIPELINE_DEFINITIONS)) as {
		[key: string]: unknown;
		stages: Array<Record<string, unknown>>;
		pipelines: Record<string, { edges: Array<Record<string, unknown>> }>;
	};
	delete legacy.version;
	for (const stage of legacy.stages) {
		delete stage.effects;
		delete stage.report;
		delete stage.promptValues;
		delete stage.inputArtifacts;
		delete stage.outputArtifacts;
	}
	for (const pipeline of Object.values(legacy.pipelines)) {
		for (const edge of pipeline.edges) {
			delete edge.artifacts;
		}
	}

	const normalized = normalizePipelineDefinitionSnapshot(legacy);
	const scanTarget = normalized.stages.find(
		(stage) => stage.id === "scan-target",
	);
	assert.deepEqual(scanTarget?.effects, [{ type: "sync-candidates" }]);
	assert.ok(normalized.stages.every((stage) => stage.jobOutput === false));
	assert.ok(normalized.stages.every((stage) => stage.promptValues));
	assert.ok(
		normalized.pipelines.full.edges.every((edge) =>
			Array.isArray(edge.artifacts),
		),
	);
	assert.equal(normalized.version, 2);
});

test("runtime normalization does not merge current YAML into a saved snapshot", () => {
	const snapshot = JSON.parse(JSON.stringify(SCAN_PIPELINE_DEFINITIONS)) as {
		stages: Array<Record<string, unknown>>;
	};
	const repositoryProfile = snapshot.stages.find(
		(stage) => stage.id === "repository-profile",
	);
	assert.ok(repositoryProfile);
	delete repositoryProfile.promptValues;
	delete repositoryProfile.inputArtifacts;

	const normalized = normalizePipelineDefinitionSnapshot(snapshot, {
		useBaseline: false,
	});
	const savedStage = normalized.stages.find(
		(stage) => stage.id === "repository-profile",
	);
	assert.deepEqual(savedStage?.promptValues, {});
	assert.deepEqual(savedStage?.inputArtifacts, []);
});

test("normalizing a v2 snapshot is idempotent", () => {
	const snapshot = JSON.parse(JSON.stringify(SCAN_PIPELINE_DEFINITIONS));
	const once = normalizePipelineDefinitionSnapshot(snapshot);
	const twice = normalizePipelineDefinitionSnapshot(once);
	assert.deepEqual(twice, once);
});

test("rejects malformed pipeline snapshots instead of silently rebuilding them", () => {
	assert.throws(
		() =>
			normalizePipelineDefinitionSnapshot({
				version: 1,
				stages: {},
				pipelines: {},
			}),
	);
});

test("loaded full pipeline fans out identify-target by threat-model vulnerability classes", () => {
	for (const stage of SCAN_PIPELINE_DEFINITIONS.stages) {
		assert.ok(
			stage.runtimeConfig?.prompt?.trim() || stage.runtimeConfig?.promptFile,
			`${stage.id} must define a Stage Graph prompt or promptFile`,
		);
	}
	const edge = SCAN_PIPELINE_DEFINITIONS.pipelines.full.edges.find(
		(item) => item.name === "attack-surface-model-to-identify-target",
	);
	assert.ok(edge);
	assert.equal(edge.mode, "fanOut");
	assert.equal(
		edge.foreach,
		"$file($.threatModel).likelyVulnerabilityClasses[*]",
	);
	assert.equal(
		(edge.input as Record<string, unknown>).vulnerabilityClassFocus,
		"$item",
	);

	const scanEdge = SCAN_PIPELINE_DEFINITIONS.pipelines.full.edges.find(
		(item) => item.name === "identify-target-to-scan-target",
	);
	assert.ok(scanEdge);
	assert.equal(
		(scanEdge.input as Record<string, unknown>).vulnerabilityClassFocus,
		"$input.vulnerabilityClassFocus",
	);
});

test("loads research as an independent scan pipeline with local feedback routes", () => {
	const research = SCAN_PIPELINE_DEFINITIONS.pipelines.research;
	assert.equal(research.rootStageId, "research-scope");
	assert.equal(research.stageIds.length, 12);
	assert.ok(
		research.edges.some(
			(edge) => edge.route?.key === "finding-found" && edge.from === "track-review",
		),
	);
	assert.ok(
		research.edges.some(
			(edge) => edge.route?.key === "primitive-gap" && edge.to === "track-plan",
		),
	);
	assert.deepEqual(
		research.edges
		.filter((edge) => edge.to === "research-report")
		.map((edge) => `${edge.from}:${edge.route?.key}`),
		["exploit-review:confirmed"],
	);
	for (const edge of research.edges.filter((item) => item.route)) {
		const stage = SCAN_PIPELINE_DEFINITIONS.stages.find(
			(item) => item.id === edge.from,
		);
		assert.ok(
			edge.outputSchema || stage?.outputSchema,
			`${edge.name} must have an edge or stage output schema`,
		);
	}
	for (const stageId of research.stageIds) {
		const stage = SCAN_PIPELINE_DEFINITIONS.stages.find(
			(item) => item.id === stageId,
		);
		assert.ok(stage);
		assert.equal(stage.maxConcurrency, null);
	}
});

test("built-in stage prompt validation rejects a stage without either prompt source", () => {
	const stage = SCAN_PIPELINE_DEFINITIONS.stages[0]!;
	assert.throws(
		() =>
			validateStagePromptConfiguration([
				{
					...stage,
					runtimeConfig: {
						...stage.runtimeConfig!,
						prompt: null,
						promptFile: null,
					},
				},
			]),
		/Stage .* must configure runtimeConfig\.prompt or runtimeConfig\.promptFile/,
	);
});

test("parseScanPipelineDefinitionsFromYaml parses full and delta pipeline topology", () => {
	const definitions = parseScanPipelineDefinitionsFromYaml(`
schemas:
  RepositoryProfileOutput:
    type: object
    required: [modules]
    additionalProperties: false
    properties:
      modules:
        type: array
        items:
          $pathOf: "#/schemas/Module"
  Module:
    type: object
    required: [moduleId]
    additionalProperties: false
    properties:
      moduleId:
        type: string
stages:
  repository-profile:
    key: repositoryProfile
    name: Repository Profile
    role: scan
    group: full-scan
    concurrency: 1
    maxConcurrency: 8
    disableable: false
    description: Repository profiling.
    runtimeConfig:
      agentProfile: repository-agent
      persistent: false
      reuseContainer: true
      nullableOutput: false
      cwd: /workspace/repo
      skills: [repo-profiler]
      prompt: |
        Profile the repository.
    outputSchema:
      $ref: "#/schemas/RepositoryProfileOutput"
  scan-target:
    key: scanTarget
    name: Scan Target
    role: scan
    group: full-scan
    concurrency: 4
    maxConcurrency: 64
    disableable: true
    description: Target-level candidate discovery.
    inputSchema:
      type: object
      required: [modulePath]
      properties:
        modulePath:
          $pathOf: "#/schemas/Module"
  analyze-finding:
    key: analysis
    name: Analyze Finding
    role: analysis
    group: review
    concurrency: 2
    maxConcurrency: 16
    disableable: true
    description: Candidate analysis.
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages:
      - repository-profile
      - scan-target
      - analyze-finding
    edges:
      - name: repository-profile-to-scan-target
        from: repository-profile
        to: scan-target
        fork: false
        mode: fanOut
        foreach: "$.modules[*]"
        input:
          modulePath: "$item"
      - name: scan-target-to-analyze-finding
        from: scan-target
        to: analyze-finding
        fork: false
        mode: map
        outputSchema:
          $ref: "#/schemas/RepositoryProfileOutput"
        route:
          key: sample
          default: true
          description: Sample routed output schema
    groups:
      - id: full-scan
        name: Full Scan Pipeline
        leader: repository-profile
        members:
          - scan-target
  delta:
    name: delta-scan-programmatic
    root: scan-target
    stages:
      - scan-target
      - analyze-finding
    edges:
      - name: scan-target-to-analyze-finding
        from: scan-target
        to: analyze-finding
        fork: false
        route:
          key: verification
          default: true
    groups: []
  research:
    name: research-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  smoke:
    name: smoke-scan
    root: repository-profile
    stages: [repository-profile, analyze-finding]
    edges: []
    groups: []
`);

	assert.deepEqual(
		definitions.pipelineIds,
		{
			full: "full",
			delta: "delta",
			research: "research",
			smoke: "smoke",
		},
	);
	assert.deepEqual(definitions.stageIds, [
		"repository-profile",
		"scan-target",
		"analyze-finding",
	]);
	assert.equal(definitions.stageMetadata.repositoryProfile?.id, "repository-profile");
	assert.equal(definitions.stageMetadata.scanTarget?.id, "scan-target");
	assert.equal(definitions.stageMetadata.analysis?.name, "Analyze Finding");
	assert.equal(definitions.pipelines.full.rootStageId, "repository-profile");
	assert.deepEqual(definitions.pipelines.delta.stageIds, [
		"scan-target",
		"analyze-finding",
	]);
	assert.equal(definitions.pipelines.smoke?.name, "smoke-scan");
	assert.deepEqual(definitions.pipelines.delta.edges[0]?.route, {
		key: "verification",
		default: true,
		description: undefined,
	});
	assert.equal(definitions.stageSettings.scanTarget?.disableable, true);
	assert.equal(definitions.stageSettings.repositoryProfile?.disableable, false);
	assert.equal(definitions.stages[0]?.concurrency, 1);
	assert.equal(definitions.stageSettings.repositoryProfile?.concurrency, 1);
	assert.deepEqual(definitions.stages[0]?.runtimeConfig, {
		agentProfile: "repository-agent",
		persistent: false,
		reuseContainer: true,
		nullableOutput: false,
		cwd: "/workspace/repo",
		skills: ["repo-profiler"],
		prompt: "Profile the repository.\n",
		promptFile: null,
		inputArtifacts: null,
		outputSchema: null,
		prepareRepository: false,
		includePolicy: false,
	});
	assert.equal(definitions.schemas.Module?.type, "object");
	assert.deepEqual(definitions.stages[0]?.outputSchema, {
		$ref: "#/schemas/RepositoryProfileOutput",
	});
	assert.equal(definitions.stages[1]?.inputSchema?.type, "object");
	assert.equal(definitions.pipelines.full.edges[0]?.mode, "fanOut");
	assert.equal(definitions.pipelines.full.edges[0]?.foreach, "$.modules[*]");
	assert.deepEqual(definitions.pipelines.full.edges[0]?.input, {
		modulePath: "$item",
	});
	assert.deepEqual(definitions.pipelines.full.edges[1]?.outputSchema, {
		$ref: "#/schemas/RepositoryProfileOutput",
	});
	assert.deepEqual(definitions.pipelines.full.edges[1]?.route, {
		key: "sample",
		default: true,
		description: "Sample routed output schema",
	});
});

test("parseScanPipelineDefinitionsFromYaml rejects invalid topology", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  repository-profile:
    key: repositoryProfile
    name: Repository Profile
    role: scan
    group: full-scan
    concurrency: 1
    disableable: false
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges:
      - name: repository-profile-to-missing
        from: repository-profile
        to: missing-stage
    groups: []
  delta:
    name: delta-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  research:
    name: research-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
`),
		/unknown target stage missing-stage/,
	);
});

test("parseScanPipelineDefinitionsFromYaml requires concurrency", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  repository-profile:
    key: repositoryProfile
    name: Repository Profile
    role: scan
    group: full-scan
    defaultConcurrency: 1
    disableable: false
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  delta:
    name: delta-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  research:
    name: research-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
`),
		/concurrency/,
	);
});

test("parseScanPipelineDefinitionsFromYaml rejects unknown schema references", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  repository-profile:
    key: repositoryProfile
    name: Repository Profile
    role: scan
    group: full-scan
    concurrency: 1
    disableable: false
    outputSchema:
      $ref: "#/schemas/Missing"
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  delta:
    name: delta-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  research:
    name: research-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
`),
		/Unknown schema reference #\/schemas\/Missing/,
	);
});

test("parseScanPipelineDefinitionsFromYaml rejects invalid edge transform expressions", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
schemas:
  SourceOutput:
    type: object
    required: [modules]
    properties:
      modules:
        type: array
        items:
          type: string
  TargetInput:
    type: object
    required: [modulePath]
    properties:
      modulePath:
        type: string
stages:
  source:
    key: source
    name: Source
    role: scan
    group: scan
    concurrency: 1
    outputSchema:
      $ref: "#/schemas/SourceOutput"
  target:
    key: target
    name: Target
    role: scan
    group: scan
    concurrency: 1
    inputSchema:
      $ref: "#/schemas/TargetInput"
pipelines:
  full:
    name: full
    root: source
    stages: [source, target]
    edges:
      - name: source-to-target
        from: source
        to: target
        mode: fanOut
        foreach: "$.missing[*]"
        input:
          modulePath: "$item"
    groups: []
  delta:
    name: delta
    root: source
    stages: [source]
    edges: []
    groups: []
  research:
    name: research
    root: source
    stages: [source]
    edges: []
    groups: []
`),
		/unknown output field missing/,
	);

	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  source:
    key: source
    name: Source
    role: scan
    group: scan
    concurrency: 1
  target:
    key: target
    name: Target
    role: scan
    group: scan
    concurrency: 1
pipelines:
  full:
    name: full
    root: source
    stages: [source, target]
    edges:
      - name: source-to-target
        from: source
        to: target
        mode: map
        input:
          bad: "$bad.value"
    groups: []
  delta:
    name: delta
    root: source
    stages: [source]
    edges: []
    groups: []
  research:
    name: research
    root: source
    stages: [source]
    edges: []
    groups: []
`),
		/Unsupported transform expression/,
	);
});

test("resolveScanPipelineDefinitionsDir resolves the definitions directory", () => {
	const moduleUrl = new URL("./scan-pipeline-definitions.ts", import.meta.url).href;
	const definitionsDir = resolveScanPipelineDefinitionsDir(moduleUrl);

	assert.equal(definitionsDir.endsWith("/definitions"), true);
	assert.equal(definitionsDir.includes("/_next/static/media/"), false);
});

test("resolveScanPipelineDefinitionsDir does not fall back to bundled runtime assets", () => {
	assert.throws(
		() =>
				resolveScanPipelineDefinitionsDir(
					"file:///packages/server/dist/services/scan/pipeline/scan-pipeline-definitions.js",
					"/app",
					"/missing/scan-pipeline",
				),
		/definitions directory not found/,
	);
});

test("loads the current external resource and embeds prompt file content", async () => {
	const sourceRoot = resolveScanPipelineResourceRoot();
	const resourceRoot = await mkdtemp(join(tmpdir(), "vulseek-pipeline-"));
	try {
		await cp(join(sourceRoot, "pipeline"), join(resourceRoot, "pipeline"), {
			recursive: true,
		});
		await cp(join(sourceRoot, "prompts"), join(resourceRoot, "prompts"), {
			recursive: true,
		});
		await cp(join(sourceRoot, "stages"), join(resourceRoot, "stages"), {
			recursive: true,
		});

		const first = loadScanPipelineDefinitions(resourceRoot);
		const firstScanTarget = first.stages.find((stage) => stage.id === "scan-target");
		assert.equal(firstScanTarget?.runtimeConfig?.persistent, false);
		assert.match(firstScanTarget?.runtimeConfig?.prompt ?? "", /scan target/i);

		const stagePath = join(
			resourceRoot,
			"pipeline",
			"definitions",
			"stages",
			"scan-target.yaml",
		);
		const updatedStage = (await readFile(stagePath, "utf8")).replace(
			"persistent: false",
			"persistent: true",
		);
		await writeFile(stagePath, updatedStage);
		const second = loadScanPipelineDefinitions(resourceRoot);
		assert.equal(
			second.stages.find((stage) => stage.id === "scan-target")?.runtimeConfig
				?.persistent,
			true,
		);
		assert.equal(firstScanTarget?.runtimeConfig?.persistent, false);
	} finally {
		await rm(resourceRoot, { recursive: true, force: true });
	}
});
