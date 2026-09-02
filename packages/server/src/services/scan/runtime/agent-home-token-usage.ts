import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveCheckoutToolsDefinition } from "../checkout-tools";
import {
	buildNativeAgentTranscriptRoots,
	findNativeAgentTranscript,
	type NativeAgentTranscriptProvider,
} from "../native-agent-transcript";
import {
	listTasksByScanJobIdRepo,
	syncScanJobTokenUsageFromTasksRepo,
	updateTaskRepo,
} from "../persistence/task.repo";
import { resolveScanJobRuntimeContext } from "../persistence/task-artifact-resolver";
import {
	type AgentHomeProfileRef,
	buildAgentProfileHomeDirName,
	remapScanContextAppPathToHost,
} from "./run-single-turn-agent";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const JOB_AGENT_HOME_DIR_NAME = "agent-home";
const CCUSAGE_TIMEOUT_MS = 30_000;
const SESSION_RETRY_DELAY_MS = 250;

export type AgentHomeTokenProvider = "claude_code" | "codex" | "grok_build";

export type AgentHomeTokenUsage = {
	inputTokens: number;
	outputTokens: number;
	thoughtTokens: number;
	totalTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	estimatedCost: number;
};

export type CcusageRunResult = {
	stdout: string;
	stderr: string;
	code: number;
};

export type CcusageRunner = (input: {
	args: string[];
	homeEnvName: string;
	agentHomePath: string;
}) => Promise<CcusageRunResult>;

type CcusageCliProvider = "claude" | "codex" | "grok";

const jobLocks = new Map<string, Promise<unknown>>();

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const toTokenCount = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.trunc(value)
		: 0;

const toCost = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

export const mapAgentHomeTokenProvider = (
	provider: string | null | undefined,
): AgentHomeTokenProvider | null => {
	if (
		provider === "claude_code" ||
		provider === "codex" ||
		provider === "grok_build"
	) {
		return provider;
	}
	return null;
};

const toCcusageCliProvider = (
	provider: AgentHomeTokenProvider,
): CcusageCliProvider => {
	if (provider === "claude_code") return "claude";
	if (provider === "grok_build") return "grok";
	return "codex";
};

const toTranscriptProvider = (
	provider: AgentHomeTokenProvider,
): NativeAgentTranscriptProvider => {
	if (provider === "claude_code") return "claude-code";
	if (provider === "grok_build") return "grok";
	return "codex";
};

const providerHomeEnvName = (provider: CcusageCliProvider) => {
	if (provider === "claude") return "CLAUDE_CONFIG_DIR";
	if (provider === "grok") return "GROK_HOME";
	return "CODEX_HOME";
};

const resolveScanContextAppRoot = async () => {
	const configured = process.env.VULSEEK_SCAN_CONTEXT_APP_PATH?.trim();
	if (configured) return configured;
	try {
		await fs.access(CONTAINER_SCAN_CONTEXT_ROOT);
		return CONTAINER_SCAN_CONTEXT_ROOT;
	} catch {
		return process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";
	}
};

export const resolveJobAgentHomePath = async (
	scanJobId: string,
	profile?: AgentHomeProfileRef,
) => {
	const context = await resolveScanJobRuntimeContext(scanJobId);
	const appRoot = await resolveScanContextAppRoot();
	if (!appRoot) {
		throw new Error(
			"Scan context app path is not configured for agent-home token usage",
		);
	}
	return path.join(
		appRoot,
		"projects",
		sanitizePathPart(context.projectName),
		"profiles",
		sanitizePathPart(context.serviceName),
		"jobs",
		scanJobId,
		JOB_AGENT_HOME_DIR_NAME,
		buildAgentProfileHomeDirName(profile),
	);
};

export const resolveCcusageSessionId = async (input: {
	provider: AgentHomeTokenProvider;
	threadId: string;
	agentHomePath: string;
	scanJobId?: string;
}): Promise<string | null> => {
	const threadId = input.threadId.trim();
	if (
		!threadId ||
		threadId === "." ||
		threadId === ".." ||
		/[\\/]/.test(threadId)
	) {
		return null;
	}
	if (input.provider === "claude_code" || input.provider === "grok_build") {
		return threadId;
	}
	const scanJobId =
		input.scanJobId?.trim() ||
		path.basename(path.dirname(path.dirname(input.agentHomePath)));
	const transcript = await findNativeAgentTranscript({
		roots: buildNativeAgentTranscriptRoots({
			runtimeDir: input.agentHomePath,
			scanJobId,
		}),
		provider: toTranscriptProvider(input.provider),
		threadId,
	});
	if (!transcript) {
		return null;
	}
	const sessionsDir = path.join(input.agentHomePath, "sessions");
	const relative = path.relative(sessionsDir, transcript);
	if (!relative || relative.startsWith("..")) {
		return null;
	}
	return relative
		.replace(/\.jsonl$/i, "")
		.split(path.sep)
		.join("/");
};

