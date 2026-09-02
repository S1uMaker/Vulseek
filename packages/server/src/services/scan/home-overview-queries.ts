import { db } from "@vulseek/server/db";
import { sql } from "drizzle-orm";
import {
	buildHomeOverviewActivity,
	clampHomeOverviewDays,
	type HomeOverviewActivityRow,
	type HomeOverviewRunningJob,
} from "./home-overview-aggregate";

const ACTIVE_TASK_STATUS_SQL = sql`'pending', 'launching', 'launched', 'starting', 'running'`;

type OrganizationJobRow = {
	scanJobId: string;
	title: string;
	status: "pending" | "running" | "paused" | "finished" | "failed" | "canceled";
	totalTokens: number | string | null;
	createdAt: string;
	target: string;
	targetKind: "application" | "compose";
	pipelineProfileName: string | null;
	projectId: string;
	environmentId: string;
	serviceId: string;
};

const organizationJobsCte = (organizationId: string) => sql`
	WITH organization_jobs AS (
		SELECT
			sj."scanJobId",
			sj."title",
			sj."status",
			sj."total_tokens" AS "totalTokens",
			sj."createdAt",
			COALESCE(NULLIF(a."name", ''), NULLIF(a."appName", ''), 'Application') AS "target",
			'application'::text AS "targetKind",
			(
				SELECT spp."name"
				FROM "scan_pipeline_profiles" spp
				WHERE spp."pipelineProfileId" = sj."pipelineProfileId"
			) AS "pipelineProfileName",
			p."projectId",
			e."environmentId",
			a."applicationId" AS "serviceId"
		FROM "scan_jobs" sj
		INNER JOIN "application" a ON sj."applicationId" = a."applicationId"
		INNER JOIN "environment" e ON a."environmentId" = e."environmentId"
		INNER JOIN "project" p ON e."projectId" = p."projectId"
		WHERE p."organizationId" = ${organizationId}

		UNION ALL

		SELECT
			sj."scanJobId",
			sj."title",
			sj."status",
			sj."total_tokens" AS "totalTokens",
			sj."createdAt",
			COALESCE(NULLIF(c."name", ''), NULLIF(c."appName", ''), 'Compose') AS "target",
			'compose'::text AS "targetKind",
			(
				SELECT spp."name"
				FROM "scan_pipeline_profiles" spp
				WHERE spp."pipelineProfileId" = sj."pipelineProfileId"
			) AS "pipelineProfileName",
			p."projectId",
			e."environmentId",
			c."composeId" AS "serviceId"
		FROM "scan_jobs" sj
		INNER JOIN "compose" c ON sj."composeId" = c."composeId"
		INNER JOIN "environment" e ON c."environmentId" = e."environmentId"
		INNER JOIN "project" p ON e."projectId" = p."projectId"
		WHERE p."organizationId" = ${organizationId}
	)
`;

const toNumber = (value: number | string | null | undefined) =>
	typeof value === "number" ? value : Number(value || 0);

const toDateRange = (days: number, now = new Date()) => {
	const end = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	);
	end.setUTCHours(0, 0, 0, 0);
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - (days - 1) - 1);
	return { start: start.toISOString(), end: end.toISOString() };
};

export const getScanHomeSummary = async (organizationId: string) => {
	const result = await db.execute(sql`
		${organizationJobsCte(organizationId)},
		organization_projects AS (
			SELECT COUNT(*)::int AS "projectCount"
			FROM "project"
			WHERE "organizationId" = ${organizationId}
		),
		organization_subjects AS (
			SELECT COUNT(*)::int AS "subjectCount"
			FROM (
				SELECT a."applicationId"
				FROM "application" a
				INNER JOIN "environment" e ON a."environmentId" = e."environmentId"
				INNER JOIN "project" p ON e."projectId" = p."projectId"
				WHERE p."organizationId" = ${organizationId}
				UNION ALL
				SELECT c."composeId"
				FROM "compose" c
				INNER JOIN "environment" e ON c."environmentId" = e."environmentId"
				INNER JOIN "project" p ON e."projectId" = p."projectId"
				WHERE p."organizationId" = ${organizationId}
			) subjects
		),
		organization_candidates AS (
			SELECT COUNT(*)::int AS "securityIssueCount"
			FROM "vulnerability_candidates" vc
			INNER JOIN organization_jobs oj ON oj."scanJobId" = vc."scanJobId"
			WHERE vc."triageResult" = 'security_issue'
		)
		SELECT
			op."projectCount",
			os."subjectCount",
			COALESCE(SUM(oj."totalTokens"), 0)::bigint AS "totalTokens",
			oc."securityIssueCount"
		FROM organization_projects op
		CROSS JOIN organization_subjects os
		CROSS JOIN organization_candidates oc
		LEFT JOIN organization_jobs oj ON TRUE
		GROUP BY op."projectCount", os."subjectCount", oc."securityIssueCount"
	`);
	const row = result[0] as
		| {
				projectCount: number;
				subjectCount: number;
				totalTokens: number | string;
				securityIssueCount: number;
		  }
		| undefined;
	return {
		projectCount: Number(row?.projectCount || 0),
		subjectCount: Number(row?.subjectCount || 0),
		totalTokens: toNumber(row?.totalTokens),
		securityIssueCount: Number(row?.securityIssueCount || 0),
	};
};

