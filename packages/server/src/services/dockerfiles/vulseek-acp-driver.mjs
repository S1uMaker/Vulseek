import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export const VULSEEK_ACP_DRIVER_VERSION = "2026-09-01-runtime-notify-goal-watch";
const SESSION_STEERING_METHOD = "_session/steering";
const RUNTIME_NOTIFY_TYPE = "runtime_notify";
const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const SNAPSHOT_DEBOUNCE_MS = 150;
const TERMINAL_TOOL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"rejected",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asRecord = (value) =>
	value && typeof value === "object" && !Array.isArray(value) ? value : {};
const isRuntimeNotify = (value) =>
	asRecord(value).type === RUNTIME_NOTIFY_TYPE;
const runtimeNotifyPromptText = (notify) => {
	const count = Number(asRecord(notify).messageCount);
	return `Inbound message count changed to ${Number.isFinite(count) ? count : "unknown"}.`;
};
const asString = (value) => (typeof value === "string" ? value : "");
const CLAUDE_REASONING_EFFORTS = new Set([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const CLAUDE_EFFORT_CONFIG_ID = "effort";

export const mapClaudeReasoningEffort = (thinkingLevel) => {
	const value = asString(thinkingLevel).trim().toLowerCase();
	if (!value) return null;
	if (CLAUDE_REASONING_EFFORTS.has(value)) return value;
	if (value === "minimal") return "low";
	if (value === "extra high" || value === "extra-high" || value === "highest") {
		return "xhigh";
	}
	return "high";
};

const claudeEffortFromTaskInput = (taskInput) =>
	taskInput?.provider === "claude"
		? mapClaudeReasoningEffort(taskInput.thinkingLevel)
		: null;

const claudeSettingsEffort = (effort) => (effort === "max" ? "xhigh" : effort);

const claudeEffortSessionMeta = (effort) => {
	const persisted = claudeSettingsEffort(effort);
	if (!persisted) return undefined;
	return {
		claudeCode: {
			options: {
				settings: {
					effortLevel: persisted,
				},
			},
		},
	};
};

const hasClaudeEffortConfigOption = (configOptions) =>
	Array.isArray(configOptions) &&
	configOptions.some(
		(option) => asRecord(option).id === CLAUDE_EFFORT_CONFIG_ID,
	);

const sessionSetConfigOptionMethod = () =>
	acp.methods?.agent?.session?.setConfigOption || "session/set_config_option";

const applyClaudeSessionEffort = async (ctx, sessionId, sessionResult, effort) => {
	if (!effort || !sessionId || !hasClaudeEffortConfigOption(sessionResult?.configOptions)) {
		return false;
	}
	await ctx.request(sessionSetConfigOptionMethod(), {
		sessionId,
		configId: CLAUDE_EFFORT_CONFIG_ID,
		value: effort,
	});
	return true;
};


const resolveRuntimeIdentity = (taskInput) => ({
	scanJobId:
		asString(taskInput.scanJobId) || process.env.VULSEEK_SCAN_JOB_ID || "",
	taskId: asString(taskInput.taskId),
	stageName: asString(taskInput.stageName),
});

const runtimeIdentityEnvironment = (identity) => ({
	...(identity.scanJobId ? { VULSEEK_SCAN_JOB_ID: identity.scanJobId } : {}),
	...(identity.taskId ? { VULSEEK_TASK_ID: identity.taskId } : {}),
	...(identity.stageName ? { VULSEEK_STAGE_NAME: identity.stageName } : {}),
});

const setRuntimeIdentityEnvironment = (taskInput) => {
	const identity = resolveRuntimeIdentity(taskInput);
	const values = {
		VULSEEK_SCAN_JOB_ID: identity.scanJobId,
		VULSEEK_TASK_ID: identity.taskId,
		VULSEEK_STAGE_NAME: identity.stageName,
	};
	for (const [key, value] of Object.entries(values)) {
		if (value) {
			process.env[key] = value;
		} else {
			delete process.env[key];
		}
	}
	return identity;
};

const pendingProtocolWrites = new Map();

const appendProtocolEvent = async (filePath, event) => {
	if (!filePath) return;
	const previousWrite = pendingProtocolWrites.get(filePath) || Promise.resolve();
	const currentWrite = previousWrite.catch(() => {}).then(async () => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
	});
	pendingProtocolWrites.set(filePath, currentWrite);
	try {
		await currentWrite;
	} finally {
		if (pendingProtocolWrites.get(filePath) === currentWrite) {
			pendingProtocolWrites.delete(filePath);
		}
	}
};

const resolveNormalizerPath = () =>
	process.env.VULSEEK_AGENT_EVENTS_PATH || "/opt/vulseek-acp/agent-events.mjs";

const activityForEvent = (event) => {
	if (event.kind === "thinking")
		return { kind: "reasoning", label: "Thinking" };
	if (event.kind === "plan") return { kind: "planning", label: "Planning" };
	if (event.kind === "text") return { kind: "writing", label: "Writing" };
	if (event.kind === "goal") {
		if (!event.goal) return { kind: "goal", label: "Goal cleared", goal: null };
		return {
			kind: "goal",
			label: `Goal ${event.goal.status}`,
			detail: event.goal.objective,
			goal: event.goal,
		};
	}
	if (event.kind === "task" && event.status === "completed") {
		return {
			kind: "goal",
			label: "Task completed",
			task: { status: "completed" },
		};
	}
	if (event.kind !== "tool") return null;
	const tool = event.tool_call;
	const names = {
		Bash: ["command", "Bash"],
		Edit: ["writing", "Editing"],
		Write: ["writing", "Writing"],
		Read: ["tool", "Reading"],
		Glob: ["tool", "Searching files"],
		Grep: ["tool", "Searching code"],
		WebSearch: ["web", "Web Search"],
		WebFetch: ["web", "Web Fetch"],
	};
	const [kind, label] = names[tool.name] || ["tool", tool.name || "Tool"];
	const input = asRecord(tool.input);
	const detail = asString(
		input.command || input.file_path || input.query || input.url,
	).slice(0, 240);
	return {
		kind,
		label: TERMINAL_TOOL_STATUSES.has(tool.status)
			? `${label} ${tool.is_error ? "failed" : "completed"}`
			: label,
		...(detail ? { detail } : {}),
		toolCallId: tool.tool_use_id,
	};
};

const createSnapshotWriter = (initialInput, sessionIdRef) => {
	let input = initialInput;
	let timer = null;
	let pendingActivity = null;
	const write = async (status, activity) => {
		await appendProtocolEvent(input.stdoutPath, {
			type: "activity",
			taskId: input.taskId || null,
			sessionId: sessionIdRef.current || null,
			status,
			activity,
		});
	};
	return {
		setInput(nextInput) {
			input = nextInput;
			pendingActivity = null;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		async immediate(status, activity) {
			if (timer) clearTimeout(timer);
			timer = null;
			pendingActivity = null;
			await write(status, activity);
		},
		schedule(activity) {
			pendingActivity = activity;
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				const next = pendingActivity;
				pendingActivity = null;
				if (next) void write("running", next);
			}, SNAPSHOT_DEBOUNCE_MS);
		},
		async flush() {
			if (timer) clearTimeout(timer);
			timer = null;
			const next = pendingActivity;
			pendingActivity = null;
			if (next) await write("running", next);
		},
	};
};

