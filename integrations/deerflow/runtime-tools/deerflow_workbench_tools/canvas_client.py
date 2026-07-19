from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.client import HTTPException
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


CAPABILITY_SECRET_NAME = "WORKBENCH_CANVAS_CAPABILITY"
CANVAS_TOOL_PROTOCOL = "workbench.canvas-agent-tool.v1"
CANVAS_DESCRIPTOR_PROTOCOL = "workbench.canvas-agent-tool-descriptor.v1"
CANVAS_REFERENCE_PROTOCOL = "workbench.canvas-agent-tool-reference.v1"
CANVAS_TOOL_NAMES = (
    "get_visible_screens",
    "get_selected_screens",
    "view_screen",
    "select_screen",
    "quick_edit",
    "duplicate_screen",
    "rename_screen",
    "navigate_canvas",
)

_MAX_CAPABILITY_BYTES = 16 * 1024
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_VISUAL_BYTES = 1_048_576
_REQUEST_TIMEOUT_SECONDS = 30
_VISUAL_REQUEST_TIMEOUT_SECONDS = 10
_MAX_POLL_ATTEMPTS = 64
_RETRY_DELAYS_SECONDS = (0.1, 0.3)
_POLL_DELAYS_SECONDS = (0.2, 0.4, 0.8, 1.6)
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
_WAITING_STATUSES = frozenset({"waiting_approval", "waiting_client"})
_RESULT_STATUSES = frozenset({
    "succeeded",
    "waiting_approval",
    "waiting_client",
    "failed",
    "cancelled",
})
_TOKEN_PATTERN = re.compile(r"^wbct1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$")
_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_URI_SCHEME_PATTERN = re.compile(r"^(?:https?|ftp|file|data|javascript|mailto):", re.IGNORECASE)
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_CURSOR_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
_ROUTE_PATTERN = re.compile(r"^/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+/?)*$")
_FAILURE_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")
_ISO_UTC_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$",
)
_INVOCATION_KEY_DOMAIN = b"workbench.canvas-agent-invocation.v1\x00"
_CANVAS_TOOL_PATH = "/api/v1/runtime/canvas/tools/execute"
_CANVAS_VISUAL_PATH = "/api/v1/runtime/canvas/visuals"
_DESCRIPTOR_KEYS = frozenset({
    "protocol",
    "endpoint",
    "token",
    "expiresAt",
    "visualEndpoint",
    "reference",
})
_VISUAL_MEDIA_TYPES = frozenset({"image/webp", "image/jpeg", "image/png"})
_REFERENCE_KEYS = frozenset({
    "protocol",
    "declarationRevision",
    "declarationSha256",
    "declaredTools",
})
_RESULT_KEYS = frozenset({
    "protocol",
    "agentSessionId",
    "toolCallId",
    "toolName",
    "status",
    "boardRevision",
    "canvasStateRevision",
    "responseSha256",
    "data",
    "failure",
    "approvalId",
    "clientCommandId",
})
_SCREEN_REFERENCE_KEYS = frozenset({
    "boardNodeId",
    "artifactId",
    "artifactVersionId",
    "screenId",
})


class CanvasToolError(RuntimeError):
    """A fixed-code error safe to pass through DeerFlow tool middleware."""


