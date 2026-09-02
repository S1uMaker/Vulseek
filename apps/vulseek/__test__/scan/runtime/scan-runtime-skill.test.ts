import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const skillPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../../agents/skills/scan-runtime/query_scan_runtime.py",
);

const startMockApi = async (
	handler: (req: IncomingMessage) => { status: number; body: unknown },
) => {
	const server: Server = createServer((req, res) => {
		const result = handler(req);
		res.statusCode = result.status;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(result.body));
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

const runSkill = async (args: string[], extraEnv: Record<string, string> = {}) =>
	execFileAsync("python3", [skillPath, ...args], {
		env: { ...process.env, ...extraEnv },
	});

describe("scan-runtime Python CLI", () => {
	const servers: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	it("queries downstream-capacity with runtime identity from environment", async () => {
		const api = await startMockApi((req) => {
			expect(req.method).toBe("GET");
			expect(req.url).toBe(
				"/api/internal/scan/runtime/downstream-capacity?toStage=hunter",
			);
			expect(req.headers.authorization).toBe("Bearer test-token");
			expect(req.headers["x-vulseek-scan-job-id"]).toBe("job-1");
			expect(req.headers["x-vulseek-task-id"]).toBe("orch-task");
			return {
				status: 200,
				body: {
					ok: true,
					scanJobId: "job-1",
					currentStage: "orchestrator",
					stages: [
						{
							stageName: "hunter",
							concurrency: 8,
							activeTasks: 3,
							availableSlots: 5,
						},
					],
				},
			};
		});
		servers.push(api);
		const { stdout } = await runSkill([
			"downstream-capacity",
			"--to-stage",
			"hunter",
			"--api-url",
			api.url,
			"--token",
			"test-token",
		], {
			VULSEEK_SCAN_JOB_ID: "job-1",
			VULSEEK_TASK_ID: "orch-task",
			VULSEEK_STAGE_NAME: "orchestrator",
		});
		expect(JSON.parse(stdout).stages[0].availableSlots).toBe(5);
	});

	it("queries active tasks for the requested stage", async () => {
		const api = await startMockApi((req) => {
			expect(req.url).toBe(
				"/api/internal/scan/runtime/running-tasks?stage=hunter",
			);
			expect(req.headers.authorization).toBe("Bearer test-token");
			expect(req.headers["x-vulseek-scan-job-id"]).toBe("job-1");
			expect(req.headers["x-vulseek-task-id"]).toBe("orch-task");
			return {
				status: 200,
				body: {
					ok: true,
					scanJobId: "job-1",
					currentStage: "orchestrator",
					stageName: "hunter",
					tasks: [
						{
							taskId: "hunter-task",
							stageName: "hunter",
							name: "xmlrpc-unauth",
							title: "xmlrpc-unauth",
							status: "running",
						},
					],
				},
			};
		});
		servers.push(api);
		const { stdout } = await runSkill([
			"running-tasks",
			"--stage",
			"hunter",
			"--api-url",
			api.url,
			"--token",
			"test-token",
		], {
			VULSEEK_SCAN_JOB_ID: "job-1",
			VULSEEK_TASK_ID: "orch-task",
			VULSEEK_STAGE_NAME: "orchestrator",
		});
		expect(JSON.parse(stdout).tasks[0]).toMatchObject({
			taskId: "hunter-task",
			name: "xmlrpc-unauth",
			title: "xmlrpc-unauth",
			status: "running",
		});
	});

	it("queries completed stage outputs for a downstream stage", async () => {
		const api = await startMockApi((req) => {
			expect(req.url).toBe(
				"/api/internal/scan/runtime/stage-outputs?stage=hunter",
			);
			return {
				status: 200,
				body: {
					ok: true,
					outputs: [
						{
							name: "xmlrpc-unauth",
							taskId: "hunter-task",
							output: { name: "xmlrpc-unauth", feedback: "no chain" },
						},
					],
				},
			};
		});
		servers.push(api);
		const { stdout } = await runSkill(
			[
				"stage-outputs",
				"--stage",
				"hunter",
				"--api-url",
				api.url,
				"--token",
				"test-token",
			],
			{
				VULSEEK_SCAN_JOB_ID: "job-1",
				VULSEEK_TASK_ID: "orch-task",
				VULSEEK_STAGE_NAME: "orchestrator",
			},
		);
		expect(JSON.parse(stdout).outputs[0].name).toBe("xmlrpc-unauth");
	});

	it("polls queued inbound tasks for the current stage", async () => {
		const api = await startMockApi((req) => {
			expect(req.method).toBe("POST");
			expect(req.url).toBe(
				"/api/internal/scan/runtime/poll-messages?stage=orchestrator",
			);
			return {
				status: 200,
				body: {
					ok: true,
					messages: [
						{
							messageId: "to-hunter-1",
							name: "xmlrpc-unauth",
							input: { name: "xmlrpc-unauth", feedback: "no chain" },
						},
					],
				},
			};
		});
		servers.push(api);
		const { stdout } = await runSkill(
			[
				"poll-messages",
				"--stage",
				"orchestrator",
				"--api-url",
				api.url,
				"--token",
				"test-token",
			],
			{
				VULSEEK_SCAN_JOB_ID: "job-1",
				VULSEEK_TASK_ID: "orch-task",
				VULSEEK_STAGE_NAME: "orchestrator",
			},
		);
		expect(JSON.parse(stdout).messages[0].name).toBe("xmlrpc-unauth");
	});

	it("completes queued inbound tasks by id", async () => {
		const api = await startMockApi((req) => {
			expect(req.method).toBe("POST");
			expect(req.url).toBe(
				"/api/internal/scan/runtime/complete-messages?stage=orchestrator",
			);
			return {
				status: 200,
				body: { ok: true, completedMessageIds: ["to-hunter-1"] },
			};
		});
		servers.push(api);
		const { stdout } = await runSkill(
			[
				"complete-messages",
				"--stage",
				"orchestrator",
				"--message-id",
				"to-hunter-1",
				"--api-url",
				api.url,
				"--token",
				"test-token",
			],
			{
				VULSEEK_SCAN_JOB_ID: "job-1",
				VULSEEK_TASK_ID: "orch-task",
				VULSEEK_STAGE_NAME: "orchestrator",
			},
		);
		expect(JSON.parse(stdout).completedMessageIds).toEqual([
			"to-hunter-1",
		]);
	});

	it("posts submit-message JSON from stdin", async () => {
		const requests: Array<{ url?: string; method?: string }> = [];
		const api = await startMockApi((req) => {
			requests.push({ url: req.url, method: req.method });
			return {
				status: 201,
				body: {
					ok: true,
					idempotent: false,
					message: { messageId: "to-1", sequence: 1 },
				},
			};
		});
		servers.push(api);
		const { stdout } = await new Promise<{ stdout: string }>(
			(resolve, reject) => {
				const child = execFile(
					"python3",
					[
						skillPath,
						"submit-message",
						"--api-url",
						api.url,
						"--token",
						"test-token",
						"--route",
						"hunt",
						"--submission-key",
						"k1",
					],
					{
						env: {
							...process.env,
							VULSEEK_SCAN_JOB_ID: "job-1",
							VULSEEK_TASK_ID: "orch-task",
							VULSEEK_STAGE_NAME: "orchestrator",
						},
					},
					(error, stdout) => {
						if (error) reject(error);
						else resolve({ stdout: String(stdout) });
					},
				);
				child.stdin?.write('{"huntTasks":[]}\n');
				child.stdin?.end();
			},
		);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe("/api/internal/scan/runtime/messages");
		expect(stdout).toContain("to-1");
	});

	it("submits output and writes a debug copy after automatic validation", async () => {
		const debugDir = await mkdtemp(join(tmpdir(), "scan-runtime-debug-"));
		const debugPath = join(debugDir, "output.json");
		const api = await startMockApi(() => ({
			status: 200,
			body: {
				ok: true,
				idempotent: false,
				message: { messageId: "to-2", sequence: 1 },
			},
		}));
		servers.push(api);
		const { stdout } = await new Promise<{ stdout: string }>(
			(resolve, reject) => {
				const child = execFile(
					"python3",
					[
						skillPath,
						"submit-message",
						"--api-url",
						api.url,
						"--token",
						"test-token",
						"--route",
						"hunt",
					],
					{
						env: {
							...process.env,
							VULSEEK_SCAN_JOB_ID: "job-1",
							VULSEEK_TASK_ID: "orch-task",
							VULSEEK_STAGE_NAME: "orchestrator",
							VULSEEK_DEBUG_OUTPUT_PATH: debugPath,
						},
					},
					(error, stdout) => {
						if (error) reject(error);
						else resolve({ stdout: String(stdout) });
					},
				);
				child.stdin?.write('{"huntTasks":["alpha"]}\n');
				child.stdin?.end();
			},
		);
		expect(stdout).toContain("to-2");
		expect(JSON.parse(await readFile(debugPath, "utf8"))).toEqual({
			huntTasks: ["alpha"],
		});
	});

	it("exits when runtime identity is missing", async () => {
		await expect(
			runSkill([
				"downstream-capacity",
				"--api-url",
				"http://127.0.0.1:9",
				"--token",
				"test-token",
			]),
		).rejects.toThrow();
	});

	it("exits on HTTP 401", async () => {
		const api = await startMockApi(() => ({
			status: 401,
			body: { ok: false, error: "Invalid runtime token" },
		}));
		servers.push(api);
		await expect(
			runSkill([
				"downstream-capacity",
				"--api-url",
				api.url,
				"--token",
				"bad",
			], {
				VULSEEK_SCAN_JOB_ID: "job-1",
				VULSEEK_TASK_ID: "orch-task",
				VULSEEK_STAGE_NAME: "orchestrator",
			}),
		).rejects.toThrow();
	});
});
