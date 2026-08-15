import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScanJobOutput } from "@vulseek/server/db/schema";
import { execAsync } from "../../../utils/process/execAsync";
import { materializeTaskJobOutput } from "../artifacts/job-output-artifacts";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import {
	CANDIDATE_PRODUCER_STAGE_NAMES,
	syncVulnerabilityCandidatesFromProducerTask,
} from "../persistence/candidate.repo";
import { normalizeCandidateResultStageOutput } from "../persistence/candidate-result-projection";
import { CANDIDATE_RESULT_STAGE_NAMES } from "../persistence/candidate-result-projection.repo";
import {
	claimPendingDownstreamDispatchResultRepo,
	completeDownstreamDispatchRepo,
	completeTerminalTaskDispatchesRepo,
	finalizeScanJobRepo,
	listPendingCompletedDownstreamDispatchesRepo,
	releaseDownstreamDispatchClaimRepo,
	resetStaleDownstreamDispatchesRepo,
	settleScanJobRepo,
} from "../persistence/job-settlement.repo";
import {
	appendScanJobOutputTx,
	findScanJobByIdRepo,
	findScanJobRuntimeControlRepo,
} from "../persistence/scan-job.repo";
import {
	bindStageLaneRuntimeRepo,
	claimIdleStageLaneRuntimeRepo,
	claimSpecificStageLaneRuntimeRepo,
	createStageGroupInstanceRepo,
	deleteStageLaneRuntimesByScanJobIdRepo,
	ensureStageGroupLaneMembershipRepo,
	findStageGroupInstanceByIdRepo,
	findStageGroupLaneMembershipRepo,
	findStageLaneRuntimeByActiveTaskIdRepo,
	findStageLaneRuntimeRepo,
	listActiveStageGroupLaneMembershipsForStageRepo,
	listStageGroupInstancesByScanJobIdRepo,
	listStageGroupLaneMembershipsRepo,
	listStageLaneRuntimesByScanJobIdRepo,
	markStageGroupInstanceExitedRepo,
	releaseStageLaneRuntimeRepo,
	resetClaimedStageLaneRuntimeForFreshStartRepo,
	resetStageLaneRuntimeByLaneForExitRepo,
	resetStageLaneRuntimeForExitRepo,
	resetStageLaneRuntimeSessionForExitRepo,
	type StageLaneRuntime,
} from "../persistence/stage-lane-runtime.repo";
import {
	countActiveTasksByScanJobAndStageRepo,
	countOpenTasksByScanJobIdRepo,
	countTasksByScanJobStageAndStatusRepo,
	findTaskByIdRepo,
	listActiveTasksByScanJobAndStageRepo,
	listActiveTasksByScanJobIdRepo,
	listPendingTaskQueueMetadataByScanJobIdRepo,
	listTasksByScanJobIdRepo,
	type PendingTaskQueueMetadata,
	transitionTaskStatusResultRepo,
	transitionTaskStatusRepo,
	updateTaskRepo,
} from "../persistence/task.repo";
import { readCandidateIdFromTaskInputArtifact } from "../persistence/task-artifact-resolver";
import { buildKnownQueueJobIdsForTask } from "../queue-job-ids";
import { AGENT_RUNTIME_FILE_NAMES } from "../runtime/agent-runtime-files";
import { parseDriverStdout } from "../runtime/driver-stdout-protocol";
import {
	ensureJobAgentHome,
	removeContainer,
} from "../runtime/run-single-turn-agent";
import {
	buildEffectiveDisabledStageSet,
	createRuntimeSettingsPolicy,
} from "../runtime-settings";
import { resolveStageTaskName } from "../stage-task-name";
import {
	createStageContext,
	type PipelineContext,
	resolveTaskRuntimeDirForTask,
	type StageContext,
} from "../stages/full-scan-stage.runtime";
import { parseAgentUsageSnapshot } from "../usage-snapshot";
import { resolveLaunchDisposition } from "./launch-disposition";
import {
	type FirstStageInputOf,
	getDownstreamEdges,
	getStageGroup,
	getStageLeaderGroup,
	getStageRouteOutputSchemas,
	isStageInGroup,
	type PipelineDefinition,
	selectDownstreamEdgesForRoute,
	validatePipelineRouteConfiguration,
} from "./pipeline-definition";
import {
	deletePipelineRuntime,
	getPipelineRuntimeRegistry,
	setPipelineRuntime,
} from "./pipeline-runtime-registry";
import { buildResearchDispatchRetryPlan } from "./research-dispatch-recovery";
import {
	getPollableStageNames,
	groupActiveTasksByStage,
	type PendingQueueTarget,
	type RuntimeLoopSnapshot,
} from "./runtime-loop-snapshot";
import { loadScanPipelineDefinitions } from "./scan-pipeline-definitions";
import { validateStructuredOutputSchemaSource } from "./scan-pipeline-schema-contracts";
import type {
	StageDefinition,
	StageExecution,
	StageQueueScope,
} from "./stage-definition";
import {
	buildPipelineTaskUpdatePatch,
	type PipelineTaskUpdate,
} from "./task-update-patch";

type PipelineScanJobContext = PipelineContext & {
	scanJob: {
		scanJobId: string;
		pipelineId?: string;
		repositoryTaskId?: string | null;
		applicationId: string | null;
		composeId: string | null;
	};
};

const hasPipelineScanJobContext = (
	ctx: PipelineContext,
): ctx is PipelineScanJobContext =>
	"scanJob" in ctx &&
	Boolean((ctx as PipelineScanJobContext).scanJob?.scanJobId);

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// Research stages must never share an agent session. Keep this capability
// explicit here because several stages do not include "research" in their id.
const RESEARCH_STAGE_IDS = new Set([
	"research-scope",
	"surface-map",
	"track-plan",
	"vulnerability-discovery",
	"track-review",
	"finding-validation",
	"finding-review",
	"chain-synthesis",
	"chain-review",
	"exploit-validation",
	"exploit-review",
	"research-report",
]);

const isResearchStage = (stageName: string | undefined) =>
	Boolean(stageName && (stageName === "research" || RESEARCH_STAGE_IDS.has(stageName)));

const resolveStagePersistent = async (
	stage: Pick<
		StageDefinition<PipelineContext, unknown, unknown>,
		"persistent" | "runtimeConfig" | "goal"
	>,
) => {
	const goalSession = stage.runtimeConfig
		? await stage.runtimeConfig.getGoalSession()
		: null;
	if (goalSession === "shared") return true;
	if (goalSession === "per-task" || stage.goal === true) return false;
	const runtimePersistent = stage.runtimeConfig
		? await stage.runtimeConfig.getPersistent()
		: null;
	return runtimePersistent ?? stage.persistent ?? true;
};

const resolveStageReuseContainer = async (
	stage: Pick<
		StageDefinition<PipelineContext, unknown, unknown>,
		"reuseContainer" | "runtimeConfig" | "goal"
	>,
	stageName?: string,
) => {
	const goalSession = stage.runtimeConfig
		? await stage.runtimeConfig.getGoalSession()
		: null;
	if (goalSession === "shared") return true;
	if (goalSession === "per-task") return false;
	const runtimeReuseContainer = stage.runtimeConfig
		? await stage.runtimeConfig.getReuseContainer()
		: null;
	const configured = runtimeReuseContainer ?? stage.reuseContainer ?? true;
	return isResearchStage(stageName) || stage.goal === true
		? false
		: configured;
};

const resolveStageNullableOutput = async (
	stage: Pick<
		StageDefinition<PipelineContext, unknown, unknown>,
		"nullableOutput" | "runtimeConfig"
	>,
) => {
	const runtimeNullableOutput = stage.runtimeConfig
		? await stage.runtimeConfig.getNullableOutput()
		: null;
	return runtimeNullableOutput ?? stage.nullableOutput ?? false;
};

const MAX_TRANSIENT_LAUNCH_RETRIES = 5;

const isTransientRuntimeLaunchError = (error: unknown) => {
	const message = getErrorMessage(error);
	return (
		message.includes("failed to create task for container") ||
		message.includes("OCI runtime create failed") ||
		message.includes("can't get final child's PID from pipe: EOF") ||
		message.includes("container stopped before reporting THREAD_ID")
	);
};

const logPipelineEvent = (event: string, details: Record<string, unknown>) => {
	console.log(
		"[scan-pipeline]",
		JSON.stringify({
			event,
			...details,
		}),
	);
};

const SCAN_JOB_CANCELLED_ERROR_NAME = "ScanJobCancelledError";
const STALE_RUNNING_STDOUT_WINDOW_MS = 10 * 60 * 1000;
const RUNNING_OUTPUT_WITHOUT_END_TURN_LOG_INTERVAL_MS = 5 * 60 * 1000;
const LOOP_TICK_LOG_INTERVAL_MS = 60 * 1000;
const JOB_LOOP_IDLE_SLEEP_MS = 1000;
const lastLoopTickLogAtByJob = new Map<string, number>();

class ScanJobCancelledError extends Error {
	constructor(scanJobId: string) {
		super(`Scan job ${scanJobId} was cancelled`);
		this.name = SCAN_JOB_CANCELLED_ERROR_NAME;
	}
}

const assertScanJobNotCancelled = async (ctx: PipelineContext) => {
	const scanJob = await findScanJobRuntimeControlRepo(ctx.scanJobId).catch(
		() => null,
	);
	if (scanJob && scanJob.status === "canceled") {
		throw new ScanJobCancelledError(ctx.scanJobId);
	}
};

const isScanJobPaused = async (ctx: PipelineContext) => {
	const scanJob = await findScanJobRuntimeControlRepo(ctx.scanJobId).catch(
		() => null,
	);
	return scanJob?.status === "paused";
};

const shouldStopForPausedScanJob = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	if (!(await isScanJobPaused(runtime.ctx))) {
		return false;
	}
	runtime.stopRequested = true;
	logPipelineEvent("loop.paused", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
	});
	return true;
};

const normalizeJsonOutput = (rawOutput: string) => {
	const trimmed = rawOutput.trim();
	const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fencedJson?.[1]?.trim() || trimmed;
};

const defaultValidateOutput = async <TOutput>(
	stageName: string,
	rawOutput: string,
): Promise<TOutput> => {
	try {
		return JSON.parse(normalizeJsonOutput(rawOutput)) as TOutput;
	} catch (error) {
		throw new Error(
			`Stage ${stageName} returned invalid JSON output: ${getErrorMessage(error)}`,
		);
	}
};

const ensureTaskRuntimeDirectory = async (ctx: StageContext) => {
	const taskDirPath = await ctx.taskDir();
	await fs.mkdir(taskDirPath, { recursive: true });
	if (ctx.laneIndex !== null) {
		await ctx.laneDir();
	}
	return {
		taskDir: taskDirPath,
		taskDirContainer: await ctx.taskDirContainer(),
	};
};

const getTaskRuntimePaths = async (ctx: StageContext) => {
	const taskDir = await ctx.taskDir();
	return {
		taskDir,
		stdoutPath: path.join(taskDir, AGENT_RUNTIME_FILE_NAMES.stdout),
		outputPath: path.join(taskDir, "output.json"),
	};
};

const copyPersistentLaneArtifactsToTaskDir = async (ctx: StageContext) => {
	if (!ctx.persistent || ctx.laneIndex === null) {
		return;
	}
	const [laneDir, taskDir] = await Promise.all([ctx.laneDir(), ctx.taskDir()]);
	if (laneDir === taskDir) {
		return;
	}
	const skipEntries = new Set([
		"inputs",
		"output.json",
		AGENT_RUNTIME_FILE_NAMES.stdin,
		AGENT_RUNTIME_FILE_NAMES.stdout,
	]);
	const entries = await fs
		.readdir(laneDir, { withFileTypes: true })
		.catch(() => []);
	await fs.mkdir(taskDir, { recursive: true });
	for (const entry of entries) {
		if (skipEntries.has(entry.name)) {
			continue;
		}
		const fromPath = path.join(laneDir, entry.name);
		const toPath = path.join(taskDir, entry.name);
		await fs.rm(toPath, { recursive: true, force: true }).catch(() => {});
		await fs.cp(fromPath, toPath, { recursive: true, force: true });
	}
};

const updateTaskDefault = async (taskId: string, patch: PipelineTaskUpdate) => {
	if (patch.status) {
		const result = await transitionTaskStatusResultRepo({
			taskId,
			from: [
				"pending",
				"launching",
				"launched",
				"starting",
				"running",
				"completed",
				"failed",
				"exited",
				"canceled",
			],
			to: patch.status,
			patch: buildPipelineTaskUpdatePatch(patch),
		});
		if (result.outcome !== "updated") {
			throw new Error(
				`Task ${taskId} status transition skipped: ${result.outcome} (${result.jobStatus ?? "missing"})`,
			);
		}
		return;
	}
	await updateTaskRepo(taskId, buildPipelineTaskUpdatePatch(patch));
};

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const readFileIfExists = async (filePath: string) =>
	await fs.readFile(filePath, "utf-8").catch(() => "");

const sha1 = (value: string) =>
	crypto.createHash("sha1").update(value).digest("hex");

const statFileIfExists = async (filePath: string) => {
	const stat = await fs.stat(filePath).catch(() => null);
	return stat
		? {
				exists: true,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				mtimeIso: stat.mtime.toISOString(),
			}
		: { exists: false, size: 0, mtimeMs: null, mtimeIso: null };
};

const summarizeOutputJson = (content: string) => {
	if (!content.trim()) {
		return {
			exists: false,
			validJson: false,
			validEnvelope: false,
			route: null,
			exit: null,
			error: null,
		};
	}
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		return {
			exists: true,
			validJson: true,
			validEnvelope:
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				"route" in parsed &&
				(parsed.route === null || typeof parsed.route === "string") &&
				typeof parsed.exit === "boolean" &&
				"output" in parsed,
			route: typeof parsed.route === "string" ? parsed.route : null,
			exit: typeof parsed.exit === "boolean" ? parsed.exit : null,
			error: null,
		};
	} catch (error) {
		return {
			exists: true,
			validJson: false,
			validEnvelope: false,
			route: null,
			exit: null,
			error: getErrorMessage(error),
		};
	}
};

const summarizeTaskProtocol = (content: string) => {
	const protocol = parseDriverStdout(content);
	const taskDone =
		protocol.latestTask?.type === "task_done" ? protocol.latestTask : null;
	return {
		exists: protocol.events.length > 0,
		promptFinished: taskDone !== null,
		endTurnReceived: taskDone?.stopReason === "end_turn",
		completedAt: taskDone ? "completed" : null,
		latestTask: taskDone,
		exitCode: protocol.exitCode,
		invalidLineCount: protocol.invalidLineCount,
	};
};

const tailText = (content: string, maxLength = 4000) => {
	if (content.length <= maxLength) {
		return content;
	}
	return `<truncated ${content.length - maxLength} chars>\n${content.slice(-maxLength)}`;
};

const inspectContainerForFailure = async (
	containerName: string | null | undefined,
) => {
	if (!containerName) {
		return null;
	}
	const [inspectResult, logsResult] = await Promise.all([
		execAsync(`docker inspect ${containerName} --format '{{json .State}}'`)
			.then(({ stdout }) => ({
				ok: true,
				state: JSON.parse(stdout.trim() || "{}") as unknown,
			}))
			.catch((error) => ({
				ok: false,
				error: getErrorMessage(error),
			})),
		execAsync(`docker logs --tail 120 ${containerName}`)
			.then(({ stdout, stderr }) => ({
				ok: true,
				stdoutTail: tailText(stdout),
				stderrTail: tailText(stderr),
			}))
			.catch((error) => ({
				ok: false,
				error: getErrorMessage(error),
			})),
	]);
	return {
		containerName,
		inspect: inspectResult,
		logs: logsResult,
	};
};

