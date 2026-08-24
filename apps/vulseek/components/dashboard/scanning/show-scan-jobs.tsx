import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import {
	CollectionSection,
	CollectionView,
	RowListItem,
	StatusBadge,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import type { ListQueryConfig } from "@/lib/ui-system/list-query";
import { api } from "@/utils/api";
import {
	formatResourceTypeLabel,
	formatScanJobStatusLabel,
	formatPipelineKindLabel,
	resolveScanJobPipelineKind,
	type ScanTranslation,
	scanT,
} from "./scan-i18n";

interface Props {
	id: string;
	type: "application" | "compose";
}

const JOBS_CONFIG: ListQueryConfig = {
	prefix: "jobs",
	sortOptions: [],
	filterKeys: ["status"],
	allowedFilterValues: { status: [] },
	defaultSortKey: "",
	defaultSortDirection: "desc",
	defaultPageSize: 20,
	pageSizes: [10, 20, 50],
};

const JOB_STATUS_OPTIONS = [
	{ value: "pending", label: "Pending" },
	{ value: "running", label: "Running" },
	{ value: "paused", label: "Paused" },
	{ value: "finalizing", label: "Finalizing" },
	{ value: "finished", label: "Finished" },
	{ value: "partially_finished", label: "Partially finished" },
	{ value: "failed", label: "Failed" },
	{ value: "canceled", label: "Canceled" },
];

const formatJobTitle = (job: { scanJobId: string }) =>
	`Scan Job (${job.scanJobId.slice(0, 6)})`;

const formatTriggerSource = (t: ScanTranslation, triggerSource: string) =>
	triggerSource === "schedule"
		? scanT(t, "scan.jobs.auto", "auto")
		: triggerSource === "manual"
			? scanT(t, "scan.jobs.manual", "manual")
			: triggerSource;

const formatTokenUsage = (t: ScanTranslation, value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
		count: new Intl.NumberFormat().format(value),
	});
};

