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


def normalize_prototype_layout_aliases(
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Map common CSS layout spellings to the typed Prototype vocabulary."""
    normalized = copy.deepcopy(artifact)
    if normalized.get("kind") != "prototype":
        return normalized, []
    content = normalized.get("content")
    nodes = content.get("nodes") if isinstance(content, dict) else None
    if not isinstance(nodes, list):
        return normalized, []

    repairs: list[dict[str, Any]] = []
    for node_index, node in enumerate(nodes):
        layout = node.get("layout") if isinstance(node, dict) else None
        if not isinstance(layout, dict):
            continue
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
