import { describe, expect, it } from "vitest";
import {
	assertStableRoundTrip,
	collectPipelineDiagnostics,
	hasBlockingDiagnostics,
	parsePipelineDocumentV3,
	serializePipelineDocumentV3,
	type PipelineDocumentV3,
	type PipelineEdgeV3,
	type PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { computePipelineContentHash } from "@vulseek/server/services/scan/pipeline/document-v3/pipeline-document-v3-hash";
import { convertV2DefinitionsToV3 } from "@vulseek/server/services/scan/pipeline/document-v3/pipeline-v2-converter";
import { loadBuiltinPipelineTemplates } from "@vulseek/server/services/scan/pipeline/document-v3/builtin-pipelines";

const stage = (overrides: Partial<PipelineStageV3> = {}): PipelineStageV3 => ({
	name: "Start",
	role: "scan",
	group: "g",
	concurrency: 1,
	disableable: true,
	goal: false,
	inputArtifacts: [],
	outputArtifacts: [],
	jobOutput: false,
	effects: [],
	containerNameParts: [],
	allowAgentExit: false,
	promptValues: {},
	runtime: {
		kind: "agent",
		prompt: "Do the thing.",
		prepareRepository: "none",
		includePolicy: false,
		plugins: [],
	},
	...overrides,
});

const edge = (overrides: Partial<PipelineEdgeV3> = {}): PipelineEdgeV3 => ({
	id: "start-to-finish",
	name: "start-to-finish",
	from: "start",
	to: "finish",
	fork: false,
	mode: "map",
	artifacts: [],
	...overrides,
});

const minimalDocument: PipelineDocumentV3 = {
	version: 3,
	name: "test-pipeline",
	supportedTargets: ["project"],
	root: "start",
	limits: { maxTasks: 100, maxDurationSeconds: 3600 },
	schemas: {},
	stages: {
		start: stage(),
		finish: stage({
			name: "Finish",
			role: "verification",
			runtime: {
				kind: "agent",
				prompt: "Verify.",
				prepareRepository: "none",
				includePolicy: false,
				plugins: [],
			},
		}),
	},
	edges: [edge()],
	groups: [],
};

describe("parsePipelineDocumentV3", () => {
	it("parses a valid document", () => {
		const { document, diagnostics } = parsePipelineDocumentV3(
			serializePipelineDocumentV3(minimalDocument),
		);
		expect(diagnostics).toEqual([]);
		expect(document?.name).toBe("test-pipeline");
		expect(document?.stages["start"]!.runtime.prompt).toBe("Do the thing.");
		expect(document?.stages["start"]!.jobOutput).toBe(false);
		expect(document?.stages["start"]!.goal).toBe(false);
	});

	it("reports syntax errors as diagnostics instead of throwing", () => {
		const { document, diagnostics } = parsePipelineDocumentV3(
			"version: 3\nstages:\n  start:\n    name: [unclosed",
		);
		expect(document).toBeNull();
		expect(diagnostics.some((d) => d.code === "yaml.syntax")).toBe(true);
	});

	it("rejects duplicate YAML keys", () => {
		const { diagnostics } = parsePipelineDocumentV3(
			"version: 3\nversion: 3\nname: dup\n",
		);
		expect(diagnostics.some((d) => d.code === "yaml.syntax")).toBe(true);
	});

	it("rejects unknown execution fields (strict contract)", () => {
		const yaml = serializePipelineDocumentV3(minimalDocument).replace(
			"name: test-pipeline",
			"name: test-pipeline\nmysteryExecutionField: sneaky",
		);
		const { document, diagnostics } = parsePipelineDocumentV3(yaml);
		expect(document).toBeNull();
		expect(diagnostics.some((d) => d.message.includes("mysteryExecutionField"))).toBe(
			true,
		);
	});

	it("rejects the removed stage mode field", () => {
		const yaml = serializePipelineDocumentV3(minimalDocument).replace(
			"    concurrency: 1",
			"    mode: serial\n    concurrency: 1",
		);
		const { document, diagnostics } = parsePipelineDocumentV3(yaml);
		expect(document).toBeNull();
		expect(diagnostics.some((diagnostic) => diagnostic.message.includes("mode"))).toBe(
			true,
		);
	});

	it("rejects promptFile in V3 documents", () => {
		const yaml = serializePipelineDocumentV3(minimalDocument).replace(
			"prompt: Do the thing.",
			"promptFile: scan-target.prompt.md",
		);
		const { document, diagnostics } = parsePipelineDocumentV3(yaml);
		expect(document).toBeNull();
		expect(
			diagnostics.some((d) => d.message.includes("promptFile")),
		).toBe(true);
	});

	it("rejects oversized documents", () => {
		const bigPrompt = "x".repeat(1 * 1024 * 1024 + 1024);
		const { diagnostics } = parsePipelineDocumentV3(
			`version: 3\nname: big\nsupportedTargets: [project]\nroot: start\nstages:\n  start:\n    name: s\n    role: scan\n    group: g\n    concurrency: 1\n    runtime:\n      prompt: ${JSON.stringify(bigPrompt)}\n`,
		);
		expect(diagnostics.some((d) => d.code === "yaml.size_exceeded")).toBe(
			true,
		);
	});

	it("rejects documents with excessive alias expansion", () => {
		const yaml = [
			"version: 3",
			"name: aliases",
			"supportedTargets: [project]",
			"root: start",
			"defaults: &d",
			"  name: s",
			"  role: scan",
			"  group: g",
			"  concurrency: 1",
			"  runtime:",
			"    prompt: p",
			"stages:",
			...Array.from(
				{ length: 20 },
				(_, i) => `  stage-${i}: *d`,
			),
			"edges: []",
		].join("\n");
		const { document, diagnostics } = parsePipelineDocumentV3(yaml);
		expect(document).toBeNull();
		expect(diagnostics.some((d) => d.code === "yaml.alias_expansion")).toBe(
			true,
		);
	});
});

describe("ui metadata", () => {
	it("round-trips ui.direction and edge bend points", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			ui: {
				direction: "RIGHT",
				nodes: { start: { x: 10, y: 20 } },
				edges: {
					"start-to-finish": {
						sourceHandle: "right-source",
						targetHandle: "left-target",
						bendPoints: [
							{ x: 10, y: 50 },
							{ x: 100, y: 50 },
						],
					},
				},
			},
		};
		assertStableRoundTrip(document);
		const { document: reparsed } = parsePipelineDocumentV3(
			serializePipelineDocumentV3(document),
		);
		expect(reparsed?.ui?.direction).toBe("RIGHT");
		expect(reparsed?.ui?.edges?.["start-to-finish"]?.bendPoints).toEqual([
			{ x: 10, y: 50 },
			{ x: 100, y: 50 },
		]);
		expect(reparsed?.ui?.edges?.["start-to-finish"]?.sourceHandle).toBe(
			"right-source",
		);
		expect(reparsed?.ui?.edges?.["start-to-finish"]?.targetHandle).toBe(
			"left-target",
		);
	});

	it("treats ui as optional and runtime-irrelevant", () => {
		const { document } = parsePipelineDocumentV3(
			serializePipelineDocumentV3(minimalDocument),
		);
		expect(document?.ui).toBeUndefined();
	});
});

