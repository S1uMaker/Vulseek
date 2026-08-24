import { cachedInputPercent } from "@/lib/scan/token-usage";
import {
	formatAnalysisResultLabel,
	formatScanJobStatusLabel,
	formatScanStageLabel,
	formatScanStatusLabel,
	formatTruthResultLabel,
	type ScanTranslation,
	scanT,
} from "./scan-i18n";

export const CORE_JOB_TABS = [
	"overview",
	"tasks",
	"monitoring",
	"files",
] as const;

export type ScanJobTab = string;

export const RESULT_SHORT_LABELS: Record<string, string> = {
	real_vulnerability: "Real",
	likely_vulnerability: "Likely",
	true: "True",
	likely: "Likely",
	false: "False",
	plausible_but_unproven: "Plausible",
	false_positive: "False",
	api_misuse: "Misuse",
};

export const formatResultLabel = (value: string) =>
	value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

export const CANDIDATE_EXPORT_FIELDS = [
	{ key: "vulnerabilityCandidateId", label: "Candidate ID" },
	{ key: "scanJobId", label: "Scan Job ID" },
	{ key: "producerTaskId", label: "Producer Task ID" },
	{ key: "title", label: "Title" },
	{ key: "description", label: "Description" },
	{ key: "fileHostPath", label: "Source File Host Path" },
	{ key: "line", label: "Line" },
	{ key: "vulnerabilityType", label: "Vulnerability Type" },
	{ key: "confidence", label: "Confidence" },
	{ key: "score", label: "Score" },
	{ key: "createdAt", label: "Created At" },
	{ key: "updatedAt", label: "Updated At" },
	{ key: "analysisTaskId", label: "Analysis Task ID" },
	{ key: "analysisResult", label: "Analysis Result" },
	{ key: "analysisConfidence", label: "Analysis Confidence" },
	{ key: "analysisScore", label: "Analysis Score" },
	{ key: "analysisSummary", label: "Analysis Summary" },
	{ key: "analysisReportHostPath", label: "Analysis Report Host Path" },
	{ key: "analysisRuntimeSeconds", label: "Analysis Runtime Seconds" },
	{ key: "analysisThreadId", label: "Analysis Thread ID" },
	{ key: "analysisCreatedAt", label: "Analysis Created At" },
	{ key: "analysisUpdatedAt", label: "Analysis Updated At" },
	{ key: "verificationTaskId", label: "Verification Task ID" },
	{ key: "verificationResult", label: "Verification Result" },
	{ key: "verificationConfidence", label: "Verification Confidence" },
	{ key: "verificationScore", label: "Verification Score" },
	{ key: "verificationSummary", label: "Verification Summary" },
	{ key: "verificationReportHostPath", label: "Verification Report Host Path" },
	{
		key: "verificationRuntimeSeconds",
		label: "Verification Runtime Seconds",
	},
	{ key: "verificationThreadId", label: "Verification Thread ID" },
	{ key: "verificationCreatedAt", label: "Verification Created At" },
	{ key: "verificationUpdatedAt", label: "Verification Updated At" },
	{ key: "triageTaskId", label: "Triage Task ID" },
	{ key: "triageResult", label: "Triage Result" },
	{ key: "triageDisqualifier", label: "Triage Disqualifier" },
	{ key: "triageDisqualifierReason", label: "Triage Disqualifier Reason" },
	{ key: "triageSecurityClassification", label: "Triage Classification" },
	{ key: "triageIsSecurityIssue", label: "Triage Is Security Issue" },
	{ key: "triageImpactType", label: "Triage Impact Type" },
	{ key: "triageCvssVector", label: "Triage CVSS Vector" },
	{ key: "triageCvssScore", label: "Triage CVSS Score" },
	{ key: "triageCvssSeverity", label: "Triage CVSS Severity" },
	{ key: "triageExploitability", label: "Triage Exploitability" },
	{ key: "triageIsExploitable", label: "Triage Is Exploitable" },
	{ key: "triageEpssProbability30d", label: "Triage EPSS 30d" },
	{ key: "triageEpssSource", label: "Triage EPSS Source" },
	{ key: "triageSummary", label: "Triage Summary" },
	{ key: "triageReportHostPath", label: "Triage Report Host Path" },
] as const;

export type CandidateExportField =
	(typeof CANDIDATE_EXPORT_FIELDS)[number]["key"];

export const DEFAULT_CANDIDATE_EXPORT_FIELDS = CANDIDATE_EXPORT_FIELDS.map(
	(field) => field.key,
);

