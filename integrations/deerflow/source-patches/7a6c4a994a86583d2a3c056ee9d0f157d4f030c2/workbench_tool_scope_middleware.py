"""Per-run Product Workbench tool visibility and execution policy.

Scoped tools stay registered in ToolNode so DeerFlow can route a declared call.
The model-visible schemas and execution path are independently reduced for every
run. Canvas tools use their tokenless configurable declaration. Prototype-only
publication tools and Knowledge visibility are enabled only by trusted fields in
``context.workbench``. Missing or malformed policy never grants ambient access.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

try:
    from typing import override
except ImportError:  # pragma: no cover - DeerFlow's pinned Python is 3.12.
    def override(function):
        return function

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command


CANVAS_TOOL_NAMES = (
    "get_visible_screens",
    "get_selected_screens",
    "view_screen",
    "select_screen",
    "quick_edit",
    "duplicate_screen",
    "rename_screen",
    "navigate_canvas",
)
ARTIFACT_PROGRESS_TOOL_NAMES = (
    "workbench_generation_stage_update",
    "workbench_artifact_draft_publish",
)
PROTOTYPE_ONLY_TOOL_NAMES = (
    "workbench_prototype_patch_publish",
)
KNOWLEDGE_TOOL_NAME = "workbench_knowledge_retrieve"
RUNTIME_ARTIFACT_KINDS = (
    "prd",
    "prototype",
    "image",
    "code",
    "document",
    "data",
)
_CANVAS_TOOL_NAME_SET = frozenset(CANVAS_TOOL_NAMES)
_ARTIFACT_PROGRESS_TOOL_NAME_SET = frozenset(ARTIFACT_PROGRESS_TOOL_NAMES)
_PROTOTYPE_ONLY_TOOL_NAME_SET = frozenset(PROTOTYPE_ONLY_TOOL_NAMES)
_RUNTIME_ARTIFACT_KIND_SET = frozenset(RUNTIME_ARTIFACT_KINDS)
_POLICY_KEY = "workbench_canvas_tools"
_POLICY_KEYS = frozenset({"declaredTools"})
_CANVAS_BLOCK_CODE = "WORKBENCH_CANVAS_TOOL_NOT_DECLARED"
_ARTIFACT_PROGRESS_BLOCK_CODE = "WORKBENCH_ARTIFACT_PROGRESS_NOT_REQUESTED"
_PROTOTYPE_BLOCK_CODE = "WORKBENCH_PROTOTYPE_TOOL_NOT_REQUESTED"
_KNOWLEDGE_BLOCK_CODE = "WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED"


def normalize_workbench_canvas_policy(value: Any) -> dict[str, list[str]] | None:
    """Return an isolated canonical policy, or ``None`` for fail-closed input."""
    if not isinstance(value, dict) or frozenset(value.keys()) != _POLICY_KEYS:
        return None
    declared = value.get("declaredTools")
    if (
        not isinstance(declared, list)
        or len(declared) > len(CANVAS_TOOL_NAMES)
        or any(not isinstance(name, str) for name in declared)
        or len(set(declared)) != len(declared)
        or declared != [name for name in CANVAS_TOOL_NAMES if name in declared]
    ):
        return None
    return {"declaredTools": list(declared)}


def workbench_canvas_policy_from_runnable_config(config: Any) -> Any:
    """Read only the tokenless policy from RunnableConfig.configurable."""
    if not isinstance(config, Mapping):
        return None
    configurable = config.get("configurable")
    if not isinstance(configurable, Mapping):
        return None
    return configurable.get(_POLICY_KEY)


def normalize_workbench_requested_artifact_kinds(value: Any) -> list[str] | None:
    """Return canonical requested kinds, or ``None`` for fail-closed input."""
    if (
        not isinstance(value, list)
        or len(value) > len(RUNTIME_ARTIFACT_KINDS)
        or any(not isinstance(kind, str) or kind not in _RUNTIME_ARTIFACT_KIND_SET for kind in value)
        or len(set(value)) != len(value)
    ):
        return None
    return list(value)


def workbench_requested_artifact_kinds_from_runnable_config(config: Any) -> Any:
    """Read requested kinds only from the Gateway-authenticated runtime context."""
    if not isinstance(config, Mapping):
        return None
    context = config.get("context")
    if not isinstance(context, Mapping):
        return None
    scope = context.get("workbench")
    if not isinstance(scope, Mapping):
        return None
    return scope.get("requestedArtifactKinds")


def workbench_knowledge_enabled_from_runnable_config(config: Any) -> Any:
    """Read the Knowledge visibility grant only from trusted runtime context."""
    if not isinstance(config, Mapping):
        return None
    context = config.get("context")
    if not isinstance(context, Mapping):
        return None
    scope = context.get("workbench")
    if not isinstance(scope, Mapping):
        return None
    return scope.get("knowledgeEnabled")


def _tool_name(tool: Any) -> str | None:
    name = getattr(tool, "name", None)
    if isinstance(name, str):
        return name
    if not isinstance(tool, Mapping):
        return None
    direct_name = tool.get("name")
    if isinstance(direct_name, str):
        return direct_name
    function = tool.get("function")
    if isinstance(function, Mapping):
        function_name = function.get("name")
        if isinstance(function_name, str):
            return function_name
    return None


class WorkbenchToolScopeMiddleware(AgentMiddleware[AgentState]):
    """Apply request-scoped Workbench declarations to model and ToolNode calls."""

    def __init__(
        self,
        canvas_policy: Any = None,
        requested_artifact_kinds: Any = None,
        knowledge_enabled: Any = None,
    ):
        super().__init__()
        normalized_canvas = normalize_workbench_canvas_policy(canvas_policy)
        normalized_kinds = normalize_workbench_requested_artifact_kinds(requested_artifact_kinds)
        self._declared_canvas = frozenset(
            normalized_canvas["declaredTools"] if normalized_canvas is not None else ()
        )
        self._artifact_progress_enabled = normalized_kinds is not None and any(
            kind in {"prd", "prototype"} for kind in normalized_kinds
        )
        self._prototype_enabled = normalized_kinds is not None and "prototype" in normalized_kinds
        self._knowledge_enabled = knowledge_enabled is True

    def _filter_tools(self, request: ModelRequest) -> ModelRequest:
        visible = []
        for tool in request.tools:
            name = _tool_name(tool)
            if name in _CANVAS_TOOL_NAME_SET and name not in self._declared_canvas:
                continue
            if name in _ARTIFACT_PROGRESS_TOOL_NAME_SET and not self._artifact_progress_enabled:
                continue
            if name in _PROTOTYPE_ONLY_TOOL_NAME_SET and not self._prototype_enabled:
                continue
            if name == KNOWLEDGE_TOOL_NAME and not self._knowledge_enabled:
                continue
            visible.append(tool)
        return request if len(visible) == len(request.tools) else request.override(tools=visible)

    def _blocked_tool_message(self, request: ToolCallRequest) -> ToolMessage | None:
        name = request.tool_call.get("name")
        if not isinstance(name, str):
            return None
        if name in _CANVAS_TOOL_NAME_SET and name not in self._declared_canvas:
            block_code = _CANVAS_BLOCK_CODE
        elif name in _ARTIFACT_PROGRESS_TOOL_NAME_SET and not self._artifact_progress_enabled:
            block_code = _ARTIFACT_PROGRESS_BLOCK_CODE
        elif name in _PROTOTYPE_ONLY_TOOL_NAME_SET and not self._prototype_enabled:
            block_code = _PROTOTYPE_BLOCK_CODE
        elif name == KNOWLEDGE_TOOL_NAME and not self._knowledge_enabled:
            block_code = _KNOWLEDGE_BLOCK_CODE
        else:
            return None
        tool_call_id = request.tool_call.get("id")
        return ToolMessage(
            content=f"Error: {block_code}",
            tool_call_id=(tool_call_id if isinstance(tool_call_id, str) and tool_call_id else "missing_tool_call_id"),
            name=name,
            status="error",
        )

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        return handler(self._filter_tools(request))

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        blocked = self._blocked_tool_message(request)
        return blocked if blocked is not None else handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        return await handler(self._filter_tools(request))

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        blocked = self._blocked_tool_message(request)
        return blocked if blocked is not None else await handler(request)
