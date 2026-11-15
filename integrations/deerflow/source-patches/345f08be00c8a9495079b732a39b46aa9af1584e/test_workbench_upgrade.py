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
from deerflow.runtime.stream_bridge.base import END_SENTINEL, StreamGap
from deerflow.runtime.stream_bridge.memory import MemoryStreamBridge
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


class StreamBackpressureCompatibility(unittest.IsolatedAsyncioTestCase):
    def bridge(self, size=2):
        bridge = MemoryStreamBridge(queue_maxsize=size)
        self.addAsyncCleanup(bridge.close)
        return bridge

    async def blocked_publisher(self, bridge):
        await bridge.publish("run", "values", {"sequence": 0})
        reader = bridge.subscribe("run")
        self.addAsyncCleanup(reader.aclose)
        await anext(reader)
        await bridge.publish("run", "values", {"sequence": 1})
        await bridge.publish("run", "values", {"sequence": 2})
        pending = asyncio.create_task(bridge.publish("run", "values", {"sequence": 3}))
        await asyncio.sleep(0)
        self.assertFalse(pending.done(), "unread active history must apply backpressure")
        return reader, pending

    async def test_active_subscriber_receives_burst_larger_than_retention_without_gap(self):
        bridge = self.bridge(8)
        ready = asyncio.Event()
        received = []

        async def consume():
            async for item in bridge.subscribe("run"):
                self.assertNotIsInstance(item, StreamGap)
                if item is END_SENTINEL:
                    return
                received.append(item)
                ready.set()
                # SSE serialization and socket writes yield to the producer.
                await asyncio.sleep(0)

        consumer = asyncio.create_task(consume())
        await bridge.publish("run", "metadata", {"sequence": 0})
        await ready.wait()
        async def publish_burst():
            for sequence in range(1, 1001):
                await bridge.publish("run", "messages", {"sequence": sequence})
            await bridge.publish_end("run")

        await asyncio.wait_for(asyncio.gather(publish_burst(), consumer), 5)
        self.assertEqual([int(item.id.split("-")[1]) for item in received], list(range(1001)))
        self.assertEqual([item.data["sequence"] for item in received], list(range(1001)))
        self.assertLessEqual(len(bridge._streams["run"].events), 8)

    async def test_slow_subscriber_advancement_releases_one_blocked_write(self):
        bridge = self.bridge()
        reader, pending = await self.blocked_publisher(bridge)
        self.assertEqual((await anext(reader)).data, {"sequence": 1})
        await asyncio.wait_for(pending, 2)
        self.assertEqual((await anext(reader)).data, {"sequence": 2})
        self.assertEqual((await anext(reader)).data, {"sequence": 3})
        self.assertEqual(len(bridge._streams["run"].events), 2)

    async def test_disconnected_subscriber_releases_blocked_publisher(self):
        bridge = self.bridge()
        reader, pending = await self.blocked_publisher(bridge)
        await reader.aclose()
        await asyncio.wait_for(pending, 2)
        for sequence in range(4, 12):
            await asyncio.wait_for(bridge.publish("run", "values", {"sequence": sequence}), 2)
        self.assertEqual(len(bridge._streams["run"].events), 2)
        self.assertEqual(bridge._streams["run"].subscriber_offsets, {})

    async def test_cancelled_waiting_subscriber_does_not_block_later_writes(self):
        bridge = self.bridge()
        reader = bridge.subscribe("run")
        pending_read = asyncio.create_task(anext(reader))
        await asyncio.sleep(0)
        pending_read.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending_read
        for sequence in range(8):
            await asyncio.wait_for(bridge.publish("run", "values", {"sequence": sequence}), 2)
        self.assertEqual(bridge._streams["run"].subscriber_offsets, {})
        self.assertEqual(len(bridge._streams["run"].events), 2)

    async def test_cancelled_blocked_write_does_not_reserve_an_event_identity(self):
        bridge = self.bridge()
        reader, pending = await self.blocked_publisher(bridge)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        await reader.aclose()
        await bridge.publish("run", "values", {"sequence": 4})
        self.assertEqual(bridge._streams["run"].events[-1].id.split("-")[1], "3")
        self.assertEqual(bridge._streams["run"].events[-1].data, {"sequence": 4})

    async def test_slowest_active_subscriber_controls_retention(self):
        bridge = self.bridge()
        slow, pending = await self.blocked_publisher(bridge)
        fast = bridge.subscribe("run")
        self.addAsyncCleanup(fast.aclose)
        self.assertEqual((await anext(fast)).data, {"sequence": 1})
        self.assertEqual((await anext(fast)).data, {"sequence": 2})
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        await slow.aclose()
        await asyncio.wait_for(pending, 2)
        self.assertEqual((await anext(fast)).data, {"sequence": 3})

    async def test_cleanup_and_close_release_waiters_without_writing_to_closed_stream(self):
        for operation in ("cleanup", "close"):
            with self.subTest(operation=operation):
                bridge = self.bridge()
                reader, pending = await self.blocked_publisher(bridge)
                if operation == "cleanup":
                    await bridge.cleanup("run")
                else:
                    await bridge.close()
                with self.assertRaisesRegex(RuntimeError, "STREAM_BRIDGE_CLOSED"):
                    await asyncio.wait_for(pending, 2)
                self.assertIs(await anext(reader), END_SENTINEL)
                self.assertFalse(await bridge.stream_exists("run"))

    async def test_expired_resume_cursor_still_reports_a_real_gap(self):
        bridge = self.bridge()
        await bridge.publish("run", "values", {"sequence": 0})
        old_cursor = bridge._streams["run"].events[-1].id
        for sequence in range(1, 6):
            await bridge.publish("run", "values", {"sequence": sequence})
        reader = bridge.subscribe("run", last_event_id=old_cursor)
        self.addAsyncCleanup(reader.aclose)
        gap = await anext(reader)
        self.assertIsInstance(gap, StreamGap)
        self.assertEqual(gap.requested_event_id, old_cursor)
        self.assertEqual(gap.earliest_available_event_id.split("-")[1], "4")
        self.assertEqual(gap.latest_available_event_id.split("-")[1], "5")
        with self.assertRaises(StopAsyncIteration):
            await anext(reader)


if __name__ == "__main__":
    unittest.main()
