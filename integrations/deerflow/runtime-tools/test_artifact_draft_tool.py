from __future__ import annotations

import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace


def _tool(*_args: object, **_kwargs: object):
    def decorate(function):
        function.func = function
        return function

    return decorate


langchain = ModuleType("langchain")
langchain_tools = ModuleType("langchain.tools")
langchain_tools.tool = _tool
deerflow = ModuleType("deerflow")
deerflow_tools = ModuleType("deerflow.tools")
deerflow_tool_types = ModuleType("deerflow.tools.types")
deerflow_tool_types.Runtime = object
sys.modules.update({
    "langchain": langchain,
    "langchain.tools": langchain_tools,
    "deerflow": deerflow,
    "deerflow.tools": deerflow_tools,
    "deerflow.tools.types": deerflow_tool_types,
})

from deerflow_workbench_tools.artifact_draft_tool import (
    _artifact_draft_repair_hints,
    _has_prd_shape_failure,
    _misplaced_prd_sections,
    workbench_artifact_draft_publish,
)


ROOT = Path(__file__).resolve().parents[3]
PROTOTYPE_EXAMPLE_PATH = ROOT / "integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json"
PRD_EXAMPLE_PATH = ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json"


from prd_acceptance_test_fixture import anonymous_acceptance_collision


class ArtifactDraftToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                    "requestedArtifactKinds": ["prototype"],
                },
            },
            tool_call_id="call_1",
        )
        self.prd_runtime = SimpleNamespace(
            context={
                "workbench": {
                    "runId": "run_1",
                    "runtimeAttemptId": "attempt_1",
                    "requestedArtifactKinds": ["prd"],
                },
            },
            tool_call_id="call_prd",
        )
        result = json.loads(PROTOTYPE_EXAMPLE_PATH.read_text(encoding="utf-8"))
        self.draft = result["artifacts"][0]
        prd_result = json.loads(PRD_EXAMPLE_PATH.read_text(encoding="utf-8"))
        self.prd_draft = prd_result["artifacts"][0]

    def test_binds_a_valid_draft_to_the_runtime_scope(self) -> None:
        content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            self.draft,
        )

        envelope = {
            "protocol": "workbench.runtime.artifact-draft.v1",
            "runId": "run_1",
            "runtimeAttemptId": "attempt_1",
            "toolCallId": "call_1",
            "artifactIndex": 0,
            "ok": True,
            "draftChecksum": artifact["draftChecksum"],
        }
        expected_checksum = hashlib.sha256(
            json.dumps(
                envelope,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8"),
        ).hexdigest()
        self.assertEqual(json.loads(content)["ok"], True)
        self.assertEqual(artifact, {
            **envelope,
            "draft": self.draft,
            "checksum": expected_checksum,
        })

    def test_returns_scoped_validation_issues_for_an_invalid_draft(self) -> None:
        invalid = copy.deepcopy(self.draft)
        del invalid["title"]

        content, artifact = workbench_artifact_draft_publish.func(
            self.runtime,
            0,
            invalid,
        )

        response = json.loads(content)
        self.assertEqual(response["ok"], False)
        self.assertEqual(artifact["ok"], False)
        self.assertTrue(any(issue["path"] == ["title"] for issue in response["issues"]))
        self.assertNotIn("draft", artifact)

    def test_prototype_graph_ack_repairs_only_the_reported_links(self) -> None:
        draft = copy.deepcopy(self.draft)
        root, form, *_ = draft["content"]["nodes"]
        missing_child = "node-not-present"
        root["childIds"] = []
        form["childIds"].append(missing_child)
        json_ack, receipt = workbench_artifact_draft_publish.func(self.runtime, 0, draft)
        ack = json.loads(json_ack)
        self.assertFalse(receipt["ok"])
        repair = ack["prototypeGraphRepair"]
        self.assertEqual(repair, {
            "baseCandidateChecksum": ack["candidateChecksum"],
            "operations": [
                {"op": "add", "path": "/content/nodes/0/childIds/-", "value": form["id"]},
                {"op": "remove", "path": "/content/nodes/1/childIds/2"},
            ],
        })

        self.runtime.tool_call_id = "graph_repair_1"
        self.runtime.state = {"messages": [
            {"type": "human"},
            {"type": "ai", "tool_calls": [{"name": "workbench_artifact_draft_publish",
                "id": "call_1", "args": {"artifact_index": 0, "draft": draft}}]},
            {"type": "tool", "name": "workbench_artifact_draft_publish", "tool_call_id": "call_1",
                "status": "success", "content": json_ack, "artifact": receipt},
            {"type": "ai", "tool_calls": [{"name": "workbench_artifact_draft_publish",
                "id": "graph_repair_1", "args": {"artifact_index": 0, "repair": repair}}]},
        ]}
        _, repaired = workbench_artifact_draft_publish.func(self.runtime, 0, repair=repair)
        self.assertTrue(repaired["ok"])
        self.assertEqual(repaired["draft"], self.draft)

    def test_prototype_graph_ack_does_not_guess_links_for_duplicate_node_ids(self) -> None:
        draft = copy.deepcopy(self.draft)
        root, form, *_ = draft["content"]["nodes"]
        root["childIds"] = []
        form["childIds"].append("node-not-present")
        draft["content"]["nodes"].append(copy.deepcopy(form))
        json_ack, receipt = workbench_artifact_draft_publish.func(self.runtime, 0, draft)
        self.assertFalse(receipt["ok"])
        self.assertNotIn("prototypeGraphRepair", json.loads(json_ack))

    def test_prototype_graph_ack_restores_missing_frame_clip_flag(self) -> None:
        draft = copy.deepcopy(self.draft)
        del draft["content"]["nodes"][0]["clipContent"]
        content, receipt = workbench_artifact_draft_publish.func(self.runtime, 0, draft)
        ack = json.loads(content)
        self.assertFalse(receipt["ok"])
        self.assertEqual(ack["prototypeGraphRepair"]["operations"], [
            {"op": "add", "path": "/content/nodes/0/clipContent", "value": False},
        ])

    def test_checkbox_repair_names_the_variable_and_preserves_false_without_coercion(self) -> None:
        invalid = copy.deepcopy(self.draft)
        input_node = next(
            node for node in invalid["content"]["nodes"] if node["kind"] == "input"
        )
        input_node["inputType"] = "checkbox"
        invalid["content"]["variables"][0]["initialValue"] = "false"
        before = copy.deepcopy(invalid)

        content, artifact = workbench_artifact_draft_publish.func(self.runtime, 0, invalid)
        repeated_content, _ = workbench_artifact_draft_publish.func(self.runtime, 0, invalid)
        response = json.loads(content)
        repeated_response = json.loads(repeated_content)

        self.assertFalse(response["ok"])
        self.assertEqual(response["issues"], [{
            "code": "custom",
            "path": ["content", "variables", 0, "initialValue"],
            "message": (
                "checkbox input variable form.name initialValue must be boolean; "
                "received string"
            ),
        }])
        self.assertIn("JSON boolean true or false", response["repairInstruction"])
        self.assertIn('never the strings "true" or "false"', response["repairInstruction"])
        self.assertIn("Do not resubmit an unchanged candidate", response["repairInstruction"])
        self.assertNotIn("continue repairing until", response["repairInstruction"])
        self.assertRegex(response["candidateChecksum"], r"^[0-9a-f]{64}$")
        self.assertEqual(repeated_response, response)
        self.assertEqual(invalid, before)
        self.assertNotIn("draft", artifact)

        repaired = copy.deepcopy(invalid)
        repaired["content"]["variables"][0]["initialValue"] = False
        repaired_content, repaired_artifact = workbench_artifact_draft_publish.func(
            self.runtime, 0, repaired,
        )
        repaired_response = json.loads(repaired_content)
        self.assertTrue(repaired_response["ok"])
        self.assertNotEqual(repaired_response["candidateChecksum"], response["candidateChecksum"])
        self.assertIs(
            repaired_artifact["draft"]["content"]["variables"][0]["initialValue"], False,
        )
        self.assertEqual(repaired_artifact["draft"]["content"]["bindings"], before["content"]["bindings"])

    def test_identical_valid_drafts_remain_idempotently_accepted(self) -> None:
        first_content, first_artifact = workbench_artifact_draft_publish.func(
            self.runtime, 0, self.draft,
        )
        self.runtime.tool_call_id = "call_repeat"
        repeated_content, repeated_artifact = workbench_artifact_draft_publish.func(
            self.runtime, 0, copy.deepcopy(self.draft),
        )
        first_response = json.loads(first_content)
        repeated_response = json.loads(repeated_content)

        self.assertTrue(first_response["ok"])
        self.assertTrue(repeated_response["ok"])
        self.assertEqual(first_response["candidateChecksum"], repeated_response["candidateChecksum"])
        self.assertEqual(first_artifact["draftChecksum"], repeated_artifact["draftChecksum"])
        self.assertEqual(first_artifact["draft"], repeated_artifact["draft"])
        self.assertNotIn("repairInstruction", repeated_response)

    def test_accepts_a_complete_prd_v3_draft_and_rejects_an_incomplete_safety_table(self) -> None:
        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            self.prd_draft,
        )

        self.assertEqual(json.loads(content)["ok"], True)
        self.assertEqual(artifact["draft"]["content"]["protocol"], "workbench.prd.v3")

        invalid = copy.deepcopy(self.prd_draft)
        invalid["content"]["sections"]["safetyBaseline"]["rows"].pop()
        invalid_content, invalid_artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime,
            0,
            invalid,
        )
        self.assertEqual(json.loads(invalid_content)["ok"], False)
        self.assertEqual(invalid_artifact["ok"], False)
        self.assertNotIn("draft", invalid_artifact)

    def test_prd_semantic_errors_preserve_the_complete_draft_for_local_repair(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        section = invalid["content"]["sections"]["businessRequirements"]["functionSections"][2]
        table = next(block for block in section["blocks"] if block["type"] == "table")
        standard_column_id = table["columns"][2]["id"]
        standard = next(
            cell for cell in table["rows"][0]["cells"]
            if cell["columnId"] == standard_column_id
        )
        standard["content"] = [
            {"type": "text", "text": "页面正常显示内容，符合预期。", "marks": []},
        ]
        before = copy.deepcopy(invalid)

        content, artifact = workbench_artifact_draft_publish.func(
            self.prd_runtime, 0, invalid,
        )

        response = json.loads(content)
        self.assertFalse(response["ok"])
        self.assertTrue(any(
            "observable results" in issue["message"] for issue in response["issues"]
        ))
        self.assertIn("Edit only the returned issue paths", response["repairInstruction"])
        self.assertNotIn("top-level PRD structure", response["repairInstruction"])
        self.assertNotIn("draft", artifact)
        self.assertEqual(invalid, before)

    def test_prd_root_type_errors_describe_the_actual_directory_object(self) -> None:
        for root in ("sections", "tableOfContents"):
            with self.subTest(root=root):
                invalid = copy.deepcopy(self.prd_draft)
                invalid["content"][root] = []
                content, artifact = workbench_artifact_draft_publish.func(
                    self.prd_runtime, 0, invalid,
                )
                response = json.loads(content)
                self.assertFalse(response["ok"])
                self.assertTrue(any(
                    issue["path"] == ["content", root]
                    and issue["code"] == "invalid_type"
                    for issue in response["issues"]
                ))
                self.assertIn(
                    "revision, cover, tableOfContents, and sections are objects",
                    response["repairInstruction"],
                )
                self.assertIn("tableOfContents.entries", response["repairInstruction"])
                self.assertNotIn("draft", artifact)

    def test_misplaced_prd_sections_are_rejected_then_preserved_by_explicit_repair(self) -> None:
        for names in (
            ("businessRequirements", "degradation", "safetyBaseline"),
            ("degradation",),
        ):
            with self.subTest(names=names):
                invalid = copy.deepcopy(self.prd_draft)
                sections = invalid["content"]["sections"]
                for name in names:
                    sections["introduction"][name] = sections.pop(name)
                before = copy.deepcopy(invalid)
                content, artifact = workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)
                response = json.loads(content)
                self.assertFalse(response["ok"])
                self.assertNotIn("draft", artifact)
                self.assertEqual(invalid, before)
                self.assertEqual(_misplaced_prd_sections(invalid, response["issues"]), list(names))
                for name in names:
                    self.assertIn(
                        f"content.sections.introduction.{name} to content.sections.{name}",
                        response["repairInstruction"],
                    )
                self.assertIn("Do not repeat generation stages", response["repairInstruction"])
                repaired = copy.deepcopy(invalid)
                for name in names:
                    repaired["content"]["sections"][name] = repaired["content"]["sections"]["introduction"].pop(name)
                repaired_content, accepted = workbench_artifact_draft_publish.func(self.prd_runtime, 0, repaired)
                self.assertTrue(json.loads(repaired_content)["ok"])
                self.assertEqual(accepted["draft"], self.prd_draft)

    def test_misplaced_section_guidance_never_overwrites_existing_or_wrong_type_fields(self) -> None:
        for case in ("existing", "wrong_type", "missing_parent_issue", "missing_sibling_issue", "non_prd"):
            with self.subTest(case=case):
                invalid = copy.deepcopy(self.prd_draft)
                sections = invalid["content"]["sections"]
                sections["introduction"]["degradation"] = sections.pop("degradation")
                issues = [
                    {"code": "unrecognized_keys", "path": ["content", "sections", "introduction"]},
                    {"code": "invalid_type", "path": ["content", "sections", "degradation"]},
                ]
                if case == "existing":
                    sections["degradation"] = None
                elif case == "wrong_type":
                    sections["introduction"]["degradation"] = []
                elif case == "missing_parent_issue":
                    issues.pop(0)
                elif case == "missing_sibling_issue":
                    issues.pop()
                else:
                    invalid["kind"] = "prototype"
                self.assertEqual(_misplaced_prd_sections(invalid, issues), [])

    def test_nested_prd_type_errors_and_extra_keys_need_only_local_repairs(self) -> None:
        for mutate in (
            lambda content: content["tableOfContents"].update(entries={}),
            lambda content: content["sections"].update(businessRequirements=None),
            lambda content: content.update(placeholder=True),
        ):
            invalid = copy.deepcopy(self.prd_draft)
            mutate(invalid["content"])
            content, _ = workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)
            response = json.loads(content)
            self.assertFalse(response["ok"])
            self.assertIn("Edit only the returned issue paths", response["repairInstruction"])

    def test_prd_shape_detection_does_not_reclassify_root_semantic_errors(self) -> None:
        for code in ("custom", "too_small", "unrecognized_keys"):
            self.assertFalse(_has_prd_shape_failure(
                self.prd_draft, [{"path": ["content", "sections"], "code": code}],
            ))
        self.assertTrue(_has_prd_shape_failure(
            self.prd_draft, [{"path": ["content"], "code": "invalid_type"}],
        ))
        self.assertFalse(_has_prd_shape_failure(
            self.draft, [{"path": ["content"], "code": "invalid_type"}],
        ))
        self.assertFalse(_has_prd_shape_failure(None, [None]))

    def test_local_prd_transport_hints_repair_observed_errors_without_mutating_content(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        sections = invalid["content"]["sections"]
        scope = sections["introduction"]["scope"]["blocks"]
        original_scope = copy.deepcopy(scope)
        scope[0] = "PRIVATE_EXISTING_SCOPE_TEXT"
        del sections["degradation"]["content"][0]["marks"]
        sections["safetyBaseline"]["intro"] = "PRIVATE_WRONG_INTRO"
        before = copy.deepcopy(invalid)

        content, artifact = workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)
        response = json.loads(content)
        self.assertFalse(response["ok"])
        self.assertEqual(invalid, before)
        self.assertNotIn("draft", artifact)
        self.assertNotIn("repairHints", artifact)
        hints = response["repairHints"]
        scope_hint = next(h for h in hints if h.get("structure", "").startswith('{id:string,type:"bulletList"'))
        self.assertEqual(scope_hint["path"], ["content", "sections", "introduction", "scope", "blocks", 0])
        self.assertIn('items:[{id:string,content:[{type:"text",text:string,marks:[]}]}]', scope_hint["structure"])
        marks_hint = next(h for h in hints if h["path"][-1] == "marks" and "structure" in h)
        self.assertIn("Use [] for unformatted text", marks_hint["instruction"])
        intro_hint = next(h for h in hints if h["path"][-1] == "intro")
        self.assertEqual(intro_hint["expectedValue"], self.prd_draft["content"]["sections"]["safetyBaseline"]["intro"])
        self.assertNotIn("PRIVATE_", json.dumps(hints))
        self.assertEqual(json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0]), response)

        repaired = copy.deepcopy(invalid)
        repaired["content"]["sections"]["introduction"]["scope"]["blocks"] = original_scope
        repaired["content"]["sections"]["degradation"]["content"][0]["marks"] = []
        repaired["content"]["sections"]["safetyBaseline"]["intro"] = intro_hint["expectedValue"]
        repaired_content, accepted = workbench_artifact_draft_publish.func(self.prd_runtime, 0, repaired)
        self.assertTrue(json.loads(repaired_content)["ok"])
        self.assertEqual(accepted["draft"], self.prd_draft)
        self.assertNotIn("repairHints", json.loads(repaired_content))

    def test_prd_scope_semantic_hint_preserves_facts_and_never_accepts_plain_list_text(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        blocks = invalid["content"]["sections"]["introduction"]["scope"]["blocks"]
        blocks[:] = [{"id": "scope_paragraph", "type": "paragraph", "content": [
            {"type": "text", "text": "PRIVATE_EXISTING_SCOPE_TEXT", "marks": []},
        ]}]
        content, artifact = workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)
        response = json.loads(content)
        self.assertFalse(response["ok"])
        hint = next(h for h in response["repairHints"] if h["path"] == ["content", "sections", "introduction", "scope", "blocks"])
        self.assertIn('type:"bulletList"', hint["structure"])
        self.assertNotIn("PRIVATE_", json.dumps(response["repairHints"]))
        self.assertNotIn("draft", artifact)

    def test_prd_toc_hints_preserve_the_contract_punctuation(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        entries = invalid["content"]["tableOfContents"]["entries"]
        entries[-2:] = ["3 业务降级方案（必填）", "4 需求安全基线要求（必填）"]
        response = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])
        hints = [h for h in response["repairHints"] if "expectedValue" in h]
        self.assertEqual([h["expectedValue"] for h in hints], ["3. 业务降级方案（必填）", "4. 需求安全基线要求（必填）"])
        self.assertFalse(response["ok"])
        for hint in hints:
            invalid["content"]["tableOfContents"]["entries"][hint["path"][-1]] = hint["expectedValue"]
        self.assertTrue(json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])["ok"])

    def test_prd_repair_hints_are_bounded_and_do_not_suggest_business_values(self) -> None:
        issues = [{"code": "invalid_type", "path": ["content", "citations", i, "quote"], "expectedType": "string"} for i in range(100)]
        hints = _artifact_draft_repair_hints(self.prd_draft, issues)
        self.assertLessEqual(len(hints), 20)
        self.assertLessEqual(len(json.dumps(hints).encode()), 12_000)
        for issue in (
            {"code": "custom", "path": ["content", "sections", "safetyBaseline", "rows", 0, "applicability"]},
            {"code": "custom", "path": ["content", "sections", "introduction", "usageScenarios", "channelTable", "rows", 0, "enabled"]},
            {"code": "custom", "path": ["content", "sections", "degradation", "content"]},
        ):
            self.assertEqual(_artifact_draft_repair_hints(self.prd_draft, [issue]), [])
        self.assertEqual(_artifact_draft_repair_hints(self.draft, issues), [])
        self.assertEqual(_artifact_draft_repair_hints(self.prd_draft, [None, {"path": [[]]}]), [])

    def test_acceptance_coverage_hints_cover_combined_table_and_typed_criteria(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        blocks = invalid["content"]["sections"]["businessRequirements"]["functionSections"][2]["blocks"]
        table = next(block for block in blocks if block["type"] == "table")
        blocks.remove(table)
        blocks.append(table)
        item_column = table["columns"][1]["id"]
        for row in table["rows"]:
            next(cell for cell in row["cells"] if cell["columnId"] == item_column)["content"] = [{"type": "text", "text": "PRIVATE_ITEM_LABEL", "marks": []}]
        before = copy.deepcopy(invalid)
        response = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])
        self.assertFalse(response["ok"])
        self.assertTrue(any(issue["message"].startswith("acceptance criteria must cover ") for issue in response["issues"]))
        hints = [hint for hint in response["repairHints"] if "Acceptance coverage combines" in hint["instruction"]]
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["path"], ["content", "sections", "businessRequirements", "functionSections"])
        self.assertIn("typed Given/When/Then criteria", hints[0]["instruction"])
        self.assertNotIn("PRIVATE_ITEM_LABEL", json.dumps(hints))
        self.assertEqual(invalid, before)

    def test_distinct_row_hint_uses_current_ssot_matrix_and_only_structural_paths(self) -> None:
        draft = anonymous_acceptance_collision()
        before = copy.deepcopy(draft)
        response, artifact = workbench_artifact_draft_publish.func(self.prd_runtime, 0, draft)
        ack = json.loads(response)
        self.assertFalse(ack["ok"])
        self.assertEqual([issue["message"] for issue in ack["issues"]], ["acceptance dimensions must be represented by distinct rows"])
        hint = next(hint for hint in ack["repairHints"] if "acceptanceCoverage" in hint)
        self.assertEqual(hint["candidateChecksum"], ack["candidateChecksum"])
        coverage = hint["acceptanceCoverage"]
        self.assertEqual({d["key"]: d["candidateRows"] for d in coverage["dimensions"]}, {
            "visibility": [3], "rules": [2, 3], "state": [0, 1, 2, 3], "failureRecovery": [2],
        })
        self.assertEqual(coverage["conflict"], {"dimensionKeys": ["visibility", "rules", "failureRecovery"], "candidateRows": [3, 2], "candidateRowCount": 2})
        self.assertEqual(coverage["requiredRowCount"], 4)
        self.assertEqual(coverage["currentRowCount"], 4)
        self.assertFalse(coverage["distinctRowsPossible"])
        self.assertFalse(coverage["truncated"])
        self.assertIn("given + when + the linked requirement.title", hint["instruction"])
        self.assertIn("changing then alone does not add", hint["instruction"])
        for row in coverage["rows"]:
            self.assertTrue(any(path.endswith("/given") for path in row["conditionPaths"]))
            self.assertTrue(any(path.endswith("/when") for path in row["conditionPaths"]))
            self.assertTrue(any(path.endswith("/title") for path in row["conditionPaths"]))
            for path in [row["path"], *row["conditionPaths"], *row["resultPaths"]]:
                current = draft
                for segment in path.lstrip("/").split("/"):
                    current = current[int(segment)] if isinstance(current, list) else current[segment]
        self.assertNotIn("已有任务", json.dumps(hint, ensure_ascii=False))
        self.assertNotIn("repairHints", artifact)
        self.assertTrue(all(set(issue) <= {"code", "path", "message", "expectedType", "expectedValue"} for issue in artifact["issues"]))
        self.assertEqual(draft, before)
        stale = _artifact_draft_repair_hints(draft, ack["issues"], [hint], "0" * 64)
        self.assertFalse(any("acceptanceCoverage" in value for value in stale))

    def test_missing_dimension_and_row_count_hints_share_exact_ssot_diagnostics(self) -> None:
        draft = anonymous_acceptance_collision()
        functions = draft["content"]["sections"]["businessRequirements"]["functionSections"]
        functions[0]["blocks"].pop()
        functions[0]["blocks"][1]["acceptanceCriterionIds"].remove("criterion-repair-2")
        ack = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, draft)[0])
        self.assertTrue(any("at least 4 independently testable rows" in issue["message"] for issue in ack["issues"]))
        self.assertTrue(any(issue["message"] == "acceptance criteria must cover 失败或异常恢复" for issue in ack["issues"]))
        hints = [hint for hint in ack["repairHints"] if "acceptanceCoverage" in hint]
        self.assertEqual(len(hints), 1)
        coverage = hints[0]["acceptanceCoverage"]
        self.assertEqual((coverage["currentRowCount"], coverage["requiredRowCount"]), (3, 4))
        self.assertEqual(next(d for d in coverage["dimensions"] if d["key"] == "failureRecovery")["candidateRows"], [])

    def test_acceptance_matrix_is_bounded_without_hiding_full_candidate_counts(self) -> None:
        draft = anonymous_acceptance_collision()
        functions = draft["content"]["sections"]["businessRequirements"]["functionSections"]
        for index in range(40):
            criterion = copy.deepcopy(functions[0]["blocks"][4])
            criterion["id"] = f"criterion-volume-{index}"
            criterion["given"][0]["text"] = f"已有第{index}项待办"
            criterion["then"][0]["text"] = f"处理第{index}项待办后保留其单独的回执编号。"
            functions[0]["blocks"].append(criterion)
            functions[0]["blocks"][1]["acceptanceCriterionIds"].append(criterion["id"])
        ack = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, draft)[0])
        hint = next(hint for hint in ack["repairHints"] if "acceptanceCoverage" in hint)
        coverage = hint["acceptanceCoverage"]
        self.assertEqual(coverage["currentRowCount"], 44)
        self.assertLessEqual(len(coverage["rows"]), 8)
        self.assertTrue(coverage["truncated"])
        self.assertEqual(next(d for d in coverage["dimensions"] if d["key"] == "state")["candidateRowCount"], 44)
        self.assertLessEqual(len(json.dumps(ack["repairHints"]).encode()), 12_000)
        self.assertFalse(ack["ok"])

    def test_unknown_citation_hints_identify_every_actual_inline_without_choosing_a_source(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        blocks = invalid["content"]["sections"]["businessRequirements"]["functionSections"][0]["blocks"]
        index = next(i for i, block in enumerate(blocks) if block["type"] == "requirement")
        inline = blocks[index]["description"]
        citation = {"type": "citation", "citationId": "missing-source-id", "label": "PRIVATE_SOURCE_LABEL"}
        inline.extend([copy.deepcopy(citation), copy.deepcopy(citation)])
        before = copy.deepcopy(invalid)
        response = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])
        self.assertFalse(response["ok"])
        hints = [hint for hint in response["repairHints"] if "undefined citation" in hint["instruction"]]
        self.assertEqual([hint["path"] for hint in hints], [["content", "sections", "businessRequirements", "functionSections", 0, "blocks", index, "description", i, "citationId"] for i in (len(inline)-2, len(inline)-1)])
        self.assertTrue(all("expectedValue" not in hint for hint in hints))
        self.assertNotIn("PRIVATE_SOURCE_LABEL", json.dumps(hints))
        self.assertEqual(invalid, before)

    def test_field_names_misplaced_in_blocks_are_not_suggested_as_business_text(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        blocks = invalid["content"]["sections"]["introduction"]["scope"]["blocks"]
        blocks.append("usageScenarios")
        before = copy.deepcopy(invalid)
        response = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])
        path = ["content", "sections", "introduction", "scope", "blocks", len(blocks) - 1]
        hints = [h for h in response["repairHints"] if h["path"] == path]
        self.assertFalse(response["ok"])
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["owningPath"], ["content", "sections", "introduction", "usageScenarios"])
        self.assertIn("remove only this invalid duplicate string", hints[0]["instruction"])
        self.assertIn("Never wrap a schema field name", hints[0]["instruction"])
        self.assertNotIn("structure", hints[0])
        self.assertEqual(invalid, before)
        blocks.pop()
        self.assertTrue(json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])["ok"])

    def test_misplaced_root_sections_and_business_children_have_precise_move_hints(self) -> None:
        for location in ("root_sections", "business_children", "content_children"):
            with self.subTest(location=location):
                invalid = copy.deepcopy(self.prd_draft)
                content = invalid["content"]
                sections = content["sections"]
                if location == "root_sections":
                    invalid["sections"] = content.pop("sections")
                    moves = [(["sections"], ["content", "sections"])]
                elif location == "business_children":
                    business = sections["businessRequirements"]
                    moves = []
                    for name in ("functionSections",):
                        sections[name] = business.pop(name)
                        moves.append((["content", "sections", name], ["content", "sections", "businessRequirements", name]))
                else:
                    moves = []
                    for name in ("degradation", "safetyBaseline"):
                        content[name] = sections.pop(name)
                        moves.append((["content", name], ["content", "sections", name]))
                before = copy.deepcopy(invalid)
                response = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])
                self.assertFalse(response["ok"])
                for source, target in moves:
                    self.assertTrue(any(h.get("moveFrom") == source and h["path"] == target for h in response["repairHints"]))
                self.assertEqual(invalid, before)

    def test_relocation_hint_never_overwrites_an_existing_destination(self) -> None:
        invalid = copy.deepcopy(self.prd_draft)
        invalid["sections"] = copy.deepcopy(invalid["content"]["sections"])
        invalid["content"]["sections"] = None
        response = json.loads(workbench_artifact_draft_publish.func(self.prd_runtime, 0, invalid)[0])
        self.assertFalse(response["ok"])
        self.assertFalse(any(h.get("moveFrom") == ["sections"] for h in response["repairHints"]))

    def test_rejects_an_unstable_artifact_index(self) -> None:
        with self.assertRaisesRegex(ValueError, "WORKBENCH_ARTIFACT_DRAFT_INDEX_INVALID"):
            workbench_artifact_draft_publish.func(self.runtime, 20, self.draft)

    def test_rejects_a_draft_kind_not_requested_by_the_run(self) -> None:
        with self.assertRaisesRegex(ValueError, "WORKBENCH_ARTIFACT_DRAFT_KIND_NOT_REQUESTED"):
            workbench_artifact_draft_publish.func(self.prd_runtime, 0, self.draft)
        with self.assertRaisesRegex(ValueError, "WORKBENCH_ARTIFACT_DRAFT_KIND_NOT_REQUESTED"):
            workbench_artifact_draft_publish.func(self.runtime, 0, self.prd_draft)


if __name__ == "__main__":
    unittest.main()
