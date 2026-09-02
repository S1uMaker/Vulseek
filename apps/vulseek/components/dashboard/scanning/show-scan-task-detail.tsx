import { format } from "date-fns";
import {
	AlertCircle,
	Ban,
	ChevronRight,
	FileIcon,
	Folder,
	Loader2,
	RefreshCw,
} from "lucide-react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { type ReactNode, useEffect, useState } from "react";
import JsonView from "react18-json-view";
import { toast } from "sonner";
import { LiveTaskActivityButton } from "@/components/dashboard/scanning/live-task-activity";
import { ScanMonitoring } from "@/components/dashboard/scanning/scan-monitoring";
import { TaskSessionStream } from "@/components/dashboard/scanning/task-session-stream";
import {
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
} from "@/components/dashboard/ui-system";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { cachedInputPercent } from "@/lib/scan/token-usage";
import type { ScanNavigationContext } from "@/lib/ui-system/route-builders";
import { parseTabParam } from "@/lib/ui-system/tab-query";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import {
	formatScanStageLabel,
	formatScanStatusLabel,
	type ScanTranslation,
	scanT,
} from "./scan-i18n";

interface Props {
	serviceType?: "application" | "compose";
	routeSegment?: "profiles" | "services";
	/**
	 * Shared scan navigation context. Dataset task pages pass this instead of
	 * the project route params; breadcrumbs, back and sibling-task links then
	 * come from the context and service-specific logic is skipped.
	 */
	navigation?: ScanNavigationContext;
}

const ACTIVE_TASK_STATUSES = new Set([
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
]);
const RERUNNABLE_TASK_STATUSES = new Set(["completed", "failed", "exited"]);
const ROOT_DIRECTORY_KEY = "__root__";

type ScanTaskTab = "details" | "session" | "monitoring" | "files";
const TASK_TAB_VALUES = ["details", "session", "monitoring", "files"] as const;

type DirectoryListItem = {
	id: string;
	name: string;
	type: "file" | "directory";
	hasChildren?: boolean;
};

type DirectoryCacheEntry = {
	items: DirectoryListItem[];
	status: "idle" | "loading" | "loaded" | "error";
};

const getTaskStageLabel = (t: ScanTranslation, stage?: string | null) => {
	if (
		stage === "Delta Scope" ||
		stage === "delta-scope" ||
		stage === "delta-scope"
	) {
		return formatScanStageLabel(t, "delta-scope");
	}
	if (stage === "repository-profile") {
		return formatScanStageLabel(t, "repository-profile");
	}
	if (stage === "identify-target") {
		return formatScanStageLabel(t, "identify-target");
	}
	if (stage === "scan-target") {
		return formatScanStageLabel(t, "scan-target");
	}
	if (stage === "analyze-finding") {
		return formatScanStageLabel(t, "analyze-finding");
	}
	if (stage === "critique-finding") {
		return formatScanStageLabel(t, "critique-finding");
	}
	if (stage === "verify-finding") {
		return formatScanStageLabel(t, "verify-finding");
	}
	if (stage === "triage-finding") {
		return formatScanStageLabel(t, "triage-finding");
	}
	return formatScanStageLabel(t, stage);
};

const getTaskStatusLabel = (t: ScanTranslation, status?: string | null) => {
	if (!status) {
		return "-";
	}
	return formatScanStatusLabel(t, status);
};

const getTaskStatusBadgeClassName = (status?: string | null) => {
	if (status === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100";
	}
	if (status === "failed") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}
	if (
		status === "running" ||
		status === "starting" ||
		status === "launched" ||
		status === "launching"
	) {
		return "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/50 dark:text-sky-100";
	}
	if (status === "pending") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	if (status === "canceled") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	if (status === "exited") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const formatValue = (value?: string | number | null) => {
	if (value === null || value === undefined || value === "") {
		return "-";
	}
	return String(value);
};