const buildTaskFailureDiagnostics = async (ctx: StageContext) => {
	const { taskDir, stdoutPath, outputPath } = await getTaskRuntimePaths(ctx);
	const [task, stdoutContent, outputContent, stdoutStat, outputStat] =
		await Promise.all([
			findTaskByIdRepo(ctx.taskId).catch(() => null),
			readFileIfExists(stdoutPath),
			readFileIfExists(outputPath),
			statFileIfExists(stdoutPath),
			statFileIfExists(outputPath),
		]);
	const containerDiagnostics = await inspectContainerForFailure(
		task?.containerName,
	);
	return {
		taskDir,
		containerName: task?.containerName || null,
		threadId: task?.threadId || null,
		runtimeFiles: {
			stdout: stdoutStat,
			output: outputStat,
		},
		output: summarizeOutputJson(outputContent),
		state: summarizeTaskProtocol(stdoutContent),
		tails: {
			stdout: tailText(stdoutContent),
			output: tailText(outputContent),
		},
		container: containerDiagnostics,
	};
};

const appendTaskFailureDiagnostics = async (
	ctx: StageContext,
	reason: string,
	diagnostics: unknown,
) => {
	const { stdoutPath } = await getTaskRuntimePaths(ctx);
	await fs
		.appendFile(
			stdoutPath,
			`${JSON.stringify({
				type: "log",
				level: "error",
				source: "pipeline",
				message: reason,
				diagnostics,
			})}\n`,
			"utf-8",
		)
		.catch(() => {});
};

const readTaskTokenUsage = async (ctx: StageContext) => {
	const { stdoutPath } = await getTaskRuntimePaths(ctx);
	const protocol = parseDriverStdout(await readFileIfExists(stdoutPath));
	const usage = parseAgentUsageSnapshot(protocol.latestUsage);
	return {
		inputTokens: usage.inputTokens || null,
		outputTokens: usage.outputTokens || null,
		thoughtTokens: usage.thoughtTokens || null,
		totalTokens: usage.totalTokens || null,
		cachedReadTokens: usage.cachedReadTokens || null,
		cachedWriteTokens: usage.cachedWriteTokens || null,
	};
};

const extractDriverExitCode = (stdoutContent: string) =>
	parseDriverStdout(stdoutContent).exitCode;

const hasDriverCompletedWithoutOutput = (stdoutContent: string) =>
	parseDriverStdout(stdoutContent).events.some(
		(event) =>
			event.type === "log" &&
			typeof event.message === "string" &&
			event.message.includes("prompt completed without output"),
	);

const extractThreadIdFromStdout = (stdoutContent: string) => {
	const threadEvent = [...parseDriverStdout(stdoutContent).events]
		.reverse()
		.find((event) => event.type === "thread");
	return typeof threadEvent?.threadId === "string"
		? threadEvent.threadId
		: null;
};

const extractDriverPidFromStdout = (stdoutContent: string) => {
	const startEvent = [...parseDriverStdout(stdoutContent).events]
		.reverse()
		.find((event) => event.type === "start");
	const pid = startEvent?.pid;
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
		? pid
		: null;
};

const cleanupTaskContainer = async (taskId: string) => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	if (!task?.containerName) {
		return;
	}
	await removeContainer(task.containerName).catch(() => {});
};

const shouldRemoveContainerAfterTask = (
	stageCtx: Pick<StageContext, "reuseContainer">,
) => !stageCtx.reuseContainer;

const cleanupFailedTaskRuntime = async (taskId: string) => {
	const [task, lane] = await Promise.all([
		findTaskByIdRepo(taskId).catch(() => null),
		findStageLaneRuntimeByActiveTaskIdRepo(taskId).catch(() => null),
	]);
	const containerNames = new Set<string>();
	if (task?.containerName) {
		containerNames.add(task.containerName);
	}
	if (lane?.containerName) {
		containerNames.add(lane.containerName);
	}
	await Promise.all(
		[...containerNames].map((containerName) =>
			removeContainer(containerName).catch(() => {}),
		),
	);
	if (lane) {
		await resetStageLaneRuntimeForExitRepo({ taskId }).catch(() => {});
	}
};

const discardInFlightLaunch = async (input: {
	taskId: string;
	stageCtx: Pick<StageContext, "scanJobId" | "stageName" | "taskName">;
	disposition: "cancel" | "defer";
}) => {
	if (input.disposition === "defer") {
		await transitionTaskStatusRepo({
			taskId: input.taskId,
			from: ["launching"],
			to: "pending",
			patch: {
				containerName: null,
				containerIndex: null,
				threadId: null,
				errorMessage: "Launch deferred while scan job is paused",
			},
		}).catch(() => null);
	}
	await cleanupFailedTaskRuntime(input.taskId);
	logPipelineEvent("stage.launch_discarded", {
		scanJobId: input.stageCtx.scanJobId,
		stageName: input.stageCtx.stageName,
		taskId: input.taskId,
		taskName: input.stageCtx.taskName,
		disposition: input.disposition,
	});
};

const markTaskExited = async (input: {
	taskId: string;
	exitReason: "agent_exit" | "leader_exit";
	exitNote?: string | null;
}) =>
	await transitionTaskStatusRepo({
		taskId: input.taskId,
		from: ["pending", "launching", "launched", "starting", "running"],
		to: "exited",
		patch: {
			exitReason: input.exitReason,
			exitNote: input.exitNote ?? null,
			errorMessage: null,
		},
	}).catch(() => null);

const isStageGroupLeaderTask = async (
	task: {
		taskId: string;
		stageName: string;
		stageGroupInstanceId?: string | null;
	} | null,
) => {
	if (!task?.stageGroupInstanceId) {
		return false;
	}
	const group = await findStageGroupInstanceByIdRepo(task.stageGroupInstanceId);
	return (
		Boolean(group) &&
		group?.status !== "exited" &&
		group?.leaderTaskId === task.taskId &&
		group?.leaderStageName === task.stageName
	);
};

const cleanupStageGroupForLeaderExit = async <
	TPipelineContext extends PipelineContext,
>(
	leaderTaskId: string,
	runtime?: JobRuntime<TPipelineContext>,
) => {
	const leaderTask = await findTaskByIdRepo(leaderTaskId).catch(() => null);
	const groupInstanceId = leaderTask?.stageGroupInstanceId;
	if (!groupInstanceId) {
		return;
	}
	const group = await findStageGroupInstanceByIdRepo(groupInstanceId);
	if (
		!group ||
		group.leaderTaskId !== leaderTaskId ||
		leaderTask.stageName !== group.leaderStageName ||
		group.status === "exited"
	) {
		return;
	}
	await markStageGroupInstanceExitedRepo(groupInstanceId).catch(() => null);
	await cleanupStageGroupQueues(runtime, groupInstanceId);
	const memberships = await listStageGroupLaneMembershipsRepo(
		groupInstanceId,
	).catch(() => []);
	const groupTasks = await listTasksByScanJobIdRepo(group.scanJobId).catch(
		() => [],
	);
	for (const membership of memberships) {
		if (membership.role === "leader") {
			continue;
		}
		const lane = await findStageLaneRuntimeRepo({
			scanJobId: group.scanJobId,
			stageName: membership.stageName,
			laneIndex: membership.laneIndex,
		}).catch(() => null);
		if (lane?.containerName) {
			await removeContainer(lane.containerName).catch(() => {});
		}
		await resetStageLaneRuntimeByLaneForExitRepo({
			scanJobId: group.scanJobId,
			stageName: membership.stageName,
			laneIndex: membership.laneIndex,
			taskId: lane?.activeTaskId ?? null,
		}).catch(() => {});
	}
	for (const task of groupTasks) {
		if (
			task.stageGroupInstanceId !== groupInstanceId ||
			task.stageName === group.leaderStageName ||
			(task.status !== "pending" &&
				task.status !== "launching" &&
				task.status !== "launched" &&
				task.status !== "starting" &&
				task.status !== "running")
		) {
			continue;
		}
		if (task.containerName) {
			await removeContainer(task.containerName).catch(() => {});
		}
		await markTaskExited({
			taskId: task.taskId,
			exitReason: "leader_exit",
			exitNote: `跟随 leader task ${leaderTaskId} exit`,
		});
	}
};

const cleanupPersistentLaneForTask = async <
	TPipelineContext extends PipelineContext,
>(
	taskId: string,
	runtime?: JobRuntime<TPipelineContext>,
) => {
	await cleanupStageGroupForLeaderExit(taskId, runtime).catch(() => {});
	const lane = await findStageLaneRuntimeByActiveTaskIdRepo(taskId);
	if (!lane) {
		return;
	}
	if (lane.containerName) {
		await removeContainer(lane.containerName).catch(() => {});
	}
	await resetStageLaneRuntimeForExitRepo({ taskId }).catch(() => {});
};

const releasePersistentLaneForTask = async (taskId: string) => {
	await releaseStageLaneRuntimeRepo(taskId).catch(() => {});
};

const cleanupTerminalJobRuntime = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId).catch(() => null);
	if (
		scanJob?.status !== "finalizing" &&
		scanJob?.status !== "finished" &&
		scanJob?.status !== "partially_finished" &&
		scanJob?.status !== "failed"
	) {
		return {
			cleaned: false,
			reason: "job_not_terminal",
			containerCount: 0,
		};
	}
	const openCount = await countOpenTasksByScanJobIdRepo(scanJobId).catch(
		() => null,
	);
	if (openCount !== 0) {
		return {
			cleaned: false,
			reason: "open_tasks_present",
			containerCount: 0,
		};
	}

	const [tasks, lanes] = await Promise.all([
		listTasksByScanJobIdRepo(scanJobId).catch(() => []),
		listStageLaneRuntimesByScanJobIdRepo(scanJobId).catch(() => []),
	]);
	const containerNames = new Set<string>();
	for (const task of tasks) {
		if (task.containerName) {
			containerNames.add(task.containerName);
		}
	}
	for (const lane of lanes) {
		if (lane.containerName) {
			containerNames.add(lane.containerName);
		}
	}

	await Promise.all(
		[...containerNames].map((containerName) =>
			removeContainer(containerName).catch(() => {}),
		),
	);
	const runtime = [...pipelineSupervisorJobs.values()].find(
		(candidate) => candidate.ctx.scanJobId === scanJobId,
	);
	const stageGroups = await listStageGroupInstancesByScanJobIdRepo(
		scanJobId,
	).catch(() => []);
	await Promise.all(
		stageGroups
			.filter((group) => group.status === "active")
			.map(async (group) => {
				await markStageGroupInstanceExitedRepo(group.groupInstanceId).catch(
					() => {},
				);
				await cleanupStageGroupQueues(runtime, group.groupInstanceId);
			}),
	);
	await deleteStageLaneRuntimesByScanJobIdRepo(scanJobId).catch(() => []);

	return {
		cleaned: true,
		reason: null,
		containerCount: containerNames.size,
	};
};

const isOpenTaskStatus = (status: string) =>
	status === "pending" ||
	status === "launching" ||
	status === "launched" ||
	status === "starting" ||
	status === "running";

const cleanupStageGroupQueues = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext> | null | undefined,
	groupInstanceId: string,
) => {
	if (!runtime) {
		return;
	}
	let removedQueues = 0;
	for (const stage of runtime.pipeline.stages) {
		if (!stage.queue) {
			continue;
		}
		await stage.queue.obliterateGroup(groupInstanceId).catch(() => {});
		removedQueues += 1;
	}
	logPipelineEvent("stage.group_queues_deleted", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		groupInstanceId,
		queueCount: removedQueues,
	});
};

const listReservedLaneIndexesForStage = async (input: {
	scanJobId: string;
	stageName: string;
	allowedGroupInstanceId?: string | null;
	runtime?: JobRuntime<PipelineContext>;
}) => {
	const memberships = await listActiveStageGroupLaneMembershipsForStageRepo({
		scanJobId: input.scanJobId,
		stageName: input.stageName,
	}).catch(() => []);
	if (memberships.length === 0) {
		return [];
	}
	const tasks = await listTasksByScanJobIdRepo(input.scanJobId).catch(() => []);
	const staleGroupInstanceIds = new Set<string>();
	for (const membership of memberships) {
		if (staleGroupInstanceIds.has(membership.groupInstanceId)) {
			continue;
		}
		const hasOpenTask = tasks.some(
			(task) =>
				task.stageGroupInstanceId === membership.groupInstanceId &&
				isOpenTaskStatus(task.status),
		);
		if (hasOpenTask) {
			continue;
		}
		staleGroupInstanceIds.add(membership.groupInstanceId);
		const group = await findStageGroupInstanceByIdRepo(
			membership.groupInstanceId,
		).catch(() => null);
		await markStageGroupInstanceExitedRepo(membership.groupInstanceId).catch(
			() => null,
		);
		await cleanupStageGroupQueues(input.runtime, membership.groupInstanceId);
		logPipelineEvent("stage.group_exited", {
			scanJobId: input.scanJobId,
			groupName: group?.groupName ?? null,
			groupInstanceId: membership.groupInstanceId,
			leaderStageName: group?.leaderStageName ?? null,
			leaderLaneIndex: group?.leaderLaneIndex ?? null,
			reason: "stale_active_group_without_open_tasks",
		});
	}
	return memberships
		.filter(
			(membership) =>
				!staleGroupInstanceIds.has(membership.groupInstanceId) &&
				(!input.allowedGroupInstanceId ||
					membership.groupInstanceId !== input.allowedGroupInstanceId),
		)
		.map((membership) => membership.laneIndex);
};

const maybeMarkTaskStageGroupExited = async <
	TPipelineContext extends PipelineContext,
>(
	taskId: string,
	runtime?: JobRuntime<TPipelineContext>,
) => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	const groupInstanceId = task?.stageGroupInstanceId;
	if (!task || !groupInstanceId) {
		return;
	}
	const group = await findStageGroupInstanceByIdRepo(groupInstanceId).catch(
		() => null,
	);
	if (!group || group.status !== "active") {
		return;
	}
	const groupTasks = await listTasksByScanJobIdRepo(group.scanJobId).catch(
		() => [],
	);
	const hasOpenTask = groupTasks.some(
		(groupTask) =>
			groupTask.stageGroupInstanceId === groupInstanceId &&
			isOpenTaskStatus(groupTask.status),
	);
	if (hasOpenTask) {
		return;
	}
	await markStageGroupInstanceExitedRepo(groupInstanceId).catch(() => null);
	await cleanupStageGroupQueues(runtime, groupInstanceId);
	logPipelineEvent("stage.group_exited", {
		scanJobId: group.scanJobId,
		groupName: group.groupName,
		groupInstanceId,
		leaderStageName: group.leaderStageName,
		leaderLaneIndex: group.leaderLaneIndex,
	});
};