export const ShowScanJobs = ({ id, type }: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const routeSegment = "profiles";
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, JOBS_CONFIG);

	const applicationQuery = api.scan.listByApplication.useQuery(
		{
			applicationId: id,
			page: state.page,
			pageSize: state.pageSize,
			search: deferredQuery || undefined,
			status: state.filters.status?.[0] as
				| "failed"
				| "pending"
				| "running"
				| "paused"
				| "canceled"
				| "finalizing"
				| "finished"
				| "partially_finished"
				| undefined,
		},
		{
			enabled: type === "application" && !!id,
			keepPreviousData: true,
			refetchInterval: 1000,
		},
	);
	const composeQuery = api.scan.listByCompose.useQuery(
		{
			composeId: id,
			page: state.page,
			pageSize: state.pageSize,
			search: deferredQuery || undefined,
			status: state.filters.status?.[0] as
				| "failed"
				| "pending"
				| "running"
				| "paused"
				| "canceled"
				| "finalizing"
				| "finished"
				| "partially_finished"
				| undefined,
		},
		{
			enabled: type === "compose" && !!id,
			keepPreviousData: true,
			refetchInterval: 1000,
		},
	);
	const query = type === "application" ? applicationQuery : composeQuery;
	const jobs = query.data;

	return (
		<CollectionSection
			title={scanT(t, "scan.jobs.title", "Jobs")}
			description={scanT(
				t,
				"scan.jobs.description",
				"See the scan job queue for this {{type}}",
				{ type: formatResourceTypeLabel(t, type) },
			)}
		>
			<CollectionView
				state={state}
				onStateChange={setState}
				data={{
					items: jobs?.items ?? [],
					total: jobs?.total ?? 0,
				}}
				isLoading={query.isLoading && !jobs}
					getRowId={(job) => job.scanJobId}
					getRowLabel={(job) => formatJobTitle(job)}
					onRowClick={(job) => {
						void router.push(
							"/dashboard/project/" +
								projectId +
								"/environment/" +
								environmentId +
								"/" +
								routeSegment +
								"/" +
								type +
								"/" +
								id +
								"/jobs/" +
								job.scanJobId,
						);
					}}
					searchValue={searchInput}
				onSearchValueChange={setSearchInput}
				searchPlaceholder={scanT(t, "scan.jobs.search", "Filter jobs...")}
				filters={[
					{
						key: "status",
						label: "Status",
						options: JOB_STATUS_OPTIONS,
					},
				]}
				emptyTitle={scanT(t, "scan.jobs.empty", "No jobs found")}
					emptyDescription={scanT(
						t,
						"scan.jobs.emptyDescription",
						"Create a scan to start monitoring pipeline runs for this {{type}}.",
						{ type: formatResourceTypeLabel(t, type) },
					)}
					columns={[
						{
							id: "job",
							header: "Job",
							cell: ({ row }) => (
								<Link
									href={
										"/dashboard/project/" +
										projectId +
										"/environment/" +
										environmentId +
										"/" +
										routeSegment +
										"/" +
										type +
										"/" +
										id +
										"/jobs/" +
										row.original.scanJobId
									}
									className="font-medium text-foreground hover:underline"
								>
									{formatJobTitle(row.original)}
								</Link>
							),
						},
						{
							id: "pipeline",
							header: "Scan Type",
							cell: ({ row }) => (
								<Badge
									variant="outline"
									className="h-5 border-border px-1.5 text-[11px] font-normal leading-none"
								>
									{formatPipelineKindLabel(
										t,
										resolveScanJobPipelineKind(row.original),
									)}
								</Badge>
							),
						},
						{
							id: "triggerSource",
							header: "Source",
							cell: ({ row }) =>
								formatTriggerSource(t, row.original.triggerSource),
						},
						{
							id: "tokens",
							header: "Tokens",
							cell: ({ row }) => formatTokenUsage(t, row.original.totalTokens),
						},
						{
							id: "createdAt",
							header: "Created",
							cell: ({ row }) => <DateTooltip date={row.original.createdAt} />,
						},
						{
							id: "status",
							header: "Status",
							cell: ({ row }) => (
								<StatusBadge
									value={row.original.status}
									label={formatScanJobStatusLabel(t, row.original.status)}
								/>
							),
						},
					]}
					mobileRender={(job) => (
					<RowListItem
						asChild
						className="group min-h-24 hover:bg-border"
					>
						<Link
							href={
								"/dashboard/project/" +
								projectId +
								"/environment/" +
								environmentId +
								"/" +
								routeSegment +
								"/" +
								type +
								"/" +
								id +
								"/jobs/" +
								job.scanJobId
							}
							className="min-w-0 flex-1 space-y-2 text-inherit no-underline"
							>
								<span className="block min-w-0 truncate text-sm font-medium leading-5 text-foreground sm:text-base">
									{formatJobTitle(job)}
								</span>
								<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground">
									<Badge
										variant="outline"
										className="h-5 border-border px-1.5 text-[11px] font-normal leading-none"
									>
										{formatPipelineKindLabel(
											t,
											resolveScanJobPipelineKind(job),
										)}
									</Badge>
									<span>{formatTriggerSource(t, job.triggerSource)}</span>
									<span className="opacity-30" aria-hidden>
										·
									</span>
									<span>{formatTokenUsage(t, job.totalTokens)}</span>
									<span className="opacity-30" aria-hidden>
										·
									</span>
									<span>
										<DateTooltip date={job.createdAt} />
									</span>
								</div>
								{job.description ? (
								<span className="line-clamp-2 break-all text-xs leading-5 text-muted-foreground">
									{job.description}
								</span>
							) : null}
							{job.note ? (
								<span className="line-clamp-1 break-all text-xs leading-5 text-foreground/80">
									{scanT(t, "scan.jobs.note", "Note: {{note}}", {
										note: job.note,
									})}
								</span>
							) : null}
							<StatusBadge
								value={job.status}
								label={formatScanJobStatusLabel(t, job.status)}
								className="h-5 shrink-0 self-start sm:self-auto"
							/>
						</Link>
						</RowListItem>
				)}
			/>
		</CollectionSection>
	);
};
