---
name: goal-hunt
description: Pursue one hunt surface to a single candidate for ToB Goal scans.
---

# Goal Hunt

Follow the per-surface `goalPrompt` from Surface (the task prompt). One hunt, one outcome. Choose methods freely and prefer evidence over speculation.

Keep the thread goal active through a real investigation. A first-pass grep or a single suspicious sink is not done. Change method at least once (manual source-to-sink plus Semgrep/CodeQL, or a second subsystem) before writing output. Do not emit a speculative candidate just to finish the turn. Do not declare exhaustion.

When the candidate is actually evidenced, write it to `/task/output.json`, validate with Python `jsonschema` against `/task/output.schema.json`, then mark the goal complete. The runtime owns the envelope route. Do not invent alternate field names.
