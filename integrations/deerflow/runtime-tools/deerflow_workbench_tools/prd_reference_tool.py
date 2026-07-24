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
        sha256="82ec80d5b8d68916b2fb9259e30db9e0982645ae96e6d189a9d1dd3daf2baf0f",
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
        sha256="ad2206958aee116654a657b1c979e7a0228aee1e080e2a289712bd7ad82b1c76",
    ),
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json": PrdReferenceSpec(
        physical_path=Path(
            "/app/skills/public/workbench/references/prd-runtime-result.schema.json",
        ),
        sha256="bd2f09b81bf8538a33ccf9eb0942d364c23dedf071979dad991fe09812f9e747",
    ),
})


@tool("read_file", parse_docstring=True)
def workbench_prd_reference_read(
    runtime: Runtime,
    description: str,
    path: PrdReferencePath,
) -> str:
    """Read one complete, pinned PRD reference for an authorized PRD-only Run.

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
    if requested_artifact_kinds != ["prd"]:
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
