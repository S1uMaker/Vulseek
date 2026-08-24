import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	DEFAULT_DELTA_COMMIT_WINDOW,
	authGithub,
	findApplicationById,
	findCheckoutImageStatus,
	findComposeById,
	haveGithubRequirements,
	resolveScanGitRepositoryContext,
} from "@vulseek/server";
import { db } from "@vulseek/server/db";
import {
	applications,
	compose,
	scanJobs,
	scanPipelines,
} from "@vulseek/server/db/schema";
import { createPipelineRun } from "@vulseek/server/services/scan/api/pipeline-runs";
import { and, desc, eq } from "drizzle-orm";
import { scansQueue } from "../queues/queueSetup";

const AUTO_DELTA_SCAN_POLL_INTERVAL_MS = 10_000;

let autoDeltaScanTimer: NodeJS.Timeout | null = null;
let autoDeltaScanInFlight = false;
const lastObservedState = new Map<string, string>();

const rememberState = (targetKey: string, nextState: string, message: string) => {
	if (lastObservedState.get(targetKey) === nextState) {
		return;
	}
	lastObservedState.set(targetKey, nextState);
	console.log(`[Auto Delta Scan] ${message}`);
};

const fetchJson = async (
	url: string,
	init?: RequestInit,
): Promise<Record<string, unknown>> => {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as Record<string, unknown>;
};

