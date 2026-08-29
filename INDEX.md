# Pi Package index

Description: Root navigation map for the Pi workflow package; points to extension entry points, supporting files, and child subsystem indexes.

Components:
- `package.json` — root manifest; Pi loads each `extensions/*/index.ts` entrypoint. Runtime is TypeScript ESM.
- `README.md` — installation, update, and local-development workflows; Pi-managed clones under `~/.pi/agent/git/...` must not be edited.
- `manual.md` — package usage notes and manual reference.
- `extensions/active-session-shortcuts/index.ts` — registers `/rs` for native session resume, `/rl` for native reload, plus `/rn` and `/rename` for session naming.
- `extensions/blink/index.ts` — registers `/blink` (off/slow/blitz human file-review modes) and wraps edit/write tools.
- `extensions/ctx/index.ts` — forwards to `src/index.ts`, which registers `/ctx`, `/cnew`, `/cb`, `/reads`, `/can`, `/cana`, `/canu`.
- `extensions/feedback-editor/index.ts` and `client.lua` — register `/fb` and `/fpr`, opening a right-side tmux Neovim pane and returning saved text to Pi's chat editor.
- `extensions/muon/index.ts` — Muon entrypoint: persists mode/skill state, injects mode prompts, registers `/build`, `/spec`, `/off`, `/muon`, `/mus`, and the `--muon-mode` flag.
- `extensions/olive-agents/index.ts` — forwards to `src/index.ts`, which registers `/agents`, `/agent-session`, `/mag`, the `alt+a` shortcut, and the `Agent` / `get_subagent_result` tools.
- `extensions/pi-telescope/index.ts` — registers Telescope commands, shortcuts, providers, and fuzzy `@` file completion.
- `extensions/startup-command/index.ts` — registers the `--startup-command` flag to run a slash command after TUI startup.
- `docs/` — gitignored handoff and plan notes (`handoff/`, `plans/`).
- `prompts/` — Pi prompt templates (`spec-to-issues.md`).
- `scripts/install-npm-packages.sh` / `.ps1` — install companion registry packages.
- `scripts/install-personal-package.sh` / `.ps1` — install this personal package.

Related:
- `extensions/blink/INDEX.md`
- `extensions/ctx/INDEX.md`
- `extensions/muon/INDEX.md`
- `extensions/olive-agents/INDEX.md`
- `extensions/pi-telescope/INDEX.md`
