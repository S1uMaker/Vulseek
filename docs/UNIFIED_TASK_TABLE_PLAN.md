# Unified Task Table Plan

## Goal

Replace the current multiple `xxxTask` tables with one unified `tasks` table.

This table should store only the fields that describe the generic task concept:

- what job it belongs to
- what pipeline stage it belongs to
- execution state
- runtime / agent / container metadata
- timing and retry information

It should **not** store stage-specific domain payload such as:

- `moduleName`
- `functionName`
- `filePath`
- `line`
- `riskType`
- `reportPath`
- `pocPath`
- `dockerfilePath`

Those fields are not generic task concepts. They belong in:

- object tables such as repository / module / function / candidate
- result tables such as analysis result / verification result
- artifact manifests

## Current Problem

Today the task concept is split across:

- `scan_repository_tasks`
- `scan_module_tasks`
- `scan_function_tasks`
- `candidate_analysis_tasks`
- `candidate_verification_tasks`

These tables duplicate the same execution metadata:

- `status`
- `attempt`
- `containerName`
- `threadId`
- `agentProfile`
- `result`
- `errorMessage`
- `startedAt`
- `completedAt`
- `createdAt`
- `updatedAt`

But they also mix in domain-specific fields. That makes the task model unstable and hard to generalize.

## Design Principle

The unified `tasks` table should answer only these questions:

1. What is this task?
2. What parent job / parent task does it belong to?
3. What pipeline stage is it running?
4. What is its current execution state?
5. What runtime metadata was produced while executing it?

If a field is not needed to answer one of the above questions, it should probably not live in `tasks`.

## Proposed Table

Suggested table name:

- `tasks`

Suggested columns:

| column | type | required | meaning |
| --- | --- | --- | --- |
| `taskId` | text pk | yes | globally unique task id |
| `scanJobId` | text fk | yes | owning scan job |
| `parentTaskId` | text fk nullable | no | upstream parent task |
| `name` | text | yes | human-readable task title |
| `stageName` | text | yes | pipeline stage name used by runtime |
| `status` | text / enum | yes | `queued`, `running`, `completed`, `failed` |
| `priority` | integer | no | scheduling priority if relevant |
| `attempt` | integer | yes | retry count |
| `agentProfile` | jsonb | no | resolved agent profile snapshot |
| `containerName` | text | no | runtime container name |
| `threadId` | text | no | remote session / thread id |
| `input` | text | no | JSON format task input object |
| `output` | text | no | JSON format validated task output object |
| `rawOutput` | text | no | raw LLM output or structured return blob |
| `errorMessage` | text | no | terminal execution error |
| `startedAt` | text | no | execution start time |
| `completedAt` | text | no | execution finish time |
| `createdAt` | text | yes | record creation time |
| `updatedAt` | text | yes | last update time |

## Field Semantics

### `taskId`

- one global id space for all task rows
- should be stable once created
- should be the same id used by:
  - queue payload
  - stage runtime context
  - frontend task detail lookup
  - artifact directory naming when task-scoped

### `scanJobId`

- every task belongs to exactly one scan job
- this remains the main partition key for:
  - job detail pages
  - queue recovery
  - cancellation
  - aggregation

### `parentTaskId`

- nullable for root task
- non-null for downstream tasks created from an upstream task
- intended meaning:
  - repository scan task -> `null`
  - module scan task -> parent is repository scan task
  - function scan task -> parent is module scan task
  - candidate analysis task -> parent is function scan task
  - candidate verification task -> parent is candidate analysis task

This should reflect execution lineage, not merely domain ownership.

### `name`

- human-readable label
- used in:
  - tables
  - breadcrumbs
  - logs
  - artifact path naming if needed

Recommended values:

- repository scan: `Repository Scan`
- module scan: module display name
- function scan: function display name
- candidate analysis: candidate title
- candidate verification: candidate title

### `stageName`

- runtime-level stage identity
- should match the actual pipeline stage definition name

Current expected values:

- `RepositoryProfileStage`
- `IdentifyTargetStage`
- `ScanTargetStage`
- `AnalysisStage`
- `VerifyingStage`

### `status`

- lifecycle status of the task row itself
- should not encode domain result meaning

Examples:

- `completed` means execution succeeded
- `failed` means execution failed

It does not mean:

- vulnerability is real
- vulnerability is false positive
- repository scan found no issues

Those meanings belong in result payloads.

### `priority`

- optional scheduling hint
- should be null when not meaningful
- do not force meaningless `0` values everywhere unless queue code really depends on them

### `attempt`

- number of execution attempts already made for this task row
- increments on retry
- should be updated by worker / queue layer, not by prompt logic

### `agentProfile`

- resolved snapshot at execution time
- should be stored as immutable execution metadata
- should not be retroactively rewritten when the profile config later changes

