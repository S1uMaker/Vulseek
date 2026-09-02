import { promises as fs } from "node:fs";
import path from "node:path";

export const AGENT_RUNTIME_FILE_NAMES = {
	stdin: "stdin",
	stdout: "stdout",
} as const;

const pendingStdinWrites = new Map<string, Promise<void>>();

export const appendStdinJsonLine = async (
	inputPath: string,
	value: unknown,
) => {
	const previousWrite =
		pendingStdinWrites.get(inputPath) || Promise.resolve();
	const currentWrite = previousWrite.catch(() => {}).then(async () => {
		await fs.mkdir(path.dirname(inputPath), { recursive: true });
		await fs.appendFile(
			inputPath,
			`${JSON.stringify(value)}\n`,
			"utf-8",
		);
	});
	pendingStdinWrites.set(inputPath, currentWrite);
	try {
		await currentWrite;
	} finally {
		if (pendingStdinWrites.get(inputPath) === currentWrite) {
			pendingStdinWrites.delete(inputPath);
		}
	}
};

export const initializeAgentRuntimeFiles = async (runtimeDir: string) => {
	await fs.mkdir(runtimeDir, { recursive: true });
	await fs.writeFile(
		path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.stdin),
		"",
		"utf-8",
	);
	await fs.writeFile(
		path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.stdout),
		"",
		"utf-8",
	);
};
