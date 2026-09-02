import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const run = (command, args, options) =>
	new Promise((resolve, reject) => {
		const inputPath = args[1];
		if (inputPath && existsSync(inputPath)) {
			const input = readFileSync(inputPath, "utf-8");
			if (!input.endsWith("\n")) {
				appendFileSync(inputPath, "\n", "utf-8");
			}
		}
		const child = spawn(command, args, {
			...options,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});

const waitFor = async (predicate, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Condition was not met within ${timeoutMs}ms`);
};

const readEvents = async (filePath) =>
	(await readFile(filePath, "utf-8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(JSON.parse);

test("ACP driver creates a session and writes normalized snapshots", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-driver-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	const envPath = path.join(dir, "adapter-env.json");

	await writeFile(
		adapterPath,
		`
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const envPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    writeFileSync(envPath, JSON.stringify({
      scanJobId: process.env.VULSEEK_SCAN_JOB_ID,
      taskId: process.env.VULSEEK_TASK_ID,
      stageName: process.env.VULSEEK_STAGE_NAME,
    }));
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  }
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-1" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting" } } } });
    for (let used = 1; used <= 64; used += 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "usage_update", used, size: 1000 } } });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "usage_update", used: 42, size: 1000 } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			scanJobId: "job-1",
			taskId: "task-1",
			stageName: "scan-target",
			provider: "codex",
			cwd: dir,
			prompt: "Inspect the repository\nwith \"quotes\" and unicode 测试 \ and \nslashes",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, envPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: true,
			persistent: false,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(await readFile(envPath, "utf-8")), {
		scanJobId: "job-1",
		taskId: "task-1",
		stageName: "scan-target",
	});
	const events = await readEvents(stdoutPath);
	assert.equal(events.some((event) => event.type === "start"), true);
	assert.equal(
		typeof events.find((event) => event.type === "start")?.pid,
		"number",
	);
	assert.equal(
		events.some(
			(event) =>
				event.type === "thread" && event.threadId === "thread-1",
		),
		true,
	);
	assert.equal(events.some((event) => event.type === "activity"), true);
	assert.deepEqual(
		events.find((event) => event.type === "log" && event.message === "task_input")?.input.prompt,
		"Inspect the repository\nwith \"quotes\" and unicode 测试 \ and \nslashes",
	);
	const promptEvent = events.find((event) => event.type === "vulseek_prompt");
	assert.equal(promptEvent?.taskId, "task-1");
	assert.equal(promptEvent?.sessionId, "thread-1");
	assert.equal(promptEvent?.turnIndex, 1);
	assert.equal(typeof promptEvent?.promptId, "string");
	assert.equal(typeof promptEvent?.timestamp, "string");
	assert.equal(promptEvent?.text, events.find((event) => event.type === "log" && event.message === "task_input")?.input.prompt);
	assert.deepEqual(
		events.findLast((event) => event.type === "usage")?.usage,
		{ used: 42, contextSize: 1000 },
	);
	assert.deepEqual(
		events.findLast((event) => event.type === "task_done"),
		{
			type: "task_done",
			taskId: "task-1",
			status: "completed",
			stopReason: "end_turn",
		},
	);
	assert.equal(events.findLast((event) => event.type === "exit")?.code, 0);
	assert.equal(existsSync(outputPath), false);
});

