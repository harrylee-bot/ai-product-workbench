#!/usr/bin/env python3
"""Apply and verify the single audited DeerFlow source patch."""

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
UPSTREAM_REPOSITORY = "https://github.com/bytedance/deer-flow"
EXPECTED_MANIFEST_KEYS = frozenset(
    {
        "protocol",
        "upstreamRepository",
        "upstreamCommit",
        "agent",
        "deferredMiddleware",
        "toolScopeMiddleware",
        "additionalSources",
        "gatewaySources",
        "patchApplier",
        "contractTest",
        "requestContextTest",
        "upgradeTest",
    }
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, content: str) -> None:
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
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


def _valid_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None


def _validate_replacements(value: object) -> bool:
    if not isinstance(value, list) or not value:
        return False
    for replacement in value:
        if not isinstance(replacement, dict) or frozenset(replacement) != {
            "anchor",
            "insertion",
            "position",
        }:
            return False
        if not isinstance(replacement["anchor"], str) or not replacement["anchor"]:
            return False
        if not isinstance(replacement["insertion"], str) or not replacement["insertion"]:
            return False
        if replacement["position"] not in {"before", "after", "replace"}:
            return False
    return True


def _validate_source_entries(
    value: object,
    seen_paths: set[str],
    required_prefix: str | None = None,
) -> list[dict]:
    if not isinstance(value, list):
        raise SystemExit("DEERFLOW_PATCH_MANIFEST_INVALID")
    entries: list[dict] = []
    for entry in value:
        if (
            not isinstance(entry, dict)
            or frozenset(entry) != {"path", "upstreamSha256", "patchedSha256", "replacements"}
            or not _valid_relative_path(entry.get("path"))
            or entry["path"] in seen_paths
            or not _valid_sha256(entry.get("upstreamSha256"))
            or not _valid_sha256(entry.get("patchedSha256"))
            or not _validate_replacements(entry.get("replacements"))
            or (
                required_prefix is not None
                and not entry["path"].startswith(required_prefix)
            )
        ):
            raise SystemExit("DEERFLOW_PATCH_MANIFEST_INVALID")
        seen_paths.add(entry["path"])
        entries.append(entry)
    return entries


def load_manifest() -> dict:
    with MANIFEST_PATH.open("r", encoding="utf-8") as source:
        manifest = json.load(source)
    if (
        not isinstance(manifest, dict)
        or frozenset(manifest) != EXPECTED_MANIFEST_KEYS
        or manifest.get("protocol") != "workbench.deerflow-source-patch.v1"
        or manifest.get("upstreamRepository") != UPSTREAM_REPOSITORY
        or not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("upstreamCommit", "")))
    ):
        raise SystemExit("DEERFLOW_PATCH_MANIFEST_INVALID")

    agent = manifest.get("agent")
    if (
        not isinstance(agent, dict)
        or frozenset(agent) != {"path", "upstreamSha256", "patchedSha256", "anchor", "insertion"}
        or not _valid_relative_path(agent.get("path"))
        or not _valid_sha256(agent.get("upstreamSha256"))
        or not _valid_sha256(agent.get("patchedSha256"))
        or not isinstance(agent.get("anchor"), str)
        or not agent.get("anchor")
        or not isinstance(agent.get("insertion"), str)
        or not agent.get("insertion")
    ):
        raise SystemExit("DEERFLOW_PATCH_MANIFEST_INVALID")

    deferred = manifest.get("deferredMiddleware")
    middleware = manifest.get("toolScopeMiddleware")
    if (
        not isinstance(deferred, dict)
        or frozenset(deferred) != {"path", "sha256"}
        or not _valid_relative_path(deferred.get("path"))
        or not _valid_sha256(deferred.get("sha256"))
        or not isinstance(middleware, dict)
        or frozenset(middleware) != {"path", "sha256"}
        or not _valid_relative_path(middleware.get("path"))
        or not _valid_sha256(middleware.get("sha256"))
    ):
        raise SystemExit("DEERFLOW_PATCH_MANIFEST_INVALID")

    seen_paths = {agent["path"], deferred["path"], middleware["path"]}
    additional_sources = _validate_source_entries(manifest.get("additionalSources"), seen_paths)
    gateway_sources = _validate_source_entries(
        manifest.get("gatewaySources"),
        set(),
        "app/gateway/",
    )

    for key in ("patchApplier", "contractTest", "requestContextTest", "upgradeTest"):
        entry = manifest.get(key)
        if (
            not isinstance(entry, dict)
            or frozenset(entry) != {"sha256"}
            or not _valid_sha256(entry.get("sha256"))
        ):
            raise SystemExit("DEERFLOW_PATCH_MANIFEST_INVALID")
    return manifest


def verify_hash(path: Path, expected: str, code: str) -> None:
    if not path.is_file() or sha256(path) != expected:
        raise SystemExit(code)


