import type {
	Evidence,
	Gap,
	LedgerPrimitive,
	LedgerState,
} from "../../../db/schema/ledger-json";
import type { EvidenceDraft, GapDraft, LedgerOperation } from "./ledger-schema";
import { ScanRuntimeApiError } from "./scan-runtime-api-error";

export type LedgerEntryState = Omit<LedgerPrimitive, "id"> & {
	functionId: number;
	primitiveId: string;
	repoId: string;
	snapshotId: string;
	revision: number;
};

const samePrimitive = (
	left: { functionId: number; primitiveId: string },
	right: { functionId: number; primitiveId: string },
) =>
	left.functionId === right.functionId &&
	left.primitiveId === right.primitiveId;

const validation = (message: string) =>
	new ScanRuntimeApiError(400, message, { code: "VALIDATION_ERROR" });

const invalidAssessment = (message: string) =>
	new ScanRuntimeApiError(400, message, { code: "INVALID_ASSESSMENT" });

const referenceNotFound = (message: string) =>
	new ScanRuntimeApiError(400, message, { code: "REFERENCE_NOT_FOUND" });

const scopeMismatch = (message: string) =>
	new ScanRuntimeApiError(400, message, { code: "SCOPE_MISMATCH" });

const staleDependency = (message: string) =>
	new ScanRuntimeApiError(400, message, { code: "STALE_DEPENDENCY" });

const idConflict = (message: string, current?: unknown) =>
	new ScanRuntimeApiError(409, message, { code: "ID_CONFLICT", current });

export const LEDGER_STATE_TRANSITIONS: Record<
	LedgerState,
	readonly LedgerState[]
> = {
	untracked: ["discovered"],
	discovered: ["assigned", "investigating", "blocked"],
	assigned: ["investigating", "blocked"],
	investigating: ["partial", "covered", "blocked"],
	partial: ["assigned", "investigating", "covered", "blocked"],
	covered: ["investigating"],
	blocked: ["assigned", "investigating"],
};

export const stableStringify = (value: unknown): string =>
	JSON.stringify(value, (_key, nested) => {
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			return Object.fromEntries(
				Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
					a.localeCompare(b),
				),
			);
		}
		return nested;
	});

const clone = <T>(value: T): T => structuredClone(value);

const gapFromDraft = (draft: GapDraft): Gap => ({
	id: draft.id,
	question: draft.question,
	...(draft.completionCriteria
		? { completionCriteria: draft.completionCriteria }
		: {}),
	status: "open",
	...(draft.owner ? { owner: draft.owner } : {}),
	...(draft.taskId ? { taskId: draft.taskId } : {}),
	resultRefs: [],
});

const evidenceFromDraft = (
	draft: EvidenceDraft,
	meta: { producer: string; createdAt: string },
): Evidence => ({
	...draft,
	producer: meta.producer,
	createdAt: meta.createdAt,
});

const evidenceDraftKey = (draft: EvidenceDraft) =>
	stableStringify({
		id: draft.id,
		kind: draft.kind,
		stance: draft.stance,
		summary: draft.summary,
		ref: draft.ref,
		runId: draft.runId,
		tool: draft.tool,
	});

const existingEvidenceDraftKey = (evidence: Evidence) =>
	evidenceDraftKey({
		id: evidence.id,
		kind: evidence.kind,
		stance: evidence.stance,
		summary: evidence.summary,
		ref: evidence.ref,
		runId: evidence.runId,
		tool: evidence.tool,
	} as EvidenceDraft);

const findEvidence = (state: LedgerEntryState, evidenceId: string) =>
	state.evidence.find((item) => item.id === evidenceId);

const isWithdrawn = (evidence: Evidence) => Boolean(evidence.withdrawn);

export const assertAssumptions = (
	state: Pick<LedgerEntryState, "context" | "gaps">,
) => {
	const gapIds = new Set(state.gaps.map((gap) => gap.id));
	for (const assumption of state.context.assumptions ?? []) {
		if (!gapIds.has(assumption.gapId)) {
			throw validation(
				`context.assumptions gapId "${assumption.gapId}" is not on this entry`,
			);
		}
	}
};

const assertResultRefs = async (
	state: LedgerEntryState,
	refs: Gap["resultRefs"],
	resolveEntry: (
		ref: { functionId: number; primitiveId: string },
	) => Promise<LedgerEntryState | null>,
) => {
	for (const ref of refs) {
		const target = samePrimitive(ref, state)
			? state
			: await resolveEntry(ref);
		if (!target) {
			throw referenceNotFound(
				`resultRefs primitive "${ref.functionId}/${ref.primitiveId}" was not found`,
			);
		}
		if (ref.evidenceId) {
			const evidence = findEvidence(target, ref.evidenceId);
			if (!evidence) {
				throw referenceNotFound(
					`resultRefs evidence "${ref.evidenceId}" was not found`,
				);
			}
		}
	}
};

