DO $$ BEGIN
 CREATE TYPE "public"."scanLedgerEntryType" AS ENUM('source', 'sink', 'gate', 'connector', 'impact', 'hypothesis');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 CREATE TYPE "public"."scanLedgerVerdict" AS ENUM('unknown', 'supported', 'refuted', 'contested');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "scan_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"applicationId" text,
	"composeId" text,
	"projectId" text,
	"sourceJobId" text NOT NULL,
	"repoId" text NOT NULL,
	"snapshotId" text NOT NULL,
	"type" "scanLedgerEntryType" NOT NULL,
	"statement" text NOT NULL,
	"verdict" "scanLedgerVerdict" DEFAULT 'unknown' NOT NULL,
	"assessment" jsonb,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" text NOT NULL,
	"updatedBy" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "scan_ledger_entries_org_repo_snapshot_idx" ON "scan_ledger_entries" ("organizationId","repoId","snapshotId");
CREATE INDEX IF NOT EXISTS "scan_ledger_entries_type_verdict_idx" ON "scan_ledger_entries" ("type","verdict");
CREATE INDEX IF NOT EXISTS "scan_ledger_entries_app_snapshot_idx" ON "scan_ledger_entries" ("applicationId","snapshotId");

DO $$ BEGIN
 ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM information_schema.tables
		WHERE table_schema = 'public'
			AND table_name = 'scan_ledger_primitives'
	) THEN
		RETURN;
	END IF;

INSERT INTO "scan_ledger_entries" (
	"id",
	"organizationId",
	"applicationId",
	"composeId",
	"projectId",
	"sourceJobId",
	"repoId",
	"snapshotId",
	"type",
	"statement",
	"verdict",
	"assessment",
	"locations",
	"context",
	"evidence",
	"gaps",
	"links",
	"changes",
	"revision",
	"createdBy",
	"updatedBy",
	"createdAt",
	"updatedAt"
)
SELECT
	p."ledgerEntryId",
	p."organizationId",
	p."applicationId",
	p."composeId",
	p."projectId",
	p."sourceJobId",
	COALESCE(NULLIF(p."applicationId", ''), NULLIF(p."composeId", ''), p."sourceJobId"),
	CASE
		WHEN p."commitSha" IS NOT NULL AND btrim(p."commitSha") <> '' THEN p."commitSha"
		ELSE 'job:' || p."sourceJobId"
	END,
	p."type"::text::"scanLedgerEntryType",
	CASE
		WHEN p."description" IS NOT NULL AND btrim(p."description") <> '' THEN p."description"
		ELSE p."type"::text || ' at ' || p."file" || ':' || p."line"::text
	END,
	'unknown'::"scanLedgerVerdict",
	NULL,
	jsonb_build_array(
		jsonb_strip_nulls(
			jsonb_build_object(
				'file', p."file",
				'line', p."line",
				'endLine', p."endLine",
				'functionName', p."function"
			)
		)
	),
	'{}'::jsonb,
	'[]'::jsonb,
	CASE
		WHEN (p."proved" IS NOT NULL AND btrim(p."proved") <> '')
			OR (p."gap" IS NOT NULL AND btrim(p."gap") <> '')
		THEN jsonb_build_array(
			jsonb_build_object(
				'id', 'gap-migrated',
				'question', concat_ws(
					' ',
					CASE
						WHEN p."proved" IS NOT NULL AND btrim(p."proved") <> ''
						THEN 'Historical proved (unverified): ' || p."proved"
						ELSE NULL
					END,
					CASE
						WHEN p."gap" IS NOT NULL AND btrim(p."gap") <> ''
						THEN 'Historical gap: ' || p."gap"
						ELSE NULL
					END
				),
				'status', 'open',
				'resultRefs', '[]'::jsonb
			)
		)
		ELSE '[]'::jsonb
	END,
	CASE
		WHEN p."feedsLedgerEntryId" IS NOT NULL
		THEN jsonb_build_array(
			jsonb_build_object(
				'id', 'link-migrated-feeds',
				'targetId', p."feedsLedgerEntryId",
				'relation', 'related_to',
				'reason', 'Migrated from legacy feedsLedgerEntryId'
			)
		)
		ELSE '[]'::jsonb
	END,
	'[]'::jsonb,
	1,
	p."sourceTaskId",
	p."sourceTaskId",
	p."createdAt",
	p."updatedAt"
FROM "scan_ledger_primitives" p
ON CONFLICT ("id") DO NOTHING;

END $$;

DROP TABLE IF EXISTS "scan_ledger_primitives";
DROP TYPE IF EXISTS "public"."scanLedgerPrimitiveType";
DROP TYPE IF EXISTS "public"."scanLedgerPrimitiveStatus";
