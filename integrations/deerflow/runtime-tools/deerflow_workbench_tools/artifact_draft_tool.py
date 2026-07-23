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
        "issues": validation["issues"],
    }
    return json.dumps(response, ensure_ascii=False, separators=(",", ":")), artifact


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
