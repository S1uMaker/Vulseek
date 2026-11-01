import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { db } from "@vulseek/server/db";
import {
	applications,
	environments,
	projects,
} from "@vulseek/server/db/schema";
import { eq } from "drizzle-orm";
import { resolveCheckoutToolsDefinition } from "../checkout-tools";
import {
	deleteScanJobByIdRepo,
	findScanJobByIdRepo,
} from "../persistence/scan-job.repo";
import { findScanJobOrganizationIdRepo } from "../persistence/scan-job-access.repo";

const execFileAsync = promisify(execFile);

const TERMINAL_SCAN_JOB_STATUSES = new Set([
	"finished",
	"partially_finished",
	"failed",
	"canceled",
]);

const sanitizeContextPathPart = (value: string) =>
	value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "unknown";

const removeJobContainers = async (scanJobId: string) => {
	const { stdout } = await execFileAsync("docker", [
		"ps",
		"-aq",
		"--filter",
		`name=${scanJobId}`,
	]);
	const containerIds = stdout.split(/\s+/).filter(Boolean);
	if (containerIds.length > 0) {
		await execFileAsync("docker", ["rm", "-f", ...containerIds]);
	}
	return containerIds.length;
};

const removeJobHostArtifacts = async (
	scanJobId: string,
	applicationId: string | null,
) => {
	const hostRoot = process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim();
	if (!hostRoot || !applicationId) {
		return 0;
	}
	const [row] = await db
		.select({
			projectName: projects.name,
			name: applications.name,
			appName: applications.appName,
		})
		.from(applications)
		.innerJoin(
			environments,
			eq(applications.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(eq(applications.applicationId, applicationId))
		.limit(1);
	if (!row) {
		return 0;
	}
	// The artifacts dir may be keyed by either of the app's name fields
	// depending on which identity the checkout stage resolved.
	const candidateNames = Array.from(
		new Set([row.appName, row.name].filter(Boolean)),
	);
	const projectProfilePrefix = path.join(
		"projects",
		sanitizeContextPathPart(row.projectName),
		"profiles",
	);
	let removed = 0;
	for (const name of candidateNames) {
		const relativeJobDir = path.join("jobs", scanJobId);
		const jobDir = path.join(
			hostRoot,
			projectProfilePrefix,
			sanitizeContextPathPart(name),
			relativeJobDir,
		);
		try {
			await fs.rm(jobDir, { recursive: true, force: true });
			removed += 1;
		} catch {
			// Agent containers run as root, so some files are root-owned and a
			// host-user rm fails with EACCES. Fall back to a root removal
			// through the scan tools image, mounted with the same convention
			// the scan itself uses (/scan-context).
			try {
				const toolsDefinition = await resolveCheckoutToolsDefinition();
				const containerJobDir = path.posix.join(
					"/scan-context",
					projectProfilePrefix,
					sanitizeContextPathPart(name),
					relativeJobDir,
				);
				await execFileAsync("docker", [
					"run",
					"--rm",
					"-v",
					`${hostRoot}:/scan-context`,
					toolsDefinition.imageTag,
					"rm",
					"-rf",
					containerJobDir,
				]);
				removed += 1;
			} catch {
				// Best effort — leftover dirs are harmless.
			}
		}
	}
	return removed;
};

/**
 * Delete a terminal scan job and everything hanging off it (tasks, messages,
 * candidates and the other scan artifacts cascade via foreign keys), plus the
 * job's leftover agent containers and host-side artifacts directory.
 * Non-terminal jobs must be stopped or canceled first.
 */
export const deleteScanJobForOrganization = async (input: {
	scanJobId: string;
	organizationId: string | null | undefined;
}) => {
	const job = await findScanJobByIdRepo(input.scanJobId);
	if (!job) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}
	const jobOrganizationId = await findScanJobOrganizationIdRepo(
		input.scanJobId,
	);
	if (jobOrganizationId !== input.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to delete this scan job",
		});
	}
	if (!TERMINAL_SCAN_JOB_STATUSES.has(job.status)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Stop or cancel the job before deleting it",
		});
	}
	await removeJobContainers(input.scanJobId).catch(() => {});
	await removeJobHostArtifacts(
		input.scanJobId,
		job.applicationId ?? null,
	).catch(() => {});
	await deleteScanJobByIdRepo(input.scanJobId);
	return { deleted: true };
};
