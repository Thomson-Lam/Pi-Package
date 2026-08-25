---
name: tlogs
description: Inspect selected tmux pane output, dev server logs, terminal stdout, errors, or warnings with the /logs workflow or bundled CLI.
compatibility: Requires bash and tmux.
---

# tmux td Logs

When this Muon skill is enabled, Muon also exposes the `tmux_tdl_logs` tool. Prefer the `/logs` workflow: the user selects panes from any tmux window, and the agent queries only that selection. Keep it read-only; do not send keys or restart servers unless the user asks.

The bundled `scripts/tmux-tdl-logs` remains a CLI fallback. Resolve it relative to this `SKILL.md` and invoke its absolute path from any repository. Without an explicit `TDL_PANES` selection it retains the legacy behavior of reading the companion `<repo>-servers` window.

## Quick reference

| Need | Command |
| --- | --- |
| Find server panes | `<SKILL_DIR>/scripts/tmux-tdl-logs panes` |
| Read one pane | `<SKILL_DIR>/scripts/tmux-tdl-logs capture-pane <index-or-%pane-id> 200` |
| Read all server panes | `<SKILL_DIR>/scripts/tmux-tdl-logs capture-servers 200` |
| Poll one pane briefly | `timeout 20s <SKILL_DIR>/scripts/tmux-tdl-logs watch-pane %12 5 4 120` |
| Poll all server panes briefly | `timeout 20s <SKILL_DIR>/scripts/tmux-tdl-logs watch-servers 5 4 120` |
| Start repro recording | `<SKILL_DIR>/scripts/tmux-tdl-logs record-start latest 2 120 600` |
| Stop repro recording | `<SKILL_DIR>/scripts/tmux-tdl-logs record-stop latest` |
| Check recording size/status | `<SKILL_DIR>/scripts/tmux-tdl-logs record-info latest` |
| Read recent recording lines | `<SKILL_DIR>/scripts/tmux-tdl-logs record-read latest 200` |
| Read a page | `<SKILL_DIR>/scripts/tmux-tdl-logs record-page latest 2 200` |
| Search recording first | `<SKILL_DIR>/scripts/tmux-tdl-logs record-grep latest 'error|fail|exception|warn' 4` |

## Tool actions

Use `tmux_tdl_logs` with one `action` and optional positional `args`:

| Action | `args` |
| --- | --- |
| `panes` | none |
| `capture-pane` | pane ID, line count |
| `capture-servers` | line count |
| `watch-pane` | pane ID, interval, count, line count |
| `watch-servers` | interval, count, line count |
| `record-start` | name, interval, lines, maximum seconds |
| `record-stop` | name |
| `record-list` | none |
| `record-info` | name |
| `record-read` | name, line count |
| `record-page` | name, page, line count |
| `record-grep` | name, pattern, context lines |

The tool limits output to 1200 lines or 30KB.

## Workflow

1. Ask the user to run `/logs` and select panes.
2. Use `tmux_tdl_logs` with `panes` if the attached selection needs confirmation.
3. Capture one pane with `capture-pane` or all selected panes with `capture-servers`.
4. For changes that affect a running server, patch first, then do one bounded watch.
5. For a user-driven reproduction, call `record-start`, tell the user it is ready, and wait for "done" before calling `record-stop`.
6. After stopping, inspect cheaply: `record-info`, then `record-grep`, then `record-read`; use `record-page` only if needed.
7. Keep captures small: 120-300 lines usually beats dumping history.

## Rules

- Foreground watching is not streaming. Use bounded `watch`: small interval, small count, `timeout`.
- Background recording is for user-driven repros; stop it before reading, unless checking status.
- The extension accepts only the `%pane-id`s attached by `/logs`; legacy CLI mode also accepts pane indexes in `<repo>-servers`.
- Explicitly selected panes may come from any tmux window.
- Server output can contain secrets. Quote only the relevant lines back to the user.
- Use the bundled CLI only when the extension tool is unavailable.

## Common mistakes

- Running an unbounded `watch` or `tail -f` in a tool call.
- Guessing the pane target instead of listing first.
- Capturing thousands of lines when the last 200 shows the failure.
- Falling back to an unselected pane when the tool reports no `/logs` selection.
- Sending input to panes during log inspection.
