import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeTaskJobOutput } from "@vulseek/server/services/scan/artifacts/job-output-artifacts";

describe("job output artifacts", () => {
	it("copies only files referenced by output.json and preserves their paths", async () => {
		const taskDir = await mkdtemp(path.join(os.tmpdir(), "vulseek-job-output-"));
		try {
			await mkdir(path.join(taskDir, "artifacts"), { recursive: true });
			await writeFile(path.join(taskDir, "report.md"), "# Report");
			await writeFile(
				path.join(taskDir, "artifacts", "evidence.bin"),
				Buffer.from([0, 1, 2]),
			);
			await writeFile(path.join(taskDir, "ignored.txt"), "not referenced");

			await expect(
				materializeTaskJobOutput({
					taskDir,
					taskId: "task-1",
					messageId: "to-1",
					stageName: "report",
					output: {
						reportPath: "/task/report.md",
						evidence: ["/task/artifacts/evidence.bin"],
						duplicate: "/task/report.md",
						location: "src/example.ts",
					},
				}),
			).resolves.toEqual({
				messageId: "to-1",
				stageName: "report",
				artifacts: [
					{ path: "/task/job-output/artifacts/evidence.bin" },
					{ path: "/task/job-output/report.md" },
				],
			});
			expect(
				await readFile(
					path.join(taskDir, "job-output", "artifacts", "evidence.bin"),
				),
			).toEqual(Buffer.from([0, 1, 2]));
			expect(
				await readFile(path.join(taskDir, "job-output", "report.md"), "utf8"),
			).toBe("# Report");
			await expect(
				readFile(path.join(taskDir, "job-output", "ignored.txt")),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("does not create a Job output record when output has no file paths", async () => {
		const taskDir = await mkdtemp(path.join(os.tmpdir(), "vulseek-job-output-"));
		try {
			await expect(
				materializeTaskJobOutput({
					taskDir,
					taskId: "task-1",
					messageId: "to-1",
					stageName: "report",
					output: { verdict: "complete" },
				}),
			).resolves.toBeNull();
			expect((await stat(path.join(taskDir, "job-output"))).isDirectory()).toBe(
				true,
			);
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("recursively copies a referenced directory", async () => {
		const taskDir = await mkdtemp(path.join(os.tmpdir(), "vulseek-job-output-"));
		try {
			await mkdir(path.join(taskDir, "bundle", "nested"), { recursive: true });
			await writeFile(path.join(taskDir, "bundle", "summary.txt"), "summary");
			await writeFile(path.join(taskDir, "bundle", "nested", "raw.dat"), "raw");

			await expect(
				materializeTaskJobOutput({
					taskDir,
					taskId: "task-1",
					messageId: "to-1",
					stageName: "report",
					output: { bundlePath: "/task/bundle" },
				}),
			).resolves.toMatchObject({
				artifacts: [
					{ path: "/task/job-output/bundle/nested/raw.dat" },
					{ path: "/task/job-output/bundle/summary.txt" },
				],
			});
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("fails when output.json references a missing artifact", async () => {
		const taskDir = await mkdtemp(path.join(os.tmpdir(), "vulseek-job-output-"));
		try {
			await expect(
				materializeTaskJobOutput({
					taskDir,
					taskId: "task-1",
					messageId: "to-1",
					stageName: "report",
					output: { reportPath: "/task/missing.md" },
				}),
			).rejects.toThrow("job output artifact does not exist: /task/missing.md");
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("rejects symbolic links instead of copying outside the task", async () => {
		const taskDir = await mkdtemp(path.join(os.tmpdir(), "vulseek-job-output-"));
		const outsideDir = await mkdtemp(
			path.join(os.tmpdir(), "vulseek-job-output-outside-"),
		);
		try {
			const outsideFile = path.join(outsideDir, "secret.txt");
			await writeFile(outsideFile, "secret");
			await symlink(outsideFile, path.join(taskDir, "secret.txt"));

			await expect(
				materializeTaskJobOutput({
					taskDir,
					taskId: "task-1",
					messageId: "to-1",
					stageName: "report",
					output: { reportPath: "/task/secret.txt" },
				}),
			).rejects.toThrow("cannot be symbolic links");
		} finally {
			await rm(taskDir, { recursive: true, force: true });
			await rm(outsideDir, { recursive: true, force: true });
		}
	});

	it("replaces stale generated output on rematerialization", async () => {
		const taskDir = await mkdtemp(path.join(os.tmpdir(), "vulseek-job-output-"));
		try {
			await writeFile(path.join(taskDir, "first.txt"), "first");
			await writeFile(path.join(taskDir, "second.txt"), "second");
			await materializeTaskJobOutput({
				taskDir,
				taskId: "task-1",
				messageId: "to-1",
				stageName: "report",
				output: { path: "/task/first.txt" },
			});
			await materializeTaskJobOutput({
				taskDir,
				taskId: "task-1",
				messageId: "to-1",
				stageName: "report",
				output: { path: "/task/second.txt" },
			});

			await expect(
				readFile(path.join(taskDir, "job-output", "first.txt")),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				await readFile(path.join(taskDir, "job-output", "second.txt"), "utf8"),
			).toBe("second");
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});
});
