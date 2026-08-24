# Research Scan 长期验证报告

## Run

- Date: 2026-07-29
- Environment: dev only
- Job: `wf23jISjp1BWn_IgMldpC`
- Target: WordPress 7.0.1
- Profile: `wordpress-gpt5x-dev-20260719`
- Result: stopped by the plan's cross-track identity safety condition

## Progress Observed

The Job successfully passed `research-scope`, `surface-map`, and `track-plan`. It then launched concurrent `vulnerability-discovery` and `track-review` tasks. The UI exposed all Research tabs, running activities, task cancellation, registry tables, filters, and pagination without console errors. The database contained 11 tracks and one Finding before cancellation.

Review artifacts and Discovery Reports were present, and task output envelopes were valid. Some active tasks wrote `output.json` with `exit: false` before receiving `end_turn`; this was logged as `running_output_without_end_turn` and did not itself stop the run.

## Hard Failure

Finding `subprocess-native:ssh2-chdir-unescaped-command` was stored with:

- `trackId`: `track-subprocess-native`
- `producerTaskId`: `d4ac96d02c5e2abb`

The producer task `d4ac96d02c5e2abb` was `Investigate track: parser-normalization`; its input and output identified `track-parser-normalization`, and its Discovery Report contained no findings. The task `d1549a2b38269750` (`Investigate track: subprocess-native`) issued the `create-finding` command for this Finding. This is a producer-task/track identity mismatch and triggered immediate cancellation.

## Cleanup

The Job was canceled through the dev UI. After the stability window:

- Job status: `canceled`
- Tasks: 16 `completed`, 16 `canceled`, no pending/starting/running tasks
- No matching Docker containers or processes
- No matching Redis keys
- Track and Finding counts stopped at 11 and 1
- Historical stdout and Discovery Report remained readable
- Artifact directory remained available for diagnosis

Release was not connected to or modified.

## Follow-up

## Second Run After Initial Fix

- Job: `hYM14mdkGD4EzTwEdTRwS`
- The run passed `research-scope`, `surface-map`, and `track-plan`, then reached concurrent Discovery, Track Review, and Finding Validation.
- The UI showed Findings and Tracks data, running activities, cancellation controls, and no observed browser errors.
- ACP/output protocol and Broker/path errors did not reappear.
- The run produced six Findings before the safety stop.

The second run exposed the deeper cause: stage containers were reused while tasks ran concurrently. `/task` is a container-level symlink, so a later task could switch the alias while an earlier agent was still running. The resulting Finding had the current stage's content but another task's `producerTaskId`, for example `outbound-destination-validation` produced by the completed `file-upload-archive-code-loading` task `da7aae2a6a8aae62`.

The Job was canceled immediately. Database verification showed one producer/track mismatch; no further tasks were allowed to run. All matching task containers were removed after cancellation, and the dev service was restarted.

## Code Changes

- Research turns receive `VULSEEK_SCAN_JOB_ID`, `VULSEEK_TASK_ID`, and
  `VULSEEK_STAGE_NAME` from the ACP Driver; the current stage input remains in
  `/task/inputs/task-input.json`.
- `research_db.py` uses the injected runtime identity and stage input, rejecting
  stale producer IDs and mismatched Finding tracks.
- Research tasks now force `reuseContainer=false` and add the task ID to the container name. Full and Delta scan reuse behavior is unchanged.
- Added Research container-isolation and Registry regression tests.

The next Research run must be created after this restart. It should verify that concurrent tasks have unique container names and that every Finding's producer task, registry track ID, and task input track key agree before allowing the run past Discovery.

## Post-Fix Run

- Job: `efoYYLcj0uIzwPc2sa_CH`
- The first attempt used the rebuilt image but exposed one remaining context bug: `resolveStageScanJob()` preferred an input `scanJob` object that omitted `scanType`. The runner therefore still treated Research as reusable during task context creation.
- The fix propagates `scanType` from the pipeline Job context into input-derived Job references. The dev image was rebuilt and restarted again.
- After recovery, concurrent Discovery and Review containers had task-specific names, for example `...-d122c3c6cf1518ef-d122c3c6cf1518ef` and `...-d4eaa600bddd9a63-d4eaa600bddd9a63`; no shared `container-0/1` names were used for newly launched non-persistent Research tasks.
- The Job reached 43 completed, 5 running, and 69 pending tasks. It produced 18 Tracks and one Finding.
- The Finding `xmlrpc-trackback-pingback-boundaries:unbounded-multicall-pingback-amplification` was produced by a `vulnerability-discovery` task whose Track matched the registry Track. Cross-Job/cross-stage producer mismatch count was `0`.
- UI checks passed for Tasks, Findings, and Tracks, including table rendering and search controls. No Broker 404/401, artifact-path validation, stale producer, or `without output.json` errors were observed after the final restart.
- The Job remains running for continued observation; it has not been canceled or modified through the release environment.

## Final Hard-Stop Run Closure