test("ACP driver forwards mcpServers on session/new", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-mcp-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	const sessionNewPath = path.join(dir, "session-new.json");
	const mcpServers = [
		{
			type: "http",
			name: "securitycontext",
			url: "https://securitycontext.dev/mcp",
			headers: [],
		},
	];

	await writeFile(
		adapterPath,
		`
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const sessionNewPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") {
    writeFileSync(sessionNewPath, JSON.stringify(message.params));
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "mcp-thread" } });
  }
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			scanJobId: "job-mcp",
			taskId: "task-mcp",
			stageName: "hunter",
			provider: "codex",
			cwd: dir,
			prompt: "Hunt",
			mcpServers,
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, sessionNewPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: true,
			persistent: false,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(await readFile(sessionNewPath, "utf-8")).mcpServers, mcpServers);
});

test("ACP driver publishes Goal updates as activity and still completes on end_turn", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-activity-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "Audit the selected attack surface", status, controlMethod: "_session/goal" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "goal-thread" } });
  if (message.method === "session/prompt") {
    for (const status of ["active", "paused", "blocked", "limited", "complete"]) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal(status) } } } });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: null } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-thread", update: { sessionUpdate: "session_info_update", _meta: { turn: { status: "completed" } } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-goal",
			provider: "codex",
			cwd: dir,
			prompt: "Work toward the goal",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: true,
			goalEnabled: true,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const events = await readEvents(stdoutPath);
	const goalActivities = events
		.filter((event) => event.type === "activity" && event.activity?.kind === "goal")
		.map((event) => event.activity);
	assert.deepEqual(
		goalActivities.map((activity) => activity.label),
		["Goal active", "Goal paused", "Goal blocked", "Goal limited", "Goal complete", "Goal cleared"],
	);
	assert.equal(goalActivities.at(-1).goal, null);
	assert.equal(events.some((event) => Object.prototype.hasOwnProperty.call(event, "goal")), false);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-goal",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver accepts Grok slash-command Goal without Goal v1 advertisement", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-grok-goal-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { availableCommands: [{ name: "goal", description: "Set, manage, or check an autonomous goal" }] } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-goal-thread" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-goal-thread", update: { sessionUpdate: "goal_updated", goal_id: "g1", objective: "Hunt one high-impact path", status: "active", phase: "executing" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-goal-thread", update: { sessionUpdate: "goal_updated", goal_id: "g1", objective: "Hunt one high-impact path", status: "completed" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "grok-goal-thread", update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-grok-goal",
			provider: "grok",
			cwd: dir,
			prompt: "Hunt one high-impact path",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: true,
			goalEnabled: true,
			promptTimeoutMs: 8000,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const events = await readEvents(stdoutPath);
	const goalActivities = events
		.filter((event) => event.type === "activity" && event.activity?.kind === "goal")
		.map((event) => event.activity);
	assert.deepEqual(
		goalActivities.map((activity) => activity.label),
		["Goal active", "Goal complete"],
	);
	assert.equal(goalActivities[0].detail, "Hunt one high-impact path");
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-grok-goal",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver rewrites Grok vendor session updates without cancelling the prompt", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-grok-vendor-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	const requestLogPath = path.join(dir, "requests.jsonl");
	await writeFile(
		outputPath,
		JSON.stringify({ route: null, exit: false, output: { done: true } }),
		"utf-8",
	);
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let promptId = null;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { availableCommands: [{ name: "goal", description: "Set, manage, or check an autonomous goal" }] } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-vendor-thread" } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ timestamp: 1787646583, method: "_x.ai/session/update", params: { sessionId: "grok-vendor-thread", _meta: { eventId: "g1-1" }, update: { sessionUpdate: "goal_updated", goal_id: "g1", objective: "Hunt one high-impact path", status: "active", phase: "executing" } } });
    send({ timestamp: 1787646794, method: "_x.ai/session/update", params: { sessionId: "grok-vendor-thread", _meta: { eventId: "g1-2" }, update: { sessionUpdate: "goal_updated", goal_id: "g1", objective: "Hunt one high-impact path", status: "complete", phase: "idle" } } });
    send({ timestamp: 1787646795, method: "_x.ai/session/update", params: { sessionId: "grok-vendor-thread", update: { sessionUpdate: "turn_completed", stop_reason: "end_turn", prompt_id: "p1" } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/cancel" && promptId !== null) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
    promptId = null;
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-grok-vendor",
			provider: "grok",
			cwd: dir,
			prompt: "Hunt one high-impact path",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: false,
			goalEnabled: true,
			promptTimeoutMs: 4000,
		}),
		"utf-8",
	);

	const startedAt = Date.now();
	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.ok(Date.now() - startedAt < 3500);
	const methods = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse)
		.map((entry) => entry.method);
	assert.equal(methods.includes("session/cancel"), false);
	const events = await readEvents(stdoutPath);
	const goalActivities = events
		.filter((event) => event.type === "activity" && event.activity?.kind === "goal")
		.map((event) => event.activity);
	assert.deepEqual(
		goalActivities.map((activity) => activity.label),
		["Goal active", "Goal complete"],
	);
	assert.equal(
		events.some((event) => event.type === "turn_done"),
		true,
	);
	assert.equal(
		events.some((event) => event.type === "log" && event.message === "goal_turn_settled"),
		false,
	);
	assert.equal(
		events.some((event) => String(event.error || event.message || "").includes("timed out")),
		false,
	);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-grok-vendor",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver rewrites Grok ExtNotification session_notification without cancelling the prompt", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-grok-extnotif-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const wirePath = path.join(dir, "wire.jsonl");
	await writeFile(
		outputPath,
		JSON.stringify({ route: null, exit: false, output: { done: true } }),
		"utf-8",
	);
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let promptId = null;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { availableCommands: [{ name: "goal" }] } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-ext-thread" } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ method: "x.ai/session_notification", params: { session_id: "grok-ext-thread", update: { sessionUpdate: "goal_updated", objective: "Hunt one high-impact path", status: "complete", phase: "idle" } } });
    send({ method: "_x.ai/session_notification", params: { session_id: "grok-ext-thread", update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/cancel" && promptId !== null) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
    promptId = null;
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-grok-ext",
			provider: "grok",
			cwd: dir,
			prompt: "Hunt one high-impact path",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: false,
			goalEnabled: true,
			promptTimeoutMs: 4000,
		}),
		"utf-8",
	);

	const startedAt = Date.now();
	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
				VULSEEK_ACP_WIRE_LOG: wirePath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.ok(Date.now() - startedAt < 3500);
	const events = await readEvents(stdoutPath);
	assert.deepEqual(
		events
			.filter((event) => event.type === "activity" && event.activity?.kind === "goal")
			.map((event) => event.activity.label),
		["Goal complete"],
	);
	assert.equal(
		events.some((event) => event.type === "turn_done"),
		true,
	);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-grok-ext",
		status: "completed",
		stopReason: "end_turn",
	});
	const methods = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse)
		.map((entry) => entry.method);
	assert.equal(methods.includes("session/cancel"), false);
	const wire = (await readFile(wirePath, "utf-8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(JSON.parse);
	assert.equal(
		wire.some((entry) => entry.method === "x.ai/session_notification" && entry.sessionUpdate === "goal_updated"),
		true,
	);
	assert.equal(
		wire.some((entry) => entry.rewrittenMethod === "session/update" && entry.rewrittenSessionUpdate === "session_info_update"),
		true,
	);
});

test("ACP driver still rejects Goal when the adapter has neither Goal v1 nor a goal command", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-no-goal-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { availableCommands: [{ name: "compact" }] } } });
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-no-goal",
			provider: "grok",
			cwd: dir,
			prompt: "Hunt",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			nullableOutput: true,
			goalEnabled: true,
			promptTimeoutMs: 8000,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.notEqual(result.code, 0);
	assert.match(
		`${result.stderr}\n${result.stdout}`,
		/does not advertise Goal v1 capability/,
	);
});

test("ACP driver waits for Goal completion after task and turn completion", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-turn-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(outputPath, JSON.stringify({ route: null, exit: false, output: {} }), "utf-8");
	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "Audit the selected attack surface", status, controlMethod: "_session/goal" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "goal-turn-thread" } });
	if (message.method === "session/prompt") {
	    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-turn-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("active") } } } });
	    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-turn-thread", update: { sessionUpdate: "session_info_update", _meta: { turn: { status: "completed" } } } } });
	    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-turn-thread", update: { sessionUpdate: "session_info_update", _meta: { task: { status: "completed" } } } } });
	    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-turn-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("complete") } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-turn-thread", update: { sessionUpdate: "session_info_update", _meta: { turn: { status: "completed" } } } } });
    }, 80);
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-goal-turn",
			provider: "codex",
			cwd: dir,
			prompt: "Work toward the goal",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: true,
			goalEnabled: true,
		}),
		"utf-8",
	);

	const startedAt = Date.now();
	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.ok(Date.now() - startedAt >= 70);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some((event) => event.type === "turn_done"),
		true,
	);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-goal-turn",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver rejects a Goal task when prompt returns without Goal completion", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-no-complete-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "planner", status, controlMethod: "_session/goal" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "goal-no-complete-thread" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-no-complete-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("active") } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-no-complete-thread", update: { sessionUpdate: "session_info_update", _meta: { task: { status: "completed" } } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-goal-no-complete",
			provider: "codex",
			cwd: dir,
			prompt: "Continue the standing planner goal.",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			goalEnabled: true,
			promptTimeoutMs: 80,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.notEqual(result.code, 0);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some((event) => event.type === "log" && event.message === "task_completed"),
		true,
	);
	assert.equal(
		events.some(
			(event) =>
				event.type === "task_done" && event.status === "completed",
		),
		false,
	);
	assert.match(
		String(events.findLast((event) => event.type === "task_done")?.error),
		/Goal did not reach complete after the prompt returned/,
	);
});

test("ACP driver completes a Goal task on the normal prompt response, not output.json", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-output-turn-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const outputPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "planner", status, controlMethod: "_session/goal" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "goal-output-turn" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-output-turn", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("active") } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-output-turn", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("complete") } } } });
    }, 50);
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-goal-output-turn",
			provider: "codex",
			cwd: dir,
			prompt: "Continue the standing planner goal.",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, outputPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: false,
			goalEnabled: true,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const events = await readEvents(stdoutPath);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-goal-output-turn",
		status: "completed",
		stopReason: "end_turn",
	});
	assert.equal(
		events.some((event) => event.message === "structured output recovery prompt"),
		false,
	);
});

test("ACP driver keeps a Goal prompt alive after goal complete until normal prompt completion", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-hang-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	const requestLogPath = path.join(dir, "requests.jsonl");
	await writeFile(outputPath, JSON.stringify({ route: null, exit: false, output: {} }), "utf-8");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "planner", status, controlMethod: "_session/goal" });
let promptId = null;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "goal-hang-thread" } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-hang-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("active") } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-hang-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("complete") } } } });
    setTimeout(() => {
      fs.appendFileSync(requestLogPath, JSON.stringify({ method: "simulated-submit-output" }) + "\\n");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-hang-thread", update: { sessionUpdate: "tool_call", toolCallId: "submit-output", title: "submit-output", status: "completed" } } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }, 80);
    return;
  }
  if (message.method === "session/cancel" && promptId !== null) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
    promptId = null;
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-goal-hang",
			provider: "codex",
			cwd: dir,
			prompt: "Continue the standing planner goal.",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: false,
			goalEnabled: true,
			promptTimeoutMs: 4000,
		}),
		"utf-8",
	);

	const startedAt = Date.now();
	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.ok(Date.now() - startedAt >= 70);
	assert.ok(Date.now() - startedAt < 3500);
	const methods = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse)
		.map((entry) => entry.method);
	assert.equal(methods.includes("simulated-submit-output"), true);
	assert.equal(methods.includes("session/cancel"), false);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some((event) => event.type === "log" && event.message === "goal_turn_settled"),
		false,
	);
	assert.equal(
		events.some((event) => String(event.error || event.message || "").includes("timed out")),
		false,
	);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-goal-hang",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver does not send an output.json recovery prompt for a Goal task", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-recovery-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const outputPath = process.argv[2];
const requestLogPath = process.argv[3];
let promptCount = 0;
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "Audit the selected attack surface", status, controlMethod: "_session/goal" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "goal-recovery-thread" } });
  if (message.method === "session/prompt") {
    promptCount += 1;
    fs.appendFileSync(requestLogPath, JSON.stringify({ promptCount, text: message.params.prompt[0].text }) + "\\n");
    if (promptCount === 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-recovery-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("active") } } } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-recovery-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("complete") } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-recovery-thread", update: { sessionUpdate: "session_info_update", _meta: { turn: { status: "completed" } } } } });
      }, 80);
      return;
    }
    fs.writeFileSync(outputPath, JSON.stringify({ route: null, exit: false, output: { recovered: true } }));
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-goal-recovery",
			provider: "codex",
			cwd: dir,
			prompt: "Work toward the goal",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, outputPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			structuredOutputSchemaPathInContainer: path.join(dir, "output.schema.json"),
			structuredOutputGracePeriodMs: 20,
			structuredOutputRecoveryAttempts: 1,
			nullableOutput: false,
			goalEnabled: true,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const prompts = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(prompts.length, 1);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some(
			(event) =>
				event.type === "log" && event.message === "structured output recovery prompt",
		),
		false,
	);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-goal-recovery",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver rejects a Goal task when the adapter lacks Goal capability", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-capability-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-goal-without-capability",
			provider: "codex",
			cwd: dir,
			prompt: "Work toward the goal",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath: path.join(dir, "stdout"),
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			nullableOutput: true,
			goalEnabled: true,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /does not advertise Goal v1 capability/);
});

test("ACP driver waits for an empty file and joins a later partial JSONL line", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-file-reader-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "stdin");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");
	const promptLogPath = path.join(dir, "prompt.txt");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-file-reader" } });
  if (message.method === "session/prompt") {
    fs.writeFileSync(process.argv[2], message.params.prompt[0].text);
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(inputPath, "", "utf-8");
	const taskInput = {
		taskId: "task-file-reader",
		provider: "codex",
		cwd: dir,
		prompt: "line one",
		outputProtocolPrompt: "line two with 测试",
		adapterCommand: process.execPath,
		adapterArgs: [adapterPath, promptLogPath],
		stdoutPath,
		structuredOutputResultPathInContainer: outputPath,
		nullableOutput: true,
	};
	const child = spawn(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(existsSync(stdoutPath), false);
		const serialized = JSON.stringify(taskInput);
		const splitAt = Math.max(1, serialized.length - 1);
		appendFileSync(inputPath, serialized.slice(0, splitAt), "utf-8");
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(existsSync(stdoutPath), false);
		appendFileSync(inputPath, `${serialized.slice(splitAt)}\n`, "utf-8");
		await waitFor(async () => {
			try {
				return (await readEvents(stdoutPath)).some(
					(event) => event.type === "task_done" && event.taskId === taskInput.taskId,
				);
			} catch {
				return false;
			}
		});
		assert.equal(
			await readFile(promptLogPath, "utf-8"),
			"line one\n\nline two with 测试",
		);
		const promptEvent = (await readEvents(stdoutPath)).find(
			(event) => event.type === "vulseek_prompt",
		);
		assert.equal(promptEvent?.text, "line one\n\nline two with 测试");
	} finally {
		child.kill("SIGTERM");
		await new Promise((resolve) => child.once("close", resolve));
	}
});

test("ACP driver reports invalid JSONL input", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-invalid-input-"));
	const inputPath = path.join(dir, "stdin");
	await writeFile(inputPath, "not valid json\n", "utf-8");
	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{ cwd: process.cwd() },
	);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Invalid task input JSONL/);
});

test("ACP driver does not invent output for a non-nullable end_turn", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-missing-output-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");

	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-no-output" } });
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-no-output",
			provider: "codex",
			cwd: dir,
			prompt: "Return without writing the required structured output",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: false,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const events = await readEvents(stdoutPath);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-no-output",
		status: "completed",
		stopReason: "end_turn",
	});
	assert.equal(existsSync(outputPath), false);
});

test("ACP driver waits for a delayed atomic output rename", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-delayed-output-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");

	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const outputPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-delayed-output" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    setTimeout(() => {
      const temporaryPath = outputPath + ".tmp";
      fs.writeFileSync(temporaryPath, JSON.stringify({ route: null, exit: false, output: {} }));
      fs.renameSync(temporaryPath, outputPath);
    }, 100);
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-delayed-output",
			provider: "codex",
			cwd: dir,
			prompt: "Write the result after a short atomic rename delay",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, outputPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			structuredOutputGracePeriodMs: 1_000,
			nullableOutput: false,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const events = await readEvents(stdoutPath);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-delayed-output",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver recovers a missing structured output with one follow-up prompt", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-output-recovery-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const stdoutPath = path.join(dir, "stdout");

	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const outputPath = process.argv[2];
const requestLogPath = process.argv[3];
let promptCount = 0;
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-recovery" } });
  if (message.method === "session/prompt") {
    promptCount += 1;
    fs.appendFileSync(requestLogPath, JSON.stringify({ promptCount, text: message.params.prompt[0].text }) + "\\n");
    if (promptCount === 2) fs.writeFileSync(outputPath, JSON.stringify({ route: null, exit: false, output: { recovered: true } }));
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-output-recovery",
			provider: "codex",
			cwd: dir,
			prompt: "Analyze and write the required result",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, outputPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			structuredOutputSchemaPathInContainer: path.join(dir, "output.schema.json"),
			structuredOutputGracePeriodMs: 20,
			structuredOutputRecoveryAttempts: 1,
			nullableOutput: false,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const prompts = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(prompts.length, 1);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some(
			(event) =>
				event.type === "log" &&
				event.message === "structured output recovery prompt",
		),
		false,
	);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-output-recovery",
		status: "completed",
		stopReason: "end_turn",
	});
});

for (const scenario of [
	{
		name: "resumes the current task session before considering fork",
		input: {
			threadId: "current-thread",
			sessionMode: "fork",
			parentSessionId: "parent-thread",
			nullableOutput: true,
		},
		expectedMethod: "session/resume",
		expectedSessionId: "current-thread",
	},
	{
		name: "forks the parent when no current session exists",
		input: {
			sessionMode: "fork",
			parentSessionId: "parent-thread",
			nullableOutput: true,
		},
		expectedMethod: "session/fork",
		expectedSessionId: "forked-thread",
	},
]) {
	test(`ACP driver ${scenario.name}`, async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-session-"));
		const adapterPath = path.join(dir, "fake-adapter.mjs");
		const requestLogPath = path.join(dir, "requests.jsonl");
		const inputPath = path.join(dir, "input.json");
		await writeFile(
			adapterPath,
			`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-thread" } });
  if (message.method === "session/resume") send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/fork") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "forked-thread" } });
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
			"utf-8",
		);
		await writeFile(
			inputPath,
			JSON.stringify({
				taskId: "task-session",
				provider: "codex",
				cwd: dir,
				prompt: "continue",
				adapterCommand: process.execPath,
				adapterArgs: [adapterPath, requestLogPath],
				stdoutPath: path.join(dir, "stdout"),
				structuredOutputResultPathInContainer: path.join(dir, "output.json"),
				persistent: false,
				...scenario.input,
			}),
			"utf-8",
		);

		const result = await run(
			process.execPath,
			[
				path.resolve(
					process.cwd(),
					"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
				),
				inputPath,
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					VULSEEK_AGENT_EVENTS_PATH: path.resolve(
						process.cwd(),
						"vendor/claude-replay/src/agent-events.mjs",
					),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout, "");
		const requests = (await readFile(requestLogPath, "utf-8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(
			requests.some((request) => request.method === scenario.expectedMethod),
			true,
		);
		assert.equal(
			requests.some((request) => request.method === "session/new"),
			false,
		);
		if (scenario.expectedMethod === "session/resume") {
			assert.equal(
				requests.some((request) => request.method === "session/fork"),
				false,
			);
		}
	});
}

