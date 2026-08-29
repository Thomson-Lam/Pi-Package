# Muon extension index

Description: Muon interaction modes, skill management, resource discovery, and the bundled skillsets.

Components:
- `index.ts` — extension init: loads mode prompts, restores persisted state, registers `/build`, `/spec`, `/off`, the `--muon-mode` flag, and resource discovery.
- `commands.ts` — user-facing `/muon` and `/mus` flows for mode selection, skill toggles/status, and skill dump.
- `skills.ts` — skill profile control, mode skill synchronization, and enabled-skill path resolution.
- `resources.ts` — `resources_discover` output for enabled skills.
- `skill-dump.ts` — exports Muon-managed skills to `.pi`/`.agents`/`.claude`/`.codex` skill dirs.
- `state.ts` — persisted Muon state create/restore/update helpers.
- `constants.ts` — extension paths and identifiers.
- `types.ts` — Muon mode, skill, and persisted-state types.
- `command-parser.js`, `mode-policy.js`, `state-policy.js` (with `.d.ts`) — plain-JS policy modules: `/muon` argument parsing, mode/skill synchronization, and state normalization/migration. These are the implementation; no TypeScript source exists.
- `modes/` — Build and Spec system prompts (`build-prompt.md`, `spec-prompt.md`).
- `skillsets/ponytail/` — ponytail, ponytail-review, and ponytail-debt skills; each `SKILL.md` is its source of truth.
- `skillsets/standalone/` — authoring-skills, cindex, github-issues-prs, ipynb_toolshed, tlogs, tcmd, yagni-product-design.
- `skillsets/standalone/tlogs/extension.ts` — `/logs` pane selection, workflow prompts, session state, and the selection-restricted `tmux_tdl_logs` tool backed by its bundled script.
- `skillsets/standalone/tcmd/extension.ts` — `/cmd`, human-approved Staging/Full-staging workflows, shared command-review feedback, in-memory observe/record output strategies, and Auto/Manual delivery backed by its bundled capture/staging script.
- `skillsets/standalone/tcmd/relative-diff.js` — relative pane-snapshot deltas for command-scoped record output.
- `tests/` — policy and smoke coverage (`smoke.mjs`, `command-parser.mjs`, `mode-policy.mjs`, `state-policy.mjs`, `engineering-skills.mjs`).

Related:
- `../../AGENTS.md`