export const getCandidateExportFieldLabel = (
	t: ScanTranslation,
	field: (typeof CANDIDATE_EXPORT_FIELDS)[number],
) => scanT(t, `scan.exportField.${field.key}`, field.label);

export const buildCandidateExportFilename = (scanJobId: string) => {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "")
		.replace("T", "-");
	return `scan-candidates-${scanJobId}-${timestamp}.json`;
};

export const copyTextToClipboard = async (text: string) => {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "true");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	document.body.appendChild(textarea);
	textarea.select();
	const didCopy = document.execCommand("copy");
	textarea.remove();
	if (!didCopy) {
		throw new Error("Failed to copy candidate JSON");
	}
};

export const formatTaskRuntime = (
	startedAt: string | null | undefined,
	nowMs: number,
) => {
	if (!startedAt) {
		return "-";
	}
	const startedAtMs = new Date(startedAt).getTime();
	if (!Number.isFinite(startedAtMs)) {
		return "-";
	}
	const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
};

export const formatDurationSeconds = (value: number | null | undefined) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	const totalSeconds = Math.max(0, Math.floor(value));
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
};

export const formatTokenUsage = (t: ScanTranslation, value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
		count: new Intl.NumberFormat().format(value),
	});
};

export const formatTokenCount = (value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return new Intl.NumberFormat().format(value);
};

export const formatTokenUsageWithCache = (
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

export const resolveRequestedTab = (
	value: string | string[] | undefined,
	allowedTabIds: readonly string[] = CORE_JOB_TABS,
): { tab: ScanJobTab; unknown: boolean } => {
	const rawTab =
		typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";
	if (rawTab === "stream") {
		return { tab: "tasks", unknown: false };
	}
	if (rawTab && allowedTabIds.includes(rawTab)) {
		return { tab: rawTab, unknown: false };
	}
	if (rawTab) {
		return { tab: "overview", unknown: true };
	}
	return { tab: "overview", unknown: false };
};

export const getShortResultLabel = (
	t: ScanTranslation,
	value?: string | null,
) => {
	if (!value) {
		return "-";
	}
	if (value in RESULT_SHORT_LABELS) {
		if (
			value === "real_vulnerability" ||
			value === "likely_vulnerability" ||
			value === "plausible_but_unproven" ||
			value === "false_positive" ||
			value === "api_misuse"
		) {
			return formatAnalysisResultLabel(t, value);
		}
		return formatTruthResultLabel(t, value);
	}
	if (
		value === "security_issue" ||
		value === "non_security" ||
		value === "hardening" ||
		value === "needs_review"
	) {
		return scanT(t, `scan.triageResult.${value}`, formatResultLabel(value));
	}
	return formatResultLabel(value);
};

export const getScanJobStatusLabel = (t: ScanTranslation, status?: string) =>
	formatScanJobStatusLabel(t, status || "pending");

export const getScanJobStatusClassName = (status?: string) => {
	if (status === "finished") {
		return "text-green-600";
	}
	if (status === "partially_finished") {
		return "text-orange-600";
	}
	if (status === "finalizing") {
		return "text-blue-600";
	}

	if (status === "canceled") {
		return "text-destructive";
	}

	if (status === "running") {
		return "text-amber-600";
	}

	if (status === "paused") {
		return "text-blue-600";
	}

	return "text-muted-foreground";
};

export const formatTriggerSourceLabel = (
	t: ScanTranslation,
	triggerSource?: string,
) =>
	triggerSource === "schedule"
		? scanT(t, "scan.jobs.auto", "auto")
		: !triggerSource || triggerSource === "manual"
			? scanT(t, "scan.jobs.manual", "manual")
			: triggerSource;

export const getAnalysisResultBadgeClassName = (result?: string | null) => {
	if (result === "real_vulnerability") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}

	if (result === "likely_vulnerability") {
		return "border-orange-200 bg-orange-100 text-orange-700 dark:border-orange-500/60 dark:bg-orange-950/50 dark:text-orange-100";
	}

	if (result === "plausible_but_unproven") {
		return "border-yellow-200 bg-yellow-100 text-yellow-700 dark:border-yellow-500/60 dark:bg-yellow-950/50 dark:text-yellow-100";
	}

	if (result === "false_positive") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}

	if (result === "api_misuse") {
		return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-500/60 dark:bg-slate-900/70 dark:text-slate-100";
	}

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

