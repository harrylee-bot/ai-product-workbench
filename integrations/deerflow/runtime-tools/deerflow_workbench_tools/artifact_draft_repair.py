"""Reconstruct local draft repairs from scoped, causally paired tool history.

There is no private draft cache. The Node validator owns candidate checksums and
all business/schema validation; this module only preserves and edits JSON data.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from collections.abc import Mapping
from functools import lru_cache
from typing import Any

from .runtime_result_validator import MAX_CANDIDATE_BYTES, validate_runtime_artifact_draft

DRAFT_TOOL = "workbench_artifact_draft_publish"
DRAFT_PROTOCOL = "workbench.runtime.artifact-draft.v1"
ACK_PROTOCOL = "workbench.runtime.artifact-draft-ack.v1"
MAX_REPAIR_OPERATIONS = 24
MAX_REPAIR_BYTES = 65_536
MAX_HISTORY_DRAFTS = 32
_ROOT_MOVE_SOURCES = frozenset({
    "degradation", "safetyBaseline", "introduction",
    "businessRequirements", "functionSections", "sections",
})
_IDENTITY_FIELDS = ("kind", "schemaVersion", "operation")


class ArtifactDraftRepairPathError(ValueError):
    """A rejected edit with bounded structural feedback, never candidate prose."""

    def __init__(self, code: str, feedback: dict[str, Any]):
        super().__init__(code)
        self.feedback = feedback


def repair_error_feedback(error: Exception) -> str:
    if not isinstance(error, ArtifactDraftRepairPathError):
        return ""
    return (
        " The entire repair was not applied; the latest rejected ACK remains the base. "
        "Correct this operation using the existing field names and types, without "
        "discarding other valid content. Repair diagnostic: "
        + json.dumps(error.feedback, ensure_ascii=False, separators=(",", ":"))
    )


def _path_feedback(candidate: dict[str, Any], operation: dict[str, Any], index: int) -> dict[str, Any]:
    # Include only object keys and array lengths. Never echo field values,
    # candidate text, replacement values, or an unvalidated path.
    details: dict[str, Any] = {"operationIndex": index, "operation": operation["op"]}
    for name in ("path", "from"):
        if name not in operation:
            continue
        parts = _pointer(operation[name], source=name == "from")
        value: Any = candidate
        reached: list[str] = []
        for part in parts:
            if isinstance(value, dict) and part in value:
                value = value[part]
            elif isinstance(value, list) and re.fullmatch(r"0|[1-9][0-9]*", part) and len(part) <= 8 and int(part) < len(value):
                value = value[int(part)]
            else:
                break
            reached.append(part)
        shape: dict[str, Any] = {
            "pointer": operation[name],
            "existingPath": "/" + "/".join(part.replace("~", "~0").replace("/", "~1") for part in reached),
            "type": "object" if isinstance(value, dict) else "array" if isinstance(value, list) else "scalar",
        }
        if isinstance(value, dict):
            shape["keys"] = sorted(key for key in value if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,48}", key))[:24]
        elif isinstance(value, list):
            shape["length"] = len(value)
        details[name] = shape
    return details


def _fail(reason: str) -> None:
    raise ValueError("WORKBENCH_ARTIFACT_DRAFT_REPAIR_" + reason)


def _json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        _fail("JSON_INVALID")


def _copy_candidate(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail("CANDIDATE_INVALID")
    if len(_json(value).encode("utf-8")) > MAX_CANDIDATE_BYTES:
        _fail("CANDIDATE_TOO_LARGE")
    return copy.deepcopy(value)


def _value(message: Any, key: str) -> Any:
    return message.get(key) if isinstance(message, Mapping) else getattr(message, key, None)


def _kind(message: Any) -> str:
    value = _value(message, "type") or _value(message, "role")
    return value.lower() if isinstance(value, str) else ""


def _turn_messages(state: Any) -> list[Any]:
    messages = _value(state, "messages")
    if not isinstance(messages, list) or len(messages) > 10_000:
        _fail("HISTORY_INVALID")
    start = next((index for index in range(len(messages)-1, -1, -1)
                  if _kind(messages[index]) in {"human", "humanmessage", "user", "usermessage"}), None)
    if start is None:
        _fail("HUMAN_TURN_MISSING")
    return messages[start+1:]


def _history_index(messages: list[Any]) -> tuple[dict[str, tuple[int, Mapping[str, Any], int]], dict[str, list[tuple[int, Any]]]]:
    declarations: dict[str, tuple[int, Mapping[str, Any], int]] = {}
    responses: dict[str, list[tuple[int, Any]]] = {}
    for index, message in enumerate(messages):
        if _kind(message) in {"ai", "aimessage", "assistant"}:
            calls = _value(message, "tool_calls") or []
            if not isinstance(calls, list):
                _fail("HISTORY_INVALID")
            for call in calls:
                if not isinstance(call, Mapping) or not isinstance(call.get("id"), str):
                    _fail("DECLARATION_INVALID")
                call_id = call["id"]
                if call_id in declarations:
                    _fail("DUPLICATE_CALL")
                declarations[call_id] = (index, call, len(calls))
        elif _kind(message) in {"tool", "toolmessage"}:
            call_id = _value(message, "tool_call_id")
            if isinstance(call_id, str):
                responses.setdefault(call_id, []).append((index, message))
    return declarations, responses


def _retrieved_citations(state: Any, run_id: str, runtime_attempt_id: str) -> dict[str, list[dict]]:
    try:
        messages = _turn_messages(state)
        declarations, responses = _history_index(messages)
    except ValueError:
        return {}
    retrieved: dict[str, list[dict]] = {}
    for call_id, (position, call, _) in declarations.items():
        paired = responses.get(call_id, [])
        if call.get("name") != "workbench_knowledge_retrieve" or len(paired) != 1 or paired[0][0] <= position:
            continue
        message = paired[0][1]
        receipt = _value(message, "artifact")
        content = _value(message, "content")
        if (_value(message, "name") != call["name"] or _value(message, "status") != "success"
                or not isinstance(receipt, dict) or not isinstance(content, str)
                or receipt.get("protocol") != "workbench.knowledge-receipt.v1"
                or receipt.get("runId") != run_id or receipt.get("runtimeAttemptId") != runtime_attempt_id
                or receipt.get("toolCallId") != call_id or not receipt.get("releaseId")
                or receipt.get("contentSha256") != hashlib.sha256(content.encode("utf-8")).hexdigest()):
            continue
        try:
            result = json.loads(content)
            evidence = result["evidence"]
            if (result["protocol"] != "workbench.knowledge-retrieval-result.v1"
                    or evidence["release"]["id"] != receipt["releaseId"]
                    or evidence["routeScope"] != "production" or evidence["mode"] != "hybrid"):
                continue
            items = [item["citation"] for item in result["items"]]
            if any(not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in items):
                continue
        except (TypeError, ValueError, KeyError):
            continue
        for citation in items:
            retrieved.setdefault(citation["id"], []).append(citation)
    return retrieved


def _unique_retrieved_source(citation: dict, retrieved: dict[str, list[dict]], *, exact_quote: bool = True) -> dict | None:
    fields = ("documentId", "chunkId", "sourcePath")
    if exact_quote:
        fields += ("quote",)
    if any(not isinstance(citation.get(key), str) or not citation[key] for key in fields):
        return None
    matches = {
        _json(item): item
        for items in retrieved.values() for item in items
        if all(item.get(key) == citation[key] for key in fields)
    }
    return next(iter(matches.values())) if len(matches) == 1 else None


def prd_citation_mirror_repair(
    candidate: dict[str, Any], validation: dict[str, Any], state: Any,
    run_id: str, runtime_attempt_id: str,
) -> dict[str, Any] | None:
    """Offer a local quote correction proven by the current retrieval receipt."""
    if (
        candidate.get("kind") != "prd" or candidate.get("schemaVersion") != 3
        or candidate.get("operation", {}).get("kind") != "create"
        or validation["issues"] != [{
            "code": "custom", "path": ["citations"],
            "message": "PRD draft citations must exactly match content citations",
        }]
        or not _checksum(checksum := validation.get("candidateChecksum"))
    ):
        return None
    outer, inner = candidate["citations"], candidate["content"]["citations"]
    if len(outer) != len(inner):
        return None
    retrieved = _retrieved_citations(state, run_id, runtime_attempt_id)
    operations = []
    for index, (envelope, document) in enumerate(zip(outer, inner)):
        if envelope == document:
            continue
        if {k: v for k, v in envelope.items() if k != "quote"} != {
            k: v for k, v in document.items() if k != "quote"
        }:
            return None
        source = _unique_retrieved_source(envelope, retrieved, exact_quote=False)
        if source is None:
            return None
        quote = source.get("quote")
        if not isinstance(quote, str) or not quote or quote not in (envelope["quote"], document["quote"]):
            return None
        prefix = "/content/citations" if quote == envelope["quote"] else "/citations"
        operations.append({"op": "replace", "path": f"{prefix}/{index}/quote", "value": quote})
    repair = {"baseCandidateChecksum": checksum, "operations": operations}
    if 1 <= len(operations) <= MAX_REPAIR_OPERATIONS and len(_json(repair).encode("utf-8")) <= MAX_REPAIR_BYTES:
        return repair
    return None


def validate_retrieved_citations(validation: dict[str, Any], state: Any, run_id: str,
                                runtime_attempt_id: str, candidate: dict[str, Any], *,
                                envelope: bool = False) -> dict[str, Any]:
    """Catch transcription errors while the model can still repair its submission."""
    if validation["ok"] is not True:
        return validation
    retrieved = _retrieved_citations(state, run_id, runtime_attempt_id)
    if not retrieved:
        return validation
    issues: list[dict[str, Any]] = []
    for index, artifact in enumerate(candidate["artifacts"] if envelope else [candidate]):
        # A revised PRD can also cite the previous frozen version. Only the Worker
        # can resolve that version and authenticate its retained citations.
        if artifact["kind"] == "prd" and artifact["operation"]["kind"] == "revise":
            continue
        prefix = ["artifacts", index] if envelope else []
        for number, citation in enumerate(artifact["citations"]):
            known = retrieved.get(citation["id"], [])
            if citation in known:
                continue
            if not known:
                expected = _unique_retrieved_source(citation, retrieved)
                issue = {
                    "code": "custom", "path": prefix + ["citations", number],
                    "message": (
                        "The citation uses an ID absent from the current retrieval. "
                        "Use the complete citation object from an authorized Knowledge tool response, "
                        "including its original ID. Retrieve the source again if necessary."
                    ),
                }
                if expected:
                    if not envelope:
                        issue["citationRepair"] = {"op": "restoreCitation", "path": f"/citations/{number}"}
                    else:
                        issue["message"] += " Matching source citation: " + _json(expected)
                else:
                    source = _unique_retrieved_source(citation, retrieved, exact_quote=False)
                    if source:
                        issue["message"] += (
                            " The proposed quote differs from this retrieved source. "
                            "Read the verified quote and confirm it supports the claims; revise any unsupported "
                            "claims before replacing the citation with this exact object."
                        )
                        issue["verifiedSourceCitation"] = source
                issues.append(issue)
                if len(issues) >= 12:
                    return {**validation, "ok": False, "issues": issues}
                continue
            expected = min(known, key=lambda row: sum(row.get(k) != v for k, v in citation.items()))
            content_index = next((i for i, entry in enumerate(artifact["content"]["citations"])
                                  if entry["id"] == citation["id"]), None) if artifact["kind"] == "prd" else None
            for key, value in expected.items():
                if key in citation and citation[key] == value:
                    continue
                guidance = "Copy this exact retrieved value: " + _json(value)
                paths = [["citations", number, key]]
                if content_index is not None:
                    paths.append(["content", "citations", content_index, key])
                for path in paths:
                    issues.append({"code": "custom", "path": prefix + path, "message": guidance})
                if len(issues) >= 12:
                    return {**validation, "ok": False, "issues": issues}
    return {**validation, "ok": False, "issues": issues} if issues else validation


def _validate_pairing(declarations: Mapping[str, Any], responses: Mapping[str, Any], *, pending_id: str | None = None) -> None:
    for call_id, paired in responses.items():
        declared = declarations.get(call_id)
        if (declared is None or len(paired) != 1 or paired[0][0] <= declared[0]
                or _value(paired[0][1], "name") != declared[1].get("name")):
            _fail("CAUSAL_HISTORY_INVALID")
    for call_id in declarations:
        if call_id != pending_id and len(responses.get(call_id, [])) != 1:
            _fail("CAUSAL_HISTORY_INVALID")


def _arguments(call: Mapping[str, Any]) -> tuple[int, Any, Any]:
    args = call.get("args")
    if not isinstance(args, dict) or set(args) - {"artifact_index", "draft", "repair"}:
        _fail("DECLARATION_INVALID")
    index = args.get("artifact_index")
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < 20:
        _fail("DECLARATION_INVALID")
    draft, repair = args.get("draft"), args.get("repair")
    if (draft is None) == (repair is None):
        _fail("MODE_INVALID")
    return index, draft, repair


def _checksum(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _unexecuted_response(message: Any) -> bool:
    content = _value(message, "content")
    return (_value(message, "name") == DRAFT_TOOL and _value(message, "status") == "error"
            and _value(message, "artifact") is None and isinstance(content, str)
            and content.startswith("Error:"))


@lru_cache(maxsize=32)
def _validate_history_json(run_id: str, runtime_attempt_id: str, body: str) -> dict[str, Any]:
    # Replays revisit the same earlier candidates for every incremental repair.
    # The bundled schema is immutable. The IDs keep reuse within one attempt.
    return validate_runtime_artifact_draft(json.loads(body))


def _validate_history_candidate(run_id: str, runtime_attempt_id: str, candidate: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(candidate, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return _validate_history_json(run_id, runtime_attempt_id, body)


def _verify_response(message: Any, candidate: dict[str, Any], state: Any, *, call_id: str,
                     run_id: str, runtime_attempt_id: str, artifact_index: int) -> tuple[bool, str]:
    if _value(message, "name") != DRAFT_TOOL or _value(message, "status") != "success":
        _fail("RESPONSE_INVALID")
    artifact = _value(message, "artifact")
    if not isinstance(artifact, Mapping):
        _fail("RESPONSE_INVALID")
    ok = artifact.get("ok")
    if not isinstance(ok, bool):
        _fail("RESPONSE_INVALID")
    envelope = {
        "protocol": DRAFT_PROTOCOL, "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id, "toolCallId": call_id,
        "artifactIndex": artifact_index, "ok": ok,
    }
    if ok:
        envelope["draftChecksum"] = artifact.get("draftChecksum")
    if any(type(artifact.get(key)) is not type(value) or artifact.get(key) != value for key, value in envelope.items()):
        _fail("SCOPE_MISMATCH")
    if artifact.get("checksum") != hashlib.sha256(_json(envelope).encode("utf-8")).hexdigest():
        _fail("RESPONSE_CHECKSUM_INVALID")
    try:
        ack = json.loads(_value(message, "content"))
    except (TypeError, ValueError):
        _fail("ACK_INVALID")
    if (not isinstance(ack, dict) or ack.get("protocol") != ACK_PROTOCOL
            or ack.get("ok") is not ok or type(ack.get("artifactIndex")) is not int
            or ack.get("artifactIndex") != artifact_index or not _checksum(ack.get("candidateChecksum"))):
        _fail("ACK_INVALID")
    validation = validate_retrieved_citations(
        _validate_history_candidate(run_id, runtime_attempt_id, candidate),
        state, run_id, runtime_attempt_id, candidate,
    )
    if validation.get("ok") is not ok or validation.get("candidateChecksum") != ack["candidateChecksum"]:
        _fail("BASE_CHECKSUM_MISMATCH")
    if _json(validation.get("issues")) != _json(ack.get("issues")):
        _fail("ACK_INVALID")
    if ok:
        persisted = artifact.get("draft")
        if not isinstance(persisted, dict) or artifact.get("draftChecksum") != ack["candidateChecksum"]:
            _fail("RESPONSE_INVALID")
        persisted_validation = _validate_history_candidate(run_id, runtime_attempt_id, persisted)
        if persisted_validation.get("ok") is not True or persisted_validation.get("candidateChecksum") != ack["candidateChecksum"]:
            _fail("BASE_CHECKSUM_MISMATCH")
    elif _json(artifact.get("issues")) != _json(validation.get("issues")):
        _fail("RESPONSE_INVALID")
    return ok, ack["candidateChecksum"]


def _pointer(value: Any, *, source: bool = False) -> list[str]:
    if not isinstance(value, str) or not value.startswith("/") or len(value) > 2048:
        _fail("PATH_INVALID")
    raw = value[1:].split("/")
    if len(raw) > 32 or any(not part or len(part) > 256 or re.search(r"~(?![01])", part) for part in raw):
        _fail("PATH_INVALID")
    parts = [part.replace("~1", "/").replace("~0", "~") for part in raw]
    if any(part in {"__proto__", "prototype", "constructor"} for part in parts):
        _fail("PATH_INVALID")
    allowed = (parts == ["title"] or (parts[0] in {"content", "citations"} and len(parts) > 1)
               or (source and len(parts) == 1 and parts[0] in _ROOT_MOVE_SOURCES))
    if not allowed:
        _fail("PATH_FORBIDDEN")
    return parts


def _array_index(token: str, length: int, *, insert: bool = False) -> int:
    if insert and token == "-":
        return length
    if re.fullmatch(r"0|[1-9][0-9]*", token) is None or len(token) > 8:
        _fail("PATH_INVALID")
    index = int(token)
    if index >= length + int(insert):
        _fail("PATH_MISSING")
    return index


def _parent(candidate: dict[str, Any], parts: list[str]) -> tuple[Any, str]:
    value: Any = candidate
    for part in parts[:-1]:
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list):
            value = value[_array_index(part, len(value))]
        else:
            _fail("PATH_MISSING")
    if not isinstance(value, (dict, list)):
        _fail("PATH_MISSING")
    return value, parts[-1]


def _remove(candidate: dict[str, Any], parts: list[str]) -> Any:
    parent, key = _parent(candidate, parts)
    if isinstance(parent, dict):
        if key not in parent:
            _fail("PATH_MISSING")
        return parent.pop(key)
    return parent.pop(_array_index(key, len(parent)))


def _write(candidate: dict[str, Any], parts: list[str], value: Any, *, replace: bool) -> None:
    parent, key = _parent(candidate, parts)
    if isinstance(parent, dict):
        if replace and key not in parent:
            _fail("PATH_MISSING")
        if not replace and key in parent:
            _fail("TARGET_EXISTS")
        parent[key] = copy.deepcopy(value)
    elif replace:
        parent[_array_index(key, len(parent))] = copy.deepcopy(value)
    else:
        parent.insert(_array_index(key, len(parent), insert=True), copy.deepcopy(value))


def template_restore_operation(issue: Any) -> dict[str, str] | None:
    """Only validator-owned fixed template strings can be restored without prose."""
    if not isinstance(issue, dict) or not isinstance(issue.get("expectedValue"), str):
        return None
    path = issue.get("path")
    if not isinstance(path, list) or len(issue["expectedValue"]) > 2_000:
        return None
    fixed_intro = issue.get("code") == "invalid_literal" and path == ["content", "sections", "safetyBaseline", "intro"]
    fixed_directory = (issue.get("code") == "custom" and len(path) == 4
                       and path[:3] == ["content", "tableOfContents", "entries"]
                       and isinstance(path[3], int) and not isinstance(path[3], bool) and path[3] >= 0)
    if not (fixed_intro or fixed_directory):
        return None
    return {"op": "restore", "path": "/" + "/".join(str(part) for part in path)}

def prd_envelope_duplicate_removals(candidate: Any, issues: list[Any]) -> list[dict[str, str]]:
    if (
        not isinstance(candidate, dict) or candidate.get("kind") != "prd" or candidate.get("schemaVersion") != 3
        or not isinstance(content := candidate.get("content"), dict)
        or not any(isinstance(issue, dict) and issue.get("path") == [] and issue.get("code") == "unrecognized_keys" for issue in issues)
    ):
        return []
    return [
        {"op": "remove", "path": "/" + key}
        for key in ("documentId", "protocol")
        if isinstance(candidate.get(key), str) and candidate[key] == content.get(key)
    ]


def _restore_template(candidate: dict[str, Any], operation: dict[str, Any], parts: list[str]) -> None:
    if candidate.get("kind") != "prd" or candidate.get("schemaVersion") != 3:
        _fail("TEMPLATE_PATH_FORBIDDEN")
    # Recompute after earlier operations. Never trust model-supplied expected text
    # or stale directory indexes from an ACK before a section move.
    issues = validate_runtime_artifact_draft(candidate)["issues"]
    matches = [issue for issue in issues if template_restore_operation(issue) == operation]
    if len(matches) != 1:
        _fail("TEMPLATE_PATH_FORBIDDEN")
    parent, key = _parent(candidate, parts)
    _write(candidate, parts, matches[0]["expectedValue"], replace=not isinstance(parent, dict) or key in parent)


def _update_inline_citation_ids(value: Any, old_id: str, new_id: str) -> None:
    if isinstance(value, dict):
        if value.get("type") == "citation" and value.get("citationId") == old_id:
            value["citationId"] = new_id
        for child in value.values():
            _update_inline_citation_ids(child, old_id, new_id)
    elif isinstance(value, list):
        for child in value:
            _update_inline_citation_ids(child, old_id, new_id)


def _restore_citation(candidate: dict[str, Any], parts: list[str], retrieved: dict[str, list[dict]]) -> None:
    if len(parts) != 2 or parts[0] != "citations" or not isinstance(candidate.get("citations"), list):
        _fail("CITATION_PATH_FORBIDDEN")
    if candidate.get("kind") == "prd" and candidate.get("operation", {}).get("kind") == "revise":
        _fail("CITATION_PATH_FORBIDDEN")
    citations = candidate["citations"]
    index = _array_index(parts[1], len(citations))
    original = citations[index]
    if not isinstance(original, dict) or not isinstance(old_id := original.get("id"), str) or old_id in retrieved:
        _fail("CITATION_SOURCE_UNRESOLVED")
    verified = _unique_retrieved_source(original, retrieved)
    if verified is None:
        _fail("CITATION_SOURCE_UNRESOLVED")
    new_id = verified["id"]
    if any(isinstance(item, dict) and item.get("id") == new_id for item in citations):
        _fail("CITATION_ALREADY_PRESENT")
    citations[index] = copy.deepcopy(verified)
    if candidate.get("kind") == "prd":
        document = candidate.get("content")
        if not isinstance(document, dict) or not isinstance(document.get("citations"), list):
            _fail("CITATION_SOURCE_UNRESOLVED")
        slots = [i for i, item in enumerate(document["citations"]) if item == original]
        if len(slots) != 1:
            _fail("CITATION_SOURCE_UNRESOLVED")
        document["citations"][slots[0]] = copy.deepcopy(verified)
        _update_inline_citation_ids(document["sections"], old_id, new_id)
        for assumption in document["assumptions"]:
            assumption["citationIds"] = [new_id if value == old_id else value for value in assumption["citationIds"]]


def _apply_repair(candidate: dict[str, Any], repair: Any, checksum: str,
                  retrieved: dict[str, list[dict]] | None = None) -> dict[str, Any]:
    if (not isinstance(repair, dict) or set(repair) != {"baseCandidateChecksum", "operations"}
            or not _checksum(repair.get("baseCandidateChecksum"))):
        _fail("REQUEST_INVALID")
    if len(_json(repair).encode("utf-8")) > MAX_REPAIR_BYTES:
        _fail("TOO_LARGE")
    if repair["baseCandidateChecksum"] != checksum:
        _fail("STALE_BASE")
    operations = repair["operations"]
    if not isinstance(operations, list) or not 1 <= len(operations) <= MAX_REPAIR_OPERATIONS:
        _fail("OPERATIONS_INVALID")
    citation_operations = [
        operation for operation in operations if isinstance(operation, dict) and operation.get("op") == "restoreCitation"
    ]
    if citation_operations and (
        len(citation_operations) != len(operations) or validate_runtime_artifact_draft(candidate)["ok"] is not True
    ):
        _fail("CITATION_REPAIR_REQUIRES_VALID_SHAPE")
    result = _copy_candidate(candidate)
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            _fail("OPERATION_INVALID")
        op = operation.get("op")
        keys = {"op", "path", "value"} if op in {"add", "replace"} else {"op", "path", "from"} if op == "move" else {"op", "path"}
        if op not in {"add", "replace", "remove", "move", "restore", "restoreCitation"} or set(operation) != keys:
            _fail("OPERATION_INVALID")
        if op == "remove" and operation["path"] in ("/documentId", "/protocol"):
            if operation not in prd_envelope_duplicate_removals(result, validate_runtime_artifact_draft(result)["issues"]):
                _fail("PATH_FORBIDDEN")
            parts = [operation["path"][1:]]
        else:
            parts = _pointer(operation["path"])
        before_operation = copy.deepcopy(result)
        try:
            if op == "restore":
                _restore_template(result, operation, parts)
            elif op == "restoreCitation":
                _restore_citation(result, parts, retrieved or {})
            elif op == "remove":
                _remove(result, parts)
            elif op == "move":
                origin = _pointer(operation["from"], source=True)
                if parts[:len(origin)] == origin:
                    _fail("MOVE_CYCLE")
                value = _remove(result, origin)
                _write(result, parts, value, replace=False)
            else:
                _write(result, parts, operation["value"], replace=op == "replace")
        except ValueError as error:
            if str(error) not in {"WORKBENCH_ARTIFACT_DRAFT_REPAIR_PATH_MISSING", "WORKBENCH_ARTIFACT_DRAFT_REPAIR_TARGET_EXISTS"}:
                raise
            raise ArtifactDraftRepairPathError(str(error), _path_feedback(before_operation, operation, index)) from None
        if len(_json(result).encode("utf-8")) > MAX_CANDIDATE_BYTES:
            _fail("CANDIDATE_TOO_LARGE")
    if any((field in result) != (field in candidate) or _json(result.get(field)) != _json(candidate.get(field)) for field in _IDENTITY_FIELDS):
        _fail("IDENTITY_CHANGED")
    if _json(result) == _json(candidate):
        _fail("UNCHANGED")
    return result


def resolve_artifact_draft_candidate(
    state: Any, *, run_id: str, runtime_attempt_id: str, tool_call_id: str,
    artifact_index: int, draft: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve a full draft, or repair the latest rejected draft in this turn."""
    if (draft is None) == (repair is None):
        _fail("MODE_INVALID")
    if draft is not None:
        return _copy_candidate(draft)
    messages = _turn_messages(state)
    declarations, responses = _history_index(messages)
    current = declarations.get(tool_call_id)
    if current is None or current[0] != len(messages)-1 or current[2] != 1 or responses.get(tool_call_id):
        _fail("PENDING_CALL_INVALID")
    _validate_pairing(declarations, responses, pending_id=tool_call_id)
    current_index, current_draft, current_repair = _arguments(current[1])
    if (current[1].get("name") != DRAFT_TOOL or current_index != artifact_index
            or current_draft is not None or _json(current_repair) != _json(repair)):
        _fail("DECLARATION_MISMATCH")
    latest: dict[str, Any] | None = None
    latest_checksum: str | None = None
    seen = 0
    for message in messages[:current[0]]:
        artifact = _value(message, "artifact")
        if (_kind(message) in {"tool", "toolmessage"} and _value(message, "name") == "workbench_runtime_result_submit"
                and isinstance(artifact, Mapping) and artifact.get("protocol") == "workbench.runtime.validated-result.v1"
                and artifact.get("runId") == run_id and artifact.get("runtimeAttemptId") == runtime_attempt_id and artifact.get("ok") is True):
            _fail("RESULT_ALREADY_ACCEPTED")
    previous_response_index = -1
    for call_id, (position, call, batch_size) in sorted(declarations.items(), key=lambda item: item[1][0]):
        if position >= current[0] or call.get("name") != DRAFT_TOOL:
            continue
        paired = responses.get(call_id, [])
        if len(paired) != 1 or not position < paired[0][0] < current[0]:
            _fail("CAUSAL_HISTORY_INVALID")
        if _unexecuted_response(paired[0][1]):
            continue
        index, historical_draft, historical_repair = _arguments(call)
        if index != artifact_index:
            continue
        seen += 1
        if seen > MAX_HISTORY_DRAFTS:
            _fail("HISTORY_TOO_LONG")
        if position <= previous_response_index:
            _fail("CAUSAL_HISTORY_INVALID")
        prefix = {"messages": [{"type": "human"}, *messages[:position]]}
        if historical_draft is not None:
            reconstructed = _copy_candidate(historical_draft)
        else:
            if batch_size != 1 or latest is None or latest_checksum is None:
                _fail("CAUSAL_HISTORY_INVALID")
            reconstructed = _apply_repair(latest, historical_repair, latest_checksum,
                                          _retrieved_citations(prefix, run_id, runtime_attempt_id))
        accepted, checksum = _verify_response(
            paired[0][1], reconstructed, prefix, call_id=call_id, run_id=run_id,
            runtime_attempt_id=runtime_attempt_id, artifact_index=artifact_index,
        )
        if accepted:
            _fail("DRAFT_ALREADY_ACCEPTED")
        latest = reconstructed
        latest_checksum = checksum
        previous_response_index = paired[0][0]
    if latest is None or latest_checksum is None:
        _fail("BASE_MISSING")
    return _apply_repair(latest, repair, latest_checksum, _retrieved_citations(state, run_id, runtime_attempt_id))


