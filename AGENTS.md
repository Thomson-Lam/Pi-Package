# Pi Package codebase index

Description: Navigation map for the current personal Pi workflow package.
Purpose: Help agents locate extension entry points, supporting modules, skills, tests, and installation tooling without treating this file as implementation documentation.

## Package boundary

- `package.json` — root Pi package manifest; Pi loads each `extensions/*/index.ts` entrypoint. Runtime code is TypeScript ESM.
- `README.md` — installation, update, and local-development workflows. Pi-managed clones under `~/.pi/agent/git/...` must not be edited directly.
- `manual.md` — package usage notes and manual reference.

## Extensions

- `extensions/context-inspector/index.ts` — package entrypoint forwarding to `src/index.ts`.
- `extensions/context-inspector/src/index.ts` — registers `/ctx`, `/reads`, `/ctfresh`, and the context-inspector shortcut; `src/collector.ts`, `src/reconstruct.ts`, and `src/state.ts` collect and rebuild context metadata, while `src/ui/` owns panels and the status widget.
- `extensions/foundation-mode/index.ts` — toggles Foundation Mode and injects `foundation-prompt.md` before agent turns; `tests/smoke.mjs` covers basic extension behavior.
- `extensions/feedback-editor/index.ts` and `client.lua` — register `/fb` and `/fpr`, opening a right-side tmux Neovim pane and returning saved text to Pi's chat editor without storing it in a file.
- `extensions/muon/index.ts` — initializes persisted Muon state, commands, and skill resource discovery.
- `extensions/muon/commands.ts` — user-facing `/muon` command flows for skill profile toggles, individual skill toggles, skill status, and skill export.
- `extensions/muon/skills.ts`, `superpowers.ts`, and `skill-dump.ts` — skill discovery/profile control and universal skill export.
- `extensions/muon/skillsets/` — bundled Muon, Ponytail, standalone, and Superpowers skills; each skill's `SKILL.md` is its source of truth. See `extensions/muon/README.md` for profiles and commands.
- `extensions/muon/tests/smoke.mjs` — Muon smoke coverage.
- `extensions/pi-telescope/index.ts` — registers Telescope commands, shortcut, providers, and fuzzy `@` file completion.
- `extensions/pi-telescope/telescope.ts`, `scoring.ts`, and `frecency.ts` — finder UI, query scoring, and ranking history; `providers/` contains files, branches, log, sessions, skills, and commands sources.
- `extensions/plan-mode/index.ts` — initializes plan storage/state, prompt injection, tool guardrails, attachment freshness notifications, and `plan_diff`.
- `extensions/plan-mode/commands.ts`, `storage.ts`, and `attachment.ts` — plan command flows, global/project plan stores, and attached-snapshot diff tracking. See `extensions/plan-mode/README.md` for current capabilities and deferred work.
- `extensions/plan-mode/guardrails.ts` and `prompt.ts` — active-plan tool restrictions and system-prompt construction; strings/templates live in `prompts.json` and `prompts.ts`.
- `extensions/review/INDEX.md` — detailed child index for the review-artifact extension, including `/pr`, its CLI, schema, render pipeline, templates, fixtures, and manual checks.

## Supporting files

- `docs/superpowers/specs/2026-07-12-foundation-mode-design.md` — design specification for Foundation Mode.
- `scripts/install-npm-packages.sh` and `scripts/install-npm-packages.ps1` — install companion registry packages on Unix and Windows.
- `scripts/install-personal-package.sh` and `scripts/install-personal-package.ps1` — install this personal package on Unix and Windows.

## Related indexes

- `extensions/review/INDEX.md` — focused navigation for the independently packaged review extension.