const isContainerAlive = async (
	containerName: string | null | undefined,
): Promise<boolean> => {
	if (!containerName) {
		return false;
	}

	try {
		const { stdout } = await execAsync(
			`docker inspect -f '{{.State.Running}}' ${containerName}`,
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
};

const createStageContextForTask = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	task: {
		stageName: string;
		taskId: string;
		name: string;
		input?: unknown;
		containerIndex?: number | null;
		runtimeMode?: "new_session" | "fork_session" | null;
		forkedFromTaskId?: string | null;
		forkedFromThreadId?: string | null;
	},
) => {
	const scanJobRef = hasPipelineScanJobContext(runtime.ctx)
		? runtime.ctx.scanJob
		: null;
	const laneRuntime = await findStageLaneRuntimeByActiveTaskIdRepo(
		task.taskId,
	).catch(() => null);
	const groupedPersistent = Boolean(
		laneRuntime && getStageGroup(runtime.pipeline, task.stageName),
	);
	const stageDefinition = runtime.stageStates.get(task.stageName)?.stage;
	const stagePersistent = stageDefinition
		? await resolveStagePersistent(stageDefinition)
		: Boolean(laneRuntime);
	const stageReuseContainer = stageDefinition
		? await resolveStageReuseContainer(stageDefinition, task.stageName)
		: true;
	const stageNullableOutput = stageDefinition
		? await resolveStageNullableOutput(stageDefinition)
		: false;
	return createStageContext({
		base: runtime.ctx,
		stageName: task.stageName,
		scanJob: scanJobRef || {
			scanJobId: runtime.ctx.scanJobId,
			applicationId: null,
			composeId: null,
		},
		taskId: task.taskId,
		taskName: task.name || resolveStageTaskName(task.stageName, task.input),
		persistent: stagePersistent,
		reuseContainer: stageReuseContainer,
		nullableOutput: stageNullableOutput,
		groupedPersistent,
		allowAgentExit: stageDefinition?.allowAgentExit ?? false,
		containerIndex: laneRuntime?.laneIndex ?? task.containerIndex ?? null,
		laneIndex: laneRuntime?.laneIndex ?? null,
		laneThreadId: laneRuntime?.threadId ?? null,
		laneDriverPid: laneRuntime?.driverPid ?? null,
		sessionMode: task.runtimeMode === "fork_session" ? "fork" : "new",
		parentSessionId: task.forkedFromThreadId ?? null,
		parentTaskId: task.forkedFromTaskId ?? null,
		routeOutputSchemas: getStageRouteOutputSchemas(
			runtime.pipeline,
			task.stageName,
		),
	});
};

const inspectHalfStartedRunningTask = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
) => {
	if (task.status !== "running") {
		return null;
	}

	const stageCtx = await createStageContextForTask(runtime, task);
	const { taskDir, stdoutPath, outputPath } =
		await getTaskRuntimePaths(stageCtx);
	const [stdoutContent, outputContent, outputStat] = await Promise.all([
		readFileIfExists(stdoutPath),
		readFileIfExists(outputPath),
		statFileIfExists(outputPath),
	]);

	const now = Date.now();
	const protocol = parseDriverStdout(stdoutContent);
	const taskSummary = summarizeTaskProtocol(stdoutContent);
	const hasEndTurn = taskSummary.endTurnReceived === true;
	const outputSummary = summarizeOutputJson(outputContent);
	const diagnostics = {
		stdoutBytes: Buffer.byteLength(stdoutContent),
		outputBytes: Buffer.byteLength(outputContent),
		output: {
			...outputSummary,
			mtimeIso: outputStat.mtimeIso,
			size: outputStat.size,
		},
		state: taskSummary,
		invalidProtocolLines: protocol.invalidLineCount,
		hasEndTurn,
		threadId: task.threadId || null,
		containerName: task.containerName || null,
	};
	const previousSnapshot = runtime.runningStdoutSnapshots.get(task.taskId);
	const diagnosticKey = outputSummary.exists
		? sha1(
				JSON.stringify({
					outputMtimeMs: outputStat.mtimeMs,
					outputSize: outputStat.size,
					outputValidEnvelope: outputSummary.validEnvelope,
					outputRoute: outputSummary.route,
					hasEndTurn,
				}),
			)
		: previousSnapshot?.lastDiagnosticKey;
	const runtimeOutputHash = sha1(
		[`stdout:${stdoutContent}`, `output:${outputContent}`].join("\n"),
	);
	if (!previousSnapshot || previousSnapshot.hash !== runtimeOutputHash) {
		const lastRunningOutputWithoutEndTurnLoggedAt =
			previousSnapshot?.lastRunningOutputWithoutEndTurnLoggedAt;
		const runningOutputWithoutEndTurnLogIntervalElapsed =
			!lastRunningOutputWithoutEndTurnLoggedAt ||
			now - lastRunningOutputWithoutEndTurnLoggedAt >=
				RUNNING_OUTPUT_WITHOUT_END_TURN_LOG_INTERVAL_MS;
		const shouldLogRunningOutputWithoutEndTurn =
			outputSummary.exists &&
			!hasEndTurn &&
			runningOutputWithoutEndTurnLogIntervalElapsed;
		runtime.runningStdoutSnapshots.set(task.taskId, {
			hash: runtimeOutputHash,
			lastChangedAt: now,
			lastDiagnosticKey: diagnosticKey,
			lastRunningOutputWithoutEndTurnDiagnosticKey:
				shouldLogRunningOutputWithoutEndTurn
					? diagnosticKey
					: previousSnapshot?.lastRunningOutputWithoutEndTurnDiagnosticKey,
			lastRunningOutputWithoutEndTurnLoggedAt:
				shouldLogRunningOutputWithoutEndTurn
					? now
					: previousSnapshot?.lastRunningOutputWithoutEndTurnLoggedAt,
		});
		if (shouldLogRunningOutputWithoutEndTurn) {
			logPipelineEvent("stage.running_output_without_end_turn", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: task.stageName,
				taskId: task.taskId,
				taskName: task.name,
				diagnostics,
			});
		}
		return null;
	}

	if (now - previousSnapshot.lastChangedAt < STALE_RUNNING_STDOUT_WINDOW_MS) {
		return null;
	}

	return {
		reason: task.threadId
			? "silent_stuck_after_start"
			: "silent_stuck_before_start",
		diagnostics: {
			...diagnostics,
			unchangedForMs: now - previousSnapshot.lastChangedAt,
			staleWindowMs: STALE_RUNNING_STDOUT_WINDOW_MS,
		},
	} as const;
};

const failSilentStuckTask = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
	reason: string,
	diagnostics?: Record<string, unknown>,
	stageCtx?: StageContext,
) => {
	const currentTask = await findTaskByIdRepo(task.taskId).catch(() => null);
	if (!currentTask || currentTask.status !== "running") {
		logPipelineEvent("stage.stale_failure_ignored", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: task.stageName,
			taskId: task.taskId,
			taskName: task.name,
			currentStatus: currentTask?.status,
			errorMessage: `Task became silently stuck: ${reason}`,
		});
		return;
	}

	const failureDiagnostics = stageCtx
		? await buildTaskFailureDiagnostics(stageCtx)
				.then((runtimeDiagnostics) => ({
					stuckDetection: diagnostics || {},
					runtime: runtimeDiagnostics,
				}))
				.catch((diagnosticError) => ({
					stuckDetection: diagnostics || {},
					error: `Unable to collect task failure diagnostics: ${getErrorMessage(
						diagnosticError,
					)}`,
				}))
		: diagnostics;
	if (stageCtx) {
		await appendTaskFailureDiagnostics(
			stageCtx,
			reason,
			failureDiagnostics || {},
		).catch(() => {});
	}
	runtime.runningStdoutSnapshots.delete(task.taskId);
	const transitionResult = await transitionTaskStatusResultRepo({
		taskId: task.taskId,
		from: ["running"],
		to: "failed",
		patch: { errorMessage: `Task became silently stuck: ${reason}` },
	});
	if (transitionResult.outcome !== "updated") {
		logPipelineEvent("stage.silent_stuck_failure_skipped", {
			scanJobId: runtime.ctx.scanJobId,
			taskId: task.taskId,
			transitionOutcome: transitionResult.outcome,
			jobStatus: transitionResult.jobStatus,
		});
		return;
	}
	await completeDownstreamDispatchRepo(task.taskId).catch(() => {});
	await cleanupFailedTaskRuntime(task.taskId);
	logPipelineEvent("stage.silent_stuck_failed", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		stageName: task.stageName,
		taskId: task.taskId,
		taskName: task.name,
		reason,
		...(failureDiagnostics ? { diagnostics: failureDiagnostics } : {}),
	});
	logPipelineEvent("loop.task_failed", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		stageName: task.stageName,
		taskId: task.taskId,
		taskName: task.name,
		errorMessage: `Task became silently stuck: ${reason}`,
	});
	await maybeMarkTaskStageGroupExited(task.taskId, runtime);
	runtime.wakeSignal.notify();
};

type ScanJobLike = {
	scanJobId: string;
	pipelineId?: string;
	applicationId: string | null;
	composeId: string | null;
};

const resolveStageScanJob = (
	input: Record<string, unknown> | null | undefined,
	ctx: PipelineContext,
): ScanJobLike => {
	const record = input || {};
	const direct = record.scanJob as ScanJobLike | undefined;
	if (direct?.scanJobId) {
		return direct;
	}

	const candidateScanJob = (
		record.candidate as { scanJob?: ScanJobLike } | undefined
	)?.scanJob;
	if (candidateScanJob?.scanJobId) {
		return candidateScanJob;
	}

	const analysisResultScanJob = (
		record.analysisResult as { scanJob?: ScanJobLike } | undefined
	)?.scanJob;
	if (analysisResultScanJob?.scanJobId) {
		return analysisResultScanJob;
	}

	const pipelineScanJob = (ctx as PipelineScanJobContext).scanJob;
	if (pipelineScanJob?.scanJobId) {
		return {
			scanJobId: pipelineScanJob.scanJobId,
			pipelineId: pipelineScanJob.pipelineId,
			applicationId: pipelineScanJob.applicationId,
			composeId: pipelineScanJob.composeId,
		};
	}

	throw new Error("Unable to resolve scanJob from stage input");
};

const getStageConcurrencyLimit = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, StageContext>,
	ctx: TPipelineContext,
) => Math.max(1, (await stage.getDesiredConcurrency?.(ctx)) || 1);

const isRuntimeStageActive = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	stageName: string,
) => {
	const scanJob = await findScanJobByIdRepo(runtime.ctx.scanJobId).catch(
		() => null,
	);
	if (!scanJob) {
		return true;
	}
	const disabledStages = buildEffectiveDisabledStageSet({
		settings: scanJob.scanRuntimeSettings,
		stageNames: runtime.pipeline.stages.map((stage) => stage.id),
		edges: runtime.pipeline.edges.map((edge) => ({
			source: edge.from.id,
			target: edge.to.id,
		})),
		rootStageName: runtime.pipeline.stages[0]?.id,
	});
	return !disabledStages.has(stageName);
};

const validateSelectedDownstreamOutput = <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageName: string,
	stageOutput: unknown,
	routeKey?: string | null,
) => {
	const downstreamEdges = getDownstreamEdges(runtime.pipeline, stageName);
	if (!downstreamEdges.some((edge) => edge.route)) {
		return;
	}
	const routedEdges = downstreamEdges.filter((edge) => edge.route);
	if (routeKey == null) {
		throw new Error(`Stage ${stageName} output.json route is required`);
	}
	const selected = routedEdges.find((edge) => edge.route?.key === routeKey);
	if (!selected) {
		throw new Error(`Invalid route key ${routeKey} for stage ${stageName}`);
	}
	if (selected.outputSchema) {
		validateStructuredOutputSchemaSource(selected.outputSchema, stageOutput);
	}
};

const resolveStageTaskId = (
	stageName: string,
	ctx: PipelineContext,
	input: unknown,
	polledTaskId?: string,
) => {
	if (polledTaskId) {
		return polledTaskId;
	}
	const inputTaskId =
		input && typeof input === "object" && "taskId" in input
			? (input as { taskId?: unknown }).taskId
			: null;
	if (typeof inputTaskId === "string" && inputTaskId.length > 0) {
		return inputTaskId;
	}

	const pipelineScanJob = (ctx as PipelineScanJobContext).scanJob;
	if (pipelineScanJob?.scanJobId) {
		return pipelineScanJob.repositoryTaskId || pipelineScanJob.scanJobId;
	}

	throw new Error(`Unable to resolve taskId for stage ${stageName}`);
};

const createTaskStageContext = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	input: TInput,
	taskIdOverride?: string,
	taskRuntime?: {
		runtimeMode?: "new_session" | "fork_session" | null;
		forkedFromTaskId?: string | null;
		forkedFromThreadId?: string | null;
		laneRuntime?: StageLaneRuntime | null;
		containerIndex?: number | null;
		routeOutputSchemas?: StageContext["routeOutputSchemas"];
		taskName?: string | null;
		groupedPersistent?: boolean;
		allowAgentExit?: boolean;
	} | null,
) => {
	const taskId = resolveStageTaskId(stage.id, ctx, input, taskIdOverride);
	const scanJob = resolveStageScanJob(
		(input as Record<string, unknown> | null | undefined) || undefined,
		ctx,
	);
	const taskName =
		taskRuntime?.taskName || resolveStageTaskName(stage.id, input);
	const stagePersistent = await resolveStagePersistent(stage);
	const stageReuseContainer = await resolveStageReuseContainer(
		stage,
		stage.id,
	);
	const stageNullableOutput = await resolveStageNullableOutput(stage);
	const stageCtx = createStageContext({
		base: ctx,
		stageName: stage.id,
		scanJob,
		taskId,
		taskName,
		routeOutputSchemas: taskRuntime?.routeOutputSchemas,
		persistent: stagePersistent,
		reuseContainer: stageReuseContainer,
		nullableOutput: stageNullableOutput,
		groupedPersistent: taskRuntime?.groupedPersistent ?? false,
		allowAgentExit:
			taskRuntime?.allowAgentExit ?? stage.allowAgentExit ?? false,
		containerIndex:
			taskRuntime?.containerIndex ??
			taskRuntime?.laneRuntime?.laneIndex ??
			null,
		laneIndex: taskRuntime?.laneRuntime?.laneIndex ?? null,
		laneThreadId: taskRuntime?.laneRuntime?.threadId ?? null,
		laneDriverPid: taskRuntime?.laneRuntime?.driverPid ?? null,
		sessionMode: taskRuntime?.laneRuntime?.threadId
			? "new"
			: taskRuntime?.runtimeMode === "fork_session"
				? "fork"
				: "new",
		parentSessionId: taskRuntime?.forkedFromThreadId ?? null,
		parentTaskId: taskRuntime?.forkedFromTaskId ?? null,
	}) as unknown as TStageContext;
	return {
		taskId,
		scanJob,
		taskName,
		stageCtx,
	};
};

type OutputEnvelope = {
	route: string | null;
	exit: boolean;
	output: unknown;
};

const isOutputEnvelope = (value: unknown): value is OutputEnvelope => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		"route" in record &&
		(record.route === null || typeof record.route === "string") &&
		typeof record.exit === "boolean" &&
		"output" in record
	);
};

