# ACP Driver Module Split

## Summary

Split `packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs`
(~1051 lines) and its test file (~2191 lines) into a small ESM package that
still runs as one Node process inside the scan-tools image. Do not bundle.
Do not change ACP protocol, Goal settlement, Grok wire rewriting, or TaskOutput
behavior in the same change.

`run-single-turn-agent.ts` is out of scope. It is the host-side container
primitive; this plan only covers the in-container ACP driver.

## Why

The driver currently mixes:

- JSONL task input / persistent queue
- stdout protocol (`start`, `thread`, `task_start`, `task_done`, `usage`)
- snapshot / activity mapping
- FS sandbox and permission
- idle timeout
- Goal capability and `/goal` prompt assembly
- Grok vendor `session/update` rewriting
- ACP client connect, session open, `runTask`

Tests spawn the whole process for every case, each copying the same fake-adapter
boilerplate. Grok wire and Goal prompt logic can be unit-tested by importing
modules.

## Constraints

- Entrypoint path stays `/opt/vulseek-acp/vulseek-acp-driver.mjs` (host
  `ACP_DRIVER_FILE_NAME` and tests spawn this file).
- Keep ESM (`import` / `export`). Relative imports only. No TypeScript, no
  bundler, no `package.json` `"type"` change required if every file is `.mjs`.
- Dockerfile currently:

  ```dockerfile
  COPY vulseek-acp-driver.mjs agent-events.mjs /opt/vulseek-acp/
  RUN chmod 0755 /opt/vulseek-acp/vulseek-acp-driver.mjs \
      && node --check /opt/vulseek-acp/vulseek-acp-driver.mjs
  ```

  After the split, copy the whole driver directory and `node --check` the
  entrypoint (which loads siblings).
- `resolveCheckoutToolsDefinition` hashes a single `acpDriver` file and
  `executeCheckoutToolsBuild` `copyFile`s only `vulseek-acp-driver.mjs` into
  the Docker build context. The hash and copy must cover every driver `.mjs`.
- `agent-events.mjs` stays a separate asset from `vendor/claude-replay`. Do
  not fold it into the driver tree.
- Tests must keep passing with `node --test packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs` (or a glob of split test files).

## Target layout

```text
packages/server/src/services/dockerfiles/
  vulseek-acp-driver.mjs              # entry only: JSONL loop, spawn, ACP connect, runTask
  vulseek-acp-driver.test.mjs         # integration tests that spawn the entry
  acp-driver/
    util.mjs                          # sleep, asRecord, asString
    identity.mjs                      # VULSEEK_* env from task input
    protocol.mjs                      # serialized JSONL append to stdoutPath
    activity.mjs                      # activityForEvent, createSnapshotWriter
    fs-sandbox.mjs                    # resolveAllowedPath, updateTaskAlias
    permission.mjs                    # choosePermission
    timeout.mjs                       # withTimeout, idle bump
    capabilities.mjs                  # resume/fork/close/Goal v1/Grok goal command
    grok-wire.mjs                     # rewrite Grok methods to session/update, stdout filter
    goal-prompt.mjs                   # prefixNativeGoal, resolveGoalPromptParts
  acp-driver/__test__/
    helpers.mjs                       # spawn driver, waitFor, readEvents, fake adapter
    grok-wire.test.mjs
    goal-prompt.test.mjs
    capabilities.test.mjs
```

Keep the entry filename at the current dockerfiles path (or a thin
`vulseek-acp-driver.mjs` that re-exports/runs `acp-driver/main.mjs`) so
`ACP_DRIVER_FILE_NAME` and existing test `path.resolve(.../vulseek-acp-driver.mjs)`
need at most one line of change.

Suggested entry contents after the split:

- read JSONL / persistent next-task loop
- spawn adapter (`codex-acp` / `claude-agent-acp` / `grok`)
- ACP client handlers (permission, fs, `session/update`)
- `runTask`: identity, alias, prompt, Goal completion gate, `task_done`
- SIGTERM / error `exit` records

Do not extract `runTask` into a framework. The session, prompt, and Goal
completion closures belong together.

## Module boundaries

