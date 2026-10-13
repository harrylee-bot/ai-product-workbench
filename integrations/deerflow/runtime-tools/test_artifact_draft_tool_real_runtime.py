"""Exercise real ToolNode/ToolRuntime injection in a clean Python subprocess."""
import os
from pathlib import Path
import subprocess
import sys
import unittest


class ArtifactDraftRealRuntimeTests(unittest.TestCase):
    def test_toolnode_injects_history_and_hides_runtime_from_model_schema(self):
        probe = subprocess.run([sys.executable, "-c", "import langgraph.prebuilt; import deerflow.tools.types"], capture_output=True)
        if probe.returncode:
            self.skipTest("Run with the locked DeerFlow Python environment for real ToolNode coverage")
        source = r'''
import asyncio, copy, json, logging
from pathlib import Path
logging.disable(logging.CRITICAL)
from langgraph.prebuilt import ToolNode
from langgraph.runtime import Runtime
from langchain_core.messages import HumanMessage, AIMessage
from deerflow_workbench_tools.artifact_draft_tool import workbench_artifact_draft_publish
from deerflow_workbench_tools.runtime_result_tool import workbench_runtime_result_submit
root = Path(__ROOT__)
draft = json.loads((root/'integrations/deerflow/test-fixtures/prd-runtime-result.example.json').read_text())['artifacts'][0]
assert set(workbench_artifact_draft_publish.tool_call_schema.model_json_schema()['properties']) == {'artifact_index','draft','repair'}
context = {'workbench':{'runId':'run_1','runtimeAttemptId':'attempt_1','requestedArtifactKinds':['prd']}}
node = ToolNode([workbench_artifact_draft_publish,workbench_runtime_result_submit], handle_tool_errors=False)
async def check(asynchronous):
    broken = copy.deepcopy(draft)
    broken['degradation'] = broken['content']['sections'].pop('degradation')
    state = {'messages':[HumanMessage('Generate the artifacts.')]}
    async def call(name, call_id, args):
        state['messages'].append(AIMessage(content='',tool_calls=[{'name':name,'id':call_id,'args':args}]))
        result = await node.ainvoke(state,runtime=Runtime(context=context)) if asynchronous else node.invoke(state,runtime=Runtime(context=context))
        state['messages'].extend(result['messages'])
        return result['messages'][0]
    rejected = await call('workbench_artifact_draft_publish','full',{'artifact_index':0,'draft':broken})
    ack = json.loads(rejected.content)
    assert ack['ok'] is False and rejected.artifact['ok'] is False
    repaired = await call('workbench_artifact_draft_publish','repair',{'artifact_index':0,'repair':{'baseCandidateChecksum':ack['candidateChecksum'],'operations':[{'op':'move','from':'/degradation','path':'/content/sections/degradation'}]}})
    assert json.loads(repaired.content)['ok'] is True and repaired.artifact['draft'] == draft
    placeholder = copy.deepcopy(draft)
    placeholder.update(title=[None], content=[None], operation=[None])
    final = await call('workbench_runtime_result_submit','final',{'candidate':{'protocol':'workbench.runtime.result.v1','message':'Done','artifacts':[placeholder]}})
    assert json.loads(final.content)['ok'] is True
    assert final.artifact['result']['artifacts'][0] == draft
asyncio.run(check(False))
asyncio.run(check(True))
print('REAL_TOOLNODE_SYNC_ASYNC_REPAIR_AND_FINALIZATION_PASS')
'''.replace("__ROOT__", repr(str(Path(__file__).resolve().parents[3])))
        result = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=45, env={**os.environ, "PYTHONDONTWRITEBYTECODE":"1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("REAL_TOOLNODE_SYNC_ASYNC_REPAIR_AND_FINALIZATION_PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
