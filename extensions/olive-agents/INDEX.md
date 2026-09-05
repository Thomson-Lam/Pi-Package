# Olive-agents extension index

Description: Human-controlled supervised child agents. Every successful `Agent` launch is detached into its own tmux window; the child owns Continue, Feedback, and Return decisions.

Components:
- `index.ts` — registers `/agents`, `/agent-session`, `/ot`, `/otn`, `/ocl`, the `alt+a` shortcut, and the Agent tool; `/ot` starts or reopens agents from selected ledger contexts, `/otn` starts an agent from current-session context, and `/ocl` clears a child/window and releases its slot.
- `src/agent-manager.ts` — child lifecycle state (tmux windows + filesystem mailbox), concurrency queue, durable parent-session links, pending-decision restoration, and `/ot` reopening. Completion, errors, and child steering do not wake the parent.
- `src/agent-runner.ts` — launch-spec preparation (v3, optional ledger), max-turn validation, and reopen descriptors.
- `src/agent-types.ts` — embedded default + user-defined agent registry.
- `src/approval.ts` — mandatory per-launch review/approval, with optional context-ledger building; parent behavior is always detached.
- `src/child-host.mjs` — plain-ESM bootstrap around native Pi InteractiveMode. Continue, Feedback, and Return are child-local; the parent mailbox accepts checkpoint acknowledgements only.
- `src/child-extension-filter.mjs` — preserves the inline child-return bridge (`/or`) alongside the inherited parent-extension allow-list.
- `src/context-ledger.ts` — durable context model, snapshotting, prompt serialization, parent-context resolution, `/ot` graph loading, and agent-tree placement.
- `src/event-mailbox.ts` — filesystem mailbox between parent and child sessions, including acknowledged incremental context checkpoints.
- `src/tmux-window.ts` — tmux window creation/management and stable-name lookups for reopen deduplication.
- `src/ui/` — fleet overview, context selection/tree, and formatting.
- `src/settings.ts` — olive-agents settings persistence and Agent tool-description modes.
- `src/memory.ts`, `src/model-resolver.ts`, `src/enabled-models.ts`, `src/skill-loader.ts`, `src/prompts.ts`, `src/usage.ts` — supporting runtime behavior.
- `src/` remaining support modules — `custom-agents.ts`, `default-agents.ts`, `env.ts`, `invocation-config.ts`, `names.ts`, `status-note.ts`, `types.ts`.
- `test/` — coverage for manager lifecycle/queue/restore, context ledger, `/ot`, approval, mailbox, model resolution, skills, memory, tmux, and tool registration.

Notes:
- Context state persists into pi session JSONL files only (`olive-agent-context-link` in the parent, `olive-agent-context-ledger` plus incremental child checkpoints); nothing is written to the project workspace.
- A checkpoint is inserted into the parent before its receipt is persisted or `ack_checkpoint` is sent. Failed insertion leaves the checkpoint unacknowledged for later delivery; duplicate checkpoint IDs are deduplicated.
- Provider failures settle children without waking the parent. The human supervises the child window and chooses Return when context should come back.
- `/ot` rebuilds the tree from persisted entries after `/resume`; `--no-session` cannot rebuild.

Related:
- `../../AGENTS.md`
