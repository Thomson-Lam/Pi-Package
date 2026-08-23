---
name: cindex
description: Create or update INDEX.md files for codebase navigation.
---

## Procedure
1. Identify what the user wants to index.
2. Find and use nearby existing `INDEX.md` files before reading broader code.
3. Treat code as single source of truth and read them directly; do not infer behavior only from existing docs.
4. Decide whether an index update is warranted by whether there are new, removed, or changed files that would render existing indexes stale.
5. Update the nearest relevant `INDEX.md` files. Create a new `INDEX.md` only when a directory is a meaningful subsystem or boundary.

## INDEX.md Style
Each index must follow this structure and keep the index as minimal as possible:

```md
# <directory or subsystem> index

Description: <what this index contains and points to in under 20 words>

Components:
- `<path (+ line; optional)>` — <brief description of what each file is>

Related:
- `<relative/path/INDEX.md>`
```

You must follow the fields and structure above. Treat the structure above as a guideline you must follow, not a template to fill. Create at most these fields and select only the fields warranted; omit the fields where there is nothing to say for rather than adding duplicate content for padding. Do not add any textual invariants, boundaries, and narratives in natural language that may result in drift. Only directly report concisely the components (files).

## Include
- primary entry points, key files, and why they matter
- related downstream/child indexes or neighboring subsystems

## Avoid
- long architecture essays
- long natural language descriptions and facts
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
When an existing index conflicts with source code, update the index to match source code. Do not modify source code merely to match an index.
