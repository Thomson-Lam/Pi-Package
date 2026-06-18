# Dev render fixtures

These fixtures support the cheap development workflow for the codebase-review HTML renderer.

Use them with:

```bash
node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
```

Or from Pi after reloading the extension:

```text
/pr-dev
```

The fixtures are synthetic. They exercise renderer and styling edge cases without invoking an agent, generating review JSON, collecting live git patches, or rendering raw diffs.

## Files

- `comprehensive.git.json` — static `GitSnapshot` metadata with modified, added, deleted, renamed, generated, and untracked cases. It intentionally excludes patch text.
- `comprehensive.ultralow.json` — compact status/file-map fixture with a small snippet reference.
- `comprehensive.low.json` — concise artifact with file map, building block, workflow, snippets, and validation.
- `comprehensive.medium.json` — shareable artifact with building blocks, workflow, data flow, review focus, risks, decisions, validation, and snippets.
- `comprehensive.high.json` — dense artifact for high-detail layout, multiple workflows, risks, decisions, limitations, and snippet-budget coverage.

Fixture reports should remain valid against `src/schema.ts`. Snippets point at real files in this package and are resolved by the production renderer at dev-render time.
