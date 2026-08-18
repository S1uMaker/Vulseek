import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
	buildCodexConfigToml,
	buildResearchContainerEnvPairs,
	buildStructuredOutputPromptSuffix,
	remapScanContextAppPathToHost,
	requireResearchDatabaseContext,
} from "../../../../../packages/server/src/services/scan/runtime/run-single-turn-agent";

const schema = z.object({
	value: z.string(),
});

describe("remapScanContextAppPathToHost", () => {
	test("rewrites the in-app scan-context path for docker -v", () => {
		expect(
			remapScanContextAppPathToHost(
				"/scan-context/projects/wordpress/profiles/GPT-5.x/jobs/job-1/scanning/full_scan/stages/goal-surface/lanes/lane-0",
				"/data/exp/vulseek-data-dev",
			),
		).toBe(
			"/data/exp/vulseek-data-dev/projects/wordpress/profiles/GPT-5.x/jobs/job-1/scanning/full_scan/stages/goal-surface/lanes/lane-0",
		);
		expect(
			remapScanContextAppPathToHost(
				"/data/exp/vulseek-data-dev/projects/wordpress/profiles/GPT-5.x/jobs/job-1/scanning/full_scan/stages/goal-surface/lanes/lane-0",
				"/data/exp/vulseek-data-dev",
			),
		).toBe(
			"/data/exp/vulseek-data-dev/projects/wordpress/profiles/GPT-5.x/jobs/job-1/scanning/full_scan/stages/goal-surface/lanes/lane-0",
		);
	});
});

describe("buildStructuredOutputPromptSuffix", () => {
	test("uses stable task output paths for non-routed stages", () => {
		const suffix = buildStructuredOutputPromptSuffix(
			schema,
			"/task/output.schema.json",
			"/task/output.json",
		);

		expect(suffix).toMatch(/read \/task\/output\.schema\.json/);
		expect(suffix).toMatch(/output-validator\/validate_output\.py/);
		expect(suffix).toMatch(/Write the final result only to \/task\/output\.json/);
		expect(suffix).toMatch(/no dynamic route; set route=null/);
		expect(suffix).not.toMatch(/\/scan-context\//);
		expect(suffix).not.toMatch(/\/workspace\/repo/);
		expect(suffix).toMatch(
			/If validation fails, fix the files[\s\S]*End the turn only after it succeeds\./,
		);
	});

	test("keeps dynamic route instructions with stable task paths", () => {
		const suffix = buildStructuredOutputPromptSuffix(
			schema,
			"/task/output.schema.json",
			"/task/output.json",
			[
				{
					routeKey: "build",
					description: "Build a fuzzer",
					schema,
					default: true,
				},
				{
					routeKey: "critic",
					description: "Criticize analysis",
					schema,
				},
			],
		);

		expect(suffix).toMatch(/Write the final result only to \/task\/output\.json/);
		expect(suffix).toMatch(/Choose exactly one route key below/);
		expect(suffix).toMatch(/- build \(default\): Build a fuzzer/);
		expect(suffix).toMatch(/- critic: Criticize analysis/);
		expect(suffix).not.toMatch(/\/scan-context\//);
		expect(suffix).not.toMatch(/\/workspace\/repo/);
	});
});

const codexProfile = (authMode: "api_key" | "host_home") => ({
	agentProfileId: "profile-123",
	name: "Codex",
	provider: "codex" as const,
	authMode,
	homePath: "/home/test/.codex",
	baseUrl: "https://api.openai.com/v1",
	apiKey: "test-api-key",
	model: "gpt-5.6-luna",
	thinkingLevel: "medium",
	thinkingLevelEnabled: true,
	envs: "",
	isEnabled: true,
});

describe("buildCodexConfigToml", () => {
	test("uses the native Codex auth provider for host-home OAuth credentials", () => {
		const config = buildCodexConfigToml(codexProfile("host_home"));

		expect(config).toContain('model = "gpt-5.6-luna"');
		expect(config).not.toContain('preferred_auth_method = "apikey"');
		expect(config).not.toContain('model_provider = "profile-123"');
		expect(config).not.toContain("[model_providers.profile-123]");
	});

	test("keeps the configured API-key provider for API-key credentials", () => {
		const config = buildCodexConfigToml(codexProfile("api_key"));

		expect(config).toContain('preferred_auth_method = "apikey"');
		expect(config).toContain('model_provider = "profile-123"');
		expect(config).toContain("[model_providers.profile-123]");
	});
});

describe("buildResearchContainerEnvPairs", () => {
	test("passes the database URL by inherited environment name only", () => {
		expect(
			buildResearchContainerEnvPairs("research", "job-a", "task-a"),
		).toEqual([
			"VULSEEK_SCAN_JOB_ID=job-a",
			"VULSEEK_TASK_ID=task-a",
			"VULSEEK_RESEARCH_DATABASE_URL",
		]);
	});

	test("does not add Research database context to Full or Delta scans", () => {
		expect(buildResearchContainerEnvPairs("full", "job-a", "task-a")).toEqual(
			[],
		);
		expect(buildResearchContainerEnvPairs("delta", "job-a", "task-a")).toEqual(
			[],
		);
	});

	test("rejects a Research launch without database context", () => {
		expect(() => requireResearchDatabaseContext("research", {})).toThrow(
			/VULSEEK_RESEARCH_DATABASE_URL/,
		);
		expect(() => requireResearchDatabaseContext("full", {})).not.toThrow();
	});
});
