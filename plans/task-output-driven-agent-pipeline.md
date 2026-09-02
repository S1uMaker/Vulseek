# TaskOutput-Driven Agent Pipeline

## Summary

Refactor the scan runtime so a `Task` represents one Agent `turn` or `goal`
lifecycle and a `TaskOutput` represents one structured output submitted during
that lifecycle. A running Task can submit multiple equal TaskOutputs. Each
accepted output dispatches downstream immediately; it does not wait for the
producer Task to end.

Use `TaskOutput`, `task_outputs`, and `taskOutputId` throughout. Remove all
`Emission` terminology and the `/task/output.json` protocol.

## Data Model

Keep only runtime data on `tasks`:

```text
taskId, scanJobId, name, stageName, lifecycle, status,
sourceTaskOutputId, sourceEdgeName, sourceItemIndex, rerunOfTaskId,
forkedFromTaskId, priority, attempt, agentProfile,
containerName, containerIndex, threadId, runtimeMode, stageGroupInstanceId,
inputTokens, outputTokens, thoughtTokens, totalTokens,
cachedReadTokens, cachedWriteTokens, estimatedCost,
errorMessage, startedAt, completedAt, createdAt, updatedAt
```

- `lifecycle` is `turn` or `goal` and replaces `executionKind`.
- Remove `input`; root Tasks derive input from Job context and downstream Tasks
  reconstruct it from TaskOutput, Edge, and the immutable Pipeline Snapshot.
- Remove `output`, `vulnerabilityCandidateId`, `parentTaskId`, `dispatchKey`,
  downstream dispatch fields, `forkedFromThreadId`, `exitReason`, and
  `exitNote`.
- `sourceTaskOutputId`, `sourceEdgeName`, and `sourceItemIndex` identify the
  normal downstream source. `rerunOfTaskId` separately records a rerun.

Add `task_outputs`:

```text
taskOutputId, producerTaskId, sequence, submissionKey, routeKey, output,
dispatchStatus, dispatchAttempt, claimedAt, dispatchedAt, errorMessage,
createdAt, updatedAt
```

- Do not duplicate `scanJobId` or `producerStageName`; obtain them through the
  producer Task.
- `(producerTaskId, sequence)` and `(producerTaskId, submissionKey)` are
  unique.
- `dispatchStatus` is `pending`, `processing`, `completed`, or `failed`.
- TaskOutput has no `continue`, `final`, or `exit` field.
- Candidate, Finding, Projection, Registry Effect, and Job Output records use
  `taskOutputId` as their dataflow provenance.

## Submission, Lifecycle, And Dispatch

Add `POST /api/internal/scan/runtime/task-outputs`. The `scan-runtime` skill
provides `submit-output`, accepting an output JSON object on stdin, plus an
optional route key and submission key. It uses the existing Task-scoped HMAC.

The API resolves the producer Task's stage schema and valid routes from the Job
Pipeline Snapshot, validates the payload and artifact paths, assigns an atomic
per-Task `sequence`, and inserts a pending TaskOutput. Reusing the same
submission key returns the original record; reusing it with different content
returns `409`.

The API wakes the Job runtime after commit. The dispatcher claims pending
outputs while the Job is running, applies effects and Edge transforms, creates
deterministic child Tasks, then enqueues them after the database transaction.
Outputs from one Task dispatch in sequence; outputs from different Tasks may
dispatch concurrently. Pause retains pending outputs, while cancel or Job
termination closes them.

Turn Tasks end on normalized ACP turn completion. Goal Tasks end only on a
normalized Goal terminal event. Submitting an output, `task_complete`, or a
completed turn cannot end an active Goal. A normally completed Task must have
at least one TaskOutput; otherwise mark it as a protocol failure. Accepted
outputs remain valid if the producer later fails.

Stop reading or writing `/task/output.json`. Continue to generate
`/task/output.schema.json`; generated prompts instruct Agents to read it and
call the runtime skill. Remove the old output validator skill and envelope
parser.

## Migration And UI

Create the new table and Task lifecycle/source fields. Backfill every historical
non-null `tasks.output` as sequence 1 with `submissionKey=legacy:<taskId>` and
`dispatchStatus=completed`, so history remains readable without replaying old
outputs. Backfill TaskOutput provenance for dependent result entities, then
remove the old Task fields. Do not retain dual protocol or query fallbacks.

Require all old-protocol Jobs to be stopped or canceled before migration.
Task detail replaces its single output view with a paginated TaskOutput list
showing sequence, route, dispatch state, timestamp, and structured payload.
Resolved Task input is reconstructed for display from its source output and
Edge.

## Test Plan

Cover multiple submissions, concurrent submissions, ordering, idempotency,
invalid schema/route/artifact, pause, cancel, claim recovery, duplicate child
creation, Redis enqueue recovery, and settlement. Verify active Goals survive
multiple TaskOutputs, normal zero-output completion fails, and input can be
reconstructed for root, downstream, and rerun Tasks. Test migration and
provenance backfill without any runtime fallback.

Run server/frontend tests, typechecks, migration tests, and `git diff --check`.

### WordPress Luna End-To-End

1. Create an `Orch-Hunt Luna` Runtime Profile for
   `orchestrator-hunt-programmatic`. Set all four stages to the
   `gpt-5.6-luna` Agent Profile and retain pipeline-default concurrency,
   including Hunter concurrency 8.
2. Check the expected dev tools image content hash. This change affects the
   Driver and runtime skill, so rebuild `vulseek-scan-tools-dev:<content-hash>`
   through the UI when the local image is absent or stale.
3. Confirm the WordPress checkout image is based on that exact tools image.
   Rebuild the WordPress checkout image through the UI when its pinned tools
   image does not match.
4. Start a WordPress Scan Job with the newest published Orch-Hunt pipeline and
   the Luna Runtime Profile.
5. Confirm the persistent Orchestrator appears in Running Tasks from launch,
   its Session includes the injected prompt, and it does not rely on
   `/task/output.json`.
6. Confirm the first Orchestrator TaskOutput immediately creates Hunter Tasks
   while the Orchestrator Goal remains active. Inspect TaskOutput sequence,
   route, child Task, artifact, and provenance in UI, API, and database.
7. Confirm Hunter feedback causes an Orchestrator continuation that can submit
   another TaskOutput. If no second output occurs within 20 minutes, retain
   Session, TaskOutput, runtime, and Driver diagnostics and fail the test.
8. Verify TaskOutput lists, Running/Finished Tasks, Candidate/Verification
   provenance, and Job settlement. Cancel the test Job and verify no waiting
   or active queue entry, Task container, or credential temporary file remains.

## Assumptions

- TaskOutput is the only output dataflow source.
- Every submitted output has equal standing; there is no final-output concept.
- Agents submit through the authenticated runtime API and never write the
  database directly.
- Pipeline Snapshots are immutable for a Job, making input reconstruction
  deterministic.
- Validation and the end-to-end test operate only in dev and do not touch
  release.
