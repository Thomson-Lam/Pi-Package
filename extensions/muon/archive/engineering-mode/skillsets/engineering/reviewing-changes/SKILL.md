---
name: reviewing-changes
description: >
  Use when evaluating a consequential diff or review feedback, or when an
  independent correctness and scope check would materially reduce risk.
---

# Reviewing Changes

Review the artifact against its requirements and real integration context. A
review is an independent attempt to find consequential gaps, not a requirement
to produce criticism.

## Establish the contract

Identify the requested behavior, binding constraints, accepted design decisions,
and evidence expected for the change. Then inspect the actual diff and relevant
surrounding code. Do not review only a summary supplied by the implementer.

Prioritize findings that affect:

- correctness and requirement coverage
- data loss, security, privacy, or permissions
- callers, compatibility, and integration boundaries
- errors, concurrency, cleanup, and recovery
- tests that fail to exercise the behavior or were weakened
- accidental scope and unnecessary complexity
- operability, migration, and rollback where relevant

Distinguish defects from optional improvements. Avoid requesting abstractions,
configuration, or polish without a demonstrated requirement or maintenance
benefit.

## Make findings actionable

For each material finding, identify the affected location or behavior, the
condition that triggers the problem, and its consequence. Ground it in code,
requirements, or reproducible evidence. State uncertainty when more
investigation is needed.

Do not inflate severity to force attention. Do not bury important findings in a
large list of style preferences. If no consequential issue is found, say so
without inventing one.

## Evaluate received feedback

Treat external review comments as hypotheses to verify against this codebase.
Clarify feedback whose intended behavior or scope is ambiguous. Check whether a
suggestion breaks existing contracts, conflicts with user decisions, assumes a
different platform, or adds unused capability.

Implement valid feedback with appropriate verification. Push back on incorrect
or disproportionate feedback using technical evidence. Return unresolved
product or architectural conflicts to the user rather than silently choosing a
side.

Review depth should match risk. Small mechanical changes may need only direct
inspection and focused checks; public interfaces, migrations, security,
concurrency, and broad refactors justify independent review and wider evidence.
