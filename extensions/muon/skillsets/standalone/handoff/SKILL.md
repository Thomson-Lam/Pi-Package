---
name: handoff
description: Create/update minimal handoff context and TODO ledger files for agent-to-agent continuation.
---

# Handoff

Create or update exactly two markdown artifacts for the current repository:

1. `docs/handoff/handoff-<subject>.md`
2. `docs/handoff/handoff-<subject>.todos.md`

Also ensure `docs/handoff/` is listed in `.gitignore` unless the user explicitly requested another output location.

## Subject slug

Determine a short semantic subject from the current work. Use lowercase, filesystem-safe text, max 3 words.

Examples:

- `muon-handoff`
- `plan-guardrails`
- `review-cli`

## Handoff file

The handoff file contains only important file context.

Format:

```markdown
# Handoff: <subject>

- `path/to/file.ts` - one-line purpose and why it matters
- `path/to/other.ts` - one-line purpose and why it matters
```

Rules:

- Include only the files a future agent truly needs to know about.
- Each bullet must be one line.
- Do not include current state, decisions, constraints, logs, or next steps here.
- Put all state and steering information in the TODO file instead.

## TODO file

The TODO file contains the actual continuation steering.

Format:

```markdown
# TODO: <subject>

- [ ] T001 Task title
  - Context: current state, decisions, constraints
  - Done when: concrete success condition

- [ ] T002 Task title
  - Context: current state, decisions, constraints
  - Done when: concrete success condition
```

Rules:

- Put all current state, decisions, constraints, risks, and next actions in TODO task context.
- Keep tasks concrete and ordered.
- Prefer fewer high-signal tasks over exhaustive notes.
- If updating an existing same-subject handoff, preserve useful unfinished TODOs and remove stale ones.

## Workflow

1. Determine subject slug.
2. Create `docs/handoff/` if needed.
3. Read existing same-subject handoff and TODO files if present.
4. Write/update the handoff file using only file bullets.
5. Write/update the TODO file using checkbox tasks.
6. Ensure `.gitignore` contains `docs/handoff/` for local/repo output.
7. Reply briefly with both saved paths.
