---
name: using-muon
description: Use when Muon skillsets are enabled and a task needs routing between lean Ponytail work, Superpowers workflows, debugging, verification, review, or skill authoring
---

# Using Muon

Muon routes the active skillset. Catalog visibility means a skill is available; it does not mean every visible skill should run.

## Route

Pick one controlling process first:

| Task shape | Use |
|---|---|
| Explicit user skill/mode request | That requested skill or mode |
| Small answer, read-only check, trivial edit | Answer directly; use ponytail if available for code changes |
| Feature/change request with obvious scope | ponytail if available; smallest diff and smallest relevant check |
| Bug, test failure, unexpected behavior | systematic-debugging if available |
| About to claim complete/fixed/passing | verification-before-completion if available |
| Receiving review feedback | receiving-code-review if available |
| Creating/editing/verifying skills | writing-skills if available |
| Over-engineering review/audit/debt request | ponytail-review/audit/debt if available |
| Large, ambiguous, risky, or multi-step implementation | using-superpowers if available |
| Superpowers brainstorm/plan starts adding speculative scope | yagni-scope-guard if available |

## Skillset boundaries

- **auto:** choose between Ponytail and Superpowers by task size/risk.
- **ponytail:** never invoke Superpowers skills.
- **superpowers:** use Superpowers skills; use yagni-scope-guard for scope creep, not Ponytail.
- **off:** no Muon routing.

## Rules

- One controlling workflow at a time.
- Load supporting skills only when their trigger is concrete.
- Prefer the smallest workflow that safely solves the task.
- If no routed skill fits, proceed normally.
