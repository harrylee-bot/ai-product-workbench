"""Per-run Product Workbench tool visibility and execution policy.

Scoped tools stay registered in ToolNode so DeerFlow can route a declared call.
The model-visible schemas and execution path are independently reduced for every
run. Canvas tools use their tokenless configurable declaration. Prototype-only
publication tools, the PRD reference reader, and Knowledge visibility are enabled
only by trusted fields in ``context.workbench``. Missing or malformed policy never
grants ambient access.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
import hashlib
import json
import posixpath
import re
from typing import Any

try:
    from typing import override
except ImportError:  # pragma: no cover - DeerFlow's pinned Python is 3.12.
    def override(function):
        return function

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelCallResult,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
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
PROTOTYPE_PATCH_TOOL_NAME = "workbench_prototype_patch_publish"
PROTOTYPE_ONLY_TOOL_NAMES = (
    "workbench_prototype_patch_publish",
)
KNOWLEDGE_TOOL_NAME = "workbench_knowledge_retrieve"
READ_FILE_TOOL_NAME = "read_file"
GENERATION_STAGE_TOOL_NAME = "workbench_generation_stage_update"
ARTIFACT_DRAFT_TOOL_NAME = "workbench_artifact_draft_publish"
RUNTIME_RESULT_TOOL_NAME = "workbench_runtime_result_submit"
SUBAGENT_TOOL_NAME = "task"
CLARIFICATION_TOOL_NAME = "ask_clarification"
PRD_STAGE_SEQUENCE = (
    "collecting-prd-context",
    "structuring-prd",
    "drafting-prd",
    "validating-prd",
)
PROTOTYPE_STAGE_SEQUENCE = (
    "design-system",
    "mapping-components",
    "creating-flows",
    "generating-ui",
)
PRD_REFERENCE_FILES = (
    (
        "/mnt/skills/public/requirement-doc-template/SKILL.md",
        "82ec80d5b8d68916b2fb9259e30db9e0982645ae96e6d189a9d1dd3daf2baf0f",
    ),
    (
        "/mnt/skills/public/requirement-doc-template/references/structure.md",
        "7952eb98fadbbd992f1bdbd227953aacbcbcdea7fdef1f758987750a9ac5bf70",
    ),
    (
        "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
        "ad2206958aee116654a657b1c979e7a0228aee1e080e2a289712bd7ad82b1c76",
    ),
    (
        "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
        "bd2f09b81bf8538a33ccf9eb0942d364c23dedf071979dad991fe09812f9e747",
    ),
)
PROTOTYPE_REFERENCE_FILES = (
    (
        "/mnt/skills/public/workbench/references/prototype-runtime-result.example.json",
        "e76e0c8b8c797a4941e31cc5067b80bb8106d4329b086ef743d6ad76ef958a99",
    ),
    (
        "/mnt/skills/public/workbench/references/runtime-result-contract.md",
        "b7a3aaf96e8e88dd0c5c7be1f91dd79711bec28626a4eec0783c8f90b4682159",
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
_PRD_REFERENCE_BLOCK_CODE = "WORKBENCH_PRD_REFERENCE_TOOL_NOT_AUTHORIZED"
_REFERENCE_BLOCK_CODE = "WORKBENCH_REFERENCE_TOOL_NOT_AUTHORIZED"
_PROTOTYPE_SUBAGENT_BLOCK_CODE = "WORKBENCH_PROTOTYPE_SUBAGENT_NOT_AVAILABLE"
_PRD_CLARIFICATION_BLOCK_CODE = "WORKBENCH_PRD_CLARIFICATION_NOT_SUPPORTED"
_PRD_REFERENCE_ROOT = "/mnt/skills/public/"
_PRD_REFERENCE_RELATIVE_PATHS = tuple(
    path.removeprefix(_PRD_REFERENCE_ROOT) for path, _digest in PRD_REFERENCE_FILES
)
_PRD_STAGE_PROTOCOL = "workbench.runtime.generation-stage.v1"
_PRD_DRAFT_PROTOCOL = "workbench.runtime.artifact-draft.v1"
_PRD_RESULT_PROTOCOL = "workbench.runtime.validated-result.v1"
_PROTOTYPE_PATCH_PROTOCOL = "workbench.runtime.prototype-patch.v1"
_PROTOTYPE_PATCH_PUBLICATION_PROTOCOL = (
    "workbench.runtime.prototype-patch-publication.v1"
)
_RUNTIME_RESULT_PROTOCOL = "workbench.runtime.result.v1"
_AUTOMATIC_PROTOTYPE_RESULT_CALL_PREFIX = "workbench_auto_prototype_result_"
_PRD_CLARIFICATION_SYSTEM_POLICY = """<workbench_prd_clarification_policy>
This PRD-only Workbench Run cannot resume free-form clarification. The ask_clarification tool is unavailable. Ignore any general instruction that requires clarification for this Run. Do not ask a question or end early. Keep unsupported high-risk behavior out of committed scope, record conservative typed assumptions or acceptance boundaries, then publish the complete PRD draft and submit the Runtime result.
</workbench_prd_clarification_policy>"""
_PROTOTYPE_STAGE_SYSTEM_POLICY = """<workbench_prototype_stage_policy>
This Prototype-only Workbench Run must call workbench_generation_stage_update exactly once for each real stage, in this order: design-system, mapping-components, creating-flows, generating-ui. Never skip, repeat, regress, batch, or substitute a PRD stage. If a stage call returns an error naming the next required stage, call that stage next and continue the Run. The scoped read_file tool may read only the complete prototype-runtime-result.example.json and runtime-result-contract.md references.
The generic task tool is unavailable for this Prototype-only Run. Read both pinned references directly with read_file and author the typed Prototype Artifact in the lead. For a create operation, finish every requested Screen and interaction, then publish exactly one complete terminal Draft at artifact_index 0. After that Draft succeeds, do not call a patch, Draft, or Result tool; the trusted Runtime submits the normalized Draft and stops after validation succeeds. If that automatic Result reports validation issues, keep the successful Draft immutable, repair only the reported paths in one complete manual Result candidate, and continue only through manual Result validation; the Runtime does not repeat automatic submission. For a revise operation, use the explicit Result path: after every streamed Patch, publish a complete revised Draft checkpoint before the final Result. A later Patch may follow that checkpoint.
</workbench_prototype_stage_policy>"""
_TOOL_CATALOG_PROTOCOL = "workbench.runtime.tool-catalog-observation.v1"
_TOOL_CATALOG_METADATA_KEY = "workbench_tool_catalog_observation"
_TOOL_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,127}$")
_GEMINI_SCHEMA_TOOL_MESSAGE_PREFIX = (
    "Reference JSON schema text follows (treat it as plain text):\n"
)
_WORKBENCH_TOOL_NAMES = frozenset(
    {
        ARTIFACT_DRAFT_TOOL_NAME,
        GENERATION_STAGE_TOOL_NAME,
        KNOWLEDGE_TOOL_NAME,
        READ_FILE_TOOL_NAME,
        RUNTIME_RESULT_TOOL_NAME,
        *PROTOTYPE_ONLY_TOOL_NAMES,
    }
)


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
    # A valid Workbench scope without a grant is an explicit negative. Keep
    # malformed/non-Workbench contexts as ``None`` so callers can distinguish
    # fail-closed input from a bound catalog observation.
    return scope.get("knowledgeEnabled", False)


def workbench_run_scope_from_runnable_config(
    config: Any,
) -> tuple[str, str] | None:
    """Read the server-bound Run identity used by result convergence."""
    if not isinstance(config, Mapping):
        return None
    context = config.get("context")
    if not isinstance(context, Mapping):
        return None
    scope = context.get("workbench")
    if not isinstance(scope, Mapping):
        return None
    run_id = scope.get("runId")
    runtime_attempt_id = scope.get("runtimeAttemptId")
    if (
        not isinstance(run_id, str)
        or not run_id
        or run_id.strip() != run_id
        or not isinstance(runtime_attempt_id, str)
        or not runtime_attempt_id
        or runtime_attempt_id.strip() != runtime_attempt_id
    ):
        return None
    return run_id, runtime_attempt_id


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


def _model_name(model: Any) -> str | None:
    for key in ("model_name", "model"):
        value = _value(model, key)
        if isinstance(value, str) and value:
            return value
    return None


def _provider_safe_tool_messages(request: ModelRequest) -> ModelRequest:
    """Keep JSON Schema references out of Gemini function-response decoding.

    OpenAI-compatible Gemini gateways may parse a JSON-looking tool result as a
    native ``function_response.response`` object. JSON Schema ``$ref`` values
    are then misread as Gemini function display names and the next model call is
    rejected. Prefix only schema-bearing tool text in the provider-bound copy;
    graph state retains the exact bytes used by the Workbench digest checks.
    """
    model_name = _model_name(_value(request, "model"))
    if model_name is None or "gemini" not in model_name.casefold():
        return request
    messages = _value(request, "messages")
    if not isinstance(messages, list):
        return request

    rewritten: list[Any] = []
    changed = False
    for message in messages:
        content = _value(message, "content")
        if (
            not _is_tool_message(message)
            or not isinstance(content, str)
            or content.startswith(_GEMINI_SCHEMA_TOOL_MESSAGE_PREFIX)
            or not content.lstrip().startswith(("{", "["))
            or ('"$defs"' not in content and '"$ref"' not in content)
        ):
            rewritten.append(message)
            continue
        provider_content = f"{_GEMINI_SCHEMA_TOOL_MESSAGE_PREFIX}{content}"
        if isinstance(message, Mapping):
            rewritten.append({**message, "content": provider_content})
            changed = True
            continue
        copier = getattr(message, "model_copy", None)
        if callable(copier):
            rewritten.append(copier(update={"content": provider_content}))
            changed = True
            continue
        rewritten.append(message)
    return request.override(messages=rewritten) if changed else request


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


def _prototype_reference(path: Any) -> tuple[str, str] | None:
    if not isinstance(path, str):
        return None
    return next(
        (reference for reference in PROTOTYPE_REFERENCE_FILES if path == reference[0]),
        None,
    )


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


def _prototype_stage_progress(state: Any) -> tuple[int, bool]:
    completed, invalid = _completed_tool_calls(state)
    successful_stages: list[str] = []
    for call in completed:
        if call["name"] != GENERATION_STAGE_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        stage = call["args"].get("stage")
        artifact = _value(call["response"], "artifact")
        if (
            stage not in PROTOTYPE_STAGE_SEQUENCE
            or not isinstance(artifact, Mapping)
            or artifact.get("protocol") != _PRD_STAGE_PROTOCOL
            or artifact.get("stage") != stage
        ):
            invalid = True
            continue
        successful_stages.append(stage)
    if successful_stages != list(PROTOTYPE_STAGE_SEQUENCE[: len(successful_stages)]):
        invalid = True
    if len(successful_stages) > len(PROTOTYPE_STAGE_SEQUENCE):
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


def _prototype_call_is_bound(
    artifact: Any,
    call_id: str,
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> bool:
    return (
        run_id is None
        or runtime_attempt_id is None
        or (
            isinstance(artifact, Mapping)
            and artifact.get("runId") == run_id
            and artifact.get("runtimeAttemptId") == runtime_attempt_id
            and artifact.get("toolCallId") == call_id
        )
    )


def _successful_prototype_draft_from_call(
    call: Mapping[str, Any],
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> tuple[dict[str, Any], int] | None:
    if call["name"] != ARTIFACT_DRAFT_TOOL_NAME or not _tool_succeeded(call["response"]):
        return None
    artifact = _value(call["response"], "artifact")
    draft = artifact.get("draft") if isinstance(artifact, Mapping) else None
    artifact_index = artifact.get("artifactIndex") if isinstance(artifact, Mapping) else None
    if not _prototype_call_is_bound(artifact, call["id"], run_id, runtime_attempt_id):
        return None
    if (
        isinstance(artifact, Mapping)
        and artifact.get("protocol") == _PRD_DRAFT_PROTOCOL
        and artifact.get("ok") is True
        and isinstance(draft, Mapping)
        and draft.get("kind") == "prototype"
        and isinstance(artifact_index, int)
        and not isinstance(artifact_index, bool)
        and 0 <= artifact_index < 20
    ):
        return dict(draft), artifact_index
    return None


def _successful_prototype_patch_from_call(
    call: Mapping[str, Any],
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> int | None:
    if call["name"] != PROTOTYPE_PATCH_TOOL_NAME or not _tool_succeeded(call["response"]):
        return None
    artifact = _value(call["response"], "artifact")
    patch = artifact.get("patch") if isinstance(artifact, Mapping) else None
    artifact_index = patch.get("artifactIndex") if isinstance(patch, Mapping) else None
    if not _prototype_call_is_bound(artifact, call["id"], run_id, runtime_attempt_id):
        return None
    if (
        isinstance(artifact, Mapping)
        and artifact.get("protocol") == _PROTOTYPE_PATCH_PUBLICATION_PROTOCOL
        and artifact.get("ok") is True
        and isinstance(patch, Mapping)
        and patch.get("protocol") == _PROTOTYPE_PATCH_PROTOCOL
        and isinstance(artifact_index, int)
        and not isinstance(artifact_index, bool)
        and 0 <= artifact_index < 20
    ):
        return artifact_index
    return None


def _successful_prototype_drafts(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[list[tuple[dict[str, Any], int]], bool]:
    """Return every bound normalized Prototype checkpoint in current-turn order."""
    completed, invalid = _completed_tool_calls(state)
    drafts: list[tuple[dict[str, Any], int]] = []
    for call in completed:
        draft = _successful_prototype_draft_from_call(
            call,
            run_id,
            runtime_attempt_id,
        )
        if draft is not None:
            drafts.append(draft)
    return drafts, invalid


def _successful_prototype_draft(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[dict[str, Any] | None, int | None, bool]:
    """Return the one terminal Prototype draft eligible for automatic create completion."""
    drafts, invalid = _successful_prototype_drafts(
        state,
        run_id,
        runtime_attempt_id,
    )
    if len(drafts) != 1:
        return None, None, invalid or len(drafts) > 1
    return drafts[0][0], drafts[0][1], invalid


def _latest_successful_prototype_draft(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[dict[str, Any] | None, int | None, bool]:
    """Return the newest bound Prototype checkpoint without rejecting revise history."""
    drafts, invalid = _successful_prototype_drafts(
        state,
        run_id,
        runtime_attempt_id,
    )
    if not drafts:
        return None, None, invalid
    if any(
        isinstance(draft.get("operation"), Mapping)
        and draft["operation"].get("kind") == "create"
        for draft, _artifact_index in drafts
    ) and len(drafts) > 1:
        return None, None, True
    draft, artifact_index = drafts[-1]
    return draft, artifact_index, invalid


def _prototype_patch_checkpoint_required(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[frozenset[int], bool]:
    """Return artifact indexes whose newest publication is an uncheckpointed Patch."""
    completed, invalid = _completed_tool_calls(state)
    latest_publication: dict[int, str] = {}
    for call in completed:
        draft = _successful_prototype_draft_from_call(
            call,
            run_id,
            runtime_attempt_id,
        )
        if draft is not None:
            _draft, artifact_index = draft
            latest_publication[artifact_index] = "draft"
            continue
        patch_artifact_index = _successful_prototype_patch_from_call(
            call,
            run_id,
            runtime_attempt_id,
        )
        if patch_artifact_index is not None:
            latest_publication[patch_artifact_index] = "patch"
    return frozenset(
        artifact_index
        for artifact_index, publication in latest_publication.items()
        if publication == "patch"
    ), invalid


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


def _successful_runtime_result_message(
    state: Any,
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> str | None:
    """Return the validated result message once, so the graph can converge."""
    if not run_id or not runtime_attempt_id:
        return None
    completed, invalid = _completed_tool_calls(state)
    if invalid:
        return None
    messages: list[str] = []
    for call in completed:
        if call["name"] != RUNTIME_RESULT_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        artifact = _value(call["response"], "artifact")
        if (
            not isinstance(artifact, Mapping)
            or artifact.get("protocol") != _PRD_RESULT_PROTOCOL
            or artifact.get("ok") is not True
            or artifact.get("runId") != run_id
            or artifact.get("runtimeAttemptId") != runtime_attempt_id
        ):
            continue
        result = _value(artifact, "result")
        message = _value(result, "message")
        messages.append(message.strip() if isinstance(message, str) else "")
    if len(messages) != 1:
        return None
    return messages[0] or "Workbench result submitted."


def _automatic_prototype_result_message(
    state: Any,
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> AIMessage | None:
    """Turn the validated Prototype draft into the final result without another LLM call."""
    if run_id is None or runtime_attempt_id is None:
        return None
    draft, artifact_index, draft_invalid = _successful_prototype_draft(
        state,
        run_id,
        runtime_attempt_id,
    )
    stage_count, stage_invalid = _prototype_stage_progress(state)
    result_count, result_invalid = _successful_runtime_results(state)
    completed, completed_invalid = _completed_tool_calls(state)
    operation = draft.get("operation") if isinstance(draft, Mapping) else None
    if (
        draft is None
        or artifact_index != 0
        or not isinstance(operation, Mapping)
        or operation.get("kind") != "create"
        or draft_invalid
        or stage_invalid
        or stage_count != len(PROTOTYPE_STAGE_SEQUENCE)
        or result_invalid
        or completed_invalid
        or result_count > 0
        or any(
            call["name"] == RUNTIME_RESULT_TOOL_NAME
            and call["id"].startswith(_AUTOMATIC_PROTOTYPE_RESULT_CALL_PREFIX)
            for call in completed
        )
    ):
        return None

    candidate = {
        "protocol": _RUNTIME_RESULT_PROTOCOL,
        "message": "\u539f\u578b\u5df2\u751f\u6210\u5e76\u53ef\u9884\u89c8\u3002",
        "artifacts": [draft],
    }
    call_identity = {
        "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id,
        "candidate": candidate,
    }
    digest = hashlib.sha256(
        json.dumps(call_identity, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
            "utf-8"
        )
    ).hexdigest()[:24]
    return AIMessage(
        content="",
        tool_calls=[{
            "id": f"{_AUTOMATIC_PROTOTYPE_RESULT_CALL_PREFIX}{digest}",
            "name": RUNTIME_RESULT_TOOL_NAME,
            "args": {"candidate": candidate},
            "type": "tool_call",
        }],
    )


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


def _tool_catalog_observation(visible: list[Any]) -> dict[str, Any]:
    """Build a deterministic, non-secret record of the model-bound tool catalog."""
    names = [_tool_name(tool) for tool in visible]
    if (
        any(
            not isinstance(name, str)
            or _TOOL_NAME_PATTERN.fullmatch(name) is None
            or (name.startswith("workbench_") and name not in _WORKBENCH_TOOL_NAMES)
            for name in names
        )
        or len(set(names)) != len(names)
    ):
        raise ValueError("WORKBENCH_TOOL_CATALOG_INVALID")
    payload = {
        "protocol": _TOOL_CATALOG_PROTOCOL,
        "knowledgeVisible": KNOWLEDGE_TOOL_NAME in names,
        "toolNames": names,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return {
        **payload,
        "sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }


def _stamp_ai_message(message: AIMessage, observation: Mapping[str, Any]) -> AIMessage:
    response_metadata = dict(message.response_metadata or {})
    response_metadata[_TOOL_CATALOG_METADATA_KEY] = dict(observation)
    return message.model_copy(update={"response_metadata": response_metadata})


def _stamp_model_response(
    response: ModelResponse[Any],
    observation: Mapping[str, Any],
) -> ModelResponse[Any]:
    return ModelResponse(
        result=[
            _stamp_ai_message(message, observation)
            if isinstance(message, AIMessage)
            else message
            for message in response.result
        ],
        structured_response=response.structured_response,
    )


def _stamp_catalog_observation(
    result: ModelCallResult,
    observation: Mapping[str, Any] | None,
) -> ModelCallResult:
    if observation is None:
        return result
    if isinstance(result, AIMessage):
        return _stamp_ai_message(result, observation)
    if isinstance(result, ExtendedModelResponse):
        return ExtendedModelResponse(
            model_response=_stamp_model_response(result.model_response, observation),
            command=result.command,
        )
    if isinstance(result, ModelResponse):
        return _stamp_model_response(result, observation)
    return result


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
        run_scope: Any = None,
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
        self._prototype_reference_enabled = normalized_kinds == ["prototype"]
        self._prototype_stage_gate_enabled = normalized_kinds == ["prototype"]
        self._prd_gate_enabled = normalized_kinds == ["prd"]
        self._knowledge_catalog_bound = isinstance(knowledge_enabled, bool)
        self._knowledge_enabled = knowledge_enabled is True
        self._run_id: str | None = None
        self._runtime_attempt_id: str | None = None
        if (
            isinstance(run_scope, tuple)
            and len(run_scope) == 2
            and all(
                isinstance(value, str)
                and value
                and value.strip() == value
                for value in run_scope
            )
        ):
            self._run_id, self._runtime_attempt_id = run_scope

    def _filter_tools(self, request: ModelRequest) -> ModelRequest:
        visible = []
        for tool in request.tools:
            name = _tool_name(tool)
            if name == CLARIFICATION_TOOL_NAME and self._prd_gate_enabled:
                continue
            # Prototype-only Runs keep the lead on the typed Artifact path. The
            # generic task tool cannot read the pinned Workbench references and
            # otherwise enables unbounded protocol-lookup delegation loops.
            if name == SUBAGENT_TOOL_NAME and self._prototype_stage_gate_enabled:
                continue
            if name in _CANVAS_TOOL_NAME_SET and name not in self._declared_canvas:
                continue
            if name in _ARTIFACT_PROGRESS_TOOL_NAME_SET and not self._artifact_progress_enabled:
                continue
            if name in _PROTOTYPE_ONLY_TOOL_NAME_SET and not self._prototype_enabled:
                continue
            if name == KNOWLEDGE_TOOL_NAME and not self._knowledge_enabled:
                continue
            if (
                name == READ_FILE_TOOL_NAME
                and not self._prd_gate_enabled
                and not self._prototype_reference_enabled
            ):
                continue
            visible.append(tool)
        overrides: dict[str, Any] = {}
        if len(visible) != len(request.tools):
            overrides["tools"] = visible
        if self._prd_gate_enabled:
            system_message = request.system_message
            system_text = system_message.text if system_message is not None else ""
            if _PRD_CLARIFICATION_SYSTEM_POLICY not in system_text:
                overrides["system_message"] = SystemMessage(content=(
                    f"{system_text.rstrip()}\n\n{_PRD_CLARIFICATION_SYSTEM_POLICY}"
                    if system_text.strip()
                    else _PRD_CLARIFICATION_SYSTEM_POLICY
                ))
        if self._prototype_stage_gate_enabled:
            system_message = overrides.get("system_message", request.system_message)
            system_text = system_message.text if system_message is not None else ""
            if _PROTOTYPE_STAGE_SYSTEM_POLICY not in system_text:
                overrides["system_message"] = SystemMessage(content=(
                    f"{system_text.rstrip()}\n\n{_PROTOTYPE_STAGE_SYSTEM_POLICY}"
                    if system_text.strip()
                    else _PROTOTYPE_STAGE_SYSTEM_POLICY
                ))
        scoped_request = request if not overrides else request.override(**overrides)
        return _provider_safe_tool_messages(scoped_request)

    def _catalog_observation(self, request: ModelRequest) -> dict[str, Any] | None:
        if not self._knowledge_catalog_bound:
            return None
        return _tool_catalog_observation(list(request.tools))

    def _blocked_tool_message(self, request: ToolCallRequest) -> ToolMessage | None:
        name = request.tool_call.get("name")
        if not isinstance(name, str):
            return None
        if name == CLARIFICATION_TOOL_NAME and self._prd_gate_enabled:
            block_code = _PRD_CLARIFICATION_BLOCK_CODE
        elif name == SUBAGENT_TOOL_NAME and self._prototype_stage_gate_enabled:
            block_code = _PROTOTYPE_SUBAGENT_BLOCK_CODE
        elif name in _CANVAS_TOOL_NAME_SET and name not in self._declared_canvas:
            block_code = _CANVAS_BLOCK_CODE
        elif name in _ARTIFACT_PROGRESS_TOOL_NAME_SET and not self._artifact_progress_enabled:
            block_code = _ARTIFACT_PROGRESS_BLOCK_CODE
        elif name in _PROTOTYPE_ONLY_TOOL_NAME_SET and not self._prototype_enabled:
            block_code = _PROTOTYPE_BLOCK_CODE
        elif name == KNOWLEDGE_TOOL_NAME and not self._knowledge_enabled:
            block_code = _KNOWLEDGE_BLOCK_CODE
        elif (
            name == READ_FILE_TOOL_NAME
            and not self._prd_gate_enabled
            and not self._prototype_reference_enabled
        ):
            block_code = _REFERENCE_BLOCK_CODE
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
            successful_references, _reference_invalid = _reference_progress(request.state)
            missing_references = _missing_reference_indexes(successful_references)
            expected_index = missing_references[0] if missing_references else len(PRD_REFERENCE_FILES) - 1
            expected_path = PRD_REFERENCE_FILES[expected_index][0]
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_PATH_INVALID",
                f"Use the exact absolute Runtime path '{expected_path}'.",
            )
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
            # The shared stage tool schema also contains Prototype stages. Keep
            # those calls out of a PRD Run before the handler can return a
            # misleading request-kind error and send the model into a retry loop.
            if stage in PROTOTYPE_STAGE_SEQUENCE:
                return _error_tool_message(
                    request,
                    "WORKBENCH_PRD_STAGE_FAMILY_INVALID",
                    "This PRD Run accepts only PRD generation stages; call the next required PRD stage instead.",
                )
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

    def _prototype_reference_preflight(
        self,
        request: ToolCallRequest,
    ) -> ToolMessage | None:
        if not self._prototype_reference_enabled:
            return None
        args = _tool_args(request.tool_call.get("args"))
        path = args.get("path")
        reference = _prototype_reference(path)
        if reference is None:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_REFERENCE_PATH_INVALID",
                f"Use one exact Prototype Runtime reference path: '{PROTOTYPE_REFERENCE_FILES[0][0]}' or '{PROTOTYPE_REFERENCE_FILES[1][0]}'.",
            )
        if not _full_reference_read(args):
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_REFERENCE_RANGE_FORBIDDEN",
                f"Retry read_file for '{path}' while omitting both start_line and end_line.",
            )
        return None

    def _prototype_reference_postflight(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if (
            not self._prototype_reference_enabled
            or request.tool_call.get("name") != READ_FILE_TOOL_NAME
        ):
            return result
        path = _tool_args(request.tool_call.get("args")).get("path")
        reference = _prototype_reference(path)
        if reference is None:
            return result
        if not isinstance(result, ToolMessage) or not _tool_succeeded(result):
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_REFERENCE_READ_FAILED",
                f"Retry read_file for the exact path '{path}' with no range.",
            )
        content = _tool_content(result)
        actual_digest = (
            hashlib.sha256(content.encode("utf-8")).hexdigest()
            if content is not None
            else None
        )
        if actual_digest != reference[1]:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_REFERENCE_CONTENT_MISMATCH",
                f"The installed file '{path}' does not match the pinned Prototype reference; do not publish until the Runtime image is corrected.",
            )
        return result

    def _prototype_stage_preflight(
        self,
        request: ToolCallRequest,
    ) -> ToolMessage | None:
        if (
            not self._prototype_stage_gate_enabled
            or request.tool_call.get("name") != GENERATION_STAGE_TOOL_NAME
        ):
            return None
        stage_count, stage_invalid = _prototype_stage_progress(request.state)
        expected_stage = (
            PROTOTYPE_STAGE_SEQUENCE[stage_count]
            if stage_count < len(PROTOTYPE_STAGE_SEQUENCE)
            else None
        )
        if stage_invalid:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_STAGE_HISTORY_INVALID",
                "The current turn contains a successful cross-family, duplicate, regressed, malformed, or out-of-order Prototype stage; do not publish from this turn.",
            )
        args = _tool_args(request.tool_call.get("args"))
        stage = args.get("stage")
        instruction = (
            f"Call workbench_generation_stage_update next with stage='{expected_stage}'."
            if expected_stage is not None
            else "All four Prototype stages already succeeded; continue artifact publication without another generation stage update."
        )
        if stage not in PROTOTYPE_STAGE_SEQUENCE:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_STAGE_FAMILY_INVALID",
                instruction,
            )
        batch_stages = [
            call
            for call in _current_batch_calls(request)
            if call["name"] == GENERATION_STAGE_TOOL_NAME
        ]
        current_position = next(
            (index for index, call in enumerate(batch_stages) if call["id"] == request.tool_call.get("id")),
            None,
        )
        if current_position is None:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_STAGE_DECLARATION_MISSING",
                f"Retry workbench_generation_stage_update with stage='{stage}' in a new model tool-call batch.",
            )
        if len(batch_stages) != 1:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_STAGE_BATCH_INVALID",
                f"Record only one real Prototype stage per model tool-call batch. {instruction}",
            )
        if stage != expected_stage:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_STAGE_ORDER_INVALID",
                instruction,
            )
        return None

    def _prototype_publication_preflight(
        self,
        request: ToolCallRequest,
    ) -> ToolMessage | None:
        if not self._prototype_stage_gate_enabled:
            return None
        name = request.tool_call.get("name")
        if name == PROTOTYPE_PATCH_TOOL_NAME:
            draft, _artifact_index, draft_invalid = _latest_successful_prototype_draft(
                request.state,
                self._run_id,
                self._runtime_attempt_id,
            )
            checkpoint_required, patch_history_invalid = _prototype_patch_checkpoint_required(
                request.state,
                self._run_id,
                self._runtime_attempt_id,
            )
            draft_operation = draft.get("operation") if isinstance(draft, Mapping) else None
            if draft_invalid or patch_history_invalid:
                return _error_tool_message(
                    request,
                    "WORKBENCH_PROTOTYPE_PUBLICATION_HISTORY_INVALID",
                    "The current turn contains malformed or duplicate successful Prototype publication calls; do not publish a patch from this turn.",
                )
            if (
                isinstance(draft_operation, Mapping)
                and draft_operation.get("kind") == "create"
            ):
                return _error_tool_message(
                    request,
                    "WORKBENCH_PROTOTYPE_TERMINAL_DRAFT_IMMUTABLE",
                    "The successful terminal create Draft is immutable; repair an automatic Result rejection only through the manual complete Result path.",
                )
            if checkpoint_required:
                return _error_tool_message(
                    request,
                    "WORKBENCH_PROTOTYPE_PATCH_CHECKPOINT_REQUIRED",
                    "Publish a complete revised Prototype Draft checkpoint before another Patch or final Result.",
                )
            if any(
                call["name"] in {ARTIFACT_DRAFT_TOOL_NAME, RUNTIME_RESULT_TOOL_NAME}
                for call in _current_batch_calls(request)
            ):
                return _error_tool_message(
                    request,
                    "WORKBENCH_PROTOTYPE_PUBLICATION_BATCH_INVALID",
                    "Call only one Prototype publication tool in each model tool-call batch.",
                )
            return None
        if name not in {ARTIFACT_DRAFT_TOOL_NAME, RUNTIME_RESULT_TOOL_NAME}:
            return None

        stage_count, stage_invalid = _prototype_stage_progress(request.state)
        draft, _artifact_index, draft_invalid = _latest_successful_prototype_draft(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        checkpoint_required, patch_history_invalid = _prototype_patch_checkpoint_required(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        result_count, result_invalid = _successful_runtime_results(request.state)
        if stage_invalid or draft_invalid or patch_history_invalid or result_invalid:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_PUBLICATION_HISTORY_INVALID",
                "The current turn contains malformed, duplicate, or out-of-order successful Prototype stages or publication calls; do not publish again from this turn.",
            )
        if stage_count < len(PROTOTYPE_STAGE_SEQUENCE):
            next_stage = PROTOTYPE_STAGE_SEQUENCE[stage_count]
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_STAGE_REQUIRED",
                f"Call workbench_generation_stage_update next with stage='{next_stage}' before publishing the Prototype.",
            )
        if result_count > 0:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_RESULT_ALREADY_SUBMITTED",
                "A validated Runtime result already exists for this turn; return the concise completion message without another tool call.",
            )
        if draft is not None and name == ARTIFACT_DRAFT_TOOL_NAME:
            draft_operation = draft.get("operation") if isinstance(draft, Mapping) else None
            if isinstance(draft_operation, Mapping) and draft_operation.get("kind") == "create":
                return _error_tool_message(
                    request,
                    "WORKBENCH_PROTOTYPE_DRAFT_ALREADY_PUBLISHED",
                    "A validated terminal create Draft already exists; the Runtime will submit that exact draft as the final result.",
                )
            if not checkpoint_required:
                return _error_tool_message(
                    request,
                    "WORKBENCH_PROTOTYPE_DRAFT_ALREADY_PUBLISHED",
                    "A validated revise Draft already exists; publish a Patch or submit the explicit Result before another Draft.",
                )
        if checkpoint_required and name == ARTIFACT_DRAFT_TOOL_NAME:
            artifact_index = _tool_args(request.tool_call.get("args")).get("artifact_index")
            if isinstance(artifact_index, int) and not isinstance(artifact_index, bool) and (
                artifact_index not in checkpoint_required
            ):
                return _error_tool_message(
                    request,
                    "WORKBENCH_PROTOTYPE_PATCH_CHECKPOINT_REQUIRED",
                    "Publish a complete revised Prototype Draft checkpoint for each patched artifact before another Patch or final Result.",
                )
        if checkpoint_required and name == RUNTIME_RESULT_TOOL_NAME:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_PATCH_CHECKPOINT_REQUIRED",
                "Publish a complete revised Prototype Draft checkpoint before another Patch or final Result.",
            )
        if draft is None and name == RUNTIME_RESULT_TOOL_NAME:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_DRAFT_REQUIRED",
                "Publish the complete validated Prototype candidate with workbench_artifact_draft_publish before final submission.",
            )

        batch_publications = [
            call
            for call in _current_batch_calls(request)
            if call["name"]
            in {
                ARTIFACT_DRAFT_TOOL_NAME,
                PROTOTYPE_PATCH_TOOL_NAME,
                RUNTIME_RESULT_TOOL_NAME,
            }
        ]
        if len(batch_publications) != 1:
            return _error_tool_message(
                request,
                "WORKBENCH_PROTOTYPE_PUBLICATION_BATCH_INVALID",
                "Call exactly one Prototype publication tool in each model tool-call batch.",
            )
        return None

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        scoped_request = self._filter_tools(request)
        submitted_message = _successful_runtime_result_message(
            scoped_request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        if submitted_message is not None:
            return _stamp_catalog_observation(
                AIMessage(content=submitted_message),
                self._catalog_observation(scoped_request),
            )
        automatic_result = (
            _automatic_prototype_result_message(
                scoped_request.state,
                self._run_id,
                self._runtime_attempt_id,
            )
            if self._prototype_stage_gate_enabled
            else None
        )
        if automatic_result is not None:
            return _stamp_catalog_observation(
                automatic_result,
                self._catalog_observation(scoped_request),
            )
        return _stamp_catalog_observation(
            handler(scoped_request),
            self._catalog_observation(scoped_request),
        )

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
        blocked = self._prototype_stage_preflight(request)
        if blocked is not None:
            return blocked
        blocked = self._prototype_publication_preflight(request)
        if blocked is not None:
            return blocked
        if request.tool_call.get("name") == READ_FILE_TOOL_NAME:
            blocked = self._prototype_reference_preflight(request)
            if blocked is not None:
                return blocked
        result = self._prd_postflight(request, handler(request))
        return self._prototype_reference_postflight(request, result)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        scoped_request = self._filter_tools(request)
        submitted_message = _successful_runtime_result_message(
            scoped_request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        if submitted_message is not None:
            return _stamp_catalog_observation(
                AIMessage(content=submitted_message),
                self._catalog_observation(scoped_request),
            )
        automatic_result = (
            _automatic_prototype_result_message(
                scoped_request.state,
                self._run_id,
                self._runtime_attempt_id,
            )
            if self._prototype_stage_gate_enabled
            else None
        )
        if automatic_result is not None:
            return _stamp_catalog_observation(
                automatic_result,
                self._catalog_observation(scoped_request),
            )
        return _stamp_catalog_observation(
            await handler(scoped_request),
            self._catalog_observation(scoped_request),
        )

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
        blocked = self._prototype_stage_preflight(request)
        if blocked is not None:
            return blocked
        blocked = self._prototype_publication_preflight(request)
        if blocked is not None:
            return blocked
        if request.tool_call.get("name") == READ_FILE_TOOL_NAME:
            blocked = self._prototype_reference_preflight(request)
            if blocked is not None:
                return blocked
        result = self._prd_postflight(request, await handler(request))
        return self._prototype_reference_postflight(request, result)
