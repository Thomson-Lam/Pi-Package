# Muon

Muon is a personal Pi extension for bundled skill-first workflows, transparent subagent orchestration, declarative workflows, worktree checkpoints, and rollback-aware monitoring.

## Skills mode

Muon includes a self-contained copy of the Superpowers-style skills under `extensions/muon/skills/`.

```text
/muon skills off      # no bundled skill discovery or bootstrap injection
/muon skills on       # expose bundled Muon skills and inject using-superpowers once per session
/muon skills status
```

Default is `off`. After changing skills mode, run `/reload` so Pi refreshes discovered skills.

## Manual commands

```text
/muon                 # open the Muon action menu
/muon help            # show UI-only help
/muon status
/muon skills on|off|status
/muon agents [user|project|both]
/muon subagent        # opens JSON editor, then asks main agent to call muon_subagent
/muon workflow        # opens JSON editor, then asks main agent to call muon_workflow
/muon runs
/muon open <runId>
/muon rollback <runId> [targetRef]
```

The `/muon` menu supports `j`/`k` navigation, Enter to select, `h`/`?` for help, and Esc to cancel.

## Bundled skills

The bundled skill tree is copied from Superpowers and includes:

```text
using-superpowers
brainstorming
writing-plans
executing-plans
subagent-driven-development
test-driven-development
systematic-debugging
verification-before-completion
using-git-worktrees
requesting-code-review
receiving-code-review
finishing-a-development-branch
dispatching-parallel-agents
writing-skills
```

When skills mode is `on`, Muon returns `extensions/muon/skills` through Pi resource discovery and injects `using-superpowers` into context once per session.

## muon_subagent

Use for one-off transparent delegation. Exactly one mode must be supplied.

Single:

```json
{
  "name": "inspect-auth",
  "agent": "scout",
  "task": "Find authentication code and summarize relevant files.",
  "agentScope": "user",
  "maxDepth": 1
}
```

Parallel:

```json
{
  "name": "parallel-audit",
  "tasks": [
    { "agent": "scout", "task": "Inspect routing files." },
    { "agent": "scout", "task": "Inspect persistence files." }
  ],
  "maxParallel": 2,
  "maxDepth": 1
}
```

Chain:

```json
{
  "name": "implement-review",
  "chain": [
    { "agent": "worker", "task": "Implement the requested change." },
    { "agent": "reviewer", "task": "Review this implementation: {previous}" }
  ],
  "maxDepth": 1
}
```

## muon_workflow

Use this as the main agent's orchestration entrypoint. It keeps the main agent informed through concise summaries while full details stay in the run ledger.

```json
{
  "name": "scout-plan-review",
  "objective": "Inspect a feature area, propose a plan, and review risks.",
  "agentScope": "user",
  "maxParallel": 2,
  "maxDepth": 1,
  "worktreeMode": "none",
  "phases": [
    { "id": "scout", "title": "Inspect files", "kind": "single", "agent": "scout", "task": "Find relevant files and summarize architecture." },
    { "id": "review", "title": "Review risks", "kind": "single", "agent": "reviewer", "task": "Review scout findings and identify implementation risks." }
  ]
}
```

## Rollback

For implementation workflows, set `worktreeMode` to `shared-run`. Muon creates a git worktree under `.worktrees/`, runs all phases there, and checkpoint-commits after phases with changes. Use:

```text
/muon rollback <runId> [targetRef]
```

Default rollback target is `HEAD~1` inside the run worktree.

## Run artifacts

Each run writes:

```text
~/.pi/agent/muon/runs/<run>/
  workflow.json
  ledger.md
  events.jsonl
  <phase>-<agent>-prompt.md
  <phase>-<agent>-output.md
```
