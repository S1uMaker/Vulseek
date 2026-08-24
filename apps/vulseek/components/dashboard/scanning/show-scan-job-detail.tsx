import Head from "next/head";
import { useTranslation } from "next-i18next";
import { DynamicJobTabRenderer } from "@/components/dashboard/scanning/dynamic-job-tab-renderer";
import { ScanJobFilesTab } from "@/components/dashboard/scanning/scan-job-files-tab";
import { ScanJobOverviewTab } from "@/components/dashboard/scanning/scan-job-overview-tab";
import { ScanJobTasksTab } from "@/components/dashboard/scanning/scan-job-tasks-tab";
import { ScanMonitoring } from "@/components/dashboard/scanning/scan-monitoring";

import {
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
} from "@/components/dashboard/ui-system";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { scanT } from "./scan-i18n";
import {
	type Props,
	ScanJobDetailProvider,
	useScanJobDetail,
} from "./scan-job-detail-context";

/**
 * Shared scan job detail shell (Phase 4). All query/URL controller state
 * lives in ScanJobDetailProvider; this component only composes the header,
 * tabs and per-tab components from context values.
 */
const ScanJobDetailShell = () => {
	const { t } = useTranslation("scan");
	const {
		projectId,
		environmentId,
		serviceId,
		scanJobId,
		serviceType,
		routeSegment,
		navigation,
		serviceData,
		activeTab,
		handleTabChange,
		jobTabs,
		unknownTab,
		isLoadingJob,
		scanJob,
		queuePendingCounts,
		resultSummary,
		isLoadingResultSummary,
		refreshScanJobViews,
		runningTasksData,
		runningTasksError,
		queueCountsData,
		queueCountsError,
		jobPipeline,
		buildTaskDetailHref,
		directoryCache,
		rootDirectoryLoading,
		expandedDirectories,
		selectedFilePath,
		onToggleDirectory,
		onSelectFile,
		selectedFile,
		isLoadingSelectedFile,
	} = useScanJobDetail();

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
								},
							]
				}
			/>
			<Head>
				<title>
					{scanT(t, "scan.job.title", "Scan Job {{id}}", {
						id: scanJobId.slice(0, 6),
					})}{" "}
					| Vulseek
				</title>
			</Head>

			<DashboardPage>
				<DashboardPageHeader
					title={scanT(t, "scan.job.title", "Scan Job {{id}}", {
						id: scanJobId.slice(0, 6),
					})}
					description={
						<div className="flex min-w-0 items-center gap-2 break-all">
							<span>{scanJobId}</span>
							<CopyValueButton
								value={scanJobId}
								label={scanT(t, "scan.field.jobId", "Job ID")}
								className="size-7 shrink-0"
							/>
						</div>
					}
				/>
				<DashboardPageTabs
					fallback="overview"
					tabs={[
						{
							value: "overview",
							label: scanT(t, "scan.job.tabs.overview", "Overview"),
						},
						{
							value: "tasks",
							label: scanT(t, "scan.job.tabs.tasks", "阶段任务"),
						},
						...jobTabs.map((tab) => ({
							value: tab.id,
							label: tab.label,
						})),
						{
							value: "monitoring",
							label: scanT(t, "scan.monitoring.title", "Monitoring"),
						},
						{ value: "files", label: scanT(t, "scan.files.title", "Files") },
					]}
				onTabChange={handleTabChange}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						<Tabs
							value={activeTab}
							onValueChange={handleTabChange}
							className="w-full"
						>
							{unknownTab ? (
								<p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800">
									This tab is not configured on the job snapshot. Showing Overview.
								</p>
							) : null}
							<TabsContent value="overview" className="mt-0 pt-0">
								<ScanJobOverviewTab
									scanJobId={scanJobId}
									serviceType={serviceType}
									serviceId={serviceId}
									isLoadingJob={isLoadingJob}
									scanJob={scanJob}
									queuePendingCounts={queuePendingCounts}
									resultSummary={resultSummary}
									isLoadingResultSummary={isLoadingResultSummary}
									refreshScanJobViews={refreshScanJobViews}
								/>
							</TabsContent>

							<TabsContent value="tasks" className="mt-0 pt-0">
								<ScanJobTasksTab
									scanJobId={scanJobId}
									scanJob={scanJob}
									runningTasksData={runningTasksData}
									runningTasksError={runningTasksError}
									queueCountsData={queueCountsData}
									queueCountsError={queueCountsError}
									jobPipeline={jobPipeline}
									taskHref={buildTaskDetailHref}
								/>
							</TabsContent>

							{jobTabs.map((tab) => (
								<TabsContent
									key={tab.id}
									value={tab.id}
									className="mt-0 rounded-xl border bg-card p-4 sm:p-6"
								>
									<DynamicJobTabRenderer tab={tab} />
								</TabsContent>
							))}

							<TabsContent value="monitoring" className="mt-0 pt-0">
								<ScanMonitoring mode="job" scanJobId={scanJobId} />
							</TabsContent>

							<TabsContent value="files" className="mt-0 pt-0">
								<ScanJobFilesTab
									scanJobId={scanJobId}
									directoryCache={directoryCache}
									rootDirectoryLoading={rootDirectoryLoading}
									expandedDirectories={expandedDirectories}
									selectedFilePath={selectedFilePath}
									onToggleDirectory={onToggleDirectory}
									onSelectFile={onSelectFile}
									selectedFile={selectedFile}
									isLoadingSelectedFile={isLoadingSelectedFile}
								/>
							</TabsContent>
						</Tabs>
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</div>
	);
};
export const ShowScanJobDetail = (props: Props) => (
	<ScanJobDetailProvider {...props}>
		<ScanJobDetailShell />
	</ScanJobDetailProvider>
);
