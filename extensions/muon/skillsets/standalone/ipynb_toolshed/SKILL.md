---
name: ipynb-toolshed
description: Read and edit toolshed for working with ipynb efficiently over handling raw JSON.
---

# ipynb Toolshed
Use this skill for `.ipynb` files, and for invoking the bundled CLIs over reading or editing raw notebook JSON. 

## Scripts
The scripts live next to this `SKILL.md` in `scripts/`. Resolve relative paths from the skill directory and use that absolute path from any project directory. In examples, `<PATH>` is the absolute path to this skill's `scripts/` directory.

Available scripts:
- `inspect_ipynb.py`: compact reader; prints cell indexes and source_sha256 edit handles
- `edit_ipynb.py`: safe writer; replaces one whole cell source by cell index + expected hash

Cell numbers are zero-based. For help with usage, invoke:
```bash
uv run python <PATH>/inspect_ipynb.py --help
uv run python <PATH>/edit_ipynb.py --help
```

## Read workflow
Flags:
- `inspect_ipynb.py NOTEBOOK` = summary of all cells
- `--cells 6` = one zero-based cell
- `--cells 6:11` = zero-based Python slice, end-exclusive
- `--cells 6-10` = inclusive range
- `--errors` = include cells with error outputs
- `--budget 20000` = larger output budget if truncated

Show a compact summary of all cells:
```bash
uv run python <PATH>/inspect_ipynb.py path/to/notebook.ipynb
```

Show selected cells with source, useful text outputs, errors, and stable edit handles:
```bash
uv run python <PATH>/inspect_ipynb.py path/to/notebook.ipynb --cells 6:11
```

Show only cells with error outputs, including tracebacks:
```bash
uv run python <PATH>/inspect_ipynb.py path/to/notebook.ipynb --errors
```

Show selected cells plus any error cells:
```bash
uv run python <PATH>/inspect_ipynb.py path/to/notebook.ipynb --cells 6:11 --errors
```

Use a larger output budget only when the default truncates needed context:
```bash
uv run python <PATH>/inspect_ipynb.py path/to/notebook.ipynb --cells 6:11 --budget 20000
```

Reader output for each detailed cell includes:
```text
cell: 6
cell_type: code
cell_id: abc123
source_sha256: <hash>
source_chars: 1234
outputs: 2
has_error: false
```

Keep `cell` and `source_sha256` when planning an edit.

## Write workflow
Flags:
- `edit_ipynb.py NOTEBOOK`: target ipynb file to edit
- `--cell 6`: zero-based cell index to replace
- `--expect HASH`: required source_sha256 from inspect_ipynb.py; prevents stale edits
- `--source-file /tmp/new_cell.py`: file containing the full replacement cell source
- `--apply`: for actually writing the change; the script only dry-runs and prints a diff without this flag

Important behavior:
- Supports only replacing the entire cell source, not a partial snippet.
- Dry-run by default.
- Refuses to edit if --expect does not match the current cell hash returned by the reader.
- On applying edits to code cells, clears outputs and execution_count.

Write workflow sample usage:

1. Inspect the target cell and copy its `source_sha256`:

```bash
uv run python <PATH>/inspect_ipynb.py path/to/notebook.ipynb --cells 6
```

2. Write the complete replacement cell source to a temporary file:

```bash
cat > /tmp/notebook_cell_6.py <<'PY'
# complete replacement source for cell 6
print("hello")
PY
```

3. Dry-run the edit. This verifies the hash and prints a unified diff without writing:

```bash
uv run python <PATH>/edit_ipynb.py \
  path/to/notebook.ipynb \
  --cell 6 \
  --expect SOURCE_SHA256_FROM_READER \
  --source-file /tmp/notebook_cell_6.py
```

4. Apply only after the dry-run diff is correct:

```bash
uv run python <PATH>/edit_ipynb.py \
  path/to/notebook.ipynb \
  --cell 6 \
  --expect SOURCE_SHA256_FROM_READER \
  --source-file /tmp/notebook_cell_6.py \
  --apply
```

5. Re-read the cell to verify:

```bash
uv run python <PATH>/inspect_ipynb.py path/to/notebook.ipynb --cells 6
```

For code cells, applying an edit automatically clears stale `outputs` and `execution_count`.

## Notes
- Do not use Pi's native `edit` or `write` tools directly on `.ipynb` unless raw JSON editing is explicitly required.
- Prefer full-cell replacement over small text replacements inside raw JSON.
- Use the reader's `source_sha256` as the write precondition to avoid stale edits.
- `--cells 6:11` is end-exclusive, like Python `range(6, 11)`.
- Hyphen ranges such as `--cells 6-10` are inclusive.
