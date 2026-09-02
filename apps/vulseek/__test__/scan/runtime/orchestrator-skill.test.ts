import { createServer, type IncomingMessage, type Server } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const skillPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../../agents/skills/orchestrator/orchestrator.py",
);

type MockRequest = {
	method?: string;
	url?: string;
	body: string;
};

const startMockApi = async (
	handler: (req: MockRequest) => { status: number; body: unknown },
) => {
	const server: Server = createServer((req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("end", () => {
			const result = handler({
				method: req.method,
				url: req.url,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			res.statusCode = result.status;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(result.body));
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("mock API did not bind a port");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};

const runtimeEnv = {
	VULSEEK_SCAN_JOB_ID: "job-1",
	VULSEEK_TASK_ID: "orch-task",
	VULSEEK_STAGE_NAME: "orchestrator",
};

const runSkill = async (args: string[], extraEnv: Record<string, string> = {}) =>
	execFileAsync("python3", [skillPath, ...args], {
		env: { ...process.env, ...runtimeEnv, ...extraEnv },
	});

const runSkillWithStdin = (args: string[], stdin: string) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = execFile(
			"python3",
			args,
			{ env: { ...process.env, ...runtimeEnv } },
			(error, stdout, stderr) => {
				if (error) {
					(
						error as {
							stdout?: string;
							stderr?: string;
						}
					).stdout = String(stdout);
					(
						error as {
							stdout?: string;
							stderr?: string;
						}
					).stderr = String(stderr);
					reject(error);
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			},
		);
		child.stdin?.write(stdin);
		child.stdin?.end();
	});

describe("orchestrator Python CLI", () => {
	const servers: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	it("lists hunter slots and running hunters", async () => {
		const api = await startMockApi((req) => {
			if (req.url?.includes("downstream-capacity")) {
				return {
					status: 200,
					body: {
						ok: true,
						stages: [
							{
								stageName: "hunter",
								concurrency: 8,
								activeTasks: 2,
								availableSlots: 6,
							},
						],
					},
				};
			}
			if (req.url?.includes("running-tasks")) {
				return {
					status: 200,
					body: {
						ok: true,
						tasks: [
							{
								taskId: "hunter-1",
								name: "#1 xmlrpc",
								title: "#1 xmlrpc",
								status: "running",
								startedAt: "2026-08-30T00:00:00.000Z",
								updatedAt: "2026-08-30T00:01:00.000Z",
							},
						],
					},
				};
			}
			return { status: 404, body: { ok: false } };
		});
		servers.push(api);
		const { stdout } = await runSkill([
			"list_hunters",
			"--api-url",
			api.url,
			"--token",
			"test-token",
		]);
		expect(JSON.parse(stdout)).toMatchObject({
			ok: true,
			availableSlots: 6,
			concurrency: 8,
			activeCount: 2,
			hunters: [
				{
					name: "#1 xmlrpc",
					taskId: "hunter-1",
					status: "running",
				},
			],
		});
	});

	it("polls hunter feedback and completes returned task outputs", async () => {
		const requests: MockRequest[] = [];
		const api = await startMockApi((req) => {
			requests.push(req);
			if (req.url?.includes("poll-messages")) {
				expect(req.method).toBe("POST");
				return {
					status: 200,
					body: {
						ok: true,
						messages: [
							{
								messageId: "to-1",
								name: "#1 xmlrpc",
								input: { name: "#1 xmlrpc", feedback: "no chain" },
							},
						],
					},
				};
			}
			if (req.url?.includes("complete-messages")) {
				expect(req.method).toBe("POST");
				expect(JSON.parse(req.body)).toEqual({ messageIds: ["to-1"] });
				return {
					status: 200,
					body: { ok: true, completedMessageIds: ["to-1"] },
				};
			}
			return { status: 404, body: { ok: false } };
		});
		servers.push(api);
		const { stdout } = await runSkill([
			"get_hunter_feedback",
			"--api-url",
			api.url,
			"--token",
			"test-token",
		]);
		expect(JSON.parse(stdout)).toEqual({
			ok: true,
			feedback: [
				{
					name: "#1 xmlrpc",
					feedback: "no chain",
					messageId: "to-1",
				},
			],
		});
		expect(requests).toHaveLength(2);
	});

	it("returns empty feedback when poll-messages has no inbound messages", async () => {
		const api = await startMockApi((req) => {
			if (req.url?.includes("poll-messages")) {
				return {
					status: 200,
					body: {
						ok: true,
						messages: [],
					},
				};
			}
			return { status: 404, body: { ok: false } };
		});
		servers.push(api);
		const { stdout } = await runSkill([
			"get_hunter_feedback",
			"--api-url",
			api.url,
			"--token",
			"test-token",
		]);
		expect(JSON.parse(stdout)).toEqual({ ok: true, feedback: [] });
	});

	it("submits hunts within available slots and appends the hunter footer", async () => {
		const requests: MockRequest[] = [];
		const api = await startMockApi((req) => {
			requests.push(req);
			if (req.url?.includes("downstream-capacity")) {
				return {
					status: 200,
					body: {
						ok: true,
						stages: [
							{
								stageName: "hunter",
								concurrency: 8,
								activeTasks: 0,
								availableSlots: 8,
							},
						],
					},
				};
			}
			if (req.url?.includes("messages")) {
				return {
					status: 201,
					body: {
						ok: true,
						message: { messageId: "to-spawn", sequence: 1 },
					},
				};
			}
			return { status: 404, body: { ok: false } };
		});
		servers.push(api);
		const { stdout } = await runSkillWithStdin(
			[
				skillPath,
				"spawn_hunters",
				"--api-url",
				api.url,
				"--token",
				"test-token",
			],
			JSON.stringify({
				hunters: [
					{
						name: "#1 xmlrpc-auth",
						goalPrompt: "Hunt XML-RPC authz.",
					},
				],
			}),
		);
		const submitted = JSON.parse(
			requests.find((item) => item.url?.includes("messages"))?.body ?? "{}",
		);
		expect(submitted.output.huntTasks).toHaveLength(1);
		expect(submitted.output.huntTasks[0].name).toBe("#1 xmlrpc-auth");
		expect(submitted.output.huntTasks[0].goalPrompt).toContain(
			"Hunt XML-RPC authz.",
		);
		expect(submitted.output.huntTasks[0].goalPrompt).toContain(
			"scan-runtime submit-message command",
		);
		expect(submitted.output.candidates).toEqual([]);
		expect(stdout).toContain("to-spawn");
	});

	it("rejects spawn when hunters exceed availableSlots", async () => {
		const api = await startMockApi(() => ({
			status: 200,
			body: {
				ok: true,
				stages: [
					{
						stageName: "hunter",
						concurrency: 8,
						activeTasks: 7,
						availableSlots: 1,
					},
				],
			},
		}));
		servers.push(api);
		await expect(
			runSkillWithStdin(
				[
					skillPath,
					"spawn_hunters",
					"--api-url",
					api.url,
					"--token",
					"test-token",
				],
				JSON.stringify({
					hunters: [
						{ name: "#1 a", goalPrompt: "one" },
						{ name: "#2 b", goalPrompt: "two" },
					],
				}),
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("exceeds availableSlots 1"),
		});
	});

	it("rejects spawn_hunters payloads that include candidates", async () => {
		await expect(
			runSkillWithStdin(
				[skillPath, "spawn_hunters", "--api-url", "http://127.0.0.1:9", "--token", "t"],
				JSON.stringify({
					hunters: [{ name: "#1 a", goalPrompt: "one" }],
					candidates: [],
				}),
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("does not take candidates"),
		});
	});

	const sampleCandidate = {
		id: "L1",
		functionId: null,
		title: "Unauth pingback SSRF",
		description: "Blind SSRF via pingback.ping",
		filePath: "wp-includes/http.php",
		line: 596,
		vulnerabilityType: "ssrf",
		confidence: 0.9,
		score: 7.5,
		claim: "Unauthenticated pingback can fetch 169.254.169.254",
		rootCauseKey: "http-validate-url-link-local",
		evidence: [],
		attackerControl: "XML-RPC args[0]",
		affectedSink: "wp_safe_remote_get",
		preconditions: ["xmlrpc enabled"],
		quickDisproofAttempt: "checked wp_http_validate_url",
		needsFuzzing: false,
		needsManualAnalysis: false,
	};

	it("submits candidates without huntTasks", async () => {
		const requests: MockRequest[] = [];
		const api = await startMockApi((req) => {
			requests.push(req);
			if (req.url?.includes("messages")) {
				return {
					status: 201,
					body: {
						ok: true,
						message: { messageId: "to-cand", sequence: 8 },
					},
				};
			}
			return { status: 404, body: { ok: false } };
		});
		servers.push(api);
		const { stdout } = await runSkillWithStdin(
			[
				skillPath,
				"submit_candidate",
				"--api-url",
				api.url,
				"--token",
				"test-token",
			],
			JSON.stringify({ candidates: [sampleCandidate] }),
		);
		const submitted = JSON.parse(
			requests.find((item) => item.url?.includes("messages"))?.body ?? "{}",
		);
		expect(submitted.output.huntTasks).toEqual([]);
		expect(submitted.output.candidates).toEqual([sampleCandidate]);
		expect(stdout).toContain("to-cand");
	});

	it("accepts submit-candidate as an alias", async () => {
		const api = await startMockApi((req) => {
			if (req.url?.includes("messages")) {
				return {
					status: 201,
					body: { ok: true, message: { messageId: "to-alias" } },
				};
			}
			return { status: 404, body: { ok: false } };
		});
		servers.push(api);
		const { stdout } = await runSkillWithStdin(
			[
				skillPath,
				"submit-candidate",
				"--api-url",
				api.url,
				"--token",
				"test-token",
			],
			JSON.stringify({ candidates: [sampleCandidate] }),
		);
		expect(stdout).toContain("to-alias");
	});

	it("rejects submit_candidate payloads that include hunters", async () => {
		await expect(
			runSkillWithStdin(
				[
					skillPath,
					"submit_candidate",
					"--api-url",
					"http://127.0.0.1:9",
					"--token",
					"t",
				],
				JSON.stringify({
					hunters: [],
					candidates: [sampleCandidate],
				}),
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("does not take hunters"),
		});
	});
});
