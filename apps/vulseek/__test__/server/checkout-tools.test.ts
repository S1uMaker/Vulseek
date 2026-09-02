import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	buildCheckoutToolsImageTag,
	buildCheckoutToolsStatus,
	canRebuildCheckoutTools,
	computeCheckoutToolsVersion,
	createCheckoutToolsBuildManager,
	inspectRequiredToolsImageReference,
	checkoutImageMatchesCurrentTools,
	matchesCheckoutToolsImageLabels,
	resolveCheckoutToolsImageVariant,
	SCAN_TOOLS_VERSION_LABEL,
} from "@vulseek/server/services/scan/checkout-tools";
import { describe, expect, it, vi } from "vitest";

const definitionInputs = {
	dockerfile: "FROM ubuntu:24.04\nRUN echo tools\n",
	codexAcpPatch: "codex patch",
	acpDriver: "driver source",
	agentEvents: "normalizer source",
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};

describe("checkout tools definition", () => {
	it("allows owner and admin roles to rebuild tools", () => {
		expect(canRebuildCheckoutTools("owner")).toBe(true);
		expect(canRebuildCheckoutTools("admin")).toBe(true);
		expect(canRebuildCheckoutTools("member")).toBe(false);
	});

	it("uses all immutable build inputs for a stable version", () => {
		const version = computeCheckoutToolsVersion(definitionInputs);

		expect(version).toMatch(/^[a-f0-9]{64}$/);
		expect(computeCheckoutToolsVersion(definitionInputs)).toBe(version);
		expect(
			computeCheckoutToolsVersion({
				...definitionInputs,
				codexAcpPatch: "changed patch",
			}),
		).not.toBe(version);
		expect(buildCheckoutToolsImageTag(version, "dev")).toBe(
			`vulseek-scan-tools-dev:${version.slice(0, 16)}`,
		);
		expect(buildCheckoutToolsImageTag(version, "release")).toBe(
			`vulseek-scan-tools-release:${version.slice(0, 16)}`,
		);
	});

	it("resolves explicit tools image variants before environment defaults", () => {
		expect(
			resolveCheckoutToolsImageVariant({
				NODE_ENV: "production",
				VULSEEK_TOOLS_IMAGE_VARIANT: "dev",
			}),
		).toBe("dev");
		expect(
			resolveCheckoutToolsImageVariant({
				NODE_ENV: "development",
				VULSEEK_TOOLS_IMAGE_VARIANT: "release",
			}),
		).toBe("release");
	});

	it("defaults production to release and other environments to dev", () => {
		expect(resolveCheckoutToolsImageVariant({ NODE_ENV: "production" })).toBe(
			"release",
		);
		expect(resolveCheckoutToolsImageVariant({ NODE_ENV: "development" })).toBe(
			"dev",
		);
		expect(resolveCheckoutToolsImageVariant({})).toBe("dev");
	});

	it("rejects an invalid explicit tools image variant", () => {
		expect(() =>
			resolveCheckoutToolsImageVariant({
				VULSEEK_TOOLS_IMAGE_VARIANT: "staging",
			}),
		).toThrow("VULSEEK_TOOLS_IMAGE_VARIANT must be dev or release");
	});

	it("requires both version and variant image labels to match", () => {
		const definition = {
			version: "a".repeat(64),
			variant: "release" as const,
			imageTag: `vulseek-scan-tools-release:${"a".repeat(16)}`,
		};
		const labels = {
			"com.fuzzing-peach.vulseek.scan-tools.version": definition.version,
			"com.fuzzing-peach.vulseek.scan-tools.variant": "release",
		};

		expect(matchesCheckoutToolsImageLabels(definition, labels)).toBe(true);
		expect(
			matchesCheckoutToolsImageLabels(definition, {
				...labels,
				"com.fuzzing-peach.vulseek.scan-tools.variant": "dev",
			}),
		).toBe(false);
	});

	it("treats a checkout image as current only when it was built from this tools version", () => {
		expect(
			checkoutImageMatchesCurrentTools(
				{ [SCAN_TOOLS_VERSION_LABEL]: "abc" },
				"abc",
			),
		).toBe(true);
		expect(
			checkoutImageMatchesCurrentTools(
				{ [SCAN_TOOLS_VERSION_LABEL]: "old" },
				"abc",
			),
		).toBe(false);
		expect(checkoutImageMatchesCurrentTools(null, "abc")).toBe(false);
	});

	it("keeps tools and repository checkout in separate Dockerfiles", async () => {
		const dockerfilesDir = path.resolve(
			process.cwd(),
			"../../packages/server/src/services/dockerfiles",
		);
		const [toolsDockerfile, checkoutDockerfile, codexAcpPatch] = await Promise.all([
			readFile(path.join(dockerfilesDir, "Dockerfile.scan-tools"), "utf8"),
			readFile(
				path.join(dockerfilesDir, "Dockerfile.scan-checkout.template"),
				"utf8",
			),
			readFile(
				path.join(dockerfilesDir, "codex-acp-fork-1.3.0.patch"),
				"utf8",
			),
		]);

		expect(toolsDockerfile).toContain(
			'LABEL com.fuzzing-peach.vulseek.scan-tools.version="${VULSEEK_TOOLS_VERSION}"',
		);
		expect(toolsDockerfile).toContain(
			'com.fuzzing-peach.vulseek.scan-tools.variant="${VULSEEK_TOOLS_VARIANT}"',
		);
		expect(toolsDockerfile).toContain('ARG CODEQL_VERSION="2.26.3"');
		expect(toolsDockerfile).not.toContain("# syntax=docker/dockerfile:1");
		expect(toolsDockerfile).not.toContain("AS repository-source");
		expect(toolsDockerfile).not.toContain("codex-acp-builder");
		expect(toolsDockerfile).not.toContain("sandbox-agent");
		expect(toolsDockerfile).toContain("@agentclientprotocol/sdk@1.3.0");
		expect(toolsDockerfile).toContain(
			"! grep -F 'requires goal text of at most 4000 characters'",
		);
		expect(codexAcpPatch).toContain("if (argument.length > 4e3)");
		expect(codexAcpPatch).toContain(
			'Command "/goal" requires goal text of at most 4000 characters.',
		);
		expect(codexAcpPatch).toContain(
			"const fullObjective = objective.length > 4e3 ? objective : null",
		);
		expect(codexAcpPatch).toContain("await this.steerTurn({");
		expect(codexAcpPatch).toContain("await onGoalTurnStarted?.(turnId)");
		expect(toolsDockerfile).toContain(
			"const fullObjective = objective.length > 4e3 ? objective : null",
		);
		expect(codexAcpPatch).not.toMatch(/^ @@/m);
		expect(toolsDockerfile).toContain("https://x.ai/cli/install.sh");
		expect(toolsDockerfile).not.toContain("COPY grok /usr/local/bin/grok");
		expect(toolsDockerfile).toContain("grok --version");
		expect(checkoutDockerfile).toContain("ARG VULSEEK_TOOLS_IMAGE");
		expect(checkoutDockerfile).not.toContain("# syntax=docker/dockerfile:1");
		expect(checkoutDockerfile).toContain(
			"FROM ${VULSEEK_TOOLS_IMAGE} AS repository-source",
		);
		expect(checkoutDockerfile).toContain(
			"FROM ${VULSEEK_TOOLS_IMAGE} AS final",
		);
		expect(checkoutDockerfile).not.toContain("codeql pack download");
	});

	it("reports a failed rebuild while preserving the previous image", () => {
		const version = "c".repeat(64);
		const variant = "dev" as const;
		const imageTag = buildCheckoutToolsImageTag(version, variant);
		const status = buildCheckoutToolsStatus({
			definition: { version, variant, imageTag },
			image: {
				version,
				variant,
				imageTag,
				imageId: "sha256:old-image",
				builtAt: "2026-07-14T09:00:00.000Z",
			},
			activeBuild: null,
			latestBuild: {
				buildId: "failed-build",
				version,
				variant,
				imageTag,
				status: "failed",
				stdout: "",
				stderr: "network failed",
				errorMessage: "network failed",
				startedAt: "2026-07-14T10:00:00.000Z",
				finishedAt: "2026-07-14T10:01:00.000Z",
			},
			canRebuild: true,
		});

		expect(status.exists).toBe(true);
		expect(status.state).toBe("failed");
		expect(status.builtAt).toBe("2026-07-14T09:00:00.000Z");
		expect(status.lastError).toBe("network failed");
	});
});

