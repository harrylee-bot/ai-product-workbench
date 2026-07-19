from __future__ import annotations

from langchain.tools import tool

from deerflow.tools.types import Runtime

from .knowledge_client import CAPABILITY_SECRET_NAME, KnowledgeToolError, retrieve_knowledge


@tool("workbench_knowledge_retrieve", parse_docstring=True)
def workbench_knowledge_retrieve(runtime: Runtime, query: str) -> str:
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
    return retrieve_knowledge(capability, query, tool_call_id)
