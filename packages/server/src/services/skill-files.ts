import { promises as fs } from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { resolveAgentsDirectory } from "./scan/runtime/available-skills";

export const SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024;

const HIDDEN_ENTRY_NAMES = new Set(["__pycache__", "node_modules"]);

export type SkillDirectoryListItem = {
	id: string;
	name: string;
	type: "directory" | "file";
	hasChildren: boolean;
};

export type SkillFileContent = {
	relativePath: string;
	content: string | null;
	binary: boolean;
	size: number;
};

export type FilesystemSkill = {
	slug: string;
	name: string;
	description: string;
	directoryPath: string;
};

const toPosix = (value: string) => value.replace(/\\/g, "/");

const isHiddenEntry = (name: string) =>
	name.startsWith(".") ||
	HIDDEN_ENTRY_NAMES.has(name) ||
	name.endsWith(".pyc");

export const resolveSkillsRoot = async (agentsDir?: string | null) => {
	const root =
		agentsDir === undefined ? await resolveAgentsDirectory() : agentsDir;
	if (!root) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Agent skills directory was not found",
		});
	}
	return path.join(root, "skills");
};

export const assertSafeRelativePath = (relativePath: string) => {
	const normalized = toPosix(relativePath.trim());
	if (!normalized || normalized === ".") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path is required",
		});
	}
	if (path.isAbsolute(normalized) || normalized.startsWith("/")) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path must be relative to the skill directory",
		});
	}
	const parts = normalized.split("/").filter((part) => part.length > 0);
	if (
		parts.length === 0 ||
		parts.some((part) => part === "." || part === ".." || part === "")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path must stay inside the skill directory",
		});
	}
	return parts.join("/");
};

export const resolvePathInsideRoot = (rootPath: string, relativePath: string) => {
	const resolvedRoot = path.resolve(rootPath);
	const safeRelative =
		relativePath.trim() === "" || relativePath.trim() === "."
			? ""
			: assertSafeRelativePath(relativePath);
	const resolvedTarget = path.resolve(resolvedRoot, safeRelative);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Path must stay inside the skill directory",
		});
	}
	return resolvedTarget;
};

const parseFrontmatter = (content: string) => {
	if (!content.startsWith("---")) {
		return { name: "", description: "" };
	}
	const end = content.indexOf("\n---", 3);
	if (end < 0) {
		return { name: "", description: "" };
	}
	const frontmatter = content.slice(4, end);
	const nameMatch = frontmatter.match(/(?:^|\n)name:\s*(.+)/);
	const descriptionMatch = frontmatter.match(
		/(?:^|\n)description:\s*(?:>-?[ \t]*\n)?([\s\S]*?)(?=\n[A-Za-z][\w-]*:|$)/,
	);
	return {
		name: (nameMatch?.[1] ?? "").replace(/^["']|["']$/g, "").trim(),
		description: (descriptionMatch?.[1] ?? "")
			.replace(/^["']|["']$/g, "")
			.replace(/\s+/g, " ")
			.trim(),
	};
};

export const defaultSkillMarkdown = (input: {
	slug: string;
	name: string;
	description?: string | null;
}) =>
	[
		"---",
		`name: ${input.slug}`,
		`description: ${input.description?.trim() || "Describe this skill."}`,
		"---",
		"",
		`# ${input.name.trim() || input.slug}`,
		"",
	].join("\n");

export const discoverFilesystemSkills = async (
	skillsRoot: string,
): Promise<FilesystemSkill[]> => {
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await fs.readdir(skillsRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const skills: FilesystemSkill[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (!entry.isDirectory() || isHiddenEntry(entry.name)) continue;
		const directoryPath = entry.name;
		const skillFile = path.join(skillsRoot, directoryPath, "SKILL.md");
		let name = directoryPath;
		let description = "";
		try {
			const content = await fs.readFile(skillFile, "utf-8");
			const parsed = parseFrontmatter(content);
			if (parsed.name) name = parsed.name;
			description = parsed.description;
		} catch {}
		skills.push({
			slug: directoryPath,
			name,
			description,
			directoryPath,
		});
	}
	return skills;
};

const listEntries = async (directoryPath: string, skillRoot: string) => {
	const entries = await fs.readdir(directoryPath, { withFileTypes: true });
	const visible = entries.filter((entry) => !isHiddenEntry(entry.name));
	visible.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return left.name.localeCompare(right.name);
	});

	return await Promise.all(
		visible.map(async (entry) => {
			const fullPath = path.join(directoryPath, entry.name);
			const relativePath = toPosix(path.relative(skillRoot, fullPath));
			if (entry.isDirectory()) {
				const children = await fs
					.readdir(fullPath, { withFileTypes: true })
					.catch(() => []);
				const hasChildren = children.some(
					(child) => !isHiddenEntry(child.name),
				);
				return {
					id: relativePath,
					name: entry.name,
					type: "directory" as const,
					hasChildren,
				};
			}
			return {
				id: relativePath,
				name: entry.name,
				type: "file" as const,
				hasChildren: false,
			};
		}),
	);
};

export const listSkillDirectoryAt = async (input: {
	skillRoot: string;
	directoryPath?: string;
}): Promise<SkillDirectoryListItem[]> => {
	const target = resolvePathInsideRoot(
		input.skillRoot,
		input.directoryPath ?? "",
	);
	const stat = await fs.stat(target).catch(() => null);
	if (!stat || !stat.isDirectory()) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Directory not found",
		});
	}
	return listEntries(target, input.skillRoot);
};