const isPathInside = (candidate, root) =>
	candidate === root || candidate.startsWith(`${root}${path.sep}`);
const resolveAllowedPath = async (requestedPath, roots, forWrite = false) => {
	const absolute = path.resolve(requestedPath);
	const checkPath = forWrite ? path.dirname(absolute) : absolute;
	const real = await fs.realpath(checkPath);
	const allowed = await Promise.all(
		roots.map((root) => fs.realpath(root).catch(() => path.resolve(root))),
	);
	if (!allowed.some((root) => isPathInside(real, root))) {
		throw new Error(
			`ACP filesystem request is outside allowed roots: ${requestedPath}`,
		);
	}
	return absolute;
};

const choosePermission = (params) => {
	const options = Array.isArray(params.options) ? params.options : [];
	const selected =
		options.find((option) => option.kind === "allow_always") ||
		options.find((option) => option.kind === "allow_once");
	return selected
		? { outcome: { outcome: "selected", optionId: selected.optionId } }
		: { outcome: { outcome: "cancelled" } };
};

const IDLE_WATCH = { current: null };

const bumpAgentAcpIdle = () => {
	IDLE_WATCH.current?.bump();
};

const withTimeout = async (
	promise,
	timeoutMs,
	onTimeout,
	timeoutMessage = `ACP prompt timed out after ${Math.round(timeoutMs / 1000)}s without agent response`,
) => {
	let timer;
	let finished = false;
	let rejectIdle;
	const timeoutError = new Error(timeoutMessage);
	const clearTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	const arm = () => {
		if (finished) return;
		clearTimer();
		timer = setTimeout(() => {
			void (async () => {
				if (finished) return;
				finished = true;
				clearTimer();
				await onTimeout().catch(() => {});
				rejectIdle?.(timeoutError);
			})();
		}, Math.max(1, timeoutMs));
	};
	const watch = {
		bump() {
			arm();
		},
		clear() {
			finished = true;
			clearTimer();
			if (IDLE_WATCH.current === watch) {
				IDLE_WATCH.current = null;
			}
		},
	};
	IDLE_WATCH.current = watch;
	try {
		const candidates = [
			promise,
			new Promise((_, reject) => {
				rejectIdle = reject;
				arm();
			}),
		];
		return await Promise.race(candidates);
	} finally {
		watch.clear();
	}
};

