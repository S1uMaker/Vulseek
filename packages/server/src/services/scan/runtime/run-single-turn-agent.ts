import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getGlobalContainerEnvironmentPairs } from "../../../utils/docker/utils";
import { execAsync } from "../../../utils/process/execAsync";
import { getAgentProfileById } from "../../ai";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import { resolveDatasetTrialRuntime } from "../../dataset";
import { inspectRequiredToolsImageReference } from "../checkout-tools";
import { findTaskByIdRepo, updateTaskRepo } from "../persistence/task.repo";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { getRuntimeStageSetting } from "../runtime-settings";
import { writeScanJobSecurityPolicyArtifact } from "../security-policy-artifact";
import { SCAN_STAGE_IDS } from "../stage-metadata";
import type { AgentProfileLike, ScanJob } from "../types";
import {
	AGENT_RUNTIME_FILE_NAMES,
	initializeAgentRuntimeFiles,
} from "./agent-runtime-files";
import { ensureCodexGoalsFeature } from "./codex-config-compat";
import { installRuntimeSkillsInContainer } from "./runtime-skills";
import {
	buildStructuredOutputEnvelopeJsonSchema,
	buildStructuredOutputPromptSuffix,
	type RouteOutputSchema,
} from "./structured-output-schema";

export { buildStructuredOutputPromptSuffix } from "./structured-output-schema";

const RUNTIME_CUSTOM_SKILLS = [
	"codeql",
	"semgrep",
	"delta-scope",
	"full-scan",
	"full-scan-subagent",
	"repository-profile",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"search-registries",
	"tree-sitter",
	"research-agent",
	"research-db",
	"output-validator",
] as const;

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const TASK_ALIAS_ROOT_IN_CONTAINER = "/task";
const LANE_ALIAS_ROOT_IN_CONTAINER = "/lane";
const STRUCTURED_OUTPUT_SCHEMA_FILE_NAME = "output.schema.json";
const STRUCTURED_OUTPUT_RESULT_FILE_NAME = "output.json";
const CLAUDE_HOME_IN_CONTAINER = "/root/.claude";
const JOB_AGENT_HOME_DIR_NAME = "agent-home";
const PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS = Number.parseInt(
	process.env.VULSEEK_PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS || "120000",
	10,
);

const sanitizeForImageTag = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-");

const toImageTagFromAppName = (appName: string) =>
	`vulseek-scan-${sanitizeForImageTag(appName)}:latest`;

const sanitizeContextPathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const buildProjectProfileContextRoot = () => TASK_ALIAS_ROOT_IN_CONTAINER;
const buildProjectProfileCacheRoot = () =>
	path.posix.join(buildProjectProfileContextRoot(), "cache");

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'"'"'`);

const buildNamespaceEnabledContainerArgs = () => {
	const configured = process.env.VULSEEK_SCAN_CONTAINER_EXTRA_ARGS?.trim();
	if (configured) {
		return configured;
	}

	return [
		"--security-opt seccomp=unconfined",
		"--security-opt apparmor=unconfined",
		"--cap-add SYS_ADMIN",
	].join(" ");
};

let cachedCurrentDockerNetworkName: string | null | undefined;

const resolveCurrentDockerNetworkName = async () => {
	if (cachedCurrentDockerNetworkName !== undefined) {
		return cachedCurrentDockerNetworkName;
	}

	try {
		const { stdout } = await execAsync(
			"docker inspect $(hostname) --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'",
		);
		const networkName =
			stdout
				.split("\n")
				.map((value) => value.trim())
				.find((value) => value.length > 0) || null;
		cachedCurrentDockerNetworkName = networkName;
		return networkName;
	} catch {
		cachedCurrentDockerNetworkName = null;
		return null;
	}
};

const resolveCurrentDockerNetworkArg = async () => {
	const networkName = await resolveCurrentDockerNetworkName();
	return networkName ? `--network ${networkName}` : "";
};

const sanitizeProviderName = (value: string) =>
	value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "provider";

const CODEX_AUTO_APPROVE_CONFIG_TOML = ensureCodexGoalsFeature(
	[`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, ""].join(
		"\n",
	),
);
const resolveAgentAuthMode = (
	agentProfile: AgentProfileLike | null | undefined,
) => (agentProfile?.authMode === "host_home" ? "host_home" : "api_key");

const resolveAgentHomeHostPath = (
	agentProfile: AgentProfileLike | null | undefined,
) => agentProfile?.homePath?.trim() || "";

const withCodexAutoApproveConfigToml = (configToml: string) => {
	const defaults: string[] = [];
	if (!/^\s*approval_policy\s*=/m.test(configToml)) {
		defaults.push(`approval_policy = "never"`);
	}
	if (!/^\s*sandbox_mode\s*=/m.test(configToml)) {
		defaults.push(`sandbox_mode = "danger-full-access"`);
	}
	const withDefaults =
		defaults.length === 0
			? configToml
			: joinTomlBlocks(`${defaults.join("\n")}\n`, configToml);
	return ensureCodexGoalsFeature(withDefaults);
};

export const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);
	const reasoningConfig = agentProfile.thinkingLevelEnabled
		? [`model_reasoning_effort = "${agentProfile.thinkingLevel}"`]
		: [];
	const providerConfig =
		resolveAgentAuthMode(agentProfile) === "api_key"
			? [
					`model_provider = "${providerName}"`,
					`preferred_auth_method = "apikey"`,
					"",
					`[model_providers.${providerName}]`,
					`name = "${providerName}"`,
					`base_url = "${agentProfile.baseUrl}"`,
					`wire_api = "responses"`,
					"",
				]
			: [];

	return withCodexAutoApproveConfigToml(
		[
			`model = "${agentProfile.model}"`,
			...reasoningConfig,
			...providerConfig,
		].join("\n"),
	);
};

const loadCodexMcpConfigToml = async (agentsDir: string | null) => {
	if (!agentsDir) {
		return "";
	}

	const mcpDir = path.join(agentsDir, "mcp");
	try {
		const entries = await fs.readdir(mcpDir, { withFileTypes: true });
		const tomlFiles = entries
			.filter(
				(entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"),
			)
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));

		if (tomlFiles.length === 0) {
			return "";
		}

		const contents = await Promise.all(
			tomlFiles.map((fileName) =>
				fs.readFile(path.join(mcpDir, fileName), "utf-8"),
			),
		);

		return contents
			.map((content) => content.trim())
			.filter(Boolean)
			.join("\n\n");
	} catch {
		return "";
	}
};

const joinTomlBlocks = (...blocks: Array<string | null | undefined>) =>
	blocks
		.map((block) => (block || "").trim())
		.filter(Boolean)
		.join("\n\n");

const buildCodexAuthJson = (agentProfile: AgentProfileLike) =>
	JSON.stringify(
		{
			OPENAI_API_KEY: agentProfile.apiKey,
		},
		null,
		2,
	);

const copyHostFileToContainer = async (input: {
	containerName: string;
	sourcePath: string;
	targetPath: string;
	description: string;
}) => {
	const sourceDirectory = path.dirname(input.sourcePath);
	const sourceFile = path.basename(input.sourcePath);
	const helperName = `${input.containerName}-credential-copy-${randomUUID().slice(0, 8)}`;
	const localCopyPath = path.join(
		tmpdir(),
		`vulseek-credential-copy-${randomUUID().slice(0, 8)}-${sourceFile}`,
	);
	const { stdout: imageOutput } = await execAsync(
		`docker inspect ${input.containerName} --format '{{.Config.Image}}'`,
	);
	const image = imageOutput.trim();
	if (!image) {
		throw new Error(`Unable to resolve image for ${input.containerName}`);
	}

	try {
		await execAsync(
			`docker create --name ${helperName} -v '${escapeSingleQuotes(sourceDirectory)}:/host-credential:ro' --entrypoint bash '${escapeSingleQuotes(image)}' -lc 'sleep 30'`,
		);
		await execAsync(
			`docker cp ${helperName}:'/host-credential/${escapeSingleQuotes(sourceFile)}' '${escapeSingleQuotes(localCopyPath)}'`,
		);
		await execAsync(
			`docker cp '${escapeSingleQuotes(localCopyPath)}' ${input.containerName}:'${escapeSingleQuotes(input.targetPath)}'`,
		);
	} catch (error) {
		throw new Error(
			`Unable to copy ${input.description} from ${input.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		await fs.unlink(localCopyPath).catch(() => {});
		await execAsync(`docker rm -f ${helperName}`).catch(() => {});
	}
};

const parseAgentProfileEnvPairs = (agentProfile: AgentProfileLike) =>
	(agentProfile.envs || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const separatorIndex = line.indexOf("=");
			if (separatorIndex <= 0) {
				return [];
			}
			const key = line.slice(0, separatorIndex).trim();
			const value = line.slice(separatorIndex + 1);
			if (!key) {
				return [];
			}
			return [`${key}=${value}`];
		});

