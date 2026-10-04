DO $$ BEGIN
 CREATE TYPE "public"."scanLedgerState" AS ENUM('untracked', 'discovered', 'assigned', 'investigating', 'partial', 'covered', 'blocked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "scan_ledger_entries"
ADD COLUMN IF NOT EXISTS "state" "scanLedgerState" DEFAULT 'untracked' NOT NULL;

CREATE INDEX IF NOT EXISTS "scan_ledger_entries_type_state_idx"
ON "scan_ledger_entries" ("type", "state");
