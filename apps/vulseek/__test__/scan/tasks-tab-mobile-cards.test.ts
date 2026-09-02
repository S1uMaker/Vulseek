import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readComponent = () =>
	readFileSync(
		join(process.cwd(), "components/dashboard/scanning/scan-job-tasks-tab.tsx"),
		"utf8",
	);

describe("tasks tab row layout", () => {
	it("passes a full-width renderRow to the running-tasks CollectionView", () => {
		const source = readComponent();
		const runningStart = source.indexOf("state={runningState}");
		const runningBlock = source.slice(
			runningStart,
			source.indexOf("state={finishedState}"),
		);

		expect(runningBlock).toContain("renderRow=");
		// The card keeps the primary task-detail anchor…
		expect(runningBlock).toContain("href={taskHref(task.taskId)}");
		// …the stage/runtime context…
		expect(runningBlock).toContain("getTaskStageShortLabel(t, task.stage)");
		expect(runningBlock).toContain(
			"formatTaskRuntime(task.startedAt, runtimeNowMs)",
		);
		expect(runningBlock).not.toContain("pendingMessageCountOf(task)");
		// …and the live activity + cancel actions, shared with the table.
		expect(runningBlock).toContain("LiveTaskActivityBadge");
		expect(runningBlock).toContain("renderRunningTaskActions(task)");
	});

	it("keeps running task metadata in a compact horizontal row", () => {
		const source = readComponent();
		const runningStart = source.indexOf("state={runningState}");
		const runningBlock = source.slice(
			runningStart,
			source.indexOf("state={finishedState}"),
		);

		expect(runningBlock).toContain(
			"<RowListItem className={RUNNING_TASK_GRID_CLASS_NAME}>",
		);
		expect(source).toContain(
			"grid-cols-[2.75rem_minmax(0,1.25fr)_2.5rem_minmax(5rem,0.9fr)_auto]",
		);
		expect(source).toContain(
			"sm:grid-cols-[4.25rem_minmax(14rem,1.4fr)_4.5rem_minmax(8rem,1fr)_auto]",
		);
		expect(runningBlock).toContain("rowHeader=");
		expect(source).toContain(
			'className="w-[4.375rem]" aria-hidden="true"',
		);
		expect(runningBlock).toContain(
			'className="min-w-0 truncate font-medium hover:underline"',
		);
		expect(runningBlock).toContain('className="min-w-0 justify-self-end"');
		expect(runningBlock).not.toContain("sm:col-start-6");
		expect(source).toContain(
			'className="h-7 w-7 rounded-md sm:h-8 sm:w-8"',
		);
		expect(runningBlock).not.toContain("items-start sm:items-center");
		expect(runningBlock).not.toContain("line-clamp-2 font-medium");
	});

	it("passes a full-width renderRow to the finished-tasks CollectionView", () => {
		const source = readComponent();
		const finishedStart = source.indexOf("state={finishedState}");
		const finishedBlock = source.slice(finishedStart);

		expect(finishedBlock).toContain("mobileRender=");
		expect(finishedBlock).toContain("href={taskHref(task.taskId)}");
		expect(finishedBlock).toContain("getTaskStageLabel(t, task.stage)");
		expect(finishedBlock).toContain("getTaskStatusLabel(t, task.status)");
		expect(finishedBlock).not.toContain("pendingMessageCountOf(task)");
		expect(finishedBlock).not.toContain("scan.tasks.pendingOutputs");
		// Per-row rerun stays reachable in the row, shared with the table.
		expect(finishedBlock).toContain("renderFinishedTaskActions(task)");
	});

	it("shares the row actions between the table contract and rendered rows", () => {
		const source = readComponent();
		// Each actions cell delegates to the shared renderer instead of
		// duplicating the buttons.
		expect(source).toContain("renderRunningTaskActions(row.original)");
		expect(source).toContain("renderFinishedTaskActions(row.original)");
		expect(source).toContain("const renderRunningTaskActions");
		expect(source).toContain("const renderFinishedTaskActions");
	});
});