- Job `efoYYLcj0uIzwPc2sa_CH` was canceled through the dev UI after five repeated `ACP prompt completed without output.json` failures. The failures affected three separate stages and met the plan's repeated-infrastructure-error stop condition.
- Final database state was stable at 84 `completed`, 5 `failed`, and 230 `canceled` tasks. The Job contained 28 Tracks, 2 Findings, 1 Primitive, and 1 Chain; the Chain reached `incomplete` at revision 1. No Exploit or Research Report was reached before cancellation.
- A 20-second post-cancel stability window showed no task, Registry, or artifact growth. There were no matching Docker containers or Job-specific ACP processes. Redis retained only BullMQ metadata, marker, and event records; no waiting, active, delayed, or prioritized Job entries remained.
- Files navigation remained available for the canceled Job and historical task/session artifacts remained on disk after credential cleanup. The browser Monitoring view required a reload after the dev restart to refresh its WebSocket snapshot; after reload it displayed the current container count correctly.
- The initial manual cleanup found root-owned `auth.json`/`.credentials.json` files because cancellation previously removed containers but not copied credentials in the Job artifact tree. `cancelScanJob()` now records a scan image before stopping containers and uses a root helper container to delete only those two filenames below the canceled Job directory. The already-canceled Job was cleaned manually during validation; no credential files remained afterward.
- The run is intentionally not resumed. Release was not connected to, modified, or restarted.

## Remaining Limitations

- The repeated ACP failure is not resolved by the container-isolation fix: ACP reached `end_turn`/`task_done` without producing `output.json`. It remains a separate driver/agent-output protocol defect requiring a dedicated fake-adapter and single-task investigation.
- No long run reached Research Report, so the complete end-to-end acceptance path remains unverified. The hard-stop rule correctly prevented continuing after repeated infrastructure failures.

## Driver Fix and Current Run

- The ACP driver now waits a bounded 2 seconds after `end_turn` for a non-nullable `output.json`, allowing delayed atomic rename without inventing output. If the file is still absent, it emits a diagnostic `task_done` failure containing the task, stage, thread, output path, and grace period.
- Driver tests cover missing output, delayed atomic rename, nullable output, session handling, and persistent-session behavior. The full dev test suite passed with 72 files and 364 tests.
- A preliminary Job `aY_CE6WKKggR228zqWYS2` was canceled because it used the pre-fix tools image; it is not evidence against the new driver. A fresh tools image `vulseek-scan-tools-dev:0164fb4712abae34` was built before the current run.
- Current Job: `e6TdcPMofJpGUYRm445RP`, dev only, WordPress 7.0.1. It passed `research-scope`, `surface-map`, and `track-plan`; all three completed without output-protocol, Broker, artifact-path, or Registry errors.
- The current run reached concurrent Discovery and Track Review. At the latest observation it had four completed Discovery tasks, two completed Track Reviews, three active Tracks and six queued Tracks. A Track Review returned `new-surface`, which correctly launched another Surface Map and Track Plan cycle. The database contained no Finding, Primitive, or Chain yet, and no task was failed.
- UI checks on the live Job passed for Overview, Tasks, Findings, Tracks, Primitives, Chains, and the Research stage list. Tracks showed 9 rows with 1 active and 8 queued before the feedback cycle; Tasks showed the running Research stages and finished-task sections.
- The current Job remains intentionally running for continued observation. The full acceptance path through Research Report is still not proven; no release service or database was connected to or modified.

## Current Run Progress Update

