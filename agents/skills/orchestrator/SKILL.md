---
name: orchestrator
description: The Orchestrator reads code at reconnaissance level, records neutral call-chain scope, dispatches Hunters, and submits candidates supported from entry through primitives to sink and impact. Hunters decompose chains into function-local propositions and record their evidence and gaps in the Ledger.
---

# Orchestrator

```bash
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" list_hunters
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" get_hunter_feedback
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" spawn_hunters < payload.json
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" submit_candidate < payload.json
```

## Commands

`list_hunters` — list running hunters and remaining slots.

- `availableSlots`, `concurrency`, `activeCount`
- `hunters[]`: `name`, `taskId`, `status`, `startedAt`, `updatedAt`
- Names just spawned this decision may be absent until launch; treat them as in-flight. Do not respawn them.

`get_hunter_feedback` — take this stage's inbound hunter results once (consumes the queue).

- `feedback[]`: `name`, `feedback`, `messageId`
- Empty array = no new results this take, not a hang.
- Read the complete feedback and any cited Ledger entries. Do not treat an unclear or incomplete message as proof that no relevant primitive exists.

The Ledger is one row per function. Discover functions with `ensure-function`
and mark them `assigned` when dispatching. Do not set `investigating`,
`partial`, `covered`, `verified`, or `blocked`; those belong to the Hunter.
A function is not covered until its row is `verified`. Empty `primitives` means
the function is registered and still needs local analysis.

An incomplete chain is an asset. A gated sink calls for further analysis;
use the chain dispatch and Hunter decomposition rules below to choose a
code-grounded scope and examine how the sink can be reached.

`spawn_hunters` — submit hunts only. stdin:

```json
{
  "hunters": [{ "name": "#1 slug", "goalPrompt": "..." }]
}
```

- `name` is job-global `#n slug`. n starts at 1 and increases by 1 for every hunt ever submitted. Never skip, reuse, or renumber.
- `len(hunters)` must be ≥ 1 and ≤ `availableSlots`. Do not pass `candidates`.
- The Hunter skill provides submission instructions. Write only the research ask in `goalPrompt`. Do not prefix `/goal` and do not include submit or scan-runtime instructions.
- Build the complete batch before calling `spawn_hunters`. For a function
  brief, name the exact file and function and keep the research ask abstract.
  For a chain brief, create or reuse a neutral chain proposition and describe
  only its ordered steps and observed relationship in the `goalPrompt`; do not
  enumerate the implementing functions or locations. The Hunter locates the
  current implementations. If fewer independent directions are justified,
  submit that smaller batch; never invent duplicates to fill slots or
  serialize a batch into one-hunt calls.

## Chain dispatch and Hunter decomposition

Use the Ledger as the shared record of both function-local analysis and
cross-function analysis. Do not require a special coverage row or a particular
task name. A function or chain is covered only when the existing rows contain
enough code-grounded information to reconstruct what was examined and what
remains open.

There are two separate scopes:

- Function-local scope: the behavior inside one complete function, including
  its material branches, runtime shapes, security-relevant operations, and
  local guards. Necessary callers, callees, handlers, and consumers provide
  context but do not narrow the function scope.
- Chain scope: the control, data, or authority flow across two or more
  functions, including routing, parameter mapping, guards, alternate paths,
  and the resulting operation or impact.

Before dispatching a chain task, use the repository and Ledger to identify its
material functions and relationships. Query the Ledger by file and function
name with `list-ledger --function-name <name> --file <file>`, use `--title` to
find related subjects, and read the complete matching rows: `title`,
`statement`, `locations`, `context`, `evidence`, `gaps`, and `links`. The
`--function-name` filter is a substring search, so verify the returned
location has the intended file and exact symbol. Read cited Hunter feedback
as a pointer to Ledger rows, not as a replacement for them.

Orch may dispatch a chain before its functions have independent Ledger
analysis. When the code supports a real relationship, create one neutral
chain proposition at dispatch time unless an equivalent row already exists.
Use `connector` for an observed control, data, or authority relationship and
`hypothesis` for an end-to-end scene that remains open. Do not create source,
gate, sink, impact, or a vulnerability conclusion from reconnaissance alone.
Put known material locations on the chain row for Ledger evidence, and record
pending local analysis or unresolved connections as concrete gaps. Pass the
chain entryId and an ordered, step-level description to the Hunter; do not
turn the row's function mapping into the `goalPrompt` scope.

