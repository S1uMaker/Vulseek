import { readdir } from "node:fs/promises";
import path from "node:path";

export type NativeAgentTranscriptProvider = "codex" | "claude-code" | "grok";

type FindNativeAgentTranscriptInput = {
	roots: string[];
	provider: NativeAgentTranscriptProvider;
	threadId: string | null | undefined;
};

export const buildNativeAgentTranscriptRoots = ({
	runtimeDir,
	scanJobId,
}: {
	runtimeDir: string;
	scanJobId: string;
}) => {
	const resolved = path.resolve(runtimeDir);
	const parts = resolved.split(path.sep);
	const scanJobIndex = parts.lastIndexOf(scanJobId);
	if (scanJobIndex <= 0 || parts[scanJobIndex - 1] !== "jobs") {
		return [];
	}
	return [parts.slice(0, scanJobIndex + 1).join(path.sep)];
};

const isSafeThreadId = (threadId: string) =>
	threadId.length > 0 &&
	threadId !== "." &&
	threadId !== ".." &&
	!/[\\/]/.test(threadId);

const matchesTranscript = (
	name: string,
	provider: NativeAgentTranscriptProvider,
	threadId: string,
) => {
	if (!name.endsWith(".jsonl")) {
		return false;
	}

	if (provider === "claude-code") {
		return name === `${threadId}.jsonl`;
	}
	if (provider === "grok") {
		return false;
	}

	return (
		name.startsWith("rollout-") && name.slice(0, -6).endsWith(`-${threadId}`)
	);
};

const findInDirectory = async (
	directory: string,
	provider: NativeAgentTranscriptProvider,
	threadId: string,
): Promise<string | null> => {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (provider === "grok" && entry.name === threadId) {
				const eventsPath = path.join(entryPath, "events.jsonl");
				const chatPath = path.join(entryPath, "chat_history.jsonl");
				const events = await readdir(entryPath, { withFileTypes: true }).catch(
					() => [],
				);
				const names = new Set(
					events.filter((item) => item.isFile()).map((item) => item.name),
				);
				if (names.has("chat_history.jsonl")) {
					return chatPath;
				}
				if (names.has("events.jsonl")) {
					return eventsPath;
				}
			}
			const match = await findInDirectory(entryPath, provider, threadId);
			if (match) {
				return match;
			}
			continue;
		}
		if (entry.isFile() && matchesTranscript(entry.name, provider, threadId)) {
			return entryPath;
		}
	}
	return null;
};

export const findNativeAgentTranscript = async ({
	roots,
	provider,
	threadId,
}: FindNativeAgentTranscriptInput): Promise<string | null> => {
	if (!threadId || !isSafeThreadId(threadId)) {
		return null;
	}

	const directoryName = provider === "claude-code" ? "projects" : "sessions";
	for (const root of roots) {
		const agentHomeRoot = path.join(root, "agent-home");
		const homes = await listProfileAgentHomes(agentHomeRoot);
		for (const home of homes) {
			const match = await findInDirectory(
				path.join(home, directoryName),
				provider,
				threadId,
			);
			if (match) {
				return match;
			}
		}
	}
	return null;
};

const listProfileAgentHomes = async (agentHomeRoot: string) => {
	const entries = await readdir(agentHomeRoot, { withFileTypes: true }).catch(
		() => [],
	);
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(agentHomeRoot, entry.name));
};
