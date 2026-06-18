# Dev render fixtures

These fixtures support the cheap development workflow for the review HTML renderer.

Use them with the dedicated CLI command:

```bash
node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
```

Or from Pi after reloading the extension:

```text
/pr-dev --fixture comprehensive --detail all --out localpi --no-open
```

The fixtures are intentionally synthetic. They exercise renderer and styling edge cases without invoking an agent, generating review JSON, or collecting live git metadata.

## Files

- `comprehensive.git.json` — static `GitSnapshot` with modified, added, deleted, renamed, binary, omitted-large-diff, untracked, long-path, and ungrouped-file cases.
- `comprehensive.ultralow.json` — compact report that omits raw diffs in rendered output.
- `comprehensive.low.json` — concise report with validation/missing-validation coverage.
- `comprehensive.medium.json` — realistic shareable artifact with chapters, appendices, missing-file warnings, risks, decisions, and validation.
- `comprehensive.high.json` — dense report for high-detail layout, behavior flow, per-file review focus, risks, limitations, and validation evidence.

These fixture reports should remain valid against `src/schema.ts`. They may intentionally produce renderer warnings or rigor-check failures to keep those states visible during styling and review-format development.