const updateTaskAlias = async (input) => {
	const alias = input.taskAliasRootInContainer;
	const target = input.taskStageRootInContainer;
	if (!alias || !target || alias === target) return;
	await fs.mkdir(target, { recursive: true });
	await fs.rm(alias, { recursive: true, force: true });
	await fs.symlink(target, alias, "dir");
};

const writeTaskEvent = async (input, event) =>
	appendProtocolEvent(input.stdoutPath, event);

const assertCapability = (capabilities, name) => {
	const session =
		capabilities?.sessionCapabilities || capabilities?.session || {};
	if (!session[name])
		throw new Error(`ACP adapter does not support session/${name}`);
};

const hasGoalV1Capability = (initialized) => {
	const goal = asRecord(initialized?._meta).goal;
	return (
		goal?.version === 1 &&
		goal?.controlMethod === "_session/goal" &&
		Array.isArray(goal.actions)
	);
};

const hasGrokGoalCommand = (initialized) => {
	const commands = asRecord(initialized?._meta).availableCommands;
	if (!Array.isArray(commands)) {
		return false;
	}
	return commands.some((command) => asRecord(command).name === "goal");
};

const hasGoalCapability = (initialized) =>
	hasGoalV1Capability(initialized) || hasGrokGoalCommand(initialized);

const GROK_ACP_WIRE_LOG_PATH =
	process.env.VULSEEK_ACP_WIRE_LOG || "/tmp/vulseek-acp-wire.jsonl";

const GROK_SESSION_UPDATE_METHODS = new Set([
	"session/update",
	"_x.ai/session/update",
	"x.ai/session/update",
	"_x.ai/session_update",
	"x.ai/session_update",
	"_x.ai/session_notification",
	"x.ai/session_notification",
]);

const ACP_SESSION_UPDATES = new Set([
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
	"plan",
	"available_commands_update",
	"current_mode_update",
	"config_option_update",
	"session_info_update",
	"usage_update",
]);

const mapGrokGoalStatus = (status) => {
	if (status === "completed" || status === "complete") {
		return "complete";
	}
	if (status === "active" || status === "blocked") {
		return status;
	}
	if (
		status === "paused" ||
		status === "user_paused" ||
		status === "back_off_paused" ||
		status === "no_progress_paused" ||
		status === "infra_paused"
	) {
		return "paused";
	}
	if (status === "limited" || status === "budget_limited") {
		return "limited";
	}
	return null;
};

const grokSessionId = (params, update) =>
	params.sessionId ||
	params.session_id ||
	update.sessionId ||
	update.session_id ||
	null;

const grokUpdateFromMessage = (message) => {
	const params = asRecord(message?.params);
	const nested = asRecord(params.update);
	if (asString(nested.sessionUpdate)) {
		return { params, update: nested };
	}
	if (asString(params.sessionUpdate)) {
		return { params, update: params };
	}
	return { params, update: nested };
};

const rewriteAsSessionUpdate = (message, update) => {
	const { params } = grokUpdateFromMessage(message);
	const sessionId = grokSessionId(params, asRecord(params.update));
	const meta = params._meta ?? params.meta;
	return {
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			...(sessionId ? { sessionId } : {}),
			update,
			...(meta !== undefined ? { _meta: meta } : {}),
		},
	};
};

const rewriteGrokAcpMessage = (message) => {
	if (!GROK_SESSION_UPDATE_METHODS.has(message?.method)) {
		return message;
	}
	const { update } = grokUpdateFromMessage(message);
	const type = update.sessionUpdate;
	if (type === "goal_updated") {
		const status = mapGrokGoalStatus(update.status);
		const objective = asString(update.objective).trim();
		if (!status || !objective) {
			return message;
		}
		return rewriteAsSessionUpdate(message, {
			sessionUpdate: "session_info_update",
			_meta: {
				goal: {
					objective,
					status,
					controlMethod: "_session/goal",
				},
			},
		});
	}
	if (type === "turn_completed") {
		return rewriteAsSessionUpdate(message, {
			sessionUpdate: "session_info_update",
			_meta: { turn: { status: "completed" } },
		});
	}
	if (message.method !== "session/update" && ACP_SESSION_UPDATES.has(type)) {
		return rewriteAsSessionUpdate(message, update);
	}
	return message;
};

