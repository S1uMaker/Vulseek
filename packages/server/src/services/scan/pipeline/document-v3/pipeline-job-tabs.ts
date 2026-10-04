import { z } from "zod";
import type { PipelineDiagnostic } from "./pipeline-document-v3";

const TAB_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const RESERVED_JOB_TAB_IDS = [
	"overview",
	"tasks",
	"monitoring",
	"files",
] as const;

export const JOB_TAB_RENDERERS = ["entity-table", "candidate-results"] as const;
export const JOB_TAB_DATA_SOURCES = [
	"vulnerability-candidates",
	"research-findings",
	"research-tracks",
	"exploit-primitives",
	"exploit-chains",
	"tob-goal-candidates",
	"tob-goal-findings",
	"ledger-primitives",
] as const;
export const JOB_TAB_DETAILS = [
	"vulnerability-candidate",
	"research-finding",
	"research-track",
	"exploit-primitive",
	"exploit-chain",
	"tob-goal-candidate",
	"tob-goal-finding",
	"ledger-primitive",
] as const;

export type JobTabRenderer = (typeof JOB_TAB_RENDERERS)[number];
export type JobTabDataSource = (typeof JOB_TAB_DATA_SOURCES)[number];
export type JobTabDetail = (typeof JOB_TAB_DETAILS)[number];

export type JobTabDataSourceCatalog = {
	label: string;
	renderers: readonly JobTabRenderer[];
	fields: readonly string[];
	sortable: readonly string[];
	filters: readonly string[];
	details: readonly JobTabDetail[];
};

export const JOB_TAB_DATA_SOURCE_CATALOG: Record<
	JobTabDataSource,
	JobTabDataSourceCatalog
> = {
	"vulnerability-candidates": {
		label: "Vulnerability candidates",
		renderers: ["candidate-results", "entity-table"],
		fields: [
			"title",
			"filePath",
			"line",
			"analysisResult",
			"verificationResult",
			"triageResult",
			"score",
			"createdAt",
			"vulnerabilityType",
		],
		sortable: ["createdAt", "score", "title", "analysisResult", "verificationResult"],
		filters: ["analysisResult", "verificationResult", "triageResult"],
		details: ["vulnerability-candidate"],
	},
	"research-findings": {
		label: "Research findings",
		renderers: ["entity-table"],
		fields: [
			"title",
			"trackKey",
			"vulnerabilityClass",
			"location",
			"status",
			"confidence",
			"updatedAt",
		],
		sortable: [
			"updatedAt",
			"title",
			"trackKey",
			"vulnerabilityClass",
			"location",
			"status",
			"confidence",
		],
		filters: ["status"],
		details: ["research-finding"],
	},
	"research-tracks": {
		label: "Research tracks",
		renderers: ["entity-table"],
		fields: [
			"trackKey",
			"approachFamily",
			"researchIdea",
			"status",
			"iteration",
			"updatedAt",
		],
		sortable: [
			"updatedAt",
			"trackKey",
			"approachFamily",
			"researchIdea",
			"status",
			"iteration",
		],
		filters: ["status"],
		details: ["research-track"],
	},
	"exploit-primitives": {
		label: "Exploit primitives",
		renderers: ["entity-table"],
		fields: ["name", "findingId", "capability", "trustLevel", "status", "updatedAt"],
		sortable: ["updatedAt", "name", "capability", "trustLevel", "status"],
		filters: ["status", "trustLevel"],
		details: ["exploit-primitive"],
	},
	"exploit-chains": {
		label: "Exploit chains",
		renderers: ["entity-table"],
		fields: ["chainKey", "status", "updatedAt"],
		sortable: ["updatedAt", "chainKey", "status"],
		filters: ["status"],
		details: ["exploit-chain"],
	},
	"tob-goal-candidates": {
		label: "Goal candidates",
		renderers: ["entity-table"],
		fields: ["title", "status", "huntGoalId", "summary", "updatedAt"],
		sortable: ["updatedAt", "title", "status"],
		filters: ["status", "huntGoalId"],
		details: ["tob-goal-candidate"],
	},
	"tob-goal-findings": {
		label: "Goal findings",
		renderers: ["entity-table"],
		fields: ["title", "status", "huntGoalId", "summary", "updatedAt"],
		sortable: ["updatedAt", "title", "status"],
		filters: ["status", "huntGoalId"],
		details: ["tob-goal-finding"],
	},
	"ledger-primitives": {
		label: "Ledger",
		renderers: ["entity-table"],
		fields: [
			"id",
			"title",
			"type",
			"state",
			"verdict",
			"statement",
			"primitiveCount",
			"file",
			"line",
			"revision",
			"updatedAt",
			"createdAt",
		],
		sortable: [
			"id",
			"createdAt",
			"updatedAt",
			"title",
			"type",
			"state",
			"verdict",
			"statement",
			"primitiveCount",
			"file",
			"line",
			"revision",
		],
		filters: ["type", "state", "verdict"],
		details: ["ledger-primitive"],
	},
};