const resolveStageRawOutput = async (ctx: StageContext) => {
	const { stdoutPath, outputPath } = await getTaskRuntimePaths(ctx);
	const [stdoutContent, outputContent] = await Promise.all([
		readFileIfExists(stdoutPath),
		readFileIfExists(outputPath),
	]);
	const protocol = parseDriverStdout(stdoutContent);
	const taskSummary = summarizeTaskProtocol(stdoutContent);
	const progressSignature = sha1([stdoutContent, outputContent].join("\n"));
	const hasAgentOutput =
		protocol.events.some((event) => event.type === "thread") ||
		taskSummary.promptFinished;
	if (!taskSummary.completedAt) {
		return {
			rawOutput: null,
			stdoutContent,
			progressSignature,
			hasAgentOutput,
			hasExitSignal: false,
			routeKey: null,
		};
	}
	if (!outputContent.trim()) {
		throw new Error("ACP prompt completed without output.json");
	}
	if (outputContent.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(outputContent);
		} catch (error) {
			throw new Error(
				`Task output.json is invalid JSON: ${getErrorMessage(error)}`,
			);
		}
		if (!isOutputEnvelope(parsed)) {
			throw new Error(
				"Task output.json must be an object with route, exit, and output fields",
			);
		}
		if (!ctx.routeOutputSchemas?.length && parsed.route !== null) {
			throw new Error(
				"Task output.json route must be null for non-routed stages",
			);
		}
		return {
			rawOutput: JSON.stringify(parsed.output, null, 2),
			stdoutContent,
			progressSignature,
			hasAgentOutput,
			hasExitSignal: ctx.allowAgentExit ? parsed.exit : false,
			routeKey: parsed.route,
		};
	}

	return {
		rawOutput: null,
		stdoutContent,
		progressSignature,
		hasAgentOutput,
		hasExitSignal: false,
		routeKey: null,
	};
};

type StageLifecycleSuccess<TOutput, TStageContext extends StageContext> = {
	taskId: string;
	taskName: string;
	stageCtx: TStageContext;
	prepared: PreparedStageSuccess<TOutput>;
	output: TOutput;
	rawOutput: string;
};

type PreparedStageSuccess<TOutput> = {
	output: TOutput;
	vulnerabilityCandidateId: string | null;
	jobOutput: ScanJobOutput | null;
};

const isCandidateProducerStage = (stageId: string) =>
	(CANDIDATE_PRODUCER_STAGE_NAMES as readonly string[]).includes(stageId);

const prepareStageSuccess = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	_ctx: TPipelineContext,
	stageCtx: TStageContext,
	input: TInput,
	rawOutput: string,
): Promise<PreparedStageSuccess<TOutput>> => {
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	await assertScanJobNotCancelled(stageCtx);
	const validatedOutput = stage.validateOutput
		? stageCtx.nullableOutput && rawOutput.trim() === "null"
			? (null as TOutput)
			: await stage.validateOutput(stageCtx, input, rawOutput)
		: await defaultValidateOutput<TOutput>(stage.id, rawOutput);
	const output = normalizeCandidateResultStageOutput(
		stage.id,
		validatedOutput,
	) as TOutput;
	const vulnerabilityCandidateId =
		currentTask && CANDIDATE_RESULT_STAGE_NAMES.includes(stage.id as never)
			? await readCandidateIdFromTaskInputArtifact(currentTask)
			: null;
	const jobOutput = stage.jobOutput
		? await materializeTaskJobOutput({
				taskDir:
					stageCtx.persistent && stageCtx.laneIndex !== null
						? await stageCtx.laneDir()
						: await stageCtx.taskDir(),
				taskId: stageCtx.taskId,
				stageName: stage.id,
				output,
			})
		: null;
	return { output, vulnerabilityCandidateId, jobOutput };
};

const persistTerminalSuccess = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	_ctx: TPipelineContext,
	input: TInput,
	stageCtx: TStageContext,
	rawOutput: string,
	prepared: PreparedStageSuccess<TOutput>,
	routeKey: string | null,
	options?: {
		exitLane?: boolean;
		exitReason?: "agent_exit";
		runtime?: JobRuntime<TPipelineContext>;
	},
) => {
	const persistStartedAt = Date.now();
	const logPersistTiming = (
		step: string,
		startedAt: number,
		extra: Record<string, unknown> = {},
	) => {
		logPipelineEvent("stage.persist_success_timing", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			step,
			elapsedMs: Date.now() - startedAt,
			totalElapsedMs: Date.now() - persistStartedAt,
			...extra,
		});
	};
	let stepStartedAt = Date.now();
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	logPersistTiming("find_current_task", stepStartedAt);
	stepStartedAt = Date.now();
	const usagePatch = await readTaskTokenUsage(stageCtx).catch(() => ({
		inputTokens: null,
		outputTokens: null,
		thoughtTokens: null,
		totalTokens: null,
		cachedReadTokens: null,
		cachedWriteTokens: null,
	}));
	logPersistTiming("read_token_usage", stepStartedAt);
	stepStartedAt = Date.now();
	const shouldMarkTaskExited =
		Boolean(options?.exitReason) && (await isStageGroupLeaderTask(currentTask));
	logPersistTiming("check_group_leader_exit", stepStartedAt, {
		shouldMarkTaskExited,
	});
	stepStartedAt = Date.now();
	const transitionResult = await transitionTaskStatusResultRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "starting", "running"],
		to: shouldMarkTaskExited ? "exited" : "completed",
		patch: {
			output: prepared.output,
			...(prepared.vulnerabilityCandidateId
				? { vulnerabilityCandidateId: prepared.vulnerabilityCandidateId }
				: {}),
			...usagePatch,
			errorMessage: null,
			...(options?.exitReason
				? {
						exitReason: options.exitReason,
						exitNote: shouldMarkTaskExited
							? "Agent requested group leader exit"
							: "Agent requested lane exit",
						errorMessage: null,
					}
				: {}),
		},
		terminalRouteKey: routeKey,
		afterUpdate: async (tx) => {
			if (options?.exitReason) return;
			if (prepared.jobOutput) {
				await appendScanJobOutputTx(tx, {
					scanJobId: stageCtx.scanJobId,
					output: prepared.jobOutput,
				});
			}
			await stage.onSuccess?.(stageCtx, input, prepared.output, tx, {
				routeKey,
			});
		},
	});
	logPersistTiming("transition_task_status", stepStartedAt, {
		updated: transitionResult.outcome === "updated",
		transitionOutcome: transitionResult.outcome,
	});
	const completionClaimed = transitionResult.outcome === "updated";
	if (!completionClaimed) {
		logPipelineEvent("stage.stale_completion_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			transitionOutcome: transitionResult.outcome,
			jobStatus: transitionResult.jobStatus,
		});
		return false;
	}
	try {
		stepStartedAt = Date.now();
		await copyPersistentLaneArtifactsToTaskDir(stageCtx);
		logPersistTiming(
			"copy_persistent_lane_artifacts_to_task_dir",
			stepStartedAt,
		);
		stepStartedAt = Date.now();
		if (stageCtx.laneIndex !== null) {
			if (options?.exitLane) {
				if (shouldRemoveContainerAfterTask(stageCtx)) {
					await cleanupPersistentLaneForTask(stageCtx.taskId, options.runtime);
				} else {
					await resetStageLaneRuntimeSessionForExitRepo({
						taskId: stageCtx.taskId,
					}).catch(() => {});
				}
			} else {
				if (stageCtx.persistent) {
					await releasePersistentLaneForTask(stageCtx.taskId);
				} else {
					await resetStageLaneRuntimeSessionForExitRepo({
						taskId: stageCtx.taskId,
					}).catch(() => {});
				}
			}
		} else if (shouldRemoveContainerAfterTask(stageCtx)) {
			await cleanupTaskContainer(stageCtx.taskId);
		}
		logPersistTiming("cleanup_or_release_runtime", stepStartedAt, {
			laneIndex: stageCtx.laneIndex,
		});
	} catch (error) {
		logPipelineEvent("stage.post_success_cleanup_failed", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			errorMessage: getErrorMessage(error),
		});
	}
	logPipelineEvent("loop.task_completed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		rawOutputLength: rawOutput.length,
	});
	if (options?.exitReason) {
		logPipelineEvent("loop.task_exited", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			exitReason: options.exitReason,
			taskStatus: shouldMarkTaskExited ? "exited" : "completed",
		});
	}
	return true;
};

const persistTerminalFailure = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	stageCtx: TStageContext,
	input: TInput,
	error: unknown,
	_options?: { exitLane?: boolean },
) => {
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	if (
		currentTask &&
		currentTask.status !== "launching" &&
		currentTask.status !== "starting" &&
		currentTask.status !== "running"
	) {
		logPipelineEvent("stage.stale_failure_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			currentStatus: currentTask.status,
			errorMessage: getErrorMessage(error),
		});
		return false;
	}
	const usagePatch = await readTaskTokenUsage(stageCtx).catch(() => ({
		inputTokens: null,
		outputTokens: null,
		thoughtTokens: null,
		totalTokens: null,
		cachedReadTokens: null,
		cachedWriteTokens: null,
	}));
	const transitionResult = await transitionTaskStatusResultRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "starting", "running"],
		to: "failed",
		patch: { errorMessage: getErrorMessage(error), ...usagePatch },
	});
	if (transitionResult.outcome !== "updated") {
		logPipelineEvent("stage.failure_transition_skipped", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			transitionOutcome: transitionResult.outcome,
			jobStatus: transitionResult.jobStatus,
			errorMessage: getErrorMessage(error),
		});
		return false;
	}
	await completeDownstreamDispatchRepo(stageCtx.taskId).catch(() => {});
	const failureDiagnostics = await buildTaskFailureDiagnostics(stageCtx).catch(
		(diagnosticError) => ({
			error: `Unable to collect task failure diagnostics: ${getErrorMessage(
				diagnosticError,
			)}`,
		}),
	);
	await appendTaskFailureDiagnostics(
		stageCtx,
		getErrorMessage(error),
		failureDiagnostics,
	).catch(() => {});
	await cleanupFailedTaskRuntime(stageCtx.taskId);
	await stage.onFailure?.(stageCtx, input, error);
	logPipelineEvent("stage.failed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		errorMessage: getErrorMessage(error),
		diagnostics: failureDiagnostics,
	});
	logPipelineEvent("loop.task_failed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		errorMessage: getErrorMessage(error),
	});
	return true;
};

const runStageTaskLifecycle = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	input: TInput,
	options?: {
		taskIdOverride?: string;
		resumeOnly?: boolean;
	},
): Promise<StageLifecycleSuccess<TOutput, TStageContext>> => {
	const { taskId, taskName, stageCtx } = await createTaskStageContext(
		stage,
		ctx,
		input,
		options?.taskIdOverride,
		await findTaskByIdRepo(
			resolveStageTaskId(stage.id, ctx, input, options?.taskIdOverride),
		).catch(() => null),
	);
	logPipelineEvent(options?.resumeOnly ? "stage.resume" : "stage.start", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId,
		taskName,
	});
	try {
		await ensureTaskRuntimeDirectory(stageCtx);
		await assertScanJobNotCancelled(stageCtx);

		if (!options?.resumeOnly && stage.validateInput) {
			const isValid = await stage.validateInput(stageCtx, input);
			if (!isValid) {
				throw new Error(`Stage ${stage.id} rejected input ${taskId}`);
			}
		}

		if (!options?.resumeOnly) {
			await updateTaskDefault(taskId, { status: "launching" });
		}

		if (options?.resumeOnly) {
			throw new Error("Task polling is handled by the job loop");
		}
		const runResult = await stage.run(stageCtx, input);
		if (runResult.completion === "deferred") {
			throw new Error("Deferred stage launch is handled by the job loop");
		}
		const rawOutput = runResult.rawOutput;

		const output = await prepareStageSuccess(
			stage,
			ctx,
			stageCtx,
			input,
			rawOutput,
		);
		return {
			taskId,
			taskName,
			stageCtx,
			prepared: output,
			output: output.output,
			rawOutput,
		};
	} catch (error) {
		throw Object.assign(
			error instanceof Error ? error : new Error(String(error)),
			{
				stageCtx,
				taskId,
				taskName,
			},
		);
	}
};

export const runPipeline = async <
	TPipelineContext extends PipelineContext,
	TPipelineStages extends PipelineDefinition<TPipelineContext>["stages"],
>(
	pipeline: PipelineDefinition<TPipelineContext, TPipelineStages>,
	ctx: TPipelineContext,
	firstStageInput?: FirstStageInputOf<TPipelineStages>,
) => {
	const stageNames = pipeline.stages.map((stage) => stage.id);
	if (stageNames.length === 0) {
		return;
	}

	await assertScanJobNotCancelled(ctx);
	logPipelineEvent("pipeline.start", {
		pipelineName: pipeline.name,
		scanJobId: ctx.scanJobId,
		stageNames,
		hasFirstStageInput: firstStageInput !== undefined,
	});

	try {
		const runtime = startPipelineRuntime(pipeline, ctx);
		if (firstStageInput !== undefined) {
			const firstStage = pipeline.stages[0];
			if (!firstStage) {
				return;
			}
			const firstStageState = runtime.stageStates.get(firstStage.id);
			if (!firstStageState) {
				throw new Error(`Runtime state missing for stage ${firstStage.name}`);
			}
			await launchStageExecution(
				runtime,
				firstStageState as RuntimeStageState<
					TPipelineContext,
					FirstStageInputOf<TPipelineStages>,
					unknown
				>,
				{
					taskId: resolveStageTaskId(firstStage.id, ctx, firstStageInput),
					input: firstStageInput,
				},
			);
		}

		await runtime.completionPromise;
		logPipelineEvent("pipeline.completed", {
			pipelineName: pipeline.name,
			scanJobId: ctx.scanJobId,
		});
	} catch (error) {
		logPipelineEvent("pipeline.failed", {
			pipelineName: pipeline.name,
			scanJobId: ctx.scanJobId,
			errorMessage: getErrorMessage(error),
		});
		throw error;
	}
};

export const runStageOnce = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	input: TInput,
	taskIdOverride?: string,
): Promise<TOutput> => {
	try {
		const result = await runStageTaskLifecycle(stage, ctx, input, {
			taskIdOverride,
		});
		const terminalUpdated = await persistTerminalSuccess(
			stage,
			ctx,
			input,
			result.stageCtx,
			result.rawOutput,
			result.prepared,
			null,
		);
		if (terminalUpdated) {
			await completeDownstreamDispatchRepo(result.taskId);
		}
		return result.output;
	} catch (error) {
		const { stageCtx } = await createTaskStageContext(
			stage,
			ctx,
			input,
			taskIdOverride,
		);
		await persistTerminalFailure(stage, ctx, stageCtx, input, error);
		throw error;
	}
};

type RuntimeStageState<
	TPipelineContext extends PipelineContext,
	TInput = unknown,
	TOutput = unknown,
> = {
	stageName: string;
	stage: StageDefinition<TPipelineContext, TInput, TOutput, StageContext>;
};

type JobRuntime<TPipelineContext extends PipelineContext> = {
	key: string;
	pipeline: PipelineDefinition<TPipelineContext>;
	ctx: TPipelineContext;
	stageStates: Map<string, RuntimeStageState<TPipelineContext>>;
	runtimeSettingsPolicy: ReturnType<typeof createRuntimeSettingsPolicy>;
	defaultConcurrencyByStage: Map<string, number>;
	runningStdoutSnapshots: Map<
		string,
		{
			hash: string;
			lastChangedAt: number;
			lastDiagnosticKey?: string;
			lastRunningOutputWithoutEndTurnDiagnosticKey?: string;
			lastRunningOutputWithoutEndTurnLoggedAt?: number;
		}
	>;
	launchingTaskIds: Set<string>;
	wakeSignal: WakeSignal;
	stopRequested: boolean;
	failure: unknown;
	completionPromise: Promise<void>;
};

const buildRuntimeLoopSnapshot = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
): Promise<
	RuntimeLoopSnapshot<
		Awaited<ReturnType<typeof listActiveTasksByScanJobIdRepo>>[number],
		PendingTaskQueueMetadata
	>
