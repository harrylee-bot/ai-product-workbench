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
import os
from pathlib import Path
import posixpath
import re
import stat
from typing import Annotated, Any, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelCallResult,
    ModelRequest,
    ModelResponse,
    PrivateStateAttr,
    hook_config,
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
PROTOTYPE_ONLY_TOOL_NAMES = (
    "workbench_prototype_patch_publish",
)
KNOWLEDGE_TOOL_NAME = "workbench_knowledge_retrieve"
READ_FILE_TOOL_NAME = "read_file"
GENERATION_STAGE_TOOL_NAME = "workbench_generation_stage_update"
ARTIFACT_DRAFT_TOOL_NAME = "workbench_artifact_draft_publish"
RUNTIME_RESULT_TOOL_NAME = "workbench_runtime_result_submit"
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
        "fe668773ece4fb6790a59e8dc9981482def6a959079c280080a8a99600ba97e9",
    ),
    (
        "/mnt/skills/public/requirement-doc-template/references/structure.md",
        "cfd9695845c2ad9bb1449bd912e8f491d008d69eb2ac88dbbe5d97868967299a",
    ),
    (
        "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
        "16f5019a156bd13648e2c2c7ed929392f1532473a739123a5f4ca1341aa113ee",
    ),
    (
        "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
        "c4354f95efa0eac1bc0cefc54a161498a09b336dd497cad954018b1d619281f1",
    ),
)
PROTOTYPE_REFERENCE_FILES = (
    (
        "/mnt/skills/public/workbench/references/prototype-runtime-result.example.json",
        "2998623ec6b2b4c2a35b77a57c6287432b1e3608c3512beb47ccc0681d0a0bf3",
    ),
    (
        "/mnt/skills/public/workbench/references/runtime-result-contract.md",
        "864f37398e06e59db8f8f7497eaf297da963d1ce75e0efe1208e660da25bdcbd",
    ),
)
_PROTOTYPE_REFERENCE_DIRECTORY = Path("/app/skills/public/workbench/references")
_PROTOTYPE_REFERENCE_MAX_BYTES = 65_536


def _prototype_transport_reference_context() -> str:
    references = []
    for virtual_path, expected_digest in PROTOTYPE_REFERENCE_FILES:
        # Only source-pinned filenames reach this reader. Model/tool arguments
        # never select a path, and symlinks/non-regular/oversized files fail closed.
        path = _PROTOTYPE_REFERENCE_DIRECTORY / posixpath.basename(virtual_path)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("WORKBENCH_PROTOTYPE_REFERENCE_FILE_INVALID")
                if not 0 < info.st_size <= _PROTOTYPE_REFERENCE_MAX_BYTES:
                    raise ValueError("WORKBENCH_PROTOTYPE_REFERENCE_SIZE_INVALID")
                content = source.read(_PROTOTYPE_REFERENCE_MAX_BYTES + 1)
                if len(content) != info.st_size:
                    raise ValueError("WORKBENCH_PROTOTYPE_REFERENCE_SIZE_INVALID")
        except OSError as exc:
            raise ValueError("WORKBENCH_PROTOTYPE_REFERENCE_UNAVAILABLE") from exc
        try:
            text = content.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("WORKBENCH_PROTOTYPE_REFERENCE_UTF8_INVALID") from exc
        if hashlib.sha256(content).hexdigest() != expected_digest:
            raise ValueError("WORKBENCH_PROTOTYPE_REFERENCE_CONTENT_MISMATCH")
        references.append(f"<reference name=\"{path.name}\" sha256=\"{expected_digest}\">\n{text}\n</reference>")
    return (
        "<workbench_prototype_transport_context>\n"
        "These verified references describe transport structure only. Example business content, IDs, URLs, "
        "citations and sources are not authorized facts and must not be copied as project evidence. Author "
        "the Prototype from the current request, its accepted PRD when present, and real authorized Knowledge "
        "retrieval; create appropriate IDs and copy citations only from successful retrieval. "
        "These references are already provided in full: ignore their generic instructions to read files or "
        "inspect other schemas. read_file still accepts only the four PRD paths during their collecting window, "
        "and is unavailable for Prototype-only Runs. This context grants no extra tools or filesystem access. "
        "In a linked Run keep the accepted PRD immutable, publish the Prototype at artifact_index 1, and submit "
        "both exact accepted Drafts in PRD/Prototype order by copying each accepted ACK's "
        "finalSubmissionArtifact into candidate.artifacts. These draftReference entries preserve the "
        "accepted content without rewriting it. The example's single-Prototype Result does not "
        "replace that linked contract.\n"
        + "\n".join(references)
        + "\n</workbench_prototype_transport_context>"
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
_PRD_CLARIFICATION_BLOCK_CODE = "WORKBENCH_PRD_CLARIFICATION_NOT_SUPPORTED"
_WORKBENCH_CLARIFICATION_BLOCK_CODE = "WORKBENCH_CLARIFICATION_NOT_SUPPORTED"
_PRD_REFERENCE_ROOT = "/mnt/skills/public/"
_PRD_REFERENCE_RELATIVE_PATHS = tuple(
    path.removeprefix(_PRD_REFERENCE_ROOT) for path, _digest in PRD_REFERENCE_FILES
)
_PRD_STAGE_PROTOCOL = "workbench.runtime.generation-stage.v1"
_PRD_DRAFT_PROTOCOL = "workbench.runtime.artifact-draft.v1"
_PRD_RESULT_PROTOCOL = "workbench.runtime.validated-result.v1"
_RUNTIME_RESULT_PROTOCOL = "workbench.runtime.result.v1"
_AUTOMATIC_PRD_RESULT_CALL_PREFIX = "workbench_auto_prd_result_"
_PRD_SEGMENTED_DRAFT_INSTRUCTIONS = """After all PRD stages, use workbench_artifact_draft_publish at artifact_index 0. Start with the actual PRD v3 title, operation, evidence, and document-level fields, including the planned table of contents, and set draft.content.sections to {}. The expected rejection keeps the candidate private and returns its candidateChecksum. Continue through repair only, using the latest rejected ACK's checksum as baseCandidateChecksum. Call the Draft tool alone and wait for each ACK.
Use prdAssembly.nextOperation to assemble the introduction and then the businessRequirements title, summary, pageLinks and functionSections. Copy fixed values exactly. Append each planned function section at /content/sections/businessRequirements/functionSections/- in reading order. For large sections, append a header with empty blocks and diagrams. Group small, related complete blocks or table rows in one ordered repair, and use smaller separate calls when a group would exceed the provider output limit. Complete every planned function section, then add /content/sections/degradation and /content/sections/safetyBaseline. Fill document-level gaps and fix exact validation issues using the latest ACK, preserving already written material. The Runtime accepts only the fully validated Draft."""
_PRD_CLARIFICATION_SYSTEM_POLICY = f"""<workbench_prd_clarification_policy>
This PRD-only Workbench Run cannot resume free-form clarification. The ask_clarification tool is unavailable. Ignore any general instruction that requires clarification for this Run. Do not ask a question or end early. Keep unsupported high-risk behavior out of committed scope, record conservative typed assumptions or acceptance boundaries, and finish one validated PRD Draft. After that Draft succeeds, do not call a Draft or Result tool; the trusted Runtime submits the exact normalized Draft and stops after validation succeeds. If that automatic Result reports validation issues, keep the successful Draft immutable, repair only the reported paths in one complete manual Result candidate, and continue only through manual Result validation; the Runtime does not repeat automatic submission.
{_PRD_SEGMENTED_DRAFT_INSTRUCTIONS}
</workbench_prd_clarification_policy>"""
_PROTOTYPE_CLARIFICATION_SYSTEM_POLICY = """<workbench_prototype_clarification_policy>
This Workbench Prototype Run has a fixed, trusted input and cannot resume free-form clarification. The ask_clarification tool is unavailable. Do not ask a question or end early. Use the supplied workbench_context and verified transport references, make conservative assumptions for nonessential details, and complete the Prototype stages and final workbench_runtime_result_submit call.
Implement the controls and observable behavior in the confirmed requirements, even for a new prototype with no source revision. Native search and select controls are kind="input", with inputType="search" or inputType="select". Select options require label, value, and disabled. Each requested screen needs a distinct route, its own root, and its own initial state. Link the relevant screen changes to actionable controls. Keep the declared screens, bindings and actions when fixing rejected draft paths, and check the approved interactions before final submission.
</workbench_prototype_clarification_policy>"""
_LINKED_PRD_SYSTEM_POLICY = f"""<workbench_linked_prd_policy>
This Workbench Run requests a linked PRD and Prototype. Free-form clarification is unavailable; record conservative typed assumptions for unsupported behavior. Complete the PRD reference reads and all PRD stages, then finish one validated PRD Draft. Keep that accepted Draft unchanged. Continue with the Prototype stages and a complete Prototype Draft at artifact_index 1 based on that PRD. Finally call workbench_runtime_result_submit with candidate containing protocol, a concise message, and artifacts copied from the two accepted ACKs' finalSubmissionArtifact fields in PRD/Prototype order. Each entry is {{"draftReference":{{"artifactIndex":0,"draftChecksum":"the exact accepted ACK checksum"}}}} with its own index and checksum. Do not rewrite accepted title, content, operation, or citations, invent a checksum, or mix a reference with artifact fields. The trusted tool resolves the explicit references and validates the complete unchanged Result. A PRD Draft alone does not finish this Run; there is no automatic PRD-only submission.
The read_file tool accepts only the four fixed PRD reference paths, only after collecting-prd-context and before structuring-prd. It cannot read Prototype references. After a Draft validation rejection, use workbench_artifact_draft_publish with repair and the latest rejected ACK's candidateChecksum as baseCandidateChecksum. Submit only the necessary JSON Patch operations and omit draft; preserve all other authored content. Use a move operation to relocate an existing complete section rather than rewriting it. Call repair alone in its tool-call batch. Do not repeat completed stages or reference reads, and do not stop with a request for the user to retry.
{_PRD_SEGMENTED_DRAFT_INSTRUCTIONS}
</workbench_linked_prd_policy>"""
_TOOL_CATALOG_PROTOCOL = "workbench.runtime.tool-catalog-observation.v1"
_TOOL_CATALOG_METADATA_KEY = "workbench_tool_catalog_observation"
_TOOL_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,127}$")
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
_LINKED_DRAFT_RECOVERY_KEY = "workbench_linked_draft_recovery"
_LINKED_DRAFT_RECOVERY_LIMIT = 2
_PRD_TOOL_JSON_RETRY_KEY = "workbench_prd_tool_json_retry"
_PRD_TOOL_JSON_RETRY_LIMIT = 3
_DRAFT_TOOL_JSON_TOTAL_RETRY_LIMIT = 12
_DRAFT_TOOL_JSON_RETRY_MAX_LEAD_IN = 256
_FORCED_STOP_MARKERS = ("[TOKEN BUDGET EXCEEDED]", "[FORCED STOP]", "[LOOP DETECTED]")