const tabIdSchema = z
	.string()
	.regex(TAB_ID_PATTERN, "must be a stable slug (^[a-z][a-z0-9_-]{0,63}$)");

export const pipelineJobTabSchema = z
	.object({
		id: tabIdSchema,
		label: z.string().min(1),
		renderer: z.enum(JOB_TAB_RENDERERS),
		dataSource: z.enum(JOB_TAB_DATA_SOURCES),
		columns: z.array(z.string().min(1)).optional().default([]),
		filters: z.array(z.string().min(1)).optional().default([]),
		defaultSort: z
			.object({
				field: z.string().min(1),
				direction: z.enum(["asc", "desc"]),
			})
			.optional(),
		detail: z.enum(JOB_TAB_DETAILS).optional(),
	})
	.strict();

export const pipelinePresentationSchema = z
	.object({
		jobTabs: z.array(pipelineJobTabSchema).optional().default([]),
	})
	.strict();

export type PipelineJobTab = z.infer<typeof pipelineJobTabSchema>;
export type PipelinePresentation = { jobTabs: PipelineJobTab[] };

export const VULNERABILITY_CANDIDATES_TAB: PipelineJobTab = {
	id: "candidates",
	label: "Candidates",
	renderer: "candidate-results",
	dataSource: "vulnerability-candidates",
	columns: [
		"title",
		"filePath",
		"analysisResult",
		"verificationResult",
		"triageResult",
		"score",
		"createdAt",
	],
	filters: ["analysisResult", "verificationResult", "triageResult"],
	defaultSort: { field: "createdAt", direction: "desc" },
	detail: "vulnerability-candidate",
};

export const RESEARCH_JOB_TABS: PipelineJobTab[] = [
	{
		id: "findings",
		label: "Findings",
		renderer: "entity-table",
		dataSource: "research-findings",
		columns: [
			"title",
			"trackKey",
			"vulnerabilityClass",
			"location",
			"status",
			"confidence",
			"updatedAt",
		],
		filters: ["status"],
		defaultSort: { field: "updatedAt", direction: "desc" },
		detail: "research-finding",
	},
	{
		id: "tracks",
		label: "Tracks",
		renderer: "entity-table",
		dataSource: "research-tracks",
		columns: [
			"trackKey",
			"approachFamily",
			"researchIdea",
			"status",
			"iteration",
			"updatedAt",
		],
		filters: ["status"],
		defaultSort: { field: "updatedAt", direction: "desc" },
		detail: "research-track",
	},
	{
		id: "primitives",
		label: "Primitives",
		renderer: "entity-table",
		dataSource: "exploit-primitives",
		columns: ["name", "findingId", "capability", "trustLevel", "status", "updatedAt"],
		filters: ["status", "trustLevel"],
		defaultSort: { field: "updatedAt", direction: "desc" },
		detail: "exploit-primitive",
	},
	{
		id: "chains",
		label: "Chains",
		renderer: "entity-table",
		dataSource: "exploit-chains",
		columns: ["chainKey", "status", "updatedAt"],
		filters: ["status"],
		defaultSort: { field: "updatedAt", direction: "desc" },
		detail: "exploit-chain",
	},
];

export const LEDGER_PRIMITIVES_TAB: PipelineJobTab = {
	id: "ledger",
	label: "Ledger",
	renderer: "entity-table",
	dataSource: "ledger-primitives",
	columns: [
		"id",
		"title",
		"type",
		"state",
		"verdict",
		"primitiveCount",
		"file",
		"line",
		"revision",
		"updatedAt",
	],
	filters: ["type", "state", "verdict"],
	defaultSort: { field: "updatedAt", direction: "desc" },
	detail: "ledger-primitive",
};