const isBinaryBuffer = (buffer: Buffer) => buffer.includes(0);

export const readSkillFileAt = async (input: {
	skillRoot: string;
	filePath: string;
}): Promise<SkillFileContent> => {
	const target = resolvePathInsideRoot(input.skillRoot, input.filePath);
	const stat = await fs.stat(target).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "File not found",
		});
	}
	if (stat.size > SKILL_FILE_MAX_BYTES) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `File is larger than ${SKILL_FILE_MAX_BYTES} bytes`,
		});
	}
	const buffer = await fs.readFile(target);
	if (isBinaryBuffer(buffer)) {
		return {
			relativePath: assertSafeRelativePath(input.filePath),
			content: null,
			binary: true,
			size: stat.size,
		};
	}
	return {
		relativePath: assertSafeRelativePath(input.filePath),
		content: buffer.toString("utf-8"),
		binary: false,
		size: stat.size,
	};
};

export const writeSkillFileAt = async (input: {
	skillRoot: string;
	filePath: string;
	content: string;
}) => {
	const target = resolvePathInsideRoot(input.skillRoot, input.filePath);
	const bytes = Buffer.byteLength(input.content, "utf-8");
	if (bytes > SKILL_FILE_MAX_BYTES) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `File is larger than ${SKILL_FILE_MAX_BYTES} bytes`,
		});
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, input.content, "utf-8");
	return readSkillFileAt({
		skillRoot: input.skillRoot,
		filePath: input.filePath,
	});
};

export const createSkillFileAt = async (input: {
	skillRoot: string;
	filePath: string;
	content?: string;
	directory?: boolean;
}) => {
	const relative = assertSafeRelativePath(input.filePath);
	const target = resolvePathInsideRoot(input.skillRoot, relative);
	const exists = await fs.stat(target).catch(() => null);
	if (exists) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "A file or directory already exists at that path",
		});
	}
	if (input.directory) {
		await fs.mkdir(target, { recursive: true });
		return { relativePath: relative, directory: true as const };
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, input.content ?? "", "utf-8");
	return { relativePath: relative, directory: false as const };
};

export const deleteSkillFileAt = async (input: {
	skillRoot: string;
	filePath: string;
}) => {
	const relative = assertSafeRelativePath(input.filePath);
	const target = resolvePathInsideRoot(input.skillRoot, relative);
	const stat = await fs.stat(target).catch(() => null);
	if (!stat) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "File not found",
		});
	}
	await fs.rm(target, { recursive: true, force: true });
	return { relativePath: relative };
};

export const ensureSkillDirectory = async (input: {
	skillsRoot: string;
	directoryPath: string;
	slug: string;
	name: string;
	description?: string | null;
}) => {
	const relative = assertSafeRelativePath(input.directoryPath);
	const target = resolvePathInsideRoot(input.skillsRoot, relative);
	await fs.mkdir(target, { recursive: true });
	const skillFile = path.join(target, "SKILL.md");
	const exists = await fs.stat(skillFile).catch(() => null);
	if (!exists) {
		await fs.writeFile(
			skillFile,
			defaultSkillMarkdown({
				slug: input.slug,
				name: input.name,
				description: input.description,
			}),
			"utf-8",
		);
	}
	return relative;
};

export const removeSkillDirectory = async (input: {
	skillsRoot: string;
	directoryPath: string;
}) => {
	const relative = assertSafeRelativePath(input.directoryPath);
	const target = resolvePathInsideRoot(input.skillsRoot, relative);
	await fs.rm(target, { recursive: true, force: true });
};