The chain row is a dispatch scope and relationship proposition. It does not
prove that any function is locally covered. A function referenced as a caller,
callee, route, sink, or downstream consumer is not thereby locally covered.
`covered`, `supported`, an empty `gaps` array, a row count, a title, or a task
label is never coverage proof by itself. Missing or unclear evidence means
coverage is unverified; compare the current source before deciding.
Titles are lookup labels, not coverage proof.

Reuse a function-local proposition only when its evidence shows that the same
snapshot's complete function was examined across its material branches,
runtime shapes, and security-relevant operations, with no unresolved gap that
matters to the current task. A function-name match, a chain location, a narrow
line range, or a proposition about one branch is partial evidence. For a
function brief, a sufficient local entry may be cited as context; for a chain
brief or follow-up, use local entries internally and pass only the chain
`entryId` and step-level scope. Reuse does not narrow the current chain
review or prevent the Hunter from recording a distinct supported proposition.

Dispatch according to the available code-grounded scope:

- Dispatch a coherent chain directly when reconnaissance identifies the
  material functions and relationship, even when local analysis is missing.
- Use a function-focused task for a concrete local gap, branch, runtime shape,
  or function that cannot be included coherently in a chain brief.
- Use a chain follow-up after local propositions exist to verify connections,
  alternate callers, reachability, and combined impact.
- If an active Hunter owns the required scope, do not duplicate it; use other
  independent work while waiting for its Ledger results.

Each function is one Ledger row. `ensure-function` registers it; empty
`primitives` means it still needs local analysis. Do not ask a Hunter to
create that row. Connector and hypothesis primitives live on the entry
function and link to other function rows. Derive scope from the function row
and its `primitives`.

## GoalPrompt construction

Register an unreviewed function with `ensure-function` before dispatch, then
`assign-function` when the Hunter is spawned. A neutral
chain proposition may be created when dispatching a code-grounded chain; put
known locations and unresolved step relationships in the Ledger row, but keep
the goalPrompt at the step level. Keep the Ledger flat; links express
evidence or flow relationships.

- Keep each `goalPrompt` at or below 4,000 characters, including spaces and newlines. Target 3,900 or fewer to leave room for the Hunter skill reference. Check its length before `spawn_hunters` and remove redundant wording without dropping essential scope, code locations, or Ledger references.
- Write every `goalPrompt` as a neutral, code-grounded investigation brief—not as a vulnerability conclusion, CVE reproduction task, or question about a preselected primitive, vulnerability, parameter, or mechanism; any Ledger-based lead must remain an open question and be checked against adjacent and alternative paths.
- For a function-based task, name the exact file and function and require a
  complete local review with the necessary surrounding context. Keep the
  request abstract; the Hunter skill supplies the detailed security review
  method.
- For a chain-based task, cite the chain Ledger `entryId` when applicable and
  describe only the ordered steps and their observed control, data, authority,
  or reachability relationship. Do not enumerate implementing functions,
  locations, or a presumed vulnerability direction. Require the Hunter to
  locate and verify the current implementation of each step.
- For a Ledger follow-up, cite the chain `entryId` and describe the steps or
  relationships to reconstruct or verify. Do not copy prior function mappings,
  detailed hypotheses, or a preselected source, sink, gate, or impact into the
  goalPrompt. The Hunter must read the cited Ledger context and current source.
- Do not repeat the Hunter skill's detailed checklist in each goalPrompt. The
  brief must still require current-source evidence, Ledger propositions, and
  concrete gaps for unresolved behavior.
- Require the Hunter to persist the examined function or chain scope in the existing Ledger fields: use `title` and `statement` to identify the subject, `locations` to identify the code, `evidence` to record what was actually examined, `gaps` to preserve unresolved paths, and `links` to express relationships. Record each independently supported source, gate, sink, impact, or hypothesis as a separate Ledger proposition, and record a connector separately only when it changes or bridges data, control, authority, routing, validation, or a trust boundary. Put ordinary assignments and routine pass-throughs in evidence. Report the exact code and paths examined, and preserve unresolved paths as gaps or partial results rather than treating a read function as fully covered. Feedback must not be the only record of scope or findings.
- For a Ledger follow-up, cite the chain `entryId` and describe the
  step-level relationship to reconstruct or verify. Use locations, evidence,
  and gaps internally to choose the brief, but do not paste the prior function
  mapping or detailed Ledger contents into the goalPrompt.
