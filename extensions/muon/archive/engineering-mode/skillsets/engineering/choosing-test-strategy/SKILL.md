---
name: choosing-test-strategy
description: >
  Use when selecting evidence for a feature, bug fix, refactor, configuration
  change, UI change, migration, or other work where the appropriate testing
  approach is unclear.
---

# Choosing Test Strategy

Choose evidence that would fail if the important claim were false. Testing is a
risk-control decision, not one required chronology.

## Start from claims and risks

Identify what the change could break and what evidence can observe it. Consider:

- externally visible behavior
- regressions in existing contracts
- integration and configuration wiring
- errors, boundaries, and recovery
- compatibility and persisted data
- performance or resource use
- visual and interactive behavior

Prefer the cheapest evidence that gives meaningful confidence, then add broader
checks where blast radius or uncertainty warrants them.

## Choose the approach

**Test-first** is valuable when desired behavior is crisp, the harness is
available, and the test helps define a useful interface.

**Regression-first** is valuable for a reproducible defect: demonstrate the
symptom against the affected path, then confirm the correction removes it.

**Characterization tests** protect important legacy behavior before changing
code whose contract is only partially documented.

**Integration tests** are appropriate when risk lives in component boundaries,
configuration, serialization, databases, processes, or external protocols.

**Existing-suite verification** may be sufficient for mechanical refactors or
generated changes already covered by meaningful tests.

**Manual or visual checks** may be primary evidence for interaction, layout,
accessibility, hardware, or environment-specific behavior. Record what was
observed and retain automation where it provides future regression value.

**Benchmarks and profiling** are required for performance claims; functional
tests do not establish speed or resource improvement.

## Protect test meaning

A new test should fail for the intended reason when practical. A passing test
that never exercised the changed behavior is weak evidence.

Test behavior and stable contracts rather than incidental implementation. Use
mocks only when a real dependency is impractical or would obscure the behavior
under test. Do not add production hooks solely to make a test convenient.

Do not weaken assertions, delete meaningful coverage, or encode a bug as the new
expectation merely to obtain a pass. Inspect changed tests alongside production
code.

State the limits of the selected evidence. A focused test does not imply the
full suite passed; a build does not prove runtime behavior; a manual check does
not create an automated regression guard.
