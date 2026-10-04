import {
	collectJobTabDiagnostics,
	collectPipelineDiagnostics,
	compilePipelineDocumentV3,
	hasBlockingDiagnostics,
	jobTabsFromSnapshot,
	LEDGER_PRIMITIVES_TAB,
	type PipelineDocumentV3,
	type PipelineJobTab,
	parsePipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { loadBuiltinPipelineTemplates } from "@vulseek/server/services/scan/pipeline/document-v3/builtin-pipelines";
import { describe, expect, it } from "vitest";

const tab = (overrides: Partial<PipelineJobTab> = {}): PipelineJobTab => ({
	id: "findings",
	label: "Findings",
	renderer: "entity-table",
	dataSource: "research-findings",
	columns: ["title", "status"],
	filters: ["status"],
	defaultSort: { field: "updatedAt", direction: "desc" },
	detail: "research-finding",
	...overrides,
});

describe("collectJobTabDiagnostics", () => {
	it("rejects reserved ids, duplicates, and unknown columns", () => {
		const diagnostics = collectJobTabDiagnostics([
			tab({ id: "overview" }),
			tab({ id: "findings" }),
			tab({ id: "findings", columns: ["not-a-field"] }),
		]);
		expect(diagnostics.map((item) => item.code)).toEqual(
			expect.arrayContaining([
				"presentation.reserved_tab_id",
				"presentation.duplicate_tab_id",
				"presentation.unknown_column",
			]),
		);
	});

	it("rejects incompatible renderer/dataSource pairs", () => {
		const diagnostics = collectJobTabDiagnostics([
			tab({
				id: "tracks",
				renderer: "candidate-results",
				dataSource: "research-tracks",
			}),
		]);
		expect(
			diagnostics.some(
				(item) => item.code === "presentation.incompatible_renderer",
			),
		).toBe(true);
	});
});

describe("ledger job tab catalog", () => {
	it("exposes the database ID as the first sortable column", () => {
		expect(LEDGER_PRIMITIVES_TAB.columns[0]).toBe("id");
		expect(
			collectJobTabDiagnostics([
				{
					...LEDGER_PRIMITIVES_TAB,
					defaultSort: { field: "id", direction: "asc" },
				},
			]),
		).toEqual([]);
	});
	it("includes state as a column and enum filter", () => {
		expect(LEDGER_PRIMITIVES_TAB.columns).toContain("state");
		expect(LEDGER_PRIMITIVES_TAB.filters).toContain("state");
	});

	it("adds state to legacy explicit Ledger tabs", () => {
		const [ledger] = jobTabsFromSnapshot({
			presentation: {
				jobTabs: [
					{
						id: "ledger",
						label: "Ledger",
						renderer: "entity-table",
						dataSource: "ledger-primitives",
						columns: ["type", "verdict", "statement"],
						filters: ["type", "verdict"],
						detail: "ledger-primitive",
					},
				],
			},
		});
		expect(ledger?.columns).toEqual([
			"id",
			"title",
			"type",
			"state",
			"verdict",
			"primitiveCount",
		]);
		expect(ledger?.filters).toEqual(["type", "state", "verdict"]);
	});

	it("accepts the orch-hunt Ledger tab", () => {
		expect(
			collectJobTabDiagnostics([
				{
					id: "ledger",
					label: "Ledger",
					renderer: "entity-table",
					dataSource: "ledger-primitives",
					columns: ["type", "state", "verdict", "statement", "file", "line"],
					filters: ["type", "state", "verdict"],
					defaultSort: { field: "createdAt", direction: "desc" },
					detail: "ledger-primitive",
				},
			]),
		).toEqual([]);
	});
});

describe("compiled presentation", () => {
	it("keeps explicit jobTabs from the document", () => {
		const document: PipelineDocumentV3 = {
			version: 3,
			name: "x",
			supportedTargets: ["project"],
			root: "start",
			limits: { maxTasks: 10, maxDurationSeconds: 60 },
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
					effects: [{ type: "sync-candidates" }],
					containerNameParts: [],
					allowAgentExit: false,
					promptValues: {},
					runtime: {
						kind: "agent",
						prompt: "go",
						inputDelivery: "prompt",
						prepareRepository: "none",
						includePolicy: false,
						plugins: [],
					},
				},
			},
			edges: [],
			groups: [],
			presentation: {
				jobTabs: [
					{
						id: "candidates",
						label: "Candidates",
						renderer: "candidate-results",
						dataSource: "vulnerability-candidates",
						columns: ["title"],
						filters: ["analysisResult"],
						defaultSort: { field: "createdAt", direction: "desc" },
						detail: "vulnerability-candidate",
					},
				],
			},
		};
		expect(
			compilePipelineDocumentV3(document).presentation.jobTabs.map(
				(item) => item.id,
			),
		).toEqual(["candidates"]);
	});
});

describe("built-in pipeline presentation", () => {
	it("publishes without blocking job-tab diagnostics", () => {
		for (const template of loadBuiltinPipelineTemplates()) {
			const parsed = parsePipelineDocumentV3(template.yaml);
			expect(parsed.document).not.toBeNull();
			const diagnostics = collectPipelineDiagnostics(parsed.document!);
			expect(
				hasBlockingDiagnostics([...parsed.diagnostics, ...diagnostics]),
			).toBe(false);
			expect(parsed.document?.presentation?.jobTabs.length).toBeGreaterThan(0);
		}
	});
});
