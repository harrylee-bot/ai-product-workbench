"""Run with the pinned real runtime to verify PRD repair and linked progression."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[3]
PATCH_ROOT = ROOT / "integrations/deerflow/source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2"


def real_runtime_available() -> bool:
    try:
        from langchain.agents import create_agent  # noqa: F401
        from deerflow.tools.types import Runtime  # noqa: F401
    except (ImportError, ModuleNotFoundError):
        return False
    return True


@unittest.skipUnless(real_runtime_available(), "requires the pinned real LangChain/LangGraph runtime")
class PrdRepairGraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_prd_repair_unlocks_linked_prototype_context_without_rewriting_args(self):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage
        from deerflow_workbench_tools.artifact_draft_tool import workbench_artifact_draft_publish
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft

        spec = importlib.util.spec_from_file_location("workbench_scope_graph_test_helpers", PATCH_ROOT / "test_workbench_tool_scope_middleware.py")
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        helpers = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = helpers
        spec.loader.exec_module(helpers)
        middleware_module = helpers.middleware_module
        original = json.loads((ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json").read_text())["artifacts"][0]
        self.assertTrue(validate_runtime_artifact_draft(original)["ok"])
        broken = copy.deepcopy(original)
        sections = broken["content"]["sections"]
        sections["introduction"]["businessRequirements"] = sections.pop("businessRequirements")
        rejected = validate_runtime_artifact_draft(broken)
        self.assertFalse(rejected["ok"])
        repair = {
            "baseCandidateChecksum": rejected["candidateChecksum"],
            "operations": [{
                "op": "move", "from": "/content/sections/introduction/businessRequirements",
                "path": "/content/sections/businessRequirements",
            }],
        }

        captures = []

        class CapturingModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                return self

            def _generate(self, messages, *args, **kwargs):
                captures.append(messages)
                return super()._generate(messages, *args, **kwargs)

        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                captures.clear()
                initial = helpers.automatic_prd_request().state
                del initial["messages"][-2:]
                initial_before = copy.deepcopy(initial)
                model = CapturingModel(responses=[
                    AIMessage(content="", tool_calls=[helpers.call("workbench_artifact_draft_publish", "real-prd-base", {"artifact_index": 0, "draft": copy.deepcopy(broken)})]),
                    AIMessage(content="", tool_calls=[helpers.call("workbench_artifact_draft_publish", "real-prd-repair", {"artifact_index": 0, "repair": copy.deepcopy(repair)})]),
                    AIMessage(content="PRD checkpoint accepted; continue the prototype workflow."),
                ])
                middleware = helpers.WorkbenchToolScopeMiddleware(
                    None, ["prd", "prototype"], run_scope=("run-auto", "attempt-auto"),
                )
                graph = create_agent(model, tools=[workbench_artifact_draft_publish], middleware=[middleware])
                with unittest.mock.patch.object(
                    middleware_module, "_PROTOTYPE_REFERENCE_DIRECTORY",
                    ROOT / "integrations/deerflow/skills/workbench/references",
                ):
                    kwargs = {"context": {"workbench": {
                        "runId": "run-auto", "runtimeAttemptId": "attempt-auto",
                        "requestedArtifactKinds": ["prd", "prototype"],
                    }}}
                    result = await graph.ainvoke(initial, **kwargs) if asynchronous else graph.invoke(initial, **kwargs)
                self.assertEqual(initial, initial_before)
                receipts = {message.tool_call_id: message for message in result["messages"] if middleware_module._is_tool_message(message)}
                self.assertFalse(receipts["real-prd-base"].artifact["ok"])
                accepted = receipts["real-prd-repair"].artifact
                self.assertTrue(accepted["ok"])
                self.assertEqual(accepted["draft"], original)
                self.assertEqual(accepted["draftChecksum"], validate_runtime_artifact_draft(original)["candidateChecksum"])
                declarations = [
                    call for message in result["messages"] if middleware_module._is_ai_message(message)
                    for call in message.tool_calls if call["id"] == "real-prd-repair"
                ]
                self.assertEqual(len(declarations), 1)
                self.assertEqual(declarations[0]["args"], {"artifact_index": 0, "repair": repair})
                self.assertEqual(len(captures), 3)
                marker = "<workbench_prototype_transport_context>"
                for messages in captures[:2]:
                    self.assertFalse(any(marker in str(message.content) for message in messages if message.type == "system"))
                self.assertTrue(any(marker in str(message.content) for message in captures[2] if message.type == "system"))
                self.assertEqual(middleware_module._stage_progress(result, "run-auto", "attempt-auto"), (4, False))
                self.assertEqual(middleware_module._successful_prd_drafts(result, "run-auto", "attempt-auto"), (1, False))
                self.assertEqual(middleware_module._successful_runtime_results(result, "run-auto", "attempt-auto"), (0, False))


if __name__ == "__main__":
    unittest.main()
