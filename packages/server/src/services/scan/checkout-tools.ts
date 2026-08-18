import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { execFileAsync } from "../../utils/process/execAsync";

const MAX_BUILD_LOG_CHARS = 400_000;

export type CheckoutToolsDefinitionInputs = {
	dockerfile: string;
	codexAcpPatch: string;
	acpDriver: string;
	agentEvents: string;
};

export type CheckoutToolsImageVariant = "dev" | "release";

export type CheckoutToolsDefinition = {
	version: string;
	variant: CheckoutToolsImageVariant;
	imageTag: string;
};

export type CheckoutToolsAssets = CheckoutToolsDefinition & {
	dockerfile: string;
	codexAcpPatchPath: string;
	acpDriverPath: string;
	agentEventsPath: string;
};

export type CheckoutToolsImageMetadata = CheckoutToolsDefinition & {
	imageId: string;
	builtAt: string;
};

const resolveAssetPath = async (fileName: string) => {
	const candidates = [
		path.resolve(process.cwd(), "packages/server/src/services/dockerfiles", fileName),
		path.resolve(process.cwd(), "packages/server/dist/services/dockerfiles", fileName),
		path.resolve(process.cwd(), "../../packages/server/src/services/dockerfiles", fileName),
		path.resolve(process.cwd(), "../../packages/server/dist/services/dockerfiles", fileName),
		path.join("/app/packages/server/src/services/dockerfiles", fileName),
		path.resolve(process.cwd(), "node_modules/@vulseek/server/src/services/dockerfiles", fileName),
		path.resolve(process.cwd(), "node_modules/@vulseek/server/dist/services/dockerfiles", fileName),
		path.join("/app/node_modules/@vulseek/server/src/services/dockerfiles", fileName),
		path.join("/app/node_modules/@vulseek/server/dist/services/dockerfiles", fileName),
	];
	for (const candidate of candidates) {
		try {
			if ((await fs.stat(candidate)).isFile()) return candidate;
		} catch {}
	}
	throw new Error(`Unable to locate ${fileName}`);
};

const resolveAgentEventsPath = async () => {
	const candidates = [
		path.resolve(process.cwd(), "vendor/claude-replay/src/agent-events.mjs"),
		path.resolve(process.cwd(), "../../vendor/claude-replay/src/agent-events.mjs"),
		path.resolve(process.cwd(), "node_modules/claude-replay/src/agent-events.mjs"),
		"/app/vendor/claude-replay/src/agent-events.mjs",
		"/app/node_modules/claude-replay/src/agent-events.mjs",
	];
	for (const candidate of candidates) {
		try {
			if ((await fs.stat(candidate)).isFile()) return candidate;
		} catch {}
	}
	throw new Error("Unable to locate claude-replay agent-events.mjs");
};

export const resolveCheckoutToolsDefinition = async (): Promise<CheckoutToolsAssets> => {
	const [dockerfilePath, codexAcpPatchPath, acpDriverPath, agentEventsPath] =
		await Promise.all([
			resolveAssetPath("Dockerfile.scan-tools"),
			resolveAssetPath("codex-acp-fork-1.3.0.patch"),
			resolveAssetPath("vulseek-acp-driver.mjs"),
			resolveAgentEventsPath(),
		]);
	const [dockerfile, codexAcpPatch, acpDriver, agentEvents] = await Promise.all([
		fs.readFile(dockerfilePath, "utf8"),
		fs.readFile(codexAcpPatchPath, "utf8"),
		fs.readFile(acpDriverPath, "utf8"),
		fs.readFile(agentEventsPath, "utf8"),
	]);
	const version = computeCheckoutToolsVersion({
		dockerfile,
		codexAcpPatch,
		acpDriver,
		agentEvents,
	});
	const variant = resolveCheckoutToolsImageVariant();
	return {
		version,
		variant,
		imageTag: buildCheckoutToolsImageTag(version, variant),
		dockerfile,
		codexAcpPatchPath,
		acpDriverPath,
		agentEventsPath,
	};
};

