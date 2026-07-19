from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from langchain.tools import tool
from langgraph.config import get_stream_writer

from deerflow.tools.types import Runtime


GENERATION_STAGE_PROTOCOL = "workbench.runtime.generation-stage.v1"
GenerationStage = Literal[
    "design-system",
    "mapping-components",
    "creating-flows",
    "generating-ui",
]


@tool(
    "workbench_generation_stage_update",
    parse_docstring=True,
    response_format="content_and_artifact",
)
def workbench_generation_stage_update(
    runtime: Runtime,
    stage: GenerationStage,
) -> tuple[str, dict[str, Any]]:
    """Record the real 产品工作台 generation stage before starting that work.

    Call this exactly when the lead agent begins the named phase. Do not use it for
    elapsed-time simulation, completion, screen readiness, or user-facing prose.

    Args:
        stage: The concrete generation phase that is starting now.
    """
    context = runtime.context if isinstance(runtime.context, dict) else {}
    scope = context.get("workbench")
    if not isinstance(scope, dict):
        raise ValueError("WORKBENCH_RUNTIME_SCOPE_MISSING")

    run_id = _required_identifier(scope.get("runId"), "WORKBENCH_RUN_ID_INVALID")
    runtime_attempt_id = _required_identifier(
        scope.get("runtimeAttemptId"),
        "WORKBENCH_RUNTIME_ATTEMPT_ID_INVALID",
    )
    tool_call_id = _required_identifier(
        getattr(runtime, "tool_call_id", None),
        "WORKBENCH_TOOL_CALL_ID_INVALID",
        maximum_length=512,
    )
    payload = {
        "protocol": GENERATION_STAGE_PROTOCOL,
        "runId": run_id,
        "runtimeAttemptId": runtime_attempt_id,
        "toolCallId": tool_call_id,
        "stage": stage,
    }
    artifact = {
        **payload,
        "checksum": hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest(),
    }

    try:
        get_stream_writer()({**artifact, "pending": True})
    except RuntimeError:
        # ToolMessage.artifact is the durable source. Custom streaming is only a latency hint.
        pass

    return (
        json.dumps(
            {
                "protocol": "workbench.runtime.generation-stage-ack.v1",
                "ok": True,
                "stage": stage,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        artifact,
    )


def _required_identifier(
    value: object,
    error_code: str,
    maximum_length: int = 240,
) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum_length:
        raise ValueError(error_code)
    return value


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
