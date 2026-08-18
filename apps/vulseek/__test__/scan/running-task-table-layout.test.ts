import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readComponent = (name: string) =>
	readFileSync(
		join(process.cwd(), "components/dashboard/scanning", name),
		"utf8",
	);

const readServerSource = (relativePath: string) =>
	readFileSync(
		join(process.cwd(), "../../packages/server/src", relativePath),
		"utf8",
	);

describe("running task table layout", () => {
	it("reserves fixed space for stage, runtime, and actions", () => {
		const source = readComponent("scan-job-tasks-tab.tsx");
		const runningStart = source.indexOf("const runningColumns");
		const runningColumns = source.slice(
			runningStart,
			source.indexOf("const finishedColumns"),
		);

		// Stage cell: nowrap, full label as title tooltip.
		expect(runningColumns).toContain(
			'className="whitespace-nowrap capitalize"',
		);
		expect(
			runningColumns.match(/getTaskStageLabel\(t, row\.original\.stage\)/g),
		).toHaveLength(2);
		// Task cell: one primary anchor with a line-clamped title, no subtitle.
		expect(runningColumns).toContain(
			'className="line-clamp-2 font-medium hover:underline"',
		);
		expect(runningColumns).toContain("{getRunningTaskTitle(row.original)}");
		const taskCellStart = runningColumns.indexOf('id: "task"');
		const taskCell = runningColumns.slice(
			taskCellStart,
			runningColumns.indexOf('id: "runtime"'),
		);
		expect(taskCell).not.toContain("Subtitle");
		// Runtime cell: tabular numbers, nowrap.
		expect(runningColumns).toContain(
			'className="whitespace-nowrap tabular-nums"',
		);
		expect(runningColumns).toContain(
			"formatTaskRuntime(row.original.startedAt, runtimeNowMs)",
		);
		// Activity cell: nowrap badge.
		expect(runningColumns).toContain("noWrap");
	});

	it("balances task queue columns", () => {
		const source = readComponent("scan-job-tasks-tab.tsx");
		const queueStart = source.indexOf('"scan.tasks.queuesDescription"');
		const queueTable = source.slice(
			queueStart,
			source.indexOf('"scan.tasks.runningDescription"', queueStart),
		);

		expect(queueTable).toContain(
			'<table className="w-full min-w-[720px] table-fixed text-sm">',
		);
		expect(queueTable.match(/w-\[30%\]/g)).toHaveLength(4);
		expect(queueTable.match(/w-\[20%\]/g)).toHaveLength(4);
	});

	it("shows stage first and the raw task name without a subtitle", () => {
		const source = readComponent("scan-job-tasks-tab.tsx");
		const runningStart = source.indexOf("const runningColumns");
		const runningColumns = source.slice(
			runningStart,
			source.indexOf("const finishedColumns"),
		);

		expect(runningColumns.indexOf("scan.field.stage")).toBeLessThan(
			runningColumns.indexOf("scan.monitoring.task"),
		);
		expect(runningColumns).not.toContain("taskNameSeparator");
		expect(runningColumns).not.toContain("taskName.slice(");
		const taskCellStart = runningColumns.indexOf('id: "task"');
		const taskCell = runningColumns.slice(
			taskCellStart,
			runningColumns.indexOf('id: "runtime"'),
		);
		expect(taskCell).toContain("getRunningTaskTitle(row.original)");
		expect(taskCell).not.toContain("Subtitle");
		expect(source).toContain('String(task.taskName || "").trim()');
		expect(runningColumns).toContain("noWrap");
		expect(readComponent("live-task-activity.tsx")).toContain(
			'"flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden"',
		);
		expect(
			readServerSource("services/scan/persistence/task.repo.ts"),
		).toContain('taskName: String(value.name || ""),');
		expect(readServerSource("services/scan.ts")).toContain(
			"title: task.name || baseTask.title,",
		);
	});

	it("renders finished tasks as a task-first desktop table with mobile cards", () => {
		const source = readComponent("scan-job-tasks-tab.tsx");
		const finishedStart = source.indexOf("const finishedColumns");
		const finishedColumns = source.slice(finishedStart);

		// The primary task column precedes supporting metadata.
		expect(finishedColumns.indexOf('"scan.monitoring.task"')).toBeLessThan(
			finishedColumns.indexOf('"scan.field.stage"'),
		);
		// The task column renders the localized title only.
		expect(finishedColumns).toContain(
			'localizeTaskListText(t, row.original.title) || "-"',
		);
		expect(finishedColumns).not.toContain("getTaskListDisplay");
		expect(finishedColumns).not.toContain('"scan.task.tabs.details"');
		expect(finishedColumns).not.toContain("task.errorMessage");
		// Rerun selection is restricted to rerunnable terminal states.
		expect(finishedColumns).toContain(
			"RERUNNABLE_TASK_STATUSES.has(task.status)",
		);
		expect(source).toContain("getRowSelectable");
		const finishedSection = source.slice(
			source.indexOf('"scan.tasks.finishedDescription"'),
		);
		expect(finishedSection).toContain("mobileRender={(task) => (");
		expect(finishedSection).not.toContain("renderRow={(task) => (");
	});

	it("uses the dashboard ping effect for connected activity", () => {
		const source = readComponent("live-task-activity.tsx");

		expect(source).toContain(
			"absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75",
		);
		expect(source).toContain(
			"relative inline-flex h-2 w-2 rounded-full bg-emerald-500",
		);
	});

	it("opens the session transcript dialog wider than the default dialog", () => {
		const source = readComponent("live-task-activity.tsx");
		expect(source).toContain('DialogContent className="sm:max-w-7xl"');
	});
});
