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
EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json"


class ArtifactDraftToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                },
            },
            tool_call_id="call_1",
        )
        result = json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))
        self.draft = result["artifacts"][0]

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

    def test_rejects_an_unstable_artifact_index(self) -> None:
        with self.assertRaisesRegex(ValueError, "WORKBENCH_ARTIFACT_DRAFT_INDEX_INVALID"):
            workbench_artifact_draft_publish.func(self.runtime, 20, self.draft)


if __name__ == "__main__":
    unittest.main()
