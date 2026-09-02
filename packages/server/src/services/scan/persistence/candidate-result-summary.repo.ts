import { db } from "@vulseek/server/db";
import { vulnerabilityCandidates } from "@vulseek/server/db/schema";
import { eq, sql } from "drizzle-orm";
import type { CandidateResultSummaryGroup } from "./candidate-result-summary";

export const listCandidateResultSummaryGroupsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<CandidateResultSummaryGroup[]> =>
	await db
		.select({
			analysisResult: vulnerabilityCandidates.analysisResult,
			verificationResult: vulnerabilityCandidates.verificationResult,
			triageResult: vulnerabilityCandidates.triageResult,
			count: sql<number>`count(*)::int`,
		})
		.from(vulnerabilityCandidates)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.groupBy(
			vulnerabilityCandidates.analysisResult,
			vulnerabilityCandidates.verificationResult,
			vulnerabilityCandidates.triageResult,
		);
