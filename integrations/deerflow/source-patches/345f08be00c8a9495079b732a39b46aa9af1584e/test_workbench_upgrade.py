"""Exercise Workbench's upgraded history, pagination and rollback contracts."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from pydantic import ValidationError

from app.gateway.services import _RawCheckpointReadAccessor
from app.gateway.routers.threads import ThreadHistoryRequest
from app.gateway.routers import thread_runs
from deerflow.runtime.checkpoint_state import CheckpointStateAccessor
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext, run_agent
from deerflow.runtime.user_context import reset_current_user, set_current_user


BINDING = {"run_id": "deerflow-1", "workbench_run_id": "run-1",
           "workbench_runtime_attempt_id": "attempt-1",
           "workbench_provider_idempotency_key": "wbrt:" + "a" * 64,
           "workbench_attempt": 1}


class UpgradeCompatibility(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner = set_current_user(SimpleNamespace(id="upgrade-test"))

    def tearDown(self):
        reset_current_user(self.owner)

    def test_history_binding_requires_all_bounded_identifiers(self):
        self.assertEqual(ThreadHistoryRequest(metadata=BINDING).metadata, BINDING)
        for invalid in ({"run_id": "other"}, {**BINDING, "workbench_attempt": True},
                        {**BINDING, "workbench_run_id": "../other"},
                        {**BINDING, "workbench_provider_idempotency_key": "wbrt:invalid"}):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                ThreadHistoryRequest(metadata=invalid)

    async def test_materialized_history_filters_before_limiting_the_page(self):
        saver = InMemorySaver()
        graph = StateGraph(MessagesState)
        graph.add_node("respond", lambda state: {"messages": [AIMessage(content="draft")]})
        graph.add_edge(START, "respond")
        graph.add_edge("respond", END)
        compiled = graph.compile(checkpointer=saver)
        accessor = CheckpointStateAccessor.bind(compiled, saver)
        config = {"configurable": {"thread_id": "history-upgrade"}, "metadata": BINDING}
        await compiled.ainvoke({"messages": [HumanMessage(content="first")]}, config)
        await compiled.ainvoke({"messages": [HumanMessage(content="second")]},
                               {**config, "metadata": {**BINDING, "workbench_run_id": "run-2"}})
        for reader in (accessor, _RawCheckpointReadAccessor(saver, "full")):
            with self.subTest(reader=type(reader).__name__):
                history = await reader.ahistory(config, limit=1, metadata_filter=BINDING)
                self.assertEqual(len(history), 1)
                self.assertEqual(history[0].metadata["workbench_run_id"], "run-1")
                self.assertTrue(history[0].values["messages"])
                self.assertEqual(await reader.ahistory(config, limit=1,
                                 metadata_filter={**BINDING, "workbench_run_id": "missing"}), [])

    async def test_legacy_offset_pagination_keeps_latest_ownership_scope(self):
        manager = RunManager()
        records = []
        for _ in range(5):
            record = await manager.create("offset-upgrade")
            await manager.set_status(record.run_id, RunStatus.success)
            records.append(record)
        with patch.object(thread_runs, "get_run_manager", return_value=manager), \
             patch.object(thread_runs, "_run_scope_user_id", new=AsyncMock(return_value="upgrade-test")):
            response = await thread_runs.list_runs.__wrapped__(
                "offset-upgrade", SimpleNamespace(), limit=2, offset=2)
        self.assertEqual([r.run_id for r in response], [r.run_id for r in records[::-1][2:4]])

    async def test_model_fallback_restores_checkpoint_and_allows_the_next_run(self):
        saver = InMemorySaver()
        graph = StateGraph(MessagesState)
        graph.add_node("respond", lambda state: {"messages": [AIMessage(
            content="Provider unavailable", additional_kwargs={"deerflow_error_fallback": True,
                                                               "error_detail": "fixture provider failure"})]})
        graph.add_edge(START, "respond")
        graph.add_edge("respond", END)
        compiled = graph.compile(checkpointer=saver)
        thread_id = "fallback-upgrade"
        config = {"configurable": {"thread_id": thread_id}}
        await compiled.aupdate_state(config, {"messages": [HumanMessage(content="preserved")]}, as_node="respond")
        manager = RunManager()
        record = await manager.create(thread_id)
        bridge = SimpleNamespace(publish=AsyncMock(), publish_end=AsyncMock(), cleanup=AsyncMock())
        await run_agent(bridge, manager, record, ctx=RunContext(checkpointer=saver),
                        agent_factory=lambda **kwargs: compiled,
                        graph_input={"messages": [HumanMessage(content="failed prompt")]},
                        config={**config, "context": {"workbench": {"runId": "run-1", "runtimeAttemptId": "attempt-1"}}})
        await asyncio.sleep(0)
        self.assertEqual(record.status, RunStatus.error)
        self.assertEqual(record.error, "fixture provider failure")
        state = await compiled.aget_state(config)
        self.assertEqual([m.content for m in state.values["messages"]], ["preserved"])
        bridge.publish_end.assert_awaited_once_with(record.run_id)
        next_record = await manager.create(thread_id)
        self.assertNotEqual(next_record.run_id, record.run_id)


if __name__ == "__main__":
    unittest.main()
