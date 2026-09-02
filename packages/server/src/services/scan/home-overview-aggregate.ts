export const ACTIVE_TASK_STATUSES = [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
] as const;

export const TRIAGE_STAGE_NAMES = ["triage-finding"] as const;

export type HomeOverviewDailyActivity = {
	date: string;
	totalTokens: number;
	scanJobCount: number;
	taskCount: number;
	candidateCount: number;
	securityIssueCount: number;
};

export type HomeOverviewRunningJob = {
	scanJobId: string;
	title: string;
	target: string;
	targetKind: "application" | "compose";
	pipelineProfileName: string | null;
	projectId: string;
	environmentId: string;
	serviceId: string;
	status: "pending" | "running";
	totalTokens: number;
	runningTaskCount: number;
	runningContainerCount: number;
	createdAt: string;
	href: string;
};

export type HomeOverview = {
	projectCount: number;
	subjectCount: number;
	totalTokens: number;
	securityIssueCount: number;
	running: {
		jobCount: number;
		taskCount: number;
		containerCount: number;
		jobs: HomeOverviewRunningJob[];
	};
	dailyActivity: HomeOverviewDailyActivity[];
};

export type HomeOverviewActivityRow = {
	date: string;
	totalTokens: number;
	scanJobCount: number;
	taskCount: number;
	candidateCount: number;
	securityIssueCount: number;
};

export type OverviewJobRow = {
	scanJobId: string;
	title: string;
	status: "pending" | "running" | "paused" | "finished" | "failed" | "canceled";
	totalTokens: number;
	createdAt: string;
	target: string;
	targetKind: "application" | "compose";
	pipelineProfileName: string | null;
	projectId: string;
	environmentId: string;
	serviceId: string;
};

export type OverviewTaskRow = {
	scanJobId: string;
	taskId: string;
	status: string;
	containerName: string | null;
	stageName: string;
	output: unknown | null;
	createdAt: string;
};

export type OverviewCandidateRow = {
	scanJobId: string;
	vulnerabilityCandidateId: string;
};

export const clampHomeOverviewDays = (days?: number) => {
	if (!Number.isFinite(days)) {
		return 365;
	}
	return Math.max(1, Math.min(366, Math.trunc(days as number)));
};

export const buildHomeOverviewActivity = (input: {
	rows: HomeOverviewActivityRow[];
	days: number;
	now?: Date;
}) => {
	const days = clampHomeOverviewDays(input.days);
	const now = input.now || new Date();
	const start = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	start.setUTCDate(start.getUTCDate() - (days - 1));
	const rowsByDate = new Map(input.rows.map((row) => [row.date, row]));

	return Array.from({ length: days }, (_, offset) => {
		const date = new Date(start);
		date.setUTCDate(start.getUTCDate() + offset);
		const key = formatHomeOverviewDate(date);
		return (
			rowsByDate.get(key) || {
				date: key,
				totalTokens: 0,
				scanJobCount: 0,
				taskCount: 0,
				candidateCount: 0,
				securityIssueCount: 0,
			}
		);
	});
};

export const formatHomeOverviewDate = (date: Date) =>
	date.toISOString().slice(0, 10);

const parseDateMs = (value: string) => {
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : 0;
};

const isSecurityIssueOutput = (output: unknown) => {
	if (!output || typeof output !== "object") {
		return false;
	}
	const record = output as Record<string, unknown>;
	return (
		record.isSecurityIssue === true ||
		record.result === "security_issue" ||
		record.securityClassification === "security_issue"
	);
};