const envPairsToRecord = (pairs: string[]) =>
	Object.fromEntries(
		pairs.flatMap((pair) => {
			const separatorIndex = pair.indexOf("=");
			return separatorIndex > 0
				? [[pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1)]]
				: [];
		}),
	);

const buildClaudeEnvPairs = (
	agentProfile: AgentProfileLike,
	claudeHome = CLAUDE_HOME_IN_CONTAINER,
) => [
	`CLAUDE_CONFIG_DIR=${claudeHome}`,
	...(resolveAgentAuthMode(agentProfile) === "api_key"
		? [
				`ANTHROPIC_BASE_URL=${agentProfile.baseUrl}`,
				`ANTHROPIC_API_KEY=${agentProfile.apiKey}`,
				`ANTHROPIC_AUTH_TOKEN=${agentProfile.apiKey}`,
			]
		: []),
	`ANTHROPIC_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_SONNET_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_OPUS_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_HAIKU_MODEL=${agentProfile.model}`,
	"CLAUDE_CODE_ENTRYPOINT=vulseek",
	...parseAgentProfileEnvPairs(agentProfile),
];

const resolveAgentsDirectory = async () => {
	const candidates = [
		path.resolve(process.cwd(), "agents"),
		path.resolve(process.cwd(), "../../agents"),
		"/app/agents",
	];

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) {
				return candidate;
			}
		} catch {}
	}
	return null;
};

const writeContainerFile = async (
	containerName: string,
	filePath: string,
	content: string,
) => {
	const encoded = Buffer.from(content, "utf-8").toString("base64");
	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${path.posix.dirname(
			filePath,
		)}' && echo '${encoded}' | base64 -d > '${filePath}'"`,
	);
};

const appendContainerFile = async (
	containerName: string,
	filePath: string,
	content: string,
) => {
	const encoded = Buffer.from(content, "utf-8").toString("base64");
	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${path.posix.dirname(
			filePath,
		)}' && echo '${encoded}' | base64 -d >> '${filePath}'"`,
	);
};

const pendingDriverInputWrites = new Map<string, Promise<void>>();

const writeDriverTaskToInputFile = async (input: {
	inputPath: string;
	taskInput: Record<string, unknown>;
}) => {
	const previousWrite =
		pendingDriverInputWrites.get(input.inputPath) || Promise.resolve();
	const currentWrite = previousWrite
		.catch(() => {})
		.then(async () => {
			await fs.mkdir(path.dirname(input.inputPath), { recursive: true });
			await fs.appendFile(
				input.inputPath,
				`${JSON.stringify(input.taskInput)}\n`,
				"utf-8",
			);
		});
	pendingDriverInputWrites.set(input.inputPath, currentWrite);
	try {
		await currentWrite;
	} finally {
		if (pendingDriverInputWrites.get(input.inputPath) === currentWrite) {
			pendingDriverInputWrites.delete(input.inputPath);
		}
	}
};

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const appendHostBootstrapLog = async (
	logPath: string | null | undefined,
	message: string,
) => {
	if (!logPath) {
		return;
	}
	await fs
		.appendFile(
			logPath,
			`${JSON.stringify({
				type: "log",
				level: "info",
				source: "host",
				message,
			})}\n`,
			"utf-8",
		)
		.catch(() => {});
};

