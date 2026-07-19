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