export const getScanHomeActivity = async (input: {
	organizationId: string;
	days?: number;
	now?: Date;
}) => {
	const days = clampHomeOverviewDays(input.days);
	const { start, end } = toDateRange(days, input.now);
	const result = await db.execute(sql`
		${organizationJobsCte(input.organizationId)},
		activity_jobs AS (
			SELECT *
			FROM organization_jobs
			WHERE "createdAt"::timestamptz >= ${start}::timestamptz
				AND "createdAt"::timestamptz < ${end}::timestamptz
		),
		task_counts AS (
			SELECT t."scanJobId", COUNT(*)::int AS "taskCount"
			FROM "tasks" t
			INNER JOIN activity_jobs aj ON aj."scanJobId" = t."scanJobId"
			GROUP BY t."scanJobId"
		),
		candidate_counts AS (
			SELECT vc."scanJobId", COUNT(*)::int AS "candidateCount"
			FROM "vulnerability_candidates" vc
			INNER JOIN activity_jobs aj ON aj."scanJobId" = vc."scanJobId"
			GROUP BY vc."scanJobId"
		),
		security_issue_counts AS (
			SELECT vc."scanJobId", COUNT(*)::int AS "securityIssueCount"
			FROM "vulnerability_candidates" vc
			INNER JOIN activity_jobs aj ON aj."scanJobId" = vc."scanJobId"
			WHERE vc."triageResult" = 'security_issue'
			GROUP BY vc."scanJobId"
		)
		SELECT
			TO_CHAR((aj."createdAt"::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
			COALESCE(SUM(aj."totalTokens"), 0)::bigint AS "totalTokens",
			COUNT(*)::int AS "scanJobCount",
			COALESCE(SUM(tc."taskCount"), 0)::int AS "taskCount",
			COALESCE(SUM(cc."candidateCount"), 0)::int AS "candidateCount",
			COALESCE(SUM(sic."securityIssueCount"), 0)::int AS "securityIssueCount"
		FROM activity_jobs aj
		LEFT JOIN task_counts tc ON tc."scanJobId" = aj."scanJobId"
		LEFT JOIN candidate_counts cc ON cc."scanJobId" = aj."scanJobId"
		LEFT JOIN security_issue_counts sic ON sic."scanJobId" = aj."scanJobId"
		GROUP BY date
		ORDER BY date
	`);
	const rows = result.map((row) => {
		const value = row as Record<string, unknown>;
		return {
			date: String(value.date),
			totalTokens: toNumber(value.totalTokens as number | string | null),
			scanJobCount: Number(value.scanJobCount || 0),
			taskCount: Number(value.taskCount || 0),
			candidateCount: Number(value.candidateCount || 0),
			securityIssueCount: Number(value.securityIssueCount || 0),
		} satisfies HomeOverviewActivityRow;
	});
	return { days: buildHomeOverviewActivity({ rows, days, now: input.now }) };
};

export const getScanHomeWorkload = async (organizationId: string) => {
	const result = await db.execute(sql`
		${organizationJobsCte(organizationId)},
		active_jobs AS (
			SELECT *
			FROM organization_jobs
			WHERE "status" IN ('pending', 'running')
		),
		active_task_counts AS (
			SELECT
				t."scanJobId",
				COUNT(*) FILTER (WHERE t."status" IN (${ACTIVE_TASK_STATUS_SQL}))::int AS "runningTaskCount",
				COUNT(DISTINCT t."containerName") FILTER (WHERE t."status" IN (${ACTIVE_TASK_STATUS_SQL}) AND t."containerName" IS NOT NULL)::int AS "runningContainerCount"
			FROM "tasks" t
			INNER JOIN active_jobs aj ON aj."scanJobId" = t."scanJobId"
			GROUP BY t."scanJobId"
		)
		SELECT
			aj.*,
			COALESCE(atc."runningTaskCount", 0)::int AS "runningTaskCount",
			COALESCE(atc."runningContainerCount", 0)::int AS "runningContainerCount"
		FROM active_jobs aj
		LEFT JOIN active_task_counts atc ON atc."scanJobId" = aj."scanJobId"
		ORDER BY aj."createdAt" DESC
	`);
	const jobs = result.map((row) => {
		const value = row as OrganizationJobRow & {
			runningTaskCount: number;
			runningContainerCount: number;
		};
		const href =
			value.targetKind === "application"
				? `/dashboard/project/${value.projectId}/environment/${value.environmentId}/services/application/${value.serviceId}/jobs/${value.scanJobId}`
				: `/dashboard/project/${value.projectId}/environment/${value.environmentId}/services/compose/${value.serviceId}/jobs/${value.scanJobId}`;
		return {
			scanJobId: value.scanJobId,
			title: value.title,
			target: value.target,
			targetKind: value.targetKind,
			pipelineProfileName: value.pipelineProfileName?.trim() || null,
			projectId: value.projectId,
			environmentId: value.environmentId,
			serviceId: value.serviceId,
			status: value.status as "pending" | "running",
			totalTokens: toNumber(value.totalTokens),
			runningTaskCount: Number(value.runningTaskCount || 0),
			runningContainerCount: Number(value.runningContainerCount || 0),
			createdAt: value.createdAt,
			href,
		} satisfies HomeOverviewRunningJob;
	});
	return {
		jobCount: jobs.length,
		taskCount: jobs.reduce((total, job) => total + job.runningTaskCount, 0),
		containerCount: jobs.reduce(
			(total, job) => total + job.runningContainerCount,
			0,
		),
		jobs,
	};
};
