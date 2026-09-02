import { describe, expect, it } from "vitest";
import {
	formatAgentStreamProvider,
	formatAgentStreamToolPreview,
	isAgentStreamNearBottom,
	mergeAgentStreamTurns,
	reduceAgentStreamConnectionState,
	shouldShowAgentStreamSpinner,
} from "../components/dashboard/scanning/agent-stream-state";
import type { AgentStreamEvent } from "../components/dashboard/scanning/agent-stream-transport";

describe("shouldShowAgentStreamSpinner", () => {
	it("shows a spinner for the active thinking block", () => {
		expect(
			shouldShowAgentStreamSpinner({
				status: "streaming",
				isLastTurn: true,
				isLastBlock: true,
				kind: "thinking",
				hasPendingToolResult: false,
			}),
		).toBe(true);
	});

	it("shows a spinner for a tool without a result", () => {
		expect(
			shouldShowAgentStreamSpinner({
				status: "running",
				isLastTurn: true,
				isLastBlock: true,
				kind: "tool_use",
				hasPendingToolResult: true,
			}),
		).toBe(true);
	});

	it("does not show a spinner after completion or on historical blocks", () => {
		expect(
			shouldShowAgentStreamSpinner({
				status: "completed",
				isLastTurn: true,
				isLastBlock: true,
				kind: "thinking",
				hasPendingToolResult: false,
			}),
		).toBe(false);
		expect(
			shouldShowAgentStreamSpinner({
				status: "streaming",
				isLastTurn: false,
				isLastBlock: true,
				kind: "thinking",
				hasPendingToolResult: false,
			}),
		).toBe(false);
	});
});

describe("AgentStream incremental state", () => {
	it("maps transport lifecycle events to visible connection state", () => {
		let state = { status: "connecting", error: null as string | null };
		const apply = (event: AgentStreamEvent) => {
			state = reduceAgentStreamConnectionState(state, event);
		};

		apply({
			type: "metadata",
			payload: {
				taskId: "task-1",
				scanJobId: "job-1",
				provider: "codex",
				threadId: null,
				status: "starting",
			},
		});
		expect(state).toEqual({ status: "starting", error: null });

		apply({ type: "waiting", payload: { reason: "thread_id" } });
		expect(state).toEqual({ status: "waiting:thread_id", error: null });

		apply({
			type: "snapshot_start",
			payload: {
				taskId: "task-1",
				scanJobId: "job-1",
				provider: "codex",
				threadId: "thread-1",
				status: "running",
			},
		});
		expect(state).toEqual({ status: "streaming", error: null });

		apply({
			type: "done",
			payload: { status: "completed", taskId: "task-1" },
		});
		expect(state).toEqual({ status: "completed", error: null });

		apply({
			type: "stream_error",
			payload: { code: "source_unavailable", message: "Transcript missing" },
		});
		expect(state).toEqual({ status: "error", error: "Transcript missing" });
	});

	it("keeps stable turn references before changedFrom", () => {
		const first = { index: 1, user_text: "one", blocks: [] };
		const second = { index: 2, user_text: "two", blocks: [] };
		const updatedSecond = { ...second, blocks: [{ kind: "text" }] };
		const merged = mergeAgentStreamTurns(
			[first, second],
			[{ ...first }, updatedSecond],
			1,
		);

		expect(merged[0]).toBe(first);
		expect(merged[1]).toBe(updatedSecond);
	});

	it("detects whether the timeline is close enough to auto-follow", () => {
		expect(
			isAgentStreamNearBottom({
				scrollHeight: 1000,
				scrollTop: 760,
				clientHeight: 220,
			}),
		).toBe(true);
		expect(
			isAgentStreamNearBottom({
				scrollHeight: 1000,
				scrollTop: 600,
				clientHeight: 220,
			}),
		).toBe(false);
	});

	it("uses the actual provider label", () => {
		expect(formatAgentStreamProvider("codex")).toBe("CODEX");
		expect(formatAgentStreamProvider("grok")).toBe("GROK BUILD");
		expect(formatAgentStreamProvider("claude-code")).toBe("CLAUDE CODE");
	});
});

describe("formatAgentStreamToolPreview", () => {
	it("prefers command and path fields", () => {
		expect(
			formatAgentStreamToolPreview({
				name: "exec",
				input: { command: "ls /workspace" },
			}),
		).toBe("ls /workspace");
		expect(
			formatAgentStreamToolPreview({
				name: "edit",
				input: { file_path: "/workspace/README.md" },
			}),
		).toBe("/workspace/README.md");
	});

	it("extracts cmd from grok/codex raw exec_command wrappers", () => {
		expect(
			formatAgentStreamToolPreview({
				name: "exec",
				input: {
					raw: 'const r = await tools.exec_command({cmd:"python3 \\"$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py\\" list_hunters","workdir":"/workspace/repo"});',
				},
			}),
		).toBe(
			'python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" list_hunters',
		);
	});

	it("falls back to compacted raw text", () => {
		expect(
			formatAgentStreamToolPreview({
				name: "exec",
				input: { raw: "foo\nbar" },
			}),
		).toBe("foo bar");
	});
});
