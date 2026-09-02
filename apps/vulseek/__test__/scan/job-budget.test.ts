import { apiCreatePipelineRun } from "@vulseek/server/db/schema/pipeline";
import {
	evaluateScanJobBudget,
	resolveScanJobDeadlineAt,
	scanJobBudgetCancelMessage,
} from "@vulseek/server/services/scan/job-budget";
import { describe, expect, it } from "vitest";

describe("scan job budgets", () => {
	it("leaves the YAML deadline unchanged when no time budget is set", () => {
		expect(
			resolveScanJobDeadlineAt({
				nowMs: Date.parse("2026-09-02T00:00:00.000Z"),
				yamlMaxDurationSeconds: 3600,
			}),
		).toBe("2026-09-02T01:00:00.000Z");
	});

	it("tightens deadlineAt to the earlier of YAML and user time budget", () => {
		expect(
			resolveScanJobDeadlineAt({
				nowMs: Date.parse("2026-09-02T00:00:00.000Z"),
				yamlMaxDurationSeconds: 3600,
				timeBudgetSeconds: 600,
			}),
		).toBe("2026-09-02T00:10:00.000Z");
		expect(
			resolveScanJobDeadlineAt({
				nowMs: Date.parse("2026-09-02T00:00:00.000Z"),
				yamlMaxDurationSeconds: 60,
				timeBudgetSeconds: 3600,
			}),
		).toBe("2026-09-02T00:01:00.000Z");
	});

	it("does not trip when budgets are unset", () => {
		expect(
			evaluateScanJobBudget({
				nowMs: Date.parse("2026-09-02T01:00:00.000Z"),
				totalTokens: 50_000,
				createdAt: "2026-09-02T00:00:00.000Z",
			}),
		).toEqual({ exceeded: false });
	});

	it("cancels when total tokens reach the token budget", () => {
		expect(
			evaluateScanJobBudget({
				nowMs: Date.parse("2026-09-02T00:01:00.000Z"),
				tokenBudget: 1_000,
				totalTokens: 1_000,
				createdAt: "2026-09-02T00:00:00.000Z",
			}),
		).toEqual({ exceeded: true, reason: "token_budget" });
	});

	it("cancels when elapsed time from start reaches the time budget", () => {
		expect(
			evaluateScanJobBudget({
				nowMs: Date.parse("2026-09-02T00:10:00.000Z"),
				totalTokens: 10,
				timeBudgetSeconds: 600,
				startedAt: "2026-09-02T00:00:00.000Z",
				createdAt: "2026-09-01T23:00:00.000Z",
			}),
		).toEqual({ exceeded: true, reason: "time_budget" });
		expect(
			evaluateScanJobBudget({
				nowMs: Date.parse("2026-09-02T00:09:59.000Z"),
				totalTokens: 10,
				timeBudgetSeconds: 600,
				startedAt: "2026-09-02T00:00:00.000Z",
				createdAt: "2026-09-01T23:00:00.000Z",
			}),
		).toEqual({ exceeded: false });
	});

	it("uses createdAt when startedAt is missing", () => {
		expect(
			evaluateScanJobBudget({
				nowMs: Date.parse("2026-09-02T00:05:00.000Z"),
				totalTokens: 0,
				timeBudgetSeconds: 300,
				createdAt: "2026-09-02T00:00:00.000Z",
			}),
		).toEqual({ exceeded: true, reason: "time_budget" });
	});

	it("prefers token budget when both are exceeded", () => {
		expect(
			evaluateScanJobBudget({
				nowMs: Date.parse("2026-09-02T01:00:00.000Z"),
				tokenBudget: 10,
				totalTokens: 11,
				timeBudgetSeconds: 1,
				createdAt: "2026-09-02T00:00:00.000Z",
			}),
		).toEqual({ exceeded: true, reason: "token_budget" });
	});

	it("describes cancel reasons", () => {
		expect(scanJobBudgetCancelMessage("token_budget")).toContain("token");
		expect(scanJobBudgetCancelMessage("time_budget")).toContain("time");
	});

	it("accepts optional budgets on pipeline run create", () => {
		const parsed = apiCreatePipelineRun.parse({
			target: { type: "application", applicationId: "app-1" },
			pipelineId: "pipe-1",
			tokenBudget: 1_000_000,
			timeBudgetSeconds: 3600,
		});
		expect(parsed.tokenBudget).toBe(1_000_000);
		expect(parsed.timeBudgetSeconds).toBe(3600);
		expect(
			apiCreatePipelineRun.parse({
				target: { type: "application", applicationId: "app-1" },
				pipelineId: "pipe-1",
			}).tokenBudget,
		).toBeUndefined();
		expect(() =>
			apiCreatePipelineRun.parse({
				target: { type: "application", applicationId: "app-1" },
				pipelineId: "pipe-1",
				tokenBudget: 0,
			}),
		).toThrow();
		expect(() =>
			apiCreatePipelineRun.parse({
				target: { type: "application", applicationId: "app-1" },
				pipelineId: "pipe-1",
				timeBudgetSeconds: 0,
			}),
		).toThrow();
	});
});