const truncateLogValue = (value: unknown, maxLength = 4000) => {
	const text = typeof value === "string" ? value : String(value ?? "");
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength} chars>`;
};

const getErrorDiagnostics = (error: unknown) => {
	const record =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	return {
		message: getErrorMessage(error),
		code: record.code ?? null,
		signal: record.signal ?? null,
		cmd: truncateLogValue(record.cmd, 2000) || null,
		stdout: truncateLogValue(record.stdout),
		stderr: truncateLogValue(record.stderr),
	};
};

const withHostBootstrapLog = async <T>(
	logPath: string | null | undefined,
	label: string,
	details: string,
	action: () => Promise<T>,
) => {
	const startedAt = Date.now();
	await appendHostBootstrapLog(
		logPath,
		`${label}_start${details ? ` ${details}` : ""}`,
	);
	try {
		const result = await action();
		await appendHostBootstrapLog(
			logPath,
			`${label}_done elapsed_ms=${Date.now() - startedAt}`,
		);
		return result;
	} catch (error) {
		await appendHostBootstrapLog(
			logPath,
			`${label}_error elapsed_ms=${Date.now() - startedAt} diagnostics=${JSON.stringify(
				getErrorDiagnostics(error),
			)}`,
		);
		throw error;
	}
};

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const execDockerRunWithRetry = async (input: {
	containerName: string;
	command: string;
	taskId?: string;
	logPath?: string | null;
}) => {
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		try {
			return await execAsync(input.command);
		} catch (error) {
			lastError = error;
			await appendHostBootstrapLog(
				input.logPath,
				`docker_run_attempt_error attempt=${attempt}/6 diagnostics=${JSON.stringify(
					getErrorDiagnostics(error),
				)}`,
			);
			if (input.taskId) {
				await updateTaskRepo(input.taskId, {
					errorMessage: `Docker container launch failed; docker run attempt ${attempt}/6: ${getErrorMessage(error)}`,
				}).catch(() => {});
			}
			await execAsync(`docker rm -f ${input.containerName}`).catch(() => {});
			if (attempt < 6) {
				await sleep(attempt * 2500);
			}
		}
	}
	throw lastError;
};

const resolveConfiguredScanContextHostPath = () =>
	process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";

/** Docker -v left-hand side must be a host path, not the in-app /scan-context mount. */
export const remapScanContextAppPathToHost = (
	appOrHostPath: string,
	hostRoot = resolveConfiguredScanContextHostPath(),
) => {
	const posixPath = appOrHostPath.split(path.sep).join("/");
	const prefix = CONTAINER_SCAN_CONTEXT_ROOT;
	if (
		hostRoot &&
		(posixPath === prefix || posixPath.startsWith(`${prefix}/`))
	) {
		return path.join(hostRoot, posixPath.slice(prefix.length));
	}
	return appOrHostPath;
};

const resolveProjectProfileHostPath = async (input: {
	projectName: string;
	profileName: string;
}) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart vulseek-dev from dev.sh so task runtime directories can be created.",
		);
	}

	const hostProfileDir = path.join(
		configuredHostRoot,
		"projects",
		sanitizeContextPathPart(input.projectName),
		"profiles",
		sanitizeContextPathPart(input.profileName),
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return hostProfileDir;
};

const resolveJobRootFromRuntimeDir = (
	runtimeDir: string,
	scanJobId: string,
) => {
	const resolved = path.resolve(runtimeDir);
	const parts = resolved.split(path.sep);
	const scanJobIndex = parts.lastIndexOf(scanJobId);
	if (scanJobIndex <= 0 || parts[scanJobIndex - 1] !== "jobs") {
		throw new Error(
			`Unable to resolve scan job runtime root from '${runtimeDir}' for job '${scanJobId}'`,
		);
	}
	const root = parts.slice(0, scanJobIndex + 1).join(path.sep);
	return root || path.sep;
};

export const buildJobAgentHomePathOnHost = (
	runtimeDir: string,
	scanJobId: string,
) =>
	path.join(
		resolveJobRootFromRuntimeDir(runtimeDir, scanJobId),
		JOB_AGENT_HOME_DIR_NAME,
	);

export const ensureJobAgentHome = async (input: {
	projectName: string;
	serviceName: string;
	scanJobId: string;
}) => {
	const profileDir = await resolveProjectProfileHostPath({
		projectName: input.projectName,
		profileName: input.serviceName,
	});
	const jobHomePath = path.join(
		profileDir,
		"jobs",
		input.scanJobId,
		JOB_AGENT_HOME_DIR_NAME,
	);
	await fs.mkdir(jobHomePath, { recursive: true });
	return jobHomePath;
};

export const buildJobAgentHomePathInContainer = (scanJobId: string) =>
	path.posix.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"jobs",
		scanJobId,
		JOB_AGENT_HOME_DIR_NAME,
	);

/**
 * Path for Node fs writes inside the vulseek process.
 * Prefer the in-container /scan-context mount (bind of host scan data).
 * VULSEEK_SCAN_CONTEXT_HOST_PATH is for Docker -v only and may not be the
 * same filesystem from inside the app container.
 */
const resolveProjectProfileAppWritePath = async (input: {
	projectName: string;
	profileName: string;
}) => {
	const relative = path.join(
		"projects",
		sanitizeContextPathPart(input.projectName),
		"profiles",
		sanitizeContextPathPart(input.profileName),
	);
	try {
		await fs.access(CONTAINER_SCAN_CONTEXT_ROOT);
		const appProfileDir = path.join(CONTAINER_SCAN_CONTEXT_ROOT, relative);
		await fs.mkdir(appProfileDir, { recursive: true });
		return appProfileDir;
	} catch {
		return resolveProjectProfileHostPath(input);
	}
};

const resolveMountedProjectProfilePath = (input: {
	projectName: string;
	profileName: string;
}) =>
	path.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		sanitizeContextPathPart(input.projectName),
		"profiles",
		sanitizeContextPathPart(input.profileName),
	);

const getTargetMemoryArgs = (target: unknown) => {
	if (!target || typeof target !== "object") {
		return { memoryLimit: null, memoryReservation: null };
	}

	const resourceTarget = target as {
		memoryLimit?: string | null;
		memoryReservation?: string | null;
	};

	return {
		memoryLimit: resourceTarget.memoryLimit || null,
		memoryReservation: resourceTarget.memoryReservation || null,
	};
};

const resolveScanExecutionContext = async (
	scanJob: ScanJob,
	datasetAgentRuntime?: StageContainerInput["datasetAgentRuntime"],
) => {
	if (datasetAgentRuntime) {
		return {
			isApplicationJob: false,
			target: {
				appName: datasetAgentRuntime.serviceName,
				name: datasetAgentRuntime.serviceName,
				environment: {
					project: {
						name: datasetAgentRuntime.projectName,
						scanContextVolumeName: "",
					},
				},
				scanStageSettings: {},
				memoryLimit: null,
				memoryReservation: null,
			},
			appName: datasetAgentRuntime.serviceName,
			imageTag: datasetAgentRuntime.imageTag,
			contextVolumeName: "",
			projectName: datasetAgentRuntime.projectName,
			serviceName: datasetAgentRuntime.serviceName,
			projectProfileContextRoot: buildProjectProfileContextRoot(),
			projectProfileCacheRoot: buildProjectProfileCacheRoot(),
			scanAgentProfile: null,
			datasetSampleHostPath: datasetAgentRuntime.workspaceHostPath,
			datasetSampleMountReadOnly:
				datasetAgentRuntime.workspaceReadOnly !== false,
		};
	}
	if (scanJob.datasetEvaluationTrialId) {
		const datasetRuntime = await resolveDatasetTrialRuntime(scanJob.scanJobId);
		if (!datasetRuntime) {
			throw new Error(
				`Dataset trial not found for scan job ${scanJob.scanJobId}`,
			);
		}
		const projectName = `dataset-${datasetRuntime.dataset.datasetId}`;
		const serviceName = `${datasetRuntime.profile.profileId}-${datasetRuntime.sample.id}`;
		const imageTag = datasetRuntime.toolsImageTag;
		const imageDigest = datasetRuntime.toolsImageDigest;
		if (!imageTag || !imageDigest) {
			throw new Error(
				`Dataset Profile ${datasetRuntime.profile.profileId} requires re-checkout to pin a scan tools image`,
			);
		}
		if (
			!(await inspectRequiredToolsImageReference({
				imageTag,
				imageId: imageDigest,
			}))
		) {
			throw new Error(`Dataset scan tools image is missing or changed: ${imageTag}`);
		}
		const repositoryProfileAgentProfileId =
			getRuntimeStageSetting(
				scanJob.scanRuntimeSettings,
				SCAN_STAGE_IDS.repositoryProfile,
			).agentProfileId || null;
		const scanAgentProfile = repositoryProfileAgentProfileId
			? await getAgentProfileById(repositoryProfileAgentProfileId).catch(
					() => null,
				)
			: null;
		return {
			isApplicationJob: false,
			target: {
				appName: serviceName,
				name: datasetRuntime.sample.title || datasetRuntime.sample.id,
				environment: {
					project: { name: projectName, scanContextVolumeName: "" },
				},
				scanStageSettings: {},
				memoryLimit: null,
				memoryReservation: null,
			},
			appName: serviceName,
			imageTag,
			contextVolumeName: "",
			projectName,
			serviceName,
			projectProfileContextRoot: buildProjectProfileContextRoot(),
			projectProfileCacheRoot: buildProjectProfileCacheRoot(),
			scanAgentProfile,
			datasetSampleHostPath: datasetRuntime.sampleHostPath,
			datasetSampleMountReadOnly: true,
		};
	}
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);
	const repositoryProfileAgentProfileId =
		getRuntimeStageSetting(
			scanJob.scanRuntimeSettings,
			SCAN_STAGE_IDS.repositoryProfile,
		).agentProfileId || null;
	const scanAgentProfile = repositoryProfileAgentProfileId
		? await getAgentProfileById(repositoryProfileAgentProfileId).catch(
				() => null,
			)
		: null;

	const appName = target.appName;
	const imageTag = toImageTagFromAppName(appName);
	const projectName = target.environment.project.name;
	const serviceName = target.name || target.appName;
	const projectProfileContextRoot = buildProjectProfileContextRoot();
	const projectProfileCacheRoot = buildProjectProfileCacheRoot();

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart vulseek-dev from dev.sh so /scan-context is mounted.",
		);
	}

	try {
		await execAsync(`docker image inspect ${imageTag}`);
	} catch {
		throw new Error(
			`Checkout image not found: ${imageTag}. Run Checkout before pipeline ${scanJob.pipelineId}.`,
		);
	}

	return {
		isApplicationJob,
		target,
		appName,
		imageTag,
		contextVolumeName: target.environment.project.scanContextVolumeName,
		projectName,
		serviceName,
		projectProfileContextRoot,
		projectProfileCacheRoot,
		scanAgentProfile,
		datasetSampleHostPath: null,
		datasetSampleMountReadOnly: true,
	};
};

const copyCodexAssetsToContainerHome = async (
	containerName: string,
	codexHome: string,
	agentsDir: string | null,
	agentProfile?: AgentProfileLike | null,
) => {
	const mcpConfigToml = await loadCodexMcpConfigToml(agentsDir);

	if (agentProfile) {
		if (agentProfile.provider === "codex") {
			if (resolveAgentAuthMode(agentProfile) === "host_home") {
				const hostPath = resolveAgentHomeHostPath(agentProfile);
				if (!hostPath) {
					throw new Error(
						"Codex host home auth mode is enabled but no home path was configured on the agent profile.",
					);
				}
				await copyHostFileToContainer({
					containerName,
					sourcePath: path.join(hostPath, "auth.json"),
					targetPath: path.posix.join(codexHome, "auth.json"),
					description: "Codex host home auth.json",
				});
				await writeContainerFile(
					containerName,
					`${codexHome}/config.toml`,
					joinTomlBlocks(buildCodexConfigToml(agentProfile), mcpConfigToml),
				);
				await execAsync(
					`docker exec ${containerName} bash -lc "test -s '${codexHome}/auth.json' && test -s '${codexHome}/config.toml'"`,
				);
				return;
			}
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				joinTomlBlocks(buildCodexConfigToml(agentProfile), mcpConfigToml),
			);
			await writeContainerFile(
				containerName,
				`${codexHome}/auth.json`,
				buildCodexAuthJson(agentProfile),
			);
			await execAsync(
				`docker exec ${containerName} bash -lc "test -s '${codexHome}/auth.json' && test -s '${codexHome}/config.toml'"`,
			);
		}
		return;
	}

	if (!agentsDir) {
		return;
	}

	const codexConfigPath = path.join(agentsDir, "codex-config.toml");
	try {
		const baseConfigToml = await fs.readFile(codexConfigPath, "utf-8");
		await writeContainerFile(
			containerName,
			`${codexHome}/config.toml`,
			joinTomlBlocks(
				withCodexAutoApproveConfigToml(baseConfigToml),
				mcpConfigToml,
			),
		);
	} catch {
		if (mcpConfigToml) {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				joinTomlBlocks(CODEX_AUTO_APPROVE_CONFIG_TOML, mcpConfigToml),
			);
		} else {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				CODEX_AUTO_APPROVE_CONFIG_TOML,
			);
		}
	}

	const codexAuthPath = path.join(agentsDir, "codex-auth.json");
	let copiedCodexAuth = false;
	try {
		await fs.stat(codexAuthPath);
		await execAsync(
			`docker cp "${codexAuthPath}" ${containerName}:"${codexHome}/auth.json"`,
		);
		copiedCodexAuth = true;
	} catch (error) {
		const errorCode =
			error && typeof error === "object"
				? (error as { code?: string }).code
				: undefined;
		if (errorCode !== "ENOENT") {
			throw new Error(
				`Unable to copy codex auth file from ${codexAuthPath}: ${getErrorMessage(error)}`,
			);
		}
	}
	await execAsync(
		`docker exec ${containerName} bash -lc "test -s '${codexHome}/config.toml'${
			copiedCodexAuth ? ` && test -s '${codexHome}/auth.json'` : ""
		}"`,
	);
};