const appendGrokAcpWireLog = (entry) => {
	try {
		fsSync.appendFileSync(GROK_ACP_WIRE_LOG_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		// Wire logging is diagnostic only; never block ACP.
	}
};

const inspectGrokAcpLine = (line) => {
	try {
		const message = JSON.parse(line);
		const { params, update } = grokUpdateFromMessage(message);
		const rewritten = rewriteGrokAcpMessage(message);
		bumpAgentAcpIdle();
		appendGrokAcpWireLog({
			ts: new Date().toISOString(),
			jsonrpc: message.jsonrpc ?? null,
			method: message.method ?? null,
			id: Object.hasOwn(message, "id") ? message.id : null,
			sessionId: grokSessionId(params, update),
			sessionUpdate: update.sessionUpdate || null,
			status: update.status ?? null,
			stop_reason: update.stop_reason ?? update.stopReason ?? null,
			rewrittenMethod: rewritten?.method ?? null,
			rewrittenSessionUpdate:
				asRecord(asRecord(rewritten?.params).update).sessionUpdate || null,
		});
		return JSON.stringify(rewritten);
	} catch (error) {
		appendGrokAcpWireLog({
			ts: new Date().toISOString(),
			parseError: String(error?.message || error),
			prefix: line.slice(0, 180),
		});
		return line;
	}
};

const createGrokAcpStdoutFilter = () => {
	let buffer = "";
	return new Transform({
		transform(chunk, _encoding, callback) {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			const rewritten = [];
			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				rewritten.push(inspectGrokAcpLine(line));
			}
			if (!rewritten.length) {
				callback();
				return;
			}
			callback(null, `${rewritten.join("\n")}\n`);
		},
		flush(callback) {
			if (!buffer.trim()) {
				callback();
				return;
			}
			callback(null, `${inspectGrokAcpLine(buffer)}\n`);
		},
	});
};

const isNativeGoalPrompt = (prompt) => /^\s*\/goal(?:\s|$)/i.test(prompt);

const stripGoalPrefix = (prompt) =>
	prompt.replace(/^\s*\/goal(?:\s+|$)/i, "").trim();

const prefixNativeGoal = (prompt) => {
	const trimmed = String(prompt ?? "").trim();
	if (!trimmed) return trimmed;
	return isNativeGoalPrompt(trimmed) ? trimmed : `/goal ${trimmed}`;
};

const textPart = (text) => {
	const trimmed = String(text ?? "").trim();
	return trimmed ? { type: "text", text: trimmed } : null;
};

const resolveGoalPromptParts = ({
	prompt,
	followUpPrompt,
	outputProtocolPrompt,
	goalEnabled,
	goalPreserving,
	goalSetThisSession,
	preservedGoalPrompt,
	initialGoalPrompt,
	lastGoalStatus,
}) => {
	const raw = String(prompt ?? "").trim();
	const protocol = String(outputProtocolPrompt ?? "").trim();
	const saved = String(preservedGoalPrompt || initialGoalPrompt || "").trim();
	const explicitFollowUp = String(followUpPrompt ?? "").trim();
	const followUp =
		explicitFollowUp ||
		(saved && raw && stripGoalPrefix(raw) !== saved ? raw : "");
	const push = (parts, text) => {
		const part = textPart(text);
		if (part) parts.push(part);
	};

	if (!goalEnabled) {
		const parts = [];
		push(parts, raw);
		push(parts, followUp);
		push(parts, protocol);
		return { parts, recordFirst: false, resetStatus: false, recordedInitial: null };
	}

	const needSetGoal =
		!goalSetThisSession ||
		(Boolean(goalPreserving) && lastGoalStatus === "complete");
	const initial = saved || (!followUp ? stripGoalPrefix(raw) : "");
	const parts = [];
	if (needSetGoal && initial) {
		push(parts, prefixNativeGoal(initial));
	}
	if (followUp) {
		push(parts, followUp);
	} else if (!needSetGoal && raw) {
		push(parts, raw);
	}
	push(parts, protocol);
	return {
		parts,
		recordFirst: Boolean(goalPreserving) && !saved && Boolean(initial),
		resetStatus: needSetGoal,
		recordedInitial: !saved && initial ? stripGoalPrefix(initial) : null,
	};
};

let lastInputForError = null;

