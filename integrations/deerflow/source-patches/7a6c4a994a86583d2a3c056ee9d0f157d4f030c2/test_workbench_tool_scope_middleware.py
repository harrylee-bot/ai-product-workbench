from __future__ import annotations

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
PROTOTYPE_TOOL_NAMES = middleware_module.PROTOTYPE_TOOL_NAMES
WorkbenchToolScopeMiddleware = middleware_module.WorkbenchToolScopeMiddleware
normalize_workbench_canvas_policy = middleware_module.normalize_workbench_canvas_policy
normalize_workbench_requested_artifact_kinds = (
    middleware_module.normalize_workbench_requested_artifact_kinds
)
workbench_canvas_policy_from_runnable_config = middleware_module.workbench_canvas_policy_from_runnable_config
workbench_requested_artifact_kinds_from_runnable_config = (
    middleware_module.workbench_requested_artifact_kinds_from_runnable_config
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
    def __init__(self, name: str, call_id: str = "call-1"):
        self.tool_call = {"name": name, "id": call_id}


def policy(*declared: str) -> dict:
    return {"declaredTools": list(declared)}


class WorkbenchToolScopeMiddlewareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.all_tools = [
            FakeTool("workbench_runtime_result_submit"),
            *map(FakeTool, PROTOTYPE_TOOL_NAMES),
            *map(FakeTool, CANVAS_TOOL_NAMES),
        ]

    def visible_names(self, descriptor, requested_artifact_kinds=None) -> list[str]:
        middleware = WorkbenchToolScopeMiddleware(descriptor, requested_artifact_kinds)
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

    def test_prototype_tools_are_visible_only_when_prototype_is_requested(self) -> None:
        self.assertEqual(
            self.visible_names(None, ["document"]),
            ["workbench_runtime_result_submit"],
        )
        self.assertEqual(
            self.visible_names(None, ["prototype"]),
            ["workbench_runtime_result_submit", *PROTOTYPE_TOOL_NAMES],
        )
        self.assertEqual(
            self.visible_names(None, ["prd", "prototype"]),
            ["workbench_runtime_result_submit", *PROTOTYPE_TOOL_NAMES],
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
            ["workbench_runtime_result_submit", *PROTOTYPE_TOOL_NAMES],
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

    def test_non_prototype_execution_is_rejected_without_calling_handler(self) -> None:
        called = False

        def handler(_request):
            nonlocal called
            called = True
            return object()

        for name in PROTOTYPE_TOOL_NAMES:
            with self.subTest(name=name):
                result = WorkbenchToolScopeMiddleware(None, ["document"]).wrap_tool_call(
                    FakeToolRequest(name),
                    handler,
                )
                self.assertFalse(called)
                self.assertEqual(result.status, "error")
                self.assertEqual(result.name, name)
                self.assertEqual(result.content, "Error: WORKBENCH_PROTOTYPE_TOOL_NOT_REQUESTED")

    def test_prototype_execution_is_allowed_when_prototype_is_requested(self) -> None:
        sentinel = object()
        middleware = WorkbenchToolScopeMiddleware(None, ["prototype"])
        for name in PROTOTYPE_TOOL_NAMES:
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

    async def test_async_prototype_tool_execution_is_fail_closed(self) -> None:
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
        self.assertEqual(blocked.content, "Error: WORKBENCH_PROTOTYPE_TOOL_NOT_REQUESTED")


if __name__ == "__main__":
    unittest.main()
