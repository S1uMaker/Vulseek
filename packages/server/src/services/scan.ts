import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import type { apiCheckoutScanEnvironment } from "@vulseek/server/db/schema";
import { Queue } from "bullmq";
import { nanoid } from "nanoid";
import { getGlobalContainerEnvironmentPairs } from "../utils/docker/utils";
import {
	execAsync,
	execAsyncStream,
	execFileAsync,
} from "../utils/process/execAsync";
import { getAgentProfileById } from "./ai";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";
import { resolveDatasetTrialRuntime } from "./dataset";
import { buildTaskAgentProfileSnapshot } from "./scan/agent-profile-snapshot";
import { findCandidateTaskLineage } from "./scan/api/candidate-records";
import {
	type Analysis,
	analysisFeedbackEnvelopeSchema,
	analysisSchema,
	type CriticResponse,
	criticResponseSchema,
	type Evidence,
	type FinalAnalysis,
	finalAnalysisSchema,
	targetKindSchema,
	type Verification,
	verificationSchema,
} from "./scan/artifacts/contracts/domain-object.contract";
import {
	copyTaskJsonArtifact,
	readTaskJsonArtifact,
	writeTaskJsonArtifact,
	writeTaskTextArtifact,
} from "./scan/artifacts/task-artifact-paths";
import {
	buildCheckoutToolsStatus,
	checkoutImageMatchesCurrentTools,
	type CheckoutToolsDefinition,
	createCheckoutToolsBuildManager,
	inspectCheckoutToolsImage,
	inspectRequiredToolsImageReference,
	resolveCheckoutToolsDefinition,
	SCAN_TOOLS_IMAGE_LABEL,
	SCAN_TOOLS_VARIANT_LABEL,
	SCAN_TOOLS_VERSION_LABEL,
} from "./scan/checkout-tools";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "./scan/constants";
import {
	buildLocalCheckoutDockerfile,
	buildLocalRepositoryPopulateScript,
} from "./scan/local-checkout";
import {
	findVulnerabilityCandidateByIdAndScanJobIdRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
} from "./scan/persistence/candidate.repo";
import { findCandidateByIdWithResultsRepo } from "./scan/persistence/candidate-list.repo";
import { settleScanJobRepo } from "./scan/persistence/job-settlement.repo";
import {
	cancelScanJobRepo,
	findScanJobByIdRepo,
	listUnfinishedScanJobsRepo,
	resetScanJobForRetryRepo,
	transitionScanJobStatusRepo,
} from "./scan/persistence/scan-job.repo";
import {
	findStageGroupInstanceByIdRepo,
	findStageLaneRuntimeByTaskIdRepo,
	listStageGroupInstancesByScanJobIdRepo,
	listStageLaneRuntimesByScanJobIdRepo,
	resetStageLaneRuntimesByScanJobIdRepo,
} from "./scan/persistence/stage-lane-runtime.repo";
import {
	createTaskRepo,
	findLatestAnalysisResultByCandidateIdRepo,
	findTaskByIdRepo,
	hasActiveCandidateAnalysisTaskRepo,
	listChildTasksByParentTaskIdAndStageRepo,
	listRunningTaskViewsByScanJobIdRepo,
	listTaskStatusCountsByScanJobIdRepo,
	listTasksByScanJobAndStageRepo,
	listTasksByScanJobIdRepo,
	listTerminalTasksPageByScanJobIdRepo,
	requeueTaskRepo,
	resetFailedTaskForRetryRepo,
	transitionTaskStatusRepo,
	updateTaskRepo,
	updateTaskStatusRepo,
} from "./scan/persistence/task.repo";
import { readTaskJsonArtifactForTask } from "./scan/persistence/task-artifact-resolver";
import {
	listMessagesBySourceTaskIdRepo,
	listProcessedMessageCountsByScanJobRepo,
} from "./scan/persistence/message.repo";
import type {
	CompiledPipelineDefinition,
	CompiledStageV3,
} from "./scan/pipeline/document-v3";
import type {
	AnyStageDefinition,
	PipelineDefinition,
	PipelineEdge,
} from "./scan/pipeline/pipeline-definition";
import { createPipelineDefinition } from "./scan/pipeline/pipeline-definition";
import {
	finalizeScanJob,
	runPipeline,
	startPipelineRuntime,
	stopPipelineRuntimesForScanJob,
} from "./scan/pipeline/pipeline-runner";
import {
	loadScanPipelineDefinitions,
	normalizeLegacyVerificationSchema,
	normalizePipelineDefinitionSnapshot,
	readScanPipelineDefinitionsYaml,
	type ScanPipelineConfig,
	type ScanPipelineDefinitions,
	type ScanPipelineEdgeConfig,
	type ScanPipelineGroupConfig,
	type ScanPipelineStageConfig,
} from "./scan/pipeline/scan-pipeline-definitions";
import {
	renderPipelineTemplate,
	transformPipelineEdgeInput,
} from "./scan/pipeline/scan-pipeline-edge-transform";
import {
	createJsonSchemaContract,
	type StructuredOutputSchemaSource,
} from "./scan/pipeline/scan-pipeline-schema-contracts";
import { createStageRuntimeConfig } from "./scan/pipeline/scan-stage-runtime-config";
import { createStageQueueBinding } from "./scan/pipeline/stage-definition";
import { createDownstreamChildIdentity } from "./scan/pipeline/message-dispatch";
import {
	asWaitingMessageQueueJob,
	listAllQueueJobs,
} from "./scan/pipeline/message-queue";
import {
	collectDispatchedHuntGoalIds,
	filterNewHuntInputs,
	huntGoalDispatchKey,
	readHuntGoalId,
} from "./scan/pipeline/tob-goal-coverage";

import {
	isRetryableTaskStageName,
	retryFailedScanJobTasksWithDeps,
} from "./scan/retry-failed-tasks";
import {
	getOrchHuntRunningTaskPresentation,
	getResearchRunningTaskPresentation,
	getTobGoalRunningTaskPresentation,
	type RunningTaskStage,
} from "./scan/running-task-stage";
import {
	applyCodexRuntimeConfigToml,
	sanitizeCodexAcpConfigToml,
} from "./scan/runtime/codex-config-compat";
import { reconstructTaskInput } from "./scan/runtime/reconstruct-task-input";
import {
	persistJobAgentHomeTokenUsage,
	persistTaskAgentHomeTokenUsage,
} from "./scan/runtime/agent-home-token-usage";
import {
	listTaskFileBrowserDirectory,
	readTaskFileBrowserFile,
	TASK_BROWSER_LANE_ROOT,
	TASK_BROWSER_TASK_ROOT,
	type TaskFileBrowserRoot,
} from "./scan/runtime/task-file-browser";
import {
	buildEffectiveDisabledStageSet,
	getRuntimeStageConcurrency,
	getRuntimeStageSetting,
} from "./scan/runtime-settings";
import { SCAN_STAGE_IDS, SCAN_STAGE_METADATA } from "./scan/stage-metadata";
import { resolveStageTaskName } from "./scan/stage-task-name";
import type { PipelineContext } from "./scan/stages/full-scan-stage.runtime";
import {
	resolveScanProfileConcurrencySettingsFromTarget,
	resolveStageAgentProfile,
	resolveStageAgentProfileFromTarget,
	resolveStageConcurrencySetting,
	resolveStageLaneRootSegment,
	resolveTaskRootSegment,
	resolveTaskRuntimeDirForTask,
} from "./scan/stages/full-scan-stage.runtime";
import { createGenericAgentStageDefinition } from "./scan/stages/generic-agent.stage";
import type {
	CandidateAnalysisTaskInput,
	CandidateVerificationTaskInput,
} from "./scan/stages/generic-stage-inputs";
import { createShortTaskId } from "./scan/task-id";

import { normalizeTerminalTaskFilters } from "./scan/terminal-task-filters";
import type {
	AgentProfileLike,
	Candidate as CanonicalCandidate,
	Function as CanonicalFunction,
	Module as CanonicalModule,
	ScanJob,
	Task,
} from "./scan/types";

const PREINSTALLED_TOOL_SKILLS = [] as const;

type UnifiedModuleTaskView = {
	taskId: string;
	scanModuleTaskId: string;
	moduleId: string;
	moduleName: string;
	status: string;
	priority: number;
	attempt: number;
	errorMessage: string | null;
	startedAt: string | null;
	completedAt: string | null;
	updatedAt: string;
};

type UnifiedFunctionTaskView = {
	taskId: string;
	functionTaskId: string;
	scanModuleTaskId: string | null;
	moduleId: string;
	moduleName: string;
	functionId: string;
	functionName: string;
	filePath: string | null;
	line: number | null;
	status: string;
	priority: number;
	attempt: number;
	score: number | null;
	vulnerabilityType: string | null;
	summary: string | null;
	errorMessage: string | null;
	startedAt: string | null;
	completedAt: string | null;
	updatedAt: string;
};

type InProgressTaskView = {
	id: string;
	taskId: string;
	title: string;
	subtitle: string;
	stage: RunningTaskStage;
	startedAt: string | null;
	updatedAt: string;
};

type TerminalTaskView = InProgressTaskView & {
	status: "completed" | "failed" | "canceled" | "exited";
	completedAt: string | null;
	errorMessage: string | null;
};

type TaskListViewSource = Pick<
	Task,
	| "taskId"
	| "name"
	| "stageName"
	| "status"
	| "errorMessage"
	| "startedAt"
	| "completedAt"
	| "updatedAt"
>;

type QueuePendingCountView = {
	id: ScanStageQueueKind;
	title: string;
	stageName: Task["stageName"];
	queueName: string;
	concurrencyLimit?: number;
	waitingCount: number;
	queuedCount: number;
	queuedMessageCount: number;
	processedMessageCount: number;
	launchingCount: number;
	launchedCount: number;
	startingCount: number;
	runningCount: number;
	completedCount: number;
	failedCount: number;
	exitedCount: number;
	canceledCount: number;
	totalCount: number;
	pendingCount: number;
};

const IN_PROGRESS_TASK_STAGE_ORDER: Record<
	InProgressTaskView["stage"],
	number
> = {
	"delta-scope": 0,
	"repository-profile": 1,
	"attack-surface-model": 2,
	"identify-target": 3,
	"scan-target": 4,
	"analyze-finding": 5,
	"critique-finding": 6,
	"verify-finding": 7,
	"triage-finding": 8,
	"research-scope": 9,
	"surface-map": 10,
	"track-plan": 11,
	"vulnerability-discovery": 12,
	"track-review": 13,
	"finding-validation": 14,
	"finding-review": 15,
	"chain-synthesis": 16,
	"chain-review": 17,
	"exploit-validation": 18,
	"exploit-review": 19,
	"research-report": 20,
	"goal-craft": 21,
	"goal-surface": 22,
	"goal-hunt": 23,
	"goal-judge": 24,
	"goal-dedup": 25,
	orchestrator: 26,
	hunter: 27,
};

const compareInProgressTaskView = (
	left: InProgressTaskView,
	right: InProgressTaskView,
) => {
	const stageRankDiff =
		IN_PROGRESS_TASK_STAGE_ORDER[left.stage] -
		IN_PROGRESS_TASK_STAGE_ORDER[right.stage];
	if (stageRankDiff !== 0) {
		return stageRankDiff;
	}
	return right.updatedAt.localeCompare(left.updatedAt);
};

const compareTerminalTaskView = (
	left: TerminalTaskView,
	right: TerminalTaskView,
) => {
	const leftCompletedAt = left.completedAt || left.updatedAt;
	const rightCompletedAt = right.completedAt || right.updatedAt;
	const completedAtDiff = rightCompletedAt.localeCompare(leftCompletedAt);
	if (completedAtDiff !== 0) {
		return completedAtDiff;
	}
	return compareInProgressTaskView(left, right);
};

// Queue names are derived from validated YAML stage IDs. Keeping this as a
// string allows a new YAML stage to use the generic queue binding without a
// TypeScript union update.
type ScanStageQueueKind = string;

const buildAnalysisFingerprint = (value: unknown) =>
	crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");

const parseRedisConnection = (url?: string) => {
	if (!url) {
		return {
			host: process.env.REDIS_HOST || "vulseek-redis-dev",
			port: process.env.REDIS_PORT
				? Number.parseInt(process.env.REDIS_PORT, 10)
				: 6379,
		};
	}

	try {
		const parsed = new URL(url);
		return {
			host: parsed.hostname || "vulseek-redis-dev",
			port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
		};
	} catch {
		return {
			host: url,
			port: 6379,
		};
	}
};

const bullRedisConnection = parseRedisConnection(process.env.REDIS_URL);

const scanStageQueueCache = new Map<string, Queue<string>>();

const buildScanStageQueueName = (scanJobId: string, kind: ScanStageQueueKind) =>
	`scan:${scanJobId}:${kind}`;

const buildScanStageGroupQueueName = (
	scanJobId: string,
	groupInstanceId: string,
	kind: ScanStageQueueKind,
) => `scan:${scanJobId}:group:${groupInstanceId}:${kind}`;

const getScanStageQueue = (scanJobId: string, kind: ScanStageQueueKind) => {
	const queueName = buildScanStageQueueName(scanJobId, kind);
	const cached = scanStageQueueCache.get(queueName);
	if (cached) {
		return cached;
	}

	const queue = new Queue<string>(queueName, {
		connection: bullRedisConnection,
	});
	scanStageQueueCache.set(queueName, queue);
	return queue;
};

const getScanStageGroupQueue = (
	scanJobId: string,
	groupInstanceId: string,
	kind: ScanStageQueueKind,
) => {
	const queueName = buildScanStageGroupQueueName(
		scanJobId,
		groupInstanceId,
		kind,
	);
	const cached = scanStageQueueCache.get(queueName);
	if (cached) {
		return cached;
	}

	const queue = new Queue<string>(queueName, {
		connection: bullRedisConnection,
	});
	scanStageQueueCache.set(queueName, queue);
	return queue;
};

const obliterateScanStageGroupQueue = async (
	scanJobId: string,
	groupInstanceId: string,
	kind: ScanStageQueueKind,
) => {
	const queueName = buildScanStageGroupQueueName(
		scanJobId,
		groupInstanceId,
		kind,
	);
	const queue =
		scanStageQueueCache.get(queueName) ||
		new Queue<string>(queueName, {
			connection: bullRedisConnection,
		});
	await queue.obliterate({ force: true }).catch(() => {});
	await queue.close().catch(() => {});
	scanStageQueueCache.delete(queueName);
};

const obliterateScanStageGroupQueues = async (
	scanJobId: string,
	groupInstanceId: string,
	stageNames: string[],
) => {
	await Promise.all(
		stageNames.map((kind) =>
			obliterateScanStageGroupQueue(scanJobId, groupInstanceId, kind),
		),
	);
};

const obliterateScanStageQueue = async (
	scanJobId: string,
	kind: ScanStageQueueKind,
) => {
	const queueName = buildScanStageQueueName(scanJobId, kind);
	const queue =
		scanStageQueueCache.get(queueName) ||
		new Queue<string>(queueName, {
			connection: bullRedisConnection,
		});
	await queue.obliterate({ force: true }).catch(() => {});
	await queue.close().catch(() => {});
	scanStageQueueCache.delete(queueName);
};

const createGenericStageQueueBinding = (
	context: FullScanPipelineContext,
	stageName: string,
) => {
	return createStageQueueBinding<FullScanPipelineContext, unknown>({
		queue: getScanStageQueue(context.scanJob.scanJobId, stageName),
		getGroupQueue: (groupInstanceId) =>
			getScanStageGroupQueue(
				context.scanJob.scanJobId,
				groupInstanceId,
				stageName,
			),
		obliterateGroupQueue: (groupInstanceId) =>
			obliterateScanStageGroupQueue(
				context.scanJob.scanJobId,
				groupInstanceId,
				stageName,
			),
	});
};

const stopScanContainer = async (containerName: string | null | undefined) => {
	if (!containerName) {
		return false;
	}

	try {
		await execAsync(`docker rm -f ${containerName}`);
		return true;
	} catch {
		return false;
	}
};

const listDockerContainersForScanJob = async (scanJobId: string) => {
	const scanJobNamePart = sanitizeContainerNamePart(scanJobId);
	if (!scanJobNamePart) {
		return [];
	}
	const { stdout } = await execAsync(
		"docker ps -a --format '{{.Names}}'",
	).catch(() => ({ stdout: "" }));
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((name) => name?.includes(scanJobNamePart));
};

const cleanupScanJobCredentialFiles = async (
	scanJob: ScanJob,
	image: string | null,
) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		return false;
	}
	const { projectName, profileName } =
		await resolveScanJobTargetIdentity(scanJob);
	// This command is executed by the Docker daemon. Do not pass the
	// container-side /scan-context path as a host bind source.
	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		projectName,
		profileName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	const jobId = sanitizeContextPathPart(scanJob.scanJobId);
	const hostJobRoot = path.join(hostProfileDir, "jobs", jobId);
	const credentialExpression =
		"-type f \\( -name auth.json -o -name .credentials.json \\) -delete";

	// Prefer the host path so cleanup does not depend on a task image still
	// existing. Fall back to a root-owned container for agent-owned files.
	try {
		await execAsync(
			`find '${escapeSingleQuotes(hostJobRoot)}' ${credentialExpression}`,
		);
		return true;
	} catch {
		// The application user may not own files created in the agent container.
	}

	if (!image) return false;

	const containerJobRoot = path.posix.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"jobs",
		jobId,
	);
	await execAsync(
		`docker run --rm --user 0 -v '${escapeSingleQuotes(hostProfileDir)}':${CONTAINER_SCAN_CONTEXT_ROOT}:rw '${escapeSingleQuotes(image)}' sh -lc 'find "${containerJobRoot}" ${credentialExpression}'`,
	);
	return true;
};

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const asTaskRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const readString = (
	record: Record<string, unknown> | null,
	key: string,
): string | null => {
	const value = record?.[key];
	return typeof value === "string" ? value : null;
};

const readNumber = (
	record: Record<string, unknown> | null,
	key: string,
): number | null => {
	const value = record?.[key];
	return typeof value === "number" ? value : null;
};

const readModuleTaskView = (task: Task): UnifiedModuleTaskView | null => {
	if (task.stageName !== SCAN_STAGE_IDS.identifyTarget) {
		return null;
	}
	const input = asTaskRecord(null);
	const module = asTaskRecord(input?.module);
	const moduleId =
		readString(input, "moduleId") || readString(module, "moduleId");
	const moduleName =
		readString(input, "moduleName") || readString(module, "name");
	if (!moduleId && !moduleName) {
		return null;
	}
	return {
		taskId: task.taskId,
		scanModuleTaskId: task.taskId,
		moduleId: moduleId || task.taskId,
		moduleName: moduleName || task.name,
		status: task.status,
		priority: task.priority ?? 0,
		attempt: task.attempt,
		errorMessage: task.errorMessage ?? null,
		startedAt: task.startedAt ?? null,
		completedAt: task.completedAt ?? null,
		updatedAt: task.updatedAt,
	};
};

const readFunctionTaskView = (task: Task): UnifiedFunctionTaskView | null => {
	if (task.stageName !== SCAN_STAGE_IDS.scanTarget) {
		return null;
	}
	const input = asTaskRecord(null);
	const func = asTaskRecord(input?.function);
	const target = asTaskRecord(input?.target);
	const functionId =
		readString(input, "targetId") ||
		readString(target, "targetId") ||
		readString(input, "functionId") ||
		readString(func, "functionId");
	const functionName =
		readString(input, "targetName") ||
		readString(target, "targetName") ||
		readString(input, "functionName") ||
		readString(func, "functionName");
	if (!functionId && !functionName) {
		return null;
	}
	const module = asTaskRecord(input?.module);
	return {
		taskId: task.taskId,
		functionTaskId: task.taskId,
		scanModuleTaskId: task.sourceMessageId ?? null,
		moduleId:
			readString(input, "moduleId") ||
			readString(target, "moduleId") ||
			readString(func, "moduleId") ||
			readString(module, "moduleId") ||
			task.sourceMessageId ||
			task.taskId,
		moduleName:
			readString(input, "moduleName") ||
			readString(target, "moduleName") ||
			readString(func, "moduleName") ||
			readString(module, "name") ||
			"Module",
		functionId: functionId || task.taskId,
		functionName: functionName || task.name,
		filePath:
			readString(input, "filePath") ||
			readString(target, "filePath") ||
			readString(func, "filePath"),
		line:
			readNumber(input, "line") ??
			readNumber(target, "line") ??
			readNumber(func, "line"),
		status: task.status,
		priority: task.priority ?? 0,
		attempt: task.attempt,
		score: readNumber(input, "score") ?? readNumber(func, "score"),
		vulnerabilityType:
			readString(input, "vulnerabilityClassFocus") ||
			readString(input, "vulnerabilityType") ||
			readString(func, "vulnerabilityType") ||
			readString(func, "riskType") ||
			readString(input, "targetKind") ||
			readString(target, "targetKind"),
		summary: readString(input, "summary") || readString(func, "summary"),
		errorMessage: task.errorMessage ?? null,
		startedAt: task.startedAt ?? null,
		completedAt: task.completedAt ?? null,
		updatedAt: task.updatedAt,
	};
};

const listUnifiedModuleTaskViewsByScanJobId = async (scanJobId: string) =>
	(
		await listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName: SCAN_STAGE_IDS.identifyTarget,
		})
	)
		.map(readModuleTaskView)
		.filter((task): task is UnifiedModuleTaskView => Boolean(task));

const listUnifiedFunctionTaskViewsByScanJobId = async (scanJobId: string) =>
	(
		await listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName: SCAN_STAGE_IDS.scanTarget,
		})
	)
		.map(readFunctionTaskView)
		.filter((task): task is UnifiedFunctionTaskView => Boolean(task));

const listUnifiedFunctionTaskViewsByModuleTaskId = async (
	moduleTaskId: string,
) =>
	(
		await listChildTasksByParentTaskIdAndStageRepo({
			parentTaskId: moduleTaskId,
			stageName: SCAN_STAGE_IDS.scanTarget,
		})
	)
		.map(readFunctionTaskView)
		.filter((task): task is UnifiedFunctionTaskView => Boolean(task));

const formatTaskLocation = (filePath: string | null, line: number | null) => {
	if (!filePath) {
		return null;
	}
	return typeof line === "number" ? `${filePath}:${line}` : filePath;
};

const joinTaskSubtitle = (...parts: Array<string | null | undefined>) =>
	parts
		.filter((part): part is string => Boolean(part && part.length > 0))
		.join(" · ");