class WorkbenchToolScopeState(AgentState, total=False):
    # Checkpointed control state cannot be supplied through the graph input or
    # exposed as product output. Never use a HumanMessage as a retry counter:
    # it would reset the current-turn stage and reference evidence.
    workbench_linked_draft_recovery: Annotated[dict[str, Any], PrivateStateAttr]
    workbench_prd_tool_json_retry: Annotated[dict[str, Any], PrivateStateAttr]
    workbench_result_retry: Annotated[dict[str, str], PrivateStateAttr]


def _ordinary_model_stop(message: Any) -> bool:
    if not _is_ai_message(message) or _message_tool_calls(message):
        return False
    additional = _value(message, "additional_kwargs") or {}
    metadata = _value(message, "response_metadata") or {}
    if not isinstance(additional, Mapping) or not isinstance(metadata, Mapping):
        return False
    if (
        _value(message, "invalid_tool_calls")
        or additional.get("tool_calls")
        or additional.get("function_call")
        or additional.get("deerflow_error_fallback")
        or additional.get("safety_termination")
        or additional.get("error")
        or additional.get("refusal")
        or metadata.get("refusal")
        or metadata.get("safety_termination")
        or metadata.get("error")
        or metadata.get("deerflow_error_fallback")
    ):
        return False
    reasons = [
        container[key] for container in (metadata, additional)
        for key in ("finish_reason", "stop_reason") if container.get(key) is not None
    ]
    if not reasons or any(reason not in ("stop", "end_turn") for reason in reasons):
        return False
    content = _value(message, "content")
    if isinstance(content, list) and any(
        isinstance(block, Mapping) and block.get("type") == "refusal" for block in content
    ):
        return False
    text = content if isinstance(content, str) else "\n".join(
        block if isinstance(block, str) else str(block.get("text", ""))
        for block in content or [] if isinstance(block, (str, Mapping))
    )
    # These upstream middleware stops currently have no structured marker.
    return not any(marker in text for marker in _FORCED_STOP_MARKERS)


def _unrepaired_draft(
    state: Any, run_id: str, attempt_id: str, artifact_kinds: tuple[str, ...] = ("prd", "prototype"),
) -> dict[str, Any] | None:
    completed, invalid = _completed_tool_calls(state)
    if invalid:
        return None
    rejected: dict[int, dict[str, Any]] = {}
    for call in completed:
        artifact = _value(call["response"], "artifact")
        if not _tool_succeeded(call["response"]) or not _workbench_call_is_bound(
            artifact, call["id"], run_id, attempt_id,
        ) or not isinstance(artifact, Mapping):
            continue
        if artifact.get("protocol") == _PRD_RESULT_PROTOCOL and artifact.get("ok") is True:
            return None
        if call["name"] != ARTIFACT_DRAFT_TOOL_NAME or artifact.get("protocol") != _PRD_DRAFT_PROTOCOL:
            continue
        index = artifact.get("artifactIndex")
        try:
            candidate = _artifact_draft_from_declaration(
                {"messages": _state_messages(state)[:call["message_index"] + 1]},
                call, run_id, attempt_id,
            )
        except (ValueError, RuntimeError, ImportError):
            return None
        if (
            type(index) is not int or not 0 <= index < len(artifact_kinds)
            or call["args"].get("artifact_index") != index
            or not isinstance(candidate, Mapping)
            or candidate.get("kind") != artifact_kinds[index]
        ):
            continue
        if artifact.get("ok") is True:
            rejected.pop(index, None)
        elif artifact.get("ok") is False and isinstance(artifact.get("issues"), list) and artifact["issues"]:
            try:
                ack = json.loads(_tool_content(call["response"]) or "")
            except ValueError:
                ack = None
            checksum = ack.get("candidateChecksum") if (
                isinstance(ack, Mapping) and ack.get("protocol") == "workbench.runtime.artifact-draft-ack.v1"
                and ack.get("ok") is False and ack.get("artifactIndex") == index
            ) else None
            rejected[index] = {
                "toolCallId": call["id"], "artifactIndex": index, "responseIndex": call["response_index"],
                "candidate": candidate, "issues": artifact["issues"],
                "candidateChecksum": checksum if isinstance(checksum, str) and re.fullmatch("[a-f0-9]{64}", checksum) else None,
            }
    return max(rejected.values(), key=lambda item: item["responseIndex"], default=None)

def _can_repair_prototype(rejected: Mapping[str, Any]) -> bool:
    candidate = rejected["candidate"]
    content = candidate.get("content")
    operation = candidate.get("operation")
    return (
        candidate.get("kind") == "prototype" and type(candidate.get("schemaVersion")) is int
        and candidate["schemaVersion"] == 1
        and isinstance(operation, Mapping) and operation.get("kind") in ("create", "revise")
        and isinstance(content, Mapping) and content.get("protocol") == "workbench.prototype.v1"
        and all(isinstance(content.get(key), list) and content[key] for key in ("screens", "nodes"))
        and all(
            isinstance(issue, Mapping) and isinstance(issue.get("path"), list) and issue["path"]
            and issue["path"][0] in ("content", "citations", "title")
            for issue in rejected["issues"]
        )
    )

def _prototype_repair_drops_addressed_structure(rejected: Mapping[str, Any], repaired: Mapping[str, Any]) -> bool:
    previous = rejected["candidate"]["content"]
    next_content = repaired.get("content")
    if not isinstance(next_content, Mapping):
        return True
    for issue in rejected["issues"]:
        path = issue.get("path")
        if (
            not isinstance(path, list) or len(path) < 4 or path[0] != "content"
            or path[1] not in ("screens", "nodes") or type(path[2]) is not int
            or path[2] < 0 or path[3] == "id"
        ):
            continue
        collection, index = path[1], path[2]
        original_items = previous[collection]
        if index >= len(original_items) or not isinstance(original_items[index], Mapping):
            continue
        original = original_items[index]
        if collection == "nodes" and original.get("kind") not in ("input", "select", "form"):
            continue
        identity = original.get("id")
        if not isinstance(identity, str) or not identity or sum(
            isinstance(item, Mapping) and item.get("id") == identity for item in original_items
        ) != 1:
            continue
        items = next_content.get(collection)
        if not isinstance(items, list) or not any(
            isinstance(item, Mapping) and item.get("id") == identity
            and (collection == "screens" or item.get("kind") in ("input", "select", "form"))
            for item in items
        ):
            return True
    return False


def _is_llm_error_fallback_message(message: Any) -> bool:
    """Identify DeerFlow's terminal provider-failure response marker."""
    additional_kwargs = getattr(message, "additional_kwargs", None)
    return (
        isinstance(additional_kwargs, Mapping)
        and additional_kwargs.get("deerflow_error_fallback") is True
    )


def _contains_llm_error_fallback(messages: Any) -> bool:
    if not isinstance(messages, (list, tuple)):
        return False
    return any(_is_llm_error_fallback_message(message) for message in messages)


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


