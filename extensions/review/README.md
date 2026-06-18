# review (pi-review-artifact)

Generates predictable, styled, self-contained HTML codebase-review artifacts from compact agent-authored JSON, local git metadata, and curated snippet line ranges. Raw diffs are intentionally omitted; GitHub remains the diff viewer.

## Requirements

- Pi coding agent
- npm
- a Git tracked repository to review

## What this extension provides

- Pi extension entrypoint: `index.ts` registers `/pr` and `/pr-dev`
- CLI: `dist/bin/pi-review-artifact.js` built from `bin/` + `src/`
- Default artifact template: `codebase`
- Tiered workflow: low/ultralow render compact stdin JSON directly; medium/high scaffold a TODO draft that the agent fills before render
- Snippet references: JSON includes only `path`, `startLine`, and `endLine`; the CLI resolves code locally at render time
- Cheap development fixture workflow: `/pr-dev` and CLI `dev-render` render static dummy JSON + dummy GitSnapshot fixtures through the real HTML renderer without invoking the agent

## Workflow

Run `/pr` to open a guided modal wizard. The first menu lets you choose the current Pi cwd, another path, or Help. The wizard then asks for diff mode, detail tier, output location, open behavior, and optional review emphasis.

The generated agent prompt asks the agent to explain the current codebase state, file responsibilities, building blocks, workflows, data flows, risks, validation, and focused code snippets. The JSON must not contain raw diffs, HTML, Mermaid, or inline copied code.

Detail tiers:

- `ultralow` — current status, concise file map, optional workflow/block, 0–3 snippet ranges.
- `low` — compact file map, at least one workflow/block/data flow, 1–6 snippet ranges, validation or missingValidation.
- `medium` — full changed-file map, important adjacent files, building blocks, workflow/data flow, review focus, 2–12 snippet ranges.
- `high` — rigorous codebase map with broader context, multiple focus/risk/decision sections, 4–25 snippet ranges, limitations, and validation evidence.

Artifacts are written under `html-reviews/` in the target git root by default. Choose `localpi` to write to `.pi/reviews/`, or `global` to write to `~/.pi/agent/reviews/<project-slug>/`. Rendered filenames use the slugged report title.

## Fresh clone setup

```bash
npm install
npm run build
```

Then in Pi:

1. Run `/reload` so Pi reloads extensions.
2. Invoke `/pr` and choose Help, or choose a target to start the review wizard.

## Quick CLI checks

```bash
node dist/bin/pi-review-artifact.js schema --json
node dist/bin/pi-review-artifact.js guide --template codebase
node dist/bin/pi-review-artifact.js example --template codebase > /tmp/review-example.json
node dist/bin/pi-review-artifact.js validate --input /tmp/review-example.json --detail medium
node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
node dist/bin/pi-review-artifact.js --help
node dist/bin/pi-review-artifact.js scaffold --template codebase --cwd . --mode worktree --include-untracked --detail medium --output /tmp/review-scaffold.json
node dist/bin/pi-review-artifact.js validate --input /tmp/review-scaffold.json --template codebase --cwd . --mode worktree --include-untracked --detail medium # expected to fail until TODO_REPLACE placeholders are filled
```

Notes:
- `scaffold` and `render` require a git repo with changes, unless using `dev-render`.
- `dev-render` uses static dummy fixtures under `fixtures/dev/`.
- `--mode baseRef` requires `--base <ref>`.
- The only supported template is `codebase`; the legacy diff-review layout has been removed.

## Development

```bash
npm run typecheck
npm run build
node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
```

Use `/pr-dev` from Pi after `/reload` to render the same dummy artifacts without invoking the agent.
