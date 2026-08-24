-- Pipelines are no longer classified as system vs user.
DROP INDEX IF EXISTS "scan_pipelines_system_key_unique";
ALTER TABLE "scan_pipelines" DROP COLUMN IF EXISTS "systemKey";
ALTER TABLE "scan_pipeline_versions" DROP COLUMN IF EXISTS "source";
DROP TYPE IF EXISTS "scanPipelineVersionSource";
