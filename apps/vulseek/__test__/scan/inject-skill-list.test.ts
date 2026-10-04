import { describe, expect, it } from "vitest";
import { injectSkillListIntoPrompt } from "@vulseek/server/services/scan/prompts/inject-skill-list";

describe("injectSkillListIntoPrompt", () => {
	it("appends selected skills that are not already named in the prompt", () => {
		const prompt = injectSkillListIntoPrompt(
			"You are the Goal Hunt stage.",
			["goal-hunt", "codeql"],
		);
		expect(prompt).toContain("Use the installed skills listed below");
		expect(prompt).toContain("$VULSEEK_AGENT_HOME/skills/goal-hunt/SKILL.md");
		expect(prompt).toContain("$VULSEEK_AGENT_HOME/skills/codeql/SKILL.md");
		expect(prompt.startsWith("You are the Goal Hunt stage.")).toBe(true);
		expect(prompt.endsWith("You are the Goal Hunt stage.")).toBe(false);
	});

	it("does not duplicate a skill whose SKILL.md path is already in the prompt", () => {
		const authored =
			"The scan-target skill file is $VULSEEK_AGENT_HOME/skills/scan-target/SKILL.md.";
		const prompt = injectSkillListIntoPrompt(authored, ["scan-target", "semgrep"]);
		expect((prompt.match(/scan-target\/SKILL\.md/g) ?? []).length).toBe(1);
		expect(prompt).toContain("semgrep");
	});
});
