#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "inspect_ipynb.py"


def notebook_data() -> dict:
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "cell_type": "markdown",
                "id": "intro",
                "metadata": {},
                "source": ["# Model report\n", "Unicode: café\n"],
            },
            {
                "cell_type": "code",
                "id": "train-model",
                "metadata": {},
                "execution_count": 3,
                "source": [
                    "prepare_data()\n",
                    "model.fit(X_train, y_train)\n",
                    "predictions = model.predict(X_test)\n",
                    "evaluate(predictions)\n",
                ],
                "outputs": [
                    {
                        "output_type": "stream",
                        "name": "stdout",
                        "text": [
                            "training accuracy: 0.94\n",
                            "validation loss: 0.27\n",
                            "validation accuracy: 0.91\n",
                            "test loss: 0.29\n",
                            "test accuracy: 0.90\n",
                        ],
                    },
                    {
                        "output_type": "display_data",
                        "metadata": {},
                        "data": {"image/png": "do-not-export-this-base64"},
                    },
                ],
            },
            {
                "cell_type": "code",
                "metadata": {},
                "execution_count": 4,
                "source": ["raise ValueError('bad café')\n"],
                "outputs": [
                    {
                        "output_type": "error",
                        "ename": "ValueError",
                        "evalue": "bad café",
                        "traceback": ["Traceback line 1", "ValueError: bad café"],
                    }
                ],
            },
        ],
    }


class InspectIpynbCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.notebook = Path(self.tempdir.name) / "fixture.ipynb"
        self.notebook.write_text(json.dumps(notebook_data(), ensure_ascii=False), encoding="utf-8")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.notebook), *args],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_existing_single_line_source_search(self) -> None:
        result = self.run_cli("--search-source", "model.fit")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cell 1 code run", result.stdout)
        self.assertIn("source:line=2", result.stdout)

    def test_multiline_source_search_reports_line_span(self) -> None:
        result = self.run_cli(
            "--search-source",
            "model.fit(X_train, y_train)\npredictions = model.predict(X_test)",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("source:lines=2-3", result.stdout)
        self.assertIn("model.fit(X_train, y_train)", result.stdout)

    def test_context_lines_marks_match_and_clips_boundaries(self) -> None:
        result = self.run_cli("--search-output", "validation accuracy", "--context-lines", "2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("    1 | training accuracy: 0.94", result.stdout)
        self.assertIn(">    3 | validation accuracy: 0.91", result.stdout)
        self.assertIn("    5 | test accuracy: 0.90", result.stdout)

    def test_multiline_context_marks_each_matched_line(self) -> None:
        result = self.run_cli(
            "--search-source",
            "model.fit(X_train, y_train)\npredictions = model.predict(X_test)",
            "--context-lines",
            "1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("     1 | prepare_data()", result.stdout)
        self.assertIn(">    2 | model.fit(X_train, y_train)", result.stdout)
        self.assertIn(">    3 | predictions = model.predict(X_test)", result.stdout)
        self.assertIn("     4 | evaluate(predictions)", result.stdout)

    def test_context_lines_requires_search_and_nonnegative_value(self) -> None:
        without_search = self.run_cli("--context-lines", "1")
        self.assertEqual(without_search.returncode, 2)
        self.assertIn("requires", without_search.stderr)

        negative = self.run_cli("--search-source", "model", "--context-lines", "-1")
        self.assertEqual(negative.returncode, 2)
        self.assertIn("non-negative", negative.stderr)

    def test_existing_grep_both_still_finds_source_and_output(self) -> None:
        result = self.run_cli("--grep", "accuracy|model\\.fit", "--where", "both")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("source:line=2", result.stdout)
        self.assertIn("output:line=1", result.stdout)

    def test_empty_substring_search_is_rejected(self) -> None:
        result = self.run_cli("--search-source", "")
        self.assertEqual(result.returncode, 2)
        self.assertIn("must not be empty", result.stderr)

    def test_json_summary_is_compact_and_parseable(self) -> None:
        result = self.run_cli("--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["mode"], "summary")
        self.assertEqual(payload["cell_count"], 3)
        self.assertEqual(payload["error_cells"], [2])
        self.assertEqual(payload["cells"][0]["preview"], "# Model report")
        self.assertNotIn("Notebook:", result.stdout)

    def test_json_search_includes_context(self) -> None:
        result = self.run_cli(
            "--search-output",
            "validation accuracy",
            "--context-lines",
            "1",
            "--json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        match = payload["matches"][0]
        self.assertEqual((match["cell"], match["area"]), (1, "output"))
        self.assertEqual((match["start_line"], match["end_line"]), (3, 3))
        self.assertEqual([line["line"] for line in match["context"]], [2, 3, 4])
        self.assertEqual([line["matched"] for line in match["context"]], [False, True, False])

    def test_json_selected_cell_has_structured_safe_outputs(self) -> None:
        result = self.run_cli("--cells", "1", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        cell = payload["cells"][0]
        self.assertIn("model.fit", cell["source"])
        self.assertEqual(cell["outputs"][0]["output_type"], "stream")
        self.assertEqual(cell["outputs"][1]["data_keys"], ["image/png"])
        self.assertNotIn("do-not-export-this-base64", result.stdout)

    def test_json_show_and_context_cells_include_cell_details(self) -> None:
        result = self.run_cli(
            "--search-source",
            "model.fit",
            "--context-cells",
            "1",
            "--show",
            "--json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["context_cells"], [0, 1, 2])
        self.assertEqual([cell["cell"] for cell in payload["cells"]], [0, 1, 2])

    def test_json_only_outputs_omits_source_and_preserves_unicode_error(self) -> None:
        result = self.run_cli("--cells", "2", "--only-outputs", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        cell = payload["cells"][0]
        self.assertNotIn("source", cell)
        self.assertIsNone(cell["cell_id"])
        self.assertEqual(cell["outputs"][0]["evalue"], "bad café")

    def test_json_no_match_is_valid_and_exits_one(self) -> None:
        result = self.run_cli("--search-source", "not present", "--json")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["matches"], [])

    def test_json_budget_exhaustion_remains_valid(self) -> None:
        result = self.run_cli("--cells", "1", "--budget", "10", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["budget_exhausted"])

    def test_json_runtime_error_is_json_on_stderr(self) -> None:
        self.notebook.write_text("not JSON", encoding="utf-8")
        result = self.run_cli("--json")
        self.assertEqual(result.returncode, 2)
        self.assertIn("error", json.loads(result.stderr))


if __name__ == "__main__":
    unittest.main()
