const unsupportedDefaultServiceTierPattern =
	/^\s*service_tier\s*=\s*(["'])default\1\s*(?:#.*)?$/;

export const sanitizeCodexAcpConfigToml = (configToml: string) => {
	let seenTable = false;
	return configToml
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			if (/^\[.*\]\s*(?:#.*)?$/.test(trimmed)) {
				seenTable = true;
			}
			return seenTable || !unsupportedDefaultServiceTierPattern.test(line);
		})
		.join("\n");
};

/**
 * Ensure Codex native Goals (`/goal`, thread_goals) are enabled.
 * Required for goal-enabled stages that activate objectives via `/goal …`.
 */
export const ensureCodexGoalsFeature = (configToml: string) => {
	const source = (configToml || "").trimEnd();
	if (/^\s*\[features\]\s*$/m.test(source) || /^\s*\[features\]\s*(?:#.*)?$/m.test(source)) {
		if (/^\s*goals\s*=/m.test(source)) {
			return source.replace(/^\s*goals\s*=\s*.*$/m, "goals = true");
		}
		return source.replace(
			/^(\s*\[features\]\s*(?:#.*)?)$/m,
			"$1\ngoals = true",
		);
	}
	const block = ["[features]", "goals = true"].join("\n");
	return source ? `${source}\n\n${block}` : block;
};

/**
 * Let Codex `exec` inherit the ACP driver environment, including
 * `VULSEEK_*` identity and `VULSEEK_RUNTIME_TOKEN`. The default policy
 * drops names matching TOKEN/KEY/SECRET/PASSWORD.
 */
export const ensureCodexShellEnvironmentPolicy = (configToml: string) => {
	const source = (configToml || "").trimEnd();
	if (/^\s*\[shell_environment_policy\]\s*(?:#.*)?$/m.test(source)) {
		return source;
	}
	const block = [
		"[shell_environment_policy]",
		'inherit = "all"',
		"ignore_default_excludes = true",
	].join("\n");
	return source ? `${source}\n\n${block}` : block;
};

/**
 * Scan sandboxes have no dbus/Secret Service. Codex still probes the OS
 * keyring for MCP OAuth on HTTP MCP startup and warns. File store uses
 * `$CODEX_HOME/.credentials.json` and skips that probe.
 */
export const ensureCodexMcpOAuthCredentialsStore = (configToml: string) => {
	const source = (configToml || "").trimEnd();
	if (/^\s*mcp_oauth_credentials_store\s*=/m.test(source)) {
		return source;
	}
	const line = 'mcp_oauth_credentials_store = "file"';
	return source ? `${line}\n${source}` : line;
};

export const applyCodexRuntimeConfigToml = (configToml: string) =>
	ensureCodexShellEnvironmentPolicy(
		ensureCodexGoalsFeature(ensureCodexMcpOAuthCredentialsStore(configToml)),
	);