### `containerName`

- actual runtime container name used for the attempt
- if retries reuse the same row but different containers, this field only stores the latest one
- if historical per-attempt runtime data becomes important later, move that concern to a separate `task_attempts` table

### `threadId`

- remote session / conversation / thread id created by sandbox agent runtime
- latest successful binding for this task

### `input`

- serialized structured task input object
- should represent the input passed into `stage.run`
- should be written before execution begins or at task creation time

### `output`

- serialized validated output object
- should represent the post-validation structured output
- should be written only after validation succeeds

### `rawOutput`

- raw model return before validation normalization
- may be:
  - valid JSON
  - invalid JSON
  - plain text
  - tag-wrapped text such as `<VULSEEK_RET>...<VULSEEK_RET>`

### `errorMessage`

- terminal execution error summary for the latest attempt
- should be concise enough for UI display
- detailed diagnostics should still live in logs / artifacts

## Recommended Constraints

### Primary Key

- primary key: `taskId`

### Foreign Keys

- `scanJobId -> scan_jobs.scanJobId`
- `parentTaskId -> tasks.taskId`

### Required Fields

Recommended non-null fields:

- `taskId`
- `scanJobId`
- `name`
- `stageName`
- `status`
- `attempt`
- `createdAt`
- `updatedAt`

### Status Enum

Recommended enum values:

- `queued`
- `running`
- `completed`
- `failed`

### Suggested Check Rules

- `attempt >= 0`
- `priority is null or priority >= 0`
- if `completedAt` is not null, then `status in ('completed', 'failed')`
- if `status = 'running'`, then `startedAt` should not be null

These can be implemented either at DB level or enforced in repo code.

## Recommended Indexes

### Required

- index on `scanJobId`
- index on `parentTaskId`
- index on `(scanJobId, status)`
- index on `(scanJobId, createdAt desc)`
- index on `(stageName, status)`

### Likely Useful

- index on `threadId`
- index on `containerName`

### Not Recommended Initially

- indexes on `input`
- indexes on `output`
- indexes on `rawOutput`

Those fields are large blobs and should not drive core query patterns.

## Strong Recommendation

Keep the table minimal. In particular:

- do not add target descriptive fields
- do not inline result-specific fields
- do not inline artifact paths

Otherwise the unified table will quickly turn into another overloaded catch-all table.

## Notes On `input`, `output`, `rawOutput`

- `input`
  - should store the exact task input object passed into stage execution
  - should be serialized JSON text
- `output`
  - should store the validated structured output object
  - should be serialized JSON text
- `rawOutput`
  - should store the original unvalidated model return
  - this may differ from `output`
  - for some tasks it may contain invalid JSON, extra prose, or partial text

This separation is useful:

- `input` is for deterministic replay / debugging
- `output` is for structured downstream consumption
- `rawOutput` is for incident analysis and prompt debugging

## Status Transition Rules

Recommended allowed transitions:

- `queued -> running`
- `queued -> failed`
- `running -> completed`
- `running -> failed`
- `failed -> queued` for retry

Transitions that should usually be avoided:

- `completed -> running`
- `completed -> failed`
- `failed -> completed` without explicit retry reset

## Task Creation Timing

Recommended creation point:

- create the task row before enqueueing work

At creation time, fill:

- `taskId`
- `scanJobId`
- `parentTaskId`
- `name`
- `stageName`
- `status = queued`
- `priority`
- `attempt = 0`
- `input`
- `createdAt`
- `updatedAt`

At run start, fill:

- `status = running`
- `startedAt`
- `containerName`
- `threadId` when available
- `agentProfile`

At validation success, fill:

- `output`
- `rawOutput`
- `status = completed`
- `completedAt`

At failure, fill:

- `rawOutput` if available
- `errorMessage`
- `status = failed`
- `completedAt`

## Aggregation Strategy

This unified table should support all current scan job summary counts:

- repository task count
- module task total / completed / failed
- function task total / completed / failed
- candidate analysis total / completed / failed
- candidate verification total / completed / failed

But those counts should be computed by:

- `stageName`
- `status`
- `scanJobId`

not by separate physical tables.

## What Should Move Out Of Task

These current fields should not remain in the unified `tasks` table:

### Repository/module/function descriptive fields

- `moduleId`
- `moduleName`
- `functionId`
- `functionName`
- `filePath`
- `line`
- `riskType`
- `summary`
- `score`

Reason:

- they describe the target object or the result, not the task execution itself

### Artifact path fields

- `repositoryProfileMdPath`
- `repositoryProfileJsonPath`
- `modulePlanJsonPath`
- `identifyTargetMdPath`
- `identifyTargetJsonPath`
- `functionPlanJsonPath`
- `scanTargetMdPath`
- `scanTargetJsonPath`
- `reportPath`
- `issueDraftPath`
- `pocPath`
- `dockerfilePath`
- `runScriptPath`

