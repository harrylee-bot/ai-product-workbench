from __future__ import annotations

import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from app.gateway.routers.thread_runs import list_runs
from app.gateway.routers.threads import ThreadHistoryRequest, get_thread_history
from deerflow.runtime.runs.manager import RunManager
from deerflow.runtime.runs.store.memory import MemoryRunStore

from app.gateway.services import (
    _DEFAULT_LEAD_GRAPH_RECURSION_LIMIT,
    _WORKBENCH_PRD_LEAD_GRAPH_RECURSION_LIMIT,
    _WORKBENCH_PROTOTYPE_CODE_LEAD_GRAPH_RECURSION_LIMIT,
    _apply_workbench_lead_recursion_limit,
    _bind_server_run_id,
    _is_trusted_internal_caller,
    _sanitize_run_config,
    build_run_config,
    merge_run_context_overrides,
)


class WorkbenchRequestContextTests(unittest.TestCase):
    def test_real_run_manager_deduplicates_store_rows_without_underfilling(self) -> None:
        class RecordingMemoryRunStore(MemoryRunStore):
            def __init__(self) -> None:
                super().__init__()
                self.list_limits: list[int] = []

            async def list_by_thread(
                self,
                thread_id: str,
                *,
                user_id: str | None = None,
                limit: int = 100,
            ) -> list[dict]:
                self.list_limits.append(limit)
                return await super().list_by_thread(
                    thread_id,
                    user_id=user_id,
                    limit=limit,
                )

        async def exercise() -> tuple[list, object, RecordingMemoryRunStore]:
            store = RecordingMemoryRunStore()
            for index in range(1, 4):
                await store.put(
                    f"stored-{index}",
                    thread_id="thread-1",
                    user_id="user-1",
                    status="success",
                    created_at=f"2000-01-0{index}T00:00:00+00:00",
                )
            manager = RunManager(store)
            live = await manager.create("thread-1", user_id="user-1")
            records = await manager.list_by_thread(
                "thread-1",
                user_id="user-1",
                limit=4,
            )
            return records, live, store

        records, live, store = asyncio.run(exercise())
        self.assertEqual(store.list_limits, [5])
        self.assertEqual(
            [record.run_id for record in records],
            [live.run_id, "stored-3", "stored-2", "stored-1"],
        )
        self.assertEqual(len({record.run_id for record in records}), 4)
        self.assertIs(records[0], live)

    def test_run_list_honors_bounded_offset_pages_beyond_default_cap(self) -> None:
        class FakeRunManager:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def list_by_thread(self, thread_id: str, *, user_id: str | None = None, limit: int = 100) -> list:
                self.calls.append({"thread_id": thread_id, "user_id": user_id, "limit": limit})
                return [
                    SimpleNamespace(
                        run_id=f"run-{index}",
                        thread_id=thread_id,
                        assistant_id="lead_agent",
                        status=SimpleNamespace(value="success"),
                        metadata={},
                        kwargs={},
                        multitask_strategy="reject",
                        created_at="",
                        updated_at="",
                        total_input_tokens=0,
                        total_output_tokens=0,
                        total_tokens=0,
                        llm_call_count=0,
                        lead_agent_tokens=0,
                        subagent_tokens=0,
                        middleware_tokens=0,
                        message_count=0,
                    )
                    for index in range(min(limit, 205))
                ]

        async def exercise() -> tuple[list, list[dict]]:
            manager = FakeRunManager()
            request = SimpleNamespace(_deerflow_test_bypass_auth=True)
            with (
                patch("app.gateway.routers.thread_runs.get_run_manager", return_value=manager),
                patch("app.gateway.routers.thread_runs.get_current_user", return_value="user-1"),
            ):
                page = await list_runs(
                    thread_id="thread-1",
                    request=request,
                    limit=100,
                    offset=100,
                )
                bounded = await list_runs(
                    thread_id="thread-1",
                    request=request,
                    limit=100,
                    offset=10_000,
                )
            return page + bounded, manager.calls

        results, calls = asyncio.run(exercise())
        self.assertEqual([item.run_id for item in results[:100]], [f"run-{index}" for index in range(100, 200)])
        self.assertEqual(results[100:], [])
        self.assertEqual(
            calls,
            [
                {"thread_id": "thread-1", "user_id": "user-1", "limit": 200},
                {"thread_id": "thread-1", "user_id": "user-1", "limit": 10_100},
            ],
        )

    def test_server_run_id_overrides_caller_metadata_and_persists_workbench_ids(self) -> None:
        async def exercise() -> dict:
            config = build_run_config(
                "thread-1",
                None,
                {
                    "run_id": "forged-client-run",
                    "workbench_run_id": "workbench-run-1",
                    "workbench_runtime_attempt_id": "attempt-1",
                },
            )
            _bind_server_run_id(config, "deerflow-run-1")
            config["configurable"]["checkpoint_ns"] = ""

            async with AsyncSqliteSaver.from_conn_string(":memory:") as saver:
                checkpoint = empty_checkpoint()
                await saver.aput(config, checkpoint, {"source": "input", "step": 0}, {})
                saved = await saver.aget_tuple(config)
                self.assertIsNotNone(saved)
                return saved.metadata

        metadata = asyncio.run(exercise())
        self.assertEqual(metadata["run_id"], "deerflow-run-1")
        self.assertEqual(metadata["workbench_run_id"], "workbench-run-1")
        self.assertEqual(metadata["workbench_runtime_attempt_id"], "attempt-1")

    def test_history_forwards_an_exact_multi_key_metadata_filter(self) -> None:
        async def exercise() -> tuple[list, list]:
            async with AsyncSqliteSaver.from_conn_string(":memory:") as saver:
                config = {
                    "configurable": {
                        "thread_id": "thread-1",
                        "checkpoint_ns": "",
                    },
                }
                for metadata in (
                    {
                    "run_id": "deerflow-run-1",
                    "workbench_run_id": "workbench-run-1",
                    "workbench_runtime_attempt_id": "attempt-1",
                    "workbench_provider_idempotency_key": "wbrt:" + "a" * 64,
                    "workbench_attempt": 1,
                },
                {
                    "run_id": "deerflow-run-2",
                    "workbench_run_id": "workbench-run-1",
                    "workbench_runtime_attempt_id": "attempt-2",
                    "workbench_provider_idempotency_key": "wbrt:" + "b" * 64,
                    "workbench_attempt": 2,
                    },
                ):
                    await saver.aput(config, empty_checkpoint(), metadata, {})

                request = SimpleNamespace(_deerflow_test_bypass_auth=True)
                with patch("app.gateway.routers.threads.get_checkpointer", return_value=saver):
                    matching = await get_thread_history(
                        thread_id="thread-1",
                        body=ThreadHistoryRequest(
                            limit=10,
                            metadata={
                                "run_id": "deerflow-run-1",
                                "workbench_run_id": "workbench-run-1",
                                "workbench_runtime_attempt_id": "attempt-1",
                                "workbench_provider_idempotency_key": "wbrt:" + "a" * 64,
                                "workbench_attempt": 1,
                            },
                        ),
                        request=request,
                    )
                    missing_key = await get_thread_history(
                        thread_id="thread-1",
                        body=ThreadHistoryRequest(
                            limit=10,
                            metadata={
                                "run_id": "deerflow-run-1",
                                "workbench_run_id": "workbench-run-1",
                                "workbench_runtime_attempt_id": "missing-attempt",
                                "workbench_provider_idempotency_key": "wbrt:" + "a" * 64,
                                "workbench_attempt": 1,
                            },
                        ),
                        request=request,
                    )
                return matching, missing_key

        matching, missing_key = asyncio.run(exercise())
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0].metadata["run_id"], "deerflow-run-1")
        self.assertEqual(matching[0].metadata["workbench_run_id"], "workbench-run-1")
        self.assertEqual(
            matching[0].metadata["workbench_runtime_attempt_id"],
            "attempt-1",
        )
        self.assertEqual(missing_key, [])

    def test_history_metadata_filter_rejects_unbound_or_unbounded_values(self) -> None:
        valid = {
            "run_id": "deerflow-run-1",
            "workbench_run_id": "workbench-run-1",
            "workbench_runtime_attempt_id": "attempt-1",
            "workbench_provider_idempotency_key": "wbrt:" + "a" * 64,
            "workbench_attempt": 1,
        }
        self.assertEqual(ThreadHistoryRequest(metadata={}).metadata, {})
        invalid_filters = (
            {"run_id": "deerflow-run-1"},
            {**valid, "unexpected": "value"},
            {**valid, "run_id": ""},
            {**valid, "run_id": " leading"},
            {**valid, "run_id": "deerflow/run"},
            {**valid, "run_id": "x" * 129},
            {**valid, "run_id": 123},
            {**valid, "workbench_provider_idempotency_key": "bad-key"},
            {**valid, "workbench_attempt": 0},
            {**valid, "workbench_attempt": True},
            {**valid, "workbench_attempt": "1"},
        )
        for metadata in invalid_filters:
            with self.subTest(metadata=metadata):
                with self.assertRaises(ValueError):
                    ThreadHistoryRequest(metadata=metadata)

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
            "recursion_limit": 999,
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
        self.assertNotIn("recursion_limit", sanitized)
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

    def test_exact_trusted_prd_scope_receives_the_named_recursion_budget(self) -> None:
        self.assertEqual(_DEFAULT_LEAD_GRAPH_RECURSION_LIMIT, 100)
        self.assertEqual(_WORKBENCH_PRD_LEAD_GRAPH_RECURSION_LIMIT, 600)
        trusted_internal_caller = _is_trusted_internal_caller(
            SimpleNamespace(
                state=SimpleNamespace(
                    user=SimpleNamespace(system_role="internal"),
                ),
            ),
        )
        self.assertTrue(trusted_internal_caller)
        config = build_run_config(
            "thread-1",
            {"recursion_limit": 999},
            None,
        )
        merge_run_context_overrides(
            config,
            {
                "workbench": {
                    "runId": "run-1",
                    "runtimeAttemptId": "attempt-1",
                    "requestedArtifactKinds": ["prd"],
                },
            },
            allow_workbench_context=trusted_internal_caller,
        )
        _apply_workbench_lead_recursion_limit(
            config,
            trusted_internal_caller=trusted_internal_caller,
        )

        self.assertEqual(
            config["recursion_limit"],
            _WORKBENCH_PRD_LEAD_GRAPH_RECURSION_LIMIT,
        )

    def test_exact_trusted_prototype_and_code_scopes_receive_the_named_recursion_budget(self) -> None:
        self.assertEqual(_WORKBENCH_PROTOTYPE_CODE_LEAD_GRAPH_RECURSION_LIMIT, 400)
        trusted_internal_caller = _is_trusted_internal_caller(
            SimpleNamespace(
                state=SimpleNamespace(
                    user=SimpleNamespace(system_role="internal"),
                ),
            ),
        )
        self.assertTrue(trusted_internal_caller)
        for artifact_kind in ("prototype", "code"):
            with self.subTest(artifact_kind=artifact_kind):
                config = build_run_config(
                    "thread-1",
                    {"recursion_limit": 999},
                    None,
                )
                merge_run_context_overrides(
                    config,
                    {
                        "workbench": {
                            "runId": "run-1",
                            "runtimeAttemptId": "attempt-1",
                            "requestedArtifactKinds": [artifact_kind],
                        },
                    },
                    allow_workbench_context=trusted_internal_caller,
                )
                _apply_workbench_lead_recursion_limit(
                    config,
                    trusted_internal_caller=trusted_internal_caller,
                )

                self.assertEqual(
                    config["recursion_limit"],
                    _WORKBENCH_PROTOTYPE_CODE_LEAD_GRAPH_RECURSION_LIMIT,
                )

    def test_non_exact_malformed_untrusted_and_forged_fields_keep_default_budget(self) -> None:
        exact_prd_scope = {
            "runId": "run-1",
            "runtimeAttemptId": "attempt-1",
            "requestedArtifactKinds": ["prd"],
        }
        cases = (
            ("document", True, {**exact_prd_scope, "requestedArtifactKinds": ["document"]}),
            ("empty", True, {**exact_prd_scope, "requestedArtifactKinds": []}),
            ("prototype-mixed", True, {**exact_prd_scope, "requestedArtifactKinds": ["prototype", "document"]}),
            ("code-mixed", True, {**exact_prd_scope, "requestedArtifactKinds": ["code", "document"]}),
            ("prd-mixed", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "image"]}),
            ("mixed", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "prototype"]}),
            ("malformed", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "prd"]}),
            ("missing", True, {"runId": "run-1", "runtimeAttemptId": "attempt-1"}),
            ("untrusted", False, exact_prd_scope),
        )
        for label, trusted_internal_caller, scope in cases:
            with self.subTest(label=label):
                config = build_run_config(
                    "thread-1",
                    {
                        "recursion_limit": 200,
                        "configurable": {"requestedArtifactKinds": ["prd"]},
                        "context": {
                            "workbench": exact_prd_scope,
                            "recursion_limit": 200,
                        },
                    },
                    None,
                )
                merge_run_context_overrides(
                    config,
                    {
                        "recursion_limit": 200,
                        "workbench": scope,
                    },
                    allow_workbench_context=trusted_internal_caller,
                )
                _apply_workbench_lead_recursion_limit(
                    config,
                    trusted_internal_caller=trusted_internal_caller,
                )

                self.assertEqual(
                    config["recursion_limit"],
                    _DEFAULT_LEAD_GRAPH_RECURSION_LIMIT,
                )

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