const resolveBranchHeadViaGit = async (input: {
	gitUrl: string;
	gitBranch: string;
	privateKey?: string | null;
}) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vulseek-autoscan-"));
	const privateKeyPath = path.join(tempDir, "id_auto_scan");

	try {
		let gitSshCommand = "";
		if (input.privateKey?.trim()) {
			await fs.writeFile(privateKeyPath, input.privateKey, { mode: 0o600 });
			gitSshCommand = [
				"ssh",
				`-i ${privateKeyPath}`,
				"-o IdentitiesOnly=yes",
				"-o StrictHostKeyChecking=no",
				"-o UserKnownHostsFile=/dev/null",
			].join(" ");
		}

		const result = await new Promise<{ stdout: string; stderr: string }>(
			(resolve, reject) => {
				const child = spawn(
					"git",
					[
						"ls-remote",
						"--heads",
						input.gitUrl,
						`refs/heads/${input.gitBranch}`,
					],
					{
						env: {
							...process.env,
							...(gitSshCommand ? { GIT_SSH_COMMAND: gitSshCommand } : {}),
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				);

				let stdout = "";
				let stderr = "";

				child.stdout.on("data", (chunk) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				child.on("error", reject);
				child.on("close", (code) => {
					if (code !== 0) {
						reject(
							new Error(
								stderr.trim() || `git ls-remote exited with code ${code ?? 0}`,
							),
						);
						return;
					}
					resolve({ stdout, stderr });
				});
			},
		);

		const line = result.stdout
			.split("\n")
			.map((entry) => entry.trim())
			.find(Boolean);
		return line?.split(/\s+/)[0] || "";
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
};

const resolveApplicationRemoteHead = async (applicationId: string) => {
	const application = await findApplicationById(applicationId);

	switch (application.sourceType) {
		case "github": {
			if (!application.owner || !application.repository || !application.branch) {
				return null;
			}
			if (application.github && haveGithubRequirements(application.github)) {
				const octokit = authGithub(application.github);
				const { data } = await octokit.rest.repos.getBranch({
					owner: application.owner,
					repo: application.repository,
					branch: application.branch,
				});
				return {
					headSha: data.commit.sha,
					branch: application.branch,
				};
			}
			const { gitUrl, gitBranch } = await resolveScanGitRepositoryContext({
				applicationId,
			});
			const headSha = await resolveBranchHeadViaGit({ gitUrl, gitBranch });
			return headSha ? { headSha, branch: gitBranch } : null;
		}
		case "gitlab": {
			if (!application.gitlabBranch || !application.gitlab) {
				return null;
			}
			const gitlabUrl = application.gitlab.gitlabUrl.replace(/\/+$/, "");
			const projectRef =
				application.gitlabProjectId ||
				encodeURIComponent(
					`${application.gitlabOwner || ""}/${application.gitlabRepository || ""}`,
				);
			const branchRef = encodeURIComponent(application.gitlabBranch);
			const data = await fetchJson(
				`${gitlabUrl}/api/v4/projects/${projectRef}/repository/branches/${branchRef}`,
				{
					headers: application.gitlab.accessToken
						? {
								"PRIVATE-TOKEN": application.gitlab.accessToken,
							}
						: undefined,
				},
			);
			const commit = data.commit as Record<string, unknown> | undefined;
			const headSha =
				typeof commit?.id === "string" ? commit.id : "";
			return headSha
				? {
						headSha,
						branch: application.gitlabBranch,
					}
				: null;
		}
		case "gitea": {
			if (
				!application.gitea ||
				!application.giteaOwner ||
				!application.giteaRepository ||
				!application.giteaBranch
			) {
				return null;
			}
			const baseUrl = application.gitea.giteaUrl.replace(/\/+$/, "");
			const owner = encodeURIComponent(application.giteaOwner);
			const repo = encodeURIComponent(application.giteaRepository);
			const branch = encodeURIComponent(application.giteaBranch);
			const data = await fetchJson(
				`${baseUrl}/api/v1/repos/${owner}/${repo}/branches/${branch}`,
				{
					headers: application.gitea.accessToken
						? {
								Authorization: `token ${application.gitea.accessToken}`,
							}
						: undefined,
				},
			);
			const commit = data.commit as Record<string, unknown> | undefined;
			const headSha =
				typeof commit?.id === "string" ? commit.id : "";
			return headSha
				? {
						headSha,
						branch: application.giteaBranch,
					}
				: null;
		}
		case "bitbucket": {
			if (
				!application.bitbucketOwner ||
				!application.bitbucketRepository ||
				!application.bitbucketBranch
			) {
				return null;
			}
			const headers: Record<string, string> = {};
			if (
				application.bitbucket?.bitbucketUsername &&
				application.bitbucket?.appPassword
			) {
				headers.Authorization = `Basic ${Buffer.from(
					`${application.bitbucket.bitbucketUsername}:${application.bitbucket.appPassword}`,
				).toString("base64")}`;
			} else if (application.bitbucket?.apiToken) {
				headers.Authorization = `Bearer ${application.bitbucket.apiToken}`;
			}
			const data = await fetchJson(
				`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(
					application.bitbucketOwner,
				)}/${encodeURIComponent(
					application.bitbucketRepository,
				)}/refs/branches/${encodeURIComponent(application.bitbucketBranch)}`,
				{
					headers: Object.keys(headers).length > 0 ? headers : undefined,
				},
			);
			const target = data.target as Record<string, unknown> | undefined;
			const headSha =
				typeof target?.hash === "string" ? target.hash : "";
			return headSha
				? {
						headSha,
						branch: application.bitbucketBranch,
					}
				: null;
		}
		case "git": {
			const { gitUrl, gitBranch } = await resolveScanGitRepositoryContext({
				applicationId,
			});
			if (!gitUrl || gitUrl === "<GIT_URL>" || !gitBranch || gitBranch === "<GIT_BRANCH>") {
				return null;
			}
			const headSha = await resolveBranchHeadViaGit({
				gitUrl,
				gitBranch,
				privateKey: application.customGitSSHKey?.privateKey,
			});
			return headSha ? { headSha, branch: gitBranch } : null;
		}
		default:
			return null;
	}
};

const resolveComposeRemoteHead = async (composeId: string) => {
	const target = await findComposeById(composeId);

	switch (target.sourceType) {
		case "github": {
			if (!target.owner || !target.repository || !target.branch) {
				return null;
			}
			if (target.github && haveGithubRequirements(target.github)) {
				const octokit = authGithub(target.github);
				const { data } = await octokit.rest.repos.getBranch({
					owner: target.owner,
					repo: target.repository,
					branch: target.branch,
				});
				return {
					headSha: data.commit.sha,
					branch: target.branch,
				};
			}
			const { gitUrl, gitBranch } = await resolveScanGitRepositoryContext({
				composeId,
			});
			const headSha = await resolveBranchHeadViaGit({ gitUrl, gitBranch });
			return headSha ? { headSha, branch: gitBranch } : null;
		}
		case "gitlab": {
			if (!target.gitlabBranch || !target.gitlab) {
				return null;
			}
			const gitlabUrl = target.gitlab.gitlabUrl.replace(/\/+$/, "");
			const projectRef =
				target.gitlabProjectId ||
				encodeURIComponent(
					`${target.gitlabOwner || ""}/${target.gitlabRepository || ""}`,
				);
			const branchRef = encodeURIComponent(target.gitlabBranch);
			const data = await fetchJson(
				`${gitlabUrl}/api/v4/projects/${projectRef}/repository/branches/${branchRef}`,
				{
					headers: target.gitlab.accessToken
						? {
								"PRIVATE-TOKEN": target.gitlab.accessToken,
							}
						: undefined,
				},
			);
			const commit = data.commit as Record<string, unknown> | undefined;
			const headSha =
				typeof commit?.id === "string" ? commit.id : "";
			return headSha
				? {
						headSha,
						branch: target.gitlabBranch,
					}
				: null;
		}
		case "gitea": {
			if (
				!target.gitea ||
				!target.giteaOwner ||
				!target.giteaRepository ||
				!target.giteaBranch
			) {
				return null;
			}
			const baseUrl = target.gitea.giteaUrl.replace(/\/+$/, "");
			const owner = encodeURIComponent(target.giteaOwner);
			const repo = encodeURIComponent(target.giteaRepository);
			const branch = encodeURIComponent(target.giteaBranch);
			const data = await fetchJson(
				`${baseUrl}/api/v1/repos/${owner}/${repo}/branches/${branch}`,
				{
					headers: target.gitea.accessToken
						? {
								Authorization: `token ${target.gitea.accessToken}`,
							}
						: undefined,
				},
			);
			const commit = data.commit as Record<string, unknown> | undefined;
			const headSha =
				typeof commit?.id === "string" ? commit.id : "";
			return headSha
				? {
						headSha,
						branch: target.giteaBranch,
					}
				: null;
		}
		case "bitbucket": {
			if (
				!target.bitbucketOwner ||
				!target.bitbucketRepository ||
				!target.bitbucketBranch
			) {
				return null;
			}
			const headers: Record<string, string> = {};
			if (
				target.bitbucket?.bitbucketUsername &&
				target.bitbucket?.appPassword
			) {
				headers.Authorization = `Basic ${Buffer.from(
					`${target.bitbucket.bitbucketUsername}:${target.bitbucket.appPassword}`,
				).toString("base64")}`;
			} else if (target.bitbucket?.apiToken) {
				headers.Authorization = `Bearer ${target.bitbucket.apiToken}`;
			}
			const data = await fetchJson(
				`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(
					target.bitbucketOwner,
				)}/${encodeURIComponent(
					target.bitbucketRepository,
				)}/refs/branches/${encodeURIComponent(target.bitbucketBranch)}`,
				{
					headers: Object.keys(headers).length > 0 ? headers : undefined,
				},
			);
			const headSha =
				typeof (data.target as Record<string, unknown> | undefined)?.hash === "string"
					? ((data.target as Record<string, unknown>).hash as string)
					: "";
			return headSha
				? {
						headSha,
						branch: target.bitbucketBranch,
					}
				: null;
		}
		case "git": {
			const { gitUrl, gitBranch } = await resolveScanGitRepositoryContext({
				composeId,
			});
			if (!gitUrl || gitUrl === "<GIT_URL>" || !gitBranch || gitBranch === "<GIT_BRANCH>") {
				return null;
			}
			const headSha = await resolveBranchHeadViaGit({
				gitUrl,
				gitBranch,
				privateKey: target.customGitSSHKey?.privateKey,
			});
			return headSha ? { headSha, branch: gitBranch } : null;
		}
		default:
			return null;
	}
};

const findLatestDeltaScanJobByTarget = async (input: {
	applicationId?: string;
	composeId?: string;
}) => {
	const organizationId = input.applicationId
		? (await findApplicationById(input.applicationId)).environment.project.organizationId
		: (await findComposeById(input.composeId as string)).environment.project.organizationId;
	const pipeline = await db
		.select({ pipelineId: scanPipelines.pipelineId })
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.organizationId, organizationId),
				eq(scanPipelines.slug, "delta"),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!pipeline) return null;
	const rows = await db
		.select()
		.from(scanJobs)
		.where(
			and(
				eq(scanJobs.pipelineId, pipeline.pipelineId),
				input.applicationId
					? eq(scanJobs.applicationId, input.applicationId)
					: eq(scanJobs.composeId, input.composeId as string),
			),
		)
		.orderBy(desc(scanJobs.createdAt))
		.limit(1);

	return rows[0] || null;
};

const enqueueAutoDeltaScan = async (input: {
	applicationId?: string;
	composeId?: string;
	headSha: string;
	branch: string;
}) => {
	const organizationId = input.applicationId
		? (await findApplicationById(input.applicationId)).environment.project.organizationId
		: (await findComposeById(input.composeId as string)).environment.project.organizationId;
	const pipeline = await db
		.select({ pipelineId: scanPipelines.pipelineId })
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.organizationId, organizationId),
				eq(scanPipelines.slug, "delta"),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!pipeline) throw new Error("Delta pipeline is not configured");
	const scanJob = await createPipelineRun({
		organizationId,
		target: input.applicationId
			? { type: "application", applicationId: input.applicationId }
			: { type: "compose", composeId: input.composeId as string },
		pipelineId: pipeline.pipelineId,
		title: "Auto Delta Scan",
		description: `Auto-created after detecting a new HEAD on ${input.branch}: ${input.headSha}`,
		repository: {
			commitSha: input.headSha,
			targetRef: input.branch,
			commitWindow: DEFAULT_DELTA_COMMIT_WINDOW,
		},
	});

	await scansQueue.add(
		"scans",
		{ scanJobId: scanJob.scanJobId },
		{
			jobId: `scan:${scanJob.scanJobId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);

	return scanJob;
};

const pollAutoDeltaScanTargets = async () => {
	const [applicationTargets, composeTargets] = await Promise.all([
		db
			.select({
				applicationId: applications.applicationId,
				name: applications.name,
			})
			.from(applications)
			.where(eq(applications.autoDeltaScan, true)),
		db
			.select({
				composeId: compose.composeId,
				name: compose.name,
			})
			.from(compose)
			.where(eq(compose.autoDeltaScan, true)),
	]);

	for (const applicationTarget of applicationTargets) {
		const targetKey = `application:${applicationTarget.applicationId}`;
		try {
			const checkoutImage = await findCheckoutImageStatus({
				applicationId: applicationTarget.applicationId,
			});
			if (!checkoutImage.exists) {
				rememberState(
					targetKey,
					"missing-checkout-image",
					`Skip ${applicationTarget.name}: checkout image does not exist yet`,
				);
				continue;
			}

			const remote = await resolveApplicationRemoteHead(
				applicationTarget.applicationId,
			);
			if (!remote?.headSha) {
				rememberState(
					targetKey,
					"missing-remote-head",
					`Skip ${applicationTarget.name}: unable to resolve remote HEAD`,
				);
				continue;
			}

			const latestJob = await findLatestDeltaScanJobByTarget({
				applicationId: applicationTarget.applicationId,
			});
			if (latestJob?.commitSha === remote.headSha) {
				rememberState(
					targetKey,
					`up-to-date:${remote.headSha}`,
					`No update for ${applicationTarget.name} on ${remote.branch} (${remote.headSha.slice(0, 12)})`,
				);
				continue;
			}

			const scanJob = await enqueueAutoDeltaScan({
				applicationId: applicationTarget.applicationId,
				headSha: remote.headSha,
				branch: remote.branch,
			});
			rememberState(
				targetKey,
				`queued:${remote.headSha}`,
				`Queued auto delta scan ${scanJob.scanJobId} for ${applicationTarget.name} on ${remote.branch} (${remote.headSha.slice(0, 12)})`,
			);
		} catch (error) {
			rememberState(
				targetKey,
				`error:${error instanceof Error ? error.message : "unknown"}`,
				`Error polling ${applicationTarget.name}: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			);
		}
	}

	for (const composeTarget of composeTargets) {
		const targetKey = `compose:${composeTarget.composeId}`;
		try {
			const checkoutImage = await findCheckoutImageStatus({
				composeId: composeTarget.composeId,
			});
			if (!checkoutImage.exists) {
				rememberState(
					targetKey,
					"missing-checkout-image",
					`Skip ${composeTarget.name}: checkout image does not exist yet`,
				);
				continue;
			}

			const remote = await resolveComposeRemoteHead(composeTarget.composeId);
			if (!remote?.headSha) {
				rememberState(
					targetKey,
					"missing-remote-head",
					`Skip ${composeTarget.name}: unable to resolve remote HEAD`,
				);
				continue;
			}

			const latestJob = await findLatestDeltaScanJobByTarget({
				composeId: composeTarget.composeId,
			});
			if (latestJob?.commitSha === remote.headSha) {
				rememberState(
					targetKey,
					`up-to-date:${remote.headSha}`,
					`No update for ${composeTarget.name} on ${remote.branch} (${remote.headSha.slice(0, 12)})`,
				);
				continue;
			}

			const scanJob = await enqueueAutoDeltaScan({
				composeId: composeTarget.composeId,
				headSha: remote.headSha,
				branch: remote.branch,
			});
			rememberState(
				targetKey,
				`queued:${remote.headSha}`,
				`Queued auto delta scan ${scanJob.scanJobId} for ${composeTarget.name} on ${remote.branch} (${remote.headSha.slice(0, 12)})`,
			);
		} catch (error) {
			rememberState(
				targetKey,
				`error:${error instanceof Error ? error.message : "unknown"}`,
				`Error polling ${composeTarget.name}: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			);
		}
	}
};

export const initAutoDeltaScanPolling = async () => {
	if (autoDeltaScanTimer) {
		return;
	}

	const runOnce = async () => {
		if (autoDeltaScanInFlight) {
			return;
		}

		autoDeltaScanInFlight = true;
		try {
			await pollAutoDeltaScanTargets();
		} finally {
			autoDeltaScanInFlight = false;
		}
	};

	await runOnce();
	autoDeltaScanTimer = setInterval(() => {
		void runOnce();
	}, AUTO_DELTA_SCAN_POLL_INTERVAL_MS);

	process.once("SIGTERM", () => {
		if (autoDeltaScanTimer) {
			clearInterval(autoDeltaScanTimer);
			autoDeltaScanTimer = null;
		}
	});
};
