import {
	appendPrimitiveForRequest,
	assignFunctionForRequest,
	ensureFunctionForRequest,
	listLedgerForRequest,
	setFunctionStateForRequest,
	updateLedgerForRequest,
	ScanRuntimeApiError,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";

const readHeader = (req: NextApiRequest, name: string) => {
	const value = req.headers[name];
	if (Array.isArray(value)) {
		return value[0] ?? null;
	}
	return value ?? null;
};

const readQuery = (req: NextApiRequest, name: string) => {
	const value = req.query[name];
	if (Array.isArray(value)) {
		return value[0] ?? null;
	}
	return value ?? null;
};

const truthy = (value: string | null) =>
	value === "1" || value === "true" || value === "yes";

const errorBody = (error: ScanRuntimeApiError) => ({
	ok: false as const,
	error: error.message,
	...(error.code ? { code: error.code } : {}),
	...(error.current !== undefined ? { current: error.current } : {}),
});

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const authorization = readHeader(req, "authorization");
	const scanJobId = readHeader(req, "x-vulseek-scan-job-id");
	const taskId = readHeader(req, "x-vulseek-task-id");
	try {
		if (req.method === "GET") {
			const result = await listLedgerForRequest({
				authorization,
				scanJobId,
				taskId,
				id: readQuery(req, "id"),
				primitiveId: readQuery(req, "primitiveId"),
				type: readQuery(req, "type"),
				verdict: readQuery(req, "verdict"),
				state: readQuery(req, "state"),
				title: readQuery(req, "title"),
				functionName: readQuery(req, "functionName"),
				file: readQuery(req, "file"),
				unlinkedSinks: truthy(readQuery(req, "unlinkedSinks")),
				includeOtherSnapshots: truthy(
					readQuery(req, "includeOtherSnapshots") ??
						readQuery(req, "includeOtherCommits"),
				),
			});
			return res.status(200).json(result);
		}
		if (req.method === "POST") {
			const action =
				req.body && typeof req.body === "object" && "action" in req.body
					? (req.body as { action?: unknown }).action
					: undefined;
			const id = readQuery(req, "id");
			if (action === "ensure-function") {
				const result = await ensureFunctionForRequest({
					authorization,
					scanJobId,
					taskId,
					body: req.body,
				});
				return res.status(200).json(result);
			}
			if (action === "assign-function") {
				const result = await assignFunctionForRequest({
					authorization,
					scanJobId,
					taskId,
					id,
					body: req.body,
				});
				return res.status(200).json(result);
			}
			if (action === "set-function-state") {
				const result = await setFunctionStateForRequest({
					authorization,
					scanJobId,
					taskId,
					id,
					body: req.body,
				});
				return res.status(200).json(result);
			}
			if (action === "append-primitive") {
				const result = await appendPrimitiveForRequest({
					authorization,
					scanJobId,
					taskId,
					id,
					body: req.body,
				});
				return res.status(200).json(result);
			}
			if (action === "update" || action === "update-primitive") {
				const result = await updateLedgerForRequest({
					authorization,
					scanJobId,
					taskId,
					id,
					body: req.body,
				});
				return res.status(200).json(result);
			}
			return res.status(400).json({
				ok: false,
				error: "Unknown ledger action",
				code: "VALIDATION_ERROR",
			});
		}
		if (req.method === "PATCH") {
			const result = await updateLedgerForRequest({
				authorization,
				scanJobId,
				taskId,
				id: readQuery(req, "id"),
				body: req.body,
			});
			return res.status(200).json(result);
		}
		res.setHeader("Allow", "GET, POST, PATCH");
		return res.status(405).json({ ok: false, error: "Method not allowed" });
	} catch (error) {
		if (error instanceof ScanRuntimeApiError) {
			return res.status(error.status).json(errorBody(error));
		}
		return res.status(500).json({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
