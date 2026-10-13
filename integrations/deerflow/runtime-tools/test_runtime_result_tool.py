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

from deerflow_workbench_tools.runtime_result_tool import (
    workbench_runtime_result_submit,
)
from deerflow_workbench_tools.runtime_result_validator import validate_runtime_result, validate_runtime_artifact_draft


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(
        context={
            "workbench": {
                "runId": "run_1",
                "runtimeAttemptId": "attempt_1",
            },
        },
        tool_call_id="call_1",
    )


def _runtime_with_messages(messages: list[object]) -> SimpleNamespace:
    runtime = _runtime()
    paired = [{"type": "human", "content": "Generate requested artifacts."}]
    for message in messages:
        artifact = getattr(message, "artifact", None)
        if isinstance(artifact, dict) and isinstance(artifact.get("draft"), dict):
            paired.append({"type": "ai", "tool_calls": [{
                "id": artifact["toolCallId"], "name": "workbench_artifact_draft_publish",
                "args": {"artifact_index": artifact["artifactIndex"], "draft": copy.deepcopy(artifact["draft"])},
            }]})
        paired.append(message)
    runtime.state = {"messages": paired}
    return runtime


def _checksum(payload: dict[str, object]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _draft_message(
    draft: dict[str, object],
    *,
    tool_call_id: str = "draft_call_1",
    artifact_index: int = 0,
    run_id: str = "run_1",
    runtime_attempt_id: str = "attempt_1",
) -> SimpleNamespace:
    envelope = {
        "protocol": "workbench.runtime.artifact-draft.v1",
        "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id,
        "toolCallId": tool_call_id,
        "artifactIndex": artifact_index,
        "ok": True,
        "draftChecksum": validate_runtime_artifact_draft(draft)["candidateChecksum"],
    }
    return SimpleNamespace(
        type="tool",
        name="workbench_artifact_draft_publish",
        tool_call_id=tool_call_id,
        status="success",
        content=json.dumps({"protocol": "workbench.runtime.artifact-draft-ack.v1", "ok": True, "artifactIndex": artifact_index,
                            "candidateChecksum": validate_runtime_artifact_draft(draft)["candidateChecksum"], "issues": []}),
        artifact={
            **envelope,
            "checksum": _checksum(envelope),
            "draft": draft,
        },
    )


class RuntimeResultToolTests(unittest.TestCase):
    def test_success_artifact_is_bound_to_runtime_scope_and_tool_call(self) -> None:
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "run": {"id": "result_1"},
        }
        validation = {
            "protocol": "workbench.runtime.validation.v1",
            "ok": True,
            "issues": [],
            "candidateChecksum": "c" * 64,
            "artifactChecksums": [],
        }

        with patch(
            "deerflow_workbench_tools.runtime_result_tool.validate_runtime_result",
            return_value=validation,
        ) as validate:
            content, artifact = workbench_runtime_result_submit.func(
                _runtime(),
                candidate,
            )

        envelope = {
            "protocol": "workbench.runtime.validated-result.v1",
            "runId": "run_1",
            "runtimeAttemptId": "attempt_1",
            "toolCallId": "call_1",
            "ok": True,
            "resultChecksum": "c" * 64,
        }
        self.assertEqual(artifact, {
            **envelope,
            "result": candidate,
            "checksum": _checksum(envelope),
        })
        self.assertEqual(json.loads(content), {
            "protocol": "workbench.runtime.validation.v1",
            "ok": True,
            "normalizations": [],
            "message": "Validated. Return only a concise user-facing completion message.",
        })
        validate.assert_called_once_with(candidate)

    def test_failure_artifact_is_bound_to_runtime_scope_and_tool_call(self) -> None:
        candidate = {"protocol": "workbench.runtime.result.v1"}
        issues = [{"path": ["artifacts"], "message": "Required"}]
        validation = {
            "protocol": "workbench.runtime.validation.v1",
            "ok": False,
            "issues": issues,
        }

        with patch(
            "deerflow_workbench_tools.runtime_result_tool.validate_runtime_result",
            return_value=validation,
        ):
            content, artifact = workbench_runtime_result_submit.func(
                _runtime(),
                candidate,
            )

        envelope = {
            "protocol": "workbench.runtime.validated-result.v1",
            "runId": "run_1",
            "runtimeAttemptId": "attempt_1",
            "toolCallId": "call_1",
            "ok": False,
        }
        self.assertEqual(artifact, {
            **envelope,
            "issues": issues,
            "checksum": _checksum(envelope),
        })
        feedback = json.loads(content)
        self.assertEqual(
            {key: feedback[key] for key in validation},
            validation,
        )
        self.assertIn("No result was accepted", feedback["repairInstruction"])
        self.assertIn("Continue until ok:true", feedback["repairInstruction"])
        self.assertNotIn("result", artifact)

    def test_document_example_in_model_visible_description_passes_real_validation(self) -> None:
        description = workbench_runtime_result_submit.func.__doc__
        self.assertIsNotNone(description)
        example_text = description.split("\n    {\"protocol\":", 1)[1]
        candidate, _ = json.JSONDecoder().raw_decode('{"protocol":' + example_text)

        result = validate_runtime_result(candidate)

        self.assertTrue(result["ok"], result["issues"])
        self.assertEqual(candidate["artifacts"][0]["kind"], "document")
        self.assertEqual(candidate["artifacts"][0]["operation"], {"kind": "create"})
        self.assertIs(type(candidate["artifacts"][0]["schemaVersion"]), int)

    def test_wrong_document_types_remain_rejected_with_specific_repair_hints(self) -> None:
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "测试文档",
            "artifacts": [{
                "kind": "document",
                "schemaVersion": "1",
                "title": "测试文档",
                "operation": "create",
                "citations": json.loads(
                    (Path(__file__).resolve().parents[3]
                     / "integrations/deerflow/skills/workbench/references"
                     / "prototype-runtime-result.example.json").read_text(encoding="utf-8"),
                )["artifacts"][0]["citations"],
                "content": {"text": "保留此正文。"},
            }],
        }
        original = copy.deepcopy(candidate)

        content, artifact = workbench_runtime_result_submit.func(_runtime(), candidate)

        feedback = json.loads(content)
        self.assertFalse(feedback["ok"])
        self.assertFalse(artifact["ok"])
        self.assertNotIn("result", artifact)
        self.assertNotIn("resultChecksum", artifact)
        self.assertEqual(candidate, original)
        paths = {tuple(issue["path"]) for issue in feedback["issues"]}
        self.assertEqual(paths, {
            ("artifacts", 0, "schemaVersion"),
            ("artifacts", 0, "operation"),
        })
        self.assertTrue(any("positive JSON integer" in hint for hint in feedback["repairHints"]))
        self.assertTrue(any('{"kind":"create"}' in hint for hint in feedback["repairHints"]))
        self.assertIn("Do not end the turn", feedback["repairInstruction"])

        repaired = copy.deepcopy(candidate)
        repaired["artifacts"][0]["schemaVersion"] = 1
        repaired["artifacts"][0]["operation"] = {"kind": "create"}
        accepted_content, accepted_artifact = workbench_runtime_result_submit.func(
            _runtime(),
            repaired,
        )
        self.assertTrue(json.loads(accepted_content)["ok"])
        self.assertTrue(accepted_artifact["ok"])
        self.assertEqual(accepted_artifact["result"], repaired)

    def test_recovers_null_prototype_result_fields_from_the_latest_successful_draft(self) -> None:
        draft = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "integrations/deerflow/skills/workbench/references"
                / "prototype-runtime-result.example.json"
            ).read_text(encoding="utf-8"),
        )["artifacts"][0]
        candidate = copy.deepcopy(draft)
        candidate.update({
            "title": [None],
            "content": [None],
            "operation": [None],
        })
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "done",
            "artifacts": [candidate],
        }
        original = copy.deepcopy(candidate)
        runtime = _runtime_with_messages([_draft_message(draft)])

        content, artifact = workbench_runtime_result_submit.func(runtime, candidate)

        self.assertTrue(json.loads(content)["ok"])
        self.assertEqual(artifact["result"], {
            **candidate,
            "artifacts": [draft],
        })
        self.assertEqual(candidate, original)
        normalizations = json.loads(content)["normalizations"]
        self.assertEqual(
            [normalization["path"] for normalization in normalizations],
            [
                ["artifacts", 0, "title"],
                ["artifacts", 0, "content"],
                ["artifacts", 0, "operation"],
            ],
        )
        self.assertTrue(all(
            normalization["action"] == "recovered-from-artifact-draft"
            for normalization in normalizations
        ))

    def test_recovers_null_prd_result_fields_from_the_latest_successful_draft(self) -> None:
        draft = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json"
            ).read_text(encoding="utf-8"),
        )["artifacts"][0]
        candidate_artifact = copy.deepcopy(draft)
        candidate_artifact.update({
            "title": [None],
            "content": [None],
            "operation": [None],
        })
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "done",
            "artifacts": [candidate_artifact],
        }
        runtime = _runtime_with_messages([_draft_message(draft)])

        content, artifact = workbench_runtime_result_submit.func(runtime, candidate)

        self.assertTrue(json.loads(content)["ok"])
        self.assertEqual(artifact["result"]["artifacts"][0], draft)
        self.assertEqual(
            [normalization["path"] for normalization in json.loads(content)["normalizations"]],
            [
                ["artifacts", 0, "title"],
                ["artifacts", 0, "content"],
                ["artifacts", 0, "operation"],
            ],
        )

    def test_does_not_coerce_null_or_other_invalid_types_without_an_exact_placeholder(self) -> None:
        draft = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "integrations/deerflow/skills/workbench/references"
                / "prototype-runtime-result.example.json"
            ).read_text(encoding="utf-8"),
        )["artifacts"][0]
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "done",
            "artifacts": [{
                **copy.deepcopy(draft),
                "title": None,
                "content": [None],
                "operation": {"kind": "create"},
            }],
        }
        runtime = _runtime_with_messages([_draft_message(draft)])

        content, artifact = workbench_runtime_result_submit.func(runtime, candidate)

        self.assertFalse(json.loads(content)["ok"])
        self.assertFalse(artifact["ok"])
        self.assertEqual(candidate["artifacts"][0]["title"], None)
        self.assertEqual(candidate["artifacts"][0]["content"], [None])
        self.assertEqual(
            json.loads(content)["normalizations"][0]["path"],
            ["artifacts", 0, "content"],
        )

    def test_rejects_a_draft_with_a_tampered_envelope_checksum(self) -> None:
        draft = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "integrations/deerflow/skills/workbench/references"
                / "prototype-runtime-result.example.json"
            ).read_text(encoding="utf-8"),
        )["artifacts"][0]
        candidate_artifact = copy.deepcopy(draft)
        candidate_artifact.update({
            "title": [None],
            "content": [None],
            "operation": [None],
        })
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "done",
            "artifacts": [candidate_artifact],
        }
        message = _draft_message(draft)
        message.artifact["checksum"] = "0" * 64

        content, artifact = workbench_runtime_result_submit.func(
            _runtime_with_messages([message]),
            candidate,
        )

        self.assertFalse(json.loads(content)["ok"])
        self.assertFalse(artifact["ok"])
        self.assertEqual(json.loads(content)["normalizations"], [])

    def test_rejects_a_draft_when_the_message_tool_call_id_does_not_match(self) -> None:
        draft = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "integrations/deerflow/skills/workbench/references"
                / "prototype-runtime-result.example.json"
            ).read_text(encoding="utf-8"),
        )["artifacts"][0]
        candidate_artifact = copy.deepcopy(draft)
        candidate_artifact.update({
            "title": [None],
            "content": [None],
            "operation": [None],
        })
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "done",
            "artifacts": [candidate_artifact],
        }
        message = _draft_message(draft, tool_call_id="draft-artifact-id")
        message.tool_call_id = "different-message-id"

        content, artifact = workbench_runtime_result_submit.func(
            _runtime_with_messages([message]),
            candidate,
        )

        self.assertFalse(json.loads(content)["ok"])
        self.assertFalse(artifact["ok"])
        self.assertEqual(json.loads(content)["normalizations"], [])

    def test_rejects_an_invalid_draft_even_when_its_checksums_are_consistent(self) -> None:
        draft = {
            "kind": "prototype",
            "schemaVersion": 1,
            "title": "Draft",
            "operation": {"kind": "create"},
            "citations": [],
            "content": {},
        }
        candidate = {
            "protocol": "workbench.runtime.result.v1",
            "message": "done",
            "artifacts": [{
                **copy.deepcopy(draft),
                "title": [None],
                "content": [None],
                "operation": [None],
            }],
        }

        content, artifact = workbench_runtime_result_submit.func(
            _runtime_with_messages([_draft_message(draft)]),
            candidate,
        )

        self.assertFalse(json.loads(content)["ok"])
        self.assertFalse(artifact["ok"])
        self.assertEqual(json.loads(content)["normalizations"], [])

    def test_rejects_missing_runtime_scope_before_validation(self) -> None:
        runtime = SimpleNamespace(context={}, tool_call_id="call_1")

        with patch(
            "deerflow_workbench_tools.runtime_result_tool.validate_runtime_result",
        ) as validate:
            with self.assertRaisesRegex(
                ValueError,
                "WORKBENCH_RUNTIME_SCOPE_MISSING",
            ):
                workbench_runtime_result_submit.func(runtime, {})

        validate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
