#!/usr/bin/env python3
"""Copy the verified current DeerFlow source into a clean runtime filesystem."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tomllib

SOURCE_PATHS = ["app", "packages", "sitecustomize.py", "pyproject.toml", "uv.lock", "README.md", "langgraph.json", ".python-version"]
IGNORED = {".venv", "__pycache__", ".git", ".deer-flow", "node_modules"}


def excluded(relative):
    return any(part in IGNORED or part == ".env" or part.startswith(".env.") for part in relative.parts)


def verify_inventory(backend, snapshot):
    actual = set()
    for name in SOURCE_PATHS:
        source = backend / name
        for file in source.rglob("*") if source.is_dir() else [source]:
            relative = file.relative_to(backend)
            if excluded(relative):
                continue
            if file.is_symlink():
                raise ValueError("RUNTIME_SOURCE_SYMLINK: " + str(relative))
            if file.is_file():
                actual.add("/app/backend/" + relative.as_posix())
    expected = {name for name in snapshot["fileSha256"] if name.startswith("/app/backend/")}
    if expected != actual:
        raise ValueError("RUNTIME_SOURCE_INVENTORY_MISMATCH")


def checked(path, expected):
    if not path.is_file() or path.is_symlink():
        raise ValueError("RUNTIME_SOURCE_NOT_REGULAR: " + str(path))
    value = path.read_bytes()
    if hashlib.sha256(value).hexdigest() != expected:
        raise ValueError("RUNTIME_SOURCE_HASH_MISMATCH: " + str(path))
    return value


def prepare(source_root, destination, recovery_root, candidate_patch_root):
    security_root = Path(__file__).resolve().parent
    security = json.loads((security_root / "dependencies.json").read_text())
    snapshot = json.loads((security_root / "source-snapshot.json").read_text())
    policy = json.loads((recovery_root / "manifest.json").read_text())
    spec = importlib.util.spec_from_file_location("workbench_recovery", recovery_root / "recover.py")
    recovery = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recovery)
    # This source-only snapshot comes from the current image, without live
    # business mounts. It includes the current pagination/history/rollback
    # fixes, which are absent from the public upstream source checkout.
    if (snapshot["schema"] != "workbench.deerflow-runtime-source.v1"
            or snapshot["applicationVersion"] != "1.0.0"
            or snapshot["upstreamCommit"] != policy["upstreamCommit"]):
        raise ValueError("RUNTIME_SOURCE_SNAPSHOT_IDENTITY_MISMATCH")
    for filename, expected in snapshot["fileSha256"].items():
        checked(recovery.under(source_root, filename), expected)
    installed = json.loads((source_root / "opt/workbench/deerflow/source-patch/manifest.json").read_text())
    candidate = recovery.load_candidate(candidate_patch_root, policy)
    if installed["upstreamCommit"] != policy["upstreamCommit"]:
        raise ValueError("RUNTIME_SOURCE_COMMIT_MISMATCH")
    backend = source_root / "app/backend"
    verify_inventory(backend, snapshot)
    project = checked(backend / "pyproject.toml", security["sourcePyprojectSha256"])
    checked(backend / "packages/harness/pyproject.toml", security["sourceHarnessPyprojectSha256"])
    checked(backend / "uv.lock", security["sourceLockSha256"])
    parsed = tomllib.loads(project.decode())
    if "constraint-dependencies" in parsed.get("tool", {}).get("uv", {}):
        raise ValueError("RUNTIME_SOURCE_CONSTRAINTS_ALREADY_PRESENT")
    if destination.exists():
        raise ValueError("RUNTIME_SOURCE_DESTINATION_ALREADY_EXISTS")
    destination.mkdir(parents=True)
    # Explicit source allowlist excludes the old virtualenv, runtime data,
    # environment files, npm, Docker CLI and every old operating-system file.
    for name in SOURCE_PATHS:
        original = backend / name
        if original.is_dir():
            shutil.copytree(original, destination / name, ignore=shutil.ignore_patterns(
                ".venv", "__pycache__", ".git", ".deer-flow", ".env", ".env.*", "node_modules",
            ))
        else:
            shutil.copy2(original, destination / name)
    for filename in policy["preservedSourcePaths"]:
        relative = Path(filename).relative_to("/app/backend")
        checked(destination / relative, policy["sourceFileSha256"][filename])
    # Reverse only the three deterministic installed patch inputs; the
    # candidate Dockerfile then applies and checks the current source patch.
    for item in policy["restoreSources"]:
        relative = Path(item["path"]).relative_to("/app/backend")
        previous = recovery.source_entry(installed, item)
        current = recovery.source_entry(candidate, item)
        upstream = recovery.reverse_source((destination / relative).read_bytes(), previous,
                                           item["manifestGroup"] == "agent")
        recovery.verify_candidate_round_trip(upstream, current, item["manifestGroup"] == "agent")
        (destination / relative).write_bytes(upstream)
    middleware = destination / Path(policy["removeMiddlewarePath"]).relative_to("/app/backend")
    middleware.unlink()
    constraints = "constraint-dependencies = [\n" + "".join(
        "    " + json.dumps(item) + ",\n" for item in security["constraints"]
    ) + "]\n"
    marker = "[tool.uv]\n"
    text = project.decode()
    if text.count(marker) != 1:
        raise ValueError("RUNTIME_SOURCE_UV_SECTION_MISMATCH")
    (destination / "pyproject.toml").write_text(text.replace(marker, marker + constraints, 1))
    shutil.copyfile(security_root / "uv.lock", destination / "uv.lock")
    print(json.dumps({"applicationVersion": "1.0.0", "sourceVerified": True,
                      "preservedPaths": policy["preservedSourcePaths"],
                      "securityConstraints": security["constraints"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--recovery-root", required=True, type=Path)
    parser.add_argument("--candidate-patch-root", required=True, type=Path)
    args = parser.parse_args()
    prepare(args.source_root, args.destination, args.recovery_root, args.candidate_patch_root)
