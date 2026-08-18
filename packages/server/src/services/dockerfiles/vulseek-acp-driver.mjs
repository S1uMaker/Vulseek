import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export const VULSEEK_ACP_DRIVER_VERSION = "2026-08-16-goal-turn-1";
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
const asString = (value) => (typeof value === "string" ? value : "");
const pendingJsonWrites = new Map();
const pendingProtocolWrites = new Map();

const atomicWriteJson = async (filePath, value) => {
	if (!filePath) return;
	const previousWrite = pendingJsonWrites.get(filePath) || Promise.resolve();
	const currentWrite = previousWrite.catch(() => {}).then(async () => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(value, null, 2)}\n`,
			"utf-8",
		);
		await fs.rename(temporaryPath, filePath);
	});
	pendingJsonWrites.set(filePath, currentWrite);
	try {
		await currentWrite;
	} finally {
		if (pendingJsonWrites.get(filePath) === currentWrite) {
			pendingJsonWrites.delete(filePath);
		}
	}
};

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

const withTimeout = async (promise, timeoutMs, onTimeout) => {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(async () => {
					await onTimeout().catch(() => {});
					reject(
						new Error(
							`ACP prompt timed out after ${Math.round(timeoutMs / 1000)}s`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
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

const writeNullableOutput = async (input, stopReason) => {
	if (!input.nullableOutput || stopReason !== "end_turn") return;
	const exists = await fs
		.stat(input.structuredOutputResultPathInContainer)
		.then(() => true)
		.catch(() => false);
	if (!exists) {
		await atomicWriteJson(input.structuredOutputResultPathInContainer, {
			route: null,
			exit: false,
			output: null,
		});
	}
};

const hasStructuredOutputEnvelope = (value) =>
	value &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.prototype.hasOwnProperty.call(value, "route") &&
	Object.prototype.hasOwnProperty.call(value, "exit") &&
	Object.prototype.hasOwnProperty.call(value, "output");

const inspectStructuredOutput = async (filePath) => {
	if (!filePath) return { exists: false, validJson: false, validEnvelope: false };
	try {
		const value = JSON.parse(await fs.readFile(filePath, "utf-8"));
		return { exists: true, validJson: true, validEnvelope: hasStructuredOutputEnvelope(value) };
	} catch (error) {
		const exists = await fs
			.stat(filePath)
			.then(() => true)
			.catch(() => false);
		return { exists, validJson: false, validEnvelope: false };
	}
};

const waitForStructuredOutput = async (input, stopReason) => {
	if (stopReason !== "end_turn" || !input.structuredOutputResultPathInContainer) {
		return true;
	}
	const timeoutMs = Math.max(
		0,
		Number(input.structuredOutputGracePeriodMs ?? 2_000),
	);
	const deadline = Date.now() + timeoutMs;
	do {
		const inspection = await inspectStructuredOutput(
			input.structuredOutputResultPathInContainer,
		);
		if (inspection.validEnvelope) return true;
		if (Date.now() >= deadline) break;
		await sleep(50);
	} while (true);
	return false;
};

const structuredOutputRecoveryPrompt = (input) =>
	[
		"The previous turn ended before the required structured output file was written.",
		"Do not continue repository analysis and do not answer with prose.",
		`Immediately write the complete JSON envelope to ${input.structuredOutputResultPathInContainer}.`,
		`Use ${input.structuredOutputSchemaPathInContainer || "/task/output.schema.json"} as the source of truth, then reopen the file and validate it before ending this turn.`,
		"Use the current task's required route, exit, and output values; do not invent or omit required fields.",
	].join("\n");

const assertCapability = (capabilities, name) => {
	const session =
		capabilities?.sessionCapabilities || capabilities?.session || {};
	if (!session[name])
		throw new Error(`ACP adapter does not support session/${name}`);
};

const hasGoalCapability = (initialized) => {
	const goal = asRecord(initialized?._meta).goal;
	return (
		goal?.version === 1 &&
		goal?.controlMethod === "_session/goal" &&
		Array.isArray(goal.actions)
	);
};

const isNativeGoalPrompt = (prompt) => /^\s*\/goal(?:\s|$)/i.test(prompt);

const stripGoalPrefix = (prompt) =>
	prompt.replace(/^\s*\/goal(?:\s+|$)/i, "").trim();

const prefixNativeGoal = (prompt) => {
	const trimmed = String(prompt ?? "").trim();
	if (!trimmed) return trimmed;
	return isNativeGoalPrompt(trimmed) ? trimmed : `/goal ${trimmed}`;
};

const createDeadline = (timeoutMs) => {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	return () => Math.max(1, deadline - Date.now());
};

const hasValidOutputEnvelopeSync = (filePath) => {
	if (!filePath) return false;
	try {
		return hasStructuredOutputEnvelope(
			JSON.parse(fsSync.readFileSync(filePath, "utf-8")),
		);
	} catch {
		return false;
	}
};

const createGoalTurnSettlement = (hasOutputEnvelope) => {
	let seenComplete = false;
	let settled = false;
	let resolveFn = () => {};
	const promise = new Promise((resolve) => {
		resolveFn = resolve;
	});
	const trySettle = () => {
		if (settled) return;
		if (!seenComplete && !hasOutputEnvelope?.()) return;
		settled = true;
		resolveFn();
	};
	return {
		promise,
		onGoalStatus(status) {
			if (status === "complete") {
				seenComplete = true;
				return;
			}
			if (
				status === "active" ||
				status === "paused" ||
				status === "blocked" ||
				status === "limited"
			) {
				seenComplete = false;
			}
		},
		onTurnCompleted() {
			trySettle();
		},
	};
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
	const readNextTaskInput = async () => {
		while (!stopRequested) {
			await readAvailableInput();
			while (pendingLines.length) {
				const line = pendingLines.shift();
				if (!line || !line.trim()) continue;
				try {
					const value = JSON.parse(line);
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
		format: initialInput.provider === "claude" ? "claude-code" : "codex",
	});
	const sessionIdRef = { current: "" };
	const snapshots = createSnapshotWriter(activeInput, sessionIdRef);
	const roots = [
		initialInput.cwd,
		...(initialInput.additionalDirectories || []),
	].filter(Boolean);
	const command =
		initialInput.adapterCommand ||
		(initialInput.provider === "claude" ? "claude-agent-acp" : "codex-acp");
	const adapterEnvironment = {
		...process.env,
		...(initialInput.adapterEnv || {}),
		...(initialInput.agentHomePathInContainer
			? initialInput.provider === "claude"
				? { CLAUDE_CONFIG_DIR: initialInput.agentHomePathInContainer }
				: { CODEX_HOME: initialInput.agentHomePathInContainer }
			: {}),
	};
	const child = spawn(command, initialInput.adapterArgs || [], {
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
	let goalCapabilityAvailable = false;
	let preservedGoalPrompt = null;
	let lastGoalStatus = null;
	let goalSetThisSession = false;
	let goalTurnSettlement = null;
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
		Readable.toWeb(child.stdout),
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
					goalTurnSettlement?.onTurnCompleted();
					await appendProtocolEvent(activeInput.stdoutPath, {
						type: "log",
						level: "debug",
						source: "driver",
						message: "turn_completed",
					});
					continue;
				}
				const activity = activityForEvent(event);
				if (!activity) continue;
				if (event.kind === "goal") {
					lastGoalStatus = event.goal?.status || null;
					goalTurnSettlement?.onGoalStatus(lastGoalStatus);
					// Do not replay or synthesize this update when a persistent
					// driver switches to another task.
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
			const common = {
				cwd: initialInput.cwd,
				mcpServers: initialInput.mcpServers || [],
				additionalDirectories: initialInput.additionalDirectories || [],
			};
			if (initialInput.threadId) {
				await ctx.request(acp.methods.agent.session.resume, {
					...common,
					sessionId: initialInput.threadId,
				});
				return initialInput.threadId;
			}
			if (initialInput.sessionMode === "fork") {
				assertCapability(initialized.agentCapabilities, "fork");
				const forked = await ctx.request(acp.methods.agent.session.fork, {
					...common,
					sessionId: initialInput.parentSessionId,
				});
				return forked.sessionId;
			}
			const created = await ctx.request(acp.methods.agent.session.new, common);
			return created.sessionId;
		};
		sessionIdRef.current = await openSession();
		await appendProtocolEvent(initialInput.stdoutPath, {
			type: "thread",
			threadId: sessionIdRef.current,
		});

		const runTask = async (taskInput) => {
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
			const requestPrompt = async (promptTextOrParts, timeoutMs) => {
				const prompt = Array.isArray(promptTextOrParts)
					? promptTextOrParts.filter(
							(part) => part && typeof part.text === "string" && part.text.trim(),
						)
					: [{ type: "text", text: String(promptTextOrParts ?? "") }];
				promptActive = true;
				try {
					const response = await withTimeout(
						ctx.request(acp.methods.agent.session.prompt, {
							sessionId: sessionIdRef.current,
							prompt,
						}),
						timeoutMs,
						cancel,
					);
					await snapshots.flush();
					const usage = asRecord(response.usage);
					if (Object.keys(usage).length) {
						await appendProtocolEvent(taskInput.stdoutPath, {
							type: "usage",
							usage,
						});
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
			const remainingMs = createDeadline(
				Number(taskInput.promptTimeoutMs || PROMPT_TIMEOUT_MS),
			);
			const settlement = taskInput.goalEnabled
				? createGoalTurnSettlement(() =>
						hasValidOutputEnvelopeSync(
							taskInput.structuredOutputResultPathInContainer,
						),
					)
				: null;
			goalTurnSettlement = settlement;
			let response = await requestPrompt(resolvedGoal.parts, remainingMs());
			if (settlement && response.stopReason !== "cancelled") {
				await withTimeout(settlement.promise, remainingMs(), cancel);
				if (promptActive) await cancel().catch(() => {});
				response = { ...response, stopReason: "end_turn" };
			}
			goalTurnSettlement = null;
			let structuredOutputExists = await waitForStructuredOutput(
				taskInput,
				response.stopReason,
			);
			const recoveryAttempts = taskInput.nullableOutput
				? 0
				: Math.max(0, Number(taskInput.structuredOutputRecoveryAttempts ?? 1));
			for (let attempt = 1; !structuredOutputExists && attempt <= recoveryAttempts; attempt += 1) {
				await appendProtocolEvent(taskInput.stdoutPath, {
					type: "log",
					level: "warn",
					source: "driver",
					message: "structured output recovery prompt",
					diagnostics: { attempt, maxAttempts: recoveryAttempts },
				});
				await snapshots.immediate("running", {
					kind: "writing",
					label: "Writing required output",
				});
				response = await requestPrompt(
					structuredOutputRecoveryPrompt(taskInput),
					remainingMs(),
				);
				structuredOutputExists = await waitForStructuredOutput(
					taskInput,
					response.stopReason,
				);
			}
			if (!structuredOutputExists && !taskInput.nullableOutput) {
				const message = "ACP prompt completed without required output.json";
				await appendProtocolEvent(taskInput.stdoutPath, {
					type: "log",
					level: "error",
					source: "driver",
					message,
					diagnostics: {
						taskId: taskInput.taskId || null,
						stopReason: response.stopReason,
						outputPath: taskInput.structuredOutputResultPathInContainer,
						gracePeriodMs: Number(taskInput.structuredOutputGracePeriodMs ?? 2_000),
					},
				});
				await writeTaskEvent(taskInput, {
					type: "task_done",
					taskId: taskInput.taskId || null,
					status: "failed",
					error: message,
					stopReason: response.stopReason,
				});
				await snapshots.immediate("error", {
					kind: "error",
					label: "Missing structured output",
					detail: message,
				});
				throw new Error(message);
			}
			await writeNullableOutput(taskInput, response.stopReason);
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