- The same Job later reached 18 Tracks and produced its first valid Finding: `multisite-tenant-isolation:activation-key-not-bound-to-network`, status `discovered`, confidence `0.877`. The Finding UI and database agree on the Track, class, location, status, and timestamp.
- Track Review routes observed so far include `blocked`, `continue`, `exhausted`, and `new-surface`; the route values are persisted on completed tasks and the UI continues to refresh the Registry list.
- Current stage counts include 11 completed Discovery tasks, 6 completed Track Reviews, 2 running Discovery tasks, and 1 running Track Review. No failed tasks were observed at this checkpoint.
- Monitoring initially displayed zero while its first WebSocket reconciliation was pending; after the first sampling interval it reported 4 running containers, non-zero token throughput, CPU, and memory. This is a delayed initial sample, not a persistent data mismatch.
- Resource checks remain below the configured hard stops at this checkpoint: the largest observed agent-home was about 22 MiB, below the 25 MiB p95 threshold, and the Job artifact tree was about 363 MiB across 53 tasks.
- The run subsequently reached `finding-validation` and `finding-review`. The Finding became `validated` and one Primitive became `confirmed`; at the latest checkpoint there were 21 Tracks, one validated Finding, one confirmed Primitive, and no Chain yet. There were still no failed tasks or hard-error log entries.
- The artifact tree grew to about 752 MiB across 52 agent-home directories. The measured agent-home p95 was about 22.1 MiB and the maximum about 22.4 MiB, remaining below the configured 25 MiB threshold.
- Browser checks also passed after the Finding was validated: Findings search for `activation-key` returned the single expected row with status `Validated`; Tracks search for `xmlrpc` returned two matching rows; Primitives and Chains showed explicit empty states rather than loading errors; Files loaded the job context browser; and Tasks showed the active Finding Validation task.
- After a further observation window, the Job remained failure-free and continued the local review loop: 24 Discovery tasks, 15 Track Reviews, 3 Finding Validations, and 2 Finding Reviews completed. The Finding moved to `needs-more-evidence`, one additional Finding Review was starting, and the Primitive remained `confirmed`. This is meaningful route-driven progress, not an idle runtime; Chain Synthesis had not yet been reached.
- Artifact audit at the same checkpoint found 61 completed tasks and 61 corresponding non-empty `output.json` files; all 64 discovered output files parsed as valid JSON. The review artifact count was 16, and no task error message or recent dev log contained the known missing-output, artifact-path, Broker, Registry, cross-Track, or credential error signatures.
- The Job continued for another observation window without failures. It now has 21 Tracks, two Findings (`needs-more-evidence`), one confirmed Primitive, 28 completed Discovery tasks, 18 completed Track Reviews, and an active Finding Review. The first Finding's repeated route is explicit `needs-more-evidence`; no Chain Synthesis task has been created yet, so the plan records this as a live evidence loop rather than claiming Chain/Report coverage.
- From the authenticated dev browser, ten sequential requests per endpoint all returned successfully. Measured p95 latency was: `jobOverview` 126 ms, `jobRunningTasks` 54 ms, `jobQueueCounts` 20 ms, `terminalTasks` 15 ms, `researchTracks` 17 ms, `researchFindings` 24 ms, `exploitPrimitives` 14 ms, and `exploitChains` 14 ms; all are below the 500 ms target.
- A direct DB consistency audit found three Findings and zero mismatches across Finding ID prefix, producer task `input.track.trackKey`, `research_tracks.trackKey`, and `research_findings.trackId`. No cross-Track or cross-Job Finding relation was observed.
- Cleanup audit found one root-owned credential left by the earlier pre-fix Job `aY_CE6WKKggR228zqWYS2`; it had no containers but retained one `auth.json`. The file was removed with a dev-only root helper container. The previously cleaned Job `efoYYLcj0uIzwPc2sa_CH` and the active Job have no comparable cleanup error signature; release was untouched.
- The long-running Job later reached 26 Tracks and 38 completed Discovery tasks while remaining at zero failed tasks. It continues to schedule Track Review and Discovery work, with the active feedback frontier moving from the first Finding toward the `cron-callback-argument-integrity` track. No Chain task has appeared yet, and no hard-stop condition has been met.

## Current Post-Fix Validation Run

- Job `2xEjotxrFnJqNVR1NNU5d` was started in dev only after rebuilding `vulseek-dev:latest` and restarting the dev service. The service health endpoint returned `{"ok":true}` and the browser showed the Research Scan success notification.
- At the latest checkpoint, `research-scope`, `surface-map`, and two `track-plan` tasks completed; six Discovery tasks and four Track Reviews completed; two Discovery/Review tasks were active; and the frontier had expanded through `new-surface` feedback. The database contained two active Tracks and eight queued Tracks at one checkpoint, with no failed tasks.
- The new run uses task-specific non-persistent containers. Its task artifacts show complete `output.json` envelopes and no `ACP prompt completed without required output.json`, Broker 404/401, Registry identity, or artifact-path errors. It has not yet reached Finding Validation in this run, so the updated validation artifact path must remain under observation.
- A prior hard-stop run exposed a separate validation artifact defect: Finding/Exploit Validation output declared a path but did not create the corresponding file. The pipeline now persists the complete `$output` into `inputs/finding-validation.json` and `inputs/exploit-validation.json`; the validation schemas and prompts no longer accept or request `validationPath`. The deterministic fixture asserts the generated artifact content and destination.
- Cancellation cleanup was corrected to use the configured host scan-context path when invoking the root helper container. The previous implementation could pass the dev container's `/scan-context/...` path to the Docker daemon, which is not a host bind source. It now builds the host profile path from `VULSEEK_SCAN_CONTEXT_HOST_PATH` and uses the current tools image definition as an image fallback when task containers have already disappeared.
- Verification after the correction: full Vulseek suite `72 files / 364 tests` passed; ACP driver tests `7/7` passed; deterministic Research fixture `1/1` passed; server typecheck passed; and `git diff --check` passed. The earlier contract fixture failure caused by obsolete `validationPath` fields was fixed and the contract test now passes `12/12`.
- The new Job remains intentionally running for continued observation. No release service, release database, release image, or release filesystem was connected to or modified.

## Post-Fix Run Hard Stop

- Job `2xEjotxrFnJqNVR1NNU5d` was canceled after the first new ACP output-protocol failure. Before cancellation it had completed Scope, Surface Map, multiple Track Plans, six Discovery tasks, four Track Reviews, and produced one Finding; no validation artifact dispatch was attempted yet.
- Failed task `d200993a1af69608` (`vulnerability-discovery`, `Investigate track: auth-session-boundaries`) reached ACP `end_turn` and `task_done` with `status=completed`, but did not create `/task/output.json`. The driver waited its configured grace period, emitted the structured diagnostic with task/stage/thread/container/stdout state, and marked the pipeline task failed. No invented business output or downstream task was created.
- The task stdout shows the agent performed extensive analysis and attempted writes under `/task`, but the required envelope was still absent at completion. This is an agent output-protocol compliance failure and triggers the plan's hard-stop rule; it is distinct from the previously fixed validation artifact-path issue.
- Cancellation returned `stoppedRuntimes=1`, `stoppedContainers=25`, and `clearedTasks=22`. Final DB state was `20 completed`, `1 failed`, and `22 canceled`; the Job was `canceled`. No matching Docker containers remained, and a host scan-context audit found zero `auth.json` or `.credentials.json` files under the Job directory, confirming the corrected host-path cleanup worked.
- Because the hard stop occurred before Finding Validation, this run does not prove the new validation artifact flow end-to-end. It does prove the new cancellation cleanup behavior and that missing ACP output is now detected deterministically instead of silently producing invalid downstream work.

