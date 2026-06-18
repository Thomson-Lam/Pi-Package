# review (pi-review-artifact)

Generates predictable, styled, self-contained HTML code-review artifacts from compact agent-authored JSON plus authoritative local git metadata/diffs. Currently only supports `npm`.

## Requirements

- Pi coding agent
- npm
- a Git tracked repository to review

## What this extension provides

- Pi extension entrypoint: `index.ts` registers `/pr`
- CLI: `dist/bin/pi-review-artifact.js` (built from `bin/` + `src/`)
- Default artifact template: `chapters`
- Tiered workflow: low/ultralow render compact stdin JSON directly; medium/high scaffold a TODO draft that the agent fills before render. Render validates and writes HTML.
- Cheap development fixture workflow: `/pr-dev` and CLI `dev-render` render static dummy JSON + dummy GitSnapshot fixtures through the real HTML renderer without invoking the agent.

## Workflow

After changes, run `/pr` to open a guided modal wizard. The first menu lets you choose the current Pi cwd, another path, or Help. The wizard then asks for diff mode, detail tier, output location, open behavior, and optional review emphasis. Help is rendered in the UI without adding text to the session.

For dummy fixture rendering, run `/pr-dev` to open a guided fixture wizard. The first menu lets you choose the current Pi cwd, another path, or Help. Neither `/pr` nor `/pr-dev` parses configuration flags from the chat bar anymore; configuration is centralized in the modal flow.

Default wizard choices start from the current Pi cwd, medium detail, repo-root output, and opening artifacts in interactive mode. Base-ref reviews default the base ref input to `HEAD`.

Detail tiers are validation profiles when `/pr` or CLI `validate/render --detail ...` is used:

- `ultralow` — fastest compact handoff: one broad grouping, minimal fields, and raw diffs omitted from the rendered artifact.
- `low` — compact internal handoff: 1–3 broad chapters, each file has a purpose, and validation run(s) or missingValidation note(s) are present.
- `medium` — default shareable artifact: explicit chapters, all changed files assigned, chapter intent/reviewFocus, file purposes, validation, and missingValidation fields.
- `high` — rigorous review: every changed file assigned exactly once, per-file reviewFocus, chapter risks/validation, top-level risks, decisions, limitations, and validation evidence. Behavior flow is warned when absent because it is only applicable to behavior-changing work.

Artifacts are written under `html-reviews/` in the target git root by default. Choose `localpi` in the `/pr` wizard or use CLI `render --out localpi` to write to `.pi/reviews/` under the target git root. Choose `global` in the wizard or use CLI `render --out global` to write to `~/.pi/agent/reviews/<project-slug>/`, where `<project-slug>` is derived from the Pi agent cwd basename (or `--project-cwd` for direct CLI use). Rendered HTML filenames use the slugged report title as `<subject>.html`, with spaces and non-alphanumeric symbols converted to hyphens. CLI `render --output <file>` overrides `--out`.

## Fresh clone setup

From this package root, compile the JS output that the command prompt will invoke from `dist/`:

```bash
npm install
npm run build
```

Then in Pi:

1. Run `/reload` so Pi reloads extensions.
2. Invoke `/pr` and choose Help to see the modal manual, or choose a target to start the review wizard.

## Quick CLI checks

```bash
node dist/bin/pi-review-artifact.js schema --json
node dist/bin/pi-review-artifact.js guide --template chapters
node dist/bin/pi-review-artifact.js example --template chapters > /tmp/review-example.json
node dist/bin/pi-review-artifact.js validate --input /tmp/review-example.json
node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
node dist/bin/pi-review-artifact.js --help
node dist/bin/pi-review-artifact.js scaffold --template chapters --cwd . --mode worktree --include-untracked --detail ultralow --output /tmp/review-ultralow.json
node dist/bin/pi-review-artifact.js scaffold --template chapters --cwd . --mode worktree --include-untracked --detail medium --output /tmp/review-scaffold.json
node dist/bin/pi-review-artifact.js validate --input /tmp/review-scaffold.json --template chapters --cwd . --mode worktree --include-untracked --detail medium # expected to fail until TODO_REPLACE placeholders are filled
node dist/bin/pi-review-artifact.js render --input /tmp/review-example.json --template chapters --mode worktree --include-untracked --out repo --no-open
```

Notes:
- `scaffold` and `render` require a git repo with changes (or explicit `--cwd <repo>`).
- `dev-render` does not require a git repo with changes; it uses static dummy fixtures under `fixtures/dev/`.
- `--mode baseRef` requires `--base <ref>`.
- The only supported template is `chapters`; the legacy sections layout has been removed.

## Typical usage flow

1. `/pr` injects a prompt with exact commands for the requested detail tier.
2. For low/ultralow, the agent inspects git diffs, writes compact JSON in a `render --stdin` here-doc, and renders in one step.
3. For medium/high, the agent runs `scaffold`, creating a JSON draft with all changed file paths, then replaces all `TODO_REPLACE` placeholders.
4. `render` validates schema, rejects unresolved placeholders, enforces the requested detail profile against the current diff, reads git metadata/diffs, and renders HTML with a Review rigor checklist.
5. CLI writes a stable `Artifact: <path> (<n> files)` line.

## Development

```bash
npm run typecheck
npm run build
node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
```

Use `/pr-dev` from Pi after `/reload` to render the same dummy artifacts without invoking the agent.
