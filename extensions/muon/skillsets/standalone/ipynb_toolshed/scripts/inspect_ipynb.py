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
MAX_BUDGET = 20_000
MATCH_LINE_LIMIT = 180


@dataclass(frozen=True)
class Match:
    cell_index: int
    area: str
    start_line: int
    end_line: int
    text: str
    haystack: str


@dataclass(frozen=True)
class DetailPart:
    cell_index: int
    kind: str
    text: str
    output_index: int | None = None


@dataclass(frozen=True)
class PagePart:
    part: DetailPart
    start: int
    end: int

    @property
    def text(self) -> str:
        return self.part.text[self.start : self.end]


@dataclass(frozen=True)
class DetailPage:
    number: int
    count: int
    page_size: int
    total_chars: int
    detail_sha256: str
    parts: list[PagePart]


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


def output_item_text(out: dict) -> tuple[str | None, str]:
    otype = out.get("output_type", "")
    if otype == "error":
        return "traceback", "\n".join(str(x) for x in (out.get("traceback", []) or []))
    if otype == "stream":
        return "stream", join_maybe(out.get("text", []))
    if otype in {"execute_result", "display_data"}:
        data = out.get("data", {}) or {}
        if "text/plain" in data:
            return "text_plain", join_maybe(data.get("text/plain"))
    return None, ""


def output_text(cell: dict) -> str:
    chunks: list[str] = []
    for out in outputs(cell):
        otype = out.get("output_type", "")
        if otype == "error":
            chunks.append(str(out.get("ename", "")))
            chunks.append(str(out.get("evalue", "")))
            chunks.append("\n".join(str(x) for x in (out.get("traceback", []) or [])))
        else:
            _, text = output_item_text(out)
            chunks.append(text)
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
    end_line = line_for_offset(text, max(start, end - 1))
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
            match = source_substring_match(i, text, pattern) if args.search_source is not None else first_line_match(i, "source", text, pattern, regex)
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


def build_detail_parts(cells: list[dict], selected: Iterable[int], only_outputs: bool) -> list[DetailPart]:
    parts: list[DetailPart] = []
    for i in sorted(selected):
        cell = cells[i]
        if not only_outputs:
            src = source_text(cell)
            if src:
                parts.append(DetailPart(i, "source", src))
        for oi, out in enumerate(outputs(cell)):
            kind, text = output_item_text(out)
            if kind and text:
                parts.append(DetailPart(i, kind, text, oi))
    return parts


