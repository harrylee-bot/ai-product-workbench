#!/usr/bin/env python3
"""Verify the complete pinned source archive before external OCI publication."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


def verify(archive, manifest, destination=None):
    policy = json.loads(manifest.read_text())
    legacy = (
        policy.get("schema") == "workbench.deerflow-runtime-source.v1"
        and re.fullmatch(r"sha256:[a-f0-9]{64}", policy.get("sourceImageId", ""))
        and policy.get("upstreamCommit") == "7a6c4a994a86583d2a3c056ee9d0f157d4f030c2"
    )
    release = (
        policy.get("schema") == "workbench.deerflow-runtime-source.v2"
        and policy.get("upstreamRepository") == "https://github.com/bytedance/deer-flow"
        and policy.get("upstreamVersion") == "2.1.0"
        and policy.get("upstreamCommit") == "345f08be00c8a9495079b732a39b46aa9af1584e"
        and all(name.startswith("/app/backend/") for name in policy.get("fileSha256", {}))
    )
    if policy.get("applicationVersion") != "1.0.0" or not (legacy or release):
        raise ValueError("SOURCE_ARCHIVE_IDENTITY_MISMATCH")
    archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    if archive_sha != policy.get("archiveSha256"):
        raise ValueError("SOURCE_ARCHIVE_HASH_MISMATCH")
    files = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for entry in bundle:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or ".." in path.parts or not (entry.isfile() or entry.isdir()):
                raise ValueError("SOURCE_ARCHIVE_UNSAFE_ENTRY")
            if any(part in {".venv", "__pycache__", ".git", ".deer-flow", "node_modules", ".env"}
                   or part.startswith(".env.") for part in path.parts):
                raise ValueError("SOURCE_ARCHIVE_RUNTIME_DATA")
            if entry.isdir():
                continue
            name = "/" + path.as_posix()
            if name in files or name not in policy["fileSha256"]:
                raise ValueError("SOURCE_ARCHIVE_UNEXPECTED_ENTRY")
            content = bundle.extractfile(entry).read()
            if hashlib.sha256(content).hexdigest() != policy["fileSha256"][name]:
                raise ValueError("SOURCE_ARCHIVE_FILE_HASH_MISMATCH: " + name)
            files[name] = content
    if set(files) != set(policy["fileSha256"]):
        raise ValueError("SOURCE_ARCHIVE_FILE_MISSING")
    # Verify all entries before creating any extracted file. No tar links,
    # traversal, or archive-provided modes are used during extraction.
    if destination is not None:
        destination.mkdir(parents=True, exist_ok=False)
        for name, content in files.items():
            target = destination / name.lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    return {"applicationVersion": "1.0.0", "archiveSha256": archive_sha,
            "upstreamCommit": policy["upstreamCommit"], "sourceImageId": policy.get("sourceImageId"), "verifiedFiles": len(files)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, default=Path(__file__).with_name("upstream-2.1.0") / "source.tar.gz")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("upstream-2.1.0") / "source-snapshot.json")
    parser.add_argument("--extract-to", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.manifest, args.extract_to)))
