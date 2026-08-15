import { describe, expect, it } from "vitest";
import type { PipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	collectSchemaRefs,
	createEdgeDraft,
	createGroupDraft,
	createStageDraft,
	deleteBlockers,
	diagnosticsForEntity,
	duplicateDiagnostics,
	entityCounts,
	filterVisibleSchemaDiagnostics,
	groupReferrers,
	isDuplicateId,
	relatedSchemaIds,
	schemaIdFromPointer,
	schemaPointer,
	schemaReferrers,
	stageReferrers,
} from "@/lib/pipeline-editor/definition-helpers";

const document: PipelineDocumentV3 = {
	version: 3,
	name: "test",
	supportedTargets: ["project"],
	root: "discovery",
	limits: { maxTasks: 100, maxDurationSeconds: 3600 },
	schemas: {
		"finding-schema": { type: "object", properties: { severity: { type: "string" } } },
		"unused-schema": { type: "object" },
	},
	stages: {
		discovery: {
			name: "Discovery",
			role: "scan",
			group: "core",
			concurrency: 1,
			runtime: { kind: "agent", prompt: "Discover.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], jobOutput: false, effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {},
			inputSchema: { $ref: "#/schemas/finding-schema" },
		},
		review: {
			name: "Review",
			role: "verification",
			group: "core",
			concurrency: 1,
			runtime: { kind: "agent", prompt: "Review.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], jobOutput: false, effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {},
			outputSchema: { $ref: "#/schemas/finding-schema" },
		},
	},
	edges: [
		{ id: "d-to-r", name: "Hand off", from: "discovery", to: "review", mode: "map", fork: false, artifacts: [], outputSchema: { $ref: "#/schemas/finding-schema" } },
	],
	groups: [
		{ id: "core", name: "Core", leader: "discovery", members: ["discovery", "review"] },
	],
};

describe("entityCounts", () => {
	it("counts every entity kind", () => {
		expect(entityCounts(document)).toEqual({ stages: 2, edges: 1, schemas: 1, groups: 1 });
	});
});

describe("schema reference resolution", () => {
	it("collects nested $refs inside arbitrary JSON Schema values", () => {
		const refs = new Set<string>();
		collectSchemaRefs(
			{
				type: "object",
				properties: {
					a: { $ref: "#/schemas/finding-schema" },
					b: { items: { $ref: "#/schemas/other/properties/x" } },
					c: { $ref: "https://example.com/external" },
				},
			},
			refs,
		);
		expect([...refs].sort()).toEqual(["finding-schema", "other"]);
	});

	it("collects $pathOf pointers as schema references", () => {
		const refs = new Set<string>();
		collectSchemaRefs(
			{
				type: "object",
				properties: {
					modulePath: { $pathOf: "#/schemas/module" },
					candidates: { type: "array", items: { $pathOf: "#/schemas/candidate" } },
				},
			},
			refs,
		);
		expect([...refs].sort()).toEqual(["candidate", "module"]);
	});

	it("parses and builds #/schemas/<id> pointers", () => {
		expect(schemaIdFromPointer("#/schemas/module")).toBe("module");
		expect(schemaPointer("module")).toBe("#/schemas/module");
		expect(schemaIdFromPointer("#/schemas/module/properties/x")).toBeNull();
		expect(schemaIdFromPointer("https://example.com/schema")).toBeNull();
		expect(schemaIdFromPointer(undefined)).toBeNull();
	});

	it("resolves stage and edge schema references", () => {
		expect(schemaReferrers(document, "finding-schema").map((r) => `${r.kind}:${r.id}`).sort()).toEqual(["edge:d-to-r", "stage:discovery", "stage:review"]);
		expect(schemaReferrers(document, "unused-schema")).toEqual([]);
	});

	it("includes transitively referenced schemas but hides global unused schemas", () => {
		const withNestedSchema = {
			...document,
			schemas: {
				...document.schemas,
				"finding-schema": {
					type: "object",
					properties: { nested: { $ref: "#/schemas/nested-schema" } },
				},
				"nested-schema": { type: "object" },
			},
		};
		expect(relatedSchemaIds(withNestedSchema)).toEqual([
			"finding-schema",
			"nested-schema",
		]);
		expect(schemaReferrers(withNestedSchema, "nested-schema").map((r) => `${r.kind}:${r.id}`)).toEqual([
			"schema:finding-schema",
		]);
		expect(
			filterVisibleSchemaDiagnostics(withNestedSchema, [
				{ severity: "warning", code: "schema.unused", message: "hidden", entity: { type: "schema", id: "unused-schema" } },
				{ severity: "warning", code: "schema.unused", message: "visible", entity: { type: "schema", id: "nested-schema" } },
			]),
		).toHaveLength(1);
	});
});

describe("stage references", () => {
	it("lists root, inbound, outbound, and group-leader references", () => {
		const refs = stageReferrers(document, "discovery");
		const reasons = refs.map((r) => `${r.kind}:${r.id}`).sort();
		expect(reasons).toContain("edge:d-to-r");
		expect(reasons).toContain("group:core");
		// Root reference is reported with kind stage.
		expect(refs.some((r) => r.kind === "stage" && r.reason.includes("root"))).toBe(true);
		expect(stageReferrers(document, "review").map((r) => r.id)).toContain("d-to-r");
	});
});

describe("group references", () => {
	it("lists stages that belong to the group", () => {
		expect(groupReferrers(document, "core").map((r) => r.id).sort()).toEqual(["discovery", "review"]);
	});
});

describe("deleteBlockers", () => {
	it("blocks deleting the root stage", () => {
		const blockers = deleteBlockers(document, "stage", "discovery");
		expect(blockers.length).toBeGreaterThan(0);
		expect(blockers.every((b) => b.severity === "error")).toBe(true);
		expect(blockers.some((b) => b.code === "delete.stage_referenced")).toBe(true);
	});

	it("blocks deleting a stage with inbound/outbound edges", () => {
		const blockers = deleteBlockers(document, "stage", "review");
		expect(blockers.some((b) => b.message.includes("Incoming edge"))).toBe(true);
	});

	it("allows deleting a stage with no references", () => {
		const doc = {
			...document,
			stages: { ...document.stages, orphan: { ...document.stages.discovery!, group: "core" } },
		};
		expect(deleteBlockers(doc, "stage", "orphan")).toEqual([]);
	});

	it("blocks deleting a referenced schema", () => {
		const blockers = deleteBlockers(document, "schema", "finding-schema");
		expect(blockers).toHaveLength(3);
		expect(blockers.every((b) => b.code === "delete.schema_referenced")).toBe(true);
		expect(deleteBlockers(document, "schema", "unused-schema")).toEqual([]);
	});

	it("blocks deleting a group that still owns stages", () => {
		const blockers = deleteBlockers(document, "group", "core");
		expect(blockers).toHaveLength(2);
		expect(blockers.every((b) => b.code === "delete.group_referenced")).toBe(true);
	});

	it("always allows edge deletion", () => {
		expect(deleteBlockers(document, "edge", "d-to-r")).toEqual([]);
	});
});

describe("duplicate and create validation", () => {
	it("detects duplicate ids per kind", () => {
		expect(isDuplicateId(document, "stage", "discovery")).toBe(true);
		expect(isDuplicateId(document, "stage", "fresh")).toBe(false);
		expect(isDuplicateId(document, "edge", "d-to-r")).toBe(true);
		expect(isDuplicateId(document, "schema", "finding-schema")).toBe(true);
		expect(isDuplicateId(document, "group", "core")).toBe(true);
	});

	it("reports slug shape and duplicate errors for create forms", () => {
		const diagnostics = duplicateDiagnostics(document, "stage", "Discovery");
		expect(diagnostics.some((d) => d.code === "create.invalid_slug")).toBe(true);
		const dup = duplicateDiagnostics(document, "stage", "discovery");
		expect(dup.some((d) => d.code === "create.duplicate_id")).toBe(true);
		expect(duplicateDiagnostics(document, "stage", "ok-id")).toEqual([]);
	});
});

describe("entity factories", () => {
	it("creates complete, parseable drafts", () => {
		const stage = createStageDraft("triage", "core");
		expect(stage.name).toBe("triage");
		expect(stage.role).toBe("scan");
		expect(stage.group).toBe("core");
		expect(stage.runtime.prompt.length).toBeGreaterThan(0);

		const edge = createEdgeDraft("hand-off", "discovery", "review", new Set(["hand-off"]));
		expect(edge.id).toBe("hand-off-1");
		expect(edge.from).toBe("discovery");
		expect(edge.to).toBe("review");
		expect(edge.mode).toBe("map");

		const group = createGroupDraft("core", "discovery", new Set(["core"]));
		expect(group.id).toBe("core-1");
		expect(group.leader).toBe("discovery");
		expect(group.members).toEqual(["discovery"]);
	});
});

describe("diagnosticsForEntity", () => {
	it("filters diagnostics to one entity", () => {
		const diagnostics = [
			{ severity: "error" as const, code: "a", message: "m", entity: { type: "stage" as const, id: "discovery" } },
			{ severity: "warning" as const, code: "b", message: "m", entity: { type: "stage" as const, id: "review" } },
			{ severity: "error" as const, code: "c", message: "m" },
		];
		const result = diagnosticsForEntity(diagnostics, "stage", "discovery");
		expect(result).toHaveLength(1);
		expect(result[0]?.code).toBe("a");
	});
});
