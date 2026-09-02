import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("agent-home copy races", () => {
	it("copies auth.json atomically and waits instead of failing a concurrent test -s", () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"../../packages/server/src/services/scan/runtime/run-single-turn-agent.ts",
			),
			"utf8",
		);
		expect(source).toContain("waitForContainerPaths");
		expect(source).toContain("containerPathHasContent");
		expect(source).toContain("mv -f");
		expect(source).toContain("Required agent-home files were not ready");
		expect(source).not.toMatch(
			/test -s '\$\{codexHome\}\/auth\.json' && test -s '\$\{codexHome\}\/config\.toml'/,
		);
	});
});
