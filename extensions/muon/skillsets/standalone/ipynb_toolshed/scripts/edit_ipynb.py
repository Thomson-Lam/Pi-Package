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
    if args.cell < 0 or args.cell >= len(cells):
        print(f"ERROR: cell index {args.cell} out of range; notebook has {len(cells)} cells", file=sys.stderr)
        return 2

    cell = cells[args.cell]
    current_source = source_text(cell)
    current_hash = source_sha256(cell)
    expected_hash = normalize_expect(args.expect)
    if current_hash != expected_hash:
        print("ERROR: source hash mismatch; refusing to edit stale cell", file=sys.stderr)
        print(f"cell: {args.cell}", file=sys.stderr)
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
    print(f"cell: {args.cell}")
    print(f"cell_type: {cell.get('cell_type', 'unknown')}")
    print(f"old_source_sha256: {current_hash}")
    print(f"new_source_sha256: {new_hash}")
    print(f"apply: {str(args.apply).lower()}")
    print()
    print_diff(notebook_path, args.cell, current_source, new_source)

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write this change.")
        return 0

    cell["source"] = source_to_notebook_shape(new_source, cell.get("source", []))
    if cell.get("cell_type") == "code":
        cell["outputs"] = []
        cell["execution_count"] = None

    try:
        atomic_write_text(notebook_path, dump_notebook(nb))
    except Exception as exc:
        print(f"ERROR: failed to write notebook {notebook_path}: {exc}", file=sys.stderr)
        return 2

    print("\nWrote notebook atomically.")
    print(f"cell: {args.cell}")
    print(f"source_sha256: {new_hash}")
    if cell.get("cell_type") == "code":
        print("outputs_cleared: true")
        print("execution_count_cleared: true")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Safely replace one Jupyter .ipynb cell source. Dry-run by default. Cell numbers are zero-based."
    )
    parser.add_argument("notebook", type=Path, help="Path to the .ipynb notebook")
    parser.add_argument("--cell", type=int, required=True, help="Zero-based cell index to replace")
    parser.add_argument(
        "--expect",
        required=True,
        help="Expected source_sha256 from inspect_ipynb.py. Edit is refused if current cell hash differs.",
    )
    parser.add_argument("--source-file", type=Path, required=True, help="File containing the full replacement cell source")
    parser.add_argument("--apply", action="store_true", help="Actually write the notebook. Without this, only verify and show diff.")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return edit_notebook(args)


if __name__ == "__main__":
    raise SystemExit(main())
