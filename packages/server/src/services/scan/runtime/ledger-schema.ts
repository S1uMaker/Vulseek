import { z } from "zod";
import {
	LEDGER_ENTRY_TYPES,
	LEDGER_ENTRYPOINT_KINDS,
	LEDGER_EVIDENCE_STANCES,
	LEDGER_GAP_STATUSES,
	LEDGER_RELATIONS,
	FUNCTION_COVERAGE_STATES,
	LEDGER_STATES,
	LEDGER_VERDICTS,
} from "../../../db/schema/ledger-json";

const idSchema = z.string().trim().min(1);
const positiveInt = z.number().int().positive();

export const ledgerEntryIdSchema = positiveInt.max(2_147_483_647);
export const ledgerEntryIdQuerySchema = z
	.string()
	.regex(/^[1-9]\d*$/)
	.transform(Number)
	.pipe(ledgerEntryIdSchema);

const isRepoRelativePath = (file: string) => {
	if (!file || file.startsWith("/") || file.includes("\\")) {
		return false;
	}
	return !file.split("/").some((part) => part === ".." || part === "");
};

export const codeLocationSchema = z
	.object({
		file: z
			.string()
			.trim()
			.min(1)
			.refine(isRepoRelativePath, "file must be a repository-relative path"),
		line: positiveInt,
		endLine: positiveInt.optional(),
		functionName: z.string().trim().min(1).optional(),
	})
	.superRefine((value, ctx) => {
		if (value.endLine !== undefined && value.endLine < value.line) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "endLine must be >= line",
				path: ["endLine"],
			});
		}
	});

const artifactPointerSchema = z.object({
	artifactId: idSchema,
	locator: z.string().trim().min(1).optional(),
});

const functionPrimitiveRefSchema = z.object({
	functionId: ledgerEntryIdSchema,
	primitiveId: idSchema,
	revision: positiveInt,
	evidenceId: idSchema.optional(),
});

const derivationInputSchema = functionPrimitiveRefSchema;

export const evidenceDraftSchema = z.discriminatedUnion("kind", [
	z.object({
		id: idSchema,
		kind: z.literal("code"),
		stance: z.enum(LEDGER_EVIDENCE_STANCES),
		summary: z.string().trim().min(1),
		ref: codeLocationSchema,
		runId: idSchema.optional(),
		tool: z
			.object({
				name: z.string().trim().min(1),
				version: z.string().trim().min(1).optional(),
			})
			.optional(),
	}),
	z.object({
		id: idSchema,
		kind: z.literal("static_analysis"),
		stance: z.enum(LEDGER_EVIDENCE_STANCES),
		summary: z.string().trim().min(1),
		ref: artifactPointerSchema,
		runId: idSchema.optional(),
		tool: z
			.object({
				name: z.string().trim().min(1),
				version: z.string().trim().min(1).optional(),
			})
			.optional(),
	}),
	z.object({
		id: idSchema,
		kind: z.literal("runtime_test"),
		stance: z.enum(LEDGER_EVIDENCE_STANCES),
		summary: z.string().trim().min(1),
		ref: artifactPointerSchema,
		runId: idSchema.optional(),
		tool: z
			.object({
				name: z.string().trim().min(1),
				version: z.string().trim().min(1).optional(),
			})
			.optional(),
	}),
	z.object({
		id: idSchema,
		kind: z.literal("derivation"),
		stance: z.enum(LEDGER_EVIDENCE_STANCES),
		summary: z.string().trim().min(1),
		ref: z.object({
			inputs: z.array(derivationInputSchema).min(1),
		}),
		runId: idSchema.optional(),
		tool: z
			.object({
				name: z.string().trim().min(1),
				version: z.string().trim().min(1).optional(),
			})
			.optional(),
	}),
]);

export const gapDraftSchema = z.object({
	id: idSchema,
	question: z.string().trim().min(1),
	completionCriteria: z.string().trim().min(1).optional(),
	owner: z.string().trim().min(1).optional(),
	taskId: idSchema.optional(),
});

export const resultPointerSchema = z.object({
	functionId: ledgerEntryIdSchema,
	primitiveId: idSchema,
	evidenceId: idSchema.optional(),
});

export const ledgerLinkSchema = z.object({
	id: idSchema,
	targetFunctionId: ledgerEntryIdSchema,
	targetPrimitiveId: idSchema.optional(),
	relation: z.enum(LEDGER_RELATIONS),
	reason: z.string().trim().min(1),
});

