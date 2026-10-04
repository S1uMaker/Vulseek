DO $$ BEGIN
 CREATE TYPE "public"."scanLedgerPrimitiveType" AS ENUM('sink', 'gate', 'connector', 'impact');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 CREATE TYPE "public"."scanLedgerPrimitiveStatus" AS ENUM('active', 'confirmed', 'false_positive');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "scan_ledger_primitives" (
	"ledgerEntryId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"applicationId" text,
	"composeId" text,
	"projectId" text,
	"commitSha" text,
	"targetTag" text,
	"targetRef" text,
	"type" "scanLedgerPrimitiveType" NOT NULL,
	"status" "scanLedgerPrimitiveStatus" NOT NULL,
	"file" text NOT NULL,
	"line" integer NOT NULL,
	"endLine" integer,
	"function" text,
	"description" text,
	"proved" text,
	"gap" text,
	"feedsLedgerEntryId" text,
	"sourceJobId" text NOT NULL,
	"sourceTaskId" text NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "scan_ledger_primitives_app_commit_idx" ON "scan_ledger_primitives" ("applicationId","commitSha");
CREATE INDEX IF NOT EXISTS "scan_ledger_primitives_app_type_status_idx" ON "scan_ledger_primitives" ("applicationId","type","status");
CREATE INDEX IF NOT EXISTS "scan_ledger_primitives_app_file_idx" ON "scan_ledger_primitives" ("applicationId","file");
CREATE INDEX IF NOT EXISTS "scan_ledger_primitives_app_function_idx" ON "scan_ledger_primitives" ("applicationId","function");

DO $$ BEGIN
 ALTER TABLE "scan_ledger_primitives" ADD CONSTRAINT "scan_ledger_primitives_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "scan_ledger_primitives" ADD CONSTRAINT "scan_ledger_primitives_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "scan_ledger_primitives" ADD CONSTRAINT "scan_ledger_primitives_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "scan_ledger_primitives" ADD CONSTRAINT "scan_ledger_primitives_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "scan_ledger_primitives" ADD CONSTRAINT "scan_ledger_primitives_feedsLedgerEntryId_scan_ledger_primitives_ledgerEntryId_fk" FOREIGN KEY ("feedsLedgerEntryId") REFERENCES "public"."scan_ledger_primitives"("ledgerEntryId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
