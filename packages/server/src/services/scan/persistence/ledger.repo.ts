import { db } from "@vulseek/server/db";
import {
	scanLedgerEntries,
	type scanLedgerFunctionStateEnum,
	scanPipelines,
} from "@vulseek/server/db/schema";
import type { LedgerPrimitive } from "@vulseek/server/db/schema/ledger-json";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNull,
	type SQL,
	sql,
} from "drizzle-orm";

export type FunctionCoverageState =
	(typeof scanLedgerFunctionStateEnum.enumValues)[number];
export type LedgerEntryRow = typeof scanLedgerEntries.$inferSelect;
export type LedgerFunctionRow = LedgerEntryRow;

export type LedgerScope = {
	organizationId: string;
	applicationId: string | null;
	composeId: string | null;
	projectId: string | null;
	repoId: string;
	snapshotId: string;
};

export type InsertLedgerEntryInput = {
	organizationId: string;
	applicationId: string | null;
	composeId: string | null;
	projectId: string | null;
	sourceJobId: string;
	repoId: string;
	snapshotId: string;
	file: string;
	functionName: string;
	line: number;
	endLine?: number | null;
	state: FunctionCoverageState;
	primitives: LedgerPrimitive[];
	revision: number;
	createdBy: string;
	updatedBy: string;
};

export type CasLedgerEntryPatch = {
	state?: FunctionCoverageState;
	primitives?: LedgerPrimitive[];
	updatedBy: string;
	updatedAt: string;
};

export const findPipelineOrganizationIdRepo = async (pipelineId: string) =>
	db
		.select({ organizationId: scanPipelines.organizationId })
		.from(scanPipelines)
		.where(eq(scanPipelines.pipelineId, pipelineId))
		.limit(1)
		.then((rows) => rows[0]?.organizationId ?? null);

