import { Ban, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useTranslation } from "next-i18next";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	LiveTaskActivityBadge,
	LiveTaskActivityButton,
} from "@/components/dashboard/scanning/live-task-activity";
import { RunningCapacityBars } from "@/components/dashboard/scanning/scan-job-result-flow";
import { buildTaskQueueMetrics } from "@/components/dashboard/scanning/task-queue-metrics";
import { useAgentActivities } from "@/components/dashboard/scanning/use-agent-activity";
import {
	type CollectionFilter,
	CollectionSection,
	CollectionView,
	RowListItem,
} from "@/components/dashboard/ui-system";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { idleAgentActivity } from "@/lib/scan/agent-activity";
import type { ListQueryState } from "@/lib/ui-system/list-query";
import { api, type RouterOutputs } from "@/utils/api";
import {
	formatScanStageLabel,
	isTerminalScanJobStatus,
	scanT,
} from "./scan-i18n";
import {
	formatTaskRuntime,
	getTaskStageLabel,
	getTaskStageShortLabel,
	getTaskStatusBadgeClassName,
	getTaskStatusLabel,
	localizeTaskListText,
	normalizeTaskStageOption,
	RERUNNABLE_TASK_STATUSES,
	RUNNING_TASK_STAGE_ORDER,
} from "./scan-job-detail-format";

/**
 * Tasks tab for the shared scan job detail.
 *
 * Owns everything the tab needs: the terminal-tasks query, the agent
 * activity stream, task rerun/cancel mutations and the running 1s runtime
 * clock. Both task lists are CollectionViews with controlled local state —
 * the tab is a live page (polling every 5–10s), so list state is not
 * written to the URL.
 */

type RunningTask = RouterOutputs["scan"]["jobRunningTasks"]["tasks"][number];
type TerminalTask = RouterOutputs["scan"]["terminalTasks"]["items"][number];

const RUNNING_TASK_GRID_CLASS_NAME =
	"grid grid-cols-[2.75rem_minmax(0,1.25fr)_2.5rem_minmax(5rem,0.9fr)_auto] items-center justify-start gap-x-1.5 overflow-hidden rounded-lg px-2 py-1.5 sm:grid-cols-[4.25rem_minmax(14rem,1.4fr)_4.5rem_minmax(8rem,1fr)_auto] sm:gap-x-4 sm:px-4 sm:py-2 sm:justify-start";

export const TERMINAL_TASK_STATUS_OPTIONS = [
	"completed",
	"failed",
	"exited",
	"canceled",
] as const;

const makeInitialState = (pageSize: number): ListQueryState => ({
	query: "",
	filters: {},
	sortKey: "",
	sortDirection: "desc",
	page: 1,
	pageSize,
});

