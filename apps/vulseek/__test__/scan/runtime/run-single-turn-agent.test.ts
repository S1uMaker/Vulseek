import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
	buildAgentProfileHomeDirName,
	buildCodexConfigToml,
	buildGrokConfigToml,
	buildJobAgentHomePathInContainer,
	buildJobAgentHomePathOnHost,
	buildResearchContainerEnvPairs,
	buildStructuredOutputPromptSuffix,
	mapClaudeReasoningEffort,
	mapClaudeSettingsEffort,
	mapGrokReasoningEffort,
	remapScanContextAppPathToHost,
	requireResearchDatabaseContext,
} from "../../../../../packages/server/src/services/scan/runtime/run-single-turn-agent";

const schema = z.object({
	value: z.string(),
});

describe("agent profile home paths", () => {
	test("uses a sanitized profile name plus id so different agents do not share a home", () => {
		const grok = {
			agentProfileId: "WL4xmdq-foiJk8mWYsm3X",
			name: "grok-4.5[zdk]",
		};
		const codex = {
			agentProfileId: "SvNUmboLzDgMU-Jqc77mM",
			name: "GPT-5.6-luna[zdk]",
		};
		expect(buildAgentProfileHomeDirName(grok)).toBe(
			"grok-4.5-zdk-WL4xmdq-foiJk8mWYsm3X",
		);
		expect(buildAgentProfileHomeDirName(codex)).toBe(
			"GPT-5.6-luna-zdk-SvNUmboLzDgMU-Jqc77mM",
		);
		expect(buildAgentProfileHomeDirName(grok)).not.toBe(
			buildAgentProfileHomeDirName(codex),
		);
		expect(buildAgentProfileHomeDirName(null)).toBe("default");
	});

	test("nests host and container agent homes under agent-home/<profile>", () => {
		const grok = {
			agentProfileId: "WL4xmdq-foiJk8mWYsm3X",
			name: "grok-4.5[zdk]",
		};
		const jobId = "UJszS6zXMjRKSLPH0eYdH";
		expect(
			buildJobAgentHomePathOnHost(
				`/data/jobs/${jobId}/scanning/full_scan/stages/hunter/tasks/t1`,
				jobId,
				grok,
			),
		).toBe(`/data/jobs/${jobId}/agent-home/grok-4.5-zdk-WL4xmdq-foiJk8mWYsm3X`);
		expect(buildJobAgentHomePathInContainer(jobId, grok)).toBe(
			`/scan-context/jobs/${jobId}/agent-home/grok-4.5-zdk-WL4xmdq-foiJk8mWYsm3X`,
		);
		expect(buildJobAgentHomePathInContainer(jobId, grok)).not.toBe(
			buildJobAgentHomePathInContainer(jobId, {
				agentProfileId: "SvNUmboLzDgMU-Jqc77mM",
				name: "GPT-5.6-luna[zdk]",
			}),
		);
	});
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
	test("describes output submission for non-routed stages", () => {
		const suffix = buildStructuredOutputPromptSuffix(
			"/task/output.schema.json",
		);

		expect(suffix).toMatch(/Read \/task\/output\.schema\.json/);
		expect(suffix).toMatch(/submit-message/);
		expect(suffix).toMatch(/OUTPUT SUBMISSION/);
		expect(suffix).toMatch(/output data schema/);
		expect(suffix).toMatch(/multiple times/);
		expect(suffix).toMatch(/schema-compatible empty object or array/);
		expect(suffix).not.toMatch(/validate-output/);
		expect(suffix).not.toMatch(
			/Runtime output protocol \(generated; do not duplicate/,
		);
		expect(suffix).not.toMatch(/Do not write `?\/?task\/output\.json/);
		expect(suffix).not.toMatch(/output-validator/);
		expect(suffix).not.toMatch(/\/scan-context\//);
		expect(suffix).not.toMatch(/\/workspace\/repo/);
	});

	test("includes dynamic route keys and descriptions", () => {
		const suffix = buildStructuredOutputPromptSuffix(
			"/task/output.schema.json",
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

		expect(suffix).toMatch(/submit-message/);
		expect(suffix).toMatch(/specific downstream stage/);
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
		expect(config).toContain("[shell_environment_policy]");
		expect(config).toContain('inherit = "all"');
		expect(config).toContain("ignore_default_excludes = true");
		expect(config).toContain('mcp_oauth_credentials_store = "file"');
	});

	test("keeps the configured API-key provider for API-key credentials", () => {
		const config = buildCodexConfigToml(codexProfile("api_key"));

		expect(config).toContain('preferred_auth_method = "apikey"');
		expect(config).toContain('model_provider = "profile-123"');
		expect(config).toContain("[model_providers.profile-123]");
	});
});

describe("buildGrokConfigToml", () => {
	test("writes GROK_HOME config with xAI model and always-approve", () => {
		const config = buildGrokConfigToml({
			...codexProfile("api_key"),
			provider: "grok_build",
			baseUrl: "https://api.x.ai/v1",
			model: "grok-4.6",
			thinkingLevel: "xhigh",
		});
		expect(config).toContain('default = "grok-4.6"');
		expect(config).toContain('default_reasoning_effort = "xhigh"');
		expect(config).toContain('[model."grok-4.6"]');
		expect(config).toContain('base_url = "https://api.x.ai/v1"');
		expect(config).toContain('env_key = "XAI_API_KEY"');
		expect(config).toContain('permission_mode = "always-approve"');
		expect(config).not.toContain("sk-");
	});

	test("maps thinking levels onto grok reasoning effort", () => {
		expect(mapGrokReasoningEffort("medium")).toBe("medium");
		expect(mapGrokReasoningEffort("extra-high")).toBe("xhigh");
		expect(mapGrokReasoningEffort("unknown")).toBe("high");
	});
});

describe("mapClaudeReasoningEffort", () => {
	test("maps profile thinking levels onto Claude ACP effort", () => {
		expect(mapClaudeReasoningEffort("medium")).toBe("medium");
		expect(mapClaudeReasoningEffort("minimal")).toBe("low");
		expect(mapClaudeReasoningEffort("extra-high")).toBe("xhigh");
		expect(mapClaudeReasoningEffort("max")).toBe("max");
		expect(mapClaudeReasoningEffort("")).toBeNull();
		expect(mapClaudeReasoningEffort(null)).toBeNull();
		expect(mapClaudeReasoningEffort("unknown")).toBe("high");
	});

	test("persists max as xhigh in Claude settings.json", () => {
		expect(mapClaudeSettingsEffort("max")).toBe("xhigh");
		expect(mapClaudeSettingsEffort("medium")).toBe("medium");
	});
});

describe("buildScanRuntimeApiEnvPairs", () => {
	test("injects API URL, job token, and scan job id", async () => {
		const { buildScanRuntimeApiEnvPairs } = await import(
			"../../../../../packages/server/src/services/scan/runtime/scan-runtime-api-auth"
		);
		const pairs = buildScanRuntimeApiEnvPairs(
			"job-a",
			"task-a",
			"orchestrator",
			{
				VULSEEK_RUNTIME_API_SECRET: "secret",
				VULSEEK_SERVICE_NAME: "vulseek-dev",
			},
		);
		expect(pairs).toEqual([
			"VULSEEK_RUNTIME_API_URL=http://vulseek-dev:3000",
			expect.stringMatching(/^VULSEEK_RUNTIME_TOKEN=[0-9a-f]{64}$/),
			"VULSEEK_SCAN_JOB_ID=job-a",
			"VULSEEK_TASK_ID=task-a",
			"VULSEEK_STAGE_NAME=orchestrator",
		]);
	});

	test("keeps identity pairs when no runtime secret is configured", async () => {
		const { buildScanRuntimeApiEnvPairs } = await import(
			"../../../../../packages/server/src/services/scan/runtime/scan-runtime-api-auth"
		);
		expect(
			buildScanRuntimeApiEnvPairs("job-a", "task-a", "orchestrator", {
				VULSEEK_RUNTIME_API_SECRET: "",
				BETTER_AUTH_SECRET: "",
				AUTH_SECRET: "",
				JWT_SECRET: "",
				SESSION_SECRET: "",
				VULSEEK_SERVICE_NAME: "vulseek-dev",
			}),
		).toEqual([
			"VULSEEK_SCAN_JOB_ID=job-a",
			"VULSEEK_TASK_ID=task-a",
			"VULSEEK_STAGE_NAME=orchestrator",
		]);
	});
});

describe("ensureScanRuntimeProxyBypass", () => {
	test("adds the Vulseek service to both proxy bypass variables", async () => {
		const { ensureScanRuntimeProxyBypass } = await import(
			"../../../../../packages/server/src/services/scan/runtime/scan-runtime-api-auth"
		);
		expect(
			ensureScanRuntimeProxyBypass(
				["HTTP_PROXY=http://proxy:9870", "NO_PROXY=localhost"],
				{ VULSEEK_SERVICE_NAME: "vulseek-dev" },
			),
		).toEqual([
			"HTTP_PROXY=http://proxy:9870",
			"NO_PROXY=localhost,vulseek-dev",
			"no_proxy=vulseek-dev",
		]);
	});

	test("does not duplicate an existing bypass entry", async () => {
		const { ensureScanRuntimeProxyBypass } = await import(
			"../../../../../packages/server/src/services/scan/runtime/scan-runtime-api-auth"
		);
		expect(
			ensureScanRuntimeProxyBypass(
				["NO_PROXY=localhost,vulseek-dev", "no_proxy=vulseek-dev"],
				{ VULSEEK_SERVICE_NAME: "vulseek-dev" },
			),
		).toEqual(["NO_PROXY=localhost,vulseek-dev", "no_proxy=vulseek-dev"]);
	});
});

describe("buildResearchContainerEnvPairs", () => {
	test("passes the database URL by inherited environment name only", () => {
		expect(
			buildResearchContainerEnvPairs("research", "job-a", "task-a"),
		).toEqual(["VULSEEK_RESEARCH_DATABASE_URL"]);
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
