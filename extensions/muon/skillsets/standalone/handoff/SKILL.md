---
name: handoff
description: Create/update a handoff file for current work and context.
---

# Handoff

Create or update a single handoff markdown artifact for the current repository.

## Invocation values

`/skill:handoff <detail level>`

`<detail level>` selects the template for level of detail the handoff needs:

- `default`: balanced handoff; use this when no value is provided
- `brief`: concise handoff
- `detailed`: fuller handoff with validation and risks

Examples:

- `/skill:handoff` - if no value is provided, go with `default`
- `/skill:handoff brief`
- `/skill:handoff detailed`

Unless the output location is otherwise specified by the user, the file should be written to `docs/handoff/` in the current working directory as `handoff-<subject>.md` and `docs/handoff/` should be added to `.gitignore`. Do not add any specified output locations by the user to `.gitignore`.

Examples:

- `/skill:handoff`: local output, use this when no value provided
- `/skill:handoff detailed`: detailed output

Parse the provided value against the known detail levels. Apply detail level `default` when none is specified by the user. If no values are matched or there are invalid values not recognized here, ask the user for clarifying intent by outputting the below:

# Handoff Usage 

`/skill:handoff <detail level>`

- `/skill:handoff`
- `/skill:handoff brief`
- `/skill:handoff detailed`

`<detail level>`:
- `default`: balanced handoff; use this when no value is provided
- `brief`: concise handoff
- `detailed`: fuller handoff with validation and risks

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

Resolve these paths relative to this skill directory:

- Prompt guidance: `references/prompts/handoff-write.md`
- Templates: `references/templates/*.md`

Before writing a handoff, read the prompt guidance and the selected template as per the parsed instructions.

## Workflow

1. Parse the requested detail level and location, applying defaults when needed.
2. Read `references/prompts/handoff-write.md`.
3. Read the selected `references/templates/<detail-level>.md`.
4. Determine a subject slug from the intended handoff content.
5. Read the existing same-subject handoff file if it exists.
6. Write or update exactly one handoff file; for local/repo: `docs/handoff/handoff-<subject>.md`. Ask the user for output location if the user did not clarify.
6. For local/repo output, add `docs/handoff/` to `.gitignore` if it is not already ignored/listed.
10. Reply briefly with the saved path, selected template, and subject.
