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
langgraph = ModuleType("langgraph")
langgraph_config = ModuleType("langgraph.config")
langgraph_config.get_stream_writer = lambda: lambda _event: None
deerflow = ModuleType("deerflow")
deerflow_tools = ModuleType("deerflow.tools")
deerflow_tool_types = ModuleType("deerflow.tools.types")
deerflow_tool_types.Runtime = object
sys.modules.update({
    "langchain": langchain,
    "langchain.tools": langchain_tools,
    "langgraph": langgraph,
    "langgraph.config": langgraph_config,
    "deerflow": deerflow,
    "deerflow.tools": deerflow_tools,
    "deerflow.tools.types": deerflow_tool_types,
})

from deerflow_workbench_tools.generation_stage_tool import (
    workbench_generation_stage_update,
)


class GenerationStageToolTests(unittest.TestCase):
    def test_binds_artifact_to_runtime_scope_and_tool_call(self) -> None:
        writes: list[dict[str, object]] = []
        runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                    "requestedArtifactKinds": ["prototype"],
                },
            },
            tool_call_id="call_1",
        )

        with patch(
            "deerflow_workbench_tools.generation_stage_tool.get_stream_writer",
            return_value=writes.append,
        ):
            content, artifact = workbench_generation_stage_update.func(
                runtime,
                "design-system",
            )

        payload = {
            "protocol": "workbench.runtime.generation-stage.v1",
            "runId": "run_1",
            "runtimeAttemptId": "attempt_1",
            "toolCallId": "call_1",
            "stage": "design-system",
        }
        expected_checksum = hashlib.sha256(
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8"),
        ).hexdigest()
        self.assertEqual(json.loads(content)["ok"], True)
        self.assertEqual(artifact, {**payload, "checksum": expected_checksum})
        self.assertEqual(writes, [{**artifact, "pending": True}])

    def test_rejects_missing_runtime_scope(self) -> None:
        runtime = SimpleNamespace(context={}, tool_call_id="call_1")
        with self.assertRaisesRegex(ValueError, "WORKBENCH_RUNTIME_SCOPE_MISSING"):
            workbench_generation_stage_update.func(runtime, "generating-ui")

    def test_accepts_each_prd_stage_for_a_prd_run(self) -> None:
        stages = (
            "collecting-prd-context",
            "structuring-prd",
            "drafting-prd",
            "validating-prd",
        )
        for stage in stages:
            with self.subTest(stage=stage):
                runtime = SimpleNamespace(
                    context={
                        "workbench": {
                            "runId": "run_1",
                            "runtimeAttemptId": "attempt_1",
                            "requestedArtifactKinds": ["prd"],
                        },
                    },
                    tool_call_id=f"call_{stage}",
                )
                content, artifact = workbench_generation_stage_update.func(runtime, stage)
                self.assertEqual(json.loads(content)["stage"], stage)
                self.assertEqual(artifact["stage"], stage)

    def test_rejects_a_stage_from_the_wrong_artifact_family(self) -> None:
        prd_runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                    "requestedArtifactKinds": ["prd"],
                },
            },
            tool_call_id="call_1",
        )
        prototype_runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                    "requestedArtifactKinds": ["prototype"],
                },
            },
            tool_call_id="call_2",
        )
        with self.assertRaisesRegex(ValueError, "WORKBENCH_PROTOTYPE_STAGE_NOT_REQUESTED"):
            workbench_generation_stage_update.func(prd_runtime, "generating-ui")
        with self.assertRaisesRegex(ValueError, "WORKBENCH_PRD_STAGE_NOT_REQUESTED"):
            workbench_generation_stage_update.func(prototype_runtime, "drafting-prd")


if __name__ == "__main__":
    unittest.main()
