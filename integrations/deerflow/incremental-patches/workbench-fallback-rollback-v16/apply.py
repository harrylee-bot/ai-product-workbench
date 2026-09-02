#!/usr/bin/env python3
"""Apply the Workbench terminal-LLM-error checkpoint rollback patch."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile


PATCH_ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = PATCH_ROOT / "manifest.json"
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, content: str) -> None:
    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def load_manifest() -> dict:
    with MANIFEST_PATH.open("r", encoding="utf-8") as source:
        manifest = json.load(source)
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {
            "protocol",
            "parentImage",
            "parentImageId",
            "worker",
            "patchApplierSha256",
            "contractTestSha256",
        }
        or manifest.get("protocol") != "workbench.deerflow-incremental-source-patch.v1"
        or not isinstance(manifest.get("parentImage"), str)
        or not manifest["parentImage"]
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(manifest.get("parentImageId", "")))
        or not SHA256_PATTERN.fullmatch(str(manifest.get("patchApplierSha256", "")))
        or not SHA256_PATTERN.fullmatch(str(manifest.get("contractTestSha256", "")))
    ):
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_MANIFEST_INVALID")
    worker = manifest.get("worker")
    if (
        not isinstance(worker, dict)
        or set(worker) != {"path", "upstreamSha256", "patchedSha256", "replacements"}
        or not isinstance(worker.get("path"), str)
        or not worker["path"]
        or Path(worker["path"]).is_absolute()
        or ".." in Path(worker["path"]).parts
        or not SHA256_PATTERN.fullmatch(str(worker.get("upstreamSha256", "")))
        or not SHA256_PATTERN.fullmatch(str(worker.get("patchedSha256", "")))
        or not isinstance(worker.get("replacements"), list)
        or not worker["replacements"]
    ):
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_MANIFEST_INVALID")
    for replacement in worker["replacements"]:
        if (
            not isinstance(replacement, dict)
            or set(replacement) != {"anchor", "replacement"}
            or not isinstance(replacement.get("anchor"), str)
            or not replacement["anchor"]
            or not isinstance(replacement.get("replacement"), str)
            or not replacement["replacement"]
        ):
            raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_MANIFEST_INVALID")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--parent-image", required=True)
    parser.add_argument("--parent-image-id", required=True)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    manifest = load_manifest()
    if sha256(Path(__file__)) != manifest["patchApplierSha256"]:
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_APPLIER_MISMATCH")
    if sha256(PATCH_ROOT / "test_workbench_fallback_rollback.py") != manifest["contractTestSha256"]:
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_CONTRACT_TEST_MISMATCH")
    if arguments.parent_image != manifest["parentImage"]:
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_PARENT_IMAGE_MISMATCH")
    if arguments.parent_image_id != manifest["parentImageId"]:
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_PARENT_IMAGE_ID_MISMATCH")

    worker_entry = manifest["worker"]
    worker_path = arguments.root.resolve() / worker_entry["path"]
    current_sha = sha256(worker_path)
    if arguments.check:
        if current_sha != worker_entry["patchedSha256"]:
            raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_NOT_APPLIED")
        print("DeerFlow Workbench fallback rollback patch verified.")
        return
    if current_sha != worker_entry["upstreamSha256"]:
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_SOURCE_MISMATCH")

    rendered = worker_path.read_text(encoding="utf-8")
    for replacement in worker_entry["replacements"]:
        anchor = replacement["anchor"]
        patched = replacement["replacement"]
        if rendered.count(anchor) != 1 or patched in rendered:
            raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_SOURCE_ANCHOR_MISMATCH")
        rendered = rendered.replace(anchor, patched, 1)
    atomic_write(worker_path, rendered)
    if sha256(worker_path) != worker_entry["patchedSha256"]:
        raise SystemExit("DEERFLOW_INCREMENTAL_PATCH_OUTPUT_MISMATCH")


if __name__ == "__main__":
    main()
