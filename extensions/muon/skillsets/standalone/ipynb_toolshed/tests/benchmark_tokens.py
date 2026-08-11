#!/usr/bin/env python3
"""Compare raw notebook size with real inspect_ipynb.py CLI workflows.

The benchmark has no tokenizer dependency. It reports exact characters/UTF-8
bytes and a clearly labeled token estimate. Optional JSON reports are refused
inside the package repository so benchmark artifacts stay with the benchmarked
project.
"""

from __future__ import annotations

import argparse
import json
import math
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "inspect_ipynb.py"


def find_package_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "package.json").is_file() and (parent / "extensions").is_dir():
            return parent
    raise RuntimeError("could not locate package repository root")


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def measure(text: str, chars_per_token: float) -> dict:
    return {
        "characters": len(text),
        "utf8_bytes": len(text.encode("utf-8")),
        "estimated_tokens": math.ceil(len(text) / chars_per_token),
    }


def parse_task(value: str, index: int) -> tuple[str, list[str]]:
    if "::" in value:
        name, command = value.split("::", 1)
        name = name.strip() or f"task_{index}"
    else:
        name, command = f"task_{index}", value
    return name, shlex.split(command)


def run_task(notebook: Path, name: str, args: list[str], chars_per_token: float) -> dict:
    command = [sys.executable, str(SCRIPT), str(notebook), *args]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    combined = result.stdout + result.stderr
    return {
        "name": name,
        "args": args,
        "exit_code": result.returncode,
        "stdout": measure(result.stdout, chars_per_token),
        "stderr": measure(result.stderr, chars_per_token),
        "total": measure(combined, chars_per_token),
    }


def savings(raw: dict, toolshed: dict, key: str) -> dict:
    baseline = raw[key]
    used = toolshed[key]
    saved = baseline - used
    return {
        "saved": saved,
        "percent": round((saved / baseline) * 100, 2) if baseline else None,
    }


def sum_metrics(items: Iterable[dict]) -> dict:
    items = list(items)
    return {
        "characters": sum(item["characters"] for item in items),
        "utf8_bytes": sum(item["utf8_bytes"] for item in items),
        "estimated_tokens": sum(item["estimated_tokens"] for item in items),
    }


def benchmark_notebook(notebook: Path, tasks: list[tuple[str, list[str]]], chars_per_token: float) -> dict:
    raw_text = notebook.read_text(encoding="utf-8")
    raw = measure(raw_text, chars_per_token)
    calls = [run_task(notebook, name, args, chars_per_token) for name, args in tasks]
    toolshed = sum_metrics(call["total"] for call in calls)
    return {
        "notebook": str(notebook),
        "raw_read": raw,
        "toolshed_workflow": toolshed,
        "savings": {
            "characters": savings(raw, toolshed, "characters"),
            "utf8_bytes": savings(raw, toolshed, "utf8_bytes"),
            "estimated_tokens": savings(raw, toolshed, "estimated_tokens"),
        },
        "calls": calls,
    }


def print_report(report: dict) -> None:
    print("ipynb-toolshed token benchmark")
    print(f"Token estimate: ceil(characters / {report['chars_per_token']})")
    for item in report["notebooks"]:
        raw = item["raw_read"]
        used = item["toolshed_workflow"]
        saved = item["savings"]["estimated_tokens"]
        percent = "n/a" if saved["percent"] is None else f"{saved['percent']:.2f}%"
        print(f"\nNotebook: {item['notebook']}")
        print(f"  raw:       {raw['characters']} chars, {raw['utf8_bytes']} bytes, ~{raw['estimated_tokens']} tokens")
        print(f"  toolshed:  {used['characters']} chars, {used['utf8_bytes']} bytes, ~{used['estimated_tokens']} tokens")
        print(f"  estimated token savings: {saved['saved']} ({percent})")
        for call in item["calls"]:
            print(
                f"  - {call['name']}: exit={call['exit_code']} "
                f"chars={call['total']['characters']} ~tokens={call['total']['estimated_tokens']}"
            )
    aggregate = report["aggregate"]
    saved = aggregate["savings"]["estimated_tokens"]
    percent = "n/a" if saved["percent"] is None else f"{saved['percent']:.2f}%"
    print("\nAggregate:")
    print(f"  raw estimated tokens: ~{aggregate['raw_read']['estimated_tokens']}")
    print(f"  toolshed estimated tokens: ~{aggregate['toolshed_workflow']['estimated_tokens']}")
    print(f"  estimated token savings: {saved['saved']} ({percent})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark raw .ipynb size against one or more real inspect_ipynb.py CLI tasks."
    )
    parser.add_argument("notebooks", nargs="+", type=Path, help="Notebook paths to benchmark")
    parser.add_argument(
        "--task",
        action="append",
        help=(
            "Inspector arguments for one workflow call, repeatable. Optional name prefix: "
            "'find metric::--search-output accuracy --context-lines 2'. "
            "Use --task='...' when the value starts with --. Defaults to a summary call."
        ),
    )
    parser.add_argument(
        "--chars-per-token",
        type=float,
        default=4.0,
        help="Heuristic characters per estimated token (default: 4.0)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional JSON report path, resolved from the current working directory; must be outside this package repo",
    )
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.chars_per_token <= 0:
        parser.error("--chars-per-token must be greater than zero")

    output = args.output.resolve() if args.output else None
    if output and is_within(output, find_package_root().resolve()):
        parser.error(f"refusing to write benchmark artifacts inside package repo: {output}")

    notebooks = [path.resolve() for path in args.notebooks]
    missing = [str(path) for path in notebooks if not path.is_file()]
    if missing:
        parser.error("notebook not found: " + ", ".join(missing))

    task_values = args.task or [""]
    try:
        tasks = [parse_task(value, i) for i, value in enumerate(task_values, start=1)]
    except ValueError as exc:
        parser.error(f"invalid --task: {exc}")

    results = [benchmark_notebook(path, tasks, args.chars_per_token) for path in notebooks]
    raw_total = sum_metrics(item["raw_read"] for item in results)
    toolshed_total = sum_metrics(item["toolshed_workflow"] for item in results)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "inspector": str(SCRIPT),
        "chars_per_token": args.chars_per_token,
        "notebooks": results,
        "aggregate": {
            "raw_read": raw_total,
            "toolshed_workflow": toolshed_total,
            "savings": {
                "characters": savings(raw_total, toolshed_total, "characters"),
                "utf8_bytes": savings(raw_total, toolshed_total, "utf8_bytes"),
                "estimated_tokens": savings(raw_total, toolshed_total, "estimated_tokens"),
            },
        },
    }

    print_report(report)
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nJSON report: {output}")

    failed = [call for item in results for call in item["calls"] if call["exit_code"] != 0]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
