import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { closeDbConnection } from "@vulseek/server/db";
import { ensureLegacyDrizzleBaseline } from "./server/db/legacy-drizzle-baseline";
const connectionString = process.env.DATABASE_URL!;
const migrationsFolder = "drizzle";

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

await ensureLegacyDrizzleBaseline(sql, migrationsFolder);

try {
	await migrate(db, { migrationsFolder });
	console.log("Migration complete");
} catch (error) {
	console.error("Migration failed", error);
	throw error;
} finally {
	await sql.end();
	await closeDbConnection();
}