Reason:

- they belong in artifact manifests or result tables

### Verification / analysis result fields

- `confidence`
- `score`
- `isBug`
- `isSecurity`
- `runtimeSeconds`

Reason:

- they are result payload, not generic task execution metadata

## Suggested Related Tables

To keep `tasks` clean, the rest of the information should be carried elsewhere.

### 1. `tasks`

Generic execution metadata only.

### 2. domain object tables

Examples:

- `repositories`
- `modules`
- `functions`
- `vulnerability_candidates`

These hold the identity and descriptive attributes of the target.

Even if `tasks` does not directly store `targetId`, the input/output payloads should still reference stable object ids where needed.

### 3. result tables

Examples:

- `repository_scan_results`
- `module_scan_results`
- `function_scan_results`
- `candidate_analysis_results`
- `candidate_verification_results`

These hold stage-specific structured outputs.

### 4. artifact tables or manifests

Examples:

- `task_artifacts`

Columns could be:

- `taskArtifactId`
- `taskId`
- `artifactKind`
- `path`
- `metadata`

## Minimal Enum Suggestions

### `status`

- `queued`
- `running`
- `completed`
- `failed`

## Mapping From Current Tables

### `scan_repository_tasks`

- maps into one `tasks` row
- `stageName = RepositoryProfileStage`
- `name = Repository Scan`
- `parentTaskId = null`

### `scan_module_tasks`

- maps into one `tasks` row
- `stageName = IdentifyTargetStage`
- `name = moduleName`
- `parentTaskId = repository task id`

### `scan_function_tasks`

- maps into one `tasks` row
- `stageName = ScanTargetStage`
- `name = functionName`
- `parentTaskId = owning module task`

### `candidate_analysis_tasks`

- maps into one `tasks` row
- `stageName = AnalysisStage`
- `name = candidate title`
- `parentTaskId = function task id`

### `candidate_verification_tasks`

- maps into one `tasks` row
- `stageName = VerifyingStage`
- `name = candidate title`
- `parentTaskId = candidate analysis task id`

## Migration Direction

Recommended migration sequence:

1. Create new `tasks` table.
2. Start dual-writing:
   - old task tables
   - new `tasks` table
3. Switch reads for:
   - job overview
   - task detail
   - queue recovery
   - cancel logic
4. Stop writing old task tables.
5. Backfill any missing derived data.
6. Drop old task tables after a stable period.

This is safer than a hard cutover because:

- queue code is stateful
- scan jobs may be long-running
- cancellation / retry semantics are easy to break

## Suggested Phase 1 Scope

Phase 1 should only aim to unify execution metadata.

Do not try to solve all of these in the same PR:

- result table redesign
- artifact manifest redesign
- frontend display redesign
- candidate schema redesign
- object table redesign

A good Phase 1 outcome is simply:

- one unified `tasks` table exists
- all new tasks are written there
- runtime and queue logic no longer depend on five separate task tables

## Drizzle Schema Draft

```ts
export const taskStatusEnum = pgEnum("task_status", [
	"queued",
	"running",
	"completed",
	"failed",
]);

export const tasks = pgTable(
	"tasks",
	{
		taskId: text("taskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		parentTaskId: text("parentTaskId").references((): AnyPgColumn => tasks.taskId, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		stageName: text("stageName").notNull(),
		status: taskStatusEnum("status").notNull().default("queued"),
		priority: integer("priority"),
		attempt: integer("attempt").notNull().default(0),
		agentProfile: jsonb("agentProfile").$type<TaskAgentProfileSnapshot | null>(),
		containerName: text("containerName"),
		threadId: text("threadId"),
		input: text("input"),
		output: text("output"),
		rawOutput: text("rawOutput"),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		completedAt: text("completedAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		scanJobIdx: index("tasks_scan_job_idx").on(table.scanJobId),
		parentTaskIdx: index("tasks_parent_task_idx").on(table.parentTaskId),
		scanJobStatusIdx: index("tasks_scan_job_status_idx").on(
			table.scanJobId,
			table.status,
		),
		scanJobCreatedAtIdx: index("tasks_scan_job_created_at_idx").on(
			table.scanJobId,
			table.createdAt,
		),
		stageStatusIdx: index("tasks_stage_status_idx").on(
			table.stageName,
			table.status,
		),
		threadIdx: index("tasks_thread_idx").on(table.threadId),
		containerIdx: index("tasks_container_idx").on(table.containerName),
	}),
);
```

Notes:

- `input`, `output`, and `rawOutput` are kept as `text` in this draft, matching your current direction.
- If later you want DB-side JSON querying, `input` and `output` can be migrated to `jsonb`.
- `stageName` is `text` for now because the stage set may continue evolving during the refactor.

## Repository API Draft