export const inspectCheckoutToolsImage = async (
	definition: CheckoutToolsDefinition,
): Promise<CheckoutToolsImageMetadata | null> => {
	try {
		const { stdout } = await execFileAsync("docker", [
			"image",
			"inspect",
			definition.imageTag,
		]);
		const inspect = JSON.parse(stdout) as Array<{
			Id?: string;
			Created?: string;
			Config?: { Labels?: Record<string, string> | null };
		}>;
		const image = inspect[0];
		const labels = image?.Config?.Labels;
		if (!image?.Id || !matchesCheckoutToolsImageLabels(definition, labels)) {
			return null;
		}
		return {
			...definition,
			imageId: image.Id,
			builtAt:
				labels?.["com.fuzzing-peach.vulseek.scan-tools.built-at"] ||
				image.Created ||
				"",
		};
	} catch {
		return null;
	}
};

export const resolveRequiredToolsImage = async () => {
	const definition = await resolveCheckoutToolsDefinition();
	const image = await inspectCheckoutToolsImage(definition);
	if (!image) {
		throw new Error(
			`Required ${definition.variant} scan tools image is unavailable or stale: ${definition.imageTag}`,
		);
	}
	return image;
};

export const inspectRequiredToolsImageReference = async (input: {
	imageTag: string;
	imageId: string;
}) => {
	try {
		const { stdout } = await execFileAsync("docker", ["image", "inspect", input.imageTag]);
		const image = (JSON.parse(stdout) as Array<{ Id?: string }>)[0];
		return image?.Id === input.imageId;
	} catch {
		return false;
	}
};

export type CheckoutToolsBuild = CheckoutToolsDefinition & {
	buildId: string;
	status: "running" | "completed" | "failed";
	stdout: string;
	stderr: string;
	errorMessage: string | null;
	startedAt: string;
	finishedAt: string | null;
};

type ExecuteBuildContext = {
	definition: CheckoutToolsDefinition;
	builtAt: string;
	appendStdout: (chunk: string) => void;
	appendStderr: (chunk: string) => void;
};

export type CheckoutToolsBuildManagerDependencies = {
	resolveDefinition: () => Promise<CheckoutToolsDefinition>;
	inspectImage: (
		definition: CheckoutToolsDefinition,
	) => Promise<CheckoutToolsImageMetadata | null>;
	executeBuild: (context: ExecuteBuildContext) => Promise<void>;
	createBuildId?: () => string;
	now?: () => Date;
};

const appendLog = (base: string, chunk: string) => {
	const combined = `${base}${chunk}`;
	return combined.length <= MAX_BUILD_LOG_CHARS
		? combined
		: combined.slice(-MAX_BUILD_LOG_CHARS);
};

export const computeCheckoutToolsVersion = (
	inputs: CheckoutToolsDefinitionInputs,
) => {
	const hash = createHash("sha256");
	for (const [name, value] of Object.entries(inputs)) {
		hash.update(`${name}\0${Buffer.byteLength(value)}\0`);
		hash.update(value);
	}
	return hash.digest("hex");
};

export const resolveCheckoutToolsImageVariant = (
	environment: Readonly<Record<string, string | undefined>> = process.env,
): CheckoutToolsImageVariant => {
	const configured = environment.VULSEEK_TOOLS_IMAGE_VARIANT?.trim();
	if (configured) {
		if (configured === "dev" || configured === "release") return configured;
		throw new Error("VULSEEK_TOOLS_IMAGE_VARIANT must be dev or release");
	}
	return environment.NODE_ENV === "production" ? "release" : "dev";
};

export const buildCheckoutToolsImageTag = (
	version: string,
	variant: CheckoutToolsImageVariant,
) => `vulseek-scan-tools-${variant}:${version.slice(0, 16)}`;

export const matchesCheckoutToolsImageLabels = (
	definition: Pick<CheckoutToolsDefinition, "version" | "variant">,
	labels: Record<string, string> | null | undefined,
) =>
	labels?.["com.fuzzing-peach.vulseek.scan-tools.version"] ===
		definition.version &&
	labels?.["com.fuzzing-peach.vulseek.scan-tools.variant"] ===
		definition.variant;

export const canRebuildCheckoutTools = (role: "owner" | "admin" | "member") =>
	role === "owner" || role === "admin";

