# review extension index

Description: Navigation index for the Pi review-artifact extension package.
Purpose: Help contributors locate extension wiring, CLI implementation, scaffold workflow, codebase-review rendering, snippet resolution, and dev fixtures quickly.

Components:
- `index.ts` — Pi extension entrypoint; registers `/pr` guided workflow and `/pr-dev` dummy fixture rendering. `/pr` keeps the modal UX, then sends an agent prompt that asks for compact codebase-review JSON with snippet line ranges and no raw diffs.
- `bin/pi-review-artifact.ts` — CLI entrypoint implementing `--help`, `guide`, `example`, `schema`, `dev-render`, `scaffold`, `validate`, and `render`; validation rejects unresolved `TODO_REPLACE` placeholders and enforces requested detail profiles.
- `src/schema.ts` — Strict Zod v4 codebase-review schema (`schemaVersion: "2.0"`), including status, fileMap, buildingBlocks, workflows, dataFlows, snippets, reviewFocus, risks, decisions, and validation.
- `src/detail.ts` — Detail-tier profile analysis for changed-file coverage, snippet budgets, structure requirements, validation, and high-detail focus/risk/decision coverage.
- `src/snippets.ts` — Resolves snippet references from local files or git blobs using path + line ranges.
- `src/git.ts` — Git metadata collection, totals, diff modes, and untracked file metadata. Raw patches are not collected or rendered.
- `src/fixtures.ts` — Dev fixture loader for static dummy review JSON and dummy GitSnapshot metadata.
- `src/render.ts` — Render orchestration for the `codebase` template.
- `src/templates/codebase.ts` — Codebase-review layout: current status, file map, building blocks, workflows, data-flow arrows, review focus, snippets, validation, and appendices.
- `src/templates/base.ts` — Base HTML shell.
- `src/templates/styles.ts` and `src/templates/style-modules/` — Importable CSS string modules for tokens, base layout, components, and code snippets.
- `src/templates/components.ts` — Escaping, badges, lists, and safe JSON/script helper.
- `src/open.ts` — Platform-specific artifact open helper.
- `fixtures/dev/` — Static comprehensive dummy reports plus GitSnapshot metadata for low-cost renderer development.
- `package.json` — Pi package manifest (`pi.extensions` only), scripts, and runtime deps.
- `tsconfig.json` — TypeScript build config targeting `dist/`.

Tests:
- No dedicated automated test suite yet.
- Manual smoke checks use:
  - `node dist/bin/pi-review-artifact.js --help`
  - `node dist/bin/pi-review-artifact.js guide --template codebase`
  - `node dist/bin/pi-review-artifact.js example --template codebase > /tmp/review-example.json`
  - `node dist/bin/pi-review-artifact.js validate --input /tmp/review-example.json --detail medium`
  - `node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open`
  - `node dist/bin/pi-review-artifact.js scaffold --template codebase --cwd . --mode worktree --include-untracked --detail medium --output /tmp/review-scaffold.json`

Related files:
- `README.md` — Setup, `/pr` usage, detail tiers, snippet-reference workflow, and CLI smoke commands.
- `docs/development.md` — Fixture-based development workflow for styling/layout/format changes without agent token cost.
