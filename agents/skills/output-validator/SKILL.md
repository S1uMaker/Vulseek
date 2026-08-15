---
name: output-validator
description: Validate the current task output envelope and referenced JSON artifacts.
---

# Output Validator

Use this skill after writing `/task/output.json` and every referenced artifact.

1. Read `/task/output.schema.json` before constructing the final output.
2. Write the complete envelope to `/task/output.json`.
3. Run:

```bash
python "$VULSEEK_AGENT_HOME/skills/output-validator/validate_output.py" \
  --schema /task/output.schema.json \
  --output /task/output.json
```

The command validates the envelope and the artifact files described by
`x-vulseek-artifacts`. If it fails, fix the files and run it again. Do not end
the turn until it exits successfully.
