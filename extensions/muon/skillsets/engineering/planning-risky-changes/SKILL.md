---
name: planning-risky-changes
description: >
  Use when the user explicitly requests a durable plan, when a handoff or
  multi-session effort needs preserved decisions, or when preparing a plan for
  a cross-cutting, migration-heavy, operationally sensitive, or high-risk change.
---

# Planning Risky Changes

Create a decision and coordination artifact, not a transcript of imagined edits.
A useful plan preserves intent while allowing implementation evidence to change
the route.

## Establish the planning basis

Inspect the relevant system before fixing the plan's structure. Capture:

- the requested outcome and success evidence
- binding constraints and invariants
- affected components, consumers, and integration boundaries
- assumptions already confirmed by repository evidence
- unresolved decisions and who owns them
- principal failure modes and blast radius

If a material requirement remains user-owned, resolve it before presenting the
plan as executable. Do not fill product or risk decisions with convenient
engineering guesses.

## Plan at the level of risk

Describe enough structure to coordinate the work:

- intended approach and important alternatives rejected
- change boundaries and dependencies
- data, API, compatibility, and migration effects
- rollout, rollback, and recovery where relevant
- verification strategy and meaningful checkpoints
- conditions that should trigger replanning or escalation

Use exact paths, interfaces, commands, or ordering only when they are known and
binding. Do not fabricate implementation detail to make the plan appear
complete. Avoid embedding full code unless an exact snippet is itself a
requirement or interface contract.

Tasks should represent coherent, reviewable outcomes. Do not decompose work into
mechanical minute-scale steps that a capable implementer can infer.

## Preserve adaptability

Mark consequential uncertainty instead of hiding it. Distinguish:

- decisions fixed by requirements
- current implementation hypotheses
- details intentionally left to local judgment

A plan is invalidated when new evidence contradicts its assumptions, changes its
risk, or reveals a better route to the same outcome. Update it rather than
forcing execution to conform.

## When a durable plan is unnecessary

Do not create a plan file for a small, clear, reversible change; a short-lived
internal direction is sufficient. Persist a plan when another worker needs a
handoff, the work spans sessions, rollback matters, or losing decisions would
create material risk.
