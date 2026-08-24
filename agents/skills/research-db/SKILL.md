---
name: research-db
description: Read and mutate the current Research Registry through typed Python commands.
---

# Research Database

Use the helper for all Research Registry reads and writes. It is scoped to the
current `VULSEEK_SCAN_JOB_ID`; do not write SQL or connect with another client.

The helper is available at:

```text
$VULSEEK_AGENT_HOME/skills/research-db/research_db.py
```

## Reads

```bash
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" list-tracks
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" get-track --track-id <id>
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" list-findings --track-id <track-id>
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" get-finding --finding-id <id>
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" list-primitives --finding-id <finding-id>
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" get-primitive --primitive-id <id>
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" list-chains
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" get-chain --chain-id <id>
```

## Writes

Use direct entity commands. Each command is one short database transaction:

```bash
python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" create-track \
  --track-id <id> \
  --track-key <key> \
  --approach-family <family> \
  --research-idea <idea>

python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" update-track \
  --track-id <id> \
  --expected-revision <revision> \
  --status active

python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" create-finding \
  --finding-id <id> \
  --track-id <track-id> \
  --content-file /task/outputs/finding.json

python3 "$VULSEEK_AGENT_HOME/skills/research-db/research_db.py" update-finding \
  --finding-id <id> \
  --expected-revision <revision> \
  --status validated
```

The same `create-*`, `update-*`, and `delete-*` commands exist for Tracks,
Findings, Primitives, and Chains. The scan job ID is always fixed by runtime
context; Finding creation defaults
`producerTaskId` from the task context and accepts an explicit value only for
repair. Entity IDs and relationship fields may be changed
only with an explicit absolute update and the current revision; preserve
stable keys unless the stage is deliberately repairing an identity or
ownership decision.

## Conflict Loop

Always use this sequence:

```text
read -> reason without an open transaction -> create/update/delete
  created/updated/alreadyApplied/alreadyExists -> continue
  conflict -> read current entity -> merge or supersede -> retry
  alreadyDeleted -> treat delete as complete
```

Stop after three consecutive CAS conflicts for one decision. Record the
unresolved conflict in the stage output rather than spinning indefinitely.

Updates require `expectedRevision` and must provide absolute desired values.
Do not use increment, append, remove-by-index, `apply-batch`, event commands,
generic mutation JSON, or raw SQL. List and object fields are replaced in full.

If a command fails after an ambiguous connection error, read the entity before
retrying. There is no operation-history or idempotency table; the current state
and monotonic `revision` are the source of truth.

Never read `auth.json`, `.credentials.json`, or an agent API token to construct
database credentials. The runtime provides `VULSEEK_RESEARCH_DATABASE_URL`,
`VULSEEK_SCAN_JOB_ID`, `VULSEEK_TASK_ID`, and `VULSEEK_STAGE_NAME`. The current
stage input is available at `/task/inputs/task-input.json`; use it to keep
`producerTaskId` and `trackId` aligned when creating findings.
