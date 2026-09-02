import path from "node:path";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import { TRPCError } from "@trpc/server";
import {
	findVulnerabilityCandidateByIdAndScanJobIdRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
	backfillVulnerabilityCandidatesFromTasks,
	listCandidateTagsRepo,
	updateVulnerabilityCandidateMetadataRepo,
} from "../persistence/candidate.repo";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import {
	findTaskByIdRepo,
	listCandidateDescendantTasksByProducerTaskIdRepo,
	listTaskRuntimeIntervalsByScanJobIdRepo,
} from "../persistence/task.repo";
import {
	findCandidatePageRepo,
	findCandidateByIdWithResultsRepo,
	listCandidateItemsByScanJobIdRepo,
} from "../persistence/candidate-list.repo";
import { buildCandidateResultSummary } from "../persistence/candidate-result-summary";
import { listCandidateResultSummaryGroupsByScanJobIdRepo } from "../persistence/candidate-result-summary.repo";
import type { Task } from "../types";
import { resolveTaskRootSegment } from "../stages/full-scan-stage.runtime";

export type CandidateListSortKey =
	| "latestResultUpdatedAt"
	| "createdAt"
	| "candidate"
	| "analysis"
	| "verify"
	| "score";
export type CandidateListSortDirection = "asc" | "desc";

export type CandidateTaskLineageRelation =
	| "repository"
	| "module"
	| "function"
	| "candidate";

export type CandidateTaskLineageItem = {
	taskId: string;
	scanJobId: string;
	parentTaskId: string | null;
	stageName: string;
	status: Task["status"];
	name: string;
	attempt: number;
	runtimeMode: Task["runtimeMode"];
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	relation: CandidateTaskLineageRelation;
};

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const CONTAINER_TASK_RUNTIME_ROOT = "/task";

const sanitizePathPart = (value: string) =>
	value
		.trim()
		.replace(/[\\/]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "default";

const isWithinPosixRoot = (filePath: string, rootPath: string) =>
	filePath === rootPath || filePath.startsWith(`${rootPath}/`);

const isWithinHostRoot = (filePath: string, rootPath: string) => {
	const resolvedFilePath = path.resolve(filePath);
	const resolvedRootPath = path.resolve(rootPath);
	return (
		resolvedFilePath === resolvedRootPath ||
		resolvedFilePath.startsWith(`${resolvedRootPath}${path.sep}`)
	);
};

const resolveConfiguredScanContextHostPath = () =>
	process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveScanJobTargetIdentity = async (scanJob: {
	applicationId: string | null;
	composeId: string | null;
}) => {
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

const resolveProjectProfileHostContextRoot = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const { projectName, profileName } =
		await resolveScanJobTargetIdentity(scanJob);
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		return null;
	}

	return path.join(
		configuredHostRoot,
		"projects",
		sanitizePathPart(projectName),
		"profiles",
		sanitizePathPart(profileName),
	);
};

const resolveScanContextHostPath = (
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
		return null;
	}
	return path.join(
		projectProfileHostContextRoot,
		relativePath.split("/").join(path.sep),
	);
};

const resolveTaskHostRoot = async (input: {
	scanJobId: string;
	taskId: string;
	projectProfileHostContextRoot: string;
}) => {
	const task = await findTaskByIdRepo(input.taskId);
	if (task.scanJobId !== input.scanJobId) {
		return null;
	}

	const jobRootPath = path.join(
		input.projectProfileHostContextRoot,
		"jobs",
		input.scanJobId,
	);
	return path.join(
		jobRootPath,
		resolveTaskRootSegment(task.stageName, task.name, task.taskId),
	);
};

const resolveTaskArtifactHostPath = async (input: {
	scanJobId: string;
	taskId: string | null | undefined;
	containerPath: string;
	projectProfileHostContextRoot: string;
}) => {
	if (!input.taskId) {
		return null;
	}
	const taskRoot = await resolveTaskHostRoot({
		scanJobId: input.scanJobId,
		taskId: input.taskId,
		projectProfileHostContextRoot: input.projectProfileHostContextRoot,
	});
	if (!taskRoot) {
		return null;
	}

	const relativePath = path.posix.relative(
		CONTAINER_TASK_RUNTIME_ROOT,
		input.containerPath,
	);
	if (!relativePath || relativePath === "." || relativePath.startsWith("../")) {
		return null;
	}

	const hostPath = path.resolve(
		taskRoot,
		relativePath.split("/").join(path.sep),
	);
	return isWithinHostRoot(hostPath, taskRoot) ? hostPath : null;
};

