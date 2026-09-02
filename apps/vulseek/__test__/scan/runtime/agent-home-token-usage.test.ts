import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseCcusageSessionOutput,
	resolveCcusageSessionId,
	selectCcusageSessionUsage,
} from "../../../../../packages/server/src/services/scan/runtime/agent-home-token-usage";

describe("agent-home token usage", () => {
	it("sums Claude --id entry buckets as uncached input plus cache", () => {
		const usage = parseCcusageSessionOutput(
			JSON.stringify({
				sessionId: "thread-1",
				totalTokens: 650,
				entries: [
					{
						inputTokens: 100,
						outputTokens: 20,
						cacheCreationTokens: 10,
						cacheReadTokens: 200,
					},
					{
						inputTokens: 50,
						outputTokens: 5,
						cacheCreationTokens: 0,
						cacheReadTokens: 300,
					},
				],
			}),
		);
		expect(usage).toEqual({
			inputTokens: 150,
			outputTokens: 25,
			thoughtTokens: 0,
			cachedReadTokens: 500,
			cachedWriteTokens: 10,
			estimatedCost: 0,
			totalTokens: 685,
		});
	});

	it("reads Codex session rows with cache subtracted from input", () => {
		const usage = selectCcusageSessionUsage(
			JSON.stringify({
				sessions: [
					{
						sessionId: "2026/08/31/rollout-abc-thread-9",
						inputTokens: 1407,
						cacheCreationTokens: 0,
						cacheReadTokens: 191232,
						outputTokens: 495,
						reasoningOutputTokens: 411,
						totalTokens: 193134,
					},
					{
						sessionId: "other",
						inputTokens: 1,
						cacheReadTokens: 2,
						outputTokens: 3,
					},
				],
			}),
			"thread-9",
		);
		expect(usage).toMatchObject({
			inputTokens: 1407,
			cachedReadTokens: 191232,
			outputTokens: 495,
			thoughtTokens: 411,
			cachedWriteTokens: 0,
			estimatedCost: 0,
		});
		expect(usage?.totalTokens).toBe(1407 + 191232 + 495);
	});

	it("reads ccusage session cost from totalCost", () => {
		const usage = selectCcusageSessionUsage(
			JSON.stringify({
				sessions: [
					{
						sessionId: "2026/08/31/rollout-abc-thread-9",
						inputTokens: 1407,
						cacheReadTokens: 191232,
						outputTokens: 495,
						totalCost: 0.17,
					},
				],
			}),
			"thread-9",
		);
		expect(usage?.estimatedCost).toBe(0.17);
	});

	it("sums entry costs and falls back to the session totalCost", () => {
		const fromEntries = parseCcusageSessionOutput(
			JSON.stringify({
				sessionId: "thread-1",
				entries: [
					{ inputTokens: 100, outputTokens: 10, totalCost: 0.02 },
					{ inputTokens: 50, outputTokens: 5, totalCost: 0.01 },
				],
			}),
		);
		expect(fromEntries?.estimatedCost).toBe(0.03);
		const fromRoot = parseCcusageSessionOutput(
			JSON.stringify({
				sessionId: "thread-1",
				totalCost: 0.44,
				entries: [{ inputTokens: 100, outputTokens: 10 }],
			}),
		);
		expect(fromRoot?.estimatedCost).toBe(0.44);
	});

	it("resolves Claude session id as the thread id", async () => {
		const sessionId = await resolveCcusageSessionId({
			provider: "claude_code",
			threadId: "282966cd-975f-4bcc-a01a-93eed3b96ac9",
			agentHomePath: "/tmp/agent-home",
		});
		expect(sessionId).toBe("282966cd-975f-4bcc-a01a-93eed3b96ac9");
	});

	it("resolves Codex session id from the rollout jsonl path", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "vulseek-ccusage-id-"));
		const jobId = "job1";
		const jobRoot = path.join(root, "jobs", jobId);
		const agentHome = path.join(jobRoot, "agent-home", "codex-profile");
		const relative = path.join(
			"2026",
			"08",
			"31",
			"rollout-xyz-thread-42.jsonl",
		);
		const filePath = path.join(agentHome, "sessions", relative);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, "{}\n");
		const sessionId = await resolveCcusageSessionId({
			provider: "codex",
			threadId: "thread-42",
			agentHomePath: agentHome,
		});
		expect(sessionId).toBe("2026/08/31/rollout-xyz-thread-42");
	});
});
