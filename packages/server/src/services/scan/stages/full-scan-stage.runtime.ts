import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@vulseek/server/db";
import type {
	ScanRuntimeSettings,
	ScanStageSettings,
} from "@vulseek/server/db/schema";
import { applications, compose, scanJobs } from "@vulseek/server/db/schema";
import { eq } from "drizzle-orm";
import { getAgentProfileById } from "../../ai";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { createStageRuntimeConfig } from "../pipeline/scan-stage-runtime-config";
import {
	getRuntimeStageSetting,
	normalizeScanRuntimeSettings,
} from "../runtime-settings";
import { SCAN_STAGE_IDS } from "../stage-metadata";
import type { AgentProfileLike, ScanJob } from "../types";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const CONTAINER_TASK_RUNTIME_ROOT = "/task";

export type PipelineContext = {
	projectName: string;
	serviceName: string;
	scanJobId: string;
};

export type ScanProfileConcurrencySettings = {
	fuzzingBudgetSeconds: number | null;
	scanStageSettings: ScanStageSettings;
};

type ScanTargetRef = {
	applicationId?: string | null;
	composeId?: string | null;
};
type ScanJobRef = Pick<ScanJob, "scanJobId" | "applicationId" | "composeId">;
type ScanJobRuntimeRef = ScanJobRef & {
	scanRuntimeSettings?: ScanRuntimeSettings | null;
};

const sanitizeContainerNamePart = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "x";

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const resolveMountedProfileDir = (
	input: Pick<PipelineContext, "projectName" | "serviceName">,
) =>
	path.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		sanitizePathPart(input.projectName),
		"profiles",
		sanitizePathPart(input.serviceName),
	);

const resolveScanContextAppRoot = async () => {
	const configuredAppRoot = process.env.VULSEEK_SCAN_CONTEXT_APP_PATH?.trim();
	if (configuredAppRoot) {
		return configuredAppRoot;
	}
	try {
		await fs.access(CONTAINER_SCAN_CONTEXT_ROOT);
		return CONTAINER_SCAN_CONTEXT_ROOT;
	} catch {
		return process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";
	}
};

const resolveAppProfileDir = async (
	input: Pick<PipelineContext, "projectName" | "serviceName">,
) => {
	const appRoot = await resolveScanContextAppRoot();
	if (!appRoot) {
		throw new Error(
			"Scan context app path is not configured. Set VULSEEK_SCAN_CONTEXT_APP_PATH or VULSEEK_SCAN_CONTEXT_HOST_PATH.",
		);
	}
	return path.join(
		appRoot,
		"projects",
		sanitizePathPart(input.projectName),
		"profiles",
		sanitizePathPart(input.serviceName),
	);
};

export const resolveTaskRootSegment = (
	stageName: string,
	taskName: string,
	taskId?: string,
) => {
	const taskPathPart = taskId
		? `${sanitizePathPart(taskName)}-${sanitizePathPart(taskId).slice(0, 6)}`
		: sanitizePathPart(taskName);
	return path.join(
		"scanning",
		"full_scan",
		"stages",
		sanitizePathPart(stageName),
		"tasks",
		taskPathPart,
	);
};

export const resolveStageLaneRootSegment = (
	stageName: string,
	laneIndex: number,
) =>
	path.join(
		"scanning",
		"full_scan",
		"stages",
		sanitizePathPart(stageName),
		"lanes",
		`lane-${laneIndex}`,
	);

const resolveScanContextMount = async (
	input: Pick<PipelineContext, "projectName" | "serviceName">,
) => {
	const configuredHostRoot =
		process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env VULSEEK_SCAN_CONTEXT_HOST_PATH",
		);
	}

	const hostProfileDir = path.join(
		configuredHostRoot,
		"projects",
		sanitizePathPart(input.projectName),
		"profiles",
		sanitizePathPart(input.serviceName),
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return {
		mountSource: hostProfileDir,
		mountDescription: `host_path:${hostProfileDir}`,
		dockerMountArg: `-v '${hostProfileDir.replace(/'/g, `'"'"'`)}':${CONTAINER_SCAN_CONTEXT_ROOT}`,
	};
};