## Follow-up After Final-Instruction Fix

- The structured-output prompt now places a final three-step checklist after the full JSON Schema block: write the complete envelope to `output.json`, reopen and validate it, and only then end the turn. This targets the observed long-context failure where the agent stopped after analysis without executing the earlier instructions.
- The prompt test now asserts that this checklist is the final instruction. Full Vulseek tests again passed `72 files / 364 tests`; ACP driver tests passed `7/7`; server typecheck and `git diff --check` passed.
- Dev was rebuilt and restarted. A second follow-up Research Job `nddRhEeW94OlfcZp-uWYz` was created through the UI. Scope, Surface Map, Track Plan, and Discovery progressed normally. At the latest checkpoint it had `15 completed`, `4 running`, and `8 pending` tasks, with zero failed tasks.
- Seven Discovery tasks have completed with valid `output.json` envelopes and corresponding `discovery-report.json` artifacts. Their reports include Finding paths where applicable; no `ACP prompt completed without required output.json`, Broker, artifact-path, credential, or cross-Track error was observed in the dev logs.
- Track Review has completed four tasks and is continuing through `blocked`, `continue`, and `new-surface` routes. The Job has not yet produced a persisted Finding or reached Finding Validation, so the validation artifact flow remains unverified by this live run; the deterministic fixture covers it separately.
- The follow-up Job remains running in dev for continued observation. It has not been canceled, and no release environment was touched.

## Follow-up Hard Stop After Final Checklist

- Job `nddRhEeW94OlfcZp-uWYz` was canceled after a new missing-output failure. Before cancellation it completed Scope, Surface Map, multiple Track Plans, 7 Discovery tasks, and 4 Track Reviews; it had expanded the research frontier through `blocked`, `continue`, and `new-surface` routes.
- Task `d56a5c9ab745f7ea` (`vulnerability-discovery`, `Investigate track: parser-serialization-resource`) reached ACP `end_turn` and emitted `task_done(status=completed)`, but `/task/output.json` was still absent after the 2-second grace period. Its stdout shows the agent validated a temporary output and attempted to copy findings/report files, but never created the required task envelope. The driver emitted the full diagnostic and correctly rejected completion without inventing business output.
- This is the second independent live failure after adding the final write/reopen/validate checklist. It remains an ACP agent-output protocol failure, not a Broker, artifact-path, or container-mount failure, and meets the plan's hard-stop condition.
- Cancellation returned `stoppedRuntimes=1`, `stoppedContainers=33`, and `clearedTasks=42`. Final task state was `28 completed`, `1 failed`, and `42 canceled`; no matching Docker containers or ACP driver processes remained. A permission-tolerant host scan-context audit found zero readable `auth.json` or `.credentials.json` files under the Job directory.
- The live run did not reach Finding Validation, Chain Synthesis, Exploit Review, or Research Report. The pipeline-generated validation artifacts remain covered by the deterministic fixture and automated tests, but complete end-to-end Research Report acceptance is still unverified.
- Release was not connected to, modified, restarted, or used for validation.

## ACP Recovery Fix And Follow-up Run

- The driver previously treated a missing `output.json` as an immediate task failure after `end_turn`. The observed failure was an agent protocol omission: the agent had written and validated intermediate Discovery files, but its last tool command copied only the Finding/Report artifacts and ended the turn without writing the required envelope.
- The driver now checks that the output path contains valid JSON with the required top-level `route`, `exit`, and `output` fields. For non-nullable tasks, a missing or malformed envelope triggers at most one explicit recovery prompt in the same ACP session. The recovery prompt asks the agent to stop analysis, write the current task's envelope, reopen it, and validate it. It never synthesizes business output; a second failure still marks the task failed.
- Added ACP tests for successful recovery, delayed atomic output rename, malformed/missing output, nullable output, session handling, persistent queues, and Research database environment inheritance. The missing-output test still proves that the driver does not invent output.
- Dev was rebuilt with `vulseek-dev:latest` and a new tools image `vulseek-scan-tools-dev:eb69cf9a5df70057`; the image was inspected to confirm it contains the recovery implementation. Release images and services were not rebuilt or touched.
- Job `AGS850lX7FLAVPVbJE7Qi` was created and run in dev only after the new tools image was available. It progressed through Scope, Surface Map, Track Plan, concurrent Discovery and Track Review, Finding Validation, Finding Review, Chain Synthesis, and Chain Review.
- Live checkpoints reached 11 Tracks, 1 Finding, and 1 Primitive. Scope, Surface Map, Track Plan, Discovery, Finding Validation, Finding Review, Chain Synthesis, and Chain Review all produced valid task outputs or completed downstream dispatches. No live task emitted a recovery event, missing-output error, Broker 404/401, artifact-path validation error, credential-copy error, or cross-Track registry error.
- The Job was canceled after Chain Review to avoid unbounded dev resource use. Final DB state was `30 completed` and `28 canceled`; the Job status was `canceled`. The 27 canceled tasks retaining `downstreamDispatchStatus=pending` were not re-enqueued: Redis contained only Job metadata/event/marker keys and no waiting, active, delayed, or prioritized queue entries.
- Post-cancel verification found no matching containers, no Job-specific ACP process, and zero `auth.json`/`.credentials.json` files using a root-readable container audit. Historical output artifacts remained available for inspection.
- The live run did not reach Exploit Validation/Review or Research Report because Chain Review did not create a Chain and the run was intentionally canceled. Full end-to-end Research Report acceptance therefore remains unverified.

