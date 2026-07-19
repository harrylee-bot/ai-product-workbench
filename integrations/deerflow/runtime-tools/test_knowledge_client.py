from __future__ import annotations

import io
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from urllib.error import HTTPError

from deerflow_workbench_tools.knowledge_client import (
    KnowledgeToolError,
    _invocation_key,
    _normalize_query,
    _parse_capability,
    retrieve_knowledge,
)


def capability() -> str:
    return json.dumps({
        "protocol": "workbench.knowledge-tool.v1",
        "endpoint": "https://workbench.example.com/api/v1/runtime/knowledge/retrieve",
        "token": f"wbkg1.{'a' * 64}.{'b' * 43}",
        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
        "releaseId": "release_1",
        "mode": "hybrid",
        "routeScope": "production",
    })


class KnowledgeClientTest(unittest.TestCase):
    def test_parses_only_the_exact_https_capability(self):
        parsed = _parse_capability(capability())
        self.assertEqual(parsed["releaseId"], "release_1")
        unsafe = json.loads(capability())
        unsafe["endpoint"] = "http://workbench.example.com/retrieve"
        with self.assertRaisesRegex(KnowledgeToolError, "CAPABILITY_INVALID"):
            _parse_capability(json.dumps(unsafe))
        extra = json.loads(capability())
        extra["provider"] = "forbidden"
        with self.assertRaisesRegex(KnowledgeToolError, "CAPABILITY_INVALID"):
            _parse_capability(json.dumps(extra))

    def test_query_normalization_and_bounds(self):
        self.assertEqual(_normalize_query("  产品\r\n工作台  "), "产品\n工作台")
        with self.assertRaisesRegex(KnowledgeToolError, "QUERY_INVALID"):
            _normalize_query("")

    def test_invocation_key_is_stable_across_token_rotation_without_exposing_inputs(self):
        token = json.loads(capability())["token"]
        rotated_token = f"wbkg1.{'c' * 64}.{'d' * 43}"
        keys_across_rotation = [_invocation_key("tool-call-1") for _ in (token, rotated_token)]
        first = keys_across_rotation[0]
        self.assertEqual(keys_across_rotation, [first, first])
        self.assertNotEqual(first, _invocation_key("tool-call-2"))
        self.assertNotIn("tool-call-1", first)
        self.assertNotIn(token, first)
        self.assertNotIn(rotated_token, first)
        self.assertRegex(first, r"^knowledge:[0-9a-f]{64}$")

    def test_retryable_http_errors_close_every_response_body(self):
        bodies = []

        class RateLimitedOpener:
            def open(self, request, timeout):  # noqa: ARG002
                body = io.BytesIO(b'{"error":"rate limited"}')
                bodies.append(body)
                raise HTTPError(request.full_url, 429, "rate limited", {}, body)

        with (
            patch(
                "deerflow_workbench_tools.knowledge_client.build_opener",
                return_value=RateLimitedOpener(),
            ),
            patch("deerflow_workbench_tools.knowledge_client.time.sleep"),
            self.assertRaisesRegex(KnowledgeToolError, "REQUEST_FAILED"),
        ):
            retrieve_knowledge(capability(), "product rules", "tool-call-rate-limited")

        self.assertEqual(len(bodies), 3)
        self.assertTrue(all(body.closed for body in bodies))


if __name__ == "__main__":
    unittest.main()
