import type { TFunction } from "i18next";

export type ScanTranslation = TFunction;

export const scanT = (
	t: ScanTranslation,
	key: string,
	defaultValue: string,
	values?: Record<string, string | number>,
) => String(t(key, { defaultValue, ...values }));

const normalizedKey = (value: string) => value.replace(/_/g, "-");

const titleCase = (value: string) =>
	value.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const STAGE_DEFAULTS: Record<string, string> = {
	"delta-scope": "Delta Scope",
	"repository-profile": "Repository Profile",
	"attack-surface-model": "Attack Surface Model",
	"identify-target": "Identify Target",
	"scan-target": "Scan Target",
	"analyze-finding": "Analyze Finding",
	"critique-finding": "Critique Finding",
	"verify-finding": "Verify Finding",
	"triage-finding": "Triage Finding",
	"research-scope": "Research Scope",
	"surface-map": "Surface Map",
	"track-plan": "Track Plan",
	"vulnerability-discovery": "Vulnerability Discovery",
	"track-review": "Track Review",
	"finding-validation": "Finding Validation",
	"finding-review": "Finding Review",
	"chain-synthesis": "Chain Synthesis",
	"chain-review": "Chain Review",
	"exploit-validation": "Exploit Validation",
	"exploit-review": "Exploit Review",
	"research-report": "Research Report",
	orchestrator: "Orchestrator",
	hunter: "Hunter",
	repository: "Repository",
	module: "Module",
	function: "Function",
};

const STAGE_ALIASES: Record<string, string> = {
	"delta scoping": "delta-scope",
	"repository profile": "repository-profile",
	"repository profiling": "repository-profile",
	"attack surface model": "attack-surface-model",
	"attack surface modeling": "attack-surface-model",
	"identify target": "identify-target",
	"target identification": "identify-target",
	"scan target": "scan-target",
	"target scanning": "scan-target",
	"analyze finding": "analyze-finding",
	"finding analysis": "analyze-finding",
	"critique finding": "critique-finding",
	"finding critique": "critique-finding",
	"verify finding": "verify-finding",
	"finding verification": "verify-finding",
	"triage finding": "triage-finding",
	"finding triage": "triage-finding",
};

export const formatScanStageLabel = (
	t: ScanTranslation,
	stage?: string | null,
) => {
	if (!stage) {
		return "-";
	}
	const normalized = normalizedKey(stage.toLowerCase());
	const canonical =
		STAGE_ALIASES[stage.toLowerCase().replace(/[_-]/g, " ")] || normalized;
	return scanT(
		t,
		`scan.stage.${canonical}`,
		STAGE_DEFAULTS[canonical] || titleCase(stage),
	);
};

const TASK_STATUS_DEFAULTS: Record<string, string> = {
	pending: "Pending",
	queued: "Queued",
	launching: "Launching",
	launched: "Launched",
	starting: "Starting",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
	exited: "Exited",
	canceled: "Canceled",
	paused: "Paused",
	finished: "Finished",
};

export const formatScanStatusLabel = (
	t: ScanTranslation,
	status?: string | null,
) => {
	if (!status) {
		return "-";
	}
	const key = normalizedKey(status.toLowerCase());
	return scanT(
		t,
		`scan.status.${key}`,
		TASK_STATUS_DEFAULTS[key] || titleCase(status),
	);
};

const SCAN_JOB_STATUS_DEFAULTS: Record<string, string> = {
	pending: "Pending",
	running: "Running",
	paused: "Paused",
	finalizing: "Finalizing",
	finished: "Finished",
	partially_finished: "Partially finished",
	failed: "Failed",
	canceled: "Canceled",
};

export const isTerminalScanJobStatus = (status?: string | null) =>
	status === "finished" ||
	status === "partially_finished" ||
	status === "failed" ||
	status === "canceled";

export const formatScanJobStatusLabel = (
	t: ScanTranslation,
	status?: string | null,
) => {
	if (!status) {
		return "-";
	}
	const key = normalizedKey(status.toLowerCase());
	return scanT(
		t,
		`scan.jobStatus.${key}`,
		SCAN_JOB_STATUS_DEFAULTS[key] || titleCase(status),
	);
};

const ANALYSIS_RESULT_DEFAULTS: Record<string, string> = {
	real_vulnerability: "Real",
	likely_vulnerability: "Likely",
	plausible_but_unproven: "Plausible",
	false_positive: "False",
	api_misuse: "Misuse",
};

export const formatAnalysisResultLabel = (
	t: ScanTranslation,
	result?: string | null,
) => {
	if (!result) {
		return "-";
	}
	return scanT(
		t,
		`scan.analysisResult.${result}`,
		ANALYSIS_RESULT_DEFAULTS[result] || titleCase(result),
	);
};

const TRUTH_RESULT_DEFAULTS: Record<string, string> = {
	true: "True",
	likely: "Likely",
	false: "False",
};

export const formatTruthResultLabel = (
	t: ScanTranslation,
	result?: string | null,
) => {
	if (!result) {
		return "-";
	}
	return scanT(
		t,
		`scan.truthResult.${result}`,
		TRUTH_RESULT_DEFAULTS[result] || titleCase(result),
	);
};

const TRIAGE_RESULT_DEFAULTS: Record<string, string> = {
	security_issue: "Security Issue",
	non_security: "Non Security",
	hardening: "Hardening",
	needs_review: "Needs Review",
};

export const formatTriageResultLabel = (
	t: ScanTranslation,
	result?: string | null,
) => {
	if (!result) {
		return "-";
	}
	return scanT(
		t,
		`scan.triageResult.${result}`,
		TRIAGE_RESULT_DEFAULTS[result] || titleCase(result),
	);
};

export type ScanJobPipelineKind = "full" | "delta" | "research" | "tob-goal";

export const resolveScanJobPipelineKind = (job: {
	pipelineSlug?: string | null;
} | null | undefined): ScanJobPipelineKind => {
	if (job?.pipelineSlug === "delta") return "delta";
	if (job?.pipelineSlug === "research") return "research";
	if (job?.pipelineSlug === "tob-goal") return "tob-goal";
	return "full";
};

export const formatPipelineKindLabel = (
	t: ScanTranslation,
	kind: ScanJobPipelineKind,
) =>
	kind === "delta"
		? scanT(t, "scan.scanType.delta", "Delta Scan")
		: kind === "research"
			? scanT(t, "scan.scanType.research", "Research Scan")
			: kind === "tob-goal"
				? scanT(t, "scan.scanType.goal", "Goal Scan")
				: scanT(t, "scan.scanType.full", "Full Scan");

export const formatResourceTypeLabel = (
	t: ScanTranslation,
	resourceType: "application" | "compose",
) =>
	resourceType === "application"
		? scanT(t, "scan.resource.application", "application")
		: scanT(t, "scan.resource.compose", "compose");