describe("stable serialization", () => {
	it("round-trips through parse", () => {
		assertStableRoundTrip(minimalDocument);
	});

	it("is deterministic for the same document", () => {
		expect(serializePipelineDocumentV3(minimalDocument)).toBe(
			serializePipelineDocumentV3(structuredClone(minimalDocument)),
		);
	});

	it("hashes stable content independent of raw layout", () => {
		const serialized = serializePipelineDocumentV3(minimalDocument);
		// Same semantic document, different raw layout: the edges block moved
		// to the top and a comment added. Parsing normalizes both to one
		// canonical form, so the content hash must match.
		const edgesMarker = "\nedges:";
		const markerIndex = serialized.indexOf(edgesMarker);
		const reordered = `# canvas-touched layout${serialized.slice(markerIndex)}\n${serialized.slice(0, markerIndex)}`;
		const documentA = parsePipelineDocumentV3(serialized).document!;
		const documentB = parsePipelineDocumentV3(reordered).document!;
		expect(documentA).toEqual(documentB);
		expect(computePipelineContentHash(documentA)).toBe(
			computePipelineContentHash(documentB),
		);
	});
});

describe("validatePipelineDocumentV3", () => {
	it("accepts a loop topology (allowed) and flags unreachable stages", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			edges: [
				edge(),
				edge({ id: "finish-to-start", name: "finish-to-start", from: "finish", to: "start" }),
			],
			stages: {
				...minimalDocument.stages,
				orphan: stage({ name: "Orphan" }),
			},
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(diagnostics.some((d) => d.code === "stage.unreachable")).toBe(true);
		expect(diagnostics.some((d) => d.code === "edge.duplicate_id")).toBe(false);
	});

	it("requires fanOut edges to carry a foreach expression", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			edges: [edge({ mode: "fanOut" })],
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(diagnostics.some((d) => d.code === "edge.fanout_requires_foreach")).toBe(
			true,
		);
		expect(hasBlockingDiagnostics(diagnostics)).toBe(true);
	});

	it("requires exactly one default route key per routed stage", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			edges: [
				edge({ id: "e1", name: "e1", route: { key: "a" } }),
				edge({ id: "e2", name: "e2", route: { key: "b" } }),
			],
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(diagnostics.some((d) => d.code === "route.requires_single_default")).toBe(
			true,
		);
	});

	it("rejects mixed routed and non-routed downstream edges", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			edges: [
				edge({ id: "e1", name: "e1", route: { key: "a", default: true } }),
				edge({ id: "e2", name: "e2" }),
			],
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(diagnostics.some((d) => d.code === "route.mixed_routed")).toBe(true);
	});

	it("flags missing schema refs and allows recursive schemas", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			schemas: {
				node: {
					type: "object",
					properties: { children: { $ref: "#/schemas/node" } },
				},
			},
			stages: {
				...minimalDocument.stages,
				start: stage({
					outputSchema: { $ref: "#/schemas/node" },
					inputSchema: { $ref: "#/schemas/Missing" },
				}),
			},
		};
		const diagnostics = collectPipelineDiagnostics(document);
		// recursive ref is fine; the missing schema is an error
		expect(diagnostics.some((d) => d.code === "schema.missing")).toBe(true);
		expect(diagnostics.some((d) => d.code === "stage.invalid_schema_ref")).toBe(
			false,
		);
	});

	it("keeps nested stage and edge schema dependencies reachable", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			schemas: {
				"goal-spec": { type: "object" },
				"goal-craft-output": {
					type: "object",
					properties: { goalSpec: { $ref: "#/schemas/goal-spec" } },
				},
				"edge-output": {
					type: "object",
					properties: { nested: { $pathOf: "#/schemas/goal-spec" } },
				},
				orphan: { type: "object" },
			},
			stages: {
				...minimalDocument.stages,
				start: stage({ outputSchema: { $ref: "#/schemas/goal-craft-output" } }),
			},
			edges: [edge({ outputSchema: { $ref: "#/schemas/edge-output" } })],
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(diagnostics.some((d) => d.code === "schema.unused" && d.entity?.id === "goal-spec")).toBe(false);
		expect(diagnostics.some((d) => d.code === "schema.unused" && d.entity?.id === "orphan")).toBe(true);
	});

	it("rejects unsafe cwd and artifact paths", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			stages: {
				...minimalDocument.stages,
				start: stage({
					runtime: {
						kind: "agent",
						prompt: "p",
						prepareRepository: "none",
						includePolicy: false,
						plugins: [],
						cwd: "/workspace/../../etc",
					},
					inputArtifacts: [{ from: "$input.repositoryPath", to: "../../../escape", required: true }],
				}),
			},
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(diagnostics.some((d) => d.code === "stage.unsafe_cwd")).toBe(true);
		expect(
			diagnostics.some((d) => d.code === "stage.unsafe_artifact_path"),
		).toBe(true);
	});

	it("rejects goalPreserving on a non-persistent stage", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			stages: {
				...minimalDocument.stages,
				start: stage({
					goalPreserving: true,
					runtime: {
						kind: "agent",
						prompt: "p",
						prepareRepository: "none",
						includePolicy: false,
						plugins: [],
						persistent: false,
					},
				}),
			},
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(
			diagnostics.some((d) => d.code === "stage.goal_preserving_requires_persistent"),
		).toBe(true);
	});

	it("rejects research plugins without a research-registry effect", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			stages: {
				...minimalDocument.stages,
				start: stage({
					runtime: {
						kind: "agent",
						prompt: "p",
						prepareRepository: "none",
						includePolicy: false,
						plugins: ["research-deadline"],
					},
				}),
			},
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(
			diagnostics.some((d) => d.code === "stage.plugin_requires_research_registry"),
		).toBe(true);
	});

	it("rejects limits above the platform hard cap", () => {
		const document: PipelineDocumentV3 = {
			...structuredClone(minimalDocument),
			limits: { maxTasks: 200_000, maxDurationSeconds: 86400 },
		};
		const diagnostics = collectPipelineDiagnostics(document);
		expect(diagnostics.some((d) => d.code === "limits.max_tasks_exceeded")).toBe(
			true,
		);
	});
});