## Checkout Image Rebase Correction

- The `AGS850lX7FLAVPVbJE7Qi` run above was created after the new tools image was built, but its existing checkout image had not been rebuilt from that tools image. It therefore does not prove the live ACP recovery implementation or the `psycopg` dependency.
- Its Scope task exposed the consequence: the agent reported that `research-db.py` could not persist the reserved `__scope__` Track because `psycopg` was unavailable, while the task itself still completed. The run was canceled and cleaned; this is recorded as a validation gap, not a passing result.
- The WordPress 7.0.1 dev checkout was then rebuilt as `vulseek-scan-wordpress-gpt5x-mi0ga7:latest` from `vulseek-scan-tools-dev:eb69cf9a5df70057`. Direct image checks confirmed the ACP recovery code is present and `/opt/vulseek-venv/bin/python3` imports `psycopg` successfully.
- A new dev-only Job `yWD8lTP8wgqJu5RgqXvCZ` is the first valid live run on that rebased checkout image. Scope completed and created `research_tracks.trackKey=__scope__`; Surface Map and Track Plan also completed, with three Discovery tasks pending and two running at the latest checkpoint. No failed task, missing output, Broker, route, artifact, credential, or cross-Track error has been observed so far.
- This corrected run remains under observation. It has not reached the full Report path yet, and no claim of complete end-to-end Research acceptance is made until Finding/Primitive/Chain/Exploit/Report behavior and final cleanup are verified.
- Follow-up checkpoint: the rebased Job has five completed tasks (Scope, Surface Map, Track Plan, and two Discovery tasks), two running tasks, and pending Discovery/Track Review work. The database contains six Tracks including `__scope__`; all five discovered `output.json` files are valid envelopes. One completed Discovery dispatched Track Review successfully, with no failed task or hard-error signature.
- Browser verification on the rebased Job loaded the Overview graph and switched through Tasks, Findings, Tracks, Primitives, Chains, Monitoring, and Files. The Research-specific tabs rendered their expected panels while the Job was running; no console or request failure was reported by the browser check.

## Rebased Checkout Run Hard Stop

- Job `yWD8lTP8wgqJu5RgqXvCZ` used the rebuilt WordPress checkout image containing both ACP recovery code and `psycopg`. Scope persistence succeeded: `research_tracks` contained `__scope__`, and the run reached Surface Map, Track Plan, parallel Discovery, and Track Review.
- The run exposed a new identity contract failure before Finding Validation. Discovery task `dd3d7a57fbbe0ea3` received input `track.trackKey=network-site-isolation`, but its persisted output declared `trackId=network-site-isolation`; the Job Registry entity is `trackId=track-network-site-isolation`. The same mismatch was confirmed by a direct DB join, where the completed task output had no matching `research_tracks.trackId` even though its input key matched a Registry `trackKey`.
- This is the plan's cross-entity identity hard-stop condition. The Job was canceled immediately through the dev API rather than allowing Track Review or later Registry effects to consume the ambiguous identity. Final DB state was `20 completed`, `12 canceled`, and Job status `canceled`.
- Cleanup verification found no matching Docker containers, no Job-specific ACP process, and zero `auth.json`/`.credentials.json` files under the Job directory using a root-readable container audit. Redis retained only metadata/event/marker/id records; no waiting, active, delayed, or prioritized queue entries remained.
- This run proves the rebased image and Scope DB path, but Research long-run acceptance is still incomplete. The next required implementation work is to enforce one canonical Track identity between Discovery output, task input, and Registry persistence before rerunning the full validation.

## Canonical Track Identity Follow-up Run

- Job `CpkpGFnu712aAGkSIINYb` is the current dev-only validation run using the rebuilt WordPress checkout image. It passed Scope, Surface Map, and Track Plan, then created five Registry Tracks and ran five concurrent Discovery tasks.
- The server now resolves `track.trackKey` to the Registry `trackId` before writing Research task inputs. Completed Discovery inputs contain canonical values such as `trackKey=rest-admin-authz` and `trackId=track-rest-admin-authz`; every completed Discovery output matched the joined Registry row. No cross-Track identity mismatch was observed.
- The run progressed through five Track Reviews, six Finding Validations, five Finding Reviews, three Chain Synthesis completions, three Chain Reviews, and two Exploit Validations. At the latest checkpoint it had five Findings, four confirmed Primitives, and four Chains; Exploit Review was active and the feedback frontier was still advancing.
- All 368 Vulseek tests passed across 73 files, the canonical-track unit test passed 4/4, server typecheck passed, and `git diff --check` passed. The live dev browser successfully loaded Overview, Tasks, Findings, Tracks, Primitives, Chains, Monitoring, and Files. The corresponding tRPC/SSE requests returned HTTP 200 during the UI pass.
- The current run has produced no matching log signatures for missing `output.json`, Broker 404/401, artifact-path validation, credential-copy, invalid route, or cross-Track identity errors. Each completed task observed so far has a valid output envelope; no task has failed.
- The Job remains intentionally running in dev for continued observation. It has not yet reached a stable Research Report terminal state, so complete end-to-end acceptance and final no-residue cleanup remain open. Release was not connected to, modified, restarted, or used.