const assertDerivation = async (
	state: LedgerEntryState,
	evidence: Evidence,
	resolveEntry: ResolvePrimitive,
) => {
	if (evidence.kind !== "derivation") {
		return;
	}
	const inputs =
		"inputs" in evidence.ref
			? (evidence.ref.inputs as Array<{
					functionId: number;
					primitiveId: string;
					revision: number;
					evidenceId?: string;
				}>)
			: [];
	if (inputs.length === 0) {
		throw validation("derivation evidence requires inputs");
	}
	for (const input of inputs) {
		if (samePrimitive(input, state)) {
			throw validation("derivation evidence cannot depend on its own primitive");
		}
		const target = await resolveEntry(input);
		if (!target) {
			throw referenceNotFound(
				`derivation input "${input.functionId}/${input.primitiveId}" was not found`,
			);
		}
		if (
			target.repoId !== state.repoId ||
			target.snapshotId !== state.snapshotId
		) {
			throw scopeMismatch(
				`derivation input "${input.functionId}/${input.primitiveId}" is not in the same snapshot`,
			);
		}
		if (target.revision !== input.revision) {
			throw staleDependency(
				`derivation input "${input.functionId}/${input.primitiveId}" revision ${input.revision} is stale (current ${target.revision})`,
			);
		}
		if (input.evidenceId) {
			const sourceEvidence = findEvidence(target, input.evidenceId);
			if (!sourceEvidence || isWithdrawn(sourceEvidence)) {
				throw referenceNotFound(
					`derivation input evidence "${input.evidenceId}" was not found`,
				);
			}
		}
	}
};

type ResolvePrimitive = (ref: {
	functionId: number;
	primitiveId: string;
}) => Promise<LedgerEntryState | null>;

const clearVerdict = (state: LedgerEntryState) => {
	if (state.verdict === "unknown" && state.assessment === null) {
		return;
	}
	state.verdict = "unknown";
	state.assessment = null;
};

const applySetGap = async (
	state: LedgerEntryState,
	operation: Extract<LedgerOperation, { op: "set_gap" }>,
	meta: { revision: number; actor: string; at: string; reason: string },
	resolveEntry: ResolvePrimitive,
) => {
	const index = state.gaps.findIndex((gap) => gap.id === operation.gapId);
	if (index < 0) {
		throw referenceNotFound(`gap "${operation.gapId}" was not found`);
	}
	const previous = state.gaps[index]!;
	const next: Gap = { ...previous };
	if (operation.status === "open" || operation.status === "investigating") {
		if (operation.result !== undefined || operation.resultRefs !== undefined) {
			throw validation(
				"open/investigating gaps cannot include result or resultRefs",
			);
		}
		delete next.result;
		next.resultRefs = [];
		next.status = operation.status;
		state.gaps[index] = next;
		return;
	}
	if (operation.status === "resolved") {
		if (!operation.result || !operation.resultRefs?.length) {
			throw validation("resolved gaps require result and non-empty resultRefs");
		}
		await assertResultRefs(state, operation.resultRefs, resolveEntry);
		next.status = "resolved";
		next.result = operation.result;
		next.resultRefs = operation.resultRefs;
		state.gaps[index] = next;
		return;
	}
	if (!operation.result) {
		throw validation("blocked gaps require result");
	}
	const resultRefs = operation.resultRefs ?? [];
	await assertResultRefs(state, resultRefs, resolveEntry);
	next.status = "blocked";
	next.result = operation.result;
	next.resultRefs = resultRefs;
	state.gaps[index] = next;
};

const applySetVerdict = (
	state: LedgerEntryState,
	operation: Extract<LedgerOperation, { op: "set_verdict" }>,
	meta: { revision: number; actor: string; at: string; reason: string },
) => {
	const previousVerdict = state.verdict;
	const previousAssessment = state.assessment;
	if (operation.verdict === "unknown") {
		if (!operation.reason) {
			throw validation("set_verdict unknown requires reason");
		}
		if (operation.assessment) {
			throw validation("set_verdict unknown cannot include assessment");
		}
		state.verdict = "unknown";
		state.assessment = null;
	} else {
		if (!operation.assessment) {
			throw invalidAssessment("supported/refuted/contested require assessment");
		}
		state.verdict = operation.verdict;
		state.assessment = {
			reason: operation.assessment.reason,
			evidenceRefs: operation.assessment.evidenceRefs,
			dependencyRefs: operation.assessment.dependencyRefs ?? [],
			assessedBy: meta.actor,
			assessedAt: meta.at,
		};
	}
};

