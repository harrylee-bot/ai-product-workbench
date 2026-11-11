"""V3 dynamic sections retain real validator and checksum-bound repair behavior."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from test_artifact_draft_tool import workbench_artifact_draft_publish
from deerflow_workbench_tools.artifact_draft_repair import _apply_repair
from deerflow_workbench_tools.prd_reference_normalizer import normalize_prd_bidirectional_references
from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft

ROOT = Path(__file__).resolve().parents[3]


class PrdV3RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.draft = json.loads((ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result-v3.example.json").read_text())["artifacts"][0]
        self.runtime = SimpleNamespace(context={"workbench": {"runId": "run_v3", "runtimeAttemptId": "attempt_v3", "requestedArtifactKinds": ["prd"]}}, state={"messages": [{"type": "human", "content": "Generate the requested requirement."}]}, tool_call_id="initial")

    def publish(self, call_id, **args):
        call = {"name": "workbench_artifact_draft_publish", "id": call_id, "args": {"artifact_index": 0, **args}}
        self.runtime.state["messages"].append({"type": "ai", "tool_calls": [call]})
        self.runtime.tool_call_id = call_id
        content, artifact = workbench_artifact_draft_publish.func(self.runtime, 0, **args)
        self.runtime.state["messages"].append({"type": "tool", "name": call["name"], "tool_call_id": call_id, "status": "success", "content": content, "artifact": artifact})
        return json.loads(content), artifact

    def test_complete_v3_and_legacy_v2_remain_valid(self):
        self.assertTrue(validate_runtime_artifact_draft(self.draft)["ok"])
        legacy = json.loads((ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json").read_text())["artifacts"][0]
        self.assertTrue(validate_runtime_artifact_draft(legacy)["ok"])
        self.draft["schemaVersion"] = 2
        self.assertFalse(validate_runtime_artifact_draft(self.draft)["ok"])

    def test_repairs_misnested_function_sections_without_rewriting_any_authored_content(self):
        invalid = copy.deepcopy(self.draft)
        invalid["functionSections"] = invalid["content"]["sections"]["businessRequirements"].pop("functionSections")
        ack, _ = self.publish("initial", draft=invalid)
        self.assertFalse(ack["ok"])
        self.assertTrue(any(hint.get("moveFrom") == ["functionSections"] and hint.get("path") == ["content", "sections", "businessRequirements", "functionSections"] for hint in ack["repairHints"]))
        accepted, artifact = self.publish("repair", repair={"baseCandidateChecksum": ack["candidateChecksum"], "operations": [{"op": "move", "from": "/functionSections", "path": "/content/sections/businessRequirements/functionSections"}]})
        self.assertTrue(accepted["ok"], accepted["issues"])
        self.assertEqual(artifact["draft"], self.draft)
        self.assertEqual(self.runtime.state["messages"][1]["tool_calls"][0]["args"]["draft"], invalid)

    def test_closes_only_declared_typed_links_across_real_function_paths(self):
        broken = copy.deepcopy(self.draft)
        functions = broken["content"]["sections"]["businessRequirements"]["functionSections"]
        criterion = functions[2]["blocks"][0]
        criterion["requirementIds"] = []
        original = copy.deepcopy(broken)
        normalized, repairs = normalize_prd_bidirectional_references(broken)
        self.assertEqual(broken, original)
        self.assertEqual(normalized, self.draft)
        self.assertEqual(repairs[0]["path"], ["content", "sections", "businessRequirements", "functionSections", 2, "blocks", 0, "requirementIds"])
        self.assertTrue(validate_runtime_artifact_draft(normalized)["ok"])
        functions[0]["blocks"][1]["acceptanceCriterionIds"] = ["unknown-criterion"]
        normalized, repairs = normalize_prd_bidirectional_references(broken)
        self.assertEqual(repairs, [])
        self.assertFalse(validate_runtime_artifact_draft(normalized)["ok"])

    def test_never_invents_a_typed_relation_from_an_acceptance_table_row(self):
        broken = copy.deepcopy(self.draft)
        functions = broken["content"]["sections"]["businessRequirements"]["functionSections"]
        requirement = functions[0]["blocks"][1]
        requirement["acceptanceCriterionIds"] = ["acceptance-visible"]
        functions[2]["blocks"][0]["requirementIds"] = []
        normalized, repairs = normalize_prd_bidirectional_references(broken)
        self.assertEqual(repairs, [])
        self.assertEqual(normalized, broken)
        self.assertFalse(validate_runtime_artifact_draft(normalized)["ok"])

    def test_restore_fixes_only_canonical_toc_and_intro_while_preserving_dynamic_titles(self):
        broken = copy.deepcopy(self.draft)
        broken["content"]["sections"]["safetyBaseline"]["intro"] = "rewritten fixed intro"
        entries = broken["content"]["tableOfContents"]["entries"]
        entries[0], entries[-1], entries[6] = "bad introduction", "bad safety", "business-authored mismatch"
        ack, _ = self.publish("initial", draft=broken)
        self.assertEqual(ack["templateRepair"]["operations"], [{"op": "restore", "path": "/content/sections/safetyBaseline/intro"}])
        # A literal parse error is repaired first; full semantic refinement then
        # exposes the fixed directory mismatches without leaking authored titles.
        rejected, artifact = self.publish("restore-intro", repair=ack["templateRepair"])
        self.assertFalse(rejected["ok"])
        operations = rejected["templateRepair"]["operations"]
        self.assertEqual({op["path"] for op in operations}, {"/content/tableOfContents/entries/0", f"/content/tableOfContents/entries/{len(entries)-1}"})
        rejected, artifact = self.publish("restore-toc", repair=rejected["templateRepair"])
        self.assertFalse(rejected["ok"])
        self.assertNotIn("draft", artifact)
        self.assertTrue(any(issue["path"] == ["content", "tableOfContents", "entries", 6] for issue in rejected["issues"]))

    def test_full_semantic_validation_still_rejects_vague_embedded_acceptance_and_safety_fabrication(self):
        broken = copy.deepcopy(self.draft)
        section = broken["content"]["sections"]["businessRequirements"]["functionSections"][2]
        section["blocks"][1]["rows"][0]["cells"][2]["content"][0]["text"] = "正确显示结果并且符合预期。"
        broken["content"]["sections"]["safetyBaseline"]["rows"][11] = {"sequence": 12, "applicability": "是", "remarks": "APP加载并提供双清单。"}
        result = validate_runtime_artifact_draft(broken)
        self.assertFalse(result["ok"])
        self.assertTrue(any("observable results" in issue["message"] for issue in result["issues"]))
        self.assertTrue(any("affirmative semantic evidence" in issue["message"] for issue in result["issues"]))
        with self.assertRaisesRegex(ValueError, "PATH_FORBIDDEN"):
            _apply_repair(broken, {"baseCandidateChecksum": result["candidateChecksum"], "operations": [{"op": "replace", "path": "/schemaVersion", "value": 2}]}, result["candidateChecksum"])


if __name__ == "__main__":
    unittest.main()