export const resolveStageAgentProfileFromTarget = async (
	targetRef: ScanTargetRef,
	stageName?: string,
): Promise<AgentProfileLike | null> => {
	const target = targetRef.applicationId
		? await findApplicationById(targetRef.applicationId)
		: await findComposeById(targetRef.composeId as string);
	const stageAgentProfileId =
		stageName && "scanStageSettings" in target
			? target.scanStageSettings?.[stageName]?.agentProfileId
			: null;
	if (stageAgentProfileId) {
		return (
			(await getAgentProfileById(stageAgentProfileId).catch(() => null)) || null
		);
	}
	return null;
};

export const resolveStageAgentProfile = async (
	scanJob: ScanJobRuntimeRef,
	stageName?: string,
): Promise<AgentProfileLike | null> => {
	if (stageName) {
		const [freshScanJob] = await db
			.select({ scanRuntimeSettings: scanJobs.scanRuntimeSettings })
			.from(scanJobs)
			.where(eq(scanJobs.scanJobId, scanJob.scanJobId))
			.limit(1);
		const runtimeAgentProfileId =
			getRuntimeStageSetting(
				freshScanJob?.scanRuntimeSettings ?? scanJob.scanRuntimeSettings,
				stageName,
			).agentProfileId ?? null;
		if (runtimeAgentProfileId) {
			return (
				(await getAgentProfileById(runtimeAgentProfileId).catch(() => null)) ||
				null
			);
		}
		const snapshotAgentProfileId = await createStageRuntimeConfig(
			scanJob.scanJobId,
			stageName,
		).getAgentProfile();
		if (snapshotAgentProfileId) {
			return await getAgentProfileById(snapshotAgentProfileId);
		}
	}
	return null;
};

export const resolveScanProfileConcurrencySettingsFromTarget = async (
	targetRef: ScanTargetRef,
): Promise<ScanProfileConcurrencySettings> => {
	if (targetRef.applicationId) {
		const [row] = await db
			.select({
				fuzzingBudgetSeconds: applications.fuzzingBudgetSeconds,
				scanStageSettings: applications.scanStageSettings,
			})
			.from(applications)
			.where(eq(applications.applicationId, targetRef.applicationId))
			.limit(1);
		return {
			fuzzingBudgetSeconds: row?.fuzzingBudgetSeconds ?? null,
			scanStageSettings: row?.scanStageSettings ?? {},
		};
	}

	if (targetRef.composeId) {
		const [row] = await db
			.select({
				fuzzingBudgetSeconds: compose.fuzzingBudgetSeconds,
				scanStageSettings: compose.scanStageSettings,
			})
			.from(compose)
			.where(eq(compose.composeId, targetRef.composeId))
			.limit(1);
		return {
			fuzzingBudgetSeconds: row?.fuzzingBudgetSeconds ?? null,
			scanStageSettings: row?.scanStageSettings ?? {},
		};
	}

	return {
		fuzzingBudgetSeconds: null,
		scanStageSettings: {},
	};
};

export const resolveScanProfileConcurrencySettings = async (
	scanJobId: string,
): Promise<
	ScanProfileConcurrencySettings & {
		scanRuntimeSettings: ScanRuntimeSettings;
		pipelineId: string;
	}
> => {
	const [scanJob] = await db
		.select({
			applicationId: scanJobs.applicationId,
			composeId: scanJobs.composeId,
			pipelineId: scanJobs.pipelineId,
			scanRuntimeSettings: scanJobs.scanRuntimeSettings,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1);

	return {
		fuzzingBudgetSeconds: null,
		scanStageSettings: {},
		scanRuntimeSettings: normalizeScanRuntimeSettings(
			scanJob?.scanRuntimeSettings ?? {},
		),
		pipelineId: scanJob?.pipelineId ?? "",
	};
};

export const resolveStageConcurrencySetting = async (
	scanJobId: string,
	stageName: string,
	fallback: (settings: ScanProfileConcurrencySettings) => number | null,
) => {
	const settings = await resolveScanProfileConcurrencySettings(scanJobId);
	const snapshotConcurrency = await createStageRuntimeConfig(
		scanJobId,
		stageName,
	).getConcurrency();
	const concurrency = Math.max(
		1,
		getRuntimeStageSetting(settings.scanRuntimeSettings, stageName)
			.concurrency ||
			snapshotConcurrency ||
			fallback(settings) ||
			1,
	);
	return concurrency;
};

export const isFullScanStageActive = async (
	scanJobId: string,
	stageName: string,
) => {
	const [scanJob] = await db
		.select({ scanRuntimeSettings: scanJobs.scanRuntimeSettings })
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1);
	const setting = getRuntimeStageSetting(
		scanJob?.scanRuntimeSettings ?? {},
		stageName,
	);
	return setting.disabled !== true;
};

