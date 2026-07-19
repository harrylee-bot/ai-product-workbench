from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

CAPABILITY_SECRET_NAME = "WORKBENCH_KNOWLEDGE_CAPABILITY"
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
_TOKEN_PATTERN = re.compile(r"^wbkg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$")
_INVOCATION_KEY_DOMAIN = b"workbench.knowledge-invocation.v1\x00"
_EXPECTED_KEYS = frozenset({
    "protocol",
    "endpoint",
    "token",
    "expiresAt",
    "releaseId",
    "mode",
    "routeScope",
})


class KnowledgeToolError(RuntimeError):
    """A fixed-code error safe to return through DeerFlow's tool middleware."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def retrieve_knowledge(capability_json: str, query: str, tool_call_id: str) -> str:
    capability = _parse_capability(capability_json)
    normalized_query = _normalize_query(query)
    invocation_key = _invocation_key(tool_call_id)
    payload = json.dumps(
        {
            "protocol": "workbench.knowledge-retrieval-request.v1",
            "query": normalized_query,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    request = Request(
        capability["endpoint"],
        data=payload,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {capability['token']}",
            "Content-Type": "application/json",
            "Idempotency-Key": invocation_key,
        },
    )
    opener = build_opener(_NoRedirect())
    for attempt in range(3):
        try:
            with opener.open(request, timeout=30) as response:
                content_type = response.headers.get("Content-Type", "").lower()
                if "application/json" not in content_type:
                    raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_RESPONSE_INVALID")
                declared = response.headers.get("Content-Length")
                if declared is not None and (not declared.isdigit() or int(declared) > _MAX_RESPONSE_BYTES):
                    raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_RESPONSE_TOO_LARGE")
                body = response.read(_MAX_RESPONSE_BYTES + 1)
                if len(body) > _MAX_RESPONSE_BYTES:
                    raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_RESPONSE_TOO_LARGE")
                try:
                    value = json.loads(body.decode("utf-8", errors="strict"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_RESPONSE_INVALID") from error
                if not isinstance(value, dict) or value.get("protocol") != "workbench.knowledge-retrieval-result.v1":
                    raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_RESPONSE_INVALID")
                return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except HTTPError as error:
            error.close()
            if error.code not in _RETRYABLE_STATUS or attempt == 2:
                raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_REQUEST_FAILED") from error
        except (TimeoutError, URLError) as error:
            if attempt == 2:
                raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_REQUEST_FAILED") from error
        time.sleep((0.1, 0.3)[attempt])
    raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_REQUEST_FAILED")


def _parse_capability(raw: str) -> dict[str, str]:
    if not isinstance(raw, str) or not raw or len(raw) > 8192:
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID")
    try:
        value: Any = json.loads(raw)
    except json.JSONDecodeError as error:
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID") from error
    if not isinstance(value, dict) or frozenset(value.keys()) != _EXPECTED_KEYS:
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID")
    if (
        value.get("protocol") != "workbench.knowledge-tool.v1"
        or value.get("mode") != "hybrid"
        or value.get("routeScope") != "production"
        or not isinstance(value.get("releaseId"), str)
        or not value["releaseId"]
        or not isinstance(value.get("token"), str)
        or not _TOKEN_PATTERN.fullmatch(value["token"])
    ):
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID")
    endpoint = value.get("endpoint")
    if not isinstance(endpoint, str) or len(endpoint) > 2048:
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID")
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID")
    expires_at = value.get("expiresAt")
    if not isinstance(expires_at, str):
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID")
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_INVALID") from error
    if expiry.tzinfo is None or expiry.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_CAPABILITY_EXPIRED")
    return value


def _normalize_query(value: str) -> str:
    if not isinstance(value, str):
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_QUERY_INVALID")
    normalized = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n").strip())
    if not normalized or len(normalized) > 4000 or "\x00" in normalized:
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_QUERY_INVALID")
    return normalized


def _invocation_key(tool_call_id: str) -> str:
    if not isinstance(tool_call_id, str) or not tool_call_id or len(tool_call_id) > 512:
        raise KnowledgeToolError("WORKBENCH_KNOWLEDGE_INVOCATION_INVALID")
    digest = hashlib.sha256(_INVOCATION_KEY_DOMAIN + tool_call_id.encode("utf-8")).hexdigest()
    return f"knowledge:{digest}"
