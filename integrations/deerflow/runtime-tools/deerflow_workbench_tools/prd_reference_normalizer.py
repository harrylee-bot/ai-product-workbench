from __future__ import annotations

import copy
from collections import Counter
from typing import Any


def normalize_prd_bidirectional_references(
    candidate: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Close valid PRD requirement/criterion links without inventing relations."""
    normalized = copy.deepcopy(candidate)
    if normalized.get("kind") != "prd" or normalized.get("schemaVersion") != 2:
        return normalized, []

    content = normalized.get("content")
    if not isinstance(content, dict) or content.get("protocol") != "workbench.prd.v2":
        return normalized, []
    sections = content.get("sections")
    if not isinstance(sections, dict):
        return normalized, []
    business_requirements = sections.get("businessRequirements")
    if not isinstance(business_requirements, dict):
        return normalized, []

    requirements = _typed_blocks(
        business_requirements.get("coreRules"),
        "requirement",
    )
    criteria = _typed_blocks(
        business_requirements.get("acceptanceCriteria"),
        "acceptanceCriterion",
    )
    requirement_counts = Counter(_block_id(block) for _index, block in requirements)
    criterion_counts = Counter(_block_id(block) for _index, block in criteria)
    requirement_by_id = {
        block_id: (index, block)
        for index, block in requirements
        if (block_id := _block_id(block)) is not None
        and requirement_counts[block_id] == 1
    }
    criterion_by_id = {
        block_id: (index, block)
        for index, block in criteria
        if (block_id := _block_id(block)) is not None
        and criterion_counts[block_id] == 1
    }

    repairs: list[dict[str, Any]] = []
    for requirement_index, requirement in requirements:
        requirement_id = _block_id(requirement)
        criterion_ids = requirement.get("acceptanceCriterionIds")
        if (
            requirement_id not in requirement_by_id
            or not _string_list(criterion_ids)
        ):
            continue
        for criterion_id in criterion_ids:
            criterion_entry = criterion_by_id.get(criterion_id)
            if criterion_entry is None:
                continue
            criterion_index, criterion = criterion_entry
            requirement_ids = criterion.get("requirementIds")
            if not _string_list(requirement_ids) or requirement_id in requirement_ids:
                continue
            requirement_ids.append(requirement_id)
            repairs.append({
                "path": [
                    "content",
                    "sections",
                    "businessRequirements",
                    "acceptanceCriteria",
                    "blocks",
                    criterion_index,
                    "requirementIds",
                ],
                "addedId": requirement_id,
                "sourcePath": [
                    "content",
                    "sections",
                    "businessRequirements",
                    "coreRules",
                    "blocks",
                    requirement_index,
                    "acceptanceCriterionIds",
                ],
            })

    for criterion_index, criterion in criteria:
        criterion_id = _block_id(criterion)
        requirement_ids = criterion.get("requirementIds")
        if criterion_id not in criterion_by_id or not _string_list(requirement_ids):
            continue
        for requirement_id in requirement_ids:
            requirement_entry = requirement_by_id.get(requirement_id)
            if requirement_entry is None:
                continue
            requirement_index, requirement = requirement_entry
            criterion_ids = requirement.get("acceptanceCriterionIds")
            if not _string_list(criterion_ids) or criterion_id in criterion_ids:
                continue
            criterion_ids.append(criterion_id)
            repairs.append({
                "path": [
                    "content",
                    "sections",
                    "businessRequirements",
                    "coreRules",
                    "blocks",
                    requirement_index,
                    "acceptanceCriterionIds",
                ],
                "addedId": criterion_id,
                "sourcePath": [
                    "content",
                    "sections",
                    "businessRequirements",
                    "acceptanceCriteria",
                    "blocks",
                    criterion_index,
                    "requirementIds",
                ],
            })

    return normalized, repairs


def normalize_runtime_result_prd_references(
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
        normalized_artifact, artifact_repairs = normalize_prd_bidirectional_references(
            artifact,
        )
        artifacts[artifact_index] = normalized_artifact
        repairs.extend({
            **repair,
            "path": ["artifacts", artifact_index, *repair["path"]],
            "sourcePath": ["artifacts", artifact_index, *repair["sourcePath"]],
        } for repair in artifact_repairs)
    return normalized, repairs


def _typed_blocks(section: Any, block_type: str) -> list[tuple[int, dict[str, Any]]]:
    if not isinstance(section, dict):
        return []
    blocks = section.get("blocks")
    if not isinstance(blocks, list):
        return []
    return [
        (index, block)
        for index, block in enumerate(blocks)
        if isinstance(block, dict) and block.get("type") == block_type
    ]


def _block_id(block: dict[str, Any]) -> str | None:
    block_id = block.get("id")
    return block_id if isinstance(block_id, str) and block_id else None


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)
