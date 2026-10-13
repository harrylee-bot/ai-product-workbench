from __future__ import annotations

import hashlib
import json
from typing import Any

from langchain.tools import tool

from deerflow.tools.types import Runtime

from .artifact_draft_repair import resolve_artifact_draft_candidate
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
    draft: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Validate and publish one real 产品工作台 Artifact checkpoint.

    Call this after an Artifact becomes complete enough to render. Publish another
    checkpoint only after its renderable content materially changes.
    For the initial call, pass draft. After a rejection, prefer repair to edit only
    invalid paths in the latest rejected candidate while preserving all other data.
    Pass exactly one of draft or repair. A repair is {baseCandidateChecksum,
    operations:[{op:"replace",path:"/content/...",value:...}]}; use the checksum
    from the latest rejection. Supported operations are add, replace, remove, move
    (move uses from instead of value). Paths use JSON Pointer syntax. Move keeps
    the complete existing object; never overwrite an existing destination object.
    Every repaired candidate is validated in full before it can be accepted.

    Args:
        artifact_index: Stable zero-based index used by the final Runtime result.
        draft: One complete Runtime Artifact draft object, omitted when using repair.
        repair: Local edits to the latest rejected candidate: baseCandidateChecksum and operations (at most 24, at most 64 KiB). Omit draft. Never edit kind, schemaVersion, or operation.
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
    draft = resolve_artifact_draft_candidate(
        getattr(runtime, "state", None), run_id=run_id,
        runtime_attempt_id=runtime_attempt_id, tool_call_id=tool_call_id,
        artifact_index=artifact_index, draft=draft, repair=repair,
    )
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
        response["repairInstruction"] = (
            "Prefer the repair argument instead of retyping the full draft. "
            "Omit draft and pass repair={baseCandidateChecksum: this response's "
            "candidateChecksum, operations:[...]}; use JSON Pointer paths and "
            "add/replace/remove/move. This edits the latest rejected candidate "
            "without changing unrelated data. "
            + _artifact_draft_repair_instruction(draft, validation["issues"])
        )
        response["repairMode"] = {
            "baseCandidateChecksum": validation["candidateChecksum"],
            "supportedOperations": ["add", "replace", "remove", "move"],
            "maximumOperations": 24,
            "maximumBytes": 65_536,
            "editablePaths": ["/title", "/content/...", "/citations/..."],
            "immutableFields": ["kind", "schemaVersion", "operation"],
        }
        response["repairHints"] = _artifact_draft_repair_hints(draft, validation["issues"])
    return json.dumps(response, ensure_ascii=False, separators=(",", ":")), artifact


def _artifact_draft_repair_instruction(candidate: Any, issues: list[Any]) -> str:
    misplaced_sections = _misplaced_prd_sections(candidate, issues)
    if misplaced_sections:
        moves = "; ".join(
            f"content.sections.introduction.{name} to content.sections.{name}"
            for name in misplaced_sections
        )
        return (
            f"Move each complete existing section object: {moves}. "
            "These sections must be siblings of introduction, not children. "
            "Preserve their entire contents and every other valid field; remove "
            "only the misplaced copies from introduction. No draft was accepted. "
            "Correct remaining issue paths using checksum-bound repair operations "
            "directly in this run. Do not repeat generation stages, call "
            "read_file again, resubmit an unchanged candidate, or ask the user to retry."
        )
    if _has_prd_shape_failure(candidate, issues):
        return (
            "Repair the invalid top-level PRD structure using the workbench.prd.v2 "
            "contract: revision, cover, tableOfContents, and sections are objects; "
            "versionHistory and assumptions are arrays of complete objects; "
            "tableOfContents.entries is the directory entries array. "
            "Preserve all valid requested content and submit local repair operations "
            "against the returned candidateChecksum. Do not resubmit the unchanged "
            "candidate or use placeholders."
        )
    instruction = (
        "Edit only the returned issue paths using repair operations against the "
        "latest candidateChecksum; preserve every other field in the existing "
        "candidate. Do not discard valid sections for a local content or reference error. "
        "No draft was accepted. Do not resubmit an unchanged candidate: the same "
        "candidateChecksum will produce the same validation issues. Correct an "
        "identified field before publishing again; if the same issue persists, "
        "compare the named field's value and type with the contract already provided. "
        "Submit the repair directly; do not repeat generation stages or "
        "call read_file again, and do not stop merely to ask the user to retry."
    )
    if _has_checkbox_initial_value_failure(candidate, issues):
        instruction += (
            " For checkbox inputs, repair the referenced "
            "content.variables[index].initialValue using a JSON boolean true or "
            'false, never the strings "true" or "false". Preserve the intended '
            "checked state and existing binding ids; do not choose a new default."
        )
    return instruction