## Follow-up Audit Correction

- The subsequent audit canceled `CpkpGFnu712aAGkSIINYb` after incorrectly interpreting PostgreSQL UTC timestamps as local time. `2026-07-29 18:31 UTC` was `2026-07-30 02:31` in the configured Asia/Shanghai timezone, so the Job had not been idle for eight hours; its task artifacts were still changing and the pipeline was making progress.
- The cancellation did complete cleanly: the Job is `canceled`, with `63 completed` and `24 canceled` tasks, no matching containers or Job-specific ACP processes, no Redis `wait`/`active`/`delayed`/`prioritized` keys, and zero readable credential files under the Job directory. This cancellation is not evidence of a no-progress hard-stop failure.
- The report's prior progress evidence remains valid through Exploit Review, but the Research Report terminal path remains unverified. A fresh dev-only run is required for continued observation.

## Fresh Run After Audit Correction

- Job `TeObdNjwX56fXyxa2uo6-` was started from the authenticated dev UI after the previous Job was cleaned up. It initially waited for the single-instance scan worker, then entered `running` without modifying unrelated Jobs.
- The new run completed `research-scope`, persisted the reserved `__scope__` Track as `scope-TeObdNjwX56fXyxa2uo6-`, completed `surface-map`, and advanced to `track-plan`. No failure, missing-output, Broker, artifact-path, credential, or identity error has appeared at this checkpoint.
- This run remains active for continued Research observation. It is not yet evidence of Report completion; the required terminal and final cleanup checks remain open until this run is stopped or reaches a terminal state.

## Fresh Run Progress Checkpoint

- Job `TeObdNjwX56fXyxa2uo6-` completed Scope, Surface Map, Track Plan, three Discovery tasks, and one Track Review. The Track Review returned the structured `new-surface` decision, which correctly launched another Surface Map cycle rather than producing a malformed route or artifact path.
- At this checkpoint the Job had two Discovery tasks running, two pending, one Surface Map running, and no failed tasks. No Finding had been persisted yet; this is an active frontier expansion, not an idle queue.
- The dev log contained only normal `stage.running_output_without_end_turn` diagnostics with valid output envelopes, plus normal loop timing. No missing-output, Broker, artifact-path, credential, cross-Track, or identity error was observed. The Job remains active for further validation.

## Fresh Run Finding And Chain Checkpoint

- A later dev-only checkpoint for `TeObdNjwX56fXyxa2uo6-` reached `23 completed`, `6 running`, and `33 pending` tasks. The Job has two persisted Findings, one completed Finding Validation, one completed Finding Review, and one Primitive; Chain Synthesis is running.
- The browser Findings tab rendered both records, including one `Validated` Finding, and the Tracks tab rendered the expected Active/Queued rows with search, status filtering, sorting, and pagination controls. No browser request or console error was observed during this pass.
- No failed task was present at this checkpoint. The error scan still found no missing-output, Research Broker, artifact-path, credential-copy, cross-Track, or identity-mismatch signature. The run remains active for continued observation toward Chain/Exploit/Report, and final cancellation/no-residue verification is still pending.

## Fresh Run Chain Progress Checkpoint

- `TeObdNjwX56fXyxa2uo6-` continued past Finding Review: the database now contains two Findings, two Primitives, and two Chains. Both Finding Validation tasks and both Finding Review tasks are completed; one Chain Synthesis task is completed, another is running, and two Chain Review tasks are starting.
- The run currently has no failed task. Discovery and Track Review continue to expand the frontier (`12` Discovery completed, `2` running, `42` pending; `8` Track Reviews completed with one starting and three pending), so the Job is still making meaningful progress rather than being idle.
- The Chains UI loaded successfully with its search box, status filter, and pagination controls. No matching hard-stop error was observed in the current database/log checks; Exploit and Research Report remain unverified and the Job has not yet been cleaned up.

## Fresh Run Review Loop Checkpoint

- Both Chain Review tasks completed with `chain=primitive-gap`; no Exploit task was created at this point. The runtime correctly returned to Surface Map/Track Plan to seek additional evidence, with one Surface Map running and new Track Plan work pending.
- Entity state was consistent with that route: one Finding was `reviewed`, one `validated`, both Primitives were `confirmed`, and both Chains were `primitive-gap`. This is an expected adaptive loop, not a task failure or a stalled runtime by itself.
- The current log scan remained empty for missing ACP output, Broker 404/401/context errors, artifact path validation, credential copy, cross-Track identity, and task failure signatures. Exploit/Report and final cleanup remain open.