export const TOB_GOAL_JOB_TABS: PipelineJobTab[] = [
	{
		id: "goal-candidates",
		label: "Goal Candidates",
		renderer: "entity-table",
		dataSource: "tob-goal-candidates",
		columns: ["title", "status", "huntGoalId", "summary", "updatedAt"],
		filters: ["status", "huntGoalId"],
		defaultSort: { field: "updatedAt", direction: "desc" },
		detail: "tob-goal-candidate",
	},
	{
		id: "goal-findings",
		label: "Goal Findings",
		renderer: "entity-table",
		dataSource: "tob-goal-findings",
		columns: ["title", "status", "huntGoalId", "summary", "updatedAt"],
		filters: ["status", "huntGoalId"],
		defaultSort: { field: "updatedAt", direction: "desc" },
		detail: "tob-goal-finding",
	},
];

const diagnostic = (
	severity: PipelineDiagnostic["severity"],
	code: string,
	message: string,
	path: Array<string | number>,
): PipelineDiagnostic => ({
	severity,
	code,
	message,
	path,
});

export const collectJobTabDiagnostics = (
	tabs: PipelineJobTab[] | undefined,
): PipelineDiagnostic[] => {
	const diagnostics: PipelineDiagnostic[] = [];
	const seen = new Set<string>();
	for (const [index, tab] of (tabs ?? []).entries()) {
		const path = ["presentation", "jobTabs", index];
		if (RESERVED_JOB_TAB_IDS.includes(tab.id as (typeof RESERVED_JOB_TAB_IDS)[number])) {
			diagnostics.push(
				diagnostic(
					"error",
					"presentation.reserved_tab_id",
					`job tab id "${tab.id}" is reserved`,
					[...path, "id"],
				),
			);
		}
		if (seen.has(tab.id)) {
			diagnostics.push(
				diagnostic(
					"error",
					"presentation.duplicate_tab_id",
					`job tab id "${tab.id}" is duplicated`,
					[...path, "id"],
				),
			);
		}
		seen.add(tab.id);
		const catalog = JOB_TAB_DATA_SOURCE_CATALOG[tab.dataSource];
		if (!catalog.renderers.includes(tab.renderer)) {
			diagnostics.push(
				diagnostic(
					"error",
					"presentation.incompatible_renderer",
					`renderer "${tab.renderer}" is not valid for data source "${tab.dataSource}"`,
					[...path, "renderer"],
				),
			);
		}
		for (const [columnIndex, column] of tab.columns.entries()) {
			if (!catalog.fields.includes(column)) {
				diagnostics.push(
					diagnostic(
						"error",
						"presentation.unknown_column",
						`column "${column}" is not a field of "${tab.dataSource}"`,
						[...path, "columns", columnIndex],
					),
				);
			}
		}
		for (const [filterIndex, filter] of tab.filters.entries()) {
			if (!catalog.filters.includes(filter)) {
				diagnostics.push(
					diagnostic(
						"error",
						"presentation.unknown_filter",
						`filter "${filter}" is not available on "${tab.dataSource}"`,
						[...path, "filters", filterIndex],
					),
				);
			}
		}
		if (tab.defaultSort && !catalog.sortable.includes(tab.defaultSort.field)) {
			diagnostics.push(
				diagnostic(
					"error",
					"presentation.unknown_sort_field",
					`sort field "${tab.defaultSort.field}" is not sortable on "${tab.dataSource}"`,
					[...path, "defaultSort", "field"],
				),
			);
		}
		if (tab.detail && !catalog.details.includes(tab.detail)) {
			diagnostics.push(
				diagnostic(
					"error",
					"presentation.incompatible_detail",
					`detail "${tab.detail}" is not valid for data source "${tab.dataSource}"`,
					[...path, "detail"],
				),
			);
		}
	}
	return diagnostics;
};

type CompiledStageLike = {
	id?: string;
	name?: string;
	effects?: Array<{ type?: string }>;
	runtime?: { plugins?: string[] };
};

const isOrchestratorStage = (stage: CompiledStageLike) =>
	stage.id === "orchestrator" ||
	stage.name?.trim().toLowerCase() === "orchestrator";