def latest_accepted_artifact_draft(
    state: Any, *, run_id: str, runtime_attempt_id: str, artifact_index: int,
) -> dict[str, Any] | None:
    """Recover a accepted draft only when its original declaration still proves it."""
    try:
        messages = _turn_messages(state)
        declarations, responses = _history_index(messages)
        # The final result call can be pending while it recovers accepted drafts.
        pending = [call_id for call_id, (position, call, _) in declarations.items()
                   if not responses.get(call_id) and position == len(messages)-1
                   and call.get("name") == "workbench_runtime_result_submit"]
        _validate_pairing(declarations, responses, pending_id=pending[0] if len(pending) == 1 else None)
        candidates = []
        for call_id, (position, call, batch_size) in declarations.items():
            if call.get("name") != DRAFT_TOOL:
                continue
            paired = responses.get(call_id, [])
            if len(paired) == 1 and position < paired[0][0] and _unexecuted_response(paired[0][1]):
                continue
            index, draft, repair = _arguments(call)
            if index == artifact_index:
                candidates.append((position, call_id, draft, repair, batch_size))
        if not candidates:
            return None
        position, call_id, draft, repair, batch_size = max(candidates, key=lambda row: row[0])
        paired = responses.get(call_id, [])
        if len(paired) != 1 or paired[0][0] <= position:
            return None
        # Retain the actual current human boundary while restricting repair history
        # to the original pending declaration, before its successful response.
        prefix = {"messages": [{"type": "human"}, *messages[:position+1]]}
        reconstructed = resolve_artifact_draft_candidate(
            prefix, run_id=run_id, runtime_attempt_id=runtime_attempt_id,
            tool_call_id=call_id, artifact_index=artifact_index, draft=draft, repair=repair,
        )
        accepted, _ = _verify_response(
            paired[0][1], reconstructed, prefix, call_id=call_id, run_id=run_id,
            runtime_attempt_id=runtime_attempt_id, artifact_index=artifact_index,
        )
        if accepted:
            return reconstructed
    except (ValueError, TypeError, KeyError, RuntimeError):
        return None
    return None