| Module | Owns | Does not own |
|---|---|---|
| `util.mjs` | tiny coercions | I/O |
| `identity.mjs` | `VULSEEK_SCAN_JOB_ID` / `TASK_ID` / `STAGE_NAME` | ACP |
| `protocol.mjs` | ordered append to task stdout JSONL | snapshot files |
| `activity.mjs` | map normalizer events → UI activity; debounce snapshots | Goal completion |
| `fs-sandbox.mjs` | path allow-list + `/task` symlink | Docker |
| `permission.mjs` | always-allow ACP permission | |
| `timeout.mjs` | idle timer vs ACP traffic | Goal wait |
| `capabilities.mjs` | Goal v1 `_meta` and Grok `availableCommands` | prompt text |
| `grok-wire.mjs` | vendor method rewrite + stdout Transform | Goal prompt |
| `goal-prompt.mjs` | `/goal` prefix, preserve, follow-up parts | ACP RPC |
| entry | process lifecycle | vendor JSON shape |

`grok-wire.mjs` must remain the only place that knows `_x.ai/session_notification`
and `goal_updated`. `goal-prompt.mjs` must remain the only place that decides
whether to send `/goal`.

## Docker and tools-image hash

1. Change `Dockerfile.scan-tools` to `COPY acp-driver/ /opt/vulseek-acp/acp-driver/`
   plus the entry `vulseek-acp-driver.mjs`, still next to `agent-events.mjs`.
   Relative imports from the entry must resolve at `/opt/vulseek-acp/`.
   Prefer putting **entry + modules in one directory**:

   ```text
   /opt/vulseek-acp/
     vulseek-acp-driver.mjs
     acp-driver/*.mjs
     agent-events.mjs
   ```

   Entry imports `./acp-driver/grok-wire.mjs` etc.

2. `executeCheckoutToolsBuild` copies the whole `acp-driver/` tree into the
   temp build context, not a single file.

3. `computeCheckoutToolsVersion` hashes concatenation (or a stable sorted
   join) of every driver `.mjs` plus the existing dockerfile, patch, and
   `agent-events`. Changing any module must bump `vulseek-scan-tools-dev:<hash>`.

4. Image smoke: `node --check` entry + each module, or `node --check` entry
   only if it statically imports all modules.

## Tests

Keep process-level tests for:

- session create + snapshots
- persistent queued tasks
- Goal complete / missing Goal / Goal v1 missing
- Grok slash-command Goal without Goal v1 ad
- Grok vendor rewrite does not cancel the prompt
- idle timeout vs ACP traffic
- invalid JSONL

Move to imported unit tests (no spawn) for:

- `rewriteGrokAcpMessage` / `createGrokAcpStdoutFilter`
- `hasGoalCapability` / `hasGrokGoalCommand`
- `resolveGoalPromptParts` / `prefixNativeGoal`

Extract shared spawn helpers so each integration test is input + fake adapter
behavior + assertions, not a 80-line adapter script.

Optional later: split `vulseek-acp-driver.test.mjs` into
`acp-driver/__test__/*.test.mjs` and run
`node --test packages/server/src/services/dockerfiles/**/*.test.mjs`.

## Implementation order

1. Add `acp-driver/util.mjs` and `grok-wire.mjs`. Entry imports them. No Docker
   change yet if files sit next to the entry via relative `./acp-driver/...`.
   Run the existing driver test file.
2. Extract `identity`, `protocol`, `activity`, `fs-sandbox`, `permission`,
   `timeout`, `capabilities`, `goal-prompt`. Entry shrinks toward `run()`.
3. Point Dockerfile + checkout-tools copy/hash at the directory. Rebuild is
   required for any running scan-tools image.
4. Extract test helpers; add direct unit tests for grok-wire and goal-prompt.
5. Optionally split the giant integration test file.

After each step: `node --test` the driver tests. Do not rebuild scan-tools
until step 3 unless a live Job must pick up the split (bind-mount does not
apply inside the tools image).

## Non-goals

- Rewriting Goal settlement or TaskOutput submit protocol.
- Converting the driver to TypeScript.
- Splitting `run-single-turn-agent.ts` or `generic-agent.stage.ts`.
- Inlining `agent-events.mjs`.
- Changing `/opt/vulseek-acp/vulseek-acp-driver.mjs` as the container command.

## Risks

- Forgetting a sibling `.mjs` in the tools hash leaves Jobs on a stale image
  that cannot `import` new files.
- Tests that `path.resolve` a single driver file keep working only if the
  entry remains at that path and Node can resolve `./acp-driver/` from cwd of
  the test (it resolves relative to the entry file, which is correct).
- `node --check` on the entry does not execute imports in all Node versions
  the same way; prefer also checking each module file.