export const resolveRepositoryArtifactsDir = async (input: {
	scanJobId: string;
	projectName: string;
	serviceName: string;
}) =>
	path.join(
		resolveMountedProfileDir(input),
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(
			SCAN_STAGE_IDS.repositoryProfile,
			"repository-profile",
			input.scanJobId,
		),
	);

export const resolveRepositoryStageRuntime = async (input: {
	scanJobId: string;
	projectName: string;
	serviceName: string;
}) => {
	await resolveScanContextMount({
		projectName: input.projectName,
		serviceName: input.serviceName,
	});

	const stageDirPath = path.join(
		await resolveAppProfileDir(input),
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(
			SCAN_STAGE_IDS.repositoryProfile,
			"repository-profile",
			input.scanJobId,
		),
	);
	await fs.mkdir(stageDirPath, { recursive: true });

	return {
		stageDirPath,
		stageRootInContainer: CONTAINER_TASK_RUNTIME_ROOT,
	};
};

export const resolveTaskRuntimeDirForTask = async (input: {
	scanJobId: string;
	projectName: string;
	serviceName: string;
	stageName: string;
	taskName: string;
	taskId: string;
}) => {
	await resolveScanContextMount(input);
	const appProfileDir = await resolveAppProfileDir(input);
	const taskDirPath = path.join(
		appProfileDir,
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(input.stageName, input.taskName, input.taskId),
	);
	await fs.mkdir(taskDirPath, { recursive: true });
	return taskDirPath;
};

export const taskRootInContainer = () => CONTAINER_TASK_RUNTIME_ROOT;

export type StageContext = PipelineContext & {
	stageName: string;
	taskId: string;
	taskName: string;
	persistent: boolean;
	reuseContainer: boolean;
	nullableOutput: boolean;
	groupedPersistent: boolean;
	allowAgentExit: boolean;
	containerIndex: number | null;
	laneIndex: number | null;
	laneThreadId: string | null;
	laneDriverPid: number | null;
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: StructuredOutputSchemaSource;
		default?: boolean;
	}>;
	sessionMode: "new" | "fork";
	parentSessionId: string | null;
	parentTaskId: string | null;
	agentProfile: () => Promise<AgentProfileLike | null>;
	containerName: (...parts: Array<string | null | undefined>) => string;
	taskDir: (
		input?:
			| string
			| {
					moduleId?: string;
					functionId?: string;
					candidateId?: string;
					taskName?: string;
					stageName?: string;
			  },
	) => Promise<string>;
	taskDirContainer: () => Promise<string>;
	taskDirRealContainer: () => Promise<string>;
	laneDir: () => Promise<string>;
	laneDirContainer: () => Promise<string>;
	repositoryArtifactsDir: () => Promise<string>;
	repositoryStageRuntime: () => Promise<{
		stageDirPath: string;
		stageRootInContainer: string;
	}>;
};

