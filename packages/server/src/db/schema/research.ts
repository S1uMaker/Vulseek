import {
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { messages, scanJobs, tasks } from "./scan";

const timestamp = () => new Date().toISOString();

export const researchTracks = pgTable(
	"research_tracks",
	{
		trackId: text("trackId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		trackKey: text("trackKey").notNull(),
		approachFamily: text("approachFamily").notNull(),
		researchIdea: text("researchIdea").notNull(),
		scope: jsonb("scope").$type<Record<string, unknown>>().notNull().default({}),
		mechanisms: jsonb("mechanisms").$type<string[]>().notNull().default([]),
		status: text("status").notNull().default("queued"),
		coverage: jsonb("coverage").$type<Record<string, unknown>>().notNull().default({}),
		evidenceRefs: jsonb("evidenceRefs").$type<string[]>().notNull().default([]),
		findingIds: jsonb("findingIds").$type<string[]>().notNull().default([]),
		blockReason: text("blockReason"),
		reopenCondition: text("reopenCondition"),
		nextStep: text("nextStep"),
		iteration: integer("iteration").notNull().default(0),
			revision: integer("revision").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		index("research_tracks_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("research_tracks_key_idx").on(table.scanJobId, table.trackKey),
		uniqueIndex("research_tracks_scan_job_key_unique").on(table.scanJobId, table.trackKey),
	],
);

export type ResearchFindingContent = {
	findingId: string;
	trackKey: string;
	title: string;
	description: string;
	vulnerabilityClass: string | null;
	location: {
		filePath: string;
		line: number | null;
		symbol: string | null;
	};
	claim: string;
	rootCauseKey: string;
	source: Record<string, unknown>;
	sink: Record<string, unknown>;
	attackerControl: string;
	trustBoundaryCrossings: Record<string, unknown>[];
	preconditions: string[];
	evidence: Array<Record<string, unknown>>;
	quickDisproofAttempt: string;
	confidence: number;
};

export const researchFindings = pgTable(
	"research_findings",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		findingId: text("findingId").notNull(),
		trackId: text("trackId")
			.notNull()
			.references(() => researchTracks.trackId, { onDelete: "cascade" }),
		producerTaskId: text("producerTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		messageId: text("messageId").references(() => messages.messageId, {
			onDelete: "set null",
		}),
		content: jsonb("content").$type<ResearchFindingContent>().notNull(),
		status: text("status").notNull().default("discovered"),
		latestValidationVerdict: text("latestValidationVerdict"),
		latestReviewDecision: text("latestReviewDecision"),
		requiredEvidence: jsonb("requiredEvidence").$type<string[]>().notNull().default([]),
		revision: integer("revision").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		primaryKey({ columns: [table.scanJobId, table.findingId] }),
		index("research_findings_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("research_findings_status_idx").on(table.scanJobId, table.status),
		index("research_findings_track_idx").on(table.scanJobId, table.trackId),
	],
);

export const exploitPrimitives = pgTable(
	"exploit_primitives",
	{
		primitiveId: text("primitiveId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		findingId: text("findingId").notNull(),
			name: text("name").notNull(),
			capability: text("capability").notNull(),
		requiredInput: jsonb("requiredInput").$type<Record<string, unknown>>().notNull().default({}),
		producedCapability: jsonb("producedCapability").$type<Record<string, unknown>>().notNull().default({}),
		trustLevel: text("trustLevel").notNull(),
		status: text("status").notNull().default("confirmed"),
		evidenceRefs: jsonb("evidenceRefs").$type<string[]>().notNull().default([]),
		revision: integer("revision").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		index("exploit_primitives_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("exploit_primitives_finding_idx").on(table.scanJobId, table.findingId),
	],
);

export const exploitChains = pgTable(
	"exploit_chains",
	{
		chainId: text("chainId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		chainKey: text("chainKey").notNull(),
		status: text("status").notNull().default("candidate"),
		steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull().default([]),
		entrypoint: jsonb("entrypoint").$type<Record<string, unknown>>().notNull().default({}),
		requiredCapabilities: jsonb("requiredCapabilities").$type<string[]>().notNull().default([]),
		producedCapabilities: jsonb("producedCapabilities").$type<string[]>().notNull().default([]),
		trustBoundaryCrossings: jsonb("trustBoundaryCrossings").$type<Record<string, unknown>[]>().notNull().default([]),
		deploymentConditions: jsonb("deploymentConditions").$type<string[]>().notNull().default([]),
		primitiveGaps: jsonb("primitiveGaps").$type<Record<string, unknown>[]>().notNull().default([]),
		successTarget: jsonb("successTarget").$type<Record<string, unknown>>().notNull().default({}),
		revision: integer("revision").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		index("exploit_chains_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("exploit_chains_key_idx").on(table.scanJobId, table.chainKey),
	],
);
