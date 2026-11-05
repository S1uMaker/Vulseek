import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const TASK_ROOT_IN_CONTAINER = "/task";

export const taskArtifactPathSchemaMessage =
	"Task artifact paths must be absolute paths under /task";

export const isTaskArtifactPath = (value: unknown): value is string =>
	typeof value === "string" &&
	(value === TASK_ROOT_IN_CONTAINER ||
		value.startsWith(`${TASK_ROOT_IN_CONTAINER}/`));

const normalizeTaskRelativePath = (containerPath: string) => {
	if (!isTaskArtifactPath(containerPath)) {
		throw new Error(
			`${taskArtifactPathSchemaMessage}: ${String(containerPath)}`,
		);
	}
	const relativePath = path.posix.relative(
		TASK_ROOT_IN_CONTAINER,
		containerPath,
	);
	if (!relativePath || relativePath === "." || relativePath.startsWith("../")) {
		throw new Error(`Invalid task artifact path: ${containerPath}`);
	}
	return relativePath;
};

export const taskArtifactHostPath = (input: {
	taskDir: string;
	containerPath: string;
}) => {
	const relativePath = normalizeTaskRelativePath(input.containerPath);
	const hostPath = path.resolve(input.taskDir, relativePath);
	const taskDir = path.resolve(input.taskDir);
	if (hostPath !== taskDir && !hostPath.startsWith(`${taskDir}${path.sep}`)) {
		throw new Error(
			`Task artifact path escapes task directory: ${input.containerPath}`,
		);
	}
	return hostPath;
};

export const writeTaskJsonArtifact = async (input: {
	taskDir: string;
	relativePath: string;
	value: unknown;
}) => {
	const normalizedRelativePath = path.posix.normalize(input.relativePath);
	if (
		!normalizedRelativePath ||
		normalizedRelativePath === "." ||
		normalizedRelativePath.startsWith("../") ||
		path.posix.isAbsolute(normalizedRelativePath)
	) {
		throw new Error(
			`Invalid task artifact relative path: ${input.relativePath}`,
		);
	}
	const hostPath = path.join(input.taskDir, normalizedRelativePath);
	await fs.mkdir(path.dirname(hostPath), { recursive: true });
	await fs.writeFile(
		hostPath,
		`${JSON.stringify(input.value, null, 2)}\n`,
		"utf-8",
	);
	return path.posix.join(TASK_ROOT_IN_CONTAINER, normalizedRelativePath);
};

export const replaceTaskJsonArtifact = async (input: {
	taskDir: string;
	containerPath: string;
	value: unknown;
}) => {
	const hostPath = taskArtifactHostPath(input);
	await fs.mkdir(path.dirname(hostPath), { recursive: true });
	const temporaryPath = `${hostPath}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(input.value, null, 2)}\n`,
			"utf-8",
		);
		await fs.rename(temporaryPath, hostPath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
	return input.containerPath;
};

export const writeTaskTextArtifact = async (input: {
	taskDir: string;
	relativePath: string;
	value: string;
}) => {
	const normalizedRelativePath = path.posix.normalize(input.relativePath);
	if (
		!normalizedRelativePath ||
		normalizedRelativePath === "." ||
		normalizedRelativePath.startsWith("../") ||
		path.posix.isAbsolute(normalizedRelativePath)
	) {
		throw new Error(
			`Invalid task artifact relative path: ${input.relativePath}`,
		);
	}
	const hostPath = path.join(input.taskDir, normalizedRelativePath);
	await fs.mkdir(path.dirname(hostPath), { recursive: true });
	await fs.writeFile(hostPath, input.value, "utf-8");
	return path.posix.join(TASK_ROOT_IN_CONTAINER, normalizedRelativePath);
};

export const readTaskJsonArtifact = async <T = unknown>(input: {
	taskDir: string;
	containerPath: string;
}): Promise<T> => {
	const hostPath = taskArtifactHostPath(input);
	const content = await fs.readFile(hostPath, "utf-8");
	return JSON.parse(content) as T;
};

export const copyTaskJsonArtifact = async (input: {
	fromTaskDir: string;
	fromContainerPath: string;
	toTaskDir: string;
	toRelativePath: string;
}) => {
	const sourcePath = taskArtifactHostPath({
		taskDir: input.fromTaskDir,
		containerPath: input.fromContainerPath,
	});
	const normalizedTarget = path.posix.normalize(input.toRelativePath);
	if (
		!normalizedTarget ||
		normalizedTarget === "." ||
		normalizedTarget.startsWith("../") ||
		path.posix.isAbsolute(normalizedTarget)
	) {
		throw new Error(
			`Invalid target artifact relative path: ${input.toRelativePath}`,
		);
	}
	const targetPath = path.join(input.toTaskDir, normalizedTarget);
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.copyFile(sourcePath, targetPath);
	return path.posix.join(TASK_ROOT_IN_CONTAINER, normalizedTarget);
};