export const inferJobTabsFromStages = (
	stages: CompiledStageLike[],
): PipelineJobTab[] => {
	let research = false;
	let tobGoal = false;
	let candidates = false;
	let ledger = false;
	for (const stage of stages) {
		if (isOrchestratorStage(stage)) ledger = true;
		for (const effect of stage.effects ?? []) {
			if (effect.type === "research-registry") research = true;
			if (effect.type === "tob-goal-registry") tobGoal = true;
			if (
				effect.type === "sync-candidates" ||
				effect.type === "project-candidate-result"
			) {
				candidates = true;
			}
		}
		for (const plugin of stage.runtime?.plugins ?? []) {
			if (plugin === "research-track" || plugin === "research-deadline") {
				research = true;
			}
		}
	}
	const tabs: PipelineJobTab[] = [];
	const seen = new Set<string>();
	const push = (items: PipelineJobTab[]) => {
		for (const tab of items) {
			if (seen.has(tab.id)) continue;
			seen.add(tab.id);
			tabs.push(tab);
		}
	};
	if (research) push(RESEARCH_JOB_TABS);
	if (tobGoal) push(TOB_GOAL_JOB_TABS);
	if (candidates) push([VULNERABILITY_CANDIDATES_TAB]);
	if (ledger) push([LEDGER_PRIMITIVES_TAB]);
	return tabs;
};

const normalizeSnapshotStages = (stages: unknown): CompiledStageLike[] => {
	if (Array.isArray(stages)) {
		return stages as CompiledStageLike[];
	}
	if (stages && typeof stages === "object") {
		return Object.entries(stages as Record<string, CompiledStageLike>).map(
			([id, stage]) => ({ ...stage, id: stage.id ?? id }),
		);
	}
	return [];
};

const withLedgerState = (
	values: string[],
	defaults: readonly string[],
) => {
	const normalized = values.length > 0 ? values : [...defaults];
	if (normalized.includes("state")) return normalized;
	const typeIndex = normalized.indexOf("type");
	if (typeIndex < 0) return ["state", ...normalized];
	return [
		...normalized.slice(0, typeIndex + 1),
		"state",
		...normalized.slice(typeIndex + 1),
	];
};

const withLedgerTitle = (values: string[], defaults: readonly string[]) => {
	const normalized = values.length > 0 ? values : [...defaults];
	return normalized.includes("title") ? normalized : ["title", ...normalized];
};

const withPrimitiveCount = (values: string[]) => {
	const replaced = values.map((column) =>
		column === "statement" ? "primitiveCount" : column,
	);
	const seen = new Set<string>();
	return replaced.filter((column) => {
		if (seen.has(column)) return false;
		seen.add(column);
		return true;
	});
};

const normalizeLedgerTab = (tab: PipelineJobTab): PipelineJobTab => {
	if (tab.dataSource !== "ledger-primitives") return tab;
	return {
		...tab,
		columns: withPrimitiveCount([
			"id",
			...withLedgerTitle(
				withLedgerState(tab.columns, LEDGER_PRIMITIVES_TAB.columns).filter(
					(column) => column !== "id",
				),
				LEDGER_PRIMITIVES_TAB.columns,
			),
		]),
		filters: withLedgerState(tab.filters, LEDGER_PRIMITIVES_TAB.filters),
	};
};

const mergeInferredJobTabs = (
	declared: PipelineJobTab[],
	inferred: PipelineJobTab[],
) => {
	const normalizedDeclared = declared.map(normalizeLedgerTab);
	const seen = new Set(normalizedDeclared.map((tab) => tab.id));
	return [
		...normalizedDeclared,
		...inferred.filter((tab) => tab.id === "ledger" && !seen.has(tab.id)),
	];
};

export const jobTabsFromSnapshot = (snapshot: unknown): PipelineJobTab[] => {
	if (!snapshot || typeof snapshot !== "object") {
		return [];
	}
	const record = snapshot as {
		presentation?: { jobTabs?: PipelineJobTab[] };
		stages?: unknown;
	};
	const inferred = inferJobTabsFromStages(normalizeSnapshotStages(record.stages));
	if (Array.isArray(record.presentation?.jobTabs)) {
		return mergeInferredJobTabs(record.presentation.jobTabs, inferred);
	}
	return inferred;
};