> => {
	const [control, activeTasks, pendingTasks, statusCounts] = await Promise.all([
		findScanJobRuntimeControlRepo(runtime.ctx.scanJobId),
		listActiveTasksByScanJobIdRepo(runtime.ctx.scanJobId),
		listPendingTaskQueueMetadataByScanJobIdRepo(runtime.ctx.scanJobId),
		countTasksByScanJobStageAndStatusRepo(runtime.ctx.scanJobId),
	]);
	const activeTasksByStage = groupActiveTasksByStage(activeTasks);
	const disabledStages =
		runtime.runtimeSettingsPolicy.buildEffectiveDisabledStageSet({
			settings: control?.scanRuntimeSettings ?? {},
			stageNames: [...runtime.stageStates.keys()],
			edges: runtime.pipeline.edges.map((edge) => ({
				source: edge.from.id,
				target: edge.to.id,
			})),
			rootStageName: runtime.pipeline.stages[0]?.id,
		});
	const stagePolicies = new Map(
		[...runtime.stageStates.values()].map((stageState) => {
			const setting = runtime.runtimeSettingsPolicy.getStageSetting(
				control?.scanRuntimeSettings ?? {},
				stageState.stageName,
			);
			const configuredConcurrency =
				setting.concurrency ??
				runtime.defaultConcurrencyByStage.get(stageState.stageName) ??
				1;
			const concurrency = Math.max(1, configuredConcurrency);
			return [
				stageState.stageName,
				{
					stageName: stageState.stageName,
					disabled: disabledStages.has(stageState.stageName),
					concurrency,
				},
			] as const;
		}),
	);

	return {
		status: control?.status ?? null,
		activeTasksByStage,
		activeCountByStage: new Map(
			[...activeTasksByStage.entries()].map(([stageName, tasks]) => [
				stageName,
				tasks.length,
			]),
		),
		pendingTargets: pendingTasks.map(
			(task): PendingQueueTarget => ({
				taskId: task.taskId,
				stageName: task.stageName,
				groupInstanceId: task.stageGroupInstanceId,
			}),
		),
		pendingTaskMetadata: pendingTasks,
		stagePolicies,
		statusCounts: statusCounts.map((row) => ({
			stageName: row.stageName,
			status: row.status,
			count: Number(row.count),
		})),
	};
};

class WakeSignal {
	private version = 0;
	private waiters = new Set<(version: number) => void>();

	current() {
		return this.version;
	}

	notify() {
		this.version += 1;
		const nextVersion = this.version;
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const waiter of waiters) {
			waiter(nextVersion);
		}
	}

	wait(previousVersion: number) {
		if (this.version !== previousVersion) {
			return Promise.resolve(this.version);
		}
		return new Promise<number>((resolve) => {
			this.waiters.add(resolve);
		});
	}
}

const pipelineSupervisorJobs =
	getPipelineRuntimeRegistry<JobRuntime<PipelineContext>>();

export const stopPipelineRuntimesForScanJob = (scanJobId: string) => {
	let stoppedRuntimes = 0;
	for (const runtime of pipelineSupervisorJobs.values()) {
		if (runtime.ctx.scanJobId !== scanJobId) {
			continue;
		}
		runtime.stopRequested = true;
		runtime.wakeSignal.notify();
		stoppedRuntimes += 1;
	}
	return stoppedRuntimes;
};

export const wakePipelineRuntimesForScanJob = (scanJobId: string) => {
	let wokenRuntimes = 0;
	for (const runtime of pipelineSupervisorJobs.values()) {
		if (runtime.ctx.scanJobId !== scanJobId) continue;
		runtime.wakeSignal.notify();
		wokenRuntimes += 1;
	}
	return wokenRuntimes;
};

const getJobRuntimeKey = (pipelineName: string, scanJobId: string) =>
	`${pipelineName}:${scanJobId}`;

const handleJobRuntimeFailure = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	error: unknown,
) => {
	if (error instanceof Error && error.name === SCAN_JOB_CANCELLED_ERROR_NAME) {
		logPipelineEvent("loop.cancelled", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			errorMessage: error.message,
		});
		runtime.stopRequested = true;
		runtime.wakeSignal.notify();
		return;
	}
	if (!runtime.failure) {
		runtime.failure = error;
	}
	runtime.stopRequested = true;
	runtime.wakeSignal.notify();
};

export const trySettleScanJob = async (scanJobId: string) => {
	const result = await settleScanJobRepo(scanJobId);
	if (result.status === "not_ready") {
		return result.status;
	}
	if (result.status === "terminal") {
		return result.status;
	}
	try {
		await cleanupTerminalJobRuntime(scanJobId);
	} catch (error) {
		logPipelineEvent("pipeline.finalization_cleanup_failed", {
			scanJobId,
			errorMessage: getErrorMessage(error),
		});
		return "finalizing" as const;
	}
	const status = await finalizeScanJobRepo(scanJobId);
	return status ? ("terminal" as const) : ("finalizing" as const);
};

export const finalizeScanJob = async (scanJobId: string) => {
	await cleanupTerminalJobRuntime(scanJobId);
	return await finalizeScanJobRepo(scanJobId);
};

const claimReusableContainerIndexForStage = async (input: {
	scanJobId: string;
	stageName: string;
	containerCount: number;
}) => {
	const activeTasks = await listActiveTasksByScanJobAndStageRepo({
		scanJobId: input.scanJobId,
		stageName: input.stageName,
	});
	const usedIndexes = new Set(
		activeTasks
			.map((task) => task.containerIndex)
			.filter((value): value is number => typeof value === "number"),
	);
	for (let index = 0; index < input.containerCount; index += 1) {
		if (!usedIndexes.has(index)) {
			return index;
		}
	}
	return null;
};

const launchStageExecution = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext, TInput, TOutput>,
	execution: StageExecution<TInput>,
	options?: { logEvent?: string },
) => {
	const launchStartedAt = Date.now();
	const logLaunchTiming = (
		step: string,
		startedAt: number,
		extra: Record<string, unknown> = {},
	) => {
		logPipelineEvent("stage.launch_timing", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			step,
			elapsedMs: Date.now() - startedAt,
			totalElapsedMs: Date.now() - launchStartedAt,
			...extra,
			});
		};
	const launchControl = await findScanJobRuntimeControlRepo(
		runtime.ctx.scanJobId,
	).catch(() => null);
	if (launchControl?.status !== "running") {
		logPipelineEvent("stage.launch_skipped_job_state", {
			scanJobId: runtime.ctx.scanJobId,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			jobStatus: launchControl?.status ?? "missing",
		});
		return false;
	}
	let stepStartedAt = Date.now();
	const limit = await getStageConcurrencyLimit(stageState.stage, runtime.ctx);
	const pendingTask = await findTaskByIdRepo(execution.taskId).catch(
		() => null,
	);
	const queueScope = pendingTask
		? (await resolvePendingTaskQueueScope(pendingTask)) || {}
		: {};
	const group = getStageGroup(runtime.pipeline, stageState.stageName);
	const leaderGroup = getStageLeaderGroup(
		runtime.pipeline,
		stageState.stageName,
	);
	const persistentBacked = await resolveStagePersistent(stageState.stage);
	const reuseContainer = await resolveStageReuseContainer(
		stageState.stage,
		stageState.stageName,
	);
	logLaunchTiming("load_pending_and_scope", stepStartedAt, {
		concurrencyLimit: limit,
		persistent: persistentBacked,
		reuseContainer,
		hasPendingTask: Boolean(pendingTask),
		groupName: group?.name ?? null,
		leaderGroupName: leaderGroup?.name ?? null,
	});
	stepStartedAt = Date.now();
	const boundMembership =
		pendingTask?.stageGroupInstanceId && persistentBacked
			? await findStageGroupLaneMembershipRepo({
					groupInstanceId: pendingTask.stageGroupInstanceId,
					stageName: stageState.stageName,
				}).catch(() => null)
			: null;
	const reservedLaneIndexes =
		!boundMembership && persistentBacked
			? await listReservedLaneIndexesForStage({
					scanJobId: runtime.ctx.scanJobId,
					stageName: stageState.stageName,
					allowedGroupInstanceId: pendingTask?.stageGroupInstanceId ?? null,
					runtime: runtime as unknown as JobRuntime<PipelineContext>,
				})
			: [];
	let laneRuntime = boundMembership
		? await claimSpecificStageLaneRuntimeRepo({
				scanJobId: runtime.ctx.scanJobId,
				stageName: stageState.stageName,
				laneIndex: boundMembership.laneIndex,
				laneCount: limit,
				taskId: execution.taskId,
			})
		: persistentBacked
			? await claimIdleStageLaneRuntimeRepo({
					scanJobId: runtime.ctx.scanJobId,
					stageName: stageState.stageName,
					laneCount: limit,
					taskId: execution.taskId,
					forkedFromTaskId: pendingTask?.forkedFromTaskId ?? null,
					forkedFromThreadId: pendingTask?.forkedFromThreadId ?? null,
					excludedLaneIndexes: reservedLaneIndexes,
				})
			: null;
	logLaunchTiming("claim_lane", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		boundLaneIndex: boundMembership?.laneIndex ?? null,
		reservedLaneIndexes,
	});
	if (persistentBacked && !laneRuntime) {
		await stageState.stage.queue
			?.enqueue(execution.taskId, queueScope)
			.catch(() => {});
		logLaunchTiming("requeue_no_lane", launchStartedAt);
		return false;
	}
	stepStartedAt = Date.now();
	const containerIndex = laneRuntime
		? laneRuntime.laneIndex
		: reuseContainer
			? await claimReusableContainerIndexForStage({
					scanJobId: runtime.ctx.scanJobId,
					stageName: stageState.stageName,
					containerCount: limit,
				})
			: null;
	logLaunchTiming("claim_container", stepStartedAt, {
		containerIndex,
	});
	if (reuseContainer && containerIndex === null) {
		await stageState.stage.queue
			?.enqueue(execution.taskId, queueScope)
			.catch(() => {});
		logLaunchTiming("requeue_no_container", launchStartedAt);
		return false;
	}
	stepStartedAt = Date.now();
	const launchTransition = await transitionTaskStatusResultRepo({
		taskId: execution.taskId,
		from: ["pending"],
		to: "launching",
		patch: {
			containerIndex,
		},
	});
	logLaunchTiming("transition_launching", stepStartedAt, {
		launched: launchTransition.outcome === "updated",
		transitionOutcome: launchTransition.outcome,
		containerIndex,
	});
	const launched = launchTransition.task;
	if (!launched) {
		if (laneRuntime) {
			await releaseStageLaneRuntimeRepo(execution.taskId).catch(() => {});
		}
		return false;
	}

	stepStartedAt = Date.now();
	if (laneRuntime && leaderGroup) {
		const existingGroup = pendingTask?.stageGroupInstanceId
			? await findStageGroupInstanceByIdRepo(
					pendingTask.stageGroupInstanceId,
				).catch(() => null)
			: null;
		const groupInstance =
			existingGroup && existingGroup.status === "active"
				? existingGroup
				: await createStageGroupInstanceRepo({
						scanJobId: runtime.ctx.scanJobId,
						groupName: leaderGroup.name,
						leaderStageName: stageState.stageName,
						leaderLaneIndex: laneRuntime.laneIndex,
						leaderTaskId: execution.taskId,
					});
		await ensureStageGroupLaneMembershipRepo({
			groupInstanceId: groupInstance.groupInstanceId,
			stageName: stageState.stageName,
			laneIndex: laneRuntime.laneIndex,
			role: "leader",
		});
		await updateTaskRepo(execution.taskId, {
			stageGroupInstanceId: groupInstance.groupInstanceId,
		});
	} else if (laneRuntime && pendingTask?.stageGroupInstanceId && group) {
		await ensureStageGroupLaneMembershipRepo({
			groupInstanceId: pendingTask.stageGroupInstanceId,
			stageName: stageState.stageName,
			laneIndex: laneRuntime.laneIndex,
			role: "member",
		});
	}
	logLaunchTiming("stage_group_membership", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		stageGroupInstanceId: launched.stageGroupInstanceId ?? null,
	});

	stepStartedAt = Date.now();
	if (
		laneRuntime &&
		persistentBacked &&
		laneRuntime.threadId &&
		!pendingTask?.stageGroupInstanceId &&
		((laneRuntime.forkedFromTaskId ?? null) !==
			(launched.forkedFromTaskId ?? null) ||
			(laneRuntime.forkedFromThreadId ?? null) !==
				(launched.forkedFromThreadId ?? null))
	) {
		const staleLaneRuntime = laneRuntime;
		if (staleLaneRuntime.containerName) {
			await removeContainer(staleLaneRuntime.containerName).catch(() => {});
		}
		laneRuntime =
			(await resetClaimedStageLaneRuntimeForFreshStartRepo({
				scanJobId: staleLaneRuntime.scanJobId,
				stageName: staleLaneRuntime.stageName,
				laneIndex: staleLaneRuntime.laneIndex,
				forkedFromTaskId: launched.forkedFromTaskId ?? null,
				forkedFromThreadId: launched.forkedFromThreadId ?? null,
			})) ?? staleLaneRuntime;
		logPipelineEvent("stage.persistent_lane_parent_changed", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			laneIndex: laneRuntime.laneIndex,
		});
	}
	logLaunchTiming("stale_lane_check", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		threadId: laneRuntime?.threadId ?? null,
	});

	stepStartedAt = Date.now();
	const { stageCtx } = await createTaskStageContext(
		stageState.stage,
		runtime.ctx,
		execution.input,
		execution.taskId,
		{
			...launched,
			laneRuntime,
			containerIndex,
			routeOutputSchemas: getStageRouteOutputSchemas(
				runtime.pipeline,
				stageState.stageName,
			),
			taskName: launched.name,
			groupedPersistent: Boolean(laneRuntime && group),
			allowAgentExit: stageState.stage.allowAgentExit ?? false,
		},
	);
	logLaunchTiming("create_stage_context", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		containerIndex,
	});
	try {
		stepStartedAt = Date.now();
		await ensureTaskRuntimeDirectory(stageCtx);
		await assertScanJobNotCancelled(stageCtx);
		if (stageState.stage.validateInput) {
			const isValid = await stageState.stage.validateInput(
				stageCtx,
				execution.input,
			);
			if (!isValid) {
				throw new Error(
					`Stage ${stageState.stage.id} rejected input ${execution.taskId}`,
				);
			}
		}
		logLaunchTiming("ensure_runtime_and_validate", stepStartedAt);

		const launchStage = stageState.stage.launch;
		if (launchStage) {
			runtime.launchingTaskIds.add(execution.taskId);
			void (async () => {
				const asyncLaunchStartedAt = Date.now();
				try {
					await launchStage(stageCtx, execution.input);
					const [launchControl, launchTask] = await Promise.all([
						findScanJobRuntimeControlRepo(runtime.ctx.scanJobId).catch(
							() => null,
						),
						findTaskByIdRepo(execution.taskId).catch(() => null),
					]);
					const launchDisposition = resolveLaunchDisposition({
						scanJobStatus: launchControl?.status,
						taskStatus: launchTask?.status,
					});
					if (launchDisposition !== "continue") {
						await discardInFlightLaunch({
							taskId: execution.taskId,
							stageCtx,
							disposition: launchDisposition,
						});
						return;
					}
					logLaunchTiming("stage_launch", asyncLaunchStartedAt, {
						laneIndex: laneRuntime?.laneIndex ?? null,
						containerIndex,
					});
					const launchCompleted = await transitionTaskStatusRepo({
						taskId: execution.taskId,
						from: ["launching"],
						to: "launched",
						patch: { errorMessage: null },
					});
					logPipelineEvent("stage.launched", {
						scanJobId: runtime.ctx.scanJobId,
						pipelineName: runtime.pipeline.name,
						stageName: stageState.stageName,
						taskId: execution.taskId,
						taskName: stageCtx.taskName,
						transitioned: Boolean(launchCompleted),
						elapsedMs: Date.now() - asyncLaunchStartedAt,
					});
					if (!launchCompleted) {
						await cleanupFailedTaskRuntime(execution.taskId);
					}
				} catch (error) {
					const [errorControl, errorTask] = await Promise.all([
						findScanJobRuntimeControlRepo(runtime.ctx.scanJobId).catch(
							() => null,
						),
						findTaskByIdRepo(execution.taskId).catch(() => null),
					]);
					const errorDisposition = resolveLaunchDisposition({
						scanJobStatus: errorControl?.status,
						taskStatus: errorTask?.status,
					});
					if (errorDisposition !== "continue") {
						await discardInFlightLaunch({
							taskId: execution.taskId,
							stageCtx,
							disposition: errorDisposition,
						});
						return;
					}
					const nextAttempt = (launched.attempt ?? 0) + 1;
					if (
						isTransientRuntimeLaunchError(error) &&
						nextAttempt <= MAX_TRANSIENT_LAUNCH_RETRIES
					) {
						const failedTask = await findTaskByIdRepo(execution.taskId).catch(
							() => null,
						);
						const failedContainerName =
							failedTask?.containerName || stageCtx.containerName();
						if (failedContainerName) {
							await removeContainer(failedContainerName).catch(() => {});
						}
						if (laneRuntime) {
							await releaseStageLaneRuntimeRepo(execution.taskId).catch(
								() => {},
							);
						}
						const requeued = await transitionTaskStatusRepo({
							taskId: execution.taskId,
							from: ["launching"],
							to: "pending",
							patch: {
								attempt: nextAttempt,
								containerName: null,
								containerIndex: null,
								threadId: null,
								errorMessage: `Transient runtime launch failure; retry ${nextAttempt}/${MAX_TRANSIENT_LAUNCH_RETRIES}: ${getErrorMessage(error)}`,
							},
						});
						if (requeued) {
							await stageState.stage.queue
								?.enqueue(execution.taskId, queueScope)
								.catch(() => {});
						} else {
							await cleanupFailedTaskRuntime(execution.taskId);
							return;
						}
						logPipelineEvent("stage.launch_retry", {
							scanJobId: runtime.ctx.scanJobId,
							pipelineName: runtime.pipeline.name,
							stageName: stageState.stageName,
							taskId: execution.taskId,
							taskName: stageCtx.taskName,
							attempt: nextAttempt,
							maxAttempts: MAX_TRANSIENT_LAUNCH_RETRIES,
							errorMessage: getErrorMessage(error),
						});
					} else {
						const failurePersisted = await persistTerminalFailure(
							stageState.stage,
							runtime.ctx,
							stageCtx,
							execution.input,
							error,
						);
						if (!failurePersisted) {
							await cleanupFailedTaskRuntime(execution.taskId);
						}
						await maybeMarkTaskStageGroupExited(execution.taskId, runtime);
					}
				} finally {
					runtime.launchingTaskIds.delete(execution.taskId);
					runtime.wakeSignal.notify();
				}
			})();
			logPipelineEvent("loop.stage_launch_spawned", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: stageState.stageName,
				taskId: execution.taskId,
				taskName: stageCtx.taskName,
			});
			return true;
		}

		stepStartedAt = Date.now();
		const runResult = await stageState.stage.run(stageCtx, execution.input);
		logLaunchTiming("stage_run", stepStartedAt, {
			completion: runResult.completion,
			threadId: "threadId" in runResult ? runResult.threadId : null,
			laneIndex: laneRuntime?.laneIndex ?? null,
			containerIndex,
		});
		if (runResult.completion === "immediate") {
			stepStartedAt = Date.now();
			const prepared = await prepareStageSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				execution.input,
				runResult.rawOutput,
			);
			logLaunchTiming("prepare_immediate_success", stepStartedAt);
			validateSelectedDownstreamOutput(
				runtime,
				stageState.stageName,
				prepared.output,
				null,
			);
			stepStartedAt = Date.now();
			const terminalUpdated = await persistTerminalSuccess(
				stageState.stage,
				runtime.ctx,
				execution.input,
				stageCtx,
				runResult.rawOutput,
				prepared,
				null,
				{ runtime },
			);
			logLaunchTiming("persist_immediate_success", stepStartedAt, {
				terminalUpdated,
			});
			if (terminalUpdated) {
				stepStartedAt = Date.now();
				await dispatchPipelineDownstream(
					runtime,
					stageState.stageName,
					execution.taskId,
					execution.input,
					prepared.output,
					null,
				);
				logLaunchTiming("dispatch_immediate_downstream", stepStartedAt);
				await maybeMarkTaskStageGroupExited(execution.taskId, runtime);
			}
		}
	} catch (error) {
		const nextAttempt = (launched.attempt ?? 0) + 1;
		if (
			isTransientRuntimeLaunchError(error) &&
			nextAttempt <= MAX_TRANSIENT_LAUNCH_RETRIES
		) {
			const failedTask = await findTaskByIdRepo(execution.taskId).catch(
				() => null,
			);
			const failedContainerName =
				failedTask?.containerName || stageCtx.containerName();
			if (failedContainerName) {
				await removeContainer(failedContainerName).catch(() => {});
			}
			if (laneRuntime) {
				await releaseStageLaneRuntimeRepo(execution.taskId).catch(() => {});
			}
			await transitionTaskStatusRepo({
				taskId: execution.taskId,
				from: ["launching"],
				to: "pending",
				patch: {
					attempt: nextAttempt,
					containerName: null,
					containerIndex: null,
					threadId: null,
					errorMessage: `Transient runtime launch failure; retry ${nextAttempt}/${MAX_TRANSIENT_LAUNCH_RETRIES}: ${getErrorMessage(error)}`,
				},
			});
			await stageState.stage.queue
				?.enqueue(execution.taskId, queueScope)
				.catch(() => {});
			logPipelineEvent("stage.launch_retry", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: stageState.stageName,
				taskId: execution.taskId,
				taskName: stageCtx.taskName,
				attempt: nextAttempt,
				maxAttempts: MAX_TRANSIENT_LAUNCH_RETRIES,
				errorMessage: getErrorMessage(error),
			});
			await backfillStageQueue(runtime, stageState);
			return true;
		}
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			execution.input,
			error,
		);
		await maybeMarkTaskStageGroupExited(execution.taskId, runtime);
		await backfillStageQueue(runtime, stageState);
	} finally {
		runtime.wakeSignal.notify();
	}
	if (!options?.logEvent) {
		logPipelineEvent("loop.stage_spawned", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
		});
	}
	return true;
};

