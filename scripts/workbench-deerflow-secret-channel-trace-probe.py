#!/usr/bin/env python3
"""Probe the installed Workbench context -> ToolRuntime callback boundary.

Run inside the candidate runtime image, with no network, credentials, or mounted
runtime home. A deterministic model drives REAL LangChain/LangGraph callbacks,
the patched gateway and Workbench middleware, and an actual InMemorySaver. This
is an in-memory trace-sink test, not evidence of any external SaaS export. Pair
it with workbench-deerflow-secret-channel-smoke.mjs for HTTP/real-model evidence.

Only summary counts and source/version fingerprints leave this process. Random
capability canaries and unredacted callback/checkpoint payloads remain in memory.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime, timezone
import hashlib
from importlib import metadata
import inspect
import json
import logging
import os
from pathlib import Path
import platform
import secrets
import sys
import traceback
from typing import Any
from uuid import uuid4
import warnings


class ProbeFailure(Exception):
    """An error code that never interpolates observed data or capabilities."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise ProbeFailure(code)


def encode(value: Any) -> str:
    # Keep unknown values visible, including any accidental ToolRuntime repr.
    # No redactor is applied to evidence before scanning.
    return json.dumps(value, default=repr, ensure_ascii=False, sort_keys=True)


async def probe(observed_warnings: list[Any]) -> dict[str, Any]:
    # Explicitly disable auto-export in this isolated test process. The positive
    # trace evidence below comes from the supplied BaseTracer, never this flag.
    for key in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING", "LANGFUSE_TRACING", "MONOCLE_TRACING"):
        os.environ[key] = "false"

    from app.gateway.services import build_run_config, merge_run_context_overrides
    from deerflow.agents.middlewares.workbench_tool_scope_middleware import (
        WorkbenchToolScopeMiddleware,
        workbench_canvas_policy_from_runnable_config,
        workbench_knowledge_enabled_from_runnable_config,
        workbench_requested_artifact_kinds_from_runnable_config,
        workbench_run_scope_from_runnable_config,
    )
    from deerflow.runtime.runs.worker import _build_runtime_context, _install_runtime_context
    from deerflow.runtime.secret_context import redact_config_secrets
    from deerflow.tools.types import Runtime as DeerFlowToolRuntime
    from langchain.agents import create_agent
    from langchain.tools import ToolRuntime, tool
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.tracers.base import BaseTracer
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.runtime import Runtime

    # A local annotation is explicitly installed below because ToolRuntime must
    # resolve to the real installed class, not a postponed string annotation.
    canaries = {
        "WORKBENCH_KNOWLEDGE_CAPABILITY": "wbkg1." + secrets.token_urlsafe(48),
        "WORKBENCH_CANVAS_CAPABILITY": "wbct1." + secrets.token_urlsafe(48),
    }
    forbidden = [*canaries.keys(), *canaries.values(), "wbkg1.", "wbct1.", *(value[-16:] for value in canaries.values())]
    scan_counts: Counter[str] = Counter()

    def scan(value: Any, boundary: str) -> None:
        serialized = encode(value)
        require(not any(marker in serialized for marker in forbidden), "SECRET_PRESENT_" + boundary.upper())
        scan_counts[boundary] += 1

    # Prove the scanner rejects a canary and a reserved key, before collecting
    # positive results. No secrets are written even on these expected failures.
    for fixture in ({"output": canaries["WORKBENCH_KNOWLEDGE_CAPABILITY"]}, {"WORKBENCH_CANVAS_CAPABILITY": "masked"}):
        try:
            scan(fixture, "negative_control")
        except ProbeFailure:
            pass
        else:
            raise ProbeFailure("SCANNER_NEGATIVE_CONTROL_FAILED")

    class MemoryTracer(BaseTracer):
        raise_error = True
        run_inline = True

        def __init__(self) -> None:
            super().__init__()
            self.roots: list[Any] = []

        def _persist_run(self, run: Any) -> None:
            self.roots.append(run)

    sink = MemoryTracer()
    deliveries: Counter[str] = Counter()
    tool_args: list[Any] = []
    tool_returns: list[Any] = []

    def receive(runtime: Any, channel: str) -> str:
        require(isinstance(runtime, ToolRuntime), "REAL_TOOL_RUNTIME_NOT_INJECTED")
        require(runtime.context.get("secrets", {}).get(channel) == canaries[channel], "CAPABILITY_NOT_DELIVERED")
        require(runtime.context.get("workbench", {}).get("runId") == run_id, "WORKBENCH_SCOPE_NOT_DELIVERED")
        deliveries[channel] += 1
        result = "Public tool result for " + ("knowledge" if "KNOWLEDGE" in channel else "canvas")
        tool_returns.append(result)
        return result

    def knowledge(query: str, runtime: Any) -> str:
        tool_args.append({"query": query})
        return receive(runtime, "WORKBENCH_KNOWLEDGE_CAPABILITY")

    def canvas(runtime: Any) -> str:
        tool_args.append({})
        return receive(runtime, "WORKBENCH_CANVAS_CAPABILITY")

    # The production alias binds ToolRuntime's context/state generics. Using
    # bare ToolRuntime instead would give Pydantic a None context schema and
    # cause serializer warnings that can include truncated context contents.
    knowledge.__annotations__["runtime"] = DeerFlowToolRuntime
    canvas.__annotations__["runtime"] = DeerFlowToolRuntime
    knowledge_tool = tool("workbench_knowledge_retrieve", description="Retrieve public probe evidence.")(knowledge)
    canvas_tool = tool("get_visible_screens", description="Read public probe screen metadata.")(canvas)
    expected_tools = {knowledge_tool.name, canvas_tool.name}
    bindings: list[set[str]] = []

    class ProbeModel(FakeMessagesListChatModel):
        def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
            bindings.append({item.name for item in tools})
            for item in tools:
                schema = item.tool_call_schema.model_json_schema()
                scan(schema, "model_tool_schema")
                require("runtime" not in schema.get("properties", {}), "TOOL_RUNTIME_VISIBLE_TO_MODEL")
            return self

    run_id = "trace-probe-" + str(uuid4())
    thread_id = "thread-" + str(uuid4())
    config = build_run_config(thread_id, {"configurable": {
        "workbench_canvas_tools": {"declaredTools": ["get_visible_screens"]},
    }}, None)
    merge_run_context_overrides(config, {
        "workbench": {
            "runId": run_id,
            "runtimeAttemptId": "attempt-trace-probe",
            "requestedArtifactKinds": ["document"],
            "knowledgeEnabled": True,
            "canvasTools": None,
            "prototypePatchBaselines": [],
        },
        "secrets": dict(canaries),
    }, allow_workbench_context=True)
    require(config.get("context", {}).get("secrets") == canaries, "GATEWAY_DROPPED_TRUSTED_CAPABILITIES")
    # This is the actual production persistence redactor, not probe logic.
    scan(redact_config_secrets(config), "persisted_run_config")
    middleware = WorkbenchToolScopeMiddleware(
        canvas_policy=workbench_canvas_policy_from_runnable_config(config),
        requested_artifact_kinds=workbench_requested_artifact_kinds_from_runnable_config(config),
        knowledge_enabled=workbench_knowledge_enabled_from_runnable_config(config),
        run_scope=workbench_run_scope_from_runnable_config(config),
    )
    model = ProbeModel(responses=[
        AIMessage(content="", tool_calls=[
            {"name": knowledge_tool.name, "args": {"query": "Public trace probe"}, "id": "knowledge-call", "type": "tool_call"},
            {"name": canvas_tool.name, "args": {}, "id": "canvas-call", "type": "tool_call"},
        ]),
        AIMessage(content="Public trace probe completed."),
    ])
    saver = InMemorySaver()
    graph = create_agent(model, tools=[knowledge_tool, canvas_tool], middleware=[middleware], checkpointer=saver)
    runtime_context = _build_runtime_context(thread_id, run_id, config.get("context"))
    _install_runtime_context(config, runtime_context)
    config.setdefault("configurable", {})["__pregel_runtime"] = Runtime(context=runtime_context)
    config["callbacks"] = [sink]
    config["run_name"] = "workbench-secret-channel-trace-probe"
    stream_modes: Counter[str] = Counter()
    async for mode, payload in graph.astream(
        {"messages": [HumanMessage(content="Read the public knowledge and canvas probe once.")]},
        config=config,
        stream_mode=["updates", "values", "messages"],
    ):
        scan(payload, "stream")
        stream_modes[mode] += 1

    require(deliveries == Counter({key: 1 for key in canaries}), "BOTH_TOOL_DELIVERIES_REQUIRED")
    require(len(bindings) == 2 and all(names == expected_tools for names in bindings), "SCOPED_MODEL_TOOL_CATALOG_MISSING")
    require(all(stream_modes[mode] > 0 for mode in ("updates", "values", "messages")), "STREAM_EVIDENCE_MISSING")
    for value in tool_args:
        scan(value, "tool_arguments")
    for value in tool_returns:
        scan(value, "tool_returns")

    # Use a fresh token-free lookup config, as the HTTP state/history endpoints
    # do. The saved tuple includes config, metadata, values and pending writes.
    lookup = {"configurable": {"thread_id": thread_id}}
    checkpoints = list(saver.list(lookup))
    history = list(graph.get_state_history(lookup))
    require(len(checkpoints) >= 3 and len(history) == len(checkpoints), "CHECKPOINT_EVIDENCE_MISSING")
    for checkpoint in checkpoints:
        scan(checkpoint._asdict(), "checkpoint")
    for snapshot in history:
        scan(snapshot._asdict(), "state_history")

    require(len(sink.roots) == 1, "ROOT_TRACE_EVIDENCE_MISSING")
    counts: Counter[str] = Counter()
    trace_tools: set[str] = set()

    def inspect_run(run: Any, parent_id: Any = None) -> None:
        require(run.parent_run_id == parent_id, "TRACE_PARENT_LINK_INVALID")
        require(run.end_time is not None and not run.error, "TRACE_RUN_NOT_SUCCESSFUL")
        counts[run.run_type] += 1
        if run.run_type == "tool":
            trace_tools.add(run.name)
            require(bool(run.outputs), "TOOL_TRACE_OUTPUT_MISSING")
        for child in run.child_runs:
            inspect_run(child, run.id)

    for root in sink.roots:
        require(root.run_type == "chain" and root.name == config["run_name"], "WRONG_ROOT_TRACE")
        inspect_run(root)
        scan(root.model_dump(), "trace_tree")
    require(counts["llm"] == 2 and counts["tool"] == 2 and trace_tools == expected_tools, "MODEL_TOOL_TRACE_EVIDENCE_MISSING")
    for warning in observed_warnings:
        scan(str(warning.message), "warnings")

    fingerprint_targets = {
        "gatewayContext": build_run_config,
        "runtimeWorker": _build_runtime_context,
        "toolScopeMiddleware": WorkbenchToolScopeMiddleware,
        "runConfigRedactor": redact_config_secrets,
    }
    fingerprints = {name: hashlib.sha256(Path(inspect.getfile(target)).read_bytes()).hexdigest() for name, target in fingerprint_targets.items()}
    return {
        "protocol": "workbench.secret-channel-trace-evidence.v1",
        "ok": True,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "machine": platform.machine(),
        "versions": {name: metadata.version(name) for name in ("langchain", "langchain-core", "langgraph", "langgraph-checkpoint")},
        "sourceSha256": fingerprints,
        "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "model": "deterministic-in-process-model-with-real-langchain-callbacks",
        "traceSink": "langchain.BaseTracer/in-memory",
        "externalSaaSTraceExport": False,
        "contextRoute": "gateway.merge_run_context_overrides -> worker._build_runtime_context/_install_runtime_context -> __pregel_runtime -> WorkbenchToolScopeMiddleware -> ToolRuntime",
        "checks": {
            "toolRuntimeDelivery": True,
            "persistedRunConfigRedacted": True,
            "checkpointRedacted": True,
            "eventStreamRedacted": True,
            "traceRedacted": True,
            "scannerNegativeControls": True,
        },
        "rootTraces": len(sink.roots),
        "traceSpans": dict(counts),
        "toolDeliveries": {"knowledge": deliveries["WORKBENCH_KNOWLEDGE_CAPABILITY"], "canvas": deliveries["WORKBENCH_CANVAS_CAPABILITY"]},
        "streamEvents": dict(stream_modes),
        "scanned": dict(scan_counts),
        "negativeControls": 2,
        "warningCount": len(observed_warnings),
    }


if __name__ == "__main__":
    logging.getLogger().setLevel(logging.CRITICAL)
    try:
        # Capture and inspect warnings before printing the safe summary. Never
        # let a serializer warning print a truncated capability to stderr.
        with warnings.catch_warnings(record=True) as captured_warnings:
            warnings.simplefilter("always")
            result = asyncio.run(probe(captured_warnings))
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        # Never print exception messages, payloads or locals: they can contain
        # the very secrets this probe is intended to detect.
        print(json.dumps({
            "protocol": "workbench.secret-channel-trace-evidence.v1",
            "ok": False,
            "errorCode": str(error) if isinstance(error, ProbeFailure) else "PROBE_EXECUTION_FAILED",
            "errorType": type(error).__name__,
            "frames": [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name} for frame in traceback.extract_tb(error.__traceback__)],
        }, sort_keys=True))
        sys.exit(1)