def resolve_runtime_result_draft_references(
    state: Any, candidate: Any, *, run_id: str, runtime_attempt_id: str,
    requested_artifact_kinds: Any,
) -> tuple[Any, list[dict[str, Any]]]:
    """Expand explicit checksum-bound references, never replace submitted content.

    References are tool input only. The returned envelope still requires the
    ordinary complete Result validation and linked workflow checks.
    """
    if not isinstance(candidate, dict) or not isinstance(candidate.get("artifacts"), list):
        return candidate, []
    artifacts = candidate["artifacts"]
    if not any(isinstance(item, dict) and "draftReference" in item for item in artifacts):
        return candidate, []
    try:
        if (not 1 <= len(artifacts) <= 20
                or not isinstance(requested_artifact_kinds, list)
                or not requested_artifact_kinds
                or any(not isinstance(kind, str) for kind in requested_artifact_kinds)):
            raise ValueError
        resolved = _copy_candidate(candidate)
        normalizations: list[dict[str, Any]] = []
        for index, item in enumerate(artifacts):
            if not isinstance(item, dict) or "draftReference" not in item:
                continue
            reference = item["draftReference"]
            if (set(item) != {"draftReference"} or not isinstance(reference, dict)
                    or set(reference) != {"artifactIndex", "draftChecksum"}
                    or type(reference["artifactIndex"]) is not int
                    or reference["artifactIndex"] != index
                    or not _checksum(reference["draftChecksum"])):
                raise ValueError
            draft = latest_accepted_artifact_draft(
                state, run_id=run_id, runtime_attempt_id=runtime_attempt_id, artifact_index=index,
            )
            if (not isinstance(draft, dict) or draft.get("kind") not in {"prd", "prototype"}
                    or draft["kind"] not in requested_artifact_kinds):
                raise ValueError
            validation = validate_runtime_artifact_draft(draft)
            if (validation.get("ok") is not True
                    or validation.get("candidateChecksum") != reference["draftChecksum"]):
                raise ValueError
            resolved["artifacts"][index] = copy.deepcopy(draft)
            normalizations.append({
                "path": ["artifacts", index], "artifactIndex": index,
                "action": "resolved-accepted-draft-reference",
            })
        # Enforce the envelope size after expansion, before any model content can
        # cross the normal validator's process boundary.
        return _copy_candidate(resolved), normalizations
    except (ValueError, TypeError, KeyError, RuntimeError, ImportError, RecursionError):
        raise ValueError("WORKBENCH_RUNTIME_DRAFT_REFERENCE_INVALID") from None
