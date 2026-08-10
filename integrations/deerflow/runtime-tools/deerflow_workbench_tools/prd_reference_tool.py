from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from types import MappingProxyType
from typing import Final, Literal, Mapping

from langchain.tools import tool

from deerflow.tools.types import Runtime


WorkbenchReferencePath = Literal[
    "/mnt/skills/public/requirement-doc-template/SKILL.md",
    "/mnt/skills/public/requirement-doc-template/references/structure.md",
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
    "/mnt/skills/public/workbench/references/prototype-runtime-result.example.json",
    "/mnt/skills/public/workbench/references/runtime-result-contract.md",
]


@dataclass(frozen=True)
class WorkbenchReferenceSpec:
    physical_path: Path
    sha256: str
    requested_artifact_kinds: tuple[str, ...]


WORKBENCH_REFERENCE_FILES: Final[
    Mapping[WorkbenchReferencePath, WorkbenchReferenceSpec]
] = MappingProxyType({
    "/mnt/skills/public/requirement-doc-template/SKILL.md": WorkbenchReferenceSpec(
        physical_path=Path("/app/skills/public/requirement-doc-template/SKILL.md"),
        sha256="82ec80d5b8d68916b2fb9259e30db9e0982645ae96e6d189a9d1dd3daf2baf0f",
        requested_artifact_kinds=("prd",),
    ),
    "/mnt/skills/public/requirement-doc-template/references/structure.md": WorkbenchReferenceSpec(
        physical_path=Path(
            "/app/skills/public/requirement-doc-template/references/structure.md",
        ),
        sha256="7952eb98fadbbd992f1bdbd227953aacbcbcdea7fdef1f758987750a9ac5bf70",
        requested_artifact_kinds=("prd",),
    ),
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md": WorkbenchReferenceSpec(
        physical_path=Path(
            "/app/skills/public/requirement-doc-template/references/quality-standards.md",
        ),
        sha256="ad2206958aee116654a657b1c979e7a0228aee1e080e2a289712bd7ad82b1c76",
        requested_artifact_kinds=("prd",),
    ),
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json": WorkbenchReferenceSpec(
        physical_path=Path(
            "/app/skills/public/workbench/references/prd-runtime-result.schema.json",
        ),
        sha256="bd2f09b81bf8538a33ccf9eb0942d364c23dedf071979dad991fe09812f9e747",
        requested_artifact_kinds=("prd",),
    ),
    "/mnt/skills/public/workbench/references/prototype-runtime-result.example.json": WorkbenchReferenceSpec(
        physical_path=Path(
            "/app/skills/public/workbench/references/prototype-runtime-result.example.json",
        ),
        sha256="e76e0c8b8c797a4941e31cc5067b80bb8106d4329b086ef743d6ad76ef958a99",
        requested_artifact_kinds=("prototype",),
    ),
    "/mnt/skills/public/workbench/references/runtime-result-contract.md": WorkbenchReferenceSpec(
        physical_path=Path(
            "/app/skills/public/workbench/references/runtime-result-contract.md",
        ),
        sha256="b7a3aaf96e8e88dd0c5c7be1f91dd79711bec28626a4eec0783c8f90b4682159",
        requested_artifact_kinds=("prototype",),
    ),
})


@tool("read_file", parse_docstring=True)
def workbench_prd_reference_read(
    runtime: Runtime,
    description: str,
    path: WorkbenchReferencePath,
) -> str:
    """Read one complete, pinned reference for an authorized PRD or Prototype Run.

    Args:
        description: Explain briefly why this Workbench reference is being read.
        path: The exact virtual path of one authorized Workbench reference.
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
    if not isinstance(path, str):
        raise ValueError("WORKBENCH_REFERENCE_PATH_INVALID")
    reference = WORKBENCH_REFERENCE_FILES.get(path)
    if reference is None:
        raise ValueError("WORKBENCH_REFERENCE_PATH_INVALID")
    if requested_artifact_kinds != list(reference.requested_artifact_kinds):
        raise ValueError("WORKBENCH_REFERENCE_TOOL_NOT_AUTHORIZED")

    try:
        content = reference.physical_path.read_bytes()
    except FileNotFoundError as error:
        raise ValueError("WORKBENCH_REFERENCE_FILE_MISSING") from error
    except OSError as error:
        raise ValueError("WORKBENCH_REFERENCE_FILE_UNREADABLE") from error

    actual_sha256 = hashlib.sha256(content).hexdigest()
    if actual_sha256 != reference.sha256:
        raise ValueError("WORKBENCH_REFERENCE_SHA256_MISMATCH")
    try:
        return content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError("WORKBENCH_REFERENCE_UTF8_INVALID") from error