const formatTokenUsage = (t: ScanTranslation, value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
		count: new Intl.NumberFormat().format(value),
	});
};

const formatTokenCount = (value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return new Intl.NumberFormat().format(value);
};

const formatTokenUsageWithCache = (
	t: ScanTranslation,
	total?: number | null,
	cached?: number | null,
) => {
	const totalValue = formatTokenCount(total);
	if (totalValue === "-") {
		return "-";
	}
	const cachedValue = formatTokenCount(cached);
	if (
		cachedValue === "-" ||
		typeof total !== "number" ||
		total <= 0 ||
		typeof cached !== "number" ||
		!Number.isFinite(cached)
	) {
		return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
			count: totalValue,
		});
	}
	const cachedPercent = cachedInputPercent(total, cached);
	if (cachedPercent === null) {
		return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
			count: totalValue,
		});
	}
	return scanT(
		t,
		"scan.cachedTokenUsage",
		"{{total}} / {{cached}} ({{percent}}% cached)",
		{
			total: totalValue,
			cached: cachedValue,
			percent: cachedPercent.toFixed(2),
		},
	);
};

const stringifyJson = (value: unknown) => {
	if (value === null || value === undefined) {
		return "";
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

const getJsonSummary = (value: unknown) => {
	if (Array.isArray(value)) {
		return `${value.length} item${value.length === 1 ? "" : "s"}`;
	}
	if (value && typeof value === "object") {
		const keyCount = Object.keys(value).length;
		return `${keyCount} key${keyCount === 1 ? "" : "s"}`;
	}
	return typeof value;
};

const formatDateTime = (value?: string | null) => {
	if (!value) {
		return "-";
	}
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		return value;
	}
	return format(date, "yyyy-MM-dd HH:mm:ss");
};

const DetailField = ({
	label,
	value,
	copyLabel,
	date,
	href,
	badgeClassName,
}: {
	label: string;
	value?: string | number | null;
	copyLabel?: string;
	date?: string | null;
	href?: string;
	badgeClassName?: string;
}) => {
	const displayValue = date ? formatDateTime(date) : formatValue(value);
	const content = badgeClassName ? (
		<Badge variant="outline" className={badgeClassName}>
			{displayValue}
		</Badge>
	) : href && displayValue !== "-" ? (
		<Link
			href={href}
			className="min-w-0 flex-1 cursor-pointer rounded-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{displayValue}
		</Link>
	) : (
		<span className="min-w-0 flex-1">{displayValue}</span>
	);
	return (
		<div
			className={cn(
				"rounded-lg border p-3 transition-colors",
				href && "hover:bg-muted/40",
			)}
		>
			<div className="text-sm text-muted-foreground">{label}</div>
			<div className="mt-1 flex min-h-5 items-start gap-2 break-all font-medium">
				{content}
				{displayValue !== "-" ? (
					<CopyValueButton
						value={displayValue}
						label={copyLabel || label}
						className="size-6 shrink-0"
					/>
				) : null}
			</div>
		</div>
	);
};

const DetailSection = ({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) => (
	<section className="rounded-lg border p-4">
		<div className="mb-4 text-lg font-semibold">{title}</div>
		{children}
	</section>
);

const JsonBlock = ({ label, value }: { label: string; value: unknown }) => {
	const json = stringifyJson(value);
	if (!json) {
		return null;
	}
	return (
		<div className="rounded-lg border">
			<div className="flex items-center justify-between gap-3 border-b px-3 py-2">
				<div className="min-w-0">
					<div className="text-sm font-medium">{label}</div>
					<div className="text-xs text-muted-foreground">
						{getJsonSummary(value)}
					</div>
				</div>
				<CopyValueButton
					value={json}
					label={label}
					className="size-7 shrink-0"
				/>
			</div>
			<div className="max-h-[420px] overflow-auto bg-muted/20 p-3 font-mono text-xs leading-5">
				<JsonView
					src={value}
					collapsed={false}
					displaySize="collapsed"
					enableClipboard={false}
				/>
			</div>
		</div>
	);
};

type LazyFileTreeProps = {
	rootItems: DirectoryListItem[];
	rootStatus: DirectoryCacheEntry["status"];
	expandedDirectories: Record<string, boolean>;
	selectedFilePath: string | null;
	directoryCache: Record<string, DirectoryCacheEntry>;
	onToggleDirectory: (directoryPath: string) => void;
	onSelectFile: (filePath: string) => void;
};

const LazyFileTree = ({
	rootItems,
	rootStatus,
	expandedDirectories,
	selectedFilePath,
	directoryCache,
	onToggleDirectory,
	onSelectFile,
}: LazyFileTreeProps) => {
	const { t } = useTranslation("scan");
	const renderItems = (items: DirectoryListItem[], depth = 0): ReactNode =>
		items.map((item) => {
			const isDirectory = item.type === "directory";
			const isExpanded = !!expandedDirectories[item.id];
			const cacheEntry = directoryCache[item.id];
			const childStatus = cacheEntry?.status || "idle";
			const childItems = cacheEntry?.items || [];

			return (
				<div key={item.id}>
					<button
						type="button"
						onClick={() =>
							isDirectory ? onToggleDirectory(item.id) : onSelectFile(item.id)
						}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
							!isDirectory && selectedFilePath === item.id
								? "bg-accent text-accent-foreground"
								: "hover:bg-muted/70",
						)}
						style={{ paddingLeft: `${depth * 14 + 10}px` }}
					>
						{isDirectory ? (
							<ChevronRight
								className={cn(
									"size-4 shrink-0 text-muted-foreground transition-transform",
									isExpanded && "rotate-90",
								)}
							/>
						) : (
							<span className="block size-4 shrink-0" />
						)}
						{isDirectory ? (
							<Folder className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<FileIcon className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 truncate font-mono text-sm">
							{item.name}
						</span>
					</button>
					{isDirectory && isExpanded ? (
						<div>
							{childStatus === "loading" ? (
								<div
									className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									<Loader2 className="size-4 animate-spin" />
									{scanT(t, "scan.files.loadingShort", "Loading...")}
								</div>
							) : childStatus === "error" ? (
								<div
									className="px-2 py-1.5 text-sm text-destructive"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									{scanT(
										t,
										"scan.files.directoryLoadError",
										"Failed to load directory",
									)}
								</div>
							) : childStatus === "loaded" && childItems.length === 0 ? (
								<div
									className="px-2 py-1.5 text-sm text-muted-foreground"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									{scanT(t, "scan.files.emptyDirectory", "Empty")}
								</div>
							) : (
								renderItems(childItems, depth + 1)
							)}
						</div>
					) : null}
				</div>
			);
		});

	if (rootStatus === "loading") {
		return (
			<div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				{scanT(t, "scan.files.loading", "Loading files...")}
			</div>
		);
	}

	if (rootStatus === "error") {
		return (
			<div className="flex h-full min-h-[320px] items-center justify-center text-destructive">
				{scanT(t, "scan.files.loadError", "Failed to load files")}
			</div>
		);
	}

	if (rootItems.length === 0) {
		return (
			<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 text-muted-foreground">
				<Folder className="size-6" />
				{scanT(t, "scan.files.empty", "No files available")}
			</div>
		);
	}

	return (
		<div className="h-[65vh] overflow-auto p-2">{renderItems(rootItems)}</div>
	);
};

export const ShowScanTaskDetail = ({
	serviceType,
	routeSegment,
	navigation,
}: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const utils = api.useUtils();
	const projectId =
		typeof router.query.projectId === "string" ? router.query.projectId : "";
	const environmentId =
		typeof router.query.environmentId === "string"
			? router.query.environmentId
			: "";
	const serviceId =
		typeof router.query.applicationId === "string"
			? router.query.applicationId
			: typeof router.query.composeId === "string"
				? router.query.composeId
				: "";
	const scanJobId =
		typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	const taskId =
		typeof router.query.taskId === "string" ? router.query.taskId : "";

	const jobTasksHref = navigation
		? `${navigation.jobHref(scanJobId)}?tab=tasks`
		: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}?tab=tasks`;

	const applicationServiceQuery = api.application.one.useQuery(
		{ applicationId: serviceId },
		{ enabled: serviceType === "application" && !!serviceId },
	);
	const composeServiceQuery = api.compose.one.useQuery(
		{ composeId: serviceId },
		{ enabled: serviceType === "compose" && !!serviceId },
	);
	const serviceData =
		serviceType === "application"
			? applicationServiceQuery.data
			: composeServiceQuery.data;

	const { data, isLoading, isError, error } = api.scan.task.useQuery(
		{ taskId, scanJobId },
		{
			enabled: !!taskId && !!scanJobId,
			refetchInterval: (result) =>
				result?.task.status && ACTIVE_TASK_STATUSES.has(result.task.status)
					? 2000
					: false,
		},
	);
	const rerunTaskMutation = api.scan.rerunTask.useMutation();
	const cancelTaskMutation = api.scan.cancelTask.useMutation();
	const [activeTab, setActiveTab] = useState<ScanTaskTab>("details");
	const requestedTab = parseTabParam(
		router.query,
		TASK_TAB_VALUES,
		"details",
	) as ScanTaskTab;

	useEffect(() => {
		if (requestedTab !== activeTab) setActiveTab(requestedTab);
	}, [activeTab, requestedTab]);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [expandedDirectories, setExpandedDirectories] = useState<
		Record<string, boolean>
	>({});
	const [directoryCache, setDirectoryCache] = useState<
		Record<string, DirectoryCacheEntry>
	>({});
	const rootDirectoryQuery = api.scan.listTaskDirectory.useQuery(
		{ scanJobId, taskId },
		{
			enabled: !!scanJobId && !!taskId && activeTab === "files",
			refetchInterval: activeTab === "files" ? 4000 : false,
		},
	);
	const { data: selectedFile, isLoading: isLoadingSelectedFile } =
		api.scan.readTaskFile.useQuery(
			{ scanJobId, taskId, filePath: selectedFilePath || "" },
			{ enabled: !!scanJobId && !!taskId && !!selectedFilePath },
		);

	const task = data?.task;
	const title =
		task?.name ||
		scanT(t, "scan.task.title", "Task {{id}}", { id: taskId.slice(0, 6) });
	const canRerunTask = task ? RERUNNABLE_TASK_STATUSES.has(task.status) : false;
	const canCancelTask = task ? ACTIVE_TASK_STATUSES.has(task.status) : false;
	const buildTaskHref = (targetTaskId?: string | null) =>
		targetTaskId
			? navigation
				? navigation.taskHref(scanJobId, targetTaskId)
				: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}/tasks/${encodeURIComponent(targetTaskId)}`
			: undefined;
	const handleRerunTask = async () => {
		if (!task) {
			return;
		}
		try {
			const result = await rerunTaskMutation.mutateAsync({
				taskId: task.taskId,
			});
			toast.success(`Created rerun task ${result.task.taskId}`);
			await Promise.all([
				utils.scan.task.invalidate({ taskId, scanJobId }),
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.jobOverview.invalidate({ scanJobId }),
				utils.scan.jobRunningTasks.invalidate({ scanJobId }),
				utils.scan.jobQueueCounts.invalidate({ scanJobId }),
				utils.scan.listTaskDirectory.invalidate({ taskId, scanJobId }),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to rerun task",
			);
		}
	};
	const handleCancelTask = async () => {
		if (!task || !canCancelTask) return;
		try {
			await cancelTaskMutation.mutateAsync({ taskId: task.taskId });
			toast.success(scanT(t, "scan.task.cancelled", "Task canceled"));
			await Promise.all([
				utils.scan.task.invalidate({ taskId, scanJobId }),
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.jobOverview.invalidate({ scanJobId }),
				utils.scan.jobRunningTasks.invalidate({ scanJobId }),
				utils.scan.jobQueueCounts.invalidate({ scanJobId }),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(t, "scan.task.cancelError", "Failed to cancel task"),
			);
		}
	};

	// Reset file navigation when either route identifier changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: route changes reset local file state.
	useEffect(() => {
		setSelectedFilePath(null);
		setExpandedDirectories({});
		setDirectoryCache({});
	}, [taskId, scanJobId]);

	useEffect(() => {
		if (activeTab !== "files") {
			return;
		}

		if (rootDirectoryQuery.isLoading) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: {
					items: current[ROOT_DIRECTORY_KEY]?.items || [],
					status: "loading",
				},
			}));
			return;
		}

		if (rootDirectoryQuery.isError) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: { items: [], status: "error" },
			}));
			setSelectedFilePath(null);
			return;
		}

		const items = rootDirectoryQuery.data || [];
		setDirectoryCache((current) => ({
			...current,
			[ROOT_DIRECTORY_KEY]: { items, status: "loaded" },
		}));

		if (!items.length) {
			setSelectedFilePath(null);
		}
	}, [
		activeTab,
		rootDirectoryQuery.data,
		rootDirectoryQuery.isError,
		rootDirectoryQuery.isLoading,
	]);

	const handleToggleDirectory = async (directoryPath: string) => {
		const nextExpanded = !expandedDirectories[directoryPath];
		setExpandedDirectories((current) => ({
			...current,
			[directoryPath]: nextExpanded,
		}));

		if (!nextExpanded) {
			return;
		}

		const existing = directoryCache[directoryPath];
		if (existing?.status === "loading" || existing?.status === "loaded") {
			return;
		}

		setDirectoryCache((current) => ({
			...current,
			[directoryPath]: {
				items: current[directoryPath]?.items || [],
				status: "loading",
			},
		}));

		try {
			const items = await utils.scan.listTaskDirectory.fetch({
				scanJobId,
				taskId,
				directoryPath,
			});
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items, status: "loaded" },
			}));
		} catch {
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items: [], status: "error" },
			}));
		}
	};

	return (
		<div className="pb-10">
			<BreadcrumbSidebar
				list={
					navigation
						? [
								...navigation.breadcrumbs.map((item) => ({
									name: item.label,
									href: item.href,
								})),
								{
									name: scanT(t, "scan.job.shortTitle", "Job {{id}}", {
										id: scanJobId.slice(0, 6),
									}),
									href: jobTasksHref,
								},
								{
									name: scanT(t, "scan.task.title", "Task {{id}}", {
										id: taskId.slice(0, 6),
									}),
								},
							]
						: [
								{
									name: scanT(t, "scan.breadcrumb.projects", "Projects"),
									href: "/dashboard/projects",
								},
								{ name: serviceData?.environment.project.name || "" },
								{
									name: serviceData?.environment.name || "",
									href: `/dashboard/project/${projectId}/environment/${environmentId}`,
								},
								{
									name: serviceData?.name || "",
									href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}`,
								},
								{
									name: scanT(t, "scan.job.shortTitle", "Job {{id}}", {
										id: scanJobId.slice(0, 6),
									}),
									href: jobTasksHref,
								},
								{
									name: scanT(t, "scan.task.title", "Task {{id}}", {
										id: taskId.slice(0, 6),
									}),
								},
							]
				}
			/>
			<Head>
				<title>
					{scanT(t, "scan.task.title", "Task {{id}}", {
						id: taskId.slice(0, 6),
					})}{" "}
					| Vulseek
				</title>
			</Head>

			<DashboardPage>
				<DashboardPageHeader
					title={title}
					description={
						<div className="flex min-w-0 items-center gap-2 break-all">
							<span>{taskId}</span>
							{taskId ? (
								<CopyValueButton
									value={taskId}
									label={scanT(t, "scan.field.taskId", "Task ID")}
									className="size-7 shrink-0"
								/>
							) : null}
						</div>
					}
					actions={
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							<LiveTaskActivityButton
								taskId={taskId}
								title={title}
								subtitle={task?.stageName || null}
								variant="outline"
							/>
							<Button
								type="button"
								variant="destructive"
								isLoading={cancelTaskMutation.isLoading}
								disabled={!canCancelTask || cancelTaskMutation.isLoading}
								title={scanT(t, "scan.task.cancelTask", "Cancel running task")}
								onClick={() => void handleCancelTask()}
							>
								<Ban className="mr-2 size-4" />
								{scanT(t, "scan.task.cancel", "Cancel")}
							</Button>
							<Button
								type="button"
								variant="outline"
								isLoading={rerunTaskMutation.isLoading}
								disabled={!canRerunTask || rerunTaskMutation.isLoading}
								title={
									canRerunTask
										? scanT(t, "scan.task.rerunTask", "重新运行阶段任务")
										: scanT(
												t,
												"scan.task.rerunDisabled",
												"阶段任务到达终态后才能重新运行",
											)
								}
								onClick={() => void handleRerunTask()}
							>
								<RefreshCw className="mr-2 size-4" />
								{scanT(t, "scan.task.rerun", "重新运行")}
							</Button>
						</div>
					}
				/>
				<DashboardPageTabs
					fallback="details"
					tabs={[
						{
							value: "details",
							label: scanT(t, "scan.task.tabs.details", "Details"),
						},
						{
							value: "session",
							label: scanT(t, "scan.task.tabs.session", "Session"),
						},
						{
							value: "monitoring",
							label: scanT(t, "scan.monitoring.title", "Monitoring"),
						},
						{ value: "files", label: scanT(t, "scan.files.title", "Files") },
					]}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						{isLoading ? (
							<div className="flex items-center gap-2 text-muted-foreground">
								<Loader2 className="size-4 animate-spin" />
								{scanT(t, "scan.task.loading", "Loading task...")}
							</div>
						) : isError ? (
							<div className="flex items-center gap-2 text-muted-foreground">
								<AlertCircle className="size-4" />
								{error?.message ||
									scanT(t, "scan.task.notFound", "Task not found")}
							</div>
						) : !task ? (
							<div className="flex items-center gap-2 text-muted-foreground">
								<AlertCircle className="size-4" />
								{scanT(t, "scan.task.notFound", "Task not found")}
							</div>
						) : (
							<Tabs
								value={activeTab}
								onValueChange={(value) => setActiveTab(value as ScanTaskTab)}
								className="w-full"
							>
								<TabsContent value="details" className="mt-0 pt-0">
									<div className="grid gap-6">
										<div className="flex flex-wrap items-center gap-2">
											<Badge
												variant="outline"
												className={getTaskStatusBadgeClassName(task.status)}
											>
												{getTaskStatusLabel(t, task.status)}
											</Badge>
											<Badge variant="outline">
												{getTaskStageLabel(t, task.stageName)}
											</Badge>
										</div>

										<DetailSection
											title={scanT(t, "scan.section.general", "General")}
										>
											<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
												<DetailField
													label={scanT(t, "scan.field.taskId", "Task ID")}
													value={task.taskId}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.scanJobId",
														"Scan Job ID",
													)}
													value={task.scanJobId}
													href={jobTasksHref}
												/>
												<DetailField
													label={scanT(t, "scan.field.name", "Name")}
													value={task.name}
												/>
												<DetailField
													label={scanT(t, "scan.field.stage", "Stage")}
													value={getTaskStageLabel(t, task.stageName)}
												/>
												<DetailField
													label={scanT(t, "scan.field.status", "Status")}
													value={getTaskStatusLabel(t, task.status)}
													badgeClassName={getTaskStatusBadgeClassName(
														task.status,
													)}
												/>
												<DetailField
													label={scanT(t, "scan.field.priority", "Priority")}
													value={task.priority}
												/>
												<DetailField
													label={scanT(t, "scan.field.attempt", "Attempt")}
													value={task.attempt}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.runtimeMode",
														"Runtime Mode",
													)}
													value={task.runtimeMode}
												/>
												<DetailField
													label={scanT(t, "scan.field.lifecycle", "Lifecycle")}
													value={task.lifecycle}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.sourceMessageId",
														"Source Message",
													)}
													value={task.sourceMessageId}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.sourceEdgeName",
														"Source Edge",
													)}
													value={task.sourceEdgeName}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.rerunOfTaskId",
														"Rerun Of Task ID",
													)}
													value={task.rerunOfTaskId}
													href={buildTaskHref(task.rerunOfTaskId)}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.forkedFromTaskId",
														"Forked From Task ID",
													)}
													value={task.forkedFromTaskId}
													href={buildTaskHref(task.forkedFromTaskId)}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.stageGroupInstanceId",
														"Stage Group Instance ID",
													)}
													value={task.stageGroupInstanceId}
												/>
												<DetailField
													label={scanT(t, "scan.field.threadId", "Thread ID")}
													value={task.threadId}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.containerName",
														"Container Name",
													)}
													value={task.containerName}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.sourceItemIndex",
														"Source Item Index",
													)}
													value={task.sourceItemIndex}
												/>
												<DetailField
													label={scanT(t, "scan.field.created", "Created")}
													value={task.createdAt}
													date={task.createdAt}
												/>
												<DetailField
													label={scanT(t, "scan.field.updated", "Updated")}
													value={task.updatedAt}
													date={task.updatedAt}
												/>
												<DetailField
													label={scanT(t, "scan.field.started", "Started")}
													value={task.startedAt}
													date={task.startedAt}
												/>
												<DetailField
													label={scanT(t, "scan.field.completed", "Completed")}
													value={task.completedAt}
													date={task.completedAt}
												/>
											</div>
										</DetailSection>

										<DetailSection
											title={scanT(t, "scan.section.usage", "Usage")}
										>
											<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
												<DetailField
													label={scanT(
														t,
														"scan.field.inputCacheRead",
														"Input Tokens / Cache Read",
													)}
													value={formatTokenUsageWithCache(
														t,
														task.inputTokens,
														task.cachedReadTokens,
													)}
													copyLabel={scanT(
														t,
														"scan.field.inputCacheRead",
														"Input Tokens / Cache Read",
													)}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.outputTokens",
														"Output Tokens",
													)}
													value={formatTokenUsage(t, task.outputTokens)}
													copyLabel={scanT(
														t,
														"scan.field.outputTokens",
														"Output Tokens",
													)}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.totalTokens",
														"Total Tokens",
													)}
													value={formatTokenUsage(t, task.totalTokens)}
													copyLabel={scanT(
														t,
														"scan.field.totalTokens",
														"Total Tokens",
													)}
												/>
												<DetailField
													label={scanT(
														t,
														"scan.field.thoughtTokens",
														"Thought Tokens",
													)}
													value={formatTokenUsage(t, task.thoughtTokens)}
													copyLabel={scanT(
														t,
														"scan.field.thoughtTokens",
														"Thought Tokens",
													)}
												/>
											</div>
										</DetailSection>

										{task.errorMessage ? (
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.errorMessage", "Error Message")}
												</div>
												<div className="mt-1 whitespace-pre-wrap break-words text-sm">
													{task.errorMessage}
												</div>
											</div>
										) : null}

										<DetailSection
											title={scanT(t, "scan.section.output", "Output")}
										>
											<div className="grid gap-4 xl:grid-cols-2">
												<JsonBlock
													label={scanT(
														t,
														"scan.field.agentProfile",
														"Agent Profile",
													)}
													value={task.agentProfile}
												/>
												<JsonBlock
													label={scanT(t, "scan.field.input", "Input")}
													value={data.reconstructedInput}
												/>
											</div>
											<div className="mt-4 space-y-3">
												<div className="text-sm font-medium">
													{scanT(t, "scan.section.messages", "Task Outputs")}
												</div>
												{(data.messages?.items ?? []).length === 0 ? (
													<div className="text-sm text-muted-foreground">
														{scanT(
															t,
															"scan.messages.empty",
															"No Messages yet",
														)}
													</div>
												) : (
													(data.messages?.items ?? []).map((item: {
														messageId: string;
														sequence: number;
														routeKey: string | null;
														status: string;
														createdAt: string;
														payload: unknown;
													}) => (
														<div
															key={item.messageId}
															className="rounded-lg border p-3"
														>
															<div className="mb-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
																<span>#{item.sequence}</span>
																<span>
																	{item.routeKey ??
																		scanT(t, "scan.messages.noRoute", "no route")}
																</span>
																<span>{item.status}</span>
																<span>{item.createdAt}</span>
															</div>
															<JsonBlock
																label={scanT(
																	t,
																	"scan.field.payload",
																	"Payload",
																)}
																value={item.payload}
															/>
														</div>
													))
												)}
											</div>
										</DetailSection>
									</div>
								</TabsContent>

								<TabsContent value="session" className="mt-0 pt-0">
									<TaskSessionStream key={task.taskId} taskId={task.taskId} />
								</TabsContent>

								<TabsContent value="monitoring" className="mt-0 pt-0">
									<ScanMonitoring
										mode="task"
										scanJobId={scanJobId}
										taskId={task.taskId}
									/>
								</TabsContent>

								<TabsContent value="files" className="mt-0 pt-0">
									<div className="rounded-lg border">
										<div className="border-b px-4 py-3">
											<div className="font-medium">
												{scanT(t, "scan.files.title", "Files")}
											</div>
											<div className="text-sm text-muted-foreground">
												{scanT(
													t,
													"scan.files.taskDescription",
													"Browse this task runtime directory.",
												)}
											</div>
										</div>
										<div className="grid min-h-[65vh] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
											<div className="border-b lg:border-b-0 lg:border-r">
												<LazyFileTree
													rootItems={
														directoryCache[ROOT_DIRECTORY_KEY]?.items || []
													}
													rootStatus={
														directoryCache[ROOT_DIRECTORY_KEY]?.status ||
														(rootDirectoryQuery.isLoading ? "loading" : "idle")
													}
													expandedDirectories={expandedDirectories}
													selectedFilePath={selectedFilePath}
													directoryCache={directoryCache}
													onToggleDirectory={handleToggleDirectory}
													onSelectFile={setSelectedFilePath}
												/>
											</div>

											<div className="min-w-0">
												<div className="border-b px-4 py-3">
													<div className="flex items-center gap-2 text-sm text-muted-foreground">
														<FileIcon className="size-4" />
														<span className="truncate">
															{selectedFile?.relativePath ||
																selectedFilePath ||
																scanT(
																	t,
																	"scan.files.noFileSelected",
																	"No file selected",
																)}
														</span>
													</div>
												</div>
												<div className="max-h-[calc(65vh-49px)] overflow-auto px-4 py-3">
													{!selectedFilePath ? (
														<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
															<FileIcon className="size-6" />
															{scanT(
																t,
																"scan.files.noFileSelected",
																"No file selected",
															)}
														</div>
													) : isLoadingSelectedFile ? (
														<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
															<Loader2 className="size-4 animate-spin" />
															{scanT(
																t,
																"scan.files.loadingFile",
																"Loading file...",
															)}
														</div>
													) : (
														<pre className="whitespace-pre-wrap break-words font-mono text-sm">
															{selectedFile?.content ||
																scanT(t, "scan.files.emptyFile", "(empty)")}
														</pre>
													)}
												</div>
											</div>
										</div>
									</div>
								</TabsContent>
							</Tabs>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</div>
	);
};
