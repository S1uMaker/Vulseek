import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	closeConnection: vi.fn(),
	ensureLegacyDrizzleBaseline: vi.fn(),
	migrate: vi.fn(),
	backfillScanPipelineDefinitionSnapshots: vi.fn(),
	backfillScanJobCosts: vi.fn(),
}));

vi.mock("postgres", () => ({
	default: vi.fn(() => ({ end: mocks.closeConnection })),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
	drizzle: vi.fn(() => ({})),
}));

vi.mock("drizzle-orm/postgres-js/migrator", () => ({
	migrate: mocks.migrate,
}));

vi.mock("@/server/db/legacy-drizzle-baseline", () => ({
	ensureLegacyDrizzleBaseline: mocks.ensureLegacyDrizzleBaseline,
}));

vi.mock(
	"@vulseek/server/services/scan/persistence/scan-job-cost-backfill",
	() => ({
		backfillScanJobCosts: mocks.backfillScanJobCosts,
	}),
);

vi.mock(
	"@vulseek/server/services/scan/persistence/scan-pipeline-definition-backfill",
	() => ({
		backfillScanPipelineDefinitionSnapshots:
			mocks.backfillScanPipelineDefinitionSnapshots,
	}),
);

import { migration } from "@/server/db/migration";

describe("migration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rethrows the original migration error and closes the connection", async () => {
		const error = new Error("migration failed");
		mocks.ensureLegacyDrizzleBaseline.mockResolvedValue(undefined);
		mocks.backfillScanJobCosts.mockResolvedValue({
			processedCount: 0,
			skippedCount: 0,
			skippedTasks: [],
		});
		mocks.backfillScanPipelineDefinitionSnapshots.mockResolvedValue({
			processedCount: 0,
			updatedCount: 0,
		});
		mocks.migrate.mockRejectedValue(error);

		await expect(migration()).rejects.toBe(error);
		expect(mocks.closeConnection).toHaveBeenCalledTimes(1);
	});

	it("runs remaining backfills after the SQL migrations", async () => {
		mocks.ensureLegacyDrizzleBaseline.mockResolvedValue(undefined);
		mocks.migrate.mockResolvedValue(undefined);
		mocks.backfillScanJobCosts.mockResolvedValue({
			processedCount: 0,
			skippedCount: 0,
			skippedTasks: [],
		});
		mocks.backfillScanPipelineDefinitionSnapshots.mockResolvedValue({
			processedCount: 0,
			updatedCount: 0,
		});

		await migration();

		expect(mocks.backfillScanPipelineDefinitionSnapshots).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.backfillScanJobCosts).toHaveBeenCalledTimes(1);
		expect(mocks.closeConnection).toHaveBeenCalledTimes(1);
	});
});