const readCandidateRecordFromTaskInput = (
	task: TaskListViewSource,
): Record<string, unknown> | null => {
	const input = asTaskRecord(null);
	if (task.stageName === SCAN_STAGE_IDS.analyzeFinding) {
		return asTaskRecord(input?.candidate);
	}
	if (task.stageName === SCAN_STAGE_IDS.critiqueFinding) {
		return asTaskRecord(input?.candidate);
	}
	if (task.stageName === SCAN_STAGE_IDS.verifyFinding) {
		return asTaskRecord(asTaskRecord(input?.analysisResult)?.candidate);
	}
	if (task.stageName === SCAN_STAGE_IDS.triageFinding) {
		return asTaskRecord(input?.candidate);
	}
	return null;
};

const buildInProgressTaskView = (
	task: TaskListViewSource,
): InProgressTaskView | null => {
	const input = asTaskRecord(null);
	const researchPresentation = getResearchRunningTaskPresentation(
		task.stageName,
		task.name,
	);
	if (researchPresentation) {
		return {
			id: `${researchPresentation.stage}-${task.taskId}`,
			taskId: task.taskId,
			...researchPresentation,
			startedAt: task.startedAt,
			updatedAt: task.updatedAt,
		};
	}
	const orchHuntPresentation = getOrchHuntRunningTaskPresentation(
		task.stageName,
		task.name,
	);
	if (orchHuntPresentation) {
		return {
			id: `${orchHuntPresentation.stage}-${task.taskId}`,
			taskId: task.taskId,
			...orchHuntPresentation,
			startedAt: task.startedAt,
			updatedAt: task.updatedAt,
		};
	}
	const tobGoalPresentation = getTobGoalRunningTaskPresentation(
		task.stageName,
		task.name,
	);
	if (tobGoalPresentation) {
		return {
			id: `${tobGoalPresentation.stage}-${task.taskId}`,
			taskId: task.taskId,
			...tobGoalPresentation,
			startedAt: task.startedAt,
			updatedAt: task.updatedAt,
		};
	}
	switch (task.stageName) {
		case SCAN_STAGE_IDS.deltaScope:
			return {
				id: `delta-scope-${task.taskId}`,
				taskId: task.taskId,
				title: "Delta Scope",
				subtitle: "Diff impact function scoping",
				stage: "delta-scope",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		case SCAN_STAGE_IDS.repositoryProfile:
			return {
				id: `repository-${task.taskId}`,
				taskId: task.taskId,
				title: "Repository Scanner",
				subtitle: "Repository-wide planner and module partitioning",
				stage: "repository-profile",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		case SCAN_STAGE_IDS.attackSurfaceModel:
			return {
				id: `attack-surface-model-${task.taskId}`,
				taskId: task.taskId,
				title: readString(input, "moduleName") || task.name,
				subtitle: readString(input, "moduleId") || "-",
				stage: "attack-surface-model",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		case SCAN_STAGE_IDS.identifyTarget: {
			const module = asTaskRecord(input?.module);
			return {
				id: `module-${task.taskId}`,
				taskId: task.taskId,
				title:
					readString(input, "moduleName") ||
					readString(module, "name") ||
					task.name,
				subtitle:
					readString(input, "moduleId") ||
					readString(module, "moduleId") ||
					"-",
				stage: "identify-target",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.scanTarget: {
			const func = asTaskRecord(input?.function);
			const target = asTaskRecord(input?.target);
			const module = asTaskRecord(input?.module);
			return {
				id: `function-${task.taskId}`,
				taskId: task.taskId,
				title:
					readString(input, "targetName") ||
					readString(input, "targetId") ||
					readString(target, "targetName") ||
					readString(target, "targetId") ||
					readString(input, "functionName") ||
					readString(input, "functionId") ||
					readString(func, "functionName") ||
					readString(func, "functionId") ||
					task.name,
				subtitle:
					joinTaskSubtitle(
						readString(input, "moduleName") ||
							readString(module, "name") ||
							readString(target, "moduleName") ||
							readString(func, "moduleName"),
						formatTaskLocation(
							readString(input, "filePath") ||
								readString(target, "filePath") ||
								readString(func, "filePath"),
							readNumber(input, "line") ??
								readNumber(target, "line") ??
								readNumber(func, "line"),
						),
					) || "-",
				stage: "scan-target",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.analyzeFinding: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `analyze-finding-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "analyze-finding",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.critiqueFinding: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `critique-finding-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "critique-finding",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.verifyFinding: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `verify-finding-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "verify-finding",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.triageFinding: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `triage-finding-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "triage-finding",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		default:
			return null;
	}
};

const buildTerminalTaskView = (
	task: TaskListViewSource,
): TerminalTaskView | null => {
	const status = task.status as string;
	if (
		status !== "completed" &&
		status !== "failed" &&
		status !== "canceled" &&
		status !== "exited"
	) {
		return null;
	}
	const baseTask = buildInProgressTaskView(task);
	if (!baseTask) {
		return null;
	}
	return {
		...baseTask,
		title: task.name || baseTask.title,
		status: status as TerminalTaskView["status"],
		completedAt: task.completedAt,
		errorMessage: task.errorMessage,
	};
};

const listQueuePendingCountsByScanJobId = async (
	scanJobId: string,
	taskStatusCounts: Array<{
		stageName: Task["stageName"];
		status: Task["status"];
		count: number;
	}>,
	concurrencyLimitByStageName = new Map<Task["stageName"], number>(),
	stageNames?: Array<string>,
	stageTitles = new Map<string, string>(),
): Promise<QueuePendingCountView[]> => {
	const stageNamesToRead = stageNames ?? Object.values(SCAN_STAGE_IDS);
	const queueEntries: Array<{
		id: ScanStageQueueKind;
		title: string;
		stageName: Task["stageName"];
		queue: Queue<string>;
	}> = stageNamesToRead.map((stageName) => {
		const metadata = Object.values(SCAN_STAGE_METADATA).find(
			(stage) => stage.id === stageName,
		);
		return {
			id: stageName,
			title: metadata?.name ?? stageTitles.get(stageName) ?? stageName,
			stageName,
			queue: getScanStageQueue(scanJobId, stageName),
		};
	});

	const processedMessageCountByStage =
		await listProcessedMessageCountsByScanJobRepo(scanJobId);
	return await Promise.all(
		queueEntries.map(async ({ id, title, stageName, queue }) => {
			const stageCounts = taskStatusCounts.filter(
				(row) => row.stageName === stageName,
			);
			const getStatusCount = (status: Task["status"]) =>
				stageCounts.find((row) => row.status === status)?.count ?? 0;
			const waitingJobs = await listAllQueueJobs(queue, [
				"wait",
				"paused",
				"prioritized",
			]).catch(() => []);
			const queuedMessageCount = waitingJobs.filter((job) =>
				Boolean(asWaitingMessageQueueJob((job as { data?: unknown }).data)),
			).length;
			const launchingCount = getStatusCount("launching");
			const launchedCount = getStatusCount("launched");
			const startingCount = getStatusCount("starting");
			const processedMessageCount =
				processedMessageCountByStage.get(stageName) ?? 0;
			return {
				id,
				title,
				stageName,
				queueName: queue.name,
				...(concurrencyLimitByStageName.size > 0
					? {
							concurrencyLimit: Math.max(
								1,
								concurrencyLimitByStageName.get(stageName) ?? 1,
							),
						}
					: {}),
				waitingCount: queuedMessageCount,
				queuedCount: queuedMessageCount,
				queuedMessageCount,
				processedMessageCount,
				launchingCount,
				launchedCount,
				startingCount,
				runningCount: getStatusCount("running"),
				completedCount: getStatusCount("completed"),
				failedCount: getStatusCount("failed"),
				exitedCount: getStatusCount("exited"),
				canceledCount: getStatusCount("canceled"),
				totalCount: stageCounts.reduce((total, row) => total + row.count, 0),
				pendingCount: queuedMessageCount,
			};
		}),
	);
};

export const retryFailedScanJobTasks = async (scanJobId: string) =>
	await retryFailedScanJobTasksWithDeps(scanJobId, {
		loadScanJob: findScanJobByIdRepo,
		listTasks: listTasksByScanJobIdRepo,
		clearTaskArtifacts: clearTaskArtifactsForRetry,
		resetFailedTask: resetFailedTaskForRetryRepo,
		resetScanJobForRetry: async (input) =>
			await resetScanJobForRetryRepo(input.scanJobId, {
				status: "pending",
				errorMessage: null,
			}),
	});

const RERUNNABLE_TASK_STATUSES = new Set<Task["status"]>([
	"completed",
	"failed",
	"exited",
	"canceled",
]);

const RERUNNABLE_TASK_STAGE_NAMES = new Set<Task["stageName"]>([
	SCAN_STAGE_IDS.deltaScope,
	SCAN_STAGE_IDS.repositoryProfile,
	SCAN_STAGE_IDS.identifyTarget,
	SCAN_STAGE_IDS.scanTarget,
	SCAN_STAGE_IDS.analyzeFinding,
	SCAN_STAGE_IDS.critiqueFinding,
	SCAN_STAGE_IDS.verifyFinding,
	SCAN_STAGE_IDS.triageFinding,
]);

const getTaskHostDir = (input: {
	projectProfileHostContextRoot: string;
	task: Task;
}) =>
	path.join(
		input.projectProfileHostContextRoot,
		"jobs",
		input.task.scanJobId,
		resolveTaskRootSegment(
			input.task.stageName,
			input.task.name,
			input.task.taskId,
		),
	);

const taskHasInputsDir = async (taskDir: string) => {
	const stat = await fs.stat(path.join(taskDir, "inputs")).catch(() => null);
	return stat?.isDirectory() ?? false;
};

const getRerunBaseTaskName = (name: string) =>
	name.replace(/(?: \(rerun\))+$/, "");

const findRerunSourceTaskWithInputs = async (input: {
	projectProfileHostContextRoot: string;
	originalTask: Task;
}) => {
	const originalTaskDir = getTaskHostDir({
		projectProfileHostContextRoot: input.projectProfileHostContextRoot,
		task: input.originalTask,
	});
	if (await taskHasInputsDir(originalTaskDir)) {
		return input.originalTask;
	}

	const baseName = getRerunBaseTaskName(input.originalTask.name);
	const tasks = await listTasksByScanJobIdRepo(input.originalTask.scanJobId);
	for (const task of tasks) {
		if (task.taskId === input.originalTask.taskId) {
			continue;
		}
		if (task.stageName !== input.originalTask.stageName) {
			continue;
		}
		if (task.sourceMessageId !== input.originalTask.sourceMessageId) {
			continue;
		}
		if (getRerunBaseTaskName(task.name) !== baseName) {
			continue;
		}
		if (task.createdAt > input.originalTask.createdAt) {
			continue;
		}

		const taskDir = getTaskHostDir({
			projectProfileHostContextRoot: input.projectProfileHostContextRoot,
			task,
		});
		if (await taskHasInputsDir(taskDir)) {
			return task;
		}
	}

	return null;
};

const copyTaskInputsForRerun = async (input: {
	scanJob: Awaited<ReturnType<typeof findScanJobByIdRepo>>;
	originalTask: Task;
	rerunTask: Task;
}) => {
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(input.scanJob);
	const sourceTask = await findRerunSourceTaskWithInputs({
		projectProfileHostContextRoot,
		originalTask: input.originalTask,
	});
	if (!sourceTask) {
		return;
	}

	const sourceTaskDir = getTaskHostDir({
		projectProfileHostContextRoot,
		task: sourceTask,
	});
	const rerunTaskDir = getTaskHostDir({
		projectProfileHostContextRoot,
		task: input.rerunTask,
	});
	const sourceInputsDir = path.join(sourceTaskDir, "inputs");
	const rerunInputsDir = path.join(rerunTaskDir, "inputs");

	await fs.rm(rerunInputsDir, { recursive: true, force: true }).catch(() => {});
	await fs.mkdir(rerunTaskDir, { recursive: true });
	await fs.cp(sourceInputsDir, rerunInputsDir, {
		recursive: true,
		force: true,
	});
};

export const rerunScanTask = async (taskId: string) => {
	const originalTask = await findTaskByIdRepo(taskId);
	const scanJob = await findScanJobByIdRepo(originalTask.scanJobId);
	if (scanJob.status === "finalizing") {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Scan job is finalizing and cannot accept reruns",
		});
	}
	if (!RERUNNABLE_TASK_STATUSES.has(originalTask.status)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Only completed, failed, exited, or canceled tasks can be rerun",
		});
	}
	if (!RERUNNABLE_TASK_STAGE_NAMES.has(originalTask.stageName)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Task stage is not rerunnable: ${originalTask.stageName}`,
		});
	}
	if (
		scanJob.status === "finished" ||
		scanJob.status === "partially_finished" ||
		scanJob.status === "failed" ||
		scanJob.status === "canceled"
	) {
		await resetScanJobForRetryRepo(scanJob.scanJobId, {
			status: "pending",
			errorMessage: null,
		});
	}

	const task = await createTaskRepo({
		taskId: createShortTaskId(),
		scanJobId: originalTask.scanJobId,
		name: `${originalTask.name} (rerun)`,
		stageName: originalTask.stageName,
		lifecycle: originalTask.lifecycle,
		sourceMessageId: originalTask.sourceMessageId,
		sourceEdgeName: originalTask.sourceEdgeName,
		sourceItemIndex: originalTask.sourceItemIndex,
		rerunOfTaskId: originalTask.taskId,
		priority: originalTask.priority,
		runtimeMode: originalTask.runtimeMode,
		forkedFromTaskId: originalTask.forkedFromTaskId,
		allowedJobStatuses: ["pending", "running"],
	});

	await copyTaskInputsForRerun({ scanJob, originalTask, rerunTask: task });
	return {
		originalTaskId: originalTask.taskId,
		task,
	};
};

const toGitUrl = (
	provider: "github" | "gitlab" | "bitbucket" | "gitea",
	owner: string,
	repository: string,
	giteaHost?: string | null,
) => {
	const cleanedRepo = repository.replace(/\.git$/, "");
	if (cleanedRepo.includes("/")) {
		if (provider === "github") return `https://github.com/${cleanedRepo}.git`;
		if (provider === "gitlab") return `https://gitlab.com/${cleanedRepo}.git`;
		if (provider === "bitbucket")
			return `https://bitbucket.org/${cleanedRepo}.git`;
		return `https://${giteaHost || "gitea.local"}/${cleanedRepo}.git`;
	}
	if (provider === "github")
		return `https://github.com/${owner}/${cleanedRepo}.git`;
	if (provider === "gitlab")
		return `https://gitlab.com/${owner}/${cleanedRepo}.git`;
	if (provider === "bitbucket")
		return `https://bitbucket.org/${owner}/${cleanedRepo}.git`;
	return `https://${giteaHost || "gitea.local"}/${owner}/${cleanedRepo}.git`;
};

const isUrlLike = (value?: string | null) =>
	Boolean(value && /^(https?:\/\/|git@)/.test(value));

const resolveDockerfileAssetPath = async (fileName: string) => {
	const candidates = [
		path.resolve(
			process.cwd(),
			"packages/server/src/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"packages/server/dist/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"../../packages/server/src/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"../../packages/server/dist/services/dockerfiles",
			fileName,
		),
		path.join("/app/packages/server/src/services/dockerfiles", fileName),
		path.resolve(
			process.cwd(),
			"node_modules/@vulseek/server/src/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"node_modules/@vulseek/server/dist/services/dockerfiles",
			fileName,
		),
		path.join(
			"/app/node_modules/@vulseek/server/src/services/dockerfiles",
			fileName,
		),
		path.join(
			"/app/node_modules/@vulseek/server/dist/services/dockerfiles",
			fileName,
		),
	];

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile()) {
				return candidate;
			}
		} catch {}
	}

	throw new Error(`Unable to locate ${fileName}`);
};

const resolveScanDockerfileTemplatePath = async () => {
	return await resolveDockerfileAssetPath("Dockerfile.scan-checkout.template");
};

const buildScanDockerfileTemplate = async () => {
	const templatePath = await resolveScanDockerfileTemplatePath();
	return await fs.readFile(templatePath, "utf-8");
};

/** Resolve the current tools image without exposing checkout implementation details. */
export const resolveCurrentCheckoutToolsImage = async () =>
	(await resolveCheckoutToolsDefinition()).imageTag;

type CheckoutStatus = "running" | "completed" | "failed";

type CheckoutTask = {
	checkoutId: string;
	status: CheckoutStatus;
	phase: "waiting_tools" | "building_checkout";
	imageTag: string;
	toolsVersion: string;
	toolsVariant: CheckoutToolsDefinition["variant"];
	toolsImageTag: string;
	toolsBuildId: string | null;
	gitUrl: string;
	gitBranch: string;
	gitTag: string;
	enableSubmodules: boolean;
	postCheckoutScript: string;
	dockerfileTemplate: string;
	localPath?: string | null;
	stdout: string;
	stderr: string;
	errorMessage?: string;
	startedAt: string;
	finishedAt?: string;
	applicationId?: string;
	composeId?: string;
};

const checkoutTasks = new Map<string, CheckoutTask>();
const MAX_LOG_CHARS = 400_000;

const appendLog = (base: string, chunk: string) => {
	const combined = `${base}${chunk}`;
	if (combined.length <= MAX_LOG_CHARS) return combined;
	return combined.slice(combined.length - MAX_LOG_CHARS);
};

const resolveCheckoutDockerBuildResourceOptions = () => {
	const dockerBuildkit = process.env.DOCKER_BUILDKIT?.trim() || "1";
	const memory = process.env.VULSEEK_SCAN_CHECKOUT_BUILD_MEMORY?.trim() || "";
	const memorySwap =
		process.env.VULSEEK_SCAN_CHECKOUT_BUILD_MEMORY_SWAP?.trim() || "";
	const env = {
		...process.env,
		DOCKER_BUILDKIT: dockerBuildkit,
	};

	if (!memory || dockerBuildkit !== "0") {
		const logMessage =
			memory && dockerBuildkit !== "0"
				? `[checkout] memory limit requested but ignored because DOCKER_BUILDKIT=${dockerBuildkit || "<unset>"}; set DOCKER_BUILDKIT=0 to use --memory with the legacy docker builder\n`
				: null;
		return {
			args: [] as string[],
			env,
			logMessage,
		};
	}

	const args = ["--memory", memory];
	if (memorySwap) {
		args.push("--memory-swap", memorySwap);
	}

	return {
		args,
		env,
		logMessage:
			`[checkout] using DOCKER_BUILDKIT=0 with memory limit ${memory}` +
			(memorySwap ? ` and memory-swap ${memorySwap}` : "") +
			"\n",
	};
};

const executeCheckoutToolsBuild = async (input: {
	definition: CheckoutToolsDefinition;
	builtAt: string;
	appendStdout: (chunk: string) => void;
	appendStderr: (chunk: string) => void;
}) => {
	const assets = await resolveCheckoutToolsDefinition();
	if (assets.version !== input.definition.version) {
		throw new Error("Checkout tools definition changed before build started");
	}
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "vulseek-scan-tools-"),
	);
	const dockerfilePath = path.join(tempDir, "Dockerfile.scan-tools");
	try {
		await Promise.all([
			fs.writeFile(dockerfilePath, assets.dockerfile, "utf8"),
			fs.copyFile(
				assets.codexAcpPatchPath,
				path.join(tempDir, "codex-acp-fork-1.3.0.patch"),
			),
			fs.copyFile(
				assets.acpDriverPath,
				path.join(tempDir, "vulseek-acp-driver.mjs"),
			),
			fs.copyFile(
				assets.agentEventsPath,
				path.join(tempDir, "agent-events.mjs"),
			),
		]);
		const args = [
			"build",
			"--progress=plain",
			"-f",
			dockerfilePath,
			"-t",
			input.definition.imageTag,
			"--build-arg",
			`VULSEEK_TOOLS_VERSION=${input.definition.version}`,
			"--build-arg",
			`VULSEEK_TOOLS_BUILT_AT=${input.builtAt}`,
			"--build-arg",
			`VULSEEK_TOOLS_VARIANT=${input.definition.variant}`,
		];
		for (const pair of getGlobalContainerEnvironmentPairs()) {
			args.push("--build-arg", pair);
		}
		args.push(tempDir);
		input.appendStderr(
			`[tools] building ${input.definition.imageTag} with BuildKit cache enabled\n`,
		);
		await new Promise<void>((resolve, reject) => {
			const child = spawn("docker", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, DOCKER_BUILDKIT: "1" },
			});
			child.stdout.on("data", (chunk) => input.appendStdout(chunk.toString()));
			child.stderr.on("data", (chunk) => input.appendStderr(chunk.toString()));
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`docker tools build failed with code ${code}`));
			});
		});
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
};

const checkoutToolsBuildManager = createCheckoutToolsBuildManager({
	resolveDefinition: resolveCheckoutToolsDefinition,
	inspectImage: inspectCheckoutToolsImage,
	executeBuild: executeCheckoutToolsBuild,
});

export const findCheckoutToolsStatus = async (canRebuild = false) => {
	const definition = await resolveCheckoutToolsDefinition();
	const [image, activeBuild, latestBuild] = await Promise.all([
		inspectCheckoutToolsImage(definition),
		Promise.resolve(checkoutToolsBuildManager.findActiveBuild()),
		Promise.resolve(checkoutToolsBuildManager.findLatestBuild()),
	]);
	return buildCheckoutToolsStatus({
		definition,
		image,
		activeBuild:
			activeBuild?.version === definition.version ? activeBuild : null,
		latestBuild:
			latestBuild?.version === definition.version ? latestBuild : null,
		canRebuild,
	});
};

export const startCheckoutToolsBuild = async () =>
	await checkoutToolsBuildManager.startBuild();

export const findCheckoutToolsBuildStatus = (buildId: string) =>
	checkoutToolsBuildManager.findBuild(buildId);

const sanitizeForImageTag = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "scan";

