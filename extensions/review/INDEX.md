# review extension index

Description: Navigation index for the Pi review-artifact extension package.
Purpose: Help contributors locate extension wiring, CLI implementation, scaffold workflow, and chapters artifact rendering quickly.

Components:
- `index.ts` — Pi extension entrypoint; registers `/pr`, `/pr --help`, path/`--cwd` targeting, `--detail ultralow|low|medium|high`, `--out repo|localpi|global`, `--prompt <instructions>` user review emphasis, low/ultralow direct-stdin render prompts, medium/high scaffold-then-render prompts, and `/pr-dev` dummy fixture rendering without invoking the agent.
- `bin/pi-review-artifact.ts` — CLI entrypoint implementing top-level `--help`, `guide`, `example`, `schema`, `dev-render`, `scaffold`, `validate`, and `render` commands; validation rejects unresolved `TODO_REPLACE` placeholders and enforces requested detail profiles.
- `src/detail.ts` — Detail-tier profile analysis for low/medium/high structural and diff-aware validation plus renderer checklist data.
- `src/schema.ts` — Strict Zod v4 report schema, including optional `reviewDetail` and `chapters`, and JSON Schema export.
- `src/git.ts` — Git metadata/diff collection, totals, diff modes, and untracked synthetic diff handling.
- `src/fixtures.ts` — Dev fixture loader for static dummy review JSON and dummy GitSnapshot data used by CLI `dev-render` and `/pr-dev`.
- `src/render.ts` — Render orchestration for the `chapters` template.
- `src/templates/chapters.ts` — Reviewer-first chapters layout, detail badge, Review rigor checklist, validation section, appendices, scoped diffs, and ultralow no-raw-diff rendering.
- `src/templates/base.ts` — Base HTML shell.
- `src/templates/styles.ts` — Self-contained inline artifact CSS.
- `src/templates/components.ts` — Escaping, badges, diff rendering, and safe JSON/script helper.
- `src/open.ts` — Platform-specific artifact open helper.
- `docs/token-estimate.md` — Token-efficiency estimates and tier tradeoffs for JSON-to-CLI rendering versus agent-authored HTML.
- `docs/styling.md` — Cheap fixture-based styling, responsiveness, and review-format development workflow.
- `fixtures/dev/` — Static comprehensive dummy reports plus GitSnapshot fixture for low-cost renderer development.
- `package.json` — Pi package manifest (`pi.extensions` only), scripts, and runtime deps.
- `tsconfig.json` — TypeScript build config targeting `dist/`.

Tests:
- No dedicated automated test suite yet.
- Manual smoke checks use:
  - `node dist/bin/pi-review-artifact.js --help`
  - `node dist/bin/pi-review-artifact.js guide --template chapters`
  - `node dist/bin/pi-review-artifact.js example --template chapters > /tmp/review-example.json`
  - `node dist/bin/pi-review-artifact.js validate --input /tmp/review-example.json`
  - `node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open`
  - `node dist/bin/pi-review-artifact.js scaffold --template chapters --cwd . --mode worktree --include-untracked --detail medium --output /tmp/review-scaffold.json`
  - `node dist/bin/pi-review-artifact.js validate --input /tmp/review-scaffold.json --template chapters --cwd . --mode worktree --include-untracked --detail medium` (expected failure until placeholders are filled)
  - `node dist/bin/pi-review-artifact.js render --input /tmp/review-example.json --template chapters --mode worktree --include-untracked --out repo --no-open`

Related files:
- `README.md` — Setup, `/pr` usage, detail tiers, tiered workflow, and CLI smoke commands.
- `docs/token-estimate.md` — Token efficiency and workflow tradeoff notes.
- `docs/styling.md` — Fixture-based dev-render workflow for styling/layout/format changes without agent token cost.
