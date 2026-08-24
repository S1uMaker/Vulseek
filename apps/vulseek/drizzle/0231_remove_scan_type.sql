-- Unify scan jobs on the organization pipeline primary key.
-- This migration intentionally removes legacy scan mode compatibility.

-- Backfill Dataset Evaluations from the old selector before dropping it.
UPDATE "dataset_evaluations" e
SET "pipelineId" = p."pipelineId"
FROM "datasets" d, "scan_pipelines" p
WHERE e."datasetId" = d."datasetId"
  AND p."organizationId" = d."organizationId"
  AND p."systemKey" = e."legacyPipelineKey"
  AND e."pipelineId" IS NULL
  AND e."legacyPipelineKey" IS NOT NULL;

-- Remove evaluations whose legacy selector cannot be mapped. Cascades remove
-- their trials; the trial-to-scan-job FK then nulls the detached job target.
DELETE FROM "dataset_evaluations" e
WHERE e."pipelineId" IS NULL;

-- Backfill ordinary Scan Jobs through their target's organization.
UPDATE "scan_jobs" sj
SET "pipelineId" = p."pipelineId"
FROM "scan_pipelines" p
WHERE sj."pipelineId" IS NULL
  AND p."systemKey" = sj."scanType"::text
  AND p."organizationId" = COALESCE(
    (
      SELECT pr."organizationId"
      FROM "application" a
      JOIN "environment" env ON env."environmentId" = a."environmentId"
      JOIN "project" pr ON pr."projectId" = env."projectId"
      WHERE a."applicationId" = sj."applicationId"
    ),
    (
      SELECT pr."organizationId"
      FROM "compose" c
      JOIN "environment" env ON env."environmentId" = c."environmentId"
      JOIN "project" pr ON pr."projectId" = env."projectId"
      WHERE c."composeId" = sj."composeId"
    ),
    (
      SELECT d."organizationId"
      FROM "dataset_evaluation_trials" tr
      JOIN "dataset_evaluations" e ON e."evaluationId" = tr."evaluationId"
      JOIN "datasets" d ON d."datasetId" = e."datasetId"
      WHERE tr."trialId" = sj."datasetEvaluationTrialId"
    )
  );

-- Do not delete unmapped jobs. If backfill could not set pipelineId, leave
-- the rows in place and keep pipelineId nullable.
ALTER TABLE "scan_jobs"
  DROP CONSTRAINT IF EXISTS "scan_jobs_pipelineId_scan_pipelines_pipelineId_fk";
ALTER TABLE "scan_jobs"
  ADD CONSTRAINT "scan_jobs_pipelineId_scan_pipelines_pipelineId_fk"
  FOREIGN KEY ("pipelineId") REFERENCES "scan_pipelines"("pipelineId") ON DELETE restrict;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "scan_jobs" WHERE "pipelineId" IS NULL
  ) THEN
    ALTER TABLE "scan_jobs" ALTER COLUMN "pipelineId" SET NOT NULL;
  END IF;
END $$;

ALTER TABLE "scan_jobs" DROP COLUMN "scanType";
DROP TYPE IF EXISTS "scanType";

ALTER TABLE "dataset_evaluations" DROP COLUMN IF EXISTS "legacyPipelineKey";