export const getVerificationTruthBadge = (
	t: ScanTranslation,
	result?: string | null,
): { label: string; className: string } | null => {
	if (!result) {
		return null;
	}

	if (result === "true") {
		return {
			label: formatTruthResultLabel(t, "true"),
			className:
				"border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100",
		};
	}

	if (result === "likely") {
		return {
			label: formatTruthResultLabel(t, "likely"),
			className:
				"border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100",
		};
	}

	return {
		label: getShortResultLabel(t, result),
		className: "border-muted-foreground/20 bg-muted text-muted-foreground",
	};
};

export const getTriageResultBadgeClassName = (result?: string | null) => {
	if (result === "security_issue") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}

	if (result === "non_security") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}

	if (result === "needs_more_information") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

export const getTaskStageLabel = (t: ScanTranslation, stage?: string) => {
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
	if (stage === "attack-surface-model" || stage === "attack-surface-model") {
		return formatScanStageLabel(t, "attack-surface-model");
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

export const RERUNNABLE_TASK_STATUSES = new Set([
	"completed",
	"failed",
	"exited",
	"canceled",
]);
export const buildCandidateReanalysisKey = (input: {
	vulnerabilityCandidateId: string;
	producerTaskId?: string | null;
}) => `${input.producerTaskId || "default"}:${input.vulnerabilityCandidateId}`;

export const getTaskStatusLabel = (t: ScanTranslation, status?: string) => {
	if (!status) {
		return "-";
	}
	return formatScanStatusLabel(t, status);
};

export const getTaskStatusBadgeClassName = (status?: string) => {
	if (status === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100";
	}
	if (status === "failed") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}
	if (status === "canceled") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	if (status === "running" || status === "starting") {
		return "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/50 dark:text-sky-100";
	}
	if (status === "launching" || status === "launched") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

export const localizeTaskListText = (
	t: ScanTranslation,
	value?: string | null,
): string => {
	const text = (value || "").trim();
	if (!text || text === "-") {
		return "";
	}
	if (text === "Delta Scope") {
		return formatScanStageLabel(t, "delta-scope");
	}
	if (text === "Repository Scanner") {
		return formatScanStageLabel(t, "repository-profile");
	}
	if (text === "Diff impact function scoping") {
		return scanT(t, "scan.tasks.deltaScopeSubtitle", "增量 diff 影响函数定位");
	}
	if (text === "Repository-wide planner and module partitioning") {
		return scanT(
			t,
			"scan.tasks.repositoryProfileSubtitle",
			"仓库级规划和模块拆分",
		);
	}
	return text;
};

export const getTaskListDisplay = (
	t: ScanTranslation,
	task: { title: string; subtitle?: string | null; stage?: string | null },
) => {
	const title = getTaskStageLabel(t, task.stage || undefined);
	const localizedTitle = localizeTaskListText(t, task.title);
	const localizedSubtitle = localizeTaskListText(t, task.subtitle);
	const subtitleParts = [localizedSubtitle, localizedTitle].filter(
		(value) => value && value !== "-" && value !== title,
	);
	return {
		title,
		subtitle: subtitleParts.join(" · ") || "-",
	};
};

export const RUNNING_TASK_STAGE_ORDER: Record<string, number> = {
	"delta-scope": 0,
	"repository-profile": 1,
	"attack-surface-model": 2,
	"identify-target": 3,
	"scan-target": 4,
	"analyze-finding": 5,
	"critique-finding": 6,
	"verify-finding": 7,
	"triage-finding": 8,
	"research-scope": 9,
	"surface-map": 10,
	"track-plan": 11,
	"vulnerability-discovery": 12,
	"track-review": 13,
	"finding-validation": 14,
	"finding-review": 15,
	"chain-synthesis": 16,
	"chain-review": 17,
	"exploit-validation": 18,
	"exploit-review": 19,
	"research-report": 20,
	"goal-craft": 21,
	"goal-surface": 22,
	"goal-hunt": 23,
	"goal-judge": 24,
	"goal-dedup": 25,
	orchestrator: 26,
	hunter: 27,
};

export const TASK_STAGE_OPTION_BY_STAGE_NAME: Record<string, string> = {
	"delta-scope": "delta-scope",
	"repository-profile": "repository-profile",
	"attack-surface-model": "attack-surface-model",
	"identify-target": "identify-target",
	"scan-target": "scan-target",
	"analyze-finding": "analyze-finding",
	"critique-finding": "critique-finding",
	"verify-finding": "verify-finding",
	"triage-finding": "triage-finding",
};

export const normalizeTaskStageOption = (stage?: string | null) => {
	if (!stage) {
		return null;
	}
	return (
		TASK_STAGE_OPTION_BY_STAGE_NAME[stage] ||
		(stage in RUNNING_TASK_STAGE_ORDER ? stage : null)
	);
};

export const TASK_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