@dataclass(frozen=True)
class CanvasToolInvocationOutcome:
    result: dict[str, Any]
    image_content_block: dict[str, str] | None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def invoke_canvas_tool(
    capability_json: str,
    tool_name: str,
    tool_call_id: str,
    tool_input: dict[str, Any],
) -> CanvasToolInvocationOutcome:
    capability = _parse_capability(capability_json)
    normalized_tool_name = _validate_tool_name(tool_name)
    if normalized_tool_name not in capability["reference"]["declaredTools"]:
        raise CanvasToolError("WORKBENCH_CANVAS_TOOL_NOT_DECLARED")
    normalized_tool_call_id = _validate_tool_call_id(tool_call_id)
    normalized_input = _normalize_tool_input(normalized_tool_name, tool_input)
    payload = json.dumps(
        {
            "protocol": CANVAS_TOOL_PROTOCOL,
            "toolName": normalized_tool_name,
            "toolCallId": normalized_tool_call_id,
            "input": normalized_input,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    invocation_key = _invocation_key(normalized_tool_call_id)
    opener = build_opener(_NoRedirect())

    result = _post_invocation(opener, capability, payload, invocation_key)
    result = _validate_result(result, normalized_tool_name, normalized_tool_call_id)
    agent_session_id = result["agentSessionId"]
    for poll_index in range(_MAX_POLL_ATTEMPTS):
        if result["status"] not in _WAITING_STATUSES:
            break
        _assert_capability_not_expired(capability["expiresAt"])
        time.sleep(_POLL_DELAYS_SECONDS[min(poll_index, len(_POLL_DELAYS_SECONDS) - 1)])
        try:
            polled = _post_invocation(opener, capability, payload, invocation_key)
            result = _validate_result(polled, normalized_tool_name, normalized_tool_call_id)
            if result["agentSessionId"] != agent_session_id:
                raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        except CanvasToolError as error:
            # A transient failure while checking a still-pending command may
            # be retried by the runtime, but must never be returned to the
            # model as if the interactive effect had completed.
            if str(error) == "WORKBENCH_CANVAS_REQUEST_FAILED":
                continue
            raise
    if result["status"] in _WAITING_STATUSES:
        raise CanvasToolError("WORKBENCH_CANVAS_PENDING_TIMEOUT")
    image_content_block = None
    if normalized_tool_name == "view_screen" and result["status"] == "succeeded":
        visual_capability_id = result["data"]["view"]["visualCapabilityId"]
        if not _is_identifier(visual_capability_id):
            raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_MISSING")
        image_content_block = _fetch_visual(
            opener,
            capability,
            visual_capability_id,
        )
    return CanvasToolInvocationOutcome(
        result=result,
        image_content_block=image_content_block,
    )


async def ainvoke_canvas_tool(
    capability_json: str,
    tool_name: str,
    tool_call_id: str,
    tool_input: dict[str, Any],
) -> CanvasToolInvocationOutcome:
    return await asyncio.to_thread(
        invoke_canvas_tool,
        capability_json,
        tool_name,
        tool_call_id,
        tool_input,
    )


def _post_invocation(
    opener: Any,
    capability: dict[str, Any],
    payload: bytes,
    invocation_key: str,
) -> Any:
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
    for attempt in range(3):
        try:
            _assert_capability_not_expired(capability["expiresAt"])
            with opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
                content_type = response.headers.get("Content-Type", "")
                if not isinstance(content_type, str) or "application/json" not in content_type.lower():
                    raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
                declared = response.headers.get("Content-Length")
                if declared is not None and (
                    not isinstance(declared, str)
                    or not declared.isdigit()
                    or int(declared) > _MAX_RESPONSE_BYTES
                ):
                    raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_TOO_LARGE")
                body = response.read(_MAX_RESPONSE_BYTES + 1)
                if not isinstance(body, bytes):
                    raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
                if len(body) > _MAX_RESPONSE_BYTES:
                    raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_TOO_LARGE")
                return _load_strict_json(
                    body.decode("utf-8", errors="strict"),
                    "WORKBENCH_CANVAS_RESPONSE_INVALID",
                )
        except HTTPError as error:
            error.close()
            if error.code not in _RETRYABLE_STATUS or attempt == 2:
                raise CanvasToolError("WORKBENCH_CANVAS_REQUEST_FAILED") from error
        except (TimeoutError, URLError, ConnectionError) as error:
            if attempt == 2:
                raise CanvasToolError("WORKBENCH_CANVAS_REQUEST_FAILED") from error
        except UnicodeDecodeError as error:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID") from error
        time.sleep(_RETRY_DELAYS_SECONDS[attempt])
    raise CanvasToolError("WORKBENCH_CANVAS_REQUEST_FAILED")


def _fetch_visual(
    opener: Any,
    capability: dict[str, Any],
    visual_capability_id: str,
) -> dict[str, str]:
    visual_url = _visual_url(capability["visualEndpoint"], visual_capability_id)
    request = Request(
        visual_url,
        method="GET",
        headers={
            "Accept": "image/webp, image/jpeg, image/png",
            "Authorization": f"Bearer {capability['token']}",
            "Cache-Control": "no-store",
        },
    )
    for attempt in range(3):
        try:
            _assert_capability_not_expired(capability["expiresAt"])
            with opener.open(request, timeout=_VISUAL_REQUEST_TIMEOUT_SECONDS) as response:
                status = getattr(response, "status", getattr(response, "code", None))
                if status != 200:
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_RESPONSE_INVALID")
                response_url = response.geturl() if callable(getattr(response, "geturl", None)) else visual_url
                if response_url != visual_url:
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_REDIRECT_REJECTED")

                content_type = response.headers.get("Content-Type", "")
                if not isinstance(content_type, str):
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_RESPONSE_INVALID")
                media_type = content_type.partition(";")[0].strip().lower()
                if media_type not in _VISUAL_MEDIA_TYPES:
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_CONTENT_TYPE_INVALID")

                declared_length = response.headers.get("Content-Length")
                if declared_length is not None and (
                    not isinstance(declared_length, str)
                    or not declared_length.isdigit()
                    or not 1 <= int(declared_length) <= _MAX_VISUAL_BYTES
                ):
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_TOO_LARGE")

                declared_sha256 = response.headers.get("X-Content-SHA256")
                etag = response.headers.get("ETag")
                expires_at = response.headers.get("X-Canvas-Visual-Expires-At")
                if (
                    not isinstance(declared_sha256, str)
                    or not _SHA256_PATTERN.fullmatch(declared_sha256)
                    or etag != f'"{declared_sha256}"'
                    or not _visual_expiry_is_valid(expires_at, capability["expiresAt"])
                ):
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_RESPONSE_INVALID")

                body = response.read(_MAX_VISUAL_BYTES + 1)
                if not isinstance(body, bytes):
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_RESPONSE_INVALID")
                if not body or len(body) > _MAX_VISUAL_BYTES:
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_TOO_LARGE")
                if declared_length is not None and len(body) != int(declared_length):
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_RESPONSE_INVALID")
                actual_sha256 = hashlib.sha256(body).hexdigest()
                if not hmac.compare_digest(actual_sha256, declared_sha256):
                    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_INTEGRITY_INVALID")
                return {
                    "type": "image",
                    "base64": base64.b64encode(body).decode("ascii"),
                    "mime_type": media_type,
                }
        except HTTPError as error:
            error.close()
            if error.code not in _RETRYABLE_STATUS or attempt == 2:
                raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_REQUEST_FAILED") from error
        except (TimeoutError, URLError, ConnectionError, HTTPException, OSError) as error:
            if attempt == 2:
                raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_REQUEST_FAILED") from error
        time.sleep(_RETRY_DELAYS_SECONDS[attempt])
    raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_REQUEST_FAILED")


def _visual_url(endpoint: str, visual_capability_id: str) -> str:
    if not _is_identifier(visual_capability_id):
        raise CanvasToolError("WORKBENCH_CANVAS_VISUAL_MISSING")
    parsed = urlsplit(endpoint)
    path = f"{parsed.path.rstrip('/')}/{quote(visual_capability_id, safe='')}"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _visual_expiry_is_valid(value: Any, capability_expiry: str) -> bool:
    if (
        not isinstance(value, str)
        or not value
        or _utf16_length(value) > 64
        or not _ISO_UTC_PATTERN.fullmatch(value)
    ):
        return False
    try:
        visual_expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
        grant_expiry = datetime.fromisoformat(capability_expiry.replace("Z", "+00:00"))
    except ValueError:
        return False
    now = datetime.now(timezone.utc)
    return (
        visual_expiry.tzinfo is not None
        and grant_expiry.tzinfo is not None
        and now < visual_expiry.astimezone(timezone.utc) <= grant_expiry.astimezone(timezone.utc)
    )


def _parse_capability(raw: str) -> dict[str, Any]:
    if not isinstance(raw, str) or not raw:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    try:
        capability_size = len(raw.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID") from error
    if capability_size > _MAX_CAPABILITY_BYTES:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    value = _load_strict_json(raw, "WORKBENCH_CANVAS_CAPABILITY_INVALID")
    if not isinstance(value, dict) or frozenset(value.keys()) != _DESCRIPTOR_KEYS:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    if value.get("protocol") != CANVAS_DESCRIPTOR_PROTOCOL:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")

    tool_origin = _validate_descriptor_url(
        value.get("endpoint"),
        expected_path=_CANVAS_TOOL_PATH,
    )
    visual_origin = _validate_descriptor_url(
        value.get("visualEndpoint"),
        expected_path=_CANVAS_VISUAL_PATH,
    )
    if tool_origin != visual_origin:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")

    token = value.get("token")
    if (
        not isinstance(token, str)
        or not 64 <= _utf16_length(token) <= 4096
        or not _TOKEN_PATTERN.fullmatch(token)
    ):
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    _parse_future_expiry(value.get("expiresAt"))

    reference = value.get("reference")
    if not isinstance(reference, dict) or frozenset(reference.keys()) != _REFERENCE_KEYS:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    declared_tools = reference.get("declaredTools")
    if (
        reference.get("protocol") != CANVAS_REFERENCE_PROTOCOL
        or not _is_revision(reference.get("declarationRevision"))
        or not isinstance(reference.get("declarationSha256"), str)
        or not _SHA256_PATTERN.fullmatch(reference["declarationSha256"])
        or not isinstance(declared_tools, list)
        or len(declared_tools) > len(CANVAS_TOOL_NAMES)
        or any(not isinstance(candidate, str) for candidate in declared_tools)
        or len(set(declared_tools)) != len(declared_tools)
        or declared_tools != [name for name in CANVAS_TOOL_NAMES if name in declared_tools]
    ):
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    return value


def _validate_descriptor_url(
    value: Any,
    *,
    expected_path: str,
) -> tuple[str, str, int]:
    if (
        not isinstance(value, str)
        or not value
        or _utf16_length(value) > 2048
        or value != value.strip()
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    try:
        parsed = urlsplit(value)
        parsed_port = parsed.port
    except ValueError as error:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID") from error
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != expected_path
        or "?" in value
        or "#" in value
        or (parsed_port is not None and not 1 <= parsed_port <= 65535)
    ):
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    default_port = 443 if parsed.scheme == "https" else 80
    return parsed.scheme, parsed.hostname.lower(), parsed_port or default_port


def _parse_future_expiry(value: Any) -> datetime:
    if (
        not isinstance(value, str)
        or not value
        or _utf16_length(value) > 64
        or not _ISO_UTC_PATTERN.fullmatch(value)
    ):
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    try:
        expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID") from error
    if expiry.tzinfo is None:
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_INVALID")
    if expiry.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise CanvasToolError("WORKBENCH_CANVAS_CAPABILITY_EXPIRED")
    return expiry


def _assert_capability_not_expired(value: Any) -> None:
    _parse_future_expiry(value)


def _load_strict_json(raw: str, error_code: str) -> Any:
    try:
        return json.loads(
            raw,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except (TypeError, ValueError, RecursionError) as error:
        raise CanvasToolError(error_code) from error


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _validate_tool_name(value: Any) -> str:
    if not isinstance(value, str) or value not in CANVAS_TOOL_NAMES:
        raise CanvasToolError("WORKBENCH_CANVAS_TOOL_INVALID")
    return value


def _validate_tool_call_id(value: Any) -> str:
    if not _is_identifier(value, maximum_length=512):
        raise CanvasToolError("WORKBENCH_CANVAS_INVOCATION_INVALID")
    return value


def _invocation_key(tool_call_id: str) -> str:
    normalized = _validate_tool_call_id(tool_call_id)
    digest = hashlib.sha256(
        _INVOCATION_KEY_DOMAIN + normalized.encode("utf-8"),
    ).hexdigest()
    return f"canvas:{digest}"


def _normalize_tool_input(tool_name: str, value: Any) -> dict[str, Any]:
    if not isinstance(tool_name, str) or not isinstance(value, dict):
        raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
    if tool_name == "get_visible_screens":
        _require_exact_keys(value, frozenset(), frozenset({"cursor", "limit"}))
        result: dict[str, Any] = {}
        if "cursor" in value:
            cursor = value["cursor"]
            if not isinstance(cursor, str) or not 1 <= _utf16_length(cursor) <= 512 or not _CURSOR_PATTERN.fullmatch(cursor):
                raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
            result["cursor"] = cursor
        if "limit" in value:
            limit = value["limit"]
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
                raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
            result["limit"] = limit
        return result
    if tool_name == "get_selected_screens":
        _require_exact_keys(value, frozenset())
        return {}
    if tool_name in {"view_screen", "duplicate_screen"}:
        _require_exact_keys(value, frozenset({"target"}))
        return {"target": _normalize_screen_reference(value["target"])}
    if tool_name == "select_screen":
        _require_exact_keys(value, frozenset({"targets", "mode"}))
        targets = value["targets"]
        if not isinstance(targets, list) or not 1 <= len(targets) <= 512:
            raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
        normalized_targets = [_normalize_screen_reference(target) for target in targets]
        if len({_screen_reference_key(target) for target in normalized_targets}) != len(normalized_targets):
            raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
        mode = value["mode"]
        if not isinstance(mode, str) or mode not in {"replace", "add", "remove", "toggle"}:
            raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
        return {"targets": normalized_targets, "mode": mode}
    if tool_name == "quick_edit":
        _require_exact_keys(value, frozenset({"target", "instruction"}))
        instruction = _normalize_trimmed_string(value["instruction"], 8000)
        return {
            "target": _normalize_screen_reference(value["target"]),
            "instruction": instruction,
        }
    if tool_name == "rename_screen":
        _require_exact_keys(value, frozenset({"target", "title"}))
        return {
            "target": _normalize_screen_reference(value["target"]),
            "title": _normalize_trimmed_string(value["title"], 160),
        }
    if tool_name == "navigate_canvas":
        _require_exact_keys(value, frozenset({"target", "behavior"}))
        behavior = value["behavior"]
        if not isinstance(behavior, str) or behavior not in {"instant", "smooth"}:
            raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
        return {
            "target": _normalize_navigation_target(value["target"]),
            "behavior": behavior,
        }
    raise CanvasToolError("WORKBENCH_CANVAS_TOOL_INVALID")


def _normalize_navigation_target(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("kind"), str):
        raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
    kind = value["kind"]
    if kind == "screen":
        _require_exact_keys(value, frozenset({"kind", "screen"}))
        return {"kind": kind, "screen": _normalize_screen_reference(value["screen"])}
    if kind in {"selection", "all"}:
        _require_exact_keys(value, frozenset({"kind"}))
        return {"kind": kind}
    raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")


def _normalize_screen_reference(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or frozenset(value.keys()) != _SCREEN_REFERENCE_KEYS:
        raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
    result: dict[str, str] = {}
    for key in ("boardNodeId", "artifactId", "artifactVersionId", "screenId"):
        candidate = value[key]
        if not _is_identifier(candidate):
            raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
        result[key] = candidate
    return result


def _validate_result(value: Any, tool_name: str, tool_call_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or frozenset(value.keys()) != _RESULT_KEYS:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    status = value.get("status") if isinstance(value, dict) else None
    if (
        value.get("protocol") != CANVAS_TOOL_PROTOCOL
        or value.get("toolName") != tool_name
        or value.get("toolCallId") != tool_call_id
        or not isinstance(status, str)
        or status not in _RESULT_STATUSES
        or not _is_identifier(value.get("agentSessionId"))
        or not _is_revision(value.get("boardRevision"))
        or not _is_revision(value.get("canvasStateRevision"))
        or not isinstance(value.get("responseSha256"), str)
        or not _SHA256_PATTERN.fullmatch(value["responseSha256"])
    ):
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")

    data = value["data"]
    failure = value["failure"]
    approval_id = value["approvalId"]
    client_command_id = value["clientCommandId"]
    if status == "succeeded":
        _validate_tool_output(tool_name, data)
        if failure is not None or not _is_nullable_identifier(approval_id) or not _is_nullable_identifier(client_command_id):
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    elif status == "waiting_approval":
        if data is not None or failure is not None or not _is_identifier(approval_id) or client_command_id is not None:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    elif status == "waiting_client":
        if data is not None or failure is not None or approval_id is not None or not _is_identifier(client_command_id):
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    elif status == "failed":
        if data is not None or not _is_failure(failure) or approval_id is not None or client_command_id is not None:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    elif data is not None or failure is not None or approval_id is not None or client_command_id is not None:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    return value


def _validate_tool_output(tool_name: str, value: Any) -> None:
    if not isinstance(value, dict):
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    if tool_name == "get_visible_screens":
        _require_result_keys(value, frozenset({"items", "nextCursor", "truncated", "viewport"}))
        items = value["items"]
        if not isinstance(items, list) or len(items) > 100:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        for item in items:
            _validate_screen_summary(item)
        cursor = value["nextCursor"]
        if cursor is not None and (
            not isinstance(cursor, str)
            or not 1 <= _utf16_length(cursor) <= 512
            or not _CURSOR_PATTERN.fullmatch(cursor)
        ):
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        _require_bool(value["truncated"])
        _validate_viewport(value["viewport"])
        return
    if tool_name == "get_selected_screens":
        _validate_selection(value)
        return
    if tool_name == "view_screen":
        _require_result_keys(value, frozenset({"view"}))
        _validate_screen_view(value["view"])
        return
    if tool_name == "select_screen":
        _require_result_keys(value, frozenset({"selection"}))
        _validate_selection(value["selection"])
        return
    if tool_name == "quick_edit":
        _require_result_keys(value, frozenset({"runId", "target", "accepted"}))
        if not _is_identifier(value["runId"]):
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        _validate_screen_reference(value["target"])
        if value["accepted"] is not True:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        return
    if tool_name == "duplicate_screen":
        _require_result_keys(value, frozenset({"runId", "target", "accepted"}))
        if not _is_identifier(value["runId"]):
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        _validate_screen_reference(value["target"])
        if value["accepted"] is not True:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        return
    if tool_name == "rename_screen":
        _require_result_keys(value, frozenset({"runId", "target", "title", "accepted"}))
        if not _is_identifier(value["runId"]):
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        _validate_screen_reference(value["target"])
        _validate_trimmed_string(value["title"], 160)
        if value["accepted"] is not True:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
        return
    if tool_name == "navigate_canvas":
        _require_result_keys(value, frozenset({"viewport"}))
        _validate_viewport(value["viewport"])
        return
    raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")


def _validate_screen_reference(value: Any) -> None:
    try:
        _normalize_screen_reference(value)
    except CanvasToolError as error:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID") from error


def _validate_screen_summary(value: Any) -> None:
    _require_result_keys(value, frozenset({"reference", "name", "route", "phase", "viewport"}))
    _validate_screen_reference(value["reference"])
    _validate_trimmed_string(value["name"], 240)
    route = value["route"]
    if not isinstance(route, str) or not 1 <= _utf16_length(route) <= 1024 or not _ROUTE_PATTERN.fullmatch(route):
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    if not isinstance(value["phase"], str) or value["phase"] not in {"generating", "complete"}:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    viewport = value["viewport"]
    _require_result_keys(viewport, frozenset({"width", "height"}))
    for dimension in (viewport["width"], viewport["height"]):
        if isinstance(dimension, bool) or not isinstance(dimension, int) or not 1 <= dimension <= 16384:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")


def _validate_screen_view(value: Any) -> None:
    _require_result_keys(value, frozenset({"screen", "structure", "visualCapabilityId"}))
    _validate_screen_summary(value["screen"])
    structure = value["structure"]
    _require_result_keys(structure, frozenset({"nodeCount", "actionCount", "stateCount", "motionCount"}))
    maxima = {
        "nodeCount": 100000,
        "actionCount": 100000,
        "stateCount": 10000,
        "motionCount": 100000,
    }
    for key, maximum in maxima.items():
        count = structure[key]
        if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= maximum:
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    if not _is_nullable_identifier(value["visualCapabilityId"]):
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")


def _validate_selection(value: Any) -> None:
    _require_result_keys(value, frozenset({"kind", "items", "truncated"}))
    items = value["items"]
    if not isinstance(items, list) or len(items) > 512:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    for item in items:
        _validate_screen_summary(item)
    references = [_screen_reference_key(item["reference"]) for item in items]
    if len(set(references)) != len(references):
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    expected_kind = "none" if not items else "single" if len(items) == 1 else "multiple"
    if value["kind"] != expected_kind:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    _require_bool(value["truncated"])


def _validate_viewport(value: Any) -> None:
    _require_result_keys(value, frozenset({"x", "y", "zoom"}))
    for key in ("x", "y", "zoom"):
        candidate = value[key]
        if isinstance(candidate, bool) or not isinstance(candidate, (int, float)) or not math.isfinite(candidate):
            raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    if not -10000000 <= value["x"] <= 10000000 or not -10000000 <= value["y"] <= 10000000:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")
    if not 0.01 <= value["zoom"] <= 64:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")


def _is_failure(value: Any) -> bool:
    if not isinstance(value, dict) or frozenset(value.keys()) != frozenset({"code", "message", "retryable"}):
        return False
    code = value["code"]
    message = value["message"]
    return (
        isinstance(code, str)
        and 1 <= _utf16_length(code) <= 120
        and _FAILURE_CODE_PATTERN.fullmatch(code) is not None
        and isinstance(message, str)
        and 1 <= _utf16_length(message.strip()) <= 2000
        and isinstance(value["retryable"], bool)
    )


def _require_exact_keys(
    value: dict[str, Any],
    required: frozenset[str],
    optional: frozenset[str] = frozenset(),
) -> None:
    keys = frozenset(value.keys())
    if not required.issubset(keys) or not keys.issubset(required | optional):
        raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")


def _require_result_keys(value: Any, expected: frozenset[str]) -> None:
    if not isinstance(value, dict) or frozenset(value.keys()) != expected:
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")


def _require_bool(value: Any) -> None:
    if not isinstance(value, bool):
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")


def _normalize_trimmed_string(value: Any, maximum_length: int) -> str:
    if not isinstance(value, str):
        raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
    normalized = value.strip()
    if not normalized or _utf16_length(normalized) > maximum_length:
        raise CanvasToolError("WORKBENCH_CANVAS_INPUT_INVALID")
    return normalized


def _validate_trimmed_string(value: Any, maximum_length: int) -> None:
    if (
        not isinstance(value, str)
        or not value.strip()
        or _utf16_length(value.strip()) > maximum_length
    ):
        raise CanvasToolError("WORKBENCH_CANVAS_RESPONSE_INVALID")


def _is_identifier(value: Any, maximum_length: int = 128) -> bool:
    return (
        isinstance(value, str)
        and 1 <= _utf16_length(value) <= maximum_length
        and _ID_PATTERN.fullmatch(value) is not None
        and _URI_SCHEME_PATTERN.match(value) is None
    )


def _is_nullable_identifier(value: Any) -> bool:
    return value is None or _is_identifier(value)


def _is_revision(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, int) and value >= 0


def _screen_reference_key(reference: dict[str, str]) -> str:
    return "\x00".join(
        reference[key]
        for key in ("boardNodeId", "artifactId", "artifactVersionId", "screenId")
    )


def _utf16_length(value: str) -> int:
    # Zod runs in JavaScript, where string bounds count UTF-16 code units.
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2
