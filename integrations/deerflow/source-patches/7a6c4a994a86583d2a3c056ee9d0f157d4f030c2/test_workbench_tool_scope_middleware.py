from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch


PATCH_ROOT = Path(__file__).resolve().parent


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

    class AgentState(dict):
        pass

    class AIMessage:
        def __init__(self, content="", *, response_metadata=None, **values):
            self.content = content
            self.response_metadata = dict(response_metadata or {})
            self.__dict__.update(values)

        def model_copy(self, *, update):
            values = dict(self.__dict__)
            values.update(update)
            content = values.pop("content", "")
            response_metadata = values.pop("response_metadata", {})
            return AIMessage(
                content=content,
                response_metadata=response_metadata,
                **values,
            )

    class SystemMessage:
        def __init__(self, *, content):
            self.content = content
            self.text = content

    class ToolMessage:
        def __init__(self, **values):
            self.__dict__.update(values)

        def model_copy(self, *, update):
            values = dict(self.__dict__)
            values.update(update)
            return ToolMessage(**values)

    class Command:
        pass

    class ModelResponse:
        @classmethod
        def __class_getitem__(cls, _item):
            return cls

        def __init__(self, result, structured_response=None):
            self.result = list(result)
            self.structured_response = structured_response

    class ExtendedModelResponse:
        def __init__(self, model_response, command=None):
            self.model_response = model_response
            self.command = command

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
    model_types.ExtendedModelResponse = ExtendedModelResponse
    model_types.ModelCallResult = object
    model_types.ModelRequest = object
    model_types.ModelResponse = ModelResponse
    modules["langchain_core.messages"].AIMessage = AIMessage
    modules["langchain_core.messages"].SystemMessage = SystemMessage
    modules["langchain_core.messages"].ToolMessage = ToolMessage
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
spec.loader.exec_module(middleware_module)

CANVAS_TOOL_NAMES = middleware_module.CANVAS_TOOL_NAMES
CLARIFICATION_TOOL_NAME = middleware_module.CLARIFICATION_TOOL_NAME
KNOWLEDGE_TOOL_NAME = middleware_module.KNOWLEDGE_TOOL_NAME
READ_FILE_TOOL_NAME = middleware_module.READ_FILE_TOOL_NAME
ARTIFACT_DRAFT_TOOL_NAME = middleware_module.ARTIFACT_DRAFT_TOOL_NAME
ARTIFACT_PROGRESS_TOOL_NAMES = middleware_module.ARTIFACT_PROGRESS_TOOL_NAMES
PROTOTYPE_ONLY_TOOL_NAMES = middleware_module.PROTOTYPE_ONLY_TOOL_NAMES
RUNTIME_RESULT_TOOL_NAME = middleware_module.RUNTIME_RESULT_TOOL_NAME
SUBAGENT_TOOL_NAME = middleware_module.SUBAGENT_TOOL_NAME
PRD_REFERENCE_FILES = middleware_module.PRD_REFERENCE_FILES
PROTOTYPE_REFERENCE_FILES = middleware_module.PROTOTYPE_REFERENCE_FILES
PRD_STAGE_SEQUENCE = middleware_module.PRD_STAGE_SEQUENCE
PROTOTYPE_STAGE_SEQUENCE = middleware_module.PROTOTYPE_STAGE_SEQUENCE
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
AIMessage = middleware_module.AIMessage
ExtendedModelResponse = middleware_module.ExtendedModelResponse
ModelResponse = middleware_module.ModelResponse

if not USING_IMPORT_STUBS:
    from deerflow.agents.middlewares.deferred_tool_filter_middleware import (
        DeferredToolFilterMiddleware,
    )
    from deerflow.runtime.serialization import serialize_channel_values_for_api
    from langchain.tools import tool
    from langchain_core.messages import HumanMessage
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode, tools_condition


CATALOG_METADATA_KEY = "workbench_tool_catalog_observation"
CATALOG_PROTOCOL = "workbench.runtime.tool-catalog-observation.v1"


class FakeTool:
    def __init__(self, name: str):
        self.name = name


class FakeModelRequest:
    def __init__(
        self,
        tools,
        system_message=None,
        state=None,
        *,
        messages=None,
        model=None,
    ):
        self.tools = list(tools)
        self.system_message = system_message
        self.state = dict(state or {})
        self.messages = list(messages or [])
        self.model = model or SimpleNamespace(model_name="gpt-5.5")

    def override(self, **overrides):
        return FakeModelRequest(
            overrides.get("tools", self.tools),
            overrides.get("system_message", self.system_message),
            overrides.get("state", self.state),
            messages=overrides.get("messages", self.messages),
            model=overrides.get("model", self.model),
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


def automatic_result_call_id(
    prefix: str,
    candidate: dict,
    *,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
) -> str:
    call_identity = {
        "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id,
        "candidate": candidate,
    }
    digest = hashlib.sha256(json.dumps(
        call_identity,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}{digest}"


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


def successful_stage_message(
    stage: str,
    call_id: str,
    *,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
):
    return middleware_module.ToolMessage(
        content="ok",
        tool_call_id=call_id,
        name="workbench_generation_stage_update",
        status="success",
        artifact={
            "protocol": "workbench.runtime.generation-stage.v1",
            "runId": run_id,
            "runtimeAttemptId": runtime_attempt_id,
            "toolCallId": call_id,
            "stage": stage,
        },
    )


def append_tool_batch(messages: list[dict], calls: list[dict], responses: list[dict]) -> None:
    messages.append({"type": "ai", "content": "", "tool_calls": calls})
    messages.extend(responses)


def append_stage(
    messages: list[dict],
    stage: str,
    call_id: str,
    *,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
) -> None:
    append_tool_batch(
        messages,
        [call("workbench_generation_stage_update", call_id, {"stage": stage})],
        [tool_message(
            "workbench_generation_stage_update",
            call_id,
            artifact={
                "protocol": "workbench.runtime.generation-stage.v1",
                "runId": run_id,
                "runtimeAttemptId": runtime_attempt_id,
                "toolCallId": call_id,
                "stage": stage,
            },
        )],
    )


def append_references(
    messages: list[dict],
    *,
    status_by_index: dict[int, str] | None = None,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
) -> None:
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
            artifact={
                "protocol": "workbench.runtime.prd-reference-read.v1",
                "runId": run_id,
                "runtimeAttemptId": runtime_attempt_id,
                "toolCallId": call_id,
                "path": path,
                "sha256": PRD_REFERENCE_FILES[index][1],
            } if status == "success" else None,
        ))
    append_tool_batch(messages, calls, responses)


def prd_messages(
    *,
    stage_count: int,
    references: bool,
    draft: bool = False,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
) -> list[dict]:
    messages: list[dict] = [{"type": "human", "content": "current PRD turn"}]
    if stage_count > 0:
        append_stage(
            messages,
            PRD_STAGE_SEQUENCE[0],
            "stage-0",
            run_id=run_id,
            runtime_attempt_id=runtime_attempt_id,
        )
    if references:
        append_references(
            messages,
            run_id=run_id,
            runtime_attempt_id=runtime_attempt_id,
        )
    for index, stage in enumerate(PRD_STAGE_SEQUENCE[1:stage_count], start=1):
        append_stage(
            messages,
            stage,
            f"stage-{index}",
            run_id=run_id,
            runtime_attempt_id=runtime_attempt_id,
        )
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
                    "runId": run_id,
                    "runtimeAttemptId": runtime_attempt_id,
                    "toolCallId": "draft-success",
                    "artifactIndex": 0,
                    "ok": True,
                    "draft": {"kind": "prd"},
                },
            )],
        )
    return messages


def prototype_messages(
    *,
    draft: bool = False,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
    artifact_index: int = 0,
    operation_kind: str = "create",
    stages: bool = True,
) -> list[dict]:
    messages: list[dict] = [{"type": "human", "content": "current Prototype turn"}]
    if stages:
        for index, stage in enumerate(PROTOTYPE_STAGE_SEQUENCE):
            append_stage(
                messages,
                stage,
                f"prototype-stage-{index}",
                run_id=run_id,
                runtime_attempt_id=runtime_attempt_id,
            )
    if draft:
        prototype_draft = {
            "kind": "prototype",
            "schemaVersion": 1,
            "title": "Product Workbench",
            "operation": {"kind": operation_kind},
            "citations": [],
            "content": {"protocol": "workbench.prototype.v1"},
        }
        append_tool_batch(
            messages,
            [call("workbench_artifact_draft_publish", "prototype-draft-success", {
                "artifact_index": artifact_index,
                "draft": prototype_draft,
            })],
            [tool_message(
                "workbench_artifact_draft_publish",
                "prototype-draft-success",
                artifact={
                    "protocol": "workbench.runtime.artifact-draft.v1",
                    "runId": run_id,
                    "runtimeAttemptId": runtime_attempt_id,
                    "toolCallId": "prototype-draft-success",
                    "artifactIndex": artifact_index,
                    "ok": True,
                    "draft": prototype_draft,
                },
            )],
        )
    return messages


