# Olive Agents Review UX — tmux-native architecture

## Context

**Each approved agent runs as a native Pi session in its own tmux window. The parent Pi session coordinates via a filesystem mailbox and keeps a compact fleet overview.**

Agents are no longer in-process `AgentSession`s rendered inside the parent TUI. The old multi-agent conversation inspector and the transcript-tail tmux window are removed: inspecting, interrupting, steering, and following up with an agent now happens in the agent's own native Pi TUI, exactly like working in the parent session.

## Product surfaces

| Surface | Purpose |
|---------|---------|
| Launch approval | Mandatory human review of every delegation (model, reasoning, context, task) |
| Inline Agent tool display | Compact call/result rendering in the parent chat (running state, activity, outcome) |
| Fleet widget (below editor) | Passive overview: status, activity, tmux window index, elapsed time, tokens, turns |
| Alt+A / `/agent-session` picker | Arrow-select a fleet row and focus its tmux window (reopens closed sessions) |
| Agent tmux window | Native Pi TUI over the persistent agent session — full interaction, no custom viewer |
| Completion / steering notifications | `followUp` messages back into the parent conversation |

## Session model

- Every agent launch creates a **persistent Pi session** (`SessionManager.create` with the parent's session file as `parentSession`), stored beside the parent session file, named `<HH:MM>-[S]: <description>`.
- `/resume` in the parent (Threaded sort, empty search) renders agent sessions **nested under the parent**.
- The child session header records the agent's actual cwd (worktree path when isolated); the file location stays with the parent so one `/resume` scope sees the whole tree.
- Reopening a closed window attaches to the **existing** session file (`SessionManager.open`) — history is preserved.
- `/resume` selecting a session owned by a **live** window is cancelled; the owning window is focused instead (one writer per JSONL file).

## Process + mailbox

- `child-host.mjs` (plain ESM, launched by `node`) reads a one-shot launch spec prepared by the parent, boots `InteractiveMode` over the agent session, and bridges events.
- Mailbox: `<tmpdir>/olive-agents/<parent-session-id>/<agent-id>/` with `events/` (child→parent) and `commands/` (parent→child); atomic JSON writes, 0700/0600, consumed-once.
- Events: `ready`, `run_started`, `tool_started/finished`, `turn_finished`, `human_steer`, `run_settled` (status/result/usage), `process_exit`.
- Commands: `steer`, `follow_up`, `abort`, `shutdown` (polled by the child host every 500 ms).
- Turn limits and grace turns are enforced inside the child host (steer-to-wrap-up, then abort).
- Concurrency: a slot covers an active **run**; an idle window consumes none. Human-initiated runs in a child window are observed via `run_started` but not scheduled by the parent.

## Naming

- tmux window: `agent-<type>-<agent-id[:8]>` (e.g. `agent-review-a1b2c3d4`)
- Pi session: `Agent · Review · inspect auth changes · a1b2c3d4`
- Windows are addressed by stable `#{window_id}`; new windows are created at `max(index) + 1` (works with `renumber-windows on`).

## Explicit behaviors

- Parent shutdown asks live children to shut down (`shutdown` command); stale windows are killed by tmux liveness polling.
- **Window lifecycle**: when a run settles, the agent's tmux window closes automatically (default `closeWindowOnComplete: true`) — unless the user is actively viewing that window or a parent follow-up is queued. The Pi session file is unaffected; reopen is on demand (Alt+A / `/resume`).
- **Fleet lifecycle**: a completed agent's row stays until the parent agent consumes its result (`get_subagent_result`) AND its window is closed — then it auto-clears. `d` in the Alt+A picker dismisses a row manually (closing its window too). The archive lives in `/resume` (nested under the parent) and the parent session's `subagents:record` entries.
- Clearing a fleet record forgets the record and releases its worktree but **never deletes the Pi session file**.
- Outside tmux, agent launches fail with a clear error — there is no in-process fallback.
- Ephemeral parents (`--no-session`) produce root-level (unnested) agent sessions plus a warning.
- Worktree isolation: parent creates the worktree, child runs inside it, parent checkpoints on every settled run, worktree is released on clear/shutdown.
- The old in-process `runAgent`/`resumeAgent`/`steerAgent`, the conversation viewer, viewer keys, the output-file transcript, and the transcript-tail tmux window are removed. `get_subagent_result` and `steer_subagent` work through the mailbox.
