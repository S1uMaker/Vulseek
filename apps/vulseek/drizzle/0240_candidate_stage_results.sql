ALTER TABLE "vulnerability_candidates"
	ADD COLUMN IF NOT EXISTS "analysisTaskId" text,
	ADD COLUMN IF NOT EXISTS "analysisMessageId" text,
	ADD COLUMN IF NOT EXISTS "analysisOutput" jsonb,
	ADD COLUMN IF NOT EXISTS "analysisResult" text,
	ADD COLUMN IF NOT EXISTS "analysisRank" integer,
	ADD COLUMN IF NOT EXISTS "analysisResultAt" text,
	ADD COLUMN IF NOT EXISTS "verificationTaskId" text,
	ADD COLUMN IF NOT EXISTS "verificationMessageId" text,
	ADD COLUMN IF NOT EXISTS "verificationOutput" jsonb,
	ADD COLUMN IF NOT EXISTS "verificationResult" text,
	ADD COLUMN IF NOT EXISTS "verificationRank" integer,
	ADD COLUMN IF NOT EXISTS "verificationResultAt" text,
	ADD COLUMN IF NOT EXISTS "triageTaskId" text,
	ADD COLUMN IF NOT EXISTS "triageMessageId" text,
	ADD COLUMN IF NOT EXISTS "triageOutput" jsonb,
	ADD COLUMN IF NOT EXISTS "triageResult" text,
	ADD COLUMN IF NOT EXISTS "triageRank" integer,
	ADD COLUMN IF NOT EXISTS "triageResultAt" text,
	ADD COLUMN IF NOT EXISTS "latestResultAt" text;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.tables
		WHERE table_schema = 'public'
			AND table_name = 'candidate_result_projections'
	) THEN
		UPDATE "vulnerability_candidates" AS vc
		SET
			"analysisTaskId" = p."analysisTaskId",
			"analysisMessageId" = p."analysisMessageId",
			"analysisOutput" = p."analysisOutput",
			"analysisResult" = p."analysisResult",
			"analysisRank" = p."analysisRank",
			"analysisResultAt" = p."analysisResultAt",
			"verificationTaskId" = p."verificationTaskId",
			"verificationMessageId" = p."verificationMessageId",
			"verificationOutput" = p."verificationOutput",
			"verificationResult" = p."verificationResult",
			"verificationRank" = p."verificationRank",
			"verificationResultAt" = p."verificationResultAt",
			"triageTaskId" = p."triageTaskId",
			"triageMessageId" = p."triageMessageId",
			"triageOutput" = p."triageOutput",
			"triageResult" = p."triageResult",
			"triageRank" = p."triageRank",
			"triageResultAt" = p."triageResultAt",
			"latestResultAt" = p."latestResultAt"
		FROM "candidate_result_projections" AS p
		WHERE p."scanJobId" = vc."scanJobId"
			AND p."vulnerabilityCandidateId" = vc."vulnerabilityCandidateId";
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "vulnerability_candidates_analysis_idx"
	ON "vulnerability_candidates" ("scanJobId", "analysisResult");
CREATE INDEX IF NOT EXISTS "vulnerability_candidates_verification_idx"
	ON "vulnerability_candidates" ("scanJobId", "verificationResult");
CREATE INDEX IF NOT EXISTS "vulnerability_candidates_triage_idx"
	ON "vulnerability_candidates" ("scanJobId", "triageResult");
CREATE INDEX IF NOT EXISTS "vulnerability_candidates_latest_result_idx"
	ON "vulnerability_candidates" ("scanJobId", "latestResultAt");

DROP TABLE IF EXISTS "candidate_result_projection_backfills";
DROP TABLE IF EXISTS "candidate_result_projections";