test("ACP driver inherits Research database context", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-research-db-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const environmentPath = path.join(dir, "adapter-environment.json");
	const inputPath = path.join(dir, "input.json");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
fs.writeFileSync(process.argv[2], JSON.stringify({
  databaseUrl: process.env.VULSEEK_RESEARCH_DATABASE_URL || null,
}));
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-secret" } });
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-research-db",
			provider: "codex",
			cwd: dir,
			prompt: "Inspect the repository",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, environmentPath],
			stdoutPath: path.join(dir, "stdout"),
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			nullableOutput: true,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
				env: {
				...process.env,
				VULSEEK_RESEARCH_DATABASE_URL: "postgresql://research-user:research-password@db/research",
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(await readFile(environmentPath, "utf-8")), {
		databaseUrl: "postgresql://research-user:research-password@db/research",
	});
});

test("ACP driver reuses one session for persistent queued tasks", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-persistent-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const firstDir = path.join(dir, "first");
	const secondDir = path.join(dir, "second");
	const inputPath = path.join(dir, "input.json");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "persistent-thread" } });
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/cancel") return;
});
`,
		"utf-8",
	);

	const taskInput = (taskId, runtimeDir, prompt) => ({
		taskId,
		provider: "codex",
		cwd: dir,
		prompt,
		adapterCommand: process.execPath,
		adapterArgs: [adapterPath, requestLogPath],
		stdoutPath: path.join(runtimeDir, "stdout"),
		structuredOutputResultPathInContainer: path.join(runtimeDir, "output.json"),
		nullableOutput: true,
		taskStageRootInContainer: runtimeDir,
		taskAliasRootInContainer: path.join(dir, "task"),
	});
	const initialInput = {
		...taskInput("task-1", firstDir, "first prompt"),
		persistent: true,
	};
	await writeFile(inputPath, `${JSON.stringify(initialInput)}\n`, "utf-8");

	const child = spawn(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitFor(async () => {
			try {
				return (
					(await readEvents(path.join(firstDir, "stdout"))).some(
						(event) => event.type === "task_done" && event.taskId === "task-1",
					)
				);
			} catch {
				return false;
			}
		});
		appendFileSync(
			inputPath,
			`${JSON.stringify(taskInput("task-2", secondDir, "second prompt"))}\n`,
			"utf-8",
		);
		await waitFor(async () => {
			try {
				return (
					(await readEvents(path.join(secondDir, "stdout"))).some(
						(event) => event.type === "task_done" && event.taskId === "task-2",
					)
				);
			} catch {
				return false;
			}
		});
		const requests = (await readFile(requestLogPath, "utf-8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(
			requests.filter((request) => request.method === "session/new").length,
			1,
		);
		assert.equal(
			requests.filter((request) => request.method === "session/prompt").length,
			2,
		);
		assert.deepEqual(
			requests
				.filter((request) => request.method === "session/prompt")
				.map((request) => request.params.sessionId),
			["persistent-thread", "persistent-thread"],
		);
		assert.equal(
			(await readEvents(path.join(secondDir, "stdout"))).some(
				(event) =>
					event.type === "activity" &&
					event.status === "completed",
			),
			true,
		);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	assert.doesNotMatch(stderr, /Condition was not met/);
});

test("ACP driver prefixes /goal and reissues the preserved goal after complete", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-goal-preserve-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const firstDir = path.join(dir, "first");
	const secondDir = path.join(dir, "second");
	const thirdDir = path.join(dir, "third");
	const inputPath = path.join(dir, "input.json");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "planner", status, controlMethod: "_session/goal" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "preserve-thread" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "preserve-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("active") } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "preserve-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("complete") } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "preserve-thread", update: { sessionUpdate: "session_info_update", _meta: { turn: { status: "completed" } } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/cancel") return;
});
`,
		"utf-8",
	);

	const taskInput = (taskId, runtimeDir, prompt, extra = {}) => ({
		taskId,
		provider: "codex",
		cwd: dir,
		prompt,
		adapterCommand: process.execPath,
		adapterArgs: [adapterPath, requestLogPath],
		stdoutPath: path.join(runtimeDir, "stdout"),
		structuredOutputResultPathInContainer: path.join(runtimeDir, "output.json"),
		nullableOutput: true,
		taskStageRootInContainer: runtimeDir,
		taskAliasRootInContainer: path.join(dir, "task"),
		goalEnabled: true,
		goalPreserving: true,
		...extra,
	});
	const initialInput = {
		...taskInput("task-1", firstDir, "Plan hunt surfaces."),
		persistent: true,
	};
	await writeFile(inputPath, `${JSON.stringify(initialInput)}\n`, "utf-8");

	const child = spawn(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitFor(async () => {
			try {
				return (await readEvents(path.join(firstDir, "stdout"))).some(
					(event) => event.type === "task_done" && event.taskId === "task-1",
				);
			} catch {
				return false;
			}
		});
		appendFileSync(
			inputPath,
			`${JSON.stringify(taskInput("task-2", secondDir, "Continue after reject."))}\n`,
			"utf-8",
		);
		await waitFor(async () => {
			try {
				return (await readEvents(path.join(secondDir, "stdout"))).some(
					(event) => event.type === "task_done" && event.taskId === "task-2",
				);
			} catch {
				return false;
			}
		});
		appendFileSync(
			inputPath,
			`${JSON.stringify(taskInput("task-3", thirdDir, "Continue after complete."))}\n`,
			"utf-8",
		);
		await waitFor(async () => {
			try {
				return (await readEvents(path.join(thirdDir, "stdout"))).some(
					(event) => event.type === "task_done" && event.taskId === "task-3",
				);
			} catch {
				return false;
			}
		});
		const prompts = (await readFile(requestLogPath, "utf-8"))
			.trim()
			.split("\n")
			.map(JSON.parse)
			.filter((request) => request.method === "session/prompt")
			.map((request) =>
				request.params.prompt.map((part) => part.text),
			);
		assert.deepEqual(prompts[0], ["/goal Plan hunt surfaces."]);
		assert.deepEqual(prompts[1], [
			"/goal Plan hunt surfaces.\n\nContinue after reject.",
		]);
		assert.deepEqual(prompts[2], [
			"/goal Plan hunt surfaces.\n\nContinue after complete.",
		]);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	assert.doesNotMatch(stderr, /Condition was not met/);
});

