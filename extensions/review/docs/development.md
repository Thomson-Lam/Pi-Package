# Styling and review-format development workflow

Use the dedicated fixture renderer to develop HTML styling, layout, responsiveness, and review-format changes without invoking the agent or generating fresh review JSON.

## Pi command

`/pr-dev` is for developing and fine tuning the extension; it loads dummy JSON data for debugging and for developing the HTML review without the need to spend tokens every time you make a change. It calls the same CLI used to generate HTML with the exception of loading the static JSON data which is tracked in this source code repo, instead of having the agent generate it.

Run `/pr-dev --help` inside your Pi coding agent session to pull up the manual on how to use this. The commands, flags and formats follow the same format as `/pr` but only uses the dummy JSON data from `fixtures/dev`. You can check the [fixture README](fixtures/dev/README.md)

### Setup

After `npm run build` and `/reload`, run from Pi:

```text
/pr-dev --fixture comprehensive --detail all --out localpi --no-open
```

This runs the local CLI with `pi.exec`; it does **not** call `pi.sendUserMessage`, start an agent turn, inspect real git, or spend model tokens.

## Direct CLI command

```bash
cd agent/extensions/review
npm run build
node dist/bin/pi-review-artifact.js dev-render \
  --fixture comprehensive \
  --detail all \
  --cwd . \
  --out localpi \
  --no-open
```

Single-tier render:

```bash
node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail high --cwd . --out repo --no-open
```

## What this tests

The `comprehensive` dev fixture uses static report JSON plus a static dummy `GitSnapshot`, then calls the same production chapters renderer used by real review artifacts. It is intended to cover cases that styling and format work commonly breaks:

- ultralow raw-diff omission
- low/medium/high detail density differences
- long titles, summaries, paths, commands, and table cells
- added, modified, deleted, renamed, binary, omitted-large-diff, and synthetic-untracked diff states
- long diff lines and diff-pane overflow
- validation badges for passed, failed, skipped, partial, and not_run
- low/medium/high risk badges
- behavior flow, decisions, known limitations, and missing validation
- ungrouped files and missing/stale chapter references
- responsive browser widths and print rendering

## Fixture files

```text
fixtures/dev/comprehensive.git.json
fixtures/dev/comprehensive.ultralow.json
fixtures/dev/comprehensive.low.json
fixtures/dev/comprehensive.medium.json
fixtures/dev/comprehensive.high.json
```

The fixtures are intentionally synthetic and should remain valid against `src/schema.ts`. They may intentionally show renderer warnings or rigor-check failures so those visual states remain easy to inspect.

## Why this workflow exists

Real `/pr` runs are optimized for producing review artifacts from real work. Development of the renderer itself should be cheaper and deterministic. The fixture workflow avoids expensive token generation while keeping debugging close to the real JSON-to-HTML render path.
