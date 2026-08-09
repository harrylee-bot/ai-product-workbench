from __future__ import annotations

import hashlib
import json
from typing import Any

from langchain.tools import tool

from deerflow.tools.types import Runtime

from .prd_reference_normalizer import normalize_runtime_result_prd_references
from .prototype_runtime_normalizer import normalize_runtime_result_prototype_layout_aliases
from .runtime_result_validator import validate_runtime_result


VALIDATED_RESULT_PROTOCOL = "workbench.runtime.validated-result.v1"


@tool(
    "workbench_runtime_result_submit",
    parse_docstring=True,
    response_format="content_and_artifact",
)
def workbench_runtime_result_submit(
    runtime: Runtime,
    candidate: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    """Validate and submit the complete final 产品工作台 Runtime result envelope.

    Call this only for the lead agent's final candidate. If validation fails, fix every
    returned issue and submit the complete candidate again. After validation succeeds,
    do not mutate or resubmit the result.

    Args:
        candidate: The complete workbench.runtime.result.v1 object, without a Markdown fence.
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
    normalized_candidate, normalizations = normalize_runtime_result_prd_references(candidate)
    normalized_candidate, prototype_normalizations = normalize_runtime_result_prototype_layout_aliases(
        normalized_candidate,
    )
    normalizations.extend(prototype_normalizations)
    validation = validate_runtime_result(normalized_candidate)
    if validation["ok"] is not True:
        artifact = _validated_artifact(
            run_id,
            runtime_attempt_id,
            tool_call_id,
            False,
            issues=validation["issues"],
        )
        return (
            json.dumps({
                **validation,
                "normalizations": normalizations,
                "repairInstruction": (
                    "Edit only the returned issue paths in the immediately preceding complete "
                    "candidate argument and preserve every other field. Reciprocal PRD "
                    "reference normalizations are reapplied automatically."
                ),
            }, ensure_ascii=False, separators=(",", ":")),
            artifact,
        )

    content = json.dumps({
        "protocol": "workbench.runtime.validation.v1",
        "ok": True,
        "normalizations": normalizations,
        "message": "Validated. Return only a concise user-facing completion message.",
    }, ensure_ascii=False, separators=(",", ":"))
    return content, _validated_artifact(
        run_id,
        runtime_attempt_id,
        tool_call_id,
        True,
        result=normalized_candidate,
        result_checksum=validation["candidateChecksum"],
    )


def _validated_artifact(
    run_id: str,
    runtime_attempt_id: str,
    tool_call_id: str,
    ok: bool,
    *,
    result: dict[str, Any] | None = None,
    result_checksum: str | None = None,
    issues: list[Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocol": VALIDATED_RESULT_PROTOCOL,
        "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id,
        "toolCallId": tool_call_id,
        "ok": ok,
    }
    if ok:
        if not isinstance(result_checksum, str):
            raise ValueError("WORKBENCH_RUNTIME_RESULT_CHECKSUM_MISSING")
        payload["resultChecksum"] = result_checksum
    artifact = {
        **payload,
        "checksum": hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest(),
    }
    if ok:
        artifact["result"] = result
    else:
        artifact["issues"] = issues
    return artifact


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