export const resolveScanGitRepositoryContext = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	let gitUrl = "<GIT_URL>";
	let gitBranch = "<GIT_BRANCH>";
	let gitTag = "";
	let enableSubmodules = false;
	let postCheckoutScript = "";
	let imageNameSeed = "scan";
	let localPath: string | null = null;

	if (input.applicationId) {
		const application = await findApplicationById(input.applicationId);
		imageNameSeed =
			application.appName || application.name || application.applicationId;
		enableSubmodules = application.enableSubmodules ?? false;
		postCheckoutScript = application.postCheckoutScript || "";
		gitTag = application.targetTag?.trim() || "";
		switch (application.sourceType) {
			case "git":
				gitUrl = application.customGitUrl || "<GIT_URL>";
				gitBranch = application.customGitBranch || "main";
				break;
			case "github":
				gitUrl =
					(isUrlLike(application.repository)
						? application.repository
						: undefined) ||
					(application.owner && application.repository
						? toGitUrl("github", application.owner, application.repository)
						: "<GIT_URL>");
				gitBranch = application.branch || "main";
				break;
			case "gitlab":
				gitUrl =
					(isUrlLike(application.gitlabRepository)
						? application.gitlabRepository
						: undefined) ||
					(application.gitlabOwner && application.gitlabRepository
						? toGitUrl(
								"gitlab",
								application.gitlabOwner,
								application.gitlabRepository,
							)
						: "<GIT_URL>");
				gitBranch = application.gitlabBranch || "main";
				break;
			case "bitbucket":
				gitUrl =
					(isUrlLike(application.bitbucketRepository)
						? application.bitbucketRepository
						: undefined) ||
					(application.bitbucketOwner && application.bitbucketRepository
						? toGitUrl(
								"bitbucket",
								application.bitbucketOwner,
								application.bitbucketRepository,
							)
						: "<GIT_URL>");
				gitBranch = application.bitbucketBranch || "main";
				break;
			case "gitea":
				gitUrl =
					(isUrlLike(application.giteaRepository)
						? application.giteaRepository
						: undefined) ||
					(application.giteaOwner && application.giteaRepository
						? toGitUrl(
								"gitea",
								application.giteaOwner,
								application.giteaRepository,
								application.gitea?.giteaUrl || null,
							)
						: "<GIT_URL>");
				gitBranch = application.giteaBranch || "main";
				break;
			case "local":
				localPath = application.localPath || null;
				gitUrl = "";
				gitBranch = "";
				break;
			default:
				gitUrl = "<GIT_URL>";
				gitBranch = "main";
		}
	}

	if (input.composeId) {
		const compose = await findComposeById(input.composeId);
		imageNameSeed = compose.appName || compose.name || compose.composeId;
		enableSubmodules = compose.enableSubmodules ?? false;
		switch (compose.sourceType) {
			case "git":
				gitUrl = compose.customGitUrl || "<GIT_URL>";
				gitBranch = compose.customGitBranch || "main";
				break;
			case "github":
				gitUrl =
					(isUrlLike(compose.repository) ? compose.repository : undefined) ||
					(compose.owner && compose.repository
						? toGitUrl("github", compose.owner, compose.repository)
						: "<GIT_URL>");
				gitBranch = compose.branch || "main";
				break;
			case "gitlab":
				gitUrl =
					(isUrlLike(compose.gitlabRepository)
						? compose.gitlabRepository
						: undefined) ||
					(compose.gitlabOwner && compose.gitlabRepository
						? toGitUrl("gitlab", compose.gitlabOwner, compose.gitlabRepository)
						: "<GIT_URL>");
				gitBranch = compose.gitlabBranch || "main";
				break;
			case "bitbucket":
				gitUrl =
					(isUrlLike(compose.bitbucketRepository)
						? compose.bitbucketRepository
						: undefined) ||
					(compose.bitbucketOwner && compose.bitbucketRepository
						? toGitUrl(
								"bitbucket",
								compose.bitbucketOwner,
								compose.bitbucketRepository,
							)
						: "<GIT_URL>");
				gitBranch = compose.bitbucketBranch || "main";
				break;
			case "gitea":
				gitUrl =
					(isUrlLike(compose.giteaRepository)
						? compose.giteaRepository
						: undefined) ||
					(compose.giteaOwner && compose.giteaRepository
						? toGitUrl(
								"gitea",
								compose.giteaOwner,
								compose.giteaRepository,
								compose.gitea?.giteaUrl || null,
							)
						: "<GIT_URL>");
				gitBranch = compose.giteaBranch || "main";
				break;
			default:
				gitUrl = "<GIT_URL>";
				gitBranch = "main";
		}
	}

	return {
		imageNameSeed,
		gitUrl,
		gitBranch,
		gitTag,
		enableSubmodules,
		postCheckoutScript,
		localPath,
	};
};

const resolveCheckoutContext = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const [dockerfileTemplate, tools] = await Promise.all([
		buildScanDockerfileTemplate(),
		resolveCheckoutToolsDefinition(),
	]);
	const {
		imageNameSeed,
		gitUrl,
		gitBranch,
		gitTag,
		enableSubmodules,
		postCheckoutScript,
		localPath,
	} = await resolveScanGitRepositoryContext(input);

	const imageTag = `vulseek-scan-${sanitizeForImageTag(imageNameSeed)}:latest`;
	return {
		imageTag,
		gitUrl,
		gitBranch,
		gitTag,
		enableSubmodules,
		postCheckoutScript,
		localPath,
		dockerfileTemplate,
		toolsVersion: tools.version,
		toolsVariant: tools.variant,
		toolsImageTag: tools.imageTag,
	};
};

const runDockerBuildInBackground = async (task: CheckoutTask) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "vulseek-scan-checkout-"),
	);
	const dockerfilePath = path.join(tempDir, "Dockerfile.scan");
	const isLocalPath = !!task.localPath;
	const args = [
		"build",
		"--progress=plain",
		"-f",
		dockerfilePath,
		"-t",
		task.imageTag,
		"--build-arg",
		`VULSEEK_TOOLS_IMAGE=${task.toolsImageTag}`,
		...(isLocalPath
			? []
			: [
					"--build-arg",
					`GIT_URL=${task.gitUrl}`,
					"--build-arg",
					`GIT_BRANCH=${task.gitBranch}`,
					"--build-arg",
					`GIT_TAG=${task.gitTag}`,
					"--build-arg",
					`ENABLE_SUBMODULES=${task.enableSubmodules ? "true" : "false"}`,
					"--build-arg",
					`POST_CHECKOUT_SCRIPT=${task.postCheckoutScript}`,
				]),
	];
	const containerBuildArgs = getGlobalContainerEnvironmentPairs();
	for (const pair of containerBuildArgs) {
		args.push("--build-arg", pair);
	}
	args.push(
		"--label",
		`${SCAN_TOOLS_VERSION_LABEL}=${task.toolsVersion}`,
		"--label",
		`${SCAN_TOOLS_VARIANT_LABEL}=${task.toolsVariant}`,
		"--label",
		`${SCAN_TOOLS_IMAGE_LABEL}=${task.toolsImageTag}`,
	);
	args.push(tempDir);

	try {
		const toolsDefinition = {
			version: task.toolsVersion,
			variant: task.toolsVariant,
			imageTag: task.toolsImageTag,
		};
		const existingToolsImage = await inspectCheckoutToolsImage(toolsDefinition);
		if (!existingToolsImage) {
			throw new Error(
				`Checkout tools image ${task.toolsImageTag} is not available; build the tools image before checkout`,
			);
		}
		task.phase = "building_checkout";
		const buildResourceOptions = resolveCheckoutDockerBuildResourceOptions();
		if (task.postCheckoutScript.trim()) {
			const latest = checkoutTasks.get(task.checkoutId);
			if (latest) {
				latest.stderr = appendLog(
					latest.stderr,
					"[checkout] post-checkout script configured\n",
				);
			}
		}
		if (buildResourceOptions.args.length > 0) {
			args.splice(args.length - 1, 0, ...buildResourceOptions.args);
			const latest = checkoutTasks.get(task.checkoutId);
			if (latest && buildResourceOptions.logMessage) {
				latest.stderr = appendLog(
					latest.stderr,
					buildResourceOptions.logMessage,
				);
			}
		}
		let dockerfileContent = task.dockerfileTemplate;
		if (isLocalPath) {
			dockerfileContent = buildLocalCheckoutDockerfile(dockerfileContent);
		}
		await fs.writeFile(dockerfilePath, dockerfileContent, "utf-8");
		await new Promise<void>((resolve, reject) => {
			const child = spawn("docker", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: buildResourceOptions.env,
			});
			child.stdout.on("data", (chunk) => {
				const text = chunk.toString();
				const latestTask = checkoutTasks.get(task.checkoutId);
				if (!latestTask) return;
				latestTask.stdout = appendLog(latestTask.stdout, text);
			});
			child.stderr.on("data", (chunk) => {
				const text = chunk.toString();
				const latestTask = checkoutTasks.get(task.checkoutId);
				if (!latestTask) return;
				latestTask.stderr = appendLog(latestTask.stderr, text);
			});
			child.on("error", (error) => reject(error));
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(`docker build failed with code ${code}`));
			});
		});

		if (task.localPath) {
			// Populate /workspace/repo from host path via docker run.
			// The host Docker daemon can bind-mount host paths directly.
			const tempName = `vulseek-local-${task.checkoutId.replace(/[^a-z0-9]/g, "-").slice(0, 40)}`;
			const appendToTask = (text: string) => {
				const t = checkoutTasks.get(task.checkoutId);
				if (t) t.stderr = appendLog(t.stderr, text);
			};
			appendToTask(
				"[checkout] copying local repo into image via docker run...\n",
			);
			try {
				const populateScript = buildLocalRepositoryPopulateScript();
				await execAsyncStream(
					[
						"docker run",
						`--name '${escapeSingleQuotes(tempName)}'`,
						`-v '${escapeSingleQuotes(task.localPath)}:/tmp/localrepo:ro'`,
						`-e 'POST_CHECKOUT_SCRIPT=${escapeSingleQuotes(task.postCheckoutScript)}'`,
						`'${escapeSingleQuotes(task.imageTag)}'`,
						"bash -lc",
						`'${escapeSingleQuotes(populateScript)}'`,
					].join(" "),
					appendToTask,
				);
				appendToTask("[checkout] committing image...\n");
				await execAsyncStream(
					`docker commit ${tempName} ${task.imageTag}`,
					appendToTask,
				);
			} finally {
				await execAsync(`docker rm -f ${tempName}`).catch(() => {});
			}
		}

		const latest = checkoutTasks.get(task.checkoutId);
		if (latest) {
			latest.status = "completed";
			latest.finishedAt = new Date().toISOString();
		}
	} catch (error) {
		const latest = checkoutTasks.get(task.checkoutId);
		if (latest) {
			latest.status = "failed";
			latest.errorMessage =
				error instanceof Error ? error.message : "Unknown checkout error";
			latest.finishedAt = new Date().toISOString();
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
};

export const startCheckoutScanEnvironment = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const context = await resolveCheckoutContext(input);
	const toolsImage = await inspectCheckoutToolsImage({
		version: context.toolsVersion,
		variant: context.toolsVariant,
		imageTag: context.toolsImageTag,
	});
	if (!toolsImage) {
		throw new Error(
			`Checkout tools image ${context.toolsImageTag} is not available; build the tools image before checkout`,
		);
	}
	const checkoutId = nanoid();
	const task: CheckoutTask = {
		checkoutId,
		status: "running",
		phase: "waiting_tools",
		imageTag: context.imageTag,
		toolsVersion: context.toolsVersion,
		toolsVariant: context.toolsVariant,
		toolsImageTag: context.toolsImageTag,
		toolsBuildId: null,
		gitUrl: context.gitUrl,
		gitBranch: context.gitBranch,
		gitTag: context.gitTag,
		enableSubmodules: context.enableSubmodules,
		postCheckoutScript: context.postCheckoutScript,
		localPath: context.localPath,
		dockerfileTemplate: context.dockerfileTemplate,
		stdout: "",
		stderr: "",
		startedAt: new Date().toISOString(),
		applicationId: input.applicationId,
		composeId: input.composeId,
	};
	checkoutTasks.set(checkoutId, task);
	void runDockerBuildInBackground(task);
	return {
		checkoutId,
		status: task.status,
		imageTag: task.imageTag,
		phase: task.phase,
		toolsVersion: task.toolsVersion,
		toolsBuildId: task.toolsBuildId,
		gitUrl: task.gitUrl,
		gitBranch: task.gitBranch,
		gitTag: task.gitTag,
		enableSubmodules: task.enableSubmodules,
	};
};

export const findCheckoutStatus = async (checkoutId: string) => {
	const task = checkoutTasks.get(checkoutId);
	if (!task) {
		return null;
	}

	return {
		...task,
		dockerBuildProbe:
			task.status === "running"
				? "checkout-task-running"
				: task.status === "completed"
					? "checkout-task-completed"
					: "checkout-task-failed",
	};
};

export const findRunningCheckoutTask = async (input: {
	applicationId?: string;
	composeId?: string;
}) => {
	for (const task of checkoutTasks.values()) {
		if (task.status !== "running") continue;
		if (input.applicationId && task.applicationId === input.applicationId) {
			return task;
		}
		if (input.composeId && task.composeId === input.composeId) {
			return task;
		}
	}
	return null;
};

export const findCheckoutImageStatus = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const context = await resolveCheckoutContext(input);
	try {
		const { stdout } = await execFileAsync("docker", [
			"image",
			"inspect",
			context.imageTag,
		]);
		const inspect = JSON.parse(stdout) as Array<{
			Config?: { Labels?: Record<string, string> | null };
		}>;
		const labels = inspect[0]?.Config?.Labels ?? null;
		const imageToolsVersion = labels?.[SCAN_TOOLS_VERSION_LABEL] || null;
		return {
			exists: true,
			current: checkoutImageMatchesCurrentTools(
				labels,
				context.toolsVersion,
			),
			imageTag: context.imageTag,
			toolsImageTag: context.toolsImageTag,
			toolsVersion: context.toolsVersion,
			imageToolsVersion,
		};
	} catch {
		return {
			exists: false,
			current: false,
			imageTag: context.imageTag,
			toolsImageTag: context.toolsImageTag,
			toolsVersion: context.toolsVersion,
			imageToolsVersion: null,
		};
	}
};

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
const sanitizeContainerNamePart = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "x";

const toImageTagFromAppName = (appName: string) =>
	`vulseek-scan-${sanitizeForImageTag(appName)}:latest`;

const sanitizeProviderName = (value: string) =>
	value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "provider";

const CODEX_AUTO_APPROVE_CONFIG_TOML = applyCodexRuntimeConfigToml(
	[
		`approval_policy = "never"`,
		`sandbox_mode = "danger-full-access"`,
		`mcp_oauth_credentials_store = "file"`,
		"",
	].join("\n"),
);
const resolveCodexAuthMode = (
	agentProfile: AgentProfileLike | null | undefined,
) => (agentProfile?.authMode === "host_home" ? "host_home" : "api_key");

const resolveCodexHomeHostPath = (
	agentProfile: AgentProfileLike | null | undefined,
) => agentProfile?.homePath?.trim() || "";

const REVIEW_CONTAINER_HOST_CODEX_HOME = "/host-codex-home";

const buildReviewContainerCodexHomeMountArg = (
	agentProfile: AgentProfileLike | null | undefined,
) => {
	if (!agentProfile) {
		return "";
	}
	if (resolveCodexAuthMode(agentProfile) !== "host_home") {
		return "";
	}
	const hostPath = resolveCodexHomeHostPath(agentProfile);
	if (!hostPath) {
		return "";
	}
	return `-v '${escapeSingleQuotes(hostPath)}:${REVIEW_CONTAINER_HOST_CODEX_HOME}:ro'`;
};

const withCodexAutoApproveConfigToml = (configToml: string) => {
	const defaults: string[] = [];
	if (!/^\s*approval_policy\s*=/m.test(configToml)) {
		defaults.push(`approval_policy = "never"`);
	}
	if (!/^\s*sandbox_mode\s*=/m.test(configToml)) {
		defaults.push(`sandbox_mode = "danger-full-access"`);
	}
	if (!/^\s*mcp_oauth_credentials_store\s*=/m.test(configToml)) {
		defaults.push(`mcp_oauth_credentials_store = "file"`);
	}
	const withDefaults =
		defaults.length === 0
			? configToml
			: joinTomlBlocks(`${defaults.join("\n")}\n`, configToml);
	return applyCodexRuntimeConfigToml(withDefaults);
};

const stripProfileControlledCodexConfigToml = (configToml: string) => {
	let seenTable = false;
	return configToml
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			if (/^\[.*\]\s*$/.test(trimmed)) {
				seenTable = true;
			}
			return (
				seenTable ||
				!/^\s*(approval_policy|sandbox_mode|mcp_oauth_credentials_store|model|model_reasoning_effort)\s*=/.test(
					line,
				)
			);
		})
		.join("\n");
};

const withCodexProfileRuntimeConfig = (
	configToml: string,
	agentProfile: AgentProfileLike,
) => {
	const profileConfig = [
		`approval_policy = "never"`,
		`sandbox_mode = "danger-full-access"`,
		`mcp_oauth_credentials_store = "file"`,
		`model = "${agentProfile.model}"`,
		...(agentProfile.thinkingLevelEnabled
			? [`model_reasoning_effort = "${agentProfile.thinkingLevel}"`]
			: []),
	].join("\n");

	return joinTomlBlocks(
		profileConfig,
		sanitizeCodexAcpConfigToml(
			stripProfileControlledCodexConfigToml(configToml),
		),
	);
};

const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);
	const reasoningConfig = agentProfile.thinkingLevelEnabled
		? [`model_reasoning_effort = "${agentProfile.thinkingLevel}"`]
		: [];

	return withCodexAutoApproveConfigToml(
		[
			`model = "${agentProfile.model}"`,
			...reasoningConfig,
			`model_provider = "${providerName}"`,
			`preferred_auth_method = "apikey"`,
			"",
			`[model_providers.${providerName}]`,
			`name = "${providerName}"`,
			`base_url = "${agentProfile.baseUrl}"`,
			`wire_api = "responses"`,
			"",
		].join("\n"),
	);
};

const withTrustedReviewWorkspaceConfig = (configToml: string) =>
	joinTomlBlocks(
		configToml,
		`[projects."/workspace/review"]\ntrust_level = "trusted"`,
	);

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

const buildClaudeEnvPairs = (agentProfile: AgentProfileLike) => {
	const envPairs = [
		...(resolveCodexAuthMode(agentProfile) === "api_key"
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
	return envPairs;
};

const buildShellExports = (pairs: string[]) =>
	pairs
		.map((pair) => {
			const index = pair.indexOf("=");
			const key = index === -1 ? pair : pair.slice(0, index);
			const value = index === -1 ? "" : pair.slice(index + 1);
			return `export ${key}='${escapeSingleQuotes(value)}'`;
		})
		.join(" && ");

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

const resolveScanExecutionContext = async (
	scanJob: ScanJob,
	options?: { validateDatasetToolsImage?: boolean },
) => {
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
		if (options?.validateDatasetToolsImage !== false) {
			const imageMatches = await inspectRequiredToolsImageReference({
				imageTag,
				imageId: imageDigest,
			});
			if (!imageMatches) {
				throw new Error(
					`Dataset scan tools image is missing or changed: ${imageTag}`,
				);
			}
		}
		const configuredHostRoot = resolveConfiguredScanContextHostPath();
		if (!configuredHostRoot) {
			throw new Error(
				"Scan context host path is not configured. Restart vulseek-dev from dev.sh so /scan-context is mounted.",
			);
		}
		const target = {
			appName: serviceName,
			name: datasetRuntime.sample.title || datasetRuntime.sample.id,
			environment: {
				project: { name: projectName, scanContextVolumeName: "" },
			},
			scanStageSettings: {},
			memoryLimit: null,
			memoryReservation: null,
		};
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
			target,
			appName: serviceName,
			imageTag,
			contextVolumeName: "",
			projectName,
			serviceName,
			projectProfileContextRoot: buildProjectProfileContextRoot(),
			projectProfileCacheRoot: buildProjectProfileCacheRoot(),
			scanAgentProfile,
			datasetSampleHostPath: datasetRuntime.sampleHostPath,
		};
	}
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);
	const repositoryProfileAgentProfileId =
		target.scanStageSettings?.[SCAN_STAGE_IDS.repositoryProfile]
			?.agentProfileId || null;
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
			if (resolveCodexAuthMode(agentProfile) === "host_home") {
				const hostPath = resolveCodexHomeHostPath(agentProfile);
				if (!hostPath) {
					throw new Error(
						"Codex host home auth mode is enabled but no home path was configured on the agent profile.",
					);
				}
				const { stdout: sourceConfigToml } = await execAsync(
					`docker exec ${containerName} bash -lc "cat '${REVIEW_CONTAINER_HOST_CODEX_HOME}/config.toml' 2>/dev/null || true"`,
				);
				await execAsync(
					`docker exec ${containerName} bash -lc "mkdir -p '${codexHome}' && cp -a '${REVIEW_CONTAINER_HOST_CODEX_HOME}/.' '${codexHome}/'"`,
				);
				await writeContainerFile(
					containerName,
					`${codexHome}/config.toml`,
					withTrustedReviewWorkspaceConfig(
						joinTomlBlocks(
							withCodexProfileRuntimeConfig(sourceConfigToml, agentProfile),
							mcpConfigToml,
						),
					),
				);
				return;
			}
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				withTrustedReviewWorkspaceConfig(
					joinTomlBlocks(buildCodexConfigToml(agentProfile), mcpConfigToml),
				),
			);
			await writeContainerFile(
				containerName,
				`${codexHome}/auth.json`,
				buildCodexAuthJson(agentProfile),
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
			withTrustedReviewWorkspaceConfig(
				joinTomlBlocks(
					withCodexAutoApproveConfigToml(baseConfigToml),
					mcpConfigToml,
				),
			),
		);
	} catch {
		if (mcpConfigToml) {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				withTrustedReviewWorkspaceConfig(
					joinTomlBlocks(CODEX_AUTO_APPROVE_CONFIG_TOML, mcpConfigToml),
				),
			);
		} else {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				withTrustedReviewWorkspaceConfig(CODEX_AUTO_APPROVE_CONFIG_TOML),
			);
		}
	}

	const codexAuthPath = path.join(agentsDir, "codex-auth.json");
	try {
		await fs.stat(codexAuthPath);
		await execAsync(
			`docker cp "${codexAuthPath}" ${containerName}:"${codexHome}/auth.json"`,
		);
	} catch {}
};

