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

    def test_normalizes_prototype_layout_aliases_before_validation(self) -> None:
        draft = copy.deepcopy(self.draft)
        draft["content"]["nodes"][0]["layout"]["justify"] = "space-between"

        content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            draft,
        )

        response = json.loads(content)
        self.assertTrue(response["ok"])
        self.assertEqual(
            artifact["draft"]["content"]["nodes"][0]["layout"]["justify"],
            "spaceBetween",
        )
        self.assertEqual(response["normalizations"][0]["to"], "spaceBetween")
        self.assertEqual(draft["content"]["nodes"][0]["layout"]["justify"], "space-between")

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

    def test_closes_existing_prd_requirement_criterion_links_before_validation(self) -> None:
        asymmetric = copy.deepcopy(self.prd_draft)
        requirement = asymmetric["content"]["sections"]["businessRequirements"]["coreRules"]["blocks"][1]
        requirement["acceptanceCriterionIds"] = []

        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            asymmetric,
        )

        response = json.loads(content)
        normalized_requirement = artifact["draft"]["content"]["sections"]["businessRequirements"]["coreRules"]["blocks"][1]
        self.assertEqual(response["ok"], True)
        self.assertEqual(normalized_requirement["acceptanceCriterionIds"], ["criterion-main"])
        self.assertEqual(response["normalizations"][0]["addedId"], "criterion-main")
        self.assertEqual(requirement["acceptanceCriterionIds"], [])

    def test_closes_existing_prd_criterion_requirement_links_before_validation(self) -> None:
        asymmetric = copy.deepcopy(self.prd_draft)
        criterion = asymmetric["content"]["sections"]["businessRequirements"]["acceptanceCriteria"]["blocks"][0]
        criterion["requirementIds"] = []

        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            asymmetric,
        )

        response = json.loads(content)
        normalized_criterion = artifact["draft"]["content"]["sections"]["businessRequirements"]["acceptanceCriteria"]["blocks"][0]
        self.assertEqual(response["ok"], True)
        self.assertEqual(normalized_criterion["requirementIds"], ["requirement-main"])
        self.assertEqual(response["normalizations"][0]["addedId"], "requirement-main")
        self.assertEqual(criterion["requirementIds"], [])

    def test_does_not_normalize_prd_links_when_referenced_ids_are_duplicated(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        core_rule_blocks = invalid["content"]["sections"]["businessRequirements"]["coreRules"]["blocks"]
        duplicate_requirement = copy.deepcopy(core_rule_blocks[1])
        duplicate_requirement["acceptanceCriterionIds"] = []
        core_rule_blocks.append(duplicate_requirement)
        criterion = invalid["content"]["sections"]["businessRequirements"]["acceptanceCriteria"]["blocks"][0]

        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            invalid,
        )

        response = json.loads(content)
        self.assertEqual(response["ok"], False)
        self.assertEqual(response["normalizations"], [])
        self.assertEqual(criterion["requirementIds"], ["requirement-main"])
        self.assertNotIn("draft", artifact)

    def test_does_not_hide_an_unknown_prd_acceptance_criterion(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        requirement = invalid["content"]["sections"]["businessRequirements"]["coreRules"]["blocks"][1]
        requirement["acceptanceCriterionIds"] = ["criterion-missing"]

        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            invalid,
        )

        response = json.loads(content)
        self.assertEqual(response["ok"], False)
        self.assertEqual(response["normalizations"][0]["addedId"], "criterion-main")
        self.assertTrue(any(
            "unknown acceptance criterion" in issue["message"]
            for issue in response["issues"]
        ))
        self.assertNotIn("draft", artifact)

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
