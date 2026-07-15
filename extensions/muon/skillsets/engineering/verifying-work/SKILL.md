---
name: verifying-work
description: >
  Use when about to claim implementation is complete, fixed, passing, or safe.
---

# Verifying Work

Match every completion claim to fresh evidence that can actually support it.
Confidence, code inspection, and delegated reports are not substitutes for
observation.

## Verify the requested outcome

Re-read the material requirements and inspect the final change set. Check for:

- missed requirements or unresolved decisions
- accidental scope expansion
- unintended file or dependency changes
- tests changed in ways that weaken their meaning
- migration, compatibility, security, or operational effects relevant to the
  work

Choose commands or observations that prove the claims you intend to make. Run
focused checks for the changed behavior and broader checks when integration or
blast radius warrants them. Read exit status and meaningful output rather than
assuming a command completed successfully.

Different evidence supports different claims:

- a focused test supports the behavior it exercises
- a full test suite supports only the covered suite
- a build supports compilation or packaging, not runtime correctness
- static checks support the properties they analyze
- a manual check supports the observed environment and path
- a benchmark supports a performance claim only under its measured conditions

## Handle imperfect evidence honestly

If a check fails, report the actual state and continue fixing or investigating
as appropriate. If a tool is unavailable, flaky, too costly, or blocked, state
the limitation and the strongest evidence obtained instead of implying the
missing result.

For delegated work, inspect the relevant diff and independently confirm evidence
proportionate to the risk. For regression coverage, confirm the check would
detect the original defect when practical.

Report completion concisely with the material verification performed and any
remaining limitations. Do not claim safety, correctness, or readiness beyond
what the evidence establishes.
