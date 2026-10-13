from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping
from typing import Any

from langchain.tools import tool

from deerflow.tools.types import Runtime

from .artifact_draft_repair import latest_accepted_artifact_draft, resolve_runtime_result_draft_references
from .prd_reference_normalizer import normalize_runtime_result_prd_references
from .prototype_runtime_normalizer import normalize_runtime_result_prototype_layout_aliases
from .runtime_result_validator import validate_runtime_result


VALIDATED_RESULT_PROTOCOL = "workbench.runtime.validated-result.v1"
_DRAFT_RECOVERY_KINDS = frozenset({"prd", "prototype"})
_DRAFT_RECOVERY_FIELDS = ("title", "content", "operation")


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

    The candidate has exactly protocol, message, and artifacts. Run identifiers are
    supplied by the runtime; never add runId or runtimeAttemptId to the candidate.

    Example for a NEW document (replace the title and text with the requested content):
    {"protocol":"workbench.runtime.result.v1","message":"文档已生成。","artifacts":[{"kind":"document","schemaVersion":1,"title":"文档","operation":{"kind":"create"},"citations":[{"id":"example-citation","documentId":"example-document","chunkId":"example-chunk","sourcePath":"00-rules/example.md","title":"Illustrative source","quote":"Example source facts","locator":{"heading":"Source","startLine":null,"endLine":null}}],"content":{"text":"完整文档正文"}}]}

    Citation values above are illustrative. Replace them with exact citations from
    a successful knowledge retrieval in this Run. Every artifact needs at least
    one verified citation; never submit an empty array or invent source values.

    schemaVersion is a JSON number, not a quoted string. operation is an object,
    never the string "create". For an edit, use {"kind":"revise","target":<the exact
    supplied target>} instead. PRD and Prototype require their own complete content
    schemas; the document example does not replace those schemas.

    For an accepted PRD or Prototype draft, copy its ACK's finalSubmissionArtifact
    into the same artifacts array position instead of retyping its body:
    {"draftReference":{"artifactIndex":0,"draftChecksum":"<exact accepted candidateChecksum>"}}.
    This must be the entire array entry, with no other fields. Only accepted drafts
    in this run and attempt can be referenced. For joint generation use the PRD
    reference at index 0 and Prototype reference at index 1. Keep protocol and
    message in the envelope. The runtime resolves and fully validates the exact
    accepted contents; never invent checksums or resubmit earlier rejected bodies.

    If ok is false, NO result was accepted. Fix every reported issue and call this
    tool again with the complete candidate. Do not stop, claim completion, or return
    an empty assistant message after a rejection. Only after ok is true, return a
    concise user-facing completion message without mutating or resubmitting the result.

    Args:
        candidate: Unfenced envelope with protocol, message, and artifacts. Each entry is either an accepted ACK's exact finalSubmissionArtifact reference or a complete artifact with kind, numeric schemaVersion, title, operation, citations, and content.
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
    normalized_candidate, reference_normalizations = resolve_runtime_result_draft_references(
        getattr(runtime, "state", None), normalized_candidate,
        run_id=run_id, runtime_attempt_id=runtime_attempt_id,
        requested_artifact_kinds=scope.get("requestedArtifactKinds"),
    )
    normalizations.extend(reference_normalizations)
    normalized_candidate, draft_normalizations = _recover_draft_placeholders(
        runtime,
        normalized_candidate,
        run_id=run_id,
        runtime_attempt_id=runtime_attempt_id,
    )
    normalizations.extend(draft_normalizations)
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
            json.dumps(_validation_feedback(validation, normalizations), ensure_ascii=False, separators=(",", ":")),
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


