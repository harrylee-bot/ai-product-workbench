from __future__ import annotations

import json
from types import SimpleNamespace
import unittest

from app.gateway.services import (
    _DEFAULT_LEAD_GRAPH_RECURSION_LIMIT,
    _WORKBENCH_LINKED_LEAD_GRAPH_RECURSION_LIMIT,
    _WORKBENCH_PRD_LEAD_GRAPH_RECURSION_LIMIT,
    _WORKBENCH_PROTOTYPE_LEAD_GRAPH_RECURSION_LIMIT,
    _apply_workbench_lead_recursion_limit,
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
                        auth_source="internal",
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
        self.assertFalse(_is_trusted_internal_caller(SimpleNamespace(
            state=SimpleNamespace(user=SimpleNamespace(system_role="internal"), auth_source="session"),
        )))
        self.assertFalse(_is_trusted_internal_caller(None))

    def test_confirmed_output_operations_reach_tools_with_their_exact_targets(self) -> None:
        operations = [
            {"kind": "prd", "operation": {"kind": "create"}},
            {"kind": "prototype", "operation": {"kind": "revise", "target": {
                "artifactId": "prototype-1", "artifactVersionId": "version-2",
                "screenIds": ["screen-b", "screen-a"],
            }}},
        ]
        scope = {
            "runId": "run-1", "runtimeAttemptId": "attempt-1",
            "requestedArtifactKinds": ["prd", "prototype"], "outputOperations": operations,
            "knowledgeEnabled": True, "canvasTools": None, "prototypePatchBaselines": [],
        }
        config = build_run_config("thread-1", None, None)
        merge_run_context_overrides(config, {
            "workbench": scope, "secrets": {"WORKBENCH_KNOWLEDGE_CAPABILITY": "test-capability"},
        }, allow_workbench_context=True)
        self.assertEqual(config["context"].get("workbench"), scope)
        _apply_workbench_lead_recursion_limit(config, trusted_internal_caller=True)
        self.assertEqual(config["recursion_limit"], _WORKBENCH_LINKED_LEAD_GRAPH_RECURSION_LIMIT)
        self.assertNotIn("workbench", config["configurable"])
        for invalid in ([], [operations[0]], [{"kind": "prd", "operation": {"kind": "revise"}}],
                        [operations[0], {"kind": "prototype", "operation": {"kind": "erase"}}]):
            with self.subTest(operations=invalid):
                config = build_run_config("thread-1", None, None)
                merge_run_context_overrides(
                    config, {"workbench": {**scope, "outputOperations": invalid}},
                    allow_workbench_context=True,
                )
                self.assertNotIn("workbench", config.get("context", {}))

    def test_exact_trusted_prd_scope_receives_the_named_recursion_budget(self) -> None:
        self.assertEqual(_DEFAULT_LEAD_GRAPH_RECURSION_LIMIT, 100)
        self.assertEqual(_WORKBENCH_PRD_LEAD_GRAPH_RECURSION_LIMIT, 560)
        trusted_internal_caller = _is_trusted_internal_caller(
            SimpleNamespace(
                state=SimpleNamespace(
                    user=SimpleNamespace(system_role="internal"),
                        auth_source="internal",
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

    def test_trusted_linked_scope_receives_a_bounded_budget_in_either_order(self) -> None:
        self.assertEqual(_WORKBENCH_LINKED_LEAD_GRAPH_RECURSION_LIMIT, 800)
        for kinds in (["prd", "prototype"], ["prototype", "prd"]):
            with self.subTest(kinds=kinds):
                config = build_run_config(
                    "thread-1",
                    {"recursion_limit": 999},
                    None,
                )
                merge_run_context_overrides(
                    config,
                    {
                        "recursion_limit": 999,
                        "workbench": {
                            "runId": "run-1",
                            "runtimeAttemptId": "attempt-1",
                            "requestedArtifactKinds": kinds,
                        },
                    },
                    allow_workbench_context=True,
                )
                _apply_workbench_lead_recursion_limit(config, trusted_internal_caller=True)
                self.assertEqual(config["recursion_limit"], 800)

    def test_exact_trusted_prototype_scope_receives_a_bounded_budget(self) -> None:
        self.assertEqual(_WORKBENCH_PROTOTYPE_LEAD_GRAPH_RECURSION_LIMIT, 480)
        for forged_limit in (1, 999):
            with self.subTest(forged_limit=forged_limit):
                config = build_run_config("thread-1", {
                    "recursion_limit": forged_limit,
                    "context": {"recursion_limit": forged_limit},
                }, None)
                merge_run_context_overrides(config, {
                    "recursion_limit": forged_limit,
                    "workbench": {
                        "runId": "run-1", "runtimeAttemptId": "attempt-1",
                        "requestedArtifactKinds": ["prototype"],
                    },
                }, allow_workbench_context=True)
                _apply_workbench_lead_recursion_limit(config, trusted_internal_caller=True)
                self.assertEqual(config["recursion_limit"], 480)

    def test_non_delivery_malformed_untrusted_and_forged_fields_keep_default_budget(self) -> None:
        exact_prd_scope = {
            "runId": "run-1",
            "runtimeAttemptId": "attempt-1",
            "requestedArtifactKinds": ["prd"],
        }
        cases = (
            ("document", True, {**exact_prd_scope, "requestedArtifactKinds": ["document"]}),
            ("prototype-mixed", True, {**exact_prd_scope, "requestedArtifactKinds": ["prototype", "document"]}),
            ("prototype-duplicate", True, {**exact_prd_scope, "requestedArtifactKinds": ["prototype", "prototype"]}),
            ("other-mixed", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "document"]}),
            ("linked-plus-extra", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "prototype", "document"]}),
            ("linked-duplicate", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "prototype", "prd"]}),
            ("unknown", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "unknown"]}),
            ("malformed", True, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "prd"]}),
            ("missing", True, {"runId": "run-1", "runtimeAttemptId": "attempt-1"}),
            ("untrusted", False, exact_prd_scope),
            ("untrusted-prototype", False, {**exact_prd_scope, "requestedArtifactKinds": ["prototype"]}),
            ("untrusted-linked", False, {**exact_prd_scope, "requestedArtifactKinds": ["prd", "prototype"]}),
        )
        for label, trusted_internal_caller, scope in cases:
            with self.subTest(label=label):
                config = build_run_config(
                    "thread-1",
                    {
                        "recursion_limit": 999,
                        "configurable": {"requestedArtifactKinds": ["prd", "prototype"]},
                        "context": {
                            "workbench": exact_prd_scope,
                            "recursion_limit": 999,
                        },
                    },
                    None,
                )
                merge_run_context_overrides(
                    config,
                    {
                        "recursion_limit": 999,
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

    def test_joint_budget_requires_a_literal_trusted_internal_identity(self) -> None:
        for trusted in (False, None, "true", 1):
            with self.subTest(trusted=trusted):
                config = {
                    "recursion_limit": 999,
                    "context": {
                        "workbench": {
                            "runId": "run-1",
                            "runtimeAttemptId": "attempt-1",
                            "requestedArtifactKinds": ["prd", "prototype"],
                        },
                    },
                }
                _apply_workbench_lead_recursion_limit(config, trusted_internal_caller=trusted)
                self.assertEqual(config["recursion_limit"], 100)
                config["context"]["workbench"]["requestedArtifactKinds"] = ["prototype"]
                _apply_workbench_lead_recursion_limit(config, trusted_internal_caller=trusted)
                self.assertEqual(config["recursion_limit"], 100)

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


class WorkbenchPrototypeGraphBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_lead_graph_completes_minimal_prototype_only_with_delivery_budget(self) -> None:
        """Use the production middleware chain and real tools, without a network model.

        Four mandatory phases, a validated draft, final submission, and the final
        assistant turn already exceed 100 graph steps. Middleware execution is
        deliberately not stubbed or padded with synthetic graph nodes.
        """
        await self._exercise_prototype_graph(edited=False)

    async def test_real_edit_graph_recovers_from_early_and_same_batch_publication_without_side_effects(self) -> None:
        await self._exercise_prototype_graph(edited=True)

    async def _exercise_prototype_graph(self, *, edited: bool) -> None:
        import json
        from pathlib import Path
        from langchain.agents import create_agent
        from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
        from langchain_core.messages import AIMessage, HumanMessage
        from langgraph.errors import GraphRecursionError
        from deerflow.config.app_config import AppConfig, pop_current_app_config, push_current_app_config
        from deerflow.agents.lead_agent.agent import build_middlewares
        from deerflow.agents.thread_state import get_thread_state_schema, normalize_middleware_state_schemas
        from deerflow_workbench_tools.artifact_draft_tool import workbench_artifact_draft_publish
        from deerflow_workbench_tools.generation_stage_tool import workbench_generation_stage_update
        from deerflow_workbench_tools.runtime_result_tool import workbench_runtime_result_submit
        from deerflow_workbench_tools.prototype_patch_tool import workbench_prototype_patch_publish
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_artifact_draft

        class ScriptedModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, *, tool_choice=None, **kwargs):
                return self

        # Disable optional external memory/summarization; all ordinary lead
        # middleware and real Workbench stage/publication guards remain active.
        app_config = AppConfig(
            sandbox={"use": "deerflow.sandbox.local:LocalSandboxProvider"},
            memory={"enabled": False}, summarization={"enabled": False},
        )
        push_current_app_config(app_config)
        try:
            draft = json.loads(Path(
                "/app/skills/public/workbench/references/prototype-runtime-result.example.json",
            ).read_text())["artifacts"][0]
            if edited:
                draft["operation"] = {"kind": "revise", "target": {
                    "artifactId": "artifact-fixed", "artifactVersionId": "version-fixed", "screenIds": [],
                }}
            validation = validate_runtime_artifact_draft(draft)
            self.assertTrue(validation["ok"])
            stages = ["design-system", "mapping-components", "creating-flows", "generating-ui"]
            calls = [("workbench_generation_stage_update", {"stage": stage}) for stage in stages]
            calls.extend([
                ("workbench_artifact_draft_publish", {"artifact_index": 0, "draft": draft}),
                ("workbench_runtime_result_submit", {"candidate": {
                    "protocol": "workbench.runtime.result.v1", "message": "Prototype complete.",
                    "artifacts": [{"draftReference": {
                        "artifactIndex": 0, "draftChecksum": validation["candidateChecksum"],
                    }}],
                }}),
            ])
            for old_budget in ((False,) if edited else (True, False)):
                with self.subTest(old_budget=old_budget):
                    scope = {"runId": "run-budget", "runtimeAttemptId": "attempt-budget",
                             "requestedArtifactKinds": ["prototype"]}
                    config = build_run_config("prototype-budget", {
                        "recursion_limit": 999,
                        "configurable": {"is_plan_mode": True, "subagent_enabled": True},
                    }, None)
                    merge_run_context_overrides(config, {"workbench": scope}, allow_workbench_context=True)
                    _apply_workbench_lead_recursion_limit(config, trusted_internal_caller=True)
                    if old_budget:
                        config["recursion_limit"] = _DEFAULT_LEAD_GRAPH_RECURSION_LIMIT
                    middleware = build_middlewares(
                        config, None, app_config=app_config, memory_enabled=False, available_skills=set(),
                    )
                    responses = [AIMessage(content="", tool_calls=[{"name": name, "id": f"call-{index}", "args": args}])
                                 for index, (name, args) in enumerate(calls)]
                    rejected_ids = set()
                    if edited:
                        screen = draft["content"]["screens"][0]
                        patch = {"artifact_index": 0, "screen_id": screen["id"], "base_revision": 0,
                                 "next_revision": 1, "operations": [{"kind": "update_screen", "screenId": screen["id"], "screen": screen}],
                                 "resulting_checksum": "a" * 64}
                        publication_calls = [*calls[-2:], ("workbench_prototype_patch_publish", patch)]
                        early = [{"name": name, "id": f"early-{index}", "args": args}
                                 for index, (name, args) in enumerate(publication_calls)]
                        siblings = [{**call, "id": call["id"].replace("early-", "sibling-")} for call in early]
                        rejected_ids = {call["id"] for call in [*early, *siblings]}
                        # ToolNode executes sibling calls from one state snapshot;
                        # the fourth stage's pending ACK cannot authorize them.
                        responses[3] = AIMessage(content="", tool_calls=[*responses[3].tool_calls, *siblings])
                        responses.insert(4, AIMessage(content="", tool_calls=[{
                            "name": "workbench_prototype_patch_publish", "id": "missing-checkpoint", "args": patch,
                        }]))
                        rejected_ids.add("missing-checkpoint")
                        responses.insert(0, AIMessage(content="", tool_calls=early))
                    responses.append(AIMessage(content="Prototype complete."))
                    model = ScriptedModel(responses=responses)
                    graph = create_agent(
                        model, tools=[workbench_generation_stage_update, workbench_artifact_draft_publish,
                                      workbench_runtime_result_submit, workbench_prototype_patch_publish],
                        middleware=normalize_middleware_state_schemas(middleware, "standard"),
                        state_schema=get_thread_state_schema("standard"),
                    )
                    steps, nodes, final, recursion_error, custom = [], [], None, None, []
                    try:
                        async for mode, event in graph.astream(
                            {"messages": [HumanMessage(content="Build the fixed prototype.")], "title": "Budget fixture"},
                            config=config, context={"workbench": scope}, stream_mode=["debug", "values", "custom"],
                        ):
                            if mode == "debug" and event.get("type") == "task":
                                steps.append(event["step"])
                                nodes.append(event["payload"]["name"])
                            elif mode == "values":
                                final = event
                            elif mode == "custom":
                                custom.append(event)
                    except GraphRecursionError as error:
                        recursion_error = error
                    if old_budget:
                        self.assertIsNotNone(recursion_error)
                        self.assertEqual(max(steps), 100)
                        continue
                    self.assertIsNone(recursion_error)
                    self.assertGreater(max(steps), 100)
                    self.assertLessEqual(max(steps), 200)
                    self.assertIn("WorkbenchToolScopeMiddleware.after_model", nodes)
                    self.assertIn("LoopDetectionMiddleware.after_model", nodes)
                    receipts = [message for message in final["messages"] if message.type == "tool"]
                    rejected = [message for message in receipts if message.tool_call_id in rejected_ids]
                    self.assertEqual({message.tool_call_id for message in rejected}, rejected_ids)
                    for message in rejected:
                        self.assertEqual(message.status, "error")
                        self.assertIsNone(message.artifact)
                        self.assertIn("WORKBENCH_PROTOTYPE_PATCH_CHECKPOINT_REQUIRED"
                                      if message.tool_call_id == "missing-checkpoint"
                                      else "WORKBENCH_PROTOTYPE_STAGES_REQUIRED", message.content)
                    workbench_events = [event for event in custom if isinstance(event, dict)
                                        and str(event.get("protocol", "")).startswith("workbench.runtime.")]
                    self.assertTrue(all(event.get("toolCallId") not in rejected_ids for event in workbench_events))
                    self.assertEqual([event["stage"] for event in workbench_events
                                      if event.get("protocol") == "workbench.runtime.generation-stage.v1"], stages)
                    receipts = [message for message in receipts if message.tool_call_id not in rejected_ids]
                    self.assertEqual([message.name for message in receipts], [name for name, _args in calls])
                    self.assertTrue(all(message.status == "success" for message in receipts))
                    self.assertEqual([message.artifact["stage"] for message in receipts[:4]], stages)
                    self.assertTrue(receipts[-2].artifact["ok"])
                    self.assertTrue(receipts[-1].artifact["ok"])
                    self.assertEqual(receipts[-1].artifact["result"]["artifacts"], [draft])
                    self.assertEqual(final["messages"][-1].content, "Prototype complete.")
                    print(json.dumps({"prototypeGraphSteps": max(steps), "tools": len(receipts),
                                      "rejectedBeforeExecution": len(rejected), "edited": edited,
                                      "budget": config["recursion_limit"], "networkModelCalls": 0}))
        finally:
            pop_current_app_config()


class WorkbenchFlashWireTests(unittest.TestCase):
    def test_flash_profile_tracks_non_thinking_mode_on_continuing_tool_turn(self):
        import httpx
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        from deerflow.config.app_config import AppConfig
        from deerflow.config.model_config import ModelConfig
        from deerflow.models.factory import create_chat_model

        received = []

        def reply(request):
            received.append(json.loads(request.content))
            return httpx.Response(200, json={
                "id": "fixture-completion",
                "created": 1,
                "model": "deepseek-flash",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "fixture response"},
                }],
            })

        messages = [
            HumanMessage(content="Verify the local fixture"),
            AIMessage(content="", tool_calls=[{
                "id": "fixture-tool-call", "name": "read_fixture", "args": {},
            }]),
            ToolMessage(content="fixture contents", tool_call_id="fixture-tool-call"),
        ]
        for profile in ("deepseek-flash", "other-flash-profile"):
            with self.subTest(profile=profile), httpx.Client(transport=httpx.MockTransport(reply)) as client:
                model_config = ModelConfig(
                    name=profile,
                    use="langchain_openai:ChatOpenAI",
                    model="deepseek-flash",
                    api_key="fixture-only-key",
                    base_url="https://provider.fixture.test/v1",
                    supports_thinking=False,
                    extra_body={"parallel_tool_calls": False},
                )
                model = create_chat_model(
                    profile,
                    app_config=AppConfig(
                        models=[model_config],
                        sandbox={"use": "deerflow.sandbox.local:LocalSandboxProvider"},
                    ),
                    attach_tracing=False,
                    http_client=client,
                )
                bound = model.bind_tools([{
                    "name": "read_fixture", "description": "Read the local fixture",
                    "parameters": {"type": "object", "properties": {}},
                }])
                self.assertEqual(bound.invoke(messages).content, "fixture response")
                body = received[-1]
                self.assertEqual(body["model"], "deepseek-flash")
                self.assertFalse(body["parallel_tool_calls"])
                self.assertEqual(body["messages"][-1]["tool_call_id"], "fixture-tool-call")
                if profile == "deepseek-flash":
                    self.assertEqual(body["thinking"], {"type": "disabled"})
                else:
                    self.assertNotIn("thinking", body)


if __name__ == "__main__":
    unittest.main()
