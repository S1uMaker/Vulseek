const AGENT_SKILL_HOME = "$VULSEEK_AGENT_HOME/skills";

export const normalizeSkillNames = (skills: readonly string[] | null | undefined) => {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const skill of skills ?? []) {
		const name = skill.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
};

export const skillFilePath = (skillName: string) =>
	`${AGENT_SKILL_HOME}/${skillName}/SKILL.md`;

export const formatSkillListPromptSection = (skills: readonly string[]) => {
	const names = normalizeSkillNames(skills);
	if (names.length === 0) return "";
	const lines = names.map((name) => `- \`${name}\`: ${skillFilePath(name)}`);
	return [
		"Use the installed skills listed below as your working methods. Read each skill file before starting.",
		"",
		...lines,
	].join("\n");
};

/**
 * Inject the stage's selected skills after the authored prompt and before
 * OUTPUT SUBMISSION / policy footers (those are appended later as protocol).
 * Skills already referenced by their SKILL.md path are left out.
 */
export const injectSkillListIntoPrompt = (
	prompt: string,
	skills: readonly string[] | null | undefined,
) => {
	const missing = normalizeSkillNames(skills).filter(
		(name) => !prompt.includes(`skills/${name}/SKILL.md`),
	);
	if (missing.length === 0) return prompt;
	const section = formatSkillListPromptSection(missing);
	const trimmed = prompt.trim();
	return trimmed ? `${trimmed}\n\n${section}` : section;
};
