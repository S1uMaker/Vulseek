import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILL_SLUG_PATTERN } from "@vulseek/server/db/schema/skills";
import { listAvailableAgentSkills } from "@vulseek/server/services/scan/runtime/available-skills";
import {
	assertSafeRelativePath,
	createSkillFileAt,
	deleteSkillFileAt,
	discoverFilesystemSkills,
	readSkillFileAt,
	resolvePathInsideRoot,
	writeSkillFileAt,
} from "@vulseek/server/services/skill-files";

describe("skill file paths", () => {
	it("rejects traversal and absolute paths", () => {
		expect(() => assertSafeRelativePath("../secret")).toThrow(/inside/);
		expect(() => assertSafeRelativePath("/etc/passwd")).toThrow(/relative/);
		expect(() => assertSafeRelativePath("a/../../b")).toThrow(/inside/);
		expect(assertSafeRelativePath("references/foo.md")).toBe(
			"references/foo.md",
		);
	});

	it("resolves files under the skill root only", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "vulseek-skill-root-"));
		const escaped = resolvePathInsideRoot(root, "SKILL.md");
		expect(escaped.startsWith(root)).toBe(true);
		expect(() => resolvePathInsideRoot(root, "../outside.md")).toThrow(
			/inside/,
		);
	});
});

describe("skill file CRUD", () => {
	it("creates, writes, reads, and deletes a text file", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "vulseek-skill-crud-"));
		await createSkillFileAt({
			skillRoot: root,
			filePath: "notes/todo.md",
			content: "one",
		});
		const written = await writeSkillFileAt({
			skillRoot: root,
			filePath: "notes/todo.md",
			content: "two",
		});
		expect(written.content).toBe("two");
		expect(written.binary).toBe(false);
		const read = await readSkillFileAt({
			skillRoot: root,
			filePath: "notes/todo.md",
		});
		expect(read.content).toBe("two");
		await deleteSkillFileAt({
			skillRoot: root,
			filePath: "notes/todo.md",
		});
		await expect(
			readSkillFileAt({ skillRoot: root, filePath: "notes/todo.md" }),
		).rejects.toThrow(/not found/i);
	});

	it("discovers filesystem skill directories including those without SKILL.md", async () => {
		const agents = await mkdtemp(path.join(tmpdir(), "vulseek-skill-disc-"));
		const skillsRoot = path.join(agents, "skills");
		await mkdir(path.join(skillsRoot, "goal-hunt"), { recursive: true });
		await mkdir(path.join(skillsRoot, "empty-dir"), { recursive: true });
		await writeFile(
			path.join(skillsRoot, "goal-hunt", "SKILL.md"),
			["---", "name: goal-hunt", "description: Pursue one hunt goal.", "---"].join(
				"\n",
			),
		);
		const discovered = await discoverFilesystemSkills(skillsRoot);
		expect(discovered.map((item) => item.slug).sort()).toEqual([
			"empty-dir",
			"goal-hunt",
		]);
		expect(discovered.find((item) => item.slug === "goal-hunt")?.description).toBe(
			"Pursue one hunt goal.",
		);
	});
});

describe("existing agents/skills catalog", () => {
	it("uses valid slugs for every checked-in skill directory", async () => {
		const repoAgents = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../../../agents",
		);
		const discovered = await discoverFilesystemSkills(
			path.join(repoAgents, "skills"),
		);
		expect(discovered.length).toBeGreaterThan(10);
		for (const skill of discovered) {
			expect(skill.slug).toMatch(SKILL_SLUG_PATTERN);
			expect(skill.directoryPath).toBe(skill.slug);
		}
		const withSkillMd = await listAvailableAgentSkills(repoAgents);
		expect(withSkillMd.length).toBeGreaterThan(10);
		expect(discovered.map((item) => item.slug)).toEqual(
			expect.arrayContaining(withSkillMd.map((item) => item.name)),
		);
	});
});