const sanitizeContextPathPart = (value: string) =>
	value
		.trim()
		.replace(/[\\/]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "default";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const CONTAINER_TASK_RUNTIME_ROOT = "/task";

const buildProjectProfileContextRoot = () => CONTAINER_SCAN_CONTEXT_ROOT;

const toAgentVisiblePath = (containerPath: string) => containerPath;

const buildProjectProfileCacheRoot = () =>
	path.posix.join(buildProjectProfileContextRoot(), "cache");

const buildScanJobContextRoot = (scanJobId: string) =>
	path.posix.join(buildProjectProfileContextRoot(), "jobs", scanJobId);

const buildFullScanRoot = (scanJobId: string) =>
	path.posix.join(buildScanJobContextRoot(scanJobId), "scanning", "full_scan");

const buildFullScanModulesRoot = (scanJobId: string) =>
	path.posix.join(buildFullScanRoot(scanJobId), "modules");

const buildFullScanModuleRoot = (scanJobId: string, moduleId: string) =>
	path.posix.join(
		buildFullScanModulesRoot(scanJobId),
		sanitizeContextPathPart(moduleId),
	);

const buildFullScanFunctionRoot = (
	scanJobId: string,
	moduleId: string,
	functionId: string,
) =>
	path.posix.join(
		buildFullScanModuleRoot(scanJobId, moduleId),
		"functions",
		sanitizeContextPathPart(functionId),
	);

const buildMountedProjectProfileContextRoot = (
	projectName: string,
	profileName: string,
) =>
	path.join(
		buildProjectProfileContextRoot(),
		"projects",
		sanitizeContextPathPart(projectName),
		"profiles",
		sanitizeContextPathPart(profileName),
	);

const buildHostProjectProfileContextRoot = (
	hostRoot: string,
	projectName: string,
	profileName: string,
) =>
	path.join(
		hostRoot,
		"projects",
		sanitizeContextPathPart(projectName),
		"profiles",
		sanitizeContextPathPart(profileName),
	);

const buildTaskHostRootForScanJob = (input: {
	hostProfileDir: string;
	scanJobId: string;
	stageName: string;
	taskName: string;
	taskId: string;
}) =>
	path.join(
		input.hostProfileDir,
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(input.stageName, input.taskName, input.taskId),
	);

const buildTaskMountPathForReview = (input: {
	scanJobId: string;
	stageName: string;
	taskName: string;
	taskId: string;
}) =>
	path.posix.join(
		CONTAINER_TASK_RUNTIME_ROOT,
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(input.stageName, input.taskName, input.taskId)
			.split(path.sep)
			.join(path.posix.sep),
	);

const resolveConfiguredScanContextHostPath = () =>
	process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveScanContextMount = async (input: {
	contextVolumeName: string | null | undefined;
	projectName: string;
	profileName: string;
}) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env VULSEEK_SCAN_CONTEXT_HOST_PATH",
		);
	}

	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		input.projectName,
		input.profileName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return {
		mountSource: hostProfileDir,
		mountDescription: `host_path:${hostProfileDir}`,
		dockerMountArg: `-v '${escapeSingleQuotes(hostProfileDir)}':${CONTAINER_SCAN_CONTEXT_ROOT}`,
	};
};

const resolveScanRuntimeDir = (scanJobId: string) =>
	path.join(buildProjectProfileContextRoot(), "jobs", scanJobId);

const resolveScanJobScanningRuntimeDir = (scanJobId: string) =>
	path.join(resolveScanRuntimeDir(scanJobId), "scanning");

const resolveTaskArtifactsDir = async (input: {
	scanJobId: string;
	stageName: string;
	taskName: string;
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(
		projectProfileHostContextRoot,
		"jobs",
		input.scanJobId,
		"scanning",
		"full_scan",
		"stages",
		sanitizeContextPathPart(input.stageName),
		"tasks",
		sanitizeContextPathPart(input.taskName),
	);
};

const resolveCandidateTaskRuntimeDir = async (
	scanJobId: string,
	candidateId: string,
	stageName:
		| typeof SCAN_STAGE_IDS.analyzeFinding
		| typeof SCAN_STAGE_IDS.verifyFinding,
) => {
	const task = await findCandidateTaskByStage(
		scanJobId,
		candidateId,
		stageName,
	);
	if (!task) {
		return null;
	}
	return await resolveTaskArtifactsDir({
		scanJobId,
		stageName: task.stageName,
		taskName: task.name,
	});
};

const resolveScanJobTargetIdentity = async (scanJob: ScanJob) => {
	if (scanJob.datasetEvaluationTrialId) {
		const datasetRuntime = await resolveDatasetTrialRuntime(scanJob.scanJobId);
		if (!datasetRuntime)
			throw new Error("Invalid dataset evaluation trial target");
		return {
			projectName: `dataset-${datasetRuntime.dataset.datasetId}`,
			profileName: `${datasetRuntime.profile.profileId}-${datasetRuntime.sample.id}`,
		};
	}
	if (scanJob.applicationId) {
		const application = await findApplicationById(scanJob.applicationId);
		return {
			projectName: application.environment.project.name,
			profileName: application.name || application.appName,
		};
	}

	if (scanJob.composeId) {
		const compose = await findComposeById(scanJob.composeId);
		return {
			projectName: compose.environment.project.name,
			profileName: compose.name || compose.appName,
		};
	}

	throw new Error("Invalid scan job target");
};

const resolveProjectProfileHostContextRootByScanJob = async (
	scanJob: ScanJob,
) => {
	const { projectName, profileName } =
		await resolveScanJobTargetIdentity(scanJob);
	const mountedProfileDir = buildMountedProjectProfileContextRoot(
		projectName,
		profileName,
	);

	try {
		await fs.access(mountedProfileDir);
		return mountedProfileDir;
	} catch {}

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env VULSEEK_SCAN_CONTEXT_HOST_PATH",
		);
	}

	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		projectName,
		profileName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return hostProfileDir;
};

const resolveRequiredProjectProfileHostContextRootByScanJob = async (
	scanJob: ScanJob,
) => {
	const projectProfileHostContextRoot =
		await resolveProjectProfileHostContextRootByScanJob(scanJob);
	return projectProfileHostContextRoot;
};

type ScanJobFileTreeItem = {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: ScanJobFileTreeItem[];
};

const resolveScanJobArtifactsDir = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(
		projectProfileHostContextRoot,
		"jobs",
		scanJobId,
		"scanning",
	);
};

const resolveFullScanRootDir = async (scanJobId: string) =>
	path.join(await resolveScanJobArtifactsDir(scanJobId), "full_scan");

const resolveModuleArtifactsDir = async (scanJobId: string, moduleId: string) =>
	path.join(
		await resolveFullScanRootDir(scanJobId),
		"modules",
		sanitizeContextPathPart(moduleId),
	);

const resolveFunctionArtifactsDir = async (
	scanJobId: string,
	moduleId: string,
	functionId: string,
) =>
	path.join(
		await resolveModuleArtifactsDir(scanJobId, moduleId),
		"functions",
		sanitizeContextPathPart(functionId),
	);

const resolveLiveScanJobArtifactsDir = (input: {
	scanContextMount: Awaited<ReturnType<typeof resolveScanContextMount>>;
	scanJobId: string;
	projectName: string;
	profileName: string;
}) =>
	path.join(
		buildMountedProjectProfileContextRoot(input.projectName, input.profileName),
		"jobs",
		input.scanJobId,
		"scanning",
	);

const resolveScanJobBrowsableRoot = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(projectProfileHostContextRoot, "jobs", scanJobId);
};

type CandidateArtifactRoot = {
	name: string;
	hostRootPath: string;
	containerRootPath: string;
	sourceContainerRootPath: string;
};

const CANDIDATE_ARTIFACT_CONTAINER_ROOT = "/candidate-artifacts";

const resolveHostPathFromContainerScanPath = (
	projectProfileHostContextRoot: string,
	containerPath: string,
) => {
	const relativePath = path.posix.relative(
		CONTAINER_SCAN_CONTEXT_ROOT,
		containerPath,
	);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid scan artifact path",
		});
	}
	return path.join(
		projectProfileHostContextRoot,
		relativePath.split("/").join(path.sep),
	);
};

const isPathWithinPosixRoot = (filePath: string, rootPath: string) =>
	filePath === rootPath || filePath.startsWith(`${rootPath}/`);

const buildCandidateArtifactRoot = async (input: {
	name: string;
	scanJobId: string;
	taskId: string | null | undefined;
	projectProfileHostContextRoot: string;
	containerFilePath: string | null | undefined;
}): Promise<CandidateArtifactRoot | null> => {
	const {
		name,
		scanJobId,
		taskId,
		projectProfileHostContextRoot,
		containerFilePath,
	} = input;
	if (!containerFilePath) {
		return null;
	}

	const normalizedFilePath = containerFilePath.trim();
	if (!path.posix.isAbsolute(normalizedFilePath)) {
		return null;
	}

	const sourceContainerRootPath = path.posix.dirname(normalizedFilePath);
	if (
		isPathWithinPosixRoot(sourceContainerRootPath, CONTAINER_SCAN_CONTEXT_ROOT)
	) {
		try {
			return {
				name,
				containerRootPath: sourceContainerRootPath,
				sourceContainerRootPath,
				hostRootPath: resolveHostPathFromContainerScanPath(
					projectProfileHostContextRoot,
					sourceContainerRootPath,
				),
			};
		} catch {
			return null;
		}
	}

	if (
		taskId &&
		isPathWithinPosixRoot(sourceContainerRootPath, CONTAINER_TASK_RUNTIME_ROOT)
	) {
		const taskRootPath = await resolveScanTaskBrowsableRoot({
			scanJobId,
			taskId,
		});
		const relativePath = path.posix.relative(
			CONTAINER_TASK_RUNTIME_ROOT,
			sourceContainerRootPath,
		);
		return {
			name,
			containerRootPath: path.posix.join(
				CANDIDATE_ARTIFACT_CONTAINER_ROOT,
				name,
			),
			sourceContainerRootPath,
			hostRootPath: path.join(
				taskRootPath,
				relativePath.split("/").join(path.sep),
			),
		};
	}

	return null;
};

const listCandidateArtifactRoots = async (input: {
	scanJobId: string;
	candidateId: string;
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	const candidate = await findVulnerabilityCandidateByIdAndScanJobIdRepo({
		scanJobId: input.scanJobId,
		vulnerabilityCandidateId: input.candidateId,
	});
	const projection = await findCandidateByIdWithResultsRepo({
		scanJobId: input.scanJobId,
		vulnerabilityCandidateId: input.candidateId,
		producerTaskId: candidate.producerTaskId,
	});
	const analysisResult = projection?.latestAnalysisResult ?? null;
	const verificationResult = projection?.latestVerificationResult ?? null;
	const triageResult = projection?.latestTriageResult ?? null;

	const roots = (
		await Promise.all([
			buildCandidateArtifactRoot({
				name: "analysis",
				scanJobId: input.scanJobId,
				taskId: analysisResult?.taskId,
				projectProfileHostContextRoot,
				containerFilePath: analysisResult?.reportPath,
			}),
			buildCandidateArtifactRoot({
				name: "verify",
				scanJobId: input.scanJobId,
				taskId: verificationResult?.taskId,
				projectProfileHostContextRoot,
				containerFilePath: verificationResult?.reportPath,
			}),
			buildCandidateArtifactRoot({
				name: "triage",
				scanJobId: input.scanJobId,
				taskId: triageResult?.taskId,
				projectProfileHostContextRoot,
				containerFilePath: triageResult?.reportPath,
			}),
		])
	).filter((root): root is CandidateArtifactRoot => Boolean(root));

	const dedupedRoots = roots.filter(
		(root, index) =>
			roots.findIndex(
				(candidateRoot) =>
					candidateRoot.name === root.name &&
					candidateRoot.containerRootPath === root.containerRootPath,
			) === index,
	);

	const visibleRoots: CandidateArtifactRoot[] = [];
	for (const root of dedupedRoots) {
		const stat = await fs.stat(root.hostRootPath).catch(() => null);
		if (stat?.isDirectory()) {
			visibleRoots.push(root);
		}
	}
	return visibleRoots;
};

const assertWithinDirectory = (rootPath: string, targetPath: string) => {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedTarget = path.resolve(targetPath);
	const relativePath = path.relative(resolvedRoot, resolvedTarget);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "File path is outside the scan job context",
		});
	}
};

const resolveBrowsableFilePath = (input: {
	rootPath: string;
	filePath: string;
	containerRootPath: string;
}) => {
	const normalizedInput = input.filePath.trim();
	if (!normalizedInput) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File path is required",
		});
	}

	if (path.isAbsolute(normalizedInput)) {
		if (
			normalizedInput === input.containerRootPath ||
			normalizedInput.startsWith(`${input.containerRootPath}/`)
		) {
			const relativePath = path.posix.relative(
				input.containerRootPath,
				normalizedInput,
			);
			return path.join(input.rootPath, relativePath);
		}
		return path.resolve(normalizedInput);
	}

	return path.join(input.rootPath, normalizedInput);
};

const resolveCandidateBrowsableFilePath = async (input: {
	scanJobId: string;
	candidateId: string;
	filePath: string;
}) => {
	const roots = await listCandidateArtifactRoots({
		scanJobId: input.scanJobId,
		candidateId: input.candidateId,
	});
	const normalizedInput = input.filePath.trim();
	if (!normalizedInput) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File path is required",
		});
	}

	const candidates: Array<{ root: CandidateArtifactRoot; targetPath: string }> =
		[];

	for (const root of roots) {
		if (
			path.posix.isAbsolute(normalizedInput) &&
			(normalizedInput === root.containerRootPath ||
				normalizedInput.startsWith(`${root.containerRootPath}/`))
		) {
			candidates.push({
				root,
				targetPath: path.join(
					root.hostRootPath,
					path.posix
						.relative(root.containerRootPath, normalizedInput)
						.split("/")
						.join(path.sep),
				),
			});
			continue;
		}

		if (
			path.posix.isAbsolute(normalizedInput) &&
			(normalizedInput === root.sourceContainerRootPath ||
				normalizedInput.startsWith(`${root.sourceContainerRootPath}/`))
		) {
			candidates.push({
				root,
				targetPath: path.join(
					root.hostRootPath,
					path.posix
						.relative(root.sourceContainerRootPath, normalizedInput)
						.split("/")
						.join(path.sep),
				),
			});
			continue;
		}

		if (
			path.isAbsolute(normalizedInput) &&
			(normalizedInput === root.hostRootPath ||
				normalizedInput.startsWith(`${root.hostRootPath}${path.sep}`) ||
				normalizedInput.startsWith(`${root.hostRootPath}/`))
		) {
			candidates.push({ root, targetPath: path.resolve(normalizedInput) });
		}
	}

	if (roots.length === 1 && !path.isAbsolute(normalizedInput)) {
		const [root] = roots;
		if (!root) {
			throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
		}
		candidates.push({
			root,
			targetPath: path.join(root.hostRootPath, normalizedInput),
		});
	}

	for (const candidate of candidates) {
		const stat = await fs.stat(candidate.targetPath).catch(() => null);
		if (stat) {
			return candidate;
		}
	}

	if (candidates[0]) {
		return candidates[0];
	}

	throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
};

const shouldHideScanJobBrowsableEntry = (entryName: string) =>
	entryName.startsWith(".");

const shouldHideCandidateFileTreeEntry = (input: {
	entryName: string;
	containerDirPath: string;
}) =>
	shouldHideScanJobBrowsableEntry(input.entryName) ||
	input.entryName === "node_modules" ||
	(input.entryName === "cache" &&
		input.containerDirPath.includes("/agent-home"));

export const listScanJobDirectory = async (input: {
	scanJobId: string;
	directoryPath?: string;
}) => {
	const rootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	try {
		await fs.access(rootPath);
	} catch {
		return [];
	}

	const requestedDirectory = (input.directoryPath || "").trim();
	const targetDirectoryPath = requestedDirectory
		? resolveBrowsableFilePath({
				rootPath,
				filePath: requestedDirectory,
				containerRootPath: path.posix.join(
					buildScanJobContextRoot(input.scanJobId),
				),
			})
		: rootPath;

	assertWithinDirectory(rootPath, targetDirectoryPath);
	const stat = await fs.stat(targetDirectoryPath).catch(() => null);
	if (!stat || !stat.isDirectory()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Directory not found" });
	}

	const entries = await fs.readdir(targetDirectoryPath, {
		withFileTypes: true,
	});
	const visibleEntries = entries.filter(
		(entry) => !shouldHideScanJobBrowsableEntry(entry.name),
	);
	const sortedEntries = visibleEntries.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return left.name.localeCompare(right.name);
	});

	return await Promise.all(
		sortedEntries.map(async (entry) => {
			const fullPath = path.join(targetDirectoryPath, entry.name);
			if (entry.isDirectory()) {
				const children = await fs
					.readdir(fullPath, { withFileTypes: true })
					.catch(() => []);
				const hasChildren = children.some(
					(child) => !shouldHideScanJobBrowsableEntry(child.name),
				);
				return {
					id: fullPath,
					name: entry.name,
					type: "directory" as const,
					hasChildren,
				};
			}

			return {
				id: fullPath,
				name: entry.name,
				type: "file" as const,
				hasChildren: false,
			};
		}),
	);
};

export const readScanJobFileContent = async (input: {
	scanJobId: string;
	filePath: string;
}) => {
	const rootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	const targetPath = resolveBrowsableFilePath({
		rootPath,
		filePath: input.filePath,
		containerRootPath: path.posix.join(
			buildScanJobContextRoot(input.scanJobId),
		),
	});
	assertWithinDirectory(rootPath, targetPath);
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	const content = await fs.readFile(targetPath, "utf-8");
	return {
		path: targetPath,
		relativePath: path.relative(rootPath, targetPath),
		content,
	};
};

const resolveScanTaskBrowsableRoot = async (input: {
	scanJobId: string;
	taskId: string;
}) => {
	const task = await findTaskByIdRepo(input.taskId);
	if (task.scanJobId !== input.scanJobId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found for this scan job",
		});
	}

	const jobRootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	const expectedTaskRootPath = path.join(
		jobRootPath,
		resolveTaskRootSegment(task.stageName, task.name, task.taskId),
	);
	const expectedStat = await fs.stat(expectedTaskRootPath).catch(() => null);
	if (expectedStat?.isDirectory()) {
		return expectedTaskRootPath;
	}

	const stageTasksDir = path.join(
		jobRootPath,
		"scanning",
		"full_scan",
		"stages",
		sanitizeContextPathPart(task.stageName),
		"tasks",
	);
	const taskIdSuffix = `-${sanitizeContextPathPart(task.taskId).slice(0, 6)}`;
	const entries = await fs
		.readdir(stageTasksDir, { withFileTypes: true })
		.catch(() => []);
	const fallbackEntry = entries.find(
		(entry) => entry.isDirectory() && entry.name.endsWith(taskIdSuffix),
	);
	if (fallbackEntry) {
		return path.join(stageTasksDir, fallbackEntry.name);
	}

	return expectedTaskRootPath;
};

const resolveScanTaskLaneHostPath = async (input: {
	scanJobId: string;
	taskId: string;
}) => {
	const task = await findTaskByIdRepo(input.taskId);
	if (task.scanJobId !== input.scanJobId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found for this scan job",
		});
	}

	const jobRootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	const laneRuntime = await findStageLaneRuntimeByTaskIdRepo({
		scanJobId: input.scanJobId,
		stageName: task.stageName,
		taskId: input.taskId,
	});
	let laneIndex = laneRuntime?.laneIndex ?? null;
	if (laneIndex == null) {
		const stageLanes = (
			await listStageLaneRuntimesByScanJobIdRepo(input.scanJobId)
		).filter((lane) => lane.stageName === task.stageName);
		if (stageLanes.length === 1) {
			laneIndex = stageLanes[0]!.laneIndex;
		}
	}
	if (laneIndex == null) {
		const lanesDir = path.join(
			jobRootPath,
			"scanning",
			"full_scan",
			"stages",
			sanitizeContextPathPart(task.stageName),
			"lanes",
		);
		const entries = await fs
			.readdir(lanesDir, { withFileTypes: true })
			.catch(() => []);
		const laneDirs = entries.filter(
			(entry) => entry.isDirectory() && /^lane-\d+$/.test(entry.name),
		);
		if (laneDirs.length === 1) {
			const match = /^lane-(\d+)$/.exec(laneDirs[0]!.name);
			laneIndex = match ? Number(match[1]) : null;
		}
	}
	if (laneIndex == null) return null;

	const hostRootPath = path.join(
		jobRootPath,
		resolveStageLaneRootSegment(task.stageName, laneIndex),
	);
	const stat = await fs.stat(hostRootPath).catch(() => null);
	return stat?.isDirectory() ? hostRootPath : null;
};

const resolveScanTaskBrowsableRoots = async (input: {
	scanJobId: string;
	taskId: string;
}): Promise<TaskFileBrowserRoot[]> => {
	const taskHostPath = await resolveScanTaskBrowsableRoot(input);
	const laneHostPath = await resolveScanTaskLaneHostPath(input);
	const roots: TaskFileBrowserRoot[] = [];
	const taskStat = await fs.stat(taskHostPath).catch(() => null);
	if (taskStat?.isDirectory()) {
		roots.push({
			name: "task",
			containerRootPath: TASK_BROWSER_TASK_ROOT,
			hostRootPath: taskHostPath,
		});
	}
	if (
		laneHostPath &&
		path.resolve(laneHostPath) !== path.resolve(taskHostPath)
	) {
		roots.push({
			name: "lane",
			containerRootPath: TASK_BROWSER_LANE_ROOT,
			hostRootPath: laneHostPath,
		});
	}
	return roots;
};

export const listScanTaskDirectory = async (input: {
	scanJobId: string;
	taskId: string;
	directoryPath?: string;
}) => {
	const roots = await resolveScanTaskBrowsableRoots(input);
	return listTaskFileBrowserDirectory({
		roots,
		directoryPath: input.directoryPath,
	});
};

export const readScanTaskFileContent = async (input: {
	scanJobId: string;
	taskId: string;
	filePath: string;
}) => {
	const roots = await resolveScanTaskBrowsableRoots(input);
	return readTaskFileBrowserFile({
		roots,
		filePath: input.filePath,
	});
};

