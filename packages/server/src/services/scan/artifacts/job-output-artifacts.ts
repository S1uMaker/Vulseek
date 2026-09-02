import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScanJobOutput } from "@vulseek/server/db/schema";
import {
	isTaskArtifactPath,
	taskArtifactHostPath,
} from "./task-artifact-paths";

export const TASK_JOB_OUTPUT_CONTAINER_ROOT = "/task/job-output";

const collectReferencedTaskPaths = (value: unknown, paths: Set<string>) => {
	if (typeof value === "string") {
		if (
			isTaskArtifactPath(value) &&
			value !== "/task" &&
			value !== TASK_JOB_OUTPUT_CONTAINER_ROOT &&
			!value.startsWith(`${TASK_JOB_OUTPUT_CONTAINER_ROOT}/`)
		) {
			paths.add(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectReferencedTaskPaths(item, paths);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const item of Object.values(value)) {
		collectReferencedTaskPaths(item, paths);
	}
};

const sortedDirectoryEntries = async (directory: string) =>
	(await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
		left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
	);

const toContainerJobOutputPath = (relativePath: string) =>
	path.posix.join(
		TASK_JOB_OUTPUT_CONTAINER_ROOT,
		...relativePath.split(path.sep),
	);

export const materializeTaskJobOutput = async (input: {
	taskDir: string;
	taskId: string;
	messageId: string;
	stageName: string;
	output: unknown;
}): Promise<ScanJobOutput | null> => {
	const taskRoot = path.resolve(input.taskDir);
	const taskRootRealPath = await fs.realpath(taskRoot);
	const outputDirectory = path.join(taskRoot, "job-output");
	const stagingDirectory = path.join(
		taskRoot,
		`.job-output-${randomUUID()}.tmp`,
	);
	const referencedPaths = new Set<string>();
	collectReferencedTaskPaths(input.output, referencedPaths);
	const copiedRelativePaths = new Set<string>();

	const copyEntry = async (
		sourcePath: string,
		relativePath: string,
		containerPath: string,
	): Promise<void> => {
		const sourceStat = await fs.lstat(sourcePath).catch((error: unknown) => {
			if ((error as { code?: unknown }).code === "ENOENT") {
				throw new Error(
					`Stage ${input.stageName} job output artifact does not exist: ${containerPath}`,
				);
			}
			throw error;
		});
		if (sourceStat.isSymbolicLink()) {
			throw new Error(
				`Job output artifacts cannot be symbolic links: ${containerPath}`,
			);
		}
		const sourceRealPath = await fs.realpath(sourcePath);
		const expectedRealPath = path.join(taskRootRealPath, relativePath);
		if (sourceRealPath !== expectedRealPath) {
			throw new Error(
				`Job output artifact resolves through a symbolic link: ${containerPath}`,
			);
		}
		if (sourceStat.isDirectory()) {
			for (const entry of await sortedDirectoryEntries(sourcePath)) {
				const entryRelativePath = path.join(relativePath, entry.name);
				await copyEntry(
					path.join(sourcePath, entry.name),
					entryRelativePath,
					path.posix.join(containerPath, entry.name),
				);
			}
			return;
		}
		if (!sourceStat.isFile()) {
			throw new Error(
				`Job output artifacts must be regular files: ${containerPath}`,
			);
		}
		if (copiedRelativePaths.has(relativePath)) return;
		const targetPath = path.join(stagingDirectory, relativePath);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.copyFile(sourcePath, targetPath);
		copiedRelativePaths.add(relativePath);
	};

	await fs.mkdir(stagingDirectory, { recursive: true });
	try {
		for (const containerPath of [...referencedPaths].sort()) {
			const sourcePath = taskArtifactHostPath({
				taskDir: taskRoot,
				containerPath,
			});
			const relativePath = path.relative(taskRoot, sourcePath);
			await copyEntry(sourcePath, relativePath, containerPath);
		}
		await fs.rm(outputDirectory, { recursive: true, force: true });
		await fs.rename(stagingDirectory, outputDirectory);
	} catch (error) {
		await fs.rm(stagingDirectory, { recursive: true, force: true });
		throw error;
	}

	if (copiedRelativePaths.size === 0) return null;

	return {
		messageId: input.messageId,
		stageName: input.stageName,
		artifacts: [...copiedRelativePaths]
			.sort()
			.map((relativePath) => ({
				path: toContainerJobOutputPath(relativePath),
			})),
	};
};
