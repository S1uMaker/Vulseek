DO $$ BEGIN
	CREATE TYPE "messageStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "messages" (
	"messageId" text PRIMARY KEY NOT NULL,
	"scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE cascade,
	"sourceTaskId" text NOT NULL REFERENCES "tasks"("taskId") ON DELETE cascade,
	"sequence" integer NOT NULL,
	"submissionKey" text NOT NULL,
	"routeKey" text,
	"payload" jsonb NOT NULL,
	"status" "messageStatus" NOT NULL DEFAULT 'pending',
	"dispatchAttempt" integer NOT NULL DEFAULT 0,
	"claimedAt" text,
	"dispatchedAt" text,
	"errorMessage" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "messages_source_sequence_unique"
	ON "messages" ("sourceTaskId", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "messages_source_submission_unique"
	ON "messages" ("sourceTaskId", "submissionKey");
CREATE INDEX IF NOT EXISTS "messages_source_status_idx"
	ON "messages" ("sourceTaskId", "status", "sequence");
CREATE INDEX IF NOT EXISTS "messages_job_status_idx"
	ON "messages" ("scanJobId", "status", "createdAt");

CREATE TABLE IF NOT EXISTS "scan_job_stage_stats" (
	"scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE cascade,
	"stageName" text NOT NULL,
	"processedMessageCount" integer NOT NULL DEFAULT 0,
	"updatedAt" text NOT NULL,
	PRIMARY KEY ("scanJobId", "stageName")
);

INSERT INTO "messages" (
	"messageId",
	"scanJobId",
	"sourceTaskId",
	"sequence",
	"submissionKey",
	"routeKey",
	"payload",
	"status",
	"dispatchAttempt",
	"claimedAt",
	"dispatchedAt",
	"errorMessage",
	"createdAt",
	"updatedAt"
)
SELECT
	o."taskOutputId",
	t."scanJobId",
	o."producerTaskId",
	o."sequence",
	o."submissionKey",
	o."routeKey",
	o."output",
	o."dispatchStatus"::text::"messageStatus",
	o."dispatchAttempt",
	o."claimedAt",
	o."dispatchedAt",
	o."errorMessage",
	o."createdAt",
	o."updatedAt"
FROM "task_outputs" AS o
INNER JOIN "tasks" AS t ON t."taskId" = o."producerTaskId"
ON CONFLICT ("messageId") DO NOTHING;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sourceMessageId" text;

UPDATE "tasks"
SET "sourceMessageId" = "sourceTaskOutputId"
WHERE "sourceMessageId" IS NULL
	AND "sourceTaskOutputId" IS NOT NULL;

DROP INDEX IF EXISTS "tasks_source_identity_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_source_identity_unique"
	ON "tasks" ("sourceMessageId", "sourceEdgeName", "sourceItemIndex")
	WHERE "sourceMessageId" IS NOT NULL AND "rerunOfTaskId" IS NULL;

DROP INDEX IF EXISTS "tasks_source_task_output_idx";
CREATE INDEX IF NOT EXISTS "tasks_source_message_idx"
	ON "tasks" ("sourceMessageId");

ALTER TABLE "vulnerability_candidates" ADD COLUMN IF NOT EXISTS "messageId" text
	REFERENCES "messages"("messageId") ON DELETE set null;
UPDATE "vulnerability_candidates"
SET "messageId" = "taskOutputId"
WHERE "messageId" IS NULL
	AND "taskOutputId" IS NOT NULL;
DROP INDEX IF EXISTS "vulnerability_candidates_task_output_idx";
CREATE INDEX IF NOT EXISTS "vulnerability_candidates_message_idx"
	ON "vulnerability_candidates" ("messageId");

ALTER TABLE "research_findings" ADD COLUMN IF NOT EXISTS "messageId" text
	REFERENCES "messages"("messageId") ON DELETE set null;
UPDATE "research_findings"
SET "messageId" = "taskOutputId"
WHERE "messageId" IS NULL
	AND "taskOutputId" IS NOT NULL;

ALTER TABLE "tob_goal_candidates" ADD COLUMN IF NOT EXISTS "messageId" text
	REFERENCES "messages"("messageId") ON DELETE set null;
UPDATE "tob_goal_candidates"
SET "messageId" = "taskOutputId"
WHERE "messageId" IS NULL
	AND "taskOutputId" IS NOT NULL;

ALTER TABLE "tob_goal_findings" ADD COLUMN IF NOT EXISTS "messageId" text
	REFERENCES "messages"("messageId") ON DELETE set null;
UPDATE "tob_goal_findings"
SET "messageId" = "taskOutputId"
WHERE "messageId" IS NULL
	AND "taskOutputId" IS NOT NULL;

ALTER TABLE "candidate_result_projections"
	ADD COLUMN IF NOT EXISTS "analysisMessageId" text;
ALTER TABLE "candidate_result_projections"
	ADD COLUMN IF NOT EXISTS "verificationMessageId" text;
ALTER TABLE "candidate_result_projections"
	ADD COLUMN IF NOT EXISTS "triageMessageId" text;

UPDATE "candidate_result_projections"
SET "analysisMessageId" = "analysisTaskOutputId"
WHERE "analysisMessageId" IS NULL
	AND "analysisTaskOutputId" IS NOT NULL;
UPDATE "candidate_result_projections"
SET "verificationMessageId" = "verificationTaskOutputId"
WHERE "verificationMessageId" IS NULL
	AND "verificationTaskOutputId" IS NOT NULL;
UPDATE "candidate_result_projections"
SET "triageMessageId" = "triageTaskOutputId"
WHERE "triageMessageId" IS NULL
	AND "triageTaskOutputId" IS NOT NULL;

ALTER TABLE "vulnerability_candidates" DROP COLUMN IF EXISTS "taskOutputId";
ALTER TABLE "research_findings" DROP COLUMN IF EXISTS "taskOutputId";
ALTER TABLE "tob_goal_candidates" DROP COLUMN IF EXISTS "taskOutputId";
ALTER TABLE "tob_goal_findings" DROP COLUMN IF EXISTS "taskOutputId";
ALTER TABLE "candidate_result_projections" DROP COLUMN IF EXISTS "analysisTaskOutputId";
ALTER TABLE "candidate_result_projections" DROP COLUMN IF EXISTS "verificationTaskOutputId";
ALTER TABLE "candidate_result_projections" DROP COLUMN IF EXISTS "triageTaskOutputId";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "sourceTaskOutputId";

DROP TABLE IF EXISTS "task_outputs";
DROP TYPE IF EXISTS "taskOutputDispatchStatus";
