---
description: Turn a completed product spec into actionable GitHub issues
argument-hint: "<spec-file> [OWNER/REPO]"
---
Turn the completed spec at `$1` into actionable GitHub issues for `${2:-the current repository}`.

This workflow must run in a fresh Muon Build session with the `github-issues-prs` skill enabled. If either is unavailable, stop and tell me to run:

1. `/muon skills on github-issues-prs`
2. `/build`
3. `/spec-to-issues $@`

Then:

1. Read the entire spec and treat its scope, goals, items, success criteria, and antirequisites as the source of truth.
2. Use the `github-issues-prs` skill to identify the target repository and list open issues before drafting, so existing work is not duplicated.
3. Convert the spec into the smallest useful set of independently deliverable issues. Merge tightly coupled or trivial items; split items only when separate ownership, sequencing, or validation requires it. Do not invent product requirements.
4. For each proposed issue provide:
   - actionable title
   - context and intended outcome
   - in-scope work
   - acceptance criteria
   - explicit non-goals
   - dependencies or ordering, if any
5. Flag duplicates, unresolved product decisions, and blockers separately. Do not turn them into implementation issues without confirmation.
6. Present the complete ordered issue set for review. Do not create anything yet.
7. After the user approves or revises the set with you, create the approved issues with the skill's bundled `github-md` wrapper and return every issue URL.
