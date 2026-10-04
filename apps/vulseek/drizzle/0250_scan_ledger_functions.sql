DROP TABLE IF EXISTS "scan_ledger_entries";

DO $$ BEGIN
 CREATE TYPE "public"."scanLedgerFunctionState" AS ENUM(
	'discovered',
	'assigned',
	'investigating',
	'partial',
	'covered',
	'verified',
	'blocked'
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "scan_ledger_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"organizationId" text NOT NULL,
	"applicationId" text,
	"composeId" text,
	"projectId" text,
	"sourceJobId" text NOT NULL,
	"repoId" text NOT NULL,
	"snapshotId" text NOT NULL,
	"file" text NOT NULL,
	"functionName" text NOT NULL,
	"line" integer NOT NULL,
	"endLine" integer,
	"state" "scanLedgerFunctionState" DEFAULT 'discovered' NOT NULL,
	"primitives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" text NOT NULL,
	"updatedBy" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

CREATE UNIQUE INDEX "scan_ledger_entries_function_identity_idx" ON "scan_ledger_entries" ("organizationId","repoId","snapshotId","file","functionName");
CREATE INDEX "scan_ledger_entries_org_repo_snapshot_idx" ON "scan_ledger_entries" ("organizationId","repoId","snapshotId");
CREATE INDEX "scan_ledger_entries_function_state_idx" ON "scan_ledger_entries" ("state");
CREATE INDEX "scan_ledger_entries_app_snapshot_idx" ON "scan_ledger_entries" ("applicationId","snapshotId");

ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "scan_ledger_entries" ADD CONSTRAINT "scan_ledger_entries_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;