const resolveHostPathForContainerPath = async (input: {
	scanJobId: string;
	taskId?: string | null;
	containerPath: string | null | undefined;
	projectProfileHostContextRoot: string | null;
}) => {
	const containerPath = input.containerPath?.trim();
	if (
		!containerPath ||
		!path.posix.isAbsolute(containerPath) ||
		!input.projectProfileHostContextRoot
	) {
		return null;
	}

	if (isWithinPosixRoot(containerPath, CONTAINER_SCAN_CONTEXT_ROOT)) {
		return resolveScanContextHostPath(
			input.projectProfileHostContextRoot,
			containerPath,
		);
	}

	if (isWithinPosixRoot(containerPath, CONTAINER_TASK_RUNTIME_ROOT)) {
		return await resolveTaskArtifactHostPath({
			scanJobId: input.scanJobId,
			taskId: input.taskId,
			containerPath,
			projectProfileHostContextRoot: input.projectProfileHostContextRoot,
		});
	}

	return null;
};

export const enrichCandidateHostPaths = async <T extends { scanJobId: string }>(
	candidates: T[],
) => {
	const profileRootByScanJobId = new Map<string, string | null>();
	const getProfileRoot = async (scanJobId: string) => {
		if (!profileRootByScanJobId.has(scanJobId)) {
			profileRootByScanJobId.set(
				scanJobId,
				await resolveProjectProfileHostContextRoot(scanJobId).catch(() => null),
			);
		}
		return profileRootByScanJobId.get(scanJobId) ?? null;
	};

	return await Promise.all(
		candidates.map(async (candidate) => {
			const projectProfileHostContextRoot = await getProfileRoot(
				candidate.scanJobId,
			);
			const candidateRecord = candidate as T & {
				filePath?: string | null;
				latestAnalysisResult?: {
					taskId?: string | null;
					reportPath?: string | null;
				} | null;
				latestVerificationResult?: {
					taskId?: string | null;
					reportPath?: string | null;
				} | null;
				latestTriageResult?: {
					taskId?: string | null;
					reportPath?: string | null;
				} | null;
			};
			const [
				fileHostPath,
				analysisReportHostPath,
				verificationReportHostPath,
				triageReportHostPath,
			] = await Promise.all([
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					containerPath: candidateRecord.filePath,
					projectProfileHostContextRoot,
				}),
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					taskId: candidateRecord.latestAnalysisResult?.taskId,
					containerPath: candidateRecord.latestAnalysisResult?.reportPath,
					projectProfileHostContextRoot,
				}),
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					taskId: candidateRecord.latestVerificationResult?.taskId,
					containerPath: candidateRecord.latestVerificationResult?.reportPath,
					projectProfileHostContextRoot,
				}),
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					taskId: candidateRecord.latestTriageResult?.taskId,
					containerPath: candidateRecord.latestTriageResult?.reportPath,
					projectProfileHostContextRoot,
				}),
			]);

			return {
				...candidate,
				fileHostPath,
				latestAnalysisResult: candidateRecord.latestAnalysisResult
					? {
							...candidateRecord.latestAnalysisResult,
							reportHostPath: analysisReportHostPath,
						}
					: null,
				latestVerificationResult: candidateRecord.latestVerificationResult
					? {
							...candidateRecord.latestVerificationResult,
							reportHostPath: verificationReportHostPath,
						}
					: null,
				latestTriageResult: candidateRecord.latestTriageResult
					? {
							...candidateRecord.latestTriageResult,
							reportHostPath: triageReportHostPath,
						}
					: null,
			};
		}),
	);
};

export const findVulnerabilityCandidatesByScanJobId = async (
	scanJobId: string,
) => await findVulnerabilityCandidatesByScanJobIdRepo(scanJobId);

export const backfillVulnerabilityCandidates = async (input?: {
	scanJobId?: string;
}) => await backfillVulnerabilityCandidatesFromTasks(input);

