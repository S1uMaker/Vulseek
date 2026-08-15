ALTER TABLE "dataset_profiles"
	RENAME COLUMN "checkoutImage" TO "toolsImageTag";
--> statement-breakpoint
ALTER TABLE "dataset_profiles"
	RENAME COLUMN "checkoutImageDigest" TO "toolsImageDigest";
--> statement-breakpoint
UPDATE "dataset_profiles"
SET
	"toolsImageTag" = NULL,
	"toolsImageDigest" = NULL,
	"status" = CASE WHEN "status" = 'ready' THEN 'preparing' ELSE "status" END,
	"errorMessage" = CASE
		WHEN "status" = 'ready' THEN 'Dataset Profile must be checked out again to pin a shared tools image.'
		ELSE "errorMessage"
	END
WHERE "toolsImageTag" IS NOT NULL
	OR "toolsImageDigest" IS NOT NULL;
