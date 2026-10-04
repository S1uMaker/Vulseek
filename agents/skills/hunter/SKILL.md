---
name: hunter
description: Investigate an assigned function or Ledger call-chain gap in orch-hunt, record supported primitives, and submit named research feedback to the Orchestrator.
---

# Hunter

Follow the assigned `goalPrompt` and the rules below for an orch-hunt Hunter task.

## Assigned hunt name

Read `/task/inputs/task-input.json` for the assigned `name` and `goalPrompt`.
When submitting a Message, copy `name` exactly, including the `#<n>` prefix,
and put the research result in `feedback`. Do not invent or rewrite the name.
Runtime job/task IDs still come from the environment as described by scan-runtime.

## Standing Hunt rules

- Ledger is the proposition source of truth. Read `$VULSEEK_AGENT_HOME/skills/hunt-ledger/SKILL.md`. Before analyzing, list-gates --file / get-gate --id (or the matching type command).
- One independently verifiable and reusable statement per row. A gate may
  record its existence, execution, and path applicability in one row with
  evidence and gaps; split only when the statements or contexts are
  materially different. Do not cover a whole function with one endLine.
- For every chain task, treat the goalPrompt's ordered steps as the scope. Locate the current functions that implement each step; do not assume that a prior Ledger mapping is complete or correct. Read each located material function completely, together with the necessary direct callers, callees, handlers, consumers, and surrounding security context. For a Ledger follow-up, read all cited rows, evidence, gaps, and relevant links before locating and analyzing the current implementation.
- A chain task must produce function-local Ledger analysis before a chain-level conclusion. For every material function, record its exact location, actual code paths examined, security-relevant operations, and unresolved gaps in the relevant local or chain proposition. Create or update separate peer propositions when the function supports distinct reusable statements; do not finish with only a chain row whose locations span several functions.
- Analyze all applicable source, connector, gate, sink, impact, and hypothesis dimensions. A single task may create multiple peer Ledger items when concrete evidence supports distinct statements. Do not create a row merely for reading a function, an ordinary assignment, or a routine pass-through. If a material function yields no independent proposition, preserve its detailed review in evidence or a concrete gap on the relevant row. Do not create a status-only placeholder row.
- Record each independently supported source, connector, gate, sink, impact, and hypothesis as a separate peer proposition when the code supports it; keep unresolved alternatives as gaps rather than inferring a conclusion from one checked path.
- Keep connectors meaningful: record a connector only when it changes or bridges data, control, authority, routing, validation, or a trust boundary, or when it is an independently reusable cross-function relationship.
- After the local review of every material function, analyze the relationships between them: parameter mapping, control flow, data flow, authority flow, routing, validation, sensitive operations, and impact. Update the chain Ledger proposition or create it if the assigned scope has no existing row. Keep function and chain rows flat; links express evidence or flow relationships and do not create a parent-child hierarchy.
- During the detailed review of each function, make no assumption about its security properties. Treat safety or correctness as established only when the current code provides direct, path-specific evidence. Do not infer safety from a function name, schema, type, caller, convention, or one checked branch; leave unproven behavior unresolved and record a concrete gap.
- During complete function review, trace relevant values and authority across materially different runtime shapes and caller paths. Assess local behavior separately from reachability, and preserve adjacent or alternative paths as evidence or concrete gaps when they remain unresolved.
- Create from unknown with create-gate / create-sink / create-source / create-connector / create-impact / create-hypothesis; every new row needs a concise neutral title and a statement, and starts discovered. Add material with append-evidence, open questions with append-gap / set-gap, and links with append-link. Use set-state and set-verdict according to the evidence and remaining gaps; Hunter owns updates to the rows it investigates. On REVISION_CONFLICT, GET the current row and retry with the new revision.
- Do not declare a proposition covered merely because the function was read or a sink was found. Empty gaps are not proof; record unresolved gaps and follow relevant paths.
- A sanitizer inside is_array / integer-array schema is a gate on that shape; if another shape skips the guard and still reaches SQL or a command, that other shape is a sink. Do not write that absint or prepare "applies" unless the guard covers the attacker-controlled shape.
- Do not emit a speculative RCE just to finish. Do not submit_candidate. Do not declare exhaustion. Do not write a PoC. Do not run a full admin-create / write-file exploit chain.
- Return the research result in feedback. Summarize material findings and unresolved questions as useful; no fixed feedback format is required.

## OUTPUT SUBMISSION

- Read `$VULSEEK_AGENT_HOME/skills/scan-runtime/SKILL.md` and `/task/output.schema.json` before submitting. The submitted JSON must match the output data schema.
- Submit with `python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" submit-message [--submission-key KEY] < result.json`.
- Submit as soon as you have a new discovery or other useful result. You may call submit-message multiple times; every accepted submission is an independent Message.
- If you have no discovery or other result, still submit the minimal valid empty-result payload required by the schema: the exact assigned `name` and a nonempty `feedback` string explaining the result and any unresolved gaps.
- This stage has no dynamic routes; omit --route.
- A natural-language reply or a local output.json file is not a submitted Message. If submission fails, correct the payload and retry. Once the assigned investigation is finished and its feedback has been accepted, mark the Goal complete.