const startStageRunAsync = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
	stageCtx: StageContext,
	input: unknown,
) => {
	void (async () => {
		const runStartedAt = Date.now();
		try {
			const runResult = await stageState.stage.run(stageCtx, input);
			logPipelineEvent("stage.run_started", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: stageState.stageName,
				taskId: task.taskId,
				taskName: stageCtx.taskName,
				completion: runResult.completion,
				threadId: "threadId" in runResult ? runResult.threadId : null,
				elapsedMs: Date.now() - runStartedAt,
			});
			if (runResult.completion === "immediate") {
				const prepared = await prepareStageSuccess(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					input,
					runResult.rawOutput,
				);
				validateSelectedDownstreamOutput(
					runtime,
					stageState.stageName,
					prepared.output,
					null,
				);
				const terminalUpdated = await persistTerminalSuccess(
					stageState.stage,
					runtime.ctx,
					input,
					stageCtx,
					runResult.rawOutput,
					prepared,
					null,
					{ runtime },
				);
				if (terminalUpdated) {
					await dispatchPipelineDownstream(
						runtime,
						stageState.stageName,
						task.taskId,
						input,
						prepared.output,
						null,
					);
					await maybeMarkTaskStageGroupExited(task.taskId, runtime);
				}
				return;
			}
			if (runResult.threadId) {
				const lane = await findStageLaneRuntimeByActiveTaskIdRepo(task.taskId);
				if (lane) {
					await bindStageLaneRuntimeRepo({
						scanJobId: lane.scanJobId,
						stageName: lane.stageName,
						laneIndex: lane.laneIndex,
						containerName: task.containerName,
						threadId: runResult.threadId,
					});
				}
				await transitionTaskStatusRepo({
					taskId: task.taskId,
					from: ["starting"],
					to: "running",
					patch: { threadId: runResult.threadId, errorMessage: null },
				});
				runtime.runningStdoutSnapshots.delete(task.taskId);
				logPipelineEvent("loop.task_running", {
					scanJobId: runtime.ctx.scanJobId,
					pipelineName: runtime.pipeline.name,
					stageName: task.stageName,
					taskId: task.taskId,
					taskName: task.name,
					threadId: runResult.threadId,
				});
			}
		} catch (error) {
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				error,
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		} finally {
			runtime.wakeSignal.notify();
		}
	})();
};

const inspectActiveStageTask = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
) => {
	const inspectStartedAt = Date.now();
	const logInspectTiming = (
		step: string,
		startedAt: number,
		extra: Record<string, unknown> = {},
	) => {
		logPipelineEvent("stage.inspect_timing", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: task.taskId,
			taskName: task.name,
			status: task.status,
			step,
			elapsedMs: Date.now() - startedAt,
			totalElapsedMs: Date.now() - inspectStartedAt,
			...extra,
		});
	};
	let stepStartedAt = Date.now();
	const stageCtx = await createStageContextForTask(runtime, task);
	const input = task.input as unknown;
	const { stdoutPath } = await getTaskRuntimePaths(stageCtx);
	const stdoutContent = await readFileIfExists(stdoutPath);
	logInspectTiming("load_runtime_logs", stepStartedAt);

	if (task.status === "launched") {
		stepStartedAt = Date.now();
		const claimed = await transitionTaskStatusRepo({
			taskId: task.taskId,
			from: ["launched"],
			to: "starting",
			patch: { errorMessage: null },
		});
		logInspectTiming("transition_starting", stepStartedAt, {
			claimed: Boolean(claimed),
		});
		if (claimed) {
			startStageRunAsync(runtime, stageState, claimed, stageCtx, input);
		}
		return true;
	}

	if (task.status === "launching" || task.status === "starting") {
		if (task.status === "launching") {
			if (runtime.launchingTaskIds.has(task.taskId)) {
				logInspectTiming("launching_waiting_for_launch", stepStartedAt, {
					containerName: task.containerName ?? null,
					reason: "launch_in_progress",
				});
				return false;
			}

			stepStartedAt = Date.now();
			const containerAlive = await isContainerAlive(task.containerName);
			logInspectTiming("recover_launching_container", stepStartedAt, {
				containerAlive,
				containerName: task.containerName ?? null,
			});
			if (containerAlive) {
				stepStartedAt = Date.now();
				const recovered = await transitionTaskStatusRepo({
					taskId: task.taskId,
					from: ["launching"],
					to: "launched",
					patch: { errorMessage: null },
				});
				logInspectTiming("recover_launching_as_launched", stepStartedAt, {
					recovered: Boolean(recovered),
				});
				return Boolean(recovered);
			}

			stepStartedAt = Date.now();
			const queueScope = await resolvePendingTaskQueueScope(task);
			if (queueScope !== null) {
				await releaseStageLaneRuntimeRepo(task.taskId).catch(() => {});
			}
			const requeued = await transitionTaskStatusRepo({
				taskId: task.taskId,
				from: ["launching"],
				to: "pending",
				patch: {
					containerName: null,
					containerIndex: null,
					threadId: null,
					errorMessage: "Recovered interrupted runtime launch; retrying",
				},
			});
			if (requeued && queueScope !== null) {
				await stageState.stage.queue
					?.enqueue(task.taskId, queueScope)
					.catch(() => {});
			}
			logInspectTiming("recover_launching_as_pending", stepStartedAt, {
				requeued: Boolean(requeued),
				queueScope: queueScope?.groupInstanceId ? "group" : "global",
			});
			return Boolean(requeued);
		}
		stepStartedAt = Date.now();
		const threadId = extractThreadIdFromStdout(stdoutContent);
		const driverPid = extractDriverPidFromStdout(stdoutContent);
		const lane =
			driverPid !== null || threadId
				? await findStageLaneRuntimeByActiveTaskIdRepo(task.taskId)
				: null;
		if (driverPid !== null) {
			if (lane) {
				await bindStageLaneRuntimeRepo({
					scanJobId: lane.scanJobId,
					stageName: lane.stageName,
					laneIndex: lane.laneIndex,
					containerName: task.containerName,
					driverPid,
				});
			}
		}
		if (threadId) {
			if (lane) {
				await bindStageLaneRuntimeRepo({
					scanJobId: lane.scanJobId,
					stageName: lane.stageName,
					laneIndex: lane.laneIndex,
					containerName: task.containerName,
					threadId,
				});
			}
			await transitionTaskStatusRepo({
				taskId: task.taskId,
				from: [task.status],
				to: "running",
				patch: { threadId, errorMessage: null },
			});
			runtime.runningStdoutSnapshots.delete(task.taskId);
			logPipelineEvent("loop.task_running", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: task.stageName,
				taskId: task.taskId,
				taskName: task.name,
				threadId,
			});
			logInspectTiming("transition_running", stepStartedAt, { threadId });
			return true;
		}

		const exitCode = extractDriverExitCode(stdoutContent);
		if (exitCode !== null) {
			stepStartedAt = Date.now();
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				exitCode === 0
					? new Error("ACP driver exited before reporting THREAD_ID")
					: new Error(
							`ACP driver exited with code ${exitCode} before reporting THREAD_ID`,
						),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			logInspectTiming("persist_launch_failure", stepStartedAt, { exitCode });
			return true;
		}

		stepStartedAt = Date.now();
		const containerAlive = await isContainerAlive(task.containerName);
		logInspectTiming(`${task.status}_container_alive`, stepStartedAt, {
			containerAlive,
		});
		if (!containerAlive) {
			stepStartedAt = Date.now();
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				new Error("Task runtime container stopped before reporting THREAD_ID"),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			logInspectTiming("persist_container_stopped_failure", stepStartedAt);
			return true;
		}

		stepStartedAt = Date.now();
		const halfStarted = await inspectHalfStartedRunningTask(runtime, {
			...task,
			status: "running",
		});
		logInspectTiming("inspect_half_started", stepStartedAt, {
			halfStarted: Boolean(halfStarted),
			reason: halfStarted?.reason ?? null,
		});
		if (halfStarted) {
			stepStartedAt = Date.now();
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				new Error(`Task became silently stuck: ${halfStarted.reason}`),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			logInspectTiming("persist_half_started_failure", stepStartedAt);
			return true;
		}
		return false;
	}

	let resolvedOutput: Awaited<ReturnType<typeof resolveStageRawOutput>>;
	try {
		stepStartedAt = Date.now();
		resolvedOutput = await resolveStageRawOutput(stageCtx);
		logInspectTiming("resolve_stage_raw_output", stepStartedAt, {
			hasRawOutput: resolvedOutput.rawOutput !== null,
			hasExitSignal: resolvedOutput.hasExitSignal,
			routeKey: resolvedOutput.routeKey ?? null,
		});
	} catch (error) {
		stepStartedAt = Date.now();
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			error,
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming("persist_resolve_failure", stepStartedAt);
		return true;
	}
	const {
		rawOutput,
		stdoutContent: rawStdoutContent,
		hasExitSignal,
		routeKey,
	} = resolvedOutput;
	if (rawOutput !== null) {
		try {
			stepStartedAt = Date.now();
			const prepared = await prepareStageSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				rawOutput,
			);
			logInspectTiming("prepare_stage_success", stepStartedAt);
			stepStartedAt = Date.now();
			validateSelectedDownstreamOutput(
				runtime,
				stageState.stageName,
				prepared.output,
				routeKey,
			);
			logInspectTiming("validate_downstream_output", stepStartedAt);
			stepStartedAt = Date.now();
			const terminalUpdated = await persistTerminalSuccess(
				stageState.stage,
				runtime.ctx,
				input,
				stageCtx,
				rawOutput,
				prepared,
				routeKey,
				{
					exitLane: hasExitSignal,
					exitReason: hasExitSignal ? "agent_exit" : undefined,
					runtime,
				},
			);
			logInspectTiming("persist_terminal_success", stepStartedAt, {
				terminalUpdated,
			});
			if (terminalUpdated) {
				stepStartedAt = Date.now();
				await dispatchPipelineDownstream(
					runtime,
					stageState.stageName,
					task.taskId,
					input,
					prepared.output,
					routeKey,
				);
				logInspectTiming("dispatch_pipeline_downstream", stepStartedAt);
				stepStartedAt = Date.now();
				await maybeMarkTaskStageGroupExited(task.taskId, runtime);
				logInspectTiming("maybe_mark_group_exited", stepStartedAt);
				stepStartedAt = Date.now();
			}
		} catch (error) {
			if (hasExitSignal) {
				stepStartedAt = Date.now();
				await updateTaskRepo(task.taskId, {
					errorMessage: getErrorMessage(error),
				}).catch(() => {});
				const exitPrepared = await prepareStageSuccess(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					input,
					rawOutput,
				);
				await persistTerminalSuccess(
					stageState.stage,
					runtime.ctx,
					input,
					stageCtx,
					rawOutput,
					exitPrepared,
					routeKey,
					{ exitLane: true, exitReason: "agent_exit", runtime },
				);
				logInspectTiming("persist_exit_lane_success_with_error", stepStartedAt);
			} else {
				stepStartedAt = Date.now();
				await persistTerminalFailure(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					input,
					error,
				);
				await maybeMarkTaskStageGroupExited(task.taskId, runtime);
				logInspectTiming("persist_success_handling_failure", stepStartedAt);
			}
		}
		return true;
	}

	const exitCode = extractDriverExitCode(rawStdoutContent);
	if (exitCode !== null) {
		stepStartedAt = Date.now();
		const driverErrorMessage =
			parseDriverStdout(rawStdoutContent).latestLog?.message;
		const driverExitMessage =
			exitCode === 0
				? "ACP driver exited before output.json completion"
				: `ACP driver exited with code ${exitCode}`;
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error(
				driverErrorMessage
					? `${driverExitMessage}; ${driverErrorMessage}`
					: driverExitMessage,
			),
			{ exitLane: hasExitSignal },
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming("persist_driver_exit_failure", stepStartedAt, {
			exitCode,
			driverErrorMessage,
		});
		return true;
	}

	if (hasDriverCompletedWithoutOutput(rawStdoutContent)) {
		stepStartedAt = Date.now();
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error("ACP prompt completed without output.json"),
			{ exitLane: hasExitSignal },
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming(
			"persist_completed_without_end_turn_failure",
			stepStartedAt,
		);
		return true;
	}

	stepStartedAt = Date.now();
	const containerAlive = await isContainerAlive(task.containerName);
	logInspectTiming("running_container_alive", stepStartedAt, {
		containerAlive,
	});
	if (!containerAlive) {
		stepStartedAt = Date.now();
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error("Task runtime container stopped before output.json completion"),
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming(
			"persist_running_container_stopped_failure",
			stepStartedAt,
		);
		return true;
	}

	stepStartedAt = Date.now();
	const halfStarted = await inspectHalfStartedRunningTask(runtime, task);
	logInspectTiming("inspect_running_half_started", stepStartedAt, {
		halfStarted: Boolean(halfStarted),
		reason: halfStarted?.reason ?? null,
	});
	if (halfStarted) {
		stepStartedAt = Date.now();
		await failSilentStuckTask(
			runtime,
			task,
			halfStarted.reason,
			halfStarted.diagnostics,
			stageCtx,
		);
		logInspectTiming("persist_running_half_started_failure", stepStartedAt);
		return true;
	}
	return false;
};

