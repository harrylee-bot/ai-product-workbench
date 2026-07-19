from __future__ import annotations

import hashlib
import json
import sys
import unittest
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


def _checksum(payload: dict[str, object]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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
        self.assertEqual(json.loads(content), validation)
        self.assertNotIn("result", artifact)

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