export const auditContextSchema = z
	.object({
		entrypoint: z
			.object({
				kind: z.enum(LEDGER_ENTRYPOINT_KINDS),
				name: z.string().trim().min(1),
			})
			.optional(),
		actor: z
			.object({
				authenticated: z.boolean().optional(),
				role: z.string().trim().min(1).optional(),
			})
			.optional(),
		input: z
			.object({
				name: z.string().trim().min(1),
				accessPath: z.string().trim().min(1).optional(),
			})
			.optional(),
		conditions: z.array(z.string().trim().min(1)).optional(),
		assumptions: z
			.array(
				z.object({
					description: z.string().trim().min(1),
					gapId: idSchema,
				}),
			)
			.optional(),
	})
	.strict();

export const assessmentDraftSchema = z.object({
	reason: z.string().trim().min(1),
	evidenceRefs: z
		.array(
			z.object({
				functionId: ledgerEntryIdSchema,
				primitiveId: idSchema,
				evidenceId: idSchema,
			}),
		)
		.min(1),
	dependencyRefs: z
		.array(
			z.object({
				functionId: ledgerEntryIdSchema,
				primitiveId: idSchema,
				revision: positiveInt,
			}),
		)
		.default([]),
});

export const ledgerOperationSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("append_evidence"),
		value: evidenceDraftSchema,
	}),
	z.object({
		op: z.literal("withdraw_evidence"),
		evidenceId: idSchema,
		reason: z.string().trim().min(1),
	}),
	z.object({
		op: z.literal("append_gap"),
		value: gapDraftSchema,
	}),
	z.object({
		op: z.literal("set_gap"),
		gapId: idSchema,
		status: z.enum(LEDGER_GAP_STATUSES),
		result: z.string().trim().min(1).optional(),
		resultRefs: z.array(resultPointerSchema).optional(),
	}),
	z.object({
		op: z.literal("append_link"),
		value: ledgerLinkSchema,
	}),
	z.object({
		op: z.literal("remove_link"),
		linkId: idSchema,
		reason: z.string().trim().min(1),
	}),
	z.object({
		op: z.literal("replace_locations"),
		value: z.array(codeLocationSchema),
	}),
	z.object({
		op: z.literal("set_verdict"),
		verdict: z.enum(LEDGER_VERDICTS),
		reason: z.string().trim().min(1).optional(),
		assessment: assessmentDraftSchema.optional(),
	}),
	z.object({
		op: z.literal("set_state"),
		state: z.enum(LEDGER_STATES),
		reason: z.string().trim().min(1).optional(),
	}),
]);

export const primitiveDraftSchema = z
	.object({
		id: idSchema,
		type: z.enum(LEDGER_ENTRY_TYPES),
		title: z.string().trim().min(1),
		statement: z.string().trim().min(1),
		locations: z.array(codeLocationSchema).optional(),
		context: auditContextSchema.optional(),
		gaps: z.array(gapDraftSchema).optional(),
	})
	.strict();

export const ensureFunctionSchema = z
	.object({
		file: z
			.string()
			.trim()
			.min(1)
			.refine(isRepoRelativePath, "file must be a repository-relative path"),
		functionName: z.string().trim().min(1),
		line: positiveInt,
		endLine: positiveInt.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.endLine !== undefined && value.endLine < value.line) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "endLine must be >= line",
				path: ["endLine"],
			});
		}
	});

export const createLedgerEntrySchema = primitiveDraftSchema;

export const createLedgerRequestSchema = z.object({
	action: z.literal("create"),
	entry: createLedgerEntrySchema,
});

export const updateLedgerRequestSchema = z.object({
	action: z.enum(["update", "update-primitive"]).optional(),
	functionId: ledgerEntryIdSchema,
	primitiveId: idSchema,
	expectedRevision: positiveInt,
	reason: z.string().trim().min(1),
	operations: z.array(ledgerOperationSchema).min(1),
});

export const setFunctionStateSchema = z.object({
	state: z.enum(FUNCTION_COVERAGE_STATES),
	expectedRevision: positiveInt,
	reason: z.string().trim().min(1),
});

export type CreateLedgerEntryInput = z.infer<typeof createLedgerEntrySchema>;
export type CreateLedgerRequest = z.infer<typeof createLedgerRequestSchema>;
export type UpdateLedgerRequest = z.infer<typeof updateLedgerRequestSchema>;
export type LedgerOperation = z.infer<typeof ledgerOperationSchema>;
export type EvidenceDraft = z.infer<typeof evidenceDraftSchema>;
export type GapDraft = z.infer<typeof gapDraftSchema>;
export type AssessmentDraft = z.infer<typeof assessmentDraftSchema>;
export type PrimitiveDraft = z.infer<typeof primitiveDraftSchema>;
export type EnsureFunctionInput = z.infer<typeof ensureFunctionSchema>;
export type SetFunctionStateInput = z.infer<typeof setFunctionStateSchema>;
