from __future__ import annotations

import hashlib
import importlib.util
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from typing import TypedDict


PATCH_ROOT = Path(__file__).resolve().parent
RUNTIME_TOOLS_ROOT = PATCH_ROOT.parents[1] / "runtime-tools"
if RUNTIME_TOOLS_ROOT.is_dir():
    sys.path.insert(0, str(RUNTIME_TOOLS_ROOT))


def install_import_stubs() -> bool:
    try:
        import langchain.agents.middleware.types  # noqa: F401
        return False
    except ModuleNotFoundError:
        pass

    class AgentMiddleware:
        @classmethod
        def __class_getitem__(cls, _item):
            return cls

    class AgentState(TypedDict, total=False):
        pass

    class SystemMessage:
        def __init__(self, *, content):
            self.content = content
            self.text = content

    class ToolMessage:
        def __init__(self, **values):
            self.__dict__.update(values)

    class AIMessage(ToolMessage):
        pass

    class Command:
        pass

    modules = {
        "langchain": types.ModuleType("langchain"),
        "langchain.agents": types.ModuleType("langchain.agents"),
        "langchain.agents.middleware": types.ModuleType("langchain.agents.middleware"),
        "langchain.agents.middleware.types": types.ModuleType("langchain.agents.middleware.types"),
        "langchain_core": types.ModuleType("langchain_core"),
        "langchain_core.messages": types.ModuleType("langchain_core.messages"),
        "langgraph": types.ModuleType("langgraph"),
        "langgraph.prebuilt": types.ModuleType("langgraph.prebuilt"),
        "langgraph.prebuilt.tool_node": types.ModuleType("langgraph.prebuilt.tool_node"),
        "langgraph.types": types.ModuleType("langgraph.types"),
    }
    modules["langchain.agents"].AgentState = AgentState
    modules["langchain.agents.middleware"].AgentMiddleware = AgentMiddleware
    model_types = modules["langchain.agents.middleware.types"]
    model_types.ModelCallResult = object
    model_types.ModelRequest = object
    model_types.ModelResponse = type("ModelResponse", (), {})
    modules["langchain_core.messages"].SystemMessage = SystemMessage
    modules["langchain_core.messages"].ToolMessage = ToolMessage
    modules["langchain_core.messages"].AIMessage = AIMessage
    modules["langgraph.prebuilt.tool_node"].ToolCallRequest = object
    modules["langgraph.types"].Command = Command
    sys.modules.update(modules)
    return True


USING_IMPORT_STUBS = install_import_stubs()
spec = importlib.util.spec_from_file_location(
    "workbench_tool_scope_middleware_under_test",
    PATCH_ROOT / "workbench_tool_scope_middleware.py",
)
if spec is None or spec.loader is None:
    raise RuntimeError("WORKBENCH_TOOL_SCOPE_TEST_IMPORT_FAILED")
middleware_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = middleware_module
spec.loader.exec_module(middleware_module)

CANVAS_TOOL_NAMES = middleware_module.CANVAS_TOOL_NAMES
CLARIFICATION_TOOL_NAME = middleware_module.CLARIFICATION_TOOL_NAME
KNOWLEDGE_TOOL_NAME = middleware_module.KNOWLEDGE_TOOL_NAME
READ_FILE_TOOL_NAME = middleware_module.READ_FILE_TOOL_NAME
ARTIFACT_PROGRESS_TOOL_NAMES = middleware_module.ARTIFACT_PROGRESS_TOOL_NAMES
PROTOTYPE_ONLY_TOOL_NAMES = middleware_module.PROTOTYPE_ONLY_TOOL_NAMES
RUNTIME_RESULT_TOOL_NAME = middleware_module.RUNTIME_RESULT_TOOL_NAME
PRD_REFERENCE_FILES = middleware_module.PRD_REFERENCE_FILES
PRD_STAGE_SEQUENCE = middleware_module.PRD_STAGE_SEQUENCE
WorkbenchToolScopeMiddleware = middleware_module.WorkbenchToolScopeMiddleware
normalize_workbench_canvas_policy = middleware_module.normalize_workbench_canvas_policy
normalize_workbench_requested_artifact_kinds = (
    middleware_module.normalize_workbench_requested_artifact_kinds
)
workbench_canvas_policy_from_runnable_config = middleware_module.workbench_canvas_policy_from_runnable_config
workbench_requested_artifact_kinds_from_runnable_config = (
    middleware_module.workbench_requested_artifact_kinds_from_runnable_config
)
workbench_knowledge_enabled_from_runnable_config = (
    middleware_module.workbench_knowledge_enabled_from_runnable_config
)
workbench_run_scope_from_runnable_config = (
    middleware_module.workbench_run_scope_from_runnable_config
)


class FakeTool:
    def __init__(self, name: str):
        self.name = name


class FakeModelRequest:
    def __init__(self, tools, system_message=None, state=None, context=None):
        self.tools = list(tools)
        self.system_message = system_message
        self.state = state or {}
        self.runtime = types.SimpleNamespace(context=context)

    def override(self, **overrides):
        return FakeModelRequest(
            overrides.get("tools", self.tools),
            overrides.get("system_message", self.system_message),
            self.state,
            self.runtime.context,
        )


class FakeToolRequest:
    def __init__(
        self,
        name: str,
        call_id: str = "call-1",
        args: dict | None = None,
        state: dict | None = None,
    ):
        self.tool_call = {"name": name, "id": call_id, "args": dict(args or {})}
        self.state = state or {
            "messages": [
                {"type": "human", "content": "current turn"},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [{
                        "id": call_id,
                        "name": name,
                        "args": dict(args or {}),
                    }],
                },
            ],
        }


def policy(*declared: str) -> dict:
    return {"declaredTools": list(declared)}


def _skill_root() -> Path:
    candidates = (
        PATCH_ROOT.parents[1] / "skills",
        Path("/app/skills/public"),
    )
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise RuntimeError("WORKBENCH_PRD_REFERENCE_SKILL_ROOT_MISSING")


SKILL_ROOT = _skill_root()
REFERENCE_CONTENT = {
    virtual_path: (
        SKILL_ROOT / virtual_path.removeprefix("/mnt/skills/public/")
    ).read_text(encoding="utf-8")
    for virtual_path, _digest in PRD_REFERENCE_FILES
}


def call(name: str, call_id: str, args: dict | None = None) -> dict:
    return {"id": call_id, "name": name, "args": dict(args or {})}


def tool_message(
    name: str,
    call_id: str,
    content: str = "ok",
    *,
    artifact: dict | None = None,
    status: str = "success",
) -> dict:
    message = {
        "type": "tool",
        "name": name,
        "tool_call_id": call_id,
        "content": content,
        "status": status,
    }
    if artifact is not None:
        message["artifact"] = artifact
    return message


def append_tool_batch(messages: list[dict], calls: list[dict], responses: list[dict]) -> None:
    messages.append({"type": "ai", "content": "", "tool_calls": calls})
    messages.extend(responses)


def append_stage(messages: list[dict], stage: str, call_id: str) -> None:
    append_tool_batch(
        messages,
        [call("workbench_generation_stage_update", call_id, {"stage": stage})],
        [tool_message(
            "workbench_generation_stage_update",
            call_id,
            artifact={
                "protocol": "workbench.runtime.generation-stage.v1",
                "stage": stage,
            },
        )],
    )


def append_references(messages: list[dict], *, status_by_index: dict[int, str] | None = None) -> None:
    calls = []
    responses = []
    for index, (path, _digest) in enumerate(PRD_REFERENCE_FILES):
        call_id = f"reference-{index}"
        calls.append(call(READ_FILE_TOOL_NAME, call_id, {"path": path}))
        status = (status_by_index or {}).get(index, "success")
        responses.append(tool_message(
            READ_FILE_TOOL_NAME,
            call_id,
            REFERENCE_CONTENT[path] if status == "success" else "Error: read failed",
            status=status,
        ))
    append_tool_batch(messages, calls, responses)


def prd_messages(*, stage_count: int, references: bool, draft: bool = False) -> list[dict]:
    messages: list[dict] = [{"type": "human", "content": "current PRD turn"}]
    if stage_count > 0:
        append_stage(messages, PRD_STAGE_SEQUENCE[0], "stage-0")
    if references:
        append_references(messages)
    for index, stage in enumerate(PRD_STAGE_SEQUENCE[1:stage_count], start=1):
        append_stage(messages, stage, f"stage-{index}")
    if draft:
        append_tool_batch(
            messages,
            [call("workbench_artifact_draft_publish", "draft-success", {
                "artifact_index": 0,
                "draft": {"kind": "prd"},
            })],
            [tool_message(
                "workbench_artifact_draft_publish",
                "draft-success",
                artifact={
                    "protocol": "workbench.runtime.artifact-draft.v1",
                    "ok": True,
                    "draft": {"kind": "prd"},
                },
            )],
        )
    return messages


def automatic_prd_request():
    messages = prd_messages(stage_count=4, references=True, draft=True)
    for message in messages:
        if message.get("type") == "tool" and "artifact" in message:
            message["artifact"].update({
                "runId": "run-auto", "runtimeAttemptId": "attempt-auto",
                "toolCallId": message["tool_call_id"],
            })
        elif message.get("type") == "tool" and message.get("name") == READ_FILE_TOOL_NAME:
            message["artifact"] = {
                "protocol": "workbench.runtime.prd-reference-read.v1",
                "runId": "run-auto",
                "runtimeAttemptId": "attempt-auto",
                "toolCallId": message["tool_call_id"],
            }
    messages[-1]["artifact"]["artifactIndex"] = 0
    messages[-1]["artifact"]["draft"]["title"] = "Normalized PRD"
    return FakeModelRequest(
        [FakeTool(RUNTIME_RESULT_TOOL_NAME)],
        state={"messages": messages},
        context={"workbench": {
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto",
            "requestedArtifactKinds": ["prd"],
        }},
    )


class AutomaticPrdResultTest(unittest.IsolatedAsyncioTestCase):
    def test_submits_the_normalized_draft_once_without_calling_model(self):
        request = automatic_prd_request()
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            run_scope=("run-auto", "attempt-auto"),
        )
        result = middleware.wrap_model_call(request, lambda _request: self.fail("model called"))
        call = result.tool_calls[0]
        self.assertEqual(call["name"], RUNTIME_RESULT_TOOL_NAME)
        self.assertEqual(call["args"]["candidate"]["artifacts"], [request.state["messages"][-1]["artifact"]["draft"]])
        replay = middleware.wrap_model_call(request, lambda _request: self.fail("model called"))
        self.assertEqual(call["id"], replay.tool_calls[0]["id"])

        append_tool_batch(request.state["messages"], [call], [tool_message(
            RUNTIME_RESULT_TOOL_NAME, call["id"], "Error: validation failed", status="error",
        )])
        sentinel = object()
        self.assertIs(middleware.wrap_model_call(request, lambda _request: sentinel), sentinel)

    async def test_async_converges_success_without_another_model_call(self):
        request = automatic_prd_request()
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            run_scope=("run-auto", "attempt-auto"),
        )

        async def forbidden(_request):
            self.fail("model called")

        automatic = await middleware.awrap_model_call(request, forbidden)
        call = automatic.tool_calls[0]
        append_tool_batch(request.state["messages"], [call], [tool_message(
            RUNTIME_RESULT_TOOL_NAME, call["id"], artifact={
                "protocol": "workbench.runtime.validated-result.v1",
                "ok": True, "runId": "run-auto", "runtimeAttemptId": "attempt-auto",
                "toolCallId": call["id"],
                "result": {**call["args"]["candidate"], "message": "Complete"},
            },
        )])
        result = await middleware.awrap_model_call(request, forbidden)
        self.assertEqual(result.content, "Complete")
        self.assertFalse(getattr(result, "tool_calls", []))

    def test_rejects_unbound_stale_missing_and_duplicate_history(self):
        original = automatic_prd_request()
        for variant in ("scope", "attempt", "reference", "stage", "draft", "index", "duplicate", "new-turn", "pending"):
            with self.subTest(variant=variant):
                request = copy.deepcopy(original)
                messages = request.state["messages"]
                run_scope = ("run-auto", "attempt-auto")
                if variant == "scope":
                    run_scope = None
                elif variant == "attempt":
                    run_scope = ("run-auto", "another-attempt")
                elif variant == "reference":
                    next(m for m in messages if m.get("name") == READ_FILE_TOOL_NAME)["content"] = "changed"
                elif variant == "stage":
                    next(m for m in messages if m.get("name") == "workbench_generation_stage_update")["artifact"]["runId"] = "other"
                elif variant == "draft":
                    messages[-1]["artifact"]["ok"] = False
                elif variant == "index":
                    messages[-1]["artifact"]["artifactIndex"] = 1
                elif variant == "duplicate":
                    messages.extend(copy.deepcopy(messages[-2:]))
                elif variant == "new-turn":
                    messages.append({"type": "human", "content": "new request"})
                else:
                    messages.append({"type": "ai", "content": "", "tool_calls": [
                        call(RUNTIME_RESULT_TOOL_NAME, "pending-result"),
                    ]})
                sentinel = object()
                self.assertIs(
                    WorkbenchToolScopeMiddleware(
                        None,
                        ["prd"],
                        run_scope=run_scope,
                    ).wrap_model_call(
                        request,
                        lambda _request: sentinel,
                    ),
                    sentinel,
                )


class DraftRepairScopeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reference_patch = patch.object(
            middleware_module, "_PROTOTYPE_REFERENCE_DIRECTORY", SKILL_ROOT / "workbench" / "references",
        )
        reference_patch.start()
        self.addCleanup(reference_patch.stop)

    @staticmethod
    def middleware(kinds=None):
        return WorkbenchToolScopeMiddleware(
            None, kinds or ["prd", "prototype"], run_scope=("run-auto", "attempt-auto"),
        )

    def rejected_state(self):
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft

        state = automatic_prd_request().state
        del state["messages"][-2:]
        # An intentionally incomplete authored PRD remains rejected by the real
        # validator. The middleware must preserve it while relocating its object.
        candidate = {
            "kind": "prd", "schemaVersion": 2, "title": "Keep authored title",
            "operation": {"kind": "create"}, "citations": [],
            "content": {"sections": {"introduction": {
                "businessRequirements": {"title": "业务要求", "authored": ["保留全文", 1.0]},
            }}},
        }
        validation = validate_runtime_artifact_draft(candidate)
        self.assertFalse(validation["ok"])
        payload = {
            "protocol": "workbench.runtime.artifact-draft.v1", "ok": False,
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": "rejected-base",
            "artifactIndex": 0,
        }
        artifact = {
            **payload,
            "checksum": hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "issues": validation["issues"],
        }
        ack = {
            "protocol": "workbench.runtime.artifact-draft-ack.v1", "ok": False,
            "artifactIndex": 0, "candidateChecksum": validation["candidateChecksum"], "issues": validation["issues"],
        }
        append_tool_batch(state["messages"], [call(
            "workbench_artifact_draft_publish", "rejected-base", {"artifact_index": 0, "draft": candidate},
        )], [tool_message("workbench_artifact_draft_publish", "rejected-base", json.dumps(ack), artifact=artifact)])
        repair = {
            "baseCandidateChecksum": validation["candidateChecksum"],
            "operations": [{
                "op": "move", "from": "/content/sections/introduction/businessRequirements",
                "path": "/content/sections/businessRequirements",
            }],
        }
        return state, candidate, repair

    async def test_repair_uses_exact_causal_declaration_without_mutating_model_args(self):
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                state, candidate, repair = self.rejected_state()
                request = request_in_state(state["messages"], "workbench_artifact_draft_publish", "local-repair", {
                    "artifact_index": 0, "repair": repair,
                })
                before = copy.deepcopy(request.state)
                observed = []
                sentinel = object()

                def handler(actual):
                    observed.append(copy.deepcopy(actual.tool_call))
                    return sentinel

                async def async_handler(actual):
                    return handler(actual)

                middleware = self.middleware()
                result = await middleware.awrap_tool_call(request, async_handler) if asynchronous else middleware.wrap_tool_call(request, handler)
                self.assertIs(result, sentinel)
                self.assertEqual(observed, [request.tool_call])
                self.assertNotIn("draft", observed[0]["args"])
                self.assertEqual(request.state, before)
                reconstructed = middleware_module._artifact_draft_from_declaration(
                    request.state, request.tool_call, "run-auto", "attempt-auto",
                )
                self.assertEqual(reconstructed["content"]["sections"]["businessRequirements"], candidate["content"]["sections"]["introduction"]["businessRequirements"])
                self.assertNotIn("businessRequirements", reconstructed["content"]["sections"]["introduction"])
                self.assertEqual(reconstructed["title"], candidate["title"])

    def test_bad_repair_history_blocks_before_the_tool_handler(self):
        for case in ("checksum", "run", "attempt", "response-name", "duplicate-response", "new-turn", "index", "old-base", "unanswered"):
            with self.subTest(case=case):
                state, _candidate, repair = self.rejected_state()
                response = state["messages"][-1]
                if case == "checksum":
                    repair["baseCandidateChecksum"] = "0" * 64
                elif case == "run":
                    response["artifact"]["runId"] = "other-run"
                elif case == "attempt":
                    response["artifact"]["runtimeAttemptId"] = "other-attempt"
                elif case == "response-name":
                    response["name"] = "different-tool"
                elif case == "duplicate-response":
                    state["messages"].append(copy.deepcopy(response))
                elif case == "new-turn":
                    state["messages"].append({"type": "human", "content": "new request"})
                elif case == "old-base":
                    state["messages"][-2]["tool_calls"][0]["args"]["draft"]["title"] = "changed after rejection"
                elif case == "unanswered":
                    state["messages"].append({"type": "ai", "content": "", "tool_calls": [call("workbench_generation_stage_update", "pending", {"stage": "validating-prd"})]})
                request = request_in_state(state["messages"], "workbench_artifact_draft_publish", "local-repair", {
                    "artifact_index": 1 if case == "index" else 0, "repair": repair,
                })
                result = self.middleware().wrap_tool_call(request, lambda _r: self.fail("invalid repair reached handler"))
                self.assertEqual(result.status, "error")
                self.assertIn("WORKBENCH_ARTIFACT_DRAFT_REPAIR_INVALID", result.content)

    def test_accepted_repair_causal_proof_is_reconstructed_at_original_declaration(self):
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft

        state, _candidate, repair = self.rejected_state()
        request = request_in_state(state["messages"], "workbench_artifact_draft_publish", "local-repair", {
            "artifact_index": 0, "repair": repair,
        })
        repaired = middleware_module._artifact_draft_from_declaration(request.state, request.tool_call, "run-auto", "attempt-auto")
        artifact = {
            "protocol": "workbench.runtime.artifact-draft.v1", "ok": True,
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": "local-repair",
            "artifactIndex": 0, "draft": repaired,
            "draftChecksum": validate_runtime_artifact_draft(repaired)["candidateChecksum"],
        }
        # This fixture tests the middleware's declaration/receipt equality only.
        # Real acceptance of an authored candidate is tested by the Draft tool.
        PrototypeTransportContextTests.sign_envelope(artifact)
        request.state["messages"].append(tool_message("workbench_artifact_draft_publish", "local-repair", artifact=artifact))
        model_request = FakeModelRequest([], state=request.state, context={"workbench": {
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": ["prd", "prototype"],
        }})
        before = copy.deepcopy(request.state)
        self.assertTrue(self.middleware()._prototype_transport_ready(model_request))
        self.assertEqual(request.state, before)
        request.state["messages"][-2]["tool_calls"][0]["args"]["repair"]["operations"][0]["path"] = "/content/sections/safetyBaseline"
        self.assertFalse(self.middleware()._prototype_transport_ready(model_request))

    @unittest.skipIf(USING_IMPORT_STUBS, "requires real ToolNode sync and async concurrency")
    async def test_real_graph_rejects_every_sibling_of_a_repair_batch(self):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage, HumanMessage
        from langchain_core.tools import StructuredTool

        class BoundModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                return self

        def publication(artifact_index: int, draft: dict | None = None, repair: dict | None = None):
            self.fail("a sibling publication executed against a shared rejected base")

        for asynchronous in (False, True):
            for sibling in ("repair", "draft"):
                with self.subTest(asynchronous=asynchronous, sibling=sibling):
                    repair = {"baseCandidateChecksum": "0" * 64, "operations": [{"op": "replace", "path": "/title", "value": "Changed"}]}
                    calls = [
                        call("workbench_artifact_draft_publish", "parallel-first", {"artifact_index": 0, "repair": repair}),
                        call("workbench_artifact_draft_publish", "parallel-second", {"artifact_index": 0, sibling: repair if sibling == "repair" else {"kind": "prototype"}}),
                    ]
                    model = BoundModel(responses=[AIMessage(content="", tool_calls=copy.deepcopy(calls)), AIMessage(content="Stopped")])
                    graph = create_agent(model, tools=[StructuredTool.from_function(
                        publication, name="workbench_artifact_draft_publish", description="Publish an authored artifact",
                    )], middleware=[self.middleware(["prototype"])])
                    kwargs = {"context": {"workbench": {
                        "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": ["prototype"],
                    }}}
                    initial = {"messages": [HumanMessage(content="Generate the requested artifact")]}
                    result = await graph.ainvoke(initial, **kwargs) if asynchronous else graph.invoke(initial, **kwargs)
                    responses = [m for m in result["messages"] if middleware_module._is_tool_message(m)]
                    self.assertEqual(len(responses), 2)
                    for response in responses:
                        self.assertEqual(response.status, "error")
                        self.assertIn("WORKBENCH_ARTIFACT_DRAFT_REPAIR_BATCH_INVALID", response.content)
                    original = next(m for m in result["messages"] if middleware_module._is_ai_message(m) and m.tool_calls)
                    self.assertEqual(original.tool_calls, [{**c, "type": "tool_call"} for c in calls])

    @unittest.skipIf(USING_IMPORT_STUBS, "requires real injected ToolRuntime state and concurrent ToolNode")
    async def test_real_graph_can_repair_after_concurrent_batch_was_rejected(self):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage, HumanMessage
        from langchain_core.tools import StructuredTool
        from deerflow.tools.types import Runtime
        from deerflow_workbench_tools.artifact_draft_tool import workbench_artifact_draft_publish
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft

        class BoundModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                return self

        source = json.loads((SKILL_ROOT / "workbench" / "references" / "prototype-runtime-result.example.json").read_text())
        original = source["artifacts"][0]
        broken = copy.deepcopy(original)
        del broken["title"]
        validation = validate_runtime_artifact_draft(broken)
        self.assertFalse(validation["ok"])
        repair = {
            "baseCandidateChecksum": validation["candidateChecksum"],
            "operations": [{"op": "add", "path": "/title", "value": original["title"]}],
        }
        publications = []

        def publication(runtime, artifact_index: int, draft: dict | None = None, repair: dict | None = None):
            publications.append(runtime.tool_call_id)
            return workbench_artifact_draft_publish.func(runtime, artifact_index, draft=draft, repair=repair)

        # Use the actual upstream ToolRuntime annotation, which ToolNode injects
        # while hiding the state/context from the model-facing tool schema.
        publication.__annotations__["runtime"] = Runtime
        publication.__annotations__["artifact_index"] = int
        publication.__annotations__["draft"] = dict | None
        publication.__annotations__["repair"] = dict | None
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                publications.clear()
                calls = [
                    call("workbench_artifact_draft_publish", ident, {"artifact_index": 0, "repair": copy.deepcopy(repair)})
                    for ident in ("parallel-first", "parallel-second")
                ]
                model = BoundModel(responses=[
                    AIMessage(content="", tool_calls=[call("workbench_artifact_draft_publish", "base", {"artifact_index": 0, "draft": copy.deepcopy(broken)})]),
                    AIMessage(content="", tool_calls=calls),
                    AIMessage(content="", tool_calls=[call("workbench_artifact_draft_publish", "retry-alone", {"artifact_index": 0, "repair": copy.deepcopy(repair)})]),
                    AIMessage(content="Done"),
                ])
                graph = create_agent(model, tools=[StructuredTool.from_function(
                    publication, name="workbench_artifact_draft_publish", description="Publish an authored artifact",
                    response_format="content_and_artifact",
                )], middleware=[self.middleware(["prototype"])])
                kwargs = {"context": {"workbench": {
                    "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": ["prototype"],
                }}}
                initial = {"messages": [HumanMessage(content="Build this prototype")]}
                result = await graph.ainvoke(initial, **kwargs) if asynchronous else graph.invoke(initial, **kwargs)
                self.assertEqual(publications, ["base", "retry-alone"])
                responses = {m.tool_call_id: m for m in result["messages"] if middleware_module._is_tool_message(m)}
                self.assertFalse(responses["base"].artifact["ok"])
                self.assertTrue(responses["retry-alone"].artifact["ok"])
                self.assertEqual(responses["retry-alone"].artifact["draft"], original)
                for ident in ("parallel-first", "parallel-second"):
                    self.assertEqual(responses[ident].status, "error")
                    self.assertIn("WORKBENCH_ARTIFACT_DRAFT_REPAIR_BATCH_INVALID", responses[ident].content)
                accepted_declaration = next(
                    c for m in result["messages"] if middleware_module._is_ai_message(m)
                    for c in m.tool_calls if c["id"] == "retry-alone"
                )
                self.assertEqual(accepted_declaration["args"], {"artifact_index": 0, "repair": repair})