describe("checkout tools build manager", () => {
	it("single-flights concurrent rebuild requests", async () => {
		const build = deferred<void>();
		const executeBuild = vi.fn(() => build.promise);
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({
				version: "a".repeat(64),
				variant: "dev",
				imageTag: `vulseek-scan-tools-dev:${"a".repeat(16)}`,
			}),
			inspectImage: async () => null,
			executeBuild,
			createBuildId: () => "tools-build-1",
			now: () => new Date("2026-07-14T10:00:00.000Z"),
		});

		const [first, second] = await Promise.all([
			manager.startBuild(),
			manager.startBuild(),
		]);

		expect(first.buildId).toBe("tools-build-1");
		expect(second.buildId).toBe(first.buildId);
		expect(executeBuild).toHaveBeenCalledTimes(1);

		build.resolve();
		await manager.waitForBuild(first.buildId);
		expect(manager.findBuild(first.buildId)?.status).toBe("completed");
	});

	it("builds a missing image before returning it to checkout", async () => {
		let imageExists = false;
		const executeBuild = vi.fn(async () => {
			imageExists = true;
		});
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({
				version: "b".repeat(64),
				variant: "dev",
				imageTag: `vulseek-scan-tools-dev:${"b".repeat(16)}`,
			}),
			inspectImage: async ({ version, variant, imageTag }) =>
				imageExists
					? {
							version,
							variant,
							imageTag,
							imageId: "sha256:image",
							builtAt: "2026-07-14T10:00:00.000Z",
						}
					: null,
			executeBuild,
			createBuildId: () => "tools-build-2",
		});

		const image = await manager.ensureImage();

		expect(executeBuild).toHaveBeenCalledTimes(1);
		expect(image.imageId).toBe("sha256:image");
	});

	it("keeps checkout available while an existing tools image is rebuilding", async () => {
		const build = deferred<void>();
		const version = "d".repeat(64);
		const variant = "dev" as const;
		const imageTag = buildCheckoutToolsImageTag(version, variant);
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({ version, variant, imageTag }),
			inspectImage: async () => ({
				version,
				variant,
				imageTag,
				imageId: "sha256:existing-image",
				builtAt: "2026-07-14T09:00:00.000Z",
			}),
			executeBuild: () => build.promise,
			createBuildId: () => "tools-build-3",
		});

		const rebuilding = await manager.startBuild();
		const image = await manager.ensureImage();

		expect(rebuilding.status).toBe("running");
		expect(image.imageId).toBe("sha256:existing-image");
		expect(manager.findBuild(rebuilding.buildId)?.status).toBe("running");

		build.resolve();
		await manager.waitForBuild(rebuilding.buildId);
	});

	it("shares a failed bootstrap across concurrent waiting checkouts", async () => {
		const build = deferred<void>();
		const executeBuild = vi.fn(() => build.promise);
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({
				version: "e".repeat(64),
				variant: "dev",
				imageTag: `vulseek-scan-tools-dev:${"e".repeat(16)}`,
			}),
			inspectImage: async () => null,
			executeBuild,
			createBuildId: () => "tools-build-4",
		});

		const firstCheckout = manager.ensureImage();
		const secondCheckout = manager.ensureImage();
		await vi.waitFor(() => expect(executeBuild).toHaveBeenCalledTimes(1));
		build.reject(new Error("tools bootstrap failed"));

		await expect(firstCheckout).rejects.toThrow("tools bootstrap failed");
		await expect(secondCheckout).rejects.toThrow("tools bootstrap failed");
		expect(manager.findBuild("tools-build-4")?.status).toBe("failed");
	});
});

describe("pinned tools image references", () => {
	it("rejects a missing or changed image reference", async () => {
		await expect(
			inspectRequiredToolsImageReference({
				imageTag: "vulseek-scan-tools-dev:test-missing",
				imageId: "sha256:expected-image",
			}),
		).resolves.toBe(false);
	});
});