const sumUsage = (left: AgentHomeTokenUsage, right: AgentHomeTokenUsage) => ({
	inputTokens: left.inputTokens + right.inputTokens,
	outputTokens: left.outputTokens + right.outputTokens,
	thoughtTokens: left.thoughtTokens + right.thoughtTokens,
	cachedReadTokens: left.cachedReadTokens + right.cachedReadTokens,
	cachedWriteTokens: left.cachedWriteTokens + right.cachedWriteTokens,
	estimatedCost: left.estimatedCost + right.estimatedCost,
	totalTokens: 0,
});

const withTotal = (
	usage: Omit<AgentHomeTokenUsage, "totalTokens">,
): AgentHomeTokenUsage => ({
	...usage,
	totalTokens:
		usage.inputTokens +
		usage.outputTokens +
		usage.cachedReadTokens +
		usage.cachedWriteTokens,
});

const usageFromRow = (row: Record<string, unknown>): AgentHomeTokenUsage =>
	withTotal({
		inputTokens: toTokenCount(row.inputTokens ?? row.input_tokens),
		outputTokens: toTokenCount(row.outputTokens ?? row.output_tokens),
		thoughtTokens: toTokenCount(
			row.thoughtTokens ??
				row.reasoningOutputTokens ??
				row.reasoning_output_tokens,
		),
		cachedReadTokens: toTokenCount(
			row.cachedReadTokens ?? row.cacheReadTokens ?? row.cache_read_tokens,
		),
		cachedWriteTokens: toTokenCount(
			row.cachedWriteTokens ??
				row.cacheCreationTokens ??
				row.cache_creation_tokens,
		),
		estimatedCost: toCost(row.totalCost ?? row.costUSD ?? row.cost),
	});

const emptyUsage = () =>
	withTotal({
		inputTokens: 0,
		outputTokens: 0,
		thoughtTokens: 0,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
		estimatedCost: 0,
	});

const withRootCost = (
	usage: AgentHomeTokenUsage,
	root: Record<string, unknown>,
) =>
	usage.estimatedCost > 0
		? usage
		: {
				...usage,
				estimatedCost: toCost(root.totalCost ?? root.costUSD ?? root.cost),
			};

export const parseCcusageSessionOutput = (
	raw: string,
): AgentHomeTokenUsage | null => {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "null") {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const root = asRecord(parsed);
	if (!root) {
		return null;
	}
	if (Array.isArray(root.entries)) {
		const summed = withRootCost(
			root.entries.reduce<AgentHomeTokenUsage>((total, entry) => {
				const row = asRecord(entry);
				return row ? withTotal(sumUsage(total, usageFromRow(row))) : total;
			}, emptyUsage()),
			root,
		);
		return summed.inputTokens +
			summed.outputTokens +
			summed.cachedReadTokens +
			summed.cachedWriteTokens >
			0
			? summed
			: null;
	}
	const totals = asRecord(root.totals);
	if (totals) {
		const usage = usageFromRow(totals);
		if (
			usage.inputTokens +
				usage.outputTokens +
				usage.cachedReadTokens +
				usage.cachedWriteTokens >
			0
		) {
			return usage;
		}
	}
	const sessions = Array.isArray(root.sessions) ? root.sessions : null;
	if (sessions?.length === 1) {
		const row = asRecord(sessions[0]);
		return row ? usageFromRow(row) : null;
	}
	if (
		"inputTokens" in root ||
		"cacheReadTokens" in root ||
		"outputTokens" in root
	) {
		return usageFromRow(root);
	}
	return null;
};

export const selectCcusageSessionUsage = (
	raw: string,
	sessionId: string,
): AgentHomeTokenUsage | null => {
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "null") {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const root = asRecord(parsed);
	if (!root) {
		return parseCcusageSessionOutput(raw);
	}
	const sessions = Array.isArray(root.sessions) ? root.sessions : null;
	if (sessions) {
		const match = sessions
			.map((entry) => asRecord(entry))
			.find((row) => {
				const id = row?.sessionId;
				return (
					typeof id === "string" &&
					(id === sessionId ||
						id.endsWith(`/${sessionId}`) ||
						id.endsWith(`-${sessionId}`))
				);
			});
		return match ? usageFromRow(match) : null;
	}
	return parseCcusageSessionOutput(raw);
};