const backfillStageQueue = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext, TInput, TOutput>,
	scope?: StageQueueScope,
	options?: {
		concurrencyLimit?: number;
		activeCount?: number;
		enabled?: boolean;
	},
) => {
	if (options?.enabled === false) return 0;
	await assertScanJobNotCancelled(runtime.ctx);
	if (await shouldStopForPausedScanJob(runtime)) {
		return 0;
	}
	const limit =
		options?.concurrencyLimit ??
		(await getStageConcurrencyLimit(stageState.stage, runtime.ctx));
	let activeCount =
		options?.activeCount ??
		(await countActiveTasksByScanJobAndStageRepo({
			scanJobId: runtime.ctx.scanJobId,
			stageName: stageState.stageName,
		}));
	let launchedCount = 0;

	while (!runtime.stopRequested) {
		if (activeCount >= limit) {
			break;
		}
		const execution = await stageState.stage.queue?.poll(runtime.ctx, scope);
		if (execution === undefined) {
			break;
		}
		const control = await findScanJobRuntimeControlRepo(
			runtime.ctx.scanJobId,
		).catch(() => null);
		if (control?.status === "canceled") {
			throw new ScanJobCancelledError(runtime.ctx.scanJobId);
		}
		if (control?.status === "paused") {
			runtime.stopRequested = true;
			break;
		}

		const launched = await launchStageExecution(
			runtime,
			stageState,
			execution,
			{
				logEvent: "loop.stage_backfill_spawned",
			},
		);
		if (!launched) {
			break;
		}
		launchedCount += 1;
		activeCount += 1;
		logPipelineEvent("loop.stage_backfill_spawned", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			concurrencyLimit: limit,
			queueScope: scope?.groupInstanceId ? "group" : "global",
			groupInstanceId: scope?.groupInstanceId ?? null,
		});
	}

	return launchedCount;
};

const resolvePendingTaskQueueScope = async (task: {
	taskId: string;
	stageGroupInstanceId?: string | null;
}): Promise<StageQueueScope | null> => {
	if (!task.stageGroupInstanceId) {
		return {};
	}
	const group = await findStageGroupInstanceByIdRepo(
		task.stageGroupInstanceId,
	).catch(() => null);
	if (!group || group.status !== "active") {
		return null;
	}
	if (group.leaderTaskId === task.taskId) {
		return {};
	}
	return { groupInstanceId: task.stageGroupInstanceId };
};

const reenqueueMissingPendingTasks = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	pendingTasks?: PendingTaskQueueMetadata[],
) => {
	const tasks =
		pendingTasks !== undefined
			? pendingTasks
			: await listPendingTaskQueueMetadataByScanJobIdRepo(
					runtime.ctx.scanJobId,
				);
	let reenqueueCount = 0;
	for (const task of tasks) {
		const stageState = runtime.stageStates.get(task.stageName);
		const queueBinding = stageState?.stage.queue;
		if (!stageState || !queueBinding) {
			continue;
		}
		const queueScope = await resolvePendingTaskQueueScope(task);
		if (queueScope === null) {
			continue;
		}
		const scopedQueue = queueBinding.getQueue(queueScope);
		const knownJobIds = buildKnownQueueJobIdsForTask(scopedQueue, task);
		const existingJobs = await Promise.all(
			knownJobIds.map((jobId) => scopedQueue.getJob(jobId).catch(() => null)),
		);
		const existingJob = existingJobs.find(Boolean);
		if (existingJob) {
			continue;
		}
		await queueBinding.enqueue(task.taskId, queueScope);
		logPipelineEvent("loop.pending_task_reenqueued", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: task.stageName,
			taskId: task.taskId,
			taskName: task.name,
			queueName: scopedQueue.name,
			queueScope: queueScope.groupInstanceId ? "group" : "global",
			groupInstanceId: queueScope.groupInstanceId ?? null,
		});
		reenqueueCount += 1;
	}
	return reenqueueCount;
};

