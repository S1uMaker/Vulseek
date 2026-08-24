import { createServer, type IncomingMessage, type Server } from "node:http";
import { join, dirname } from "node:path";
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
							title: "Hunt",
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
			title: "Hunt",
			status: "running",
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
