import { promises as fs } from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";

export const TASK_BROWSER_TASK_ROOT = "/task";
export const TASK_BROWSER_LANE_ROOT = "/lane";

export type TaskFileBrowserRoot = {
	name: "task" | "lane";
	containerRootPath: string;
	hostRootPath: string;
};

const isHiddenEntry = (name: string) => name.startsWith(".");

const assertWithinDirectory = (rootPath: string, targetPath: string) => {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedTarget = path.resolve(targetPath);
	const relativePath = path.relative(resolvedRoot, resolvedTarget);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "File path is outside the scan job context",
		});
	}
};

const isWithinDirectory = (rootPath: string, targetPath: string) => {
	try {
		assertWithinDirectory(rootPath, targetPath);
		return true;
	} catch {
		return false;
	}
};

export const resolveTaskFileBrowserTarget = (input: {
	roots: readonly TaskFileBrowserRoot[];
	filePath: string;
}) => {
	const normalized = input.filePath.trim();
	if (!normalized) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File path is required",
		});
	}

	const byContainer = input.roots.find(
		(root) =>
			normalized === root.containerRootPath ||
			normalized.startsWith(`${root.containerRootPath}/`),
	);
	if (byContainer) {
		const relativePath = path.posix.relative(
			byContainer.containerRootPath,
			normalized,
		);
		const targetPath = relativePath
			? path.join(
					byContainer.hostRootPath,
					relativePath.split("/").join(path.sep),
				)
			: byContainer.hostRootPath;
		assertWithinDirectory(byContainer.hostRootPath, targetPath);
		return { root: byContainer, targetPath };
	}

	const resolved = path.resolve(normalized);
	const byHost = input.roots.find(
		(root) =>
			resolved === path.resolve(root.hostRootPath) ||
			isWithinDirectory(root.hostRootPath, resolved),
	);
	if (byHost) {
		assertWithinDirectory(byHost.hostRootPath, resolved);
		return { root: byHost, targetPath: resolved };
	}

	throw new TRPCError({
		code: "NOT_FOUND",
		message: "Directory not found",
	});
};

const listHostDirectory = async (input: {
	root: TaskFileBrowserRoot;
	hostDirectory: string;
	entryId: (entryName: string) => string;
}) => {
	const entries = await fs.readdir(input.hostDirectory, {
		withFileTypes: true,
	});
	const visible = entries.filter((entry) => !isHiddenEntry(entry.name));
	visible.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return left.name.localeCompare(right.name);
	});
	return await Promise.all(
		visible.map(async (entry) => {
			const fullPath = path.join(input.hostDirectory, entry.name);
			if (entry.isDirectory()) {
				const children = await fs
					.readdir(fullPath, { withFileTypes: true })
					.catch(() => []);
				return {
					id: input.entryId(entry.name),
					name: entry.name,
					type: "directory" as const,
					hasChildren: children.some((child) => !isHiddenEntry(child.name)),
				};
			}
			return {
				id: input.entryId(entry.name),
				name: entry.name,
				type: "file" as const,
				hasChildren: false,
			};
		}),
	);
};

const directoryHasVisibleChildren = async (hostPath: string) => {
	const children = await fs
		.readdir(hostPath, { withFileTypes: true })
		.catch(() => []);
	return children.some((child) => !isHiddenEntry(child.name));
};

export const listTaskFileBrowserDirectory = async (input: {
	roots: readonly TaskFileBrowserRoot[];
	directoryPath?: string;
}) => {
	const roots = input.roots.filter((root) => root.hostRootPath);
	if (roots.length === 0) return [];

	const requestedPath = (input.directoryPath || "").trim();
	if (!requestedPath) {
		if (roots.length === 1 && roots[0]?.name === "task") {
			const [root] = roots;
			try {
				await fs.access(root.hostRootPath);
			} catch {
				return [];
			}
			return listHostDirectory({
				root,
				hostDirectory: root.hostRootPath,
				entryId: (entryName) => path.join(root.hostRootPath, entryName),
			});
		}

		return await Promise.all(
			roots.map(async (root) => ({
				id: root.containerRootPath,
				name: root.name,
				type: "directory" as const,
				hasChildren: await directoryHasVisibleChildren(root.hostRootPath),
			})),
		);
	}

	const { root, targetPath } = resolveTaskFileBrowserTarget({
		roots,
		filePath: requestedPath,
	});
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat?.isDirectory()) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Directory not found",
		});
	}

	const useContainerIds =
		requestedPath === root.containerRootPath ||
		requestedPath.startsWith(`${root.containerRootPath}/`);
	return listHostDirectory({
		root,
		hostDirectory: targetPath,
		entryId: (entryName) =>
			useContainerIds
				? path.posix.join(requestedPath, entryName)
				: path.join(targetPath, entryName),
	});
};

export const readTaskFileBrowserFile = async (input: {
	roots: readonly TaskFileBrowserRoot[];
	filePath: string;
}) => {
	const { root, targetPath } = resolveTaskFileBrowserTarget({
		roots: input.roots,
		filePath: input.filePath,
	});
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "File not found",
		});
	}
	const content = await fs.readFile(targetPath, "utf-8");
	const relativeFromHost = path
		.relative(root.hostRootPath, targetPath)
		.split(path.sep)
		.join("/");
	return {
		path: targetPath,
		relativePath:
			input.roots.length > 1
				? path.posix.join(root.name, relativeFromHost)
				: relativeFromHost,
		content,
	};
};
