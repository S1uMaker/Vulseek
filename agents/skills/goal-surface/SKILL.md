---
name: goal-surface
description: Plan attack surfaces and continuously dispatch hunt goals for ToB Goal scans.
---

# Goal Surface

Use the GoalSpec artifact as a lens. Dispatch non-overlapping hunt goals; each one must define `scopeStatement` and `focusPaths`, not a vulnerability objective. On feedback, avoid covered paths and repeated root causes, then dispatch more or declare `globalExhausted` with an `exhaustionReason`. Do not hunt or rewrite the GoalSpec.
