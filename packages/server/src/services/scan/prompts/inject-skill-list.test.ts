import assert from "node:assert/strict";
import test from "node:test";
import {
	formatSkillListPromptSection,
	injectSkillListIntoPrompt,
	normalizeSkillNames,
} from "./inject-skill-list";

test("normalizeSkillNames trims, drops empties, and deduplicates", () => {
	assert.deepEqual(normalizeSkillNames([" goal-hunt ", "", "codeql", "goal-hunt"]), [
		"goal-hunt",
		"codeql",
	]);
	assert.deepEqual(normalizeSkillNames(null), []);
});

test("formatSkillListPromptSection lists SKILL.md paths", () => {
	const section = formatSkillListPromptSection(["goal-hunt", "codeql"]);
	assert.match(section, /Use the installed skills listed below/);
	assert.match(
		section,
		/`goal-hunt`: \$VULSEEK_AGENT_HOME\/skills\/goal-hunt\/SKILL\.md/,
	);
	assert.match(section, /`codeql`: \$VULSEEK_AGENT_HOME\/skills\/codeql\/SKILL\.md/);
});

test("injectSkillListIntoPrompt appends missing skills and skips ones already named", () => {
	const authored = [
		"You are the Scan Target stage.",
		"Use the installed skill named scan-target as your working method.",
		"The scan-target skill file is $VULSEEK_AGENT_HOME/skills/scan-target/SKILL.md.",
	].join("\n");
	const injected = injectSkillListIntoPrompt(authored, [
		"scan-target",
		"codeql",
		"semgrep",
	]);
	assert.match(injected, /`codeql`:/);
	assert.match(injected, /`semgrep`:/);
	assert.equal((injected.match(/scan-target\/SKILL\.md/g) ?? []).length, 1);
	assert.ok(injected.startsWith(authored));
	assert.ok(
		injected.indexOf(authored) < injected.indexOf("Use the installed skills"),
	);
});

test("injectSkillListIntoPrompt is a no-op when every skill is already referenced", () => {
	const prompt =
		"Read $VULSEEK_AGENT_HOME/skills/goal-craft/SKILL.md before drafting.";
	assert.equal(injectSkillListIntoPrompt(prompt, ["goal-craft"]), prompt);
});

test("injectSkillListIntoPrompt is a no-op for an empty skill list", () => {
	assert.equal(injectSkillListIntoPrompt("Hunt the bug.", []), "Hunt the bug.");
});
