from __future__ import annotations

import hashlib
import json
from typing import Any

from langchain.tools import tool

from deerflow.tools.types import Runtime

from .runtime_result_validator import validate_runtime_prototype_patch


PROTOTYPE_PATCH_PUBLICATION_PROTOCOL = (
    "workbench.runtime.prototype-patch-publication.v1"
)


@tool(
    "workbench_prototype_patch_publish",
    parse_docstring=True,
    response_format="content_and_artifact",
)
def workbench_prototype_patch_publish(
    runtime: Runtime,
    artifact_index: int,
    screen_id: str,
    base_revision: int,
    next_revision: int,
    operations: list[dict[str, Any]],
    resulting_checksum: str,
) -> tuple[str, dict[str, Any]]:
    """Validate and publish one atomic 产品工作台 Prototype Screen patch.

    Call this only after publishing the first complete Prototype checkpoint. The
    Worker derives every trusted scope identifier and applies the batch atomically.

    Args:
        artifact_index: Stable zero-based index used by the final Runtime result.
        screen_id: Stable Prototype Screen id from the complete checkpoint.
        base_revision: Current Screen transport revision.
        next_revision: Exactly base_revision plus one.
        operations: One to 128 strict typed Prototype patch operations.
        resulting_checksum: SHA-256 of the resulting canonical Screen projection.
    """
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

    patch: dict[str, Any] = {
        "protocol": "workbench.runtime.prototype-patch.v1",
        "artifactIndex": artifact_index,
        "screenId": screen_id,
        "baseRevision": base_revision,
        "nextRevision": next_revision,
        "operations": operations,
        "resultingChecksum": resulting_checksum,
    }
    validation = validate_runtime_prototype_patch(patch)
    payload: dict[str, Any] = {
        "protocol": PROTOTYPE_PATCH_PUBLICATION_PROTOCOL,
        "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id,
        "toolCallId": tool_call_id,
        "ok": validation["ok"],
    }
    if validation["ok"] is True:
        patch_checksum = validation["candidateChecksum"]
        if not isinstance(patch_checksum, str):
            raise ValueError("WORKBENCH_PROTOTYPE_PATCH_CHECKSUM_MISSING")
        payload["patchChecksum"] = patch_checksum
    artifact = {
        **payload,
        "checksum": hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest(),
    }
    if validation["ok"] is True:
        artifact["patch"] = patch
    else:
        artifact["issues"] = validation["issues"]
    response = {
        "protocol": "workbench.runtime.prototype-patch-ack.v1",
        "ok": validation["ok"],
        "artifactIndex": artifact_index,
        "screenId": screen_id,
        "nextRevision": next_revision,
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
