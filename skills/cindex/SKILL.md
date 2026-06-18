---
name: cindex
description: Create, update, or audit lightweight INDEX.md file navigation pointers for both humans and agents to know where to look when navigating the codebase.
disable-model-invocation: true
---

# Code Index

Maintain lightweight `INDEX.md` files that help humans steer agents through a codebase. The source code remains the single source of truth; indexes are navigation maps, not dense documentation.

## Invocation
The user should invoke this skill manually:
```text
/skill:cindex staged
/skill:cindex unstaged
/skill:cindex src/auth
/skill:cindex audit src
/skill:cindex prefix <NAME>
/skill:cindex ignore <FILES>
```

## Scope
Determine the indexing scope from the user's argument:
- `staged`: inspect `git diff --cached --name-only` and relevant staged diffs.
- `unstaged`: inspect `git diff --name-only` and relevant unstaged diffs.
- `changed`: inspect both staged and unstaged changed files.
- `audit <path>`: inspect existing index coverage and report gaps before editing.
- `<path>`: inspect specified directory, package, module, or subtree.

The user may attach additional instructions after the skill invocation, such as:
- `prefix <NAME>`: prefix all `INDEX.md` files with `<NAME>_`
- `ignore <FILES>`: do not read and index the files specified

If the scope is ambiguous, ask for user intent and clarity.

## Procedure
1. Identify relevant changed files or target directories.
2. Find nearby existing `INDEX.md` files before reading broader code.
3. Read the source files directly; do not infer behavior only from existing docs.
4. Decide whether an index update is warranted. Prefer no edit for purely mechanical changes that do not affect navigation, entry points, invariants, or test layout.
5. Update the nearest relevant `INDEX.md` files. Create a new `INDEX.md` only when a directory is a meaningful subsystem or navigation boundary.
6. Keep edits small, factual, and easy to review.
7. Summarize which indexes were changed and why.

## INDEX.md Style
Each index should be concise. Prefer this structure when useful:

```md
# <directory or subsystem> index

Description: <what this index contains and points to>
Purpose: <high-level purpose of the code pointed to by this index>

Components:
- `<path (+ line; optional)>` — <brief description>

Tests:
- `<test-file-or-directory>` — <coverage area>

Related Indexes:
- `<relative/path/INDEX.md>` - <description of index>
```

Use only sections that add value. Omit empty sections or sections that do not yet exist. If there are no related indexes or related tests, do not make any sections for them.

## Include
- subsystem purpose in one short sentence
- primary entry points
- key files or lines in files, and why they matter
- important invariants, boundaries, or ownership rules
- test locations
- related downstream/child indexes or neighboring subsystems
- generated-code warnings, if relevant

## Avoid
- long architecture essays
- duplicated implementation details 
- API reference material
- speculative explanations
- stale examples
- exhaustive file listings: be concise and list important, distinctly different components worth noting
- changelog-style history
- comments about the indexing process itself

## Placement Rules
- Prefer one `INDEX.md` at meaningful subsystem boundaries over indexes in every folder.
- If a child subsystem has distinct entry points or invariants, it may have its own index.
- Link between parent and child indexes using relative paths.
- Do not create indexes inside generated, vendored, build-output, dependency, or cache directories.

## Source of Truth Rule
When an existing index conflicts with source code, update the index to match source code. Do not modify source code merely to match an index unless the user explicitly asks.

## Audit Mode
When asked to audit instead of update:

1. List discovered `INDEX.md` files.
2. Identify important subsystems without indexes.
3. Identify indexes that appear stale, overly dense, or too implementation-heavy.
4. Recommend specific index additions or edits.
5. Do not edit files unless the user approves or explicitly requested updates.
