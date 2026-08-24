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
});