def detail_hash(parts: list[DetailPart]) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(f"{part.cell_index}:{part.kind}:{part.output_index}\0".encode("utf-8"))
        digest.update(part.text.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def paginate_detail(parts: list[DetailPart], page_number: int, page_size: int) -> DetailPage:
    total = sum(len(part.text) for part in parts)
    page_count = max(1, (total + page_size - 1) // page_size)
    if page_number > page_count:
        raise ValueError(f"page {page_number} out of range; detail has {page_count} page{'s' if page_count != 1 else ''}")
    page_start = (page_number - 1) * page_size
    page_end = min(total, page_start + page_size)
    page_parts: list[PagePart] = []
    cursor = 0
    for part in parts:
        part_end = cursor + len(part.text)
        start = max(page_start, cursor)
        end = min(page_end, part_end)
        if start < end:
            page_parts.append(PagePart(part, start - cursor, end - cursor))
        cursor = part_end
    return DetailPage(page_number, page_count, page_size, total, detail_hash(parts), page_parts)


def visible_cells_for_page(selected: set[int], parts: list[DetailPart], page: DetailPage) -> set[int]:
    page_start = (page.number - 1) * page.page_size
    page_end = min(page.total_chars, page_start + page.page_size)
    lengths = {i: 0 for i in selected}
    for part in parts:
        lengths[part.cell_index] += len(part.text)
    visible: set[int] = set()
    cursor = 0
    for i in sorted(selected):
        cell_end = cursor + lengths[i]
        if cursor < page_end and cell_end > page_start:
            visible.add(i)
        elif lengths[i] == 0 and (
            (page_start <= cursor < page_end)
            or (cursor == page.total_chars and page.number == page.count)
        ):
            visible.add(i)
        cursor = cell_end
    return visible


def pagination_record(page: DetailPage) -> dict:
    record = {
        "page": page.number,
        "page_count": page.count,
        "page_size": page.page_size,
        "total_chars": page.total_chars,
        "detail_sha256": page.detail_sha256,
        "has_previous": page.number > 1,
        "has_next": page.number < page.count,
    }
    if page.number > 1:
        record["previous_page"] = page.number - 1
    if page.number < page.count:
        record["next_page"] = page.number + 1
    return record


def text_cell_metadata(i: int, cell: dict) -> str:
    metadata = cell_metadata(i, cell)
    return "\n".join(
        [
            f"--- cell {i} {metadata['cell_type']} ---",
            f"cell: {i}",
            f"cell_type: {metadata['cell_type']}",
            f"run_state: {metadata['run_state']}",
            f"cell_id: {metadata['cell_id'] or '-'}",
            f"source_sha256: {metadata['source_sha256']}",
            f"source_chars: {metadata['source_chars']}",
            f"outputs: {metadata['output_count']}",
            f"has_error: {str(metadata['has_error']).lower()}",
        ]
    )


def part_header(page_part: PagePart, cell: dict) -> str:
    part = page_part.part
    complete = page_part.start == 0 and page_part.end == len(part.text)
    range_text = "" if complete else f" chars {page_part.start + 1}-{page_part.end} of {len(part.text)}"
    if part.kind == "source":
        return f"source{range_text}:"
    out = outputs(cell)[part.output_index]
    if part.kind == "traceback":
        return f"--- ERROR output {part.output_index}: {out.get('ename', '')} {out.get('evalue', '')}{range_text} ---"
    if part.kind == "stream":
        return f"--- stream output {part.output_index} ({out.get('name', 'stream')}){range_text} ---"
    return f"--- {out.get('output_type', 'unknown')} output {part.output_index} text/plain{range_text} ---"


def render_detail_text(
    cells: list[dict],
    selected: set[int],
    parts: list[DetailPart],
    page: DetailPage,
    only_outputs: bool,
) -> None:
    if page.count > 1:
        print(f"--- detail page {page.number} of {page.count} ---")
        print(f"detail_chars: {page.total_chars}")
        print(f"page_budget: {page.page_size}")
        print(f"detail_sha256: {page.detail_sha256}")
        print(f"has_previous: {str(page.number > 1).lower()}")
        print(f"has_next: {str(page.number < page.count).lower()}")
        if page.number > 1:
            print(f"previous_page: {page.number - 1}")
        if page.number < page.count:
            print(f"next_page: {page.number + 1}")
        print()

    by_cell: dict[int, list[PagePart]] = {}
    for page_part in page.parts:
        by_cell.setdefault(page_part.part.cell_index, []).append(page_part)

    visible_cells = visible_cells_for_page(selected, parts, page)

    for i in sorted(visible_cells):
        cell = cells[i]
        print(text_cell_metadata(i, cell))
        cell_parts = by_cell.get(i, [])
        if not only_outputs and not source_text(cell):
            print("source:")
            print("[empty source]")
        for page_part in cell_parts:
            print(part_header(page_part, cell))
            print(page_part.text)
        textual_indexes = {part.part.output_index for part in cell_parts if part.part.output_index is not None}
        for oi, out in enumerate(outputs(cell)):
            kind, text = output_item_text(out)
            if kind and text:
                continue
            if oi in textual_indexes:
                continue
            otype = out.get("output_type", "unknown")
            if otype in {"execute_result", "display_data"}:
                keys = ", ".join(sorted((out.get("data", {}) or {}).keys()))
                if keys:
                    print(f"--- {otype} output {oi}: non-text data keys: {keys} ---")
            elif otype == "error":
                print(f"--- ERROR output {oi}: {out.get('ename', '')} {out.get('evalue', '')} ---")

    if page.number < page.count:
        print(f"\n...[detail continues; re-run with --page {page.number + 1}]")


def output_json_record(out: dict, oi: int, page_part: PagePart | None) -> dict:
    otype = out.get("output_type", "unknown")
    record: dict = {"index": oi, "output_type": otype}
    if otype == "error":
        record["ename"] = str(out.get("ename", ""))
        record["evalue"] = str(out.get("evalue", ""))
    elif otype == "stream":
        record["name"] = out.get("name", "stream")
    elif otype in {"execute_result", "display_data"}:
        record["data_keys"] = sorted((out.get("data", {}) or {}).keys())
    if page_part:
        field = {"stream": "text", "traceback": "traceback", "text_plain": "text_plain"}[page_part.part.kind]
        record[field] = page_part.text
        if page_part.start != 0 or page_part.end != len(page_part.part.text):
            record[f"{field}_range"] = {
                "start": page_part.start,
                "end": page_part.end,
                "total": len(page_part.part.text),
            }
    return record


def detail_json_cells(
    cells: list[dict],
    selected: set[int],
    parts: list[DetailPart],
    page: DetailPage,
    only_outputs: bool,
) -> list[dict]:
    by_cell: dict[int, list[PagePart]] = {}
    for page_part in page.parts:
        by_cell.setdefault(page_part.part.cell_index, []).append(page_part)
    visible_cells = visible_cells_for_page(selected, parts, page)

    records: list[dict] = []
    for i in sorted(visible_cells):
        cell = cells[i]
        record = cell_metadata(i, cell)
        page_parts = by_cell.get(i, [])
        source_part = next((part for part in page_parts if part.part.kind == "source"), None)
        if source_part:
            record["source"] = source_part.text
            if source_part.start != 0 or source_part.end != len(source_part.part.text):
                record["source_range"] = {
                    "start": source_part.start,
                    "end": source_part.end,
                    "total": len(source_part.part.text),
                }
        elif not only_outputs and not source_text(cell):
            record["source"] = ""

        output_parts = {part.part.output_index: part for part in page_parts if part.part.output_index is not None}
        output_records: list[dict] = []
        for oi, out in enumerate(outputs(cell)):
            kind, text = output_item_text(out)
            page_part = output_parts.get(oi)
            if page_part or not (kind and text):
                output_records.append(output_json_record(out, oi, page_part))
        record["outputs"] = output_records
        records.append(record)
    return records


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


def render_selected(path: Path, cells: list[dict], error_indexes: set[int], selected: set[int], args: argparse.Namespace, payload: dict | None = None) -> int:
    parts = build_detail_parts(cells, selected, args.only_outputs)
    try:
        page = paginate_detail(parts, args.page, args.budget)
    except ValueError as exc:
        emit_error(str(exc), args)
        return 2

    if args.json:
        result = payload or base_payload(path, cells, error_indexes, "cells")
        result["cells"] = detail_json_cells(cells, selected, parts, page, args.only_outputs)
        if page.count > 1:
            result["pagination"] = pagination_record(page)
        emit_json(result)
        return 0

    render_detail_text(cells, selected, parts, page, args.only_outputs)
    return 0


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

    error_indexes = {i for i, cell in enumerate(cells) if has_error(cell)}
    matches = iter_matches(cells, args)

    if has_search(args):
        if args.json:
            payload = base_payload(path, cells, error_indexes, "matches")
            payload["matches"] = [match_record(match, cells[match.cell_index], args.context_lines) for match in matches]
            if args.context_cells:
                payload["context_cells"] = sorted(expand_context((match.cell_index for match in matches), len(cells), args.context_cells))
            if not matches:
                emit_json(payload)
                return 1
            if not args.show:
                emit_json(payload)
                return 0
            selected = expand_context((match.cell_index for match in matches), len(cells), args.context_cells)
            selected = {i for i in selected if passes_filters(cells[i], args) or args.context_cells}
            return render_selected(path, cells, error_indexes, selected, args, payload)

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
                selected = expand_context((match.cell_index for match in matches), len(cells), args.context_cells)
                print(f"context cells: {', '.join(str(i) for i in sorted(selected))}")
            return 0
        selected = expand_context((match.cell_index for match in matches), len(cells), args.context_cells)
        selected = {i for i in selected if passes_filters(cells[i], args) or args.context_cells}
        return render_selected(path, cells, error_indexes, selected, args)

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
        if args.page != 1:
            emit_error("--page requires at least one selected detail cell", args)
            return 2
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

    if not args.json:
        print(f"Notebook: {path}")
        print(f"Cells: {len(cells)}")
        print("Error cells: " + (", ".join(str(i) for i in sorted(error_indexes)) if error_indexes else "none"))
    return render_selected(path, cells, error_indexes, selected, args)


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
    parser.add_argument("--search-output", help="Plain substring search in complete rendered text outputs/errors")
    parser.add_argument("--grep", help="Regex search, grep-like")
    parser.add_argument("--where", choices=["source", "output", "both"], default="source", help="Where --grep searches (default: source)")
    parser.add_argument("--context-lines", type=int, default=0, help="Show N lines before/after each source or output match")
    parser.add_argument("--context-cells", type=int, default=0, help="Include N cells before/after matched cells when showing matches")
    parser.add_argument("--show", action="store_true", help="With search/grep, render matched/context cells after the match list")
    parser.add_argument("--json", action="store_true", help="Emit one compact machine-readable JSON document")
    parser.add_argument("--page", type=int, default=1, help="One-based detail page to render after the hard content guardrail is reached")
    parser.add_argument(
        "--budget",
        type=int,
        default=DEFAULT_BUDGET,
        help=f"Detail characters per page (default: {DEFAULT_BUDGET}; maximum: {MAX_BUDGET})",
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
    if args.page < 1:
        parser.error("--page must be at least 1")
    if args.budget < 1 or args.budget > MAX_BUDGET:
        parser.error(f"--budget must be between 1 and {MAX_BUDGET}")
    if args.page != 1 and not (args.cells or args.errors or (has_search(args) and args.show)):
        parser.error("--page requires --cells, --errors, or search with --show")
    return inspect_notebook(args.notebook, args)


if __name__ == "__main__":
    raise SystemExit(main())
