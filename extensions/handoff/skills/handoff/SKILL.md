---
name: handoff
description: Create/update a handoff file for current work and context.
disable-model-invocation: true
---

# Handoff

Create or update a single handoff markdown artifact for the current repository.

## Invocation values

`/skill:handoff <detail level> <location>`

`<detail level>` selects the template for level of detail the handoff needs:

- `default`: balanced handoff; use this when no value is provided
- `brief`: concise handoff
- `detailed`: fuller handoff with validation and risks

Examples:

- `/skill:handoff`
- `/skill:handoff brief`
- `/skill:handoff detailed`

`<location>` specifies where the file should be written to:

- `repo`: the default value if no value is provided; write to `docs/handoff/handoff-<subject>.md` in the current project/repository and add `docs/handoff/` to `.gitignore`
- `global`: write to global store, `~/.pi/agent/handoffs/<repo-slug>/handoff-<subject>.md`

Examples:

- `/skill:handoff`: local output, use this when no value provided
- `/skill:handoff repo`: specified local output
- `/skill:handoff global`: global output
- `/skill:handoff detailed global`: detailed global output

Parse each provided value against the known detail levels and locations. Apply defaults when values are omitted: detail level `default`, location `repo`. If no values are matched or there are invalid values not recognized here, ask the user for clarifying intent by outputting the below:

```markdown
# Handoff Usage 

`/skill:handoff <detail level> <location>`

- `/skill:handoff`
- `/skill:handoff brief`
- `/skill:handoff detailed`

`<detail level>`:
- `default`: balanced handoff; use this when no value is provided
- `brief`: concise handoff
- `detailed`: fuller handoff with validation and risks

`<location>`: 
- `repo`: the default value if no value is provided, write to `docs/handoff/handoff-<subject>.md` in the current working directory of the project and add `docs/handoff/` to `.gitignore`
- `global`: write to global store, `~/.pi/agent/handoffs/<repo-slug>/handoff-<subject>.md`
```

Then inquire what the user would like to do. Do NOT edit the existing template and prompt source files.

## Subject slug

Before choosing the target path, determine a short subject string based on the content/purpose of the handoff you are about to write.

Subject rules:

- Use a concise semantic subject, not a timestamp.
- Base it on the handoff content, task, or project area, such as `extension-refactor`, `auth-migration`, `release-status`, or `schema-cleanup`.
- Convert the subject into a filesystem-safe slug:
  - lowercase
  - replace non-alphanumeric runs with `-`
  - trim leading/trailing dashes
  - 3 words max
- The final filename must be `handoff-<subject>.md`.
- If an existing `handoff-<subject>.md` covers the same subject, read and update it. Otherwise write your `handoff-subject>.md` as a new file.

## Source files

Absolute paths:

- Prompt guidance: `~/.pi/agent/extensions/handoff/skills/handoff/references/prompts/handoff-write.md`
- Templates: `~/.pi/agent/extensions/handoff/skills/handoff/references/templates/*.md`

Before writing a handoff, read the prompt guidance and the selected template as per the parsed instructions.

## Repo slug for global `<location>` flag

Determine a stable repo slug before writing the global handoff:

1. Prefer the git repository root from `git rev-parse --show-toplevel`.
2. Prefer the origin remote from `git config --get remote.origin.url` when available.
3. Convert the remote URL or repository root into a filesystem-safe slug:
   - lowercase
   - replace path separators and non-alphanumeric runs with `-`
   - trim leading/trailing dashes
   - keep it readable and stable
4. If git metadata is unavailable, derive the slug from the current working directory path.

## Workflow

1. Parse the requested detail level and location, applying defaults when needed.
2. Read `references/prompts/handoff-write.md`.
3. Read the selected `references/templates/<detail-level>.md`.
4. Determine whether the user requested global or local output; default to local/repo.
5. Determine a subject slug from the intended handoff content.
6. Determine `<repo-slug>` if the location is `global`.
7. Read the existing same-subject handoff file if it exists.
8. Write or update exactly one handoff file:
   - global: `~/.pi/agent/handoffs/<repo-slug>/handoff-<subject>.md`
   - local/repo: `docs/handoff/handoff-<subject>.md`
9. For local/repo output, add `docs/handoff/` to `.gitignore` if it is not already ignored/listed.
10. Reply briefly with the saved path, selected template, and subject.
