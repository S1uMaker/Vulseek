import { backfillScanJobCosts } from "@vulseek/server/services/scan/persistence/scan-job-cost-backfill";
import { backfillScanPipelineDefinitionSnapshots } from "@vulseek/server/services/scan/persistence/scan-pipeline-definition-backfill";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { ensureLegacyDrizzleBaseline } from "./legacy-drizzle-baseline";

const connectionString = process.env.DATABASE_URL!;
const migrationsFolder = "drizzle";

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

export const migration = async () => {
	try {
		await ensureLegacyDrizzleBaseline(sql, migrationsFolder);
		await migrate(db, { migrationsFolder });
		const pipelineBackfill =
			await backfillScanPipelineDefinitionSnapshots();
		console.log(
			`Scan pipeline snapshot backfill complete: processed=${pipelineBackfill.processedCount} updated=${pipelineBackfill.updatedCount}`,
		);
		const costBackfill = await backfillScanJobCosts();
		console.log(
			`Scan job cost backfill complete: processed=${costBackfill.processedCount} skipped=${costBackfill.skippedCount}`,
		);
		console.log("Migration complete");
	} finally {
		await sql.end();
	}
};
