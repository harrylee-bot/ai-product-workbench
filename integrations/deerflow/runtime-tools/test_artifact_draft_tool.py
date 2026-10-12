from __future__ import annotations

import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace


def _tool(*_args: object, **_kwargs: object):
    def decorate(function):
        function.func = function
        return function

    return decorate


langchain = ModuleType("langchain")
langchain_tools = ModuleType("langchain.tools")
langchain_tools.tool = _tool
deerflow = ModuleType("deerflow")
deerflow_tools = ModuleType("deerflow.tools")
deerflow_tool_types = ModuleType("deerflow.tools.types")
deerflow_tool_types.Runtime = object
sys.modules.update({
    "langchain": langchain,
    "langchain.tools": langchain_tools,
    "deerflow": deerflow,
    "deerflow.tools": deerflow_tools,
    "deerflow.tools.types": deerflow_tool_types,
})

from deerflow_workbench_tools.artifact_draft_tool import (
    _has_prd_shape_failure,
    _misplaced_prd_sections,
    workbench_artifact_draft_publish,
)


ROOT = Path(__file__).resolve().parents[3]
PROTOTYPE_EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json"
PRD_EXAMPLE_PATH = ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json"


class ArtifactDraftToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                    "requestedArtifactKinds": ["prototype"],
                },
            },
            tool_call_id="call_1",
        )
        self.prd_runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                    "requestedArtifactKinds": ["prd"],
                },
            },
            tool_call_id="call_prd",
        )
        result = json.loads(PROTOTYPE_EXAMPLE_PATH.read_text(encoding="utf-8"))
        self.draft = result["artifacts"][0]
        prd_result = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        self.prd_draft = prd_result["artifacts"][0]

    def test_binds_a_valid_draft_to_the_runtime_scope(self) -> None:
        content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            self.draft,
        )

        envelope = {
            "protocol": "workbench.runtime.artifact-draft.v1",
            "runId": "run_1",
            "runtimeAttemptId": "attempt_1",
            "toolCallId": "call_1",
            "artifactIndex": 0,
            "ok": True,
            "draftChecksum": artifact["draftChecksum"],
        }
        expected_checksum = hashlib.sha256(
            json.dumps(
                envelope,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8"),
        ).hexdigest()
        self.assertEqual(json.loads(content)["ok"], True)
        self.assertEqual(artifact, {
            **envelope,
            "draft": self.draft,
            "checksum": expected_checksum,
        })

    def test_returns_scoped_validation_issues_for_an_invalid_draft(self) -> None:
        invalid = copy.deepcopy(self.draft)
        del invalid["title"]

        content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            invalid,
        )

        response = json.loads(content)
        self.assertEqual(response["ok"], False)
        self.assertEqual(artifact["ok"], False)
        self.assertTrue(any(issue["path"] == ["title"] for issue in response["issues"]))
        self.assertNotIn("draft", artifact)

    def test_checkbox_repair_names_the_variable_and_preserves_false_without_coercion(self) -> None:
        invalid = copy.deepcopy(self.draft)
        input_node = next(
            node for node in invalid["content"]["nodes"] if node["kind"] == "input"
        )
        input_node["inputType"] = "checkbox"
        invalid["content"]["variables"][0]["initialValue"] = "false"
        before = copy.deepcopy(invalid)

        content, artifact = workbench_artifact_draft_publish.func(self.runtime, 0, invalid)
        repeated_content, _ = workbench_artifact_draft_publish.func(self.runtime, 0, invalid)
        response = json.loads(content)
        repeated_response = json.loads(repeated_content)

        self.assertFalse(response["ok"])
        self.assertEqual(response["issues"], [{
            "code": "custom",
            "path": ["content", "variables", 0, "initialValue"],
            "message": (
                "checkbox input variable form.name initialValue must be boolean; "
                "received string"
            ),
        }])
        self.assertIn("JSON boolean true or false", response["repairInstruction"])
        self.assertIn('never the strings "true" or "false"', response["repairInstruction"])
        self.assertIn("Do not resubmit an unchanged candidate", response["repairInstruction"])
        self.assertNotIn("continue repairing until", response["repairInstruction"])
        self.assertRegex(response["candidateChecksum"], r"^[0-9a-f]{64}$")
        self.assertEqual(repeated_response, response)
        self.assertEqual(invalid, before)
        self.assertNotIn("draft", artifact)

        repaired = copy.deepcopy(invalid)
        repaired["content"]["variables"][0]["initialValue"] = False
        repaired_content, repaired_artifact = workbench_artifact_draft_publish.func(
            self.runtime, 0, repaired,
        )
        repaired_response = json.loads(repaired_content)
        self.assertTrue(repaired_response["ok"])
        self.assertNotEqual(repaired_response["candidateChecksum"], response["candidateChecksum"])
        self.assertIs(
            repaired_artifact["draft"]["content"]["variables"][0]["initialValue"], False,
        )
        self.assertEqual(repaired_artifact["draft"]["content"]["bindings"], before["content"]["bindings"])

    def test_identical_valid_drafts_remain_idempotently_accepted(self) -> None:
        first_content, first_artifact = workbench_artifact_draft_publish.func(
            self.runtime, 0, self.draft,
        )
        self.runtime.tool_call_id = "call_repeat"
        repeated_content, repeated_artifact = workbench_artifact_draft_publish.func(
            self.runtime, 0, copy.deepcopy(self.draft),
        )
        first_response = json.loads(first_content)
        repeated_response = json.loads(repeated_content)

        self.assertTrue(first_response["ok"])
        self.assertTrue(repeated_response["ok"])
        self.assertEqual(first_response["candidateChecksum"], repeated_response["candidateChecksum"])
        self.assertEqual(first_artifact["draftChecksum"], repeated_artifact["draftChecksum"])
        self.assertEqual(first_artifact["draft"], repeated_artifact["draft"])
        self.assertNotIn("repairInstruction", repeated_response)

    def test_accepts_a_complete_prd_v2_draft_and_rejects_an_incomplete_safety_table(self) -> None:
        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            self.prd_draft,
        )

        self.assertEqual(json.loads(content)["ok"], True)
        self.assertEqual(artifact["draft"]["content"]["protocol"], "workbench.prd.v2")

        invalid = copy.deepcopy(self.prd_draft)
        invalid["content"]["sections"]["safetyBaseline"]["rows"].pop()
        invalid_content, invalid_artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            invalid,
        )
        self.assertEqual(json.loads(invalid_content)["ok"], False)
        self.assertEqual(invalid_artifact["ok"], False)
        self.assertNotIn("draft", invalid_artifact)

    def test_prd_semantic_errors_preserve_the_complete_draft_for_local_repair(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        section = invalid["content"]["sections"]["businessRequirements"]["acceptanceCriteria"]
        table = next(block for block in section["blocks"] if block["type"] == "table")
        standard_column_id = table["columns"][2]["id"]
        standard = next(
            cell for cell in table["rows"][0]["cells"]
            if cell["columnId"] == standard_column_id
        )
        standard["content"] = [
            {"type": "text", "text": "页面正常显示内容，符合预期。", "marks": []},
        ]
        before = copy.deepcopy(invalid)

        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime, 0, invalid,
        )

        response = json.loads(content)
        self.assertFalse(response["ok"])
        self.assertTrue(any(
            "observable results" in issue["message"] for issue in response["issues"]
        ))
        self.assertIn("Edit only the returned issue paths", response["repairInstruction"])
        self.assertNotIn("top-level PRD structure", response["repairInstruction"])
        self.assertNotIn("draft", artifact)
        self.assertEqual(invalid, before)

    def test_prd_root_type_errors_describe_the_actual_directory_object(self) -> None:
        for root in ("sections", "tableOfContents"):
            with self.subTest(root=root):
                invalid = copy.deepcopy(self.prd_draft)
                invalid["content"][root] = []
                content, artifact = workbench_artifact_draft_publish.func(
                    self.prd_runtime, 0, invalid,
                )
                response = json.loads(content)
                self.assertFalse(response["ok"])
                self.assertTrue(any(
                    issue["path"] == ["content", root]
                    and issue["code"] == "invalid_type"
                    for issue in response["issues"]
                ))
                self.assertIn(
                    "revision, cover, tableOfContents, and sections are objects",
                    response["repairInstruction"],
                )
                self.assertIn("tableOfContents.entries", response["repairInstruction"])
                self.assertNotIn("draft", artifact)

    def test_misplaced_prd_sections_are_rejected_then_preserved_by_explicit_repair(self) -> None:
        for names in (
            ("businessRequirements", "degradation", "safetyBaseline"),
            ("degradation",),
        ):
            with self.subTest(names=names):
                invalid = copy.deepcopy(self.prd_draft)
                sections = invalid["content"]["sections"]
                for name in names:
                    sections["introduction"][name] = sections.pop(name)
                before = copy.deepcopy(invalid)
                content, artifact = workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)
                response = json.loads(content)
                self.assertFalse(response["ok"])
                self.assertNotIn("draft", artifact)
                self.assertEqual(invalid, before)
                self.assertEqual(_misplaced_prd_sections(invalid, response["issues"]), list(names))
                for name in names:
                    self.assertIn(
                        f"content.sections.introduction.{name} to content.sections.{name}",
                        response["repairInstruction"],
                    )
                self.assertIn("Do not repeat generation stages", response["repairInstruction"])
                repaired = copy.deepcopy(invalid)
                for name in names:
                    repaired["content"]["sections"][name] = repaired["content"]["sections"]["introduction"].pop(name)
                repaired_content, accepted = workbench_artifact_draft_publish.func(self.prd_runtime, 0, repaired)
                self.assertTrue(json.loads(repaired_content)["ok"])
                self.assertEqual(accepted["draft"], self.prd_draft)

    def test_misplaced_section_guidance_never_overwrites_existing_or_wrong_type_fields(self) -> None:
        for case in ("existing", "wrong_type", "missing_parent_issue", "missing_sibling_issue", "non_prd"):
            with self.subTest(case=case):
                invalid = copy.deepcopy(self.prd_draft)
                sections = invalid["content"]["sections"]
                sections["introduction"]["degradation"] = sections.pop("degradation")
                issues = [
                    {"code": "unrecognized_keys", "path": ["content", "sections", "introduction"]},
                    {"code": "invalid_type", "path": ["content", "sections", "degradation"]},
                ]
                if case == "existing":
                    sections["degradation"] = None
                elif case == "wrong_type":
                    sections["introduction"]["degradation"] = []
                elif case == "missing_parent_issue":
                    issues.pop(0)
                elif case == "missing_sibling_issue":
                    issues.pop()
                else:
                    invalid["kind"] = "prototype"
                self.assertEqual(_misplaced_prd_sections(invalid, issues), [])

    def test_nested_prd_type_errors_and_extra_keys_need_only_local_repairs(self) -> None:
        for mutate in (
            lambda content: content["tableOfContents"].update(entries={}),
            lambda content: content["sections"].update(businessRequirements=None),
            lambda content: content.update(placeholder=True),
        ):
            invalid = copy.deepcopy(self.prd_draft)
            mutate(invalid["content"])
            content, _ = workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)
            response = json.loads(content)
            self.assertFalse(response["ok"])
            self.assertIn("Edit only the returned issue paths", response["repairInstruction"])

    def test_prd_shape_detection_does_not_reclassify_root_semantic_errors(self) -> None:
        for code in ("custom", "too_small", "unrecognized_keys"):
            self.assertFalse(_has_prd_shape_failure(
                self.prd_draft, [{"path": ["content", "sections"], "code": code}],
            ))
        self.assertTrue(_has_prd_shape_failure(
            self.prd_draft, [{"path": ["content"], "code": "invalid_type"}],
        ))
        self.assertFalse(_has_prd_shape_failure(
            self.draft, [{"path": ["content"], "code": "invalid_type"}],
        ))
        self.assertFalse(_has_prd_shape_failure(None, [None]))

    def test_rejects_an_unstable_artifact_index(self) -> None:
        with self.assertRaisesRegex(ValueError, "WORKBENCH_ARTIFACT_DRAFT_INDEX_INVALID"):
            workbench_artifact_draft_publish.func(self.runtime, 20, self.draft)

    def test_rejects_a_draft_kind_not_requested_by_the_run(self) -> None:
        with self.assertRaisesRegex(ValueError, "WORKBENCH_ARTIFACT_DRAFT_KIND_NOT_REQUESTED"):
            workbench_artifact_draft_publish.func(self.prd_runtime, 0, self.draft)
        with self.assertRaisesRegex(ValueError, "WORKBENCH_ARTIFACT_DRAFT_KIND_NOT_REQUESTED"):
            workbench_artifact_draft_publish.func(self.runtime, 0, self.prd_draft)


if __name__ == "__main__":
    unittest.main()
