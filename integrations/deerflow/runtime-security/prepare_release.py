#!/usr/bin/env python3
"""Prepare the immutable 2.1.0 release source, then apply pinned security deps.

The legacy recovered-image source and its verification procedure stay intact
for rollback. New builds start from the upstream release, with Workbench's
compatibility changes applied separately by the checksum-bound source patch.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tomllib

from prepare_source import SOURCE_PATHS, checked, verify_inventory

COMMIT = "345f08be00c8a9495079b732a39b46aa9af1584e"


def prepare(source_root, destination, release_root, candidate_patch_root):
    snapshot = json.loads((release_root / "source-snapshot.json").read_text())
    policy = json.loads((release_root / "dependencies.json").read_text())
    candidate = json.loads((candidate_patch_root / "manifest.json").read_text())
    if (snapshot.get("schema") != "workbench.deerflow-runtime-source.v2"
            or snapshot.get("applicationVersion") != "1.0.0"
            or snapshot.get("upstreamVersion") != "2.1.0"
            or snapshot.get("upstreamRepository") != "https://github.com/bytedance/deer-flow"
            or snapshot.get("upstreamCommit") != COMMIT
            or policy.get("upstreamCommit") != COMMIT
            or candidate.get("upstreamCommit") != COMMIT):
        raise ValueError("RUNTIME_RELEASE_IDENTITY_MISMATCH")
    backend = source_root / "app/backend"
    verify_inventory(backend, snapshot)
    for filename, expected in snapshot["fileSha256"].items():
        relative = Path(filename).relative_to("/app/backend")
        checked(backend / relative, expected)
    project = checked(backend / "pyproject.toml", policy["sourcePyprojectSha256"])
    checked(backend / "packages/harness/pyproject.toml", policy["sourceHarnessPyprojectSha256"])
    checked(backend / "uv.lock", policy["sourceLockSha256"])
    locked = checked(release_root / "uv.lock", policy["securedLockSha256"])
    parsed = tomllib.loads(project.decode())
    if "constraint-dependencies" in parsed.get("tool", {}).get("uv", {}):
        raise ValueError("RUNTIME_RELEASE_CONSTRAINTS_ALREADY_PRESENT")
    if destination.exists():
        raise ValueError("RUNTIME_SOURCE_DESTINATION_ALREADY_EXISTS")
    destination.mkdir(parents=True)
    for name in SOURCE_PATHS:
        original = backend / name
        if original.is_dir():
            shutil.copytree(original, destination / name, ignore=shutil.ignore_patterns(
                ".venv", "__pycache__", ".git", ".deer-flow", ".env", ".env.*", "node_modules",
            ))
        else:
            shutil.copy2(original, destination / name)
    marker = "[tool.uv]\n"
    text = project.decode()
    if text.count(marker) != 1:
        raise ValueError("RUNTIME_SOURCE_UV_SECTION_MISMATCH")
    constraints = "constraint-dependencies = [\n" + "".join(
        "    " + json.dumps(item) + ",\n" for item in policy["constraints"]
    ) + "]\n"
    (destination / "pyproject.toml").write_text(text.replace(marker, marker + constraints, 1))
    (destination / "uv.lock").write_bytes(locked)
    return {"applicationVersion": "1.0.0", "upstreamVersion": "2.1.0",
            "sourceVerified": True, "verifiedFiles": len(snapshot["fileSha256"]),
            "securedLockSha256": hashlib.sha256(locked).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--release-root", type=Path, default=Path(__file__).with_name("upstream-2.1.0"))
    parser.add_argument("--candidate-patch-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source_root, args.destination, args.release_root, args.candidate_patch_root)))
