from __future__ import annotations

import hashlib
import json
from typing import Any

from langchain.tools import tool

from deerflow.tools.types import Runtime

from .runtime_result_validator import validate_runtime_artifact_draft


ARTIFACT_DRAFT_PROTOCOL = "workbench.runtime.artifact-draft.v1"


@tool(
    "workbench_artifact_draft_publish",
    parse_docstring=True,
    response_format="content_and_artifact",
)
def workbench_artifact_draft_publish(
    runtime: Runtime,
    artifact_index: int,
    draft: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    """Validate and publish one real 产品工作台 Artifact checkpoint.

    Call this after an Artifact becomes complete enough to render. Publish another
    checkpoint only after its renderable content materially changes.

    Args:
        artifact_index: Stable zero-based index used by the final Runtime result.
        draft: One complete Runtime Artifact draft object.
    """
    if isinstance(artifact_index, bool) or not isinstance(artifact_index, int):
        raise ValueError("WORKBENCH_ARTIFACT_DRAFT_INDEX_INVALID")
    if artifact_index < 0 or artifact_index >= 20:
        raise ValueError("WORKBENCH_ARTIFACT_DRAFT_INDEX_INVALID")

    context = runtime.context if isinstance(runtime.context, dict) else {}
    scope = context.get("workbench")
    if not isinstance(scope, dict):
        raise ValueError("WORKBENCH_RUNTIME_SCOPE_MISSING")
    run_id = _required_identifier(scope.get("runId"), "WORKBENCH_RUN_ID_INVALID")
    runtime_attempt_id = _required_identifier(
        scope.get("runtimeAttemptId"),
        "WORKBENCH_RUNTIME_ATTEMPT_ID_INVALID",
    )
    tool_call_id = _required_identifier(
        getattr(runtime, "tool_call_id", None),
        "WORKBENCH_TOOL_CALL_ID_INVALID",
        maximum_length=512,
    )
    requested_artifact_kinds = scope.get("requestedArtifactKinds")
    if (
        not isinstance(requested_artifact_kinds, list)
        or any(not isinstance(kind, str) for kind in requested_artifact_kinds)
    ):
        raise ValueError("WORKBENCH_REQUESTED_ARTIFACT_KINDS_INVALID")
    draft_kind = draft.get("kind") if isinstance(draft, dict) else None
    if not isinstance(draft_kind, str) or draft_kind not in requested_artifact_kinds:
        raise ValueError("WORKBENCH_ARTIFACT_DRAFT_KIND_NOT_REQUESTED")

    validation = validate_runtime_artifact_draft(draft)
    payload: dict[str, Any] = {
        "protocol": ARTIFACT_DRAFT_PROTOCOL,
        "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id,
        "toolCallId": tool_call_id,
        "artifactIndex": artifact_index,
        "ok": validation["ok"],
    }
    if validation["ok"] is True:
        draft_checksum = validation["candidateChecksum"]
        if not isinstance(draft_checksum, str):
            raise ValueError("WORKBENCH_ARTIFACT_DRAFT_CHECKSUM_MISSING")
        payload["draftChecksum"] = draft_checksum
    artifact = {
        **payload,
        "checksum": hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest(),
    }
    if validation["ok"] is True:
        artifact["draft"] = draft
    else:
        artifact["issues"] = validation["issues"]
    response = {
        "protocol": "workbench.runtime.artifact-draft-ack.v1",
        "ok": validation["ok"],
        "artifactIndex": artifact_index,
        "candidateChecksum": validation["candidateChecksum"],
        "issues": validation["issues"],
    }
    if validation["ok"] is False:
        response["repairInstruction"] = _artifact_draft_repair_instruction(
            draft, validation["issues"],
        )
    return json.dumps(response, ensure_ascii=False, separators=(",", ":")), artifact


def _artifact_draft_repair_instruction(candidate: Any, issues: list[Any]) -> str:
    if _has_prd_shape_failure(candidate, issues):
        return (
            "Repair the invalid top-level PRD structure using the workbench.prd.v2 "
            "contract: revision, cover, tableOfContents, and sections are objects; "
            "versionHistory and assumptions are arrays of complete objects; "
            "tableOfContents.entries is the directory entries array. "
            "Preserve all valid requested content and publish the complete repaired "
            "draft again. Do not resubmit the unchanged candidate or use placeholders."
        )
    instruction = (
        "Edit only the returned issue paths in the immediately preceding complete "
        "draft argument, preserve every other field, and publish that complete draft "
        "again. Do not discard valid sections for a local content or reference error. "
        "No draft was accepted. Do not resubmit an unchanged candidate: the same "
        "candidateChecksum will produce the same validation issues. Correct an "
        "identified field before publishing again; if the same issue persists, "
        "re-read its contract and compare the named field's value and type."
    )
    if _has_checkbox_initial_value_failure(candidate, issues):
        instruction += (
            " For checkbox inputs, repair the referenced "
            "content.variables[index].initialValue using a JSON boolean true or "
            'false, never the strings "true" or "false". Preserve the intended '
            "checked state and existing binding ids; do not choose a new default."
        )
    return instruction


def _has_checkbox_initial_value_failure(candidate: Any, issues: list[Any]) -> bool:
    if not isinstance(candidate, dict) or candidate.get("kind") != "prototype":
        return False
    for issue in issues:
        if not isinstance(issue, dict) or issue.get("code") != "custom":
            continue
        path = issue.get("path")
        message = issue.get("message")
        if (
            isinstance(path, list)
            and len(path) == 4
            and path[:2] == ["content", "variables"]
            and isinstance(path[2], int)
            and not isinstance(path[2], bool)
            and path[3] == "initialValue"
            and isinstance(message, str)
            and message.startswith("checkbox input variable ")
        ):
            return True
    return False


def _has_prd_shape_failure(candidate: Any, issues: list[Any]) -> bool:
    if (
        not isinstance(candidate, dict)
        or candidate.get("kind") != "prd"
        or candidate.get("schemaVersion") != 2
    ):
        return False
    shape_roots = {
        "revision", "cover", "versionHistory", "tableOfContents", "assumptions",
        "sections",
    }
    for issue in issues:
        if not isinstance(issue, dict) or issue.get("code") != "invalid_type":
            continue
        path = issue.get("path")
        # Nested type and semantic errors need local repairs. Even an error at
        # ["content", "sections"] is not a shape failure unless its type is wrong.
        if path == ["content"]:
            return True
        if (
            isinstance(path, list)
            and len(path) == 2
            and path[0] == "content"
            and path[1] in shape_roots
        ):
            return True
    return False


def _required_identifier(
    value: object,
    error_code: str,
    maximum_length: int = 240,
) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum_length:
        raise ValueError(error_code)
    return value


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
