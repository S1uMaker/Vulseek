import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	validateRequest: vi.fn(),
	findRuntime: vi.fn(),
	findOrganization: vi.fn(),
	getSnapshot: vi.fn(),
	subscribe: vi.fn(),
}));

vi.mock("@vulseek/server", () => ({
	validateRequest: mocks.validateRequest,
	findAgentStreamRuntimeByTaskId: mocks.findRuntime,
	findScanJobOrganizationId: mocks.findOrganization,
	DriverPromptEventParser: class {
		reset() {}
		push(content: string) {
			return content
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((event) => event.type === "vulseek_prompt")
				.map((event) => ({ ...event, offset: content.length }));
		}
	},
}));

vi.mock("@/server/utils/file-stream-buffer", () => ({
	getFileStreamBuffer: () => ({
		getSnapshot: mocks.getSnapshot,
		subscribe: mocks.subscribe,
	}),
}));

import handler from "@/pages/api/scan/tasks/[taskId]/agent-stream";

const runtime = (overrides: Record<string, unknown> = {}) => {
	const { runtime: runtimeOverride, ...rest } = overrides;
	return {
	runtime: {
		taskId: "task-1",
		scanJobId: "job-1",
		status: "running",
		baseDir: "/scan",
		runtimeDir: "/scan/task-1",
		stdoutPath: "/scan/task-1/stdout",
		createdAt: "2026-08-24T00:00:00.000Z",
		updatedAt: "2026-08-24T00:00:00.000Z",
		...((runtimeOverride as Record<string, unknown> | undefined) || {}),
	},
	provider: "codex",
	threadId: "thread-1",
	roots: ["/scan/task-1"],
	transcriptPath: "/scan/task-1/agent-home/sessions/rollout-thread-1.jsonl",
	promptSources: [
		{
			taskId: "task-1",
			stdoutPath: "/scan/task-1/stdout",
		},
	],
	...rest,
	};
};

const makeRequest = () => {
	let close: (() => void) | undefined;
	return {
		request: {
			method: "GET",
			query: { taskId: "task-1" },
			on: vi.fn((event: string, listener: () => void) => {
				if (event === "close") close = listener;
			}),
		},
		close: () => close?.(),
	};
};

const makeResponse = () => {
	const writes: string[] = [];
	const response = {
		statusCode: 200,
		writableEnded: false,
		jsonBody: null as unknown,
		status(code: number) {
			this.statusCode = code;
			return this;
		},
		json(payload: unknown) {
			this.jsonBody = payload;
			this.writableEnded = true;
			return this;
		},
		writeHead: vi.fn(),
		flushHeaders: vi.fn(),
		write(chunk: string) {
			writes.push(chunk);
			return true;
		},
		end() {
			this.writableEnded = true;
		},
	};
	return { response, writes };
};

const eventNames = (writes: string[]) =>
	[...writes.join("").matchAll(/^event: ([^\n]+)$/gm)].map((match) => match[1]);

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.validateRequest.mockResolvedValue({
		user: { id: "user-1" },
		session: { activeOrganizationId: "org-1" },
	});
	mocks.findRuntime.mockResolvedValue(runtime());
	mocks.findOrganization.mockResolvedValue("org-1");
	mocks.getSnapshot.mockResolvedValue({
		content: '{"type":"session_meta"}\n',
		offset: 24,
	});
	mocks.subscribe.mockReturnValue(vi.fn());
});

describe("task AgentStream SSE", () => {
	it("returns 401 without resolving task files for an unauthenticated request", async () => {
		mocks.validateRequest.mockResolvedValue({ user: null, session: null });
		const { request } = makeRequest();
		const { response } = makeResponse();

		await handler(request as never, response as never);

		expect(response.statusCode).toBe(401);
		expect(mocks.findRuntime).not.toHaveBeenCalled();
	});

	it("returns 403 when the task belongs to another organization", async () => {
		mocks.findOrganization.mockResolvedValue("org-2");
		const { request } = makeRequest();
		const { response } = makeResponse();

		await handler(request as never, response as never);

		expect(response.statusCode).toBe(403);
	});

	it("sends a complete snapshot followed by native transcript appends", async () => {
		const subscribers: Array<
			(event: { type: string; content: string; offset: number }) => void
		> = [];
		mocks.subscribe.mockImplementation((listener) => {
			subscribers.push(listener);
			return vi.fn();
		});
		const { request, close } = makeRequest();
		const { response, writes } = makeResponse();

		await handler(request as never, response as never);
		subscribers[0]?.({ type: "append", content: "next\n", offset: 29 });

		expect(eventNames(writes)).toEqual([
			"metadata",
			"snapshot_start",
			"chunk",
			"snapshot_end",
			"append",
		]);
		close();
	});

	it("sends stdout prompt events through the session stream", async () => {
		const prompt = {
			type: "vulseek_prompt",
			promptId: "prompt-1",
			taskId: "task-1",
			sessionId: "thread-1",
			turnIndex: 1,
			timestamp: "2026-08-24T00:00:00.000Z",
			text: "Inspect the repository",
		};
		mocks.getSnapshot.mockResolvedValue({
			content: `${JSON.stringify(prompt)}\n`,
			offset: JSON.stringify(prompt).length + 1,
		});
		const { request, close } = makeRequest();
		const { response, writes } = makeResponse();

		await handler(request as never, response as never);

		expect(eventNames(writes)).toContain("prompt");
		expect(writes.join("")).toContain("Inspect the repository");
		close();
	});

	it("waits for a thread and reports source_unavailable for a terminal task", async () => {
		mocks.findRuntime
			.mockResolvedValueOnce(runtime({ threadId: null, transcriptPath: null }))
			.mockResolvedValueOnce(
				runtime({
					threadId: null,
					transcriptPath: null,
					runtime: { taskId: "task-1", scanJobId: "job-1", status: "failed" },
				}),
			);
		const { request } = makeRequest();
		const { response, writes } = makeResponse();

		await handler(request as never, response as never);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(eventNames(writes)).toEqual([
			"metadata",
			"waiting",
			"waiting",
			"stream_error",
			"done",
		]);
		expect(writes.join("")).toContain("source_unavailable");
		expect(response.writableEnded).toBe(true);
	});

	it("re-sends a full snapshot for each reconnect", async () => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const { request, close } = makeRequest();
			const { response, writes } = makeResponse();
			await handler(request as never, response as never);
			expect(eventNames(writes)).toContain("snapshot_start");
			expect(eventNames(writes)).toContain("snapshot_end");
			close();
		}
		expect(mocks.getSnapshot).toHaveBeenCalledTimes(6);
	});
});
