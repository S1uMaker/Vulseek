import { promises as fs } from "node:fs";
import path from "node:path";

export type AgentSkillCatalogEntry = {
	name: string;
	description: string;
};

export const resolveAgentsDirectory = async () => {
	const candidates = [
		path.resolve(process.cwd(), "agents"),
		path.resolve(process.cwd(), "../../agents"),
		"/app/agents",
	];
	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) return candidate;
		} catch {}
	}
	return null;
};

const parseSkillDescription = (content: string) => {
	if (!content.startsWith("---")) return "";
	const end = content.indexOf("\n---", 3);
	if (end < 0) return "";
	const frontmatter = content.slice(4, end);
	const match = frontmatter.match(
		/(?:^|\n)description:\s*(?:>-?[ \t]*\n)?([\s\S]*?)(?=\n[A-Za-z][\w-]*:|$)/,
	);
	return (match?.[1] ?? "")
		.replace(/^["']|["']$/g, "")
		.replace(/\s+/g, " ")
		.trim();
};

export const listAvailableAgentSkills = async (
	agentsDir?: string | null,
): Promise<AgentSkillCatalogEntry[]> => {
	const root = agentsDir === undefined ? await resolveAgentsDirectory() : agentsDir;
	if (!root) return [];
	const skillsRoot = path.join(root, "skills");
	let entries: string[] = [];
	try {
		entries = await fs.readdir(skillsRoot);
	} catch {
		return [];
	}

	const skills: AgentSkillCatalogEntry[] = [];
	for (const name of entries.sort()) {
		const skillFile = path.join(skillsRoot, name, "SKILL.md");
		try {
			const content = await fs.readFile(skillFile, "utf-8");
			skills.push({
				name,
				description: parseSkillDescription(content),
			});
		} catch {
			continue;
		}
	}
	return skills;
};
