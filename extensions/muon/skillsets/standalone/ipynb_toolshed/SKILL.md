---
name: ipynb-toolshed
description: Read and edit toolshed for working with ipynb efficiently over handling raw JSON.
---

# ipynb Toolshed

Use this skill for `.ipynb` files. Prefer the bundled CLIs over reading or editing raw notebook JSON.

## Scripts

The scripts live next to this `SKILL.md` in `scripts/`. Resolve relative paths from the skill directory and use that absolute path from any project directory. In examples, `<PATH>` is the absolute path to this skill's `scripts/` directory.

Available scripts:
- `inspect_ipynb.py`: compact reader/searcher; prints cell indexes and source_sha256 edit handles
- `edit_ipynb.py`: safe writer; replaces one whole cell source by cell index + expected hash

Cell numbers are zero-based. Use `python3`; no `uv` environment is required.

```bash
python3 <PATH>/inspect_ipynb.py --help
python3 <PATH>/edit_ipynb.py --help
```

## First rule: find before reading

Do not read the whole notebook unless the user explicitly asks. Search or filter first, then inspect exact cells.

Find a source snippet cheaply:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --search-source "fit_transform"
```

Regex-search source, grep-style:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --grep 'model\.(fit|predict)' --where source
```

Search outputs/errors:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --search-output "accuracy"
python3 <PATH>/inspect_ipynb.py notebook.ipynb --grep 'ValueError|Traceback' --where output
```

Search both source and outputs:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --grep 'loss|accuracy' --where both
```

Match output is intentionally compact: cell index, cell type, run state, source hash, line number, and a short matching line.

## Show matched cells and neighbors

After finding a match, render the full matched cell:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --search-source "train_test_split" --show
```

Render matched cells plus nearby context cells:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --grep 'train_test_split' --where source --context-cells 2 --show
```

Without `--show`, `--context-cells` only prints which cells would be included:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --grep 'train_test_split' --context-cells 2
```

## Read selected cells

Summary of all cells:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb
```

Read one cell, a slice, or an inclusive range:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --cells 6
python3 <PATH>/inspect_ipynb.py notebook.ipynb --cells 6:11
python3 <PATH>/inspect_ipynb.py notebook.ipynb --cells 6-10
```

Read only outputs for a selected cell:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --cells 6 --only-outputs
```

Show error cells:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --errors
```

Use a larger output budget only when the default truncates needed context:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --cells 6:11 --budget 20000
```

Detailed cell output includes:

```text
cell: 6
cell_type: code
run_state: run
cell_id: abc123
source_sha256: <hash>
source_chars: 1234
outputs: 2
has_error: false
```

Keep `cell` and `source_sha256` when planning an edit.

## Filter cells

Filter by cell type:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --type code
python3 <PATH>/inspect_ipynb.py notebook.ipynb --type markdown
```

Filter code cells by execution state:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --type code --run
python3 <PATH>/inspect_ipynb.py notebook.ipynb --type code --unrun
```

Filter by outputs:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --type code --has-outputs
python3 <PATH>/inspect_ipynb.py notebook.ipynb --type code --no-outputs
```

Filters combine with search:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --type code --unrun --grep 'TODO|FIXME'
```

## Write workflow

Use `edit_ipynb.py` for safe full-cell source changes. It supports:

- replacing one whole cell
- inserting a new cell before an anchor cell
- inserting a new cell after an anchor cell

It dry-runs by default. Pass `--expect SOURCE_SHA256` from `inspect_ipynb.py` so stale edits are refused.

### Replace a cell

1. Inspect the target cell and copy its `source_sha256`:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --cells 6
```

2. Write the complete replacement cell source to a temporary file:

```bash
cat > /tmp/notebook_cell_6.py <<'PY'
# complete replacement source for cell 6
print("hello")
PY
```

3. Dry-run the edit:

```bash
python3 <PATH>/edit_ipynb.py \
  notebook.ipynb \
  --cell 6 \
  --expect SOURCE_SHA256_FROM_READER \
  --source-file /tmp/notebook_cell_6.py
```

4. Apply only after the dry-run diff is correct:

```bash
python3 <PATH>/edit_ipynb.py \
  notebook.ipynb \
  --cell 6 \
  --expect SOURCE_SHA256_FROM_READER \
  --source-file /tmp/notebook_cell_6.py \
  --apply
```

5. Re-read the cell to verify:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --cells 6
```

For code cells, applying a replacement automatically clears stale `outputs` and `execution_count`.

### Insert a new cell

Find an anchor cell first:

```bash
python3 <PATH>/inspect_ipynb.py notebook.ipynb --search-source "nearby code" --show
```

Then insert before or after the anchor cell index. The agent does not need raw notebook JSON or cell IDs.

Insert a code cell after cell 6:

```bash
cat > /tmp/new_cell.py <<'PY'
# new code cell
print("inserted")
PY

python3 <PATH>/edit_ipynb.py \
  notebook.ipynb \
  --insert-after 6 \
  --expect SOURCE_SHA256_OF_CELL_6 \
  --cell-type code \
  --source-file /tmp/new_cell.py
```

Insert a markdown cell before cell 6:

```bash
cat > /tmp/new_cell.md <<'MD'
## New section
MD

python3 <PATH>/edit_ipynb.py \
  notebook.ipynb \
  --insert-before 6 \
  --expect SOURCE_SHA256_OF_CELL_6 \
  --cell-type markdown \
  --source-file /tmp/new_cell.md \
  --apply
```

Notes:

- `--insert-before 6` inserts at position 6.
- `--insert-after 6` inserts at position 7.
- The script creates valid notebook cell JSON.
- New code cells start with empty outputs and `execution_count: null`.

## Notes

- Do not use Pi's native `edit` or `write` tools directly on `.ipynb` unless raw JSON editing is explicitly required.
- Prefer search/grep/filter before selected-cell reads.
- Prefer user-pasted code snippets over cell IDs; notebook UIs usually hide cell IDs.
- Prefer full-cell replacement over small text replacements inside raw JSON.
- Use the reader's `source_sha256` as the write precondition to avoid stale edits.
- `--cells 6:11` is end-exclusive, like Python `range(6, 11)`.
- Hyphen ranges such as `--cells 6-10` are inclusive.
