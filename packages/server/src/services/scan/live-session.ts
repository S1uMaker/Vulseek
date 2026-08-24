import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@vulseek/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	scanJobs,
} from "@vulseek/server/db/schema";
import { and, eq, or } from "drizzle-orm";
import { findApplicationById } from "../application";
import { findComposeById } from "../compose";
import { resolveDatasetTrialRuntime } from "../dataset";
import { findScanJobByIdRepo } from "./persistence/scan-job.repo";
import { findScanJobOrganizationIdRepo } from "./persistence/scan-job-access.repo";
import {
	findTaskByIdRepo,
	listRunningTaskRuntimeMetadataRepo,
} from "./persistence/task.repo";
import type { Task } from "./types";

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const resolveScanStageTaskRuntimeDir = (
	baseDir: string,
	stageName: string,
	taskName: string,
	taskId?: string,
) =>
	path.join(
		baseDir,
		"scanning",
		"full_scan",
		"stages",
		sanitizePathPart(stageName),
		"tasks",
		taskId
			? `${sanitizePathPart(taskName)}-${sanitizePathPart(taskId).slice(0, 6)}`
			: sanitizePathPart(taskName),
	);

const resolveScanContextRoot = async () => {
	const candidates = [
		"/scan-context",
		process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "",
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) {
				return candidate;
			}
		} catch {}
	}
	return "/scan-context";
};

