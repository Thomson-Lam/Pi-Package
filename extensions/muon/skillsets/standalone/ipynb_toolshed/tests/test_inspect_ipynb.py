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

    def test_json_budget_uses_valid_paginated_output(self) -> None:
        result = self.run_cli("--cells", "1", "--budget", "10", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertGreater(payload["pagination"]["page_count"], 1)
        self.assertEqual(payload["pagination"]["next_page"], 2)
        self.assertLessEqual(len(payload["cells"][0]["source"]), 10)

    def test_source_pages_reconstruct_complete_source(self) -> None:
        data = notebook_data()
        source = "α" * 12_000 + "LATE_SOURCE_TARGET"
        data["cells"][1]["source"] = [source]
        data["cells"][1]["outputs"] = []
        self.notebook.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

        first = self.run_cli("--cells", "1", "--json")
        second = self.run_cli("--cells", "1", "--page", "2", "--json")
        self.assertEqual((first.returncode, second.returncode), (0, 0))
        first_payload = json.loads(first.stdout)
        second_payload = json.loads(second.stdout)
        self.assertEqual(first_payload["pagination"]["page_count"], 2)
        self.assertEqual(first_payload["cells"][0]["source"] + second_payload["cells"][0]["source"], source)
        self.assertEqual(first_payload["pagination"]["detail_sha256"], second_payload["pagination"]["detail_sha256"])

        search = self.run_cli("--search-source", "LATE_SOURCE_TARGET")
        self.assertEqual(search.returncode, 0, search.stderr)
        self.assertIn("cell 1 code", search.stdout)

    def test_source_at_budget_limit_is_not_paginated(self) -> None:
        data = notebook_data()
        data["cells"][1]["source"] = ["x" * 12_000]
        data["cells"][1]["outputs"] = []
        self.notebook.write_text(json.dumps(data), encoding="utf-8")
        result = self.run_cli("--cells", "1", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertNotIn("pagination", payload)
        self.assertEqual(len(payload["cells"][0]["source"]), 12_000)

    def test_output_pages_reconstruct_and_search_complete_output(self) -> None:
        data = notebook_data()
        output = "log line\n" * 1_500 + "final accuracy: 0.97\n"
        data["cells"][1]["source"] = ["run_training()\n"]
        data["cells"][1]["outputs"] = [{"output_type": "stream", "name": "stdout", "text": [output]}]
        self.notebook.write_text(json.dumps(data), encoding="utf-8")

        search = self.run_cli("--search-output", "final accuracy", "--context-lines", "1")
        self.assertEqual(search.returncode, 0, search.stderr)
        self.assertIn("final accuracy: 0.97", search.stdout)

        first = json.loads(self.run_cli("--cells", "1", "--only-outputs", "--json").stdout)
        second = json.loads(self.run_cli("--cells", "1", "--only-outputs", "--page", "2", "--json").stdout)
        chunks = first["cells"][0]["outputs"][0]["text"] + second["cells"][0]["outputs"][0]["text"]
        self.assertEqual(chunks, output)

    def test_multiple_output_items_and_traceback_paginate_with_metadata(self) -> None:
        data = notebook_data()
        data["cells"][1]["source"] = []
        data["cells"][1]["outputs"] = [
            {"output_type": "stream", "name": "stdout", "text": ["a" * 10]},
            {
                "output_type": "error",
                "ename": "RuntimeError",
                "evalue": "late failure",
                "traceback": ["b" * 11],
            },
        ]
        self.notebook.write_text(json.dumps(data), encoding="utf-8")

        pages = [
            json.loads(self.run_cli("--cells", "1", "--only-outputs", "--budget", "10", "--page", str(page), "--json").stdout)
            for page in (1, 2, 3)
        ]
        self.assertEqual(pages[0]["cells"][0]["outputs"][0]["text"], "a" * 10)
        error_page = pages[1]["cells"][0]["outputs"][0]
        self.assertEqual(error_page["ename"], "RuntimeError")
        self.assertEqual(error_page["evalue"], "late failure")
        traceback = error_page["traceback"] + pages[2]["cells"][0]["outputs"][0]["traceback"]
        self.assertEqual(traceback, "b" * 11)

    def test_mixed_source_and_output_cross_page_without_loss(self) -> None:
        data = notebook_data()
        source = "s" * 11_995
        output = "output-crossing-boundary"
        data["cells"][1]["source"] = [source]
        data["cells"][1]["outputs"] = [{"output_type": "stream", "name": "stdout", "text": [output]}]
        self.notebook.write_text(json.dumps(data), encoding="utf-8")

        first = json.loads(self.run_cli("--cells", "1", "--json").stdout)
        second = json.loads(self.run_cli("--cells", "1", "--page", "2", "--json").stdout)
        first_cell = first["cells"][0]
        second_cell = second["cells"][0]
        self.assertEqual(first_cell["source"], source)
        output_chunks = first_cell["outputs"][0]["text"] + second_cell["outputs"][0]["text"]
        self.assertEqual(output_chunks, output)

    def test_text_page_reports_exact_continuation(self) -> None:
        data = notebook_data()
        data["cells"][1]["source"] = ["x" * 12_001]
        data["cells"][1]["outputs"] = []
        self.notebook.write_text(json.dumps(data), encoding="utf-8")
        result = self.run_cli("--cells", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("detail page 1 of 2", result.stdout)
        self.assertIn("next_page: 2", result.stdout)
        self.assertIn("re-run with --page 2", result.stdout)

    def test_only_outputs_page_count_excludes_large_source(self) -> None:
        data = notebook_data()
        data["cells"][1]["source"] = ["s" * 19_000]
        data["cells"][1]["outputs"] = [{"output_type": "stream", "name": "stdout", "text": ["small output"]}]
        self.notebook.write_text(json.dumps(data), encoding="utf-8")
        payload = json.loads(self.run_cli("--cells", "1", "--only-outputs", "--json").stdout)
        self.assertNotIn("pagination", payload)
        self.assertNotIn("source", payload["cells"][0])
        self.assertEqual(payload["cells"][0]["outputs"][0]["text"], "small output")

    def test_page_and_budget_validation(self) -> None:
        zero_page = self.run_cli("--cells", "1", "--page", "0")
        self.assertEqual(zero_page.returncode, 2)
        self.assertIn("at least 1", zero_page.stderr)

        excessive_budget = self.run_cli("--cells", "1", "--budget", "20001")
        self.assertEqual(excessive_budget.returncode, 2)
        self.assertIn("between 1 and 20000", excessive_budget.stderr)

        no_detail = self.run_cli("--page", "2")
        self.assertEqual(no_detail.returncode, 2)
        self.assertIn("requires", no_detail.stderr)

        out_of_range = self.run_cli("--cells", "1", "--page", "99", "--json")
        self.assertEqual(out_of_range.returncode, 2)
        self.assertIn("out of range", json.loads(out_of_range.stderr)["error"])

    def test_json_runtime_error_is_json_on_stderr(self) -> None:
        self.notebook.write_text("not JSON", encoding="utf-8")
        result = self.run_cli("--json")
        self.assertEqual(result.returncode, 2)
        self.assertIn("error", json.loads(result.stderr))


if __name__ == "__main__":
    unittest.main()
