import { TRPCError } from "@trpc/server";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import { findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId } from "../api/candidate-records";
import { findCandidateProjectionByIdRepo } from "../persistence/candidate-projection-list.repo";
import {
	listExploitChainsPageRepo,
	listExploitPrimitivesPageRepo,
	listResearchTracksPageRepo,
} from "../persistence/research-registry-list.repo";
import {
	findResearchFindingRepo,
	listResearchFindingsPageRepo,
} from "../persistence/research-finding-list.repo";
import {
	listTobGoalCandidatesPageRepo,
	listTobGoalFindingsPageRepo,
} from "../persistence/tob-goal-list.repo";
import { findTobGoalCandidateRepo } from "../persistence/tob-goal-candidate.repo";
import { findTobGoalFindingRepo } from "../persistence/tob-goal-finding.repo";
import { resolveCompiledDefinition } from "../api/pipeline-runs";
import {
	JOB_TAB_DATA_SOURCE_CATALOG,
	jobTabsFromSnapshot,
	type JobTabDataSource,
	type PipelineJobTab,
} from "../pipeline/document-v3/pipeline-job-tabs";


export type JobTabListInput = {
	scanJobId: string;
	tabId: string;
	page?: number;
	pageSize?: number;
	query?: string;
	sortField?: string;
	sortDirection?: "asc" | "desc";
	filters?: Record<string, string[]>;
};

export type JobTabListItem = {
	id: string;
	values: Record<string, unknown>;
};

export type JobTabListResult = {
	tab: PipelineJobTab;
	items: JobTabListItem[];
	total: number;
	page: number;
	pageSize: number;
	filterOptions: Record<string, string[]>;
};

const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export const jobTabsFromCompiledSnapshot = (
	snapshot: unknown,
	yaml?: string | null,
): PipelineJobTab[] => {
	const fromSnapshot = jobTabsFromSnapshot(snapshot);
	if (fromSnapshot.length > 0 || !yaml) {
		return fromSnapshot;
	}
	try {
		return jobTabsFromSnapshot(resolveCompiledDefinition(snapshot, yaml));
	} catch {
		return fromSnapshot;
	}
};

