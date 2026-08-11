from __future__ import annotations

import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


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

    def test_normalizes_observed_prototype_gaps_before_draft_validation(self) -> None:
        draft = {
            "kind": "prototype",
            "content": {
                "protocol": "workbench.prototype.v1",
                "nodes": [{
                    "kind": "text",
                    "style": {"typography": None},
                    "textStyle": {"align": "left"},
                }, {
                    "kind": "input",
                    "style": {"typography": None},
                    "required": True,
                    "fieldName": "email",
                    "optionValue": None,
                }],
                "motions": [{"trigger": "mount"}],
            },
        }
        validation = {
            "protocol": "workbench.runtime.validation.v1",
            "ok": True,
            "issues": [],
            "candidateChecksum": "c" * 64,
        }

        with patch(
            "deerflow_workbench_tools.artifact_draft_tool.validate_runtime_artifact_draft",
            return_value=validation,
        ) as validate:
            content, artifact = workbench_artifact_draft_publish.func(
                self.runtime,
                0,
                draft,
            )

        normalized = validate.call_args.args[0]
        document = normalized["content"]
        self.assertIsNone(document["nodes"][0]["maxLines"])
        self.assertNotIn("textStyle", document["nodes"][0])
        self.assertEqual(document["motions"][0]["trigger"], "enter")
        for field in ("tokens", "assets", "variables", "states", "actions", "bindings"):
            self.assertEqual(document[field], [])
        self.assertTrue(document["nodes"][1]["required"])
        self.assertEqual(document["nodes"][1]["fieldName"], "email")
        self.assertIsNone(document["nodes"][1]["optionValue"])
        self.assertEqual(artifact["draft"], normalized)
        self.assertGreaterEqual(len(json.loads(content)["normalizations"]), 9)
        self.assertNotIn("maxLines", draft["content"]["nodes"][0])

    def test_accepts_a_complete_checkpoint_with_common_model_shape_drift(self) -> None:
        draft = copy.deepcopy(self.draft)
        content = draft["content"]
        root = content["nodes"][0]
        root.pop("clipContent")
        root["childIds"].extend(["missing-child", "node-group"])

        text = copy.deepcopy(root)
        text.update({
            "id": "node-compat-text",
            "kind": "text",
            "name": "compat-text",
            "parentId": root["id"],
            "label": "Checkpoint",
        })
        text.pop("childIds", None)
        text.pop("clipContent", None)
        text.pop("text", None)
        text.pop("maxLines", None)
        content["nodes"].append(text)
        root["childIds"].append(text["id"])
        content["nodes"].append({"id": "node-group", "name": "group"})
        content["nodes"].append("node-noise")

        content["screens"][0]["initialStateId"] = "state-missing"
        input_node = next(node for node in content["nodes"] if node.get("kind") == "input")
        content["bindings"] = [
            binding for binding in content["bindings"]
            if binding["id"] != input_node["bindingIds"][0]
        ]
        button = next(node for node in content["nodes"] if node.get("kind") == "button")
        button["actionIds"].append("action-missing")

        content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            draft,
        )

        response = json.loads(content)
        self.assertTrue(response["ok"])
        normalized = artifact["draft"]["content"]
        self.assertIsNone(normalized["screens"][0]["initialStateId"])
        self.assertEqual(normalized["nodes"][0]["clipContent"], False)
        normalized_text = next(node for node in normalized["nodes"] if node["id"] == "node-compat-text")
        self.assertEqual(normalized_text["text"], "Checkpoint")
        self.assertNotIn("label", normalized_text)
        self.assertEqual(len(normalized["nodes"]), 5)
        normalized_input = next(node for node in normalized["nodes"] if node["kind"] == "input")
        self.assertEqual(len(normalized_input["bindingIds"]), 1)

    def test_repairs_missing_radio_bindings_with_one_shared_variable(self) -> None:
        draft = copy.deepcopy(self.draft)
        document = draft["content"]
        form = next(node for node in document["nodes"] if node["kind"] == "form")
        first_radio = next(node for node in document["nodes"] if node["kind"] == "input")
        first_radio.update({
            "inputType": "radio",
            "fieldName": "attendance",
            "label": "参加",
            "optionValue": "yes",
        })
        first_missing_binding_id = first_radio["bindingIds"][0]
        document["bindings"] = [
            binding for binding in document["bindings"]
            if binding["id"] != first_missing_binding_id
        ]

        second_radio = copy.deepcopy(first_radio)
        second_radio.update({
            "id": "node-attendance-no",
            "name": "不参加",
            "label": "不参加",
            "optionValue": "no",
            "bindingIds": ["binding-attendance-no-missing"],
        })
        submit_node_index = next(
            index for index, node in enumerate(document["nodes"])
            if node.get("kind") == "button"
        )
        document["nodes"].insert(submit_node_index, second_radio)
        form["childIds"].insert(-1, second_radio["id"])
        submit_action = next(
            action for action in document["actions"]
            if action["kind"] == "submit"
        )
        submit_action["bindingIds"] = [
            first_missing_binding_id,
            second_radio["bindingIds"][0],
        ]

        response_content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            draft,
        )

        self.assertTrue(json.loads(response_content)["ok"])
        normalized = artifact["draft"]["content"]
        normalized_radios = [
            node for node in normalized["nodes"]
            if node.get("kind") == "input" and node.get("fieldName") == "attendance"
        ]
        binding_by_id = {binding["id"]: binding for binding in normalized["bindings"]}
        radio_bindings = [
            binding_by_id[node["bindingIds"][0]]
            for node in normalized_radios
        ]
        normalized_submit = next(
            action for action in normalized["actions"]
            if action["kind"] == "submit"
        )
        self.assertEqual(len(normalized_radios), 2)
        self.assertEqual(len({binding["id"] for binding in radio_bindings}), 2)
        self.assertEqual(
            len({binding["source"]["path"] for binding in radio_bindings}),
            1,
        )
        self.assertEqual(len(normalized_submit["bindingIds"]), 1)
        self.assertIn(normalized_submit["bindingIds"][0], {
            binding["id"] for binding in radio_bindings
        })

    def test_reuses_an_input_value_binding_when_its_variable_is_missing(self) -> None:
        draft = copy.deepcopy(self.draft)
        document = draft["content"]
        input_node = next(node for node in document["nodes"] if node["kind"] == "input")
        value_binding = next(
            binding for binding in document["bindings"]
            if binding["id"] == input_node["bindingIds"][0]
        )
        value_binding["source"]["path"] = "missing.value"
        missing_binding_alias = "binding-name-missing-alias"
        input_node["bindingIds"].append(missing_binding_alias)
        submit_action = next(
            action for action in document["actions"]
            if action["kind"] == "submit"
        )
        submit_action["bindingIds"] = [missing_binding_alias]

        response_content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            draft,
        )

        self.assertTrue(json.loads(response_content)["ok"])
        normalized = artifact["draft"]["content"]
        normalized_input = next(node for node in normalized["nodes"] if node["kind"] == "input")
        input_value_bindings = [
            binding for binding in normalized["bindings"]
            if binding["nodeId"] == normalized_input["id"] and binding["property"] == "value"
        ]
        self.assertEqual(normalized_input["bindingIds"], [value_binding["id"]])
        self.assertEqual(len(input_value_bindings), 1)
        normalized_submit = next(
            action for action in normalized["actions"]
            if action["kind"] == "submit"
        )
        self.assertEqual(normalized_submit["bindingIds"], [value_binding["id"]])
        self.assertIn(
            input_value_bindings[0]["source"]["path"],
            {variable["path"] for variable in normalized["variables"]},
        )

    def test_prefers_a_valid_input_value_binding_over_an_invalid_first_binding(self) -> None:
        draft = copy.deepcopy(self.draft)
        document = draft["content"]
        input_node = next(node for node in document["nodes"] if node["kind"] == "input")
        first_binding = next(
            binding for binding in document["bindings"]
            if binding["id"] == input_node["bindingIds"][0]
        )
        first_binding["source"]["path"] = "missing.value"
        valid_binding = copy.deepcopy(first_binding)
        valid_binding.update({
            "id": "binding-name-valid",
            "source": {"kind": "variable", "path": "form.name"},
        })
        duplicate_valid_binding = copy.deepcopy(valid_binding)
        duplicate_valid_binding["id"] = "binding-name-valid-duplicate"
        document["bindings"].extend([valid_binding, duplicate_valid_binding])
        input_node["bindingIds"].extend([
            valid_binding["id"],
            duplicate_valid_binding["id"],
        ])

        response_content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            draft,
        )

        self.assertTrue(json.loads(response_content)["ok"])
        normalized = artifact["draft"]["content"]
        normalized_input = next(node for node in normalized["nodes"] if node["kind"] == "input")
        self.assertEqual(normalized_input["bindingIds"], [valid_binding["id"]])
        self.assertEqual(
            next(action for action in normalized["actions"] if action["kind"] == "submit")["bindingIds"],
            [valid_binding["id"]],
        )

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

    def test_routes_malformed_kind_to_schema_validation_instead_of_scope_rejection(self) -> None:
        malformed = {
            "kind": 1,
            "title": 1,
            "content": {"protocol": 1},
            "operation": 1,
            "citations": [],
            "schemaVersion": 2,
        }

        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            malformed,
        )

        response = json.loads(content)
        self.assertFalse(response["ok"])
        self.assertFalse(artifact["ok"])
        self.assertTrue(any(issue["path"] == ["kind"] for issue in response["issues"]))
        self.assertNotIn("WORKBENCH_ARTIFACT_DRAFT_KIND_NOT_REQUESTED", response["issues"])

        malformed["kind"] = "1"
        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            malformed,
        )
        response = json.loads(content)
        self.assertFalse(response["ok"])
        self.assertFalse(artifact["ok"])
        self.assertTrue(any(issue["path"] == ["kind"] for issue in response["issues"]))
        self.assertNotIn("WORKBENCH_ARTIFACT_DRAFT_KIND_NOT_REQUESTED", response["issues"])


if __name__ == "__main__":
    unittest.main()