export const listCandidateDirectory = async (input: {
	scanJobId: string;
	candidateId: string;
	directoryPath?: string;
}) => {
	const roots = await listCandidateArtifactRoots({
		scanJobId: input.scanJobId,
		candidateId: input.candidateId,
	});
	const requestedPath = (input.directoryPath || "").trim();
	if (!requestedPath) {
		return await Promise.all(
			roots.map(async (root) => ({
				id: root.containerRootPath,
				name: root.name,
				type: "directory" as const,
				hasChildren: Boolean(
					(
						await fs
							.readdir(root.hostRootPath, { withFileTypes: true })
							.catch(() => [])
					).some(
						(entry) =>
							!shouldHideCandidateFileTreeEntry({
								entryName: entry.name,
								containerDirPath: root.containerRootPath,
							}),
					),
				),
			})),
		);
	}

	const root = roots.find(
		(candidateRoot) =>
			requestedPath === candidateRoot.containerRootPath ||
			requestedPath.startsWith(`${candidateRoot.containerRootPath}/`),
	);
	if (!root) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Directory not found" });
	}
	const relativePath = path.posix.relative(
		root.containerRootPath,
		requestedPath,
	);
	const hostDirectory = path.join(
		root.hostRootPath,
		relativePath.split("/").join(path.sep),
	);
	assertWithinDirectory(root.hostRootPath, hostDirectory);
	const stat = await fs.stat(hostDirectory).catch(() => null);
	if (!stat?.isDirectory()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Directory not found" });
	}
	const entries = (
		await fs.readdir(hostDirectory, { withFileTypes: true })
	).filter(
		(entry) =>
			!shouldHideCandidateFileTreeEntry({
				entryName: entry.name,
				containerDirPath: requestedPath,
			}),
	);
	entries.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return left.name.localeCompare(right.name);
	});
	return await Promise.all(
		entries.map(async (entry) => {
			const id = path.posix.join(requestedPath, entry.name);
			return {
				id,
				name: entry.name,
				type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
				hasChildren: entry.isDirectory()
					? (
							await fs
								.readdir(path.join(hostDirectory, entry.name), {
									withFileTypes: true,
								})
								.catch(() => [])
						).some(
							(child) =>
								!shouldHideCandidateFileTreeEntry({
									entryName: child.name,
									containerDirPath: id,
								}),
						)
					: false,
			};
		}),
	);
};

export const readCandidateFileContent = async (input: {
	scanJobId: string;
	candidateId: string;
	filePath: string;
}) => {
	const { root, targetPath } = await resolveCandidateBrowsableFilePath(input);
	assertWithinDirectory(root.hostRootPath, targetPath);
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	const content = await fs.readFile(targetPath, "utf-8");
	return {
		path: targetPath,
		relativePath: path.posix.join(
			root.name,
			path.relative(root.hostRootPath, targetPath).split(path.sep).join("/"),
		),
		content,
	};
};

export const findScanJobRunningTasks = async (scanJobId: string) =>
	(await listRunningTaskViewsByScanJobIdRepo(scanJobId)).sort(
		compareInProgressTaskView,
	);

export const findScanJobQueueCounts = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const taskStatusCounts = await listTaskStatusCountsByScanJobIdRepo(scanJobId);
	const snapshot =
		scanJob.pipelineVersionId && scanJob.pipelineCompiledSnapshot
			? loadCompiledPipelineSnapshot(scanJob)
			: null;
	const snapshotStages = snapshot?.stages;
	if (snapshotStages?.length) {
		const yamlConcurrencyByStage = new Map(
			snapshotStages.map((stage) => [stage.id, stage.concurrency] as const),
		);
		return await listQueuePendingCountsByScanJobId(
			scanJobId,
			taskStatusCounts,
			await resolveQueueConcurrencyByStage(
				scanJobId,
				snapshotStages.map((stage) => stage.id),
				yamlConcurrencyByStage,
			),
			snapshotStages.map((stage) => stage.id),
			new Map(snapshotStages.map((stage) => [stage.id, stage.name] as const)),
		);
	}
	const pipelineDefinitions = resolveScanJobPipelineDefinitions(scanJob);
	const pipeline = pipelineDefinitions.pipelines[scanJob.pipelineId];
	if (!pipeline)
		throw new Error(`Unknown scan pipeline: ${scanJob.pipelineId}`);
	const yamlConcurrencyByStage = new Map(
		pipeline.stageIds.map(
			(stageId) => [stageId, getRuntimeStageConcurrency(stageId)] as const,
		),
	);
	return await listQueuePendingCountsByScanJobId(
		scanJobId,
		taskStatusCounts,
		await resolveQueueConcurrencyByStage(
			scanJobId,
			pipeline.stageIds,
			yamlConcurrencyByStage,
		),
		pipeline.stageIds,
		new Map(),
	);
};

const resolveQueueConcurrencyByStage = async (
	scanJobId: string,
	stageIds: string[],
	yamlConcurrencyByStage: Map<string, number | null | undefined>,
) => {
	const entries = await Promise.all(
		stageIds.map(async (stageId) => {
			const limit = await resolveStageConcurrencySetting(
				scanJobId,
				stageId,
				() => yamlConcurrencyByStage.get(stageId) ?? null,
			);
			return [stageId, limit] as const;
		}),
	);
	return new Map<Task["stageName"], number>(entries);
};
export const findScanJobTerminalTasksPage = async (input: {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	stage?: string;
	status?: string;
}) => {
	const { stageName, status } = normalizeTerminalTaskFilters(input);
	const page = await listTerminalTasksPageByScanJobIdRepo({
		scanJobId: input.scanJobId,
		page: input.page,
		pageSize: input.pageSize,
		query: input.query,
		stageName,
		status,
	});
	return {
		...page,
		items: page.items
			.map(buildTerminalTaskView)
			.filter((task): task is TerminalTaskView => Boolean(task))
			.sort(compareTerminalTaskView),
	};
};

type ScanStageGraphNodeStatus =
	| "pending"
	| "launching"
	| "launched"
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "exited";

type ScanStageGraphCounts = {
	waiting: number;
	queued: number;
	launching: number;
	launched: number;
	starting: number;
	running: number;
	completed: number;
	failed: number;
	exited: number;
	total: number;
	pending: number;
};

const emptyStageGraphCounts = (): ScanStageGraphCounts => ({
	waiting: 0,
	queued: 0,
	launching: 0,
	launched: 0,
	starting: 0,
	running: 0,
	completed: 0,
	failed: 0,
	exited: 0,
	total: 0,
	pending: 0,
});

const toStageGraphCounts = (
	queue: QueuePendingCountView | undefined,
): ScanStageGraphCounts => {
	if (!queue) {
		return emptyStageGraphCounts();
	}
	return {
		waiting: queue.waitingCount,
		queued: queue.queuedCount,
		launching: queue.launchingCount,
		launched: queue.launchedCount,
		starting: queue.startingCount,
		running: queue.runningCount,
		completed: queue.completedCount,
		failed: queue.failedCount,
		exited: queue.exitedCount,
		total: queue.totalCount,
		pending: queue.pendingCount,
	};
};

const deriveStageGraphStatus = (
	stageName: string,
	counts: ScanStageGraphCounts,
	scanJob: ScanJob,
): ScanStageGraphNodeStatus => {
	if (
		stageName === SCAN_STAGE_IDS.repositoryProfile ||
		stageName === SCAN_STAGE_IDS.deltaScope
	) {
		const repositoryStatus = scanJob.repositoryTaskStatus;
		if (
			repositoryStatus === "pending" ||
			repositoryStatus === "launching" ||
			repositoryStatus === "launched" ||
			repositoryStatus === "starting" ||
			repositoryStatus === "running" ||
			repositoryStatus === "completed" ||
			repositoryStatus === "failed" ||
			repositoryStatus === "exited"
		) {
			return repositoryStatus;
		}
	}
	if (counts.failed > 0) {
		return "failed";
	}
	if (counts.running > 0 || counts.starting > 0) {
		return "running";
	}
	if (counts.launching > 0 || counts.launched > 0) {
		return "launching";
	}
	if (counts.total > 0 && counts.completed + counts.exited >= counts.total) {
		return counts.exited > 0 ? "exited" : "completed";
	}
	return "pending";
};

type ScanStageGraphTargetInput = {
	applicationId?: string | null;
	composeId?: string | null;
	pipelineId: string;
};

export const getScanPipelineDefinitions = () => loadScanPipelineDefinitions();

export const getScanPipelineYaml = () => readScanPipelineDefinitionsYaml();

const resolveStaticStageConcurrency = (
	stageName: string,
	settings: Awaited<
		ReturnType<typeof resolveScanProfileConcurrencySettingsFromTarget>
	>,
) => {
	const stageConcurrency = settings.scanStageSettings?.[stageName]?.concurrency;
	if (stageConcurrency) {
		return Math.max(1, stageConcurrency);
	}
	return getRuntimeStageConcurrency(stageName);
};

export const findFullScanStageGraph = async (
	target: ScanStageGraphTargetInput,
) => {
	const settings =
		await resolveScanProfileConcurrencySettingsFromTarget(target);
	const definitions = loadScanPipelineDefinitions();
	const pipeline = definitions.pipelines[target.pipelineId];
	if (!pipeline) {
		throw new Error(`Unknown scan pipeline ${target.pipelineId}`);
	}
	const stages = pipeline.stageIds.map((stageId) => {
		const stage = definitions.stageMetadataById[stageId];
		if (!stage) {
			throw new Error(`Unknown scan stage ${stageId} in ${pipeline.name}`);
		}
		return stage;
	});
	return {
		pipelineName: pipeline.name,
		nodes: await Promise.all(
			stages.map(async (stage, index) => {
				const agentProfile = await resolveStageAgentProfileFromTarget(
					target,
					stage.id,
				);
				return {
					id: stage.id,
					stageId: stage.id,
					stageName: stage.id,
					name: stage.name,
					title: stage.name,
					queueId: null,
					queueName: null,
					status: "pending" as const,
					counts: emptyStageGraphCounts(),
					concurrencyLimit: resolveStaticStageConcurrency(stage.id, settings),
					disabled: false,
					effectiveDisabled: false,
					configuredConcurrency: null,
					configuredAgentProfileId: null,
					agentProfile:
						buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
					groupId: null,
					order: index,
				};
			}),
		),
		edges: pipeline.edges.map((edge) => ({
			id: edge.id,
			name: edge.name,
			source: edge.from,
			target: edge.to,
			fork: edge.fork,
			routeKey: edge.route?.key ?? null,
			isDefaultRoute: Boolean(edge.route?.default),
		})),
		groups: pipeline.groups.map((group) => ({
			id: group.id,
			name: group.name,
			leaderStageName: group.leader,
			memberStageNames: group.members,
			stageNames: [group.leader, ...group.members],
		})),
	};
};

export const findScanJobStageGraph = async (
	scanJobId: string,
	options?: { includeQueue?: boolean },
) => {
	const includeQueue = options?.includeQueue ?? true;
	const context = await buildFullScanPipelineContext(scanJobId, {
		validateDatasetToolsImage: false,
	});
	const pipeline =
		context.scanJob.pipelineVersionId &&
		context.scanJob.pipelineCompiledSnapshot
			? buildPipelineFromCompiled(
					context,
					loadCompiledPipelineSnapshot(context.scanJob),
				)
			: buildYamlPipeline(context, context.scanJob.pipelineId);
	const disabledStages = buildEffectiveDisabledStageSet({
		settings: context.scanJob.scanRuntimeSettings,
		stageNames: pipeline.stages.map((stage) => stage.id),
		edges: pipeline.edges.map((edge) => ({
			source: edge.from.id,
			target: edge.to.id,
		})),
		rootStageName: pipeline.stages[0]?.id,
	});
	const queuePendingCounts = includeQueue
		? await listQueuePendingCountsByScanJobId(
				scanJobId,
				await listTaskStatusCountsByScanJobIdRepo(scanJobId),
				new Map<Task["stageName"], number>(),
				pipeline.stages.map((stage) => stage.id),
			)
		: [];
	const queueByStageName = new Map(
		queuePendingCounts.map((queue) => [queue.stageName, queue]),
	);
	const groupNameByStageName = new Map<string, string>();
	for (const group of pipeline.groups ?? []) {
		groupNameByStageName.set(group.leader.id, group.name);
		for (const member of group.members) {
			groupNameByStageName.set(member.id, group.name);
		}
	}

	return {
		pipelineName: pipeline.name,
		nodes: await Promise.all(
			pipeline.stages.map(async (stage, index) => {
				const queue = queueByStageName.get(stage.id);
				const counts = toStageGraphCounts(queue);
				const runtimeSetting = getRuntimeStageSetting(
					context.scanJob.scanRuntimeSettings,
					stage.id,
				);
				const concurrencyLimit = Math.max(
					1,
					(await stage.getDesiredConcurrency?.(context)) ?? 1,
				);
				const agentProfile = await resolveStageAgentProfile(
					context.scanJob,
					stage.id,
				);
				return {
					id: stage.id,
					stageId: stage.id,
					stageName: stage.id,
					name: stage.name,
					title: stage.name,
					queueId: queue?.id ?? null,
					queueName: queue?.queueName ?? null,
					status: deriveStageGraphStatus(stage.id, counts, context.scanJob),
					counts,
					concurrencyLimit,
					disabled: runtimeSetting.disabled === true,
					effectiveDisabled: disabledStages.has(stage.id),
					configuredConcurrency: runtimeSetting.concurrency ?? null,
					configuredAgentProfileId: runtimeSetting.agentProfileId ?? null,
					agentProfile:
						buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
					groupId: groupNameByStageName.get(stage.id) ?? null,
					order: index,
				};
			}),
		),
		edges: pipeline.edges.map((edge) => ({
			id: edge.name,
			name: edge.name,
			source: edge.from.id,
			target: edge.to.id,
			fork: Boolean(edge.fork),
			routeKey: edge.route?.key ?? null,
			isDefaultRoute: Boolean(edge.route?.default),
		})),
		groups: (pipeline.groups ?? []).map((group) => ({
			id: group.name,
			name: group.name,
			leaderStageName: group.leader.id,
			memberStageNames: group.members.map((stage) => stage.id),
			stageNames: [group.leader.id, ...group.members.map((stage) => stage.id)],
		})),
	};
};

export const findScanJobPipeline = async (scanJobId: string) =>
	await findScanJobStageGraph(scanJobId, { includeQueue: false });

