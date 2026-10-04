ALTER TABLE "scan_ledger_entries"
ADD COLUMN IF NOT EXISTS "title" text;

UPDATE "scan_ledger_entries"
SET "title" = left(btrim("statement"), 160)
WHERE "title" IS NULL OR btrim("title") = '';

ALTER TABLE "scan_ledger_entries"
ALTER COLUMN "title" SET NOT NULL;
