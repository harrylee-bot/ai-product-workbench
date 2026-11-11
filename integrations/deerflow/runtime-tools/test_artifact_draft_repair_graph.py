"""Run with the pinned real runtime to verify PRD repair and linked progression."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[3]
PATCH_ROOT = ROOT / "integrations/deerflow/source-patches/345f08be00c8a9495079b732a39b46aa9af1584e"


def real_runtime_available() -> bool:
    try:
        from langchain.agents import create_agent  # noqa: F401
        from deerflow.tools.types import Runtime  # noqa: F401
    except (ImportError, ModuleNotFoundError):
        return False
    return True


@unittest.skipUnless(real_runtime_available(), "requires the pinned real LangChain/LangGraph runtime")
class PrdRepairGraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_template_restore_recovers_after_repeated_unchanged_model_repairs(self):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage
        from deerflow_workbench_tools.artifact_draft_tool import workbench_artifact_draft_publish
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft

        spec = importlib.util.spec_from_file_location("workbench_template_restore_graph_helpers", PATCH_ROOT / "test_workbench_tool_scope_middleware.py")
        helpers = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = helpers
        spec.loader.exec_module(helpers)
        original = json.loads((ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json").read_text())["artifacts"][0]
        broken = copy.deepcopy(original)
        broken["content"]["sections"]["safetyBaseline"]["intro"] = "模型反复提交的固定说明"
        checksum = validate_runtime_artifact_draft(broken)["candidateChecksum"]
        noop = {"baseCandidateChecksum": checksum, "operations": [{"op": "replace", "path": "/content/sections/safetyBaseline/intro", "value": broken["content"]["sections"]["safetyBaseline"]["intro"]}]}
        restore = {"baseCandidateChecksum": checksum, "operations": [{"op": "restore", "path": "/content/sections/safetyBaseline/intro"}]}

        class ToolModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                return self

        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                initial = helpers.automatic_prd_request().state
                del initial["messages"][-2:]
                initial_before = copy.deepcopy(initial)
                calls = [
                    helpers.call("workbench_artifact_draft_publish", "template-base", {"artifact_index": 0, "draft": broken}),
                    helpers.call("workbench_artifact_draft_publish", "template-noop-1", {"artifact_index": 0, "repair": noop}),
                    helpers.call("workbench_artifact_draft_publish", "template-noop-2", {"artifact_index": 0, "repair": noop}),
                    helpers.call("workbench_artifact_draft_publish", "template-restore", {"artifact_index": 0, "repair": restore}),
                ]
                model = ToolModel(responses=[*[AIMessage(content="", tool_calls=[copy.deepcopy(call)]) for call in calls], AIMessage(content="PRD accepted; continue prototype generation.")])
                middleware = helpers.WorkbenchToolScopeMiddleware(None, ["prd", "prototype"], run_scope=("run-auto", "attempt-auto"))
                graph = create_agent(model, tools=[workbench_artifact_draft_publish], middleware=[middleware])
                kwargs = {"context": {"workbench": {"runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": ["prd", "prototype"]}}}
                with unittest.mock.patch.object(helpers.middleware_module, "_PROTOTYPE_REFERENCE_DIRECTORY", ROOT / "integrations/deerflow/skills/workbench/references"):
                    result = await graph.ainvoke(initial, **kwargs) if asynchronous else graph.invoke(initial, **kwargs)
                self.assertEqual(initial, initial_before)
                receipts = {message.tool_call_id: message for message in result["messages"] if helpers.middleware_module._is_tool_message(message)}
                ack = json.loads(receipts["template-base"].content)
                self.assertFalse(ack["ok"])
                self.assertEqual(ack["templateRepair"], restore)
                for ident in ("template-noop-1", "template-noop-2"):
                    self.assertEqual(receipts[ident].status, "error")
                    self.assertIsNone(receipts[ident].artifact)
                self.assertTrue(receipts["template-restore"].artifact["ok"])
                self.assertEqual(receipts["template-restore"].artifact["draft"], original)
                self.assertEqual(helpers.middleware_module._successful_prd_drafts(result, "run-auto", "attempt-auto"), (1, False))

    async def test_linked_final_references_preserve_both_drafts_after_full_result_drift(self):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage
        from deerflow_workbench_tools.artifact_draft_tool import workbench_artifact_draft_publish
        from deerflow_workbench_tools.generation_stage_tool import workbench_generation_stage_update
        from deerflow_workbench_tools.runtime_result_tool import workbench_runtime_result_submit
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft, validate_runtime_result

        spec = importlib.util.spec_from_file_location("workbench_final_reference_graph_helpers", PATCH_ROOT / "test_workbench_tool_scope_middleware.py")
        helpers = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = helpers
        spec.loader.exec_module(helpers)
        prd = json.loads((ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json").read_text())["artifacts"][0]
        prototype = json.loads((ROOT / "integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json").read_text())["artifacts"][0]
        drafts = [prd, prototype]
        references = [
            {"draftReference": {"artifactIndex": index, "draftChecksum": validate_runtime_artifact_draft(draft)["candidateChecksum"]}}
            for index, draft in enumerate(drafts)
        ]
        candidate = {"protocol": "workbench.runtime.result.v1", "message": "Both accepted artifacts are ready.", "artifacts": references}
        drifted = {**candidate, "artifacts": copy.deepcopy(drafts)}
        drifted["artifacts"][1]["content"]["title"] += " rewritten"
        self.assertTrue(validate_runtime_result(drifted)["ok"], "drift must remain schema-valid to exercise exact equality")
        captures = []

        class CapturingModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                return self

            def _generate(self, messages, *args, **kwargs):
                captures.append(copy.deepcopy(messages))
                return super()._generate(messages, *args, **kwargs)

        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                captures.clear()
                initial = helpers.automatic_prd_request().state
                del initial["messages"][-2:]
                initial_before = copy.deepcopy(initial)
                calls = [helpers.call("workbench_artifact_draft_publish", "linked-prd", {"artifact_index": 0, "draft": copy.deepcopy(prd)})]
                calls.extend(helpers.call("workbench_generation_stage_update", f"linked-stage-{index}", {"stage": stage})
                             for index, stage in enumerate(helpers.middleware_module.PROTOTYPE_STAGE_SEQUENCE))
                calls.extend([
                    helpers.call("workbench_artifact_draft_publish", "linked-prototype", {"artifact_index": 1, "draft": copy.deepcopy(prototype)}),
                    helpers.call("workbench_runtime_result_submit", "linked-final-drift", {"candidate": copy.deepcopy(drifted)}),
                    helpers.call("workbench_runtime_result_submit", "linked-final-reference", {"candidate": copy.deepcopy(candidate)}),
                ])
                model = CapturingModel(responses=[AIMessage(content="", tool_calls=[call]) for call in calls])
                middleware = helpers.WorkbenchToolScopeMiddleware(None, ["prd", "prototype"], run_scope=("run-auto", "attempt-auto"))
                graph = create_agent(model, tools=[workbench_artifact_draft_publish, workbench_generation_stage_update, workbench_runtime_result_submit], middleware=[middleware])
                kwargs = {"context": {"workbench": {
                    "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": ["prd", "prototype"],
                }}, "config": {"recursion_limit": 100}}
                with unittest.mock.patch.object(helpers.middleware_module, "_PROTOTYPE_REFERENCE_DIRECTORY", ROOT / "integrations/deerflow/skills/workbench/references"):
                    result = await graph.ainvoke(initial, **kwargs) if asynchronous else graph.invoke(initial, **kwargs)
                self.assertEqual(initial, initial_before)
                receipts = {message.tool_call_id: message for message in result["messages"] if helpers.middleware_module._is_tool_message(message)}
                for index, ident in enumerate(("linked-prd", "linked-prototype")):
                    self.assertTrue(receipts[ident].artifact["ok"])
                    self.assertEqual(json.loads(receipts[ident].content)["finalSubmissionArtifact"], references[index])
                rejected = receipts["linked-final-drift"]
                self.assertEqual(rejected.status, "error")
                self.assertIsNone(rejected.artifact)
                self.assertIn("WORKBENCH_LINKED_RESULT_DRAFT_MISMATCH", rejected.content)
                final = receipts["linked-final-reference"]
                self.assertTrue(final.artifact["ok"])
                self.assertEqual(final.artifact["result"], {**candidate, "artifacts": drafts})
                self.assertEqual(final.artifact["resultChecksum"], validate_runtime_result(final.artifact["result"])["candidateChecksum"])
                declarations = {call["id"]: call for message in result["messages"] if helpers.middleware_module._is_ai_message(message)
                                for call in message.tool_calls}
                for call in calls:
                    self.assertEqual(declarations[call["id"]]["args"], call["args"])
                self.assertEqual(len(captures), len(calls))
                marker = "<workbench_linked_result_submission>"
                for messages in captures[:6]:
                    self.assertFalse(any(marker in str(message.content) for message in messages if message.type == "system"))
                for messages in captures[6:]:
                    policy = next(str(message.content) for message in messages if message.type == "system" and marker in str(message.content))
                    segment = policy.split(marker, 1)[1].split("</workbench_linked_result_submission>", 1)[0]
                    self.assertEqual(segment.count('"draftReference"'), 2)
                    self.assertNotIn('"content":', segment)
                    for reference in references:
                        self.assertIn(reference["draftReference"]["draftChecksum"], segment)
                self.assertEqual(helpers.middleware_module._successful_runtime_results(result, "run-auto", "attempt-auto"), (1, False))

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