export const insertLedgerEntryRepo = async (input: InsertLedgerEntryInput) => {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(scanLedgerEntries)
		.values({
			...input,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return row!;
};

export const findLedgerEntryByIdRepo = async (id: number) =>
	db
		.select()
		.from(scanLedgerEntries)
		.where(eq(scanLedgerEntries.id, id))
		.limit(1)
		.then((rows) => rows[0] ?? null);

export const updateLedgerEntryCasRepo = async (input: {
	id: number;
	expectedRevision: number;
	patch: CasLedgerEntryPatch;
}) => {
	const [row] = await db
		.update(scanLedgerEntries)
		.set({
			...input.patch,
			revision: sql`${scanLedgerEntries.revision} + 1`,
		})
		.where(
			and(
				eq(scanLedgerEntries.id, input.id),
				eq(scanLedgerEntries.revision, input.expectedRevision),
			),
		)
		.returning();
	return row ?? null;
};

export const findLedgerFunctionByIdentityRepo = async (input: {
	organizationId: string;
	repoId: string;
	snapshotId: string;
	file: string;
	functionName: string;
}) =>
	db
		.select()
		.from(scanLedgerEntries)
		.where(
			and(
				eq(scanLedgerEntries.organizationId, input.organizationId),
				eq(scanLedgerEntries.repoId, input.repoId),
				eq(scanLedgerEntries.snapshotId, input.snapshotId),
				eq(scanLedgerEntries.file, input.file),
				eq(scanLedgerEntries.functionName, input.functionName),
			),
		)
		.limit(1)
		.then((rows) => rows[0] ?? null);

export const listLedgerEntriesRepo = async (input: {
	scope: Pick<LedgerScope, "applicationId" | "composeId">;
	snapshotId?: string | null;
	includeOtherSnapshots?: boolean;
	state?: FunctionCoverageState;
	functionName?: string;
	file?: string;
}) => {
	const filters = [scopePredicate(input.scope)];
	if (!input.includeOtherSnapshots && input.snapshotId) {
		filters.push(eq(scanLedgerEntries.snapshotId, input.snapshotId));
	}
	if (input.state) {
		filters.push(eq(scanLedgerEntries.state, input.state));
	}
	if (input.functionName?.trim()) {
		const pattern = `%${escapeLike(input.functionName.trim())}%`;
		filters.push(
			sql`${scanLedgerEntries.functionName} ilike ${pattern} escape '\\'`,
		);
	}
	if (input.file?.trim()) {
		const prefix = input.file.trim();
		const likePattern = `${escapeLike(prefix)}%`;
		filters.push(
			sql`(
				${scanLedgerEntries.file} = ${prefix}
				or ${scanLedgerEntries.file} like ${likePattern} escape '\\'
			)`,
		);
	}
	return db
		.select()
		.from(scanLedgerEntries)
		.where(and(...filters))
		.orderBy(desc(scanLedgerEntries.updatedAt), asc(scanLedgerEntries.id));
};

const ledgerSortColumn = (field: string | undefined) => {
	switch (field) {
		case "id":
			return scanLedgerEntries.id;
		case "state":
			return scanLedgerEntries.state;
		case "title":
		case "functionName":
			return scanLedgerEntries.functionName;
		case "statement":
		case "file":
			return scanLedgerEntries.file;
		case "line":
			return scanLedgerEntries.line;
		case "primitiveCount":
			return sql`jsonb_array_length(${scanLedgerEntries.primitives})`;
		case "revision":
			return scanLedgerEntries.revision;
		case "updatedAt":
			return scanLedgerEntries.updatedAt;
		default:
			return scanLedgerEntries.createdAt;
	}
};

export const listLedgerEntriesPageRepo = async (input: {
	scope: Pick<LedgerScope, "applicationId" | "composeId">;
	snapshotId?: string | null;
	includeOtherSnapshots?: boolean;
	sourceJobId?: string;
	states?: FunctionCoverageState[];
	query?: string;
	sortField?: string;
	sortDirection?: "asc" | "desc";
	page: number;
	pageSize: number;
}) => {
	const page = Math.max(1, input.page);
	const pageSize = Math.max(1, Math.min(100, input.pageSize));
	const filters: SQL[] = [scopePredicate(input.scope)];
	if (!input.includeOtherSnapshots && input.snapshotId) {
		filters.push(eq(scanLedgerEntries.snapshotId, input.snapshotId));
	}
	if (input.sourceJobId) {
		filters.push(eq(scanLedgerEntries.sourceJobId, input.sourceJobId));
	}
	if (input.states && input.states.length > 0) {
		filters.push(inArray(scanLedgerEntries.state, input.states));
	}
	const query = input.query?.trim() ?? "";
	if (query) {
		const pattern = `%${escapeLike(query)}%`;
		filters.push(
			sql`(
				${scanLedgerEntries.functionName} ilike ${pattern} escape '\\'
				or ${scanLedgerEntries.file} ilike ${pattern} escape '\\'
				or ${scanLedgerEntries.primitives}::text ilike ${pattern} escape '\\'
			)`,
		);
	}
	const where = and(...filters);
	const [totalRow] = await db
		.select({ total: count() })
		.from(scanLedgerEntries)
		.where(where);
	const total = Number(totalRow?.total ?? 0);
	const sortColumn = ledgerSortColumn(input.sortField);
	const order =
		input.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
	const items = await db
		.select()
		.from(scanLedgerEntries)
		.where(where)
		.orderBy(
			order,
			desc(scanLedgerEntries.updatedAt),
			asc(scanLedgerEntries.id),
		)
		.limit(pageSize)
		.offset((page - 1) * pageSize);
	return {
		items,
		total,
		page,
		pageSize,
	};
};

const scopePredicate = (
	scope: Pick<LedgerScope, "applicationId" | "composeId">,
) => {
	if (scope.applicationId) {
		return eq(scanLedgerEntries.applicationId, scope.applicationId);
	}
	if (scope.composeId) {
		return eq(scanLedgerEntries.composeId, scope.composeId);
	}
	return isNull(scanLedgerEntries.applicationId);
};

const escapeLike = (value: string) =>
	value.replace(/[\\%_]/g, (char) => `\\${char}`);
