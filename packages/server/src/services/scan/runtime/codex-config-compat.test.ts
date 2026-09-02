import assert from "node:assert/strict";
import test from "node:test";
import {
	applyCodexRuntimeConfigToml,
	ensureCodexGoalsFeature,
	sanitizeCodexAcpConfigToml,
} from "./codex-config-compat";

test("removes the unsupported default service tier from copied Codex config", () => {
	const source = [
		'model = "gpt-5.4-mini"',
		'service_tier = "default"',
		'',
		'[projects."/workspace/repo"]',
		'trust_level = "trusted"',
		'',
	].join("\n");

	assert.equal(
		sanitizeCodexAcpConfigToml(source),
		[
			'model = "gpt-5.4-mini"',
			'',
			'[projects."/workspace/repo"]',
			'trust_level = "trusted"',
			'',
		].join("\n"),
	);
});

test("preserves supported service tiers and nested keys", () => {
	const source = [
		'service_tier = "fast"',
		'',
		'[model_providers.default]',
		'service_tier = "default"',
		'',
	].join("\n");

	assert.equal(sanitizeCodexAcpConfigToml(source), source);
});

test("ensureCodexGoalsFeature appends features.goals when missing", () => {
	const source = ['model = "gpt-5.4-mini"', 'approval_policy = "never"'].join(
		"\n",
	);
	assert.equal(
		ensureCodexGoalsFeature(source),
		[
			'model = "gpt-5.4-mini"',
			'approval_policy = "never"',
			"",
			"[features]",
			"goals = true",
		].join("\n"),
	);
});

test("ensureCodexGoalsFeature forces goals = true inside existing features table", () => {
	const source = ["[features]", "goals = false", "foo = true"].join("\n");
	assert.equal(
		ensureCodexGoalsFeature(source),
		["[features]", "goals = true", "foo = true"].join("\n"),
	);
});

test("applyCodexRuntimeConfigToml lets exec inherit VULSEEK env including TOKEN names", () => {
	const config = applyCodexRuntimeConfigToml(
		['model = "gpt-5.4-mini"', 'approval_policy = "never"'].join("\n"),
	);
	assert.match(config, /\[shell_environment_policy\]/);
	assert.match(config, /inherit = "all"/);
	assert.match(config, /ignore_default_excludes = true/);
	assert.match(config, /goals = true/);
	assert.match(config, /mcp_oauth_credentials_store = "file"/);
});

test("applyCodexRuntimeConfigToml keeps an explicit MCP OAuth credential store", () => {
	const config = applyCodexRuntimeConfigToml(
		['mcp_oauth_credentials_store = "keyring"', 'model = "gpt-5.4-mini"'].join(
			"\n",
		),
	);
	assert.match(config, /mcp_oauth_credentials_store = "keyring"/);
	assert.doesNotMatch(config, /mcp_oauth_credentials_store = "file"/);
});
