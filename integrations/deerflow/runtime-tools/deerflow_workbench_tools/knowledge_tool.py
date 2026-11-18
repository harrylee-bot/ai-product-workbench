from __future__ import annotations

import hashlib
import json

from langchain.tools import tool

from deerflow.tools.types import Runtime

from .knowledge_client import CAPABILITY_SECRET_NAME, KnowledgeToolError, retrieve_knowledge


@tool("workbench_knowledge_retrieve", parse_docstring=True, response_format="content_and_artifact")
def workbench_knowledge_retrieve(runtime: Runtime, query: str) -> tuple[str, dict | None]:
    """Retrieve citation-ready evidence from the exact Knowledge Release pinned to this 产品工作台 Run.

    Args:
        query: One focused product-domain question. Do not include credentials, endpoints, or a Release id.
    """
    context = runtime.context if isinstance(runtime.context, dict) else {}
    secrets = context.get("secrets")
    capability = secrets.get(CAPABILITY_SECRET_NAME) if isinstance(secrets, dict) else None
    tool_call_id = getattr(runtime, "tool_call_id", None)
    if not isinstance(capability, str):
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING")
    content = retrieve_knowledge(capability, query, tool_call_id)
    scope = context.get("workbench")
    if not isinstance(scope, dict) or not all(
        isinstance(scope.get(key), str) and scope[key] for key in ("runId", "runtimeAttemptId")
    ):
        return content, None
    return content, {
        "protocol": "workbench.knowledge-receipt.v1",
        "runId": scope["runId"],
        "runtimeAttemptId": scope["runtimeAttemptId"],
        "toolCallId": tool_call_id,
        "releaseId": json.loads(capability)["releaseId"],
        "contentSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
    }
