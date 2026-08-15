import {
	CheckCircle2,
	Circle,
	Database,
	Loader2,
	Play,
	RefreshCw,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { FormEvent, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	CollectionSection,
	CollectionView,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
	RowList,
	RowListItem,
	StatusBadge,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import type { ListQueryStateSetter } from "@/components/dashboard/ui-system/use-collection-query";
import { CheckoutLogModal } from "@/components/dashboard/scanning/checkout-log-modal";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type {
	ListQueryConfig,
	ListQueryState,
} from "@/lib/ui-system/list-query";
import { api } from "@/utils/api";

const PROFILE_EVALUATIONS_CONFIG: ListQueryConfig = {
	prefix: "evaluations",
	sortOptions: [],
	filterKeys: [],
	defaultSortKey: "",
	defaultPageSize: 20,
	pageSizes: [10, 20, 50],
};

const PROFILE_STATUS_LABEL = (status: string) =>
	status
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

const CHECKOUT_STAGES = [
	{ phase: "validating_source", label: "Validate local dataset" },
	{ phase: "checking_tools", label: "Check shared tools image" },
	{ phase: "reading_manifest", label: "Read and validate samples" },
	{ phase: "saving_profile", label: "Save profile and tools image reference" },
] as const;

const ProfileDetailPage = () => {
	const router = useRouter();
	const datasetId =
		typeof router.query.datasetId === "string" ? router.query.datasetId : "";
	const profileId =
		typeof router.query.profileId === "string" ? router.query.profileId : "";
	const profile = api.dataset.profiles.one.useQuery(
		{ profileId },
		{ enabled: Boolean(profileId) },
	);
	const { state: evaluationState, setState: setEvaluationState } =
		useCollectionQuery(router, PROFILE_EVALUATIONS_CONFIG);
	const evaluationsTab = router.query.tab === "evaluations";
	const evaluationList = api.dataset.evaluations.list.useQuery(
		{
			profileId,
			page: evaluationState.page,
			pageSize: evaluationState.pageSize,
		},
		{
			enabled: Boolean(profileId) && evaluationsTab,
			keepPreviousData: true,
		},
	);
	const samplesEnabled = profile.data?.status === "ready";
	const [sampleSearch, setSampleSearch] = useState("");
	const [samplePage, setSamplePage] = useState(1);
	const [selectedSampleIds, setSelectedSampleIds] = useState<string[]>([]);
	const [hostRoot, setHostRoot] = useState("");
	const samplePageSize = 20;
	const samples = api.dataset.samples.list.useQuery(
		{
			profileId,
			page: samplePage,
			pageSize: samplePageSize,
			search: sampleSearch || undefined,
		},
		{ enabled: samplesEnabled },
	);
	const updateSelectedSamples =
		api.dataset.profiles.updateSelectedSamples.useMutation();
	const updateHostRoot = api.dataset.profiles.updateHostRoot.useMutation();
	const checkout = api.dataset.profiles.checkout.useMutation();
	const rebuildTools = api.scan.rebuildCheckoutTools.useMutation();
	const [toolsBuildId, setToolsBuildId] = useState<string | null>(null);
	const [toolsLogOpen, setToolsLogOpen] = useState(false);
	const { data: toolsStatus, refetch: refetchToolsStatus } =
		api.scan.checkoutToolsStatus.useQuery(undefined, {
			refetchInterval: (value) => (value?.state === "building" ? 1800 : false),
		});
	const activeToolsBuildId = toolsBuildId || toolsStatus?.activeBuildId || null;
	const { data: toolsBuildStatus } = api.scan.checkoutToolsBuildStatus.useQuery(
		{ buildId: activeToolsBuildId || "" },
		{
			enabled: Boolean(activeToolsBuildId),
			refetchInterval: (value) => (value?.status === "running" ? 1500 : false),
		},
	);
	const [checkoutDialogOpen, setCheckoutDialogOpen] = useState(false);
	const [checkoutId, setCheckoutId] = useState<string | null>(null);
	const [checkoutFinalized, setCheckoutFinalized] = useState(true);
	const [checkoutStartError, setCheckoutStartError] = useState<string | null>(null);
	const handledCheckoutRef = useRef<string | null>(null);
	const { data: checkoutStatus } = api.dataset.profiles.checkoutStatus.useQuery(
		{ checkoutId: checkoutId ?? "" },
		{
			enabled: Boolean(checkoutId),
			refetchInterval: checkoutId && !checkoutFinalized ? 800 : false,
		},
	);
	const createEvaluation = api.dataset.evaluations.create.useMutation();
	const [evaluationName, setEvaluationName] = useState("Evaluation");
	const [pipelineId, setPipelineId] = useState("");
	const [pipelineProfileId, setPipelineProfileId] = useState("");
	const pipelineOptions = api.pipeline.publishedOptions.useQuery({
		targetType: "evaluation",
	});
	const pipelineProfiles = api.pipeline.profilesList.useQuery(
		{ pipelineId },
		{ enabled: Boolean(pipelineId) },
	);
	const [repetitions, setRepetitions] = useState(1);
	const [timeBudgetSeconds, setTimeBudgetSeconds] = useState("");
	const toolsBuildNotifiedRef = useRef<string | null>(null);

	useEffect(() => {
		if (!toolsBuildStatus || toolsBuildStatus.status === "running") return;
		if (toolsBuildNotifiedRef.current === toolsBuildStatus.buildId) return;
		toolsBuildNotifiedRef.current = toolsBuildStatus.buildId;
		void refetchToolsStatus();
		if (toolsBuildStatus.status === "completed") {
			toast.success("Tools image built successfully");
		} else {
			toast.error(toolsBuildStatus.errorMessage || "Tools image build failed");
		}
	}, [refetchToolsStatus, toolsBuildStatus]);
	useEffect(() => {
		if (profile.data?.profileId !== profileId) return;
		setSelectedSampleIds(profile.data.selectedSampleIds);
		setHostRoot(profile.data.hostRoot);
	}, [
		profile.data?.hostRoot,
		profile.data?.profileId,
		profile.data?.selectedSampleIds,
		profileId,
	]);
	// Reset pagination whenever the search input changes intentionally.
	// biome-ignore lint/correctness/useExhaustiveDependencies: search changes reset pagination.
	useEffect(() => {
		setSamplePage(1);
	}, [sampleSearch]);
	useEffect(() => {
		if (pipelineId || !pipelineOptions.data?.length) return;
		const preferred =
			pipelineOptions.data.find((pipeline) => pipeline.systemKey === "research") ??
			pipelineOptions.data[0];
		setPipelineId(preferred?.pipelineId ?? "");
	}, [pipelineId, pipelineOptions.data]);

	const toggleSample = (sampleId: string) => {
		setSelectedSampleIds((current) =>
			current.includes(sampleId)
				? current.filter((id) => id !== sampleId)
				: [...current, sampleId],
		);
	};
	const pageSampleIds = samples.data?.items.map((sample) => sample.id) ?? [];
	const allCurrentPageSelected =
		pageSampleIds.length > 0 &&
		pageSampleIds.every((id) => selectedSampleIds.includes(id));
	const toggleSamplesOnPage = () => {
		setSelectedSampleIds((current) =>
			allCurrentPageSelected
				? current.filter((id) => !pageSampleIds.includes(id))
				: Array.from(new Set([...current, ...pageSampleIds])),
		);
	};
	const saveSelection = async () => {
		try {
			const result = await updateSelectedSamples.mutateAsync({
				profileId,
				sampleIds: selectedSampleIds,
			});
			setSelectedSampleIds(result.selectedSampleIds);
			await profile.refetch();
			toast.success("Sample selection saved");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to save sample selection",
			);
		}
	};
	const saveHostRoot = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		try {
			const result = await updateHostRoot.mutateAsync({
				profileId,
				hostRoot: hostRoot.trim(),
			});
			setHostRoot(result.hostRoot);
			await profile.refetch();
			toast.success("Local path saved");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to save local path",
			);
		}
	};
	const recheckout = async () => {
		setCheckoutDialogOpen(true);
		setCheckoutId(null);
		setCheckoutFinalized(false);
		setCheckoutStartError(null);
		try {
			const result = await checkout.mutateAsync({ profileId });
			setCheckoutId(result.checkoutId);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Checkout failed";
			setCheckoutFinalized(true);
			setCheckoutStartError(message);
			toast.error(message);
		}
	};
	const buildTools = async () => {
		try {
			const build = await rebuildTools.mutateAsync();
			setToolsBuildId(build.buildId);
			setToolsLogOpen(true);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to build tools image");
		}
	};

	useEffect(() => {
		if (
			!checkoutStatus ||
			checkoutStatus.status === "running" ||
			handledCheckoutRef.current === checkoutStatus.checkoutId
		)
			return;
		handledCheckoutRef.current = checkoutStatus.checkoutId;
		setCheckoutFinalized(true);
		if (checkoutStatus.status === "completed") {
			void (async () => {
				const refreshed = await profile.refetch();
				setSelectedSampleIds(refreshed.data?.selectedSampleIds ?? []);
				await samples.refetch();
				toast.success("Profile checkout completed");
			})();
		} else {
			toast.error(checkoutStatus.errorMessage || "Checkout failed");
		}
	}, [checkoutStatus, profile.refetch, samples.refetch]);
	const submitEvaluation = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!profile.data || selectedSampleIds.length === 0) return;
		try {
			await createEvaluation.mutateAsync({
				datasetId,
				profileId,
				name: evaluationName,
				pipelineId,
				pipelineProfileId: pipelineProfileId || null,
				sampleIds: selectedSampleIds,
				repetitions,
				timeBudgetSeconds: timeBudgetSeconds ? Number(timeBudgetSeconds) : null,
				scanRuntimeSettings: {},
			});
			await profile.refetch();
			toast.success("Evaluation queued");
			void router.replace(
				{ query: { ...router.query, tab: "evaluations" } },
				undefined,
				{ shallow: true },
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to create evaluation",
			);
		}
	};

	if (profile.isLoading) {
		return (
			<div className="flex min-h-96 items-center justify-center">
				<Loader2 className="animate-spin" />
			</div>
		);
	}
	if (!profile.data)
		return <div className="p-8 text-center">Dataset profile not found.</div>;
	const data = profile.data;
	const totalPages = Math.max(
		1,
		Math.ceil((samples.data?.total ?? 0) / samplePageSize),
	);
	const checkoutIsRunning =
		!checkoutFinalized || checkout.isLoading;
	const checkoutIsCompleted =
		Boolean(checkoutId) && checkoutStatus?.status === "completed";
	const checkoutIsFailed =
		Boolean(checkoutStartError) ||
		(Boolean(checkoutId) && checkoutStatus?.status === "failed");
	const checkoutStageIndex = checkoutIsCompleted
		? CHECKOUT_STAGES.length
		: Math.max(
				0,
				CHECKOUT_STAGES.findIndex(
					(stage) =>
						stage.phase === (checkoutId ? checkoutStatus?.phase : undefined),
				),
			);
	const manifestProgress = checkoutId ? checkoutStatus?.manifestProgress : null;
	const manifestPercent = manifestProgress?.total
		? Math.round((manifestProgress.current / manifestProgress.total) * 100)
		: 0;

	return (
		<>
			<BreadcrumbSidebar
				list={[
					{ name: "Datasets", href: "/dashboard/datasets" },
					{
						name: data.datasetName,
						href: `/dashboard/datasets/${datasetId}`,
					},
					{ name: data.profileKey },
				]}
			/>
			<DashboardPage>
				<DashboardPageHeader
					icon={<Database />}
					title={data.profileKey}
					description={
						<span className="flex min-w-0 items-center gap-2 break-all">
							<span className="shrink-0 font-mono text-xs">
								{data.profileId}
							</span>
							<CopyValueButton
								value={data.profileId}
								label="Dataset Profile ID"
								className="size-7 shrink-0"
							/>
							<span className="truncate">
								{data.datasetName} ·{" "}
								{data.hostRootSummary || "Local path not configured"}
							</span>
						</span>
					}
					status={
						<StatusBadge
							value={data.status}
							label={PROFILE_STATUS_LABEL(data.status)}
						/>
					}
					actions={
						data.canManage ? (
							<Button
								variant="outline"
								onClick={recheckout}
								disabled={checkoutIsRunning || !data.hostRoot.trim()}
							>
								{checkoutIsRunning ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<RefreshCw className="size-4" />
								)}
								{data.status === "ready" ? "Re-checkout" : "Checkout"}
							</Button>
						) : undefined
					}
				/>
				<DashboardPageTabs
					fallback="overview"
					tabs={[
						{ value: "overview", label: "Overview" },
						{ value: "evaluations", label: "Evaluations" },
					]}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						{evaluationsTab ? (
							<CollectionSection
								title="Evaluations"
								description="Evaluation runs created from this Profile."
							>
								<ProfileEvaluationsTable
									state={evaluationState}
									onStateChange={setEvaluationState}
									data={evaluationList.data}
									isLoading={evaluationList.isLoading}
									isRefreshing={evaluationList.isFetching}
								/>
							</CollectionSection>
						) : (
							<div className="flex flex-col gap-4">
								<Card>
									<CardHeader>
										<CardTitle>New Evaluation</CardTitle>
										<CardDescription>
											Run the selected pipeline sequentially over the saved
											sample selection.
										</CardDescription>
									</CardHeader>
									<CardContent>
									<form
										onSubmit={submitEvaluation}
										className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
									>
										<label className="grid gap-2 text-sm font-medium">
											Evaluation name
											<Input
												value={evaluationName}
												onChange={(event) =>
													setEvaluationName(event.target.value)
												}
												placeholder="Evaluation name"
												required
											/>
										</label>
										<label className="grid gap-2 text-sm font-medium">
											Pipeline
											<select
												className="h-10 rounded-md border bg-background px-3"
												value={pipelineId}
												onChange={(event) => {
													setPipelineId(event.target.value);
													setPipelineProfileId("");
												}}
												disabled={pipelineOptions.isLoading}
												required
											>
												<option value="" disabled>
													Select pipeline
												</option>
												{pipelineOptions.data?.map((pipeline) => (
													<option
														key={pipeline.pipelineId}
														value={pipeline.pipelineId}
													>
														{pipeline.name} · v{pipeline.currentVersionNumber}
													</option>
												))}
											</select>
										</label>
										<label className="grid gap-2 text-sm font-medium">
											Pipeline profile
											<select
												className="h-10 rounded-md border bg-background px-3"
												value={pipelineProfileId}
												onChange={(event) =>
													setPipelineProfileId(event.target.value)
												}
												disabled={!pipelineId || pipelineProfiles.isLoading}
											>
												<option value="">Default pipeline settings</option>
												{pipelineProfiles.data?.map((pipelineProfile) => (
													<option
														key={pipelineProfile.pipelineProfileId}
														value={pipelineProfile.pipelineProfileId}
													>
														{pipelineProfile.name}
													</option>
												))}
											</select>
										</label>
										<label className="grid gap-2 text-sm font-medium">
											Repetitions
											<Input
												type="number"
												min={1}
												max={100}
												value={repetitions}
												onChange={(event) =>
													setRepetitions(Number(event.target.value))
												}
											/>
										</label>
										<label className="grid gap-2 text-sm font-medium">
											Time budget (seconds)
											<Input
												type="number"
												min={1}
												max={86400}
												value={timeBudgetSeconds}
												onChange={(event) =>
													setTimeBudgetSeconds(event.target.value)
												}
												placeholder="Optional"
											/>
										</label>
										<Button
											type="submit"
											className="md:col-span-2 md:justify-self-start lg:col-span-3"
											disabled={
												!data.canManage ||
												data.status !== "ready" ||
												selectedSampleIds.length === 0 ||
												!data.toolsImageAvailable ||
												!pipelineId ||
														createEvaluation.isLoading
											}
											>
												<Play className="size-4" />
												Run Evaluation ({selectedSampleIds.length})
											</Button>
											</form>
										</CardContent>
									</Card>
							<Card>
								<CardHeader>
									<CardTitle>Tools Image</CardTitle>
									<CardDescription>
										Dataset checkout pins this shared image for every trial and
										scoring container.
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-2 text-sm">
									<div className="flex flex-wrap items-center justify-between gap-3">
										<span className="text-muted-foreground">
											Current status: {toolsStatus?.state ?? "loading"}
										</span>
										{data.canManage ? (
											<Button
												type="button"
												size="sm"
												variant="outline"
												disabled={
													toolsStatus?.state === "building" ||
													rebuildTools.isLoading
												}
												onClick={buildTools}
											>
												{rebuildTools.isLoading || toolsStatus?.state === "building" ? (
													<Loader2 className="size-4 animate-spin" />
												) : null}
													{toolsStatus?.exists
														? "Rebuild tools image"
														: "Build tools image"}
											</Button>
										) : null}
									</div>
									{data.toolsImageTag && data.toolsImageDigest && data.toolsImageAvailable ? (
										<>
											<div className="flex flex-wrap items-center gap-2">
												<code className="break-all rounded bg-muted px-2 py-1 text-xs">
													{data.toolsImageTag}
												</code>
												<CopyValueButton
													value={data.toolsImageTag}
													label="Tools image tag"
													className="size-7"
												/>
											</div>
											<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
														<span className="break-all font-mono text-xs">
													{data.toolsImageDigest}
												</span>
												<CopyValueButton
													value={data.toolsImageDigest}
													label="Tools image digest"
													className="size-7"
												/>
											</div>
										</>
									) : (
										<p className="text-amber-700">
											{data.toolsImageTag && data.toolsImageDigest
												? "The pinned tools image is missing. Re-checkout is required before this Profile can run an Evaluation."
												: "Re-checkout required before this Profile can run an Evaluation."}
										</p>
									)}
								</CardContent>
							</Card>
													<Card>
														<CardHeader>
															<CardTitle>Local Dataset Path</CardTitle>
															<CardDescription>
																Set the directory mounted for this Profile. Checkout is
																separate and runs from the button above.
															</CardDescription>
														</CardHeader>
														<CardContent>
															<form
																onSubmit={saveHostRoot}
																className="flex flex-wrap items-end gap-3"
															>
											<label
												htmlFor="profile-host-root"
												className="grid min-w-0 flex-1 gap-2 text-sm font-medium"
											>
												Absolute local path
												<Input
													id="profile-host-root"
													required
													value={hostRoot}
													onChange={(event) => setHostRoot(event.target.value)}
													placeholder="/data/datasets/example"
												/>
											</label>
											<Button
												type="submit"
												disabled={updateHostRoot.isLoading || !hostRoot.trim()}
											>
												{updateHostRoot.isLoading ? (
													<Loader2 className="size-4 animate-spin" />
												) : null}
												Save Path
											</Button>
										</form>
									</CardContent>
								</Card>
								<Card>
									<CardHeader>
										<CardTitle>Samples</CardTitle>
										<CardDescription>
											{data.sampleCount} prepared samples;{" "}
											{data.selectedSampleCount} selected for evaluation.
										</CardDescription>
									</CardHeader>
									<CardContent className="flex h-[32rem] min-h-0 flex-col">
										{data.status === "ready" && (
											<>
												<div className="mb-3 flex shrink-0 gap-2">
													<Input
														value={sampleSearch}
														onChange={(event) =>
															setSampleSearch(event.target.value)
														}
														placeholder="Search samples"
													/>
													<Button
														type="button"
														variant="outline"
														onClick={() => setSampleSearch("")}
														disabled={!sampleSearch}
													>
														Clear
													</Button>
												</div>
												<div className="mb-3 flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
													<span>{selectedSampleIds.length} selected</span>
													<div className="flex items-center gap-2">
														<Button
															type="button"
															size="sm"
															variant="ghost"
															onClick={toggleSamplesOnPage}
															disabled={!pageSampleIds.length}
														>
															{allCurrentPageSelected
																? "Clear page"
																: "Select page"}
														</Button>
														<Button
															type="button"
															size="sm"
															onClick={saveSelection}
															disabled={updateSelectedSamples.isLoading}
														>
															{updateSelectedSamples.isLoading ? (
																<Loader2 className="size-4 animate-spin" />
															) : null}
															Save Selection
														</Button>
													</div>
												</div>
											</>
										)}
										{data.status === "preparing" ? (
											<p className="flex-1 text-sm text-muted-foreground">
												Checkout has not been run for this profile. Click
												Checkout above to prepare samples.
											</p>
										) : data.status === "failed" ? (
											<p className="flex-1 text-sm text-destructive">
												Profile checkout failed. Re-checkout to try again.
											</p>
										) : data.status !== "ready" ? (
											<p className="flex-1 text-sm text-muted-foreground">
												No prepared samples.
											</p>
										) : samples.isFetching ? (
											<div className="flex flex-1 items-center justify-center">
												<Loader2 className="animate-spin" />
											</div>
										) : samples.data?.items.length ? (
											<>
												<div className="min-h-0 flex-1 overflow-y-auto pr-2">
													<RowList>
														{samples.data.items.map((sample) => (
															<RowListItem
																asChild
																key={sample.sampleId}
																className={[
																	"cursor-pointer flex-row items-start justify-start gap-3 hover:bg-muted/30 sm:items-center",
																	selectedSampleIds.includes(sample.id)
																		? "border-primary bg-primary/5"
																		: "",
																].join(" ")}
															>
																<label htmlFor={`sample-${sample.sampleId}`}>
																	<Checkbox
																		id={`sample-${sample.sampleId}`}
																		checked={selectedSampleIds.includes(
																			sample.id,
																		)}
																		onCheckedChange={() =>
																			toggleSample(sample.id)
																		}
																		aria-label={`Select sample ${sample.id}`}
																		className="mt-0.5 shrink-0 sm:mt-0"
																	/>
																	<span className="grid min-w-0 flex-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:items-center sm:gap-4">
																		<span className="break-words font-medium">
																			{sample.title || sample.id}
																		</span>
																		<span className="break-all font-mono text-xs text-muted-foreground sm:text-right">
																			{sample.id} · {sample.repositoryPath}
																		</span>
																	</span>
																</label>
															</RowListItem>
														))}
													</RowList>
												</div>
												<div className="mt-3 flex shrink-0 flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
													<span>{samples.data.total} samples</span>
													<div className="flex items-center gap-2">
														<Button
															type="button"
															size="sm"
															variant="outline"
															disabled={samplePage <= 1}
															onClick={() => setSamplePage((page) => page - 1)}
														>
															Previous
														</Button>
														<span className="whitespace-nowrap">
															Page {samplePage} of {totalPages}
														</span>
														<Button
															type="button"
															size="sm"
															variant="outline"
															disabled={samplePage >= totalPages}
															onClick={() => setSamplePage((page) => page + 1)}
														>
															Next
														</Button>
													</div>
												</div>
											</>
										) : (
											<p className="flex-1 text-sm text-muted-foreground">
												No prepared samples.
											</p>
										)}
									</CardContent>
								</Card>
							</div>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
			<Dialog
				open={checkoutDialogOpen}
				onOpenChange={(open) => {
					if (!open && checkoutIsRunning) return;
					setCheckoutDialogOpen(open);
				}}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>
							{checkoutIsCompleted
								? "Dataset checkout complete"
								: checkoutIsFailed
									? "Dataset checkout failed"
									: "Checking out dataset profile"}
						</DialogTitle>
						<DialogDescription>
							{checkoutIsRunning
							? "This process checks the shared tools image and validates every sample. You can close this dialog after it finishes."
							: checkoutIsCompleted
								? `Prepared ${checkoutStatus.sampleCount ?? data.sampleCount} samples and pinned the shared tools image.`
									: "The profile was not prepared. Review the error and retry checkout."}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-3">
							{CHECKOUT_STAGES.map((stage, index) => {
								const complete = index < checkoutStageIndex || checkoutIsCompleted;
								const active = checkoutIsRunning && index === checkoutStageIndex;
								return (
									<div
										key={stage.phase}
										className="flex items-start gap-3"
									>
										<div className="mt-0.5 shrink-0">
											{complete ? (
												<CheckCircle2 className="size-5 text-emerald-600" />
											) : active ? (
												<Loader2 className="size-5 animate-spin text-primary" />
											) : (
												<Circle className="size-5 text-muted-foreground/40" />
												)}
										</div>
										<div className="min-w-0">
											<p className={active ? "font-medium" : "text-muted-foreground"}>
												{stage.label}
											</p>
											{active && checkoutStatus?.message ? (
												<p className="text-xs text-muted-foreground">
													{checkoutStatus.message}
												</p>
											) : null}
										</div>
									</div>
								);
							})}
						</div>

						{checkoutStatus?.phase === "reading_manifest" && manifestProgress ? (
							<div className="space-y-2 rounded-lg border bg-muted/20 p-3">
								<div className="flex items-center justify-between gap-3 text-sm">
									<span className="font-medium">Sample validation progress</span>
									<span className="text-muted-foreground">
										{manifestProgress.current} / {manifestProgress.total}
									</span>
								</div>
								<Progress
									value={manifestPercent}
									aria-label="Sample validation progress"
								/>
							</div>
						) : null}

						{checkoutIsFailed ? (
							<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
								<XCircle className="mt-0.5 size-4 shrink-0" />
								<span>{checkoutStartError || checkoutStatus?.errorMessage}</span>
							</div>
						) : null}
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={checkoutIsRunning}
							onClick={() => setCheckoutDialogOpen(false)}
						>
							{checkoutIsRunning ? "Checkout in progress" : "Close"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<CheckoutLogModal
				open={toolsLogOpen}
				onOpenChange={setToolsLogOpen}
				title="Tools image build"
				description={toolsBuildStatus?.imageTag}
				logs={
					toolsBuildStatus
						? [toolsBuildStatus.stdout, toolsBuildStatus.stderr].filter(Boolean).join("\n")
						: "Waiting for tools image build..."
				}
				isLoading={toolsBuildStatus?.status === "running"}
			/>
		</>
	);
};

/** Evaluations tab — shared CollectionView row list backed by the paginated API. */
export const ProfileEvaluationsTable = ({
	state,
	onStateChange,
	data,
	isLoading,
	isRefreshing,
}: {
	state: ListQueryState;
	onStateChange: ListQueryStateSetter;
	data:
		| {
				items: {
					evaluationId: string;
					name: string;
					pipelineId: string | null;
					status: string;
					sampleIds: string[];
					repetitions: number;
				}[];
				total: number;
		  }
		| undefined;
	isLoading?: boolean;
	isRefreshing?: boolean;
}) => (
	<CollectionView
		state={state}
		onStateChange={onStateChange}
		data={{
			items: data?.items ?? [],
			total: data?.total ?? 0,
		}}
		isLoading={isLoading}
		isRefreshing={isRefreshing}
		getRowId={(evaluation) => evaluation.evaluationId}
		getRowLabel={(evaluation) => evaluation.name}
		emptyTitle="No evaluations have been created for this Profile."
		renderRow={(evaluation) => (
			<RowListItem
				asChild
				className="group gap-3 hover:bg-border"
			>
				<Link
					href={`/dashboard/datasets/evaluations/${evaluation.evaluationId}`}
				>
					<span className="min-w-0">
						<span className="block font-medium">{evaluation.name}</span>
						<span className="mt-1 block text-xs capitalize text-muted-foreground">
							Pipeline {evaluation.pipelineId}
						</span>
					</span>
					<span className="flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
						<span>{evaluation.sampleIds.length} samples</span>
						<span>{evaluation.repetitions} repetitions</span>
						<StatusBadge value={evaluation.status} />
					</span>
				</Link>
			</RowListItem>
		)}
	/>
);

ProfileDetailPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default ProfileDetailPage;
