import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	listTaskFileBrowserDirectory,
	readTaskFileBrowserFile,
	resolveTaskFileBrowserTarget,
	TASK_BROWSER_LANE_ROOT,
	TASK_BROWSER_TASK_ROOT,
	type TaskFileBrowserRoot,
} from "./task-file-browser";

const makeRoots = async () => {
	const base = await mkdtemp(path.join(tmpdir(), "vulseek-task-files-"));
	const taskHost = path.join(base, "task");
	const laneHost = path.join(base, "lane");
	await mkdir(path.join(taskHost, "inputs"), { recursive: true });
	await mkdir(laneHost, { recursive: true });
	await writeFile(path.join(taskHost, "output.json"), '{"ok":true}');
	await writeFile(path.join(laneHost, "ledger.md"), "# ledger");
	const roots: TaskFileBrowserRoot[] = [
		{
			name: "task",
			containerRootPath: TASK_BROWSER_TASK_ROOT,
			hostRootPath: taskHost,
		},
		{
			name: "lane",
			containerRootPath: TASK_BROWSER_LANE_ROOT,
			hostRootPath: laneHost,
		},
	];
	return { roots, taskHost, laneHost };
};

test("persistent task root lists task and lane together", async () => {
	const { roots } = await makeRoots();
	const items = await listTaskFileBrowserDirectory({ roots });
	assert.deepEqual(
		items.map((item) => ({ id: item.id, name: item.name, type: item.type })),
		[
			{ id: "/task", name: "task", type: "directory" },
			{ id: "/lane", name: "lane", type: "directory" },
		],
	);
});

test("single-root tasks still list the task directory contents at the top", async () => {
	const { roots, taskHost } = await makeRoots();
	const items = await listTaskFileBrowserDirectory({
		roots: [roots[0]!],
	});
	assert.deepEqual(
		items.map((item) => item.name).sort(),
		["inputs", "output.json"],
	);
	assert.equal(
		items.find((item) => item.name === "output.json")?.id,
		path.join(taskHost, "output.json"),
	);
});

test("expands /lane to lane files and reads ledger.md", async () => {
	const { roots, laneHost } = await makeRoots();
	const items = await listTaskFileBrowserDirectory({
		roots,
		directoryPath: "/lane",
	});
	assert.deepEqual(
		items.map((item) => ({ id: item.id, name: item.name })),
		[{ id: "/lane/ledger.md", name: "ledger.md" }],
	);
	const file = await readTaskFileBrowserFile({
		roots,
		filePath: "/lane/ledger.md",
	});
	assert.equal(file.content, "# ledger");
	assert.equal(file.relativePath, "lane/ledger.md");
	assert.equal(file.path, path.join(laneHost, "ledger.md"));
});

test("a lone lane root stays named lane instead of flattening", async () => {
	const { roots } = await makeRoots();
	const items = await listTaskFileBrowserDirectory({
		roots: [roots[1]!],
	});
	assert.deepEqual(
		items.map((item) => ({ id: item.id, name: item.name })),
		[{ id: "/lane", name: "lane" }],
	);
});

test("resolves both container and host paths into the matching root", async () => {
	const { roots, taskHost, laneHost } = await makeRoots();
	assert.equal(
		resolveTaskFileBrowserTarget({ roots, filePath: "/task/output.json" })
			.root.name,
		"task",
	);
	assert.equal(
		resolveTaskFileBrowserTarget({
			roots,
			filePath: path.join(laneHost, "ledger.md"),
		}).root.name,
		"lane",
	);
	assert.equal(
		resolveTaskFileBrowserTarget({ roots, filePath: "/lane" }).targetPath,
		laneHost,
	);
	assert.equal(
		resolveTaskFileBrowserTarget({
			roots,
			filePath: path.join(taskHost, "inputs"),
		}).root.name,
		"task",
	);
});
