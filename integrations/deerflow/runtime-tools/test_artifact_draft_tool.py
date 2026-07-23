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
PRD_EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prd-runtime-result.example.json"
PRD_FINGERPRINT_PATH = (
    ROOT
    / "integrations/deerflow/runtime-tools/deerflow_workbench_tools/prd_reference_fingerprint.json"
)


def _replace_exact_strings(value: object, replacements: dict[str, str]) -> object:
    if isinstance(value, str):
        return replacements.get(value, value)
    if isinstance(value, list):
        return [_replace_exact_strings(item, replacements) for item in value]
    if isinstance(value, dict):
        return {
            key: _replace_exact_strings(item, replacements)
            for key, item in value.items()
        }
    return value


def _rewrite_reference_business_text(value: str) -> str:
    replacements = (
        ("产品工作台", "服务运营门户"),
        ("目标业务用户", "业务经办人员"),
        ("任务处理", "申请受理"),
        ("任务页面", "申请界面"),
        ("任务状态", "申请进度"),
        ("任务记录", "申请记录"),
        ("任务编号", "申请编号"),
        ("任务", "申请"),
        ("用户", "经办人员"),
        ("提交", "发起"),
        ("处理", "受理"),
        ("状态", "进度"),
        ("结果", "办理回执"),
        ("异常", "故障"),
        ("恢复", "续办"),
        ("权限", "操作资格"),
        ("校验", "检查"),
        ("输入", "表单内容"),
        ("页面", "界面"),
        ("成功", "办结"),
        ("失败", "未办结"),
        ("重试", "重新办理"),
        ("重复", "多次"),
        ("阶段", "环节"),
        ("需求说明书", "业务规格文档"),
        ("验收标准", "交付检查"),
        ("业务降级方案", "应急处置方案"),
        ("需求安全基线", "安全自查"),
    )
    rewritten = value
    for source, target in replacements:
        rewritten = rewritten.replace(source, target)
    if rewritten == value:
        raise AssertionError(f"Reference business text was not materialized: {value}")
    return rewritten


def _materialize_prd_reference(reference: dict[str, object]) -> dict[str, object]:
    draft = copy.deepcopy(reference)
    fingerprint = json.loads(PRD_FINGERPRINT_PATH.read_text(encoding="utf-8"))
    id_replacements = {
        sample_id: f"real-{index:02d}-{sample_id}"
        for index, sample_id in enumerate(fingerprint["sampleIds"], start=1)
    }
    business_replacements = {
        sample_text: _rewrite_reference_business_text(sample_text)
        for sample_text in fingerprint["businessText"]
    }
    draft = _replace_exact_strings(draft, {**id_replacements, **business_replacements})
    draft["title"] = "真实工单需求说明书"
    content = draft["content"]
    content["documentId"] = "prd-real-work-order"
    content["title"] = "真实工单需求说明书"
    content["cover"] = {
        "workOrderName": "真实工单",
        "title": "真实工单需求说明书",
    }
    return draft


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
        self.prd_reference_draft = prd_result["artifacts"][0]
        self.prd_draft = _materialize_prd_reference(self.prd_reference_draft)

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

    def test_rejects_the_unmaterialized_prd_reference_draft(self) -> None:
        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            self.prd_reference_draft,
        )

        response = json.loads(content)
        self.assertEqual(response["ok"], False)
        self.assertEqual(artifact["ok"], False)
        self.assertTrue(any(
            issue["path"] == ["content", "documentId"]
            for issue in response["issues"]
        ))
        self.assertNotIn("draft", artifact)

    def test_rejects_a_partially_materialized_prd_reference_draft(self) -> None:
        partial = copy.deepcopy(self.prd_reference_draft)
        partial["title"] = "真实工单需求说明书"
        partial["content"]["documentId"] = "prd-real-work-order"
        partial["content"]["title"] = "真实工单需求说明书"
        partial["content"]["cover"] = {
            "workOrderName": "真实工单",
            "title": "真实工单需求说明书",
        }
        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            partial,
        )

        response = json.loads(content)
        self.assertEqual(response["ok"], False)
        residue_issues = [
            issue for issue in response["issues"]
            if issue["path"][:1] == ["content"]
            and ("sample business content" in issue["message"] or "sample ID" in issue["message"])
        ]
        residue_paths = {tuple(issue["path"]) for issue in residue_issues}
        self.assertIn((
            "content", "sections", "introduction", "background", "blocks", 0, "id",
        ), residue_paths)
        self.assertIn((
            "content", "sections", "businessRequirements", "coreRules", "blocks", 0, "id",
        ), residue_paths)
        self.assertIn((
            "content", "sections", "businessRequirements", "summary", 0, "text",
        ), residue_paths)
        self.assertEqual(len(residue_issues), len(residue_paths))
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
