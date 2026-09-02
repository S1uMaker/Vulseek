ALTER TABLE "scan_jobs"
	ADD COLUMN IF NOT EXISTS "pipelineProfileId" text;

DO $$ BEGIN
	ALTER TABLE "scan_jobs"
		ADD CONSTRAINT "scan_jobs_pipeline_profile_fk"
		FOREIGN KEY ("pipelineProfileId") REFERENCES "scan_pipeline_profiles"("pipelineProfileId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
