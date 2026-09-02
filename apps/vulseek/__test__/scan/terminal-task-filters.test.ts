import { normalizeTerminalTaskFilters } from "../../../../packages/server/src/services/scan/terminal-task-filters";
import { describe, expect, it } from "vitest";

describe("terminal task filters", () => {
	it("passes every supported terminal status through to persistence", () => {
		for (const status of [
			"completed",
			"failed",
			"exited",
			"canceled",
		] as const) {
			expect(normalizeTerminalTaskFilters({ stage: "all", status })).toEqual({
				stageName: undefined,
				status,
			});
		}
	});

	it("maps a public stage name and drops all filters", () => {
		expect(
			normalizeTerminalTaskFilters({
				stage: "analyze-finding",
				status: "all",
			}),
		).toEqual({
			stageName: "analyze-finding",
			status: undefined,
		});
	});

	it("passes through the current pipeline's stage ids", () => {
		expect(
			normalizeTerminalTaskFilters({
				stage: "orchestrator",
				status: "completed",
			}),
		).toEqual({
			stageName: "orchestrator",
			status: "completed",
		});
		expect(
			normalizeTerminalTaskFilters({
				stage: "hunter",
				status: "failed",
			}),
		).toEqual({
			stageName: "hunter",
			status: "failed",
		});
	});

	it("drops non-terminal statuses instead of filtering the finished list by them", () => {
		expect(
			normalizeTerminalTaskFilters({
				stage: "hunter",
				status: "running",
			}),
		).toEqual({
			stageName: "hunter",
			status: undefined,
		});
	});
});
