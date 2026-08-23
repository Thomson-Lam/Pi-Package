# Blink extension index

Description: Human file-review modes (off/slow/blitz) and the tmux/Neovim review protocol backing them.

Components:
- `index.ts` — registers `/blink` mode picker, wraps edit/write tools with mutation tracking, and manages blink runtime sessions.
- `runtime.ts` — BlinkRuntime: review-session lifecycle, materialized file state, and feedback sinks.
- `tools.ts` — wrapped edit/write tool definitions and blink mode types.
- `protocol.ts` — tmux/Neovim JSON protocol for file transfer and review sync.
- `revisions.ts` — file revision snapshots and diffs for undo/redo across review rounds.
- `tmux.ts` — tmux exec helpers and pane detection.
- `nvim/lua/blink/` — Neovim-side client: `protocol.lua`, `state.lua`, `ui.lua`.
- `nvim/review.lua` — Neovim review-mode entry script.
- `tests/` — unit and tmux-isolated coverage for tools, protocol, revisions, history, and actions.

Related:
- `../../AGENTS.md`