test("ACP driver does not time out a prompt while the agent keeps sending ACP updates", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-idle-alive-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "idle-alive-thread" } });
  if (message.method === "session/prompt") {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "idle-alive-thread", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "working " + n } } } });
      if (n >= 8) {
        clearInterval(timer);
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    }, 150);
    return;
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-idle-alive",
			provider: "codex",
			cwd: dir,
			prompt: "Keep working",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			nullableOutput: true,
			promptTimeoutMs: 400,
		}),
		"utf-8",
	);

	const startedAt = Date.now();
	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	assert.ok(Date.now() - startedAt >= 900);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some((event) =>
			String(event.error || event.message || "").includes("timed out"),
		),
		false,
	);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-idle-alive",
		status: "completed",
		stopReason: "end_turn",
	});
});

test("ACP driver times out a prompt only after the agent ACP stays silent", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-idle-silent-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const stdoutPath = path.join(dir, "stdout");
	const requestLogPath = path.join(dir, "requests.jsonl");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let promptId = null;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "idle-silent-thread" } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    return;
  }
  if (message.method === "session/cancel" && promptId !== null) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
    promptId = null;
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-idle-silent",
			provider: "codex",
			cwd: dir,
			prompt: "Hang without ACP updates",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			nullableOutput: true,
			promptTimeoutMs: 400,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.notEqual(result.code, 0);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some((event) =>
			String(event.error || event.message || "").includes(
				"timed out after 0s without agent response",
			),
		),
		true,
	);
	const methods = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse)
		.map((entry) => entry.method);
	assert.equal(methods.includes("session/cancel"), true);
});