const run = async () => {
	const inputPath = process.argv[2] || process.env.VULSEEK_ACP_DRIVER_INPUT_PATH;
	if (!inputPath) {
		throw new Error("ACP driver input JSONL path is required");
	}

	let inputOffset = 0;
	let inputRemainder = "";
	let pendingLines = [];
	let stopRequested = false;
	const readAvailableInput = async () => {
		const fileStat = await fs.stat(inputPath).catch(() => null);
		if (!fileStat || !fileStat.isFile()) return;
		if (fileStat.size < inputOffset) {
			inputOffset = 0;
			inputRemainder = "";
			pendingLines = [];
		}
		const length = fileStat.size - inputOffset;
		if (length <= 0) return;
		const handle = await fs.open(inputPath, "r");
		try {
			const buffer = Buffer.alloc(length);
			const result = await handle.read(buffer, 0, length, inputOffset);
			inputOffset += result.bytesRead;
			const text = `${inputRemainder}${buffer.toString("utf-8", 0, result.bytesRead)}`;
			const lines = text.split("\n");
			inputRemainder = lines.pop() || "";
			pendingLines.push(...lines.map((line) => line.replace(/\r$/, "")));
		} finally {
			await handle.close();
		}
	};
	const takeRuntimeNotifies = async () => {
		await readAvailableInput();
		const remaining = [];
		const notifies = [];
		while (pendingLines.length) {
			const line = pendingLines.shift();
			if (!line || !line.trim()) continue;
			try {
				const value = JSON.parse(line);
				if (isRuntimeNotify(value)) {
					notifies.push(value);
					continue;
				}
			} catch {
				remaining.push(line);
				continue;
			}
			remaining.push(line);
		}
		pendingLines.push(...remaining);
		return notifies;
	};
	const readNextTaskInput = async () => {
		while (!stopRequested) {
			await readAvailableInput();
			while (pendingLines.length) {
				const line = pendingLines.shift();
				if (!line || !line.trim()) continue;
				try {
					const value = JSON.parse(line);
					if (isRuntimeNotify(value)) continue;
					if (!value || typeof value !== "object" || Array.isArray(value)) {
						throw new Error("task input must be a JSON object");
					}
					lastInputForError = value;
					return value;
				} catch (error) {
					if (lastInputForError?.stdoutPath) {
						await appendProtocolEvent(lastInputForError.stdoutPath, {
							type: "log",
							level: "error",
							source: "driver",
							message: "invalid task input JSONL",
							error: error instanceof Error ? error.message : String(error),
						});
					}
					throw new Error(
						"Invalid task input JSONL: " +
							(error instanceof Error ? error.message : String(error)),
					);
				}
			}
			await sleep(50);
		}
		return null;
	};
	const initialInput = await readNextTaskInput();
	if (!initialInput) return false;
	const initialIdentity = setRuntimeIdentityEnvironment(initialInput);
	let activeInput = initialInput;
	await appendProtocolEvent(initialInput.stdoutPath, {
		type: "start",
		pid: process.pid,
	});
	const heartbeat = setInterval(() => {
		void appendProtocolEvent(activeInput.stdoutPath, {
			type: "log",
			level: "debug",
			source: "driver",
			message: "heartbeat",
		}).catch(
			() => {},
		);
	}, 15_000);
	heartbeat.unref();
	const normalizerModule = await import(
		new URL(`file://${resolveNormalizerPath()}`).href
	);
	const normalizer = normalizerModule.createAgentEventNormalizer({
		format:
			initialInput.provider === "claude" || initialInput.provider === "grok"
				? "claude-code"
				: "codex",
	});
	const sessionIdRef = { current: "" };
	const snapshots = createSnapshotWriter(activeInput, sessionIdRef);
	const roots = [
		initialInput.cwd,
		...(initialInput.additionalDirectories || []),
	].filter(Boolean);
	const defaultGrokArgs = [
		"agent",
		"--always-approve",
		"--no-leader",
		...(initialInput.model ? ["--model", String(initialInput.model)] : []),
		...(initialInput.thinkingLevel
			? ["--reasoning-effort", String(initialInput.thinkingLevel)]
			: []),
		"stdio",
	];
	const command =
		initialInput.adapterCommand ||
		(initialInput.provider === "claude"
			? "claude-agent-acp"
			: initialInput.provider === "grok"
				? "grok"
				: "codex-acp");
	const adapterArgs =
		initialInput.adapterArgs ||
		(initialInput.provider === "grok" && !initialInput.adapterCommand
			? defaultGrokArgs
			: []);
	const adapterHomeEnv = initialInput.agentHomePathInContainer
		? initialInput.provider === "claude"
			? { CLAUDE_CONFIG_DIR: initialInput.agentHomePathInContainer }
			: initialInput.provider === "grok"
				? { GROK_HOME: initialInput.agentHomePathInContainer }
				: { CODEX_HOME: initialInput.agentHomePathInContainer }
		: {};
	const adapterEnvironment = {
		...process.env,
		...(initialInput.adapterEnv || {}),
		...runtimeIdentityEnvironment(initialIdentity),
		...adapterHomeEnv,
	};
	const child = spawn(command, adapterArgs, {
		stdio: ["pipe", "pipe", "pipe"],
		env: adapterEnvironment,
	});
	child.stderr.on("data", (chunk) => {
		void appendProtocolEvent(activeInput.stdoutPath, {
			type: "log",
			level: "error",
			source: "agent",
			message: chunk.toString(),
		}).catch(() => {});
	});
	const childExit = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	let context = null;
	let promptActive = false;
	let notifyWatchActive = false;
	let goalCapabilityAvailable = false;
	let preservedGoalPrompt = null;
	let lastGoalStatus = null;
	let activeGoalCompletion = null;
	let goalSetThisSession = false;
	let promptTurnIndex = 0;
	let agentTurnIndex = 0;
	const cancel = async () => {
		if (context && sessionIdRef.current && promptActive) {
			await context.notify(acp.methods.agent.session.cancel, {
				sessionId: sessionIdRef.current,
			});
		}
	};
	const stop = async (signal) => {
		stopRequested = true;
		await cancel().catch(() => {});
		await appendProtocolEvent(activeInput.stdoutPath, {
			type: "log",
			level: "warn",
			source: "driver",
			message: `received ${signal}`,
		});
		child.kill("SIGTERM");
	};
	process.once("SIGTERM", () => void stop("SIGTERM"));
	process.once("SIGINT", () => void stop("SIGINT"));

	const stream = acp.ndJsonStream(
		Writable.toWeb(child.stdin),
		Readable.toWeb(child.stdout.pipe(createGrokAcpStdoutFilter())),
	);
	const client = acp
		.client({ name: "vulseek-acp-driver", version: VULSEEK_ACP_DRIVER_VERSION })
		.onRequest(acp.methods.client.session.requestPermission, (ctx) =>
			choosePermission(ctx.params),
		)
		.onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
			const filePath = await resolveAllowedPath(ctx.params.path, roots);
			return { content: await fs.readFile(filePath, "utf-8") };
		})
		.onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
			const filePath = await resolveAllowedPath(ctx.params.path, roots, true);
			await fs.writeFile(filePath, ctx.params.content, "utf-8");
			return {};
		})
		.onNotification(acp.methods.client.session.update, async (ctx) => {
			if (ctx.params.sessionId !== sessionIdRef.current) return;
			for (const event of normalizer.push(ctx.params)) {
				if (event.kind === "usage") {
					await appendProtocolEvent(activeInput.stdoutPath, {
						type: "usage",
						usage: {
							used: event.used,
							...(event.size !== undefined ? { contextSize: event.size } : {}),
						},
					});
					continue;
				}
				if (event.kind === "turn") {
					await appendProtocolEvent(activeInput.stdoutPath, {
						type: "turn_done",
						threadId: sessionIdRef.current || null,
						taskId: activeInput.taskId || null,
						turnIndex: ++agentTurnIndex,
						timestamp: new Date().toISOString(),
					});
					continue;
				}
				if (event.kind === "task") {
					if (event.status === "completed") {
						await appendProtocolEvent(activeInput.stdoutPath, {
							type: "log",
							level: "debug",
							source: "driver",
							message: "task_completed",
						});
					}
					const activity = activityForEvent(event);
					if (activity) await snapshots.immediate("running", activity);
					continue;
				}
				const activity = activityForEvent(event);
				if (!activity) continue;
				if (event.kind === "goal") {
					lastGoalStatus = event.goal?.status || null;
					if (event.goal?.status === "complete") {
						activeGoalCompletion?.markComplete();
					}
					await snapshots.immediate("running", activity);
					continue;
				}
				snapshots.schedule(activity);
			}
		});

	const result = await client.connectWith(stream, async (ctx) => {
		context = ctx;
		const initialized = await ctx.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
		});
		assertCapability(initialized.agentCapabilities, "resume");
		assertCapability(initialized.agentCapabilities, "close");
		goalCapabilityAvailable = hasGoalCapability(initialized);
		if (initialInput.goalEnabled && !goalCapabilityAvailable) {
			throw new Error("ACP adapter does not advertise Goal v1 capability");
		}
		const openSession = async () => {
			const effort = claudeEffortFromTaskInput(initialInput);
			const common = {
				cwd: initialInput.cwd,
				mcpServers: initialInput.mcpServers || [],
				additionalDirectories: initialInput.additionalDirectories || [],
				...(effort ? { _meta: claudeEffortSessionMeta(effort) } : {}),
			};
			let sessionId;
			let sessionResult = {};
			if (initialInput.threadId) {
				sessionResult = await ctx.request(acp.methods.agent.session.resume, {
					...common,
					sessionId: initialInput.threadId,
				});
				sessionId = initialInput.threadId;
			} else if (initialInput.sessionMode === "fork") {
				assertCapability(initialized.agentCapabilities, "fork");
				sessionResult = await ctx.request(acp.methods.agent.session.fork, {
					...common,
					sessionId: initialInput.parentSessionId,
				});
				sessionId = sessionResult.sessionId;
			} else {
				sessionResult = await ctx.request(
					acp.methods.agent.session.new,
					common,
				);
				sessionId = sessionResult.sessionId;
			}
			const applied = await applyClaudeSessionEffort(
				ctx,
				sessionId,
				sessionResult,
				effort,
			);
			if (effort) {
				await appendProtocolEvent(initialInput.stdoutPath, {
					type: "log",
					level: "info",
					source: "driver",
					message: applied
						? `claude_effort_set configId=${CLAUDE_EFFORT_CONFIG_ID} value=${effort}`
						: `claude_effort_requested value=${effort} via_session_meta=true`,
				});
			}
			return sessionId;
		};
		sessionIdRef.current = await openSession();
		await appendProtocolEvent(initialInput.stdoutPath, {
			type: "thread",
			threadId: sessionIdRef.current,
		});

		const runTask = async (taskInput) => {
			setRuntimeIdentityEnvironment(taskInput);
			if (taskInput.goalEnabled && !goalCapabilityAvailable) {
				throw new Error("ACP adapter does not advertise Goal v1 capability");
			}
			activeInput = taskInput;
			lastInputForError = taskInput;
			snapshots.setInput(taskInput);
			normalizer.reset();
			await updateTaskAlias(taskInput);
			await writeTaskEvent(taskInput, {
				type: "log",
				level: "debug",
				source: "driver",
				message: "task_input",
				input: taskInput,
			});
			await writeTaskEvent(taskInput, {
				type: "task_start",
				taskId: taskInput.taskId || null,
				sessionId: sessionIdRef.current,
			});
			await snapshots.immediate("running", {
				kind: "prompt",
				label: "Starting",
			});
			let grokFollowUp = null;
			const idleTimeoutMs = Number(
				taskInput.promptTimeoutMs || PROMPT_TIMEOUT_MS,
			);
			const sendPrompt = async (promptTextOrParts, timeoutMs) => {
				const promptParts = Array.isArray(promptTextOrParts)
					? promptTextOrParts.filter(
							(part) => part && typeof part.text === "string" && part.text.trim(),
						)
					: [{ type: "text", text: String(promptTextOrParts ?? "") }];
				const promptText = promptParts.map((part) => part.text).join("\n\n");
				const prompt = promptText ? [{ type: "text", text: promptText }] : [];
				if (promptText.trim()) {
					await appendProtocolEvent(taskInput.stdoutPath, {
						type: "vulseek_prompt",
						promptId: randomUUID(),
						taskId: taskInput.taskId || null,
						sessionId: sessionIdRef.current || null,
						turnIndex: ++promptTurnIndex,
						timestamp: new Date().toISOString(),
						text: promptText,
					});
				}
				const rpc = ctx.request(acp.methods.agent.session.prompt, {
					sessionId: sessionIdRef.current,
					prompt,
				});
				void rpc.catch(() => {});
				const response = await withTimeout(rpc, timeoutMs, cancel);
				await snapshots.flush();
				const usage = asRecord(response.usage);
				if (Object.keys(usage).length) {
					await appendProtocolEvent(taskInput.stdoutPath, {
						type: "usage",
						usage,
					});
				}
				return response;
			};
			const applyRuntimeNotify = async (notify) => {
				const text = runtimeNotifyPromptText(notify);
				await appendProtocolEvent(taskInput.stdoutPath, {
					type: "log",
					level: "info",
					source: "driver",
					message: `runtime_notify messageCount=${asRecord(notify).messageCount} provider=${taskInput.provider || "codex"}`,
				});
				if (taskInput.provider === "grok") {
					if (promptActive) {
						await cancel();
						return { followUp: text };
					}
					promptActive = true;
					try {
						await sendPrompt(text, idleTimeoutMs);
					} finally {
						promptActive = false;
					}
					return {};
				}
				if (!sessionIdRef.current) return {};
				try {
					const result = await ctx.request(SESSION_STEERING_METHOD, {
						sessionId: sessionIdRef.current,
						prompt: [{ type: "text", text }],
					});
					await appendProtocolEvent(taskInput.stdoutPath, {
						type: "log",
						level: "info",
						source: "driver",
						message: `runtime_notify_steered outcome=${asRecord(result).outcome || "ok"}`,
					});
				} catch (error) {
					await appendProtocolEvent(taskInput.stdoutPath, {
						type: "log",
						level: "warn",
						source: "driver",
						message: `runtime_notify_steer_failed ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				return {};
			};
			const watchRuntimeNotifies = () => {
				let stopped = false;
				const loop = (async () => {
					while (!stopped && notifyWatchActive && !stopRequested) {
						const notifies = await takeRuntimeNotifies();
						for (const notify of notifies) {
							if (stopped || !notifyWatchActive) break;
							const applied = await applyRuntimeNotify(notify);
							if (applied.followUp) grokFollowUp = applied.followUp;
						}
						await sleep(50);
					}
				})();
				return {
					stop: async () => {
						stopped = true;
						await loop.catch(() => {});
					},
				};
			};
			const requestPrompt = async (promptTextOrParts, timeoutMs) => {
				let nextPrompt = promptTextOrParts;
				while (!stopRequested) {
					grokFollowUp = null;
					promptActive = true;
					try {
						const response = await sendPrompt(nextPrompt, timeoutMs);
						if (
							taskInput.provider === "grok" &&
							grokFollowUp &&
							response.stopReason === "cancelled"
						) {
							nextPrompt = grokFollowUp;
							continue;
						}
						return response;
					} catch (error) {
						await snapshots.immediate("error", {
							kind: "error",
							label: "Error",
							detail: error.message,
						});
						await writeTaskEvent(taskInput, {
							type: "task_done",
							taskId: taskInput.taskId || null,
							status: "failed",
							error: error.message,
						});
						throw error;
					} finally {
						promptActive = false;
					}
				}
				throw new Error("ACP prompt cancelled because the driver is stopping");
			};

			if (taskInput.initialGoalPrompt && !preservedGoalPrompt) {
				preservedGoalPrompt = stripGoalPrefix(taskInput.initialGoalPrompt);
			}
			const resolvedGoal = resolveGoalPromptParts({
				prompt: taskInput.prompt,
				followUpPrompt: taskInput.followUpPrompt,
				outputProtocolPrompt: taskInput.outputProtocolPrompt,
				goalEnabled: Boolean(taskInput.goalEnabled),
				goalPreserving: Boolean(taskInput.goalPreserving),
				goalSetThisSession,
				preservedGoalPrompt,
				initialGoalPrompt: taskInput.initialGoalPrompt,
				lastGoalStatus,
			});
			if (resolvedGoal.recordFirst && resolvedGoal.recordedInitial) {
				preservedGoalPrompt = resolvedGoal.recordedInitial;
			}
				if (resolvedGoal.resetStatus) {
					goalSetThisSession = true;
					lastGoalStatus = null;
				}
				const goalCompletion = taskInput.goalEnabled
					? (() => {
						let resolveCompletion;
						let completed = false;
						const promise = new Promise((resolve) => {
							resolveCompletion = resolve;
						});
						return {
							promise,
							get completed() {
								return completed;
							},
							markComplete() {
								if (completed) return;
								completed = true;
								resolveCompletion();
							},
						};
					})()
					: null;
				activeGoalCompletion = goalCompletion;
				notifyWatchActive = true;
				const watcher = watchRuntimeNotifies();
				let response;
				try {
					response = await requestPrompt(resolvedGoal.parts, idleTimeoutMs);
					if (goalCompletion && response.stopReason !== "cancelled") {
						try {
							while (
								!goalCompletion.completed &&
								!stopRequested &&
								taskInput.provider === "grok" &&
								grokFollowUp
							) {
								const text = grokFollowUp;
								grokFollowUp = null;
								response = await requestPrompt(text, idleTimeoutMs);
							}
							if (!goalCompletion.completed) {
								await withTimeout(
									goalCompletion.promise,
									idleTimeoutMs,
									async () => {},
									`Goal did not reach complete after the prompt returned within ${Math.round(idleTimeoutMs / 1000)}s`,
								);
							}
						} catch (error) {
							await snapshots.immediate("error", {
								kind: "error",
								label: "Error",
								detail: error.message,
							});
							await writeTaskEvent(taskInput, {
								type: "task_done",
								taskId: taskInput.taskId || null,
								status: "failed",
								error: error.message,
							});
							throw error;
						}
					}
				} finally {
					notifyWatchActive = false;
					await watcher.stop();
				}
				await writeTaskEvent(taskInput, {
				type: "task_done",
				taskId: taskInput.taskId || null,
				status: response.stopReason === "cancelled" ? "cancelled" : "completed",
				stopReason: response.stopReason,
			});
			const finalStatus =
				response.stopReason === "cancelled" ? "cancelled" : "completed";
				await snapshots.immediate(finalStatus, {
				kind: finalStatus,
					label: finalStatus === "completed" ? "Completed" : "Cancelled",
				});
				activeGoalCompletion = null;
			};

		await runTask(initialInput);
		while (initialInput.persistent) {
			const nextInput = await readNextTaskInput();
			if (!nextInput) break;
			await runTask(nextInput);
		}
		await ctx.request(acp.methods.agent.session.close, {
			sessionId: sessionIdRef.current,
		});
		await appendProtocolEvent(activeInput.stdoutPath, {
			type: "exit",
			code: 0,
		});
		return true;
	});

	child.kill("SIGTERM");
	await Promise.race([childExit, sleep(2000)]);
	clearInterval(heartbeat);
	return result;
};

run().catch(async (error) => {
	try {
		const input = lastInputForError || {};
		await appendProtocolEvent(input.stdoutPath, {
			type: "log",
			level: "error",
			source: "driver",
			message: error instanceof Error ? error.stack || error.message : String(error),
		});
		await appendProtocolEvent(input.stdoutPath, {
			type: "exit",
			code: 1,
		});
	} catch {}
	fsSync.writeSync(
		process.stderr.fd,
		`${error instanceof Error ? error.stack || error.message : String(error)}\n`,
	);
	process.exit(1);
});
