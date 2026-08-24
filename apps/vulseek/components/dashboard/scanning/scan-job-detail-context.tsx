/**
 * Query controller for the shared scan job detail (Phase 4). Hosts all
 * URL-backed tab/list state, the polling queries, mutations and file-tree
 * state; ShowScanJobDetail and its tab components consume this context
 * instead of owning controller state themselves.
 */
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	applyCandidateListQueryState,
	buildCandidateListStateHref,
	type CandidateSortDirection,
	type CandidateSortKey,
	parseCandidateListQueryState,
	serializeCandidateListQueryState,
} from "@/components/dashboard/scanning/candidate-list-query-state";
import { jobTabsFromSnapshot } from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	type DirectoryCacheEntry,
	ROOT_DIRECTORY_KEY,
} from "@/components/dashboard/scanning/scan-lazy-file-tree";
import type { ScanNavigationContext } from "@/lib/ui-system/route-builders";
import { api, type RouterOutputs } from "@/utils/api";
import {
	isTerminalScanJobStatus,
	scanT,
} from "./scan-i18n";
import {
	buildCandidateReanalysisKey,
	CORE_JOB_TABS,
	resolveRequestedTab,
	type ScanJobTab,
} from "./scan-job-detail-format";

export interface Props {
	projectId?: string;
	environmentId?: string;
	serviceId?: string;
	scanJobId: string;
	serviceType?: "application" | "compose";
	routeSegment?: "profiles" | "services";
	/**
	 * Shared scan navigation context. Dataset job pages pass this instead of
	 * the project route params; the page then builds breadcrumbs, return and
	 * task/candidate links from the context and skips service-specific logic.
	 */
	navigation?: ScanNavigationContext;
}

export type ScanJobCandidateListItem =
	RouterOutputs["scan"]["candidates"]["items"][number];

/** Everything the scan job detail shell and its tabs need from the controller. */
export type ScanJobDetailContextValue = {
	// Identity + navigation, forwarded to the shell for breadcrumbs and links.
	projectId?: string;
	environmentId?: string;
	serviceId?: string;
	scanJobId: string;
	serviceType?: "application" | "compose";
	routeSegment?: "profiles" | "services";
	navigation?: ScanNavigationContext;
	serviceData:
		| RouterOutputs["application"]["one"]
		| RouterOutputs["compose"]["one"]
		| undefined;

	// URL-backed tab state and the tab-change handler that syncs the URL.
	activeTab: ScanJobTab;
	handleTabChange: (value: string) => void;
	jobTabs: ReturnType<typeof jobTabsFromSnapshot>;
	unknownTab: boolean;

	// Job overview + shared polling.
	scanJob: RouterOutputs["scan"]["jobOverview"] | undefined;
	isLoadingJob: boolean;
	queuePendingCounts: RouterOutputs["scan"]["jobQueueCounts"]["queues"];
	resultSummary: RouterOutputs["scan"]["resultSummary"] | undefined;
	isLoadingResultSummary: boolean;
	/** Invalidates every job view; shared with the tabs. */
	refreshScanJobViews: () => Promise<void>;

	// Candidates: URL-backed list state plus the last-good-data pattern.
	candidates: RouterOutputs["scan"]["candidates"] | undefined;
	isLoadingCandidates: boolean;
	isFetchingCandidates: boolean;
	candidatePagination: {
		page: number;
		pageSize: number;
		totalItems: number;
		totalPages: number;
		startIndex: number;
		endIndex: number;
		items: RouterOutputs["scan"]["candidates"]["items"];
	};
	candidateQuery: string;
	onSearchChange: (value: string) => void;
	analysisFilters: string[];
	onAnalysisFilterToggle: (value: string) => void;
	onClearAnalysisFilters: () => void;
	verifyFilters: string[];
	onVerifyFilterToggle: (value: string) => void;
	onClearVerifyFilters: () => void;
	triageFilters: string[];
	onTriageFilterToggle: (value: string) => void;
	onClearTriageFilters: () => void;
	onToggleCandidateSort: (key: CandidateSortKey) => void;
	candidatePageSize: number;
	onPageSizeChange: (size: number) => void;
	onPageChange: (page: number) => void;
	buildCandidateDetailHref: (
		candidate: Pick<
			ScanJobCandidateListItem,
			"vulnerabilityCandidateId" | "producerTaskId"
		>,
	) => string;
	onCandidateLinkClick: () => void;
	reanalyzingCandidateId: string | null;
	onReanalyzeCandidate: (candidate: {
		vulnerabilityCandidateId: string;
		scanJobId: string;
		producerTaskId?: string | null;
	}) => Promise<void>;

	// Tasks.
	runningTasksData: RouterOutputs["scan"]["jobRunningTasks"] | undefined;
	runningTasksError: unknown;
	queueCountsData: RouterOutputs["scan"]["jobQueueCounts"] | undefined;
	queueCountsError: unknown;
	jobPipeline: RouterOutputs["scan"]["jobPipeline"] | undefined;
	buildTaskDetailHref: (taskId: string) => string;

	// Files.
	directoryCache: Record<string, DirectoryCacheEntry>;
	rootDirectoryLoading: boolean;
	expandedDirectories: Record<string, boolean>;
	selectedFilePath: string | null;
	onToggleDirectory: (directoryPath: string) => Promise<void>;
	onSelectFile: (filePath: string | null) => void;
	selectedFile: RouterOutputs["scan"]["readFile"] | undefined;
	isLoadingSelectedFile: boolean;
};

