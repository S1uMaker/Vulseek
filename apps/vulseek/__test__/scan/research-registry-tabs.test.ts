import { describe, expect, it } from "vitest";
import { jobTabsFromSnapshot } from "@vulseek/server/services/scan/pipeline/document-v3";

describe("jobTabsFromSnapshot", () => {
	it("returns configured presentation tabs", () => {
		expect(
			jobTabsFromSnapshot({
				presentation: {
					jobTabs: [
						{
							id: "findings",
							label: "Findings",
							renderer: "entity-table",
							dataSource: "research-findings",
							columns: ["title"],
							filters: [],
						},
					],
				},
			}).map((tab) => tab.id),
		).toEqual(["findings"]);
	});

	it("infers research tabs from effects when presentation is missing", () => {
		expect(
			jobTabsFromSnapshot({
				stages: [
					{
						effects: [{ type: "research-registry" }],
						runtime: { plugins: ["research-track"] },
					},
				],
			}).map((tab) => tab.id),
		).toEqual(["findings", "tracks", "primitives", "chains"]);
	});

	it("infers no business tabs for an empty pipeline", () => {
		expect(jobTabsFromSnapshot({ stages: [] })).toEqual([]);
	});

	it("appends Ledger when an orchestrator stage is present", () => {
		expect(
			jobTabsFromSnapshot({
				presentation: {
					jobTabs: [
						{
							id: "candidates",
							label: "Candidates",
							renderer: "candidate-results",
							dataSource: "vulnerability-candidates",
							columns: ["title"],
							filters: [],
						},
					],
				},
				stages: [{ id: "orchestrator", name: "Orchestrator" }],
			}).map((tab) => tab.id),
		).toEqual(["candidates", "ledger"]);
	});
});
