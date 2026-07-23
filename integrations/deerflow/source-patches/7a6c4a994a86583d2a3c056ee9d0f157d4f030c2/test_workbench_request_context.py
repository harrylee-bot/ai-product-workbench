from __future__ import annotations

from types import SimpleNamespace
import unittest

from app.gateway.services import (
    _is_trusted_internal_caller,
    _sanitize_run_config,
    build_run_config,
    merge_run_context_overrides,
)


class WorkbenchRequestContextTests(unittest.TestCase):
    def test_only_an_authenticated_internal_caller_can_deliver_workbench_channels(self) -> None:
        config = build_run_config(
            "thread-1",
            {
                "configurable": {
                    "WORKBENCH_KNOWLEDGE_CAPABILITY": "forged-config-secret",
                    "workbench": {"runId": "forged"},
                },
                "context": {
                    "secrets": {"WORKBENCH_CANVAS_CAPABILITY": "forged-context-secret"},
                },
            },
            None,
        )
        merge_run_context_overrides(
            config,
            {
                "workbench": {
                    "runId": "run-1",
                    "runtimeAttemptId": "attempt-1",
                    "requestedArtifactKinds": ["prototype"],
                    "knowledgeEnabled": True,
                    "canvasTools": None,
                    "prototypePatchBaselines": [],
                },
                "secrets": {
                    "WORKBENCH_KNOWLEDGE_CAPABILITY": "knowledge-secret",
                    "WORKBENCH_CANVAS_CAPABILITY": "canvas-secret",
                    "FORGED_SECRET": "must-not-pass",
                },
            },
            allow_workbench_context=True,
        )

        self.assertEqual(config["context"]["workbench"]["runId"], "run-1")
        self.assertEqual(
            config["context"]["workbench"]["requestedArtifactKinds"],
            ["prototype"],
        )
        self.assertIs(config["context"]["workbench"]["knowledgeEnabled"], True)
        self.assertEqual(
            config["context"]["secrets"],
            {
                "WORKBENCH_KNOWLEDGE_CAPABILITY": "knowledge-secret",
                "WORKBENCH_CANVAS_CAPABILITY": "canvas-secret",
            },
        )
        self.assertNotIn("secrets", config["configurable"])
        self.assertNotIn("WORKBENCH_KNOWLEDGE_CAPABILITY", config["configurable"])

    def test_untrusted_context_is_fail_closed_and_persistence_config_is_redacted(self) -> None:
        request_config = {
            "configurable": {
                "model_name": "gpt-5.5",
                "workbench": {"runId": "forged"},
                "WORKBENCH_KNOWLEDGE_CAPABILITY": "forged-config-secret",
            },
            "context": {
                "user_id": "user-1",
                "secrets": {"WORKBENCH_KNOWLEDGE_CAPABILITY": "forged-context-secret"},
            },
        }
        sanitized = _sanitize_run_config(request_config)
        self.assertEqual(sanitized["configurable"], {"model_name": "gpt-5.5"})
        self.assertEqual(sanitized["context"], {"user_id": "user-1"})
        self.assertIn("secrets", request_config["context"])

        config = build_run_config("thread-1", request_config, None)
        merge_run_context_overrides(
            config,
            {
                "workbench": {"runId": "run-1", "runtimeAttemptId": "attempt-1"},
                "secrets": {"WORKBENCH_KNOWLEDGE_CAPABILITY": "forged-body-secret"},
            },
        )
        self.assertNotIn("workbench", config.get("context", {}))
        self.assertNotIn("secrets", config.get("context", {}))
        self.assertNotIn("WORKBENCH_KNOWLEDGE_CAPABILITY", str(config))

    def test_internal_identity_is_server_stamped(self) -> None:
        self.assertTrue(
            _is_trusted_internal_caller(
                SimpleNamespace(
                    state=SimpleNamespace(
                        user=SimpleNamespace(system_role="internal"),
                    ),
                ),
            ),
        )
        self.assertFalse(
            _is_trusted_internal_caller(
                SimpleNamespace(
                    state=SimpleNamespace(
                        user=SimpleNamespace(system_role="admin"),
                    ),
                ),
            ),
        )
        self.assertFalse(_is_trusted_internal_caller(None))

    def test_malformed_scope_does_not_create_a_runtime_secret_channel(self) -> None:
        config = build_run_config("thread-1", None, None)
        merge_run_context_overrides(
            config,
            {
                "workbench": {"runId": "run-1"},
                "secrets": {"WORKBENCH_KNOWLEDGE_CAPABILITY": "orphan-secret"},
            },
            allow_workbench_context=True,
        )
        self.assertNotIn("workbench", config.get("context", {}))
        self.assertNotIn("secrets", config.get("context", {}))

    def test_malformed_requested_artifact_kinds_fail_closed(self) -> None:
        malformed = [
            "prototype",
            ["prototype", "prototype"],
            ["unknown"],
            ["prototype", 1],
            ["prd", "prototype", "image", "code", "document", "data", "prd"],
        ]
        for requested_kinds in malformed:
            with self.subTest(requested_kinds=requested_kinds):
                config = build_run_config("thread-1", None, None)
                merge_run_context_overrides(
                    config,
                    {
                        "workbench": {
                            "runId": "run-1",
                            "runtimeAttemptId": "attempt-1",
                            "requestedArtifactKinds": requested_kinds,
                        },
                    },
                    allow_workbench_context=True,
                )
                self.assertNotIn("workbench", config.get("context", {}))

    def test_knowledge_visibility_requires_the_exact_true_flag_and_capability(self) -> None:
        for flag, secret, enabled, secret_forwarded in (
            (True, "knowledge-secret", True, True),
            (True, None, False, False),
            (None, "orphan-secret", False, False),
        ):
            with self.subTest(flag=flag, secret=secret):
                scope = {"runId": "run-1", "runtimeAttemptId": "attempt-1"}
                if flag is not None:
                    scope["knowledgeEnabled"] = flag
                context = {"workbench": scope}
                if secret is not None:
                    context["secrets"] = {"WORKBENCH_KNOWLEDGE_CAPABILITY": secret}
                config = build_run_config("thread-1", None, None)
                merge_run_context_overrides(
                    config,
                    context,
                    allow_workbench_context=True,
                )
                self.assertEqual(
                    config["context"]["workbench"].get("knowledgeEnabled") is True,
                    enabled,
                )
                self.assertEqual(
                    "WORKBENCH_KNOWLEDGE_CAPABILITY" in config["context"].get("secrets", {}),
                    secret_forwarded,
                )

    def test_malformed_knowledge_visibility_flag_fails_closed(self) -> None:
        for flag in (False, 1, "true", {}, []):
            with self.subTest(flag=flag):
                config = build_run_config("thread-1", None, None)
                merge_run_context_overrides(
                    config,
                    {
                        "workbench": {
                            "runId": "run-1",
                            "runtimeAttemptId": "attempt-1",
                            "knowledgeEnabled": flag,
                        },
                        "secrets": {
                            "WORKBENCH_KNOWLEDGE_CAPABILITY": "must-not-pass",
                        },
                    },
                    allow_workbench_context=True,
                )
                self.assertNotIn("workbench", config.get("context", {}))
                self.assertNotIn("secrets", config.get("context", {}))


if __name__ == "__main__":
    unittest.main()
