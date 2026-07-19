from __future__ import annotations

import hashlib
import json
import sys
import unittest
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

from deerflow_workbench_tools.prototype_patch_tool import (
    workbench_prototype_patch_publish,
)


class PrototypePatchToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                },
            },
            tool_call_id="patch_call_1",
        )
        self.operations = [{
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
        }]

    def test_binds_a_valid_patch_to_the_runtime_scope(self) -> None:
        content, artifact = workbench_prototype_patch_publish.func(
            self.runtime,
            0,
            "screen_home",
            0,
            1,
            self.operations,
            "a" * 64,
        )

        envelope = {
            "protocol": "workbench.runtime.prototype-patch-publication.v1",
            "runId": "run_1",
            "runtimeAttemptId": "attempt_1",
            "toolCallId": "patch_call_1",
            "ok": True,
            "patchChecksum": artifact["patchChecksum"],
        }
        expected_checksum = hashlib.sha256(
            json.dumps(
                envelope,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8"),
        ).hexdigest()
        response = json.loads(content)
        self.assertEqual(response["ok"], True)
        self.assertEqual(response["nextRevision"], 1)
        self.assertEqual(artifact, {
            **envelope,
            "patch": {
                "protocol": "workbench.runtime.prototype-patch.v1",
                "artifactIndex": 0,
                "screenId": "screen_home",
                "baseRevision": 0,
                "nextRevision": 1,
                "operations": self.operations,
                "resultingChecksum": "a" * 64,
            },
            "checksum": expected_checksum,
        })

    def test_returns_validation_issues_for_a_revision_gap(self) -> None:
        content, artifact = workbench_prototype_patch_publish.func(
            self.runtime,
            0,
            "screen_home",
            0,
            2,
            self.operations,
            "a" * 64,
        )

        response = json.loads(content)
        self.assertEqual(response["ok"], False)
        self.assertEqual(artifact["ok"], False)
        self.assertNotIn("patch", artifact)
        self.assertTrue(any(issue["path"] == ["nextRevision"] for issue in response["issues"]))

    def test_rejects_missing_trusted_runtime_scope(self) -> None:
        missing = SimpleNamespace(context={}, tool_call_id="patch_call_1")
        with self.assertRaisesRegex(ValueError, "WORKBENCH_RUNTIME_SCOPE_MISSING"):
            workbench_prototype_patch_publish.func(
                missing,
                0,
                "screen_home",
                0,
                1,
                self.operations,
                "a" * 64,
            )


if __name__ == "__main__":
    unittest.main()