export const buildCheckoutToolsStatus = (input: {
	definition: CheckoutToolsDefinition;
	image: CheckoutToolsImageMetadata | null;
	activeBuild: CheckoutToolsBuild | null;
	latestBuild: CheckoutToolsBuild | null;
	canRebuild: boolean;
}) => {
	const failedBuild =
		input.latestBuild?.status === "failed" ? input.latestBuild : null;
	return {
		version: input.definition.version,
		shortVersion: input.definition.version.slice(0, 12),
		imageTag: input.definition.imageTag,
		imageId: input.image?.imageId ?? null,
		exists: Boolean(input.image),
		builtAt: input.image?.builtAt ?? null,
		state: input.activeBuild
			? ("building" as const)
			: failedBuild
				? ("failed" as const)
				: input.image
					? ("ready" as const)
					: ("missing" as const),
		activeBuildId: input.activeBuild?.buildId ?? null,
		lastError: failedBuild?.errorMessage ?? null,
		canRebuild: input.canRebuild,
	};
};

export const createCheckoutToolsBuildManager = (
	dependencies: CheckoutToolsBuildManagerDependencies,
) => {
	const builds = new Map<string, CheckoutToolsBuild>();
	const buildPromises = new Map<string, Promise<void>>();
	const createBuildId = dependencies.createBuildId ?? nanoid;
	const now = dependencies.now ?? (() => new Date());
	let activeBuildId: string | null = null;
	let latestBuildId: string | null = null;
	let startInFlight: Promise<CheckoutToolsBuild> | null = null;

	const runBuild = (
		build: CheckoutToolsBuild,
		definition: CheckoutToolsDefinition,
	) => {
		const promise = dependencies
			.executeBuild({
				definition,
				builtAt: build.startedAt,
				appendStdout: (chunk) => {
					build.stdout = appendLog(build.stdout, chunk);
				},
				appendStderr: (chunk) => {
					build.stderr = appendLog(build.stderr, chunk);
				},
			})
			.then(() => {
				build.status = "completed";
			})
			.catch((error) => {
				build.status = "failed";
				build.errorMessage =
					error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				build.finishedAt = now().toISOString();
				if (activeBuildId === build.buildId) activeBuildId = null;
			});
		buildPromises.set(build.buildId, promise);
	};

	const startBuild = async () => {
		if (activeBuildId) {
			const active = builds.get(activeBuildId);
			if (active?.status === "running") return active;
		}
		if (startInFlight) return await startInFlight;

		startInFlight = (async () => {
			if (activeBuildId) {
				const active = builds.get(activeBuildId);
				if (active?.status === "running") return active;
			}
			const definition = await dependencies.resolveDefinition();
			const startedAt = now().toISOString();
			const build: CheckoutToolsBuild = {
				...definition,
				buildId: createBuildId(),
				status: "running",
				stdout: "",
				stderr: "",
				errorMessage: null,
				startedAt,
				finishedAt: null,
			};
			builds.set(build.buildId, build);
			activeBuildId = build.buildId;
			latestBuildId = build.buildId;
			runBuild(build, definition);
			return build;
		})();

		try {
			return await startInFlight;
		} finally {
			startInFlight = null;
		}
	};

	const waitForBuild = async (buildId: string) => {
		await buildPromises.get(buildId);
		const build = builds.get(buildId);
		if (!build)
			throw new Error(`Checkout tools build ${buildId} was not found`);
		return build;
	};

	const ensureImage = async () => {
		const definition = await dependencies.resolveDefinition();
		const existingImage = await dependencies.inspectImage(definition);
		if (existingImage) return existingImage;

		const build = await startBuild();
		const completedBuild = await waitForBuild(build.buildId);
		if (completedBuild.status !== "completed") {
			throw new Error(
				completedBuild.errorMessage || "Checkout tools image build failed",
			);
		}
		const image = await dependencies.inspectImage(definition);
		if (!image) {
			throw new Error(
				`Checkout tools image ${definition.imageTag} is missing after build`,
			);
		}
		return image;
	};

	return {
		startBuild,
		waitForBuild,
		ensureImage,
		findBuild: (buildId: string) => builds.get(buildId) ?? null,
		findActiveBuild: () =>
			activeBuildId ? (builds.get(activeBuildId) ?? null) : null,
		findLatestBuild: () =>
			latestBuildId ? (builds.get(latestBuildId) ?? null) : null,
	};
};
