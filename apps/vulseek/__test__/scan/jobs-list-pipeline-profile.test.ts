import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readJobsList = () =>
	readFileSync(
		join(process.cwd(), "components/dashboard/scanning/show-scan-jobs.tsx"),
		"utf8",
	);

describe("jobs list pipeline profile column", () => {
	it("renders pipeline profile after the pipeline column on desktop and mobile", () => {
		const source = readJobsList();
		const pipelineColumn = source.indexOf('id: "pipeline"');
		const profileColumn = source.indexOf('id: "pipelineProfile"');
		const tokensColumn = source.indexOf('id: "tokens"');
		const mobilePipeline = source.indexOf("{job.pipelineSlug || \"-\"}");
		const mobileProfile = source.indexOf("formatPipelineProfileLabel(t, job)");

		expect(pipelineColumn).toBeGreaterThan(-1);
		expect(profileColumn).toBeGreaterThan(pipelineColumn);
		expect(tokensColumn).toBeGreaterThan(profileColumn);
		expect(source).not.toContain('id: "triggerSource"');
		expect(source).not.toContain('header: "Source"');
		expect(source).not.toContain("formatTriggerSource");
		expect(source).toContain("scan.field.pipelineProfile");
		expect(source).toContain("pipelineProfileName");
		expect(mobilePipeline).toBeGreaterThan(-1);
		expect(mobileProfile).toBeGreaterThan(mobilePipeline);
		expect(source).not.toContain("<Badge");
		expect(source).not.toContain("Scan Job (");
		expect(source).toContain("job.scanJobId.slice(0, 6)");
	});
});
