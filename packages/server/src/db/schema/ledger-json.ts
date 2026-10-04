export const LEDGER_ENTRY_TYPES = [
	"source",
	"sink",
	"gate",
	"connector",
	"impact",
	"hypothesis",
] as const;
export const LEDGER_VERDICTS = [
	"unknown",
	"supported",
	"refuted",
	"contested",
] as const;
export const LEDGER_STATES = [
	"untracked",
	"discovered",
	"assigned",
	"investigating",
	"partial",
	"covered",
	"blocked",
] as const;
export const FUNCTION_COVERAGE_STATES = [
	"discovered",
	"assigned",
	"investigating",
	"partial",
	"covered",
	"verified",
	"blocked",
] as const;
export const LEDGER_EVIDENCE_STANCES = [
	"supports",
	"refutes",
	"inconclusive",
] as const;
export const LEDGER_EVIDENCE_KINDS = [
	"code",
	"static_analysis",
	"runtime_test",
	"derivation",
] as const;
export const LEDGER_GAP_STATUSES = [
	"open",
	"investigating",
	"resolved",
	"blocked",
] as const;
export const LEDGER_RELATIONS = [
	"supports",
	"refutes",
	"depends_on",
	"related_to",
] as const;
export const LEDGER_CHANGE_FIELDS = [
	"state",
	"verdict",
	"assessment",
	"locations",
	"evidence",
	"gaps",
	"links",
] as const;
export const LEDGER_ENTRYPOINT_KINDS = [
	"http",
	"cli",
	"queue",
	"scheduled",
	"function",
	"other",
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];
export type LedgerVerdict = (typeof LEDGER_VERDICTS)[number];
export type LedgerState = (typeof LEDGER_STATES)[number];
export type FunctionCoverageState = (typeof FUNCTION_COVERAGE_STATES)[number];
export type EvidenceStance = (typeof LEDGER_EVIDENCE_STANCES)[number];
export type EvidenceKind = (typeof LEDGER_EVIDENCE_KINDS)[number];
export type GapStatus = (typeof LEDGER_GAP_STATUSES)[number];
export type LedgerRelation = (typeof LEDGER_RELATIONS)[number];
export type LedgerChangeField = (typeof LEDGER_CHANGE_FIELDS)[number];
export type EntrypointKind = (typeof LEDGER_ENTRYPOINT_KINDS)[number];

export type CodeLocation = {
	file: string;
	line: number;
	endLine?: number;
	functionName?: string;
};

export type AuditContext = {
	entrypoint?: { kind: EntrypointKind; name: string };
	actor?: { authenticated?: boolean; role?: string };
	input?: { name: string; accessPath?: string };
	conditions?: string[];
	assumptions?: { description: string; gapId: string }[];
};

export type EvidencePointer = {
	functionId: number;
	primitiveId: string;
	evidenceId: string;
};
export type FunctionRevisionPointer = {
	functionId: number;
	primitiveId: string;
	revision: number;
};
export type ResultPointer = {
	functionId: number;
	primitiveId: string;
	evidenceId?: string;
};
/** @deprecated Use FunctionRevisionPointer. Kept so older imports still typecheck during the cut. */
export type EntryRevisionPointer = FunctionRevisionPointer;
export type ArtifactPointer = { artifactId: string; locator?: string };
export type DerivationInput = EntryRevisionPointer & { evidenceId?: string };

export type Evidence = {
	id: string;
	kind: EvidenceKind;
	stance: EvidenceStance;
	summary: string;
	ref: CodeLocation | ArtifactPointer | { inputs: DerivationInput[] };
	producer: string;
	createdAt: string;
	runId?: string;
	tool?: { name: string; version?: string };
	withdrawn?: { at: string; by: string; reason: string };
};

export type Gap = {
	id: string;
	question: string;
	completionCriteria?: string;
	status: GapStatus;
	owner?: string;
	taskId?: string;
	result?: string;
	resultRefs: ResultPointer[];
};

export type LedgerLink = {
	id: string;
	targetFunctionId: number;
	targetPrimitiveId?: string;
	relation: LedgerRelation;
	reason: string;
};

export type Assessment = {
	reason: string;
	evidenceRefs: EvidencePointer[];
	dependencyRefs: EntryRevisionPointer[];
	assessedBy: string;
	assessedAt: string;
};

export type LedgerChange = {
	id: string;
	revision: number;
	field: LedgerChangeField;
	from: unknown;
	to: unknown;
	reason: string;
	actor: string;
	at: string;
	evidenceRefs: EvidencePointer[];
};

export type LedgerPrimitive = {
	id: string;
	type: LedgerEntryType;
	title: string;
	statement: string;
	state: LedgerState;
	verdict: LedgerVerdict;
	assessment: Assessment | null;
	locations: CodeLocation[];
	context: AuditContext;
	evidence: Evidence[];
	gaps: Gap[];
	links: LedgerLink[];
};

export type LedgerFunctionJson = {
	id: number;
	repoId: string;
	snapshotId: string;
	file: string;
	functionName: string;
	line: number;
	endLine?: number;
	state: FunctionCoverageState;
	primitives: LedgerPrimitive[];
	revision: number;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
};

/** Proposition view used by primitive operations. `id` is the function id. */
export type LedgerEntryJson = LedgerPrimitive & {
	functionId: number;
	repoId: string;
	snapshotId: string;
	revision: number;
};