test("ACP driver sends Claude effort on session/new and set_config_option", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-claude-effort-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "claude-effort-thread", configOptions: [{ id: "effort", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] }] } });
  if (message.method === "session/set_config_option") send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [{ id: "effort", currentValue: message.params.value }] } });
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-claude-effort",
			provider: "claude",
			cwd: dir,
			prompt: "hunt",
			thinkingLevel: "medium",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			persistent: false,
			nullableOutput: true,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const requests = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	const sessionNew = requests.find((request) => request.method === "session/new");
	assert.equal(
		sessionNew?.params?._meta?.claudeCode?.options?.settings?.effortLevel,
		"medium",
	);
	const setConfig = requests.find(
		(request) => request.method === "session/set_config_option",
	);
	assert.deepEqual(
		{
			sessionId: setConfig?.params?.sessionId,
			configId: setConfig?.params?.configId,
			value: setConfig?.params?.value,
		},
		{
			sessionId: "claude-effort-thread",
			configId: "effort",
			value: "medium",
		},
	);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some(
			(event) =>
				event.type === "log" &&
				String(event.message || "").includes("claude_effort_set"),
		),
		true,
	);
});

test("ACP driver steers Codex/Claude when a runtime_notify arrives mid-prompt", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-steer-notify-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const inputPath = path.join(dir, "input.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let promptId = null;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "steer-thread" } });
  if (message.method === "session/prompt") {
    promptId = message.id;
    return;
  }
  if (message.method === "_session/steering") {
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: "injected" } });
    if (promptId !== null) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      promptId = null;
    }
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		`${JSON.stringify({
			taskId: "task-steer-notify",
			provider: "codex",
			cwd: dir,
			prompt: "Stay in this turn",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			nullableOutput: true,
			promptTimeoutMs: 8_000,
		})}\n`,
		"utf-8",
	);

	const child = spawn(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitFor(async () => {
			try {
				return (await readEvents(stdoutPath)).some(
					(event) => event.type === "vulseek_prompt",
				);
			} catch {
				return false;
			}
		});
		appendFileSync(
			inputPath,
			`${JSON.stringify({ type: "runtime_notify", messageCount: 2 })}\n`,
			"utf-8",
		);
		await waitFor(async () => {
			try {
				return (await readEvents(stdoutPath)).some(
					(event) => event.type === "task_done" && event.status === "completed",
				);
			} catch {
				return false;
			}
		});
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	assert.doesNotMatch(stderr, /Condition was not met/);
	const requests = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	const steered = requests.find(
		(request) => request.method === "_session/steering",
	);
	assert.equal(steered?.params?.sessionId, "steer-thread");
	assert.deepEqual(steered?.params?.prompt, [
		{ type: "text", text: "Inbound message count changed to 2." },
	]);
	assert.equal(
		requests.filter((request) => request.method === "session/cancel").length,
		0,
	);
});