def successful_prototype_patch_message(
    call_id: str,
    *,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
    artifact_index: int = 0,
) -> dict:
    return tool_message(
        PROTOTYPE_ONLY_TOOL_NAMES[0],
        call_id,
        artifact={
            "protocol": "workbench.runtime.prototype-patch-publication.v1",
            "runId": run_id,
            "runtimeAttemptId": runtime_attempt_id,
            "toolCallId": call_id,
            "ok": True,
            "patch": {
                "protocol": "workbench.runtime.prototype-patch.v1",
                "artifactIndex": artifact_index,
            },
        },
    )


def submitted_result_messages(
    message: str = "Published",
    *,
    run_id: str = "run-1",
    runtime_attempt_id: str = "attempt-1",
) -> list[dict]:
    call_id = "final-result"
    return [
        {"type": "human", "content": "current Workbench turn"},
        {"type": "ai", "content": "", "tool_calls": [
            call("workbench_runtime_result_submit", call_id, {}),
        ]},
        tool_message(
            "workbench_runtime_result_submit",
            call_id,
            artifact={
                "protocol": "workbench.runtime.validated-result.v1",
                "runId": run_id,
                "runtimeAttemptId": runtime_attempt_id,
                "toolCallId": call_id,
                "ok": True,
                "result": {"message": message},
            },
        ),
    ]


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

    def test_gemini_provider_receives_schema_tool_results_as_plain_text(self) -> None:
        schema = '{"$defs":{"PrdInlineContent":{"type":"string"}},"value":{"$ref":"#/$defs/PrdInlineContent"}}'
        messages = [
            {"type": "human", "content": "Read the schema"},
            {
                "type": "tool",
                "name": READ_FILE_TOOL_NAME,
                "tool_call_id": "schema-read",
                "content": schema,
            },
            {
                "type": "tool",
                "name": "safe_tool",
                "tool_call_id": "safe-json",
                "content": '{"ok":true}',
            },
        ]
        state = {"messages": messages}
        observed = WorkbenchToolScopeMiddleware(None, ["prd"]).wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                state=state,
                messages=messages,
                model=SimpleNamespace(model_name="gemini-3-flash"),
            ),
            lambda scoped: scoped,
        )

        self.assertEqual(
            observed.messages[1]["content"],
            f"{middleware_module._GEMINI_SCHEMA_TOOL_MESSAGE_PREFIX}{schema}",
        )
        self.assertEqual(observed.messages[2]["content"], '{"ok":true}')
        self.assertEqual(messages[1]["content"], schema)
        self.assertEqual(observed.state["messages"][1]["content"], schema)

    def test_non_gemini_provider_keeps_schema_tool_results_byte_exact(self) -> None:
        schema = '{"$defs":{"PrdInlineContent":{"type":"string"}}}'
        messages = [{
            "type": "tool",
            "name": READ_FILE_TOOL_NAME,
            "tool_call_id": "schema-read",
            "content": schema,
        }]
        observed = WorkbenchToolScopeMiddleware(None, ["prd"]).wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                messages=messages,
                model=SimpleNamespace(model_name="gpt-5.5"),
            ),
            lambda scoped: scoped,
        )
        self.assertEqual(observed.messages[0]["content"], schema)

    def test_gemini_provider_copies_tool_message_objects_before_prefixing(self) -> None:
        schema = '{"$defs":{"RuntimeArtifactDraftPrdV2":{"type":"object"}},"artifact":{"$ref":"#/$defs/RuntimeArtifactDraftPrdV2"}}'
        message = middleware_module.ToolMessage(
            name=READ_FILE_TOOL_NAME,
            tool_call_id="schema-object-read",
            content=schema,
        )
        observed = WorkbenchToolScopeMiddleware(None, ["prd"]).wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                messages=[message],
                model=SimpleNamespace(model_name="gemini-3-flash"),
            ),
            lambda scoped: scoped,
        )

        self.assertIsNot(observed.messages[0], message)
        self.assertEqual(message.content, schema)
        self.assertEqual(
            observed.messages[0].content,
            f"{middleware_module._GEMINI_SCHEMA_TOOL_MESSAGE_PREFIX}{schema}",
        )

    def test_gemini_provider_prefixes_schema_tool_results_with_array_root(self) -> None:
        schema = '[{"$ref":"#/$defs/PrdListItem"},{"$defs":{"PrdListItem":{"type":"object"}}}]'
        messages = [{
            "type": "tool",
            "name": "tool_search",
            "tool_call_id": "schema-array-read",
            "content": schema,
        }]
        observed = WorkbenchToolScopeMiddleware(None, ["prd"]).wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                messages=messages,
                model=SimpleNamespace(model_name="gemini-3-flash"),
            ),
            lambda scoped: scoped,
        )

        self.assertEqual(
            observed.messages[0]["content"],
            f"{middleware_module._GEMINI_SCHEMA_TOOL_MESSAGE_PREFIX}{schema}",
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

    def test_run_scope_is_read_only_from_trusted_runtime_context(self) -> None:
        expected = ("run-1", "attempt-1")
        self.assertEqual(
            workbench_run_scope_from_runnable_config(
                {"context": {"workbench": {
                    "runId": expected[0],
                    "runtimeAttemptId": expected[1],
                }}}
            ),
            expected,
        )
        for config in (
            {"configurable": {"workbench": {
                "runId": expected[0],
                "runtimeAttemptId": expected[1],
            }}},
            {"context": {"workbench": {"runId": expected[0]}}},
            {"context": {"workbench": {
                "runId": " run-1",
                "runtimeAttemptId": expected[1],
            }}},
            {"context": {"workbench": {
                "runId": expected[0],
                "runtimeAttemptId": "",
            }}},
        ):
            with self.subTest(config=config):
                self.assertIsNone(workbench_run_scope_from_runnable_config(config))

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
        self.assertIs(
            workbench_knowledge_enabled_from_runnable_config(
                {"context": {"workbench": {"runId": "run-1"}}}
            ),
            False,
        )

    def test_knowledge_tool_is_visible_only_for_the_exact_true_grant(self) -> None:
        for disabled in (None, False, 1, "true", {}, []):
            with self.subTest(disabled=disabled):
                self.assertNotIn(KNOWLEDGE_TOOL_NAME, self.visible_names(None, None, disabled))
        self.assertIn(KNOWLEDGE_TOOL_NAME, self.visible_names(None, None, True))

    def test_model_result_catalog_observation_is_hashed_and_tracks_knowledge_visibility(self) -> None:
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                middleware = WorkbenchToolScopeMiddleware(None, None, enabled)
                original = AIMessage(
                    content="done",
                    response_metadata={"provider_request_id": "provider-1"},
                )
                scoped_requests = []
                observed = middleware.wrap_model_call(
                    FakeModelRequest(self.all_tools),
                    lambda scoped: (
                        scoped_requests.append(scoped)
                        or ModelResponse(result=[original], structured_response={"ok": True})
                    ),
                )
                self.assertIsInstance(observed, ModelResponse)
                self.assertEqual(observed.structured_response, {"ok": True})
                self.assertEqual(len(scoped_requests), 1)
                self.assertIsNone(scoped_requests[0].system_message)
                self.assertIsNot(observed.result[0], original)
                self.assertNotIn(CATALOG_METADATA_KEY, original.response_metadata)
                self.assertEqual(
                    observed.result[0].response_metadata["provider_request_id"],
                    "provider-1",
                )
                payload = observed.result[0].response_metadata[CATALOG_METADATA_KEY]
                self.assertEqual(
                    set(payload),
                    {"protocol", "knowledgeVisible", "toolNames", "sha256"},
                )
                self.assertEqual(payload["protocol"], CATALOG_PROTOCOL)
                self.assertEqual(payload["knowledgeVisible"], enabled)
                self.assertEqual(KNOWLEDGE_TOOL_NAME in payload["toolNames"], enabled)
                self.assertEqual(len(payload["toolNames"]), len(set(payload["toolNames"])))
                digest_payload = {
                    "knowledgeVisible": payload["knowledgeVisible"],
                    "protocol": payload["protocol"],
                    "toolNames": payload["toolNames"],
                }
                canonical = json.dumps(digest_payload, sort_keys=True, separators=(",", ":"))
                self.assertEqual(payload["sha256"], hashlib.sha256(canonical.encode("utf-8")).hexdigest())

    def test_catalog_observation_overwrites_untrusted_metadata_and_supports_all_result_shapes(self) -> None:
        forged = {
            "protocol": CATALOG_PROTOCOL,
            "knowledgeVisible": False,
            "toolNames": [],
            "sha256": "0" * 64,
            "extra": "forged",
        }
        middleware = WorkbenchToolScopeMiddleware(None, None, True)
        original = AIMessage(
            content="done",
            response_metadata={CATALOG_METADATA_KEY: forged},
        )

        direct = middleware.wrap_model_call(
            FakeModelRequest([FakeTool(KNOWLEDGE_TOOL_NAME)]),
            lambda _scoped: original,
        )
        extended = middleware.wrap_model_call(
            FakeModelRequest([FakeTool(KNOWLEDGE_TOOL_NAME)]),
            lambda _scoped: ExtendedModelResponse(
                model_response=ModelResponse(result=[original]),
                command="keep-command",
            ),
        )

        for stamped in (direct, extended.model_response.result[0]):
            with self.subTest(result_type=type(stamped).__name__):
                observation = stamped.response_metadata[CATALOG_METADATA_KEY]
                self.assertEqual(set(observation), {
                    "protocol", "knowledgeVisible", "toolNames", "sha256",
                })
                self.assertTrue(observation["knowledgeVisible"])
                self.assertEqual(observation["toolNames"], [KNOWLEDGE_TOOL_NAME])
                self.assertNotEqual(observation["sha256"], forged["sha256"])
        self.assertEqual(extended.command, "keep-command")
        self.assertIs(original.response_metadata[CATALOG_METADATA_KEY], forged)

    def test_model_bound_catalog_observation_rejects_noncanonical_or_unknown_tools(self) -> None:
        invalid_catalogs = (
            [FakeTool("safe_tool"), FakeTool("safe_tool")],
            [FakeTool("workbench_unknown_tool")],
            [FakeTool("Read_File")],
            [FakeTool("read-file")],
        )
        middleware = WorkbenchToolScopeMiddleware(None, None, False)
        for tools in invalid_catalogs:
            with self.subTest(names=[tool.name for tool in tools]):
                with self.assertRaisesRegex(ValueError, "WORKBENCH_TOOL_CATALOG_INVALID"):
                    middleware.wrap_model_call(
                        FakeModelRequest(tools),
                        lambda _scoped: AIMessage(content="done"),
                    )

    def test_successful_runtime_result_short_circuits_followup_model_call(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-1"),
        )
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        response = middleware.wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                state={"messages": submitted_result_messages("Done")},
            ),
            handler,
        )
        self.assertFalse(called)
        self.assertIsInstance(response, AIMessage)
        self.assertEqual(response.content, "Done")

    def test_runtime_result_with_a_mismatched_tool_call_id_does_not_short_circuit(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = submitted_result_messages("Wrong call binding")
        messages[-1]["artifact"]["toolCallId"] = "different-call"
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        response = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            handler,
        )

        self.assertTrue(called)
        self.assertEqual(response.content, "model continued")

    def test_successful_prd_draft_short_circuits_to_exact_runtime_result_call(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-1"),
        )
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        messages = prd_messages(stage_count=4, references=True, draft=True)
        response = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            handler,
        )

        self.assertFalse(called)
        self.assertIsInstance(response, AIMessage)
        self.assertEqual(response.content, "")
        self.assertEqual(len(response.tool_calls), 1)
        result_call = response.tool_calls[0]
        self.assertEqual(result_call["name"], RUNTIME_RESULT_TOOL_NAME)
        self.assertTrue(result_call["id"].startswith("workbench_auto_prd_result_"))
        candidate = result_call["args"]["candidate"]
        self.assertEqual(candidate["protocol"], "workbench.runtime.result.v1")
        self.assertEqual(candidate["message"], "\u9700\u6c42\u8bf4\u660e\u4e66\u5df2\u751f\u6210\u3002")
        self.assertEqual(
            candidate["artifacts"][0],
            messages[-1]["artifact"]["draft"],
        )

        messages.append(response)
        request = FakeToolRequest(
            RUNTIME_RESULT_TOOL_NAME,
            result_call["id"],
            result_call["args"],
            {"messages": messages},
        )
        sentinel = object()
        self.assertIs(
            middleware.wrap_tool_call(request, lambda _request: sentinel),
            sentinel,
        )

    def test_automatic_prd_result_fails_closed_for_an_unbound_draft(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = prd_messages(
            stage_count=4,
            references=True,
            draft=True,
            run_id="other-run",
        )
        response = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            lambda _request: AIMessage(content="model continued"),
        )

        self.assertEqual(response.content, "model continued")
        self.assertFalse(getattr(response, "tool_calls", []))

    def test_automatic_prd_result_fails_closed_for_old_attempt_stage_and_reference_history(
        self,
    ) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-2"),
        )
        messages = prd_messages(
            stage_count=4,
            references=True,
            draft=True,
            runtime_attempt_id="attempt-1",
        )
        current_draft_call = "draft-current-attempt"
        current_draft = {"kind": "prd"}
        append_tool_batch(
            messages,
            [call(ARTIFACT_DRAFT_TOOL_NAME, current_draft_call, {
                "artifact_index": 0,
                "draft": current_draft,
            })],
            [tool_message(
                ARTIFACT_DRAFT_TOOL_NAME,
                current_draft_call,
                artifact={
                    "protocol": "workbench.runtime.artifact-draft.v1",
                    "runId": "run-1",
                    "runtimeAttemptId": "attempt-2",
                    "toolCallId": current_draft_call,
                    "artifactIndex": 0,
                    "ok": True,
                    "draft": current_draft,
                },
            )],
        )

        response = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            lambda _request: AIMessage(content="model continued"),
        )

        self.assertEqual(response.content, "model continued")
        self.assertFalse(getattr(response, "tool_calls", []))

    def test_failed_automatic_prd_result_uses_manual_repair_without_repeating(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = prd_messages(stage_count=4, references=True, draft=True)
        automatic = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            lambda _request: self.fail("the first convergence call must be automatic"),
        )
        result_call = automatic.tool_calls[0]
        messages.extend([
            automatic,
            tool_message(
                RUNTIME_RESULT_TOOL_NAME,
                result_call["id"],
                '{"ok":false}',
                artifact={
                    "protocol": "workbench.runtime.validated-result.v1",
                    "runId": "run-1",
                    "runtimeAttemptId": "attempt-1",
                    "toolCallId": result_call["id"],
                    "ok": False,
                    "issues": [{"path": ["artifacts", 0]}],
                },
            ),
        ])
        manual_call = call(
            RUNTIME_RESULT_TOOL_NAME,
            "manual-prd-result-repair",
            result_call["args"],
        )

        response = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            lambda _request: AIMessage(content="", tool_calls=[manual_call]),
        )
        self.assertEqual(len(response.tool_calls), 1)
        self.assertEqual(response.tool_calls[0]["id"], manual_call["id"])
        self.assertEqual(response.tool_calls[0]["name"], manual_call["name"])
        self.assertEqual(response.tool_calls[0]["args"], manual_call["args"])

        messages.append(response)
        sentinel = object()
        request = FakeToolRequest(
            RUNTIME_RESULT_TOOL_NAME,
            manual_call["id"],
            manual_call["args"],
            {"messages": messages},
        )
        self.assertIs(
            middleware.wrap_tool_call(request, lambda _request: sentinel),
            sentinel,
        )

    def test_automatic_prd_result_call_id_is_bound_to_run_and_attempt(self) -> None:
        call_ids = []
        for run_id, runtime_attempt_id in (
            ("run-1", "attempt-1"),
            ("run-2", "attempt-1"),
            ("run-1", "attempt-2"),
        ):
            middleware = WorkbenchToolScopeMiddleware(
                None,
                ["prd"],
                None,
                (run_id, runtime_attempt_id),
            )
            response = middleware.wrap_model_call(
                FakeModelRequest(
                    self.all_tools,
                    state={
                        "messages": prd_messages(
                            stage_count=4,
                            references=True,
                            draft=True,
                            run_id=run_id,
                            runtime_attempt_id=runtime_attempt_id,
                        ),
                    },
                ),
                lambda _request: self.fail("the bound Draft must converge automatically"),
            )
            call_ids.append(response.tool_calls[0]["id"])
        self.assertEqual(len(set(call_ids)), 3)

    def test_successful_prototype_draft_short_circuits_to_exact_runtime_result_call(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        messages = prototype_messages(draft=True)
        response = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            handler,
        )

        self.assertFalse(called)
        self.assertIsInstance(response, AIMessage)
        self.assertEqual(response.content, "")
        self.assertEqual(len(response.tool_calls), 1)
        result_call = response.tool_calls[0]
        self.assertEqual(result_call["name"], RUNTIME_RESULT_TOOL_NAME)
        self.assertTrue(result_call["id"].startswith("workbench_auto_prototype_result_"))
        candidate = result_call["args"]["candidate"]
        self.assertEqual(candidate["protocol"], "workbench.runtime.result.v1")
        self.assertEqual(
            candidate["message"],
            "\u539f\u578b\u5df2\u751f\u6210\u5e76\u53ef\u9884\u89c8\u3002",
        )
        self.assertEqual(
            candidate["artifacts"][0],
            messages[-1]["artifact"]["draft"],
        )

        messages.append(response)
        request = FakeToolRequest(
            RUNTIME_RESULT_TOOL_NAME,
            result_call["id"],
            result_call["args"],
            {"messages": messages},
        )
        sentinel = object()
        self.assertIs(
            middleware.wrap_tool_call(request, lambda _request: sentinel),
            sentinel,
        )

    def test_prototype_publication_requires_one_draft_and_blocks_duplicates(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        premature = middleware.wrap_tool_call(
            request_in_state(
                prototype_messages(draft=False),
                RUNTIME_RESULT_TOOL_NAME,
                "premature-result",
                {},
            ),
            handler,
        )
        self.assertFalse(called)
        self.assertIn("WORKBENCH_PROTOTYPE_DRAFT_REQUIRED", premature.content)

        duplicate = request_in_state(
            prototype_messages(draft=True),
            "workbench_artifact_draft_publish",
            "duplicate-prototype-draft",
            {"artifact_index": 0, "draft": {"kind": "prototype"}},
        )
        blocked = middleware.wrap_tool_call(duplicate, handler)
        self.assertFalse(called)
        self.assertIn("WORKBENCH_PROTOTYPE_DRAFT_ALREADY_PUBLISHED", blocked.content)

        before_stages = middleware.wrap_tool_call(
            request_in_state(
                prototype_messages(draft=False, stages=False),
                "workbench_artifact_draft_publish",
                "draft-before-stages",
                {"artifact_index": 0, "draft": {"kind": "prototype"}},
            ),
            handler,
        )
        self.assertFalse(called)
        self.assertIn("WORKBENCH_PROTOTYPE_STAGE_REQUIRED", before_stages.content)
        self.assertIn("stage='design-system'", before_stages.content)

    def test_prototype_revise_checkpoint_allows_followup_patch_and_result(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = prototype_messages(draft=True, operation_kind="revise")
        sentinel = object()

        first_patch = request_in_state(
            messages,
            PROTOTYPE_ONLY_TOOL_NAMES[0],
            "revise-patch-before-checkpoint",
            {},
        )
        self.assertIs(
            middleware.wrap_tool_call(first_patch, lambda _request: sentinel),
            sentinel,
        )
        messages.append(successful_prototype_patch_message(
            "revise-patch-before-checkpoint",
        ))

        checkpoint_call_id = "revise-checkpoint-after-patch"
        second_draft = request_in_state(
            messages,
            "workbench_artifact_draft_publish",
            checkpoint_call_id,
            {"artifact_index": 0, "draft": {"kind": "prototype"}},
        )
        self.assertIs(
            middleware.wrap_tool_call(second_draft, lambda _request: sentinel),
            sentinel,
        )
        checkpoint_draft = {
            "kind": "prototype",
            "schemaVersion": 1,
            "title": "Product Workbench revised",
            "operation": {"kind": "revise"},
            "citations": [],
            "content": {"protocol": "workbench.prototype.v1"},
        }
        messages.append(tool_message(
            "workbench_artifact_draft_publish",
            checkpoint_call_id,
            artifact={
                "protocol": "workbench.runtime.artifact-draft.v1",
                "runId": "run-1",
                "runtimeAttemptId": "attempt-1",
                "toolCallId": checkpoint_call_id,
                "artifactIndex": 0,
                "ok": True,
                "draft": checkpoint_draft,
            },
        ))

        followup_patch = request_in_state(
            messages,
            PROTOTYPE_ONLY_TOOL_NAMES[0],
            "revise-patch-after-checkpoint",
            {},
        )
        self.assertIs(
            middleware.wrap_tool_call(followup_patch, lambda _request: sentinel),
            sentinel,
        )
        final_result = request_in_state(
            messages,
            RUNTIME_RESULT_TOOL_NAME,
            "revise-final-result",
            {},
        )
        self.assertIs(
            middleware.wrap_tool_call(final_result, lambda _request: sentinel),
            sentinel,
        )

    def test_prototype_revise_requires_checkpoint_after_patch(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = prototype_messages(draft=True, operation_kind="revise")
        patch_call_id = "revise-patch-needs-checkpoint"
        request_in_state(
            messages,
            PROTOTYPE_ONLY_TOOL_NAMES[0],
            patch_call_id,
            {},
        )
        messages.append(successful_prototype_patch_message(patch_call_id))

        second_patch = middleware.wrap_tool_call(
            request_in_state(
                messages,
                PROTOTYPE_ONLY_TOOL_NAMES[0],
                "revise-second-patch-before-checkpoint",
                {},
            ),
            lambda _request: self.fail("a checkpoint must precede another patch"),
        )
        self.assertIn("WORKBENCH_PROTOTYPE_PATCH_CHECKPOINT_REQUIRED", second_patch.content)

        final_result = middleware.wrap_tool_call(
            request_in_state(
                messages,
                RUNTIME_RESULT_TOOL_NAME,
                "revise-result-before-checkpoint",
                {},
            ),
            lambda _request: self.fail("a checkpoint must precede the final Result"),
        )
        self.assertIn("WORKBENCH_PROTOTYPE_PATCH_CHECKPOINT_REQUIRED", final_result.content)

    def test_prototype_revise_rejects_patch_and_result_in_one_batch(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = prototype_messages(draft=True, operation_kind="revise")
        patch_call_id = "revise-patch-and-result-patch"
        result_call_id = "revise-patch-and-result-result"
        batch = [
            call(PROTOTYPE_ONLY_TOOL_NAMES[0], patch_call_id, {}),
            call(RUNTIME_RESULT_TOOL_NAME, result_call_id, {}),
        ]

        patch = middleware.wrap_tool_call(
            request_in_state(
                messages,
                PROTOTYPE_ONLY_TOOL_NAMES[0],
                patch_call_id,
                {},
                sibling_calls=batch,
            ),
            lambda _request: self.fail("mixed publication batch must not run Patch"),
        )
        self.assertIn("WORKBENCH_PROTOTYPE_PUBLICATION_BATCH_INVALID", patch.content)

        result = middleware.wrap_tool_call(
            FakeToolRequest(
                RUNTIME_RESULT_TOOL_NAME,
                result_call_id,
                {},
                {"messages": messages},
            ),
            lambda _request: self.fail("mixed publication batch must not run Result"),
        )
        self.assertIn("WORKBENCH_PROTOTYPE_PUBLICATION_BATCH_INVALID", result.content)

    def test_multiple_successful_create_drafts_remain_invalid(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = prototype_messages(draft=True)
        duplicate_call_id = "duplicate-successful-create-draft"
        request_in_state(
            messages,
            "workbench_artifact_draft_publish",
            duplicate_call_id,
            {"artifact_index": 0, "draft": {"kind": "prototype"}},
        )
        duplicate_draft = {
            "kind": "prototype",
            "schemaVersion": 1,
            "title": "Duplicate create",
            "operation": {"kind": "create"},
            "citations": [],
            "content": {"protocol": "workbench.prototype.v1"},
        }
        messages.append(tool_message(
            "workbench_artifact_draft_publish",
            duplicate_call_id,
            artifact={
                "protocol": "workbench.runtime.artifact-draft.v1",
                "runId": "run-1",
                "runtimeAttemptId": "attempt-1",
                "toolCallId": duplicate_call_id,
                "artifactIndex": 0,
                "ok": True,
                "draft": duplicate_draft,
            },
        ))
        blocked = middleware.wrap_tool_call(
            request_in_state(
                messages,
                RUNTIME_RESULT_TOOL_NAME,
                "result-after-duplicate-create-draft",
                {},
            ),
            lambda _request: self.fail("multiple successful create Drafts are invalid"),
        )
        self.assertIn("WORKBENCH_PROTOTYPE_PUBLICATION_HISTORY_INVALID", blocked.content)

    def test_non_prototype_run_does_not_auto_submit_prototype_draft(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["code"])
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="code path")

        response = middleware.wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                state={"messages": prototype_messages(draft=True)},
            ),
            handler,
        )
        self.assertTrue(called)
        self.assertEqual(response.content, "code path")

    def test_prototype_auto_submit_fails_closed_for_unbound_retry_or_non_create_draft(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        for kwargs in (
            {"run_id": "old-run"},
            {"runtime_attempt_id": "old-attempt"},
            {"artifact_index": 1},
            {"operation_kind": "revise"},
            {"stages": False},
        ):
            with self.subTest(kwargs=kwargs):
                called = False

                def handler(_request):
                    nonlocal called
                    called = True
                    return AIMessage(content="model continued")

                response = middleware.wrap_model_call(
                    FakeModelRequest(
                        self.all_tools,
                        state={"messages": prototype_messages(draft=True, **kwargs)},
                    ),
                    handler,
                )
                self.assertTrue(called)
                self.assertEqual(response.content, "model continued")

    def test_failed_automatic_prototype_result_uses_manual_repair_without_repeating(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        messages = prototype_messages(draft=True)
        automatic = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            lambda _request: self.fail("the first convergence call must be automatic"),
        )
        result_call = automatic.tool_calls[0]
        messages.extend([
            automatic,
            tool_message(
                RUNTIME_RESULT_TOOL_NAME,
                result_call["id"],
                '{"ok":false}',
                artifact={
                    "protocol": "workbench.runtime.validated-result.v1",
                    "runId": "run-1",
                    "runtimeAttemptId": "attempt-1",
                    "toolCallId": result_call["id"],
                    "ok": False,
                    "issues": [{"path": ["artifacts", 0]}],
                },
            ),
        ])
        called = False
        manual_call = call(
            RUNTIME_RESULT_TOOL_NAME,
            "manual-prototype-result-repair",
            result_call["args"],
        )

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="", tool_calls=[manual_call])

        response = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            handler,
        )
        self.assertTrue(called)
        self.assertEqual(len(response.tool_calls), 1)
        normalized_manual_call = response.tool_calls[0]
        self.assertEqual(normalized_manual_call["id"], manual_call["id"])
        self.assertEqual(normalized_manual_call["name"], RUNTIME_RESULT_TOOL_NAME)
        self.assertEqual(normalized_manual_call["args"], manual_call["args"])

        messages.append(response)
        sentinel = object()
        manual_request = FakeToolRequest(
            RUNTIME_RESULT_TOOL_NAME,
            manual_call["id"],
            manual_call["args"],
            {"messages": messages},
        )
        self.assertIs(
            middleware.wrap_tool_call(manual_request, lambda _request: sentinel),
            sentinel,
        )

        patch_messages = list(messages)
        patch_request = request_in_state(
            patch_messages,
            PROTOTYPE_ONLY_TOOL_NAMES[0],
            "patch-after-terminal-draft",
            {},
        )
        blocked_patch = middleware.wrap_tool_call(
            patch_request,
            lambda _request: self.fail("a terminal create Draft must remain immutable"),
        )
        self.assertIn("WORKBENCH_PROTOTYPE_TERMINAL_DRAFT_IMMUTABLE", blocked_patch.content)

        messages.append(tool_message(
            RUNTIME_RESULT_TOOL_NAME,
            manual_call["id"],
            artifact={
                "protocol": "workbench.runtime.validated-result.v1",
                "runId": "run-1",
                "runtimeAttemptId": "attempt-1",
                "toolCallId": manual_call["id"],
                "ok": True,
                "result": manual_call["args"]["candidate"],
            },
        ))
        completed = middleware.wrap_model_call(
            FakeModelRequest(self.all_tools, state={"messages": messages}),
            lambda _request: self.fail("the successful manual Result must stop the graph"),
        )
        self.assertEqual(completed.content, "\u539f\u578b\u5df2\u751f\u6210\u5e76\u53ef\u9884\u89c8\u3002")

    def test_automatic_prototype_result_call_id_is_bound_to_run_and_attempt(self) -> None:
        call_ids = []
        for run_id, runtime_attempt_id in (
            ("run-1", "attempt-1"),
            ("run-2", "attempt-1"),
            ("run-1", "attempt-2"),
        ):
            middleware = WorkbenchToolScopeMiddleware(
                None,
                ["prototype"],
                None,
                (run_id, runtime_attempt_id),
            )
            response = middleware.wrap_model_call(
                FakeModelRequest(
                    self.all_tools,
                    state={
                        "messages": prototype_messages(
                            draft=True,
                            run_id=run_id,
                            runtime_attempt_id=runtime_attempt_id,
                        ),
                    },
                ),
                lambda _request: self.fail("the bound draft must converge automatically"),
            )
            call_ids.append(response.tool_calls[0]["id"])
        self.assertEqual(len(set(call_ids)), 3)

    def test_previous_run_runtime_result_does_not_short_circuit_new_run(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-2", "attempt-2"),
        )
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        response = middleware.wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                state={
                    "messages": submitted_result_messages(
                        "Previous run",
                        run_id="run-1",
                        runtime_attempt_id="attempt-1",
                    ),
                },
            ),
            handler,
        )
        self.assertTrue(called)
        self.assertEqual(response.content, "model continued")

    def test_runtime_result_without_scope_does_not_short_circuit(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        response = middleware.wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                state={"messages": submitted_result_messages("No scope")},
            ),
            handler,
        )
        self.assertTrue(called)
        self.assertEqual(response.content, "model continued")

    @unittest.skipIf(USING_IMPORT_STUBS, "requires pinned LangChain/LangGraph dependencies")
    def test_catalog_observation_survives_message_reducer_and_checkpoint(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, None, True)
        provider_message = AIMessage(
            content="persisted",
            response_metadata={"model_name": "fixture-model"},
        )

        def model_node(_state):
            response = middleware.wrap_model_call(
                FakeModelRequest([
                    FakeTool("safe_tool"),
                    FakeTool(KNOWLEDGE_TOOL_NAME),
                ]),
                lambda _scoped: ModelResponse(result=[provider_message]),
            )
            return {"messages": response.result}

        builder = StateGraph(MessagesState)
        builder.add_node("model", model_node)
        builder.add_edge(START, "model")
        builder.add_edge("model", END)
        checkpointer = InMemorySaver()
        graph = builder.compile(checkpointer=checkpointer)
        config = {"configurable": {"thread_id": "catalog-checkpoint-test"}}

        graph.invoke({"messages": [HumanMessage(content="start")]}, config)
        checkpoint = checkpointer.get_tuple(config)
        self.assertIsNotNone(checkpoint)
        persisted = checkpoint.checkpoint["channel_values"]["messages"][-1]
        self.assertIsInstance(persisted, AIMessage)
        self.assertEqual(persisted.response_metadata["model_name"], "fixture-model")
        observation = persisted.response_metadata[CATALOG_METADATA_KEY]
        self.assertEqual(set(observation), {
            "protocol", "knowledgeVisible", "toolNames", "sha256",
        })
        self.assertEqual(observation["protocol"], CATALOG_PROTOCOL)
        self.assertTrue(observation["knowledgeVisible"])
        self.assertEqual(
            observation["toolNames"],
            ["safe_tool", KNOWLEDGE_TOOL_NAME],
        )
        serialized = serialize_channel_values_for_api({"messages": [persisted]})
        self.assertEqual(
            serialized["messages"][0]["response_metadata"][CATALOG_METADATA_KEY],
            observation,
        )

    @unittest.skipIf(USING_IMPORT_STUBS, "requires pinned LangChain/LangGraph dependencies")
    def test_automatic_prd_result_routes_through_real_tool_node_and_stops(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-1"),
        )
        tool_invocations: list[dict] = []

        @tool(RUNTIME_RESULT_TOOL_NAME, response_format="content_and_artifact")
        def submit_result(candidate: dict) -> tuple[str, dict]:
            """Validate the complete Workbench Runtime result candidate."""
            tool_invocations.append(candidate)
            return "{\"ok\":true}", {
                "protocol": "workbench.runtime.validated-result.v1",
                "runId": "run-1",
                "runtimeAttemptId": "attempt-1",
                "toolCallId": automatic_result_call_id(
                    "workbench_auto_prd_result_",
                    candidate,
                ),
                "ok": True,
                "result": candidate,
            }

        def model_node(state):
            result = middleware.wrap_model_call(
                FakeModelRequest([submit_result], state=state),
                lambda _request: self.fail("the provider must not run after a validated PRD draft"),
            )
            return {"messages": [result]}

        builder = StateGraph(MessagesState)
        builder.add_node("model", model_node)
        builder.add_node("tools", ToolNode([submit_result]))
        builder.add_edge(START, "model")
        builder.add_conditional_edges("model", tools_condition)
        builder.add_edge("tools", "model")
        graph = builder.compile()
        result = graph.invoke({
            "messages": prd_messages(stage_count=4, references=True, draft=True),
        })

        self.assertEqual(len(tool_invocations), 1)
        self.assertEqual(tool_invocations[0]["protocol"], "workbench.runtime.result.v1")
        self.assertEqual(tool_invocations[0]["artifacts"][0]["kind"], "prd")
        self.assertEqual(result["messages"][-1].content, "\u9700\u6c42\u8bf4\u660e\u4e66\u5df2\u751f\u6210\u3002")
        self.assertFalse(result["messages"][-1].tool_calls)

    @unittest.skipIf(USING_IMPORT_STUBS, "requires pinned LangChain/LangGraph dependencies")
    def test_automatic_prototype_result_routes_through_real_tool_node_and_stops(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        tool_invocations: list[dict] = []

        @tool(RUNTIME_RESULT_TOOL_NAME, response_format="content_and_artifact")
        def submit_result(candidate: dict) -> tuple[str, dict]:
            """Validate the complete Workbench Runtime result candidate."""
            tool_invocations.append(candidate)
            return "{\"ok\":true}", {
                "protocol": "workbench.runtime.validated-result.v1",
                "runId": "run-1",
                "runtimeAttemptId": "attempt-1",
                "toolCallId": automatic_result_call_id(
                    "workbench_auto_prototype_result_",
                    candidate,
                ),
                "ok": True,
                "result": candidate,
            }

        def model_node(state):
            result = middleware.wrap_model_call(
                FakeModelRequest([submit_result], state=state),
                lambda _request: self.fail("the provider must not run after a validated draft"),
            )
            return {"messages": [result]}

        builder = StateGraph(MessagesState)
        builder.add_node("model", model_node)
        builder.add_node("tools", ToolNode([submit_result]))
        builder.add_edge(START, "model")
        builder.add_conditional_edges("model", tools_condition)
        builder.add_edge("tools", "model")
        graph = builder.compile()
        result = graph.invoke({"messages": prototype_messages(draft=True)})

        self.assertEqual(len(tool_invocations), 1)
        self.assertEqual(tool_invocations[0]["protocol"], "workbench.runtime.result.v1")
        self.assertEqual(tool_invocations[0]["artifacts"][0]["kind"], "prototype")
        self.assertEqual(result["messages"][-1].content, "\u539f\u578b\u5df2\u751f\u6210\u5e76\u53ef\u9884\u89c8\u3002")
        self.assertFalse(result["messages"][-1].tool_calls)

    @unittest.skipIf(USING_IMPORT_STUBS, "requires pinned DeerFlow dependencies")
    def test_workbench_registration_after_deferred_filter_observes_effective_catalog(self) -> None:
        deferred = DeferredToolFilterMiddleware(frozenset({"promoted_tool"}), "catalog-1")
        workbench = WorkbenchToolScopeMiddleware(None, None, True)
        tools = [
            FakeTool("safe_tool"),
            FakeTool("promoted_tool"),
            FakeTool(KNOWLEDGE_TOOL_NAME),
        ]

        def invoke(state):
            return deferred.wrap_model_call(
                FakeModelRequest(tools, state=state),
                lambda deferred_request: workbench.wrap_model_call(
                    deferred_request,
                    lambda _scoped: ModelResponse(result=[AIMessage(content="done")]),
                ),
            )

        hidden = invoke({})
        promoted = invoke({
            "promoted": {"catalog_hash": "catalog-1", "names": ["promoted_tool"]},
        })
        self.assertEqual(
            hidden.result[0].response_metadata[CATALOG_METADATA_KEY]["toolNames"],
            ["safe_tool", KNOWLEDGE_TOOL_NAME],
        )
        self.assertEqual(
            promoted.result[0].response_metadata[CATALOG_METADATA_KEY]["toolNames"],
            ["safe_tool", "promoted_tool", KNOWLEDGE_TOOL_NAME],
        )

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
                READ_FILE_TOOL_NAME,
                *ARTIFACT_PROGRESS_TOOL_NAMES,
                *PROTOTYPE_ONLY_TOOL_NAMES,
            ],
        )
        self.assertEqual(
            self.visible_names(None, ["prd", "prototype"]),
            [
                "workbench_runtime_result_submit",
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
        self.assertIn("publish exactly one complete PRD Draft at artifact_index 0", observed.system_message.text)
        self.assertIn("do not call a Draft or Result tool", observed.system_message.text)
        self.assertIn("trusted Runtime submits the exact normalized Draft", observed.system_message.text)
        self.assertIn("the Runtime does not repeat automatic submission", observed.system_message.text)
        self.assertTrue(observed.system_message.text.startswith(base_system_text))
        self.assertEqual(observed.system_message.text.count(base_system_text), 1)
        repeated = prd.wrap_model_call(observed, lambda scoped: scoped)
        self.assertEqual(
            repeated.system_message.text.count("<workbench_prd_clarification_policy>"),
            1,
        )
        for non_exact_prd_scope in (["prd", "document"], ["prd", "prd"]):
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

    def test_prototype_stage_policy_is_injected_once_for_exact_scope(self) -> None:
        base_system_text = "Base DeerFlow policy."
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        observed = middleware.wrap_model_call(
            FakeModelRequest(
                self.all_tools,
                middleware_module.SystemMessage(content=base_system_text),
            ),
            lambda scoped: scoped,
        )
        self.assertTrue(observed.system_message.text.startswith(base_system_text))
        self.assertIn("<workbench_prototype_stage_policy>", observed.system_message.text)
        self.assertIn(
            "design-system, mapping-components, creating-flows, generating-ui",
            observed.system_message.text,
        )
        self.assertIn("publish exactly one complete terminal Draft", observed.system_message.text)
        self.assertIn("do not call a patch, Draft, or Result tool", observed.system_message.text)
        self.assertIn(
            "If that automatic Result reports validation issues",
            observed.system_message.text,
        )
        self.assertIn("the Runtime does not repeat automatic submission", observed.system_message.text)
        repeated = middleware.wrap_model_call(observed, lambda scoped: scoped)
        self.assertEqual(
            repeated.system_message.text.count("<workbench_prototype_stage_policy>"),
            1,
        )

        mixed = WorkbenchToolScopeMiddleware(None, ["prototype", "document"]).wrap_model_call(
            FakeModelRequest(self.all_tools),
            lambda scoped: scoped,
        )
        self.assertIsNone(mixed.system_message)

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
                READ_FILE_TOOL_NAME,
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

    def test_prototype_model_binding_hides_subagent_tool(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        observed = middleware.wrap_model_call(
            FakeModelRequest([*self.all_tools, FakeTool(SUBAGENT_TOOL_NAME)]),
            lambda scoped: scoped,
        )
        self.assertNotIn(SUBAGENT_TOOL_NAME, [tool.name for tool in observed.tools])

    def test_prototype_subagent_execution_is_rejected(self) -> None:
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        result = WorkbenchToolScopeMiddleware(None, ["prototype"]).wrap_tool_call(
            FakeToolRequest(SUBAGENT_TOOL_NAME),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(result.status, "error")
        self.assertEqual(
            result.content,
            "Error: WORKBENCH_PROTOTYPE_SUBAGENT_NOT_AVAILABLE",
        )

    def test_code_run_keeps_subagent_tool_available(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["code"])
        observed = middleware.wrap_model_call(
            FakeModelRequest([FakeTool(SUBAGENT_TOOL_NAME)]),
            lambda scoped: scoped,
        )
        self.assertEqual([tool.name for tool in observed.tools], [SUBAGENT_TOOL_NAME])

        sentinel = object()
        self.assertIs(
            middleware.wrap_tool_call(
                FakeToolRequest(SUBAGENT_TOOL_NAME),
                lambda _request: sentinel,
            ),
            sentinel,
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
                args = {"stage": "design-system"} if name == "workbench_generation_stage_update" else None
                request = (
                    request_in_state(
                        prototype_messages(draft=False),
                        name,
                        "publish-after-prototype-stages",
                        args,
                    )
                    if name == "workbench_artifact_draft_publish"
                    else FakeToolRequest(name, args=args)
                )
                self.assertIs(
                    middleware.wrap_tool_call(
                        request,
                        lambda _request: sentinel,
                    ),
                    sentinel,
                )

    def test_prototype_stage_gate_recovers_from_first_generating_ui_skip(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        messages: list = [{"type": "human", "content": "current Prototype turn"}]
        skipped = request_in_state(
            messages,
            "workbench_generation_stage_update",
            "skip-to-generating-ui",
            {"stage": "generating-ui"},
        )
        called = False

        def skipped_handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = middleware.wrap_tool_call(skipped, skipped_handler)
        self.assertFalse(called)
        self.assertEqual(blocked.status, "error")
        self.assertIn("WORKBENCH_PROTOTYPE_STAGE_ORDER_INVALID", blocked.content)
        self.assertIn("stage='design-system'", blocked.content)
        messages.append(blocked)

        corrected = request_in_state(
            messages,
            "workbench_generation_stage_update",
            "corrected-design-system",
            {"stage": "design-system"},
        )
        sentinel = object()
        self.assertIs(
            middleware.wrap_tool_call(corrected, lambda _request: sentinel),
            sentinel,
        )

    def test_prototype_stage_gate_allows_only_the_full_ordered_sequence(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        messages: list = [{"type": "human", "content": "current Prototype turn"}]
        for index, stage in enumerate(PROTOTYPE_STAGE_SEQUENCE):
            call_id = f"prototype-stage-{index}"
            request = request_in_state(
                messages,
                "workbench_generation_stage_update",
                call_id,
                {"stage": stage},
            )
            observed = middleware.wrap_tool_call(
                request,
                lambda _request, current_stage=stage, current_id=call_id: (
                    successful_stage_message(current_stage, current_id)
                ),
            )
            self.assertEqual(observed.status, "success")
            messages.append(observed)

        for stage in ("design-system", "collecting-prd-context"):
            with self.subTest(rejected_stage=stage):
                request = request_in_state(
                    messages,
                    "workbench_generation_stage_update",
                    f"rejected-{stage}",
                    {"stage": stage},
                )
                blocked = middleware.wrap_tool_call(request, lambda _request: object())
                self.assertEqual(blocked.status, "error")
                self.assertIn("All four Prototype stages already succeeded", blocked.content)
                messages.append(blocked)

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

    def test_prototype_reference_pins_match_every_shipped_runtime_file(self) -> None:
        for virtual_path, expected_digest in PROTOTYPE_REFERENCE_FILES:
            with self.subTest(path=virtual_path):
                content = (
                    SKILL_ROOT / virtual_path.removeprefix("/mnt/skills/public/")
                ).read_text(encoding="utf-8")
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

    def test_prd_gate_blocks_prototype_stage_family_before_handler(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        request = request_in_state(
            prd_messages(stage_count=0, references=False),
            "workbench_generation_stage_update",
            "prototype-stage-in-prd",
            {"stage": "design-system"},
        )
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = middleware.wrap_tool_call(request, handler)
        self.assertFalse(called)
        self.assertEqual(blocked.status, "error")
        self.assertIn("WORKBENCH_PRD_STAGE_FAMILY_INVALID", blocked.content)

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
        partial_batch.append(recovered)

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

    def test_prd_reference_reader_is_blocked_outside_exact_prd_runs(self) -> None:
        path = PRD_REFERENCE_FILES[0][0]
        for requested_kinds in (["prototype"], ["document"], ["prd", "prototype"]):
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
                    blocked.status,
                    "error",
                )
                self.assertIn("REFERENCE", blocked.content)


class WorkbenchToolScopeMiddlewareAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_successful_prototype_draft_short_circuits_to_result_call(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prototype"],
            None,
            ("run-1", "attempt-1"),
        )
        called = False

        async def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        response = await middleware.awrap_model_call(
            FakeModelRequest(
                [FakeTool(RUNTIME_RESULT_TOOL_NAME)],
                state={"messages": prototype_messages(draft=True)},
            ),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(len(response.tool_calls), 1)
        self.assertEqual(response.tool_calls[0]["name"], RUNTIME_RESULT_TOOL_NAME)

    async def test_async_successful_runtime_result_short_circuits_followup_model_call(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-1", "attempt-1"),
        )
        called = False

        async def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        response = await middleware.awrap_model_call(
            FakeModelRequest(
                [FakeTool(RUNTIME_RESULT_TOOL_NAME)],
                state={"messages": submitted_result_messages("Done async")},
            ),
            handler,
        )
        self.assertFalse(called)
        self.assertIsInstance(response, AIMessage)
        self.assertEqual(response.content, "Done async")

    async def test_async_previous_run_runtime_result_does_not_short_circuit_new_run(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(
            None,
            ["prd"],
            None,
            ("run-2", "attempt-2"),
        )
        called = False

        async def handler(_request):
            nonlocal called
            called = True
            return AIMessage(content="model continued")

        response = await middleware.awrap_model_call(
            FakeModelRequest(
                [FakeTool(RUNTIME_RESULT_TOOL_NAME)],
                state={
                    "messages": submitted_result_messages(
                        "Previous run async",
                        run_id="run-1",
                        runtime_attempt_id="attempt-1",
                    ),
                },
            ),
            handler,
        )
        self.assertTrue(called)
        self.assertEqual(response.content, "model continued")

    async def test_async_model_result_is_stamped_after_scope_filtering(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, None, False)
        original = AIMessage(
            content="done",
            response_metadata={"model_name": "fixture-model"},
        )
        scoped_names = []

        async def model_handler(request):
            scoped_names.extend(tool.name for tool in request.tools)
            return ModelResponse(result=[original])

        result = await middleware.awrap_model_call(
            FakeModelRequest([
                FakeTool("safe_tool"),
                FakeTool(KNOWLEDGE_TOOL_NAME),
            ]),
            model_handler,
        )

        self.assertEqual(scoped_names, ["safe_tool"])
        self.assertIsNot(result.result[0], original)
        self.assertEqual(result.result[0].response_metadata["model_name"], "fixture-model")
        observation = result.result[0].response_metadata[CATALOG_METADATA_KEY]
        self.assertEqual(set(observation), {
            "protocol", "knowledgeVisible", "toolNames", "sha256",
        })
        self.assertFalse(observation["knowledgeVisible"])
        self.assertEqual(observation["toolNames"], ["safe_tool"])

    async def test_async_authorized_knowledge_is_visible_and_executes(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, None, True)

        async def model_handler(request):
            return request

        model_result = await middleware.awrap_model_call(
            FakeModelRequest([
                FakeTool("workbench_runtime_result_submit"),
                FakeTool(KNOWLEDGE_TOOL_NAME),
            ]),
            model_handler,
        )
        self.assertEqual(
            [tool.name for tool in model_result.tools],
            ["workbench_runtime_result_submit", KNOWLEDGE_TOOL_NAME],
        )

        handler_calls = 0
        sentinel = object()

        async def tool_handler(_request):
            nonlocal handler_calls
            handler_calls += 1
            return sentinel

        observed = await middleware.awrap_tool_call(
            FakeToolRequest(KNOWLEDGE_TOOL_NAME),
            tool_handler,
        )
        self.assertIs(observed, sentinel)
        self.assertEqual(handler_calls, 1)

    async def test_concurrent_opposite_knowledge_scopes_do_not_leak(self) -> None:
        both_model_calls_started = asyncio.Event()
        release_model_calls = asyncio.Event()
        started_count = 0
        authorized_tool_calls = 0
        unauthorized_tool_calls = 0
        sentinel = object()

        async def exercise_scope(enabled: bool):
            nonlocal started_count, authorized_tool_calls, unauthorized_tool_calls
            middleware = WorkbenchToolScopeMiddleware(None, None, enabled)

            async def model_handler(request):
                nonlocal started_count
                started_count += 1
                if started_count == 2:
                    both_model_calls_started.set()
                await release_model_calls.wait()
                return request

            model_result = await middleware.awrap_model_call(
                FakeModelRequest([FakeTool(KNOWLEDGE_TOOL_NAME)]),
                model_handler,
            )

            async def tool_handler(_request):
                nonlocal authorized_tool_calls, unauthorized_tool_calls
                if enabled:
                    authorized_tool_calls += 1
                else:
                    unauthorized_tool_calls += 1
                return sentinel

            tool_result = await middleware.awrap_tool_call(
                FakeToolRequest(KNOWLEDGE_TOOL_NAME),
                tool_handler,
            )
            return [tool.name for tool in model_result.tools], tool_result

        authorized = asyncio.create_task(exercise_scope(True))
        unauthorized = asyncio.create_task(exercise_scope(False))
        await asyncio.wait_for(both_model_calls_started.wait(), timeout=1)
        release_model_calls.set()
        authorized_result, unauthorized_result = await asyncio.gather(
            authorized,
            unauthorized,
        )

        self.assertEqual(authorized_result[0], [KNOWLEDGE_TOOL_NAME])
        self.assertIs(authorized_result[1], sentinel)
        self.assertEqual(unauthorized_result[0], [])
        self.assertEqual(
            unauthorized_result[1].content,
            "Error: WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED",
        )
        self.assertEqual(authorized_tool_calls, 1)
        self.assertEqual(unauthorized_tool_calls, 0)

    @unittest.skipIf(USING_IMPORT_STUBS, "requires the pinned DeerFlow executor stack")
    async def test_real_subagent_executor_removes_parent_run_tools(self) -> None:
        task_module = importlib.import_module("deerflow.tools.builtins.task_tool")

        safe_tool = FakeTool("safe_subagent_tool")
        parent_run_tools = [
            FakeTool(KNOWLEDGE_TOOL_NAME),
            FakeTool("workbench_artifact_draft_publish"),
            FakeTool("workbench_runtime_result_submit"),
            FakeTool("view_screen"),
        ]
        captured_executor_kwargs = None
        execute_calls: list[tuple[str, str]] = []

        class FakeExecutor:
            def __init__(self, **kwargs):
                nonlocal captured_executor_kwargs
                captured_executor_kwargs = kwargs

            def execute_async(self, prompt, *, task_id):
                execute_calls.append((prompt, task_id))
                return task_id

        terminal_result = SimpleNamespace(
            status=task_module.SubagentStatus.COMPLETED,
            ai_messages=[],
            token_usage_records=[],
            usage_reported=True,
            result="opaque-success",
            error=None,
        )
        app_config = SimpleNamespace(token_usage=SimpleNamespace(enabled=False))
        subagent_config = SimpleNamespace(
            model="inherit",
            skills=None,
            timeout_seconds=1,
        )
        runtime = SimpleNamespace(
            state={},
            context={},
            config={
                "configurable": {},
                "metadata": {
                    "model_name": "test-model",
                    "tool_groups": ["test-group"],
                },
            },
        )
        stream_events: list[dict] = []

        with (
            patch.object(task_module, "get_app_config", return_value=app_config),
            patch.object(task_module, "get_available_subagent_names", return_value=["general-purpose"]),
            patch.object(task_module, "get_subagent_config", return_value=subagent_config),
            patch.object(task_module, "resolve_runtime_user_id", return_value=None),
            patch.object(task_module, "resolve_subagent_model_name", return_value="test-model"),
            patch.object(task_module, "SubagentExecutor", FakeExecutor),
            patch.object(task_module, "get_background_task_result", return_value=terminal_result),
            patch.object(task_module, "cleanup_background_task"),
            patch.object(task_module, "get_stream_writer", return_value=stream_events.append),
            patch(
                "deerflow.tools.get_available_tools",
                return_value=[safe_tool, *parent_run_tools],
            ),
        ):
            coroutine = getattr(task_module.task_tool, "coroutine", None)
            self.assertTrue(callable(coroutine), "PINNED_SUBAGENT_TOOL_COROUTINE_MISSING")
            result = await coroutine(
                runtime=runtime,
                description="scope contract",
                prompt="opaque task",
                subagent_type="general-purpose",
                tool_call_id="scope-call",
            )

        self.assertEqual(result, "Task Succeeded. Result: opaque-success")
        self.assertEqual(execute_calls, [("opaque task", "scope-call")])
        self.assertIsNotNone(captured_executor_kwargs)
        self.assertEqual(
            [tool.name for tool in captured_executor_kwargs["tools"]],
            [safe_tool.name],
        )
        self.assertEqual(
            [event["type"] for event in stream_events],
            ["task_started", "task_completed"],
        )

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
        ).awrap_model_call(
            FakeModelRequest([*tools, FakeTool(SUBAGENT_TOOL_NAME)]),
            handler,
        )
        self.assertEqual(
            [tool.name for tool in prototype_result.tools],
            [
                "workbench_runtime_result_submit",
                READ_FILE_TOOL_NAME,
                *ARTIFACT_PROGRESS_TOOL_NAMES,
                *PROTOTYPE_ONLY_TOOL_NAMES,
                CLARIFICATION_TOOL_NAME,
            ],
        )
        self.assertIn(
            "<workbench_prototype_stage_policy>",
            prototype_result.system_message.text,
        )
        self.assertIn(
            "The generic task tool is unavailable",
            prototype_result.system_message.text,
        )
        self.assertIn(
            "publish exactly one complete terminal Draft",
            prototype_result.system_message.text,
        )

    async def test_async_prototype_subagent_execution_is_rejected(self) -> None:
        called = False

        async def handler(_request):
            nonlocal called
            called = True
            return object()

        result = await WorkbenchToolScopeMiddleware(None, ["prototype"]).awrap_tool_call(
            FakeToolRequest(SUBAGENT_TOOL_NAME),
            handler,
        )
        self.assertFalse(called)
        self.assertEqual(result.status, "error")
        self.assertEqual(
            result.content,
            "Error: WORKBENCH_PROTOTYPE_SUBAGENT_NOT_AVAILABLE",
        )

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
                args = {"stage": "design-system"} if name == "workbench_generation_stage_update" else None
                request = (
                    request_in_state(
                        prototype_messages(draft=False),
                        name,
                        "async-publish-after-prototype-stages",
                        args,
                    )
                    if name == "workbench_artifact_draft_publish"
                    else FakeToolRequest(name, args=args)
                )
                self.assertIs(
                    await prototype_middleware.awrap_tool_call(
                        request,
                        handler,
                    ),
                    sentinel,
                )
                self.assertIn(name, called)

        blocked_prd_reference = await prototype_middleware.awrap_tool_call(
            FakeToolRequest(
                READ_FILE_TOOL_NAME,
                args={"path": PRD_REFERENCE_FILES[0][0]},
            ),
            handler,
        )
        self.assertEqual(
            blocked_prd_reference.status,
            "error",
        )
        self.assertNotIn(READ_FILE_TOOL_NAME, called)

        prototype_reference = PROTOTYPE_REFERENCE_FILES[0][0]
        prototype_content = (
            SKILL_ROOT / prototype_reference.removeprefix("/mnt/skills/public/")
        ).read_text(encoding="utf-8")
        request = FakeToolRequest(
            READ_FILE_TOOL_NAME,
            args={"path": prototype_reference},
        )

        async def read_reference(_request):
            called.append(READ_FILE_TOOL_NAME)
            return middleware_module.ToolMessage(
                content=prototype_content,
                tool_call_id="call-1",
                name=READ_FILE_TOOL_NAME,
                status="success",
            )

        allowed_reference = await prototype_middleware.awrap_tool_call(
            request,
            read_reference,
        )
        self.assertEqual(allowed_reference.content, prototype_content)
        self.assertIn(READ_FILE_TOOL_NAME, called)

    async def test_async_prototype_stage_gate_recovers_and_completes_ordered_sequence(
        self,
    ) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        messages: list = [{"type": "human", "content": "current Prototype turn"}]
        skipped = request_in_state(
            messages,
            "workbench_generation_stage_update",
            "async-skip-to-generating-ui",
            {"stage": "generating-ui"},
        )
        called = False

        async def skipped_handler(_request):
            nonlocal called
            called = True
            return object()

        blocked = await middleware.awrap_tool_call(skipped, skipped_handler)
        self.assertFalse(called)
        self.assertIn("WORKBENCH_PROTOTYPE_STAGE_ORDER_INVALID", blocked.content)
        self.assertIn("stage='design-system'", blocked.content)
        messages.append(blocked)

        for index, stage in enumerate(PROTOTYPE_STAGE_SEQUENCE):
            call_id = f"async-prototype-stage-{index}"
            request = request_in_state(
                messages,
                "workbench_generation_stage_update",
                call_id,
                {"stage": stage},
            )

            async def stage_handler(
                _request,
                *,
                current_stage=stage,
                current_id=call_id,
            ):
                return successful_stage_message(current_stage, current_id)

            observed = await middleware.awrap_tool_call(request, stage_handler)
            self.assertEqual(observed.status, "success")
            messages.append(observed)

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
