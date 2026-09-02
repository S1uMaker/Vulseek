import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readOverview = () =>
	readFileSync(
		join(process.cwd(), "components/dashboard/scanning/scan-job-overview-tab.tsx"),
		"utf8",
	);

describe("job overview pipeline identity", () => {
	it("shows the running pipeline, version, and profile instead of a V3 placeholder", () => {
		const source = readOverview();
		expect(source).not.toContain("V3 pipeline run");
		expect(source).toContain("scan.field.pipeline");
		expect(source).toContain("scan.field.pipelineVersion");
		expect(source).toContain("scan.field.pipelineProfile");
		expect(source).toContain("resolveScanJobPipelineLabel(scanJob)");
		expect(source).toContain("formatPipelineVersionLabel(scanJob.pipelineVersionNumber)");
		expect(source).toContain("scanJob.pipelineProfileName");
		expect(source).toContain("/dashboard/pipelines/");
	});
});