const ScanJobDetailContext = createContext<ScanJobDetailContextValue | null>(
	null,
);

type ScanJobDetailProviderProps = Props & {
	children: ReactNode;
};

export const ScanJobDetailProvider = ({
	projectId,
	environmentId,
	serviceId,
	scanJobId,
	serviceType,
	routeSegment,
	navigation,
	children,
}: ScanJobDetailProviderProps) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const utils = api.useUtils();
	const initialCandidateListQueryState = parseCandidateListQueryState(
		router.query,
	);
	const [activeTab, setActiveTab] = useState<ScanJobTab>(
		() => resolveRequestedTab(router.query.tab).tab,
	);
	const [candidateQuery, setCandidateQuery] = useState(
		() => initialCandidateListQueryState.candidateQuery,
	);
	const [analysisFilters, setAnalysisFilters] = useState<string[]>(
		() => initialCandidateListQueryState.analysisFilters,
	);
	const [verifyFilters, setVerifyFilters] = useState<string[]>(
		() => initialCandidateListQueryState.verifyFilters,
	);
	const [triageFilters, setTriageFilters] = useState<string[]>(
		() => initialCandidateListQueryState.triageFilters,
	);
	const [candidateSortKey, setCandidateSortKey] = useState<CandidateSortKey>(
		() => initialCandidateListQueryState.candidateSortKey,
	);
	const [candidateSortDirection, setCandidateSortDirection] =
		useState<CandidateSortDirection>(
			() => initialCandidateListQueryState.candidateSortDirection,
		);
	const [candidatePage, setCandidatePage] = useState(
		() => initialCandidateListQueryState.candidatePage,
	);
	const [candidatePageSize, setCandidatePageSize] = useState(
		() => initialCandidateListQueryState.candidatePageSize,
	);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [expandedDirectories, setExpandedDirectories] = useState<
		Record<string, boolean>
	>({});
	const [directoryCache, setDirectoryCache] = useState<
		Record<string, DirectoryCacheEntry>
	>({});
	const restoredCandidateScrollKeyRef = useRef<string | null>(null);
	const isApplyingQueryStateRef = useRef(false);

	const serviceQuery =
		serviceType === "application" && serviceId
			? api.application.one.useQuery({ applicationId: serviceId })
			: serviceType === "compose" && serviceId
				? api.compose.one.useQuery({ composeId: serviceId })
				: undefined;
	const serviceData = serviceQuery?.data;

	const {
		data: scanJob,
		isLoading: isLoadingJob,
	} = api.scan.jobOverview.useQuery(
		{ scanJobId },
		{
			enabled: !!scanJobId,
			refetchInterval: (data) =>
				isTerminalScanJobStatus(data?.status) ? false : 10_000,
		},
	);
	const jobTabs = useMemo(
		() => jobTabsFromSnapshot(scanJob?.pipelineCompiledSnapshot),
		[scanJob],
	);
	const shouldLoadJobRuntime =
		activeTab === "overview" || activeTab === "tasks";
	const {
		data: candidatesData,
		isLoading: isLoadingCandidates,
		isFetching: isFetchingCandidates,
	} = api.scan.candidates.useQuery(
		{
			scanJobId,
			page: candidatePage,
			pageSize: candidatePageSize,
			query: candidateQuery,
			analysisResults: analysisFilters.join(","),
			verifyResults: verifyFilters.join(","),
			triageResults: triageFilters.join(","),
			sortKey: candidateSortKey,
			sortDirection: candidateSortDirection,
		},
		{
			enabled:
				!!scanJobId &&
				jobTabs.some(
					(tab) => tab.id === activeTab && tab.renderer === "candidate-results",
				),
			refetchInterval:
				jobTabs.some(
					(tab) => tab.id === activeTab && tab.renderer === "candidate-results",
				) && !isTerminalScanJobStatus(scanJob?.status)
					? 20_000
					: false,
			// No keepPreviousData: show correct data only. Use isFetchingCandidates
			// to render a dim overlay instead of replacing the table on filter change.
		},
	);
	// Keep the last successfully fetched data visible while a new fetch is in
	// flight, so the table doesn't disappear. This is safer than keepPreviousData
	// because it only shows data that matches the correct query key.
	const candidatesLastRef = useRef(candidatesData);
	if (candidatesData !== undefined) {
		candidatesLastRef.current = candidatesData;
	}
	const candidates = candidatesLastRef.current;
	const { data: runningTasksData, error: runningTasksError } =
		api.scan.jobRunningTasks.useQuery(
			{ scanJobId },
			{
				enabled: !!scanJobId && shouldLoadJobRuntime,
				refetchInterval:
					shouldLoadJobRuntime && !isTerminalScanJobStatus(scanJob?.status)
						? 5000
						: false,
			},
		);
	const { data: queueCountsData, error: queueCountsError } =
		api.scan.jobQueueCounts.useQuery(
			{ scanJobId },
			{
				enabled: !!scanJobId && shouldLoadJobRuntime,
				refetchInterval:
					shouldLoadJobRuntime && !isTerminalScanJobStatus(scanJob?.status)
						? 5000
						: false,
			},
		);
	const { data: jobPipeline } = api.scan.jobPipeline.useQuery(
		{ scanJobId },
		{
			enabled: !!scanJobId && shouldLoadJobRuntime,
			staleTime: Number.POSITIVE_INFINITY,
			refetchOnWindowFocus: false,
			trpc: { context: { skipBatch: true } },
		},
	);
	const { data: resultSummary, isLoading: isLoadingResultSummary } =
		api.scan.resultSummary.useQuery(
			{ scanJobId },
			{
				enabled: !!scanJobId && activeTab === "overview",
				refetchInterval:
					activeTab === "overview" && !isTerminalScanJobStatus(scanJob?.status)
						? 10_000
						: false,
			},
		);
	const { data: selectedFile, isLoading: isLoadingSelectedFile } =
		api.scan.readFile.useQuery(
			{ scanJobId, filePath: selectedFilePath || "" },
			{ enabled: !!scanJobId && !!selectedFilePath },
		);
	const analyzeCandidateMutation = api.scan.analyzeCandidate.useMutation();
	const [reanalyzingCandidateId, setReanalyzingCandidateId] = useState<
		string | null
	>(null);
	const rootDirectoryQuery = api.scan.listDirectory.useQuery(
		{ scanJobId },
		{
			enabled: !!scanJobId && activeTab === "files",
			refetchInterval: activeTab === "files" ? 4000 : false,
		},
	);

	useEffect(() => {
		setSelectedFilePath(null);
		setExpandedDirectories({});
		setDirectoryCache({});
	}, [scanJobId]);

	const allowedTabIds = useMemo(() => {
		const ids = [...CORE_JOB_TABS, ...jobTabs.map((tab) => tab.id)];
		const pendingTab =
			typeof router.query.tab === "string" ? router.query.tab : "";
		if (!scanJob && pendingTab && !ids.includes(pendingTab)) {
			ids.push(pendingTab);
		}
		return ids;
	}, [jobTabs, router.query.tab, scanJob]);
	const requested = useMemo(
		() => resolveRequestedTab(router.query.tab, allowedTabIds),
		[allowedTabIds, router.query.tab],
	);
	const requestedTab = requested.tab;
	const unknownTab = Boolean(scanJob) && requested.unknown;

	const refreshScanJobViews = async () => {
		await Promise.all([
			utils.scan.jobOverview.invalidate({ scanJobId }),
			utils.scan.jobRunningTasks.invalidate({ scanJobId }),
			utils.scan.jobQueueCounts.invalidate({ scanJobId }),
			utils.scan.resultSummary.invalidate({ scanJobId }),
			utils.scan.candidates.invalidate({ scanJobId }),
			serviceType === "application" && serviceId
				? utils.scan.listByApplication.invalidate({ applicationId: serviceId })
				: serviceType === "compose" && serviceId
					? utils.scan.listByCompose.invalidate({ composeId: serviceId })
					: undefined,
		]);
	};

	const candidateListQueryState = useMemo(
		() => parseCandidateListQueryState(router.query),
		[router.query],
	);
	const candidateListQueryStateSerialized = useMemo(
		() => serializeCandidateListQueryState(candidateListQueryState),
		[candidateListQueryState],
	);
	const currentCandidateListState = useMemo(
		() => ({
			candidateQuery,
			analysisFilters,
			verifyFilters,
			triageFilters,
			candidateSortKey,
			candidateSortDirection,
			candidatePage,
			candidatePageSize,
		}),
		[
			analysisFilters,
			candidateQuery,
			candidatePage,
			candidatePageSize,
			candidateSortDirection,
			candidateSortKey,
			triageFilters,
			verifyFilters,
		],
	);
	const currentCandidateListStateSerialized = useMemo(
		() => serializeCandidateListQueryState(currentCandidateListState),
		[currentCandidateListState],
	);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		// Only sync tab from URL. Filter/sort/page state is initialized from URL
		// via useState() and then managed locally to avoid race conditions where
		// async router.replace() from Effect 3 would trigger this effect and
		// overwrite state set by rapid user clicks.
		isApplyingQueryStateRef.current = true;
		setActiveTab(requestedTab);
	}, [requestedTab, router.isReady]);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		// Reset the "applying" flag once the tab has caught up with the URL.
		if (activeTab === requestedTab) {
			isApplyingQueryStateRef.current = false;
		}
	}, [activeTab, requestedTab, router.isReady]);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		if (isApplyingQueryStateRef.current) {
			return;
		}

		if (
			currentCandidateListStateSerialized === candidateListQueryStateSerialized
		) {
			return;
		}

		void router.replace(
			{
				pathname: router.pathname,
				query: applyCandidateListQueryState(
					router.query,
					currentCandidateListState,
					activeTab,
				),
			},
			undefined,
			{ shallow: true },
		);
	}, [
		activeTab,
		candidateListQueryStateSerialized,
		currentCandidateListState,
		currentCandidateListStateSerialized,
		router,
	]);
	const queuePendingCounts = queueCountsData?.queues ?? [];

	const handleAnalyzeCandidate = async (candidate: {
		vulnerabilityCandidateId: string;
		scanJobId: string;
		producerTaskId?: string | null;
	}) => {
		const reanalysisKey = buildCandidateReanalysisKey(candidate);
		setReanalyzingCandidateId(reanalysisKey);
		try {
			const result = await analyzeCandidateMutation.mutateAsync({
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				scanJobId: candidate.scanJobId,
				producerTaskId: candidate.producerTaskId || undefined,
			});
			toast.success(
				scanT(t, "scan.candidates.analysisRequeued", "Analysis requeued"),
			);
			await Promise.all([
				utils.scan.jobOverview.invalidate({ scanJobId }),
				utils.scan.jobRunningTasks.invalidate({ scanJobId }),
				utils.scan.jobQueueCounts.invalidate({ scanJobId }),
				utils.scan.candidates.invalidate({ scanJobId }),
			]);
			await router.push(
				navigation
					? `${navigation.taskHref(scanJobId, result.taskId)}?tab=tasks&taskId=${encodeURIComponent(result.taskId)}`
					: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}?tab=tasks&taskId=${encodeURIComponent(
							result.taskId,
						)}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(
							t,
							"scan.candidates.analysisRequeueError",
							"Failed to requeue analysis",
						),
			);
		} finally {
			setReanalyzingCandidateId((current) =>
				current === reanalysisKey ? null : current,
			);
		}
	};

	const candidatePagination = useMemo(() => {
		const totalItems = candidates?.total ?? 0;
		const pageSize = candidates?.pageSize ?? candidatePageSize;
		const totalPages =
			candidates?.totalPages ?? Math.max(1, Math.ceil(totalItems / pageSize));
		const safePage =
			candidates?.page ?? Math.min(Math.max(1, candidatePage), totalPages);
		const startIndex = totalItems > 0 ? (safePage - 1) * pageSize : 0;
		const items = candidates?.items ?? [];
		const endIndex = Math.min(totalItems, startIndex + items.length);
		return {
			page: safePage,
			pageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items,
		};
	}, [candidatePage, candidatePageSize, candidates]);
	type CandidateListItem = (typeof candidatePagination.items)[number];
	useEffect(() => {
		if (candidatePage !== candidatePagination.page) {
			setCandidatePage(candidatePagination.page);
		}
	}, [candidatePage, candidatePagination.page]);
	const toggleCandidateSort = (key: CandidateSortKey) => {
		if (candidateSortKey === key) {
			setCandidateSortDirection((current) =>
				current === "asc" ? "desc" : "asc",
			);
			return;
		}
		setCandidateSortKey(key);
		setCandidateSortDirection(
			key === "latestResultUpdatedAt" || key === "createdAt" ? "desc" : "asc",
		);
	};

	const toggleAnalysisFilter = (value: string) => {
		setCandidatePage(1);
		setAnalysisFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const toggleVerifyFilter = (value: string) => {
		setCandidatePage(1);
		setVerifyFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const toggleTriageFilter = (value: string) => {
		setCandidatePage(1);
		setTriageFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const candidateListPageBasePath = navigation
		? navigation.jobsListHref
		: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}`;

	const candidateScrollStorageKey = useMemo(
		() =>
			`scan-candidates-scroll:${buildCandidateListStateHref(
				candidateListPageBasePath,
				currentCandidateListState,
				"candidates",
			)}`,
		[candidateListPageBasePath, currentCandidateListState],
	);

	useEffect(() => {
		if (
			typeof window === "undefined" ||
			!router.isReady ||
			activeTab !== "candidates"
		) {
			return;
		}

		if (restoredCandidateScrollKeyRef.current === candidateScrollStorageKey) {
			return;
		}

		const rawScrollY = window.sessionStorage.getItem(candidateScrollStorageKey);
		if (!rawScrollY) {
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			return;
		}

		const scrollY = Number.parseFloat(rawScrollY);
		if (!Number.isFinite(scrollY) || scrollY < 0) {
			window.sessionStorage.removeItem(candidateScrollStorageKey);
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			return;
		}

		requestAnimationFrame(() => {
			window.scrollTo({ top: scrollY, behavior: "auto" });
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			window.sessionStorage.removeItem(candidateScrollStorageKey);
		});
	}, [
		activeTab,
		candidatePagination.page,
		candidateScrollStorageKey,
		router.isReady,
	]);

	const buildCandidateDetailHref = (
		candidate: Pick<
			CandidateListItem,
			"vulnerabilityCandidateId" | "producerTaskId"
		>,
	) => {
		const href = buildCandidateListStateHref(
			navigation
				? navigation.candidateHref(
						scanJobId,
						candidate.vulnerabilityCandidateId,
					)
				: `${candidateListPageBasePath}/candidates/${encodeURIComponent(
						candidate.vulnerabilityCandidateId,
					)}`,
			currentCandidateListState,
			"candidates",
		);
		if (!candidate.producerTaskId) {
			return href;
		}
		const separator = href.includes("?") ? "&" : "?";
		return `${href}${separator}producerTaskId=${encodeURIComponent(
			candidate.producerTaskId,
		)}`;
	};
	const buildTaskDetailHref = (taskId: string) =>
		navigation
			? navigation.taskHref(scanJobId, taskId)
			: `${candidateListPageBasePath}/tasks/${encodeURIComponent(taskId)}`;
	const handleCandidateLinkClick = () => {
		if (typeof window === "undefined") {
			return;
		}
		window.sessionStorage.setItem(
			candidateScrollStorageKey,
			String(window.scrollY),
		);
	};

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
			return;
		}

		const firstFile = items.find((item) => item.type === "file")?.id || null;
		if (!firstFile) {
			return;
		}
		setSelectedFilePath((current) => current || firstFile);
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
		if (existing?.status === "loading") {
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
			const items = await utils.scan.listDirectory.fetch({
				scanJobId,
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
	const contextValue: ScanJobDetailContextValue = {
		projectId,
		environmentId,
		serviceId,
		scanJobId,
		serviceType,
		routeSegment,
		navigation,
		serviceData,
		activeTab,
		handleTabChange: (value) => {
			const nextTab = value as ScanJobTab;
			setActiveTab(nextTab);
			void router.replace(
				{
					pathname: router.pathname,
					query: applyCandidateListQueryState(
						router.query,
						currentCandidateListState,
						nextTab,
					),
				},
				undefined,
				{ shallow: true },
			);
		},
		jobTabs,
		unknownTab,
		scanJob,
		isLoadingJob,
		queuePendingCounts,
		resultSummary,
		isLoadingResultSummary,
		refreshScanJobViews,
		candidates,
		isLoadingCandidates,
		isFetchingCandidates,
		candidatePagination,
		candidateQuery,
		onSearchChange: (value) => {
			setCandidatePage(1);
			setCandidateQuery(value);
		},
		analysisFilters,
		onAnalysisFilterToggle: toggleAnalysisFilter,
		onClearAnalysisFilters: () => setAnalysisFilters([]),
		verifyFilters,
		onVerifyFilterToggle: toggleVerifyFilter,
		onClearVerifyFilters: () => setVerifyFilters([]),
		triageFilters,
		onTriageFilterToggle: toggleTriageFilter,
		onClearTriageFilters: () => setTriageFilters([]),
		onToggleCandidateSort: toggleCandidateSort,
		candidatePageSize,
		onPageSizeChange: (size) => {
			setCandidatePage(1);
			setCandidatePageSize(size);
		},
		onPageChange: setCandidatePage,
		buildCandidateDetailHref,
		onCandidateLinkClick: handleCandidateLinkClick,
		reanalyzingCandidateId,
		onReanalyzeCandidate: handleAnalyzeCandidate,
		runningTasksData,
		runningTasksError,
		queueCountsData,
		queueCountsError,
		jobPipeline,
		buildTaskDetailHref,
		directoryCache,
		rootDirectoryLoading: rootDirectoryQuery.isLoading,
		expandedDirectories,
		selectedFilePath,
		onToggleDirectory: handleToggleDirectory,
		onSelectFile: setSelectedFilePath,
		selectedFile,
		isLoadingSelectedFile,
	};

	return (
		<ScanJobDetailContext.Provider value={contextValue}>
			{children}
		</ScanJobDetailContext.Provider>
	);
};

export const useScanJobDetail = () => {
	const context = useContext(ScanJobDetailContext);
	if (!context) {
		throw new Error(
			"useScanJobDetail must be used within a ScanJobDetailProvider",
		);
	}
	return context;
};
