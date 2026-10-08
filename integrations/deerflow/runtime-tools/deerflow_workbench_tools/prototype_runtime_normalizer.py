from __future__ import annotations

import copy
import math
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

_OBSERVED_LITERAL_KIND_ALIAS = "literal长"

_PROTOTYPE_NODE_KINDS = frozenset({
    "frame",
    "form",
    "text",
    "icon",
    "image",
    "vector",
    "button",
    "input",
})

_COMMON_NODE_FIELDS = frozenset({
    "id",
    "screenId",
    "parentId",
    "name",
    "visible",
    "layout",
    "style",
    "actionIds",
    "bindingIds",
    "motionIds",
})

_NODE_FIELDS_BY_KIND = {
    "frame": _COMMON_NODE_FIELDS | {"kind", "childIds", "clipContent"},
    "form": _COMMON_NODE_FIELDS | {"kind", "childIds"},
    "text": _COMMON_NODE_FIELDS | {"kind", "text", "label", "maxLines"},
    "icon": _COMMON_NODE_FIELDS | {"kind", "assetId", "accessibilityLabel"},
    "image": _COMMON_NODE_FIELDS | {"kind", "assetId", "fit", "alt"},
    "vector": _COMMON_NODE_FIELDS | {"kind", "viewBox", "paths"},
    "button": _COMMON_NODE_FIELDS | {"kind", "label", "childIds", "buttonType", "disabled"},
    "input": _COMMON_NODE_FIELDS | {
        "kind",
        "inputType",
        "fieldName",
        "label",
        "placeholder",
        "optionValue",
        "options",
        "required",
        "disabled",
    },
}

_NODE_ARRAY_DEFAULTS = ("actionIds", "bindingIds", "motionIds")
_CHILD_NODE_KINDS = frozenset({"frame", "form", "button"})


