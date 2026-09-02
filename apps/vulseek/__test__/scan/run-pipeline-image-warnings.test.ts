import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunPipelineImageWarnings } from "@/components/dashboard/pipelines/run-pipeline-image-warnings";

describe("run pipeline image warnings", () => {
	it("does not warn while status is still loading", () => {
		expect(
			buildRunPipelineImageWarnings({
				loading: true,
				tools: null,
				checkout: null,
			}),
		).toEqual([]);
	});

	it("warns when the tools image is missing or outdated", () => {
		const warnings = buildRunPipelineImageWarnings({
			tools: {
				exists: false,
				state: "missing",
				imageTag: "vulseek-scan-tools-dev:abc",
			},
			checkout: {
				exists: true,
				current: true,
				imageTag: "vulseek-scan-app:latest",
			},
		});
		expect(warnings.map((warning) => warning.id)).toEqual(["tools-missing"]);
	});

	it("warns when the checkout image is missing or stale", () => {
		expect(
			buildRunPipelineImageWarnings({
				tools: {
					exists: true,
					state: "ready",
					imageTag: "vulseek-scan-tools-dev:abc",
				},
				checkout: {
					exists: false,
					current: false,
					imageTag: "vulseek-scan-app:latest",
				},
			}).map((warning) => warning.id),
		).toEqual(["checkout-missing"]);
		expect(
			buildRunPipelineImageWarnings({
				tools: {
					exists: true,
					state: "ready",
					imageTag: "vulseek-scan-tools-dev:abc",
				},
				checkout: {
					exists: true,
					current: false,
					imageTag: "vulseek-scan-app:latest",
				},
			}).map((warning) => warning.id),
		).toEqual(["checkout-stale"]);
	});

	it("renders image warnings in the run pipeline dialog", () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"components/dashboard/pipelines/run-pipeline-dialog.tsx",
			),
			"utf8",
		);
		expect(source).toContain("api.scan.checkoutToolsStatus.useQuery");
		expect(source).toContain("api.scan.checkoutImageStatus.useQuery");
		expect(source).toContain("buildRunPipelineImageWarnings");
		expect(source).toContain("scan.dialog.imageWarningTitle");
		expect(source).toContain("tokenBudget");
		expect(source).toContain("timeBudgetSeconds");
		expect(source).toContain("scan.dialog.tokenBudget");
		expect(source).toContain("scan.dialog.timeBudget");
	});
});