const requireTab = async (input: { scanJobId: string; tabId: string }) => {
	const job = await findScanJobByIdRepo(input.scanJobId);
	const tabs = jobTabsFromCompiledSnapshot(
		job.pipelineCompiledSnapshot,
		job.pipelineYamlSnapshot,
	);
	const tab = tabs.find((item) => item.id === input.tabId);
	if (!tab) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Job tab "${input.tabId}" is not configured on this scan job`,
		});
	}
	return { job, tab };
};

const csv = (values: string[] | undefined) => (values ?? []).join(",");

const pickValues = (row: Record<string, unknown>, columns: string[]) => {
	const values: Record<string, unknown> = {};
	for (const column of columns) {
		values[column] = row[column] ?? null;
	}
	return values;
};

const candidateSortKey = (field: string | undefined) => {
	switch (field) {
		case "title":
			return "candidate" as const;
		case "analysisResult":
			return "analysis" as const;
		case "verificationResult":
			return "verify" as const;
		case "score":
			return "score" as const;
		case "createdAt":
			return "createdAt" as const;
		default:
			return "latestResultUpdatedAt" as const;
	}
};

const resultValue = (value: unknown) => {
	if (value && typeof value === "object" && "result" in value) {
		return (value as { result?: unknown }).result ?? null;
	}
	return value ?? null;
};

const flattenCandidate = (row: Record<string, unknown>) => ({
	title: row.title ?? null,
	filePath: row.filePath ?? row.fileHostPath ?? null,
	line: row.line ?? null,
	analysisResult:
		row.analysisResult ?? resultValue(row.latestAnalysisResult),
	verificationResult:
		row.verificationResult ?? resultValue(row.latestVerificationResult),
	triageResult: row.triageResult ?? resultValue(row.latestTriageResult),
	score: row.score ?? null,
	createdAt: row.createdAt ?? null,
	vulnerabilityType: row.vulnerabilityType ?? null,
});

const flattenFinding = (row: Record<string, unknown>) => {
	const content = asRecord(row.content);
	const location = asRecord(content.location);
	return {
		title: content.title ?? row.findingId ?? null,
		trackKey: row.trackKey ?? null,
		vulnerabilityClass: content.vulnerabilityClass ?? null,
		location: location.filePath ?? null,
		status: row.status ?? null,
		confidence: content.confidence ?? null,
		updatedAt: row.updatedAt ?? null,
	};
};

export const queryJobTabData = async (
	input: JobTabListInput,
): Promise<JobTabListResult> => {
	const { tab } = await requireTab(input);
	const catalog = JOB_TAB_DATA_SOURCE_CATALOG[tab.dataSource];
	const page = Math.max(1, input.page ?? 1);
	const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 20));
	const query = input.query?.trim() ?? "";
	const sortField = input.sortField || tab.defaultSort?.field;
	if (sortField && !catalog.sortable.includes(sortField)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Sort field "${sortField}" is not allowed for this tab`,
		});
	}
	for (const [key, values] of Object.entries(input.filters ?? {})) {
		if (values.length > 0 && !catalog.filters.includes(key)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Filter "${key}" is not allowed for this tab`,
			});
		}
	}
	const columns = tab.columns.length ? tab.columns : [...catalog.fields];
	const source = tab.dataSource as JobTabDataSource;
	const filters = input.filters ?? {};

	if (source === "vulnerability-candidates") {
		const result =
			await findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId({
				scanJobId: input.scanJobId,
				page,
				pageSize,
				query,
				analysisResults: filters.analysisResult,
				verifyResults: filters.verificationResult,
				triageResults: filters.triageResult,
				sortKey: candidateSortKey(sortField),
				sortDirection: input.sortDirection ?? tab.defaultSort?.direction ?? "desc",
			});
		return {
			tab,
			items: result.items.map((item) => {
				const row = flattenCandidate(item as unknown as Record<string, unknown>);
				return {
					id: String(
						(item as { vulnerabilityCandidateId?: string }).vulnerabilityCandidateId ??
							"",
					),
					values: pickValues(row, columns),
				};
			}),
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
			filterOptions: {
				analysisResult: catalog.filters.includes("analysisResult")
					? ["real_vulnerability", "likely_vulnerability", "false_positive"]
					: [],
				verificationResult: ["true", "likely", "false"],
				triageResult: ["confirmed", "needs_review", "not_a_finding"],
			},
		};
	}

	if (source === "research-findings") {
		const result = await listResearchFindingsPageRepo({
			scanJobId: input.scanJobId,
			page,
			pageSize,
			query,
			statuses: filters.status,
			sortKey: sortField,
			sortDirection: input.sortDirection ?? tab.defaultSort?.direction,
		});
		return {
			tab,
			items: result.items.map((item) => ({
				id: item.findingId,
				values: pickValues(
					flattenFinding(item as unknown as Record<string, unknown>),
					columns,
				),
			})),
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
			filterOptions: { status: filters.status ?? [] },
		};
	}

	if (source === "research-tracks") {
		const result = await listResearchTracksPageRepo({
			scanJobId: input.scanJobId,
			page,
			pageSize,
			query,
			statuses: filters.status,
			sortKey: sortField,
			sortDirection: input.sortDirection ?? tab.defaultSort?.direction,
		});
		return {
			tab,
			items: result.items.map((item) => ({
				id: item.trackId,
				values: pickValues(item as unknown as Record<string, unknown>, columns),
			})),
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
			filterOptions: { status: [] },
		};
	}

	if (source === "exploit-primitives") {
		const result = await listExploitPrimitivesPageRepo({
			scanJobId: input.scanJobId,
			page,
			pageSize,
			query,
			statuses: filters.status,
			trustLevels: filters.trustLevel,
			sortKey: sortField,
			sortDirection: input.sortDirection ?? tab.defaultSort?.direction,
		});
		return {
			tab,
			items: result.items.map((item) => ({
				id: item.primitiveId,
				values: pickValues(item as unknown as Record<string, unknown>, columns),
			})),
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
			filterOptions: { status: [], trustLevel: [] },
		};
	}

	if (source === "exploit-chains") {
		const result = await listExploitChainsPageRepo({
			scanJobId: input.scanJobId,
			page,
			pageSize,
			query,
			statuses: filters.status,
			sortKey: sortField,
			sortDirection: input.sortDirection ?? tab.defaultSort?.direction,
		});
		return {
			tab,
			items: result.items.map((item) => ({
				id: item.chainId,
				values: pickValues(item as unknown as Record<string, unknown>, columns),
			})),
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
			filterOptions: { status: [] },
		};
	}

	if (source === "tob-goal-candidates") {
		const result = await listTobGoalCandidatesPageRepo({
			scanJobId: input.scanJobId,
			page,
			pageSize,
			query,
			status: csv(filters.status),
			huntGoalId: csv(filters.huntGoalId),
		});
		return {
			tab,
			items: result.items.map((item) => ({
				id: item.candidateId,
				values: pickValues(
					{
						title: item.title,
						status: item.status,
						huntGoalId: item.huntGoalId,
						summary: item.summary,
						updatedAt: item.updatedAt,
					},
					columns,
				),
			})),
			total: result.total,
			page: result.page,
			pageSize: result.pageSize,
			filterOptions: result.filterOptions,
		};
	}

	const result = await listTobGoalFindingsPageRepo({
		scanJobId: input.scanJobId,
		page,
		pageSize,
		query,
		status: csv(filters.status),
		huntGoalId: csv(filters.huntGoalId),
	});
	return {
		tab,
		items: result.items.map((item) => ({
			id: item.findingId,
			values: pickValues(
				{
					title: item.title,
					status: item.status,
					huntGoalId: item.huntGoalId,
					summary: item.summary,
					updatedAt: item.updatedAt,
				},
				columns,
			),
		})),
		total: result.total,
		page: result.page,
		pageSize: result.pageSize,
		filterOptions: result.filterOptions,
	};
};

export const queryJobTabDetail = async (input: {
	scanJobId: string;
	tabId: string;
	itemId: string;
}) => {
	const { tab } = await requireTab(input);
	if (!tab.detail) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This tab does not define a detail view",
		});
	}
	if (tab.detail === "vulnerability-candidate") {
		const item = await findCandidateProjectionByIdRepo({
			vulnerabilityCandidateId: input.itemId,
			scanJobId: input.scanJobId,
		});
		if (!item) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
		}
		return { tab, id: input.itemId, fields: flattenCandidate(item as unknown as Record<string, unknown>), raw: item };
	}
	if (tab.detail === "research-finding") {
		const item = await findResearchFindingRepo({
			scanJobId: input.scanJobId,
			findingId: input.itemId,
		});
		if (!item) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
		}
		return {
			tab,
			id: input.itemId,
			fields: flattenFinding(item as unknown as Record<string, unknown>),
			raw: item,
		};
	}
	if (tab.detail === "research-track") {
		const page = await listResearchTracksPageRepo({
			scanJobId: input.scanJobId,
			page: 1,
			pageSize: 100,
			query: input.itemId,
		});
		const item = page.items.find((row) => row.trackId === input.itemId) ?? null;
		if (!item) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
		}
		return { tab, id: input.itemId, fields: item, raw: item };
	}
	if (tab.detail === "exploit-primitive") {
		const page = await listExploitPrimitivesPageRepo({
			scanJobId: input.scanJobId,
			page: 1,
			pageSize: 100,
			query: input.itemId,
		});
		const item =
			page.items.find((row) => row.primitiveId === input.itemId) ?? null;
		if (!item) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
		}
		return { tab, id: input.itemId, fields: item, raw: item };
	}
	if (tab.detail === "exploit-chain") {
		const page = await listExploitChainsPageRepo({
			scanJobId: input.scanJobId,
			page: 1,
			pageSize: 100,
			query: input.itemId,
		});
		const item = page.items.find((row) => row.chainId === input.itemId) ?? null;
		if (!item) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
		}
		return { tab, id: input.itemId, fields: item, raw: item };
	}
	if (tab.detail === "tob-goal-candidate") {
		const item = await findTobGoalCandidateRepo({
			scanJobId: input.scanJobId,
			candidateId: input.itemId,
		});
		if (!item) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
		}
		return { tab, id: input.itemId, fields: item, raw: item };
	}
	const item = await findTobGoalFindingRepo({
		scanJobId: input.scanJobId,
		findingId: input.itemId,
	});
	if (!item) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
	}
	return { tab, id: input.itemId, fields: item, raw: item };
};
