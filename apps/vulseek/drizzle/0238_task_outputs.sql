-- TaskOutput-driven dispatch. Old-protocol jobs must be stopped first.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "scan_jobs"
		WHERE "status"::text IN ('pending', 'running', 'paused', 'finalizing')
	) THEN
		RAISE EXCEPTION
			'Cannot migrate to task_outputs while old-protocol jobs are still pending, running, paused, or finalizing; stop or cancel them first';
	END IF;
END $$;

DO $$ BEGIN
	CREATE TYPE "taskLifecycle" AS ENUM ('turn', 'goal');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
	CREATE TYPE "taskOutputDispatchStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "task_outputs" (
	"taskOutputId" text PRIMARY KEY NOT NULL,
	"producerTaskId" text NOT NULL REFERENCES "tasks"("taskId") ON DELETE cascade,
	"sequence" integer NOT NULL,
	"submissionKey" text NOT NULL,
	"routeKey" text,
	"output" jsonb NOT NULL,
	"dispatchStatus" "taskOutputDispatchStatus" NOT NULL DEFAULT 'pending',
	"dispatchAttempt" integer NOT NULL DEFAULT 0,
	"claimedAt" text,
	"dispatchedAt" text,
	"errorMessage" text,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "task_outputs_producer_sequence_unique"
	ON "task_outputs" ("producerTaskId", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "task_outputs_producer_submission_unique"
	ON "task_outputs" ("producerTaskId", "submissionKey");
CREATE INDEX IF NOT EXISTS "task_outputs_producer_dispatch_idx"
	ON "task_outputs" ("producerTaskId", "dispatchStatus", "sequence");
CREATE INDEX IF NOT EXISTS "task_outputs_dispatch_status_idx"
	ON "task_outputs" ("dispatchStatus", "createdAt");

ALTER TABLE "tasks"
	ADD COLUMN IF NOT EXISTS "lifecycle" "taskLifecycle" NOT NULL DEFAULT 'turn',
	ADD COLUMN IF NOT EXISTS "sourceTaskOutputId" text,
	ADD COLUMN IF NOT EXISTS "sourceEdgeName" text,
	ADD COLUMN IF NOT EXISTS "sourceItemIndex" integer,
	ADD COLUMN IF NOT EXISTS "rerunOfTaskId" text;

DO $$ BEGIN
	ALTER TABLE "tasks"
		ADD CONSTRAINT "tasks_rerun_of_task_fk"
		FOREIGN KEY ("rerunOfTaskId") REFERENCES "tasks"("taskId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

-- Goal stages from the immutable job snapshot.
UPDATE "tasks" AS t
SET "lifecycle" = 'goal'
FROM "scan_jobs" AS j
WHERE t."scanJobId" = j."scanJobId"
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements(
			COALESCE(j."scanPipelineDefinitionSnapshot"->'stages', '[]'::jsonb)
		) AS stage
		WHERE stage->>'id' = t."stageName"
			AND COALESCE((stage->>'goal')::boolean, false)
	);

-- Historical non-null tasks.output becomes sequence-1 completed TaskOutput.
-- Do not read downstreamRouteKey: backfilled outputs are never replayed, and
-- a retried migrate may already have dropped that column.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'tasks'
			AND column_name = 'output'
	) THEN
		EXECUTE $sql$
			INSERT INTO "task_outputs" (
				"taskOutputId",
				"producerTaskId",
				"sequence",
				"submissionKey",
				"routeKey",
				"output",
				"dispatchStatus",
				"dispatchAttempt",
				"dispatchedAt",
				"createdAt",
				"updatedAt"
			)
			SELECT
				'tol' || substr(md5(t."taskId"), 1, 16),
				t."taskId",
				1,
				'legacy:' || t."taskId",
				NULL,
				t."output",
				'completed',
				1,
				COALESCE(t."completedAt", t."updatedAt"),
				COALESCE(t."completedAt", t."createdAt"),
				t."updatedAt"
			FROM "tasks" AS t
			WHERE t."output" IS NOT NULL
			ON CONFLICT ("producerTaskId", "sequence") DO NOTHING
		$sql$;
	END IF;
END $$;

-- Reconstruct downstream identity from parentTaskId + sibling order.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'tasks'
			AND column_name = 'parentTaskId'
	) THEN
		EXECUTE $sql$
			WITH ranked_children AS (
				SELECT
					c."taskId",
					legacy."taskOutputId" AS source_output_id,
					'legacy'::text AS source_edge_name,
					(row_number() OVER (
						PARTITION BY c."parentTaskId"
						ORDER BY c."createdAt", c."taskId"
					) - 1)::integer AS source_item_index
				FROM "tasks" AS c
				INNER JOIN "task_outputs" AS legacy
					ON legacy."producerTaskId" = c."parentTaskId"
					AND legacy."sequence" = 1
				WHERE c."parentTaskId" IS NOT NULL
			)
			UPDATE "tasks" AS t
			SET
				"sourceTaskOutputId" = ranked_children.source_output_id,
				"sourceEdgeName" = ranked_children.source_edge_name,
				"sourceItemIndex" = ranked_children.source_item_index
			FROM ranked_children
			WHERE t."taskId" = ranked_children."taskId"
		$sql$;
	END IF;
END $$;

ALTER TABLE "vulnerability_candidates"
	ADD COLUMN IF NOT EXISTS "taskOutputId" text;

UPDATE "vulnerability_candidates" AS c
SET "taskOutputId" = o."taskOutputId"
FROM "task_outputs" AS o
WHERE o."producerTaskId" = c."producerTaskId"
	AND o."sequence" = 1
	AND c."taskOutputId" IS NULL;

