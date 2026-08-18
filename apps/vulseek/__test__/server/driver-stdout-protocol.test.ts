import { describe, expect, it } from "vitest";
import {
	parseDriverStdout,
	readLatestDriverStdoutEvent,
} from "../../../../packages/server/src/services/scan/runtime/driver-stdout-protocol";

describe("driver stdout protocol", () => {
	it("extracts the latest activity, usage, task state, and exit event", () => {
		const parsed = parseDriverStdout(
			[
				JSON.stringify({ type: "start", pid: 42 }),
				JSON.stringify({ type: "activity", activity: { kind: "tool" } }),
				JSON.stringify({
					type: "usage",
					usage: { inputTokens: 10, outputTokens: 4 },
				}),
				JSON.stringify({
					type: "task_done",
					taskId: "task-1",
					status: "completed",
					stopReason: "end_turn",
				}),
				JSON.stringify({ type: "exit", code: 0 }),
			].join("\n"),
		);

		expect(parsed.latestActivity).toEqual({ kind: "tool" });
		expect(parsed.activityRevision).toBe(1);
		expect(parsed.activityEvents).toEqual([
			{ revision: 1, activity: { kind: "tool" } },
		]);
		expect(parsed.latestUsage).toEqual({ inputTokens: 10, outputTokens: 4 });
		expect(parsed.latestTask).toMatchObject({
			type: "task_done",
			taskId: "task-1",
			status: "completed",
		});
		expect(parsed.exitCode).toBe(0);
	});

	it("keeps goal and following activities in the same ordered activity stream", () => {
		const parsed = parseDriverStdout(
			[
				JSON.stringify({
					type: "activity",
					activity: {
						kind: "goal",
						label: "Goal active",
						goal: { objective: "Audit", status: "active" },
					},
				}),
				JSON.stringify({ type: "activity", activity: { kind: "reasoning" } }),
			].join("\n"),
		);

		expect(parsed.activityRevision).toBe(2);
		expect(parsed.activityEvents.map((event) => event.activity)).toEqual([
			{
				kind: "goal",
				label: "Goal active",
				goal: { objective: "Audit", status: "active" },
			},
			{ kind: "reasoning" },
		]);
	});

	it("ignores malformed and unknown lines while preserving valid events", () => {
		const parsed = parseDriverStdout(
			[
				"not json",
				JSON.stringify({ type: "unknown", value: true }),
				JSON.stringify({ type: "usage", usage: { totalTokens: 12 } }),
			].join("\n"),
		);

		expect(parsed.latestUsage).toEqual({ totalTokens: 12 });
		expect(parsed.invalidLineCount).toBe(1);
	});

	it("reads the latest valid event of a requested type", () => {
		const content = [
			JSON.stringify({ type: "log", level: "info", message: "old" }),
			JSON.stringify({ type: "log", level: "error", message: "new" }),
		].join("\n");

		expect(readLatestDriverStdoutEvent(content, "log")).toEqual({
			type: "log",
			level: "error",
			message: "new",
		});
	});
});