def _recover_draft_placeholders(
    runtime: Runtime,
    candidate: Any,
    *,
    run_id: str,
    runtime_attempt_id: str,
) -> tuple[Any, list[dict[str, Any]]]:
    """Recover only the observed [null] artifact fields from a trusted draft."""
    if not isinstance(candidate, dict):
        return candidate, []
    artifacts = candidate.get("artifacts")
    if not isinstance(artifacts, list):
        return candidate, []
    if not any(
        isinstance(artifact, dict)
        and artifact.get("kind") in _DRAFT_RECOVERY_KINDS
        and any(_is_null_array(artifact.get(field)) for field in _DRAFT_RECOVERY_FIELDS)
        for artifact in artifacts
    ):
        return candidate, []

    normalized = copy.deepcopy(candidate)
    normalized_artifacts = normalized.get("artifacts")
    if not isinstance(normalized_artifacts, list):
        return candidate, []

    normalizations: list[dict[str, Any]] = []
    for artifact_index, artifact in enumerate(normalized_artifacts):
        if (
            not isinstance(artifact, dict)
            or artifact.get("kind") not in _DRAFT_RECOVERY_KINDS
            or not any(_is_null_array(artifact.get(field)) for field in _DRAFT_RECOVERY_FIELDS)
        ):
            continue
        draft = _latest_successful_draft(
            runtime,
            artifact_index,
            run_id=run_id,
            runtime_attempt_id=runtime_attempt_id,
        )
        if (
            not isinstance(draft, Mapping)
            or draft.get("kind") != artifact.get("kind")
        ):
            continue
        for field in _DRAFT_RECOVERY_FIELDS:
            if not _is_null_array(artifact.get(field)) or field not in draft:
                continue
            artifact[field] = copy.deepcopy(draft[field])
            normalizations.append({
                "path": ["artifacts", artifact_index, field],
                "from": [None],
                "action": "recovered-from-artifact-draft",
                "artifactIndex": artifact_index,
            })
    return normalized, normalizations


def _latest_successful_draft(
    runtime: Runtime,
    artifact_index: int,
    *,
    run_id: str,
    runtime_attempt_id: str,
) -> Mapping[str, Any] | None:
    return latest_accepted_artifact_draft(
        getattr(runtime, "state", None), run_id=run_id,
        runtime_attempt_id=runtime_attempt_id, artifact_index=artifact_index,
    )


def _is_null_array(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 1 and value[0] is None


def _validation_feedback(
    validation: dict[str, Any],
    normalizations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    hints: list[str] = []
    field_hints = {
        "schemaVersion": (
            "schemaVersion must be a positive JSON integer, for example 1, not "
            '"1". Keep the required version for the requested artifact kind.'
        ),
        "operation": (
            'For a new artifact, operation is {"kind":"create"}, not "create". '
            'For an edit, use {"kind":"revise","target":<the exact supplied target>}.'
        ),
        "citations": (
            "citations must be a nonempty JSON array copied exactly from a successful "
            "Knowledge retrieval in this attempt. Retrieve authorized knowledge first; "
            "when no relevant knowledge exists, require more knowledge or fail. Never invent citations."
        ),
    }
    for issue in validation.get("issues", []):
        path = issue.get("path") if isinstance(issue, dict) else None
        if path == ["message"]:
            hints.append("message must be a string summarizing the completed result.")
        elif path == [] and issue.get("code") == "unrecognized_keys":
            hints.append(
                "The envelope allows only protocol, message, and artifacts. Remove "
                "the rejected envelope keys; runtime identifiers are supplied securely."
            )
        elif (
            isinstance(path, list)
            and len(path) == 3
            and path[0] == "artifacts"
            and isinstance(path[1], int)
            and path[2] in field_hints
        ):
            hints.append(field_hints[path[2]])
    feedback = {
        **validation,
        "repairInstruction": (
            "No result was accepted. Correct every reported issue in the complete "
            "candidate, preserving the requested content and all valid fields, then "
            "call workbench_runtime_result_submit again. Continue until ok:true. "
            "Do not end the turn or return an empty completion while ok:false."
        ),
        "repairHints": list(dict.fromkeys(hints)),
    }
    feedback["normalizations"] = normalizations or []
    return feedback


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
