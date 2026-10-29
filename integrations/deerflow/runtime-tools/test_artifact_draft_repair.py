from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from test_artifact_draft_tool import workbench_artifact_draft_publish
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

    def test_reconstructs_multiple_failed_repairs_then_accepts_final_repair(self):
        ack,_=self.reject()
        ack,artifact=self.publish("repair1",repair=self.repair(ack,[{"op":"move","from":"/safetyBaseline","path":"/content/sections/safetyBaseline"}]))
        self.assertFalse(ack["ok"])
        self.assertNotIn("draft",artifact)
        ack,artifact=self.publish("repair2",repair=self.repair(ack,[{"op":"move","from":"/degradation","path":"/content/sections/degradation"}]))
        self.assertTrue(ack["ok"],ack["issues"])
        self.assertEqual(artifact["draft"],self.draft)

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
        path = "/content/sections/businessRequirements/acceptanceCriteria/blocks/0/rows/0/cells/2/content/0/text"
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
        self.assertEqual(error.feedback["path"]["existingPath"], "/content/sections/businessRequirements/acceptanceCriteria/blocks/0")
        self.assertEqual(error.feedback["path"]["type"], "object")
        self.assertIn("requirementIds", error.feedback["path"]["keys"])
        self.assertNotIn("rows", error.feedback["path"]["keys"])
        feedback = repair_error_feedback(error)
        self.assertIn("entire repair was not applied", feedback)
        self.assertNotIn("PRIVATE_", feedback)

    def test_out_of_range_repair_reports_array_length_and_unrelated_errors_have_no_details(self):
        path = "/content/sections/businessRequirements/acceptanceCriteria/blocks/99"
        repair = {"baseCandidateChecksum": "b" * 64, "operations": [{"op": "add", "path": path, "value": {}}]}
        with self.assertRaises(ArtifactDraftRepairPathError) as caught:
            _apply_repair(self.draft, repair, "b" * 64)
        self.assertEqual(caught.exception.feedback["path"]["length"], len(self.draft["content"]["sections"]["businessRequirements"]["acceptanceCriteria"]["blocks"]))
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
        base={"kind":"prd","schemaVersion":2,"operation":{"kind":"create"},"title":"title","citations":[],"content":{"a/b":{"~key":["first","second","third"]},"empty":{},"existing":{"x":1}}}
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
