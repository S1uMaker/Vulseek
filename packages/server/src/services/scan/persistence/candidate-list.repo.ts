import { db } from "@vulseek/server/db";
import {
	candidateMetadata,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import {
	and,
	asc,
	count,
	desc,
	eq,
	ilike,
	inArray,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
	analysisSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import type { AnalysisResult, TriageResult, VerificationResult } from "../types";
import { toCandidateRecord } from "./candidate.repo";

export type CandidateListInput = {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	analysisResults?: string[];
	verifyResults?: string[];
	triageResults?: string[];
	sortKey:
		| "latestResultUpdatedAt"
		| "createdAt"
		| "candidate"
		| "analysis"
		| "verify"
		| "score";
	sortDirection: "asc" | "desc";
};

const analysisTask = alias(tasks, "candidate_analysis_task");
const verificationTask = alias(tasks, "candidate_verification_task");
const triageTask = alias(tasks, "candidate_triage_task");

const buildConditions = (input: CandidateListInput) => {
	const conditions = [eq(vulnerabilityCandidates.scanJobId, input.scanJobId)];
	if (input.analysisResults && input.analysisResults.length > 0) {
		conditions.push(
			inArray(vulnerabilityCandidates.analysisResult, input.analysisResults),
		);
	}
	if (input.verifyResults && input.verifyResults.length > 0) {
		conditions.push(
			inArray(
				vulnerabilityCandidates.verificationResult,
				input.verifyResults,
			),
		);
	}
	if (input.triageResults && input.triageResults.length > 0) {
		conditions.push(
			inArray(vulnerabilityCandidates.triageResult, input.triageResults),
		);
	}

	const query = input.query?.trim().toLowerCase();
	if (query) {
		const searchText = sql<string>`lower(concat_ws(E'\\n',
			${vulnerabilityCandidates.title},
			${vulnerabilityCandidates.description},
			${candidateMetadata.note},
			${candidateMetadata.tags}::text,
			${vulnerabilityCandidates.filePath},
			${vulnerabilityCandidates.line}::text,
			${vulnerabilityCandidates.analysisResult},
			${vulnerabilityCandidates.analysisOutput}->>'reportPath',
			${vulnerabilityCandidates.analysisOutput}->>'threadId',
			${vulnerabilityCandidates.verificationResult},
			${vulnerabilityCandidates.verificationOutput}->>'confidence',
			${vulnerabilityCandidates.verificationOutput}->>'score',
			${vulnerabilityCandidates.verificationOutput}->>'reportPath',
			${vulnerabilityCandidates.verificationOutput}->>'threadId',
			${vulnerabilityCandidates.triageResult},
			${vulnerabilityCandidates.triageOutput}->>'disqualifier',
			${vulnerabilityCandidates.triageOutput}->>'disqualifierReason',
			${vulnerabilityCandidates.triageOutput}->>'securityClassification',
			${vulnerabilityCandidates.triageOutput}->>'impactType',
			${vulnerabilityCandidates.triageOutput}->>'cvssSeverity',
			${vulnerabilityCandidates.triageOutput}->>'cvssScore',
			${vulnerabilityCandidates.triageOutput}->>'epssProbability30d',
			${vulnerabilityCandidates.triageOutput}->>'reportPath',
			${vulnerabilityCandidates.score}::text
		))`;
		conditions.push(ilike(searchText, `%${query}%`));
	}
	return conditions;
};

const buildOrderBy = (input: CandidateListInput) => {
	const direction = input.sortDirection === "asc" ? asc : desc;
	const order = (() => {
		switch (input.sortKey) {
			case "createdAt":
				return vulnerabilityCandidates.createdAt;
			case "candidate":
				return sql`lower(${vulnerabilityCandidates.title})`;
			case "analysis":
				return sql`coalesce(${vulnerabilityCandidates.analysisRank}, -1)`;
			case "verify":
				return sql`coalesce(${vulnerabilityCandidates.verificationRank}, -1)`;
			case "score":
				return sql`coalesce(${vulnerabilityCandidates.score}, -1)`;
			default:
				return sql`coalesce(${vulnerabilityCandidates.latestResultAt}, ${vulnerabilityCandidates.createdAt})`;
		}
	})();
	return [
		direction(order),
		direction(vulnerabilityCandidates.title),
		asc(vulnerabilityCandidates.vulnerabilityCandidateId),
	];
};

type CandidateRow = {
	candidate: typeof vulnerabilityCandidates.$inferSelect;
	metadata: typeof candidateMetadata.$inferSelect | null;
	analysisTask: typeof analysisTask.$inferSelect | null;
	verificationTask: typeof verificationTask.$inferSelect | null;
	triageTask: typeof triageTask.$inferSelect | null;
};

const buildCandidateListItem = (row: CandidateRow) => {
	const candidate = toCandidateRecord(row.candidate, row.metadata ?? undefined);
	return {
		...candidate,
		latestAnalysisResult: buildAnalysisResult(row),
		latestVerificationResult: buildVerificationResult(row),
		latestTriageResult: buildTriageResult(row),
	};
};

const buildAnalysisResult = (row: CandidateRow): AnalysisResult | null => {
	if (!row.candidate.analysisOutput) {
		return null;
	}
	const parsed = analysisSchema.safeParse(row.candidate.analysisOutput);
	if (!parsed.success || !row.candidate.analysisTaskId) {
		return null;
	}
	return {
		taskId: row.candidate.analysisTaskId,
		scanJobId: row.candidate.scanJobId,
		vulnerabilityCandidateId: row.candidate.vulnerabilityCandidateId,
		producerTaskId: row.candidate.producerTaskId,
		result: parsed.data.result,
		confidence: parsed.data.confidence,
		score: parsed.data.score,
		reportPath: parsed.data.reportPath,
		runtimeSeconds: parsed.data.runtimeSeconds,
		threadId: row.analysisTask?.threadId ?? null,
		summary: parsed.data.summary,
		createdAt:
			row.analysisTask?.createdAt ??
			row.candidate.analysisResultAt ??
			row.candidate.createdAt,
		updatedAt:
			row.analysisTask?.updatedAt ??
			row.candidate.analysisResultAt ??
			row.candidate.updatedAt,
		status: parsed.data.status ?? row.analysisTask?.status,
	};
};

const buildVerificationResult = (
	row: CandidateRow,
): VerificationResult | null => {
	if (!row.candidate.verificationOutput) {
		return null;
	}
	const parsed = verificationSchema.safeParse(row.candidate.verificationOutput);
	if (!parsed.success || !row.candidate.verificationTaskId) {
		return null;
	}
	return {
		taskId: row.candidate.verificationTaskId,
		scanJobId: row.candidate.scanJobId,
		vulnerabilityCandidateId: row.candidate.vulnerabilityCandidateId,
		producerTaskId: row.candidate.producerTaskId,
		result: parsed.data.result,
		confidence: parsed.data.confidence,
		score: parsed.data.score,
		reportPath: parsed.data.reportPath,
		runtimeSeconds: parsed.data.runtimeSeconds,
		threadId: row.verificationTask?.threadId ?? null,
		summary: parsed.data.summary,
		createdAt:
			row.verificationTask?.createdAt ??
			row.candidate.verificationResultAt ??
			row.candidate.createdAt,
		updatedAt:
			row.verificationTask?.updatedAt ??
			row.candidate.verificationResultAt ??
			row.candidate.updatedAt,
		status: parsed.data.status ?? row.verificationTask?.status,
	};
};

const buildTriageResult = (row: CandidateRow): TriageResult | null => {
	if (!row.candidate.triageOutput) {
		return null;
	}
	const parsed = triageSchema.safeParse(row.candidate.triageOutput);
	if (!parsed.success || !row.candidate.triageTaskId) {
		return null;
	}
	return {
		taskId: row.candidate.triageTaskId,
		scanJobId: row.candidate.scanJobId,
		vulnerabilityCandidateId: row.candidate.vulnerabilityCandidateId,
		producerTaskId: row.candidate.producerTaskId,
		result: parsed.data.result,
		disqualifier: parsed.data.disqualifier,
		disqualifierReason: parsed.data.disqualifierReason,
		securityClassification: parsed.data.securityClassification,
		isSecurityIssue: parsed.data.isSecurityIssue,
		impactType: parsed.data.impactType,
		cvssVector: parsed.data.cvssVector,
		cvssScore: parsed.data.cvssScore,
		cvssSeverity: parsed.data.cvssSeverity,
		exploitability: parsed.data.exploitability,
		isExploitable: parsed.data.isExploitable,
		commonTriggerConditions: parsed.data.commonTriggerConditions,
		hardeningOrRobustness: parsed.data.hardeningOrRobustness,
		epssProbability30d: parsed.data.epssProbability30d,
		epssSource: parsed.data.epssSource,
		confidence: null,
		score: parsed.data.cvssScore,
		reportPath: parsed.data.reportPath,
		runtimeSeconds: parsed.data.runtimeSeconds,
		threadId: row.triageTask?.threadId ?? null,
		summary: parsed.data.summary,
		createdAt:
			row.triageTask?.createdAt ??
			row.candidate.triageResultAt ??
			row.candidate.createdAt,
		updatedAt:
			row.triageTask?.updatedAt ??
			row.candidate.triageResultAt ??
			row.candidate.updatedAt,
		status: parsed.data.status ?? row.triageTask?.status,
	};
};

const fromCandidates = () =>
	db
		.select({
			candidate: vulnerabilityCandidates,
			metadata: candidateMetadata,
			analysisTask,
			verificationTask,
			triageTask,
		})
		.from(vulnerabilityCandidates)
		.leftJoin(
			candidateMetadata,
			and(
				eq(candidateMetadata.scanJobId, vulnerabilityCandidates.scanJobId),
				eq(
					candidateMetadata.vulnerabilityCandidateId,
					vulnerabilityCandidates.vulnerabilityCandidateId,
				),
			),
		)
		.leftJoin(
			analysisTask,
			eq(analysisTask.taskId, vulnerabilityCandidates.analysisTaskId),
		)
		.leftJoin(
			verificationTask,
			eq(verificationTask.taskId, vulnerabilityCandidates.verificationTaskId),
		)
		.leftJoin(
			triageTask,
			eq(triageTask.taskId, vulnerabilityCandidates.triageTaskId),
		);

export const findCandidatePageRepo = async (input: CandidateListInput) => {
	const conditions = buildConditions(input);
	const totalRow = await db
		.select({ count: count() })
		.from(vulnerabilityCandidates)
		.leftJoin(
			candidateMetadata,
			and(
				eq(candidateMetadata.scanJobId, vulnerabilityCandidates.scanJobId),
				eq(
					candidateMetadata.vulnerabilityCandidateId,
					vulnerabilityCandidates.vulnerabilityCandidateId,
				),
			),
		)
		.where(and(...conditions))
		.then((rows) => rows[0]?.count ?? 0);

	const pageSize = Math.max(1, Math.min(100, input.pageSize));
	const total = Number(totalRow);
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(Math.max(1, input.page), totalPages);
	const rows = await fromCandidates()
		.where(and(...conditions))
		.orderBy(...buildOrderBy(input))
		.limit(pageSize)
		.offset((page - 1) * pageSize);

	return {
		items: rows.map(buildCandidateListItem),
		total,
		page,
		pageSize,
		totalPages,
	};
};

export const listCandidateItemsByScanJobIdRepo = async (scanJobId: string) => {
	const items: Array<
		Awaited<ReturnType<typeof findCandidatePageRepo>>["items"][number]
	> = [];
	let page = 1;
	let totalPages = 1;
	while (page <= totalPages) {
		const result = await findCandidatePageRepo({
			scanJobId,
			page,
			pageSize: 100,
			sortKey: "createdAt",
			sortDirection: "asc",
		});
		items.push(...result.items);
		totalPages = result.totalPages;
		page += 1;
	}
	return items;
};

export const findCandidateByIdWithResultsRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	producerTaskId?: string;
}) => {
	const conditions = [
		eq(vulnerabilityCandidates.scanJobId, input.scanJobId),
		eq(
			vulnerabilityCandidates.vulnerabilityCandidateId,
			input.vulnerabilityCandidateId,
		),
	];
	if (input.producerTaskId) {
		conditions.push(
			eq(vulnerabilityCandidates.producerTaskId, input.producerTaskId),
		);
	}

	const row = await fromCandidates()
		.where(and(...conditions))
		.limit(1)
		.then((rows) => rows[0] || null);

	return row ? buildCandidateListItem(row) : null;
};
