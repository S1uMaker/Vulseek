---
name: delta-scope
description: Select functions affected by a target/base diff for the delta scan pipeline without making vulnerability-candidate judgments.
---

# Delta Scope

## Purpose

Identify functions that should enter downstream function scanning because they were changed by, or are directly impacted by, the prepared delta diff.

This stage is impact scoping only.

Do not produce vulnerability candidates.
Do not perform exploitability analysis.
Do not verify findings.
Do not write module artifacts.

The downstream `scan-target` stage will decide whether candidate findings exist.

## Inputs

Use the paths, commits, runtime metadata, and Zod schemas provided by the stage prompt.

Expected inputs include:

- checked-out repository at the target revision
- repository state JSON
- base commit
- target commit
- output schema

If the base commit is unavailable, use the prepared repository state's commit window context and inspect the target commit neighborhood conservatively.

## Outputs

Write exactly the artifacts required by the stage prompt:

- `/task/repository.json`
- zero or more `/task/functions/<function-id>.json`
- submit-message JSON matching `/task/output.schema.json`

The output manifest has only:

- `repository`
- `functions`

Do not include `module`, `modules`, `candidates`, or `findings` in the manifest.

When no function should be scanned, still write `/task/repository.json` and return:

```json
{ "repository": "/task/repository.json", "functions": [] }
```

## Workflow

1. Read the repository state JSON.
2. Confirm the target and base commits from the prompt and state file.
3. Inspect `git diff --name-only`, `git diff --stat`, and relevant hunks for the base-to-target range.
4. Map changed hunks to concrete functions using tree-sitter when possible, with local source inspection as a fallback.
5. Add directly impacted neighboring functions when the changed code alters dispatch, parsing, validation, state transitions, serialization, authorization, memory ownership, or error handling used by those functions.
6. Exclude pure documentation, generated output, tests, vendored code, formatting-only changes, and build metadata unless they directly change runtime security behavior.
7. Write one function artifact for each selected function.
8. Validate every artifact and the final output manifest.

## Selection Policy

Prefer recall over precision for diff impact.

Select a function when any of these are true:

- its body changed
- its signature, type, macro wrapper, callback registration, or exported symbol changed
- it calls a changed helper in the same local trust boundary
- it is called by changed dispatch, parser, authorization, deserialization, protocol, file I/O, network I/O, memory-copy, allocation, crypto, sandbox, plugin, or configuration code
- the diff changes data layout, enum values, constants, flags, validation rules, or state machine transitions that the function consumes

Do not select functions merely because they are in the same file when local inspection shows no plausible behavioral dependency.

## Function Artifacts

Each function artifact must satisfy the injected function schema.

Use stable deterministic ids. Prefer a path-plus-symbol slug when available.

Set:

- `moduleId` to `delta-scope` unless a more precise existing logical module is obvious
- `moduleName` to `Delta Scope` unless a more precise existing logical module is obvious
- `priority` lower for higher impact
- `role`, `reachability`, `priorityReason`, and `securityModelRelation` from diff-impact evidence, not from vulnerability certainty
- `excludeReason` to null for selected functions
- `likelyVulnerabilityTypes` to broad classes suggested by code role when useful, or an empty array when there is no strong signal

Use repository-relative file paths.

Do not invent line numbers. Use null if uncertain.

## Constraints

Do not use external CVE, issue, registry, GitHub, or web intelligence.

Do not run expensive builds or fuzzers.

Do not make candidate/security finding judgments.
