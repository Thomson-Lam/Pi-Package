---
name: using-muon
description: >
  Use as this a manual for using all development tasks and standard workflow
  practices, including planning, brainstorming, review, debugging, execution,
  verification, and orchestration
---

# Using Muon

Muon integrates 2 skill based workflows, Ponytail and Superpowers, into a
unified layer:

- Superpowers: a planning/execution/review framework + modular skills that can
  be used, using subagents for implementation when available while the main
  agent orchestrates. Skills include:
  - superpowers-brainstorming
  - dispatching-parallel-agents
  - executing-plans
  - finishing-a-development-branch
  - requesting-code-review
  - receiving-code-review
  - subagent-driven-development
  - systematic-debugging
  - test-driven-development
  - using-git-worktrees
  - using-superpowers
  - verification-before-completion
  - writing-plans
  - writing-skills

Invoke `using-superpowers` for usage.

- Ponytail: an efficient implementation procedure and framework, NOT a
  process-heavy or end-to-end planning to subagent orchestration framework. It
  is designed to complement the execution of Superpower approved tasks after
  planning and delegation: "do the least that actually works, with the smallest
  safe diff". `ponytail` is the main skill, other ponytail skills are prefixed
  by `ponytail-*`.

Invoke `ponytail` for usage.

Muon contains an additional `yagni-scope-guard` skill to complement
superpowers-brainstorming.

Muon routes the active skillset. Catalog visibility means a skill is available;
it does not mean every visible skill should run. If you do not see a skill, then
do not consider that skill available.

## Route

You can invoke any available skill you determine necessary based on the scope of
the task. Example routing to subsequent skills and separation of
responsibilities:

| Task shape                                                                      | Use                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Explicit user skill/mode request                                                | That requested skill or mode                                                          |
| Small answer, read-only check, trivial edit                                     | Answer directly; use ponytail if available for code changes                           |
| Feature/change request with obvious scope                                       | ponytail if available; smallest diff and smallest relevant check                      |
| Concrete code-writing subtask inside an approved Superpowers plan               | ponytail if available; Superpowers plans/orchestrates, Ponytail executes code changes |
| When the execution task is a bug/debugging task, diagnosing unexpected failures | systematic-debugging if available                                                     |
| About to claim a task is complete/fixed/passing                                 | verification-before-completion if available                                           |
| Receiving review feedback                                                       | receiving-code-review if available                                                    |
| Creating/editing/verifying skills                                               | writing-skills if available                                                           |
| Over-engineering review/audit/debt request                                      | ponytail-review/audit/debt if available                                               |
| Large, ambiguous, risky, or multi-step implementation                           | using-superpowers if available                                                        |
| Superpowers brainstorm/plan starts adding speculative scope                     | yagni-scope-guard if available                                                        |

## Rules

- use ponytail skills during the implementation process and code related
  operations, superpowers skills for end to end planning to orchestrating
  implementations.
- Load supporting skills only when their trigger is concrete.
- Prefer the smallest workflow that safely solves the task.
- If no routed skill fits, proceed normally.
