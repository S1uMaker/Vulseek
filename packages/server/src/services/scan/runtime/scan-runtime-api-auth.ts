import { createHmac, timingSafeEqual } from "node:crypto";
import { getVulseekServiceName } from "../../settings";

const TOKEN_ENCODING = "hex" as const;
type RuntimeEnvironment = Record<string, string | undefined>;

export const resolveScanRuntimeApiSecret = (
	env: RuntimeEnvironment = process.env,
) =>
	env.VULSEEK_RUNTIME_API_SECRET?.trim() ||
	env.BETTER_AUTH_SECRET?.trim() ||
	env.AUTH_SECRET?.trim() ||
	env.JWT_SECRET?.trim() ||
	env.SESSION_SECRET?.trim() ||
	null;

export const resolveScanRuntimeApiUrl = (
	env: RuntimeEnvironment = process.env,
) => {
	const explicit = env.VULSEEK_RUNTIME_API_URL?.trim();
	if (explicit) {
		return explicit.replace(/\/+$/, "");
	}
	const serviceName = env.VULSEEK_SERVICE_NAME?.trim() || getVulseekServiceName();
	return `http://${serviceName}:3000`;
};

export const issueScanRuntimeToken = (
	scanJobId: string,
	secret = resolveScanRuntimeApiSecret(),
) => {
	if (!secret || !scanJobId) {
		return null;
	}
	return createHmac("sha256", secret).update(scanJobId).digest(TOKEN_ENCODING);
};

export const verifyScanRuntimeToken = (input: {
	scanJobId: string;
	token: string | null | undefined;
	secret?: string | null;
}) => {
	const expected = issueScanRuntimeToken(
		input.scanJobId,
		input.secret === undefined
			? resolveScanRuntimeApiSecret()
			: input.secret,
	);
	if (!expected || !input.token) {
		return false;
	}
	const actual = Buffer.from(input.token);
	const wanted = Buffer.from(expected);
	if (actual.length !== wanted.length) {
		return false;
	}
	return timingSafeEqual(actual, wanted);
};

export const parseBearerToken = (authorization: string | null | undefined) => {
	if (!authorization) {
		return null;
	}
	const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
	return match?.[1] ?? null;
};

export const buildScanRuntimeApiEnvPairs = (
	scanJobId: string,
	taskId = "",
	stageName = "",
	env: RuntimeEnvironment = process.env,
) => {
	const url = resolveScanRuntimeApiUrl(env);
	const token = issueScanRuntimeToken(
		scanJobId,
		resolveScanRuntimeApiSecret(env),
	);
	const pairs = [
		`VULSEEK_SCAN_JOB_ID=${scanJobId}`,
		`VULSEEK_TASK_ID=${taskId}`,
		`VULSEEK_STAGE_NAME=${stageName}`,
	];
	if (url && token) {
		pairs.unshift(`VULSEEK_RUNTIME_TOKEN=${token}`);
		pairs.unshift(`VULSEEK_RUNTIME_API_URL=${url}`);
	}
	return pairs;
};

export const ensureScanRuntimeProxyBypass = (
	pairs: readonly string[],
	env: RuntimeEnvironment = process.env,
) => {
	const serviceName = env.VULSEEK_SERVICE_NAME?.trim();
	if (!serviceName) {
		return [...pairs];
	}

	const result = [...pairs];
	for (const key of ["NO_PROXY", "no_proxy"] as const) {
		const index = result.findIndex((pair) => pair.startsWith(`${key}=`));
		const current =
			index >= 0 ? (result[index]?.slice(key.length + 1) ?? "") : "";
		const values = current
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		if (!values.includes(serviceName)) {
			values.push(serviceName);
		}
		const pair = `${key}=${values.join(",")}`;
		if (index >= 0) {
			result[index] = pair;
		} else {
			result.push(pair);
		}
	}
	return result;
};
