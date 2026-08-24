import { describe, expect, it } from "vitest";
import {
	compilePipelineDocumentV3,
	type CompiledPipelineDefinition,
	type PipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { resolveCompiledDefinition } from "@vulseek/server/services/scan/api/pipeline-runs";

const baseDocument = (): PipelineDocumentV3 => ({
	version: 3,
	name: "test",
	supportedTargets: ["project", "evaluation"],
	root: "start",
	limits: { maxTasks: 10_000, maxDurationSeconds: 86_400 },
	schemas: {},
	stages: {
		start: {
			name: "Start",
			role: "scan",
			group: "g",
			concurrency: 1,
			disableable: true,
			inputArtifacts: [],
			outputArtifacts: [],
			jobOutput: false,
			effects: [],
			containerNameParts: [],
			allowAgentExit: false,
			promptValues: {},
			runtime: {
				kind: "agent",
				prompt: "Do it.",
				prepareRepository: "target",
				includePolicy: false,
				plugins: [],
			},
		},
		finish: {
			name: "Finish",
			role: "verification",
			group: "g",
			concurrency: 1,
			disableable: true,
			inputArtifacts: [],
			outputArtifacts: [],
			jobOutput: true,
			effects: [],
			containerNameParts: [],
			allowAgentExit: false,
			promptValues: {},
			runtime: {
				kind: "agent",
				prompt: "Verify.",
				prepareRepository: "none",
				includePolicy: false,
				plugins: [],
			},
		},
	},
	edges: [
		{
			id: "start-to-finish",
			name: "start-to-finish",
			from: "start",
			to: "finish",
			fork: false,
			mode: "map",
			artifacts: [],
		},
	],
	groups: [],
});

describe("compilePipelineDocumentV3", () => {
	it("flattens stages into an ordered array with ids", () => {
		const compiled = compilePipelineDocumentV3(baseDocument(), {
			pipelineId: "my-pipeline",
		});
		expect(compiled.pipelineId).toBe("my-pipeline");
		expect(compiled.root).toBe("start");
		expect(compiled.stages.map((stage) => stage.id)).toEqual([
			"start",
			"finish",
		]);
		expect(compiled.edges[0]?.id).toBe("start-to-finish");
		expect(compiled.stages.find((stage) => stage.id === "start")?.jobOutput).toBe(
			false,
		);
		expect(compiled.stages.find((stage) => stage.id === "finish")?.jobOutput).toBe(
			true,
		);
	});

	it("carries the root stage prepareRepository mode", () => {
		const compiled = compilePipelineDocumentV3(baseDocument());
		expect(compiled.prepareRepository).toBe("target");
	});

	it("keeps limits in the snapshot", () => {
		const compiled = compilePipelineDocumentV3(baseDocument());
		expect(compiled.limits).toEqual({
			maxTasks: 10_000,
			maxDurationSeconds: 86_400,
		});
	});
});

describe("compiled presentation.jobTabs", () => {
	it("infers a candidates tab from sync-candidates", () => {
		const document = baseDocument();
		document.stages.start!.effects = [{ type: "sync-candidates" }];
		expect(
			compilePipelineDocumentV3(document).presentation.jobTabs.map(
				(tab) => tab.id,
			),
		).toEqual(["candidates"]);
	});

	it("infers research and tob-goal tabs from effects", () => {
		const research = baseDocument();
		research.stages.start!.effects = [
			{ type: "research-registry", operation: "persist-scope" },
		];
		expect(
			compilePipelineDocumentV3(research).presentation.jobTabs.map(
				(tab) => tab.id,
			),
		).toEqual(["findings", "tracks", "primitives", "chains"]);

		const goal = baseDocument();
		goal.stages.start!.effects = [
			{ type: "tob-goal-registry", operation: "persist-candidate" },
		];
		expect(
			compilePipelineDocumentV3(goal).presentation.jobTabs.map((tab) => tab.id),
		).toEqual(["goal-candidates", "goal-findings"]);
	});
});

describe("resolveCompiledDefinition", () => {
	it("passes a compiled snapshot through unchanged", () => {
		const compiled: CompiledPipelineDefinition =
			compilePipelineDocumentV3(baseDocument());
		expect(resolveCompiledDefinition(compiled, "")).toBe(compiled);
		expect(compiled).not.toHaveProperty("capabilities");
	});

	it("strips legacy compiled capabilities from stored snapshots", () => {
		const compiled = compilePipelineDocumentV3(baseDocument());
		const resolved = resolveCompiledDefinition(
			{ ...compiled, capabilities: { candidates: true, research: false, tobGoal: false } },
			"",
		);
		expect(resolved).not.toHaveProperty("capabilities");
	});

	it("compiles a stored canonical document on the fly (Phase 2 seed rows)", () => {
		const document = baseDocument();
		const resolved = resolveCompiledDefinition(
			document as unknown,
			"",
		);
		expect(resolved.stages.map((stage) => stage.id)).toEqual([
			"start",
			"finish",
		]);
	});
});