const findScanJobTargetSummary = async (scanJobId: string) => {
	const applicationTarget = await db
		.select({
			projectName: projects.name,
			serviceName: applications.name,
			appName: applications.appName,
		})
		.from(scanJobs)
		.innerJoin(
			applications,
			eq(scanJobs.applicationId, applications.applicationId),
		)
		.innerJoin(
			environments,
			eq(applications.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (applicationTarget) {
		return {
			projectName: applicationTarget.projectName,
			serviceName:
				applicationTarget.serviceName ||
				applicationTarget.appName ||
				"application",
		};
	}

	const composeTarget = await db
		.select({
			projectName: projects.name,
			serviceName: compose.name,
			appName: compose.appName,
		})
		.from(scanJobs)
		.innerJoin(compose, eq(scanJobs.composeId, compose.composeId))
		.innerJoin(
			environments,
			eq(compose.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (composeTarget) {
		return {
			projectName: composeTarget.projectName,
			serviceName:
				composeTarget.serviceName || composeTarget.appName || "compose",
		};
	}

	const datasetRuntime = await resolveDatasetTrialRuntime(scanJobId);
	if (datasetRuntime) {
		return {
			projectName: `dataset-${datasetRuntime.dataset.datasetId}`,
			serviceName: `${datasetRuntime.profile.profileId}-${datasetRuntime.sample.id}`,
		};
	}

	return null;
};

export const findScanJobOrganizationId = async (scanJobId: string) =>
	await findScanJobOrganizationIdRepo(scanJobId);

export const findScanJobStatusById = async (scanJobId: string) =>
	await db
		.select({ status: scanJobs.status })
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]?.status || null);

const resolveScanJobBaseDir = async (scanJobId: string) => {
	const target = await findScanJobTargetSummary(scanJobId);
	if (!target) {
		const scanJob = await findScanJobByIdRepo(scanJobId);
		if (!scanJob.applicationId && !scanJob.composeId) {
			throw new Error(`Scan job ${scanJobId} has no supported runtime target`);
		}
		const fullTarget = scanJob.applicationId
			? await findApplicationById(scanJob.applicationId)
			: await findComposeById(scanJob.composeId as string);
		const projectName = fullTarget.environment.project.name;
		const serviceName = fullTarget.name || fullTarget.appName;
		return path.join(
			await resolveScanContextRoot(),
			"projects",
			sanitizePathPart(projectName),
			"profiles",
			sanitizePathPart(serviceName),
			"jobs",
			scanJobId,
		);
	}
	return path.join(
		await resolveScanContextRoot(),
		"projects",
		sanitizePathPart(target.projectName),
		"profiles",
		sanitizePathPart(target.serviceName),
		"jobs",
		scanJobId,
	);
};

const toAgentProvider = (provider?: string | null): "codex" | "claude" =>
	provider === "claude_code" ? "claude" : "codex";

const resolveTaskAgentProvider = (
	agentProfile?: { provider?: string | null } | null,
) => toAgentProvider(agentProfile?.provider);

export type AgentTaskRuntime = {
	taskId: string;
	scanJobId: string;
	stageName: string;
	taskKind:
		| "delta-scope"
		| "repository-profile"
		| "identify-target"
		| "scan-target"
		| "analyze-finding"
		| "critique-finding"
		| "verify-finding"
		| "triage-finding"
		| "research-scope"
		| "surface-map"
		| "track-plan"
		| "vulnerability-discovery"
		| "track-review"
		| "finding-validation"
		| "finding-review"
		| "chain-synthesis"
		| "chain-review"
		| "exploit-validation"
		| "exploit-review"
		| "research-report"
		| "goal-craft"
		| "goal-surface"
		| "goal-hunt"
		| "goal-judge"
		| "goal-dedup";
	status: string;
	containerName: string | null;
	sessionId: string | null;
	provider: "codex" | "claude";
	baseDir: string;
	runtimeDir: string;
	stdoutPath: string;
	createdAt: string | null;
	updatedAt: string | null;
};

const buildAgentRuntimeFiles = (runtimeDir: string) => ({
	runtimeDir,
	stdoutPath: path.join(runtimeDir, "stdout"),
});

export const findAgentTaskRuntimeByTaskId = async (
	taskId: string,
): Promise<AgentTaskRuntime | null> => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	if (task) {
		return buildAgentTaskRuntime(task);
	}
	return null;
};

type AgentTaskRuntimeSource = Pick<
	Task,
	| "taskId"
	| "scanJobId"
	| "stageName"
	| "name"
	| "status"
	| "containerName"
	| "threadId"
	| "agentProfile"
	| "updatedAt"
> & { createdAt?: string | null };

export const buildAgentTaskRuntime = async (
	task: AgentTaskRuntimeSource,
	baseDirOverride?: string,
): Promise<AgentTaskRuntime> => {
	const baseDir = baseDirOverride ?? (await resolveScanJobBaseDir(task.scanJobId));
	const runtimeDir = resolveScanStageTaskRuntimeDir(
		baseDir,
		task.stageName,
		task.name,
		task.taskId,
	);
	let taskKind: AgentTaskRuntime["taskKind"] = "repository-profile";

	switch (task.stageName) {
		case "delta-scope":
			taskKind = "delta-scope";
			break;
		case "repository-profile":
			taskKind = "repository-profile";
			break;
		case "identify-target":
			taskKind = "identify-target";
			break;
		case "scan-target":
			taskKind = "scan-target";
			break;
		case "analyze-finding":
			taskKind = "analyze-finding";
			break;
		case "critique-finding":
			taskKind = "critique-finding";
			break;
		case "verify-finding":
			taskKind = "verify-finding";
			break;
		case "triage-finding":
			taskKind = "triage-finding";
			break;
		case "research-scope":
		case "surface-map":
		case "track-plan":
		case "vulnerability-discovery":
		case "track-review":
		case "finding-validation":
		case "finding-review":
		case "chain-synthesis":
		case "chain-review":
		case "exploit-validation":
		case "exploit-review":
		case "research-report":
		case "goal-craft":
		case "goal-surface":
		case "goal-hunt":
		case "goal-judge":
		case "goal-dedup":
			taskKind = task.stageName as AgentTaskRuntime["taskKind"];
			break;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		stageName: task.stageName,
		taskKind,
		status: task.status,
		containerName: task.containerName,
		sessionId: task.threadId,
		provider: resolveTaskAgentProvider(task.agentProfile),
		baseDir,
		...buildAgentRuntimeFiles(runtimeDir),
		createdAt: task.createdAt || null,
		updatedAt: task.updatedAt || null,
	};
};

export const findRunningAgentTaskRuntimesByScanJobId = async (
	scanJobId: string,
): Promise<AgentTaskRuntime[]> => {
	const runningTasks = await listRunningTaskRuntimeMetadataRepo(scanJobId);
	const baseDir = await resolveScanJobBaseDir(scanJobId);
	return await Promise.all(
		runningTasks.map((task) => buildAgentTaskRuntime(task, baseDir)),
	);
};

export const listRunningScanJobsByOrganizationId = async (
	organizationId: string,
): Promise<{ scanJobId: string }[]> => {
	const statusFilter = or(
		eq(scanJobs.status, "pending"),
		eq(scanJobs.status, "running"),
	);
	const [appJobs, composeJobs] = await Promise.all([
		db
			.select({ scanJobId: scanJobs.scanJobId })
			.from(scanJobs)
			.innerJoin(
				applications,
				eq(scanJobs.applicationId, applications.applicationId),
			)
			.innerJoin(
				environments,
				eq(applications.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(and(eq(projects.organizationId, organizationId), statusFilter)),
		db
			.select({ scanJobId: scanJobs.scanJobId })
			.from(scanJobs)
			.innerJoin(compose, eq(scanJobs.composeId, compose.composeId))
			.innerJoin(
				environments,
				eq(compose.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(and(eq(projects.organizationId, organizationId), statusFilter)),
	]);
	return [...appJobs, ...composeJobs];
};