const applySetState = (
	state: LedgerEntryState,
	operation: Extract<LedgerOperation, { op: "set_state" }>,
	meta: { revision: number; actor: string; at: string; reason: string },
) => {
	if (operation.state === state.state) {
		return;
	}
	if (!LEDGER_STATE_TRANSITIONS[state.state].includes(operation.state)) {
		throw validation(
			`invalid ledger state transition: ${state.state} -> ${operation.state}`,
		);
	}
	const reason = operation.reason ?? meta.reason;
	if (operation.state === "blocked" && !reason.trim()) {
		throw validation("blocked state requires reason");
	}
	state.state = operation.state;
};

export const assertLedgerState = (
	state: Pick<LedgerEntryState, "state" | "verdict" | "evidence" | "gaps">,
) => {
	if (
		state.state === "partial" &&
		state.evidence.length === 0 &&
		state.gaps.length === 0
	) {
		throw validation("partial state requires evidence or a gap");
	}
	if (state.state === "covered") {
		if (state.verdict === "unknown") {
			throw validation("covered state requires a non-unknown verdict");
		}
		if (
			state.gaps.some(
				(gap) => gap.status === "open" || gap.status === "investigating",
			)
		) {
			throw validation("covered state cannot have open or investigating gaps");
		}
	}
};

const assertAssessment = async (
	state: LedgerEntryState,
	resolveEntry: ResolvePrimitive,
) => {
	if (state.verdict === "unknown") {
		if (state.assessment !== null) {
			throw invalidAssessment("unknown verdict requires assessment null");
		}
		return;
	}
	const assessment = state.assessment;
	if (!assessment) {
		throw invalidAssessment(`${state.verdict} requires assessment`);
	}
	if (assessment.evidenceRefs.length === 0) {
		throw invalidAssessment("assessment.evidenceRefs must not be empty");
	}
	const stances = new Set<string>();
	for (const ref of assessment.evidenceRefs) {
		if (!samePrimitive(ref, state)) {
			throw invalidAssessment(
				"assessment.evidenceRefs must point at this primitive",
			);
		}
		const evidence = findEvidence(state, ref.evidenceId);
		if (!evidence) {
			throw referenceNotFound(
				`assessment evidence "${ref.evidenceId}" was not found`,
			);
		}
		if (isWithdrawn(evidence)) {
			throw invalidAssessment(
				`assessment evidence "${ref.evidenceId}" is withdrawn`,
			);
		}
		stances.add(evidence.stance);
		await assertDerivation(state, evidence, resolveEntry);
	}
	if (state.verdict === "supported" && !stances.has("supports")) {
		throw invalidAssessment("supported assessment needs supporting evidence");
	}
	if (state.verdict === "refuted" && !stances.has("refutes")) {
		throw invalidAssessment("refuted assessment needs refuting evidence");
	}
	if (
		state.verdict === "contested" &&
		!(stances.has("supports") && stances.has("refutes"))
	) {
		throw invalidAssessment(
			"contested assessment needs both supporting and refuting evidence",
		);
	}
	const visited = new Set<string>([
		`${state.functionId}/${state.primitiveId}`,
	]);
	for (const dep of assessment.dependencyRefs) {
		const key = `${dep.functionId}/${dep.primitiveId}`;
		if (samePrimitive(dep, state)) {
			throw invalidAssessment("assessment cannot depend on its own primitive");
		}
		const target = await resolveEntry(dep);
		if (!target) {
			throw referenceNotFound(
				`assessment dependency "${key}" was not found`,
			);
		}
		if (
			target.repoId !== state.repoId ||
			target.snapshotId !== state.snapshotId
		) {
			throw scopeMismatch(
				`assessment dependency "${key}" is not in the same snapshot`,
			);
		}
		if (target.revision !== dep.revision) {
			throw staleDependency(
				`assessment dependency "${key}" revision ${dep.revision} is stale (current ${target.revision})`,
			);
		}
		if (visited.has(key)) {
			throw invalidAssessment("assessment dependencies form a cycle");
		}
		visited.add(key);
	}
};