const backfillActiveGroupQueues = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	pendingTasks: PendingTaskQueueMetadata[],
	snapshot: RuntimeLoopSnapshot,
) => {
	const seen = new Set<string>();
	let launchedCount = 0;
	const launchedByStage = new Map<string, number>();
	for (const task of pendingTasks) {
		if (task.status !== "pending" || !task.stageGroupInstanceId) {
			continue;
		}
		const queueScope = await resolvePendingTaskQueueScope(task);
		if (!queueScope?.groupInstanceId) {
			continue;
		}
		const key = `${queueScope.groupInstanceId}:${task.stageName}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const stageState = runtime.stageStates.get(task.stageName);
		if (!stageState) {
			continue;
		}
		const policy = snapshot.stagePolicies.get(task.stageName);
		if (!policy) continue;
		const stageLaunchedCount = await backfillStageQueue(
			runtime,
			stageState,
			queueScope,
			{
				concurrencyLimit: policy.concurrency,
				activeCount: snapshot.activeCountByStage.get(task.stageName) ?? 0,
				enabled: !policy.disabled,
			},
		);
		launchedCount += stageLaunchedCount;
		launchedByStage.set(
			task.stageName,
			(launchedByStage.get(task.stageName) ?? 0) + stageLaunchedCount,
		);
	}
	return { count: launchedCount, byStage: launchedByStage };
};

const inspectTasks = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	activeTasksByStage: Map<
		string,
		Awaited<ReturnType<typeof listActiveTasksByScanJobIdRepo>>
	>,
) => {
	const metrics = {
		progressed: false,
		inspectedCount: 0,
		progressedCount: 0,
		activeCount: 0,
		completedCount: 0,
	};
	for (const stageState of runtime.stageStates.values()) {
		const activeTasks = activeTasksByStage.get(stageState.stageName) ?? [];
		metrics.activeCount += activeTasks.length;
		for (const task of activeTasks) {
			metrics.inspectedCount += 1;
			const wasRunning = task.status === "running";
			const taskProgressed = await inspectActiveStageTask(
				runtime,
				stageState,
				task,
			);
			if (taskProgressed) {
				metrics.progressed = true;
				metrics.progressedCount += 1;
				if (wasRunning) {
					const currentTask = await findTaskByIdRepo(task.taskId).catch(
						() => null,
					);
					if (currentTask?.status === "completed") {
						metrics.completedCount += 1;
					}
				}
			}
		}
	}
	return metrics;
};

const retryPendingDownstreamDispatches = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	const pendingTasks = await listPendingCompletedDownstreamDispatchesRepo(
		runtime.ctx.scanJobId,
	);
	const retryPlan = buildResearchDispatchRetryPlan(
		pendingTasks,
		new Set(runtime.stageStates.keys()),
	);
	for (const task of retryPlan.skipped) {
		if (!runtime.stageStates.has(task.stageName)) {
			logPipelineEvent("downstream.retry_skipped", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				taskId: task.taskId,
				stageName: task.stageName,
				reason: "stage_not_in_runtime",
			});
			continue;
		}
		logPipelineEvent("downstream.retry_skipped", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			taskId: task.taskId,
			stageName: task.stageName,
			reason: "duplicate_pending_row",
		});
	}
	for (const task of retryPlan.ready) {
		try {
			if (isCandidateProducerStage(task.stageName)) {
				await syncVulnerabilityCandidatesFromProducerTask(task.taskId);
			}
			await dispatchPipelineDownstream(
				runtime,
				task.stageName,
				task.taskId,
				task.input,
				task.output,
				task.downstreamRouteKey,
			);
		} catch (error) {
			logPipelineEvent("downstream.retry_failed", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				taskId: task.taskId,
				stageName: task.stageName,
				errorMessage: getErrorMessage(error),
			});
		}
	}
};

const runJobLoop = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	await completeTerminalTaskDispatchesRepo(runtime.ctx.scanJobId);
	await resetStaleDownstreamDispatchesRepo(runtime.ctx.scanJobId);
	let loopIteration = 0;
	while (!runtime.stopRequested) {
		loopIteration += 1;
		const loopStartedAt = Date.now();
		await assertScanJobNotCancelled(runtime.ctx);
		if (await shouldStopForPausedScanJob(runtime)) {
			return;
		}
		await resetStaleDownstreamDispatchesRepo(runtime.ctx.scanJobId);
		await retryPendingDownstreamDispatches(runtime);
		if (runtime.failure) {
			throw runtime.failure;
		}
		const lastLoopTickLogAt =
			lastLoopTickLogAtByJob.get(runtime.ctx.scanJobId) ?? 0;
		const now = Date.now();
		if (now - lastLoopTickLogAt >= LOOP_TICK_LOG_INTERVAL_MS) {
			lastLoopTickLogAtByJob.set(runtime.ctx.scanJobId, now);
			logPipelineEvent("loop.tick", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
			});
		}

		const snapshotStartedAt = Date.now();
		const snapshot = await buildRuntimeLoopSnapshot(runtime);
		const snapshotElapsedMs = Date.now() - snapshotStartedAt;
		if (snapshot.status === "paused") {
			runtime.stopRequested = true;
			return;
		}
		const statusTotals = snapshot.statusCounts.reduce(
			(acc, row) => {
				const countValue = row.count;
				acc.total += countValue;
				if (row.status === "pending") {
					acc.pending += countValue;
				}
				if (row.status === "launching") {
					acc.launching += countValue;
				}
				if (row.status === "launched") {
					acc.launched += countValue;
				}
				if (row.status === "starting") {
					acc.starting += countValue;
				}
				if (row.status === "running") {
					acc.running += countValue;
				}
				if (row.status === "completed") {
					acc.completed += countValue;
				}
				if (row.status === "failed") {
					acc.failed += countValue;
				}
				if (row.status === "exited") {
					acc.exited += countValue;
				}
				if (row.status === "canceled") {
					acc.canceled += countValue;
				}
				return acc;
			},
			{
				total: 0,
				pending: 0,
				launching: 0,
				launched: 0,
				starting: 0,
				running: 0,
				completed: 0,
				failed: 0,
				exited: 0,
				canceled: 0,
			},
		);

		if (runtime.stopRequested) {
			return;
		}
		const inspectStartedAt = Date.now();
		const inspectMetrics = await inspectTasks(
			runtime,
			snapshot.activeTasksByStage,
		);
		const inspectElapsedMs = Date.now() - inspectStartedAt;
		let progressed = inspectMetrics.progressed;

		if (runtime.stopRequested) {
			return;
		}
		const reenqueueStartedAt = Date.now();
		const reenqueueCount = await reenqueueMissingPendingTasks(
			runtime,
			snapshot.pendingTaskMetadata,
		);
		const reenqueueElapsedMs = Date.now() - reenqueueStartedAt;
		progressed = reenqueueCount > 0 || progressed;

		if (runtime.stopRequested) {
			return;
		}
		const groupBackfillStartedAt = Date.now();
		const groupBackfill =
			(runtime.pipeline.groups?.length ?? 0) > 0
				? await backfillActiveGroupQueues(
						runtime,
						snapshot.pendingTaskMetadata,
						snapshot,
					)
				: { count: 0, byStage: new Map<string, number>() };
		const groupBackfillElapsedMs = Date.now() - groupBackfillStartedAt;
		progressed = groupBackfill.count > 0 || progressed;

		const stageBackfillTimings: Array<{
			stageName: string;
			elapsedMs: number;
			launchedCount: number;
		}> = [];
		let stageBackfillLaunchedCount = 0;
		for (const stageName of getPollableStageNames(snapshot)) {
			if (runtime.stopRequested) {
				return;
			}
			const stageState = runtime.stageStates.get(stageName);
			const policy = snapshot.stagePolicies.get(stageName);
			if (!stageState || !policy) continue;
			const stageBackfillStartedAt = Date.now();
			const launchedCount = await backfillStageQueue(
				runtime,
				stageState,
				undefined,
				{
					concurrencyLimit: policy.concurrency,
					activeCount:
						(snapshot.activeCountByStage.get(stageName) ?? 0) +
						(groupBackfill.byStage.get(stageName) ?? 0),
					enabled: !policy.disabled,
				},
			);
			const elapsedMs = Date.now() - stageBackfillStartedAt;
			stageBackfillTimings.push({
				stageName: stageState.stageName,
				elapsedMs,
				launchedCount,
			});
			stageBackfillLaunchedCount += launchedCount;
			progressed = launchedCount > 0 || progressed;
		}
		const totalLaunchedCount = groupBackfill.count + stageBackfillLaunchedCount;
		const settlementStatus = await trySettleScanJob(runtime.ctx.scanJobId);
		if (settlementStatus === "terminal") {
			logPipelineEvent("loop.timing", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				iteration: loopIteration,
				totalElapsedMs: Date.now() - loopStartedAt,
				snapshotElapsedMs,
				statusTotals,
				inspectTasksElapsedMs: inspectElapsedMs,
				inspectTasks: inspectMetrics,
				reenqueueMissingPendingTasksElapsedMs: reenqueueElapsedMs,
				reenqueueMissingPendingTasksCount: reenqueueCount,
				backfillActiveGroupQueuesElapsedMs: groupBackfillElapsedMs,
				backfillActiveGroupQueuesLaunchedCount: groupBackfill.count,
				stageBackfillTimings,
				launchedCount: totalLaunchedCount,
				settlementStatus,
				progressed,
				quiescent: true,
				slept: false,
				sleepElapsedMs: 0,
			});
			return;
		}
		let slept = false;
		let sleepElapsedMs = 0;
		if (!progressed) {
			const version = runtime.wakeSignal.current();
			const sleepStartedAt = Date.now();
			await Promise.race([
				runtime.wakeSignal.wait(version),
				sleep(JOB_LOOP_IDLE_SLEEP_MS),
			]);
			slept = true;
			sleepElapsedMs = Date.now() - sleepStartedAt;
		}
		logPipelineEvent("loop.timing", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			iteration: loopIteration,
			totalElapsedMs: Date.now() - loopStartedAt,
			snapshotElapsedMs,
			statusTotals,
			inspectTasksElapsedMs: inspectElapsedMs,
			inspectTasks: inspectMetrics,
			reenqueueMissingPendingTasksElapsedMs: reenqueueElapsedMs,
			reenqueueMissingPendingTasksCount: reenqueueCount,
			backfillActiveGroupQueuesElapsedMs: groupBackfillElapsedMs,
			backfillActiveGroupQueuesLaunchedCount: groupBackfill.count,
			stageBackfillTimings,
			launchedCount: totalLaunchedCount,
			progressed,
			quiescent: false,
			slept,
			sleepElapsedMs,
		});
	}
};

const startJobRuntime = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	return (async () => {
		try {
			await ensureJobAgentHome({
				projectName: runtime.ctx.projectName,
				serviceName: runtime.ctx.serviceName,
				scanJobId: runtime.ctx.scanJobId,
			});
			await runJobLoop(runtime);
			if (runtime.failure) {
				throw runtime.failure;
			}
		} catch (error) {
			handleJobRuntimeFailure(runtime, error);
		} finally {
			runtime.stopRequested = true;
			runtime.wakeSignal.notify();
			if (deletePipelineRuntime(runtime.key, runtime)) {
				logPipelineEvent("runtime.removed", {
					scanJobId: runtime.ctx.scanJobId,
					pipelineName: runtime.pipeline.name,
					runtimeKey: runtime.key,
				});
			}
		}

		if (runtime.failure) {
			throw runtime.failure;
		}
	})();
};

const ensureJobRuntime = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	ctx: TPipelineContext,
): JobRuntime<TPipelineContext> => {
	const key = getJobRuntimeKey(pipeline.name, ctx.scanJobId);
	const existing = pipelineSupervisorJobs.get(key) as
		| JobRuntime<TPipelineContext>
		| undefined;
	if (existing) {
		logPipelineEvent("runtime.reused", {
			scanJobId: ctx.scanJobId,
			pipelineName: pipeline.name,
			runtimeKey: key,
		});
		return existing;
	}

	validatePipelineRouteConfiguration(pipeline);

	const stageStates = new Map<string, RuntimeStageState<TPipelineContext>>();
	for (const stage of pipeline.stages) {
		stageStates.set(stage.id, {
			stageName: stage.id,
			stage: stage as StageDefinition<
				TPipelineContext,
				unknown,
				unknown,
				StageContext
			>,
		});
	}
	const runtimeSettingsPolicy = createRuntimeSettingsPolicy(
		loadScanPipelineDefinitions(),
	);

	const runtime: JobRuntime<TPipelineContext> = {
		key,
		pipeline,
		ctx,
		stageStates,
		runtimeSettingsPolicy,
		defaultConcurrencyByStage: new Map(
			pipeline.stages.map((stage) => [
				stage.id,
				Math.max(1, runtimeSettingsPolicy.getStageConcurrency(stage.id)),
			]),
		),
		runningStdoutSnapshots: new Map(),
		launchingTaskIds: new Set(),
		wakeSignal: new WakeSignal(),
		stopRequested: false,
		failure: null,
		completionPromise: Promise.resolve(),
	};
	setPipelineRuntime(key, runtime as unknown as JobRuntime<PipelineContext>);
	logPipelineEvent("runtime.created", {
		scanJobId: ctx.scanJobId,
		pipelineName: pipeline.name,
		runtimeKey: key,
	});
	runtime.completionPromise = startJobRuntime(runtime);
	return runtime;
};

export const startPipelineRuntime = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	ctx: TPipelineContext,
) => {
	const runtime = ensureJobRuntime(pipeline, ctx);
	runtime.wakeSignal.notify();
	return runtime;
};

const resolveResearchDeadlineFromStageInput = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	fromTaskId: string,
	stageInput: unknown,
) => {
	const scanJob = (runtime.ctx as unknown as PipelineScanJobContext).scanJob;
	if (!scanJob?.pipelineId || !runtime.pipeline.stages.some((stage) => stage.id === "research-scope")) {
		return null;
	}
	const input =
		stageInput && typeof stageInput === "object"
			? (stageInput as Record<string, unknown>)
			: {};
	const scopePath =
		typeof input.scopePath === "string" ? input.scopePath : null;
	if (!scopePath) return null;
	const task = await findTaskByIdRepo(fromTaskId).catch(() => null);
	if (!task) return null;
	const taskDir = await resolveTaskRuntimeDirForTask({
		scanJobId: runtime.ctx.scanJobId,
		projectName: runtime.ctx.projectName,
		serviceName: runtime.ctx.serviceName,
		stageName: task.stageName,
		taskName: task.name,
		taskId: task.taskId,
	});
	const scope = await readTaskJsonArtifact({
		taskDir,
		containerPath: scopePath,
	}).catch(() => null);
	const deadline =
		scope && typeof scope === "object" && !Array.isArray(scope)
			? Date.parse(
					String(
						(scope as Record<string, unknown>).minimumResearchDeadlineAt || "",
					),
				)
			: Number.NaN;
	return Number.isFinite(deadline) ? deadline : null;
};

const dispatchPipelineDownstreamInternal = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageName: string,
	fromTaskId: string,
	stageInput: TInput,
	stageOutput: TOutput,
	routeKey?: string | null,
) => {
	await assertScanJobNotCancelled(runtime.ctx);
	let effectiveRouteKey = routeKey;
	const downstreamEdges = getDownstreamEdges(runtime.pipeline, stageName);
	const routedEdges = downstreamEdges.filter((edge) => edge.route);
	if (runtime.pipeline.stages.some((stage) => stage.id === "research-scope")) {
		const deadline = await resolveResearchDeadlineFromStageInput(
			runtime,
			fromTaskId,
			stageInput,
		);
		if (
			deadline &&
			Date.now() < deadline &&
			routeKey === "confirmed" &&
			stageName === "exploit-review"
		) {
			effectiveRouteKey = "runtime-retry";
			logPipelineEvent("research.deadline_route_extended", {
				scanJobId: (runtime.ctx as unknown as PipelineScanJobContext).scanJob
					.scanJobId,
				stageName,
				fromTaskId,
				deadline,
				requestedRoute: routeKey,
			});
		}
	}
	if (routedEdges.length > 0) {
		const activeRoutedEdges: typeof routedEdges = [];
		for (const edge of routedEdges) {
			if (await isRuntimeStageActive(runtime, edge.to.id)) {
				activeRoutedEdges.push(edge);
			}
		}
		const selectedRouteIsActive =
			effectiveRouteKey == null
				? activeRoutedEdges.some((edge) => edge.route?.default)
				: activeRoutedEdges.some(
						(edge) => edge.route?.key === effectiveRouteKey,
					);
		if (!selectedRouteIsActive) {
			effectiveRouteKey = activeRoutedEdges[0]?.route?.key ?? null;
			logPipelineEvent("downstream.route.runtime_fallback", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				fromStageName: stageName,
				fromTaskId,
				routeKey: routeKey ?? null,
				selectedRouteKey: effectiveRouteKey,
			});
		}
	}
	const selectedDownstream = selectDownstreamEdgesForRoute(
		runtime.pipeline,
		stageName,
		effectiveRouteKey,
	);
	if (selectedDownstream.selectedRouteKey) {
		logPipelineEvent("downstream.route.selected", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			fromStageName: stageName,
			fromTaskId,
			routeKey: routeKey ?? null,
			selectedRouteKey: selectedDownstream.selectedRouteKey,
			edgeName: selectedDownstream.edges[0]?.name ?? null,
			toStageName: selectedDownstream.edges[0]?.to.id ?? null,
			fallback: selectedDownstream.fallback,
		});
	}
	for (const edge of selectedDownstream.edges) {
		if (!(await isRuntimeStageActive(runtime, edge.to.id))) {
			logPipelineEvent("downstream.stage_disabled", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				edgeName: edge.name,
				fromStageName: stageName,
				toStageName: edge.to.id,
			});
			continue;
		}
		const selectedStageOutput = edge.outputSchema
			? validateStructuredOutputSchemaSource(edge.outputSchema, stageOutput)
			: stageOutput;
		const downstreamInputs = edge.transformOutput
			? await edge.transformOutput({
					ctx: runtime.ctx,
					fromTaskId,
					stageInput,
					stageOutput: selectedStageOutput,
				})
			: [];
		if (downstreamInputs.length === 0) {
			logPipelineEvent("downstream.tasks.created", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				edgeName: edge.name,
				fromStageName: stageName,
				toStageName: edge.to.id,
				taskCount: 0,
			});
			continue;
		}
		if (!edge.createTasks) {
			continue;
		}

		const taskIds = await edge.createTasks({
			ctx: runtime.ctx,
			fromTaskId,
			stageInput,
			stageOutput: selectedStageOutput,
			nextInputObjects: downstreamInputs,
			dispatchKeyForItem: (index) =>
				[
					runtime.ctx.scanJobId,
					fromTaskId,
					edge.name,
					effectiveRouteKey ?? "default",
					index,
				].join(":"),
		});
		const fromTask = await findTaskByIdRepo(fromTaskId).catch(() => null);
		const fromGroup = fromTask?.stageGroupInstanceId
			? await findStageGroupInstanceByIdRepo(
					fromTask.stageGroupInstanceId,
				).catch(() => null)
			: null;
		const downstreamGroupInstanceId =
			fromGroup &&
			fromGroup.status === "active" &&
			runtime.pipeline.groups?.some(
				(group) =>
					group.name === fromGroup.groupName &&
					isStageInGroup(group, stageName) &&
					isStageInGroup(group, edge.to.id),
			)
				? fromGroup.groupInstanceId
				: null;
		if (downstreamGroupInstanceId) {
			await Promise.all(
				taskIds.map((taskId) =>
					updateTaskRepo(taskId, {
						stageGroupInstanceId: downstreamGroupInstanceId,
					}),
				),
			);
		}
		if (edge.fork) {
			await Promise.all(
				taskIds.map((taskId) =>
					updateTaskRepo(taskId, {
						runtimeMode: "fork_session",
						forkedFromTaskId: fromTaskId,
						forkedFromThreadId: fromTask?.threadId ?? null,
					}),
				),
			);
		}
		logPipelineEvent("downstream.tasks.created", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			edgeName: edge.name,
			fromStageName: stageName,
			toStageName: edge.to.id,
			taskCount: taskIds.length,
		});
		const downstreamStageState = runtime.stageStates.get(edge.to.id);
		const downstreamQueue = edge.to.queue;
		if (!downstreamStageState || !downstreamQueue) {
			continue;
		}

		const queueScope: StageQueueScope = {
			groupInstanceId: downstreamGroupInstanceId,
		};
		const queue = downstreamQueue.getQueue(queueScope);
		for (const taskId of taskIds) {
			await downstreamQueue.enqueue(taskId, queueScope);
			logPipelineEvent("loop.downstream_enqueued", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				edgeName: edge.name,
				fromStageName: stageName,
				toStageName: edge.to.id,
				taskId,
				queueName: queue.name,
				queueScope: downstreamGroupInstanceId ? "group" : "global",
				groupInstanceId: downstreamGroupInstanceId,
			});
		}
	}
	return effectiveRouteKey;
};

const dispatchPipelineDownstream = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageName: string,
	fromTaskId: string,
	stageInput: TInput,
	stageOutput: TOutput,
	routeKey?: string | null,
) => {
	const claim = await claimPendingDownstreamDispatchResultRepo(fromTaskId);
	if (!claim.claimed) {
		return;
	}
	try {
		await dispatchPipelineDownstreamInternal(
			runtime,
			stageName,
			fromTaskId,
			stageInput,
			stageOutput,
			routeKey,
		);
		await completeDownstreamDispatchRepo(fromTaskId);
	} catch (error) {
		const control = await findScanJobRuntimeControlRepo(runtime.ctx.scanJobId).catch(
			() => null,
		);
		if (
			control?.status === "canceled" ||
			control?.status === "failed" ||
			control?.status === "finished" ||
			control?.status === "partially_finished"
		) {
			await completeDownstreamDispatchRepo(fromTaskId).catch((cleanupError) => {
				logPipelineEvent("downstream.dispatch_close_failed", {
					scanJobId: runtime.ctx.scanJobId,
					fromTaskId,
					errorMessage: getErrorMessage(cleanupError),
				});
			});
			logPipelineEvent("downstream.dispatch_stopped_job_ignored", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName,
				fromTaskId,
				jobStatus: control.status,
			});
			return;
		}
		await releaseDownstreamDispatchClaimRepo(fromTaskId).catch((cleanupError) => {
			logPipelineEvent("downstream.dispatch_claim_release_failed", {
				scanJobId: runtime.ctx.scanJobId,
				fromTaskId,
				errorMessage: getErrorMessage(cleanupError),
			});
		});
		if (control?.status === "paused") return;
		logPipelineEvent("downstream.dispatch_incomplete", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName,
			fromTaskId,
			errorMessage: getErrorMessage(error),
		});
		throw error;
	}
};
