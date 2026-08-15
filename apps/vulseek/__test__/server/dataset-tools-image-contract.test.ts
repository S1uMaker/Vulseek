import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (relativePath: string) =>
	readFile(path.resolve(process.cwd(), "../../", relativePath), "utf8");

describe("Dataset Profile tools-image checkout contract", () => {
	it("does not build or create a profile-owned image", async () => {
		const source = await readRepositoryFile("packages/server/src/services/dataset.ts");

		expect(source).not.toContain("docker build");
		expect(source).not.toContain("buildCheckoutImage");
		expect(source).not.toContain("resolveDatasetToolsImage");
		expect(source).not.toContain("vulseek-dataset-profile-");
		expect(source).toContain("resolveRequiredToolsImage");
		expect(source).toContain("toolsImageTag");
		expect(source).toContain("toolsImageDigest");
	});

	it("preserves samples referenced by historical evaluation trials", async () => {
		const source = await readRepositoryFile(
			"packages/server/src/services/dataset.ts",
		);

		expect(source).toContain("referencedSamples");
		expect(source).toContain(
			"notInArray(datasetSamples.sampleId, referencedSampleIds)",
		);
		expect(source).toContain("onConflictDoUpdate");
		expect(source).toContain(
			"target: [datasetSamples.profileId, datasetSamples.id]",
		);
	});

	it("migrates old profile image references without changing the published migration", async () => {
		const migration = await readRepositoryFile(
			"apps/vulseek/drizzle/0232_dataset_profile_tools_image.sql",
		);
		const originalMigration = await readRepositoryFile(
			"apps/vulseek/drizzle/0222_dataset_evaluation.sql",
		);

		expect(migration).toContain('RENAME COLUMN "checkoutImage" TO "toolsImageTag"');
		expect(migration).toContain(
			'RENAME COLUMN "checkoutImageDigest" TO "toolsImageDigest"',
		);
		expect(migration).toContain('"toolsImageTag" = NULL');
		expect(migration).toContain('"toolsImageDigest" = NULL');
		expect(migration).toContain('WHERE "toolsImageTag" IS NOT NULL');
		expect(originalMigration).toContain('"checkoutImage" text');
	});
});
