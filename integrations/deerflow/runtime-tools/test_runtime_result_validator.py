from __future__ import annotations

import copy
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from deerflow_workbench_tools.runtime_result_validator import (
    PRD_REFERENCE_SAMPLE_PHRASES,
    RuntimeResultValidatorError,
    _prd_reference_content_match,
    _prd_reference_content_matches,
    validate_runtime_artifact_draft,
    validate_runtime_prototype_patch,
    validate_runtime_result,
)


ROOT = Path(__file__).resolve().parents[3]
EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json"
PRD_EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prd-runtime-result.example.json"


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

    def test_rejects_the_unmaterialized_prd_reference_example(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))

        result = validate_runtime_result(candidate)

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"] == ["artifacts", 0, "content", "documentId"]
            and "reference example" in issue["message"]
            for issue in result["issues"]
        ))

    def test_rejects_a_large_prd_reference_copy_after_renaming_the_cover(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        artifact = candidate["artifacts"][0]
        artifact["title"] = "真实工单需求说明书"
        content = artifact["content"]
        content["documentId"] = "prd-real-work-order"
        content["title"] = "真实工单需求说明书"
        content["cover"] = {
            "workOrderName": "真实工单",
            "title": "真实工单需求说明书",
        }

        result = validate_runtime_result(candidate)

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"][:3] == ["artifacts", 0, "content"]
            and ("sample business content" in issue["message"] or "sample ID" in issue["message"])
            for issue in result["issues"]
        ))

    def test_rejects_one_unchanged_prd_reference_passage(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        artifact = candidate["artifacts"][0]
        artifact["title"] = "真实工单需求说明书"
        content = artifact["content"]
        content["documentId"] = "prd-real-work-order"
        content["title"] = "真实工单需求说明书"
        content["cover"] = {
            "workOrderName": "真实工单",
            "title": "真实工单需求说明书",
        }
        serialized = json.dumps(candidate, ensure_ascii=False)
        for index, phrase in enumerate(PRD_REFERENCE_SAMPLE_PHRASES, start=1):
            serialized = serialized.replace(phrase, f"已替换的真实业务内容{index}")
        candidate = json.loads(serialized)
        background = candidate["artifacts"][0]["content"]["sections"]["introduction"]["background"]
        background["blocks"][0]["content"][0]["text"] = PRD_REFERENCE_SAMPLE_PHRASES[0]

        result = validate_runtime_result(candidate)

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"][:3] == ["artifacts", 0, "content"]
            and ("sample business content" in issue["message"] or "sample ID" in issue["message"])
            for issue in result["issues"]
        ))

    def test_rejects_a_reference_copy_after_all_legacy_sentinels_are_replaced(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        artifact = candidate["artifacts"][0]
        artifact["title"] = "真实工单需求说明书"
        content = artifact["content"]
        content["documentId"] = "prd-real-work-order"
        content["title"] = "真实工单需求说明书"
        content["cover"] = {
            "workOrderName": "真实工单",
            "title": "真实工单需求说明书",
        }
        serialized = json.dumps(candidate, ensure_ascii=False)
        for index, phrase in enumerate(PRD_REFERENCE_SAMPLE_PHRASES, start=1):
            serialized = serialized.replace(phrase, f"已替换的真实业务内容{index}")

        result = validate_runtime_result(json.loads(serialized))

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"][:3] == ["artifacts", 0, "content"]
            and ("sample business content" in issue["message"] or "sample ID" in issue["message"])
            for issue in result["issues"]
        ))

    def test_rejects_reference_content_in_a_v2_revision(self) -> None:
        candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        candidate["artifacts"][0]["operation"] = {
            "kind": "revise",
            "target": {
                "artifactId": "artifact-existing-prd",
                "artifactVersionId": "version-existing-prd",
                "screenIds": [],
            },
        }

        result = validate_runtime_result(candidate)

        self.assertFalse(result["ok"])
        self.assertTrue(any(
            issue["path"][:3] == ["artifacts", 0, "content"]
            or issue["path"] == ["artifacts", 0, "title"]
            for issue in result["issues"]
        ))

    def test_reports_all_reference_paths_for_create_and_revise_in_one_round(self) -> None:
        for operation_kind in ("create", "revise"):
            with self.subTest(operation=operation_kind):
                candidate = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
                artifact = candidate["artifacts"][0]
                if operation_kind == "revise":
                    artifact["operation"] = {
                        "kind": "revise",
                        "target": {
                            "artifactId": "artifact-existing-prd",
                            "artifactVersionId": "version-existing-prd",
                            "screenIds": [],
                        },
                    }
                background = artifact["content"]["sections"]["introduction"]["background"]
                original_text = background["blocks"][0]["content"][0]["text"]
                split_at = len(original_text) // 2
                background["blocks"][0]["content"] = [
                    {"type": "text", "text": original_text[:split_at], "marks": []},
                    {"type": "text", "text": original_text[split_at:], "marks": []},
                ]

                result = validate_runtime_result(candidate)

                self.assertFalse(result["ok"])
                residue_issues = [
                    issue for issue in result["issues"]
                    if "sample ID" in issue["message"]
                    or "sample business content" in issue["message"]
                ]
                paths = {tuple(issue["path"]) for issue in residue_issues}
                self.assertIn((
                    "artifacts", 0, "content", "sections", "introduction", "background",
                    "blocks", 0, "id",
                ), paths)
                self.assertIn((
                    "artifacts", 0, "content", "sections", "businessRequirements",
                    "coreRules", "blocks", 0, "id",
                ), paths)
                self.assertIn((
                    "artifacts", 0, "content", "sections", "businessRequirements",
                    "summary", 0, "text",
                ), paths)
                self.assertIn((
                    "artifacts", 0, "content", "sections", "introduction", "background",
                    "blocks", 0, "content",
                ), paths)
                self.assertEqual(len(residue_issues), len(paths))

    def test_rejects_sample_business_text_embedded_inside_a_longer_leaf(self) -> None:
        match = _prd_reference_content_match({
            "background": (
                "本次签到活动仅调整参与记录，仍然原样保留工作台任务页面的入口、表单和结果区域。"
                "其余营销能力不在范围内。"
            ),
        })

        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match[0], ["background"])
        self.assertIn("embedded sample business content", match[1])

    def test_rejects_sample_business_text_split_across_adjacent_inlines(self) -> None:
        sample_text = "工作台任务页面的入口、表单和结果区域。"
        match = _prd_reference_content_match({
            "blocks": [{
                "content": [
                    {"type": "text", "text": sample_text[:10]},
                    {"type": "text", "text": sample_text[10:]},
                ],
            }],
        })

        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match[0], ["blocks", 0, "content"])
        self.assertIn("sample business content", match[1])

    def test_collects_all_business_paths_and_deduplicates_match_modes_per_path(self) -> None:
        exact = "工作台任务页面的入口、表单和结果区域。"
        split = "总体目标：让目标业务用户从端内入口完成任务提交、状态跟踪、异常恢复和结果确认的完整闭环。"
        matches = _prd_reference_content_matches({
            "exact": exact,
            "embedded": f"本次仅调整签到，原样保留{exact}其他能力不变。",
            "nearCopy": "任务状态、异常提示、重试和权限反馈规范。",
            "firstInlineGroup": [
                {"type": "text", "text": split[:20]},
                {"type": "text", "text": split[20:]},
            ],
            "secondInlineGroup": [
                {"type": "text", "text": exact[:10]},
                {"type": "text", "text": exact[10:]},
            ],
        })

        messages_by_path = {
            tuple(path): message
            for path, message in matches
        }
        self.assertEqual(len(matches), len(messages_by_path))
        self.assertIn(("exact",), messages_by_path)
        self.assertIn("unchanged", messages_by_path[("exact",)])
        self.assertIn(("embedded",), messages_by_path)
        self.assertIn("embedded", messages_by_path[("embedded",)])
        self.assertIn(("nearCopy",), messages_by_path)
        self.assertIn("near-copied", messages_by_path[("nearCopy",)])
        self.assertIn(("firstInlineGroup",), messages_by_path)
        self.assertIn(("secondInlineGroup",), messages_by_path)

    def test_allows_generic_template_language_without_sample_business_facts(self) -> None:
        self.assertIsNone(_prd_reference_content_match({
            "notes": "形成首版需求说明书并进入评审。",
            "acceptance": "页面与状态可见性",
            "scope": "验收标准、业务降级方案和需求安全基线。",
            "text": "page rule item standard sequence",
        }))

    def test_rejects_a_sample_id_only_in_a_typed_id_field(self) -> None:
        match = _prd_reference_content_match({
            "id": "page",
            "content": [{"type": "text", "text": "page"}],
        })

        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match[0], ["id"])
        self.assertIn("sample ID", match[1])

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