describe("convertV2DefinitionsToV3", () => {
	it("converts all four built-in pipelines with inline prompts", () => {
		const { documents, skipped } = convertV2DefinitionsToV3();
		expect(skipped).toEqual([]);
		expect(Object.keys(documents)).toEqual(
			expect.arrayContaining(["full", "delta", "research", "tob-goal"]),
		);

		for (const kind of ["full", "delta", "research", "tob-goal"] as const) {
			const document = documents[kind];
			expect(document).toBeDefined();
			expect(document!.version).toBe(3);
			// prompts inlined — never promptFile
			for (const convertedStage of Object.values(document!.stages)) {
				expect(convertedStage.runtime.prompt.trim().length).toBeGreaterThan(10);
			}
			// no diagnostics that block publishing
			expect(hasBlockingDiagnostics(collectPipelineDiagnostics(document!))).toBe(
				false,
			);
			// stable round-trip
			assertStableRoundTrip(document!);
		}
	});

	it("maps prepareRepository per pipeline kind", () => {
		const { documents } = convertV2DefinitionsToV3();
		const full = documents.full!;
		const delta = documents.delta!;
		expect(full.stages[full.root]!.runtime.prepareRepository).toBe("target");
		expect(delta.stages[delta.root]!.runtime.prepareRepository).toBe("diff");
		expect(
			Object.values(full.stages).filter(
				(convertedStage) =>
					convertedStage.runtime.prepareRepository !== "none",
			),
		).toHaveLength(1);
	});

	it("keeps edge names as stable ids and preserves routes", () => {
		const { documents } = convertV2DefinitionsToV3();
		const full = documents.full!;
		const critiqueEdge = full.edges.find(
			(convertedEdge) =>
				convertedEdge.from === "analyze-finding" &&
				convertedEdge.to === "critique-finding",
		);
		expect(critiqueEdge?.route?.key).toBe("critic");
		expect(full.edges.every((convertedEdge) => /^[a-z0-9_-]+$/.test(convertedEdge.id))).toBe(
			true,
		);
	});
});

describe("loadBuiltinPipelineTemplates", () => {
	it("loads four templates whose YAML re-parses to the same content hash", () => {
		const templates = loadBuiltinPipelineTemplates();
		expect(templates).toHaveLength(4);
		for (const template of templates) {
			const { document, diagnostics } = parsePipelineDocumentV3(template.yaml);
			expect(document).not.toBeNull();
			expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
			expect(computePipelineContentHash(document!)).toBe(template.contentHash);
		}
	});
});