export const buildHomeOverviewFromRows = (input: {
	projectCount: number;
	subjectCount: number;
	jobs: OverviewJobRow[];
	tasks: OverviewTaskRow[];
	candidates: OverviewCandidateRow[];
	days: number;
	now?: Date;
}): HomeOverview => {
	const days = clampHomeOverviewDays(input.days);
	const now = input.now || new Date();
	const start = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	start.setUTCDate(start.getUTCDate() - (days - 1));

	const activityByDate = new Map<string, HomeOverviewDailyActivity>();
	for (let offset = 0; offset < days; offset += 1) {
		const date = new Date(start);
		date.setUTCDate(start.getUTCDate() + offset);
		const key = formatHomeOverviewDate(date);
		activityByDate.set(key, {
			date: key,
			totalTokens: 0,
			scanJobCount: 0,
			taskCount: 0,
			candidateCount: 0,
			securityIssueCount: 0,
		});
	}

	const dateByScanJobId = new Map<string, string>();
	let totalTokens = 0;
	for (const job of input.jobs) {
		totalTokens += job.totalTokens || 0;
		const date = formatHomeOverviewDate(new Date(parseDateMs(job.createdAt)));
		dateByScanJobId.set(job.scanJobId, date);
		const activity = activityByDate.get(date);
		if (activity) {
			activity.scanJobCount += 1;
			activity.totalTokens += job.totalTokens || 0;
		}
	}

	const runningTaskCountByScanJobId = new Map<string, number>();
	const runningContainerCountByScanJobId = new Map<string, Set<string>>();
	let securityIssueCount = 0;
	for (const task of input.tasks) {
		const activity = activityByDate.get(
			dateByScanJobId.get(task.scanJobId) || "",
		);
		if (activity) {
			activity.taskCount += 1;
		}
		if ((ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) {
			runningTaskCountByScanJobId.set(
				task.scanJobId,
				(runningTaskCountByScanJobId.get(task.scanJobId) || 0) + 1,
			);
			if (task.containerName) {
				const containers =
					runningContainerCountByScanJobId.get(task.scanJobId) ||
					new Set<string>();
				containers.add(task.containerName);
				runningContainerCountByScanJobId.set(task.scanJobId, containers);
			}
		}
		if (
			(TRIAGE_STAGE_NAMES as readonly string[]).includes(task.stageName) &&
			isSecurityIssueOutput(task.output)
		) {
			securityIssueCount += 1;
			if (activity) {
				activity.securityIssueCount += 1;
			}
		}
	}

	for (const candidate of input.candidates) {
		const activity = activityByDate.get(
			dateByScanJobId.get(candidate.scanJobId) || "",
		);
		if (activity) {
			activity.candidateCount += 1;
		}
	}

	const runningJobs = input.jobs
		.filter(
			(job): job is OverviewJobRow & { status: "pending" | "running" } =>
				job.status === "pending" || job.status === "running",
		)
		.map((job) => {
			const runningContainerCount =
				runningContainerCountByScanJobId.get(job.scanJobId)?.size || 0;
			const href =
				job.targetKind === "application"
					? `/dashboard/project/${job.projectId}/environment/${job.environmentId}/services/application/${job.serviceId}/jobs/${job.scanJobId}`
					: `/dashboard/project/${job.projectId}/environment/${job.environmentId}/services/compose/${job.serviceId}/jobs/${job.scanJobId}`;
			return {
				scanJobId: job.scanJobId,
				title: job.title,
				target: job.target,
				targetKind: job.targetKind,
				pipelineProfileName: job.pipelineProfileName?.trim() || null,
				projectId: job.projectId,
				environmentId: job.environmentId,
				serviceId: job.serviceId,
				status: job.status,
				totalTokens: job.totalTokens || 0,
				runningTaskCount: runningTaskCountByScanJobId.get(job.scanJobId) || 0,
				runningContainerCount,
				createdAt: job.createdAt,
				href,
			};
		})
		.sort(
			(left, right) =>
				parseDateMs(right.createdAt) - parseDateMs(left.createdAt),
		);

	return {
		projectCount: input.projectCount,
		subjectCount: input.subjectCount,
		totalTokens,
		securityIssueCount,
		running: {
			jobCount: runningJobs.length,
			taskCount: [...runningTaskCountByScanJobId.values()].reduce(
				(total, count) => total + count,
				0,
			),
			containerCount: [...runningContainerCountByScanJobId.values()].reduce(
				(total, containers) => total + containers.size,
				0,
			),
			jobs: runningJobs,
		},
		dailyActivity: [...activityByDate.values()],
	};
};
