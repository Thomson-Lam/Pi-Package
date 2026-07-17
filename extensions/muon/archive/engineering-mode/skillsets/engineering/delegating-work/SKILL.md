---
name: delegating-work
description: >
  Use when considering subagents for independent work, parallel investigation,
  isolated implementation, or consequential independent review.
---

# Delegating Work

Delegate when isolation or independent judgment creates more value than the
handoff costs. Subagents are a tool, not the default unit of development.

## Decide whether to delegate

Delegation is useful when work:

- can be scoped without transferring most of the parent context
- is independent of other active work
- benefits materially from parallel execution
- needs a fresh, independent review perspective
- would otherwise consume the controller's context with mechanical detail

Keep work with the current agent when tasks share files, mutable state, evolving
design decisions, or tightly coupled debugging evidence. Do not split a coherent
change merely to create more agents.

Use one orchestration layer by default. Avoid spawning agents beneath another
agent already coordinating the same task unless the ownership and benefit are
explicit.

## Define a useful boundary

Give a delegate:

- one outcome or problem domain
- the relevant requirements and constraints
- the context needed to start, preferably through file paths
- explicit permissions and prohibited scope
- expected evidence and handoff information

Do not paste the whole conversation when a focused brief and repository sources
are sufficient. Do not make the delegate reconstruct settled decisions.

Parallel delegates should not edit overlapping files, depend on one another's
uncommitted results, or contend for the same external resources. When apparent
independence is uncertain, investigate the dependency before parallelizing.

## Supervise proportionately

Let delegates complete bounded work without routine interruptions. Escalations
about missing context, contradictory requirements, or unexpected risk should
return to the controller rather than being guessed through.

Treat a delegate's report as a claim. Inspect relevant diffs and evidence before
integration. The depth of independent review should match the change's
consequences; a mechanical isolated edit does not need the same review structure
as security, concurrency, migration, or public API work.

After integration, verify the combined result because independently correct
changes can still conflict at their boundaries.
