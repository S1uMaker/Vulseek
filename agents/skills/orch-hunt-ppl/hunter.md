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

- Ledger is the proposition source of truth. Read `$VULSEEK_AGENT_HOME/skills/orch-hunt-ppl/hunt-ledger.md`. Before analyzing, list the function row. Do not set function state to `verified`. `submit-message` goes to the critic, not the orchestrator.
- One independently verifiable and reusable statement per row. A gate may
  record its existence, execution, and path applicability in one row with
  evidence and gaps; split only when the statements or contexts are
  materially different. Do not cover a whole function with one endLine.
- Treat the goalPrompt as an approach and an ordered route, not as a list of functions or Ledger rows. Find the current function that implements each step. Read each security-relevant function completely, including the branches that matter to that step.
- Every function you analyze gets its own Ledger row. Call `ensure-function` with its file, function name, and line. A new row is `investigating`. If the row already exists, use it and do not create another. Write that function's primitives, evidence, and gaps only on its own row. Evidence describes that function's code. Another function is a `links` target, not a location or evidence item on this row.
- Do not append a function you analyzed onto an existing row, including a row the Orchestrator created, as `locations` or `evidence`. Ordinary assignments and pure pass-throughs do not need a row. A function you actually reviewed does, even when its only result is a gate or an open gap.
- Record each independently supported source, connector, gate, sink, impact, and hypothesis as a separate peer proposition when the code supports it; keep unresolved alternatives as gaps rather than inferring a conclusion from one checked path.
- Keep connectors meaningful: record a connector only when it changes or bridges data, control, authority, routing, validation, or a trust boundary, or when it is an independently reusable cross-function relationship.
- After each function has its own row, record a cross-function relationship as a connector primitive on the caller and link it to the callee's function id. The callee's behavior stays on the callee's row.
- During the detailed review of each function, make no assumption about its security properties. Treat safety or correctness as established only when the current code provides direct, path-specific evidence. Do not infer safety from a function name, schema, type, caller, convention, or one checked branch; leave unproven behavior unresolved and record a concrete gap.
- During complete function review, trace relevant values and authority across materially different runtime shapes and caller paths. Assess local behavior separately from reachability, and preserve adjacent or alternative paths as evidence or concrete gaps when they remain unresolved.
- On a function row, add primitives with `append-primitive`. Add evidence and gaps to that same row. Use `set-function-state` for `investigating`, `partial`, `covered`, or `blocked`. Do not set `verified`. On REVISION_CONFLICT, read the current row and retry with the new revision.
- Do not declare a proposition covered merely because the function was read or a sink was found. Empty gaps are not proof; record unresolved gaps and follow relevant paths.
- A sanitizer inside is_array / integer-array schema is a gate on that shape; if another shape skips the guard and still reaches SQL or a command, that other shape is a sink. Do not write that absint or prepare "applies" unless the guard covers the attacker-controlled shape.
- Do not emit a speculative RCE just to finish. Do not submit_candidate. Do not declare exhaustion. Do not write a PoC. Do not run a full admin-create / write-file exploit chain.
- Return the research result in feedback. Summarize material findings and unresolved questions as useful; no fixed feedback format is required.

## OUTPUT SUBMISSION

- Read `$VULSEEK_AGENT_HOME/skills/scan-runtime/SKILL.md` and `/task/output.schema.json` before submitting. The submitted JSON must match the output data schema.
- Submit with `python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" submit-message [--submission-key KEY] < result.json`.
- Submit as soon as you have a new discovery or other useful result. You may call submit-message multiple times before you finish; every accepted submission is an independent Message.
- If you have no discovery or other result, still submit the minimal valid empty-result payload required by the schema: the exact assigned `name` and a nonempty `feedback` string explaining the result and any unresolved gaps.
- This stage has no dynamic routes; omit --route.
- A natural-language reply or a local output.json file is not a submitted Message. If submission fails, correct the payload and retry.
- `submit-message` is your only handoff. A successful return means the feedback was accepted. Do not call `running-tasks`, `stage-outputs`, or `poll-messages`, and do not sleep or poll for the critic or any other downstream stage. The critic review is not your result and is not a reason to edit the Ledger again.