export const createStageContext = <TBase extends PipelineContext>(input: {
	base: TBase;
	stageName: string;
	scanJob: ScanJobRef;
	taskId: string;
	taskName: string;
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: StructuredOutputSchemaSource;
		default?: boolean;
	}>;
	persistent?: boolean;
	reuseContainer?: boolean;
	nullableOutput?: boolean;
	groupedPersistent?: boolean;
	allowAgentExit?: boolean;
	containerIndex?: number | null;
	laneIndex?: number | null;
	laneThreadId?: string | null;
	laneDriverPid?: number | null;
	sessionMode?: "new" | "fork";
	parentSessionId?: string | null;
	parentTaskId?: string | null;
}): TBase & StageContext => ({
	...input.base,
	stageName: input.stageName,
	taskId: input.taskId,
	taskName: input.taskName,
	persistent: input.persistent ?? false,
	reuseContainer: input.reuseContainer ?? true,
	nullableOutput: input.nullableOutput ?? false,
	groupedPersistent: input.groupedPersistent ?? false,
	allowAgentExit: input.allowAgentExit ?? false,
	containerIndex: input.containerIndex ?? null,
	laneIndex: input.laneIndex ?? null,
	laneThreadId: input.laneThreadId ?? null,
	laneDriverPid: input.laneDriverPid ?? null,
	routeOutputSchemas: input.routeOutputSchemas,
	sessionMode: input.sessionMode || "new",
	parentSessionId: input.parentSessionId ?? null,
	parentTaskId: input.parentTaskId ?? null,
	agentProfile: async () =>
		await resolveStageAgentProfile(input.scanJob, input.stageName),
	containerName: (...parts) =>
		[
			sanitizeContainerNamePart(input.base.projectName),
			sanitizeContainerNamePart(input.base.serviceName),
			sanitizeContainerNamePart(input.stageName),
			sanitizeContainerNamePart(input.scanJob.scanJobId),
			input.persistent &&
			input.laneIndex !== undefined &&
			input.laneIndex !== null
				? `lane-${input.laneIndex}`
				: null,
			!input.persistent &&
			input.reuseContainer &&
			input.containerIndex !== undefined &&
			input.containerIndex !== null
				? `container-${input.containerIndex}`
				: null,
			...(input.persistent || input.reuseContainer
				? []
				: parts
						.filter((value): value is string => Boolean(value && value.trim()))
						.map((value) => sanitizeContainerNamePart(value))),
			input.persistent || input.reuseContainer
				? null
				: sanitizeContainerNamePart(input.taskId),
		]
			.filter((value): value is string => Boolean(value))
			.join("-"),
	taskDir: async (runtimeInput) => {
		const normalizedRuntimeInput =
			typeof runtimeInput === "string"
				? { taskName: runtimeInput, stageName: input.stageName }
				: runtimeInput;
		const targetStageName =
			normalizedRuntimeInput?.stageName || input.stageName;
		const targetTaskName = normalizedRuntimeInput?.taskName || input.taskName;
		await resolveScanContextMount(input.base);
		// The stage dir is written by THIS process (stdout/stdin/bootstrap logs),
		// so it must resolve through the app-visible root: /scan-context when the
		// server itself runs inside dev.sh, the host dir on bare `pnpm vulseek:dev`.
		const defaultStageDirPath = path.join(
			await resolveAppProfileDir(input.base),
			"jobs",
			input.scanJob.scanJobId,
			resolveTaskRootSegment(targetStageName, targetTaskName, input.taskId),
		);
		await fs.mkdir(defaultStageDirPath, { recursive: true });
		return defaultStageDirPath;
	},
	taskDirContainer: async () => CONTAINER_TASK_RUNTIME_ROOT,
	taskDirRealContainer: async () => {
		const taskPathPart = resolveTaskRootSegment(
			input.stageName,
			input.taskName,
			input.taskId,
		)
			.split(path.sep)
			.join("/");
		return path.posix.join(
			resolveMountedProfileDir(input.base).split(path.sep).join("/"),
			"jobs",
			input.scanJob.scanJobId,
			taskPathPart,
		);
	},
	laneDir: async () => {
		if (input.laneIndex === undefined || input.laneIndex === null) {
			return await (
				createStageContext({
					...input,
					persistent: false,
				}) as TBase & StageContext
			).taskDir();
		}
		await resolveScanContextMount(input.base);
		const laneDirPath = path.join(
			await resolveAppProfileDir(input.base),
			"jobs",
			input.scanJob.scanJobId,
			resolveStageLaneRootSegment(input.stageName, input.laneIndex),
		);
		await fs.mkdir(laneDirPath, { recursive: true });
		return laneDirPath;
	},
	laneDirContainer: async () => {
		if (input.laneIndex === undefined || input.laneIndex === null) {
			return await (
				createStageContext({
					...input,
					persistent: false,
					reuseContainer: false,
				}) as TBase & StageContext
			).taskDirRealContainer();
		}
		return path.posix.join(
			resolveMountedProfileDir(input.base).split(path.sep).join("/"),
			"jobs",
			input.scanJob.scanJobId,
			resolveStageLaneRootSegment(input.stageName, input.laneIndex)
				.split(path.sep)
				.join("/"),
		);
	},
	repositoryArtifactsDir: async () =>
		await resolveRepositoryArtifactsDir({
			scanJobId: input.scanJob.scanJobId,
			projectName: input.base.projectName,
			serviceName: input.base.serviceName,
		}),
	repositoryStageRuntime: async () =>
		await resolveRepositoryStageRuntime({
			scanJobId: input.scanJob.scanJobId,
			projectName: input.base.projectName,
			serviceName: input.base.serviceName,
		}),
});
