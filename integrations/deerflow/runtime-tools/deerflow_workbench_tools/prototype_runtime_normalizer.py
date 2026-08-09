from __future__ import annotations

import copy
from typing import Any


_LAYOUT_ALIASES: dict[str, dict[str, str]] = {
    "align": {
        "flex-start": "start",
        "flex-end": "end",
    },
    "justify": {
        "flex-start": "start",
        "flex-end": "end",
        "space-between": "spaceBetween",
        "space-around": "spaceAround",
        "space_between": "spaceBetween",
        "space_around": "spaceAround",
    },
}

_PROTOTYPE_COLLECTION_DEFAULTS = (
    "tokens",
    "assets",
    "variables",
    "states",
    "actions",
    "bindings",
    "motions",
)

_MOTION_TRIGGER_ALIASES = {
    "mount": "enter",
}


def normalize_prototype_layout_aliases(
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Repair narrow, lossless Prototype compatibility aliases before validation."""
    normalized = copy.deepcopy(artifact)
    if normalized.get("kind") != "prototype":
        return normalized, []
    content = normalized.get("content")
    if not isinstance(content, dict):
        return normalized, []

    repairs: list[dict[str, Any]] = []
    nodes = content.get("nodes")
    if isinstance(nodes, list):
        for node_index, node in enumerate(nodes):
            if not isinstance(node, dict):
                continue
            layout = node.get("layout")
            if isinstance(layout, dict):
                for field, aliases in _LAYOUT_ALIASES.items():
                    value = layout.get(field)
                    canonical = aliases.get(value) if isinstance(value, str) else None
                    if canonical is None:
                        continue
                    layout[field] = canonical
                    repairs.append({
                        "path": ["content", "nodes", node_index, "layout", field],
                        "from": value,
                        "to": canonical,
                    })
            if node.get("kind") != "text":
                continue
            if "maxLines" not in node:
                node["maxLines"] = None
                repairs.append({
                    "path": ["content", "nodes", node_index, "maxLines"],
                    "action": "defaulted",
                    "to": None,
                })
            if "textStyle" in node:
                del node["textStyle"]
                repairs.append({
                    "path": ["content", "nodes", node_index, "textStyle"],
                    "action": "removed-unsupported",
                })

    if content.get("protocol") == "workbench.prototype.v1":
        for field in _PROTOTYPE_COLLECTION_DEFAULTS:
            if field in content:
                continue
            content[field] = []
            repairs.append({
                "path": ["content", field],
                "action": "defaulted",
                "to": [],
            })

    motions = content.get("motions")
    if isinstance(motions, list):
        for motion_index, motion in enumerate(motions):
            if not isinstance(motion, dict):
                continue
            trigger = motion.get("trigger")
            canonical = _MOTION_TRIGGER_ALIASES.get(trigger) if isinstance(trigger, str) else None
            if canonical is None:
                continue
            motion["trigger"] = canonical
            repairs.append({
                "path": ["content", "motions", motion_index, "trigger"],
                "from": trigger,
                "to": canonical,
            })
    return normalized, repairs


def normalize_runtime_result_prototype_layout_aliases(
    candidate: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    normalized = copy.deepcopy(candidate)
    artifacts = normalized.get("artifacts")
    if not isinstance(artifacts, list):
        return normalized, []

    repairs: list[dict[str, Any]] = []
    for artifact_index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            continue
        normalized_artifact, artifact_repairs = normalize_prototype_layout_aliases(artifact)
        artifacts[artifact_index] = normalized_artifact
        repairs.extend({
            **repair,
            "path": ["artifacts", artifact_index, *repair["path"]],
        } for repair in artifact_repairs)
    return normalized, repairs