const ACTIVE_TASK_STATUSES = new Set([
	"launching",
	"launched",
	"starting",
	"running",
]);

const parseTimestampMs = (value: string | null | undefined) => {
	if (!value) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
};

const findScanJobTaskTimeline = async (scanJobId: string) => {
	const nowMs = Date.now();
	const intervals = await listTaskRuntimeIntervalsByScanJobIdRepo(scanJobId);
	const normalizedIntervals: Array<{ startMs: number; endMs: number }> = [];
	let activeTaskCount = 0;

	for (const task of intervals) {
		const startMs = parseTimestampMs(task.startedAt) ?? parseTimestampMs(task.createdAt);
		if (startMs === null) {
			continue;
		}

		const isActive = ACTIVE_TASK_STATUSES.has(task.status);
		const endMs = isActive
			? nowMs
			: (parseTimestampMs(task.completedAt) ??
				parseTimestampMs(task.updatedAt) ??
				startMs);
		if (isActive) {
			activeTaskCount += 1;
		}
		normalizedIntervals.push({
			startMs,
			endMs: Math.max(startMs, endMs),
		});
	}

	if (normalizedIntervals.length === 0) {
		return {
			taskCount: 0,
			activeTaskCount: 0,
			startedAt: null,
			finishedAt: null,
			spanSeconds: 0,
			coveredSeconds: 0,
		};
	}

	normalizedIntervals.sort((left, right) => left.startMs - right.startMs);
	let coveredMs = 0;
	let spanStartMs = normalizedIntervals[0]?.startMs ?? nowMs;
	let spanEndMs = spanStartMs;
	let currentStartMs = spanStartMs;
	let currentEndMs = normalizedIntervals[0]?.endMs ?? spanStartMs;

	for (const interval of normalizedIntervals) {
		spanStartMs = Math.min(spanStartMs, interval.startMs);
		spanEndMs = Math.max(spanEndMs, interval.endMs);
		if (interval.startMs <= currentEndMs) {
			currentEndMs = Math.max(currentEndMs, interval.endMs);
			continue;
		}
		coveredMs += currentEndMs - currentStartMs;
		currentStartMs = interval.startMs;
		currentEndMs = interval.endMs;
	}
	coveredMs += currentEndMs - currentStartMs;

	return {
		taskCount: normalizedIntervals.length,
		activeTaskCount,
		startedAt: new Date(spanStartMs).toISOString(),
		finishedAt: activeTaskCount > 0 ? null : new Date(spanEndMs).toISOString(),
		spanSeconds: Math.max(0, Math.floor((spanEndMs - spanStartMs) / 1000)),
		coveredSeconds: Math.max(0, Math.floor(coveredMs / 1000)),
	};
};
export const findScanJobResultSummary = async (scanJobId: string) => {
	const [resultGroups, taskTimeline] = await Promise.all([
		listCandidateResultSummaryGroupsByScanJobIdRepo(scanJobId),
		findScanJobTaskTimeline(scanJobId),
	]);
	const resultSummary = buildCandidateResultSummary(resultGroups);
	return {
		...resultSummary,
		taskTimeline,
	};
};

export const findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId =
	async (input: {
		scanJobId: string;
		page: number;
		pageSize: number;
		query?: string;
		analysisResults?: string[];
		verifyResults?: string[];
		triageResults?: string[];
		sortKey: CandidateListSortKey;
		sortDirection: CandidateListSortDirection;
	}) => {
		const page = await findCandidatePageRepo(input);
		return {
			...page,
			items: await enrichCandidateHostPaths(page.items),
		};
	};

export const listVulnerabilityCandidatesWithProjectionByScanJobId = async (
	scanJobId: string,
) => await listCandidateItemsByScanJobIdRepo(scanJobId);

export const findVulnerabilityCandidateById = async (
	vulnerabilityCandidateId: string,
) => await findVulnerabilityCandidateByIdRepo(vulnerabilityCandidateId);

export const findVulnerabilityCandidateByIdForScanJob = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	producerTaskId?: string;
}) => await findVulnerabilityCandidateByIdAndScanJobIdRepo(input);

export const listCandidateTags = async () => await listCandidateTagsRepo();

