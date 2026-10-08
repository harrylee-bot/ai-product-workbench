#!/usr/bin/env python3
"""Recover pinned upstream inputs inside a disposable image-build container."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read_checked(path, expected):
    if path.is_symlink() or not path.is_file():
        raise ValueError("RECOVERY_SOURCE_NOT_REGULAR: " + str(path))
    value = path.read_bytes()
    if digest(value) != expected:
        raise ValueError("RECOVERY_SOURCE_HASH_MISMATCH: " + str(path))
    return value


def under(root, absolute):
    if not absolute.startswith("/") or ".." in Path(absolute).parts:
        raise ValueError("RECOVERY_PATH_INVALID")
    return root / absolute.lstrip("/")


def replacement_text(entry):
    if entry["position"] == "before":
        return entry["insertion"] + entry["anchor"]
    if entry["position"] == "after":
        return entry["anchor"] + entry["insertion"]
    if entry["position"] == "replace":
        return entry["insertion"]
    raise ValueError("RECOVERY_REPLACEMENT_INVALID")


def reverse_source(value, entry, agent=False):
    if digest(value) != entry["patchedSha256"]:
        raise ValueError("RECOVERY_PATCHED_HASH_MISMATCH")
    text = value.decode("utf-8")
    if agent:
        if text.count(entry["insertion"]) != 1:
            raise ValueError("RECOVERY_REVERSE_ANCHOR_MISMATCH")
        text = text.replace(entry["insertion"], "", 1)
    else:
        for replacement in reversed(entry["replacements"]):
            inserted = replacement_text(replacement)
            if text.count(inserted) != 1:
                raise ValueError("RECOVERY_REVERSE_ANCHOR_MISMATCH")
            text = text.replace(inserted, replacement["anchor"], 1)
    result = text.encode("utf-8")
    if digest(result) != entry["upstreamSha256"]:
        raise ValueError("RECOVERY_UPSTREAM_HASH_MISMATCH")
    return result


def verify_candidate_round_trip(value, entry, agent=False):
    if digest(value) != entry["upstreamSha256"]:
        raise ValueError("RECOVERY_CANDIDATE_UPSTREAM_MISMATCH")
    text = value.decode("utf-8")
    replacements = [{"anchor": entry["anchor"], "insertion": entry["insertion"], "position": "before"}] if agent else entry["replacements"]
    for replacement in replacements:
        if text.count(replacement["anchor"]) != 1 or replacement["insertion"] in text:
            raise ValueError("RECOVERY_FORWARD_ANCHOR_MISMATCH")
        text = text.replace(replacement["anchor"], replacement_text(replacement), 1)
    if digest(text.encode("utf-8")) != entry["patchedSha256"]:
        raise ValueError("RECOVERY_CANDIDATE_OUTPUT_MISMATCH")


def source_entry(manifest, item):
    group = item["manifestGroup"]
    if group == "agent":
        entry = manifest[group]
    else:
        prefix = "/app/backend/" if group == "gatewaySources" else "/app/backend/packages/harness/"
        entry = next((e for e in manifest[group] if prefix + e["path"] == item["path"]), None)
    if entry is None:
        raise ValueError("RECOVERY_SOURCE_ENTRY_MISSING")
    return entry


def load_candidate(candidate_root, policy):
    manifest = json.loads(read_checked(candidate_root / "manifest.json", policy["candidatePatchManifestSha256"]))
    if manifest["upstreamCommit"] != policy["upstreamCommit"]:
        raise ValueError("RECOVERY_SOURCE_COMMIT_MISMATCH")
    for filename, key in [("apply.py", "patchApplier"), ("test_workbench_tool_scope_middleware.py", "contractTest"), ("test_workbench_request_context.py", "requestContextTest"), ("workbench_tool_scope_middleware.py", "toolScopeMiddleware")]:
        read_checked(candidate_root / filename, manifest[key]["sha256"])
    return manifest


def prepare_restore(root, candidate_root, policy):
    # Validate every pinned parent file and every transformation before writing.
    for filename, expected in policy["sourceFileSha256"].items():
        read_checked(under(root, filename), expected)
    old = json.loads(read_checked(under(root, policy["installedPatchManifestPath"]), policy["installedPatchManifestSha256"]))
    candidate = load_candidate(candidate_root, policy)
    if old["upstreamCommit"] != policy["upstreamCommit"]:
        raise ValueError("RECOVERY_SOURCE_COMMIT_MISMATCH")
    result = {}
    for item in policy["restoreSources"]:
        previous = source_entry(old, item)
        current = source_entry(candidate, item)
        upstream = reverse_source(under(root, item["path"]).read_bytes(), previous, item["manifestGroup"] == "agent")
        verify_candidate_round_trip(upstream, current, item["manifestGroup"] == "agent")
        result[item["path"]] = upstream
    return result


def atomic_write(path, content):
    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, temporary = tempfile.mkstemp(prefix=".workbench-recovery-", dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def check_restored(root, candidate_root, policy):
    candidate = load_candidate(candidate_root, policy)
    changed = {item["path"] for item in policy["restoreSources"]}
    removed = policy["removeMiddlewarePath"]
    for filename, expected in policy["sourceFileSha256"].items():
        if filename not in changed and filename != removed:
            read_checked(under(root, filename), expected)
    for item in policy["restoreSources"]:
        read_checked(under(root, item["path"]), source_entry(candidate, item)["upstreamSha256"])
    if under(root, removed).exists() or under(root, removed).is_symlink():
        raise ValueError("RECOVERY_MIDDLEWARE_STILL_PRESENT")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/"))
    parser.add_argument("--candidate-patch-root", type=Path, required=True)
    parser.add_argument("--source-image-id", required=True)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--restore", action="store_true")
    actions.add_argument("--check-restored", action="store_true")
    args = parser.parse_args()
    policy = json.loads(Path(__file__).with_name("manifest.json").read_text())
    if policy["schema"] != "workbench.deerflow-base-recovery.v1" or args.source_image_id != policy["sourceImageId"]:
        raise ValueError("RECOVERY_IMAGE_ID_MISMATCH")
    if args.check_restored:
        check_restored(args.root, args.candidate_patch_root, policy)
        mode = "restored-inputs-verified"
    else:
        plan = prepare_restore(args.root, args.candidate_patch_root, policy)
        mode = "verified-plan"
        if args.restore:
            for filename, content in plan.items():
                atomic_write(under(args.root, filename), content)
            under(args.root, policy["removeMiddlewarePath"]).unlink()
            check_restored(args.root, args.candidate_patch_root, policy)
            mode = "restored-candidate-inputs"
    print(json.dumps({"mode": mode, "applicationVersion": policy["applicationVersion"], "sourceImageId": policy["sourceImageId"], "restoredPaths": [item["path"] for item in policy["restoreSources"]], "preservedPaths": policy["preservedSourcePaths"]}))


if __name__ == "__main__":
    main()
