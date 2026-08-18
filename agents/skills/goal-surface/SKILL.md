---
name: goal-surface
description: Plan attack surfaces and continuously dispatch hunt goals for ToB Goal scans.
---

# Goal Surface

Read `/task/inputs/goal-spec.json` and partition the repository into non-overlapping vulnerability attack surfaces. Dispatch hunt goals; each one must define `scopeStatement`, `focusPaths`, and a per-surface `goalPrompt` for Hunt.

Read and write `/lane/surface-coverage.json`. On feedback, close the judged hunt with a lesson from the verdict, then choose one new unused surface yourself. Do not wait for Judge to name the next direction. Do not declare global exhaustion. Do not hunt, spawn subagents, or rewrite the GoalSpec.
