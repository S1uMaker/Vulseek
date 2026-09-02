import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ccusage cost integration", () => {
	it("lets ccusage calculate per-request cost and refresh prices online", () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"../../packages/server/src/services/scan/runtime/agent-home-token-usage.ts",
			),
			"utf8",
		);
		expect(source).toContain('"calculate"');
		expect(source).toContain("--mode");
		expect(source).not.toContain("--offline");
		expect(source).not.toContain("--no-cost");
		expect(source).not.toContain("--network");
		expect(source).toContain("totalCost");
	});

	it("does not ask agent profiles to pick a pricing provider", () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"components/dashboard/settings/handle-agent-profile.tsx",
			),
			"utf8",
		);
		expect(source).not.toContain("pricingProvider");
		expect(source).not.toContain("Pricing Provider");
	});
});
