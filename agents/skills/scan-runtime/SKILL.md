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

## Commands

Query remaining downstream dispatch capacity before emitting fan-out work:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/query_scan_runtime.py" \
  downstream-capacity [--to-stage STAGE]
```

`availableSlots` is `concurrency - activeTasks` for that downstream stage (`launching`, `launched`, `starting`, `running`). It is a hard cap for this turn. If it is 0, emit an empty list for that downstream collection.

Examples:

- Orchestrator hunt dispatch: `--to-stage hunter`
- All outgoing stages: omit `--to-stage`

Query active tasks for any pipeline stage:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/scan-runtime/query_scan_runtime.py" \
  running-tasks --stage STAGE
```

The result contains `stageName` and a `tasks` array. Each task includes `taskId`,
`title`, `status`, `startedAt`, and `updatedAt`. Active task statuses are
`launching`, `launched`, `starting`, and `running`. An empty `tasks` array means
that no active task currently exists for the requested stage.

For Orchestrator hunt dispatch, query `running-tasks --stage hunter` together
with downstream capacity immediately before writing `/task/output.json`.