const CLAUDE_REQUIRED_SETTINGS = {
	permissions: {
		allow: [
			"Bash",
			"Bash(*)",
			"Read",
			"Read(*)",
			"Write",
			"Write(*)",
			"Edit",
			"Edit(*)",
			"MultiEdit",
			"MultiEdit(*)",
			"Glob",
			"Glob(*)",
			"Grep",
			"Grep(*)",
			"LS",
			"LS(*)",
			"Task",
			"Task(*)",
			"TodoWrite",
			"TodoWrite(*)",
			"WebFetch",
			"WebFetch(*)",
			"WebSearch",
			"WebSearch(*)",
		],
		deny: [],
		ask: [],
	},
};

const mergeUniqueStringArrays = (left: unknown, right: string[]) => [
	...new Set([
		...(Array.isArray(left)
			? left.filter((value): value is string => typeof value === "string")
			: []),
		...right,
	]),
];

const readContainerFileOrEmpty = async (
	containerName: string,
	filePath: string,
) => {
	const { stdout } = await execAsync(
		`docker exec ${containerName} bash -lc "if [ -f '${escapeSingleQuotes(
			filePath,
		)}' ]; then base64 -w0 '${escapeSingleQuotes(filePath)}'; fi"`,
	);
	return stdout.trim()
		? Buffer.from(stdout.trim(), "base64").toString("utf-8")
		: "";
};

const buildClaudeProfileSettingsEnv = (
	agentProfile: AgentProfileLike | null | undefined,
) => {
	if (agentProfile?.provider !== "claude_code" || !agentProfile.model) {
		return {};
	}
	return {
		ANTHROPIC_MODEL: agentProfile.model,
		ANTHROPIC_SMALL_FAST_MODEL: agentProfile.model,
		ANTHROPIC_DEFAULT_SONNET_MODEL: agentProfile.model,
		ANTHROPIC_DEFAULT_OPUS_MODEL: agentProfile.model,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: agentProfile.model,
		CLAUDE_CODE_SUBAGENT_MODEL: agentProfile.model,
	};
};

