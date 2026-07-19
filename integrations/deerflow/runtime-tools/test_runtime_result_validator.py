from __future__ import annotations

import copy
import hashlib
import json
import unittest
from pathlib import Path

from deerflow_workbench_tools.runtime_result_validator import (
    validate_runtime_artifact_draft,
    validate_runtime_prototype_patch,
    validate_runtime_result,
)


ROOT = Path(__file__).resolve().parents[3]
EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json"


class RuntimeResultValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.example = json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))

    def test_accepts_the_production_reference_example(self) -> None:
        result = validate_runtime_result(self.example)

        self.assertEqual(result["protocol"], "workbench.runtime.validation.v1")
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["issues"], [])
        self.assertRegex(result["candidateChecksum"], r"^[0-9a-f]{64}$")
        self.assertEqual(len(result["artifactChecksums"]), 1)

    def test_reports_state_binding_shape_errors(self) -> None:
        candidate = copy.deepcopy(self.example)
        candidate["artifacts"][0]["content"]["bindings"][0]["source"] = {
            "kind": "state",
            "key": "status",
        }
        result = validate_runtime_result(candidate)
        self.assertFalse(result["ok"])
        paths = {tuple(issue["path"]) for issue in result["issues"]}
        self.assertIn(("artifacts", 0, "content", "bindings", 0, "source", "stateId"), paths)
        self.assertIn(("artifacts", 0, "content", "bindings", 0, "source", "field"), paths)

    def test_validates_one_draft_without_result_path_prefixes(self) -> None:
        draft = copy.deepcopy(self.example["artifacts"][0])
        del draft["title"]

        result = validate_runtime_artifact_draft(draft)

        self.assertFalse(result["ok"])
        self.assertIn(("title",), {tuple(issue["path"]) for issue in result["issues"]})

    def test_runs_zod_graph_reference_refinements(self) -> None:
        candidate = copy.deepcopy(self.example)
        candidate["artifacts"][0]["content"]["nodes"][1]["parentId"] = "missing-parent"
        result = validate_runtime_result(candidate)
        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"] == ["artifacts", 0, "content", "nodes", 1, "parentId"]
            and "unknown parent node" in issue["message"]
            for issue in result["issues"]
        ))

    def test_uses_node_canonical_numbers_for_cross_language_hashes(self) -> None:
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "numeric canonicalization",
            "artifacts": [{
                "title": "Numeric data",
                "citations": [],
                "operation": {"kind": "create"},
                "kind": "data",
                "schemaVersion": 1,
                "content": {"whole": 1.0, "scientific": 1e-7},
            }],
        }

        result = validate_runtime_result(candidate)
        python_checksum = hashlib.sha256(json.dumps(
            candidate,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")).hexdigest()

        self.assertTrue(result["ok"])
        self.assertNotEqual(result["candidateChecksum"], python_checksum)

    def test_validates_a_strict_runtime_prototype_patch(self) -> None:
        patch = {
            "protocol": "workbench.runtime.prototype-patch.v1",
            "artifactIndex": 0,
            "screenId": "screen_home",
            "baseRevision": 0,
            "nextRevision": 1,
            "operations": [{
                "kind": "update_screen",
                "screenId": "screen_home",
                "screen": {
                    "id": "screen_home",
                    "name": "Home",
                    "route": "/home",
                    "rootNodeId": "node_root",
                    "initialStateId": None,
                    "viewport": {"width": 1440, "height": 900},
                },
            }],
            "resultingChecksum": "a" * 64,
        }

        result = validate_runtime_prototype_patch(patch)
        self.assertTrue(result["ok"])
        self.assertRegex(result["candidateChecksum"], r"^[0-9a-f]{64}$")
        self.assertEqual(result["artifactChecksums"], [])

        patch["nextRevision"] = 2
        invalid = validate_runtime_prototype_patch(patch)
        self.assertFalse(invalid["ok"])
        self.assertIn(
            ("nextRevision",),
            {tuple(issue["path"]) for issue in invalid["issues"]},
        )


if __name__ == "__main__":
    unittest.main()