def render_source_patch(path: Path, entry: dict) -> str:
    source = path.read_text(encoding="utf-8")
    for replacement in entry["replacements"]:
        anchor = replacement["anchor"]
        insertion = replacement["insertion"]
        if source.count(anchor) != 1 or insertion in source:
            raise SystemExit("DEERFLOW_PATCH_SOURCE_ANCHOR_MISMATCH")
        if replacement["position"] == "before":
            source = source.replace(anchor, f"{insertion}{anchor}", 1)
        elif replacement["position"] == "after":
            source = source.replace(anchor, f"{anchor}{insertion}", 1)
        elif replacement["position"] == "replace":
            source = source.replace(anchor, insertion, 1)
        else:
            raise SystemExit("DEERFLOW_PATCH_MANIFEST_INVALID")
    return source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--gateway-root", type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    manifest = load_manifest()
    verify_hash(Path(__file__), manifest["patchApplier"]["sha256"], "DEERFLOW_PATCH_APPLIER_MISMATCH")
    verify_hash(
        PATCH_ROOT / "test_workbench_tool_scope_middleware.py",
        manifest["contractTest"]["sha256"],
        "DEERFLOW_PATCH_CONTRACT_TEST_MISMATCH",
    )
    verify_hash(
        PATCH_ROOT / "test_workbench_request_context.py",
        manifest["requestContextTest"]["sha256"],
        "DEERFLOW_PATCH_REQUEST_CONTEXT_TEST_MISMATCH",
    )
    verify_hash(
        PATCH_ROOT / "test_workbench_upgrade.py",
        manifest["upgradeTest"]["sha256"],
        "DEERFLOW_PATCH_UPGRADE_TEST_MISMATCH",
    )
    if arguments.source_commit != manifest.get("upstreamCommit"):
        raise SystemExit("DEERFLOW_PATCH_SOURCE_COMMIT_MISMATCH")

    root = arguments.root.resolve()
    gateway_sources_root = arguments.gateway_root.resolve() if arguments.gateway_root else None
    if manifest["gatewaySources"] and gateway_sources_root is None:
        raise SystemExit("DEERFLOW_PATCH_GATEWAY_ROOT_REQUIRED")
    agent = root / manifest["agent"]["path"]
    deferred = root / manifest["deferredMiddleware"]["path"]
    target_middleware = root / manifest["toolScopeMiddleware"]["path"]
    source_middleware = PATCH_ROOT / "workbench_tool_scope_middleware.py"
    additional_sources = [
        (root / entry["path"], entry)
        for entry in manifest["additionalSources"]
    ]
    gateway_sources = [
        (gateway_sources_root / entry["path"], entry)
        for entry in manifest["gatewaySources"]
    ] if gateway_sources_root is not None else []

    verify_hash(deferred, manifest["deferredMiddleware"]["sha256"], "DEERFLOW_PATCH_DEFERRED_SOURCE_MISMATCH")
    verify_hash(source_middleware, manifest["toolScopeMiddleware"]["sha256"], "DEERFLOW_PATCH_MIDDLEWARE_SOURCE_MISMATCH")

    if arguments.check:
        verify_hash(agent, manifest["agent"]["patchedSha256"], "DEERFLOW_PATCH_AGENT_NOT_APPLIED")
        verify_hash(target_middleware, manifest["toolScopeMiddleware"]["sha256"], "DEERFLOW_PATCH_MIDDLEWARE_NOT_APPLIED")
        for path, entry in additional_sources:
            verify_hash(path, entry["patchedSha256"], "DEERFLOW_PATCH_ADDITIONAL_SOURCE_NOT_APPLIED")
        for path, entry in gateway_sources:
            verify_hash(path, entry["patchedSha256"], "DEERFLOW_PATCH_GATEWAY_SOURCE_NOT_APPLIED")
        print("DeerFlow Workbench tool-scope patch verified.")
        return

    verify_hash(agent, manifest["agent"]["upstreamSha256"], "DEERFLOW_PATCH_AGENT_SOURCE_MISMATCH")
    source = agent.read_text(encoding="utf-8")
    anchor = manifest["agent"]["anchor"]
    insertion = manifest["agent"]["insertion"]
    if source.count(anchor) != 1 or insertion in source:
        raise SystemExit("DEERFLOW_PATCH_AGENT_ANCHOR_MISMATCH")
    patched = source.replace(anchor, f"{insertion}{anchor}", 1)
    rendered_additional_sources = []
    for path, entry in additional_sources:
        verify_hash(path, entry["upstreamSha256"], "DEERFLOW_PATCH_ADDITIONAL_SOURCE_MISMATCH")
        rendered_additional_sources.append((path, entry, render_source_patch(path, entry)))
    rendered_gateway_sources = []
    for path, entry in gateway_sources:
        verify_hash(path, entry["upstreamSha256"], "DEERFLOW_PATCH_GATEWAY_SOURCE_MISMATCH")
        rendered_gateway_sources.append((path, entry, render_source_patch(path, entry)))
    if target_middleware.exists() and sha256(target_middleware) != manifest["toolScopeMiddleware"]["sha256"]:
        raise SystemExit("DEERFLOW_PATCH_MIDDLEWARE_TARGET_CONFLICT")
    atomic_write(agent, patched)
    for path, _entry, rendered in rendered_additional_sources:
        atomic_write(path, rendered)
    for path, _entry, rendered in rendered_gateway_sources:
        atomic_write(path, rendered)
    target_middleware.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(target_middleware, source_middleware.read_text(encoding="utf-8"))
    verify_hash(agent, manifest["agent"]["patchedSha256"], "DEERFLOW_PATCH_AGENT_OUTPUT_MISMATCH")
    verify_hash(target_middleware, manifest["toolScopeMiddleware"]["sha256"], "DEERFLOW_PATCH_MIDDLEWARE_OUTPUT_MISMATCH")
    for path, entry, _rendered in rendered_additional_sources:
        verify_hash(path, entry["patchedSha256"], "DEERFLOW_PATCH_ADDITIONAL_SOURCE_OUTPUT_MISMATCH")
    for path, entry, _rendered in rendered_gateway_sources:
        verify_hash(path, entry["patchedSha256"], "DEERFLOW_PATCH_GATEWAY_SOURCE_OUTPUT_MISMATCH")
    print("DeerFlow Workbench tool-scope patch applied.")


if __name__ == "__main__":
    main()
