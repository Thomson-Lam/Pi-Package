# Muon

Muon is a personal Pi extension for bundled skill-first workflows, transparent subagent orchestration, declarative workflows, worktree checkpoints, and rollback-aware monitoring.

## Skillsets

Muon uses static skill roots from `extensions/muon/skillsets/`.

```text
/muon skillset off           # expose no bundled Muon skills
/muon skillset auto          # expose using-muon + Ponytail + Superpowers
/muon skillset ponytail      # expose using-muon + Ponytail only
/muon skillset superpowers   # expose using-muon + Superpowers only
/muon skillset status
```

`/muon skills ...` is kept as an alias for `/muon skillset ...`.

Default is `off`. Changing skillsets reloads the session so Pi refreshes the
skill catalog.

| Skillset      | Exposed skill roots                                                       |
| ------------- | ------------------------------------------------------------------------- |
| `off`         | none                                                                      |
| `auto`        | `skillsets/muon`, `skillsets/ponytail`, `skillsets/superpowers` |
| `ponytail`    | `skillsets/muon`, `skillsets/ponytail`                          |
| `superpowers` | `skillsets/muon`, `skillsets/superpowers`                       |

`using-muon` routes between available skills. In `superpowers` mode,
`yagni-scope-guard` is available to constrain scope creep without exposing
Ponytail.

## Manual commands

```text
/muon                 # open the Muon action menu
/muon help            # show UI-only help
/muon status
/muon skillset        # open skillset modal
/muon skillset off|auto|ponytail|superpowers|status
/muon skills off|auto|ponytail|superpowers|status  # alias
/muon agents [user|project|both]
/muon subagent        # opens JSON editor, then asks main agent to call muon_subagent
/muon workflow        # opens JSON editor, then asks main agent to call muon_workflow
/muon runs
/muon open <runId>
/muon rollback <runId> [targetRef]
```

The `/muon` menu supports `j`/`k` navigation, Enter to select, `h`/`?` for help, and Esc to cancel. The `/muon skillset` modal supports `j`/`k` navigation, Enter to select a mode, and Esc to cancel.

## Bundled skills

Muon exposes selected roots through Pi resource discovery.

```text
skillsets/muon/
  using-muon
  yagni-scope-guard

skillsets/ponytail/
  ponytail
  ponytail-review
  ponytail-audit
  ponytail-debt
  ponytail-gain
  ponytail-help

skillsets/superpowers/
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

## muon_subagent

Use for one-off transparent delegation. Exactly one mode must be supplied.

### Agent-defined subagent skills

Muon agents can declare an explicit skill catalog in agent frontmatter:

```md
---
name: worker
description: Implements code changes
skills: ponytail
---
```

When `skills` is set, Muon launches that subagent with only the declared skill roots. Currently supported values:

- `ponytail`

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
