#!/usr/bin/env python3
"""Safely replace a Jupyter notebook cell source by cell index + hash.

Pairs with inspect_ipynb.py. The reader prints source_sha256; this writer
requires that hash before it will modify a cell, preventing stale edits.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import random
import string
import sys
import tempfile
from pathlib import Path
from typing import Iterable


def join_maybe(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "".join(str(x) for x in value)
    return str(value)


def source_text(cell: dict) -> str:
    return join_maybe(cell.get("source", []))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def source_sha256(cell: dict) -> str:
    return sha256_text(source_text(cell))


def normalize_expect(value: str) -> str:
    value = value.strip()
    if value.startswith("sha256="):
        value = value[len("sha256=") :]
    if value.startswith("sha256:"):
        value = value[len("sha256:") :]
    return value


def source_to_notebook_shape(new_source: str, old_source) -> str | list[str]:
    """Preserve the existing source representation where possible."""
    if isinstance(old_source, list):
        return new_source.splitlines(keepends=True)
    return new_source


def new_cell_id() -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(8))


def make_cell(cell_type: str, source: str) -> dict:
    cell = {
        "cell_type": cell_type,
        "id": new_cell_id(),
        "metadata": {},
        "source": source.splitlines(keepends=True),
    }
    if cell_type == "code":
        cell["execution_count"] = None
        cell["outputs"] = []
    return cell


def atomic_write_text(path: Path, text: str) -> None:
    path = path.resolve()
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def load_notebook(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_notebook(nb: dict) -> str:
    # Jupyter notebooks commonly use indent=1. ensure_ascii=False keeps source readable.
    return json.dumps(nb, ensure_ascii=False, indent=1) + "\n"


def print_diff(notebook: Path, cell_index: int, old_source: str, new_source: str) -> None:
    old_name = f"{notebook}:cell[{cell_index}]:old"
    new_name = f"{notebook}:cell[{cell_index}]:new"
    diff = difflib.unified_diff(
        old_source.splitlines(keepends=True),
        new_source.splitlines(keepends=True),
        fromfile=old_name,
        tofile=new_name,
    )
    rendered = "".join(diff)
    print(rendered if rendered else "[no source changes]")


def print_insert_preview(notebook: Path, insert_index: int, cell_type: str, source: str) -> None:
    print(f"--- {notebook}:insert cell[{insert_index}] {cell_type} ---")
    print(source if source else "[empty source]")


def edit_notebook(args: argparse.Namespace) -> int:
    notebook_path = args.notebook
    try:
        nb = load_notebook(notebook_path)
    except Exception as exc:
        print(f"ERROR: failed to read/parse notebook {notebook_path}: {exc}", file=sys.stderr)
        return 2

    cells = nb.get("cells", []) or []
    if not isinstance(cells, list):
        print(f"ERROR: notebook cells field is not a list: {notebook_path}", file=sys.stderr)
        return 2
    anchor = args.cell if args.cell is not None else args.insert_before if args.insert_before is not None else args.insert_after
    if anchor is None:
        print("ERROR: choose --cell, --insert-before, or --insert-after", file=sys.stderr)
        return 2
    if anchor < 0 or anchor >= len(cells):
        print(f"ERROR: cell index {anchor} out of range; notebook has {len(cells)} cells", file=sys.stderr)
        return 2
    if args.cell is None and args.cell_type is None:
        print("ERROR: --cell-type is required for insertion", file=sys.stderr)
        return 2

    cell = cells[anchor]
    current_source = source_text(cell)
    current_hash = source_sha256(cell)
    expected_hash = normalize_expect(args.expect)
    if current_hash != expected_hash:
        print("ERROR: source hash mismatch; refusing stale notebook edit", file=sys.stderr)
        print(f"anchor_cell: {anchor}", file=sys.stderr)
        print(f"expected: {expected_hash}", file=sys.stderr)
        print(f"actual:   {current_hash}", file=sys.stderr)
        print("Re-run inspect_ipynb.py for this cell and retry with the current source_sha256.", file=sys.stderr)
        return 3

    try:
        new_source = args.source_file.read_text(encoding="utf-8")
    except Exception as exc:
        print(f"ERROR: failed to read source file {args.source_file}: {exc}", file=sys.stderr)
        return 2

    new_hash = sha256_text(new_source)
    print(f"notebook: {notebook_path}")
    print(f"anchor_cell: {anchor}")
    print(f"anchor_cell_type: {cell.get('cell_type', 'unknown')}")
    print(f"anchor_source_sha256: {current_hash}")
    print(f"new_source_sha256: {new_hash}")
    print(f"apply: {str(args.apply).lower()}")
    print()

    if args.cell is not None:
        print(f"operation: replace")
        print_diff(notebook_path, args.cell, current_source, new_source)
    else:
        insert_index = anchor if args.insert_before is not None else anchor + 1
        cell_type = args.cell_type
        print(f"operation: insert")
        print(f"insert_index: {insert_index}")
        print(f"new_cell_type: {cell_type}")
        print_insert_preview(notebook_path, insert_index, cell_type, new_source)

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write this change.")
        return 0

    if args.cell is not None:
        cell["source"] = source_to_notebook_shape(new_source, cell.get("source", []))
        if cell.get("cell_type") == "code":
            cell["outputs"] = []
            cell["execution_count"] = None
    else:
        cells.insert(insert_index, make_cell(args.cell_type, new_source))

    try:
        atomic_write_text(notebook_path, dump_notebook(nb))
    except Exception as exc:
        print(f"ERROR: failed to write notebook {notebook_path}: {exc}", file=sys.stderr)
        return 2

    print("\nWrote notebook atomically.")
    if args.cell is not None:
        print(f"cell: {args.cell}")
        print(f"source_sha256: {new_hash}")
        if cell.get("cell_type") == "code":
            print("outputs_cleared: true")
            print("execution_count_cleared: true")
    else:
        print(f"inserted_cell: {insert_index}")
        print(f"cell_type: {args.cell_type}")
        print(f"source_sha256: {new_hash}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Safely replace or insert Jupyter .ipynb cells. Dry-run by default. Cell numbers are zero-based."
    )
    parser.add_argument("notebook", type=Path, help="Path to the .ipynb notebook")
    op = parser.add_mutually_exclusive_group(required=True)
    op.add_argument("--cell", type=int, help="Zero-based cell index to replace")
    op.add_argument("--insert-before", type=int, help="Insert a new cell before this zero-based anchor cell")
    op.add_argument("--insert-after", type=int, help="Insert a new cell after this zero-based anchor cell")
    parser.add_argument("--cell-type", choices=["code", "markdown", "raw"], help="Cell type for insertion")
    parser.add_argument(
        "--expect",
        required=True,
        help="Expected source_sha256 of the target/anchor cell from inspect_ipynb.py. Edit is refused if it differs.",
    )
    parser.add_argument("--source-file", type=Path, required=True, help="File containing the replacement or inserted cell source")
    parser.add_argument("--apply", action="store_true", help="Actually write the notebook. Without this, only verify and show diff.")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return edit_notebook(args)


if __name__ == "__main__":
    raise SystemExit(main())
