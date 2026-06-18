# Token-efficiency notes

The current review artifact format saves tokens by asking the agent for compact structured JSON plus snippet references, not inline HTML, copied code, or raw diffs.

## Why snippet references help

The agent writes:

```json
{ "id": "prompt-builder", "path": "index.ts", "startLine": 120, "endLine": 160, "caption": "Builds the review prompt." }
```

The CLI reads those lines from disk at render time. This avoids spending model output tokens duplicating source code into JSON while still letting the final HTML show the relevant code.

The agent still spends tokens reading enough code to understand the change, but it avoids a second expensive copy of that code in its final report.

## Relative costs

| Approach | Expected token pressure |
| --- | --- |
| Agent-authored full HTML | high |
| Agent-authored JSON with inline code | medium/high |
| Agent-authored JSON with snippet line ranges | low/medium |
| Raw diffs embedded in the artifact | very high and redundant with GitHub |

## Detail-tier budgets

- `ultralow`: 0–3 snippets, about 80 snippet lines maximum.
- `low`: 1–6 snippets, about 180 snippet lines maximum.
- `medium`: 2–12 snippets, about 400 snippet lines maximum.
- `high`: 4–25 snippets, about 900 snippet lines maximum.

These are validation budgets for the JSON contract. They keep artifacts useful without making the agent output large code blocks.