- Use variant analysis, post-patch validation, and other available strategies to choose useful code directions, but use them as search heuristics rather than as evidence of a vulnerability or as a substitute for reading the current source tree.

For a Ledger follow-up, read the chain row and its linked local propositions as
context. Use their evidence and gaps to define the remaining step-level
question, but do not turn the recorded function mapping into the goalPrompt's
scope. The Hunter must locate the current implementation, compare it with the
Ledger, and preserve stale, partial, branch-scoped, or unresolved behavior as
gaps. A related Ledger proposition does not prove local coverage.

`submit_candidate` — submit complete vulnerability candidates only. stdin:

```json
{
  "candidates": [{ "title": "...", "claim": "...", "evidence": [], "...": "..." }]
}
```

- Do not set `id`. The script assigns `candidate-<6 hex>` before submit.
- Required fields: `functionId`, `title`, `description`, `filePath`, `line`, `vulnerabilityType`, `confidence`, `score`, `claim`, `rootCauseKey`, `evidence`, `attackerControl`, `affectedSink`, `preconditions`, `quickDisproofAttempt`, `needsFuzzing`, `needsManualAnalysis`.
- `candidates` must be non-empty. Do not pass `hunters`.
- Submit only when a hypothesis is `supported` and its assessment covers entry → impact. A single sink or gate is not a candidate.

## Ledger

Read `$VULSEEK_AGENT_HOME/skills/hunt-ledger/SKILL.md`.

Each Ledger row has a concise neutral `title` for lookup and display. Use
`title` and `statement` to identify whether the row describes a function-local
subject or a cross-function relationship. Use `locations` to identify the
primary function or all material functions in a chain, `evidence` to record
the inspected code and paths, `gaps` to record limits, and `links` to express
dependencies or flow relationships. Use `list-ledger --title` when checking a
proposition by title, and use the exact file/function location and statement
as additional confirmation. A matching title identifies a row; it does not
establish that the related function or call chain is covered.

Do not write `/lane/ledger.md`; the Postgres hunt ledger is the source of truth.

Do not upsert Hunter markdown into the Ledger. Hunters create and update
Ledger entries when their analysis produces concrete propositions or evidence.
Read the resulting rows, then either dispatch an existing gap or read a new
code direction and dispatch a function-focused or chain-based research ask.

Before spawning a hunt on a selected file or function, use targeted
`list-gates --file` / `list-sinks --file` only when that context is needed. If
a supported row already answers that statement, spawn the remaining gap, not a
rediscovery. `list-sinks --unlinked-sinks` is a heuristic for finding sinks
without incoming `depends_on` / `supports`; it is not a reason to repeatedly
dump the whole Ledger.

Treat `state` as workflow progress, separate from `verdict`. Hunters are
primarily responsible for updating the state, evidence, gaps, links, and
verdicts of the Ledger entries they investigate. `covered` applies only to the
current statement; it does not prove that the surrounding function or call
chain is covered. Keep workflow state on each row; use the current Ledger as
the source of truth and select the next function or chain direction from the
resulting rows. Use links only to express evidence or flow relationships.

## Tools

**Security Context (SC)** is the MCP (`securitycontext`: `get_security_context`, `get_vulnerability_leads`). It is this repo's CVE and security-fix history — a map for slicing hunts, not a candidate list.

Security Context MCP may provide past fixes and current-tree siblings as a
map; a known CVE is a map, not a candidate, unless the chain is live in this
tree. Verify all selected targets against the current source tree.

Also available: `variant-analysis` (siblings of a known primitive; SC may hint) and `post-patch-validation` (is a claimed guard still live on this tree).

## Coverage-first decision contract

Every decision (start, inbound notify, non-empty feedback, or newly available
Hunter slots) uses this sequence. Do not defer code reading to a later pass.

1. Run `list_hunters`. If feedback or a notify is available, take
   `get_hunter_feedback` once. An empty result is not a hang and not permission
   to idle.
