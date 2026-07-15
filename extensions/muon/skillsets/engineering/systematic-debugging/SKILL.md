---
name: systematic-debugging
description: >
  Use when encountering bugs, test failures, build failures, performance
  regressions, flaky behavior, or unexpected runtime results.
---

# Systematic Debugging

Reduce uncertainty before accumulating changes. The next action should produce
information or address a cause supported by evidence.

## Establish the observation

Read the complete error and relevant output. Reproduce the behavior when
practical and record the conditions under which it appears or disappears. Check
recent code, configuration, dependency, data, and environment changes that
could affect those conditions.

If reproduction is unreliable, gather timing, state, input, and boundary
evidence rather than guessing from one occurrence.

## Locate the failing boundary

Trace the affected value, event, or state through the system. In a
multi-component path, inspect what enters and leaves the boundaries most likely
to distinguish the failing component. Start with existing logs and focused
commands; add temporary instrumentation only where it will answer a concrete
question.

Compare the broken path with a nearby working example. Differences are candidate
causes until evidence rules them out.

## Test a hypothesis

State a specific causal hypothesis and why the observations support it. Choose
the smallest experiment that distinguishes it from plausible alternatives.
Change one causal variable at a time when combining changes would hide which
explanation was correct.

If evidence rejects the hypothesis, update the model of the problem. Do not
stack another speculative fix on top of the first.

When the cause is already directly established—for example, an error identifies
a missing symbol and repository history confirms the rename—do not add ceremony
that produces no new information. Correct it and verify the affected behavior.

## Correct and verify

Fix the cause at the narrowest shared source that completely resolves the
problem. Avoid caller-by-caller symptom guards when one upstream invariant is
wrong. Keep unrelated cleanup separate.

Choose a regression check appropriate to the defect. Automated reproduction is
preferred when stable and valuable; integration, manual, diagnostic, or
environmental evidence may be more suitable for failures that cannot be isolated
cheaply.

After repeated failed approaches, reassess architecture, assumptions,
environment, and observability before trying another variation. Ask the user
when progress now depends on an architectural choice, unavailable authority,
risk acceptance, or missing product intent. Otherwise continue with a revised,
evidence-producing investigation.