const assertLinks = async (
	state: LedgerEntryState,
	resolveEntry: ResolvePrimitive,
) => {
	const seen = new Set<string>();
	for (const link of state.links) {
		if (
			link.targetFunctionId === state.functionId &&
			(!link.targetPrimitiveId || link.targetPrimitiveId === state.primitiveId)
		) {
			throw validation("links cannot target the same primitive");
		}
		const combo = `${link.targetFunctionId}|${link.targetPrimitiveId ?? ""}|${link.relation}`;
		if (seen.has(combo)) {
			throw validation(
				"duplicate link targetFunctionId/targetPrimitiveId/relation combination",
			);
		}
		seen.add(combo);
		if (!link.targetPrimitiveId) {
			continue;
		}
		const target = await resolveEntry({
			functionId: link.targetFunctionId,
			primitiveId: link.targetPrimitiveId,
		});
		if (!target) {
			throw referenceNotFound(
				`link target "${link.targetFunctionId}/${link.targetPrimitiveId}" was not found`,
			);
		}
		if (link.relation !== "related_to") {
			if (
				target.repoId !== state.repoId ||
				target.snapshotId !== state.snapshotId
			) {
				throw scopeMismatch(
					`link target "${link.targetFunctionId}/${link.targetPrimitiveId}" is not in the same snapshot`,
				);
			}
		}
	}
};

export const applyLedgerOperations = async (input: {
	current: LedgerEntryState;
	operations: LedgerOperation[];
	actor: string;
	at: string;
	reason: string;
	nextRevision: number;
	resolveEntry: ResolvePrimitive;
}): Promise<LedgerEntryState> => {
	const state = clone(input.current);
	const meta = {
		revision: input.nextRevision,
		actor: input.actor,
		at: input.at,
		reason: input.reason,
	};
	let hasSetVerdict = false;
	let revertUnknown = false;
	let revertReason = input.reason;

	for (const operation of input.operations) {
		if (operation.op === "append_evidence") {
			const existing = findEvidence(state, operation.value.id);
			if (existing) {
				if (
					existingEvidenceDraftKey(existing) !==
					evidenceDraftKey(operation.value)
				) {
					throw idConflict(
						`evidence id "${operation.value.id}" already exists with different content`,
					);
				}
				continue;
			}
			const evidence = evidenceFromDraft(operation.value, {
				producer: input.actor,
				createdAt: input.at,
			});
			await assertDerivation(state, evidence, input.resolveEntry);
			if (
				(state.verdict === "supported" && evidence.stance === "refutes") ||
				(state.verdict === "refuted" && evidence.stance === "supports")
			) {
				revertUnknown = true;
				revertReason = "New opposing evidence requires reassessment";
			}
			state.evidence.push(evidence);
			continue;
		}
		if (operation.op === "withdraw_evidence") {
			const evidence = findEvidence(state, operation.evidenceId);
			if (!evidence) {
				throw referenceNotFound(
					`evidence "${operation.evidenceId}" was not found`,
				);
			}
			if (!evidence.withdrawn) {
				evidence.withdrawn = {
					at: input.at,
					by: input.actor,
					reason: operation.reason,
				};			}
			const used = state.assessment?.evidenceRefs.some(
				(ref) => ref.evidenceId === evidence.id,
			);
			if (used) {
				revertUnknown = true;
				revertReason = operation.reason;
			}
			continue;
		}
		if (operation.op === "append_gap") {
			const existing = state.gaps.find((gap) => gap.id === operation.value.id);
			if (existing) {
				if (existing.question !== operation.value.question) {
					throw idConflict(
						`gap id "${operation.value.id}" already exists with different content`,
					);
				}
				continue;
			}
			state.gaps.push(gapFromDraft(operation.value));
			continue;
		}
		if (operation.op === "set_gap") {
			await applySetGap(state, operation, meta, input.resolveEntry);
			continue;
		}
		if (operation.op === "append_link") {
			const existing = state.links.find(
				(link) => link.id === operation.value.id,
			);
			if (existing) {
				if (stableStringify(existing) !== stableStringify(operation.value)) {
					throw idConflict(
						`link id "${operation.value.id}" already exists with different content`,
					);
				}
				continue;
			}
			state.links.push(operation.value);
			continue;
		}
		if (operation.op === "remove_link") {
			const index = state.links.findIndex(
				(link) => link.id === operation.linkId,
			);
			if (index < 0) {
				throw referenceNotFound(`link "${operation.linkId}" was not found`);
			}
			const [removed] = state.links.splice(index, 1);			continue;
		}
		if (operation.op === "replace_locations") {			state.locations = operation.value;
			revertUnknown = true;
			revertReason = "Locations changed; reassessment required";
			continue;
		}
		if (operation.op === "set_state") {
			applySetState(state, operation, meta);
			continue;
		}
		hasSetVerdict = true;
		applySetVerdict(state, operation, meta);
	}

	if (revertUnknown && !hasSetVerdict) {
		clearVerdict(state);
	}

	assertAssumptions(state);
	assertLedgerState(state);
	await assertLinks(state, input.resolveEntry);
	await assertAssessment(state, input.resolveEntry);
	state.revision = input.nextRevision;
	return state;
};

export const normalizeCreatedGaps = (drafts: GapDraft[] | undefined): Gap[] =>
	(drafts ?? []).map(gapFromDraft);
