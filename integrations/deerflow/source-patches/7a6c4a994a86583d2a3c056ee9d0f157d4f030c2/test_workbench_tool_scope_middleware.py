from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import sys
import types
import unittest


PATCH_ROOT = Path(__file__).resolve().parent


def install_import_stubs() -> None:
    try:
        import langchain.agents.middleware.types  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    class AgentMiddleware:
        @classmethod
        def __class_getitem__(cls, _item):
            return cls

    class AgentState(dict):
        pass

    class ToolMessage:
        def __init__(self, **values):
            self.__dict__.update(values)

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
    model_types.ModelResponse = object
    modules["langchain_core.messages"].ToolMessage = ToolMessage
    modules["langgraph.prebuilt.tool_node"].ToolCallRequest = object
    modules["langgraph.types"].Command = Command
    sys.modules.update(modules)


install_import_stubs()
spec = importlib.util.spec_from_file_location(
    "workbench_tool_scope_middleware_under_test",
    PATCH_ROOT / "workbench_tool_scope_middleware.py",
)
if spec is None or spec.loader is None:
    raise RuntimeError("WORKBENCH_TOOL_SCOPE_TEST_IMPORT_FAILED")
middleware_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(middleware_module)

CANVAS_TOOL_NAMES = middleware_module.CANVAS_TOOL_NAMES
KNOWLEDGE_TOOL_NAME = middleware_module.KNOWLEDGE_TOOL_NAME
ARTIFACT_PROGRESS_TOOL_NAMES = middleware_module.ARTIFACT_PROGRESS_TOOL_NAMES
PROTOTYPE_ONLY_TOOL_NAMES = middleware_module.PROTOTYPE_ONLY_TOOL_NAMES
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


class FakeTool:
    def __init__(self, name: str):
        self.name = name


class FakeModelRequest:
    def __init__(self, tools):
        self.tools = list(tools)

    def override(self, *, tools):
        return FakeModelRequest(tools)


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
        PATCH_ROOT.parents[1] / "skills" / "workbench",
        Path("/app/skills/public/workbench"),
    )
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise RuntimeError("WORKBENCH_PRD_REFERENCE_SKILL_ROOT_MISSING")


SKILL_ROOT = _skill_root()
REFERENCE_CONTENT = {
    virtual_path: (
        SKILL_ROOT / virtual_path.removeprefix("/mnt/skills/public/workbench/")
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
        calls.append(call("read_file", call_id, {"description": "Read PRD reference", "path": path}))
        status = (status_by_index or {}).get(index, "success")
        responses.append(tool_message(
            "read_file",
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
            ["workbench_runtime_result_submit", *ARTIFACT_PROGRESS_TOOL_NAMES],
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
                *ARTIFACT_PROGRESS_TOOL_NAMES,
                *PROTOTYPE_ONLY_TOOL_NAMES,
            ],
        )

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

    def test_prd_gate_allows_three_ordered_reference_reads_in_one_batch(self) -> None:
        middleware = WorkbenchToolScopeMiddleware(None, ["prd"])
        messages = prd_messages(stage_count=1, references=False)
        reference_calls = [
            call("read_file", f"parallel-reference-{index}", {
                "description": "Read complete PRD reference",
                "path": path,
            })
            for index, (path, _digest) in enumerate(PRD_REFERENCE_FILES)
        ]
        messages.append({"type": "ai", "content": "", "tool_calls": reference_calls})
        state = {"messages": messages}
        called: list[str] = []
        for index, (path, _digest) in enumerate(PRD_REFERENCE_FILES):
            call_id = f"parallel-reference-{index}"
            request = FakeToolRequest(
                "read_file",
                call_id,
                {"description": "Read complete PRD reference", "path": path},
                state,
            )

            def handler(_request, *, current_id=call_id, current_path=path):
                called.append(current_id)
                return middleware_module.ToolMessage(
                    content=REFERENCE_CONTENT[current_path],
                    tool_call_id=current_id,
                    name="read_file",
                    status="success",
                )

            observed = middleware.wrap_tool_call(request, handler)
            self.assertEqual(observed.status, "success")
            self.assertEqual(observed.content, REFERENCE_CONTENT[path])
        self.assertEqual(called, [f"parallel-reference-{index}" for index in range(3)])

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
        alias_path = structure_path.replace("/structure.md", "/./structure.md")
        alias_request = request_in_state(
            prd_messages(stage_count=1, references=False),
            "read_file",
            "alias-reference",
            {"path": alias_path},
        )
        alias = middleware.wrap_tool_call(alias_request, lambda _request: object())
        self.assertIn("WORKBENCH_PRD_REFERENCE_PATH_INVALID", alias.content)
        self.assertIn(structure_path, alias.content)

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

    def test_prd_gate_does_not_affect_prototype_non_prd_or_mixed_runs(self) -> None:
        sentinel = object()
        path = PRD_REFERENCE_FILES[0][0]
        for requested_kinds in (["prototype"], ["document"], ["prd", "prototype"]):
            with self.subTest(requested_kinds=requested_kinds):
                middleware = WorkbenchToolScopeMiddleware(None, requested_kinds)
                request = FakeToolRequest("read_file", args={"path": path})
                self.assertIs(
                    middleware.wrap_tool_call(request, lambda _request: sentinel),
                    sentinel,
                )


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
            *map(FakeTool, ARTIFACT_PROGRESS_TOOL_NAMES),
            *map(FakeTool, PROTOTYPE_ONLY_TOOL_NAMES),
        ]

        async def handler(request):
            return request

        prd_result = await WorkbenchToolScopeMiddleware(None, ["prd"]).awrap_model_call(
            FakeModelRequest(tools),
            handler,
        )
        self.assertEqual(
            [tool.name for tool in prd_result.tools],
            ["workbench_runtime_result_submit", *ARTIFACT_PROGRESS_TOOL_NAMES],
        )

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
            ],
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
        for name in (*ARTIFACT_PROGRESS_TOOL_NAMES, *PROTOTYPE_ONLY_TOOL_NAMES):
            with self.subTest(scope="prototype", name=name):
                self.assertIs(
                    await prototype_middleware.awrap_tool_call(FakeToolRequest(name), handler),
                    sentinel,
                )
                self.assertIn(name, called)

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