DO $$ BEGIN
	ALTER TABLE "vulnerability_candidates"
		ADD CONSTRAINT "vulnerability_candidates_task_output_fk"
		FOREIGN KEY ("taskOutputId") REFERENCES "task_outputs"("taskOutputId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "vulnerability_candidates_task_output_idx"
	ON "vulnerability_candidates" ("taskOutputId");

ALTER TABLE "candidate_result_projections"
	ADD COLUMN IF NOT EXISTS "analysisTaskOutputId" text,
	ADD COLUMN IF NOT EXISTS "verificationTaskOutputId" text,
	ADD COLUMN IF NOT EXISTS "triageTaskOutputId" text;

UPDATE "candidate_result_projections" AS p
SET "analysisTaskOutputId" = o."taskOutputId"
FROM "task_outputs" AS o
WHERE o."producerTaskId" = p."analysisTaskId"
	AND o."sequence" = 1
	AND p."analysisTaskOutputId" IS NULL;

UPDATE "candidate_result_projections" AS p
SET "verificationTaskOutputId" = o."taskOutputId"
FROM "task_outputs" AS o
WHERE o."producerTaskId" = p."verificationTaskId"
	AND o."sequence" = 1
	AND p."verificationTaskOutputId" IS NULL;

UPDATE "candidate_result_projections" AS p
SET "triageTaskOutputId" = o."taskOutputId"
FROM "task_outputs" AS o
WHERE o."producerTaskId" = p."triageTaskId"
	AND o."sequence" = 1
	AND p."triageTaskOutputId" IS NULL;

ALTER TABLE "research_findings"
	ADD COLUMN IF NOT EXISTS "taskOutputId" text;

UPDATE "research_findings" AS f
SET "taskOutputId" = o."taskOutputId"
FROM "task_outputs" AS o
WHERE o."producerTaskId" = f."producerTaskId"
	AND o."sequence" = 1
	AND f."taskOutputId" IS NULL;

DO $$ BEGIN
	ALTER TABLE "research_findings"
		ADD CONSTRAINT "research_findings_task_output_fk"
		FOREIGN KEY ("taskOutputId") REFERENCES "task_outputs"("taskOutputId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "tob_goal_candidates"
	ADD COLUMN IF NOT EXISTS "taskOutputId" text;

UPDATE "tob_goal_candidates" AS c
SET "taskOutputId" = o."taskOutputId"
FROM "task_outputs" AS o
WHERE o."producerTaskId" = c."huntTaskId"
	AND o."sequence" = 1
	AND c."taskOutputId" IS NULL;

DO $$ BEGIN
	ALTER TABLE "tob_goal_candidates"
		ADD CONSTRAINT "tob_goal_candidates_task_output_fk"
		FOREIGN KEY ("taskOutputId") REFERENCES "task_outputs"("taskOutputId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "tob_goal_findings"
	ADD COLUMN IF NOT EXISTS "taskOutputId" text;

DO $$ BEGIN
	ALTER TABLE "tob_goal_findings"
		ADD CONSTRAINT "tob_goal_findings_task_output_fk"
		FOREIGN KEY ("taskOutputId") REFERENCES "task_outputs"("taskOutputId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

-- Rewrite job outputs provenance from taskId to taskOutputId.
UPDATE "scan_jobs" AS j
SET "outputs" = COALESCE((
	SELECT jsonb_agg(
		CASE
			WHEN item ? 'taskOutputId' THEN item
			WHEN item ? 'taskId' THEN
				item
				- 'taskId'
				|| jsonb_build_object(
					'taskOutputId',
					COALESCE(
						(
							SELECT o."taskOutputId"
							FROM "task_outputs" AS o
							WHERE o."producerTaskId" = item->>'taskId'
								AND o."sequence" = 1
						),
						'tol' || substr(md5(item->>'taskId'), 1, 16)
					)
				)
			ELSE item
		END
	)
	FROM jsonb_array_elements(COALESCE(j."outputs", '[]'::jsonb)) AS item
), '[]'::jsonb);

CREATE INDEX IF NOT EXISTS "tasks_source_task_output_idx"
	ON "tasks" ("sourceTaskOutputId");
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_source_identity_unique"
	ON "tasks" ("sourceTaskOutputId", "sourceEdgeName", "sourceItemIndex")
	WHERE "sourceTaskOutputId" IS NOT NULL AND "rerunOfTaskId" IS NULL;
CREATE INDEX IF NOT EXISTS "tasks_rerun_of_task_idx"
	ON "tasks" ("rerunOfTaskId");

DO $$ BEGIN
	ALTER TABLE "tasks"
		ADD CONSTRAINT "tasks_source_task_output_fk"
		FOREIGN KEY ("sourceTaskOutputId") REFERENCES "task_outputs"("taskOutputId")
		ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "tasks"
	DROP COLUMN IF EXISTS "vulnerabilityCandidateId",
	DROP COLUMN IF EXISTS "parentTaskId",
	DROP COLUMN IF EXISTS "downstreamDispatchStatus",
	DROP COLUMN IF EXISTS "downstreamRouteKey",
	DROP COLUMN IF EXISTS "downstreamDispatchedAt",
	DROP COLUMN IF EXISTS "dispatchKey",
	DROP COLUMN IF EXISTS "forkedFromThreadId",
	DROP COLUMN IF EXISTS "input",
	DROP COLUMN IF EXISTS "output",
	DROP COLUMN IF EXISTS "exitReason",
	DROP COLUMN IF EXISTS "exitNote";