## Fresh Run Resource And Route Audit

- The active Job remains `running`. At this audit it had `112` tasks, approximately `2.44M` persisted total tokens, and `608,491,639` bytes of scan artifacts. Fifty `agent-home` directories were visible through a root-readable audit; the measured p95 was about `13.5MiB` and the maximum about `14.2MiB`, below the plan's `25MiB` hard limit. No Job-specific containers were running at the instant of the audit because the sample was between task launches.
- The persisted pipeline snapshot hash was stable within the Job (`scanPipelineDefinitionSnapshot` MD5 `305163a0832944ac057ee05768c7dbf5`; `scanPipelineSnapshot` MD5 `99914b932bd37a50b983c5e7c90ae93b5`). No runtime snapshot drift was observed.
- Completed Track Review, Finding Review, and Chain Review tasks all had non-null original routes; the sampled completed review tasks had completed dispatch and zero pending dispatch. Eleven `track-review`, two `finding-review`, and four `chain-review` review artifacts were present under task input paths, confirming pipeline-generated artifact propagation rather than LLM-generated path values.
- The browser network log showed successful HTTP 200 responses for the Job Overview and Chains API requests. The active run continues through an adaptive `primitive-gap` loop; Exploit/Report and final cleanup remain unverified.

## Fresh Run Continued Frontier Checkpoint

- After another observation interval, the Job reached `17` completed Discovery tasks, `12` completed Track Reviews, `3` completed Finding Validations, `3` completed Finding Reviews, `2` completed Chain Synthesis tasks, and `4` completed Chain Reviews. It now contains four Findings, two confirmed Primitives, and two Chains.
- Entity statuses are `2 discovered`, `1 reviewed`, and `1 validated` Finding, two `confirmed` Primitives, and two `primitive-gap` Chains. New Discovery, Track Plan, Track Review, and Chain Synthesis tasks are active, so the frontier continues to move even though Exploit has not yet been selected.
- No task failure or hard-stop signature was observed. The run remains active for continued observation; do not treat the primitive-gap route as an infrastructure failure.

## Fresh Run Dispatch Health Check

- The next checkpoint reached `19` completed Discovery tasks, `13` completed Track Reviews, `4` completed Chain Reviews, and one active Finding Validation. The Job still has four Findings, two confirmed Primitives, and two Chains; no Exploit task has been selected yet.
- There were no completed tasks with `downstreamDispatchStatus=pending`; all pending dispatch markers belonged to pending, running, or starting tasks. This distinguishes normal future work from a completed-task dispatch stall.
- No failed task or hard-stop error signature was observed. The run remains active and continues its adaptive frontier expansion.

## Fresh Run UI Monitoring Checkpoint

- The dev browser rendered the Monitoring tab with Token Throughput, CPU Usage, Memory Usage, Block I/O, and Network I/O panels. The Tasks tab rendered task links, running/finished timestamps, task names describing the actual Research work, selection checkboxes, and rerun controls.
- No browser navigation or API failure was observed during this pass. The Job remains active; no cancellation or cleanup was performed because the user requested continued observation.

## Fresh Run Primitive And Verification Checkpoint

- The active Job now has four Findings, three `confirmed` Primitives, and two `primitive-gap` Chains. Finding statuses cover `discovered`, `needs-more-evidence`, `reviewed`, and `validated`; Finding Validation, Track Review, Track Plan, and Discovery work remain active.
- No failed task or hard-stop log signature was observed. The new `needs-more-evidence` state is being handled as feedback, not treated as a runtime failure.
- Re-ran the canonical Track identity unit test: `4/4` passed. Re-ran `pnpm --filter @vulseek/server typecheck`: passed. `git diff --check`: passed. The commands emitted the repository's existing Node 20 vs local Node 24 engine warning, but no test or typecheck failure.

## Automated Regression Checkpoint

- Re-ran the complete Vulseek suite while the dev Job remained active: `73` test files and `368` tests passed. ACP recovery tests included `7` passing tests; no test failed.
- Existing Better Auth social-provider warnings, Node engine warnings, and an intentionally exercised ZIP error were emitted by the test suite but did not affect its exit status. No release process or database was involved.

## Fresh Run Review Route Audit

- The active Job reached `379` tasks, with five Findings, four Primitives, and five Chains. Discovery has `30` completed tasks; Track Review has `23`; Finding Review has `11`; Chain Review has `14`.
- Every completed Track Review, Finding Review, and Chain Review task in the current Job had a non-null persisted route, completed dispatch, and no pending dispatch. No Exploit Review task exists because all current Chains remain on the `primitive-gap` route.
- Artifact storage is approximately `1.65GB`; `127` agent-home directories were measured with p95 about `13.6MiB` and maximum about `22.1MiB`. No hard threshold was exceeded and no matching error signature appeared in the dev log.

## Fresh Run Completed-Output Audit

- Database audit found `127` completed tasks, all with non-null persisted output and completion timestamps. There were no completed tasks missing output; pending and running tasks were the only rows without persisted output.
- The scan context currently contains `129` `output.json` files, consistent with completed outputs plus output files from active tasks. No missing-output hard stop was present in this audit.

## Hard Stop: Stale Track Identity

