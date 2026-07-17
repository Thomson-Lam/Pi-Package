---
name: brainstorming
description: >
  Use when a requested change has unresolved product behavior, competing valid
  designs, unclear success criteria, or consequential requirements that
  repository evidence cannot settle.
---

# Brainstorming

Surface the few decisions that materially shape the outcome. Brainstorming is
for unresolved intent, not a ceremony before every change.

## First reduce uncertainty

Inspect relevant project context before asking the user questions. Separate:

- facts discoverable from code, tests, documentation, history, or experiments
- low-impact defaults implied by project conventions
- decisions that encode product intent, risk acceptance, or lasting commitments

Resolve the first category yourself. Choose sensible, reversible defaults for
the second. Bring only the third category to the user.

## Find consequential omissions

Examine the risk surfaces relevant to the request, such as:

- users and observable behavior
- callers, interfaces, and compatibility
- state, persistence, migration, and rollback
- errors, cancellation, concurrency, and partial failure
- permissions, privacy, and external effects
- operations, observability, and recovery

Do not mechanically discuss every category. Use the scan to find assumptions
whose answers could materially change the design.

## Collaborate on decisions

Ask after enough reconnaissance to make the question useful. Explain what is
known, what remains unresolved, and the consequences of viable choices. Batch
closely related decisions when they share context.

Offer alternatives only when more than one approach is genuinely competitive.
Lead with a recommendation when evidence supports one; otherwise state what
would distinguish the choices.

A decision needs explicit user input when it changes product policy, public
behavior, compatibility, data handling, security posture, operational burden,
irreversibility, or project scope. Routine engineering mechanics remain yours
to resolve.

## Stop brainstorming

Stop when another engineer could proceed without inventing material user-owned
decisions. The result may be a short clarified direction or a durable design,
depending on risk and complexity.

Do not require approval merely because an approach was discussed. Do not create
a specification, plan, or commit unless the user requests one or durable
coordination materially benefits the work.
