from __future__ import annotations

import json
import re
import shutil
import subprocess
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
            or operation.get("kind") != "create"
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
        content_text = "\n".join(_string_leaves(content))
        copied_phrases = [
            phrase for phrase in PRD_REFERENCE_SAMPLE_PHRASES
            if phrase in content_text
        ]
        if len(copied_phrases) >= 2:
            issues.append(_reference_issue(
                [*base_path, "content"],
                "PRD contains multiple unchanged passages of sample business content from the reference example",
            ))
    return issues


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
