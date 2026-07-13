---
name: using-muon
description: >
  Use when choosing between Muon skill profiles, or when both Ponytail and
  Superpowers are available and the task needs light routing guidance.
---

# Using Muon

Muon exposes skill profiles. A profile makes a group of skills visible; visible means available, not mandatory. If a skill is not visible, do not route to it.

## Profiles

**Ponytail** is for concrete implementation and simplification: smallest safe diff, reuse existing code, stdlib/native first, no speculative abstractions.

Skills:

- ponytail
- ponytail-review
- ponytail-debt

**Superpowers** is for process-heavy work: brainstorming, planning, TDD, debugging, worktrees, subagents, execution plans, verification, and reviews.

Skills:

- using-superpowers
- superpowers-brainstorming
- writing-plans
- executing-plans
- subagent-driven-development
- dispatching-parallel-agents
- test-driven-development
- systematic-debugging
- verification-before-completion
- requesting-code-review
- receiving-code-review
- using-git-worktrees
- finishing-a-development-branch
- writing-skills

## Route

Prefer the smallest workflow that safely solves the task, and invoke the following skills if available. If there is no matching visible skill, proceed as normal.

- Small answer/read-only/trivial edit: answer directly; use ponytail for code changes.
- Clear implementation task: ponytail.
- Large, ambiguous, risky, or multi-step tasks and planning: using-superpowers, yagni-scope-guard.
- multi-agent orchestration for tasks: using-supepowers.
- Bugs, tests, reviews, skill edits, and completion checks: use the matching visible skill from the ledger.