const captureContainerCodexState = async (
	containerName: string,
	scanRootDir: string,
	fileName: string,
) => {
	const shellScript = [
		"set -eu",
		`mkdir -p '${scanRootDir}'`,
		`output='${scanRootDir}/${fileName}'`,
		"{",
		`echo '# Codex Runtime State'`,
		"echo",
		`echo '## config.toml'`,
		"echo '```toml'",
		`if [ -f /root/.codex/config.toml ]; then cat /root/.codex/config.toml; else echo '(missing)'; fi`,
		"echo '```'",
		"echo",
		`echo '## auth.json'`,
		"echo '```json'",
		`if [ -f /root/.codex/auth.json ]; then cat /root/.codex/auth.json; else echo '(missing)'; fi`,
		"echo '```'",
		"echo",
		`echo '## environment'`,
		"echo '```text'",
		`env | grep -iE 'OPENAI|proxy|BASE_URL|CODEX' | sort || true`,
		"echo '```'",
		`} > "$output"`,
	].join("\n");
	const encoded = Buffer.from(shellScript, "utf-8").toString("base64");

	await execAsync(
		`docker exec ${containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
	);
};

type PreparedRepositoryState = {
	effectiveTargetMode: string;
	targetRef: string | null;
	targetTag: string | null;
	requestedCommitSha: string | null;
	requestedBaseSha: string | null;
	commitWindow: number;
	resolvedTargetSha: string;
	resolvedBaseSha: string | null;
	currentBranch: string | null;
	currentExactTag: string | null;
	markdown: string;
};

const prepareRepositoryForScanInContainer = async (input: {
	containerName: string;
	scanJob: ScanJob;
	scanRootDir: string;
}): Promise<PreparedRepositoryState> => {
	const compiledSnapshot = input.scanJob.pipelineCompiledSnapshot as {
		stages?: Array<{ id: string }>;
	} | null;
	const stageIds = Array.isArray(compiledSnapshot?.stages)
		? compiledSnapshot.stages.map((stage) => stage.id)
		: [];
	const forceLatestRef = stageIds.includes("delta-scope");
	const preferLatestTag = !forceLatestRef;
	const targetRef = input.scanJob.targetRef?.trim() || "";
	const targetTag = input.scanJob.targetTag?.trim() || "";
	const requestedCommit = input.scanJob.commitSha?.trim() || "";
	const requestedBase = input.scanJob.baseSha?.trim() || "";
	const commitWindow =
		input.scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW;
	const isDeltaScan = forceLatestRef;

	const shellScript = [
		`SCAN_ROOT='${escapeSingleQuotes(input.scanRootDir)}'`,
		'mkdir -p "$SCAN_ROOT"',
		'PREPARE_STDOUT="$SCAN_ROOT/00_repository_prepare.stdout.log"',
		'PREPARE_STDERR="$SCAN_ROOT/00_repository_prepare.stderr.log"',
		': > "$PREPARE_STDOUT"',
		': > "$PREPARE_STDERR"',
		'exec > >(tee -a "$PREPARE_STDOUT") 2> >(tee -a "$PREPARE_STDERR" >&2)',
		"set -Eeuo pipefail",
		'CURRENT_CMD="(initializing)"',
		"trap 'rc=$?; echo \"[error] command failed (exit ${rc}): ${CURRENT_CMD}\" >&2' ERR",
		"run() {",
		'  CURRENT_CMD="$*"',
		'  echo "[cmd] $CURRENT_CMD"',
		'  "$@"',
		"}",
		"cd /workspace/repo",
		'CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"',
		'echo "[info] using repository state from checkout image; skipping remote fetch/pull"',
		`TARGET_REF='${escapeSingleQuotes(targetRef)}'`,
		`TARGET_TAG='${escapeSingleQuotes(targetTag)}'`,
		`REQUESTED_COMMIT='${escapeSingleQuotes(requestedCommit)}'`,
		`REQUESTED_BASE='${escapeSingleQuotes(requestedBase)}'`,
		`COMMIT_WINDOW='${commitWindow}'`,
		`FORCE_LATEST_REF='${forceLatestRef ? "true" : "false"}'`,
		`PREFER_LATEST_TAG='${preferLatestTag ? "true" : "false"}'`,
		'RESOLVED_TARGET=""',
		'EFFECTIVE_TARGET_MODE="explicit"',
		'if [ "$FORCE_LATEST_REF" = "true" ]; then',
		'  EFFECTIVE_TARGET_MODE="latest-ref"',
		'  if [ -n "$CURRENT_BRANCH" ]; then',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'    TARGET_REF="$CURRENT_BRANCH"',
		'    TARGET_TAG=""',
		'    REQUESTED_COMMIT=""',
		"  else",
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'    TARGET_REF="HEAD"',
		'    TARGET_TAG=""',
		'    REQUESTED_COMMIT=""',
		"  fi",
		'elif [ "$PREFER_LATEST_TAG" = "true" ] && [ -z "$TARGET_TAG" ]; then',
		'  CURRENT_CMD="git for-each-ref --sort=-creatordate --count=1 --format=%(refname:short) refs/tags"',
		"  LATEST_TAG=\"$(git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' refs/tags)\"",
		'  if [ -n "$LATEST_TAG" ]; then',
		'    EFFECTIVE_TARGET_MODE="latest-tag"',
		'    TARGET_TAG="$LATEST_TAG"',
		'    TARGET_REF=""',
		'    REQUESTED_COMMIT=""',
		'    CURRENT_CMD="git rev-parse --verify refs/tags/$TARGET_TAG^{commit}"',
		'    git rev-parse --verify "refs/tags/$TARGET_TAG^{commit}" >/dev/null',
		'    run git checkout -f "refs/tags/$TARGET_TAG"',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"  else",
		'    EFFECTIVE_TARGET_MODE="latest-head-no-tag"',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"  fi",
		'elif [ -n "$TARGET_TAG" ]; then',
		'  CURRENT_CMD="git rev-parse --verify refs/tags/$TARGET_TAG^{commit}"',
		'  git rev-parse --verify "refs/tags/$TARGET_TAG^{commit}" >/dev/null',
		'  run git checkout -f "refs/tags/$TARGET_TAG"',
		'  RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'elif [ -n "$TARGET_REF" ]; then',
		'  CURRENT_CMD="git rev-parse --verify $TARGET_REF^{commit}"',
		'  if git rev-parse --verify "$TARGET_REF^{commit}" >/dev/null 2>&1; then',
		'    run git checkout -f "$TARGET_REF"',
		"  else",
		'    CURRENT_CMD="git rev-parse --verify origin/$TARGET_REF^{commit}"',
		'    if git rev-parse --verify "origin/$TARGET_REF^{commit}" >/dev/null 2>&1; then',
		'      run git checkout -f "origin/$TARGET_REF"',
		"    else",
		'      echo "Unable to resolve targetRef: $TARGET_REF" >&2',
		"      exit 1",
		"    fi",
		"  fi",
		'  RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'elif [ -n "$REQUESTED_COMMIT" ]; then',
		'  CURRENT_CMD="git rev-parse --verify $REQUESTED_COMMIT^{commit}"',
		'  if git rev-parse --verify "$REQUESTED_COMMIT^{commit}" >/dev/null 2>&1; then',
		'    run git checkout -f "$REQUESTED_COMMIT"',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"  else",
		'    echo "Unable to resolve commitSha: $REQUESTED_COMMIT" >&2',
		"    exit 1",
		"  fi",
		"else",
		'  RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"fi",
		'TARGET_SUBJECT="$(git log -1 --format=%s "$RESOLVED_TARGET")"',
		'TARGET_SHORT="$(git rev-parse --short "$RESOLVED_TARGET")"',
		'CURRENT_EXACT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"',
		...(isDeltaScan
			? [
					'if [ -n "$REQUESTED_BASE" ] && git rev-parse --verify "$REQUESTED_BASE^{commit}" >/dev/null 2>&1; then',
					'  RESOLVED_BASE="$REQUESTED_BASE"',
					"else",
					'  RESOLVED_BASE="$(git rev-parse "$RESOLVED_TARGET~$COMMIT_WINDOW" 2>/dev/null || true)"',
					"fi",
				]
			: ['RESOLVED_BASE=""']),
		"{",
		"  echo '# Repository State'",
		"  echo",
		'  echo "- effective_target_mode: ${EFFECTIVE_TARGET_MODE}"',
		'  echo "- target_tag: ${TARGET_TAG:-<none>}"',
		'  echo "- target_ref: ${TARGET_REF:-<none>}"',
		'  echo "- requested_commit_sha: ${REQUESTED_COMMIT:-<none>}"',
		'  echo "- requested_base_sha: ${REQUESTED_BASE:-<none>}"',
		'  echo "- resolved_target_sha: ${RESOLVED_TARGET}"',
		'  echo "- resolved_target_short: ${TARGET_SHORT}"',
		'  echo "- resolved_base_sha: ${RESOLVED_BASE:-<none>}"',
		'  echo "- target_subject: ${TARGET_SUBJECT}"',
		...(isDeltaScan
			? [
					'  echo "- commit_window: ${COMMIT_WINDOW}"',
					"  echo",
					"  echo '## Recent Commits'",
					'  CURRENT_CMD="git log --oneline -n $((COMMIT_WINDOW + 1)) $RESOLVED_TARGET"',
					'  git log --oneline -n "$((COMMIT_WINDOW + 1))" "$RESOLVED_TARGET" || true',
				]
			: []),
		'} > "$SCAN_ROOT/00_repository_state.md"',
		"jq -n \\",
		'  --arg effectiveTargetMode "$EFFECTIVE_TARGET_MODE" \\',
		'  --arg targetRef "$TARGET_REF" \\',
		'  --arg targetTag "$TARGET_TAG" \\',
		'  --arg requestedCommitSha "$REQUESTED_COMMIT" \\',
		'  --arg requestedBaseSha "$REQUESTED_BASE" \\',
		'  --arg resolvedTargetSha "$RESOLVED_TARGET" \\',
		'  --arg resolvedBaseSha "$RESOLVED_BASE" \\',
		'  --arg currentBranch "$CURRENT_BRANCH" \\',
		'  --arg currentExactTag "$CURRENT_EXACT_TAG" \\',
		'  --argjson commitWindow "$COMMIT_WINDOW" \\',
		"  '{",
		"    effectiveTargetMode: $effectiveTargetMode,",
		'    targetRef: (if $targetRef == "" then null else $targetRef end),',
		'    targetTag: (if $targetTag == "" then null else $targetTag end),',
		'    requestedCommitSha: (if $requestedCommitSha == "" then null else $requestedCommitSha end),',
		'    requestedBaseSha: (if $requestedBaseSha == "" then null else $requestedBaseSha end),',
		"    commitWindow: $commitWindow,",
		"    resolvedTargetSha: $resolvedTargetSha,",
		'    resolvedBaseSha: (if $resolvedBaseSha == "" then null else $resolvedBaseSha end),',
		'    currentBranch: (if $currentBranch == "" then null else $currentBranch end),',
		'    currentExactTag: (if $currentExactTag == "" then null else $currentExactTag end)',
		'  }\' > "$SCAN_ROOT/00_repository_state.json"',
	].join("\n");
	const encoded = Buffer.from(shellScript, "utf-8").toString("base64");

	await execAsync(
		`docker exec ${input.containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
	).catch(async (error) => {
		let prepareStdout = "";
		let prepareStderr = "";
		try {
			const stdoutRead = await execAsync(
				`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_prepare.stdout.log' 2>/dev/null || true"`,
			);
			prepareStdout = stdoutRead.stdout.trim();
		} catch {}
		try {
			const stderrRead = await execAsync(
				`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_prepare.stderr.log' 2>/dev/null || true"`,
			);
			prepareStderr = stderrRead.stdout.trim();
		} catch {}

		const message =
			error instanceof Error ? error.message : "Repository prepare failed";
		const tail = (value: string) =>
			value.split("\n").slice(-40).join("\n").trim();
		throw new Error(
			[
				message,
				prepareStdout ? `prepare_stdout_tail:\n${tail(prepareStdout)}` : "",
				prepareStderr ? `prepare_stderr_tail:\n${tail(prepareStderr)}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	});

	const repositoryState = await execAsync(
		`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_state.md'"`,
	);
	const repositoryStateJson = await execAsync(
		`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_state.json'"`,
	);

	const parsed = JSON.parse(repositoryStateJson.stdout) as Omit<
		PreparedRepositoryState,
		"markdown"
	>;

	return {
		...parsed,
		markdown: repositoryState.stdout.trim(),
	};
};

type FullScanExecutionContext = Awaited<
	ReturnType<typeof resolveScanExecutionContext>
>;

type FullScanPipelineContext = PipelineContext & {
	scanJob: ScanJob;
	executionContext: FullScanExecutionContext;
};

type FullScanPipelineStage = AnyStageDefinition<FullScanPipelineContext>;
type FullScanPipelineEdge = PipelineEdge<
	FullScanPipelineContext,
	FullScanPipelineStage,
	any,
	FullScanPipelineStage,
	any
>;

const buildSchemaContract = (
	schemas: Record<string, Record<string, unknown>>,
	schema: Record<string, unknown> | null | undefined,
): StructuredOutputSchemaSource | undefined =>
	schema
		? createJsonSchemaContract({
				schemas,
				schema,
			})
		: undefined;

const buildDefinitionsSchemaContract = (
	definitions: ScanPipelineDefinitions,
	schema: Record<string, unknown> | null | undefined,
): StructuredOutputSchemaSource | undefined =>
	buildSchemaContract(definitions.schemas, schema);

const getDefinitionsStageOutputSchema = (
	definitions: ScanPipelineDefinitions,
	stageId: string,
) =>
	buildDefinitionsSchemaContract(
		definitions,
		definitions.stages.find((stage) => stage.id === stageId)?.outputSchema,
	);

const buildPipelineGroupsFromConfigs = (
	groups: ScanPipelineGroupConfig[],
	stageRegistry: Map<string, FullScanPipelineStage>,
) =>
	groups.map((group) => {
		const leader = stageRegistry.get(group.leader);
		if (!leader) {
			throw new Error(`missing group leader implementation: ${group.leader}`);
		}
		return {
			name: group.name,
			leader,
			members: group.members.map((stageId) => {
				const stage = stageRegistry.get(stageId);
				if (!stage) {
					throw new Error(`missing group member implementation: ${stageId}`);
				}
				return stage;
			}),
		};
	});

const resolveScanJobPipelineDefinitions = (
	scanJob: Pick<ScanJob, "scanPipelineDefinitionSnapshot">,
): ScanPipelineDefinitions => {
	const snapshot = scanJob.scanPipelineDefinitionSnapshot;
	if (
		snapshot &&
		typeof snapshot === "object" &&
		"stages" in snapshot &&
		"pipelines" in snapshot
	) {
		return normalizePipelineDefinitionSnapshot(
			normalizeLegacyVerificationSchema(snapshot as ScanPipelineDefinitions),
			{ useBaseline: false },
		);
	}
	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: "Scan job pipeline definition snapshot is missing or invalid",
	});
};

const attachStageRuntimeConfigs = <TStage extends FullScanPipelineStage>(
	scanJobId: string,
	stages: readonly TStage[],
): FullScanPipelineStage[] =>
	stages.map((stage) => ({
		...stage,
		runtimeConfig: createStageRuntimeConfig(scanJobId, stage.id),
	}));

const toGenericStageConfig = (stage: ScanPipelineStageConfig) =>
	({
		id: stage.id,
		name: stage.name,
		role: stage.role,
		concurrency: stage.concurrency,
		maxConcurrency: stage.maxConcurrency ?? undefined,
		goal: stage.goal,
		goalPreserving: stage.goalPreserving,
		runtime: stage.runtimeConfig || {},
		inputArtifacts: stage.inputArtifacts,
		outputArtifacts: stage.outputArtifacts,
		jobOutput: stage.jobOutput,
		effects: stage.effects,
		report: stage.report ?? undefined,
		disableable: stage.disableable,
		taskName: stage.taskName || undefined,
		promptValues: stage.promptValues,
		containerNameParts: stage.containerNameParts,
		allowAgentExit: stage.allowAgentExit,
	}) as Parameters<typeof createGenericAgentStageDefinition>[0]["config"];

const resolveResearchTaskNameInput = async (input: {
	scanJobId: string;
	stageName: string;
	value: unknown;
}) => {
	if (
		input.stageName !== "finding-validation" &&
		input.stageName !== "finding-review"
	) {
		return input.value;
	}

	const value = input.value as Record<string, unknown> | null;
	const candidateId =
		value && typeof value.candidateId === "string"
			? value.candidateId
			: value && typeof value.vulnerabilityCandidateId === "string"
				? value.vulnerabilityCandidateId
				: null;
	if (!candidateId) {
		return input.value;
	}

	const candidate = await findVulnerabilityCandidateByIdAndScanJobIdRepo({
		vulnerabilityCandidateId: candidateId,
		scanJobId: input.scanJobId,
	}).catch(() => null);
	if (!candidate) {
		return input.value;
	}

	return {
		...value,
		candidate: { title: candidate.title },
	};
};

const buildPipelineFromStageConfigs = (input: {
	context: FullScanPipelineContext;
	pipelineName: string;
	stageIds: string[];
	edges: ScanPipelineEdgeConfig[];
	groups: ScanPipelineGroupConfig[];
	stageConfigs: Map<string, ScanPipelineStageConfig>;
	schemas: Record<string, Record<string, unknown>>;
	/** Research/goal pipelines fall back to descriptive task-name resolvers. */
	useTaskNameResolvers: boolean;
	runtimeConfigBuilder?: (
		stageId: string,
	) => ReturnType<typeof createStageRuntimeConfig>;
}): PipelineDefinition<
	FullScanPipelineContext,
	FullScanPipelineStage[],
	FullScanPipelineEdge[]
> => {
	const { context } = input;
	const stageRegistry = new Map<string, FullScanPipelineStage>();
	for (const stageId of input.stageIds) {
		const stage = input.stageConfigs.get(stageId);
		if (!stage) throw new Error(`Unknown YAML stage: ${stageId}`);
		const genericStage =
			createGenericAgentStageDefinition<FullScanPipelineContext>({
				config: toGenericStageConfig(stage),
				outputSchema: buildSchemaContract(input.schemas, stage.outputSchema),
				queue: createGenericStageQueueBinding(context, stageId),
			});
		stageRegistry.set(stageId, {
			...genericStage,
			runtimeConfig: input.runtimeConfigBuilder?.(stageId),
		});
	}

	const stages = input.stageIds.map((stageId) => {
		const stage = stageRegistry.get(stageId);
		if (!stage) throw new Error(`Missing generic stage: ${stageId}`);
		return stage;
	});
	const edges = input.edges.map((edgeConfig) => {
		const from = stageRegistry.get(edgeConfig.from);
		const to = stageRegistry.get(edgeConfig.to);
		if (!from || !to) throw new Error(`Invalid YAML edge: ${edgeConfig.name}`);
		return {
			name: edgeConfig.name,
			from,
			to,
			fork: edgeConfig.fork,
			mode: edgeConfig.mode || "map",
			route: edgeConfig.route || undefined,
			outputSchema: buildSchemaContract(input.schemas, edgeConfig.outputSchema),
			transformOutput: async ({
				stageInput,
				stageOutput,
				fromTaskId,
			}: {
				stageInput: unknown;
				stageOutput: unknown;
				fromTaskId: string;
			}) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const mapped = (await transformPipelineEdgeInput(
					{
						mode: edgeConfig.mode,
						foreach: edgeConfig.foreach,
						input: edgeConfig.input,
					},
					{
						ctx: context,
						stageInput,
						stageOutput,
						readJsonFile: async (containerPath) =>
							await readTaskJsonArtifact({
								taskDir: fromTaskDir,
								containerPath,
							}),
						allowedRoots: [fromTaskDir],
					},
				)) as unknown[];
				if (edgeConfig.to !== "goal-hunt") {
					return mapped;
				}
				const huntTasks = await listTasksByScanJobAndStageRepo({
					scanJobId: context.scanJob.scanJobId,
					stageName: "goal-hunt",
				});
				const dispatchedHuntGoalIds = collectDispatchedHuntGoalIds(
					await Promise.all(
						huntTasks.map(async (task) => ({
							input: await reconstructTaskInput(task).catch(() => null),
						})),
					),
				);
				return filterNewHuntInputs(mapped, dispatchedHuntGoalIds);
			},
			createTasks: async (taskInput: {
				ctx: FullScanPipelineContext;
				fromTaskId: string;
				stageInput: unknown;
				stageOutput: unknown;
				nextInputObjects: unknown[];
				sourceMessageId: string;
				sourceEdgeName: string;
				sourceItemIndexes?: number[];
			}) => {
				const {
					ctx,
					fromTaskId,
					stageInput: parentStageInput,
					stageOutput,
					nextInputObjects,
					sourceMessageId,
					sourceEdgeName,
					sourceItemIndexes,
				} = taskInput;
				const parentInput =
					parentStageInput &&
					typeof parentStageInput === "object" &&
					!Array.isArray(parentStageInput)
						? (parentStageInput as Record<string, unknown>)
						: {};
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const targetConfig = input.stageConfigs.get(edgeConfig.to);
				if (!targetConfig)
					throw new Error(`Missing target stage: ${edgeConfig.to}`);
				const taskIds: string[] = [];
				for (const [offset, nextInput] of nextInputObjects.entries()) {
					const index = sourceItemIndexes?.[offset] ?? offset;
					const input = {
						...(nextInput as Record<string, unknown>),
					};
					const taskNameInput = input.useTaskNameResolvers
						? await resolveResearchTaskNameInput({
								scanJobId: context.scanJob.scanJobId,
								stageName: edgeConfig.to,
								value: input,
							})
						: input;
					const renderedTaskName = targetConfig.taskName
						? String(
								await renderPipelineTemplate(targetConfig.taskName, {
									ctx,
									stageInput: input.useTaskNameResolvers
										? taskNameInput
										: input,
									stageOutput: null,
									readJsonFile: async (containerPath) =>
										await readTaskJsonArtifact({
											taskDir: fromTaskDir,
											containerPath,
										}),
									allowedRoots: [fromTaskDir],
								}),
							).trim()
						: "";
					// Prefer YAML taskName templates; fall back to descriptive resolvers
					// for research/tob-goal (not "StageName 1" fan-out indexes).
					const taskName =
						renderedTaskName &&
						!/\(\s*\)$/.test(renderedTaskName) &&
						!/:\s*$/.test(renderedTaskName)
							? renderedTaskName
							: input.useTaskNameResolvers
								? resolveStageTaskName(edgeConfig.to, taskNameInput)
								: `${targetConfig.name} ${index + 1}`;
					const identity = createDownstreamChildIdentity({
						sourceMessageId,
						sourceEdgeName,
						sourceItemIndex: index,
					});
					const taskId = identity.taskId;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: edgeConfig.to,
						taskName,
					});
					for (const artifact of edgeConfig.artifacts) {
						const fromValue = await renderPipelineTemplate(artifact.from, {
							ctx,
							stageInput: {
								...parentInput,
								...input,
							},
							stageOutput,
							readJsonFile: async (containerPath) =>
								await readTaskJsonArtifact({
									taskDir: fromTaskDir,
									containerPath,
								}),
							allowedRoots: [fromTaskDir],
						});
						if (
							(fromValue === null ||
								fromValue === undefined ||
								fromValue === "") &&
							!artifact.required
						) {
							continue;
						}
						if (
							fromValue === null ||
							fromValue === undefined ||
							fromValue === ""
						) {
							throw new Error(
								`Required edge artifact ${artifact.from} resolved to an empty value`,
							);
						}
						const copied =
							typeof fromValue === "string"
								? await copyArtifactToDownstreamInput({
										fromTaskDir,
										fromPath: fromValue,
										toTaskDir,
										toRelativePath: artifact.to,
									})
								: await writeDownstreamInputArtifact({
										toTaskDir,
										toRelativePath: artifact.to,
										value: fromValue,
									});
						if (artifact.inputField) {
							input[artifact.inputField] = copied;
						}
					}
					const lifecycle = targetConfig.goal ? "goal" : "turn";
					const task = await createTaskRepo({
						taskId,
						scanJobId: context.scanJob.scanJobId,
						name: taskName,
						stageName: edgeConfig.to,
						lifecycle,
						sourceMessageId: identity.sourceMessageId,
						sourceEdgeName: identity.sourceEdgeName,
						sourceItemIndex: identity.sourceItemIndex,
						priority:
							typeof input.priority === "number" ? input.priority : null,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		};
	});
	return createPipelineDefinition<
		FullScanPipelineContext,
		FullScanPipelineStage[],
		FullScanPipelineEdge[]
	>({
		name: input.pipelineName,
		stages,
		edges: edges as FullScanPipelineEdge[],
		groups: buildPipelineGroupsFromConfigs(input.groups, stageRegistry),
	});
};

const buildGenericYamlPipeline = (
	context: FullScanPipelineContext,
	pipelineId: string,
): PipelineDefinition<
	FullScanPipelineContext,
	FullScanPipelineStage[],
	FullScanPipelineEdge[]
> => {
	const definitions = resolveScanJobPipelineDefinitions(context.scanJob);
	const pipelineConfig = definitions.pipelines[pipelineId];
	if (!pipelineConfig) {
		throw new Error(`Unknown YAML pipeline: ${pipelineId}`);
	}
	const stageConfigs = new Map(
		definitions.stages.map((stage) => [stage.id, stage] as const),
	);
	return buildPipelineFromStageConfigs({
		context,
		pipelineName: pipelineConfig.name,
		stageIds: pipelineConfig.stageIds,
		edges: pipelineConfig.edges,
		groups: pipelineConfig.groups,
		stageConfigs,
		schemas: definitions.schemas,
		useTaskNameResolvers:
			pipelineId.includes("research") || pipelineId.includes("tob-goal"),
		runtimeConfigBuilder: (stageId) =>
			createStageRuntimeConfig(context.scanJob.scanJobId, stageId),
	});
};

/**
 * V3 runtime path: build the runner pipeline from a frozen compiled snapshot
 * instead of the V2 definitions / scanType branch. Runtime config getters
 * read straight from the snapshot so the job never touches filesystem
 * definitions or `scanType`.
 */
const toStageConfigFromCompiled = (
	stage: CompiledStageV3,
): ScanPipelineStageConfig => ({
	id: stage.id,
	key: stage.id,
	name: stage.name,
	role: stage.role,
	group: stage.group,
	concurrency: stage.concurrency,
	maxConcurrency: stage.maxConcurrency ?? null,
	disableable: stage.disableable,
	goal: stage.goal ?? false,
	goalPreserving: stage.goalPreserving ?? false,
	description: stage.description ?? null,
	inputSchema: stage.inputSchema ?? null,
	outputSchema: stage.outputSchema ?? null,
	runtimeConfig: {
		agentProfile: stage.runtime.agentProfileId ?? null,
		...(stage.runtime.goalSession
			? { goalSession: stage.runtime.goalSession }
			: {}),
		persistent: stage.runtime.persistent ?? null,
		reuseContainer: stage.runtime.reuseContainer ?? null,
		nullableOutput: stage.runtime.nullableOutput ?? null,
		cwd: stage.runtime.cwd ?? null,
		skills: stage.runtime.skills ?? null,
		mcp: stage.runtime.mcp ?? null,
		prompt: stage.runtime.prompt,
		promptFile: null,
		inputDelivery: stage.runtime.inputDelivery ?? "prompt",
		pollPrompt: stage.runtime.pollPrompt ?? null,
		messageNotification: stage.runtime.messageNotification === true,
		outputSuffix: stage.runtime.outputSuffix === "omit" ? "omit" : "include",
		prepareRepository: stage.runtime.prepareRepository !== "none",
		includePolicy: stage.runtime.includePolicy ?? false,
		// Legacy runtime-level fields are unused in V3 (stage-level
		// inputArtifacts/outputSchema are authoritative).
		inputArtifacts: null,
		outputSchema: null,
	},
	inputArtifacts: stage.inputArtifacts ?? [],
	outputArtifacts: stage.outputArtifacts ?? [],
	jobOutput: stage.jobOutput ?? false,
	effects: stage.effects ?? [],
	report: stage.report ?? null,
	taskName: stage.taskName ?? null,
	promptValues: stage.promptValues ?? {},
	containerNameParts: stage.containerNameParts ?? [],
	allowAgentExit: stage.allowAgentExit ?? false,
});

const toEdgeConfigFromCompiled = (
	edge: CompiledPipelineDefinition["edges"][number],
): ScanPipelineEdgeConfig => ({
	id: edge.id,
	name: edge.name,
	from: edge.from,
	to: edge.to,
	fork: edge.fork,
	mode: edge.mode ?? null,
	foreach: edge.foreach ?? null,
	input: edge.input ?? null,
	outputSchema: edge.outputSchema ?? null,
	artifacts: (edge.artifacts ?? []).map((artifact) => ({
		from: artifact.from,
		to: artifact.to,
		inputField: artifact.inputField,
		required: artifact.required,
	})),
	route: edge.route ?? null,
});

const createCompiledStageRuntimeConfig = (
	compiled: CompiledPipelineDefinition,
	stageId: string,
) => {
	const stage = compiled.stages.find((item) => item.id === stageId);
	if (!stage) {
		throw new Error(`Compiled stage not found: ${stageId}`);
	}
	const runtime = stage.runtime;
	return {
		getConcurrency: async () => stage.concurrency,
		getAgentProfile: async () => runtime.agentProfileId ?? null,
		getGoalSession: async () => runtime.goalSession ?? null,
		getPersistent: async () => runtime.persistent ?? null,
		getReuseContainer: async () => runtime.reuseContainer ?? null,
		getNullableOutput: async () => runtime.nullableOutput ?? null,
		getCwd: async () => runtime.cwd ?? null,
		getSkills: async () => runtime.skills ?? [],
		getMcp: async () => runtime.mcp ?? [],
		getPrompt: async () => runtime.prompt,
		getInputArtifacts: async () => null,
		getOutputSchema: async () => stage.outputSchema ?? null,
	};
};

export const buildPipelineFromCompiled = (
	context: FullScanPipelineContext,
	compiled: CompiledPipelineDefinition,
): PipelineDefinition<
	FullScanPipelineContext,
	FullScanPipelineStage[],
	FullScanPipelineEdge[]
> => {
	const stageConfigs = new Map(
		compiled.stages.map(
			(stage) => [stage.id, toStageConfigFromCompiled(stage)] as const,
		),
	);
	const edges = compiled.edges.map(toEdgeConfigFromCompiled);
	const groups = (compiled.groups ?? []).map((group) => ({
		id: group.id,
		name: group.name,
		leader: group.leader,
		members: group.members,
	}));
	return buildPipelineFromStageConfigs({
		context,
		pipelineName: compiled.name,
		stageIds: compiled.stages.map((stage) => stage.id),
		edges,
		groups,
		stageConfigs,
		schemas: compiled.schemas,
		useTaskNameResolvers: compiled.stages.some(
			(stage) =>
				(stage.effects ?? []).some(
					(effect) =>
						effect.type === "research-registry" ||
						effect.type === "tob-goal-registry",
				) ||
				(stage.runtime.plugins ?? []).some(
					(plugin) =>
						plugin === "research-track" || plugin === "research-deadline",
				),
		),
		runtimeConfigBuilder: (stageId) =>
			createCompiledStageRuntimeConfig(compiled, stageId) as ReturnType<
				typeof createStageRuntimeConfig
			>,
	});
};

export const buildYamlPipeline = buildGenericYamlPipeline;

const buildCandidateObject = (candidate: {
	vulnerabilityCandidateId: string;
	producerTaskId: string | null;
	functionId: string | null;
	title: string;
	description: string | null;
	filePath: string | null;
	line: number | null;
	vulnerabilityType: string | null;
	confidence: number | null;
	score: number | null;
	targetId: string | null;
	targetKind: string | null;
	claim: string;
	rootCauseKey: string | null;
	evidence: Evidence[];
	attackerControl: string | null;
	affectedSink: string | null;
	preconditions: string[];
	quickDisproofAttempt: string | null;
	needsFuzzing: boolean;
	needsManualAnalysis: boolean;
}): CanonicalCandidate => {
	const parsedTargetKind = targetKindSchema
		.nullable()
		.safeParse(candidate.targetKind);
	return {
		id: candidate.vulnerabilityCandidateId,
		functionId: candidate.functionId || candidate.producerTaskId,
		title: candidate.title,
		description: candidate.description || "",
		filePath: candidate.filePath,
		line: candidate.line,
		vulnerabilityType: candidate.vulnerabilityType,
		confidence: candidate.confidence,
		score: candidate.score,
		targetId: candidate.targetId,
		targetKind: parsedTargetKind.success ? parsedTargetKind.data : null,
		claim: candidate.claim,
		rootCauseKey: candidate.rootCauseKey,
		evidence: candidate.evidence,
		attackerControl: candidate.attackerControl,
		affectedSink: candidate.affectedSink,
		preconditions: candidate.preconditions,
		quickDisproofAttempt: candidate.quickDisproofAttempt,
		needsFuzzing: candidate.needsFuzzing,
		needsManualAnalysis: candidate.needsManualAnalysis,
	};
};

const buildFullScanPipelineContext = async (
	scanJobId: string,
	options?: { validateDatasetToolsImage?: boolean },
): Promise<FullScanPipelineContext> => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const executionContext = await resolveScanExecutionContext(scanJob, options);
	return {
		scanJob,
		executionContext,
		scanJobId: scanJob.scanJobId,
		projectName: executionContext.projectName,
		serviceName: executionContext.serviceName,
	};
};

const resolveFullScanTaskRuntimeDir = async (
	context: FullScanPipelineContext,
	input: {
		taskId: string;
		stageName: string;
		taskName: string;
	},
) =>
	await resolveTaskRuntimeDirForTask({
		scanJobId: context.scanJob.scanJobId,
		projectName: context.projectName,
		serviceName: context.serviceName,
		stageName: input.stageName,
		taskName: input.taskName,
		taskId: input.taskId,
	});

const resolveExistingFullScanTaskRuntimeDir = async (
	context: FullScanPipelineContext,
	task: Task,
) =>
	await resolveFullScanTaskRuntimeDir(context, {
		taskId: task.taskId,
		stageName: task.stageName,
		taskName: task.name,
	});

const copyArtifactToDownstreamInput = async (input: {
	fromTaskDir: string;
	fromPath: string;
	toTaskDir: string;
	toRelativePath: string;
}) =>
	await copyTaskJsonArtifact({
		fromTaskDir: input.fromTaskDir,
		fromContainerPath: input.fromPath,
		toTaskDir: input.toTaskDir,
		toRelativePath: input.toRelativePath,
	});

const writeDownstreamInputArtifact = async (input: {
	toTaskDir: string;
	toRelativePath: string;
	value: unknown;
}) =>
	await writeTaskJsonArtifact({
		taskDir: input.toTaskDir,
		relativePath: input.toRelativePath,
		value: input.value,
	});

const copyAnalysisBaseInputArtifacts = async (input: {
	fromTaskDir: string;
	toTaskDir: string;
	stageInput: CandidateAnalysisTaskInput;
}): Promise<CandidateAnalysisTaskInput> => {
	const base: CandidateAnalysisTaskInput = {
		scanJob: input.stageInput.scanJob,
		repositoryPath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.repositoryPath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/repository.json",
		}),
		modulePath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.modulePath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/module.json",
		}),
		functionPath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.functionPath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/target.json",
		}),
		candidatePath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.candidatePath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/candidate.json",
		}),
	};
	if (input.stageInput.analysisReportTemplatePath) {
		base.analysisReportTemplatePath = await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.analysisReportTemplatePath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/analysis-report-template.md",
		});
	}
	if (input.stageInput.feedbackPath) {
		base.feedbackPath = await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.feedbackPath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/feedback.json",
		});
	}
	return base;
};

