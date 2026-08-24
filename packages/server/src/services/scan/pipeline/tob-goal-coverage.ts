import { promises as fs } from "node:fs";
import path from "node:path";

export const SURFACE_COVERAGE_FILE_NAME = "surface-coverage.json";

export const emptySurfaceCoverage = () =>
	({
		huntGoals: [] as Array<{
			huntGoalId: string;
			title?: string;
			scopeStatement?: string;
			status: string;
			lesson?: string;
		}>,
	}) as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readTrimmedString = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : null;

export const readHuntGoalId = (value: unknown): string | null => {
	if (!isRecord(value)) return null;
	return (
		readTrimmedString(value.huntGoalId) ||
		readHuntGoalId(value.huntGoal) ||
		readTrimmedString(isRecord(value.input) ? value.input.huntGoalId : null)
	);
};

export const collectDispatchedHuntGoalIds = (
	tasks: Array<{ input?: unknown }>,
) => {
	const ids = new Set<string>();
	for (const task of tasks) {
		const huntGoalId = readHuntGoalId(task.input);
		if (huntGoalId) ids.add(huntGoalId);
	}
	return [...ids].sort();
};

export const huntGoalDispatchKey = (scanJobId: string, huntGoalId: string) =>
	`${scanJobId}:goal-hunt:${huntGoalId}`;

export const surfaceCoverageContainerPath = (laneDirContainer: string) =>
	path.posix.join(laneDirContainer.replace(/\/+$/, ""), SURFACE_COVERAGE_FILE_NAME);

export const filterNewHuntInputs = (
	inputs: unknown[],
	dispatchedHuntGoalIds: Iterable<string>,
) => {
	const seen = new Set(dispatchedHuntGoalIds);
	return inputs.filter((input) => {
		const huntGoalId = readHuntGoalId(input);
		if (!huntGoalId || seen.has(huntGoalId)) return false;
		seen.add(huntGoalId);
		return true;
	});
};

export const ensureSurfaceCoverageFile = async (laneDir: string) => {
	const laneFile = path.join(laneDir, SURFACE_COVERAGE_FILE_NAME);
	await fs.mkdir(laneDir, { recursive: true });
	try {
		await fs.access(laneFile);
	} catch {
		await fs.writeFile(
			laneFile,
			`${JSON.stringify(emptySurfaceCoverage(), null, 2)}\n`,
			"utf-8",
		);
	}
	return laneFile;
};
