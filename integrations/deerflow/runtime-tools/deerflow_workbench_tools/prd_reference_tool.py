from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from types import MappingProxyType
from typing import Final, Literal, Mapping

from langchain.tools import tool

from deerflow.tools.types import Runtime


PrdReferencePath = Literal[
    "/mnt/skills/public/requirement-doc-template/SKILL.md",
    "/mnt/skills/public/requirement-doc-template/references/structure.md",
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
]


@dataclass(frozen=True)
class PrdReferenceSpec:
    physical_path: Path
    sha256: str


PRD_REFERENCE_FILES: Final[Mapping[PrdReferencePath, PrdReferenceSpec]] = MappingProxyType({
    "/mnt/skills/public/requirement-doc-template/SKILL.md": PrdReferenceSpec(
        physical_path=Path("/app/skills/public/requirement-doc-template/SKILL.md"),
        sha256="fe1493653986206aeed4684b46235c41d58e1e49db2b143ec0be5840542446e0",
    ),
    "/mnt/skills/public/requirement-doc-template/references/structure.md": PrdReferenceSpec(
        physical_path=Path(
            "/app/skills/public/requirement-doc-template/references/structure.md",
        ),
        sha256="7952eb98fadbbd992f1bdbd227953aacbcbcdea7fdef1f758987750a9ac5bf70",
    ),
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md": PrdReferenceSpec(
        physical_path=Path(
            "/app/skills/public/requirement-doc-template/references/quality-standards.md",
        ),
        sha256="32dc990927fbaf126e2d79f291869df8e576454261d4a644e916f3020c70d44e",
    ),
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json": PrdReferenceSpec(
        physical_path=Path(
            "/app/skills/public/workbench/references/prd-runtime-result.schema.json",
        ),
        sha256="52c29a5477e5a854bedf807ba947dca21b6f62d1a841c0f5aea3e1b55dddcd65",
    ),
})


@tool("read_file", parse_docstring=True)
def workbench_prd_reference_read(
    runtime: Runtime,
    description: str,
    path: PrdReferencePath,
) -> str:
    """Read one complete, pinned PRD reference for a Run that requests a PRD.

    Args:
        description: Explain briefly why this PRD reference is being read.
        path: The exact virtual path of one required PRD reference.
    """
    context = runtime.context if isinstance(runtime.context, dict) else {}
    scope = context.get("workbench")
    if not isinstance(scope, dict):
        raise ValueError("WORKBENCH_RUNTIME_SCOPE_MISSING")

    requested_artifact_kinds = scope.get("requestedArtifactKinds")
    if (
        not isinstance(requested_artifact_kinds, list)
        or any(not isinstance(kind, str) for kind in requested_artifact_kinds)
    ):
        raise ValueError("WORKBENCH_REQUESTED_ARTIFACT_KINDS_INVALID")
    if "prd" not in requested_artifact_kinds:
        raise ValueError("WORKBENCH_PRD_REFERENCE_TOOL_NOT_AUTHORIZED")

    if not isinstance(path, str):
        raise ValueError("WORKBENCH_PRD_REFERENCE_PATH_INVALID")
    reference = PRD_REFERENCE_FILES.get(path)
    if reference is None:
        raise ValueError("WORKBENCH_PRD_REFERENCE_PATH_INVALID")

    try:
        content = reference.physical_path.read_bytes()
    except FileNotFoundError as error:
        raise ValueError("WORKBENCH_PRD_REFERENCE_FILE_MISSING") from error
    except OSError as error:
        raise ValueError("WORKBENCH_PRD_REFERENCE_FILE_UNREADABLE") from error

    actual_sha256 = hashlib.sha256(content).hexdigest()
    if actual_sha256 != reference.sha256:
        raise ValueError("WORKBENCH_PRD_REFERENCE_SHA256_MISMATCH")
    try:
        return content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError("WORKBENCH_PRD_REFERENCE_UTF8_INVALID") from error
