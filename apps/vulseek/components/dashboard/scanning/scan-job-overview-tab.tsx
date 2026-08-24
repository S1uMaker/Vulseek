import { AlertCircle, Loader2, Pause, Play } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ResultFlowChart } from "@/components/dashboard/scanning/scan-job-result-flow";
import {
	type ScanRuntimeSettingsDraft,
	ScanStageGraph,
} from "@/components/dashboard/scanning/scan-stage-graph";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";
import {
	formatPipelineKindLabel,
	resolveScanJobPipelineKind,
	scanT,
} from "./scan-i18n";
import {
	formatDurationSeconds,
	formatTokenCount,
	formatTokenUsage,
	formatTokenUsageWithCache,
	formatTriggerSourceLabel,
	getScanJobStatusClassName,
	getScanJobStatusLabel,
} from "./scan-job-detail-format";

type ScanJobOverviewTabProps = {
	scanJobId: string;
	serviceType?: "application" | "compose";
	serviceId?: string;
	isLoadingJob: boolean;
	scanJob: RouterOutputs["scan"]["jobOverview"] | undefined;
	queuePendingCounts: RouterOutputs["scan"]["jobQueueCounts"]["queues"];
	resultSummary: RouterOutputs["scan"]["resultSummary"] | undefined;
	isLoadingResultSummary: boolean;
	/** Invalidates every job view; shared with the shell/context controller. */
	refreshScanJobViews: () => Promise<void>;
};

/**
 * Overview tab for the shared scan job detail (Phase 4 split from
 * show-scan-job-detail): pause/resume/cancel actions, stage graph, results
 * flow, status/usage grid and the job note editor. Owns its action
 * mutations and the note draft; polling queries live in the page/context
 * controller.
 */