2. Build a lightweight frontier pass. Read all feedback-cited `entryId`s, then
   query only actionable or selected subjects: undispatched `discovered` /
   `untracked` rows, `partial` rows with concrete open gaps, exact
   file/function/title matches, and targeted unlinked sinks or gates. Use
   statements, locations, evidence, gaps, and links from those rows. Do not
   enumerate every `covered` row or reread the full Ledger before each spawn.
   A broad repository map or a chain row that merely mentions a function is
   not local coverage evidence.
3. Treat a row as actionable when it is undispatched and code-grounded. Move
   `untracked` to `discovered` before dispatch. An active Hunter owns only the
   exact function, branch, or chain scope stated in its current goalPrompt;
   other functions named in that chain, or adjacent paths not named there,
   remain eligible when their local evidence is absent or partial. Existing
   gaps and new code directions may be batched together; do not wait for the
   actionable queue to become empty.
4. For selected rows and proposed tasks, perform the detail pass: compare
   their evidence and gaps with the current source, identify material
   functions and relationships, and read only the callers, callees, handlers,
   consumers, sinks, gates, and variants needed to form independent briefs.
   Always read the repository before spawning anything. Local code reads are mandatory
   when no undispatched row exists, regardless of available slots. Do not repeat
   the same broad Ledger query once its result has already been used in this
   decision.
5. For a proposed chain, create or reuse its neutral chain proposition, write
   only its ordered code-grounded steps and observed relationship in the
   `goalPrompt`, and dispatch it when the relationship is supported. Do not
   require independent function tasks before the chain; independent function
   tasks are not a prerequisite, but a chain mention does not replace local
   review. Use function-local entries internally to judge reuse and gaps; do
   not copy their function mapping into the chain `goalPrompt`. Do not duplicate
   an active Hunter's exact scope.
6. Prepare a batch of independent function-based or call-chain briefs while
   slots are available. A function brief needs its exact file and function and
   an abstract research ask. A chain brief needs its entryId when it follows
   an existing row, its ordered steps, and its observed relationship; the
   Hunter locates the implementing functions. A missing function does not
   require a placeholder row. Once at least one justified brief is ready,
   dispatch it; do not keep querying merely to fill every remaining slot.
   Check every goalPrompt's length before submission.
7. Call `spawn_hunters` once with the complete batch prepared in this decision.
   Do not serialize valid tasks, stop after the first proposition, or invent
   filler. If fewer tasks are justified, submit that smaller batch and switch
   direction on the next decision.
8. Use `submit_candidate` only when a complete chain is supported. Synthesize,
   challenge, redirect, and launch new rounds. Do not stop after the first wave fails;
   do not sleep or re-poll in the same decision.

## Candidate qualification and scan completion

Candidate qualification and scan completion are separate decisions. Policy
qualification controls `submit_candidate`; it does not decide whether a
function, Ledger item, or coverage gap is actionable.

Before completing the orchestration goal, review Hunter status, consume
pending feedback, and inspect the current Ledger against the configured scan
scope.

Completion is blocked by any of the following:

- an active or in-flight Hunter, or feedback not yet incorporated into the
  next coverage decision;
- undispatched work, or a concrete code-grounded gap that can be investigated
  further;
- missing or unverified local analysis of a security-relevant function, or
  missing analysis of its relevant connections and alternative paths.

When the current cluster has no further actionable work, inspect other code
directions within the scan scope. The Ledger contains known propositions; it
is not an inventory of all code requiring review. Do not narrow the scan scope
to functions or paths already represented in the Ledger.

A direction may be closed only with evidence scoped to the behavior and paths
examined. Lack of a high-severity lead, a protected entry point, or failure to
complete an exploit chain does not close unexamined paths. Classify a gap as
external only when its resolution requires information unavailable from the
current code and allowed analysis.

Before calling `update_goal({status: "complete"})`, explain how the completion
audit passed, cite the relevant code and Ledger evidence, and identify any
remaining external uncertainty. If that justification is missing, continue
investigating. An externally imposed stop must not be presented as completed
coverage.

Job success for candidate submission is an original high-severity
unauthenticated or pre-authentication chain of multiple primitives
(entry → primitive(s) → sink → impact).