- Job `TeObdNjwX56fXyxa2uo6-` was canceled through the dev UI after task `d805816c8fb43583` failed with `No canonical Registry trackId exists for assigned Track account-lifecycle-and-token-boundaries`.
- The task input contained `trackKey=account-lifecycle-and-token-boundaries`, while the only matching current Registry row was `trackKey=account-lifecycle-and-token-recovery`, `trackId=track-account-lifecycle-tokens`, `revision=3`. The task's output was absent because the server rejected the input before ACP execution; this was not an ACP missing-output failure.
- Timeline evidence shows the stale task was created at `19:30:05Z`, while later Track Plan iterations and Review work used `account-lifecycle-and-token-recovery`. This indicates that a queued Discovery task from an earlier Track Plan snapshot survived a later Registry rename/update. The canonical identity guard correctly stopped it, but the pipeline still needs stale queued-task reconciliation before this validation can pass.
- Before cancellation the Job had `140` completed, `1` failed, and `308` canceled tasks; it had reached seven Findings, four Primitives, and five Chains. No Broker, artifact-path, credential-copy, or cross-Job error was observed.

## Hard-Stop Cleanup Verification

- After UI cancellation, the Job became `canceled`; task count remained stable at `449` over 20 seconds, with no pending/starting/running/launched tasks. Redis had zero live wait/active/delayed/prioritized/waiting/paused keys, and there were zero matching containers or ACP processes.
- The first credential audit found `146` per-task `auth.json` files under the canceled Job's agent-home directories. These were removed from this dev-only test Job without reading their contents; a second audit found zero `auth.json` or `.credentials.json` files.
- This cleanup finding is recorded as a defect in credential artifact cleanup. The Job's historical task artifacts remain available, but no credential files remain in the test Job directory. Release was not connected to or modified.

## Post-Run Corrective Patch (Not Yet Live-Validated)

- Added canonical Track identity resolution by unique `approachFamily` when a queued task's old `trackKey` no longer exists. Exact `trackKey` remains preferred; ambiguous or missing matches still fail closed. The enriched task input is rewritten to the current canonical `trackKey` and `trackId`.
- Added regression coverage for stale-key rebinding and ambiguous/missing identity rejection; the identity test now passes `6/6`, server typecheck passes, and `git diff --check` passes.
- Hardened credential cleanup to try the host Job root first and then a root-owned container fallback, instead of silently depending on a task image. This patch has not been deployed to dev yet because restarting the shared dev service would disrupt unrelated running Delta Jobs; a fresh Research run is required before final acceptance.

## Corrective Patch Regression Check

- After the corrective patch, the complete Vulseek suite passed `73` files and `370` tests; the new stale-identity cases are included in the six passing `research-track-input` tests.
- `pnpm --filter @vulseek/server typecheck` and `git diff --check` both passed. Existing Node engine, Better Auth provider, Browserslist, and intentionally exercised ZIP warnings remain non-fatal.

## Corrective Patch Live Research Run

- Started dev-only Research Job `Xdhl0qNBa8bD731Amsqnn` through the authenticated browser UI. The initial Job remained `pending` because the single-instance scan Worker had all configured execution slots occupied by existing Delta work; after temporarily raising dev `scanJobConcurrency` from `4` to `6`, the queued Job entered `running`. The setting was restored to `4` after the test. This exposes a scheduler starvation risk: queued scan workers capture the limit when they begin waiting and do not get re-evaluated when the setting changes.
- The live run completed `research-scope`, `surface-map`, and serial `track-plan`; Track Plan persisted four ordinary Tracks plus the reserved `__scope__` Track. It then created six Discovery tasks, completed four, and reached Track Review and Finding Validation. Three Findings were persisted, with `producerTaskId` and canonical Track IDs consistent. No failed task appeared.
- Stale identity correction was live-validated: Discovery task DB snapshots retained the original `trackKey` without a `trackId`, while the actual `inputs/task-input.json` consumed by the agent contained the current canonical `trackKey` and `trackId`. Completed Discovery outputs and Finding rows used matching canonical Track IDs, and downstream Track Review tasks were created normally.
- Browser validation passed for the Research-specific Findings and Tracks tabs, including dynamic tab selection, search fields, Status filters, table rows, and the live Finding records. Monitoring and Tasks loaded without observed request or console errors. No `without output.json`, Broker 404/401/context, artifact-path, credential-copy, cross-Track, or identity-mismatch error appeared in the Job log.
- The Job was canceled from the UI after meaningful progress. Final DB state was `canceled` with `13` completed and `6` canceled tasks; after the cancellation window there were no matching containers, no matching ACP processes, and zero `auth.json`/`.credentials.json` files under the Job root. The run-specific Redis metadata keys remained, but no live scan queue entry matched the Job. Release was not connected to or modified.

## Remaining Findings

- A full terminal Research Report was not reached in this corrective run because the test was intentionally canceled after validating the repaired Discovery/Review path and cleanup behavior. Exploit/Report route behavior therefore remains covered by deterministic tests and prior historical audits, not by this live run.
- The dev scan Worker can starve newly submitted Research Jobs behind long-running Delta Jobs when the global scan concurrency is saturated. This is an operational scheduling issue separate from the Research pipeline identity fix and should be addressed before relying on long-running UI tests in a busy dev instance.