export const updateVulnerabilityCandidateMetadata = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	note: string;
	tags: string[];
}) => await updateVulnerabilityCandidateMetadataRepo(input);

export const findVulnerabilityCandidateWithLatestAnalysisResultById =
	async (input: {
		vulnerabilityCandidateId: string;
		scanJobId?: string;
		producerTaskId?: string;
	}) => {
		const resolvedScanJobId =
			input.scanJobId ||
			(await findVulnerabilityCandidateByIdRepo(input.vulnerabilityCandidateId))
				?.scanJobId;
		const projectionCandidate = resolvedScanJobId
			? await findCandidateByIdWithResultsRepo({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: resolvedScanJobId,
					producerTaskId: input.producerTaskId,
				})
			: null;
		const [enrichedCandidate] = projectionCandidate
			? await enrichCandidateHostPaths([projectionCandidate])
			: [];
		if (!enrichedCandidate) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Vulnerability candidate not found",
			});
		}
		return enrichedCandidate;
	};

const toLineageItem = (
	task: Task,
	relation: CandidateTaskLineageRelation,
): CandidateTaskLineageItem => ({
	taskId: task.taskId,
	scanJobId: task.scanJobId,
	parentTaskId: task.sourceMessageId,
	stageName: task.stageName,
	status: task.status,
	name: task.name,
	attempt: task.attempt,
	runtimeMode: task.runtimeMode,
	createdAt: task.createdAt,
	startedAt: task.startedAt,
	completedAt: task.completedAt,
	relation,
});

const resolveUpstreamRelation = (
	task: Task,
): CandidateTaskLineageRelation | null => {
	if (
		task.stageName === "repository-profile" ||
		task.stageName === "delta-scope"
	) {
		return "repository";
	}
	if (task.stageName === "identify-target") {
		return "module";
	}
	if (task.stageName === "scan-target") {
		return "function";
	}
	return null;
};

export const findCandidateTaskLineage = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId?: string;
	producerTaskId?: string;
}) => {
	const candidate = input.scanJobId
		? await findVulnerabilityCandidateByIdAndScanJobIdRepo({
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
				scanJobId: input.scanJobId,
				producerTaskId: input.producerTaskId,
			})
		: await findVulnerabilityCandidateByIdRepo(input.vulnerabilityCandidateId);
	const upstreamTasks: CandidateTaskLineageItem[] = [];
	const seenTaskIds = new Set<string>();
	const visitedUpstreamTaskIds = new Set<string>();

	let currentTask = candidate.producerTaskId
		? await findTaskByIdRepo(candidate.producerTaskId).catch(() => null)
		: null;
	while (currentTask) {
		if (visitedUpstreamTaskIds.has(currentTask.taskId)) {
			break;
		}
		if (currentTask.scanJobId !== candidate.scanJobId) {
			break;
		}
		visitedUpstreamTaskIds.add(currentTask.taskId);
		const relation = resolveUpstreamRelation(currentTask);
		if (relation && !seenTaskIds.has(currentTask.taskId)) {
			upstreamTasks.push(toLineageItem(currentTask, relation));
			seenTaskIds.add(currentTask.taskId);
		}
		if (!currentTask.sourceMessageId) {
			currentTask = null;
			continue;
		}
		const { findMessageByIdRepo } = await import(
			"../persistence/message.repo"
		);
		const source = await findMessageByIdRepo(currentTask.sourceMessageId);
		currentTask = source
			? await findTaskByIdRepo(source.sourceTaskId).catch(() => null)
			: null;
	}
	upstreamTasks.reverse();

	const downstreamTasks: CandidateTaskLineageItem[] = [];
	const candidateTasks = candidate.producerTaskId
		? await listCandidateDescendantTasksByProducerTaskIdRepo({
				producerTaskId: candidate.producerTaskId,
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			})
		: [];
	for (const task of candidateTasks) {
		if (seenTaskIds.has(task.taskId)) {
			continue;
		}
		downstreamTasks.push(toLineageItem(task, "candidate"));
		seenTaskIds.add(task.taskId);
	}
	downstreamTasks.sort((left, right) =>
		left.createdAt.localeCompare(right.createdAt),
	);

	return {
		vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
		scanJobId: candidate.scanJobId,
		tasks: [...upstreamTasks, ...downstreamTasks],
	};
};
