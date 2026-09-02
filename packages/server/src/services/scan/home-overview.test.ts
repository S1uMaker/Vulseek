import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHomeOverviewActivity,
	buildHomeOverviewFromRows,
	clampHomeOverviewDays,
} from "./home-overview-aggregate";

test("buildHomeOverviewActivity fills missing dates without loading detail rows", () => {
	const days = buildHomeOverviewActivity({
		days: 3,
		now: new Date("2026-07-13T12:00:00.000Z"),
		rows: [
			{
				date: "2026-07-12",
				totalTokens: 12,
				scanJobCount: 1,
				taskCount: 4,
				candidateCount: 2,
				securityIssueCount: 1,
			},
		],
	});

	assert.deepEqual(days, [
		{
			date: "2026-07-11",
			totalTokens: 0,
			scanJobCount: 0,
			taskCount: 0,
			candidateCount: 0,
			securityIssueCount: 0,
		},
		{
			date: "2026-07-12",
			totalTokens: 12,
			scanJobCount: 1,
			taskCount: 4,
			candidateCount: 2,
			securityIssueCount: 1,
		},
		{
			date: "2026-07-13",
			totalTokens: 0,
			scanJobCount: 0,
			taskCount: 0,
			candidateCount: 0,
			securityIssueCount: 0,
		},
	]);
});

test("clampHomeOverviewDays defaults and limits the requested range", () => {
	assert.equal(clampHomeOverviewDays(undefined), 365);
	assert.equal(clampHomeOverviewDays(Number.NaN), 365);
	assert.equal(clampHomeOverviewDays(0), 1);
	assert.equal(clampHomeOverviewDays(999), 366);
	assert.equal(clampHomeOverviewDays(7.8), 7);
});

test("buildHomeOverviewFromRows fills daily rows and aggregates overview metrics", () => {
	const overview = buildHomeOverviewFromRows({
		projectCount: 2,
		subjectCount: 3,
		now: new Date("2026-07-07T12:00:00.000Z"),
		days: 3,
		jobs: [
			{
				scanJobId: "job-1",
				title: "GitLab full scan",
				status: "running",
				totalTokens: 100,
				createdAt: "2026-07-06T01:00:00.000Z",
				target: "GitLab",
				targetKind: "application",
				pipelineProfileName: "orch-hunt-default",
				projectId: "project-1",
				environmentId: "env-1",
				serviceId: "app-1",
			},
			{
				scanJobId: "job-2",
				title: "Jira full scan",
				status: "finished",
				totalTokens: 50,
				createdAt: "2026-07-07T02:00:00.000Z",
				target: "Jira",
				targetKind: "compose",
				pipelineProfileName: null,
				projectId: "project-1",
				environmentId: "env-1",
				serviceId: "compose-1",
			},
			{
				scanJobId: "job-3",
				title: "Old scan",
				status: "finished",
				totalTokens: 25,
				createdAt: "2026-06-01T02:00:00.000Z",
				target: "Old target",
				targetKind: "application",
				pipelineProfileName: "legacy",
				projectId: "project-1",
				environmentId: "env-1",
				serviceId: "app-2",
			},
		],
		tasks: [
			{
				scanJobId: "job-1",
				taskId: "task-1",
				status: "running",
				containerName: "container-1",
				stageName: "scan-target",
				output: null,
				createdAt: "2026-07-06T01:10:00.000Z",
			},
			{
				scanJobId: "job-2",
				taskId: "task-2",
				status: "completed",
				containerName: null,
				stageName: "triage-finding",
				output: { isSecurityIssue: true },
				createdAt: "2026-07-07T02:20:00.000Z",
			},
			{
				scanJobId: "job-3",
				taskId: "task-3",
				status: "completed",
				containerName: null,
				stageName: "triage-finding",
				output: { result: "security_issue" },
				createdAt: "2026-06-01T02:20:00.000Z",
			},
		],
		candidates: [
			{ scanJobId: "job-1", vulnerabilityCandidateId: "candidate-1" },
			{ scanJobId: "job-2", vulnerabilityCandidateId: "candidate-2" },
		],
	});

	assert.equal(overview.projectCount, 2);
	assert.equal(overview.subjectCount, 3);
	assert.equal(overview.totalTokens, 175);
	assert.equal(overview.securityIssueCount, 2);
	assert.deepEqual(
		overview.dailyActivity.map((day) => day.date),
		["2026-07-05", "2026-07-06", "2026-07-07"],
	);
	assert.deepEqual(overview.dailyActivity[0], {
		date: "2026-07-05",
		totalTokens: 0,
		scanJobCount: 0,
		taskCount: 0,
		candidateCount: 0,
		securityIssueCount: 0,
	});
	assert.deepEqual(overview.dailyActivity[1], {
		date: "2026-07-06",
		totalTokens: 100,
		scanJobCount: 1,
		taskCount: 1,
		candidateCount: 1,
		securityIssueCount: 0,
	});
	assert.deepEqual(overview.dailyActivity[2], {
		date: "2026-07-07",
		totalTokens: 50,
		scanJobCount: 1,
		taskCount: 1,
		candidateCount: 1,
		securityIssueCount: 1,
	});
	assert.equal(overview.running.jobCount, 1);
	assert.equal(overview.running.taskCount, 1);
	assert.equal(overview.running.containerCount, 1);
	assert.equal(
		overview.running.jobs[0]?.href,
		"/dashboard/project/project-1/environment/env-1/services/application/app-1/jobs/job-1",
	);
	assert.equal(
		overview.running.jobs[0]?.pipelineProfileName,
		"orch-hunt-default",
	);
});
