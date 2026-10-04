---
name: scan-runtime
description: Query live scan-job runtime info from the Vulseek API, including dispatch capacity and active tasks for a pipeline stage.
---

# Scan runtime

Identity comes from the environment injected by the ACP Driver before the task
starts:

```text
VULSEEK_SCAN_JOB_ID
VULSEEK_TASK_ID
VULSEEK_STAGE_NAME
```

Do not read task identity from files or infer it from the prompt.

The client uses Python `requests` and honors the container's proxy environment,
including `NO_PROXY/no_proxy`. It retries transient network failures, including
temporary DNS resolution errors, connection resets/refusals, and socket
timeouts, up to three attempts with short exponential backoff. HTTP errors such
as `401`, `403`, or `404` are not retried because they indicate an
authentication or request problem rather than a transient network failure.

## Commands

Query remaining downstream dispatch capacity before emitting fan-out work:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" \
  downstream-capacity [--to-stage STAGE]
```

`availableSlots` is `concurrency - activeTasks` for that downstream stage (`launching`, `launched`, `starting`, `running`). It is a hard cap for this turn. If it is 0, emit an empty list for that downstream collection.

Examples:

- Orchestrator hunt dispatch: `--to-stage hunter`
- All outgoing stages: omit `--to-stage`

Query active tasks for any pipeline stage:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" \
  running-tasks --stage STAGE
```

The result contains `stageName` and a `tasks` array. Each task includes `taskId`,
`name`, `title`, `status`, `startedAt`, and `updatedAt`. `name` is the assigned
hunt/work name (the same string Orchestrator put on `huntTasks[].name`). Active
task statuses are `launching`, `launched`, `starting`, and `running`. An empty
`tasks` array means that no active task currently exists for the requested stage.

Poll completed Messages from a downstream stage:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" \
  stage-outputs --stage STAGE
```

The result contains an `outputs` array. Each item includes `name`, `taskId`,
`taskStatus`, `messageId`, `dispatchStatus`, `output`, and `createdAt`.
`name` prefers `output.name` and falls back to the Task name. Only completed
dispatches are listed. You may only query stages that are downstream of the
current Task.

Take **this stage's waiting inbound Messages** (not another stage's outputs).
Pass the current stage name. For Orchestrator that is `--stage orchestrator`:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" \
  poll-messages --stage STAGE
```

That call takes every currently waiting Message in one batch (not one
item per call), removes them from Redis, and returns this poll's items. It
does not replay items from earlier polls. Each item includes
`messageId`, `edgeName`, `name`, `status`, `sourceEdgeName`, and reconstructed
`input` (for Hunter follow-up: `name` and `feedback`). You may only poll your
own stage queue. An empty array while downstream tasks are still `running` is
the Orchestrator's wait state, not a hang. `running-tasks` timestamps often stay unchanged
during a run. `query-messages` only peeks; use `poll-messages` to consume.
A Hunter does not poll. Its only handoff is `submit-message`; it does not
call `running-tasks`, `stage-outputs`, or `poll-messages`, and it does not
wait for a downstream stage.

After using an item's input, complete it so any leftover queue entry is dropped:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" \
  complete-messages --message-id MESSAGE_ID
```

Repeat `--message-id` to complete several Messages.

For Orchestrator hunt dispatch, query `running-tasks --stage hunter` together
with downstream capacity immediately before submitting an output. Use `name` to
avoid duplicate hunts. On later Goal turns, poll `poll-messages --stage orchestrator`
and match `name` / `input.name` to the hunts you launched. Do not use
`stage-outputs --stage hunter` as the Hunter-to-Orchestrator return path.

Submit one or more structured Messages (a JSON value matching the output
schema on stdin). The same snapshot schema and artifact checks run automatically
inside `submit-message` before the output is inserted or dispatched. Validation
failure returns a non-zero command status and no output is inserted. Optional
`--route` selects a downstream route; optional `--submission-key` makes the
submission idempotent:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/scan_runtime.py" \
  submit-message [--route KEY] [--submission-key KEY] < result.json
```

Read `/task/output.schema.json` first, then call `submit-message` directly. Do
not run a separate validation command. The client may keep a debug copy of the
last submitted payload; that copy is not the dispatch protocol. A Task may
submit multiple outputs; each accepted output dispatches immediately.
