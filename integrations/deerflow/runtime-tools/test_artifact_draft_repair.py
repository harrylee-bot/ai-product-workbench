from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_artifact_draft_tool import anonymous_acceptance_collision, workbench_artifact_draft_publish
from deerflow_workbench_tools.knowledge_tool import workbench_knowledge_retrieve
from deerflow_workbench_tools.runtime_result_tool import workbench_runtime_result_submit
from deerflow_workbench_tools.artifact_draft_repair import (
    ArtifactDraftRepairPathError,
    _apply_repair,
    latest_accepted_artifact_draft,
    repair_error_feedback,
    resolve_artifact_draft_candidate,
)

ROOT = Path(__file__).resolve().parents[3]


class ArtifactDraftRepairTests(unittest.TestCase):
    def setUp(self):
        self.draft = json.loads((ROOT / "integrations/deerflow/test-fixtures/prd-runtime-result.example.json").read_text())["artifacts"][0]
        self.runtime = SimpleNamespace(
            context={"workbench":{"runId":"run_1","runtimeAttemptId":"attempt_1","requestedArtifactKinds":["prd"]}},
            state={"messages":[{"type":"human","content":"Generate the requested artifacts."}]},
            tool_call_id="initial",
        )

    def declare(self, call_id, **args):
        call = {"name":"workbench_artifact_draft_publish","id":call_id,"args":{"artifact_index":0,**args}}
        self.runtime.state["messages"].append({"type":"ai","tool_calls":[call]})
        self.runtime.tool_call_id = call_id
        return call

    def publish(self, call_id, **args):
        self.declare(call_id, **args)
        content, artifact = workbench_artifact_draft_publish.func(self.runtime,0,**args)
        self.runtime.state["messages"].append({"type":"tool","name":"workbench_artifact_draft_publish","tool_call_id":call_id,"status":"success","content":content,"artifact":artifact})
        return json.loads(content), artifact

    def reject(self):
        invalid=copy.deepcopy(self.draft)
        invalid["safetyBaseline"]=invalid["content"]["sections"].pop("safetyBaseline")
        invalid["degradation"]=invalid["content"]["sections"].pop("degradation")
        ack,_=self.publish("initial",draft=invalid)
        self.assertFalse(ack["ok"])
        return ack,invalid

    def repair(self, ack, operations):
        return {"baseCandidateChecksum":ack["candidateChecksum"],"operations":operations}

    def test_move_repairs_real_root_misnesting_without_rewriting_content(self):
        ack,invalid=self.reject()
        original=copy.deepcopy(self.runtime.state)
        repair=self.repair(ack,[{"op":"move","from":"/safetyBaseline","path":"/content/sections/safetyBaseline"},{"op":"move","from":"/degradation","path":"/content/sections/degradation"}])
        result,artifact=self.publish("repair1",repair=repair)
        self.assertTrue(result["ok"],result["issues"])
        self.assertEqual(artifact["draft"],self.draft)
        self.assertEqual(self.runtime.state["messages"][:3],original["messages"])
        self.assertNotIn("repair",artifact)
        self.assertEqual(latest_accepted_artifact_draft(self.runtime.state,run_id="run_1",runtime_attempt_id="attempt_1",artifact_index=0),self.draft)

    def test_only_matching_prd_envelope_duplicates_can_be_removed(self):
        rejected = copy.deepcopy(self.draft)
        rejected.update({key: rejected["content"][key] for key in ("documentId", "protocol")})
        ack, _ = self.publish("initial", draft=rejected)
        self.assertFalse(ack["ok"])
        expected = [{"op": "remove", "path": "/documentId"}, {"op": "remove", "path": "/protocol"}]
        self.assertEqual(ack["envelopeRepair"], self.repair(ack, expected))
        result, artifact = self.publish("repair1", repair=ack["envelopeRepair"])
        self.assertTrue(result["ok"], result["issues"])
        self.assertEqual(artifact["draft"], self.draft)
        rejected["documentId"] = "different-id"
        with self.assertRaisesRegex(ValueError, "PATH_FORBIDDEN"):
            _apply_repair(rejected, ack["envelopeRepair"], ack["candidateChecksum"])

    def install_retrieval(self):
        citation = self.draft["citations"][0]
        name = "workbench_knowledge_retrieve"
        self.runtime.tool_call_id = "retrieve"
        self.runtime.context["secrets"] = {"WORKBENCH_KNOWLEDGE_CAPABILITY": json.dumps({"releaseId": "release"})}
        self.runtime.state["messages"].append({"type": "ai", "tool_calls": [
            {"name": name, "id": "retrieve", "args": {"query": "activity filters"}},
        ]})
        body = json.dumps({"protocol": "workbench.knowledge-retrieval-result.v1", "items": [{"citation": citation}],
                           "evidence": {"release": {"id": "release"}, "mode": "hybrid", "routeScope": "production"}})
        with patch("deerflow_workbench_tools.knowledge_tool.retrieve_knowledge", return_value=body):
            content, receipt = workbench_knowledge_retrieve.func(self.runtime, "activity filters")
        self.runtime.state["messages"].append({"type": "tool", "name": name, "tool_call_id": "retrieve",
                                              "status": "success", "content": content, "artifact": receipt})
        return receipt

    def test_retrieved_locator_reports_exact_field_and_allows_checksum_bound_repair(self):
        self.install_retrieval()
        draft = copy.deepcopy(self.draft)
        locator = self.draft["citations"][0]["locator"]
        for citations in (draft["citations"], draft["content"]["citations"]):
            citations[0]["locator"]["heading"] = "Transcribed heading"
        raw = {"protocol": "workbench.runtime.result.v1", "message": "Ready", "artifacts": [draft]}
        content, attempt = workbench_runtime_result_submit.func(self.runtime, raw)
        self.assertFalse(attempt["ok"])
        self.assertEqual(json.loads(content)["issues"][0]["path"], ["artifacts", 0, "citations", 0, "locator"])
        ack, artifact = self.publish("initial", draft=draft)
        self.assertFalse(ack["ok"])
        self.assertNotIn("draft", artifact)
        self.assertEqual([issue["path"] for issue in ack["issues"]],
                         [["citations", 0, "locator"], ["content", "citations", 0, "locator"]])
        self.assertEqual(json.loads(ack["issues"][0]["message"].split(": ", 1)[1]), locator)
        repaired, artifact = self.publish("repair1", repair=self.repair(ack, [
            {"op": "replace", "path": "/citations/0/locator", "value": locator},
            {"op": "replace", "path": "/content/citations/0/locator", "value": locator},
        ]))
        self.assertTrue(repaired["ok"], repaired["issues"])
        content, submitted = workbench_runtime_result_submit.func(
            self.runtime, {**raw, "artifacts": [repaired["finalSubmissionArtifact"]]},
        )
        self.assertTrue(json.loads(content)["ok"])
        self.assertEqual(submitted["result"]["artifacts"][0], self.draft)

    def test_different_attempt_or_modified_receipt_cannot_supply_correction(self):
        receipt = self.install_retrieval()
        draft = copy.deepcopy(self.draft)
        for citations in (draft["citations"], draft["content"]["citations"]):
            citations[0]["locator"]["heading"] = "Different heading"
        for key in ("runtimeAttemptId", "toolCallId", "releaseId", "contentSha256"):
            with self.subTest(key=key), patch.dict(receipt, {key: "unrelated"}):
                content, _ = workbench_artifact_draft_publish.func(self.runtime, 0, draft=draft)
                self.assertTrue(json.loads(content)["ok"])

    def test_repair_uses_verified_citation_identity_and_preserves_prd_body(self):
        self.install_retrieval()
        expected = copy.deepcopy(self.draft)
        citation_id = expected["citations"][0]["id"]
        paragraph = expected["content"]["sections"]["introduction"]["background"]["blocks"][0]
        paragraph["content"].append({"type": "citation", "citationId": citation_id, "label": "Evidence"})
        expected["content"]["assumptions"][0]["citationIds"] = [citation_id]
        draft = copy.deepcopy(expected)
        alias = "c-invented-by-model"
        for citations in (draft["citations"], draft["content"]["citations"]):
            citations[0]["id"] = alias
            citations[0]["locator"]["heading"] = "Changed by the model"
        draft["content"]["sections"]["introduction"]["background"]["blocks"][0]["content"][-1]["citationId"] = alias
        draft["content"]["assumptions"][0]["citationIds"] = [alias]
        draft["content"]["citations"][0]["quote"] = "A transcribed quote"

        ack, _ = self.publish("initial", draft=draft)
        self.assertFalse(ack["ok"])
        mirror = ack["citationMirrorRepair"]
        self.assertEqual(mirror, self.repair(ack, [{
            "op": "replace", "path": "/content/citations/0/quote", "value": expected["citations"][0]["quote"],
        }]))
        ack, artifact = self.publish("mirror", repair=mirror)
        self.assertFalse(ack["ok"])
        self.assertNotIn("draft", artifact)
        self.assertNotIn("citationMirrorRepair", ack)
        self.assertEqual(ack["citationRepair"]["operations"], [{"op": "restoreCitation", "path": "/citations/0"}])
        repaired, _ = self.publish("repair1", repair=ack["citationRepair"])
        self.assertTrue(repaired["ok"], repaired["issues"])
        self.assertEqual(latest_accepted_artifact_draft(
            self.runtime.state, run_id="run_1", runtime_attempt_id="attempt_1", artifact_index=0,
        ), expected)

    def test_citation_mirror_requires_same_facts_and_exact_current_quote(self):
        receipt = self.install_retrieval()
        draft = copy.deepcopy(self.draft)
        draft["citations"][0]["quote"] = "An unverified transcription."
        for key in ("runtimeAttemptId", "contentSha256"):
            with self.subTest(untrusted=key), patch.dict(receipt, {key: "unrelated"}):
                content, _ = workbench_artifact_draft_publish.func(self.runtime, 0, draft=draft)
                self.assertNotIn("citationMirrorRepair", json.loads(content))
        for changed_field, value in (
            ("quote", "A second unverified transcription."),
            ("documentId", "a-different-source"),
        ):
            conflicting = copy.deepcopy(draft)
            conflicting["content"]["citations"][0][changed_field] = value
            with self.subTest(changed_field=changed_field):
                content, _ = workbench_artifact_draft_publish.func(self.runtime, 0, draft=conflicting)
                self.assertNotIn("citationMirrorRepair", json.loads(content))
        ack, _ = self.publish("initial", draft=draft)
        repair = ack["citationMirrorRepair"]
        self.assertEqual(repair, self.repair(ack, [{
            "op": "replace", "path": "/citations/0/quote", "value": self.draft["citations"][0]["quote"],
        }]))
        accepted, artifact = self.publish("mirror", repair=repair)
        self.assertTrue(accepted["ok"])
        self.assertEqual(artifact["draft"], self.draft)

    def test_citation_restore_refuses_a_different_quote_or_unrelated_path(self):
        self.install_retrieval()
        draft = copy.deepcopy(self.draft)
        for citations in (draft["citations"], draft["content"]["citations"]):
            citations[0]["id"] = "c-unknown"
            citations[0]["quote"] = "A different assertion"
        ack, _ = self.publish("initial", draft=draft)
        self.assertFalse(ack["ok"])
        self.assertNotIn("citationRepair", ack)
        self.assertEqual(ack["issues"][0]["verifiedSourceCitation"], self.draft["citations"][0])
        for path, error in (("/citations/0", "CITATION_SOURCE_UNRESOLVED"),
                            ("/content/title", "CITATION_PATH_FORBIDDEN")):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, error):
                resolve_artifact_draft_candidate(
                    {"messages": [*self.runtime.state["messages"], {"type": "ai", "tool_calls": [{
                        "id": "forged", "name": "workbench_artifact_draft_publish",
                        "args": {"artifact_index": 0, "repair": self.repair(ack, [
                            {"op": "restoreCitation", "path": path},
                        ])},
                    }]}]},
                    run_id="run_1", runtime_attempt_id="attempt_1", tool_call_id="forged",
                    artifact_index=0, repair=self.repair(ack, [{"op": "restoreCitation", "path": path}]),
                )

    def test_prd_assembles_small_repairs_without_publishing_partial_content(self):
        baseline = copy.deepcopy(self.draft)
        sections = baseline["content"]["sections"]
        sections_to_write = copy.deepcopy(sections)
        sections.clear()
        parts = sections_to_write["businessRequirements"]["functionSections"]
        sections_to_write["businessRequirements"]["functionSections"] = []
        ack, artifact = self.publish("initial", draft=baseline)
        self.assertFalse(ack["ok"])
        self.assertNotIn("draft", artifact)
        intro_path = "/content/sections/introduction"
        intro = sections_to_write["introduction"]
        usage_path = f"{intro_path}/usageScenarios"
        usage = intro["usageScenarios"]
        business_path = "/content/sections/businessRequirements"
        business = sections_to_write["businessRequirements"]
        page_links = business["pageLinks"]
        ordered_steps = [
            (intro_path, {"title": intro["title"]}),
            (f"{intro_path}/background", intro["background"]),
            (f"{intro_path}/scope", intro["scope"]),
            (usage_path, {"title": usage["title"]}),
            (f"{usage_path}/blocks", usage["blocks"]),
            (f"{usage_path}/channelTable", usage["channelTable"]),
            (business_path, {"title": business["title"]}),
            (f"{business_path}/summary", business["summary"]),
            (f"{business_path}/pageLinks", {"title": page_links["title"]}),
            (f"{business_path}/pageLinks/blocks", page_links["blocks"]),
            (f"{business_path}/functionSections", []),
            *[(f"{business_path}/functionSections/-", section) for section in parts],
            ("/content/sections/degradation", sections_to_write["degradation"]),
            ("/content/sections/safetyBaseline", sections_to_write["safetyBaseline"]),
        ]
        for index, (path, value) in enumerate(ordered_steps):
            expected = {"op": "add", "path": path}
            if path in (intro_path, usage_path, business_path, f"{business_path}/pageLinks", f"{business_path}/functionSections"):
                expected["value"] = value
            self.assertEqual(ack["prdAssembly"]["nextOperation"], expected)
            self.assertIn("one small complete value", ack["repairInstruction"])
            ack, artifact = self.publish(f"add_{index}", repair=self.repair(ack, [
                {"op": "add", "path": path, "value": value},
            ]))
            if index + 1 < len(ordered_steps):
                self.assertFalse(ack["ok"])
                self.assertNotIn("draft", artifact)
        self.assertTrue(ack["ok"], ack["issues"])
        self.assertNotIn("prdAssembly", ack)
        self.assertEqual(latest_accepted_artifact_draft(
            self.runtime.state, run_id="run_1", runtime_attempt_id="attempt_1", artifact_index=0,
        ), self.draft)

    def test_function_title_and_blocks_take_priority_over_missing_later_sections(self):
        baseline = copy.deepcopy(self.draft)
        sections = baseline["content"]["sections"]
        sections.pop("degradation")
        first = sections["businessRequirements"]["functionSections"][0]
        title = first["title"]
        first["title"] = title.replace("2.2 ", "2.2", 1)
        first["blocks"] = []
        ack, artifact = self.publish("initial", draft=baseline)
        self.assertFalse(ack["ok"])
        self.assertNotIn("draft", artifact)
        path = "/content/sections/businessRequirements/functionSections/0"
        expected = {"op": "replace", "path": f"{path}/title", "value": title}
        self.assertEqual(ack["prdAssembly"]["nextOperation"], expected)
        self.assertIn("ASCII space", ack["repairInstruction"])
        revised, artifact = self.publish("repair", repair=self.repair(ack, [expected]))
        self.assertFalse(revised["ok"])
        self.assertNotIn("draft", artifact)
        self.assertEqual(revised["prdAssembly"]["nextOperation"], {"op": "add", "path": f"{path}/blocks/-"})

    def test_reconstructs_multiple_failed_repairs_then_accepts_final_repair(self):
        ack,_=self.reject()
        ack,artifact=self.publish("repair1",repair=self.repair(ack,[{"op":"move","from":"/safetyBaseline","path":"/content/sections/safetyBaseline"}]))
        self.assertFalse(ack["ok"])
        self.assertNotIn("draft",artifact)
        ack,artifact=self.publish("repair2",repair=self.repair(ack,[{"op":"move","from":"/degradation","path":"/content/sections/degradation"}]))
        self.assertTrue(ack["ok"],ack["issues"])
        self.assertEqual(artifact["draft"],self.draft)

    def test_observed_then_only_repair_loop_gets_precise_condition_path_and_can_finish(self):
        draft = anonymous_acceptance_collision()
        before = copy.deepcopy(draft)
        ack, _ = self.publish("collision", draft=draft)
        initial_hint = next(h for h in ack["repairHints"] if "acceptanceCoverage" in h)
        matrix = initial_hint["acceptanceCoverage"]
        # Reproduce two causally reconstructed, checksum-changing repairs to
        # then, as observed in the real failure. Neither fixes condition coverage.
        for index in range(2):
            previous_checksum = ack["candidateChecksum"]
            ack, rejected = self.publish(f"then-{index}", repair=self.repair(ack, [{
                "op": "replace", "path": matrix["rows"][2]["resultPaths"][0] + "/0/text",
                "value": f"第{index + 1}次操作后保留已录入内容并给出可核对的回执。",
            }]))
            self.assertFalse(ack["ok"])
            self.assertNotEqual(ack["candidateChecksum"], previous_checksum)
            hint = next(h for h in ack["repairHints"] if "acceptanceCoverage" in h)
            self.assertEqual(hint["candidateChecksum"], ack["candidateChecksum"])
            self.assertEqual(hint["acceptanceCoverage"], matrix)
            self.assertNotIn("draft", rejected)
        # This fixture already specifies the mandatory-input rule. Express its
        # independent precondition at the exact current row path from the hint.
        condition_path = next(path for path in matrix["rows"][0]["conditionPaths"] if path.endswith("/given"))
        ack, accepted = self.publish("independent-condition", repair=self.repair(ack, [{
            "op": "replace", "path": condition_path + "/0/text", "value": "必填项尚未输入",
        }]))
        self.assertTrue(ack["ok"], ack["issues"])
        self.assertNotIn("repairHints", ack)
        self.assertEqual(draft, before)
        self.assertEqual(accepted["draft"]["content"]["sections"]["introduction"], before["content"]["sections"]["introduction"])
        self.assertEqual(accepted["draft"]["content"]["sections"]["businessRequirements"]["functionSections"][0]["blocks"][1], before["content"]["sections"]["businessRequirements"]["functionSections"][0]["blocks"][1])
        self.assertEqual(latest_accepted_artifact_draft(self.runtime.state, run_id="run_1", runtime_attempt_id="attempt_1", artifact_index=0), accepted["draft"])

    def test_patch_still_runs_full_semantic_validation(self):
        ack,_=self.reject()
        result,artifact=self.publish("repair1",repair=self.repair(ack,[{"op":"add","path":"/content/sections/safetyBaseline","value":{}}]))
        self.assertFalse(result["ok"])
        self.assertNotIn("draft",artifact)

    def test_restores_contract_text_without_model_retyping_and_preserves_business_content(self):
        invalid = copy.deepcopy(self.draft)
        invalid["content"]["sections"]["safetyBaseline"]["intro"] = "模型改写的固定说明"
        ack, _ = self.publish("initial", draft=invalid)
        self.assertFalse(ack["ok"])
        repair = ack["templateRepair"]
        self.assertEqual(repair, self.repair(ack, [{"op": "restore", "path": "/content/sections/safetyBaseline/intro"}]))
        result, artifact = self.publish("restore", repair=repair)
        self.assertTrue(result["ok"], result["issues"])
        self.assertEqual(artifact["draft"], self.draft)
        self.assertEqual(latest_accepted_artifact_draft(self.runtime.state, run_id="run_1", runtime_attempt_id="attempt_1", artifact_index=0), self.draft)
        self.assertEqual(self.runtime.state["messages"][1]["tool_calls"][0]["args"]["draft"], invalid)

    def test_restore_does_not_repair_business_claims_or_bypass_remaining_validation(self):
        invalid = copy.deepcopy(self.draft)
        invalid["content"]["sections"]["safetyBaseline"]["intro"] = "wrong template"
        invalid["title"] = "wrong business title"
        ack, _ = self.publish("initial", draft=invalid)
        result, artifact = self.publish("restore", repair=ack["templateRepair"])
        self.assertFalse(result["ok"])
        self.assertNotIn("draft", artifact)
        self.assertNotIn("templateRepair", result)
        for operation in (
            {"op": "restore", "path": "/title"},
            {"op": "restore", "path": "/content/sections/safetyBaseline/rows/0/remarks"},
            {"op": "restore", "path": "/content/sections/safetyBaseline/intro", "value": "forged"},
            {"op": "restore", "path": "/content/sections/safetyBaseline/intro"},
        ):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                _apply_repair(self.draft, self.repair(result, [operation]), result["candidateChecksum"])

    def test_wrong_table_path_reports_actual_typed_block_shape_without_applying_partial_edits(self):
        candidate = copy.deepcopy(self.draft)
        candidate["title"] = "PRIVATE_CANDIDATE_TEXT"
        original = copy.deepcopy(candidate)
        path = "/content/sections/businessRequirements/functionSections/2/blocks/0/rows/0/cells/2/content/0/text"
        repair = {"baseCandidateChecksum": "a" * 64, "operations": [
            {"op": "replace", "path": "/title", "value": "PRIVATE_REPLACEMENT_TEXT"},
            {"op": "replace", "path": path, "value": "PRIVATE_NEW_CRITERION"},
        ]}
        with self.assertRaises(ArtifactDraftRepairPathError) as caught:
            _apply_repair(candidate, repair, "a" * 64)
        self.assertEqual(candidate, original)
        error = caught.exception
        self.assertEqual(str(error), "WORKBENCH_ARTIFACT_DRAFT_REPAIR_PATH_MISSING")
        self.assertEqual(error.feedback["operationIndex"], 1)
        self.assertEqual(error.feedback["path"]["pointer"], path)
        self.assertEqual(error.feedback["path"]["existingPath"], "/content/sections/businessRequirements/functionSections/2/blocks/0")
        self.assertEqual(error.feedback["path"]["type"], "object")
        self.assertIn("requirementIds", error.feedback["path"]["keys"])
        self.assertNotIn("rows", error.feedback["path"]["keys"])
        feedback = repair_error_feedback(error)
        self.assertIn("entire repair was not applied", feedback)
        self.assertNotIn("PRIVATE_", feedback)

    def test_out_of_range_repair_reports_array_length_and_unrelated_errors_have_no_details(self):
        path = "/content/sections/businessRequirements/functionSections/2/blocks/99"
        repair = {"baseCandidateChecksum": "b" * 64, "operations": [{"op": "add", "path": path, "value": {}}]}
        with self.assertRaises(ArtifactDraftRepairPathError) as caught:
            _apply_repair(self.draft, repair, "b" * 64)
        self.assertEqual(caught.exception.feedback["path"]["length"], len(self.draft["content"]["sections"]["businessRequirements"]["functionSections"][2]["blocks"]))
        self.assertEqual(repair_error_feedback(ValueError("PRIVATE_ERROR_TEXT")), "")

    def test_restores_canonical_directory_entries(self):
        invalid = copy.deepcopy(self.draft)
        entries = invalid["content"]["tableOfContents"]["entries"]
        entries[-2:] = ["改写的降级标题", "改写的安全标题"]
        ack, _ = self.publish("initial", draft=invalid)
        self.assertEqual(len(ack["templateRepair"]["operations"]), 2)
        result, artifact = self.publish("restore", repair=ack["templateRepair"])
        self.assertTrue(result["ok"], result["issues"])
        self.assertEqual(artifact["draft"], self.draft)

    def test_rejects_stale_or_forged_bases_and_all_identity_edits(self):
        for operation in (
            {"op":"replace","path":"/kind","value":"prototype"},
            {"op":"replace","path":"/schemaVersion","value":1},
            {"op":"replace","path":"/operation/kind","value":"revise"},
            {"op":"replace","path":"/content","value":{}},
            {"op":"move","from":"/unknown","path":"/content/sections/unknown"},
        ):
            with self.subTest(operation=operation):
                self.setUp();ack,_=self.reject()
                repair=self.repair(ack,[operation]);self.declare("repair1",repair=repair)
                with self.assertRaisesRegex(ValueError,"PATH_FORBIDDEN"):
                    workbench_artifact_draft_publish.func(self.runtime,0,repair=repair)
        self.setUp();ack,_=self.reject()
        repair=self.repair(ack,[{"op":"replace","path":"/title","value":"Another title"}])
        repair["baseCandidateChecksum"]="a"*64
        self.declare("repair1",repair=repair)
        with self.assertRaisesRegex(ValueError,"STALE_BASE"):
            workbench_artifact_draft_publish.func(self.runtime,0,repair=repair)

    def test_rejects_bad_causal_history_and_scope(self):
        mutations={
            "missing-human":lambda m:m.pop(0),
            "new-human":lambda m:m.append({"type":"human","content":"new turn"}),
            "duplicate-response":lambda m:m.append(copy.deepcopy(m[-1])),
            "forged-ack":lambda m:m[-1].update(content=json.dumps({**json.loads(m[-1]["content"]),"candidateChecksum":"0"*64})),
            "foreign-run":lambda m:m[-1]["artifact"].update(runId="other"),
            "foreign-attempt":lambda m:m[-1]["artifact"].update(runtimeAttemptId="other"),
            "foreign-index":lambda m:m[-1]["artifact"].update(artifactIndex=1),
            "undeclared-response":lambda m:m.pop(1),
            "unanswered-other-tool":lambda m:m.append({"type":"ai","tool_calls":[{"id":"stage","name":"workbench_generation_stage_update","args":{}}]}),
        }
        for name,mutate in mutations.items():
            with self.subTest(name=name):
                self.setUp();ack,_=self.reject();mutate(self.runtime.state["messages"])
                repair=self.repair(ack,[{"op":"replace","path":"/title","value":"New title"}]);self.declare("repair1",repair=repair)
                with self.assertRaises(ValueError):workbench_artifact_draft_publish.func(self.runtime,0,repair=repair)

    def test_skips_unexecuted_errors_without_losing_last_rejected_candidate(self):
        ack,_=self.reject()
        self.declare("blocked",repair={"invalid":True})
        self.runtime.state["messages"].append({"type":"tool","name":"workbench_artifact_draft_publish","tool_call_id":"blocked","status":"error","content":"Error: WORKBENCH_PRD_DRAFT_REQUIRED"})
        result,artifact=self.publish("repair1",repair=self.repair(ack,[{"op":"move","from":"/safetyBaseline","path":"/content/sections/safetyBaseline"},{"op":"move","from":"/degradation","path":"/content/sections/degradation"}]))
        self.assertTrue(result["ok"])
        self.declare("blocked_after",repair={"invalid":True})
        self.runtime.state["messages"].append({"type":"tool","name":"workbench_artifact_draft_publish","tool_call_id":"blocked_after","status":"error","content":"Error: WORKBENCH_PRD_DRAFT_REQUIRED"})
        self.assertEqual(latest_accepted_artifact_draft(self.runtime.state,run_id="run_1",runtime_attempt_id="attempt_1",artifact_index=0),self.draft)

    def test_rejects_concurrent_repair_accepted_base_and_result_completion(self):
        ack,_=self.reject();repair=self.repair(ack,[{"op":"replace","path":"/title","value":"New title"}]);self.declare("repair1",repair=repair)
        self.runtime.state["messages"][-1]["tool_calls"].append({"id":"other","name":"workbench_generation_stage_update","args":{}})
        with self.assertRaisesRegex(ValueError,"PENDING_CALL_INVALID"):workbench_artifact_draft_publish.func(self.runtime,0,repair=repair)
        self.setUp();ack,_=self.publish("initial",draft=self.draft);repair=self.repair(ack,[{"op":"replace","path":"/title","value":"New title"}]);self.declare("repair1",repair=repair)
        with self.assertRaisesRegex(ValueError,"DRAFT_ALREADY_ACCEPTED"):workbench_artifact_draft_publish.func(self.runtime,0,repair=repair)
        self.setUp();ack,_=self.reject()
        self.runtime.state['messages'].append({'type':'ai','tool_calls':[{'id':'final','name':'workbench_runtime_result_submit','args':{'candidate':{}}}]})
        self.runtime.state['messages'].append({'type':'tool','name':'workbench_runtime_result_submit','tool_call_id':'final','status':'success','content':'{}','artifact':{'protocol':'workbench.runtime.validated-result.v1','runId':'run_1','runtimeAttemptId':'attempt_1','ok':True}})
        repair=self.repair(ack,[{'op':'replace','path':'/title','value':'New title'}]);self.declare('repair1',repair=repair)
        with self.assertRaisesRegex(ValueError,'RESULT_ALREADY_ACCEPTED'):workbench_artifact_draft_publish.func(self.runtime,0,repair=repair)

    def test_node_checksum_handles_numbers_and_unicode_without_python_hash_assumptions(self):
        for number in (1.0, -0.0, 1e-7):
            with self.subTest(number=number):
                self.setUp()
                broken=copy.deepcopy(self.draft)
                broken['content']['unsupported']={'\U0001f600':number,'\ue000':number}
                ack,_=self.publish('initial',draft=broken)
                result,artifact=self.publish('repair1',repair=self.repair(ack,[{'op':'remove','path':'/content/unsupported'}]))
                self.assertTrue(result['ok'],result['issues'])
                self.assertEqual(artifact['draft'],self.draft)

    def test_recovery_rejects_orphan_old_turn_and_later_rejection(self):
        self.publish('initial',draft=self.draft)
        for messages in (
            self.runtime.state['messages'][0:1]+self.runtime.state['messages'][2:],
            self.runtime.state['messages']+[{'type':'human','content':'new turn'}],
            self.runtime.state['messages']+[copy.deepcopy(self.runtime.state['messages'][-1])],
        ):
            self.assertIsNone(latest_accepted_artifact_draft({'messages':messages},run_id='run_1',runtime_attempt_id='attempt_1',artifact_index=0))
        invalid=copy.deepcopy(self.draft);invalid['title']=''
        self.publish('new-invalid',draft=invalid)
        self.assertIsNone(latest_accepted_artifact_draft(self.runtime.state,run_id='run_1',runtime_attempt_id='attempt_1',artifact_index=0))

    def test_pointer_rules_bounds_and_transactional_operations(self):
        base={"kind":"prd","schemaVersion":3,"operation":{"kind":"create"},"title":"title","citations":[],"content":{"a/b":{"~key":["first","second","third"]},"empty":{},"existing":{"x":1}}}
        checksum="a"*64
        patch=lambda ops:{"baseCandidateChecksum":checksum,"operations":ops}
        result=_apply_repair(base,patch([{"op":"move","from":"/content/a~1b/~0key/0","path":"/content/a~1b/~0key/2"},{"op":"add","path":"/content/empty/new","value":False},{"op":"replace","path":"/content/existing/x","value":2},{"op":"remove","path":"/content/empty/new"}]),checksum)
        self.assertEqual(result["content"]["a/b"]["~key"],["second","third","first"])
        self.assertEqual(base["content"]["existing"]["x"],1)
        invalid=[
            {"op":"move","from":"/content/existing","path":"/content/existing/child"},
            {"op":"move","from":"/content/empty","path":"/content/existing"},
            {"op":"replace","path":"/content/a~1b/~0key/01","value":0},
            {"op":"replace","path":"/content/bad~2","value":0},
            {"op":"add","path":"/content/__proto__/polluted","value":True},
            {"op":"replace","path":"/content/missing","value":0},
        ]
        for operation in invalid:
            with self.subTest(operation=operation):
                before=copy.deepcopy(base)
                with self.assertRaises(ValueError):_apply_repair(base,patch([operation]),checksum)
                self.assertEqual(base,before)
        with self.assertRaisesRegex(ValueError,"TOO_LARGE"):_apply_repair(base,patch([{"op":"replace","path":"/title","value":"x"*65536}]),checksum)
        with self.assertRaisesRegex(ValueError,"OPERATIONS_INVALID"):_apply_repair(base,patch([{"op":"replace","path":"/title","value":"x"}]*25),checksum)
        with self.assertRaisesRegex(ValueError,"UNCHANGED"):_apply_repair(base,patch([{"op":"replace","path":"/title","value":"title"}]),checksum)

    def test_full_and_repair_are_exclusive(self):
        for draft,repair in ((None,None),(self.draft,{})):
            with self.assertRaisesRegex(ValueError,"MODE_INVALID"):
                resolve_artifact_draft_candidate(None,run_id="run_1",runtime_attempt_id="attempt_1",tool_call_id="id",artifact_index=0,draft=draft,repair=repair)


if __name__ == "__main__":
    unittest.main()