const mergeClaudeSettingsJson = (
	existingSettingsJson: string,
	agentProfile?: AgentProfileLike | null,
) => {
	let existing: Record<string, unknown> = {};
	if (existingSettingsJson.trim()) {
		try {
			const parsed = JSON.parse(existingSettingsJson) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {}
	}

	const existingPermissions =
		existing.permissions &&
		typeof existing.permissions === "object" &&
		!Array.isArray(existing.permissions)
			? (existing.permissions as Record<string, unknown>)
			: {};
	const existingEnv =
		existing.env &&
		typeof existing.env === "object" &&
		!Array.isArray(existing.env)
			? (existing.env as Record<string, unknown>)
			: {};
	const profileEnv = buildClaudeProfileSettingsEnv(agentProfile);
	return {
		...existing,
		env: {
			...existingEnv,
			...profileEnv,
		},
		permissions: {
			...existingPermissions,
			allow: mergeUniqueStringArrays(
				existingPermissions.allow,
				CLAUDE_REQUIRED_SETTINGS.permissions.allow,
			),
			deny: mergeUniqueStringArrays(
				existingPermissions.deny,
				CLAUDE_REQUIRED_SETTINGS.permissions.deny,
			),
			ask: mergeUniqueStringArrays(
				existingPermissions.ask,
				CLAUDE_REQUIRED_SETTINGS.permissions.ask,
			),
		},
	};
};

const initializeClaudeHomeInContainer = async (
	containerName: string,
	claudeHome: string,
	agentProfile?: AgentProfileLike | null,
) => {
	const settingsPath = `${claudeHome}/settings.json`;
	const existingSettingsJson = await readContainerFileOrEmpty(
		containerName,
		settingsPath,
	);
	await writeContainerFile(
		containerName,
		settingsPath,
		`${JSON.stringify(
			mergeClaudeSettingsJson(existingSettingsJson, agentProfile),
			null,
			2,
		)}\n`,
	);
};

const copyClaudeAssetsToContainerHome = async (
	containerName: string,
	claudeHome: string,
	agentProfile?: AgentProfileLike | null,
) => {
	if (
		agentProfile?.provider === "claude_code" &&
		resolveAgentAuthMode(agentProfile) === "host_home"
	) {
		const hostPath = resolveAgentHomeHostPath(agentProfile);
		if (!hostPath) {
			throw new Error(
				"Claude Code host home auth mode is enabled but no home path was configured on the agent profile.",
			);
		}
		await copyHostFileToContainer({
			containerName,
			sourcePath: path.join(hostPath, ".credentials.json"),
			targetPath: path.posix.join(claudeHome, ".credentials.json"),
			description:
				"Claude Code host home .credentials.json. Configure homePath as the Claude config directory.",
		});
	}

	await initializeClaudeHomeInContainer(
		containerName,
		claudeHome,
		agentProfile,
	);
	await execAsync(
		`docker exec ${containerName} bash -lc "test -s '${escapeSingleQuotes(
			path.posix.join(claudeHome, "settings.json"),
		)}'"`,
	);
};

export type StageContainerInput = {
	scanJob: ScanJob;
	taskId?: string;
	agentProfile: AgentProfileLike | null;
	containerName: string;
	codexHome: string;
	stageDirPath: string;
	stageRootInContainer: string;
	taskRealRootInContainer?: string;
	laneHostPath?: string;
	persistent?: boolean;
	reuseContainer?: boolean;
	nullableOutput?: boolean;
	groupedPersistent?: boolean;
	allowAgentExit?: boolean;
	/** Optional host-backed workspace used by Dataset evaluation scan tasks. */
	datasetAgentRuntime?: {
		imageTag: string;
		projectName: string;
		serviceName: string;
		profileHostDir: string;
		workspaceHostPath: string;
		workspaceReadOnly?: boolean;
	};
	/**
	 * When true, write jobs/<scanJobId>/security-policy.md under the project
	 * profile and append its path instruction to the agent prompt. Defaults to
	 * false (stage YAML runtimeConfig.includePolicy).
	 */
	includePolicy?: boolean;
	/**
	 * When true, still write policy/schema files but do not append their
	 * instructions to the prompt. Unused by goal stages; they now receive
	 * policy, injection, and the structured-output suffix like other stages.
	 */
	omitPromptAdditions?: boolean;
};

export type RunSingleTurnAgentInput = StageContainerInput & {
	taskId?: string;
	cwd: string;
	prompt: string | ((containerName: string) => Promise<string>);
	taskStageDirPath?: string;
	taskStageRootInContainer?: string;
	taskRealRootInContainer?: string;
	laneThreadId?: string | null;
	laneDriverPid?: number | null;
	outputSchema?: StructuredOutputSchemaSource;
	routeOutputSchemas?: RouteOutputSchema[];
	onThreadId?: (threadId: string) => Promise<void>;
	sessionMode?: "new" | "fork";
	parentSessionId?: string | null;
	parentTaskId?: string | null;
	goal?: boolean;
	goalPreserving?: boolean;
	followUpPrompt?: string | null;
	initialGoalPrompt?: string | null;
	stageName?: string;
	laneIndex?: number | null;
};

export type RunSingleTurnAgentResult = {
	threadId: string | null;
};

const isResearchPipeline = (value: ScanJob | string) =>
	typeof value === "string"
		? value === "research"
		: Array.isArray((value.pipelineCompiledSnapshot as { stages?: Array<{ id: string }> } | null)?.stages) &&
			(value.pipelineCompiledSnapshot as { stages: Array<{ id: string }> }).stages.some(
				(stage) => stage.id === "research-scope",
			);

export const buildResearchContainerEnvPairs = (
	scanJob: ScanJob | string,
	scanJobId: string,
	taskId: string,
) =>
	isResearchPipeline(scanJob)
		? [
				`VULSEEK_SCAN_JOB_ID=${scanJobId}`,
				`VULSEEK_TASK_ID=${taskId}`,
				"VULSEEK_RESEARCH_DATABASE_URL",
			]
		: [];

export const requireResearchDatabaseContext = (
	scanJob: ScanJob | string,
	environment: Record<string, string | undefined>,
) => {
	if (
		isResearchPipeline(scanJob) &&
		!environment.VULSEEK_RESEARCH_DATABASE_URL?.trim()
	) {
		throw new Error(
			"Research database context is not configured; set VULSEEK_RESEARCH_DATABASE_URL before starting Research tasks",
		);
	}
};

const resolveStageContainerRuntime = async (input: StageContainerInput) => {
	const {
		imageTag,
		projectName,
		serviceName,
		target,
		datasetSampleHostPath,
		datasetSampleMountReadOnly,
	} = await resolveScanExecutionContext(
		input.scanJob,
		input.datasetAgentRuntime,
	);
	requireResearchDatabaseContext(input.scanJob, process.env);
	const globalContainerEnvPairs = getGlobalContainerEnvironmentPairs();
	const agentsDir = await resolveAgentsDirectory();
	const hostProfileDir =
		input.datasetAgentRuntime?.profileHostDir ||
		(await resolveProjectProfileHostPath({
			projectName,
			profileName: serviceName,
		}));
	const mountedProfileDir = resolveMountedProjectProfilePath({
		projectName,
		profileName: serviceName,
	});
	const jobAgentHomeHostPath = path.join(
		hostProfileDir,
		"jobs",
		input.scanJob.scanJobId,
		JOB_AGENT_HOME_DIR_NAME,
	);
	const jobAgentHomeContainerPath = buildJobAgentHomePathInContainer(
		input.scanJob.scanJobId,
	);
	await fs.mkdir(jobAgentHomeHostPath, { recursive: true });
	await fs.mkdir(input.stageDirPath, { recursive: true });
	const containerEnvPairs = [
		...globalContainerEnvPairs,
		`VULSEEK_PROJECT_PROFILE_DIR=${mountedProfileDir}`,
		`VULSEEK_PROJECT_CACHE_DIR=${path.posix.join(mountedProfileDir, "cache")}`,
		`VULSEEK_AGENT_HOME=${jobAgentHomeContainerPath}`,
		...buildResearchContainerEnvPairs(
			input.scanJob,
			input.scanJob.scanJobId,
			input.taskId || "",
		),
	];
	const runtimeFileNames = AGENT_RUNTIME_FILE_NAMES;
	const containerNetworkArg = await resolveCurrentDockerNetworkArg();
	const containerEnvArgs = containerEnvPairs
		.map((pair) => {
			const escaped = pair.replace(/'/g, `"'"'`);
			return `-e '${escaped}'`;
		})
		.join(" ");
	const datasetSampleMountArg = datasetSampleHostPath
		? `-v '${escapeSingleQuotes(datasetSampleHostPath)}:/workspace/repo:${datasetSampleMountReadOnly ? "ro" : "rw"}'`
		: "";

	const stdoutPath = path.join(input.stageDirPath, runtimeFileNames.stdout);
	const containerBootstrapPath = path.join(
		input.stageDirPath,
		CONTAINER_BOOTSTRAP_LOG_FILE_NAME,
	);
	const { memoryLimit, memoryReservation } = getTargetMemoryArgs(target);
	const memoryArgs = [
		memoryLimit ? `--memory ${memoryLimit}` : null,
		memoryReservation ? `--memory-reservation ${memoryReservation}` : null,
	]
		.filter(Boolean)
		.join(" ");

	return {
		imageTag,
		agentsDir,
		taskRuntimeMount: {
			mountSource: hostProfileDir,
			mountDescription: `host_path:${hostProfileDir}`,
			dockerMountArg: `-v '${escapeSingleQuotes(hostProfileDir)}':${mountedProfileDir} -v '${escapeSingleQuotes(jobAgentHomeHostPath)}':${jobAgentHomeContainerPath}`,
		},
		agentHome: {
			codexContainerDir: jobAgentHomeContainerPath,
			claudeContainerDir: jobAgentHomeContainerPath,
		},
		containerNetworkArg,
		containerEnvArgs,
		datasetSampleMountArg,
		memoryArgs,
		stdoutPath,
		containerBootstrapPath,
	};
};

const containerHasMountDestination = async (
	containerName: string,
	destination: string,
) => {
	const { stdout } = await execAsync(
		`docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' ${containerName}`,
	).catch(() => ({ stdout: "" }));
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.includes(destination);
};

export const startContainer = async (input: StageContainerInput) => {
	const runtime = await resolveStageContainerRuntime(input);
	const logPath = runtime.containerBootstrapPath;
	await fs.writeFile(logPath, "", "utf-8").catch(() => {});
	await appendHostBootstrapLog(
		logPath,
		`start_container task_id=${input.taskId || ""} container=${input.containerName} persistent=${String(
			Boolean(input.persistent),
		)} stage_dir=${JSON.stringify(input.stageDirPath)} stage_root=${JSON.stringify(
			input.stageRootInContainer,
		)} lane_host=${JSON.stringify(input.laneHostPath || "")}`,
	);

	const laneHostPath = input.laneHostPath
		? remapScanContextAppPathToHost(input.laneHostPath)
		: "";
	if (laneHostPath) {
		await fs.mkdir(laneHostPath, { recursive: true });
	}
	const laneMountArg = laneHostPath
		? `-v '${escapeSingleQuotes(laneHostPath)}':${LANE_ALIAS_ROOT_IN_CONTAINER}`
		: "";

	if ((input.reuseContainer ?? true) || input.persistent) {
		let running = await execAsync(
			`docker inspect -f '{{.State.Running}}' ${input.containerName}`,
		)
			.then(({ stdout }) => stdout.trim() === "true")
			.catch(() => false);
		if (running && laneHostPath) {
			const hasLaneMount = await containerHasMountDestination(
				input.containerName,
				LANE_ALIAS_ROOT_IN_CONTAINER,
			);
			if (!hasLaneMount) {
				await withHostBootstrapLog(
					logPath,
					"recreate_container_missing_lane_mount",
					"",
					() => execAsync(`docker rm -f ${input.containerName}`).catch(() => {}),
				);
				running = false;
			}
		}
		if (running) {
			await withHostBootstrapLog(logPath, "container_reuse", "", () =>
				execAsync(
					`docker exec ${input.containerName} bash -lc "mkdir -p '${input.stageRootInContainer}' '${runtime.agentHome.codexContainerDir}/skills' '${runtime.agentHome.claudeContainerDir}'"`,
				),
			);
			if (input.taskRealRootInContainer) {
				if (!input.persistent) {
					await drainPreviousTaskAliasInContainer({
						containerName: input.containerName,
						nextTaskRootInContainer: input.taskRealRootInContainer,
						logPath,
					});
				}
				await updateTaskAliasSymlinkInContainer({
					containerName: input.containerName,
					taskRootInContainer: input.taskRealRootInContainer,
					logPath,
				});
			}
			await appendHostBootstrapLog(logPath, "start_container_done reused=true");
			return;
		}
		await withHostBootstrapLog(logPath, "remove_stale_container", "", () =>
			execAsync(`docker rm -f ${input.containerName}`).catch(() => {}),
		);
	} else {
		// Recovery/retry may encounter leftover containers with the same deterministic
		// name. Remove them first so restart logic can safely recreate the runtime.
		await withHostBootstrapLog(logPath, "remove_existing_container", "", () =>
			execAsync(`docker rm -f ${input.containerName}`).catch(() => {}),
		);
	}

	await withHostBootstrapLog(
		logPath,
		"runtime_files_initialized_on_host",
		"",
		() => initializeAgentRuntimeFiles(input.stageDirPath),
	);
	await withHostBootstrapLog(
		logPath,
		"docker_run",
		`image=${JSON.stringify(runtime.imageTag)} mount=${JSON.stringify(
			runtime.taskRuntimeMount.mountDescription,
		)}`,
		() =>
			execDockerRunWithRetry({
				containerName: input.containerName,
				taskId: input.taskId,
				logPath,
				command: `docker run -d --init --name ${input.containerName} ${runtime.containerNetworkArg} ${buildNamespaceEnabledContainerArgs()} ${runtime.memoryArgs} ${runtime.taskRuntimeMount.dockerMountArg} ${laneMountArg} ${runtime.datasetSampleMountArg} ${runtime.containerEnvArgs} --entrypoint bash ${runtime.imageTag} -lc "mkdir -p '${input.stageRootInContainer}' '${LANE_ALIAS_ROOT_IN_CONTAINER}' '${runtime.agentHome.codexContainerDir}/skills' '${runtime.agentHome.claudeContainerDir}' && sleep infinity"`,
			}),
	);

	await withHostBootstrapLog(logPath, "install_runtime_skills", "", () =>
		installRuntimeSkillsInContainer({
			containerName: input.containerName,
			agentsDir: runtime.agentsDir,
			agentHomeDir: runtime.agentHome.codexContainerDir,
			skillNames: RUNTIME_CUSTOM_SKILLS,
			logPath,
		}),
	);
	await appendHostBootstrapLog(logPath, "start_container_runtime_ready");
	if (input.taskRealRootInContainer) {
		await updateTaskAliasSymlinkInContainer({
			containerName: input.containerName,
			taskRootInContainer: input.taskRealRootInContainer,
			logPath,
		});
	}
	await appendHostBootstrapLog(logPath, "start_container_done reused=false");
};

export const stopContainer = async (containerName: string) => {
	await execAsync(`docker stop ${containerName}`).catch(() => {});
};

export const removeContainer = async (containerName: string) => {
	await execAsync(`docker rm -f ${containerName}`).catch(() => {});
};

const updateContainerRootAlias = async (input: {
	containerName: string;
	aliasRoot: string;
	targetRoot: string;
	logName: string;
	logPath?: string | null;
}) => {
	const script = [
		"set -euo pipefail",
		`target_root='${escapeSingleQuotes(input.targetRoot)}'`,
		`alias_root='${escapeSingleQuotes(input.aliasRoot)}'`,
		'mkdir -p "$target_root"',
		'if [ -L "$alias_root" ]; then',
		'  rm "$alias_root"',
		'elif [ -e "$alias_root" ]; then',
		'  echo "$alias_root exists but is not a symlink" >&2',
		"  exit 1",
		"fi",
		'ln -s "$target_root" "$alias_root"',
	].join("\n");
	await withHostBootstrapLog(
		input.logPath,
		input.logName,
		`target=${JSON.stringify(input.targetRoot)}`,
		() =>
			execAsync(
				`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
			),
	);
};

const updateTaskAliasSymlinkInContainer = async (input: {
	containerName: string;
	taskRootInContainer: string;
	logPath?: string | null;
}) =>
	await updateContainerRootAlias({
		containerName: input.containerName,
		aliasRoot: TASK_ALIAS_ROOT_IN_CONTAINER,
		targetRoot: input.taskRootInContainer,
		logName: "task_alias_symlink",
		logPath: input.logPath,
	});

const DRAIN_PREVIOUS_DRIVER_TIMEOUT_MS = 60_000;
const ACP_DRIVER_FILE_NAME = "/opt/vulseek-acp/vulseek-acp-driver.mjs";
const CONTAINER_BOOTSTRAP_LOG_FILE_NAME = "container-bootstrap.log";

const drainPreviousTaskAliasInContainer = async (input: {
	containerName: string;
	nextTaskRootInContainer: string;
	logPath?: string | null;
}) => {
	const timeoutSeconds = Math.ceil(DRAIN_PREVIOUS_DRIVER_TIMEOUT_MS / 1000);
	const script = [
		"set -euo pipefail",
		`next_root='${escapeSingleQuotes(input.nextTaskRootInContainer)}'`,
		"if [ ! -L /task ]; then exit 0; fi",
		"old_root=$(readlink -f /task)",
		'if [ "$old_root" = "$next_root" ]; then exit 0; fi',
		'input_path="$old_root/stdin"',
		"pid=''",
		`pid=$(pgrep -f -- "${ACP_DRIVER_FILE_NAME} $input_path" | head -n 1 || true)`,
		'if [ -z "$pid" ]; then exit 0; fi',
		`deadline=$(($(date +%s) + ${timeoutSeconds}))`,
		"while :; do",
		"  process_alive=false",
		'  if kill -0 "$pid" 2>/dev/null; then process_alive=true; fi',
		'  if [ "$process_alive" = false ]; then exit 0; fi',
		'  if [ "$(date +%s)" -ge "$deadline" ]; then',
		'    echo "previous driver did not drain: pid=$pid old_root=$old_root process_alive=$process_alive" >&2',
		"    exit 42",
		"  fi",
		"  sleep 0.2",
		"done",
	].join("\n");
	await withHostBootstrapLog(
		input.logPath,
		"drain_previous_driver",
		`next_root=${JSON.stringify(input.nextTaskRootInContainer)}`,
		() =>
			execAsync(
				`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
			),
	);
};

type DriverHealth = {
	alive: boolean;
	reason: string | null;
	pid: string | null;
	state: string | null;
	lifecycleAgeMs: number | null;
	lastLifecycleLine: string | null;
};

const parseDriverHealthOutput = (output: string): DriverHealth => {
	const record = new Map<string, string>();
	for (const line of output.split("\n")) {
		const index = line.indexOf("=");
		if (index <= 0) {
			continue;
		}
		record.set(line.slice(0, index), line.slice(index + 1));
	}
	const age = Number.parseInt(record.get("age_ms") || "", 10);
	return {
		alive: record.get("alive") === "true",
		reason: record.get("reason") || null,
		pid: record.get("pid") || null,
		state: record.get("state") || null,
		lifecycleAgeMs: Number.isFinite(age) ? age : null,
		lastLifecycleLine: record.get("last_line") || null,
	};
};

const inspectDriverHealth = async (input: {
	containerName: string;
	driverScriptPath: string;
	driverInputPath: string;
	driverStdoutPath: string;
	driverPid?: number | null;
}): Promise<DriverHealth> => {
	const maxIdleMs = Number.isFinite(PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS)
		? Math.max(30000, PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS)
		: 120000;
	const maxIdleSeconds = Math.ceil(maxIdleMs / 1000);
	const probe = [
		"set -u",
		`driver_script='${escapeSingleQuotes(input.driverScriptPath)}'`,
		`input_path='${escapeSingleQuotes(input.driverInputPath)}'`,
		`stdout_path='${escapeSingleQuotes(input.driverStdoutPath)}'`,
		`max_idle_seconds=${maxIdleSeconds}`,
		`expected_pid='${input.driverPid ?? ""}'`,
		'pid="$expected_pid"',
		'if [ -z "$pid" ]; then pid=$(pgrep -f -- "$driver_script $input_path" | head -n 1 || true); fi',
		"if [ -z \"$pid\" ]; then echo 'alive=false'; echo 'reason=process_not_running'; exit 0; fi",
		'if [ -n "$pid" ]; then command_line=$(ps -p "$pid" -o args= 2>/dev/null || true); case "$command_line" in *"$driver_script $input_path"*) ;; *) echo \'alive=false\'; echo \'reason=process_not_running\'; echo "pid=$pid"; exit 0;; esac; fi',
		"state=$(ps -p \"$pid\" -o stat= 2>/dev/null | tr -d '[:space:]' || true)",
		"if [ -z \"$state\" ]; then echo 'alive=false'; echo 'reason=process_not_running'; echo \"pid=$pid\"; exit 0; fi",
		'case "$state" in *Z*) echo \'alive=false\'; echo \'reason=process_zombie\'; echo "pid=$pid"; echo "state=$state"; exit 0;; esac',
		'if ! kill -0 "$pid" 2>/dev/null; then echo \'alive=false\'; echo \'reason=kill_check_failed\'; echo "pid=$pid"; echo "state=$state"; exit 0; fi',
		'if [ ! -f "$stdout_path" ]; then echo \'alive=false\'; echo \'reason=missing_stdout\'; echo "pid=$pid"; echo "state=$state"; exit 0; fi',
		"now=$(date +%s)",
		'mtime=$(stat -c %Y "$stdout_path" 2>/dev/null || echo 0)',
		"age_seconds=$((now - mtime))",
		"age_ms=$((age_seconds * 1000))",
		"last_line=$(tail -n 1 \"$stdout_path\" 2>/dev/null | tr '\\n' ' ' || true)",
		'if [ "$age_seconds" -gt "$max_idle_seconds" ]; then echo \'alive=false\'; echo \'reason=stale_stdout\'; echo "pid=$pid"; echo "state=$state"; echo "age_ms=$age_ms"; echo "last_line=$last_line"; exit 0; fi',
		"echo 'alive=true'",
		"echo 'reason=ok'",
		'echo "pid=$pid"',
		'echo "state=$state"',
		'echo "age_ms=$age_ms"',
		'echo "last_line=$last_line"',
	].join("; ");
	return await execAsync(
		`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(probe)}'`,
	)
		.then(({ stdout }) => parseDriverHealthOutput(stdout))
		.catch((error) => ({
			alive: false,
			reason: `health_probe_failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
			pid: null,
			state: null,
			lifecycleAgeMs: null,
			lastLifecycleLine: null,
		}));
};

const stopPersistentDriver = async (input: {
	containerName: string;
	driverScriptPath: string;
	driverInputPath: string;
}) => {
	const script = [
		"set -u",
		`driver_script='${escapeSingleQuotes(input.driverScriptPath)}'`,
		`input_path='${escapeSingleQuotes(input.driverInputPath)}'`,
		'pkill -TERM -f "$driver_script $input_path" 2>/dev/null || true',
		"sleep 1",
		'pkill -KILL -f "$driver_script $input_path" 2>/dev/null || true',
	].join("; ");
	await execAsync(
		`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
	).catch(() => {});
};

const prepareTaskAgentHomeInContainer = async (input: {
	containerName: string;
	agentProvider: string;
	agentProfile: AgentProfileLike | null;
	agentsDir: string | null;
	agentHomePathInContainer: string;
	logPath?: string | null;
}) => {
	const setupScript = [
		"set -euo pipefail",
		`agent_home='${escapeSingleQuotes(input.agentHomePathInContainer)}'`,
		'mkdir -p "$agent_home/skills"',
	].join("\n");

	await withHostBootstrapLog(
		input.logPath,
		"agent_home_setup",
		`provider=${input.agentProvider} target=${JSON.stringify(input.agentHomePathInContainer)}`,
		() =>
			execAsync(
				`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(setupScript)}'`,
			),
	);

	if (input.agentProvider === "claude_code") {
		await withHostBootstrapLog(
			input.logPath,
			"agent_home_copy_claude_assets",
			"",
			() =>
				copyClaudeAssetsToContainerHome(
					input.containerName,
					input.agentHomePathInContainer,
					input.agentProfile,
				),
		);
	} else {
		await withHostBootstrapLog(
			input.logPath,
			"agent_home_copy_codex_assets",
			"",
			() =>
				copyCodexAssetsToContainerHome(
					input.containerName,
					input.agentHomePathInContainer,
					input.agentsDir,
					input.agentProfile,
				),
		);
	}

	return {
		agentHomePathInContainer: input.agentHomePathInContainer,
		agentHomeLinkPathInContainer: input.agentHomePathInContainer,
		parentAgentHomePathInContainer: null,
		agentHomeCopiedFromParent: false,
	};
};

export const runSingleTurnAgentInContainer = async (
	input: RunSingleTurnAgentInput,
): Promise<RunSingleTurnAgentResult> => {
	const runSingleTurnStartedAt = Date.now();
	let outputSchemaElapsedMs = 0;
	let promptResolveElapsedMs = 0;
	const taskStageDirPath = input.taskStageDirPath || input.stageDirPath;
	const taskStageRootInContainer =
		input.taskStageRootInContainer || input.stageRootInContainer;
	const realTaskRootInContainer =
		input.taskRealRootInContainer ||
		(taskStageRootInContainer !== TASK_ALIAS_ROOT_IN_CONTAINER
			? taskStageRootInContainer
			: null);
	if (!realTaskRootInContainer) {
		throw new Error(
			"Task real root in container is required when /task is an alias",
		);
	}
	const structuredOutputSchemaPathOnHost = path.join(
		taskStageDirPath,
		STRUCTURED_OUTPUT_SCHEMA_FILE_NAME,
	);
	const structuredOutputResultPathInContainer = path.posix.join(
		taskStageRootInContainer,
		STRUCTURED_OUTPUT_RESULT_FILE_NAME,
	);
	const structuredOutputSchemaAgentPathInContainer = path.posix.join(
		TASK_ALIAS_ROOT_IN_CONTAINER,
		STRUCTURED_OUTPUT_SCHEMA_FILE_NAME,
	);
	const structuredOutputResultAgentPathInContainer = path.posix.join(
		TASK_ALIAS_ROOT_IN_CONTAINER,
		STRUCTURED_OUTPUT_RESULT_FILE_NAME,
	);
	if (input.outputSchema || input.routeOutputSchemas?.length) {
		const stepStartedAt = Date.now();
		const jsonSchema = buildStructuredOutputEnvelopeJsonSchema(
			input.outputSchema || input.routeOutputSchemas![0]!.schema,
			input.routeOutputSchemas,
			{
				nullableOutput: input.nullableOutput,
				allowAgentExit: input.allowAgentExit,
			},
		);
		const serializedJsonSchema = `${JSON.stringify(jsonSchema, null, 2)}\n`;
		await fs.mkdir(taskStageDirPath, { recursive: true });
		await fs.writeFile(
			structuredOutputSchemaPathOnHost,
			serializedJsonSchema,
			"utf-8",
		);
		if (input.persistent && input.stageDirPath !== taskStageDirPath) {
			await fs.mkdir(input.stageDirPath, { recursive: true });
			await fs.writeFile(
				path.join(input.stageDirPath, STRUCTURED_OUTPUT_SCHEMA_FILE_NAME),
				serializedJsonSchema,
				"utf-8",
			);
		}
		outputSchemaElapsedMs = Date.now() - stepStartedAt;
	}

	const promptResolveStartedAt = Date.now();
	const resolvedPrompt =
		typeof input.prompt === "string"
			? input.prompt
			: await input.prompt(input.containerName);
	promptResolveElapsedMs = Date.now() - promptResolveStartedAt;
	const injectionTarget = input.scanJob.applicationId
		? await findApplicationById(input.scanJob.applicationId)
		: input.scanJob.composeId
			? await findComposeById(input.scanJob.composeId)
			: null;
	const injectionPromptText = injectionTarget?.injectionPrompt?.trim() || "";
	const securityPolicyText = injectionTarget?.securityPolicy?.trim() || "";
	// Only stages with runtimeConfig.includePolicy: true get the policy path in prompt.
	const securityPolicyArtifact =
		input.includePolicy && injectionTarget && securityPolicyText
			? await writeScanJobSecurityPolicyArtifact({
					securityPolicy: securityPolicyText,
					// Write via /scan-context (app mount), not HOST_PATH shadow dir.
					profileHostPath: await resolveProjectProfileAppWritePath({
						projectName: injectionTarget.environment.project.name,
						profileName: injectionTarget.name || injectionTarget.appName,
					}),
					profileContainerPath: resolveMountedProjectProfilePath({
						projectName: injectionTarget.environment.project.name,
						profileName: injectionTarget.name || injectionTarget.appName,
					}),
					scanJobId: input.scanJob.scanJobId,
				})
			: null;
	const omitPromptAdditions = Boolean(input.omitPromptAdditions);
	const promptAdditions = omitPromptAdditions
		? []
		: [securityPolicyArtifact?.instruction, injectionPromptText || null].filter(
				Boolean,
			);
	const outputProtocolPrompt = omitPromptAdditions
		? ""
		: [
				...promptAdditions,
				input.outputSchema || input.routeOutputSchemas?.length
					? buildStructuredOutputPromptSuffix(
							input.outputSchema || input.routeOutputSchemas![0]!.schema,
							structuredOutputSchemaAgentPathInContainer,
							structuredOutputResultAgentPathInContainer,
							input.routeOutputSchemas,
							{
								allowAgentExit: input.allowAgentExit,
								nullableOutput: input.nullableOutput,
							},
						)
					: "",
			]
				.filter(Boolean)
				.join("\n");
	const resolvedPromptFinal = resolvedPrompt;
	const promptWithOutputSchema = resolvedPromptFinal;
	const runtimeFileNames = AGENT_RUNTIME_FILE_NAMES;
	const taskStderrPath = path.join(taskStageDirPath, runtimeFileNames.stdout);
	await initializeAgentRuntimeFiles(taskStageDirPath);
	await appendHostBootstrapLog(
		taskStderrPath,
		`run_single_turn_start task_id=${input.taskId || ""} container=${input.containerName} persistent=${String(
			Boolean(input.persistent),
		)} lane_thread_id=${input.laneThreadId || ""} session_mode=${input.sessionMode || ""} task_dir=${JSON.stringify(
			taskStageDirPath,
		)} task_root=${JSON.stringify(taskStageRootInContainer)} stage_root=${JSON.stringify(
			input.stageRootInContainer,
		)} elapsed_before_runtime_ms=${Date.now() - runSingleTurnStartedAt} output_schema_ms=${outputSchemaElapsedMs} prompt_resolve_ms=${promptResolveElapsedMs}`,
	);
	await updateTaskAliasSymlinkInContainer({
		containerName: input.containerName,
		taskRootInContainer: realTaskRootInContainer,
		logPath: taskStderrPath,
	});
	const agentProvider = input.agentProfile?.provider || "codex";
	const driverScriptPath = ACP_DRIVER_FILE_NAME;
	const driverInputHostPath = path.join(
		input.stageDirPath,
		runtimeFileNames.stdin,
	);
	const driverInputPath = path.posix.join(
		input.stageRootInContainer,
		runtimeFileNames.stdin,
	);
	const driverStdoutPath = path.posix.join(
		taskStageRootInContainer,
		runtimeFileNames.stdout,
	);

	const persistentDriverHealth = input.persistent
		? await withHostBootstrapLog(
				taskStderrPath,
				"inspect_persistent_driver_health",
				"",
				() =>
					inspectDriverHealth({
						containerName: input.containerName,
						driverScriptPath,
						driverInputPath: driverInputPath,
						driverStdoutPath,
						driverPid: input.laneDriverPid,
					}),
			)
		: null;
	if (persistentDriverHealth) {
		await appendHostBootstrapLog(
			taskStderrPath,
			`persistent_driver_health alive=${String(
				persistentDriverHealth.alive,
			)} reason=${JSON.stringify(persistentDriverHealth.reason || "")} pid=${JSON.stringify(
				persistentDriverHealth.pid || "",
			)} state=${JSON.stringify(persistentDriverHealth.state || "")} lifecycle_age_ms=${
				persistentDriverHealth.lifecycleAgeMs ?? ""
			}`,
		);
	}
	const persistentDriverAlive = Boolean(
		input.persistent && persistentDriverHealth?.alive,
	);
	const agentHomePathInContainer = buildJobAgentHomePathInContainer(
		input.scanJob.scanJobId,
	);
	const agentsDir = await resolveAgentsDirectory();
	const taskAgentHome = persistentDriverAlive
		? {
				agentHomePathInContainer,
				agentHomeLinkPathInContainer: agentHomePathInContainer,
				parentAgentHomePathInContainer: null,
				agentHomeCopiedFromParent: false,
			}
		: await prepareTaskAgentHomeInContainer({
				containerName: input.containerName,
				agentProvider,
				agentProfile: input.agentProfile,
				agentsDir,
				agentHomePathInContainer,
				logPath: taskStderrPath,
			});

	await appendHostBootstrapLog(
		taskStderrPath,
		`agent_home_ready path=${JSON.stringify(
			taskAgentHome.agentHomePathInContainer,
		)} link=${JSON.stringify(taskAgentHome.agentHomeLinkPathInContainer)} copied_from_parent=${String(
			taskAgentHome.agentHomeCopiedFromParent,
		)}`,
	);

	const existingTaskThreadId = input.taskId
		? (await findTaskByIdRepo(input.taskId).catch(() => null))?.threadId || null
		: null;
	const adapterEnv = input.agentProfile
		? envPairsToRecord(
				agentProvider === "claude_code"
					? buildClaudeEnvPairs(
							input.agentProfile,
							taskAgentHome.agentHomePathInContainer,
						)
					: parseAgentProfileEnvPairs(input.agentProfile),
			)
		: {};
	const buildDriverTaskInput = () => ({
		taskId: input.taskId || undefined,
		provider:
			input.agentProfile?.provider === "claude_code" ? "claude" : "codex",
		cwd: input.cwd,
		prompt: promptWithOutputSchema,
		followUpPrompt: input.followUpPrompt || null,
		outputProtocolPrompt: outputProtocolPrompt || null,
		initialGoalPrompt: input.initialGoalPrompt || null,
		threadId: existingTaskThreadId || input.laneThreadId || null,
		adapterEnv,
		taskStageRootInContainer,
		taskAliasRootInContainer: TASK_ALIAS_ROOT_IN_CONTAINER,
		structuredOutputResultPathInContainer,
		structuredOutputSchemaPathInContainer:
			structuredOutputSchemaAgentPathInContainer,
		structuredOutputGracePeriodMs: 2_000,
		structuredOutputRecoveryAttempts: 1,
		goalEnabled: Boolean(input.goal),
		goalPreserving: Boolean(input.goal && input.goalPreserving && input.persistent),
		nullableOutput: Boolean(input.nullableOutput),
		allowAgentExit: Boolean(input.allowAgentExit),
		model: input.agentProfile?.model || null,
		thinkingLevel: input.agentProfile?.thinkingLevelEnabled
			? input.agentProfile.thinkingLevel
			: null,
		sessionMode: input.laneThreadId ? "persistent" : input.sessionMode || "new",
		persistent: Boolean(input.persistent),
		parentSessionId: input.parentSessionId || null,
		stdoutPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.stdout,
		),
		agentHomePathInContainer: taskAgentHome.agentHomePathInContainer,
		agentHomeLinkPathInContainer: taskAgentHome.agentHomeLinkPathInContainer,
		parentAgentHomePathInContainer:
			taskAgentHome.parentAgentHomePathInContainer,
		agentHomeCopiedFromParent: taskAgentHome.agentHomeCopiedFromParent,
	});
	if (persistentDriverAlive) {
		const driverTaskInput = buildDriverTaskInput();
		await appendHostBootstrapLog(
			taskStderrPath,
			`persistent_driver_enqueue stdin task_id=${input.taskId || ""} lane_thread_id=${input.laneThreadId || ""}`,
		);
		await appendContainerFile(
			input.containerName,
			driverStdoutPath,
			`${JSON.stringify({ type: "log", level: "debug", source: "host", message: `persistent_driver_enqueue stdin task_id=${input.taskId || ""} lane_thread_id=${input.laneThreadId || ""}` })}\n`,
		).catch(() => {});
		await withHostBootstrapLog(
			taskStderrPath,
			"persistent_driver_append_stdin",
			"",
			() =>
				writeDriverTaskToInputFile({
					inputPath: driverInputHostPath,
					taskInput: driverTaskInput,
				}),
		);
		return { threadId: input.laneThreadId || null };
	}
	const driverTaskInput = buildDriverTaskInput();
	if (input.persistent && input.laneThreadId && persistentDriverHealth) {
		await appendContainerFile(
			input.containerName,
			driverStdoutPath,
			`${JSON.stringify({
				type: "log",
				level: "warn",
				source: "host",
				message: `persistent_driver_unhealthy task_id=${input.taskId || ""} reason=${persistentDriverHealth.reason || ""} pid=${persistentDriverHealth.pid || ""} state=${persistentDriverHealth.state || ""} last_stdout=${persistentDriverHealth.lastLifecycleLine || ""}`,
			})}\n`,
		).catch(() => {});
		await stopPersistentDriver({
			containerName: input.containerName,
			driverScriptPath,
			driverInputPath,
		});
	}

	await withHostBootstrapLog(taskStderrPath, "write_driver_stdin", "", () =>
		writeDriverTaskToInputFile({
			inputPath: driverInputHostPath,
			taskInput: driverTaskInput,
		}),
	);
	await withHostBootstrapLog(taskStderrPath, "launch_driver", "", () =>
		execAsync(
			`docker exec -d ${input.containerName} node '${escapeSingleQuotes(driverScriptPath)}' '${escapeSingleQuotes(driverInputPath)}'`,
		),
	);
	await appendHostBootstrapLog(
		taskStderrPath,
		"run_single_turn_driver_launched",
	);

	return {
		threadId: null,
	};
};