export const ScanJobTasksTab = ({
	scanJobId,
	scanJob,
	runningTasksData,
	runningTasksError,
	queueCountsData,
	queueCountsError,
	jobPipeline,
	taskHref,
}: {
	scanJobId: string;
	scanJob: RouterOutputs["scan"]["jobOverview"] | undefined;
	runningTasksData: RouterOutputs["scan"]["jobRunningTasks"] | undefined;
	runningTasksError: unknown;
	queueCountsData: RouterOutputs["scan"]["jobQueueCounts"] | undefined;
	queueCountsError: unknown;
	jobPipeline: RouterOutputs["scan"]["jobPipeline"] | undefined;
	/** Link builder for the task detail page (project or dataset entry). */
	taskHref: (taskId: string) => string;
}) => {
	const { t } = useTranslation("scan");
	const utils = api.useUtils();

	// Shared free-text search: both lists echo it immediately; only the
	// finished list's server query consumes the deferred value.
	const [searchInput, setSearchInput] = useState("");
	const deferredQuery = useDeferredValue(searchInput);
	const [runningState, setRunningState] = useState<ListQueryState>(() =>
		makeInitialState(10),
	);
	const [finishedState, setFinishedState] = useState<ListQueryState>(() =>
		makeInitialState(20),
	);
	const [selectedFinishedTaskIds, setSelectedFinishedTaskIds] = useState<
		Set<string>
	>(() => new Set());
	const [rerunningTaskId, setRerunningTaskId] = useState<string | null>(null);
	const [cancelingTaskId, setCancelingTaskId] = useState<string | null>(null);
	const [bulkRerunningTaskIds, setBulkRerunningTaskIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [runtimeNowMs, setRuntimeNowMs] = useState(() => Date.now());

	const runningStage = runningState.filters.stage?.[0] ?? "all";
	const finishedStage = finishedState.filters.stage?.[0] ?? "all";
	const finishedStatus = finishedState.filters.status?.[0] ?? "all";

	const {
		data: terminalTasks,
		isLoading: isLoadingTerminalTasks,
		isFetching: isFetchingTerminalTasks,
	} = api.scan.terminalTasks.useQuery(
		{
			scanJobId,
			page: finishedState.page,
			pageSize: finishedState.pageSize,
			query: deferredQuery,
			stage: finishedStage,
			status: finishedStatus,
		},
		{
			enabled: !!scanJobId,
			refetchInterval: !isTerminalScanJobStatus(scanJob?.status)
				? 10_000
				: false,
			keepPreviousData: true,
		},
	);
	const { activitiesByTaskId, connectedTaskIds } = useAgentActivities({
		scanJobId,
		enabled: (runningTasksData?.tasks.length ?? 0) > 0,
	});
	const rerunTaskMutation = api.scan.rerunTask.useMutation();
	const cancelTaskMutation = api.scan.cancelTask.useMutation();

	const queuePendingCounts = queueCountsData?.queues ?? [];
	const hasQueueRuntime = Boolean(queueCountsData);
	const pipelineConcurrencyByStage = useMemo(
		() =>
			new Map(
				(jobPipeline?.nodes ?? []).map((node) => [
					node.stageName,
					node.configuredConcurrency ?? node.concurrencyLimit,
				]),
			),
		[jobPipeline?.nodes],
	);
	const getQueueTaskMetrics = (queue: (typeof queuePendingCounts)[number]) => {
		const metrics = buildTaskQueueMetrics(
			queue,
			pipelineConcurrencyByStage.get(queue.stageName),
		);
		return {
			...metrics,
			title: scanT(
				t,
				"scan.tasks.queueMetrics",
				"队列消息 {{queuedMessages}}，运行任务 {{runningTasks}} / {{limit}}，完成任务 {{completedTasks}}，已处理消息 {{processedMessages}}",
				{
					queuedMessages: metrics.queuedMessages,
					runningTasks: metrics.runningTasks,
					limit: metrics.concurrencyLimit,
					completedTasks: metrics.completedTasks,
					processedMessages: metrics.processedMessages,
				},
			),
		};
	};
	const sortedInProgressTasks = useMemo(() => {
		return [...(runningTasksData?.tasks || [])].sort((left, right) => {
			const stageRankDiff =
				(RUNNING_TASK_STAGE_ORDER[left.stage] ?? Number.MAX_SAFE_INTEGER) -
				(RUNNING_TASK_STAGE_ORDER[right.stage] ?? Number.MAX_SAFE_INTEGER);
			if (stageRankDiff !== 0) {
				return stageRankDiff;
			}
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	}, [runningTasksData?.tasks]);
	const runningStageOptions = useMemo(() => {
		const seen = new Set<string>();
		const addStage = (stage?: string | null) => {
			const option = normalizeTaskStageOption(stage);
			if (option) {
				seen.add(option);
			}
		};

		for (const queue of queuePendingCounts) {
			addStage(queue.stageName);
		}
		for (const task of sortedInProgressTasks) {
			addStage(task.stage);
		}

		return [...seen].sort(
			(left, right) =>
				(RUNNING_TASK_STAGE_ORDER[left] ?? Number.MAX_SAFE_INTEGER) -
				(RUNNING_TASK_STAGE_ORDER[right] ?? Number.MAX_SAFE_INTEGER),
		);
	}, [queuePendingCounts, sortedInProgressTasks]);
	const pipelineStageOptions = useMemo(
		() =>
			[...(jobPipeline?.nodes ?? [])]
				.filter((node) => Boolean(node.stageName))
				.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
				.map((node) => node.stageName),
		[jobPipeline?.nodes],
	);
	const filteredInProgressTasks = useMemo(() => {
		const query = searchInput.trim().toLowerCase();
		return sortedInProgressTasks.filter((task) => {
			if (runningStage !== "all" && task.stage !== runningStage) {
				return false;
			}
			if (!query) {
				return true;
			}
			return [
				task.title,
				task.subtitle || "",
				task.stage || "",
				getTaskStageLabel(t, task.stage),
				task.taskId,
			]
				.join("\n")
				.toLowerCase()
				.includes(query);
		});
	}, [sortedInProgressTasks, searchInput, runningStage, t]);
	const runningPagination = useMemo(() => {
		const pageSize = runningState.pageSize;
		const totalItems = filteredInProgressTasks.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
		const page = Math.min(Math.max(1, runningState.page), totalPages);
		const startIndex = (page - 1) * pageSize;
		return {
			page,
			pageSize,
			totalItems,
			items: filteredInProgressTasks.slice(
				startIndex,
				Math.min(totalItems, startIndex + pageSize),
			),
		};
	}, [filteredInProgressTasks, runningState.page, runningState.pageSize]);
	const finishedPagination = useMemo(() => {
		const totalItems = terminalTasks?.total ?? 0;
		const pageSize = terminalTasks?.pageSize ?? finishedState.pageSize;
		const totalPages =
			terminalTasks?.totalPages ??
			Math.max(1, Math.ceil(totalItems / pageSize));
		const page =
			terminalTasks?.page ??
			Math.min(Math.max(1, finishedState.page), totalPages);
		return {
			page,
			pageSize,
			totalItems,
			totalPages,
			items: terminalTasks?.items ?? [],
		};
	}, [finishedState.page, finishedState.pageSize, terminalTasks]);
	const currentPageRerunnableFinishedTaskIds = useMemo(
		() =>
			finishedPagination.items
				.filter((task) => RERUNNABLE_TASK_STATUSES.has(task.status))
				.map((task) => task.taskId),
		[finishedPagination.items],
	);
	const selectedCurrentPageFinishedTasks = useMemo(
		() =>
			finishedPagination.items.filter((task) =>
				selectedFinishedTaskIds.has(task.taskId),
			),
		[finishedPagination.items, selectedFinishedTaskIds],
	);
	const selectedFinishedTaskCount = selectedCurrentPageFinishedTasks.length;
	const hasCurrentPageRerunnableFinishedTasks =
		currentPageRerunnableFinishedTaskIds.length > 0;
	const areAllCurrentPageFinishedTasksSelected =
		hasCurrentPageRerunnableFinishedTasks &&
		currentPageRerunnableFinishedTaskIds.every((taskId) =>
			selectedFinishedTaskIds.has(taskId),
		);
	const areSomeCurrentPageFinishedTasksSelected =
		selectedFinishedTaskCount > 0 && !areAllCurrentPageFinishedTasksSelected;
	const hasFinishedTaskFilters =
		deferredQuery.trim().length > 0 ||
		finishedStage !== "all" ||
		finishedStatus !== "all";

	// Clamp the running page when tasks complete and the list shrinks.
	useEffect(() => {
		const totalPages = Math.max(
			1,
			Math.ceil(filteredInProgressTasks.length / runningState.pageSize),
		);
		if (runningState.page > totalPages) {
			setRunningState((previous) => ({ ...previous, page: totalPages }));
		}
	}, [
		filteredInProgressTasks.length,
		runningState.page,
		runningState.pageSize,
	]);

	// Clamp the finished page when the server echoes a clamped page back.
	useEffect(() => {
		const totalPages = Math.max(
			1,
			Math.ceil((terminalTasks?.total ?? 0) / finishedState.pageSize),
		);
		if (finishedState.page > totalPages) {
			setFinishedState((previous) => ({ ...previous, page: totalPages }));
		}
	}, [finishedState.page, finishedState.pageSize, terminalTasks?.total]);

	// Selection is page-scoped: prune ids that left the current page.
	useEffect(() => {
		const currentPageIds = new Set(currentPageRerunnableFinishedTaskIds);
		setSelectedFinishedTaskIds((current) => {
			let changed = false;
			const next = new Set<string>();
			for (const taskId of current) {
				if (currentPageIds.has(taskId)) {
					next.add(taskId);
				} else {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [currentPageRerunnableFinishedTaskIds]);

	// Drop a running stage chip if that stage left the in-progress set.
	useEffect(() => {
		if (runningStage !== "all" && !runningStageOptions.includes(runningStage)) {
			setRunningState((previous) => ({
				...previous,
				filters: { ...previous.filters, stage: [] },
				page: 1,
			}));
		}
	}, [runningStage, runningStageOptions]);

	// Finished stage chips come from the current pipeline, so only drop a
	// selection that is no longer a pipeline stage.
	useEffect(() => {
		if (
			finishedStage !== "all" &&
			!pipelineStageOptions.includes(finishedStage)
		) {
			setFinishedState((previous) => ({
				...previous,
				filters: { ...previous.filters, stage: [] },
				page: 1,
			}));
		}
	}, [finishedStage, pipelineStageOptions]);

	// Live runtime clock while tasks are running.
	useEffect(() => {
		if (
			sortedInProgressTasks.length === 0 &&
			scanJob?.status !== "running" &&
			scanJob?.status !== "pending"
		) {
			return;
		}
		const timer = window.setInterval(() => {
			setRuntimeNowMs(Date.now());
		}, 1000);
		return () => window.clearInterval(timer);
	}, [sortedInProgressTasks.length, scanJob?.status]);

	const handleSearchChange = (value: string) => {
		setSearchInput(value);
		setRunningState((previous) => ({ ...previous, query: value, page: 1 }));
		setFinishedState((previous) => ({ ...previous, query: value, page: 1 }));
	};

	const handleRerunTask = async (taskId: string) => {
		setRerunningTaskId(taskId);
		try {
			const result = await rerunTaskMutation.mutateAsync({ taskId });
			toast.success(
				scanT(t, "scan.task.rerunCreated", "Created rerun task {{id}}", {
					id: result.task.taskId,
				}),
			);
			await Promise.all([
				utils.scan.jobOverview.invalidate({ scanJobId }),
				utils.scan.jobRunningTasks.invalidate({ scanJobId }),
				utils.scan.jobQueueCounts.invalidate({ scanJobId }),
				utils.scan.terminalTasks.invalidate(),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(t, "scan.task.rerunError", "Failed to rerun task"),
			);
		} finally {
			setRerunningTaskId((current) => (current === taskId ? null : current));
		}
	};
	const handleCancelTask = async (taskId: string) => {
		setCancelingTaskId(taskId);
		try {
			await cancelTaskMutation.mutateAsync({ taskId });
			toast.success(scanT(t, "scan.task.cancelled", "Task canceled"));
			await Promise.all([
				utils.scan.jobOverview.invalidate({ scanJobId }),
				utils.scan.jobRunningTasks.invalidate({ scanJobId }),
				utils.scan.jobQueueCounts.invalidate({ scanJobId }),
				utils.scan.terminalTasks.invalidate(),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(t, "scan.task.cancelError", "Failed to cancel task"),
			);
		} finally {
			setCancelingTaskId((current) => (current === taskId ? null : current));
		}
	};

	const toggleFinishedTaskSelection = (taskId: string) => {
		setSelectedFinishedTaskIds((current) => {
			const next = new Set(current);
			if (next.has(taskId)) {
				next.delete(taskId);
			} else {
				next.add(taskId);
			}
			return next;
		});
	};

	const handleToggleFinishedPage = (
		pageIds: string[],
		allSelected: boolean,
	) => {
		setSelectedFinishedTaskIds((current) => {
			if (allSelected) {
				return new Set();
			}
			return new Set([...current, ...pageIds]);
		});
	};

	const handleRerunSelectedFinishedTasks = async () => {
		const taskIds = selectedCurrentPageFinishedTasks
			.filter((task) => RERUNNABLE_TASK_STATUSES.has(task.status))
			.map((task) => task.taskId);
		if (taskIds.length === 0) {
			return;
		}

		setBulkRerunningTaskIds(new Set(taskIds));
		let createdCount = 0;
		let failedCount = 0;
		let firstError: string | null = null;
		try {
			for (const taskId of taskIds) {
				try {
					await rerunTaskMutation.mutateAsync({ taskId });
					createdCount += 1;
				} catch (error) {
					failedCount += 1;
					firstError ??=
						error instanceof Error
							? error.message
							: scanT(t, "scan.task.rerunError", "Failed to rerun task");
				}
			}

			if (createdCount > 0) {
				setSelectedFinishedTaskIds(new Set());
			}
			if (failedCount > 0) {
				toast.error(
					scanT(
						t,
						"scan.task.bulkRerunPartialError",
						"Created {{created}} rerun tasks; {{failed}} failed. {{error}}",
						{
							created: createdCount,
							failed: failedCount,
							error: firstError || "",
						},
					),
				);
			} else {
				toast.success(
					scanT(
						t,
						"scan.task.bulkRerunCreated",
						"Created rerun tasks for {{count}} selected tasks",
						{ count: createdCount },
					),
				);
			}
			await Promise.all([
				utils.scan.jobOverview.invalidate({ scanJobId }),
				utils.scan.jobRunningTasks.invalidate({ scanJobId }),
				utils.scan.jobQueueCounts.invalidate({ scanJobId }),
				utils.scan.terminalTasks.invalidate(),
			]);
		} finally {
			setBulkRerunningTaskIds(new Set());
		}
	};

	const getRunningTaskTitle = (task: RunningTask) =>
		String(task.taskName || "").trim() ||
		localizeTaskListText(t, task.title) ||
		"-";
	const getRunningTaskSubtitle = (task: RunningTask) =>
		localizeTaskListText(t, task.subtitle) || "-";

	// Shared between the desktop table's actions column and the mobile cards.
	const renderRunningTaskActions = (task: RunningTask) => (
		<div className="flex items-center justify-end gap-1 sm:gap-1.5">
			<LiveTaskActivityButton
				taskId={task.taskId}
				title={getRunningTaskTitle(task)}
				subtitle={getRunningTaskSubtitle(task)}
				activity={activitiesByTaskId[task.taskId] || idleAgentActivity}
				variant="outline"
				size="icon"
				iconOnly
				className="h-7 w-7 rounded-md sm:h-8 sm:w-8"
			/>
			<Button
				type="button"
				variant="destructive"
				size="icon"
				className="h-7 w-7 rounded-md sm:h-8 sm:w-8"
				title={scanT(t, "scan.task.cancelTask", "Cancel running task")}
				aria-label={scanT(t, "scan.task.cancelTask", "Cancel running task")}
				disabled={
					cancelingTaskId === task.taskId || cancelTaskMutation.isLoading
				}
				onClick={() => void handleCancelTask(task.taskId)}
			>
				{cancelingTaskId === task.taskId ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<Ban className="size-4" />
				)}
			</Button>
		</div>
	);

	const renderFinishedTaskActions = (task: TerminalTask) => {
		const canRerunTask = RERUNNABLE_TASK_STATUSES.has(task.status);
		const isRerunningTask =
			rerunningTaskId === task.taskId || bulkRerunningTaskIds.has(task.taskId);
		return (
			<Button
				type="button"
				variant="outline"
				size="icon"
				title={
					canRerunTask
						? scanT(t, "scan.task.rerunTask", "重新运行阶段任务")
						: scanT(
								t,
								"scan.task.rerunDisabled",
								"阶段任务到达终态后才能重新运行",
							)
				}
				aria-label={
					canRerunTask
						? scanT(t, "scan.task.rerunTask", "重新运行阶段任务")
						: scanT(
								t,
								"scan.task.rerunDisabled",
								"阶段任务到达终态后才能重新运行",
							)
				}
				disabled={
					!canRerunTask || isRerunningTask || rerunTaskMutation.isLoading
				}
				onClick={() => void handleRerunTask(task.taskId)}
			>
				{isRerunningTask ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<RefreshCw className="size-4" />
				)}
			</Button>
		);
	};

	const runningFilters: CollectionFilter[] = [
		{
			key: "stage",
			label: scanT(t, "scan.field.stage", "阶段"),
			options: runningStageOptions.map((stage) => ({
				value: stage,
				label: getTaskStageLabel(t, stage),
			})),
		},
	];
	const finishedFilters: CollectionFilter[] = [
		...(pipelineStageOptions.length > 0
			? [
					{
						key: "stage",
						label: scanT(t, "scan.field.stage", "阶段"),
						options: pipelineStageOptions.map((stage) => ({
							value: stage,
							label: getTaskStageLabel(t, stage),
						})),
					} satisfies CollectionFilter,
				]
			: []),
		{
			key: "status",
			label: scanT(t, "scan.field.status", "状态"),
			options: TERMINAL_TASK_STATUS_OPTIONS.map((status) => ({
				value: status,
				label: getTaskStatusLabel(t, status),
			})),
		},
	];

	const runningColumns = [
		{
			id: "stage",
			header: scanT(t, "scan.field.stage", "阶段"),
			cell: ({ row }: { row: { original: RunningTask } }) => (
				<span
					className="whitespace-nowrap"
					title={getTaskStageLabel(t, row.original.stage)}
				>
					{getTaskStageShortLabel(t, row.original.stage)}
				</span>
			),
		},
		{
			id: "task",
			header: scanT(t, "scan.monitoring.task", "阶段任务"),
			cell: ({ row }: { row: { original: RunningTask } }) => (
				<Link
					href={taskHref(row.original.taskId)}
					className="line-clamp-2 font-medium hover:underline"
				>
					{getRunningTaskTitle(row.original)}
				</Link>
			),
		},
		{
			id: "runtime",
			header: scanT(t, "scan.field.runtime", "运行时长"),
			cell: ({ row }: { row: { original: RunningTask } }) => (
				<span className="whitespace-nowrap tabular-nums">
					{formatTaskRuntime(row.original.startedAt, runtimeNowMs)}
				</span>
			),
		},
		{
			id: "activity",
			header: scanT(t, "scan.tasks.currentActivity", "当前活动"),
			cell: ({ row }: { row: { original: RunningTask } }) => (
				<LiveTaskActivityBadge
					activity={
						activitiesByTaskId[row.original.taskId] || idleAgentActivity
					}
					isConnected={connectedTaskIds.has(row.original.taskId)}
					noWrap
				/>
			),
		},
		{
			id: "actions",
			header: scanT(t, "scan.tasks.actions", "操作"),
			cell: ({ row }: { row: { original: RunningTask } }) =>
				renderRunningTaskActions(row.original),
		},
	];

	const finishedColumns = [
		{
			id: "task",
			header: scanT(t, "scan.monitoring.task", "阶段任务"),
			cell: ({ row }: { row: { original: TerminalTask } }) => (
				<Link
					href={taskHref(row.original.taskId)}
					className="block min-w-[14rem] max-w-[30rem] truncate font-medium hover:underline"
					title={localizeTaskListText(t, row.original.title) || "-"}
				>
					{localizeTaskListText(t, row.original.title) || "-"}
				</Link>
			),
		},
		{
			id: "stage",
			header: scanT(t, "scan.field.stage", "阶段"),
			cell: ({ row }: { row: { original: TerminalTask } }) => (
				<span
					className="whitespace-nowrap capitalize"
					title={getTaskStageLabel(t, row.original.stage)}
				>
					{getTaskStageLabel(t, row.original.stage)}
				</span>
			),
		},
		{
			id: "startedAt",
			header: scanT(t, "scan.field.started", "开始时间"),
			cell: ({ row }: { row: { original: TerminalTask } }) =>
				row.original.startedAt ? (
					<span className="whitespace-nowrap text-xs text-muted-foreground">
						<DateTooltip date={row.original.startedAt} />
					</span>
				) : (
					"-"
				),
		},
		{
			id: "completedAt",
			header: scanT(t, "scan.field.completed", "完成时间"),
			cell: ({ row }: { row: { original: TerminalTask } }) =>
				row.original.completedAt ? (
					<span className="whitespace-nowrap text-xs text-muted-foreground">
						<DateTooltip date={row.original.completedAt} />
					</span>
				) : (
					"-"
				),
		},
		{
			id: "status",
			header: scanT(t, "scan.field.status", "状态"),
			cell: ({ row }: { row: { original: TerminalTask } }) => (
				<Badge
					variant="outline"
					className={getTaskStatusBadgeClassName(row.original.status)}
				>
					{getTaskStatusLabel(t, row.original.status)}
				</Badge>
			),
		},
		{
			id: "actions",
			header: scanT(t, "scan.tasks.actions", "操作"),
			cell: ({ row }: { row: { original: TerminalTask } }) =>
				renderFinishedTaskActions(row.original),
		},
	];

	const runningEmptyTitle = runningTasksError
		? scanT(t, "scan.tasks.runningLoadError", "加载运行中任务失败。")
		: sortedInProgressTasks.length === 0
			? scanT(t, "scan.tasks.noRunning", "暂无运行中阶段任务")
			: scanT(t, "scan.tasks.noMatching", "没有匹配的阶段任务");
	const finishedEmptyTitle =
		!terminalTasks || (terminalTasks.total === 0 && !hasFinishedTaskFilters)
			? scanT(t, "scan.tasks.noFinished", "暂无已完成阶段任务")
			: scanT(t, "scan.tasks.noMatching", "没有匹配的阶段任务");

	return (
		<div className="flex flex-col gap-4">
			<CollectionSection
				title={scanT(t, "scan.tasks.queues", "阶段任务队列")}
				description={scanT(
					t,
					"scan.tasks.queuesDescription",
					"每个 stage 的收件箱消息、正在运行的任务、已完成的任务，以及已经处理过的消息。",
				)}
			>
				<div className="overflow-x-auto">
					{queueCountsError ? (
						<div className="px-4 py-6 text-sm text-destructive">
							{scanT(t, "scan.tasks.queueLoadError", "加载队列状态失败。")}
						</div>
					) : !hasQueueRuntime ? (
						<div className="px-4 py-6 text-sm text-muted-foreground">
							{scanT(t, "scan.tasks.queueLoading", "正在加载队列状态...")}
						</div>
					) : queuePendingCounts.length === 0 ? (
						<div className="px-4 py-6 text-sm text-muted-foreground">
							{scanT(t, "scan.tasks.noQueues", "暂无阶段任务队列")}
						</div>
					) : (
						<table className="w-full min-w-[880px] table-fixed text-sm">
							<thead className="border-b bg-muted/30 text-left">
								<tr>
									<th className="w-[22%] px-4 py-3 font-medium">
										{scanT(t, "scan.tasks.queue", "队列")}
									</th>
									<th className="w-[18%] px-4 py-3 text-right font-medium">
										{scanT(t, "scan.tasks.queuedMessages", "队列中的消息")}
									</th>
									<th className="w-[24%] px-4 py-3 text-right font-medium">
										{scanT(t, "scan.tasks.runningTasks", "运行中的任务")}
									</th>
									<th className="w-[18%] px-4 py-3 text-right font-medium">
										{scanT(t, "scan.tasks.completedTasks", "完成的任务")}
									</th>
									<th className="w-[18%] px-4 py-3 text-right font-medium">
										{scanT(
											t,
											"scan.tasks.processedMessages",
											"已处理的消息",
										)}
									</th>
								</tr>
							</thead>
							<tbody>
								{queuePendingCounts.map((queue) => {
									const metrics = getQueueTaskMetrics(queue);
									return (
										<tr key={queue.id} className="border-b last:border-b-0">
											<td className="w-[22%] px-4 py-3 align-top font-medium">
												{formatScanStageLabel(
													t,
													queue.stageName || queue.title,
												)}
											</td>
											<td
												className="w-[18%] px-4 py-3 text-right align-top"
												title={metrics.title}
											>
												<span className="tabular-nums">
													{metrics.queuedMessages}
												</span>
											</td>
											<td
												className="w-[24%] px-4 py-3 text-right align-top"
												title={metrics.title}
											>
												<RunningCapacityBars
													running={metrics.runningTasks}
													limit={metrics.concurrencyLimit}
												/>
											</td>
											<td
												className="w-[18%] px-4 py-3 text-right align-top"
												title={metrics.title}
											>
												<span className="tabular-nums">
													{metrics.completedTasks}
												</span>
											</td>
											<td
												className="w-[18%] px-4 py-3 text-right align-top"
												title={metrics.title}
											>
												<span className="tabular-nums">
													{metrics.processedMessages}
												</span>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					)}
				</div>
			</CollectionSection>

			<CollectionSection
				title={scanT(t, "scan.tasks.running", "运行中阶段任务")}
				description={scanT(
					t,
					"scan.tasks.runningDescription",
					"此任务中所有运行中的扫描、分析和验证 agent。",
				)}
			>
				<CollectionView
					state={runningState}
					onStateChange={setRunningState}
					data={{
						items: runningPagination.items,
						total: runningPagination.totalItems,
					}}
					isLoading={!runningTasksData && !runningTasksError}
					searchValue={searchInput}
					onSearchValueChange={handleSearchChange}
					searchPlaceholder={scanT(t, "scan.tasks.search", "搜索阶段任务")}
					filters={runningFilters}
					columns={runningColumns}
					rowHeader={
						<div
							className={`${RUNNING_TASK_GRID_CLASS_NAME} hidden rounded-none px-4 py-0 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground sm:grid`}
							aria-hidden="true"
						>
							<span>{scanT(t, "scan.field.stage", "阶段")}</span>
							<span>{scanT(t, "scan.monitoring.task", "阶段任务")}</span>
							<span>{scanT(t, "scan.field.runtime", "运行时长")}</span>
							<span>
								{scanT(t, "scan.tasks.currentActivity", "当前活动")}
							</span>
							<span className="w-[4.375rem]" aria-hidden="true" />
						</div>
					}
					getRowId={(task) => task.id}
					getRowLabel={getRunningTaskTitle}
					emptyTitle={runningEmptyTitle}
					renderRow={(task) => (
						<RowListItem className={RUNNING_TASK_GRID_CLASS_NAME}>
							<span
								className="min-w-0 truncate text-xs text-muted-foreground"
								title={getTaskStageLabel(t, task.stage)}
							>
								{getTaskStageShortLabel(t, task.stage)}
							</span>
							<Link
								href={taskHref(task.taskId)}
								className="min-w-0 truncate font-medium hover:underline"
								title={getRunningTaskTitle(task)}
							>
								{getRunningTaskTitle(task)}
							</Link>
							<span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
								{formatTaskRuntime(task.startedAt, runtimeNowMs)}
							</span>
							<div className="min-w-0">
								<LiveTaskActivityBadge
									activity={
										activitiesByTaskId[task.taskId] || idleAgentActivity
									}
									isConnected={connectedTaskIds.has(task.taskId)}
									noWrap
								/>
							</div>
							<div className="min-w-0 justify-self-end">
								{renderRunningTaskActions(task)}
							</div>
						</RowListItem>
					)}
				/>
			</CollectionSection>

			<CollectionSection
				title={scanT(t, "scan.tasks.finished", "已完成阶段任务")}
				description={scanT(
					t,
					"scan.tasks.finishedDescription",
					"此任务中已完成、失败和已取消的阶段任务。",
				)}
			>
				<CollectionView
					state={finishedState}
					onStateChange={setFinishedState}
					data={{
						items: finishedPagination.items,
						total: finishedPagination.totalItems,
					}}
					isLoading={isLoadingTerminalTasks}
					isRefreshing={isFetchingTerminalTasks && Boolean(terminalTasks)}
					searchValue={searchInput}
					onSearchValueChange={handleSearchChange}
					searchPlaceholder={scanT(t, "scan.tasks.search", "搜索阶段任务")}
					toolbarChildren={
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Checkbox
								aria-label={scanT(
									t,
									"scan.tasks.selectAll",
									"Select all rerunnable tasks on this page",
								)}
								checked={
									areAllCurrentPageFinishedTasksSelected
										? true
										: areSomeCurrentPageFinishedTasksSelected
											? "indeterminate"
											: false
								}
								disabled={!hasCurrentPageRerunnableFinishedTasks}
								onCheckedChange={() =>
									handleToggleFinishedPage(
										currentPageRerunnableFinishedTaskIds,
										areAllCurrentPageFinishedTasksSelected,
									)
								}
							/>
							<span>{scanT(t, "scan.tasks.selectPage", "本页可重跑任务")}</span>
						</div>
					}
					filters={finishedFilters}
					columns={finishedColumns}
					tableCellClassName="!py-3"
					bulkActions={
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void handleRerunSelectedFinishedTasks()}
							disabled={
								rerunTaskMutation.isLoading || bulkRerunningTaskIds.size > 0
							}
						>
							{bulkRerunningTaskIds.size > 0 ? (
								<Loader2 className="mr-2 size-4 animate-spin" />
							) : (
								<RefreshCw className="mr-2 size-4" />
							)}
							{scanT(t, "scan.task.rerunSelected", "Rerun selected")}
						</Button>
					}
					selectedIds={selectedFinishedTaskIds}
					onToggleRow={toggleFinishedTaskSelection}
					onTogglePage={handleToggleFinishedPage}
					onClearSelection={() => setSelectedFinishedTaskIds(new Set())}
					getRowSelectable={(task) =>
						RERUNNABLE_TASK_STATUSES.has(task.status) &&
						bulkRerunningTaskIds.size === 0
					}
					getRowId={(task) => task.id}
					getRowLabel={(task) => localizeTaskListText(t, task.title) || "-"}
					emptyTitle={finishedEmptyTitle}
					mobileRender={(task) => (
						<RowListItem className="items-start sm:items-center">
							<div className="flex min-w-0 flex-1 items-start gap-3">
								<Checkbox
									aria-label={scanT(t, "scan.tasks.selectTask", "Select task")}
									checked={selectedFinishedTaskIds.has(task.taskId)}
									disabled={
										!RERUNNABLE_TASK_STATUSES.has(task.status) ||
										bulkRerunningTaskIds.size > 0
									}
									onCheckedChange={() =>
										toggleFinishedTaskSelection(task.taskId)
									}
								/>
								<div className="min-w-0 flex-1 space-y-1.5">
									<Link
										href={taskHref(task.taskId)}
										className="line-clamp-2 font-medium hover:underline"
									>
										{localizeTaskListText(t, task.title) || "-"}
									</Link>
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-xs capitalize text-muted-foreground">
											{getTaskStageLabel(t, task.stage)}
										</span>
										<Badge
											variant="outline"
											className={getTaskStatusBadgeClassName(task.status)}
										>
											{getTaskStatusLabel(t, task.status)}
										</Badge>
									</div>
									<div className="text-xs text-muted-foreground">
										{scanT(t, "scan.field.started", "开始时间")}:{" "}
										{task.startedAt ? (
											<DateTooltip date={task.startedAt} />
										) : (
											"-"
										)}
										{" · "}
										{scanT(t, "scan.field.completed", "完成时间")}:{" "}
										{task.completedAt ? (
											<DateTooltip date={task.completedAt} />
										) : (
											"-"
										)}
									</div>
								</div>
								<div className="shrink-0">
									{renderFinishedTaskActions(task)}
								</div>
							</div>
						</RowListItem>
					)}
				/>
			</CollectionSection>
		</div>
	);
};
