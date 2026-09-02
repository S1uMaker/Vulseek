ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "tokenBudget" bigint;
ALTER TABLE "scan_jobs" ADD COLUMN IF NOT EXISTS "timeBudgetSeconds" integer;