def _artifact_draft_repair_hints(candidate: Any, issues: list[Any]) -> list[dict[str, Any]]:
    """Bounded transport guidance only; never normalize or invent business content."""
    if (
        not isinstance(candidate, dict)
        or candidate.get("kind") != "prd"
        or candidate.get("schemaVersion") != 2
    ):
        return []
    hints: list[dict[str, Any]] = []
    used_bytes = 2  # The surrounding JSON array brackets.

    def append(hint: dict[str, Any]) -> None:
        nonlocal used_bytes
        encoded = json.dumps(hint, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        addition = len(encoded) + (1 if hints else 0)
        if len(hints) < 20 and used_bytes + addition <= 12_000 and hint not in hints:
            hints.append(hint)
            used_bytes += addition

    inline_shape = '[{type:"text",text:string,marks:[]}]'
    paragraph_shape = '{id:string,type:"paragraph",content:' + inline_shape + '}'
    list_shape = (
        '{id:string,type:"bulletList",items:[{id:string,content:' + inline_shape + '}]}'
    )
    section_shapes = {
        ("content", "sections"): (
            '{introduction:{title,background,scope,usageScenarios},'
            'businessRequirements:{title,summary,pageLinks,coreRules,flowAndPages,'
            'acceptanceCriteria,additionalSections},degradation:{title,applicable,content},'
            'safetyBaseline:{title,intro,rows}}'
        ),
        ("content", "sections", "businessRequirements"): (
            '{title:string,summary:Inline[],pageLinks:{title,blocks},coreRules:{title,blocks},'
            'flowAndPages:{title,blocks,diagrams},acceptanceCriteria:{title,blocks},'
            'additionalSections:[{title,blocks}]}'
        ),
        ("content", "sections", "degradation"): '{title:string,applicable:boolean,content:Inline[]}',
        ("content", "sections", "safetyBaseline"): '{title:string,intro:string,rows:SafetyRow[21]}',
        ("content", "sections", "businessRequirements", "acceptanceCriteria"): '{title:string,blocks:Block[]}',
        ("content", "sections", "businessRequirements", "additionalSections"): '[{title:string,blocks:Block[]}]',
    }
    for name in _misplaced_prd_sections(candidate, issues):
        append({
            "path": ["content", "sections", name],
            "moveFrom": ["content", "sections", "introduction", name],
            "instruction": "Move the complete existing object to this sibling path; preserve its contents and remove only the misplaced copy.",
        })
    relocation_paths = [
        (["sections"], ["content", "sections"], dict),
        (["degradation"], ["content", "sections", "degradation"], dict),
        (["safetyBaseline"], ["content", "sections", "safetyBaseline"], dict),
        (["content", "degradation"], ["content", "sections", "degradation"], dict),
        (["content", "safetyBaseline"], ["content", "sections", "safetyBaseline"], dict),
        (["content", "sections", "flowAndPages"], ["content", "sections", "businessRequirements", "flowAndPages"], dict),
        (["content", "sections", "businessRequirements", "diagrams"], ["content", "sections", "businessRequirements", "flowAndPages", "diagrams"], list),
        (["content", "sections", "acceptanceCriteria"], ["content", "sections", "businessRequirements", "acceptanceCriteria"], dict),
        (["content", "sections", "additionalSections"], ["content", "sections", "businessRequirements", "additionalSections"], list),
    ]
    for source, target, expected_type in relocation_paths:
        parent = _candidate_value(candidate, target[:-1])
        if (
            isinstance(parent, dict) and target[-1] not in parent
            and isinstance(_candidate_value(candidate, source), expected_type)
            and any(isinstance(i, dict) and i.get("code") == "unrecognized_keys" and i.get("path") == source[:-1] for i in issues)
            # additionalSections has a contract default, so only its rejected
            # source is required as evidence; it must still remain absent here.
            and (target[-1] == "additionalSections" or any(isinstance(i, dict) and i.get("code") == "invalid_type" and i.get("path") == target for i in issues))
        ):
            append({"path": target, "moveFrom": source, "instruction": "Move the complete existing value to its exact owning path and remove only the misplaced copy. Preserve all nested content; do not rewrite it."})
    for issue in issues[:100]:
        if not isinstance(issue, dict) or not isinstance(issue.get("path"), list):
            continue
        path = issue["path"]
        if len(path) > 24 or any(
            isinstance(part, bool) or not isinstance(part, (str, int))
            or (isinstance(part, str) and len(part) > 96)
            for part in path
        ):
            continue
        code = issue.get("code")
        if code == "invalid_type" and len(path) >= 5 and path[-1] == "cells" and path[-3] == "rows":
            row = _candidate_value(candidate, path[:-1])
            block_array = path[:-4]
            if (
                isinstance(row, dict) and row.get("type") in {"requirement", "goal"}
                and "cells" not in row and block_array and block_array[-1] == "blocks"
                and isinstance(_candidate_value(candidate, block_array), list)
            ):
                append({
                    "path": path[:-1], "owningArrayPath": block_array,
                    "instruction": "This is an authored requirement/goal block misplaced inside table.rows. Use a move operation to relocate the whole object into the owning section's blocks array at the intended position. Preserve its text, IDs, and references; do not turn it into an empty table row or rewrite its business content. Array indexes apply after each preceding move/removal.",
                })
        if (
            isinstance(issue.get("expectedValue"), str)
            and len(issue["expectedValue"]) <= 2_000
            and (
                code == "invalid_literal" and path == ["content", "sections", "safetyBaseline", "intro"]
                or code == "custom" and len(path) == 4 and path[:3] == ["content", "tableOfContents", "entries"]
                and isinstance(path[3], int) and not isinstance(path[3], bool)
            )
        ):
            append({
                "path": path,
                "expectedValue": issue["expectedValue"],
                "instruction": "Copy this exact contract-owned string, including punctuation and newlines. It is fixed template text, not a business assertion.",
            })
        if code == "invalid_type" and tuple(path) in section_shapes:
            append({
                "path": path,
                "structure": section_shapes[tuple(path)],
                "instruction": "This is type notation, not replacement content. Preserve existing sections and relocate misplaced complete objects to these exact paths; do not recreate their business text.",
            })
        if (
            len(path) >= 2 and path[-2] == "blocks" and isinstance(path[-1], int)
            and code in ("invalid_type", "invalid_union", "invalid_union_discriminator")
        ):
            misplaced_field_paths = {
                "introduction": ["content", "sections", "introduction"],
                "background": ["content", "sections", "introduction", "background"],
                "scope": ["content", "sections", "introduction", "scope"],
                "usageScenarios": ["content", "sections", "introduction", "usageScenarios"],
                "businessRequirements": ["content", "sections", "businessRequirements"],
                "degradation": ["content", "sections", "degradation"],
                "safetyBaseline": ["content", "sections", "safetyBaseline"],
                "pageLinks": ["content", "sections", "businessRequirements", "pageLinks"],
                "coreRules": ["content", "sections", "businessRequirements", "coreRules"],
                "flowAndPages": ["content", "sections", "businessRequirements", "flowAndPages"],
                "acceptanceCriteria": ["content", "sections", "businessRequirements", "acceptanceCriteria"],
            }
            value = _candidate_value(candidate, path)
            owning_path = misplaced_field_paths.get(value) if isinstance(value, str) else None
            if owning_path is not None:
                exists = isinstance(_candidate_value(candidate, owning_path), dict)
                append({
                    "path": path,
                    "owningPath": owning_path,
                    "instruction": (
                        "This string is a schema field name, not business text, a block object, or a valid reference. "
                        + ("The owning field already contains an object: remove only this invalid duplicate string from blocks and preserve that object."
                           if exists else "Restore the required object at owningPath using existing authored content, then remove this invalid field-name string from blocks.")
                        + " Never wrap a schema field name in a text paragraph or list item. Keep all genuine business blocks unchanged."
                    ),
                })
                continue
            scope = path[:4] == ["content", "sections", "introduction", "scope"]
            append({
                "path": path,
                "structure": list_shape if scope else paragraph_shape,
                "instruction": (
                    "Every blocks entry is a typed object, never a string or Markdown. "
                    "This is type notation: preserve existing business text and stable IDs; allocate unique IDs only for new objects. Schema field names and IDs are not business text and must not become prose. "
                    + ("Scope needs an explicit bulletList or orderedList; every list item is an object with id and an inline content array."
                       if scope else "Use the block type that preserves the existing meaning; a paragraph contains an inline content array.")
                ),
            })
        if code == "custom" and path == ["content", "sections", "introduction", "scope", "blocks"] and issue.get("message") == "document scope must contain an explicit list":
            append({
                "path": path,
                "structure": list_shape,
                "instruction": "Represent existing scope items as a typed bulletList or orderedList. Preserve their meaning; do not append a plain string or a Markdown list to blocks.",
            })
        if code == "invalid_type" and path and path[-1] == "marks":
            parent = _candidate_value(candidate, path[:-1])
            if isinstance(parent, dict) and parent.get("type") == "text":
                append({
                    "path": path,
                    "structure": 'marks: Array<"strong"|"emphasis"|"code"|"strikethrough">',
                    "instruction": "Every text inline requires marks. Use [] for unformatted text, otherwise preserve its intended format with unique allowed marks. Preserve the sibling text exactly.",
                })
        if code == "invalid_type" and issue.get("expectedType") in ("object", "array", "string", "number", "boolean", "null"):
            append({"path": path, "expectedType": issue["expectedType"], "instruction": "Repair this field's JSON type while preserving its existing meaning and every unrelated field."})
    return hints


def _candidate_value(candidate: Any, path: list[Any]) -> Any:
    value = candidate
    for part in path:
        if isinstance(value, dict) and isinstance(part, str):
            value = value.get(part)
        elif isinstance(value, list) and isinstance(part, int) and not isinstance(part, bool) and 0 <= part < len(value):
            value = value[part]
        else:
            return None
    return value


def _misplaced_prd_sections(candidate: Any, issues: list[Any]) -> list[str]:
    if (
        not isinstance(candidate, dict)
        or candidate.get("kind") != "prd"
        or candidate.get("schemaVersion") != 2
    ):
        return []
    content = candidate.get("content")
    sections = content.get("sections") if isinstance(content, dict) else None
    introduction = sections.get("introduction") if isinstance(sections, dict) else None
    if not isinstance(introduction, dict):
        return []
    if not any(
        isinstance(issue, dict)
        and issue.get("code") == "unrecognized_keys"
        and issue.get("path") == ["content", "sections", "introduction"]
        for issue in issues
    ):
        return []
    return [
        name for name in ("businessRequirements", "degradation", "safetyBaseline")
        if name not in sections
        and isinstance(introduction.get(name), dict)
        and any(
            isinstance(issue, dict)
            and issue.get("code") == "invalid_type"
            and issue.get("path") == ["content", "sections", name]
            for issue in issues
        )
    ]


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
