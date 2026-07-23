from __future__ import annotations

from difflib import SequenceMatcher
import json
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path
from typing import Any


VALIDATION_PROTOCOL = "workbench.runtime.validation.v1"
MAX_CANDIDATE_BYTES = 2_000_000
MAX_VALIDATOR_OUTPUT_BYTES = 65_536
PRD_REFERENCE_DOCUMENT_ID = "prd-example"
PRD_REFERENCE_WORK_ORDER_NAME = "示例工单"
PRD_REFERENCE_TITLE = "示例工单需求说明书"
PRD_REFERENCE_SAMPLE_PHRASES = (
    "现有产品工作台已提供业务任务处理入口",
    "让目标业务用户从端内入口完成任务提交、状态跟踪、异常恢复和结果确认的完整闭环",
    "任务处理依赖暂时不可用时，页面保留用户已填写的信息并停止重复提交",
    "产品流程图对应用户从进入页面到确认结果的操作与异常分支",
)
PRD_REFERENCE_FINGERPRINT_PROTOCOL = "workbench.prd-reference-fingerprint.v1"
PRD_INLINE_VISIBLE_KEYS = {
    "text": "text",
    "link": "text",
    "citation": "label",
    "reference": "label",
}


def _load_prd_reference_fingerprint() -> tuple[frozenset[str], frozenset[str]]:
    path = Path(__file__).with_name("prd_reference_fingerprint.json")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("WORKBENCH_PRD_REFERENCE_FINGERPRINT_INVALID") from error
    business_text = value.get("businessText") if isinstance(value, dict) else None
    sample_ids = value.get("sampleIds") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or value.get("protocol") != PRD_REFERENCE_FINGERPRINT_PROTOCOL
        or not isinstance(value.get("sourceDocumentSha256"), str)
        or re.fullmatch(r"[0-9a-f]{64}", value["sourceDocumentSha256"]) is None
        or not isinstance(business_text, list)
        or len(business_text) < 20
        or not all(isinstance(item, str) and item for item in business_text)
        or not isinstance(sample_ids, list)
        or len(sample_ids) < 20
        or not all(isinstance(item, str) and item for item in sample_ids)
    ):
        raise RuntimeError("WORKBENCH_PRD_REFERENCE_FINGERPRINT_INVALID")
    normalized_business_text = frozenset(
        _normalize_reference_text(item) for item in business_text
    )
    if "" in normalized_business_text or len(normalized_business_text) != len(business_text):
        raise RuntimeError("WORKBENCH_PRD_REFERENCE_FINGERPRINT_INVALID")
    return normalized_business_text, frozenset(sample_ids)


def _normalize_reference_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\W_]+", "", normalized, flags=re.UNICODE)


PRD_REFERENCE_BUSINESS_TEXT, PRD_REFERENCE_SAMPLE_IDS = _load_prd_reference_fingerprint()


class RuntimeResultValidatorError(RuntimeError):
    """A fixed-code failure from the local Runtime result validator."""


def validate_runtime_result(candidate: dict[str, Any]) -> dict[str, Any]:
    return _validate_candidate(candidate)


def validate_runtime_prototype_patch(candidate: dict[str, Any]) -> dict[str, Any]:
    result = _validate_candidate(candidate, mode="prototype-patch")
    if result["artifactChecksums"] != []:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_OUTPUT_INVALID")
    return result


