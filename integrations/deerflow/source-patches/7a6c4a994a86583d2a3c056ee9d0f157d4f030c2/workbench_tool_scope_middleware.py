"""Per-run Product Workbench Canvas tool visibility and execution policy.

The eight Canvas tools stay registered in ToolNode so DeerFlow can route a
declared call. The model-visible schemas and execution path are independently
reduced to ``configurable.workbench_canvas_tools.declaredTools`` for every run.
Missing or malformed policy is an empty declaration, never ambient access.
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
_CANVAS_TOOL_NAME_SET = frozenset(CANVAS_TOOL_NAMES)
_POLICY_KEY = "workbench_canvas_tools"
_POLICY_KEYS = frozenset({"declaredTools"})
_BLOCK_CODE = "WORKBENCH_CANVAS_TOOL_NOT_DECLARED"


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
    """Apply the request-scoped Canvas declaration to model and ToolNode calls."""

    def __init__(self, policy: Any = None):
        super().__init__()
        normalized = normalize_workbench_canvas_policy(policy)
        self._declared = frozenset(normalized["declaredTools"] if normalized is not None else ())

    def _filter_tools(self, request: ModelRequest) -> ModelRequest:
        visible = [
            tool
            for tool in request.tools
            if _tool_name(tool) not in _CANVAS_TOOL_NAME_SET
            or _tool_name(tool) in self._declared
        ]
        return request if len(visible) == len(request.tools) else request.override(tools=visible)

    def _blocked_tool_message(self, request: ToolCallRequest) -> ToolMessage | None:
        name = request.tool_call.get("name")
        if not isinstance(name, str) or name not in _CANVAS_TOOL_NAME_SET:
            return None
        if name in self._declared:
            return None
        tool_call_id = request.tool_call.get("id")
        return ToolMessage(
            content=f"Error: {_BLOCK_CODE}",
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
