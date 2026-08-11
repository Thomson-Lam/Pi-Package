# Pi Package codebase index

Description: Navigation map for the current personal Pi workflow package.
Purpose: Help agents locate extension entry points, supporting modules, skills, tests, and installation tooling without treating this file as implementation documentation.

## Package boundary

- `package.json` — root Pi package manifest; Pi loads each `extensions/*/index.ts` entrypoint. Runtime code is TypeScript ESM.
- `README.md` — installation, update, and local-development workflows. Pi-managed clones under `~/.pi/agent/git/...` must not be edited directly.
- `manual.md` — package usage notes and manual reference.

## Extensions

- `extensions/ctx/index.ts` — package entrypoint forwarding to `src/index.ts`.
- `extensions/ctx/src/index.ts` — registers `/ctx`, `/cnew`, and `/reads`; `src/fresh/` owns the prepared fresh-session workflow, `src/collector.ts`, `src/reconstruct.ts`, and `src/state.ts` collect and rebuild context metadata, while `src/ui/` owns panels and widgets.
- `extensions/muon/modes/` — Build and Spec system prompts selected through Muon's interaction mode control.
- `extensions/feedback-editor/index.ts` and `client.lua` — register `/fb` and `/fpr`, opening a right-side tmux Neovim pane and returning saved text to Pi's chat editor without storing it in a file.
- `extensions/muon/index.ts` — initializes persisted Muon mode/skill state, injects the selected mode prompt, and registers resource discovery.
- `extensions/muon/commands.ts` — user-facing `/muon` flows for mode selection, skill toggles/status, and skill export.
- `extensions/muon/skills.ts`, `resources.ts`, and `skill-dump.ts` — skill profile control, resource discovery, and universal skill export.
- `extensions/muon/skillsets/` — bundled Ponytail and standalone skills; each skill's `SKILL.md` is its source of truth. Retired Engineering and Foundation resources are archived under `extensions/muon/archive/`.
- `extensions/muon/tests/smoke.mjs` — Muon smoke coverage.
- `extensions/olive-agents/index.ts` — registers human-approved `Agent`, result, steering, agent-management, and scheduling flows; `src/approval.ts` owns the mandatory per-launch review while the remaining `src/` modules provide the reused subagent runtime, sessions, transcripts, and UI.
- `extensions/pi-telescope/index.ts` — registers Telescope commands, shortcut, providers, and fuzzy `@` file completion.
- `extensions/pi-telescope/telescope.ts`, `scoring.ts`, and `frecency.ts` — finder UI, query scoring, and ranking history; `providers/` contains files, branches, log, sessions, skills, and commands sources.
- `extensions/plan-mode/index.ts` — initializes plan storage/state, prompt injection, tool guardrails, attachment freshness notifications, and `plan_diff`.
- `extensions/plan-mode/commands.ts`, `storage.ts`, and `attachment.ts` — plan command flows, global/project plan stores, and attached-snapshot diff tracking. See `extensions/plan-mode/README.md` for current capabilities and deferred work.
- `extensions/plan-mode/guardrails.ts` and `prompt.ts` — active-plan tool restrictions and system-prompt construction; strings/templates live in `prompts.json` and `prompts.ts`.
- `extensions/muon/skillsets/standalone/tmux-tdl-logs/extension.ts` — Muon-governed `/tdlogs` pane selection, workflow prompts, session state, and the selection-restricted `tmux_tdl_logs` tool backed by its adjacent bundled script.
- `extensions/review/INDEX.md` — detailed child index for the review-artifact extension, including `/pr`, its CLI, schema, render pipeline, templates, fixtures, and manual checks.

## Supporting files

- `docs/planning/super-foundations/` — research conversation and source draft for the retired Engineering Mode prompt.
- `scripts/install-npm-packages.sh` and `scripts/install-npm-packages.ps1` — install companion registry packages on Unix and Windows.
- `scripts/install-personal-package.sh` and `scripts/install-personal-package.ps1` — install this personal package on Unix and Windows.

## Related indexes

- `extensions/review/INDEX.md` — focused navigation for the independently packaged review extension.
