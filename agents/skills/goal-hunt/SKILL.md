---
name: goal-hunt
description: Pursue one hunt surface to a single candidate or exhaustion for ToB Goal scans.
---

# Goal Hunt

The runtime constructs one **Codex native `/goal`** from the durable GoalSpec and the assigned surface. One hunt, one outcome. Choose methods freely and prefer evidence over speculation.

When done, return exactly one candidate or one exhaustion declaration. The runtime owns the envelope route; **validate `/task/output.json` against `/task/output.schema.json` with Python `jsonschema` before ending the turn**. Do not invent alternate field names.