const writeAnalysisReportTemplateInput = async (input: {
	scanJob: ScanJob;
	toTaskDir: string;
}) => {
	if (!input.scanJob.applicationId || input.scanJob.composeId) {
		return null;
	}
	const application = await findApplicationById(input.scanJob.applicationId);
	const template = application.analysisReportTemplate?.trim();
	if (!template) {
		return null;
	}
	return await writeTaskTextArtifact({
		taskDir: input.toTaskDir,
		relativePath: "inputs/analysis-report-template.md",
		value: template,
	});
};

const runFullScan = async (
	scanJobId: string,
	options?: {
		enqueueInitialRepositoryTask?: boolean;
		awaitCompletion?: boolean;
	},
) => {
	const enqueueInitialRepositoryTask =
		options?.enqueueInitialRepositoryTask ?? true;
	const awaitCompletion = options?.awaitCompletion ?? true;
	await assertScanJobNotCancelled(scanJobId);
	console.log(
		"[full-scan]",
		JSON.stringify({
			event: "runFullScan.start",
			scanJobId,
		}),
	);
	const context = await buildFullScanPipelineContext(scanJobId);
	const pipeline = buildYamlPipeline(context, context.scanJob.pipelineId);

	try {
		await assertScanJobNotCancelled(scanJobId);
		if (enqueueInitialRepositoryTask) {
			console.log(
				"[full-scan]",
				JSON.stringify({
					event: "runFullScan.repository.pending",
					scanJobId,
				}),
			);
		}
		await assertScanJobNotCancelled(scanJobId);
		if (awaitCompletion) {
			await runPipeline(pipeline, context);
		} else {
			startPipelineRuntime(pipeline, context);
		}
		console.log(
			"[full-scan]",
			JSON.stringify({
				event: awaitCompletion
					? "runFullScan.completed"
					: "runFullScan.runtime_started",
				scanJobId,
			}),
		);
	} catch (error) {
		console.log(
			"[full-scan]",
			JSON.stringify({
				event: "runFullScan.failed",
				scanJobId,
				errorMessage: error instanceof Error ? error.message : String(error),
			}),
		);
		throw error;
	}
};

const runDeltaScan = async (
	scanJobId: string,
	options?: {
		enqueueInitialDeltaScopeTask?: boolean;
		awaitCompletion?: boolean;
	},
) => {
	const enqueueInitialDeltaScopeTask =
		options?.enqueueInitialDeltaScopeTask ?? true;
	const awaitCompletion = options?.awaitCompletion ?? true;
	await assertScanJobNotCancelled(scanJobId);
	console.log(
		"[delta-scan]",
		JSON.stringify({
			event: "runDeltaScan.start",
			scanJobId,
		}),
	);
	const context = await buildFullScanPipelineContext(scanJobId);
	const pipeline = buildYamlPipeline(context, context.scanJob.pipelineId);

	try {
		await assertScanJobNotCancelled(scanJobId);
		if (enqueueInitialDeltaScopeTask) {
			console.log(
				"[delta-scan]",
				JSON.stringify({
					event: "runDeltaScan.delta_scope.pending",
					scanJobId,
				}),
			);
		}
		await assertScanJobNotCancelled(scanJobId);
		if (awaitCompletion) {
			await runPipeline(pipeline, context);
		} else {
			startPipelineRuntime(pipeline, context);
		}
		console.log(
			"[delta-scan]",
			JSON.stringify({
				event: awaitCompletion
					? "runDeltaScan.completed"
					: "runDeltaScan.runtime_started",
				scanJobId,
			}),
		);
	} catch (error) {
		console.log(
			"[delta-scan]",
			JSON.stringify({
				event: "runDeltaScan.failed",
				scanJobId,
				errorMessage: error instanceof Error ? error.message : String(error),
			}),
		);
		throw error;
	}
};

const runResearchScan = async (
	scanJobId: string,
	options?: {
		enqueueInitialResearchTask?: boolean;
		awaitCompletion?: boolean;
	},
) => {
	const awaitCompletion = options?.awaitCompletion ?? true;
	await assertScanJobNotCancelled(scanJobId);
	const context = await buildFullScanPipelineContext(scanJobId);
	const pipeline = buildYamlPipeline(context, context.scanJob.pipelineId);
	await assertScanJobNotCancelled(scanJobId);
	if (awaitCompletion) {
		await runPipeline(pipeline, context);
	} else {
		startPipelineRuntime(pipeline, context);
	}
};

const runTobGoalScan = async (
	scanJobId: string,
	options?: {
		enqueueInitialGoalCraftTask?: boolean;
		awaitCompletion?: boolean;
	},
) => {
	const awaitCompletion = options?.awaitCompletion ?? true;
	await assertScanJobNotCancelled(scanJobId);
	const context = await buildFullScanPipelineContext(scanJobId);
	const pipeline = buildYamlPipeline(context, context.scanJob.pipelineId);
	await assertScanJobNotCancelled(scanJobId);
	if (awaitCompletion) {
		await runPipeline(pipeline, context);
	} else {
		startPipelineRuntime(pipeline, context);
	}
};

const startScanPipelineRuntimeForExistingQueues = async (scanJobId: string) => {
	await runPipelineFromSnapshot(scanJobId, { enqueueInitialRootTask: false });
};

export const pauseScanJob = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (scanJob.status === "canceled" || scanJob.status === "finished") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only pending or running scan jobs can be paused",
		});
	}
	if (scanJob.status === "paused") {
		return {
			paused: true,
			scanJobId,
			stoppedRuntimes: 0,
		};
	}

	const paused = await transitionScanJobStatusRepo({
		scanJobId,
		from: ["pending", "running"],
		to: "paused",
	});
	if (!paused.updated) {
		if (paused.job?.status === "paused") {
			return { paused: true, scanJobId, stoppedRuntimes: 0 };
		}
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Scan job cannot be paused from ${paused.job?.status ?? "missing"}`,
		});
	}
	const stoppedRuntimes = stopPipelineRuntimesForScanJob(scanJobId);
	return {
		paused: true,
		scanJobId,
		stoppedRuntimes,
	};
};

export const resumeScanJob = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (scanJob.status !== "paused") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only paused scan jobs can be resumed",
		});
	}

	const resumed = await transitionScanJobStatusRepo({
		scanJobId,
		from: ["paused"],
		to: "running",
	});
	if (!resumed.updated) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Scan job cannot be resumed from ${resumed.job?.status ?? "missing"}`,
		});
	}
	await startScanPipelineRuntimeForExistingQueues(scanJobId);
	return {
		resumed: true,
		scanJobId,
	};
};

const loadCompiledPipelineSnapshot = (scanJob: ScanJob) => {
	const snapshot = scanJob.pipelineCompiledSnapshot;
	if (!snapshot || typeof snapshot !== "object") {
		throw new Error(
			`Scan job ${scanJob.scanJobId} has no compiled pipeline snapshot`,
		);
	}
	return snapshot as unknown as CompiledPipelineDefinition;
};

/**
 * V3 run entry: builds the pipeline from the job's frozen compiled snapshot
 * and dispatches it through the same generic runtime as the legacy paths.
 */
const runPipelineFromSnapshot = async (
	scanJobId: string,
	options?: { enqueueInitialRootTask?: boolean },
) => {
	const enqueueInitialRootTask = options?.enqueueInitialRootTask ?? true;
	const awaitCompletion = options
		? "awaitCompletion" in options && options.awaitCompletion === false
			? false
			: true
		: true;
	await assertScanJobNotCancelled(scanJobId);
	console.log(
		"[scan-v3]",
		JSON.stringify({ event: "runPipelineFromSnapshot.start", scanJobId }),
	);
	const context = await buildFullScanPipelineContext(scanJobId);
	const compiled = loadCompiledPipelineSnapshot(context.scanJob);
	const pipeline = buildPipelineFromCompiled(context, compiled);

	try {
		await assertScanJobNotCancelled(scanJobId);
		if (enqueueInitialRootTask) {
			await createV3RootTask(context, compiled);
			console.log(
				"[scan-v3]",
				JSON.stringify({ event: "root.enqueued", scanJobId }),
			);
		}
		await assertScanJobNotCancelled(scanJobId);
		if (awaitCompletion) {
			await runPipeline(pipeline, context);
		} else {
			startPipelineRuntime(pipeline, context);
		}
	} catch (error) {
		console.log(
			"[scan-v3]",
			JSON.stringify({
				event: "runPipelineFromSnapshot.failed",
				scanJobId,
				errorMessage: error instanceof Error ? error.message : String(error),
			}),
		);
		throw error;
	}
};

export const runScanJobInContainer = async (
	scanJobId: string,
	options?: {
		enqueueInitialRepositoryTask?: boolean;
	},
) => {
	await assertScanJobNotCancelled(scanJobId);
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (!scanJob.pipelineVersionId || !scanJob.pipelineCompiledSnapshot) {
		throw new Error("Scan job has no compiled pipeline snapshot");
	}
	await runPipelineFromSnapshot(scanJobId, {
		enqueueInitialRootTask: options?.enqueueInitialRepositoryTask ?? true,
	});
};

const resolveHostPathToScanContextContainerPath = async (
	scanJob: ScanJob,
	hostPath: string,
) => {
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	const resolvedRoot = path.resolve(projectProfileHostContextRoot);
	const resolvedTarget = path.resolve(hostPath);
	const relativePath = path.relative(resolvedRoot, resolvedTarget);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		throw new Error(
			`Path is outside project profile context root: ${hostPath}`,
		);
	}

	return path.posix.join(
		"/scan-context",
		relativePath.split(path.sep).join("/"),
	);
};

const shouldVerifyFromAnalysisResult = (result: string | null | undefined) =>
	result === "real_vulnerability" || result === "likely_vulnerability";

const readCandidateIdFromTask = (task: Task): string | null => {
	const input = asTaskRecord(null);
	const candidate =
		asTaskRecord(input?.candidate) ||
		asTaskRecord(asTaskRecord(input?.analysisResult)?.candidate);
	return readString(candidate, "id");
};

const findCandidateTaskByStage = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
	stageName:
		| typeof SCAN_STAGE_IDS.analyzeFinding
		| typeof SCAN_STAGE_IDS.verifyFinding,
) =>
	(
		await listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName,
		})
	).find((task) => {
		return readCandidateIdFromTask(task) === vulnerabilityCandidateId;
	}) || null;

export const listScanStageWaitingMessageJobs = async (input: {
	scanJobId: string;
	stageName: string;
}) => {
	const queue = getScanStageQueue(input.scanJobId, input.stageName);
	const jobs = await listAllQueueJobs(queue, ["prioritized", "waiting"]);
	return jobs.flatMap((job) => {
		const parsed = asWaitingMessageQueueJob(job.data);
		if (!parsed) {
			return [];
		}
		return [
			{
				id: String(job.id ?? ""),
				...parsed,
				createdAt: job.timestamp
					? new Date(job.timestamp).toISOString()
					: new Date().toISOString(),
				remove: () => job.remove().then(() => undefined).catch(() => {}),
			},
		];
	});
};

export const removeScanStageMessageJobsByMessageId = async (input: {
	scanJobId: string;
	stageName: string;
	messageId: string;
}) => {
	const jobs = await listScanStageWaitingMessageJobs(input);
	const matched = jobs.filter(
		(job) => job.messageId === input.messageId,
	);
	for (const job of matched) {
		await job.remove();
	}
	return matched.map((job) => job.messageId);
};

/**
 * V3 root task: one pending task row with the standardized root context
 * `{ run, target, repository, limits }`. The runner launches it from the
 * database; Redis only carries downstream Messages. The compiled root
 * stage's promptValues read `$ctx.scanJob.*` which the expression resolver
 * supplies from the frozen scan job row.
 */
const createV3RootTask = async (
	context: FullScanPipelineContext,
	compiled: CompiledPipelineDefinition,
) => {
	const scanJob = context.scanJob;
	const rootStage = compiled.stages.find((stage) => stage.id === compiled.root);
	const taskId = scanJob.repositoryTaskId || scanJob.scanJobId;
	const existing = await findTaskByIdRepo(taskId).catch(() => null);
	if (existing) {
		return;
	}
	const taskName = rootStage?.name ?? compiled.root;
	const taskDir = await resolveFullScanTaskRuntimeDir(context, {
		taskId,
		stageName: compiled.root,
		taskName,
	});
	await writeTaskJsonArtifact({
		taskDir,
		relativePath: "inputs/repository.json",
		value: {
			id: scanJob.scanJobId,
			name: context.projectName,
			summary: `Repository context for ${context.projectName}`,
			languages: [],
			buildSystems: [],
			runtimeDirectories: [],
			downrankedDirectories: [],
			notes: [],
			targetRef: scanJob.targetRef ?? null,
			targetTag: scanJob.targetTag ?? null,
			commitSha: scanJob.commitSha ?? null,
			baseSha: scanJob.baseSha ?? null,
			commitWindow: scanJob.commitWindow ?? 3,
		},
	});
	await createTaskRepo({
		taskId,
		scanJobId: scanJob.scanJobId,
		name: taskName,
		stageName: compiled.root,
		lifecycle: rootStage?.goal ? "goal" : "turn",
		status: "pending",
		allowedJobStatuses: ["pending", "running"],
	});
};

const clearTaskArtifactsForRetry = async (scanJobId: string, task: Task) => {
	if (!isRetryableTaskStageName(task.stageName)) {
		return;
	}

	await stopScanContainer(task.containerName).catch(() => false);
	const taskDirPath = await resolveTaskArtifactsDir({
		scanJobId,
		stageName: task.stageName,
		taskName: task.name,
	});
	await fs.rm(taskDirPath, { recursive: true, force: true }).catch(() => {});
};

const MANUAL_STOP_MESSAGE = "Stopped manually";

const isManuallyCancelledScanJob = (
	scanJob: Pick<ScanJob, "status" | "errorMessage"> | null | undefined,
) => Boolean(scanJob && scanJob.status === "canceled");

const OPEN_TASK_STATUSES: Task["status"][] = [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
];

const assertScanJobNotCancelled = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId).catch(() => null);
	if (isManuallyCancelledScanJob(scanJob)) {
		const error = new Error(`Scan job ${scanJobId} was cancelled`);
		error.name = "ScanJobCancelledError";
		throw error;
	}
};

export const cancelScanTask = async (taskId: string) => {
	const task = await findTaskByIdRepo(taskId);
	if (!task) {
		throw new Error(`Task ${taskId} not found`);
	}

	const canceledTask = await transitionTaskStatusRepo({
		taskId,
		from: OPEN_TASK_STATUSES,
		to: "canceled",
		patch: { errorMessage: MANUAL_STOP_MESSAGE },
	});
	if (!canceledTask) {
		return await findTaskByIdRepo(taskId);
	}

	await stopScanContainer(task.containerName).catch(() => false);
	await persistTaskAgentHomeTokenUsage({
		taskId: canceledTask.taskId,
		scanJobId: canceledTask.scanJobId,
		threadId: canceledTask.threadId,
		provider: canceledTask.agentProfile?.provider,
	}).catch(() => null);

	return canceledTask;
};

export const cancelScanJob = async (
	scanJobId: string,
	options?: { reason?: string; message?: string },
) => {
	const stopMessage = options?.message ?? MANUAL_STOP_MESSAGE;
	const terminationReason = options?.reason ?? "manual_cancel";
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const cancellation = await cancelScanJobRepo({
		scanJobId,
		errorMessage: stopMessage,
		terminationReason,
	});
	if (cancellation.outcome === "not_found") {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	const stoppedRuntimes = stopPipelineRuntimesForScanJob(scanJobId);

	const [allTasks, stageGroups, laneRuntimes, dockerScanContainers] =
		await Promise.all([
			listTasksByScanJobIdRepo(scanJobId),
			listStageGroupInstancesByScanJobIdRepo(scanJobId),
			listStageLaneRuntimesByScanJobIdRepo(scanJobId).catch(() => []),
			listDockerContainersForScanJob(scanJobId),
		]);
	const tasksToCancel = cancellation.tasksToStop;
	let pipeline: { rootStageId: string; stageIds: readonly string[] } | null =
		null;
	try {
		const pipelineDefinitions = resolveScanJobPipelineDefinitions(scanJob);
		pipeline = pipelineDefinitions.pipelines[scanJob.pipelineId] ?? null;
	} catch (error) {
		console.warn(
			"[scan-cancel] pipeline snapshot unavailable; continuing resource cleanup",
			JSON.stringify({ scanJobId, error: String(error) }),
		);
	}
	const stageNames = pipeline
		? [...pipeline.stageIds]
		: [...new Set(allTasks.map((task) => task.stageName))];

	const containerNames = new Set<string>();

	for (const task of allTasks) {
		if (task.containerName) {
			containerNames.add(task.containerName);
		}
	}
	for (const task of tasksToCancel) {
		if (task.containerName) {
			containerNames.add(task.containerName);
		}
	}
	for (const lane of laneRuntimes) {
		if (lane.containerName) {
			containerNames.add(lane.containerName);
		}
	}
	for (const containerName of dockerScanContainers) {
		containerNames.add(containerName);
	}

	await Promise.all([
		...stageNames.map((stageName) =>
			obliterateScanStageQueue(scanJobId, stageName).catch((error) => {
				console.warn(
					"[scan-cancel] stage queue cleanup failed",
					JSON.stringify({
						scanJobId,
						stageName,
						error: String(error),
					}),
				);
			}),
		),
		...stageGroups
			.filter((group) => group.status === "active")
			.map((group) =>
				obliterateScanStageGroupQueues(
					scanJobId,
					group.groupInstanceId,
					stageNames,
				).catch((error) => {
					console.warn(
						"[scan-cancel] stage group cleanup failed",
						JSON.stringify({
							scanJobId,
							groupInstanceId: group.groupInstanceId,
							error: String(error),
						}),
					);
				}),
			),
	]);
	// The scan container may disappear before cancellation reaches this point.
	// Task snapshots retain the tools image and are a more reliable cleanup image.
	let scanContainerImage: string | null = null;
	for (const containerName of containerNames) {
		if (scanContainerImage) break;
		const { stdout } = await execAsync(
			`docker inspect ${containerName} --format '{{.Config.Image}}'`,
		).catch(() => ({ stdout: "" }));
		if (stdout.trim()) {
			scanContainerImage = stdout.trim();
			break;
		}
	}
	if (!scanContainerImage) {
		scanContainerImage = await resolveCheckoutToolsDefinition()
			.then((definition) => definition.imageTag)
			.catch(() => null);
	}
	const stoppedContainers = (
		await Promise.all(
			[...containerNames].map((name) => stopScanContainer(name)),
		)
	).filter(Boolean).length;
	await cleanupScanJobCredentialFiles(scanJob, scanContainerImage).catch(
		(error) => {
			console.warn(
				"[scan-cancel] credential cleanup failed",
				JSON.stringify({ scanJobId, error: String(error) }),
			);
		},
	);

	await resetStageLaneRuntimesByScanJobIdRepo(scanJobId).catch((error) => {
		console.warn(
			"[scan-cancel] lane cleanup failed",
			JSON.stringify({ scanJobId, error: String(error) }),
		);
	});

	await persistJobAgentHomeTokenUsage({ scanJobId }).catch((error) => {
		console.warn(
			"[scan-cancel] token usage sync failed",
			JSON.stringify({ scanJobId, error: String(error) }),
		);
	});

	return {
		cancelled: cancellation.outcome === "canceled",
		alreadyStopped: cancellation.outcome === "already_stopped",
		scanJobId: scanJob.scanJobId,
		stoppedRuntimes,
		stoppedContainers,
		clearedTasks: tasksToCancel.length,
	};
};

const buildJoinedCandidateInput = async (vulnerabilityCandidateId: string) => {
	const candidate = await findVulnerabilityCandidateByIdRepo(
		vulnerabilityCandidateId,
	);
	if (!candidate.producerTaskId) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} is missing producerTaskId; cannot build joined candidate input`,
		);
	}
	const [scanJob, producerTask] = await Promise.all([
		findScanJobByIdRepo(candidate.scanJobId),
		findTaskByIdRepo(candidate.producerTaskId),
	]);
	if (
		producerTask.scanJobId !== candidate.scanJobId ||
		producerTask.stageName !== SCAN_STAGE_IDS.scanTarget
	) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} references non-candidate-producing task ${candidate.producerTaskId}`,
		);
	}
	const functionInput = asTaskRecord(
		await reconstructTaskInput(producerTask).catch(() => null),
	);
	let moduleObject = asTaskRecord(
		functionInput?.module,
	) as CanonicalModule | null;
	let functionObject = asTaskRecord(
		functionInput?.function,
	) as CanonicalFunction | null;
	const modulePath = readString(functionInput, "modulePath");
	if (!moduleObject && modulePath) {
		moduleObject = await readTaskJsonArtifactForTask<CanonicalModule>(
			producerTask,
			modulePath,
		).catch(() => null);
	}
	const functionPath = readString(functionInput, "functionPath");
	if (!functionObject && functionPath) {
		functionObject = await readTaskJsonArtifactForTask<CanonicalFunction>(
			producerTask,
			functionPath,
		).catch(() => null);
	}
	if (!moduleObject || !functionObject) {
		throw new Error(
			`Candidate-producing task ${producerTask.taskId} is missing module/function input metadata`,
		);
	}
	const joinedModule = {
		...moduleObject,
		scanJob,
	};
	return {
		producerTaskId: candidate.producerTaskId,
		candidate: {
			...buildCandidateObject(candidate),
			scanJob,
			module: joinedModule,
			function: {
				...functionObject,
				scanJob,
				module: joinedModule,
			},
		},
	};
};