const spawnCommand = (
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<CcusageRunResult> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`ccusage timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 1 });
		});
	});

const defaultCcusageRunner: CcusageRunner = async (input) => {
	const localBin = process.env.CCUSAGE_BIN?.trim() || "ccusage";
	const localEnv = {
		...process.env,
		CI: "1",
		[input.homeEnvName]: input.agentHomePath,
	};
	try {
		const local = await spawnCommand(
			localBin,
			input.args,
			localEnv,
			CCUSAGE_TIMEOUT_MS,
		);
		if (local.code === 0 || process.env.CCUSAGE_BIN?.trim()) {
			return local;
		}
		if (local.code !== 127) {
			return local;
		}
	} catch (error) {
		if (process.env.CCUSAGE_BIN?.trim()) {
			throw error;
		}
		if (error && typeof error === "object" && "code" in error) {
			const code = (error as { code?: unknown }).code;
			if (code !== "ENOENT") {
				throw error;
			}
		} else {
			throw error;
		}
	}
	const definition = await resolveCheckoutToolsDefinition();
	const hostAgentHome = remapScanContextAppPathToHost(input.agentHomePath);
	const dockerArgs = [
		"run",
		"--rm",
		"-v",
		`${hostAgentHome}:/agent-home:ro`,
		"-e",
		`${input.homeEnvName}=/agent-home`,
		definition.imageTag,
		"ccusage",
		...input.args,
	];
	return await spawnCommand(
		"docker",
		dockerArgs,
		process.env,
		CCUSAGE_TIMEOUT_MS,
	);
};

const withJobLock = async <T>(scanJobId: string, work: () => Promise<T>) => {
	const previous = jobLocks.get(scanJobId) ?? Promise.resolve();
	let finish = () => {};
	const current = new Promise<void>((resolve) => {
		finish = resolve;
	});
	jobLocks.set(
		scanJobId,
		previous.catch(() => {}).then(() => current),
	);
	await previous.catch(() => {});
	try {
		return await work();
	} finally {
		finish();
	}
};

const logTokenUsage = (event: string, details: Record<string, unknown>) => {
	console.log("[scan-token-usage]", JSON.stringify({ event, ...details }));
};

const runCcusageSession = async (input: {
	provider: AgentHomeTokenProvider;
	agentHomePath: string;
	sessionId: string;
	runner?: CcusageRunner;
}): Promise<AgentHomeTokenUsage | null> => {
	const cliProvider = toCcusageCliProvider(input.provider);
	const args =
		cliProvider === "claude"
			? [
					"claude",
					"session",
					"--id",
					input.sessionId,
					"--json",
					"--mode",
					"calculate",
				]
			: [cliProvider, "session", "--json", "--mode", "calculate"];
	const runner = input.runner ?? defaultCcusageRunner;
	const result = await runner({
		args,
		homeEnvName: providerHomeEnvName(cliProvider),
		agentHomePath: input.agentHomePath,
	});
	if (result.code !== 0) {
		logTokenUsage("ccusage.failed", {
			provider: cliProvider,
			sessionId: input.sessionId,
			code: result.code,
			stderr: result.stderr.slice(0, 500),
		});
		return null;
	}
	return cliProvider === "claude"
		? parseCcusageSessionOutput(result.stdout)
		: selectCcusageSessionUsage(result.stdout, input.sessionId);
};

export const readAgentHomeSessionTokenUsage = async (input: {
	scanJobId: string;
	threadId: string | null | undefined;
	provider: string | null | undefined;
	agentProfile?: AgentHomeProfileRef;
	runner?: CcusageRunner;
}): Promise<AgentHomeTokenUsage | null> => {
	const provider = mapAgentHomeTokenProvider(input.provider);
	const threadId = input.threadId?.trim();
	if (!provider || !threadId) {
		return null;
	}
	const agentHomePath = await resolveJobAgentHomePath(
		input.scanJobId,
		input.agentProfile,
	);
	const load = async () => {
		const sessionId = await resolveCcusageSessionId({
			provider,
			threadId,
			agentHomePath,
			scanJobId: input.scanJobId,
		});
		if (!sessionId) {
			return null;
		}
		return await runCcusageSession({
			provider,
			agentHomePath,
			sessionId,
			runner: input.runner,
		});
	};
	return await withJobLock(input.scanJobId, async () => {
		const first = await load();
		if (first) return first;
		await sleep(SESSION_RETRY_DELAY_MS);
		return await load();
	});
};

export const persistTaskAgentHomeTokenUsage = async (input: {
	taskId: string;
	scanJobId: string;
	threadId?: string | null;
	provider?: string | null;
	agentProfile?: AgentHomeProfileRef;
	runner?: CcusageRunner;
}): Promise<AgentHomeTokenUsage | null> => {
	const usage = await readAgentHomeSessionTokenUsage({
		scanJobId: input.scanJobId,
		threadId: input.threadId,
		provider: input.provider,
		agentProfile: input.agentProfile,
		runner: input.runner,
	});
	if (!usage) {
		return null;
	}
	await updateTaskRepo(input.taskId, usage);
	logTokenUsage("task.updated", {
		scanJobId: input.scanJobId,
		taskId: input.taskId,
		threadId: input.threadId ?? null,
		...usage,
	});
	return usage;
};

export const persistJobAgentHomeTokenUsage = async (input: {
	scanJobId: string;
	runner?: CcusageRunner;
}) => {
	const tasks = await listTasksByScanJobIdRepo(input.scanJobId);
	for (const task of tasks) {
		if (!task.threadId || !task.agentProfile?.provider) {
			continue;
		}
		await persistTaskAgentHomeTokenUsage({
			taskId: task.taskId,
			scanJobId: input.scanJobId,
			threadId: task.threadId,
			provider: task.agentProfile.provider,
			agentProfile: task.agentProfile,
			runner: input.runner,
		}).catch((error) => {
			logTokenUsage("task.failed", {
				scanJobId: input.scanJobId,
				taskId: task.taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
	await syncScanJobTokenUsageFromTasksRepo(input.scanJobId);
	logTokenUsage("job.synced", { scanJobId: input.scanJobId });
};
