---
name: orchestrator
description: Dispatch and collect hunter work through scan-runtime. Use for orch-hunt Orchestrator turns.
---

# Orchestrator

Wraps scan-runtime. Do not call scan-runtime poll/capacity/running/submit for hunters.

```bash
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" list_hunters
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" get_hunter_feedback
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" spawn_hunters < payload.json
python3 "$VULSEEK_AGENT_HOME/skills/orchestrator/orchestrator.py" submit_candidate < payload.json
```

## Commands

`list_hunters` — running hunters and remaining slots.

- `availableSlots`, `concurrency`, `activeCount`
- `hunters[]`: `name`, `taskId`, `status`, `startedAt`, `updatedAt`
- Names just spawned this decision may be absent until launch; treat them as in-flight. Do not respawn them.

`get_hunter_feedback` — take this stage's inbound hunter results once (consumes the queue).

- `feedback[]`: `name`, `feedback`, `messageId`
- Empty array = no new results this take, not a hang.
- Each `feedback` string must yield these blocks. If you cannot extract them, the feedback is incomplete — respawn the same primitive narrower. Do not treat unparseable feedback as "no bug".

| Block | Content |
| --- | --- |
| primitive type | sink / gate / smuggle-or-desync / privilege-upgrade |
| location | `file:line` + symbol |
| proved | one or more facts |
| gap | which primitive is still needed to reach an unauthenticated entry or the impact |
| next (optional) | a suggested connector; you may change it |

An incomplete chain is an asset. A sink that exists but is gated is not a candidate and not a close-out — spawn the connector that still feeds the sink.

`spawn_hunters` — submit hunts only. stdin:

```json
{
  "hunters": [{ "name": "#1 slug", "goalPrompt": "..." }]
}
```

- `name` is job-global `#n slug`. n starts at 1 and increases by 1 for every hunt ever submitted. Never skip, reuse, or renumber.
- `len(hunters)` must be ≥ 1 and ≤ `availableSlots`. Do not pass `candidates`.
- Script appends the hunter submit footer. Write the research ask only.

### `goalPrompt` contract

Lock **one** falsifiable primitive. Outcome-heavy, path-light.

Must:

- State what must be proved and what is excluded.
- Treat a missing unauthenticated entry as a **gap**, not as this hunt's success condition.
- Stay on the same primitive; the hunter may change method (manual trace + Semgrep/CodeQL, or a sibling API).

Must not:

- Prefix with `/goal`.
- Write the hunter submit footer or scan-runtime submit instructions.
- Say "audit all …" or "find RCE in REST".
- State an unverified root cause as fact (example: "resolver does not call check_permissions").
- Paste policy, GoalSpec JSON, or name a required tool.

Bad (do not write these shapes):

```
Audit all public media/zip/upload paths for unauthenticated RCE... End with the required footer.
```

```
/goal ... execute_ability() does NOT call check_permissions() ...
```

Good (shape only — not a required hunt target):

```
Primitive: query-var hygiene for author__not_in / author_exclude.
Prove which query vars are interpolated into SQL without absint/prepare,
and whether the REST author_exclude field is typed as an int array (where a string is rejected).
Do not prove RCE. If the sink exists but REST blocks strings, report the gate file:line
and what primitive would still feed a raw string into the query.
No PoC. Stay on this primitive.
```

`submit_candidate` — submit complete vulnerability candidates only. stdin:

```json
{
  "candidates": [{ "id": "L1", "title": "...", "claim": "...", "evidence": [], "...": "..." }]
}
```

- Required fields: `id`, `functionId`, `title`, `description`, `filePath`, `line`, `vulnerabilityType`, `confidence`, `score`, `claim`, `rootCauseKey`, `evidence`, `attackerControl`, `affectedSink`, `preconditions`, `quickDisproofAttempt`, `needsFuzzing`, `needsManualAnalysis`.
- `candidates` must be non-empty. Do not pass `hunters`.
- Submit only when the chain is complete: entry → primitive(s) → sink → impact, each at `file:line`. A single primitive is not a candidate.

## Ledger

Keep `/lane/ledger.md` (human-readable). Optionally also `/lane/primitives.json`.

Each primitive row: `id`, type (sink / gate / smuggle-or-desync / privilege-upgrade), location, status (`open` / `blocked` / `connected` / `in-candidate`), source hunt `name`, gap.

The ledger must answer: which primitives are confirmed, which gaps are not yet dispatched, which are already in a submitted candidate. Later hunts fill gaps. Do not rescan the same surface as "find another RCE".

### Strategies

1. **Slice, don't reproduce.** A lead or CVE is a hypothesis. Spawn a hunter to prove *this tree's* primitive (sink / gate / smuggle / upgrade) at evidence `file:line`. Do not write `goalPrompt`s like "re-find CVE-YYYY-n" or "audit all paths from the SC brief".
2. **Known vs original.** Job success is an original unauthenticated high-CVSS chain. If SC shows this exact chain is disclosed **and already guarded in this tree**, do not `submit_candidate`. Keep the fingerprint (sink + the guard the fix added) and hunt **siblings** still missing that guard.
3. **One lead, one primitive.** Do not send every open slot at the same lead. If a lead's sink exists but an entry/gate is missing, that gap is the next hunter, not a close-out.
4. **Spawn first, SC second.** Fill slots with distinct first-principles primitives immediately. When SC returns, dispatch only leads that are not already on the ledger.
5. **Distill `goalPrompt`s.** Never paste SC markdown, CVE text, or tool dumps into `goalPrompt`. Lock one outcome-heavy primitive. A lead's `file:line` may be a hint, not a required tour.
6. **Record SC ids on the ledger** (lead id / CVE id / weak-spot) so you do not redispatch the same fingerprint as "another RCE".

## When

Every decision (start, inbound notify, non-empty feedback, slots opening) uses the same sequence. Do not wait for a later pass.

1. `list_hunters`
2. `get_hunter_feedback` (do not call again after an empty result in this decision)
3. Update the `/lane` ledger from feedback (primitive + gap)
4. If `availableSlots > 0`, `spawn_hunters` immediately to fill remaining slots with distinct primitives, or a narrowed retry of a primitive whose feedback had no extractable gap
5. `submit_candidate` only when a chain is complete
6. Only after slots are full (or nothing remains to dispatch) may you read the repo locally — to write the next primitive briefs or to check a submitted chain
7. Do not deep-dive a single file while `availableSlots > 0`. Do not sleep or re-poll.

Empty feedback is not halt and not permission to idle.