const buildJoinedAnalysisResultInput = async (
	vulnerabilityCandidateId: string,
): Promise<CandidateVerificationTaskInput> => {
	const candidateInput = await buildJoinedCandidateInput(
		vulnerabilityCandidateId,
	);
	const analysisResult = await findLatestAnalysisResultByCandidateIdRepo({
		scanJobId: candidateInput.candidate.scanJob.scanJobId,
		vulnerabilityCandidateId,
		producerTaskId: candidateInput.producerTaskId,
	});
	if (!analysisResult) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} has no persisted analysis result`,
		);
	}
	if (!analysisResult.result) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} has analysis task without result`,
		);
	}
	return {
		analysisResult: {
			id: analysisResult.taskId,
			result: analysisResult.result,
			summary: analysisResult.summary || "",
			confidence: analysisResult.confidence,
			score: analysisResult.score,
			reportPath: analysisResult.reportPath,
			runtimeSeconds: analysisResult.runtimeSeconds,
			hypothesis: analysisResult.summary || "",
			evidenceTable: [],
			attackPath: [],
			blockers: [],
			rulingRationale:
				"Manual verification requested from an existing analysis result.",
			missingEvidenceRequest: [],
			feedbackHistory: [],
			status: analysisResult.status,
			analysisFingerprint: buildAnalysisFingerprint({
				id: analysisResult.taskId,
				result: analysisResult.result,
				summary: analysisResult.summary || "",
				confidence: analysisResult.confidence,
				score: analysisResult.score,
				reportPath: analysisResult.reportPath,
				runtimeSeconds: analysisResult.runtimeSeconds,
				hypothesis: analysisResult.summary || "",
				evidenceTable: [],
				attackPath: [],
				blockers: [],
				rulingRationale:
					"Manual verification requested from an existing analysis result.",
				missingEvidenceRequest: [],
				feedbackHistory: [],
				status: analysisResult.status,
			}),
			criticApproval: {
				criticTaskId: "manual-verification",
				reviewedAnalysisFingerprint: buildAnalysisFingerprint({
					id: analysisResult.taskId,
					result: analysisResult.result,
					summary: analysisResult.summary || "",
					confidence: analysisResult.confidence,
					score: analysisResult.score,
					reportPath: analysisResult.reportPath,
					runtimeSeconds: analysisResult.runtimeSeconds,
					hypothesis: analysisResult.summary || "",
					evidenceTable: [],
					attackPath: [],
					blockers: [],
					rulingRationale:
						"Manual verification requested from an existing analysis result.",
					missingEvidenceRequest: [],
					feedbackHistory: [],
					status: analysisResult.status,
				}),
				stance: "convinced",
				summary: "Manual verification requested for existing analysis result.",
			},
			evidenceBundle: [],
			fuzzEvidence: [],
			scanJob: candidateInput.candidate.scanJob,
			module: candidateInput.candidate.module,
			function: candidateInput.candidate.function,
			candidate: candidateInput.candidate,
		},
	} as unknown as CandidateVerificationTaskInput;
};

export const recoverPendingScanCandidateQueues = async () => ({
	scanJobs: 0,
	analysisCandidates: 0,
	verificationCandidates: 0,
	mergedIntoFullScanQueues: true,
});

export const recoverPendingFullScanQueues = async (input?: {
	shouldRecoverScanJob?: (scanJobId: string) => Promise<boolean>;
}) => {
	const jobs = await listUnfinishedScanJobsRepo();
	let startedPipelines = 0;

	for (const job of jobs) {
		if (job.status === "finalizing") {
			await finalizeScanJob(job.scanJobId).catch((error) => {
				console.log(
					"[full-scan]",
					JSON.stringify({
						event: "finalization.recovery_failed",
						scanJobId: job.scanJobId,
						errorMessage:
							error instanceof Error ? error.message : String(error),
					}),
				);
			});
			continue;
		}
		if (job.status !== "running" && job.status !== "pending") {
			continue;
		}

		if (input?.shouldRecoverScanJob) {
			const shouldRecover = await input.shouldRecoverScanJob(job.scanJobId);
			if (!shouldRecover) {
				continue;
			}
		}

		if (job.status === "pending") {
			const started = await transitionScanJobStatusRepo({
				scanJobId: job.scanJobId,
				from: ["pending"],
				to: "running",
			});
			if (!started.updated) continue;
		}

		await startScanPipelineRuntimeForExistingQueues(job.scanJobId);
		startedPipelines += 1;
	}

	return {
		scanJobs: jobs.length,
		startedPipelines,
	};
};

export const syncFullScanTasksFromArtifacts = async (scanJobId: string) => {
	const pipelineState = await settleScanJobRepo(scanJobId).catch(() => null);
	return {
		synced: true,
		scanJobId,
		pipelineState,
	};
};

export const startCandidateVerification = async (
	vulnerabilityCandidateId: string,
) => {
	const candidate = await findVulnerabilityCandidateByIdRepo(
		vulnerabilityCandidateId,
	);
	const scanJob = await findScanJobByIdRepo(candidate.scanJobId);
	if (scanJob.status === "canceled" || scanJob.status === "paused") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Resume the scan job before re-running candidate verification",
		});
	}
	if (scanJob.status !== "running") {
		await resetScanJobForRetryRepo(scanJob.scanJobId, {
			status: "running",
			errorMessage: null,
		});
	}
	const [latestAnalysisResult, existingVerificationTask] = await Promise.all([
		findLatestAnalysisResultByCandidateIdRepo({
			scanJobId: scanJob.scanJobId,
			vulnerabilityCandidateId,
			producerTaskId: candidate.producerTaskId,
		}),
		findCandidateTaskByStage(
			scanJob.scanJobId,
			vulnerabilityCandidateId,
			SCAN_STAGE_IDS.verifyFinding,
		),
	]);

	if (
		!latestAnalysisResult ||
		(latestAnalysisResult.result !== "real_vulnerability" &&
			latestAnalysisResult.result !== "likely_vulnerability")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Verification can only be started for candidates with likely or real analysis results",
		});
	}

	const hasPreviousVerification = Boolean(existingVerificationTask?.threadId);
	const hasActiveVerification = Boolean(
		existingVerificationTask &&
			["pending", "launching", "launched", "starting", "running"].includes(
				existingVerificationTask.status,
			),
	);
	if (hasActiveVerification) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate verification is already queued or running",
		});
	}

	const shouldReuseVerificationTask =
		hasPreviousVerification || existingVerificationTask?.status === "failed";

	const context = await buildFullScanPipelineContext(scanJob.scanJobId);
	const latestAnalysisTask = await findTaskByIdRepo(
		latestAnalysisResult.taskId,
	);
	const latestAnalysisTaskDir = await resolveExistingFullScanTaskRuntimeDir(
		context,
		latestAnalysisTask,
	);
	const analyzeFindingStageInput = (await reconstructTaskInput(
		latestAnalysisTask,
	).catch(() => null)) as CandidateAnalysisTaskInput | null;
	const latestAnalysisOutputs = await listMessagesBySourceTaskIdRepo(
		latestAnalysisTask.taskId,
	);
	const finalAnalysis = finalAnalysisSchema.safeParse(
		latestAnalysisOutputs.at(-1)?.output,
	);
	if (!analyzeFindingStageInput || !finalAnalysis.success) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Verification requires a critic-approved final analysis task with artifact paths",
		});
	}
	const verifyFindingTaskId =
		existingVerificationTask?.taskId || createShortTaskId();
	const verificationTaskName = existingVerificationTask?.name
		? existingVerificationTask.name
		: `Candidate Verification: ${candidate.title}`;
	const verificationTaskDir = await resolveFullScanTaskRuntimeDir(context, {
		taskId: verifyFindingTaskId,
		stageName: SCAN_STAGE_IDS.verifyFinding,
		taskName: verificationTaskName,
	});
	const baseInput = await copyAnalysisBaseInputArtifacts({
		fromTaskDir: latestAnalysisTaskDir,
		toTaskDir: verificationTaskDir,
		stageInput: analyzeFindingStageInput,
	});
	const verificationInput: CandidateVerificationTaskInput = {
		scanJob: baseInput.scanJob,
		repositoryPath: baseInput.repositoryPath,
		modulePath: baseInput.modulePath,
		functionPath: baseInput.functionPath,
		candidatePath: baseInput.candidatePath,
		analysisResultPath: await writeDownstreamInputArtifact({
			toTaskDir: verificationTaskDir,
			toRelativePath: "inputs/final-analysis.json",
			value: finalAnalysis.data,
		}),
	};
	const verificationTask =
		existingVerificationTask ||
		(await createTaskRepo({
			taskId: verifyFindingTaskId,
			scanJobId: scanJob.scanJobId,
			name: verificationTaskName,
			stageName: SCAN_STAGE_IDS.verifyFinding,
			lifecycle: "turn",
			runtimeMode: latestAnalysisResult.threadId
				? "fork_session"
				: "new_session",
			forkedFromTaskId: latestAnalysisResult.threadId
				? latestAnalysisResult.taskId
				: null,
		}));

	if (verificationTask && shouldReuseVerificationTask) {
		await stopScanContainer(verificationTask.containerName).catch(() => false);
		await updateTaskRepo(verificationTask.taskId, {
			runtimeMode: latestAnalysisResult.threadId
				? "fork_session"
				: "new_session",
			forkedFromTaskId: latestAnalysisResult.threadId
				? latestAnalysisResult.taskId
				: null,
		});
		await requeueTaskRepo(verificationTask.taskId);
	}
	await startScanPipelineRuntimeForExistingQueues(scanJob.scanJobId);

	return {
		started: true,
		reverify: hasPreviousVerification,
	};
};

export const startCandidateAnalysis = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	producerTaskId?: string;
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	if (scanJob.status === "canceled") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Canceled scan jobs cannot re-run candidate analysis",
		});
	}
	if (scanJob.status === "paused") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Resume the scan job before re-running candidate analysis",
		});
	}
	if (scanJob.status !== "running") {
		await resetScanJobForRetryRepo(scanJob.scanJobId, {
			status: "running",
			errorMessage: null,
		});
	}
	const candidate = await findVulnerabilityCandidateByIdAndScanJobIdRepo({
		vulnerabilityCandidateId: input.vulnerabilityCandidateId,
		scanJobId: input.scanJobId,
		producerTaskId: input.producerTaskId,
	});
	if (!candidate.producerTaskId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate does not have a producer task",
		});
	}

	if (
		await hasActiveCandidateAnalysisTaskRepo({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
		})
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate analysis is already queued or running",
		});
	}

	const producerTask = await findTaskByIdRepo(candidate.producerTaskId);
	if (
		producerTask.scanJobId !== scanJob.scanJobId ||
		producerTask.stageName !== SCAN_STAGE_IDS.scanTarget ||
		!(await reconstructTaskInput(producerTask).catch(() => null))
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate producer task is not available",
		});
	}

	const context = await buildFullScanPipelineContext(scanJob.scanJobId);
	const producerTaskDir = await resolveExistingFullScanTaskRuntimeDir(
		context,
		producerTask,
	);
	const producerInput = asTaskRecord(
		await reconstructTaskInput(producerTask).catch(() => null),
	);
	const repositorySourcePath = readString(producerInput, "repositoryPath");
	const moduleSourcePath = readString(producerInput, "modulePath");
	const functionSourcePath =
		readString(producerInput, "targetPath") ||
		readString(producerInput, "functionPath");
	if (!repositorySourcePath || !moduleSourcePath || !functionSourcePath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate producer task is missing analysis input artifacts",
		});
	}

	const analyzeFindingTaskId = createShortTaskId();
	const sourceCandidate = buildCandidateObject(candidate);
	const analysisTaskName = `Candidate Analysis: ${sourceCandidate.title}`;
	const analysisTaskDir = await resolveFullScanTaskRuntimeDir(context, {
		taskId: analyzeFindingTaskId,
		stageName: SCAN_STAGE_IDS.analyzeFinding,
		taskName: analysisTaskName,
	});
	const analysisInput: CandidateAnalysisTaskInput = {
		scanJob,
		repositoryPath: await copyArtifactToDownstreamInput({
			fromTaskDir: producerTaskDir,
			fromPath: repositorySourcePath,
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/repository.json",
		}),
		modulePath: await copyArtifactToDownstreamInput({
			fromTaskDir: producerTaskDir,
			fromPath: moduleSourcePath,
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/module.json",
		}),
		functionPath: await copyArtifactToDownstreamInput({
			fromTaskDir: producerTaskDir,
			fromPath: functionSourcePath,
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/target.json",
		}),
		candidatePath: await writeDownstreamInputArtifact({
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/candidate.json",
			value: sourceCandidate,
		}),
		analysisReportTemplatePath: await writeAnalysisReportTemplateInput({
			scanJob,
			toTaskDir: analysisTaskDir,
		}),
	};
	const analysisTask = await createTaskRepo({
		taskId: analyzeFindingTaskId,
		scanJobId: scanJob.scanJobId,
		name: analysisTaskName,
		stageName: SCAN_STAGE_IDS.analyzeFinding,
		lifecycle: "turn",
		runtimeMode: "new_session",
	});

	return {
		started: true,
		taskId: analysisTask.taskId,
		scanJobId: scanJob.scanJobId,
	};
};

export const startCandidateReviewContainer = async (input: {
	scanJobId: string;
	candidateIds: string[];
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	if (input.candidateIds.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Select at least one candidate",
		});
	}

	const executionContext = await resolveScanExecutionContext(scanJob);
	const repositoryProfile = await resolveStageAgentProfile(
		scanJob,
		SCAN_STAGE_IDS.repositoryProfile,
	);
	if (!repositoryProfile || repositoryProfile.provider !== "codex") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Repository profile stage must use a Codex agent profile before launching a review container",
		});
	}

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Scan context host path is not configured. Restart vulseek-dev from dev.sh.",
		});
	}

	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		executionContext.projectName,
		executionContext.serviceName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });

	const uniqueCandidateIds = Array.from(
		new Set(
			input.candidateIds
				.map((candidateId) => candidateId.trim())
				.filter(Boolean),
		),
	);
	const lineageByCandidate = await Promise.all(
		uniqueCandidateIds.map(async (candidateId) => {
			const candidate = await findVulnerabilityCandidateByIdAndScanJobIdRepo({
				vulnerabilityCandidateId: candidateId,
				scanJobId: input.scanJobId,
			});
			const lineage = await findCandidateTaskLineage({
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				scanJobId: input.scanJobId,
				producerTaskId: candidate.producerTaskId || undefined,
			});
			return { candidate, lineage };
		}),
	);

	const taskMounts = new Map<
		string,
		{
			taskId: string;
			stageName: string;
			taskName: string;
			hostPath: string;
			containerPath: string;
		}
	>();
	for (const { lineage } of lineageByCandidate) {
		for (const task of lineage.tasks) {
			if (taskMounts.has(task.taskId)) {
				continue;
			}
			taskMounts.set(task.taskId, {
				taskId: task.taskId,
				stageName: task.stageName,
				taskName: task.name,
				hostPath: buildTaskHostRootForScanJob({
					hostProfileDir,
					scanJobId: task.scanJobId,
					stageName: task.stageName,
					taskName: task.name,
					taskId: task.taskId,
				}),
				containerPath: buildTaskMountPathForReview({
					scanJobId: task.scanJobId,
					stageName: task.stageName,
					taskName: task.name,
					taskId: task.taskId,
				}),
			});
		}
	}
	if (taskMounts.size === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Selected candidates do not have any task context to mount",
		});
	}

	const reviewId = nanoid(10).toLowerCase();
	const containerName = `scan-candidate-review-${scanJob.scanJobId.toLowerCase()}-${reviewId}`;
	const reviewHostDir = path.join(
		os.tmpdir(),
		"vulseek-candidate-review",
		containerName,
	);
	const reviewContainerDir = "/workspace/review";
	const reviewManifest = {
		scanJobId: scanJob.scanJobId,
		containerName,
		candidates: lineageByCandidate.map(({ candidate, lineage }) => ({
			candidateId: candidate.vulnerabilityCandidateId,
			title: candidate.title,
			producerTaskId: candidate.producerTaskId,
			tasks: lineage.tasks.map((task) => ({
				taskId: task.taskId,
				stageName: task.stageName,
				name: task.name,
				relation: task.relation,
				mountedPath: taskMounts.get(task.taskId)?.containerPath || null,
			})),
		})),
		tasks: Array.from(taskMounts.values()).map((task) => ({
			taskId: task.taskId,
			stageName: task.stageName,
			name: task.taskName,
			hostPath: task.hostPath,
			containerPath: task.containerPath,
		})),
	};
	const readme = [
		"# Candidate Review Workspace",
		"",
		"Open the terminal in Codex mode to start the CLI inside this workspace.",
		`Task directories are mounted under ${CONTAINER_TASK_RUNTIME_ROOT}/jobs/${scanJob.scanJobId}/...`,
		"",
		"Open candidate-review.json for the mounted task manifest.",
	].join("\n");
	await fs.mkdir(reviewHostDir, { recursive: true });
	await fs.writeFile(
		path.join(reviewHostDir, "candidate-review.json"),
		JSON.stringify(reviewManifest, null, 2),
		"utf-8",
	);
	await fs.writeFile(path.join(reviewHostDir, "README.md"), readme, "utf-8");

	const allEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		...parseAgentProfileEnvPairs(repositoryProfile),
	];
	const dockerEnvArgs = allEnvPairs
		.map((pair) => {
			const separatorIndex = pair.indexOf("=");
			const key = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
			const value = separatorIndex === -1 ? "" : pair.slice(separatorIndex + 1);
			return `-e '${escapeSingleQuotes(key)}=${escapeSingleQuotes(value)}'`;
		})
		.join(" ");
	const mountArgs = [
		`-v '${escapeSingleQuotes(hostProfileDir)}:${CONTAINER_SCAN_CONTEXT_ROOT}:ro'`,
		`-v '${escapeSingleQuotes(reviewHostDir)}:${reviewContainerDir}'`,
		...Array.from(taskMounts.values()).map(
			(task) =>
				`-v '${escapeSingleQuotes(task.hostPath)}:${task.containerPath}:ro'`,
		),
	]
		.filter(Boolean)
		.join(" ");
	const containerNetworkArg = await resolveCurrentDockerNetworkArg();
	const codexHomeMountArg =
		buildReviewContainerCodexHomeMountArg(repositoryProfile);
	const agentsDir = await resolveAgentsDirectory();

	try {
		await execAsync(`docker rm -f ${containerName}`).catch(() => {});
		await execAsync(
			`docker run -d -i -t --init --name ${containerName} ${containerNetworkArg} ${buildNamespaceEnabledContainerArgs()} ${mountArgs} ${codexHomeMountArg} ${dockerEnvArgs} ${executionContext.imageTag} bash -lc "mkdir -p /root/.codex '${reviewContainerDir}' && sleep infinity"`,
		);
		await copyCodexAssetsToContainerHome(
			containerName,
			"/root/.codex",
			agentsDir,
			repositoryProfile,
		);
		const { stdout: containerId } = await execAsync(
			`docker inspect --format '{{.Id}}' ${containerName}`,
		);
		return {
			containerId: containerId.trim(),
			containerName,
			terminalUrl: `/dashboard/scan-review-terminal?containerId=${encodeURIComponent(
				containerId.trim(),
			)}`,
		};
	} catch (error) {
		await execAsync(`docker rm -f ${containerName}`).catch(() => {});
		throw error;
	}
};

export {
	type AgentStreamRuntime,
	findAgentStreamRuntimeByTaskId,
} from "./scan/agent-stream-session";