export const ScanJobOverviewTab = ({
	scanJobId,
	serviceType,
	serviceId,
	isLoadingJob,
	scanJob,
	queuePendingCounts,
	resultSummary,
	isLoadingResultSummary,
	refreshScanJobViews,
}: ScanJobOverviewTabProps) => {
	const { t } = useTranslation("scan");
	const utils = api.useUtils();
	const cancelScanJobMutation = api.scan.cancel.useMutation();
	const pauseScanJobMutation = api.scan.pause.useMutation();
	const resumeScanJobMutation = api.scan.resume.useMutation();
	const updateNoteMutation = api.scan.updateNote.useMutation();
	const [noteDraft, setNoteDraft] = useState("");

	useEffect(() => {
		setNoteDraft(scanJob?.note ?? "");
	}, [scanJob?.note]);

	const isNoteDirty = (scanJob?.note ?? "") !== noteDraft;
	const canPauseScanJob =
		scanJob?.status === "pending" || scanJob?.status === "running";
	const canResumeScanJob = scanJob?.status === "paused";
	const canCancelScanJob =
		scanJob?.status === "pending" ||
		scanJob?.status === "running" ||
		scanJob?.status === "paused";

	return (
		<>
			{isLoadingJob ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					{scanT(t, "scan.job.loading", "Loading job...")}
				</div>
			) : !scanJob ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<AlertCircle className="size-4" />
					{scanT(t, "scan.job.notFound", "Job not found")}
				</div>
			) : (
				<div className="flex flex-col gap-3">
					<div className="rounded-lg border p-4">
						<div className="mb-3 text-lg font-semibold">
							{scanT(t, "scan.actions.title", "Actions")}
						</div>
						{canPauseScanJob || canResumeScanJob || canCancelScanJob ? (
							<div className="flex flex-wrap gap-2">
								{canPauseScanJob ? (
									<Button
										type="button"
										variant="outline"
										disabled={pauseScanJobMutation.isLoading}
										onClick={async () => {
											try {
												const result = await pauseScanJobMutation.mutateAsync({
													scanJobId,
												});
												toast.success(
													scanT(
														t,
														"scan.job.pausedToast",
														"Paused job. Stopped {{count}} runtimes.",
														{ count: result.stoppedRuntimes },
													),
												);
												await refreshScanJobViews();
											} catch (error) {
												toast.error(
													error instanceof Error
														? error.message
														: scanT(
																t,
																"scan.job.pauseError",
																"Failed to pause scan job",
															),
												);
											}
										}}
									>
										{pauseScanJobMutation.isLoading ? (
											<>
												<Loader2 className="mr-2 size-4 animate-spin" />
												{scanT(t, "scan.job.pausing", "Pausing...")}
											</>
										) : (
											<>
												<Pause className="mr-2 size-4" />
												{scanT(t, "scan.job.pause", "Pause")}
											</>
										)}
									</Button>
								) : null}
								{canResumeScanJob ? (
									<Button
										type="button"
										variant="outline"
										disabled={resumeScanJobMutation.isLoading}
										onClick={async () => {
											try {
												await resumeScanJobMutation.mutateAsync({
													scanJobId,
												});
												toast.success(
													scanT(t, "scan.job.resumedToast", "Resumed job"),
												);
												await refreshScanJobViews();
											} catch (error) {
												toast.error(
													error instanceof Error
														? error.message
														: scanT(
																t,
																"scan.job.resumeError",
																"Failed to resume scan job",
															),
												);
											}
										}}
									>
										{resumeScanJobMutation.isLoading ? (
											<>
												<Loader2 className="mr-2 size-4 animate-spin" />
												{scanT(t, "scan.job.resuming", "Resuming...")}
											</>
										) : (
											<>
												<Play className="mr-2 size-4" />
												{scanT(t, "scan.job.resume", "Resume")}
											</>
										)}
									</Button>
								) : null}
								{canCancelScanJob ? (
									<Button
										type="button"
										variant="destructive"
										disabled={cancelScanJobMutation.isLoading}
										onClick={async () => {
											try {
												const result = await cancelScanJobMutation.mutateAsync({
													scanJobId,
												});
												toast.success(
													scanT(
														t,
														"scan.job.cancelledToast",
														"Cancelled job. Stopped {{count}} containers.",
														{ count: result.stoppedContainers },
													),
												);
												await refreshScanJobViews();
											} catch (error) {
												toast.error(
													error instanceof Error
														? error.message
														: scanT(
																t,
																"scan.job.cancelError",
																"Failed to cancel scan job",
															),
												);
											}
										}}
									>
										{cancelScanJobMutation.isLoading ? (
											<>
												<Loader2 className="mr-2 size-4 animate-spin" />
												{scanT(t, "scan.job.cancelling", "Cancelling...")}
											</>
										) : (
											scanT(t, "scan.dialog.cancel", "Cancel")
										)}
									</Button>
								) : null}
							</div>
						) : (
							<div className="text-sm text-muted-foreground">
								{scanT(
									t,
									"scan.job.noActions",
									"No actions available for this job status.",
								)}
							</div>
						)}
					</div>
					<ScanStageGraph
						scanJobId={scanJobId}
						queueCounts={queuePendingCounts}
						scanRuntimeSettings={
							scanJob?.scanRuntimeSettings as ScanRuntimeSettingsDraft | null
						}
					/>
					<Card className="bg-background">
						<CardHeader>
							<CardTitle className="text-xl">
								{scanT(t, "scan.results.title", "Results")}
							</CardTitle>
							<CardDescription>
								{scanT(
									t,
									"scan.results.description",
									"Latest candidate results across analysis, verification, and triage.",
								)}
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-4">
							<div className="rounded-lg border p-3">
								<div className="mb-3 flex items-center justify-between gap-3">
									<div>
										<div className="font-medium">
											{scanT(t, "scan.results.flowTitle", "Candidate Flow")}
										</div>
										<div className="text-sm text-muted-foreground">
											{scanT(
												t,
												"scan.results.flowDescription",
												"Sankey-style flow from positive analysis results through verification and triage.",
											)}
										</div>
									</div>
									{isLoadingResultSummary ? (
										<Loader2 className="size-4 animate-spin text-muted-foreground" />
									) : null}
								</div>
								<ResultFlowChart summary={resultSummary} t={t} />
							</div>
						</CardContent>
					</Card>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
						<div className="border rounded-lg p-3">
							<div className="text-sm text-muted-foreground">
								{scanT(t, "scan.field.status", "Status")}
							</div>
							<div
								className={`font-medium ${getScanJobStatusClassName(scanJob.status)}`}
							>
								{getScanJobStatusLabel(t, scanJob.status)}
							</div>
						</div>
						<div className="border rounded-lg p-3">
							<div className="text-sm text-muted-foreground">
								{scanT(t, "scan.field.pipeline", "Pipeline")}
							</div>
							<div className="font-medium">
								{scanJob.pipelineVersionId ? (
									<span className="text-primary">V3 pipeline run</span>
								) : (
									formatPipelineKindLabel(
										t,
										resolveScanJobPipelineKind(scanJob),
									)
								)}
							</div>
						</div>
						<div className="border rounded-lg p-3">
							<div className="text-sm text-muted-foreground">
								{scanT(t, "scan.field.trigger", "Trigger")}
							</div>
							<div className="font-medium">
								{formatTriggerSourceLabel(t, scanJob.triggerSource)}
							</div>
						</div>
						<div className="border rounded-lg p-3">
							<div className="text-sm text-muted-foreground">
								{scanT(t, "scan.field.duration", "Duration")}
							</div>
							<div className="font-medium tabular-nums">
								{formatDurationSeconds(
									resultSummary?.taskTimeline.coveredSeconds,
								)}
							</div>
						</div>
						<div className="border rounded-lg p-3 md:col-span-2">
							<div className="mb-3 text-sm font-medium">
								{scanT(t, "scan.section.usage", "Usage")}
							</div>
							<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
								<div>
									<div className="text-sm text-muted-foreground">
										{scanT(
											t,
											"scan.field.inputCacheRead",
											"Input Tokens / Cache Read",
										)}
									</div>
									<div className="font-medium">
										{formatTokenUsageWithCache(
											t,
											scanJob.inputTokens,
											scanJob.cachedReadTokens,
										)}
									</div>
								</div>
								<div>
									<div className="text-sm text-muted-foreground">
										{scanT(t, "scan.field.outputTokens", "Output Tokens")}
									</div>
									<div className="font-medium">
										{formatTokenCount(scanJob.outputTokens)}
									</div>
								</div>
								<div>
									<div className="text-sm text-muted-foreground">
										{scanT(t, "scan.field.totalTokens", "Total Tokens")}
									</div>
									<div className="font-medium">
										{formatTokenCount(scanJob.totalTokens)}
									</div>
								</div>
								<div>
									<div className="text-sm text-muted-foreground">
										{scanT(
											t,
											"scan.field.thoughtTokens",
											"Thought Tokens",
										)}
									</div>
									<div className="font-medium">
										{formatTokenUsage(t, scanJob.thoughtTokens)}
									</div>
								</div>
								{typeof scanJob.estimatedCost === "number" &&
								scanJob.estimatedCost > 0 ? (
									<div>
										<div className="text-sm text-muted-foreground">
											{scanT(t, "scan.field.estimatedCost", "Estimated Cost")}
										</div>
										<div className="font-medium">
											${scanJob.estimatedCost.toFixed(4)}
										</div>
									</div>
								) : null}
							</div>
						</div>
						{resolveScanJobPipelineKind(scanJob) === "delta" ? (
							<div className="border rounded-lg p-3">
								<div className="text-sm text-muted-foreground">
									{scanT(t, "scan.field.commitWindow", "Commit Window")}
								</div>
								<div className="font-medium">
									k={scanJob.commitWindow}
								</div>
							</div>
						) : null}
						<div className="border rounded-lg p-3">
							<div className="text-sm text-muted-foreground">
								{scanT(t, "scan.field.created", "Created")}
							</div>
							<div className="font-medium">
								<DateTooltip date={scanJob.createdAt} />
							</div>
						</div>
						<div className="border rounded-lg p-3">
							<div className="text-sm text-muted-foreground">
								{scanT(t, "scan.status.finished", "Finished")}
							</div>
							<div className="font-medium">
								{scanJob.finishedAt ? (
									<DateTooltip date={scanJob.finishedAt} />
								) : (
									"-"
								)}
							</div>
						</div>
						{scanJob.errorMessage && (
							<div className="border rounded-lg p-3 md:col-span-2">
								<div className="text-sm text-muted-foreground">
									{scanT(t, "scan.field.errorMessage", "Error")}
								</div>
								<div className="font-medium text-destructive break-all">
									{scanJob.errorMessage}
								</div>
							</div>
						)}
						<div className="border rounded-lg p-3 md:col-span-2">
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="text-sm text-muted-foreground">
										{scanT(t, "scan.candidate.note", "Note")}
									</div>
									<div className="text-xs text-muted-foreground">
										{scanT(
											t,
											"scan.job.noteDescription",
											"Internal note for this scan job",
										)}
									</div>
								</div>
								<Button
									type="button"
									size="sm"
									disabled={
										updateNoteMutation.isLoading ||
										!isNoteDirty ||
										!scanJob
									}
									onClick={async () => {
										try {
											await updateNoteMutation.mutateAsync({
												scanJobId,
												note: noteDraft,
											});
											toast.success(
												scanT(t, "scan.job.noteSaved", "Note saved"),
											);
											await Promise.all([
												utils.scan.jobOverview.invalidate({ scanJobId }),
												serviceType === "application"
													? utils.scan.listByApplication.invalidate({
															applicationId: serviceId,
														})
													: utils.scan.listByCompose.invalidate({
															composeId: serviceId,
														}),
											]);
										} catch (error) {
											toast.error(
												error instanceof Error
													? error.message
													: scanT(
															t,
															"scan.job.noteSaveError",
															"Failed to save note",
														),
											);
										}
									}}
								>
									{updateNoteMutation.isLoading ? (
										<>
											<Loader2 className="mr-2 size-4 animate-spin" />
											{scanT(t, "scan.common.saving", "Saving...")}
										</>
									) : (
										scanT(t, "scan.dialog.save", "Save")
									)}
								</Button>
							</div>
							<Textarea
								value={noteDraft}
								onChange={(event) => setNoteDraft(event.target.value)}
								placeholder={scanT(
									t,
									"scan.job.notePlaceholder",
									"Add a note for this scan job...",
								)}
								className="mt-3 min-h-[96px] resize-y"
							/>
						</div>
					</div>
				</div>
			)}
		</>
	);
};
