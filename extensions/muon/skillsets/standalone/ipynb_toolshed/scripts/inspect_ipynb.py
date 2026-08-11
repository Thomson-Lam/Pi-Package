#!/usr/bin/env python3
"""Inspect Jupyter notebooks without dumping raw .ipynb JSON.

Compact, agent-friendly reader for Jupyter notebooks. It prints stable edit
handles (cell index + source sha256) that pair with edit_ipynb.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

DEFAULT_BUDGET = 12_000
SOURCE_PER_CELL_LIMIT = 3_000
OUTPUT_PER_ITEM_LIMIT = 1_000
TRACEBACK_LIMIT = 4_000
MATCH_LINE_LIMIT = 180


@dataclass(frozen=True)
class Match:
    cell_index: int
    area: str
    start_line: int
    end_line: int
    text: str
    haystack: str


def join_maybe(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "".join(str(x) for x in value)
    return str(value)


def source_text(cell: dict) -> str:
    return join_maybe(cell.get("source", []))


def source_sha256(cell: dict) -> str:
    return hashlib.sha256(source_text(cell).encode("utf-8")).hexdigest()


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated {len(text) - limit} chars]"


class Budget:
    def __init__(self, limit: int):
        self.limit = max(0, limit)
        self.used = 0
        self.exhausted = False

    def add(self, text: str = "") -> bool:
        """Print text if possible. Returns False once budget is exhausted."""
        if self.exhausted:
            return False
        remaining = self.limit - self.used
        if remaining <= 0:
            print("\n...[output budget exhausted]")
            self.exhausted = True
            return False
        if len(text) > remaining:
            print(text[:remaining])
            print("\n...[output budget exhausted]")
            self.used = self.limit
            self.exhausted = True
            return False
        print(text)
        self.used += len(text) + 1
        return True


class JsonTextBudget:
    """Budget notebook text while always allowing valid JSON serialization."""

    def __init__(self, limit: int):
        self.remaining = max(0, limit)
        self.exhausted = False

    def take(self, text: str, per_item_limit: int) -> str:
        text = truncate(text, per_item_limit)
        if not text:
            return text
        if self.remaining <= 0:
            self.exhausted = True
            return ""
        if len(text) <= self.remaining:
            self.remaining -= len(text)
            return text
        omitted = len(text) - self.remaining
        kept = text[: self.remaining]
        self.remaining = 0
        self.exhausted = True
        return kept + f"\n...[truncated {omitted} chars; output budget exhausted]"


def parse_cell_selector(selector: str, total: int) -> set[int]:
    """Parse zero-based selectors: '6', '6:11', '6-10', '1,3,5:8'."""
    result: set[int] = set()
    for part in selector.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            bits = part.split(":")
            if len(bits) > 3:
                raise ValueError(f"Invalid cell slice: {part!r}")
            start = int(bits[0]) if bits[0].strip() else None
            end = int(bits[1]) if len(bits) > 1 and bits[1].strip() else None
            step = int(bits[2]) if len(bits) > 2 and bits[2].strip() else None
            result.update(range(total)[slice(start, end, step)])
        elif "-" in part and not part.startswith("-"):
            start_s, end_s = [x.strip() for x in part.split("-", 1)]
            start, end = int(start_s), int(end_s)
            lo, hi = sorted((start, end))
            result.update(i for i in range(lo, hi + 1) if 0 <= i < total)
        else:
            idx = int(part)
            if 0 <= idx < total:
                result.add(idx)
    return result


def outputs(cell: dict) -> list[dict]:
    raw = cell.get("outputs", []) or []
    return raw if isinstance(raw, list) else []


def output_text(cell: dict) -> str:
    chunks: list[str] = []
    for out in outputs(cell):
        otype = out.get("output_type", "")
        if otype == "error":
            chunks.append(str(out.get("ename", "")))
            chunks.append(str(out.get("evalue", "")))
            chunks.append("\n".join(out.get("traceback", []) or []))
        elif otype == "stream":
            chunks.append(join_maybe(out.get("text", [])))
        elif otype in {"execute_result", "display_data"}:
            data = out.get("data", {}) or {}
            chunks.append(join_maybe(data.get("text/plain", "")))
    return "\n".join(chunk for chunk in chunks if chunk)


def has_error(cell: dict) -> bool:
    return any(o.get("output_type") == "error" for o in outputs(cell))


def is_run_code(cell: dict) -> bool:
    return cell.get("cell_type") == "code" and cell.get("execution_count") is not None


def run_state(cell: dict) -> str:
    if cell.get("cell_type") != "code":
        return "-"
    return "run" if is_run_code(cell) else "unrun"


def first_nonempty_line(text: str) -> str:
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def cell_metadata(i: int, cell: dict) -> dict:
    src = source_text(cell)
    return {
        "cell": i,
        "cell_type": cell.get("cell_type", "unknown"),
        "run_state": run_state(cell),
        "cell_id": cell.get("id") or None,
        "source_sha256": source_sha256(cell),
        "source_chars": len(src),
        "output_count": len(outputs(cell)),
        "has_error": has_error(cell),
    }


def summary_record(i: int, cell: dict) -> dict:
    record = cell_metadata(i, cell)
    record["preview"] = first_nonempty_line(source_text(cell))[:140]
    return record


def summary_line(i: int, cell: dict) -> str:
    src = source_text(cell)
    outs = outputs(cell)
    err = " ERROR" if has_error(cell) else ""
    cell_id = cell.get("id", "")
    first = first_nonempty_line(src)
    return (
        f"{i}: {cell.get('cell_type', 'unknown')} {run_state(cell)} "
        f"id={cell_id or '-'} sha256={source_sha256(cell)} "
        f"source_chars={len(src)} outputs={len(outs)}{err} :: {first[:140]}"
    )


def render_outputs(cell: dict, budget: Budget) -> None:
    for oi, out in enumerate(outputs(cell)):
        otype = out.get("output_type", "unknown")
        if otype == "error":
            header = f"--- ERROR output {oi}: {out.get('ename', '')} {out.get('evalue', '')} ---"
            tb = "\n".join(out.get("traceback", []) or [])
            if not budget.add(header):
                return
            if not budget.add(truncate(tb, TRACEBACK_LIMIT)):
                return
        elif otype == "stream":
            text = join_maybe(out.get("text", []))
            if text:
                if not budget.add(f"--- stream output {oi} ({out.get('name', 'stream')}) ---"):
                    return
                if not budget.add(truncate(text, OUTPUT_PER_ITEM_LIMIT)):
                    return
        elif otype in {"execute_result", "display_data"}:
            data = out.get("data", {}) or {}
            if "text/plain" in data:
                if not budget.add(f"--- {otype} output {oi} text/plain ---"):
                    return
                if not budget.add(truncate(join_maybe(data.get("text/plain")), OUTPUT_PER_ITEM_LIMIT)):
                    return
            elif data:
                keys = ", ".join(sorted(data.keys()))
                if not budget.add(f"--- {otype} output {oi}: non-text data keys: {keys} ---"):
                    return


def render_cell(i: int, cell: dict, budget: Budget, only_outputs: bool = False) -> None:
    src = source_text(cell)
    outs = outputs(cell)
    metadata = [
        f"--- cell {i} {cell.get('cell_type', 'unknown')} ---",
        f"cell: {i}",
        f"cell_type: {cell.get('cell_type', 'unknown')}",
        f"run_state: {run_state(cell)}",
        f"cell_id: {cell.get('id', '') or '-'}",
        f"source_sha256: {source_sha256(cell)}",
        f"source_chars: {len(src)}",
        f"outputs: {len(outs)}",
        f"has_error: {str(has_error(cell)).lower()}",
    ]
    if not budget.add("\n".join(metadata)):
        return
    if not only_outputs:
        if not budget.add("source:"):
            return
        if not budget.add(truncate(src if src else "[empty source]", SOURCE_PER_CELL_LIMIT)):
            return
    render_outputs(cell, budget)


def output_records(cell: dict, budget: JsonTextBudget) -> list[dict]:
    records: list[dict] = []
    for oi, out in enumerate(outputs(cell)):
        otype = out.get("output_type", "unknown")
        record: dict = {"index": oi, "output_type": otype}
        if otype == "error":
            record["ename"] = str(out.get("ename", ""))
            record["evalue"] = str(out.get("evalue", ""))
            record["traceback"] = budget.take("\n".join(out.get("traceback", []) or []), TRACEBACK_LIMIT)
        elif otype == "stream":
            record["name"] = out.get("name", "stream")
            record["text"] = budget.take(join_maybe(out.get("text", [])), OUTPUT_PER_ITEM_LIMIT)
        elif otype in {"execute_result", "display_data"}:
            data = out.get("data", {}) or {}
            record["data_keys"] = sorted(data.keys())
            if "text/plain" in data:
                record["text_plain"] = budget.take(join_maybe(data.get("text/plain")), OUTPUT_PER_ITEM_LIMIT)
        records.append(record)
    return records


def cell_record(i: int, cell: dict, budget: JsonTextBudget, only_outputs: bool = False) -> dict:
    record = cell_metadata(i, cell)
    if not only_outputs:
        record["source"] = budget.take(source_text(cell), SOURCE_PER_CELL_LIMIT)
    record["outputs"] = output_records(cell, budget)
    return record


def load_notebook(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def passes_filters(cell: dict, args: argparse.Namespace) -> bool:
    if args.type and cell.get("cell_type") != args.type:
        return False
    if args.run and not is_run_code(cell):
        return False
    if args.unrun and not (cell.get("cell_type") == "code" and not is_run_code(cell)):
        return False
    if args.has_outputs and not outputs(cell):
        return False
    if args.no_outputs and outputs(cell):
        return False
    return True


def line_for_offset(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def source_substring_match(i: int, text: str, pattern: str) -> Match | None:
    start = text.find(pattern)
    if start < 0:
        return None
    end = start + len(pattern)
    start_line = line_for_offset(text, start)
    last_character = max(start, end - 1)
    end_line = line_for_offset(text, last_character)
    lines = text.splitlines()
    preview = lines[start_line - 1].strip() if start_line <= len(lines) else pattern.strip()
    return Match(i, "source", start_line, end_line, preview, text)


def first_line_match(i: int, area: str, text: str, pattern: str, regex: re.Pattern | None) -> Match | None:
    for line_no, line in enumerate(text.splitlines(), start=1):
        if regex.search(line) if regex else pattern in line:
            return Match(i, area, line_no, line_no, line.strip(), text)
    return None


def has_search(args: argparse.Namespace) -> bool:
    return args.grep is not None or args.search_source is not None or args.search_output is not None


def iter_matches(cells: list[dict], args: argparse.Namespace) -> list[Match]:
    pattern = args.grep if args.grep is not None else args.search_source if args.search_source is not None else args.search_output
    if pattern is None:
        return []
    where = args.where
    if args.search_source is not None:
        where = "source"
    elif args.search_output is not None:
        where = "output"
    regex = re.compile(pattern) if args.grep is not None else None
    matches: list[Match] = []
    for i, cell in enumerate(cells):
        if not passes_filters(cell, args):
            continue
        if where in {"source", "both"}:
            text = source_text(cell)
            match = (
                source_substring_match(i, text, pattern)
                if args.search_source is not None
                else first_line_match(i, "source", text, pattern, regex)
            )
            if match:
                matches.append(match)
        if where in {"output", "both"}:
            match = first_line_match(i, "output", output_text(cell), pattern, regex)
            if match:
                matches.append(match)
    return matches


def context_records(match: Match, n: int) -> list[dict]:
    if n <= 0:
        return []
    lines = match.haystack.splitlines()
    first = max(1, match.start_line - n)
    last = min(len(lines), match.end_line + n)
    return [
        {
            "line": line_no,
            "text": lines[line_no - 1][:MATCH_LINE_LIMIT],
            "matched": match.start_line <= line_no <= match.end_line,
        }
        for line_no in range(first, last + 1)
    ]


def match_record(match: Match, cell: dict, context_n: int) -> dict:
    record = {
        "cell": match.cell_index,
        "cell_type": cell.get("cell_type", "unknown"),
        "run_state": run_state(cell),
        "cell_id": cell.get("id") or None,
        "source_sha256": source_sha256(cell),
        "area": match.area,
        "start_line": match.start_line,
        "end_line": match.end_line,
        "text": match.text[:MATCH_LINE_LIMIT],
    }
    context = context_records(match, context_n)
    if context:
        record["context"] = context
    return record


def render_match(match: Match, cell: dict, context_n: int) -> None:
    location = f"line={match.start_line}" if match.start_line == match.end_line else f"lines={match.start_line}-{match.end_line}"
    print(
        f"cell {match.cell_index} {cell.get('cell_type', 'unknown')} {run_state(cell)} "
        f"sha256={source_sha256(cell)} {match.area}:{location} :: {match.text[:MATCH_LINE_LIMIT]}"
    )
    for context in context_records(match, context_n):
        marker = ">" if context["matched"] else " "
        print(f"{marker} {context['line']:4} | {context['text']}")


def expand_context(indexes: Iterable[int], total: int, n: int) -> set[int]:
    expanded: set[int] = set()
    for i in indexes:
        expanded.update(range(max(0, i - n), min(total, i + n + 1)))
    return expanded


def base_payload(path: Path, cells: list[dict], error_indexes: set[int], mode: str) -> dict:
    return {
        "notebook": str(path),
        "cell_count": len(cells),
        "error_cells": sorted(error_indexes),
        "mode": mode,
    }


def emit_json(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def emit_error(message: str, args: argparse.Namespace) -> None:
    if args.json:
        print(json.dumps({"error": message}, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
    else:
        print(f"ERROR: {message}", file=sys.stderr)


def inspect_notebook(path: Path, args: argparse.Namespace) -> int:
    try:
        nb = load_notebook(path)
    except Exception as exc:
        emit_error(f"failed to read/parse notebook {path}: {exc}", args)
        return 2

    if not isinstance(nb, dict):
        emit_error(f"notebook root is not an object: {path}", args)
        return 2
    cells = nb.get("cells", []) or []
    if not isinstance(cells, list):
        emit_error(f"notebook cells field is not a list: {path}", args)
        return 2

    error_indexes = {i for i, c in enumerate(cells) if has_error(c)}
    matches = iter_matches(cells, args)

    if has_search(args):
        if args.json:
            payload = base_payload(path, cells, error_indexes, "matches")
            payload["matches"] = [match_record(match, cells[match.cell_index], args.context_lines) for match in matches]
            if args.context_cells:
                payload["context_cells"] = sorted(expand_context((m.cell_index for m in matches), len(cells), args.context_cells))
            if args.show and matches:
                selected = expand_context((m.cell_index for m in matches), len(cells), args.context_cells)
                selected = {i for i in selected if passes_filters(cells[i], args) or args.context_cells}
                text_budget = JsonTextBudget(args.budget)
                payload["cells"] = [cell_record(i, cells[i], text_budget, args.only_outputs) for i in sorted(selected)]
                if text_budget.exhausted:
                    payload["budget_exhausted"] = True
            emit_json(payload)
            return 0 if matches else 1

        print(f"Notebook: {path}")
        print(f"Cells: {len(cells)}")
        print("Error cells: " + (", ".join(str(i) for i in sorted(error_indexes)) if error_indexes else "none"))
        print("\n== Matches ==")
        if not matches:
            print("none")
            return 1
        for match in matches:
            render_match(match, cells[match.cell_index], args.context_lines)
        if not args.show:
            if args.context_cells:
                selected = expand_context((m.cell_index for m in matches), len(cells), args.context_cells)
                print(f"context cells: {', '.join(str(i) for i in sorted(selected))}")
            return 0
        selected = expand_context((m.cell_index for m in matches), len(cells), args.context_cells)
        selected = {i for i in selected if passes_filters(cells[i], args) or args.context_cells}
    else:
        selected: set[int] = set()
        try:
            for selector in args.cells or []:
                selected.update(parse_cell_selector(selector, len(cells)))
        except (ValueError, ZeroDivisionError) as exc:
            emit_error(str(exc), args)
            return 2
        if args.errors:
            selected.update(error_indexes)
        selected = {i for i in selected if passes_filters(cells[i], args)}

        if not selected:
            filtered = [(i, cell) for i, cell in enumerate(cells) if passes_filters(cell, args)]
            if args.json:
                payload = base_payload(path, cells, error_indexes, "summary")
                payload["cells"] = [summary_record(i, cell) for i, cell in filtered]
                emit_json(payload)
                return 0
            print(f"Notebook: {path}")
            print(f"Cells: {len(cells)}")
            print("Error cells: " + (", ".join(str(i) for i in sorted(error_indexes)) if error_indexes else "none"))
            print("\n== Cell summary ==")
            for i, cell in filtered:
                print(summary_line(i, cell))
            return 0

        if args.json:
            text_budget = JsonTextBudget(args.budget)
            payload = base_payload(path, cells, error_indexes, "cells")
            payload["cells"] = [cell_record(i, cells[i], text_budget, args.only_outputs) for i in sorted(selected)]
            if text_budget.exhausted:
                payload["budget_exhausted"] = True
            emit_json(payload)
            return 0

        print(f"Notebook: {path}")
        print(f"Cells: {len(cells)}")
        print("Error cells: " + (", ".join(str(i) for i in sorted(error_indexes)) if error_indexes else "none"))

    budget = Budget(args.budget)
    for i in sorted(selected):
        if 0 <= i < len(cells):
            render_cell(i, cells[i], budget, only_outputs=args.only_outputs)
            if budget.exhausted:
                break
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Inspect a Jupyter .ipynb notebook in compact text form. Cell numbers are zero-based."
    )
    parser.add_argument("notebook", type=Path, help="Path to the .ipynb notebook")
    parser.add_argument(
        "--cells",
        action="append",
        help="Zero-based cell selector(s), repeatable. Examples: 6, 6:11, 6-10, 1,3,5:8.",
    )
    parser.add_argument("--errors", action="store_true", help="Include cells that have error outputs")
    parser.add_argument("--type", choices=["code", "markdown", "raw"], help="Only include cells of this type")
    parser.add_argument("--run", action="store_true", help="Only include executed code cells")
    parser.add_argument("--unrun", action="store_true", help="Only include unexecuted code cells")
    parser.add_argument("--has-outputs", action="store_true", help="Only include cells with outputs")
    parser.add_argument("--no-outputs", action="store_true", help="Only include cells without outputs")
    parser.add_argument("--outputs", action="store_true", help="Compatibility no-op: detailed cell views already include outputs")
    parser.add_argument("--only-outputs", action="store_true", help="For detailed cell rendering, omit source and print outputs only")
    parser.add_argument("--search-source", help="Plain substring search across complete cell source; supports multiline snippets")
    parser.add_argument("--search-output", help="Plain substring search in rendered text outputs/errors")
    parser.add_argument("--grep", help="Regex search, grep-like")
    parser.add_argument("--where", choices=["source", "output", "both"], default="source", help="Where --grep searches (default: source)")
    parser.add_argument("--context-lines", type=int, default=0, help="Show N lines before/after each source or output match")
    parser.add_argument("--context-cells", type=int, default=0, help="Include N cells before/after matched cells when showing matches")
    parser.add_argument("--show", action="store_true", help="With search/grep, render matched/context cells after the match list")
    parser.add_argument("--json", action="store_true", help="Emit one compact machine-readable JSON document")
    parser.add_argument(
        "--budget",
        type=int,
        default=DEFAULT_BUDGET,
        help=f"Approximate character budget for selected cell detail output (default: {DEFAULT_BUDGET})",
    )
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.context_lines < 0:
        parser.error("--context-lines must be non-negative")
    if args.context_cells < 0:
        parser.error("--context-cells must be non-negative")
    if args.context_lines and not has_search(args):
        parser.error("--context-lines requires --search-source, --search-output, or --grep")
    if args.search_source == "":
        parser.error("--search-source must not be empty")
    if args.search_output == "":
        parser.error("--search-output must not be empty")
    if args.grep is not None:
        try:
            re.compile(args.grep)
        except re.error as exc:
            parser.error(f"invalid --grep pattern: {exc}")
    return inspect_notebook(args.notebook, args)


if __name__ == "__main__":
    raise SystemExit(main())
