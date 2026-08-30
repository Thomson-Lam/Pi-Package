# Olive-agents extension index

Description: Human-approved autonomous sub-agents: launch, lifecycle, tmux windows, and mailbox communication.

Components:
- `index.ts` — registers `/agents`, `/agent-session`, `/mag`, `/ot`, the `alt+a` shortcut, and the `Agent` / `get_subagent_result` tools; wires managers, approval, context ledger, and UI.
- `src/agent-manager.ts` — child agent lifecycle state (tmux windows + filesystem mailbox); persists parent-session context links; reopens persisted sessions from /ot.
- `src/agent-runner.ts` — launch-spec preparation (v3, optional ledger), max-turns/grace-turn normalization, and reopen descriptors.
- `src/agent-types.ts` — embedded default + user-defined agent registry.
- `src/approval.ts` — mandatory per-launch review/approval, with optional context-ledger building.
- `src/child-host.mjs` — plain-ESM host booting each agent as a native Pi session in its own tmux window; persists the received ledger node into the child session.
- `src/context-ledger.ts` — durable context model: message/tool extraction, snapshotting, prompt serialization, ancestor-chain resolution, /ot graph loading and tree placement (nested / parallel / skipped-parent / isolated).
- `src/cross-extension-rpc.ts` — ping/spawn/stop RPC over `pi.events`.
- `src/event-mailbox.ts` — filesystem mailbox between parent and child sessions.
- `src/group-join.ts` — grouped completion notifications for background agents.
- `src/tmux-window.ts` — tmux window creation/management for agent hosts, incl. stable-name lookups for reopen dedup.
- `src/ui/` — fleet overview (`fleet-list.ts`), context selection (`context-selection.ts`), and /ot tree (`context-tree.ts`, which doubles as the inheritance picker via select mode), plus formatting (`format.ts`).
- `src/settings.ts` — olive-agents settings persistence and tool-description modes.
- `src/memory.ts` — per-agent persistent memory directories.
- `src/model-resolver.ts` and `src/enabled-models.ts` — model resolution and enabled-model scoping.
- `src/skill-loader.ts` — skill preloading roots.
- `src/prompts.ts` — system prompt builder.
- `src/usage.ts` — token usage shapes and accumulators.
- `src/` remaining support modules — `custom-agents.ts`, `default-agents.ts`, `env.ts`, `invocation-config.ts`, `names.ts`, `nudge.ts`, `status-note.ts`, `types.ts`.
- `test/` — unit coverage for manager, runner, approval, context ledger, tree placement, mailbox, model resolution, and UI.

Notes:
- The context ledger persists into pi session JSONL files only (`olive-agent-context-link` in the parent session, `olive-agent-context-ledger` in the child session); nothing is written to the project workspace.
- Non-mutating compaction output uses pi's native summarizer without appending a compaction entry to the current session.
- Context-building flow: selection TUI → inherit prior context? y/n (only when a prior ledger exists; Yes opens the /ot tree in select mode) → compact full conversation? y/n → launch.
- `/ot` actions per ledger row: "Launch agent with this context" (reuses the whole ledger+compaction flow pre-seeded with that node's chain), view context, focus/open session.
- /ot rebuilds the tree from persisted entries after /resume; `--no-session` cannot rebuild.

Related:
- `../../AGENTS.md`