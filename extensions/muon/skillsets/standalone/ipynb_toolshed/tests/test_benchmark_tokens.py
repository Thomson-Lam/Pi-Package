#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BENCHMARK = Path(__file__).resolve().parent / "benchmark_tokens.py"
PACKAGE_ROOT = Path(__file__).resolve().parents[6]


class BenchmarkTokensCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.notebook = self.root / "fixture.ipynb"
        notebook = {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": [
                {
                    "cell_type": "code",
                    "id": "metric",
                    "metadata": {},
                    "execution_count": 1,
                    "source": ["print('accuracy')\n"],
                    "outputs": [
                        {
                            "output_type": "stream",
                            "name": "stdout",
                            "text": ["accuracy: 0.91\n"],
                        }
                    ],
                }
            ],
        }
        self.notebook.write_text(json.dumps(notebook), encoding="utf-8")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_benchmark(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(BENCHMARK), str(self.notebook), *args],
            cwd=self.root,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_runs_real_cli_tasks_and_writes_report_outside_repo(self) -> None:
        output = self.root / "reports" / "metrics.json"
        result = self.run_benchmark(
            "--task=find metric::--search-output accuracy --context-lines 1",
            "--task=inspect cell::--cells 0 --only-outputs",
            "--output",
            str(output),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("estimated token savings", result.stdout)
        report = json.loads(output.read_text(encoding="utf-8"))
        item = report["notebooks"][0]
        self.assertEqual(len(item["calls"]), 2)
        self.assertEqual([call["exit_code"] for call in item["calls"]], [0, 0])
        self.assertEqual(item["calls"][0]["name"], "find metric")
        self.assertEqual(item["raw_read"]["characters"], len(self.notebook.read_text(encoding="utf-8")))
        self.assertEqual(
            item["toolshed_workflow"]["characters"],
            sum(call["total"]["characters"] for call in item["calls"]),
        )

    def test_default_task_is_summary_and_does_not_write_a_file(self) -> None:
        result = self.run_benchmark()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("task_1: exit=0", result.stdout)
        self.assertEqual(list(self.root.glob("*.json")), [])

    def test_failed_cli_task_is_reported_and_returns_one(self) -> None:
        output = self.root / "failed.json"
        result = self.run_benchmark(
            "--task=missing::--search-output definitely-not-present",
            "--output",
            str(output),
        )
        self.assertEqual(result.returncode, 1)
        report = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(report["notebooks"][0]["calls"][0]["exit_code"], 1)

    def test_refuses_report_inside_package_repo(self) -> None:
        output = PACKAGE_ROOT / "benchmark-must-not-be-written.json"
        result = self.run_benchmark("--output", str(output))
        self.assertEqual(result.returncode, 2)
        self.assertIn("refusing to write", result.stderr)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
