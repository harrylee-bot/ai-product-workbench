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

    # The fixed acceptance table has transport row IDs (normally ac-row-v-*),
    # but those IDs are not typed acceptanceCriterion entities. Keep them out
    # of the typed relationship after a real, already reciprocal criterion is
    # present. Never use a table row to invent a business relationship.
    acceptance_table_rows = _acceptance_table_rows(
        business_requirements.get("acceptanceCriteria"),
    )
    initial_reciprocal_criteria: dict[str, set[str]] = {}
    for requirement_id, (_requirement_index, requirement) in requirement_by_id.items():
        criterion_ids = requirement.get("acceptanceCriterionIds")
        if not _string_list(criterion_ids):
            continue
        reciprocal = {
            criterion_id
            for criterion_id in criterion_ids
            if (
                criterion_id in criterion_by_id
                and _string_list(criterion_by_id[criterion_id][1].get("requirementIds"))
                and requirement_id in criterion_by_id[criterion_id][1]["requirementIds"]
            )
        }
        initial_reciprocal_criteria[requirement_id] = reciprocal

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

    for requirement_index, requirement in requirements:
        requirement_id = _block_id(requirement)
        criterion_ids = requirement.get("acceptanceCriterionIds")
        if (
            requirement_id not in requirement_by_id
            or not _string_list(criterion_ids)
            or len(set(criterion_ids)) != len(criterion_ids)
        ):
            continue
        reciprocal_criteria = initial_reciprocal_criteria.get(requirement_id, set())
        # Exactly one real typed criterion must already be reciprocal. A
        # row-only candidate, an unknown ID, or multiple candidates remains a
        # validation error instead of being silently repaired.
        if len(reciprocal_criteria) != 1:
            continue
        row_candidates = [
            criterion_id
            for criterion_id in criterion_ids
            if criterion_id.startswith("ac-row-v-")
            and acceptance_table_rows.get(criterion_id, (0, None, None))[0] == 1
        ]
        if len(row_candidates) != 1:
            continue
        row_id = row_candidates[0]
        row_count, table_index, row_index = acceptance_table_rows[row_id]
        if row_count != 1 or table_index is None or row_index is None:
            continue
        requirement["acceptanceCriterionIds"] = [
            criterion_id for criterion_id in criterion_ids if criterion_id != row_id
        ]
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
            "removedId": row_id,
            "sourcePath": [
                "content",
                "sections",
                "businessRequirements",
                "acceptanceCriteria",
                "blocks",
                table_index,
                "rows",
                row_index,
                "id",
            ],
            "reason": "acceptance_table_row_reference",
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


def _acceptance_table_rows(
    section: Any,
) -> dict[str, tuple[int, int | None, int | None]]:
    """Index only the canonical acceptance table's unique row IDs."""
    if not isinstance(section, dict):
        return {}
    blocks = section.get("blocks")
    if not isinstance(blocks, list):
        return {}
    indexed: dict[str, tuple[int, int | None, int | None]] = {}
    for block_index, block in enumerate(blocks):
        if not isinstance(block, dict) or block.get("type") != "table":
            continue
        columns = block.get("columns")
        rows = block.get("rows")
        if not isinstance(columns, list) or not isinstance(rows, list):
            continue
        labels = [
            column.get("label", "").strip()
            for column in columns
            if isinstance(column, dict) and isinstance(column.get("label"), str)
        ]
        if labels != ["序号", "验收项", "验收标准"]:
            continue
        for row_index, row in enumerate(rows):
            row_id = row.get("id") if isinstance(row, dict) else None
            if not isinstance(row_id, str) or not row_id:
                continue
            previous = indexed.get(row_id)
            if previous is None:
                indexed[row_id] = (1, block_index, row_index)
            else:
                indexed[row_id] = (previous[0] + 1, None, None)
    return indexed


def _block_id(block: dict[str, Any]) -> str | None:
    block_id = block.get("id")
    return block_id if isinstance(block_id, str) and block_id else None


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)