Suggested persistence surface:

### Create

```ts
createTaskRepo(input: {
	taskId?: string;
	scanJobId: string;
	parentTaskId?: string | null;
	name: string;
	stageName: string;
	status?: "queued" | "running" | "completed" | "failed";
	priority?: number | null;
	attempt?: number;
	agentProfile?: TaskAgentProfileSnapshot | null;
	containerName?: string | null;
	threadId?: string | null;
	input?: string | null;
	output?: string | null;
	rawOutput?: string | null;
	errorMessage?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
})
```

### Read

```ts
findTaskByIdRepo(taskId: string)
listTasksByScanJobIdRepo(scanJobId: string)
listChildTasksByParentTaskIdRepo(parentTaskId: string)
listTasksByScanJobAndStageRepo(input: {
	scanJobId: string;
	stageName: string;
})
```

### Update

```ts
updateTaskRepo(
	taskId: string,
	patch: Partial<typeof tasks.$inferSelect>,
)

updateTaskStatusRepo(input: {
	taskId: string;
	status: "queued" | "running" | "completed" | "failed";
	errorMessage?: string | null;
})

bindTaskRuntimeRepo(input: {
	taskId: string;
	containerName?: string | null;
	threadId?: string | null;
	agentProfile?: TaskAgentProfileSnapshot | null;
})

storeTaskInputRepo(taskId: string, input: string)
storeMessageRepo(taskId: string, output: string)
storeTaskRawOutputRepo(taskId: string, rawOutput: string)
```

### Aggregation

```ts
countTasksByScanJobAndStatusRepo(scanJobId: string)
countTasksByScanJobStageAndStatusRepo(scanJobId: string)
```

## Runtime Mapping Draft

### At task creation time

Write:

- `taskId`
- `scanJobId`
- `parentTaskId`
- `name`
- `stageName`
- `priority`
- `status = queued`
- `attempt = 0`
- `input`

### At stage start

Write:

- `status = running`
- `startedAt`
- `containerName`
- `agentProfile`

### When thread/session is known

Write:

- `threadId`

### After raw model return is captured

Write:

- `rawOutput`

### After validation succeeds

Write:

- `output`
- `status = completed`
- `completedAt`

### After failure

Write:

- `errorMessage`
- `status = failed`
- `completedAt`

## How Existing Stage Inputs Would Map Into `input`

### Repository task

```json
null
```

### Module task

```json
{
	"scanJob": { "...": "..." },
	"repository": { "...": "..." },
	"module": { "...": "..." }
}
```

### Function task

```json
{
	"scanJob": { "...": "..." },
	"repository": { "...": "..." },
	"module": { "...": "..." },
	"function": { "...": "..." }
}
```

### Candidate analysis task

```json
{
	"candidate": { "...": "..." }
}
```

### Candidate verification task

```json
{
	"analysisResult": { "...": "..." }
}
```

## How Existing Stage Outputs Would Map Into `output`

### Repository task

```json
{
	"taskId": "...",
	"repository": { "...": "..." },
	"modules": [{ "...": "..." }]
}
```

### Module task

```json
{
	"taskId": "...",
	"functions": [{ "...": "..." }]
}
```

### Function task

```json
{
	"taskId": "...",
	"candidates": [{ "...": "..." }]
}
```

### Candidate analysis task

```json
{
	"taskId": "...",
	"analysis": { "...": "..." }
}
```

### Candidate verification task

```json
{
	"taskId": "...",
	"verification": { "...": "..." }
}
```

## Cutover Checklist

Before removing old task tables, verify:

1. queue workers read/write only `tasks`
2. scan cancellation stops tasks via unified lookup
3. job overview counts come from unified aggregation
4. task detail page reads from unified table
5. agent output lookup still resolves the correct task row
6. retry logic increments `attempt` correctly
7. pipeline recovery can reconstruct downstream scheduling using `parentTaskId` and `stageName`

## Open Questions

1. Should `taskId` remain stage-local ids, or become globally stable ids across the whole pipeline?
2. Should `parentTaskId` be nullable for root tasks only, or also for tasks created outside the pipeline?
3. Do we want one unified result table too, or only unify the task table?
4. Should artifact paths live in a separate `task_artifacts` table or a JSON manifest file?
5. Should `rawOutput` stay in DB, or should DB hold only a pointer to on-disk artifacts?
6. Should `input` and `output` use `text` or directly use `jsonb`?

## Recommendation

For the first refactor, keep scope strict:

1. Introduce one unified `tasks` table.
2. Keep generic execution metadata only.
3. Add `input`, `output`, and `rawOutput` explicitly.
4. Do not mix structured result fields into `tasks`.
5. Move artifact/result payloads into separate tables or manifests.

That gives a clean core model instead of simply merging five noisy tables into one bigger noisy table.
