import {
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { messages, scanJobs, tasks } from "./scan";

const timestamp = () => new Date().toISOString();

export type TobGoalCandidateContent = {
	candidateId: string;
	huntGoalId: string;
	title: string;
	description: string;
	vulnerabilityClass?: string | null;
	location: {
		filePath: string;
		line?: number | null;
		symbol?: string | null;
	};
	claim: string;
	rootCauseKey: string;
	evidence?: Array<Record<string, unknown>>;
	attackerControl?: string | null;
	preconditions?: string[];
	quickDisproofAttempt?: string | null;
	confidence?: number | null;
	[key: string]: unknown;
};

export type TobGoalFindingContent = TobGoalCandidateContent & {
	findingId: string;
	sourceCandidateId: string;
	novelty?: string;
	references?: string[];
};

export const tobGoalCandidates = pgTable(
	"tob_goal_candidates",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		candidateId: text("candidateId").notNull(),
		huntGoalId: text("huntGoalId").notNull(),
		huntTaskId: text("huntTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		messageId: text("messageId").references(() => messages.messageId, {
			onDelete: "set null",
		}),
		status: text("status").notNull().default("discovered"),
		title: text("title").notNull(),
		summary: text("summary").notNull().default(""),
		content: jsonb("content").$type<TobGoalCandidateContent>().notNull(),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		primaryKey({ columns: [table.scanJobId, table.candidateId] }),
		index("tob_goal_candidates_scan_job_idx").on(
			table.scanJobId,
			table.updatedAt,
		),
		index("tob_goal_candidates_status_idx").on(table.scanJobId, table.status),
		index("tob_goal_candidates_hunt_goal_idx").on(
			table.scanJobId,
			table.huntGoalId,
		),
	],
);

export const tobGoalFindings = pgTable(
	"tob_goal_findings",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		findingId: text("findingId").notNull(),
		sourceCandidateId: text("sourceCandidateId").notNull(),
		huntGoalId: text("huntGoalId").notNull(),
		messageId: text("messageId").references(() => messages.messageId, {
			onDelete: "set null",
		}),
		status: text("status").notNull().default("novel"),
		title: text("title").notNull(),
		summary: text("summary").notNull().default(""),
		content: jsonb("content").$type<TobGoalFindingContent>().notNull(),
		dedupRefs: jsonb("dedupRefs").$type<string[]>().notNull().default([]),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		primaryKey({ columns: [table.scanJobId, table.findingId] }),
		index("tob_goal_findings_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("tob_goal_findings_candidate_idx").on(
			table.scanJobId,
			table.sourceCandidateId,
		),
	],
);

export const createTobGoalCandidateId = () => nanoid();
export const createTobGoalFindingId = () => nanoid();
