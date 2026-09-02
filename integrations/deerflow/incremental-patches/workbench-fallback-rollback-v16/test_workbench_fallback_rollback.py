import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.base import empty_checkpoint

from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.schemas import RunStatus
from deerflow.runtime.runs.worker import RunContext, run_agent


def _bridge():
    return SimpleNamespace(
        publish=AsyncMock(),
        publish_end=AsyncMock(),
        cleanup=AsyncMock(),
    )


def _pre_run_checkpoint():
    checkpoint = empty_checkpoint()
    checkpoint["id"] = "00000000-0000-0000-0000-000000000001"
    checkpoint["channel_values"] = {"messages": ["before"]}
    checkpoint["channel_versions"] = {"messages": 1}
    return SimpleNamespace(
        config={
            "configurable": {
                "thread_id": "thread-1",
                "checkpoint_ns": "",
                "checkpoint_id": checkpoint["id"],
            }
        },
        checkpoint=checkpoint,
        metadata={"source": "input"},
        pending_writes=[],
    )


def _checkpointer(*, rollback_error: Exception | None = None):
    checkpoint = _pre_run_checkpoint()
    aput = AsyncMock(
        return_value={
            "configurable": {
                "thread_id": "thread-1",
                "checkpoint_ns": "",
                "checkpoint_id": "00000000-0000-0000-0000-000000000002",
            }
        }
    )
    if rollback_error is not None:
        aput.side_effect = rollback_error
    return SimpleNamespace(
        aget_tuple=AsyncMock(return_value=checkpoint),
        aput=aput,
        aput_writes=AsyncMock(),
        adelete_thread=AsyncMock(),
    )


class FallbackAgent:
    async def astream(self, graph_input, config=None, stream_mode=None, subgraphs=False):
        yield {
            "messages": [
                AIMessage(
                    content="The configured LLM provider is temporarily unavailable.",
                    additional_kwargs={
                        "deerflow_error_fallback": True,
                        "error_detail": "Provider connection failed.",
                    },
                )
            ]
        }


def _factory(*, config):
    return FallbackAgent()


def _workbench_config():
    return {
        "context": {
            "workbench": {
                "runId": "workbench-run-1",
                "runtimeAttemptId": "runtime-attempt-1",
                "requestedArtifactKinds": ["prd"],
            }
        }
    }


@pytest.mark.anyio
async def test_workbench_llm_fallback_restores_pre_run_checkpoint_before_error_is_visible():
    run_manager = RunManager()
    record = await run_manager.create("thread-1")
    checkpointer = _checkpointer()
    statuses: list[RunStatus] = []
    original_set_status = run_manager.set_status

    async def set_status(run_id, status, *, error=None):
        if status == RunStatus.error:
            checkpointer.aput.assert_awaited_once()
        statuses.append(status)
        await original_set_status(run_id, status, error=error)

    run_manager.set_status = set_status
    bridge = _bridge()

    await run_agent(
        bridge,
        run_manager,
        record,
        ctx=RunContext(checkpointer=checkpointer),
        agent_factory=_factory,
        graph_input={},
        config=_workbench_config(),
    )
    await asyncio.sleep(0)

    fetched = await run_manager.get(record.run_id)
    assert fetched is not None
    assert fetched.status == RunStatus.error
    assert fetched.error == "Provider connection failed."
    assert statuses == [RunStatus.running, RunStatus.error]
    checkpointer.aput.assert_awaited_once()
    bridge.publish_end.assert_awaited_once_with(record.run_id)


@pytest.mark.anyio
async def test_generic_llm_fallback_keeps_existing_checkpoint_semantics():
    run_manager = RunManager()
    record = await run_manager.create("thread-1")
    checkpointer = _checkpointer()

    await run_agent(
        _bridge(),
        run_manager,
        record,
        ctx=RunContext(checkpointer=checkpointer),
        agent_factory=_factory,
        graph_input={},
        config={},
    )

    fetched = await run_manager.get(record.run_id)
    assert fetched is not None
    assert fetched.status == RunStatus.error
    assert fetched.error == "Provider connection failed."
    checkpointer.aput.assert_not_awaited()


@pytest.mark.anyio
async def test_workbench_rollback_failure_does_not_hide_provider_error():
    run_manager = RunManager()
    record = await run_manager.create("thread-1")
    checkpointer = _checkpointer(rollback_error=RuntimeError("checkpoint store unavailable"))

    await run_agent(
        _bridge(),
        run_manager,
        record,
        ctx=RunContext(checkpointer=checkpointer),
        agent_factory=_factory,
        graph_input={},
        config=_workbench_config(),
    )

    fetched = await run_manager.get(record.run_id)
    assert fetched is not None
    assert fetched.status == RunStatus.error
    assert fetched.error == "Provider connection failed."
    checkpointer.aput.assert_awaited_once()
