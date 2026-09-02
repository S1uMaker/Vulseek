import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("home overview running jobs", () => {
	it("shows pipeline profile after the project profile", () => {
		const source = readFileSync(
			join(process.cwd(), "pages/dashboard/index.tsx"),
			"utf8",
		);
		expect(source).toContain("job.targetKind");
		expect(source).toContain("job.target");
		expect(source).toContain("job.pipelineProfileName");
		expect(source.indexOf("job.target")).toBeLessThan(
			source.indexOf("job.pipelineProfileName"),
		);
	});
});
