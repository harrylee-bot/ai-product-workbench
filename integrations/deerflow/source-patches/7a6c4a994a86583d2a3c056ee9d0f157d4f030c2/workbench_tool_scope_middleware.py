"""Per-run Product Workbench tool visibility and execution policy.

Scoped tools stay registered in ToolNode so DeerFlow can route a declared call.
The model-visible schemas and execution path are independently reduced for every
run. Canvas tools use their tokenless configurable declaration. Prototype-only
publication tools and Knowledge visibility are enabled only by trusted fields in
``context.workbench``. Missing or malformed policy never grants ambient access.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
import hashlib
import json
import posixpath
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
READ_FILE_TOOL_NAME = "read_file"
GENERATION_STAGE_TOOL_NAME = "workbench_generation_stage_update"
ARTIFACT_DRAFT_TOOL_NAME = "workbench_artifact_draft_publish"
RUNTIME_RESULT_TOOL_NAME = "workbench_runtime_result_submit"
PRD_STAGE_SEQUENCE = (
    "collecting-prd-context",
    "structuring-prd",
    "drafting-prd",
    "validating-prd",
)
PRD_REFERENCE_FILES = (
    (
        "/mnt/skills/public/requirement-doc-template/SKILL.md",
        "f59cf65306078cdcdc7cc98486860a47f20ff80b81f0a849af381494183c78e1",
    ),
    (
        "/mnt/skills/public/requirement-doc-template/references/structure.md",
        "2b6bc148797504455de52dec18b18be0d66f13e2af6f0381a5886427d7e7c6eb",
    ),
    (
        "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
        "45e76fe4c178e8609cd1dd3c4a6c9642c280a219b0470295b3204e469a6b4168",
    ),
    (
        "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
        "bd2f09b81bf8538a33ccf9eb0942d364c23dedf071979dad991fe09812f9e747",
    ),
)
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
_PRD_REFERENCE_ROOT = "/mnt/skills/public/"
_PRD_REFERENCE_RELATIVE_PATHS = tuple(
    path.removeprefix(_PRD_REFERENCE_ROOT) for path, _digest in PRD_REFERENCE_FILES
)
_PRD_STAGE_PROTOCOL = "workbench.runtime.generation-stage.v1"
_PRD_DRAFT_PROTOCOL = "workbench.runtime.artifact-draft.v1"
_PRD_RESULT_PROTOCOL = "workbench.runtime.validated-result.v1"


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


def _value(source: Any, key: str) -> Any:
    if isinstance(source, Mapping):
        return source.get(key)
    return getattr(source, key, None)


def _message_kind(message: Any) -> str:
    kind = _value(message, "type") or _value(message, "role")
    if isinstance(kind, str):
        return kind.lower()
    return message.__class__.__name__.lower()


def _is_human_message(message: Any) -> bool:
    return _message_kind(message) in {"human", "humanmessage", "user", "usermessage"}


def _is_ai_message(message: Any) -> bool:
    return _message_kind(message) in {"ai", "aimessage", "assistant", "assistantmessage"}


def _is_tool_message(message: Any) -> bool:
    return _message_kind(message) in {"tool", "toolmessage"}


def _tool_args(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
        return dict(parsed) if isinstance(parsed, Mapping) else {}
    return {}


def _message_tool_calls(message: Any) -> list[dict[str, Any]]:
    raw_calls = _value(message, "tool_calls")
    if not isinstance(raw_calls, list):
        additional = _value(message, "additional_kwargs")
        raw_calls = _value(additional, "tool_calls")
    if not isinstance(raw_calls, list):
        return []
    calls: list[dict[str, Any]] = []
    for position, raw_call in enumerate(raw_calls):
        function = _value(raw_call, "function")
        call_id = _value(raw_call, "id")
        name = _value(raw_call, "name") or _value(function, "name")
        args = _value(raw_call, "args")
        if args is None:
            args = _value(raw_call, "arguments")
        if args is None:
            args = _value(function, "arguments")
        if isinstance(call_id, str) and call_id and isinstance(name, str) and name:
            calls.append({
                "id": call_id,
                "name": name,
                "args": _tool_args(args),
                "position": position,
            })
    return calls


def _state_messages(state: Any) -> list[Any]:
    messages = _value(state, "messages")
    return list(messages) if isinstance(messages, list) else []


def _current_turn_start(messages: list[Any]) -> int:
    for index in range(len(messages) - 1, -1, -1):
        if _is_human_message(messages[index]):
            return index
    return -1


def _completed_tool_calls(state: Any) -> tuple[list[dict[str, Any]], bool]:
    messages = _state_messages(state)
    turn_start = _current_turn_start(messages)
    if turn_start < 0:
        return [], False
    declarations: dict[str, dict[str, Any]] = {}
    completed: list[dict[str, Any]] = []
    responded: set[str] = set()
    invalid = False
    for message_index in range(turn_start + 1, len(messages)):
        message = messages[message_index]
        if _is_ai_message(message):
            for call in _message_tool_calls(message):
                existing = declarations.get(call["id"])
                if existing is not None:
                    invalid = True
                    continue
                declarations[call["id"]] = {
                    **call,
                    "message_index": message_index,
                }
            continue
        if not _is_tool_message(message):
            continue
        call_id = _value(message, "tool_call_id")
        if not isinstance(call_id, str) or call_id not in declarations or call_id in responded:
            invalid = True
            continue
        responded.add(call_id)
        completed.append({
            **declarations[call_id],
            "response": message,
            "response_index": message_index,
        })
    completed.sort(key=lambda item: (item["message_index"], item["position"]))
    return completed, invalid


def _tool_succeeded(response: Any) -> bool:
    status = _value(response, "status")
    if isinstance(status, str) and status.lower() != "success":
        return False
    content = _tool_content(response)
    return content is None or not content.lstrip().startswith("Error:")


def _tool_content(response: Any) -> str | None:
    content = _value(response, "content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
            continue
        text = _value(part, "text") or _value(part, "content")
        if not isinstance(text, str):
            return None
        parts.append(text)
    return "".join(parts)


def _full_reference_read(args: Mapping[str, Any]) -> bool:
    return args.get("start_line") is None and args.get("end_line") is None


def _reference_index(path: Any) -> int | None:
    if not isinstance(path, str):
        return None
    for index, (candidate, _digest) in enumerate(PRD_REFERENCE_FILES):
        if path == candidate:
            return index
    return None


def _reference_like_path(path: Any) -> bool:
    if not isinstance(path, str) or not path:
        return False
    normalized = posixpath.normpath(path)
    return any(
        normalized == canonical
        or normalized == relative
        or normalized.endswith(f"/{relative}")
        for (canonical, _digest), relative in zip(
            PRD_REFERENCE_FILES,
            _PRD_REFERENCE_RELATIVE_PATHS,
        )
    )


def _reference_progress(state: Any) -> tuple[frozenset[int], bool]:
    completed, invalid = _completed_tool_calls(state)
    reference_batches: dict[int, list[dict[str, Any]]] = {}
    for call in completed:
        if call["name"] != READ_FILE_TOOL_NAME:
            continue
        path = call["args"].get("path")
        reference_index = _reference_index(path)
        if reference_index is None or not _full_reference_read(call["args"]):
            continue
        reference_batches.setdefault(call["message_index"], []).append({
            **call,
            "reference_index": reference_index,
        })

    successful_indexes: set[int] = set()
    for batch in reference_batches.values():
        missing_indexes = [
            index
            for index in range(len(PRD_REFERENCE_FILES))
            if index not in successful_indexes
        ]
        successful_batch_calls: list[tuple[int, dict[str, Any]]] = []
        for position, call in enumerate(batch):
            if not _tool_succeeded(call["response"]):
                continue
            content = _tool_content(call["response"])
            reference_index = call["reference_index"]
            expected_digest = PRD_REFERENCE_FILES[reference_index][1]
            if (
                content is None
                or hashlib.sha256(content.encode("utf-8")).hexdigest() != expected_digest
            ):
                continue
            successful_batch_calls.append((position, call))
        for position, call in successful_batch_calls:
            attempted_prefix = [
                candidate["reference_index"]
                for candidate in batch[: position + 1]
            ]
            if attempted_prefix != missing_indexes[: position + 1]:
                invalid = True
            reference_index = call["reference_index"]
            if reference_index in successful_indexes:
                invalid = True
                continue
            successful_indexes.add(reference_index)
    return frozenset(successful_indexes), invalid


def _missing_reference_indexes(successful_indexes: frozenset[int]) -> list[int]:
    return [
        index
        for index in range(len(PRD_REFERENCE_FILES))
        if index not in successful_indexes
    ]


def _stage_progress(state: Any) -> tuple[int, bool]:
    completed, invalid = _completed_tool_calls(state)
    successful_stages: list[str] = []
    for call in completed:
        if call["name"] != GENERATION_STAGE_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        stage = call["args"].get("stage")
        if stage not in PRD_STAGE_SEQUENCE:
            continue
        artifact = _value(call["response"], "artifact")
        if (
            not isinstance(artifact, Mapping)
            or artifact.get("protocol") != _PRD_STAGE_PROTOCOL
            or artifact.get("stage") != stage
        ):
            continue
        successful_stages.append(stage)
    if successful_stages != list(PRD_STAGE_SEQUENCE[: len(successful_stages)]):
        invalid = True
    if len(successful_stages) > len(PRD_STAGE_SEQUENCE):
        invalid = True
    return len(successful_stages), invalid


def _successful_prd_drafts(state: Any) -> tuple[int, bool]:
    completed, invalid = _completed_tool_calls(state)
    count = 0
    for call in completed:
        if call["name"] != ARTIFACT_DRAFT_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        artifact = _value(call["response"], "artifact")
        draft = artifact.get("draft") if isinstance(artifact, Mapping) else None
        if (
            isinstance(artifact, Mapping)
            and artifact.get("protocol") == _PRD_DRAFT_PROTOCOL
            and artifact.get("ok") is True
            and isinstance(draft, Mapping)
            and draft.get("kind") == "prd"
        ):
            count += 1
    return count, invalid or count > 1


def _successful_runtime_results(state: Any) -> tuple[int, bool]:
    completed, invalid = _completed_tool_calls(state)
    count = 0
    for call in completed:
        if call["name"] != RUNTIME_RESULT_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        artifact = _value(call["response"], "artifact")
        if (
            isinstance(artifact, Mapping)
            and artifact.get("protocol") == _PRD_RESULT_PROTOCOL
            and artifact.get("ok") is True
        ):
            count += 1
    return count, invalid or count > 1


def _current_batch_calls(request: ToolCallRequest) -> list[dict[str, Any]]:
    call_id = request.tool_call.get("id")
    messages = _state_messages(request.state)
    for message in reversed(messages):
        if not _is_ai_message(message):
            continue
        calls = _message_tool_calls(message)
        if any(call["id"] == call_id for call in calls):
            return calls
    return []


def _error_tool_message(request: ToolCallRequest, code: str, instruction: str) -> ToolMessage:
    name = request.tool_call.get("name")
    call_id = request.tool_call.get("id")
    return ToolMessage(
        content=f"Error: {code}. {instruction} This tool call was not executed; complete the action and retry.",
        tool_call_id=(call_id if isinstance(call_id, str) and call_id else "missing_tool_call_id"),
        name=(name if isinstance(name, str) and name else "unknown_tool"),
        status="error",
    )


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
        self._prd_gate_enabled = normalized_kinds == ["prd"]
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

    def _prd_history_error(self, request: ToolCallRequest) -> ToolMessage | None:
        successful_references, reference_invalid = _reference_progress(request.state)
        stage_count, stage_invalid = _stage_progress(request.state)
        draft_count, draft_invalid = _successful_prd_drafts(request.state)
        result_count, result_invalid = _successful_runtime_results(request.state)
        if reference_invalid:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_HISTORY_INVALID",
                "The current turn contains duplicate or out-of-order successful PRD reference reads; do not publish a PRD from this turn.",
            )
        if stage_invalid:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_STAGE_HISTORY_INVALID",
                "The current turn contains duplicate or out-of-order successful PRD stages; do not publish a PRD from this turn.",
            )
        if draft_invalid or result_invalid:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_PUBLICATION_HISTORY_INVALID",
                "The current turn contains duplicate successful PRD publication calls; do not submit another result.",
            )
        if result_count > 0:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_RESULT_ALREADY_SUBMITTED",
                "A validated Runtime result already exists for this turn; return the concise completion message without another tool call.",
            )
        if draft_count > 0 and request.tool_call.get("name") == ARTIFACT_DRAFT_TOOL_NAME:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_DRAFT_ALREADY_PUBLISHED",
                "A validated PRD draft already exists for this turn; submit the identical candidate with workbench_runtime_result_submit.",
            )
        if stage_count == 0:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_COLLECTING_STAGE_REQUIRED",
                "Call workbench_generation_stage_update with stage='collecting-prd-context' first.",
            )
        missing_references = _missing_reference_indexes(successful_references)
        if missing_references:
            next_path = PRD_REFERENCE_FILES[missing_references[0]][0]
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_READ_REQUIRED",
                f"Call read_file next with the exact path '{next_path}' and omit start_line/end_line; remaining references may be batched once each in canonical order.",
            )
        if stage_count < len(PRD_STAGE_SEQUENCE):
            next_stage = PRD_STAGE_SEQUENCE[stage_count]
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_STAGE_REQUIRED",
                f"Call workbench_generation_stage_update next with stage='{next_stage}'.",
            )
        if (
            draft_count == 0
            and request.tool_call.get("name") == RUNTIME_RESULT_TOOL_NAME
        ):
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_DRAFT_REQUIRED",
                "Publish the complete validated PRD candidate with workbench_artifact_draft_publish before final submission.",
            )
        return None

    def _prd_reference_preflight(self, request: ToolCallRequest) -> ToolMessage | None:
        args = _tool_args(request.tool_call.get("args"))
        path = args.get("path")
        if not _reference_like_path(path):
            return None
        reference_index = _reference_index(path)
        successful_references, reference_invalid = _reference_progress(request.state)
        stage_count, stage_invalid = _stage_progress(request.state)
        if reference_index is None:
            missing_references = _missing_reference_indexes(successful_references)
            expected_index = missing_references[0] if missing_references else len(PRD_REFERENCE_FILES) - 1
            expected_path = PRD_REFERENCE_FILES[expected_index][0]
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_PATH_INVALID",
                f"Use the exact absolute Runtime path '{expected_path}'.",
            )
        if reference_invalid or stage_invalid:
            return self._prd_history_error(request)
        if stage_count == 0:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_COLLECTING_STAGE_REQUIRED",
                "Call workbench_generation_stage_update with stage='collecting-prd-context' before reading PRD references.",
            )
        if stage_count != 1:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_WINDOW_CLOSED",
                "All PRD references must be read after collecting-prd-context succeeds and before structuring-prd starts.",
            )
        if not _full_reference_read(args):
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_RANGE_FORBIDDEN",
                f"Retry read_file for '{path}' while omitting both start_line and end_line.",
            )
        batch_references: list[dict[str, Any]] = []
        for call in _current_batch_calls(request):
            call_path = call["args"].get("path")
            if _reference_like_path(call_path):
                batch_references.append(call)
            if call["id"] == request.tool_call.get("id"):
                break
        if not batch_references or batch_references[-1]["id"] != request.tool_call.get("id"):
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_DECLARATION_MISSING",
                f"Retry read_file for '{path}' in a new model tool-call batch.",
            )
        missing_references = _missing_reference_indexes(successful_references)
        for offset, call in enumerate(batch_references):
            expected_index = missing_references[offset] if offset < len(missing_references) else None
            expected_path = PRD_REFERENCE_FILES[expected_index][0] if expected_index is not None else None
            if (
                expected_path is None
                or call["args"].get("path") != expected_path
                or not _full_reference_read(call["args"])
            ):
                instruction = (
                    f"The next successful read must use exact path '{expected_path}' with no range."
                    if expected_path is not None
                    else "Every required PRD reference already has one successful read; do not read it again."
                )
                return _error_tool_message(
                    request,
                    "WORKBENCH_PRD_REFERENCE_ORDER_INVALID",
                    instruction,
                )
        return None

    def _prd_stage_preflight(self, request: ToolCallRequest) -> ToolMessage | None:
        args = _tool_args(request.tool_call.get("args"))
        stage = args.get("stage")
        if stage not in PRD_STAGE_SEQUENCE:
            return None
        stage_count, stage_invalid = _stage_progress(request.state)
        successful_references, reference_invalid = _reference_progress(request.state)
        if stage_invalid or reference_invalid:
            return self._prd_history_error(request)
        batch_stages = [
            call
            for call in _current_batch_calls(request)
            if call["name"] == GENERATION_STAGE_TOOL_NAME
            and call["args"].get("stage") in PRD_STAGE_SEQUENCE
        ]
        current_position = next(
            (index for index, call in enumerate(batch_stages) if call["id"] == request.tool_call.get("id")),
            None,
        )
        if current_position is None:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_STAGE_DECLARATION_MISSING",
                f"Retry workbench_generation_stage_update with stage='{stage}' in a new model tool-call batch.",
            )
        if current_position != 0:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_STAGE_BATCH_INVALID",
                "Record only one real PRD generation stage per model tool-call batch.",
            )
        expected_stage = (
            PRD_STAGE_SEQUENCE[stage_count]
            if stage_count < len(PRD_STAGE_SEQUENCE)
            else None
        )
        if stage != expected_stage:
            instruction = (
                f"Call workbench_generation_stage_update next with stage='{expected_stage}'."
                if expected_stage is not None
                else "All four PRD stages already succeeded; publish the complete draft instead of recording another stage."
            )
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_STAGE_ORDER_INVALID",
                instruction,
            )
        missing_references = _missing_reference_indexes(successful_references)
        if stage == "structuring-prd" and missing_references:
            next_path = PRD_REFERENCE_FILES[missing_references[0]][0]
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_READ_REQUIRED",
                f"Read '{next_path}' next with read_file and no range before starting structuring-prd.",
            )
        return None

    def _prd_preflight(self, request: ToolCallRequest) -> ToolMessage | None:
        if not self._prd_gate_enabled:
            return None
        name = request.tool_call.get("name")
        if name == READ_FILE_TOOL_NAME:
            return self._prd_reference_preflight(request)
        if name == GENERATION_STAGE_TOOL_NAME:
            return self._prd_stage_preflight(request)
        if name in {ARTIFACT_DRAFT_TOOL_NAME, RUNTIME_RESULT_TOOL_NAME}:
            same_batch_calls = [
                call
                for call in _current_batch_calls(request)
                if call["name"] == name
            ]
            current_position = next(
                (index for index, call in enumerate(same_batch_calls) if call["id"] == request.tool_call.get("id")),
                None,
            )
            if current_position is None:
                return _error_tool_message(
                    request,
                    "WORKBENCH_PRD_PUBLICATION_DECLARATION_MISSING",
                    f"Retry {name} in a new model tool-call batch.",
                )
            if current_position != 0:
                return _error_tool_message(
                    request,
                    "WORKBENCH_PRD_PUBLICATION_BATCH_INVALID",
                    f"Call {name} only once in a model tool-call batch.",
                )
            return self._prd_history_error(request)
        return None

    def _prd_postflight(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if not self._prd_gate_enabled or request.tool_call.get("name") != READ_FILE_TOOL_NAME:
            return result
        args = _tool_args(request.tool_call.get("args"))
        path = args.get("path")
        reference_index = _reference_index(path)
        if reference_index is None:
            return result
        if not isinstance(result, ToolMessage) or not _tool_succeeded(result):
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_READ_FAILED",
                f"Retry read_file for the exact path '{path}' with no range.",
            )
        content = _tool_content(result)
        expected_digest = PRD_REFERENCE_FILES[reference_index][1]
        actual_digest = (
            hashlib.sha256(content.encode("utf-8")).hexdigest()
            if content is not None
            else None
        )
        if actual_digest != expected_digest:
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_CONTENT_MISMATCH",
                f"The installed file '{path}' does not match pinned SHA-256 '{expected_digest}'; do not publish until the Runtime image is corrected.",
            )
        return result

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
        if blocked is not None:
            return blocked
        blocked = self._prd_preflight(request)
        if blocked is not None:
            return blocked
        return self._prd_postflight(request, handler(request))

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
        if blocked is not None:
            return blocked
        blocked = self._prd_preflight(request)
        if blocked is not None:
            return blocked
        return self._prd_postflight(request, await handler(request))