class PrototypeTransportContextTests(unittest.IsolatedAsyncioTestCase):
    marker = "<workbench_prototype_transport_context>"
    reference_directory = SKILL_ROOT / "workbench" / "references"

    def setUp(self):
        self.reference_patch = patch.object(
            middleware_module, "_PROTOTYPE_REFERENCE_DIRECTORY", self.reference_directory,
        )
        self.reference_patch.start()
        self.addCleanup(self.reference_patch.stop)

    @staticmethod
    def middleware(kinds):
        return WorkbenchToolScopeMiddleware(None, kinds, run_scope=("run-auto", "attempt-auto"))

    @staticmethod
    def sign_envelope(artifact):
        envelope = {key: artifact[key] for key in (
            "protocol", "runId", "runtimeAttemptId", "toolCallId", "artifactIndex", "ok", "draftChecksum",
        )}
        artifact["checksum"] = hashlib.sha256(json.dumps(
            envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")).hexdigest()

    def request(self, kinds, *, accepted=False):
        if accepted:
            request = automatic_prd_request()
            messages = request.state["messages"]
            artifact = messages[-1]["artifact"]
            messages[-2]["tool_calls"][0]["args"]["draft"] = copy.deepcopy(artifact["draft"])
            artifact["draftChecksum"] = hashlib.sha256(json.dumps(
                artifact["draft"], sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            self.sign_envelope(artifact)
        else:
            request = FakeModelRequest([], state={"messages": [{"type": "human", "content": "Build my actual product"}]})
        request.runtime.context = {"workbench": {
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": kinds,
        }}
        request.system_message = middleware_module.SystemMessage(content="Existing system instructions")
        request.tools = [FakeTool(name) for name in (
            RUNTIME_RESULT_TOOL_NAME, READ_FILE_TOOL_NAME, KNOWLEDGE_TOOL_NAME,
            CLARIFICATION_TOOL_NAME, *ARTIFACT_PROGRESS_TOOL_NAMES, *PROTOTYPE_ONLY_TOOL_NAMES,
        )]
        return request

    def assert_context(self, text):
        self.assertEqual(text.count(self.marker), 1)
        for virtual_path, digest in middleware_module.PROTOTYPE_REFERENCE_FILES:
            source = (self.reference_directory / Path(virtual_path).name).read_text(encoding="utf-8")
            self.assertEqual(text.count(source), 1)
            self.assertIn(digest, text)
        self.assertIn("not authorized facts", text)
        self.assertIn("real authorized Knowledge retrieval", text)
        self.assertIn("ignore their generic instructions to read files", text)
        self.assertIn("keep the accepted PRD immutable", text)
        self.assertIn("both exact accepted Drafts in PRD/Prototype order", text)

    def test_exact_prototype_injects_only_system_context_without_expanding_capabilities(self):
        request = self.request(["prototype"])
        before = copy.deepcopy(request.state)
        middleware = self.middleware(["prototype"])
        scoped = middleware.wrap_model_call(request, lambda captured: captured)
        self.assert_context(scoped.system_message.text)
        self.assertTrue(scoped.system_message.text.startswith("Existing system instructions"))
        self.assertEqual(request.system_message.text, "Existing system instructions")
        self.assertEqual(request.state, before)
        self.assertIs(scoped.state, request.state)
        self.assertEqual([tool.name for tool in scoped.tools], [
            RUNTIME_RESULT_TOOL_NAME, CLARIFICATION_TOOL_NAME,
            *ARTIFACT_PROGRESS_TOOL_NAMES, *PROTOTYPE_ONLY_TOOL_NAMES,
        ])
        self.assertFalse(middleware._prototype_reference_enabled)
        self.assertFalse(middleware._prototype_stage_gate_enabled)
        again = middleware.wrap_model_call(scoped, lambda captured: captured)
        self.assertEqual(again.system_message.text, scoped.system_message.text)

    def test_joint_context_requires_accepted_prd_for_either_requested_order(self):
        for kinds in (["prd", "prototype"], ["prototype", "prd"]):
            with self.subTest(kinds=kinds):
                middleware = self.middleware(kinds)
                before = self.request(kinds)
                with patch.object(middleware_module, "_prototype_transport_reference_context", side_effect=AssertionError("premature read")):
                    self.assertNotIn(self.marker, middleware._filter_tools(before).system_message.text)
                accepted = self.request(kinds, accepted=True)
                state_before = copy.deepcopy(accepted.state)
                scoped = middleware.wrap_model_call(accepted, lambda captured: captured)
                self.assert_context(scoped.system_message.text)
                self.assertIn(READ_FILE_TOOL_NAME, [tool.name for tool in scoped.tools])
                self.assertEqual(accepted.state, state_before)
                self.assertEqual(middleware_module._stage_progress(scoped.state, "run-auto", "attempt-auto"), (4, False))
                self.assertEqual(middleware_module._successful_runtime_results(scoped.state, "run-auto", "attempt-auto"), (0, False))

    def test_runtime_and_constructor_scope_must_be_exact_and_trusted(self):
        cases = (
            "missing-context", "missing-workbench", "missing-run", "wrong-run", "wrong-attempt",
            "missing-constructor", "wrong-constructor", "kind-disagreement", "missing-kinds",
        )
        for case in cases:
            with self.subTest(case=case):
                request = self.request(["prototype"])
                middleware = self.middleware(["prototype"])
                scope = request.runtime.context["workbench"]
                if case == "missing-context":
                    request.runtime.context = None
                elif case == "missing-workbench":
                    request.runtime.context = {}
                elif case == "missing-run":
                    scope.pop("runId")
                elif case == "wrong-run":
                    scope["runId"] = "run-other"
                elif case == "wrong-attempt":
                    scope["runtimeAttemptId"] = "attempt-other"
                elif case == "missing-constructor":
                    middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
                elif case == "wrong-constructor":
                    middleware = WorkbenchToolScopeMiddleware(None, ["prototype"], run_scope=("run-auto", "attempt-other"))
                elif case == "kind-disagreement":
                    scope["requestedArtifactKinds"] = ["prd", "prototype"]
                else:
                    scope.pop("requestedArtifactKinds")
                # Model-authored fields cannot replace trusted runtime context.
                request.state["workbench"] = {"runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": ["prototype"]}
                with patch.object(middleware_module, "_prototype_transport_reference_context", side_effect=AssertionError("untrusted read")):
                    self.assertNotIn(self.marker, middleware._filter_tools(request).system_message.text)

    def test_malformed_extra_and_other_kinds_do_not_read_or_inject(self):
        for kinds in (None, [], "prototype", ["prototype", "prototype"], ["prototype", 1],
                      ["unknown"], ["prd"], ["document"], ["prototype", "image"], ["prd", "prototype", "data"]):
            with self.subTest(kinds=kinds):
                request = self.request(kinds, accepted=True)
                with patch.object(middleware_module, "_prototype_transport_reference_context", side_effect=AssertionError("invalid kind read")):
                    self.assertNotIn(self.marker, self.middleware(kinds)._filter_tools(request).system_message.text)

    def test_joint_rejects_unvalidated_stale_unbound_and_incomplete_evidence(self):
        cases = (
            "missing-draft", "failed-draft", "error-response", "content-only-ack", "wrong-name",
            "wrong-run", "wrong-attempt", "wrong-tool-id", "missing-envelope", "bad-envelope",
            "bad-draft-checksum", "wrong-index", "boolean-index", "argument-index", "argument-body",
            "argument-kind", "unmatched-response", "duplicate-response", "duplicate-draft", "new-turn",
            "missing-reference", "unbound-reference", "modified-reference", "missing-stage", "unbound-stage",
        )
        for case in cases:
            with self.subTest(case=case):
                request = self.request(["prd", "prototype"], accepted=True)
                messages = request.state["messages"]
                response, declaration = messages[-1], messages[-2]
                artifact = response["artifact"]
                args = declaration["tool_calls"][0]["args"]
                if case == "missing-draft":
                    del messages[-2:]
                elif case == "failed-draft":
                    artifact["ok"] = False
                elif case == "error-response":
                    response["status"] = "error"
                elif case == "content-only-ack":
                    response["content"] = json.dumps(artifact)
                    response.pop("artifact")
                elif case == "wrong-name":
                    response["name"] = "untrusted_tool"
                elif case == "wrong-run":
                    artifact["runId"] = "run-other"
                elif case == "wrong-attempt":
                    artifact["runtimeAttemptId"] = "attempt-other"
                elif case == "wrong-tool-id":
                    artifact["toolCallId"] = "another-call"
                elif case == "missing-envelope":
                    artifact.pop("checksum")
                elif case == "bad-envelope":
                    artifact["checksum"] = "a" * 64
                elif case == "bad-draft-checksum":
                    artifact["draftChecksum"] = "not-a-checksum"
                    self.sign_envelope(artifact)
                elif case == "wrong-index":
                    artifact["artifactIndex"] = 1
                    self.sign_envelope(artifact)
                elif case == "boolean-index":
                    artifact["artifactIndex"] = False
                    self.sign_envelope(artifact)
                elif case == "argument-index":
                    args["artifact_index"] = False
                elif case == "argument-body":
                    args["draft"]["title"] = "Different candidate"
                elif case == "argument-kind":
                    args["draft"]["kind"] = "prototype"
                elif case == "unmatched-response":
                    del messages[-2]
                elif case == "duplicate-response":
                    messages.append(copy.deepcopy(response))
                elif case == "duplicate-draft":
                    messages.extend(copy.deepcopy(messages[-2:]))
                elif case == "new-turn":
                    messages.append({"type": "human", "content": "A different request"})
                elif case == "missing-reference":
                    messages.remove(next(m for m in messages if m.get("name") == READ_FILE_TOOL_NAME))
                elif case == "unbound-reference":
                    next(m for m in messages if m.get("name") == READ_FILE_TOOL_NAME)["artifact"]["runId"] = "other"
                elif case == "modified-reference":
                    next(m for m in messages if m.get("name") == READ_FILE_TOOL_NAME)["content"] = "altered reference"
                elif case == "missing-stage":
                    messages.remove(next(m for m in messages if m.get("name") == "workbench_generation_stage_update"))
                else:
                    next(m for m in messages if m.get("name") == "workbench_generation_stage_update")["artifact"]["runtimeAttemptId"] = "other"
                with patch.object(middleware_module, "_prototype_transport_reference_context", side_effect=AssertionError("invalid PRD read")):
                    self.assertNotIn(self.marker, self.middleware(["prd", "prototype"])._filter_tools(request).system_message.text)

    def test_trusted_node_canonical_draft_checksum_is_not_recomputed_with_python(self):
        request = self.request(["prd", "prototype"], accepted=True)
        messages = request.state["messages"]
        artifact = messages[-1]["artifact"]
        draft = {"kind": "prd", "revision": 1.0}
        artifact["draft"] = copy.deepcopy(draft)
        messages[-2]["tool_calls"][0]["args"]["draft"] = copy.deepcopy(draft)
        # RFC8785/Node represents 1.0 as 1; this is the accepted tool's checksum.
        artifact["draftChecksum"] = hashlib.sha256(b'{"kind":"prd","revision":1}').hexdigest()
        python_digest = hashlib.sha256(json.dumps(draft, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertNotEqual(artifact["draftChecksum"], python_digest)
        self.sign_envelope(artifact)
        self.assert_context(self.middleware(["prd", "prototype"])._filter_tools(request).system_message.text)

    def test_joint_evidence_must_finish_in_causal_order_within_the_current_turn(self):
        for case in ("late-references", "early-draft", "overlapping-stages", "batched-draft",
                     "new-turn-only-references", "new-turn-only-stages", "new-turn-only-draft"):
            with self.subTest(case=case):
                request = self.request(["prd", "prototype"], accepted=True)
                messages = request.state["messages"]
                if case == "late-references":
                    messages[3:10] = [*messages[8:10], *messages[3:8]]
                elif case == "early-draft":
                    messages[12:16] = [*messages[14:16], *messages[12:14]]
                elif case == "overlapping-stages":
                    messages[8:12] = [messages[8], messages[10], messages[9], messages[11]]
                elif case == "batched-draft":
                    messages[12]["tool_calls"].extend(messages[14]["tool_calls"])
                    del messages[14]
                else:
                    new_turn = [{"type": "human", "content": "Start a new request"}]
                    if case == "new-turn-only-references":
                        new_turn.extend(copy.deepcopy(messages[1:8]))
                    elif case == "new-turn-only-stages":
                        new_turn.extend(copy.deepcopy([*messages[1:3], *messages[8:14]]))
                    else:
                        new_turn.extend(copy.deepcopy(messages[14:16]))
                    messages.extend(new_turn)
                with patch.object(middleware_module, "_prototype_transport_reference_context", side_effect=AssertionError("noncausal context read")):
                    self.assertNotIn(self.marker, self.middleware(["prd", "prototype"])._filter_tools(request).system_message.text)

    def test_successful_bound_runtime_result_stops_context_for_both_workflows(self):
        for kinds in (["prototype"], ["prd", "prototype"]):
            for bound in (True, False):
                with self.subTest(kinds=kinds, bound=bound):
                    request = self.request(kinds, accepted="prd" in kinds)
                    append_tool_batch(request.state["messages"], [call(RUNTIME_RESULT_TOOL_NAME, "terminal-result")], [tool_message(
                        RUNTIME_RESULT_TOOL_NAME, "terminal-result", artifact={
                            "protocol": "workbench.runtime.validated-result.v1", "ok": True,
                            "runId": "run-auto", "runtimeAttemptId": "attempt-auto" if bound else "stale-attempt",
                            "toolCallId": "terminal-result", "result": {"message": "Done"},
                        },
                    )])
                    middleware = self.middleware(kinds)
                    if bound:
                        with patch.object(middleware_module, "_prototype_transport_reference_context", side_effect=AssertionError("post-result read")):
                            self.assertNotIn(self.marker, middleware._filter_tools(request).system_message.text)
                    else:
                        self.assert_context(middleware._filter_tools(request).system_message.text)

    def test_transport_context_does_not_open_any_new_read_file_paths_or_windows(self):
        for kinds in (["prototype"], ["prd", "prototype"]):
            middleware = self.middleware(kinds)
            request = self.request(kinds, accepted="prd" in kinds)
            self.assert_context(middleware._filter_tools(request).system_message.text)
            for path in (*[item[0] for item in middleware_module.PROTOTYPE_REFERENCE_FILES], PRD_REFERENCE_FILES[0][0], "/etc/passwd"):
                with self.subTest(kinds=kinds, path=path):
                    state = copy.deepcopy(request.state)
                    tool_request = request_in_state(state["messages"], READ_FILE_TOOL_NAME, "blocked-read", {"path": path})
                    blocked = middleware.wrap_tool_call(tool_request, lambda _request: self.fail("read_file executed outside its existing scope"))
                    self.assertEqual(blocked.status, "error")

    def test_fixed_reference_reader_rejects_missing_symlink_nonregular_size_utf8_and_hash_failures(self):
        variants = ("missing", "symlink", "directory", "fifo", "empty", "oversized", "invalid-utf8", "hash-mismatch")
        for virtual_path, _digest in middleware_module.PROTOTYPE_REFERENCE_FILES:
            for variant in variants:
                with self.subTest(file=virtual_path, variant=variant), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    for source_path, _ in middleware_module.PROTOTYPE_REFERENCE_FILES:
                        filename = Path(source_path).name
                        (root / filename).write_bytes((self.reference_directory / filename).read_bytes())
                    target = root / Path(virtual_path).name
                    if variant in {"missing", "symlink", "directory", "fifo"}:
                        target.unlink()
                    if variant == "symlink":
                        target.symlink_to(self.reference_directory / target.name)
                    elif variant == "directory":
                        target.mkdir()
                    elif variant == "fifo":
                        os.mkfifo(target)
                    elif variant == "empty":
                        target.write_bytes(b"")
                    elif variant == "oversized":
                        target.write_bytes(b"x" * (middleware_module._PROTOTYPE_REFERENCE_MAX_BYTES + 1))
                    elif variant == "invalid-utf8":
                        target.write_bytes(b"\xff")
                    elif variant == "hash-mismatch":
                        target.write_text("substituted instructions", encoding="utf-8")
                    expected = {
                        "empty": "SIZE_INVALID", "oversized": "SIZE_INVALID", "invalid-utf8": "UTF8_INVALID",
                        "hash-mismatch": "CONTENT_MISMATCH", "fifo": "FILE_INVALID",
                    }.get(variant, "UNAVAILABLE")
                    with patch.object(middleware_module, "_PROTOTYPE_REFERENCE_DIRECTORY", root):
                        with self.assertRaisesRegex(ValueError, f"WORKBENCH_PROTOTYPE_REFERENCE_{expected}"):
                            self.middleware(["prototype"]).wrap_model_call(
                                self.request(["prototype"]), lambda _request: self.fail("model received invalid references"),
                            )

    def test_reader_opens_only_the_two_fixed_files_and_propagates_permission_failure(self):
        with patch.object(middleware_module.os, "open", wraps=os.open) as reader:
            context = middleware_module._prototype_transport_reference_context()
        self.assert_context(context)
        self.assertEqual([args.args[0] for args in reader.call_args_list], [
            self.reference_directory / Path(virtual_path).name
            for virtual_path, _ in middleware_module.PROTOTYPE_REFERENCE_FILES
        ])
        with patch.object(middleware_module.os, "open", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(ValueError, "WORKBENCH_PROTOTYPE_REFERENCE_UNAVAILABLE"):
                middleware_module._prototype_transport_reference_context()

    def real_graph(self, kinds):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage

        observed = []

        class CapturingModel(FakeMessagesListChatModel):
            def _generate(self, messages, *args, **kwargs):
                observed.append(copy.deepcopy(messages))
                return super()._generate(messages, *args, **kwargs)

        graph = create_agent(
            CapturingModel(responses=[AIMessage(content="Captured model request")]),
            system_prompt="Existing system instructions",
            middleware=[self.middleware(kinds)],
        )
        return graph, observed

    def assert_real_capture(self, request, result, observed, *, expected):
        from langchain_core.messages import SystemMessage

        self.assertEqual(len(observed), 1)
        system = [message for message in observed[0] if isinstance(message, SystemMessage)]
        self.assertEqual(len(system), 1)
        if expected:
            self.assert_context(system[0].text)
        else:
            self.assertNotIn(self.marker, system[0].text)
        for message in observed[0]:
            if not isinstance(message, SystemMessage):
                self.assertNotIn(self.marker, str(message.content))
        input_messages = request.state["messages"]
        for predicate in (middleware_module._is_human_message, middleware_module._is_tool_message):
            self.assertEqual(sum(predicate(message) for message in result["messages"]), sum(predicate(message) for message in input_messages))
        self.assertEqual(len(result["messages"]), len(input_messages) + 1)
        self.assertNotIn(self.marker, str(result))
        self.assertNotIn(self.marker, str(request.state))

    @unittest.skipIf(USING_IMPORT_STUBS, "requires actual LangChain model-request serialization")
    def test_real_sync_graph_injects_system_context_only_at_the_correct_boundary(self):
        for kinds, accepted in ((["prototype"], False), (["prd", "prototype"], False), (["prd", "prototype"], True)):
            with self.subTest(kinds=kinds, accepted=accepted):
                request = self.request(kinds, accepted=accepted)
                graph, observed = self.real_graph(kinds)
                result = graph.invoke(copy.deepcopy(request.state), context=request.runtime.context)
                self.assert_real_capture(request, result, observed, expected=accepted or kinds == ["prototype"])

    @unittest.skipIf(USING_IMPORT_STUBS, "requires actual LangChain async model-request serialization")
    async def test_real_async_graph_injects_system_context_only_at_the_correct_boundary(self):
        for kinds, accepted in ((["prototype"], False), (["prototype", "prd"], False), (["prototype", "prd"], True)):
            with self.subTest(kinds=kinds, accepted=accepted):
                request = self.request(kinds, accepted=accepted)
                graph, observed = self.real_graph(kinds)
                result = await graph.ainvoke(copy.deepcopy(request.state), context=request.runtime.context)
                self.assert_real_capture(request, result, observed, expected=accepted or kinds == ["prototype"])


def request_in_state(
    messages: list[dict],
    name: str,
    call_id: str,
    args: dict | None = None,
    *,
    sibling_calls: list[dict] | None = None,
) -> FakeToolRequest:
    current_calls = sibling_calls or [call(name, call_id, args)]
    messages.append({"type": "ai", "content": "", "tool_calls": current_calls})
    return FakeToolRequest(name, call_id, args, {"messages": messages})


class WorkbenchToolScopeMiddlewareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.all_tools = [
            FakeTool("workbench_runtime_result_submit"),
            FakeTool(READ_FILE_TOOL_NAME),
            *map(FakeTool, ARTIFACT_PROGRESS_TOOL_NAMES),
            *map(FakeTool, PROTOTYPE_ONLY_TOOL_NAMES),
            FakeTool(KNOWLEDGE_TOOL_NAME),
            *map(FakeTool, CANVAS_TOOL_NAMES),
        ]

    def visible_names(
        self,
        descriptor,
        requested_artifact_kinds=None,
        knowledge_enabled=None,
    ) -> list[str]:
        middleware = WorkbenchToolScopeMiddleware(
            descriptor,
            requested_artifact_kinds,
            knowledge_enabled,
        )
        observed = middleware.wrap_model_call(FakeModelRequest(self.all_tools), lambda scoped: scoped)
        return [tool.name for tool in observed.tools]

    def test_model_binding_keeps_only_per_run_declared_canvas_tools(self) -> None:
        self.assertEqual(
            self.visible_names(policy("get_visible_screens", "view_screen")),
            ["workbench_runtime_result_submit", "get_visible_screens", "view_screen"],
        )

    def test_policy_normalization_returns_an_isolated_canonical_copy(self) -> None:
        source = policy("get_visible_screens", "view_screen")
        normalized = normalize_workbench_canvas_policy(source)
        middleware = WorkbenchToolScopeMiddleware(source)
        self.assertEqual(normalized, source)
        self.assertIsNot(normalized, source)
        self.assertIsNot(normalized["declaredTools"], source["declaredTools"])
        source["declaredTools"].append("select_screen")
        self.assertEqual(normalized["declaredTools"], ["get_visible_screens", "view_screen"])
        observed = middleware.wrap_model_call(FakeModelRequest(self.all_tools), lambda scoped: scoped)
        self.assertEqual(
            [tool.name for tool in observed.tools],
            ["workbench_runtime_result_submit", "get_visible_screens", "view_screen"],
        )

    def test_policy_is_read_only_from_runnable_config_configurable(self) -> None:
        expected = policy("view_screen")
        self.assertIs(
            workbench_canvas_policy_from_runnable_config(
                {"configurable": {"workbench_canvas_tools": expected}}
            ),
            expected,
        )
        self.assertIsNone(
            workbench_canvas_policy_from_runnable_config(
                {"context": {"workbench_canvas_tools": expected}}
            )
        )
        self.assertIsNone(workbench_canvas_policy_from_runnable_config({"configurable": []}))

    def test_requested_artifact_kinds_are_read_only_from_trusted_runtime_context(self) -> None:
        expected = ["prototype"]
        self.assertIs(
            workbench_requested_artifact_kinds_from_runnable_config(
                {"context": {"workbench": {"requestedArtifactKinds": expected}}}
            ),
            expected,
        )
        self.assertIsNone(
            workbench_requested_artifact_kinds_from_runnable_config(
                {"configurable": {"requestedArtifactKinds": expected}}
            )
        )
        self.assertIsNone(
            workbench_requested_artifact_kinds_from_runnable_config(
                {"context": {"workbench": []}}
            )
        )

    def test_knowledge_visibility_is_read_only_from_trusted_runtime_context(self) -> None:
        self.assertIs(
            workbench_knowledge_enabled_from_runnable_config(
                {"context": {"workbench": {"knowledgeEnabled": True}}}
            ),
            True,
        )
        self.assertIsNone(
            workbench_knowledge_enabled_from_runnable_config(
                {"configurable": {"knowledgeEnabled": True}}
            )
        )
        self.assertIsNone(
            workbench_knowledge_enabled_from_runnable_config(
                {"context": {"workbench": []}}
            )
        )

    def test_run_scope_is_read_only_from_trusted_runtime_context(self) -> None:
        expected = ("run-1", "attempt-1")
        self.assertEqual(
            workbench_run_scope_from_runnable_config(
                {
                    "context": {
                        "workbench": {
                            "runId": expected[0],
                            "runtimeAttemptId": expected[1],
                        }
                    }
                }
            ),
            expected,
        )
        for malformed in (
            None,
            {},
            {"configurable": {"runId": "run-1", "runtimeAttemptId": "attempt-1"}},
            {"context": {"workbench": []}},
            {"context": {"workbench": {"runId": "", "runtimeAttemptId": "attempt-1"}}},
            {"context": {"workbench": {"runId": "run-1", "runtimeAttemptId": " attempt-1"}}},
        ):
            with self.subTest(malformed=malformed):
                self.assertIsNone(workbench_run_scope_from_runnable_config(malformed))

    def test_knowledge_tool_is_visible_only_for_the_exact_true_grant(self) -> None:
        for disabled in (None, False, 1, "true", {}, []):
            with self.subTest(disabled=disabled):
                self.assertNotIn(KNOWLEDGE_TOOL_NAME, self.visible_names(None, None, disabled))
        self.assertIn(KNOWLEDGE_TOOL_NAME, self.visible_names(None, None, True))

    def test_knowledge_execution_is_blocked_without_calling_the_handler(self) -> None:
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = WorkbenchToolScopeMiddleware().wrap_tool_call(
            FakeToolRequest(KNOWLEDGE_TOOL_NAME),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(blocked.status, "error")
        self.assertEqual(blocked.name, KNOWLEDGE_TOOL_NAME)
        self.assertEqual(blocked.content, "Error: WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED")

        sentinel = object()
        allowed = WorkbenchToolScopeMiddleware(None, None, True).wrap_tool_call(
            FakeToolRequest(KNOWLEDGE_TOOL_NAME),
            lambda _request: sentinel,
        )
        self.assertIs(allowed, sentinel)

    def test_artifact_progress_tools_are_visible_for_prd_and_prototype(self) -> None:
        self.assertEqual(
            self.visible_names(None, ["document"]),
            ["workbench_runtime_result_submit"],
        )
        self.assertEqual(
            self.visible_names(None, ["prd"]),
            [
                "workbench_runtime_result_submit",
                READ_FILE_TOOL_NAME,
                *ARTIFACT_PROGRESS_TOOL_NAMES,
            ],
        )
        self.assertEqual(
            self.visible_names(None, ["prototype"]),
            [
                "workbench_runtime_result_submit",
                *ARTIFACT_PROGRESS_TOOL_NAMES,
                *PROTOTYPE_ONLY_TOOL_NAMES,
            ],
        )
        self.assertEqual(
            self.visible_names(None, ["prd", "prototype"]),
            [
                "workbench_runtime_result_submit",
                READ_FILE_TOOL_NAME,
                *ARTIFACT_PROGRESS_TOOL_NAMES,
                *PROTOTYPE_ONLY_TOOL_NAMES,
            ],
        )

    def test_prd_clarification_is_hidden_and_blocked_without_calling_the_handler(self) -> None:
        tools = [
            FakeTool("workbench_runtime_result_submit"),
            FakeTool(CLARIFICATION_TOOL_NAME),
        ]
        prd = WorkbenchToolScopeMiddleware(None, ["prd"])
        base_system_text = "Base DeerFlow policy.\nTodo policy."
        observed = prd.wrap_model_call(
            FakeModelRequest(tools, middleware_module.SystemMessage(content=base_system_text)),
            lambda scoped: scoped,
        )
        self.assertEqual(
            [tool.name for tool in observed.tools],
            ["workbench_runtime_result_submit"],
        )
        self.assertIn(
            "<workbench_prd_clarification_policy>",
            observed.system_message.text,
        )
        self.assertIn("Ignore any general instruction that requires clarification", observed.system_message.text)
        self.assertTrue(observed.system_message.text.startswith(base_system_text))
        self.assertEqual(observed.system_message.text.count(base_system_text), 1)
        repeated = prd.wrap_model_call(observed, lambda scoped: scoped)
        self.assertEqual(
            repeated.system_message.text.count("<workbench_prd_clarification_policy>"),
            1,
        )
        for non_exact_prd_scope in (
            ["prototype"],
            ["document"],
            ["prd", "prd"],
        ):
            with self.subTest(non_exact_prd_scope=non_exact_prd_scope):
                non_exact_prd = WorkbenchToolScopeMiddleware(None, non_exact_prd_scope)
                observed_non_exact_prd = non_exact_prd.wrap_model_call(
                    FakeModelRequest(tools),
                    lambda scoped: scoped,
                )
                self.assertEqual(
                    [tool.name for tool in observed_non_exact_prd.tools],
                    ["workbench_runtime_result_submit", CLARIFICATION_TOOL_NAME],
                )
                self.assertIsNone(observed_non_exact_prd.system_message)

        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = prd.wrap_tool_call(FakeToolRequest(CLARIFICATION_TOOL_NAME), handler)
        self.assertFalse(called)
        self.assertEqual(blocked.status, "error")
        self.assertEqual(blocked.name, CLARIFICATION_TOOL_NAME)
        self.assertEqual(blocked.content, "Error: WORKBENCH_PRD_CLARIFICATION_NOT_SUPPORTED")

    @unittest.skipIf(USING_IMPORT_STUBS, "requires the pinned DeerFlow middleware stack")
    def test_real_middleware_chain_hides_clarification_from_prd_model_binding(self) -> None:
        from deerflow.agents.middlewares.clarification_middleware import ClarificationMiddleware
        from deerflow.tools.builtins import ask_clarification_tool
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage
        from langchain_core.tools import StructuredTool

        observed_tool_names: list[list[str]] = []

        class CapturingModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                del tool_choice, kwargs
                observed_tool_names.append([tool.name for tool in tools])
                return self

        def test_tool(name: str):
            return StructuredTool.from_function(
                lambda: "ok",
                name=name,
                description=f"Contract fixture for {name}",
            )

        expected = [
            RUNTIME_RESULT_TOOL_NAME,
            READ_FILE_TOOL_NAME,
            *ARTIFACT_PROGRESS_TOOL_NAMES,
        ]
        graph = create_agent(
            CapturingModel(responses=[AIMessage(content="done")]),
            tools=[
                test_tool(RUNTIME_RESULT_TOOL_NAME),
                test_tool(READ_FILE_TOOL_NAME),
                *[test_tool(name) for name in ARTIFACT_PROGRESS_TOOL_NAMES],
                *[test_tool(name) for name in PROTOTYPE_ONLY_TOOL_NAMES],
                ask_clarification_tool,
            ],
            middleware=[
                WorkbenchToolScopeMiddleware(None, ["prd"]),
                ClarificationMiddleware(),
            ],
        )
        graph.invoke({"messages": [{"role": "user", "content": "Create a PRD"}]})

        self.assertTrue(observed_tool_names)
        self.assertEqual(observed_tool_names[-1], expected)
        self.assertNotIn(CLARIFICATION_TOOL_NAME, observed_tool_names[-1])

    def test_requested_artifact_kind_policy_is_copied_and_malformed_input_is_fail_closed(self) -> None:
        source = ["prototype"]
        normalized = normalize_workbench_requested_artifact_kinds(source)
        middleware = WorkbenchToolScopeMiddleware(None, source)
        self.assertEqual(normalized, source)
        self.assertIsNot(normalized, source)
        source.append("document")
        self.assertEqual(normalized, ["prototype"])
        observed = middleware.wrap_model_call(FakeModelRequest(self.all_tools), lambda scoped: scoped)
        self.assertEqual(
            [tool.name for tool in observed.tools],
            [
                "workbench_runtime_result_submit",
                *ARTIFACT_PROGRESS_TOOL_NAMES,
                *PROTOTYPE_ONLY_TOOL_NAMES,
            ],
        )

        malformed = [
            None,
            "prototype",
            ["prototype", "prototype"],
            ["unknown"],
            ["prototype", 1],
            ["prd", "prototype", "image", "code", "document", "data", "prd"],
        ]
        for requested_kinds in malformed:
            with self.subTest(requested_kinds=requested_kinds):
                self.assertIsNone(normalize_workbench_requested_artifact_kinds(requested_kinds))
                self.assertEqual(
                    self.visible_names(None, requested_kinds),
                    ["workbench_runtime_result_submit"],
                )

    def test_missing_or_malformed_policy_hides_all_eight_canvas_tools(self) -> None:
        malformed = [
            ...,
            None,
            [],
            {},
            {"declaredTools": "view_screen"},
            {"declaredTools": ["view_screen", "view_screen"]},
            {"declaredTools": ["view_screen", "get_visible_screens"]},
            {"declaredTools": ["unknown"]},
            {"declaredTools": [], "token": "must-not-be-accepted"},
        ]
        for descriptor in malformed:
            with self.subTest(descriptor=descriptor):
                middleware = WorkbenchToolScopeMiddleware(None if descriptor is ... else descriptor)
                observed = middleware.wrap_model_call(FakeModelRequest(self.all_tools), lambda scoped: scoped)
                self.assertEqual([tool.name for tool in observed.tools], ["workbench_runtime_result_submit"])

                called = False

                def handler(_request):
                    nonlocal called
                    called = True
                    return object()

                blocked = middleware.wrap_tool_call(FakeToolRequest("view_screen"), handler)
                self.assertFalse(called)
                self.assertEqual(blocked.status, "error")

    def test_model_binding_filters_object_and_provider_dict_tool_schemas(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(policy("get_visible_screens"))
        tools = [
            {"name": "get_visible_screens"},
            {"type": "function", "function": {"name": "quick_edit"}},
            {"type": "function", "function": {"name": "other_tool"}},
        ]
        observed = middleware.wrap_model_call(FakeModelRequest(tools), lambda scoped: scoped)
        self.assertEqual(observed.tools, [tools[0], tools[2]])

    def test_undeclared_canvas_execution_is_rejected_without_calling_handler(self) -> None:
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        result = WorkbenchToolScopeMiddleware(policy("get_visible_screens")).wrap_tool_call(
            FakeToolRequest("quick_edit"),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(result.status, "error")
        self.assertEqual(result.name, "quick_edit")
        self.assertEqual(result.tool_call_id, "call-1")
        self.assertEqual(result.content, "Error: WORKBENCH_CANVAS_TOOL_NOT_DECLARED")

    def test_non_artifact_execution_rejects_progress_tools_without_calling_handler(self) -> None:
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        for name in ARTIFACT_PROGRESS_TOOL_NAMES:
            with self.subTest(name=name):
                result = WorkbenchToolScopeMiddleware(None, ["document"]).wrap_tool_call(
                    FakeToolRequest(name),
                    handler,
                )
                self.assertFalse(called)
                self.assertEqual(result.status, "error")
                self.assertEqual(result.name, name)
                self.assertEqual(result.content, "Error: WORKBENCH_ARTIFACT_PROGRESS_NOT_REQUESTED")

    def test_prd_execution_starts_with_collecting_and_rejects_prototype_patch(self) -> None:
        sentinel = object()
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        collecting = FakeToolRequest(
            "workbench_generation_stage_update",
            args={"stage": "collecting-prd-context"},
        )
        self.assertIs(
            middleware.wrap_tool_call(collecting, lambda _request: sentinel),
            sentinel,
        )
        draft = middleware.wrap_tool_call(
            FakeToolRequest("workbench_artifact_draft_publish"),
            lambda _request: sentinel,
        )
        self.assertIn("WORKBENCH_PRD_COLLECTING_STAGE_REQUIRED", draft.content)
        for name in PROTOTYPE_ONLY_TOOL_NAMES:
            with self.subTest(name=name):
                result = middleware.wrap_tool_call(FakeToolRequest(name), lambda _request: sentinel)
                self.assertEqual(result.content, "Error: WORKBENCH_PROTOTYPE_TOOL_NOT_REQUESTED")

    def test_prototype_execution_is_allowed_when_prototype_is_requested(self) -> None:
        sentinel = object()
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        for name in (*ARTIFACT_PROGRESS_TOOL_NAMES, *PROTOTYPE_ONLY_TOOL_NAMES):
            with self.subTest(name=name):
                self.assertIs(
                    middleware.wrap_tool_call(FakeToolRequest(name), lambda _request: sentinel),
                    sentinel,
                )

    def test_declared_canvas_execution_and_non_canvas_tools_are_unchanged(self) -> None:
        sentinel = object()
        middleware = WorkbenchToolScopeMiddleware(policy("view_screen"))
        allowed = middleware.wrap_tool_call(
            FakeToolRequest("view_screen"),
            lambda _request: sentinel,
        )
        non_canvas = WorkbenchToolScopeMiddleware({"bad": True}).wrap_tool_call(
            FakeToolRequest("workbench_runtime_result_submit"),
            lambda _request: sentinel,
        )
        self.assertIs(allowed, sentinel)
        self.assertIs(non_canvas, sentinel)

    def test_prd_reference_pins_match_every_shipped_runtime_file(self) -> None:
        for virtual_path, expected_digest in PRD_REFERENCE_FILES:
            with self.subTest(path=virtual_path):
                content = REFERENCE_CONTENT[virtual_path]
                self.assertEqual(
                    hashlib.sha256(content.encode("utf-8")).hexdigest(),
                    expected_digest,
                )
                self.assertLess(len(content), 50_000)

    def test_prd_gate_blocks_premature_structuring_draft_and_final_with_actions(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        for name, args in (
            ("workbench_generation_stage_update", {"stage": "structuring-prd"}),
            ("workbench_artifact_draft_publish", {}),
            ("workbench_runtime_result_submit", {}),
        ):
            with self.subTest(name=name):
                called = False

                def handler(_request):
                    nonlocal called
                    called = True
                    return object()

                blocked = middleware.wrap_tool_call(
                    FakeToolRequest(name, args=args),
                    handler,
                )
                self.assertFalse(called)
                self.assertEqual(blocked.status, "error")
                self.assertEqual(blocked.name, name)
                self.assertEqual(blocked.tool_call_id, "call-1")
                self.assertIn("stage='collecting-prd-context'", blocked.content)

    def test_prd_gate_allows_ordered_reference_reads_in_one_batch(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        messages = prd_messages(stage_count=1, references=False)
        reference_calls = [
            call(READ_FILE_TOOL_NAME, f"parallel-reference-{index}", {"path": path})
            for index, (path, _digest) in enumerate(PRD_REFERENCE_FILES)
        ]
        messages.append({"type": "ai", "content": "", "tool_calls": reference_calls})
        state = {"messages": messages}
        called: list[str] = []
        for index, (path, _digest) in enumerate(PRD_REFERENCE_FILES):
            call_id = f"parallel-reference-{index}"
            request = FakeToolRequest(
                READ_FILE_TOOL_NAME,
                call_id,
                {"path": path},
                state,
            )

            def handler(_request, *, current_id=call_id, current_path=path):
                called.append(current_id)
                return middleware_module.ToolMessage(
                    content=REFERENCE_CONTENT[current_path],
                    tool_call_id=current_id,
                    name=READ_FILE_TOOL_NAME,
                    status="success",
                )

            observed = middleware.wrap_tool_call(request, handler)
            self.assertEqual(observed.status, "success")
            self.assertEqual(observed.content, REFERENCE_CONTENT[path])
        self.assertEqual(
            called,
            [f"parallel-reference-{index}" for index in range(len(PRD_REFERENCE_FILES))],
        )

    def test_prd_gate_deterministically_blocks_duplicate_and_misordered_batch_reads(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        structure_path = PRD_REFERENCE_FILES[0][0]
        quality_path = PRD_REFERENCE_FILES[1][0]
        messages = prd_messages(stage_count=1, references=False)
        duplicate_calls = [
            call("read_file", "first-structure", {"path": structure_path}),
            call("read_file", "duplicate-structure", {"path": structure_path}),
            call("read_file", "quality-after-duplicate", {"path": quality_path}),
        ]
        messages.append({"type": "ai", "content": "", "tool_calls": duplicate_calls})
        state = {"messages": messages}
        first = middleware.wrap_tool_call(
            FakeToolRequest("read_file", "first-structure", {"path": structure_path}, state),
            lambda _request: middleware_module.ToolMessage(
                content=REFERENCE_CONTENT[structure_path],
                tool_call_id="first-structure",
                name="read_file",
                status="success",
            ),
        )
        self.assertEqual(first.status, "success")
        for call_id, path in (
            ("duplicate-structure", structure_path),
            ("quality-after-duplicate", quality_path),
        ):
            called = False

            def handler(_request):
                nonlocal called
                called = True
                return object()

            blocked = middleware.wrap_tool_call(
                FakeToolRequest("read_file", call_id, {"path": path}, state),
                handler,
            )
            self.assertFalse(called)
            self.assertIn("WORKBENCH_PRD_REFERENCE_ORDER_INVALID", blocked.content)

        wrong_order_messages = prd_messages(stage_count=1, references=False)
        request = request_in_state(
            wrong_order_messages,
            "read_file",
            "quality-first",
            {"path": quality_path},
        )
        blocked = middleware.wrap_tool_call(request, lambda _request: object())
        self.assertIn("WORKBENCH_PRD_REFERENCE_ORDER_INVALID", blocked.content)
        self.assertIn(structure_path, blocked.content)

    def test_prd_gate_requires_exact_unranged_path_and_pinned_handler_content(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        structure_path, expected_digest = PRD_REFERENCE_FILES[0]
        alias_path = structure_path.replace(
            "/requirement-doc-template/",
            "/requirement-doc-template/./",
        )
        alias_request = request_in_state(
            prd_messages(stage_count=1, references=False),
            "read_file",
            "alias-reference",
            {"path": alias_path},
        )
        alias = middleware.wrap_tool_call(alias_request, lambda _request: object())
        self.assertIn("WORKBENCH_PRD_REFERENCE_PATH_INVALID", alias.content)
        self.assertIn(structure_path, alias.content)

        unrelated_request = request_in_state(
            prd_messages(stage_count=1, references=False),
            READ_FILE_TOOL_NAME,
            "unrelated-reference",
            {"path": "/mnt/user-data/private.txt"},
        )
        unrelated = middleware.wrap_tool_call(unrelated_request, lambda _request: object())
        self.assertIn("WORKBENCH_PRD_REFERENCE_PATH_INVALID", unrelated.content)
        self.assertIn(structure_path, unrelated.content)

        ranged_request = request_in_state(
            prd_messages(stage_count=1, references=False),
            "read_file",
            "ranged-reference",
            {"path": structure_path, "start_line": 1, "end_line": 20},
        )
        ranged = middleware.wrap_tool_call(ranged_request, lambda _request: object())
        self.assertIn("WORKBENCH_PRD_REFERENCE_RANGE_FORBIDDEN", ranged.content)

        hash_request = request_in_state(
            prd_messages(stage_count=1, references=False),
            "read_file",
            "hash-mismatch",
            {"path": structure_path},
        )
        mismatch = middleware.wrap_tool_call(
            hash_request,
            lambda _request: middleware_module.ToolMessage(
                content=f"{REFERENCE_CONTENT[structure_path]}\nchanged",
                tool_call_id="hash-mismatch",
                name="read_file",
                status="success",
            ),
        )
        self.assertEqual(mismatch.status, "error")
        self.assertIn("WORKBENCH_PRD_REFERENCE_CONTENT_MISMATCH", mismatch.content)
        self.assertIn(expected_digest, mismatch.content)

        failed_request = request_in_state(
            prd_messages(stage_count=1, references=False),
            "read_file",
            "read-failed",
            {"path": structure_path},
        )
        failed = middleware.wrap_tool_call(
            failed_request,
            lambda _request: middleware_module.ToolMessage(
                content="Error: File not found",
                tool_call_id="read-failed",
                name="read_file",
                status="success",
            ),
        )
        self.assertEqual(failed.status, "error")
        self.assertIn("WORKBENCH_PRD_REFERENCE_READ_FAILED", failed.content)

    def test_prd_gate_enforces_stage_draft_final_sequence_and_allows_correction(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        structuring_messages = prd_messages(stage_count=1, references=True)
        structuring = request_in_state(
            structuring_messages,
            "workbench_generation_stage_update",
            "structuring-current",
            {"stage": "structuring-prd"},
        )
        sentinel = object()
        self.assertIs(
            middleware.wrap_tool_call(structuring, lambda _request: sentinel),
            sentinel,
        )

        without_draft = request_in_state(
            prd_messages(stage_count=4, references=True),
            "workbench_runtime_result_submit",
            "final-before-draft",
            {},
        )
        blocked_final = middleware.wrap_tool_call(without_draft, lambda _request: sentinel)
        self.assertIn("WORKBENCH_PRD_DRAFT_REQUIRED", blocked_final.content)

        draft_request = request_in_state(
            prd_messages(stage_count=4, references=True),
            "workbench_artifact_draft_publish",
            "draft-current",
            {},
        )
        self.assertIs(
            middleware.wrap_tool_call(draft_request, lambda _request: sentinel),
            sentinel,
        )

        complete_messages = prd_messages(stage_count=4, references=True, draft=True)
        append_tool_batch(
            complete_messages,
            [call("workbench_runtime_result_submit", "early-final", {})],
            [tool_message(
                "workbench_runtime_result_submit",
                "early-final",
                "Error: WORKBENCH_PRD_DRAFT_REQUIRED",
                status="error",
            )],
        )
        corrected_final = request_in_state(
            complete_messages,
            "workbench_runtime_result_submit",
            "corrected-final",
            {},
        )
        self.assertIs(
            middleware.wrap_tool_call(corrected_final, lambda _request: sentinel),
            sentinel,
        )

        duplicate_draft = request_in_state(
            prd_messages(stage_count=4, references=True, draft=True),
            "workbench_artifact_draft_publish",
            "duplicate-draft",
            {},
        )
        duplicate = middleware.wrap_tool_call(duplicate_draft, lambda _request: sentinel)
        self.assertIn("WORKBENCH_PRD_DRAFT_ALREADY_PUBLISHED", duplicate.content)

        duplicate_final_messages = prd_messages(stage_count=4, references=True, draft=True)
        final_calls = [
            call("workbench_runtime_result_submit", "parallel-final-first", {}),
            call("workbench_runtime_result_submit", "parallel-final-second", {}),
        ]
        duplicate_final_messages.append({
            "type": "ai",
            "content": "",
            "tool_calls": final_calls,
        })
        duplicate_final_state = {"messages": duplicate_final_messages}
        first_final = FakeToolRequest(
            "workbench_runtime_result_submit",
            "parallel-final-first",
            {},
            duplicate_final_state,
        )
        second_final = FakeToolRequest(
            "workbench_runtime_result_submit",
            "parallel-final-second",
            {},
            duplicate_final_state,
        )
        self.assertIs(
            middleware.wrap_tool_call(first_final, lambda _request: sentinel),
            sentinel,
        )
        blocked_duplicate_final = middleware.wrap_tool_call(
            second_final,
            lambda _request: sentinel,
        )
        self.assertIn(
            "WORKBENCH_PRD_PUBLICATION_BATCH_INVALID",
            blocked_duplicate_final.content,
        )

    def test_prd_gate_ignores_failed_attempts_but_not_previous_turn_evidence(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        messages = prd_messages(stage_count=1, references=False)
        structure_path = PRD_REFERENCE_FILES[0][0]
        append_tool_batch(
            messages,
            [call("read_file", "failed-structure", {"path": structure_path})],
            [tool_message(
                "read_file",
                "failed-structure",
                "Error: transient read failure",
                status="error",
            )],
        )
        append_references(messages)
        structuring = request_in_state(
            messages,
            "workbench_generation_stage_update",
            "structuring-after-retry",
            {"stage": "structuring-prd"},
        )
        sentinel = object()
        self.assertIs(
            middleware.wrap_tool_call(structuring, lambda _request: sentinel),
            sentinel,
        )

        partial_batch = prd_messages(stage_count=1, references=False)
        append_references(partial_batch, status_by_index={0: "error"})
        retry_id = "retry-missing-structure"
        retry = request_in_state(
            partial_batch,
            "read_file",
            retry_id,
            {"path": structure_path},
        )
        recovered = middleware.wrap_tool_call(
            retry,
            lambda _request: middleware_module.ToolMessage(
                content=REFERENCE_CONTENT[structure_path],
                tool_call_id=retry_id,
                name="read_file",
                status="success",
            ),
        )
        self.assertEqual(recovered.status, "success")
        partial_batch.append(tool_message(
            "read_file",
            retry_id,
            REFERENCE_CONTENT[structure_path],
        ))

        recovered_structuring = request_in_state(
            list(partial_batch),
            "workbench_generation_stage_update",
            "structuring-after-partial-batch-retry",
            {"stage": "structuring-prd"},
        )
        self.assertIs(
            middleware.wrap_tool_call(recovered_structuring, lambda _request: sentinel),
            sentinel,
        )
        duplicate_after_recovery = request_in_state(
            list(partial_batch),
            "read_file",
            "duplicate-quality-after-recovery",
            {"path": PRD_REFERENCE_FILES[1][0]},
        )
        blocked_duplicate = middleware.wrap_tool_call(
            duplicate_after_recovery,
            lambda _request: sentinel,
        )
        self.assertIn("WORKBENCH_PRD_REFERENCE_ORDER_INVALID", blocked_duplicate.content)

        previous_turn = prd_messages(stage_count=4, references=True, draft=True)
        previous_turn.append({"type": "human", "content": "new PRD turn"})
        current_final = request_in_state(
            previous_turn,
            "workbench_runtime_result_submit",
            "new-turn-final",
            {},
        )
        blocked = middleware.wrap_tool_call(current_final, lambda _request: sentinel)
        self.assertIn("WORKBENCH_PRD_COLLECTING_STAGE_REQUIRED", blocked.content)

    def test_prd_reference_reader_is_blocked_when_prd_is_not_requested(self) -> None:
        path = PRD_REFERENCE_FILES[0][0]
        for requested_kinds in (["prototype"], ["document"]):
            with self.subTest(requested_kinds=requested_kinds):
                middleware = WorkbenchToolScopeMiddleware(None, requested_kinds)
                called = False

                def handler(_request):
                    nonlocal called
                    called = True
                    return object()

                request = FakeToolRequest(READ_FILE_TOOL_NAME, args={"path": path})
                blocked = middleware.wrap_tool_call(request, handler)
                self.assertFalse(called)
                self.assertEqual(
                    blocked.content,
                    "Error: WORKBENCH_PRD_REFERENCE_TOOL_NOT_AUTHORIZED",
                )

    def test_linked_run_keeps_prd_draft_then_publishes_prototype_before_combined_result(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None, ["prd", "prototype"], run_scope=("run-auto", "attempt-auto"),
        )
        request = automatic_prd_request()
        request.runtime.context["workbench"]["requestedArtifactKinds"] = ["prd", "prototype"]
        scoped = middleware.wrap_model_call(request, lambda scoped: scoped)
        self.assertIsInstance(scoped, FakeModelRequest)
        self.assertIn("<workbench_linked_prd_policy>", scoped.system_message.text)
        self.assertNotIn("<workbench_prd_clarification_policy>", scoped.system_message.text)
        messages = request.state["messages"]
        prd = copy.deepcopy(messages[-1]["artifact"]["draft"])
        prototype = {"kind": "prototype", "title": "Linked Prototype"}
        sentinel = object()

        early = request_in_state(
            copy.deepcopy(messages), RUNTIME_RESULT_TOOL_NAME, "early",
            {"candidate": {"artifacts": [prd]}},
        )
        self.assertIn(
            "WORKBENCH_LINKED_PROTOTYPE_STAGES_REQUIRED",
            middleware.wrap_tool_call(early, lambda _request: sentinel).content,
        )
        for index, stage in enumerate(middleware_module.PROTOTYPE_STAGE_SEQUENCE):
            call_id = f"prototype-stage-{index}"
            stage_request = request_in_state(messages, "workbench_generation_stage_update", call_id, {"stage": stage})
            self.assertIs(middleware.wrap_tool_call(stage_request, lambda _request: sentinel), sentinel)
            messages.append(tool_message("workbench_generation_stage_update", call_id, artifact={
                "protocol": "workbench.runtime.generation-stage.v1", "stage": stage,
                "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": call_id,
            }))

        draft_request = request_in_state(messages, "workbench_artifact_draft_publish", "prototype-draft", {
            "artifact_index": 1, "draft": prototype,
        })
        self.assertIs(middleware.wrap_tool_call(draft_request, lambda _request: sentinel), sentinel)
        messages.append(tool_message("workbench_artifact_draft_publish", "prototype-draft", artifact={
            "protocol": "workbench.runtime.artifact-draft.v1", "ok": True,
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": "prototype-draft",
            "artifactIndex": 1, "draft": prototype,
        }))
        incomplete = request_in_state(
            copy.deepcopy(messages), RUNTIME_RESULT_TOOL_NAME, "incomplete",
            {"candidate": {"artifacts": [prd]}},
        )
        self.assertIn(
            "WORKBENCH_LINKED_RESULT_DRAFT_MISMATCH",
            middleware.wrap_tool_call(incomplete, lambda _request: sentinel).content,
        )
        result_request = request_in_state(messages, RUNTIME_RESULT_TOOL_NAME, "combined", {
            "candidate": {"artifacts": [prd, prototype]},
        })
        self.assertIs(middleware.wrap_tool_call(result_request, lambda _request: sentinel), sentinel)

    def test_linked_run_rejects_prototype_stages_before_prd_draft(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd", "prototype"])
        request = request_in_state(
            prd_messages(stage_count=4, references=True),
            "workbench_generation_stage_update", "early-prototype",
            {"stage": middleware_module.PROTOTYPE_STAGE_SEQUENCE[0]},
        )
        result = middleware.wrap_tool_call(request, lambda _request: self.fail("handler called"))
        self.assertIn("WORKBENCH_PRD_DRAFT_REQUIRED", result.content)


class LinkedDraftRecoveryTests(unittest.IsolatedAsyncioTestCase):
    scope = {"runId": "run-auto", "runtimeAttemptId": "attempt-auto", "requestedArtifactKinds": ["prd", "prototype"]}

    def middleware(self, kinds=None, scope=("run-auto", "attempt-auto")):
        return WorkbenchToolScopeMiddleware(None, kinds or ["prd", "prototype"], run_scope=scope)

    def runtime(self, scope=None, task_id="hook-task"):
        return types.SimpleNamespace(context={"run_id": "external-provider-id", "workbench": scope or self.scope}, execution_info=types.SimpleNamespace(task_id=task_id))

    def state(self):
        state = automatic_prd_request().state
        state["messages"] = state["messages"][:-2]
        issues = [{"code": "invalid_type", "path": ["content", "sections", "businessRequirements"], "message": "Required"}]
        append_tool_batch(state["messages"], [call("workbench_artifact_draft_publish", "rejected-draft", {
            "artifact_index": 0, "draft": {"kind": "prd", "title": "Keep this title"},
        })], [tool_message("workbench_artifact_draft_publish", "rejected-draft", json.dumps({
            "protocol": "workbench.runtime.artifact-draft-ack.v1", "ok": False,
            "artifactIndex": 0, "candidateChecksum": "a" * 64, "issues": issues,
        }), artifact={
            "protocol": "workbench.runtime.artifact-draft.v1", "ok": False,
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": "rejected-draft",
            "artifactIndex": 0, "issues": issues,
        })])
        return state

    def stop(self, state, message_id="ordinary-stop", **overrides):
        message = {"type": "ai", "id": message_id, "content": "Please retry.",
                   "tool_calls": [], "response_metadata": {"finish_reason": "stop"}, **overrides}
        state["messages"].append(message)
        return message

    def apply(self, state, update):
        self.assertIsNotNone(update)
        self.assertEqual(update["jump_to"], "model")
        self.assertNotIn("messages", update)
        state.update({key: value for key, value in update.items() if key != "jump_to"})

    async def test_rejected_draft_wrong_stage_then_repair_preserves_publication_gates(self):
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                middleware = self.middleware()
                state = self.state()
                repeat = request_in_state(state["messages"], "workbench_generation_stage_update", "repeat-validating", {"stage": "validating-prd"})
                blocked = middleware.wrap_tool_call(repeat, lambda _request: self.fail("repeated stage executed"))
                self.assertIn("WORKBENCH_PRD_STAGE_ORDER_INVALID", blocked.content)
                state["messages"].append(blocked)
                self.stop(state)
                update = await middleware.aafter_model(state, self.runtime()) if asynchronous else middleware.after_model(state, self.runtime())
                self.apply(state, update)
                request = FakeModelRequest([FakeTool("workbench_artifact_draft_publish")], state=state, context=self.runtime().context)

                async def capture(scoped):
                    return scoped

                scoped = await middleware.awrap_model_call(request, capture) if asynchronous else middleware.wrap_model_call(request, lambda scoped: scoped)
                self.assertIn("preserve every other field", scoped.system_message.text)
                self.assertIn("Do not repeat completed generation stages", scoped.system_message.text)
                self.assertIn("only the four PRD", scoped.system_message.text)
                self.assertIsNone(request.system_message)
                repaired = {"kind": "prd", "title": "Keep this title"}
                retry = request_in_state(state["messages"], "workbench_artifact_draft_publish", "repaired-draft", {"artifact_index": 0, "draft": repaired})
                accepted = middleware_module.ToolMessage(content='{"ok":true}', name="workbench_artifact_draft_publish", tool_call_id="repaired-draft", status="success", artifact={
                    "protocol": "workbench.runtime.artifact-draft.v1", "ok": True,
                    "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": "repaired-draft",
                    "artifactIndex": 0, "draft": repaired,
                })

                async def publish(_request):
                    return accepted

                result = await middleware.awrap_tool_call(retry, publish) if asynchronous else middleware.wrap_tool_call(retry, lambda _request: accepted)
                self.assertIs(result, accepted)
                state["messages"].append(result)
                self.assertEqual(middleware_module._stage_progress(state, "run-auto", "attempt-auto"), (4, False))
                self.assertEqual(middleware_module._successful_prd_drafts(state, "run-auto", "attempt-auto"), (1, False))
                self.stop(state, "after-repair")
                self.assertIsNone(middleware.after_model(state, self.runtime()))
                self.assertEqual(sum(middleware_module._is_human_message(m) for m in state["messages"]), 1)
                self.assertEqual(middleware_module._successful_runtime_results(state, "run-auto", "attempt-auto"), (0, False))

    async def test_retry_budget_is_checkpointed_idempotent_and_survives_reconstruction(self):
        state = self.state()
        key = middleware_module._LINKED_DRAFT_RECOVERY_KEY
        for count in (1, 2):
            self.stop(state, f"stop-{count}")
            middleware = self.middleware()
            runtime = self.runtime(task_id=f"hook-task-{count}")
            self.apply(state, await middleware.aafter_model(state, runtime))
            self.assertEqual(state[key]["count"], count)
            self.assertEqual(middleware.after_model(state, runtime), {"jump_to": "model"})
            state = json.loads(json.dumps(state))
        self.stop(state, "third-stop")
        ended = self.middleware().after_model(state, self.runtime(task_id="third-hook"))
        self.assertEqual(ended["jump_to"], "end")
        self.assertEqual(ended[key]["count"], 2)
        self.assertTrue(ended[key]["exhausted"])
        self.assertEqual(ended[key]["code"], "WORKBENCH_LINKED_DRAFT_REPAIR_EXHAUSTED")
        state[key] = ended[key]
        self.assertEqual(await self.middleware().aafter_model(state, self.runtime()), {"jump_to": "end"})

    def test_recovery_requires_exact_joint_and_matching_trusted_runtime(self):
        state = self.state()
        self.stop(state)
        for kinds in (["prd"], ["prototype"], ["prd", "prototype", "document"], ["prd", "prd"]):
            self.assertIsNone(self.middleware(kinds=kinds).after_model(state, self.runtime()))
        for scope in (None, ("other", "attempt-auto"), ("run-auto", "other")):
            self.assertIsNone(self.middleware(scope=scope).after_model(state, self.runtime()))
        for runtime in (None, types.SimpleNamespace(context={}), self.runtime({**self.scope, "runtimeAttemptId": "other"})):
            self.assertIsNone(self.middleware().after_model(state, runtime))
        self.assertEqual(self.middleware(kinds=["prototype", "prd"]).after_model(state, self.runtime())["jump_to"], "model")

    def test_old_attempt_budget_is_ignored_but_matching_malformed_budget_fails_closed(self):
        state = self.state()
        self.stop(state)
        self.apply(state, self.middleware().after_model(state, self.runtime()))
        key = middleware_module._LINKED_DRAFT_RECOVERY_KEY
        marker = copy.deepcopy(state[key])
        for bad_count in (True, -1, 0, 3, "1"):
            state[key] = {**marker, "count": bad_count}
            with self.assertRaisesRegex(ValueError, "WORKBENCH_LINKED_DRAFT_REPAIR_STATE_INVALID"):
                self.middleware().after_model(state, self.runtime())
        state[key] = {**marker, "runtimeAttemptId": "old-attempt", "count": 2}
        self.assertEqual(self.middleware().after_model(state, self.runtime())[key]["count"], 1)

    def test_no_rejection_unbound_rejection_and_completed_result_do_not_recover(self):
        state = self.state()
        rejected = state["messages"][-1]
        for changes in ({"runId": "other"}, {"runtimeAttemptId": "other"}, {"toolCallId": "other"}, {"artifactIndex": 1}, {"ok": True}, {"issues": []}):
            altered = copy.deepcopy(state)
            altered["messages"][-1]["artifact"].update(changes)
            self.stop(altered)
            self.assertIsNone(self.middleware().after_model(altered, self.runtime()))
        no_rejection = automatic_prd_request().state
        self.stop(no_rejection)
        self.assertIsNone(self.middleware().after_model(no_rejection, self.runtime()))
        append_tool_batch(state["messages"], [call(RUNTIME_RESULT_TOOL_NAME, "final-result", {})], [tool_message(RUNTIME_RESULT_TOOL_NAME, "final-result", artifact={
            "protocol": "workbench.runtime.validated-result.v1", "ok": True,
            "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": "final-result",
        })])
        self.stop(state)
        self.assertIsNone(self.middleware().after_model(state, self.runtime()))
        self.assertFalse(rejected["artifact"]["ok"])

    def test_provider_safety_interrupt_and_tool_intent_never_restart(self):
        endings = [
            {"response_metadata": {}},
            *[{"response_metadata": {"finish_reason": reason}} for reason in ("length", "content_filter", "SAFETY", "tool_calls")],
            {"response_metadata": {"finish_reason": "stop", "stop_reason": "refusal"}},
            {"additional_kwargs": {"stop_reason": "refusal"}},
            *[{"additional_kwargs": {key: True}} for key in ("refusal", "safety_termination", "error")],
            {"content": [{"type": "refusal", "refusal": "Refused"}]},
            *[{"content": [{"type": "text", "text": marker}]} for marker in ("[TOKEN BUDGET EXCEEDED]", "[FORCED STOP]", "[LOOP DETECTED]")],
            *[{"content": [{"type": "thinking", "thinking": "Reasoning"}, {"type": "text", "text": marker}]} for marker in ("[TOKEN BUDGET EXCEEDED]", "[FORCED STOP]", "[LOOP DETECTED]")],
            {"invalid_tool_calls": [{"name": "workbench_artifact_draft_publish", "id": "invalid", "args": "{"}]},
            {"additional_kwargs": {"tool_calls": [{"id": "raw"}]}},
            {"additional_kwargs": {"function_call": {"name": "raw"}}},
            {"tool_calls": [call("workbench_artifact_draft_publish", "pending", {})]},
        ]
        for ending in endings:
            with self.subTest(ending=ending):
                state = self.state()
                self.stop(state, **ending)
                self.assertIsNone(self.middleware().after_model(state, self.runtime()))
        for boundary in ({"jump_to": "end"}, {"__interrupt__": ["pause"]}, {"interrupts": ["pause"]}):
            state = self.state()
            self.stop(state)
            state.update(boundary)
            self.assertIsNone(self.middleware().after_model(state, self.runtime()))
        state = self.state()
        self.stop(state)
        runtime = self.runtime()
        runtime.control = types.SimpleNamespace(drain_requested=True)
        self.assertIsNone(self.middleware().after_model(state, runtime))

    @unittest.skipIf(USING_IMPORT_STUBS, "requires real LangChain routing and checkpoint schemas")
    def test_real_graph_routes_repair_without_forging_messages_or_replaying_stages(self):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage
        from langchain_core.tools import StructuredTool
        from langgraph.checkpoint.memory import InMemorySaver

        observed_requests = []
        publications = []

        class CapturingModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                return self

            def _generate(self, messages, *args, **kwargs):
                observed_requests.append(messages)
                return super()._generate(messages, *args, **kwargs)

        def publish(artifact_index: int, draft: dict):
            publications.append(copy.deepcopy(draft))
            return '{"ok":true}', {
                "protocol": "workbench.runtime.artifact-draft.v1", "ok": True,
                "runId": "run-auto", "runtimeAttemptId": "attempt-auto", "toolCallId": "real-repair",
                "artifactIndex": artifact_index, "draft": draft,
            }

        def stage(stage: str):
            self.fail("already completed stage was executed")

        stop = lambda ident: AIMessage(id=ident, content="Please retry.", response_metadata={"finish_reason": "stop"})
        repaired = {"kind": "prd", "title": "Keep this title"}
        model = CapturingModel(responses=[
            AIMessage(content="", tool_calls=[call("workbench_generation_stage_update", "real-repeat-stage", {"stage": "validating-prd"})]),
            stop("real-first-stop"),
            AIMessage(content="", tool_calls=[call("workbench_artifact_draft_publish", "real-repair", {"artifact_index": 0, "draft": repaired})]),
            stop("real-after-repair"),
        ])
        graph = create_agent(model, tools=[
            StructuredTool.from_function(publish, name="workbench_artifact_draft_publish", description="Publish a validated fixture", response_format="content_and_artifact"),
            StructuredTool.from_function(stage, name="workbench_generation_stage_update", description="Record a fixture stage"),
        ], middleware=[self.middleware()], checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "linked-repair-test"}, "recursion_limit": 60}
        result = graph.invoke(self.state(), config=config, context=self.runtime().context)
        self.assertEqual(publications, [repaired])
        self.assertEqual(len(observed_requests), 4)
        self.assertTrue(any("<workbench_linked_draft_repair>" in str(message.content) for message in observed_requests[2]))
        self.assertEqual(sum(middleware_module._is_human_message(m) for m in result["messages"]), 1)
        self.assertEqual(middleware_module._stage_progress(result, "run-auto", "attempt-auto"), (4, False))
        self.assertEqual(middleware_module._successful_prd_drafts(result, "run-auto", "attempt-auto"), (1, False))
        self.assertEqual(middleware_module._successful_runtime_results(result, "run-auto", "attempt-auto"), (0, False))
        key = middleware_module._LINKED_DRAFT_RECOVERY_KEY
        self.assertNotIn(key, result)
        self.assertEqual(graph.get_state(config).values[key]["count"], 1)
        self.assertNotIn(key, json.dumps(graph.get_input_schema().model_json_schema()))
        self.assertNotIn(key, json.dumps(graph.get_output_schema().model_json_schema()))

    @unittest.skipIf(USING_IMPORT_STUBS, "requires real LangChain routing and checkpoint schemas")
    async def test_real_async_graph_exhausts_private_checkpointed_budget(self):
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage
        from langgraph.checkpoint.memory import InMemorySaver

        # A provider may reuse a message ID. The cap must depend on graph task
        # identity, not on that model-controlled field.
        responses = [AIMessage(id="reused-provider-id", content="Please retry.", response_metadata={"finish_reason": "stop"}) for _ in range(3)]
        graph = create_agent(FakeMessagesListChatModel(responses=responses), middleware=[self.middleware()], checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "linked-limit-test"}, "recursion_limit": 60}
        state = self.state()
        key = middleware_module._LINKED_DRAFT_RECOVERY_KEY
        state[key] = {"runId": "run-auto", "runtimeAttemptId": "attempt-auto", "count": 999}
        result = await graph.ainvoke(state, config=config, context=self.runtime().context)
        checkpoint = await graph.aget_state(config)
        self.assertEqual(checkpoint.values[key]["count"], 2)
        self.assertTrue(checkpoint.values[key]["exhausted"])
        self.assertEqual(checkpoint.values[key]["messageId"], "reused-provider-id")
        self.assertEqual(checkpoint.values[key]["code"], "WORKBENCH_LINKED_DRAFT_REPAIR_EXHAUSTED")
        self.assertEqual(middleware_module._successful_runtime_results(result, "run-auto", "attempt-auto"), (0, False))
        self.assertEqual(sum(middleware_module._is_human_message(m) for m in result["messages"]), 1)


class WorkbenchToolScopeMiddlewareAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_model_and_tool_paths_enforce_the_same_scope(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(policy("get_selected_screens"))

        async def model_handler(request):
            return request

        model_result = await middleware.awrap_model_call(
            FakeModelRequest([FakeTool("view_screen"), FakeTool("get_selected_screens")]),
            model_handler,
        )
        self.assertEqual([tool.name for tool in model_result.tools], ["get_selected_screens"])

        called = False

        async def tool_handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = await middleware.awrap_tool_call(
            FakeToolRequest("view_screen"),
            tool_handler,
        )
        self.assertFalse(called)
        self.assertEqual(blocked.content, "Error: WORKBENCH_CANVAS_TOOL_NOT_DECLARED")

        allowed = await middleware.awrap_tool_call(
            FakeToolRequest("get_selected_screens"),
            tool_handler,
        )
        self.assertTrue(called)
        self.assertIsNotNone(allowed)

    async def test_async_non_canvas_tool_is_not_affected_by_malformed_policy(self) -> None:
        middleware = WorkbenchToolScopeMiddleware({"unexpected": True})
        sentinel = object()

        async def handler(_request):
            return sentinel

        observed = await middleware.awrap_tool_call(
            FakeToolRequest("workbench_runtime_result_submit"),
            handler,
        )
        self.assertIs(observed, sentinel)

    async def test_async_artifact_progress_execution_is_fail_closed(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["document"])
        called = False

        async def handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = await middleware.awrap_tool_call(
            FakeToolRequest("workbench_artifact_draft_publish"),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(blocked.content, "Error: WORKBENCH_ARTIFACT_PROGRESS_NOT_REQUESTED")

    async def test_async_prd_and_prototype_model_binding_enforces_artifact_visibility_matrix(
        self,
    ) -> None:
        tools = [
            FakeTool("workbench_runtime_result_submit"),
            FakeTool(READ_FILE_TOOL_NAME),
            *map(FakeTool, ARTIFACT_PROGRESS_TOOL_NAMES),
            *map(FakeTool, PROTOTYPE_ONLY_TOOL_NAMES),
            FakeTool(CLARIFICATION_TOOL_NAME),
        ]

        async def handler(request):
            return request

        prd_result = await WorkbenchToolScopeMiddleware(None, ["prd"]).awrap_model_call(
            FakeModelRequest(tools),
            handler,
        )
        self.assertEqual(
            [tool.name for tool in prd_result.tools],
            [
                "workbench_runtime_result_submit",
                READ_FILE_TOOL_NAME,
                *ARTIFACT_PROGRESS_TOOL_NAMES,
            ],
        )
        self.assertIn("<workbench_prd_clarification_policy>", prd_result.system_message.text)

        prototype_result = await WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
        ).awrap_model_call(FakeModelRequest(tools), handler)
        self.assertEqual(
            [tool.name for tool in prototype_result.tools],
            [
                "workbench_runtime_result_submit",
                *ARTIFACT_PROGRESS_TOOL_NAMES,
                *PROTOTYPE_ONLY_TOOL_NAMES,
                CLARIFICATION_TOOL_NAME,
            ],
        )
        self.assertIsNone(prototype_result.system_message)

    async def test_async_prd_and_prototype_tool_execution_enforces_artifact_scope_matrix(
        self,
    ) -> None:
        called: list[str] = []
        sentinel = object()

        async def handler(request):
            called.append(request.tool_call["name"])
            return sentinel

        prd_middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        blocked_clarification = await prd_middleware.awrap_tool_call(
            FakeToolRequest(CLARIFICATION_TOOL_NAME),
            handler,
        )
        self.assertEqual(
            blocked_clarification.content,
            "Error: WORKBENCH_PRD_CLARIFICATION_NOT_SUPPORTED",
        )
        self.assertNotIn(CLARIFICATION_TOOL_NAME, called)
        collecting = FakeToolRequest(
            "workbench_generation_stage_update",
            args={"stage": "collecting-prd-context"},
        )
        self.assertIs(
            await prd_middleware.awrap_tool_call(collecting, handler),
            sentinel,
        )
        blocked_draft = await prd_middleware.awrap_tool_call(
            FakeToolRequest("workbench_artifact_draft_publish"),
            handler,
        )
        self.assertIn("WORKBENCH_PRD_COLLECTING_STAGE_REQUIRED", blocked_draft.content)
        self.assertNotIn("workbench_artifact_draft_publish", called)
        for name in PROTOTYPE_ONLY_TOOL_NAMES:
            with self.subTest(scope="prd", name=name):
                blocked = await prd_middleware.awrap_tool_call(FakeToolRequest(name), handler)
                self.assertEqual(blocked.content, "Error: WORKBENCH_PROTOTYPE_TOOL_NOT_REQUESTED")
                self.assertNotIn(name, called)

        prototype_middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        self.assertIs(
            await prototype_middleware.awrap_tool_call(
                FakeToolRequest(CLARIFICATION_TOOL_NAME),
                handler,
            ),
            sentinel,
        )
        for name in (*ARTIFACT_PROGRESS_TOOL_NAMES, *PROTOTYPE_ONLY_TOOL_NAMES):
            with self.subTest(scope="prototype", name=name):
                self.assertIs(
                    await prototype_middleware.awrap_tool_call(FakeToolRequest(name), handler),
                    sentinel,
                )
                self.assertIn(name, called)

        blocked_reference = await prototype_middleware.awrap_tool_call(
            FakeToolRequest(
                READ_FILE_TOOL_NAME,
                args={"path": PRD_REFERENCE_FILES[0][0]},
            ),
            handler,
        )
        self.assertEqual(
            blocked_reference.content,
            "Error: WORKBENCH_PRD_REFERENCE_TOOL_NOT_AUTHORIZED",
        )
        self.assertNotIn(READ_FILE_TOOL_NAME, called)

    async def test_async_knowledge_tool_execution_is_fail_closed(self) -> None:
        middleware = WorkbenchToolScopeMiddleware()
        called = False

        async def handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = await middleware.awrap_tool_call(
            FakeToolRequest(KNOWLEDGE_TOOL_NAME),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(blocked.content, "Error: WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED")

    async def test_async_prd_gate_blocks_early_final_and_allows_corrected_final(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        called = False

        async def handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = await middleware.awrap_tool_call(
            FakeToolRequest("workbench_runtime_result_submit"),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(blocked.status, "error")
        self.assertIn("WORKBENCH_PRD_COLLECTING_STAGE_REQUIRED", blocked.content)

        complete = request_in_state(
            prd_messages(stage_count=4, references=True, draft=True),
            "workbench_runtime_result_submit",
            "async-final",
            {},
        )
        observed = await middleware.awrap_tool_call(complete, handler)
        self.assertTrue(called)
        self.assertIsNotNone(observed)

    async def test_async_prd_gate_validates_ordered_reference_handler_output(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        path = PRD_REFERENCE_FILES[0][0]
        request = request_in_state(
            prd_messages(stage_count=1, references=False),
            "read_file",
            "async-reference",
            {"path": path},
        )

        async def valid_handler(_request):
            return middleware_module.ToolMessage(
                content=REFERENCE_CONTENT[path],
                tool_call_id="async-reference",
                name="read_file",
                status="success",
            )

        observed = await middleware.awrap_tool_call(request, valid_handler)
        self.assertEqual(observed.status, "success")
        self.assertEqual(observed.content, REFERENCE_CONTENT[path])

        mismatch_request = request_in_state(
            prd_messages(stage_count=1, references=False),
            "read_file",
            "async-reference-mismatch",
            {"path": path},
        )

        async def mismatch_handler(_request):
            return middleware_module.ToolMessage(
                content="wrong file",
                tool_call_id="async-reference-mismatch",
                name="read_file",
                status="success",
            )

        mismatch = await middleware.awrap_tool_call(mismatch_request, mismatch_handler)
        self.assertEqual(mismatch.status, "error")
        self.assertIn("WORKBENCH_PRD_REFERENCE_CONTENT_MISMATCH", mismatch.content)


if __name__ == "__main__":
    unittest.main()
