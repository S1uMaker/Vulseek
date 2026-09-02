import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	buildNativeAgentTranscriptRoots,
	findNativeAgentTranscript,
} from "./native-agent-transcript";

const makeRoot = async () =>
	mkdtemp(path.join(os.tmpdir(), "vulseek-agent-stream-"));

describe("findNativeAgentTranscript", () => {
	it("resolves every task to the Job-level agent home", () => {
		assert.deepEqual(
			buildNativeAgentTranscriptRoots({
				runtimeDir: "/scan/jobs/job-1/stages/scan-target/tasks/task-1",
				scanJobId: "job-1",
			}),
			["/scan/jobs/job-1"],
		);
	});

	it("does not resolve a task outside its Job runtime", () => {
		assert.deepEqual(
			buildNativeAgentTranscriptRoots({
				runtimeDir: "/scan/jobs/other-job/stages/scan-target/tasks/task-1",
				scanJobId: "job-1",
			}),
			[],
		);
	});

	it("finds a Codex rollout by the exact thread id", async () => {
		const root = await makeRoot();
		const sessions = path.join(
			root,
			"agent-home",
			"codex-profile",
			"sessions",
			"2026",
			"07",
			"15",
		);
		await mkdir(sessions, { recursive: true });
		const expected = path.join(
			sessions,
			"rollout-2026-07-15T01-02-03-thread-123.jsonl",
		);
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "codex",
				threadId: "thread-123",
			}),
			expected,
		);
	});

	it("finds a Claude Code transcript under the project directory", async () => {
		const root = await makeRoot();
		const projects = path.join(
			root,
			"agent-home",
			"claude-profile",
			"projects",
			"-workspace-repo",
		);
		await mkdir(projects, { recursive: true });
		const expected = path.join(projects, "claude-thread-456.jsonl");
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "claude-code",
				threadId: "claude-thread-456",
			}),
			expected,
		);
	});

	it("finds a Grok Build session chat_history.jsonl by thread id", async () => {
		const root = await makeRoot();
		const sessionDir = path.join(
			root,
			"agent-home",
			"grok-profile",
			"sessions",
			encodeURIComponent("/workspace/repo"),
			"thread-grok-1",
		);
		await mkdir(sessionDir, { recursive: true });
		const expected = path.join(sessionDir, "chat_history.jsonl");
		await writeFile(path.join(sessionDir, "events.jsonl"), "{}\n");
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "grok",
				threadId: "thread-grok-1",
			}),
			expected,
		);
	});

	it("falls back to Grok events.jsonl when chat_history is missing", async () => {
		const root = await makeRoot();
		const sessionDir = path.join(
			root,
			"agent-home",
			"grok-profile",
			"sessions",
			encodeURIComponent("/workspace/repo"),
			"thread-grok-2",
		);
		await mkdir(sessionDir, { recursive: true });
		const expected = path.join(sessionDir, "events.jsonl");
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "grok",
				threadId: "thread-grok-2",
			}),
			expected,
		);
	});

	it("does not match a partial or unrelated thread id", async () => {
		const root = await makeRoot();
		const sessions = path.join(root, "agent-home", "codex-profile", "sessions");
		await mkdir(sessions, { recursive: true });
		await writeFile(path.join(sessions, "rollout-thread-12.jsonl"), "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "codex",
				threadId: "thread-1",
			}),
			null,
		);
	});

	it("selects the forked transcript rather than the parent transcript", async () => {
		const root = await makeRoot();
		const sessions = path.join(
			root,
			"agent-home",
			"codex-profile",
			"sessions",
			"2026",
			"07",
		);
		await mkdir(sessions, { recursive: true });
		await writeFile(
			path.join(sessions, "rollout-2026-07-parent-thread.jsonl"),
			"{}\n",
		);
		const expected = path.join(sessions, "rollout-2026-07-forked-thread.jsonl");
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "codex",
				threadId: "forked-thread",
			}),
			expected,
		);
	});

	it("finds transcripts in per-profile agent homes without mixing them", async () => {
		const root = await makeRoot();
		const grokExpected = path.join(
			root,
			"agent-home",
			"grok-4.5-WL4xmdq",
			"sessions",
			encodeURIComponent("/workspace/repo"),
			"thread-orch",
			"chat_history.jsonl",
		);
		const codexExpected = path.join(
			root,
			"agent-home",
			"GPT-5.6-luna-SvNUmbo",
			"sessions",
			"2026",
			"09",
			"rollout-2026-09-hunter-thread.jsonl",
		);
		await mkdir(path.dirname(grokExpected), { recursive: true });
		await mkdir(path.dirname(codexExpected), { recursive: true });
		await writeFile(grokExpected, "{}\n");
		await writeFile(codexExpected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "grok",
				threadId: "thread-orch",
			}),
			grokExpected,
		);
		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "codex",
				threadId: "hunter-thread",
			}),
			codexExpected,
		);
	});
});
