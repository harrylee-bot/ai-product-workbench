from __future__ import annotations

import copy
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from deerflow_workbench_tools.runtime_result_validator import (
    RuntimeResultValidatorError,
    validate_runtime_artifact_draft,
    validate_runtime_prototype_patch,
    validate_runtime_result,
)


ROOT = Path(__file__).resolve().parents[3]
EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json"
PRD_EXAMPLE_PATH = ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json"


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

    def test_fails_with_a_fixed_code_when_node_is_missing(self) -> None:
        with patch(
            "deerflow_workbench_tools.runtime_result_validator.shutil.which",
            return_value=None,
        ):
            with self.assertRaisesRegex(
                RuntimeResultValidatorError,
                "^WORKBENCH_RUNTIME_VALIDATOR_NODE_MISSING$",
            ):
                validate_runtime_result(self.example)

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

    def test_checkbox_type_error_points_to_the_referenced_variable_in_the_bundle(self) -> None:
        candidate = copy.deepcopy(self.example)
        content = candidate["artifacts"][0]["content"]
        input_node = next(node for node in content["nodes"] if node["kind"] == "input")
        input_node["inputType"] = "checkbox"
        content["variables"][0]["initialValue"] = "true"
        content["variables"].insert(0, {"path": "unrelated.label", "initialValue": "Keep"})

        result = validate_runtime_result(candidate)

        self.assertFalse(result["ok"])
        self.assertEqual(result["issues"], [{
            "code": "custom",
            "path": ["artifacts", 0, "content", "variables", 1, "initialValue"],
            "message": (
                "checkbox input variable form.name initialValue must be boolean; "
                "received string"
            ),
        }])
        self.assertEqual(content["variables"][1]["initialValue"], "true")
        content["variables"][1]["initialValue"] = True
        repaired = validate_runtime_result(candidate)
        self.assertTrue(repaired["ok"])
        self.assertNotEqual(result["candidateChecksum"], repaired["candidateChecksum"])

    def test_accepts_the_prd_v2_test_fixture_without_business_specific_runtime_rules(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))

        result = validate_runtime_result(candidate)

        self.assertTrue(result["ok"])
        self.assertEqual(result["issues"], [])

    def test_prd_expected_metadata_is_contract_owned_and_does_not_echo_candidate_values(self) -> None:
        draft = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))["artifacts"][0]
        sections = draft["content"]["sections"]
        expected_intro = sections["safetyBaseline"]["intro"]
        sections["safetyBaseline"]["intro"] = "PRIVATE_WRONG_INTRO"
        sections["introduction"]["scope"]["blocks"][0] = "PRIVATE_WRONG_BLOCK"
        del sections["degradation"]["content"][0]["marks"]
        before = copy.deepcopy(draft)

        result = validate_runtime_artifact_draft(draft)

        self.assertFalse(result["ok"])
        self.assertEqual(draft, before)
        intro = next(issue for issue in result["issues"] if issue["path"][-1] == "intro")
        self.assertEqual(intro["expectedValue"], expected_intro)
        self.assertIn("截图违依据", intro["expectedValue"])
        block = next(issue for issue in result["issues"] if issue["path"][-2:] == ["blocks", 0])
        self.assertEqual(block["expectedType"], "object")
        marks = next(issue for issue in result["issues"] if issue["path"][-1] == "marks")
        self.assertEqual(marks["expectedType"], "array")
        self.assertNotIn("PRIVATE_", json.dumps(result["issues"]))
        self.assertTrue(all(set(issue) <= {"code", "path", "message", "expectedType", "expectedValue"} for issue in result["issues"]))

    def test_toc_expected_values_skip_authored_headings_and_account_for_their_offset(self) -> None:
        draft = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))["artifacts"][0]
        content = draft["content"]
        content["sections"]["businessRequirements"]["additionalSections"] = [{
            "title": "2.5 PRIVATE_AUTHORED_HEADING",
            "blocks": [{"id": "extra_section_text", "type": "paragraph", "content": [
                {"type": "text", "text": "沿用正文已经说明的业务范围。", "marks": []},
            ]}],
        }]
        content["tableOfContents"]["entries"][9:9] = ["2.5 WRONG"]
        content["tableOfContents"]["entries"][-2:] = ["3 无点", "4 无点"]

        result = validate_runtime_artifact_draft(draft)

        self.assertFalse(result["ok"])
        toc = {issue["path"][-1]: issue for issue in result["issues"] if issue["path"][:3] == ["content", "tableOfContents", "entries"]}
        self.assertNotIn("expectedValue", toc[9])
        self.assertEqual(toc[10]["expectedValue"], "3. 业务降级方案（必填）")
        self.assertEqual(toc[11]["expectedValue"], "4. 需求安全基线要求（必填）")
        self.assertTrue(all("PRIVATE_" not in str(issue.get("expectedValue", "")) for issue in result["issues"]))

    def test_expected_value_metadata_is_not_added_for_prototype_or_unknown_literal_paths(self) -> None:
        candidate = copy.deepcopy(self.example)
        candidate["protocol"] = "WRONG_PROTOCOL"
        candidate["artifacts"][0]["content"]["protocol"] = "WRONG_CONTENT_PROTOCOL"
        result = validate_runtime_result(candidate)
        self.assertFalse(result["ok"])
        self.assertTrue(all("expectedValue" not in issue for issue in result["issues"]))

    def test_rejects_vague_acceptance_text_before_publishing_a_prd(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        section = candidate["artifacts"][0]["content"]["sections"]["businessRequirements"]["acceptanceCriteria"]
        table = next(block for block in section["blocks"] if block["type"] == "table")
        standard_column_id = table["columns"][2]["id"]
        standard = next(
            cell for cell in table["rows"][0]["cells"]
            if cell["columnId"] == standard_column_id
        )
        standard["content"] = [{"type": "text", "text": "页面正常显示内容，符合预期。", "marks": []}]

        result = validate_runtime_result(candidate)

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"] == [
                "artifacts", 0, "content", "sections", "businessRequirements",
                "acceptanceCriteria", "blocks", "rows", 0,
            ]
            and "observable results" in issue["message"]
            for issue in result["issues"]
        ))

    def test_rejects_missing_recovery_branch_before_publishing_a_prd(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        content = candidate["artifacts"][0]["content"]
        self.assertTrue(content["sections"]["degradation"]["applicable"])
        flow = content["sections"]["businessRequirements"]["flowAndPages"]["diagrams"][0]
        flow["edges"] = [
            {
                "id": f"validation-linear-edge-{index}",
                "from": current["id"],
                "to": following["id"],
                "label": None,
            }
            for index, (current, following) in enumerate(zip(flow["nodes"], flow["nodes"][1:]))
        ]

        result = validate_runtime_result(candidate)

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"] == [
                "artifacts", 0, "content", "sections", "businessRequirements",
                "flowAndPages", "diagrams", 0,
            ]
            and "failure and recovery branch" in issue["message"]
            for issue in result["issues"]
        ))

    def test_validates_one_draft_without_result_path_prefixes(self) -> None:
        draft = copy.deepcopy(self.example["artifacts"][0])
        del draft["title"]

        result = validate_runtime_artifact_draft(draft)

        self.assertFalse(result["ok"])
        self.assertIn(("title",), {tuple(issue["path"]) for issue in result["issues"]})

    def test_reports_actionable_prd_v2_paths_for_misnested_sections(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        draft = candidate["artifacts"][0]
        content = draft["content"]
        sections = content["sections"]
        business = sections["businessRequirements"]
        sections["acceptanceCriteria"] = business.pop("acceptanceCriteria")
        sections["additionalSections"] = business.pop("additionalSections")
        content["degradation"] = sections.pop("degradation")
        content["safetyBaseline"] = sections.pop("safetyBaseline")

        result = validate_runtime_artifact_draft(draft)

        self.assertFalse(result["ok"])
        self.assertNotIn("invalid_union", {issue["code"] for issue in result["issues"]})
        paths = {tuple(issue["path"]) for issue in result["issues"]}
        self.assertIn(
            ("content", "sections", "businessRequirements", "acceptanceCriteria"),
            paths,
        )
        self.assertIn(("content", "sections", "degradation"), paths)
        self.assertIn(("content", "sections", "safetyBaseline"), paths)
        self.assertNotIn(("content", "sections", "executiveSummary"), paths)

    def test_keeps_an_ambiguous_union_when_no_schema_version_matches(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        draft = candidate["artifacts"][0]
        draft["schemaVersion"] = 4

        result = validate_runtime_artifact_draft(draft)

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["code"] == "invalid_union" and issue["path"] == ["schemaVersion"]
            for issue in result["issues"]
        ))
        self.assertFalse(any(
            issue["code"] == "invalid_literal" and issue["path"] == ["schemaVersion"]
            for issue in result["issues"]
        ))

    def test_keeps_an_ambiguous_union_when_no_token_type_matches(self) -> None:
        candidate = copy.deepcopy(self.example)
        candidate["artifacts"][0]["content"]["tokens"] = [{
            "id": "token_bad",
            "name": "Bad token",
            "type": "bogus",
            "value": 0,
        }]

        result = validate_runtime_result(candidate)

        token_path = ["artifacts", 0, "content", "tokens", 0]
        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["code"] == "invalid_union" and issue["path"] == token_path
            for issue in result["issues"]
        ))
        self.assertFalse(any(
            issue["code"] in {"invalid_enum_value", "invalid_literal"}
            and issue["path"] == [*token_path, "type"]
            for issue in result["issues"]
        ))

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
                "citations": copy.deepcopy(self.example["artifacts"][0]["citations"]),
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