test("ACP driver steers runtime_notify after Goal prompt returns while Goal is still active", async () => {
	const dir = await mkdtemp(
		path.join(tmpdir(), "vulseek-acp-goal-steer-notify-"),
	);
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const inputPath = path.join(dir, "input.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const goal = (status) => ({ objective: "planner", status, controlMethod: "_session/goal" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, _meta: { goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "goal-steer-thread" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-steer-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("active") } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "_session/steering") {
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: "injected" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-steer-thread", update: { sessionUpdate: "session_info_update", _meta: { goal: goal("complete") } } } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		`${JSON.stringify({
			taskId: "task-goal-steer-notify",
			provider: "codex",
			cwd: dir,
			prompt: "Hunt until Goal complete",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			nullableOutput: true,
			goalEnabled: true,
			promptTimeoutMs: 8_000,
		})}\n`,
		"utf-8",
	);

	const child = spawn(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitFor(async () => {
			try {
				return (await readEvents(stdoutPath)).some(
					(event) => event.type === "vulseek_prompt",
				);
			} catch {
				return false;
			}
		});
		// Prompt RPC returns end_turn while Goal stays active. Wait past that
		// so this covers the post-prompt Goal-wait window, not mid-prompt.
		await new Promise((resolve) => setTimeout(resolve, 150));
		appendFileSync(
			inputPath,
			`${JSON.stringify({ type: "runtime_notify", messageCount: 3 })}\n`,
			"utf-8",
		);
		await waitFor(async () => {
			try {
				return (await readEvents(stdoutPath)).some(
					(event) =>
						event.type === "task_done" &&
						event.taskId === "task-goal-steer-notify" &&
						event.status === "completed",
				);
			} catch {
				return false;
			}
		});
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	assert.doesNotMatch(stderr, /Condition was not met/);
	const requests = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	const steered = requests.find(
		(request) => request.method === "_session/steering",
	);
	assert.equal(steered?.params?.sessionId, "goal-steer-thread");
	assert.deepEqual(steered?.params?.prompt, [
		{ type: "text", text: "Inbound message count changed to 3." },
	]);
	const events = await readEvents(stdoutPath);
	assert.equal(
		events.some(
			(event) =>
				event.type === "log" &&
				String(event.message || "").includes("runtime_notify messageCount=3"),
		),
		true,
	);
	assert.equal(
		events.some(
			(event) =>
				event.type === "log" &&
				String(event.message || "").includes("runtime_notify_steered"),
		),
		true,
	);
});

test("ACP driver cancels a Grok prompt then follows up on runtime_notify", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-grok-notify-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const inputPath = path.join(dir, "input.json");
	const stdoutPath = path.join(dir, "stdout");
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let promptId = null;
let promptCount = 0;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-thread" } });
  if (message.method === "session/prompt") {
    promptCount += 1;
    promptId = message.id;
    if (promptCount >= 2) {
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      promptId = null;
    }
    return;
  }
  if (message.method === "session/cancel" && promptId !== null) {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
    promptId = null;
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		`${JSON.stringify({
			taskId: "task-grok-notify",
			provider: "grok",
			cwd: dir,
			prompt: "Stay in this turn",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath, requestLogPath],
			stdoutPath,
			structuredOutputResultPathInContainer: path.join(dir, "output.json"),
			nullableOutput: true,
			promptTimeoutMs: 8_000,
		})}\n`,
		"utf-8",
	);

	const child = spawn(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitFor(async () => {
			try {
				return (await readEvents(stdoutPath)).some(
					(event) => event.type === "vulseek_prompt",
				);
			} catch {
				return false;
			}
		});
		appendFileSync(
			inputPath,
			`${JSON.stringify({ type: "runtime_notify", messageCount: 4 })}\n`,
			"utf-8",
		);
		await waitFor(async () => {
			try {
				return (await readEvents(stdoutPath)).some(
					(event) => event.type === "task_done" && event.taskId === "task-grok-notify",
				);
			} catch {
				return false;
			}
		});
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	assert.doesNotMatch(stderr, /Condition was not met/);
	const requests = (await readFile(requestLogPath, "utf-8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(
		requests.filter((request) => request.method === "session/cancel").length,
		1,
	);
	assert.equal(
		requests.filter((request) => request.method === "_session/steering").length,
		0,
	);
	const prompts = requests
		.filter((request) => request.method === "session/prompt")
		.map((request) => request.params.prompt.map((part) => part.text));
	assert.deepEqual(prompts, [
		["Stay in this turn"],
		["Inbound message count changed to 4."],
	]);
	const events = await readEvents(stdoutPath);
	assert.deepEqual(events.findLast((event) => event.type === "task_done"), {
		type: "task_done",
		taskId: "task-grok-notify",
		status: "completed",
		stopReason: "end_turn",
	});
});


