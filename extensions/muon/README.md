# Muon

Muon is a personal Pi extension for optional Superpowers skill bootstrapping, transparent subagent orchestration, declarative workflows, worktree checkpoints, and rollback-aware monitoring.

## Superpowers modes

```text
/muon skills off        # no Superpowers discovery or bootstrap
/muon skills discover   # expose /Users/tlam/superpowers/skills as Pi skills
/muon skills bootstrap  # discover skills and inject using-superpowers bootstrap
/muon skills status
```

Default is `off`.

## Manual commands

```text
/muon status
/muon agents [user|project|both]
/muon subagent          # opens JSON editor, then asks main agent to call muon_subagent
/muon workflow          # opens JSON editor, then asks main agent to call muon_workflow
/muon runs
/muon open <runId>
/muon rollback <runId> [targetRef]
```

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