def _validate_candidate(
    candidate: dict[str, Any],
    mode: str | None = None,
) -> dict[str, Any]:
    encoded = json.dumps(candidate, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_CANDIDATE_BYTES:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_RESULT_TOO_LARGE")

    node = shutil.which("node")
    if node is None:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_NODE_MISSING")
    bundle = Path(__file__).with_name("runtime_result_validator.bundle.mjs")
    if not bundle.is_file():
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_BUNDLE_MISSING")

    try:
        command = [node, str(bundle)]
        if mode is not None:
            command.append(mode)
        completed = subprocess.run(
            command,
            input=encoded,
            capture_output=True,
            check=False,
            timeout=20,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_TIMEOUT") from error
    if completed.returncode != 0:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_PROCESS_FAILED")
    if len(completed.stdout) > MAX_VALIDATOR_OUTPUT_BYTES:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_OUTPUT_TOO_LARGE")

    try:
        result = json.loads(completed.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_OUTPUT_INVALID") from error
    if (
        not isinstance(result, dict)
        or result.get("protocol") != VALIDATION_PROTOCOL
        or not isinstance(result.get("ok"), bool)
        or not isinstance(result.get("issues"), list)
        or not _optional_checksum(result.get("candidateChecksum"))
        or not isinstance(result.get("artifactChecksums"), list)
        or not all(_required_checksum(value) for value in result["artifactChecksums"])
    ):
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_OUTPUT_INVALID")
    if mode is None and result["ok"] is True:
        reference_issues = _prd_reference_issues(candidate)
        if reference_issues:
            return {
                **result,
                "ok": False,
                "issues": reference_issues,
            }
    return result


def validate_runtime_artifact_draft(candidate: dict[str, Any]) -> dict[str, Any]:
    result = validate_runtime_result({
        "protocol": "workbench.runtime.result.v1",
        "message": "",
        "artifacts": [candidate],
    })
    artifact_checksums = result["artifactChecksums"]
    if len(artifact_checksums) != 1:
        raise RuntimeResultValidatorError("WORKBENCH_RUNTIME_VALIDATOR_OUTPUT_INVALID")
    draft_result = {**result, "candidateChecksum": artifact_checksums[0]}
    if result["ok"] is True:
        return draft_result

    issues = []
    for issue in result["issues"]:
        adjusted = dict(issue)
        path = issue.get("path")
        if isinstance(path, list) and path[:2] == ["artifacts", 0]:
            adjusted["path"] = path[2:]
        issues.append(adjusted)
    return {**draft_result, "issues": issues}


def _required_checksum(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _optional_checksum(value: object) -> bool:
    return value is None or _required_checksum(value)


def _prd_reference_issues(candidate: dict[str, Any]) -> list[dict[str, Any]]:
    artifacts = candidate.get("artifacts")
    if not isinstance(artifacts, list):
        return []
    issues: list[dict[str, Any]] = []
    for artifact_index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            continue
        operation = artifact.get("operation")
        content = artifact.get("content")
        if (
            artifact.get("kind") != "prd"
            or not isinstance(operation, dict)
            or operation.get("kind") not in {"create", "revise"}
            or not isinstance(content, dict)
            or content.get("protocol") != "workbench.prd.v2"
        ):
            continue
        base_path = ["artifacts", artifact_index]
        if content.get("documentId") == PRD_REFERENCE_DOCUMENT_ID:
            issues.append(_reference_issue(
                [*base_path, "content", "documentId"],
                "PRD reference example documentId must be replaced before draft publication or submission",
            ))
        cover = content.get("cover")
        if isinstance(cover, dict) and cover.get("workOrderName") == PRD_REFERENCE_WORK_ORDER_NAME:
            issues.append(_reference_issue(
                [*base_path, "content", "cover", "workOrderName"],
                "PRD reference example work-order name must be replaced before draft publication or submission",
            ))
        if artifact.get("title") == PRD_REFERENCE_TITLE or content.get("title") == PRD_REFERENCE_TITLE:
            issues.append(_reference_issue(
                [*base_path, "title"],
                "PRD reference example title must be replaced before draft publication or submission",
            ))
        for relative_path, message in _prd_reference_content_matches(content):
            issues.append(_reference_issue(
                [*base_path, "content", *relative_path],
                message,
            ))
    return issues


def _prd_reference_content_match(
    content: dict[str, Any],
) -> tuple[list[object], str] | None:
    matches = _prd_reference_content_matches(content)
    return matches[0] if matches else None


def _prd_reference_content_matches(
    content: dict[str, Any],
) -> list[tuple[list[object], str]]:
    leaves = _string_leaves_with_paths(content)
    matches_by_path: dict[tuple[object, ...], tuple[list[object], str]] = {}

    def add(path: list[object], message: str) -> None:
        matches_by_path.setdefault(tuple(path), (path, message))

    for path, leaf in leaves:
        if path and path[-1] == "id" and leaf in PRD_REFERENCE_SAMPLE_IDS:
            add(path, f"PRD reference sample ID must be replaced: {leaf}")

    reference_by_length: dict[int, list[str]] = {}
    for reference in PRD_REFERENCE_BUSINESS_TEXT:
        if len(reference) >= 16:
            reference_by_length.setdefault(len(reference), []).append(reference)

    for path, leaf in [*leaves, *_visible_text_segments(content)]:
        message = _prd_reference_business_match_message(leaf, reference_by_length)
        if message is not None:
            add(path, message)
    return list(matches_by_path.values())


def _prd_reference_business_match_message(
    value: str,
    reference_by_length: dict[int, list[str]],
) -> str | None:
    if any(phrase in value for phrase in PRD_REFERENCE_SAMPLE_PHRASES):
        return "PRD contains unchanged sample business content from the reference example"
    normalized = _normalize_reference_text(value)
    if len(normalized) < 8:
        return None
    if normalized in PRD_REFERENCE_BUSINESS_TEXT:
        return "PRD contains unchanged sample business content from the reference example"
    if any(
        len(reference) >= 16 and reference in normalized
        for reference in PRD_REFERENCE_BUSINESS_TEXT
    ):
        return "PRD contains embedded sample business content from the reference example"
    if len(normalized) < 16:
        return None
    tolerance = max(2, len(normalized) // 12)
    for length in range(max(16, len(normalized) - tolerance), len(normalized) + tolerance + 1):
        for reference in reference_by_length.get(length, ()):
            if SequenceMatcher(None, normalized, reference, autojunk=False).ratio() >= 0.94:
                return "PRD contains near-copied sample business content from the reference example"
    return None


def _reference_issue(path: list[object], message: str) -> dict[str, Any]:
    return {
        "code": "custom",
        "path": path,
        "message": message,
    }


def _string_leaves(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in _string_leaves(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _string_leaves(item)]
    return []


def _string_leaves_with_paths(
    value: object,
    path: tuple[object, ...] = (),
) -> list[tuple[list[object], str]]:
    if isinstance(value, str):
        return [(list(path), value)]
    if isinstance(value, list):
        return [
            leaf
            for index, item in enumerate(value)
            for leaf in _string_leaves_with_paths(item, (*path, index))
        ]
    if isinstance(value, dict):
        return [
            leaf
            for key, item in value.items()
            for leaf in _string_leaves_with_paths(item, (*path, key))
        ]
    return []


def _visible_text_segments(value: object) -> list[tuple[list[object], str]]:
    segments: list[tuple[list[object], str]] = []

    def visit(current: object, path: tuple[object, ...]) -> None:
        if isinstance(current, list):
            for index, item in enumerate(current):
                visit(item, (*path, index))
            fragments: list[str] = []
            for item in current:
                if not isinstance(item, dict):
                    continue
                visible_key = PRD_INLINE_VISIBLE_KEYS.get(item.get("type"))
                fragment = item.get(visible_key) if visible_key is not None else None
                if isinstance(fragment, str):
                    fragments.append(fragment)
            if len(fragments) > 1:
                segments.append((list(path), "".join(fragments)))
        elif isinstance(current, dict):
            for key, item in current.items():
                visit(item, (*path, key))

    visit(value, ())
    return segments