def normalize_prototype_layout_aliases(
    artifact: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Repair deterministic Prototype authoring compatibility shapes before validation."""
    normalized = copy.deepcopy(artifact)
    if normalized.get("kind") != "prototype":
        return normalized, []
    content = normalized.get("content")
    if not isinstance(content, dict):
        return normalized, []

    repairs: list[dict[str, Any]] = []
    nodes = content.get("nodes")
    if isinstance(nodes, list):
        strict_node_shape = content.get("protocol") == "workbench.prototype.v1"
        normalized_nodes: list[Any] = []
        for node_index, node in enumerate(nodes):
            if not strict_node_shape:
                if not isinstance(node, dict):
                    normalized_nodes.append(node)
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
                if node.get("kind") == "text":
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
                normalized_nodes.append(node)
                continue
            node_kind = node.get("kind") if isinstance(node, dict) else None
            if not isinstance(node_kind, str) or node_kind not in _PROTOTYPE_NODE_KINDS:
                repairs.append({
                    "path": ["content", "nodes", node_index],
                    "action": "removed-unsupported-node",
                })
                continue
            allowed_fields = _NODE_FIELDS_BY_KIND[node_kind]
            for field in list(node):
                if field in allowed_fields:
                    continue
                del node[field]
                repairs.append({
                    "path": ["content", "nodes", node_index, field],
                    "action": "removed-unsupported-field",
                })
            for field in _NODE_ARRAY_DEFAULTS:
                if field in node:
                    continue
                node[field] = []
                repairs.append({
                    "path": ["content", "nodes", node_index, field],
                    "action": "defaulted",
                    "to": [],
                })
            if node_kind in _CHILD_NODE_KINDS and "childIds" not in node:
                node["childIds"] = []
                repairs.append({
                    "path": ["content", "nodes", node_index, "childIds"],
                    "action": "defaulted",
                    "to": [],
                })
            if node_kind == "frame" and "clipContent" not in node:
                node["clipContent"] = False
                repairs.append({
                    "path": ["content", "nodes", node_index, "clipContent"],
                    "action": "defaulted",
                    "to": False,
                })
            if node_kind == "text":
                if "text" not in node and isinstance(node.get("label"), str):
                    node["text"] = node["label"]
                    repairs.append({
                        "path": ["content", "nodes", node_index, "text"],
                        "action": "copied-from-label",
                    })
                if "maxLines" not in node:
                    node["maxLines"] = None
                    repairs.append({
                        "path": ["content", "nodes", node_index, "maxLines"],
                        "action": "defaulted",
                        "to": None,
                    })
                if "label" in node:
                    del node["label"]
                    repairs.append({
                        "path": ["content", "nodes", node_index, "label"],
                        "action": "removed-compatibility-alias",
                    })
            if node_kind in {"button", "input"} and "label" not in node and isinstance(node.get("name"), str):
                node["label"] = node["name"]
                repairs.append({
                    "path": ["content", "nodes", node_index, "label"],
                    "action": "copied-from-name",
                })
            layout = node.get("layout")
            if isinstance(layout, dict):
                if strict_node_shape and "z" in layout:
                    del layout["z"]
                    repairs.append({
                        "path": ["content", "nodes", node_index, "layout", "z"],
                        "action": "removed-unsupported-field",
                    })
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
            normalized_nodes.append(node)

        if strict_node_shape:
            valid_node_ids = {
                node.get("id")
                for node in normalized_nodes
                if isinstance(node, dict) and isinstance(node.get("id"), str)
            }
            for node_index, node in enumerate(normalized_nodes):
                if not isinstance(node, dict) or node.get("kind") not in _CHILD_NODE_KINDS:
                    continue
                child_ids = node.get("childIds")
                if not isinstance(child_ids, list):
                    continue
                filtered_child_ids = [
                    child_id for child_id in child_ids
                    if isinstance(child_id, str) and child_id in valid_node_ids
                ]
                if filtered_child_ids == child_ids:
                    continue
                node["childIds"] = filtered_child_ids
                repairs.append({
                    "path": ["content", "nodes", node_index, "childIds"],
                    "action": "removed-dangling-child-refs",
                    "removed": len(child_ids) - len(filtered_child_ids),
                })
        content["nodes"] = normalized_nodes

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
        _normalize_observed_literal_kind_aliases(content, ["content"], repairs)
        _normalize_prototype_graph_references(content, repairs)

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


def _normalize_observed_literal_kind_aliases(
    value: Any,
    path: list[str | int],
    repairs: list[dict[str, Any]],
) -> None:
    if isinstance(value, dict):
        literal_value = value.get("value")
        if (
            value.get("kind") == _OBSERVED_LITERAL_KIND_ALIAS
            and isinstance(literal_value, (int, float))
            and not isinstance(literal_value, bool)
            and (isinstance(literal_value, int) or math.isfinite(literal_value))
        ):
            value["kind"] = "literal"
            repairs.append({
                "path": [*path, "kind"],
                "from": _OBSERVED_LITERAL_KIND_ALIAS,
                "to": "literal",
            })
        for key, child in value.items():
            _normalize_observed_literal_kind_aliases(child, [*path, key], repairs)
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            _normalize_observed_literal_kind_aliases(child, [*path, index], repairs)


def _normalize_prototype_graph_references(
    content: dict[str, Any],
    repairs: list[dict[str, Any]],
) -> None:
    """Remove dangling generated references and keep input controls renderable."""
    states = content.get("states")
    state_ids = {
        state.get("id")
        for state in states
        if isinstance(state, dict) and isinstance(state.get("id"), str)
    } if isinstance(states, list) else set()
    if isinstance(content.get("screens"), list):
        for screen_index, screen in enumerate(content["screens"]):
            if not isinstance(screen, dict):
                continue
            initial_state_id = screen.get("initialStateId")
            if initial_state_id is not None and (
                not isinstance(initial_state_id, str)
                or initial_state_id not in state_ids
            ):
                screen["initialStateId"] = None
                repairs.append({
                    "path": ["content", "screens", screen_index, "initialStateId"],
                    "action": "cleared-dangling-state-ref",
                })

    actions = content.get("actions")
    action_ids = {
        action.get("id")
        for action in actions
        if isinstance(action, dict) and isinstance(action.get("id"), str)
    } if isinstance(actions, list) else set()
    bindings = content.get("bindings")
    binding_by_id = {
        binding.get("id"): binding
        for binding in bindings
        if isinstance(binding, dict) and isinstance(binding.get("id"), str)
    } if isinstance(bindings, list) else {}
    motions = content.get("motions")
    motion_ids = {
        motion.get("id")
        for motion in motions
        if isinstance(motion, dict) and isinstance(motion.get("id"), str)
    } if isinstance(motions, list) else set()

    nodes = content.get("nodes")
    if not isinstance(nodes, list):
        return
    used_binding_ids = set(binding_by_id)
    variables_collection = content.get("variables")
    used_variable_paths = {
        variable.get("path")
        for variable in variables_collection
        if isinstance(variable, dict) and isinstance(variable.get("path"), str)
    } if isinstance(variables_collection, list) else set()
    node_by_id = {
        node.get("id"): node
        for node in nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }

    def radio_group_key(node: dict[str, Any]) -> tuple[str, str | None, str] | None:
        if node.get("kind") != "input" or node.get("inputType") != "radio":
            return None
        screen_id = node.get("screenId")
        field_name = node.get("fieldName")
        if not isinstance(screen_id, str) or not isinstance(field_name, str):
            return None
        visited: set[str] = set()
        current = node
        form_id: str | None = None
        while isinstance(current.get("parentId"), str):
            parent_id = current["parentId"]
            if parent_id in visited:
                return None
            visited.add(parent_id)
            parent = node_by_id.get(parent_id)
            if not isinstance(parent, dict):
                return None
            if parent.get("kind") == "form":
                form_id = parent_id
                break
            current = parent
        return screen_id, form_id, field_name

    radio_group_paths: dict[tuple[str, str | None, str], set[str]] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        group_key = radio_group_key(node)
        if group_key is None or not isinstance(node.get("bindingIds"), list):
            continue
        for reference in node["bindingIds"]:
            if not isinstance(reference, str):
                continue
            binding = binding_by_id.get(reference)
            source = binding.get("source") if isinstance(binding, dict) else None
            if (
                not isinstance(binding, dict)
                or binding.get("nodeId") != node.get("id")
                or binding.get("property") != "value"
                or not isinstance(source, dict)
                or source.get("kind") != "variable"
                or not isinstance(source.get("path"), str)
                or source["path"] not in used_variable_paths
            ):
                continue
            radio_group_paths.setdefault(group_key, set()).add(source["path"])
    radio_group_variable_paths = {
        group_key: next(iter(paths))
        for group_key, paths in radio_group_paths.items()
        if len(paths) == 1
    }
    ambiguous_radio_groups = {
        group_key for group_key, paths in radio_group_paths.items()
        if len(paths) > 1
    }
    replacement_binding_ids: dict[str, str] = {}
    removed_binding_ids: set[str] = set()
    for node_index, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        for field, available_ids in (
            ("actionIds", action_ids),
            ("motionIds", motion_ids),
        ):
            references = node.get(field)
            if not isinstance(references, list):
                continue
            filtered = [
                reference for reference in references
                if isinstance(reference, str) and reference in available_ids
            ]
            if filtered == references:
                continue
            node[field] = filtered
            repairs.append({
                "path": ["content", "nodes", node_index, field],
                "action": "removed-dangling-refs",
                "removed": len(references) - len(filtered),
            })

        references = node.get("bindingIds")
        if not isinstance(references, list):
            continue
        missing_binding_references = [
            reference for reference in references
            if isinstance(reference, str) and reference not in binding_by_id
        ]
        filtered = [
            reference for reference in references
            if isinstance(reference, str) and reference in binding_by_id
        ]
        if filtered != references:
            node["bindingIds"] = filtered
            repairs.append({
                "path": ["content", "nodes", node_index, "bindingIds"],
                "action": "removed-dangling-refs",
                "removed": len(references) - len(filtered),
            })
        if node.get("kind") != "input" or not isinstance(node.get("id"), str):
            continue

        value_binding_ids = [
            reference
            for reference in node["bindingIds"]
            if isinstance(binding_by_id[reference], dict)
            and binding_by_id[reference].get("property") == "value"
            and binding_by_id[reference].get("nodeId") == node.get("id")
        ]
        valid_value_binding_ids = [
            reference
            for reference in value_binding_ids
            if isinstance(binding_by_id[reference].get("source"), dict)
            and binding_by_id[reference]["source"].get("kind") == "variable"
            and isinstance(binding_by_id[reference]["source"].get("path"), str)
            and binding_by_id[reference]["source"]["path"] in used_variable_paths
        ]
        if valid_value_binding_ids:
            canonical_binding_id = valid_value_binding_ids[0]
        elif value_binding_ids:
            canonical_binding_id = value_binding_ids[0]
        else:
            canonical_binding_id = None
        if canonical_binding_id is not None:
            replacement_binding_ids.update({
                reference: canonical_binding_id
                for reference in missing_binding_references
                if isinstance(reference, str)
            })
        if canonical_binding_id is not None and len(value_binding_ids) == 1 and len(valid_value_binding_ids) == 1:
            continue
        if not isinstance(variables_collection, list) or not isinstance(bindings, list):
            continue

        retained = [
            reference
            for reference in node["bindingIds"]
            if binding_by_id[reference].get("property") != "value"
        ]
        if canonical_binding_id is not None:
            obsolete_binding_ids = [
                reference
                for reference in value_binding_ids
                if reference != canonical_binding_id
            ]
            for reference in obsolete_binding_ids:
                replacement_binding_ids[reference] = canonical_binding_id
                binding_by_id.pop(reference, None)
                removed_binding_ids.add(reference)
            if obsolete_binding_ids:
                repairs.append({
                    "path": ["content", "nodes", node_index, "bindingIds"],
                    "action": "removed-redundant-input-value-bindings",
                    "removed": len(obsolete_binding_ids),
                })
            node["bindingIds"] = [*retained, canonical_binding_id]
            if valid_value_binding_ids:
                continue
        else:
            node["bindingIds"] = retained

        input_type = node.get("inputType")
        group_key = radio_group_key(node)
        variable_path = (
            radio_group_variable_paths.get(group_key)
            if group_key is not None and group_key not in ambiguous_radio_groups
            else None
        )
        if variable_path is None:
            variable_path = f"workbench_input_{node_index}"
            suffix = 2
            while variable_path in used_variable_paths:
                variable_path = f"workbench_input_{node_index}_{suffix}"
                suffix += 1
            used_variable_paths.add(variable_path)
            initial_value: Any = False if input_type == "checkbox" else 0 if input_type == "number" else None if input_type == "radio" else ""
            variables_collection.append({"path": variable_path, "initialValue": initial_value})
            repairs.append({
                "path": ["content", "variables", len(variables_collection) - 1],
                "action": "synthesized-input-variable",
            })
            if group_key is not None and group_key not in ambiguous_radio_groups:
                radio_group_variable_paths[group_key] = variable_path

        if canonical_binding_id is not None:
            binding = binding_by_id[canonical_binding_id]
            binding["source"] = {"kind": "variable", "path": variable_path}
            binding_index = next(
                index for index, candidate in enumerate(bindings)
                if candidate is binding
            )
            repairs.append({
                "path": ["content", "bindings", binding_index, "source"],
                "action": "repaired-input-binding-source",
            })
            continue

        binding_id = f"compat-binding-{node_index}"
        suffix = 2
        while binding_id in used_binding_ids:
            binding_id = f"compat-binding-{node_index}-{suffix}"
            suffix += 1
        used_binding_ids.add(binding_id)
        binding = {
            "id": binding_id,
            "nodeId": node.get("id"),
            "property": "value",
            "source": {"kind": "variable", "path": variable_path},
        }
        bindings.append(binding)
        binding_by_id[binding_id] = binding
        node["bindingIds"].append(binding_id)
        replacement_binding_ids.update({
            reference: binding_id
            for reference in missing_binding_references
            if isinstance(reference, str)
        })
        repairs.append({
            "path": ["content", "nodes", node_index, "bindingIds"],
            "action": "synthesized-input-binding",
        })

    if isinstance(actions, list):
        for action_index, action in enumerate(actions):
            if not isinstance(action, dict) or action.get("kind") != "submit":
                continue
            references = action.get("bindingIds")
            if not isinstance(references, list):
                continue
            normalized_references = [
                replacement_binding_ids.get(reference, reference)
                for reference in references
                if isinstance(reference, str)
            ]
            filtered_references = [
                reference for reference in normalized_references
                if reference in used_binding_ids
            ]
            deduplicated_references: list[str] = []
            submitted_radio_groups: set[tuple[str, str | None, str]] = set()
            for reference in filtered_references:
                binding = binding_by_id.get(reference)
                binding_node_id = binding.get("nodeId") if isinstance(binding, dict) else None
                input_node = (
                    node_by_id.get(binding_node_id)
                    if isinstance(binding_node_id, str)
                    else None
                )
                group_key = (
                    radio_group_key(input_node)
                    if isinstance(input_node, dict)
                    else None
                )
                if group_key is not None and group_key in submitted_radio_groups:
                    continue
                if group_key is not None:
                    submitted_radio_groups.add(group_key)
                deduplicated_references.append(reference)
            if deduplicated_references == references:
                continue
            action["bindingIds"] = deduplicated_references
            repairs.append({
                "path": ["content", "actions", action_index, "bindingIds"],
                "action": "repaired-input-binding-refs",
            })

    if removed_binding_ids and isinstance(bindings, list):
        bindings[:] = [
            binding
            for binding in bindings
            if (
                not isinstance(binding, dict)
                or not isinstance(binding.get("id"), str)
                or binding["id"] not in removed_binding_ids
            )
        ]


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
