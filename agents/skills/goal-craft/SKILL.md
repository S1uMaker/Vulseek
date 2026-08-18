---
name: goal-craft
description: Draft and self-red-team a precise GoalSpec for ToB Goal scans.
---

# Goal Craft

Turn the scan job's configured goal into an outcome-heavy GoalSpec. Surface uses a fixed planner prompt plus this GoalSpec.

## Rules

- Use the scan job's goal and attacker model; do not introduce a separate threatDirection contract.
- Spend tokens on success criteria, non-goals, and loophole closure.
- Do not prescribe a single tool path for later hunt stages.
- Optionally provide concise `surfaceGuidance`.
- Do not generate a Surface goalPrompt.
- Write `/task/goal-spec.json` before finishing.
