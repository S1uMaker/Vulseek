import { buildPipelineTaskUpdatePatch } from "@vulseek/server/services/scan/pipeline/task-update-patch";
import { expect, it } from "vitest";

it("forwards status and error to task persistence without storing output", () => {
	expect(
		buildPipelineTaskUpdatePatch({
			status: "failed",
			errorMessage: "boom",
		}),
	).toMatchObject({
		status: "failed",
		errorMessage: "boom",
	});
	expect(
		buildPipelineTaskUpdatePatch({
			status: "running",
		}),
	).not.toHaveProperty("output");
});
