# Olive-agents extension index

Description: Human-approved autonomous sub-agents: launch, lifecycle, tmux windows, mailbox communication, and context handoff.

Components:
- `index.ts` — forwards to `src/index.ts`.
- `src/index.ts` — registers `/agents`, `/agent-session`, `/mag`, the `alt+a` shortcut, and the `Agent` / `get_subagent_result` / `steer_subagent` tools; wires managers, approval, and UI.
- `src/agent-manager.ts` — child agent lifecycle state (tmux windows + filesystem mailbox).
- `src/agent-runner.ts` — launch-spec preparation and max-turns/grace-turn normalization.
- `src/agent-types.ts` — embedded default + user-defined agent registry.
- `src/approval.ts` — mandatory per-launch review/approval.
- `src/child-host.mjs` — plain-ESM host booting each agent as a native Pi session in its own tmux window.
- `src/child-handoff.mjs` — plain-ESM constrained-context packet for freshly launched children.
- `src/context.ts` — parent conversation extraction for subagent inheritance.
- `src/cross-extension-rpc.ts` — ping/spawn/stop RPC over `pi.events`.
- `src/event-mailbox.ts` — filesystem mailbox between parent and child sessions.
- `src/group-join.ts` — grouped completion notifications for background agents.
- `src/tmux-window.ts` — tmux window creation/management for agent hosts.
- `src/handoff/` — context-handoff pipeline: `prepare.ts`, `serialize.ts`, `source.ts`, `freshness.ts`, `types.ts`.
- `src/ui/` — fleet overview (`fleet-list.ts`), context review (`context-review.ts`), formatting (`format.ts`).
- `src/settings.ts` — olive-agents settings persistence and tool-description modes.
- `src/memory.ts` — per-agent persistent memory directories.
- `src/model-resolver.ts` and `src/enabled-models.ts` — model resolution and enabled-model scoping.
- `src/skill-loader.ts` — skill preloading roots.
- `src/prompts.ts` — system prompt builder.
- `src/usage.ts` — token usage shapes and accumulators.
- `src/worktree.ts` — git worktree isolation for agents.
- `src/` remaining support modules — `custom-agents.ts`, `default-agents.ts`, `env.ts`, `invocation-config.ts`, `names.ts`, `nudge.ts`, `status-note.ts`, `types.ts`.
- `test/` — unit coverage for manager, runner, approval, handoff, mailbox, model resolution, and UI.

Related:
- `../../AGENTS.md`