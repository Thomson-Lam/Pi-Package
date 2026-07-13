---
name: tmux-tdl-logs
description: Use in a td tmux workflow to inspect dev server panes output, server logs, terminal stdout, errors, or warnings from the companion <repo>-servers window.
---

# tmux td Logs

Read dev-server panes in the current `td` tmux workflow with `tmux-tdl-logs`. It only captures `<repo>-servers`, never window 1 / `<repo>-agent`. Keep it read-only; do not send keys or restart servers unless the user asks.

## Quick reference

| Need | Command |
| --- | --- |
| Find server panes | `tmux-tdl-logs panes` |
| Read one pane | `tmux-tdl-logs capture-pane <index-or-%pane-id> 200` |
| Read all server panes | `tmux-tdl-logs capture-servers 200` |
| Poll one pane briefly | `timeout 20s tmux-tdl-logs watch-pane %12 5 4 120` |
| Poll all server panes briefly | `timeout 20s tmux-tdl-logs watch-servers 5 4 120` |
| Start repro recording | `tmux-tdl-logs record-start latest 2 120 600` |
| Stop repro recording | `tmux-tdl-logs record-stop latest` |
| Check recording size/status | `tmux-tdl-logs record-info latest` |
| Read recent recording lines | `tmux-tdl-logs record-read latest 200` |
| Read a page | `tmux-tdl-logs record-page latest 2 200` |
| Search recording first | `tmux-tdl-logs record-grep latest 'error|fail|exception|warn' 4` |

## Workflow

1. Run `tmux-tdl-logs panes` to identify panes in `<repo>-servers`.
2. Capture the relevant pane, or use `capture-servers` if unsure.
3. For changes that affect a running server, patch first, then do one bounded poll with `timeout`.
4. If the user needs time to reproduce a bug, run `record-start`, tell them to reproduce it, then wait for "done" before `record-stop`.
5. After a recording, inspect cheaply: `record-info`, then `record-grep`, then `record-read 200`; use `record-page` only if needed.
6. Keep captures small: 120-300 lines usually beats dumping history.

## Rules

- Foreground watching is not streaming. Use bounded `watch`: small interval, small count, `timeout`.
- Background recording is for user-driven repros; stop it before reading, unless checking status.
- Prefer pane ids (`%12`) after `list`; pane indexes are fine too.
- Imported panes in `<repo>-agent` are intentionally ignored/rejected; send them back before capturing if needed.
- Server output can contain secrets. Quote only the relevant lines back to the user.

## Common mistakes

- Running an unbounded `watch` or `tail -f` in a tool call.
- Guessing the pane target instead of listing first.
- Capturing thousands of lines when the last 200 shows the failure.
- Sending input to panes during log inspection.