def _artifact_draft_from_declaration(
    state: Any,
    call: Mapping[str, Any],
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> Mapping[str, Any] | None:
    """Resolve original declared arguments without rewriting model messages.

    Full Draft calls retain their existing causal equality. Repair calls derive
    the candidate from strictly paired current-turn history; the same helper is
    used by the real tool, including its Node canonical checksum verification.
    For a completed call, callers supply the historical state through its AI
    declaration, before its response, so later messages cannot become its base.
    """
    args = _tool_args(call.get("args"))
    if args.get("repair") is None:
        draft = args.get("draft")
        return draft if isinstance(draft, Mapping) else None
    if not run_id or not runtime_attempt_id:
        raise ValueError("WORKBENCH_ARTIFACT_DRAFT_REPAIR_SCOPE_MISSING")
    from deerflow_workbench_tools.artifact_draft_repair import resolve_artifact_draft_candidate

    return resolve_artifact_draft_candidate(
        state,
        run_id=run_id,
        runtime_attempt_id=runtime_attempt_id,
        tool_call_id=call.get("id"),
        artifact_index=args.get("artifact_index"),
        draft=args.get("draft"),
        repair=args.get("repair"),
    )


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


def _tool_call_was_declared(
    state: Any,
    *,
    name: str,
    call_id: str,
) -> bool:
    """Detect an in-flight model declaration before ToolNode has answered."""
    messages = _state_messages(state)
    turn_start = _current_turn_start(messages)
    if turn_start < 0:
        return False
    return any(
        call["name"] == name and call["id"] == call_id
        for message in messages[turn_start + 1 :]
        if _is_ai_message(message)
        for call in _message_tool_calls(message)
    )


def _has_pending_tool_call(state: Any, *, name: str) -> bool:
    """Return whether a named model call lacks its ToolNode response."""
    messages = _state_messages(state)
    turn_start = _current_turn_start(messages)
    if turn_start < 0:
        return False
    declared_ids = {
        call["id"]
        for message in messages[turn_start + 1 :]
        if _is_ai_message(message)
        for call in _message_tool_calls(message)
        if call["name"] == name
    }
    responded_ids = {
        call_id
        for message in messages[turn_start + 1 :]
        if _is_tool_message(message)
        for call_id in [_value(message, "tool_call_id")]
        if isinstance(call_id, str)
    }
    return any(call_id not in responded_ids for call_id in declared_ids)


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


def _workbench_call_is_bound(
    artifact: Any,
    call_id: str,
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> bool:
    if run_id is None or runtime_attempt_id is None:
        return True
    return (
        isinstance(artifact, Mapping)
        and artifact.get("runId") == run_id
        and artifact.get("runtimeAttemptId") == runtime_attempt_id
        and artifact.get("toolCallId") == call_id
    )


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


def _reference_progress(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[frozenset[int], bool]:
    completed, invalid = _completed_tool_calls(state)
    collecting_response_index = -1
    if run_id is not None and runtime_attempt_id is not None:
        collecting_calls = []
        for call in completed:
            if (
                call["name"] != GENERATION_STAGE_TOOL_NAME
                or not _tool_succeeded(call["response"])
                or call["args"].get("stage") != PRD_STAGE_SEQUENCE[0]
            ):
                continue
            artifact = _value(call["response"], "artifact")
            if (
                _workbench_call_is_bound(
                    artifact,
                    call["id"],
                    run_id,
                    runtime_attempt_id,
                )
                and isinstance(artifact, Mapping)
                and artifact.get("protocol") == _PRD_STAGE_PROTOCOL
                and artifact.get("stage") == PRD_STAGE_SEQUENCE[0]
            ):
                collecting_calls.append(call)
        if len(collecting_calls) != 1:
            return frozenset(), invalid or len(collecting_calls) > 1
        collecting_response_index = collecting_calls[0]["response_index"]

    reference_batches: dict[int, list[dict[str, Any]]] = {}
    for call in completed:
        if call["name"] != READ_FILE_TOOL_NAME:
            continue
        if call["message_index"] <= collecting_response_index:
            continue
        if not _workbench_call_is_bound(
            _value(call["response"], "artifact"),
            call["id"],
            run_id,
            runtime_attempt_id,
        ):
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


def _stage_progress(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[int, bool]:
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
            or not _workbench_call_is_bound(
                artifact,
                call["id"],
                run_id,
                runtime_attempt_id,
            )
        ):
            continue
        successful_stages.append(stage)
    if successful_stages != list(PRD_STAGE_SEQUENCE[: len(successful_stages)]):
        invalid = True
    if len(successful_stages) > len(PRD_STAGE_SEQUENCE):
        invalid = True
    return len(successful_stages), invalid


def _prototype_stage_progress(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
    *,
    allow_prd_stages: bool = False,
) -> tuple[int, bool]:
    completed, invalid = _completed_tool_calls(state)
    successful_stages: list[str] = []
    for call in completed:
        if call["name"] != GENERATION_STAGE_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        stage = call["args"].get("stage")
        if allow_prd_stages and stage in PRD_STAGE_SEQUENCE:
            continue
        artifact = _value(call["response"], "artifact")
        if not _workbench_call_is_bound(
            artifact,
            call["id"],
            run_id,
            runtime_attempt_id,
        ):
            continue
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


def _successful_prd_drafts(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[int, bool]:
    completed, invalid = _completed_tool_calls(state)
    count = 0
    for call in completed:
        if call["name"] != ARTIFACT_DRAFT_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        artifact = _value(call["response"], "artifact")
        draft = artifact.get("draft") if isinstance(artifact, Mapping) else None
        if (
            _workbench_call_is_bound(
                artifact,
                call["id"],
                run_id,
                runtime_attempt_id,
            )
            and isinstance(artifact, Mapping)
            and artifact.get("protocol") == _PRD_DRAFT_PROTOCOL
            and artifact.get("ok") is True
            and isinstance(draft, Mapping)
            and draft.get("kind") == "prd"
        ):
            count += 1
    return count, invalid or count > 1


def _successful_prd_draft_from_call(
    call: Mapping[str, Any],
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> tuple[dict[str, Any], int] | None:
    if call["name"] != ARTIFACT_DRAFT_TOOL_NAME or not _tool_succeeded(call["response"]):
        return None
    artifact = _value(call["response"], "artifact")
    draft = artifact.get("draft") if isinstance(artifact, Mapping) else None
    artifact_index = artifact.get("artifactIndex") if isinstance(artifact, Mapping) else None
    if (
        run_id is None
        or runtime_attempt_id is None
        or not isinstance(artifact, Mapping)
        or artifact.get("runId") != run_id
        or artifact.get("runtimeAttemptId") != runtime_attempt_id
        or artifact.get("toolCallId") != call["id"]
    ):
        return None
    if (
        artifact.get("protocol") == _PRD_DRAFT_PROTOCOL
        and artifact.get("ok") is True
        and isinstance(draft, Mapping)
        and draft.get("kind") == "prd"
        and isinstance(artifact_index, int)
        and not isinstance(artifact_index, bool)
        and 0 <= artifact_index < 20
    ):
        return dict(draft), artifact_index
    return None


def _successful_prd_draft(
    state: Any,
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> tuple[dict[str, Any] | None, int | None, bool]:
    completed, invalid = _completed_tool_calls(state)
    drafts = [
        draft
        for call in completed
        if (draft := _successful_prd_draft_from_call(
            call,
            run_id,
            runtime_attempt_id,
        )) is not None
    ]
    if len(drafts) != 1:
        return None, None, invalid or len(drafts) > 1
    return drafts[0][0], drafts[0][1], invalid


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
    if not _workbench_call_is_bound(artifact, call["id"], run_id, runtime_attempt_id):
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


def _successful_runtime_results(
    state: Any,
    run_id: str | None = None,
    runtime_attempt_id: str | None = None,
) -> tuple[int, bool]:
    completed, invalid = _completed_tool_calls(state)
    count = 0
    for call in completed:
        if call["name"] != RUNTIME_RESULT_TOOL_NAME or not _tool_succeeded(call["response"]):
            continue
        artifact = _value(call["response"], "artifact")
        if (
            _workbench_call_is_bound(
                artifact,
                call["id"],
                run_id,
                runtime_attempt_id,
            )
            and isinstance(artifact, Mapping)
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
            or artifact.get("toolCallId") != call["id"]
        ):
            continue
        result = _value(artifact, "result")
        message = _value(result, "message")
        messages.append(message.strip() if isinstance(message, str) else "")
    if len(messages) != 1:
        return None
    return messages[0] or "Workbench result submitted."


def _automatic_prd_result_message(
    state: Any,
    run_id: str | None,
    runtime_attempt_id: str | None,
) -> AIMessage | None:
    """Turn one validated PRD draft into the final result without re-emitting it."""
    if run_id is None or runtime_attempt_id is None:
        return None
    draft, artifact_index, draft_invalid = _successful_prd_draft(
        state,
        run_id,
        runtime_attempt_id,
    )
    successful_references, reference_invalid = _reference_progress(
        state,
        run_id,
        runtime_attempt_id,
    )
    stage_count, stage_invalid = _stage_progress(
        state,
        run_id,
        runtime_attempt_id,
    )
    result_count, result_invalid = _successful_runtime_results(
        state,
        run_id,
        runtime_attempt_id,
    )
    completed, completed_invalid = _completed_tool_calls(state)
    if (
        draft is None
        or artifact_index != 0
        or draft_invalid
        or reference_invalid
        or _missing_reference_indexes(successful_references)
        or stage_invalid
        or stage_count != len(PRD_STAGE_SEQUENCE)
        or result_invalid
        or completed_invalid
        or result_count > 0
    ):
        return None
    if _has_pending_tool_call(state, name=RUNTIME_RESULT_TOOL_NAME):
        return None

    candidate = {
        "protocol": _RUNTIME_RESULT_PROTOCOL,
        "message": "\u9700\u6c42\u8bf4\u660e\u4e66\u5df2\u751f\u6210\u3002",
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
    call_id = f"{_AUTOMATIC_PRD_RESULT_CALL_PREFIX}{digest}"
    if any(
        call["name"] == RUNTIME_RESULT_TOOL_NAME and call["id"] == call_id
        for call in completed
    ) or _tool_call_was_declared(
        state,
        name=RUNTIME_RESULT_TOOL_NAME,
        call_id=call_id,
    ):
        return None
    return AIMessage(
        content="",
        tool_calls=[{
            "id": call_id,
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


def _decode_prd_draft_call(message: AIMessage) -> AIMessage:
    invalid = message.invalid_tool_calls
    if message.tool_calls or len(invalid) != 1 or message.content or message.response_metadata.get("finish_reason") != "tool_calls":
        return message
    call = invalid[0]
    if call.get("name") != ARTIFACT_DRAFT_TOOL_NAME or not call.get("id"):
        return message
    for metadata in (message.additional_kwargs, message.response_metadata):
        if any(metadata.get(key) for key in ("refusal", "safety_termination", "error", "deerflow_error_fallback")):
            return message
    from deerflow_workbench_tools.prd_draft_json import decode_prd_draft_sections
    decoded = decode_prd_draft_sections(call.get("args"))
    if decoded is None:
        return message
    args, edits = decoded
    metadata = dict(message.response_metadata)
    metadata["workbench_prd_tool_json_recovery"] = {
        "originalSha256": hashlib.sha256(call["args"].encode()).hexdigest(), "insertedClosings": edits,
    }
    return message.model_copy(update={
        "response_metadata": metadata, "invalid_tool_calls": [],
        "tool_calls": [{"type": "tool_call", "id": call["id"], "name": ARTIFACT_DRAFT_TOOL_NAME, "args": args}],
    })


def _stamp_ai_message(message: AIMessage, observation: Mapping[str, Any], decode_prd: bool = False) -> AIMessage:
    if decode_prd:
        message = _decode_prd_draft_call(message)
    response_metadata = dict(message.response_metadata or {})
    response_metadata[_TOOL_CATALOG_METADATA_KEY] = dict(observation)
    return message.model_copy(update={"response_metadata": response_metadata})


def _stamp_model_response(
    response: ModelResponse[Any],
    observation: Mapping[str, Any],
    decode_prd: bool,
) -> ModelResponse[Any]:
    result_messages = _value(response, "result")
    if not isinstance(result_messages, list):
        return response
    return ModelResponse(
        result=[
            _stamp_ai_message(message, observation, decode_prd)
            if isinstance(message, AIMessage)
            else message
            for message in result_messages
        ],
        structured_response=_value(response, "structured_response"),
    )


def _stamp_catalog_observation(
    result: ModelCallResult,
    observation: Mapping[str, Any] | None,
    decode_prd: bool = False,
) -> ModelCallResult:
    if observation is None:
        return result
    if isinstance(result, AIMessage):
        return _stamp_ai_message(result, observation, decode_prd)
    if isinstance(result, ExtendedModelResponse):
        return ExtendedModelResponse(
            model_response=_stamp_model_response(result.model_response, observation, decode_prd),
            command=result.command,
        )
    if isinstance(result, ModelResponse) and isinstance(_value(result, "result"), list):
        return _stamp_model_response(result, observation, decode_prd)
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

    state_schema = WorkbenchToolScopeState

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
        self._requested_artifact_kinds = frozenset(normalized_kinds) if normalized_kinds is not None else None
        self._workbench_run_enabled = normalized_kinds is not None
        self._declared_canvas = frozenset(
            normalized_canvas["declaredTools"] if normalized_canvas is not None else ()
        )
        self._artifact_progress_enabled = normalized_kinds is not None and any(
            kind in {"prd", "prototype"} for kind in normalized_kinds
        )
        self._prototype_enabled = normalized_kinds is not None and "prototype" in normalized_kinds
        self._prd_gate_enabled = normalized_kinds is not None and "prd" in normalized_kinds
        self._clarification_disabled = normalized_kinds is not None and any(
            kind in {"prd", "prototype"} for kind in normalized_kinds
        )
        self._prd_auto_enabled = normalized_kinds == ["prd"]
        self._linked_draft_recovery_enabled = (
            normalized_kinds is not None and set(normalized_kinds) == {"prd", "prototype"}
        )
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

    def _prototype_transport_ready(self, state: Any, runtime: Any) -> bool:
        scope = _value(_value(runtime, "context"), "workbench")
        kinds = normalize_workbench_requested_artifact_kinds(_value(scope, "requestedArtifactKinds"))
        if (
            not self._run_id or not self._runtime_attempt_id
            or _value(scope, "runId") != self._run_id
            or _value(scope, "runtimeAttemptId") != self._runtime_attempt_id
            or kinds is None or frozenset(kinds) != self._requested_artifact_kinds
            or self._requested_artifact_kinds not in (frozenset({"prototype"}), frozenset({"prd", "prototype"}))
        ):
            return False
        result_count, result_invalid = _successful_runtime_results(state, self._run_id, self._runtime_attempt_id)
        if result_count or result_invalid:
            return False
        if self._requested_artifact_kinds == frozenset({"prototype"}):
            return True
        draft, index, invalid = _successful_prd_draft(state, self._run_id, self._runtime_attempt_id)
        references, reference_invalid = _reference_progress(state, self._run_id, self._runtime_attempt_id)
        stages, stage_invalid = _stage_progress(state, self._run_id, self._runtime_attempt_id)
        if (
            draft is None or index != 0 or invalid or reference_invalid or stage_invalid
            or len(references) != len(PRD_REFERENCE_FILES) or stages != len(PRD_STAGE_SEQUENCE)
        ):
            return False
        completed, _ = _completed_tool_calls(state)
        messages = _state_messages(state)
        stage_calls = [
            call for call in completed
            if call["name"] == GENERATION_STAGE_TOOL_NAME
            and _tool_succeeded(call["response"])
            and _value(call["response"], "name") == GENERATION_STAGE_TOOL_NAME
            and call["args"].get("stage") in PRD_STAGE_SEQUENCE
            and _value(_value(call["response"], "artifact"), "protocol") == _PRD_STAGE_PROTOCOL
            and _value(_value(call["response"], "artifact"), "stage") == call["args"]["stage"]
            and _workbench_call_is_bound(_value(call["response"], "artifact"), call["id"], self._run_id, self._runtime_attempt_id)
        ]
        if len(stage_calls) != len(PRD_STAGE_SEQUENCE):
            return False
        for stage_index, stage_call in enumerate(stage_calls):
            before_stage = {"messages": messages[:stage_call["message_index"]]}
            if _stage_progress(before_stage, self._run_id, self._runtime_attempt_id) != (stage_index, False):
                return False
            if stage_index == 1:
                preceding_references, preceding_invalid = _reference_progress(before_stage, self._run_id, self._runtime_attempt_id)
                if preceding_invalid or len(preceding_references) != len(PRD_REFERENCE_FILES):
                    return False
        for call in completed:
            if _successful_prd_draft_from_call(call, self._run_id, self._runtime_attempt_id) != (draft, 0):
                continue
            before_draft = {"messages": messages[:call["message_index"]]}
            if _stage_progress(before_draft, self._run_id, self._runtime_attempt_id) != (len(PRD_STAGE_SEQUENCE), False):
                return False
            artifact = _value(call["response"], "artifact")
            try:
                declared_draft = _artifact_draft_from_declaration(
                    {"messages": messages[:call["message_index"] + 1]},
                    call, self._run_id, self._runtime_attempt_id,
                )
            except (ValueError, RuntimeError, ImportError):
                return False
            if (
                _value(call["response"], "name") != ARTIFACT_DRAFT_TOOL_NAME
                or type(call["args"].get("artifact_index")) is not int or call["args"]["artifact_index"] != 0
                or declared_draft != draft
                or not isinstance(artifact.get("draftChecksum"), str)
                or re.fullmatch(r"[0-9a-f]{64}", artifact["draftChecksum"]) is None
            ):
                return False
            envelope = {key: artifact.get(key) for key in (
                "protocol", "runId", "runtimeAttemptId", "toolCallId", "artifactIndex", "ok", "draftChecksum",
            )}
            try:
                # The trusted Draft tool uses this Python serialization for its
                # metadata envelope. Its draftChecksum uses Node canonicalize;
                # recomputing that body digest with Python would reject valid
                # floats and Unicode keys. The accepted body must instead match
                # its causal declared args, or the exact repair reconstructed
                # from preceding paired declarations; final validation remains
                # authoritative. Never replace the model's original arguments.
                encoded = json.dumps(envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
                return hashlib.sha256(encoded).hexdigest() == artifact.get("checksum")
            except (TypeError, ValueError):
                return False
        return False

    def _prd_tool_json_retry_scope(self, runtime: Any) -> bool:
        if self._linked_recovery_scope(runtime):
            return True
        scope = _value(_value(runtime, "context"), "workbench")
        return bool(
            self._prd_auto_enabled and self._run_id and self._runtime_attempt_id
            and _value(scope, "runId") == self._run_id
            and _value(scope, "runtimeAttemptId") == self._runtime_attempt_id
            and normalize_workbench_requested_artifact_kinds(_value(scope, "requestedArtifactKinds")) == ["prd"]
        )

    def _prd_tool_json_retry_marker(self, state: Any) -> Mapping[str, Any] | None:
        marker = _value(state, _PRD_TOOL_JSON_RETRY_KEY)
        if not isinstance(marker, Mapping) or (
            marker.get("runId"), marker.get("runtimeAttemptId")
        ) != (self._run_id, self._runtime_attempt_id):
            return None
        total = marker.get("totalAttempts", marker.get("count"))
        checksum = marker.get("candidateChecksum")
        if (
            type(marker.get("count")) is not int
            or not 1 <= marker["count"] <= _PRD_TOOL_JSON_RETRY_LIMIT
            or type(total) is not int or not marker["count"] <= total <= _DRAFT_TOOL_JSON_TOTAL_RETRY_LIMIT
            or (checksum is not None and (not isinstance(checksum, str) or not re.fullmatch("[a-f0-9]{64}", checksum)))
            or any(not isinstance(marker.get(key), str) or not marker[key] for key in ("messageId", "taskId"))
            or type(marker.get("repair")) is not bool
            or marker.get("kind", "prd") not in ("prd", "prototype")
        ):
            raise ValueError("WORKBENCH_PRD_TOOL_JSON_RETRY_STATE_INVALID")
        return marker

    def _malformed_draft_target(self, state: Any, runtime: Any) -> tuple[str, int, str | None] | None:
        if self._prd_tool_json_retry_scope(runtime):
            references, reference_invalid = _reference_progress(state, self._run_id, self._runtime_attempt_id)
            stages, stage_invalid = _stage_progress(state, self._run_id, self._runtime_attempt_id)
            drafts, draft_invalid = _successful_prd_drafts(state, self._run_id, self._runtime_attempt_id)
            if (
                not reference_invalid and not stage_invalid and not draft_invalid and not drafts
                and not _missing_reference_indexes(references)
            ):
                if stages == len(PRD_STAGE_SEQUENCE):
                    return "prd", 0, None
                if stages == len(PRD_STAGE_SEQUENCE) - 1:
                    return "prd", 0, PRD_STAGE_SEQUENCE[-1]
        if not self._prototype_transport_ready(state, runtime):
            return None
        linked = self._requested_artifact_kinds == frozenset({"prd", "prototype"})
        stages, stage_invalid = _prototype_stage_progress(
            state, self._run_id, self._runtime_attempt_id, allow_prd_stages=linked,
        )
        draft, _, draft_invalid = _successful_prototype_draft(state, self._run_id, self._runtime_attempt_id)
        if not stage_invalid and not draft_invalid and draft is None and stages == len(PROTOTYPE_STAGE_SEQUENCE):
            return "prototype", int(linked), None
        return None

    def _recover_draft_tool_json(self, state: AgentState, runtime: Any) -> dict[str, Any] | None:
        if (
            state.get("jump_to") is not None
            or state.get("__interrupt__")
            or state.get("interrupts")
            or _value(_value(runtime, "control"), "drain_requested")
        ):
            return None
        messages = _state_messages(state)
        message = messages[-1] if messages else None
        if not isinstance(message, AIMessage) or message.tool_calls:
            return None
        # The provider may return a short lead-in before its known Draft call.
        # Structured refusal content and terminal middleware markers still stop.
        if message.content and (
            not isinstance(message.content, str)
            or len(message.content) > _DRAFT_TOOL_JSON_RETRY_MAX_LEAD_IN
            or any(marker in message.content for marker in _FORCED_STOP_MARKERS)
        ):
            return None
        invalid = message.invalid_tool_calls
        metadata, additional = message.response_metadata, message.additional_kwargs
        raw_calls = additional.get("tool_calls")
        finish_reason = metadata.get("finish_reason")
        if (
            len(invalid) != 1 or invalid[0].get("name") != ARTIFACT_DRAFT_TOOL_NAME
            or not isinstance(invalid[0].get("id"), str) or not invalid[0]["id"]
            or not isinstance(invalid[0].get("args"), str) or not invalid[0]["args"]
            or finish_reason not in ("tool_calls", "length") or additional.get("function_call")
            or (raw_calls is not None and (
                not isinstance(raw_calls, list) or len(raw_calls) != 1
                or _value(raw_calls[0], "id") != invalid[0]["id"]
                or _value(_value(raw_calls[0], "function"), "name") != ARTIFACT_DRAFT_TOOL_NAME
            ))
            or any(container.get(key) for container in (metadata, additional)
                   for key in ("refusal", "safety_termination", "error", "deerflow_error_fallback"))
            or any(container.get(key) not in (None, finish_reason) for container in (metadata, additional)
                   for key in ("finish_reason", "stop_reason"))
        ):
            return None
        message_id = message.id
        task_id = _value(_value(runtime, "execution_info"), "task_id")
        if any(not isinstance(value, str) or not value for value in (message_id, task_id)):
            return None
        history = {"messages": messages[:-1]}
        target = self._malformed_draft_target(history, runtime)
        if target is None:
            return None
        kind, artifact_index, next_stage = target
        marker = self._prd_tool_json_retry_marker(state)
        draft_kinds = ("prototype",) if kind == "prototype" and artifact_index == 0 else ("prd", "prototype")
        rejected = _unrepaired_draft(history, self._run_id, self._runtime_attempt_id, draft_kinds)
        repair = rejected is not None and rejected["artifactIndex"] == artifact_index
        checksum = rejected["candidateChecksum"] if repair else None
        same_kind = marker is not None and marker.get("kind", "prd") == kind
        same_candidate = same_kind and (checksum is None or marker.get("candidateChecksum") == checksum)
        count = marker["count"] if same_candidate else 0
        total = marker.get("totalAttempts", marker["count"]) if marker else 0
        replay = same_candidate and marker["taskId"] == task_id
        stage_retry_exhausted = next_stage is not None and count >= 1
        if not replay and (
            stage_retry_exhausted or count >= _PRD_TOOL_JSON_RETRY_LIMIT
            or total >= _DRAFT_TOOL_JSON_TOTAL_RETRY_LIMIT
        ):
            return {"jump_to": "end"}
        # The reducer replaces the malformed declaration using the same ID.
        # Neither wire arguments nor an unanswered tool call go back to the model.
        return {
            "messages": [AIMessage(id=message_id, content=f"The {kind} draft tool arguments were malformed.")],
            "jump_to": "model",
            _PRD_TOOL_JSON_RETRY_KEY: {
                "runId": self._run_id, "runtimeAttemptId": self._runtime_attempt_id,
                "messageId": message_id, "taskId": task_id, "count": count if replay else count + 1,
                "kind": kind, "repair": repair, "totalAttempts": total if replay else total + 1,
                "candidateChecksum": checksum if checksum is not None or not same_candidate else marker.get("candidateChecksum"),
            },
        }

    def _draft_tool_json_retry_policy(self, request: ModelRequest) -> str | None:
        marker = self._prd_tool_json_retry_marker(request.state)
        messages = _state_messages(request.state)
        if not marker or not messages or _value(messages[-1], "id") != marker["messageId"]:
            return None
        target = self._malformed_draft_target(request.state, request.runtime)
        if target is None or target[0] != marker.get("kind", "prd"):
            return None
        kind, artifact_index, next_stage = target
        if next_stage is not None:
            return (
                "<workbench_prd_tool_json_retry>\n"
                "The malformed Draft arrived before the final PRD stage. "
                f"Call workbench_generation_stage_update with stage='{next_stage}' as the only next tool call. "
                "Wait for the successful stage ACK before submitting the initial PRD v3 draft with "
                "actual document-level fields and an empty sections object.\n"
                "</workbench_prd_tool_json_retry>"
            )
        if kind == "prototype":
            next_call = (
                "Send one small repair against the latest rejected Draft ACK's baseCandidateChecksum."
                if marker["repair"] else
                "Send a valid complete Prototype Draft. Keep all confirmed screens and actions. "
                "Use shared style tokens, concise object IDs and content, and the supplied Prototype schema. "
                "For large arguments, start with the structural Draft and add small groups of real nodes or actions "
                "with checksum-bound repairs until the complete confirmed scope validates."
            )
            return (
                "<workbench_prototype_tool_json_retry>\n"
                f"Retry workbench_artifact_draft_publish at artifact_index {artifact_index} as the only tool call. "
                "Check each delimiter and quote. Preserve the approved scope and prior stages. "
                + next_call + "\n</workbench_prototype_tool_json_retry>"
            )
        next_call = (
            "Use repair with baseCandidateChecksum copied from the latest rejected PRD Draft ACK. "
            "Send a single small operation. If an introduction section is too large, add its fixed title first, "
            "then add background, scope, and usageScenarios separately in later tool calls."
            if marker["repair"] else
            "Submit the initial PRD v3 draft with actual document-level fields and an empty sections object."
        )
        return (
            "<workbench_prd_tool_json_retry>\n"
            "Retry workbench_artifact_draft_publish now at artifact_index 0 as the only tool call. "
            "Check every nested delimiter and quote before sending the JSON arguments. "
            "Keep the already authored fields and use the existing generation stages and references. "
            + next_call + "\n</workbench_prd_tool_json_retry>"
        )

    def _linked_recovery_scope(self, runtime: Any) -> bool:
        context = _value(runtime, "context")
        scope = _value(context, "workbench")
        kinds = normalize_workbench_requested_artifact_kinds(_value(scope, "requestedArtifactKinds"))
        return bool(
            self._linked_draft_recovery_enabled and self._run_id and self._runtime_attempt_id
            and _value(scope, "runId") == self._run_id
            and _value(scope, "runtimeAttemptId") == self._runtime_attempt_id
            and kinds is not None and set(kinds) == {"prd", "prototype"}
        )

    def _linked_recovery_marker(self, state: Any) -> Mapping[str, Any] | None:
        marker = _value(state, _LINKED_DRAFT_RECOVERY_KEY)
        if not isinstance(marker, Mapping) or (
            marker.get("runId"), marker.get("runtimeAttemptId")
        ) != (self._run_id, self._runtime_attempt_id):
            return None
        if (
            marker.get("protocol") != "workbench.linked-draft-recovery.v1"
            or type(marker.get("count")) is not int
            or not 1 <= marker["count"] <= _LINKED_DRAFT_RECOVERY_LIMIT
            or any(not isinstance(marker.get(key), str) or not marker[key] for key in ("messageId", "toolCallId", "taskId"))
            or type(marker.get("artifactIndex")) is not int or marker["artifactIndex"] not in (0, 1)
            or ("exhausted" in marker and type(marker["exhausted"]) is not bool)
        ):
            raise ValueError("WORKBENCH_LINKED_DRAFT_REPAIR_STATE_INVALID")
        return marker

    def _rejected_draft_for_recovery(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if self._linked_recovery_scope(runtime):
            return _unrepaired_draft(state, self._run_id, self._runtime_attempt_id)
        if self._requested_artifact_kinds == frozenset({"prototype"}) and self._prototype_transport_ready(state, runtime):
            rejected = _unrepaired_draft(state, self._run_id, self._runtime_attempt_id, ("prototype",))
            if rejected is not None and _can_repair_prototype(rejected):
                return rejected
        return None

    def _recover_rejected_draft_stop(self, state: AgentState, runtime: Any) -> dict[str, Any] | None:
        if (
            not self._prototype_enabled
            or state.get("jump_to") is not None
            or state.get("__interrupt__")
            or state.get("interrupts")
            or _value(_value(runtime, "control"), "drain_requested")
        ):
            return None
        messages = _state_messages(state)
        if not messages or not _ordinary_model_stop(messages[-1]):
            return None
        message_id = _value(messages[-1], "id")
        task_id = _value(_value(runtime, "execution_info"), "task_id")
        if any(not isinstance(value, str) or not value for value in (message_id, task_id)):
            return None
        rejected = self._rejected_draft_for_recovery(state, runtime)
        if rejected is None:
            return None
        marker = self._linked_recovery_marker(state)
        if marker is not None and marker.get("exhausted") is True:
            return {"jump_to": "end"}
        # Provider message IDs can be reused. Only the trusted graph task ID
        # distinguishes replay of this hook from a new model/after-model turn.
        if marker is not None and marker["taskId"] == task_id:
            return {"jump_to": "model"}
        count = marker["count"] if marker is not None else 0
        if count >= _LINKED_DRAFT_RECOVERY_LIMIT:
            # End the graph with the original rejection intact. The Worker
            # diagnoses that trusted failed Draft instead of losing the cause
            # behind a generic provider execution error. No Result is created.
            return {
                "jump_to": "end",
                _LINKED_DRAFT_RECOVERY_KEY: {
                    **marker, "messageId": message_id, "taskId": task_id, "exhausted": True,
                    "code": "WORKBENCH_LINKED_DRAFT_REPAIR_EXHAUSTED",
                },
            }
        return {
            "jump_to": "model",
            _LINKED_DRAFT_RECOVERY_KEY: {
                "protocol": "workbench.linked-draft-recovery.v1",
                "runId": self._run_id, "runtimeAttemptId": self._runtime_attempt_id,
                "count": count + 1, "messageId": message_id, "taskId": task_id, "exhausted": False,
                "toolCallId": rejected["toolCallId"], "artifactIndex": rejected["artifactIndex"],
            },
        }

    def _rejected_draft_repair_policy(self, request: ModelRequest) -> str | None:
        marker = self._linked_recovery_marker(request.state)
        messages = _state_messages(request.state)
        if marker is None or marker.get("exhausted") or not messages or _value(messages[-1], "id") != marker["messageId"]:
            return None
        rejected = self._rejected_draft_for_recovery(request.state, request.runtime)
        if rejected is None or rejected["toolCallId"] != marker["toolCallId"]:
            return None
        if not self._linked_draft_recovery_enabled:
            return (
                "<workbench_prototype_draft_repair>\n"
                "The Prototype Draft was rejected. Use the latest ACK's candidateChecksum as "
                "baseCandidateChecksum, copy any applicable prototypeGraphRepair, and fix the precise "
                "reported fields in one repair-only call. Preserve the confirmed screens, controls, "
                "bindings and actions. Once the complete Draft validates, copy finalSubmissionArtifact "
                "into workbench_runtime_result_submit. Continue with the tool before ending the turn.\n"
                "</workbench_prototype_draft_repair>"
            )
        semantic_guidance = ""
        if rejected["candidate"].get("kind") == "prd":
            for issue in rejected["issues"]:
                if not isinstance(issue, Mapping):
                    continue
                path, message = issue.get("path"), issue.get("message")
                if (
                    isinstance(path, list) and len(path) == 6
                    and path[:4] == ["content", "sections", "safetyBaseline", "rows"]
                    and path[-1] == "applicability"
                    and message == "a safety row marked 否 requires a concrete remediation for the same safety topic in the requirement body"
                ):
                    semantic_guidance += (
                        "For the reported safety row, recheck whether the existing requirement body supports its current "
                        "applicability. A 否 row needs a concrete remediation for that same topic in the requirement "
                        "body, not just in remarks. If the body instead supports 是 or 不涉及, correct applicability "
                        "and remarks together. Do not invent a safety fact or new remediation. "
                    )
                if (
                    path == ["content", "sections", "businessRequirements", "functionSections"]
                    and message == "acceptance dimensions must be represented by distinct rows"
                ):
                    semantic_guidance += (
                        "Use the latest ACK's acceptanceCoverage conflict to find the dimensions sharing too few "
                        "rows. Split an existing combined check into separate verifiable rows for those dimensions, "
                        "using only confirmed conditions and observable results. Preserve existing IDs and links, "
                        "and update both directions for any new criterion ID. A mirrored table and typed check count "
                        "once. Do not add unrelated cases. "
                    )
        return (
            "<workbench_linked_draft_repair>\n"
            f"The Draft at artifact_index {marker['artifactIndex']} was rejected, and no complete Result exists. "
            "Continue this Run now: call workbench_artifact_draft_publish with repair, using the latest "
            "rejected ACK's candidateChecksum as baseCandidateChecksum and only the necessary JSON Patch "
            "operations. Omit draft and preserve every other field. Relocate complete existing "
            "sections with move instead of rewriting them. Call repair alone in its tool-call batch. "
            "Do not repeat completed generation stages or read_file calls. read_file accepts only the four PRD "
            "references during collecting-prd-context; use their already-read contract, not a new reference read. "
            "Do not ask the user to retry or end with a prose summary. "
            + semantic_guidance +
            "After validation succeeds, continue the "
            "remaining linked workflow and submit both accepted ACKs' finalSubmissionArtifact references "
            "through workbench_runtime_result_submit without rewriting either Draft.\n"
            "</workbench_linked_draft_repair>"
        )

    def _result_reference_candidate(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if not self._prototype_transport_ready(state, runtime):
            return None
        linked = self._linked_recovery_scope(runtime)
        stage_count, stage_invalid = _prototype_stage_progress(
            state, self._run_id, self._runtime_attempt_id, allow_prd_stages=linked,
        )
        if stage_invalid or stage_count != len(PROTOTYPE_STAGE_SEQUENCE):
            return None
        if any(_has_pending_tool_call(state, name=name)
               for name in (RUNTIME_RESULT_TOOL_NAME, ARTIFACT_DRAFT_TOOL_NAME, *PROTOTYPE_ONLY_TOOL_NAMES)):
            return None
        completed, invalid = _completed_tool_calls(state)
        if invalid:
            return None
        kinds = ["prd", "prototype"] if linked else ["prototype"]
        drafts = []
        references = []
        for index, kind in enumerate(kinds):
            receipts = [
                (call["response_index"], receipt)
                for call in completed
                if call["name"] == ARTIFACT_DRAFT_TOOL_NAME and _tool_succeeded(call["response"])
                and isinstance(receipt := _value(call["response"], "artifact"), Mapping)
                and receipt.get("protocol") == _PRD_DRAFT_PROTOCOL and receipt.get("ok") is True
                and receipt.get("artifactIndex") == index and call["args"].get("artifact_index") == index
                and _value(receipt.get("draft"), "kind") == kind
                and _workbench_call_is_bound(receipt, call["id"], self._run_id, self._runtime_attempt_id)
            ]
            if not receipts or (linked and len(receipts) != 1):
                return None
            position, receipt = receipts[-1]
            if kind == "prototype" and any(
                call["name"] in _PROTOTYPE_ONLY_TOOL_NAME_SET and call["response_index"] > position
                and _tool_succeeded(call["response"])
                and _value(_value(call["response"], "artifact"), "ok") is True
                for call in completed
            ):
                # A complete checkpoint must incorporate subsequent screen patches.
                return None
            checksum = receipt.get("draftChecksum")
            if not isinstance(checksum, str) or re.fullmatch(r"[0-9a-f]{64}", checksum) is None:
                return None
            drafts.append(receipt["draft"])
            references.append({"draftReference": {"artifactIndex": index, "draftChecksum": checksum}})
        scope = _value(_value(runtime, "context"), "workbench")
        operations = _value(scope, "outputOperations")
        if operations is not None and operations != [
            {"kind": draft.get("kind"), "operation": draft.get("operation")} for draft in drafts
        ]:
            return None
        candidate = {
            "protocol": _RUNTIME_RESULT_PROTOCOL,
            "message": "需求文档与原型已生成。" if linked else "原型已生成。",
            "artifacts": references,
        }
        try:
            from deerflow_workbench_tools.artifact_draft_repair import resolve_runtime_result_draft_references

            resolved, _normalizations = resolve_runtime_result_draft_references(
                state, candidate, run_id=self._run_id,
                runtime_attempt_id=self._runtime_attempt_id, requested_artifact_kinds=kinds,
            )
        except (ValueError, RuntimeError, ImportError):
            return None
        if not isinstance(resolved, Mapping) or resolved.get("artifacts") != drafts:
            return None
        return candidate

    def _result_reference_policy(self, request: ModelRequest) -> str | None:
        candidate = self._result_reference_candidate(request.state, request.runtime)
        if candidate is None:
            return None
        if not self._linked_draft_recovery_enabled:
            return (
                "<workbench_prototype_result_submission>\n"
                "The latest Prototype checkpoint is accepted. Its checksum is for Result submission, "
                "and cannot be used for repair. If the checkpoint covers the confirmed interactions, "
                "call workbench_runtime_result_submit alone using the exact reference below. "
                "For unfinished interactions, use screen patches and publish a new complete checkpoint "
                "before submitting. A prose response does not submit the result.\n"
                + json.dumps({"candidate": candidate}, ensure_ascii=False, separators=(",", ":"))
                + "\n</workbench_prototype_result_submission>"
            )
        return (
            "<workbench_linked_result_submission>\n"
            "Both exact Drafts are accepted in this Run. Call workbench_runtime_result_submit alone next "
            "with the following candidate; you may change only its concise message. These references were "
            "verified against the current accepted Drafts. Do not regenerate or copy their bodies, repeat "
            "stages, publish another Draft, or stop before the Result tool returns ok:true.\n"
            + json.dumps({"candidate": candidate}, ensure_ascii=False, separators=(",", ":"))
            + "\n</workbench_linked_result_submission>"
        )

    def _recover_result_stop(self, state: AgentState, runtime: Any) -> dict[str, Any] | None:
        if (
            not self._prototype_enabled or state.get("jump_to") is not None
            or state.get("__interrupt__") or state.get("interrupts")
            or _value(_value(runtime, "control"), "drain_requested")
        ):
            return None
        messages = _state_messages(state)
        task_id = _value(_value(runtime, "execution_info"), "task_id")
        if not messages or not _ordinary_model_stop(messages[-1]) or not isinstance(task_id, str) or not task_id:
            return None
        marker = state.get("workbench_result_retry")
        if isinstance(marker, Mapping) and (
            marker.get("runId"), marker.get("runtimeAttemptId")
        ) == (self._run_id, self._runtime_attempt_id):
            return {"jump_to": "model"} if marker.get("taskId") == task_id else None
        if self._result_reference_candidate(state, runtime) is None:
            return None
        return {
            "jump_to": "model",
            "workbench_result_retry": {
                "runId": self._run_id, "runtimeAttemptId": self._runtime_attempt_id, "taskId": task_id,
            },
        }

    def _filter_tools(self, request: ModelRequest) -> ModelRequest:
        visible = []
        for tool in request.tools:
            name = _tool_name(tool)
            if name == CLARIFICATION_TOOL_NAME and self._clarification_disabled:
                continue
            if name in _CANVAS_TOOL_NAME_SET and name not in self._declared_canvas:
                continue
            if name in _ARTIFACT_PROGRESS_TOOL_NAME_SET and not self._artifact_progress_enabled:
                continue
            if name in _PROTOTYPE_ONLY_TOOL_NAME_SET and not self._prototype_enabled:
                continue
            if name == KNOWLEDGE_TOOL_NAME and not self._knowledge_enabled:
                continue
            if name == READ_FILE_TOOL_NAME and not self._prd_gate_enabled:
                continue
            visible.append(tool)
        overrides: dict[str, Any] = {}
        if len(visible) != len(request.tools):
            overrides["tools"] = visible
        if self._clarification_disabled:
            if self._prd_gate_enabled:
                policy = (
                    _PRD_CLARIFICATION_SYSTEM_POLICY
                    if self._prd_auto_enabled
                    else _LINKED_PRD_SYSTEM_POLICY
                )
            else:
                policy = _PROTOTYPE_CLARIFICATION_SYSTEM_POLICY
            system_message = request.system_message
            system_text = system_message.text if system_message is not None else ""
            if policy not in system_text:
                overrides["system_message"] = SystemMessage(content=(
                    f"{system_text.rstrip()}\n\n{policy}"
                    if system_text.strip()
                    else policy
                ))
        repair_policy = self._draft_tool_json_retry_policy(request) or self._rejected_draft_repair_policy(request)
        if repair_policy is not None:
            system_message = overrides.get("system_message", request.system_message)
            system_text = system_message.text if system_message is not None else ""
            overrides["system_message"] = SystemMessage(content=f"{system_text.rstrip()}\n\n{repair_policy}".strip())
        if self._prototype_transport_ready(request.state, request.runtime):
            transport_context = _prototype_transport_reference_context()
            system_message = overrides.get("system_message", request.system_message)
            system_text = system_message.text if system_message is not None else ""
            if transport_context not in system_text:
                overrides["system_message"] = SystemMessage(content=f"{system_text.rstrip()}\n\n{transport_context}".strip())
        result_policy = self._result_reference_policy(request)
        if result_policy is not None:
            system_message = overrides.get("system_message", request.system_message)
            system_text = system_message.text if system_message is not None else ""
            if result_policy not in system_text:
                overrides["system_message"] = SystemMessage(content=f"{system_text.rstrip()}\n\n{result_policy}".strip())
        scoped_request = request if not overrides else request.override(**overrides)
        return scoped_request

    def _catalog_observation(self, request: ModelRequest) -> dict[str, Any] | None:
        if not self._knowledge_catalog_bound:
            return None
        return _tool_catalog_observation(list(request.tools))

    def _blocked_tool_message(self, request: ToolCallRequest) -> ToolMessage | None:
        name = request.tool_call.get("name")
        if not isinstance(name, str):
            return None
        if name == CLARIFICATION_TOOL_NAME and self._clarification_disabled:
            block_code = (
                _PRD_CLARIFICATION_BLOCK_CODE
                if self._prd_gate_enabled
                else _WORKBENCH_CLARIFICATION_BLOCK_CODE
            )
        elif name in _CANVAS_TOOL_NAME_SET and name not in self._declared_canvas:
            block_code = _CANVAS_BLOCK_CODE
        elif name in _ARTIFACT_PROGRESS_TOOL_NAME_SET and not self._artifact_progress_enabled:
            block_code = _ARTIFACT_PROGRESS_BLOCK_CODE
        elif name in _PROTOTYPE_ONLY_TOOL_NAME_SET and not self._prototype_enabled:
            block_code = _PROTOTYPE_BLOCK_CODE
        elif name == KNOWLEDGE_TOOL_NAME and not self._knowledge_enabled:
            block_code = _KNOWLEDGE_BLOCK_CODE
        elif name == READ_FILE_TOOL_NAME and not self._prd_gate_enabled:
            block_code = _PRD_REFERENCE_BLOCK_CODE
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
        successful_references, reference_invalid = _reference_progress(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        stage_count, stage_invalid = _stage_progress(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        draft_count, draft_invalid = _successful_prd_drafts(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        result_count, result_invalid = _successful_runtime_results(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
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
        declared_draft = _artifact_draft_from_declaration(
            request.state, request.tool_call, self._run_id, self._runtime_attempt_id,
        ) if request.tool_call.get("name") == ARTIFACT_DRAFT_TOOL_NAME else None
        is_prototype_draft = isinstance(declared_draft, Mapping) and declared_draft.get("kind") == "prototype"
        if draft_count > 0 and request.tool_call.get("name") == ARTIFACT_DRAFT_TOOL_NAME and not (self._prototype_enabled and is_prototype_draft):
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_DRAFT_ALREADY_PUBLISHED",
                "A validated PRD draft already exists for this turn; keep it immutable and continue the requested workflow without publishing another PRD draft.",
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
            and (request.tool_call.get("name") == RUNTIME_RESULT_TOOL_NAME or is_prototype_draft)
        ):
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_DRAFT_REQUIRED",
                "Publish the complete validated PRD candidate with workbench_artifact_draft_publish before final submission.",
            )
        return None

    def _draft_repair_preflight(self, request: ToolCallRequest) -> ToolMessage | None:
        batch = _current_batch_calls(request)
        repair_calls = [
            call for call in batch
            if call["name"] == ARTIFACT_DRAFT_TOOL_NAME and call["args"].get("repair") is not None
        ]
        # ToolNode executes every sibling from the same state snapshot, in both
        # sync and async modes. Reject the entire batch, including a sibling full
        # Draft, rather than letting one publication race with another.
        if repair_calls and len(batch) != 1:
            return _error_tool_message(
                request, "WORKBENCH_ARTIFACT_DRAFT_REPAIR_BATCH_INVALID",
                "Call the repair alone in a new tool-call batch so it can use the latest completed rejected candidate.",
            )
        args = _tool_args(request.tool_call.get("args"))
        if request.tool_call.get("name") != ARTIFACT_DRAFT_TOOL_NAME:
            return None
        rejected = None
        if self._prototype_enabled and self._run_id and self._runtime_attempt_id:
            kinds = ("prd", "prototype") if self._prd_gate_enabled else ("prototype",)
            prior = _unrepaired_draft(request.state, self._run_id, self._runtime_attempt_id, kinds)
            if prior is not None and prior["artifactIndex"] == args.get("artifact_index") and _can_repair_prototype(prior):
                rejected = prior
        if args.get("repair") is None:
            draft = args.get("draft")
            if rejected is not None and isinstance(draft, Mapping) and draft.get("kind") == "prototype":
                return _error_tool_message(
                    request, "WORKBENCH_PROTOTYPE_DRAFT_REPAIR_REQUIRED",
                    "Omit draft and call repair alone with the last rejected Prototype ACK's candidateChecksum "
                    "as baseCandidateChecksum. Fix its issue paths in small JSON Patch groups. Preserve the original "
                    "screens, controls, bindings, and actions while repairing their fields.",
                )
            return None
        try:
            repaired = _artifact_draft_from_declaration(
                request.state, request.tool_call, self._run_id, self._runtime_attempt_id,
            )
        except (ValueError, RuntimeError, ImportError) as error:
            if str(error) == "WORKBENCH_ARTIFACT_DRAFT_REPAIR_DRAFT_ALREADY_ACCEPTED":
                return _error_tool_message(
                    request, "WORKBENCH_ARTIFACT_DRAFT_ALREADY_ACCEPTED",
                    "The current checkpoint already passed validation. Reuse its accepted ACK's "
                    "finalSubmissionArtifact in workbench_runtime_result_submit when the requested "
                    "work is complete. A repair requires a rejected candidate.",
                )
            try:
                from deerflow_workbench_tools.artifact_draft_repair import repair_error_feedback

                feedback = repair_error_feedback(error)
            except ImportError:
                feedback = ""

            return _error_tool_message(
                request, "WORKBENCH_ARTIFACT_DRAFT_REPAIR_INVALID",
                "Use the latest rejected ACK's candidateChecksum for this run and artifact_index, omit draft, and repair only permitted paths. Accepted drafts are immutable."
                + feedback,
            )
        if rejected is not None and isinstance(repaired, Mapping) and _prototype_repair_drops_addressed_structure(rejected, repaired):
            return _error_tool_message(
                request, "WORKBENCH_PROTOTYPE_REPAIR_REMOVES_STRUCTURE",
                "Keep the screen or input named in the previous Prototype ACK. Correct the reported fields "
                "without removing the addressed screen, form, or input. Each screen has its own route, root node "
                "and initial state. Continue from that same ACK with a small repair.",
            )
        return None

    def _prd_reference_preflight(self, request: ToolCallRequest) -> ToolMessage | None:
        args = _tool_args(request.tool_call.get("args"))
        path = args.get("path")
        if not _reference_like_path(path):
            successful_references, _reference_invalid = _reference_progress(
                request.state,
                self._run_id,
                self._runtime_attempt_id,
            )
            missing_references = _missing_reference_indexes(successful_references)
            expected_index = missing_references[0] if missing_references else len(PRD_REFERENCE_FILES) - 1
            expected_path = PRD_REFERENCE_FILES[expected_index][0]
            return _error_tool_message(
                request,
                "WORKBENCH_PRD_REFERENCE_PATH_INVALID",
                f"Use the exact absolute Runtime path '{expected_path}'.",
            )
        reference_index = _reference_index(path)
        successful_references, reference_invalid = _reference_progress(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        stage_count, stage_invalid = _stage_progress(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
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
                if self._prototype_enabled:
                    count, invalid = _successful_prd_drafts(request.state, self._run_id, self._runtime_attempt_id)
                    if count == 1 and not invalid:
                        return None
                    return _error_tool_message(request, "WORKBENCH_PRD_DRAFT_REQUIRED", "Publish the validated PRD at artifact_index 0 before Prototype stages.")
                return _error_tool_message(
                    request,
                    "WORKBENCH_PRD_STAGE_FAMILY_INVALID",
                    "This PRD Run accepts only PRD generation stages; call the next required PRD stage instead.",
                )
            return None
        stage_count, stage_invalid = _stage_progress(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
        successful_references, reference_invalid = _reference_progress(
            request.state,
            self._run_id,
            self._runtime_attempt_id,
        )
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
            history_error = self._prd_history_error(request)
            if history_error is not None:
                return history_error
            if self._prototype_enabled:
                return self._linked_publication_preflight(request)
        return None

    def _linked_publication_preflight(self, request: ToolCallRequest) -> ToolMessage | None:
        args = _tool_args(request.tool_call.get("args"))
        is_result = request.tool_call.get("name") == RUNTIME_RESULT_TOOL_NAME
        if not is_result:
            draft = _artifact_draft_from_declaration(
                request.state, request.tool_call, self._run_id, self._runtime_attempt_id,
            )
            expected_index = 0 if isinstance(draft, Mapping) and draft.get("kind") == "prd" else 1
            if args.get("artifact_index") != expected_index:
                return _error_tool_message(
                    request, "WORKBENCH_LINKED_ARTIFACT_INDEX_INVALID",
                    "Publish the PRD at artifact_index 0 and its Prototype at artifact_index 1.",
                )
            if expected_index == 0:
                return None
        stage_count, invalid = _prototype_stage_progress(
            request.state, self._run_id, self._runtime_attempt_id, allow_prd_stages=True,
        )
        if invalid or stage_count != len(PROTOTYPE_STAGE_SEQUENCE):
            return _error_tool_message(
                request, "WORKBENCH_LINKED_PROTOTYPE_STAGES_REQUIRED",
                "Complete all Prototype stages in order after publishing the PRD Draft.",
            )
        prototype, index, invalid = _successful_prototype_draft(
            request.state, self._run_id, self._runtime_attempt_id,
        )
        if invalid or (not is_result and prototype is not None):
            return _error_tool_message(
                request, "WORKBENCH_LINKED_PROTOTYPE_DRAFT_DUPLICATE",
                "Keep the successful Prototype Draft immutable; submit both Drafts together.",
            )
        if is_result:
            prd, prd_index, prd_invalid = _successful_prd_draft(
                request.state, self._run_id, self._runtime_attempt_id,
            )
            candidate = args.get("candidate")
            if prototype is None or index != 1 or prd_invalid or prd is None or prd_index != 0:
                return _error_tool_message(
                    request, "WORKBENCH_LINKED_DRAFTS_REQUIRED",
                    "Publish the PRD Draft at index 0 and its Prototype Draft at index 1 before submitting.",
                )
            try:
                from deerflow_workbench_tools.artifact_draft_repair import resolve_runtime_result_draft_references

                candidate, _normalizations = resolve_runtime_result_draft_references(
                    request.state, candidate, run_id=self._run_id,
                    runtime_attempt_id=self._runtime_attempt_id,
                    requested_artifact_kinds=list(self._requested_artifact_kinds or ()),
                )
            except (ValueError, RuntimeError, ImportError):
                return _error_tool_message(
                    request, "WORKBENCH_RUNTIME_DRAFT_REFERENCE_INVALID",
                    "Copy each accepted ACK's finalSubmissionArtifact exactly into candidate.artifacts in "
                    "PRD/Prototype order. Do not mix draftReference with content or other Artifact fields.",
                )
            if not isinstance(candidate, Mapping) or candidate.get("artifacts") != [prd, prototype]:
                return _error_tool_message(
                    request, "WORKBENCH_LINKED_RESULT_DRAFT_MISMATCH",
                    "Submit the unchanged PRD and Prototype Drafts in that order, preferably by copying "
                    "the accepted ACKs' finalSubmissionArtifact references. Do not rewrite accepted content.",
                )
        return None

    def _prototype_preflight(self, request: ToolCallRequest) -> ToolMessage | None:
        if not self._prototype_enabled:
            return None
        name = request.tool_call.get("name")
        args = _tool_args(request.tool_call.get("args"))
        stage = args.get("stage")
        if name == GENERATION_STAGE_TOOL_NAME:
            if stage not in PROTOTYPE_STAGE_SEQUENCE:
                return None
        elif name == ARTIFACT_DRAFT_TOOL_NAME:
            draft = _artifact_draft_from_declaration(
                request.state, request.tool_call, self._run_id, self._runtime_attempt_id,
            )
            if isinstance(draft, Mapping) and draft.get("kind") != "prototype":
                return None
        elif name not in {RUNTIME_RESULT_TOOL_NAME, *PROTOTYPE_ONLY_TOOL_NAMES}:
            return None
        stage_count, invalid = _prototype_stage_progress(
            request.state, self._run_id, self._runtime_attempt_id,
            allow_prd_stages=self._prd_gate_enabled,
        )
        if invalid:
            return _error_tool_message(
                request, "WORKBENCH_PROTOTYPE_STAGE_HISTORY_INVALID",
                "The current run has conflicting successful Prototype stages; do not publish from this history.",
            )
        next_stage = PROTOTYPE_STAGE_SEQUENCE[stage_count] if stage_count < len(PROTOTYPE_STAGE_SEQUENCE) else None
        if name == GENERATION_STAGE_TOOL_NAME:
            stage_calls = [call for call in _current_batch_calls(request)
                           if call["name"] == GENERATION_STAGE_TOOL_NAME
                           and call["args"].get("stage") in PROTOTYPE_STAGE_SEQUENCE]
            position = next((index for index, call in enumerate(stage_calls)
                             if call["id"] == request.tool_call.get("id")), None)
            if position is None or position != 0:
                return _error_tool_message(
                    request, "WORKBENCH_PROTOTYPE_STAGE_BATCH_INVALID",
                    "Record only one real Prototype stage per model tool-call batch; wait for its successful ACK before the next stage.",
                )
            if stage != next_stage:
                instruction = (f"Begin the next phase with workbench_generation_stage_update(stage='{next_stage}')."
                               if next_stage else "All Prototype phases already succeeded; do not repeat stages when repairing a draft.")
                return _error_tool_message(request, "WORKBENCH_PROTOTYPE_STAGE_ORDER_INVALID", instruction)
            return None
        if next_stage is not None:
            return _error_tool_message(
                request, "WORKBENCH_PROTOTYPE_STAGES_REQUIRED",
                "New and edited Prototypes require this run's four real phases in order: design-system, mapping-components, creating-flows, generating-ui. "
                f"Begin the next phase with workbench_generation_stage_update(stage='{next_stage}'); wait for all four successful ACKs before publishing a draft, patch, or result. "
                "Earlier runs and unacknowledged calls in this batch do not count.",
            )
        if name in _PROTOTYPE_ONLY_TOOL_NAME_SET:
            drafts, invalid = _successful_prototype_drafts(request.state, self._run_id, self._runtime_attempt_id)
            checkpoint = next((draft for draft, index in reversed(drafts)
                               if index == args.get("artifact_index")), None)
            content = checkpoint.get("content") if isinstance(checkpoint, Mapping) else None
            screens = content.get("screens") if isinstance(content, Mapping) else None
            if invalid or not isinstance(screens, list) or not any(
                isinstance(screen, Mapping) and screen.get("id") == args.get("screen_id") for screen in screens
            ):
                return _error_tool_message(
                    request, "WORKBENCH_PROTOTYPE_PATCH_CHECKPOINT_REQUIRED",
                    "First publish a complete Prototype checkpoint for this artifact_index and screen_id in the current run and attempt; wait for its successful ACK before patching. Earlier runs and sibling calls do not count.",
                )
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
        if self._run_id is None or self._runtime_attempt_id is None:
            return result
        return result.model_copy(update={
            "artifact": {
                "protocol": "workbench.runtime.prd-reference-read.v1",
                "runId": self._run_id,
                "runtimeAttemptId": self._runtime_attempt_id,
                "toolCallId": request.tool_call.get("id"),
                "path": path,
                "sha256": expected_digest,
            },
        })

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
        automatic_prd_result = (
            _automatic_prd_result_message(
                scoped_request.state,
                self._run_id,
                self._runtime_attempt_id,
            )
            if self._prd_auto_enabled
            else None
        )
        if automatic_prd_result is not None:
            return _stamp_catalog_observation(
                automatic_prd_result,
                self._catalog_observation(scoped_request),
            )
        return _stamp_catalog_observation(
            handler(scoped_request),
            self._catalog_observation(scoped_request),
            self._prd_gate_enabled and bool(self._run_id and self._runtime_attempt_id),
        )

    @hook_config(can_jump_to=["end", "model"])
    def after_model(self, state: AgentState, runtime: Any = None) -> dict[str, Any] | None:
        if self._workbench_run_enabled and _contains_llm_error_fallback(state.get("messages")):
            return {"jump_to": "end"}
        return (
            self._recover_draft_tool_json(state, runtime)
            or self._recover_rejected_draft_stop(state, runtime)
            or self._recover_result_stop(state, runtime)
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
        blocked = self._draft_repair_preflight(request)
        if blocked is not None:
            return blocked
        blocked = self._prd_preflight(request)
        if blocked is not None:
            return blocked
        blocked = self._prototype_preflight(request)
        if blocked is not None:
            return blocked
        return self._prd_postflight(request, handler(request))

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
        automatic_prd_result = (
            _automatic_prd_result_message(
                scoped_request.state,
                self._run_id,
                self._runtime_attempt_id,
            )
            if self._prd_auto_enabled
            else None
        )
        if automatic_prd_result is not None:
            return _stamp_catalog_observation(
                automatic_prd_result,
                self._catalog_observation(scoped_request),
            )
        return _stamp_catalog_observation(
            await handler(scoped_request),
            self._catalog_observation(scoped_request),
            self._prd_gate_enabled and bool(self._run_id and self._runtime_attempt_id),
        )

    @hook_config(can_jump_to=["end", "model"])
    async def aafter_model(
        self,
        state: AgentState,
        runtime: Any = None,
    ) -> dict[str, Any] | None:
        if self._workbench_run_enabled and _contains_llm_error_fallback(state.get("messages")):
            return {"jump_to": "end"}
        return (
            self._recover_draft_tool_json(state, runtime)
            or self._recover_rejected_draft_stop(state, runtime)
            or self._recover_result_stop(state, runtime)
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
        blocked = self._draft_repair_preflight(request)
        if blocked is not None:
            return blocked
        blocked = self._prd_preflight(request)
        if blocked is not None:
            return blocked
        blocked = self._prototype_preflight(request)
        if blocked is not None:
            return blocked
        return self._prd_postflight(request, await handler(request))
