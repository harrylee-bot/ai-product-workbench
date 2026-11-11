"""Exercise upgraded packages against the real gateway and graph runtime."""

import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import httpx
from langgraph_sdk import get_client
from packaging.version import Version


class RuntimeCompatibility(unittest.TestCase):
    def test_fixed_dependency_versions(self):
        policy = json.loads(Path(__file__).with_name("dependencies.json").read_text())
        for constraint in policy["constraints"]:
            name, version = constraint.split("==")
            self.assertEqual(Version(importlib.metadata.version(name)), Version(version), name)

    def test_langgraph_checkpoint_and_message_round_trip(self):
        from langchain_core.messages import AIMessage, HumanMessage
        from langgraph.checkpoint.memory import InMemorySaver
        from langgraph.graph import END, START, MessagesState, StateGraph

        graph = StateGraph(MessagesState)
        graph.add_node("respond", lambda state: {"messages": [AIMessage(content="fixture response")]})
        graph.add_edge(START, "respond")
        graph.add_edge("respond", END)
        compiled = graph.compile(checkpointer=InMemorySaver())
        config = {"configurable": {"thread_id": "isolated-runtime-compatibility"}}
        result = compiled.invoke({"messages": [HumanMessage(content="fixture request")]}, config)
        self.assertEqual([message.content for message in result["messages"]],
                         ["fixture request", "fixture response"])
        self.assertEqual(compiled.get_state(config).values["messages"][-1].content, "fixture response")
        self.assertGreaterEqual(len(list(compiled.get_state_history(config))), 2)

    def test_node_protocol_validator_runs_under_the_runtime_identity(self):
        from deerflow_workbench_tools.runtime_result_validator import validate_runtime_result

        result = validate_runtime_result({})
        self.assertEqual(result["protocol"], "workbench.runtime.validation.v1")
        self.assertIs(result["ok"], False)
        self.assertTrue(result["issues"])

    def test_upgraded_sdk_against_real_authenticated_gateway(self):
        with tempfile.TemporaryDirectory(prefix="workbench-runtime-security-") as temporary:
            root = Path(temporary)
            config = root / "config.yaml"
            config.write_text(
                "config_version: 1\nmodels: []\ntools: []\ntool_groups: []\n"
                "database:\n  backend: sqlite\n  sqlite_dir: " + str(root / "database") + "\n"
                "sandbox:\n  use: deerflow.sandbox.local:LocalSandboxProvider\n  allow_host_bash: false\n"
                "memory:\n  token_counting: char\n"
            )
            token = secrets.token_urlsafe(32)
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            origin = "http://127.0.0.1:" + str(listener.getsockname()[1])
            environment = {**os.environ, "DEER_FLOW_CONFIG_PATH": str(config),
                           "DEER_FLOW_HOME": str(root / "home"),
                           "DEER_FLOW_PROJECT_ROOT": str(root),
                           "DEER_FLOW_INTERNAL_AUTH_TOKEN": token,
                           "DEER_FLOW_AUTH_DISABLED": "0", "DEER_FLOW_ENV": "production",
                           "ENVIRONMENT": "production"}
            with (root / "gateway.log").open("w+") as logs:
                process = subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "app.gateway.app:app", "--fd", str(listener.fileno()),
                     "--no-access-log", "--log-level", "warning"],
                    env=environment, pass_fds=(listener.fileno(),), stdout=logs, stderr=logs,
                )
                listener.close()
                try:
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            logs.seek(0)
                            self.fail("Gateway startup failed: " + logs.read()[-8000:].replace(token, "[redacted]"))
                        try:
                            response = httpx.get(origin + "/health", timeout=0.5, trust_env=False)
                            if response.status_code == 200:
                                break
                        except httpx.HTTPError:
                            pass
                        time.sleep(0.1)
                    else:
                        self.fail("Gateway health check timed out")
                    self.assertIn(httpx.post(origin + "/api/threads/search", json={}, trust_env=False).status_code, [401, 403])
                    try:
                        asyncio.run(self.exercise_sdk(origin, token))
                    except Exception:
                        logs.seek(0)
                        print("Gateway diagnostic: " + logs.read()[-8000:].replace(token, "[redacted]"))
                        raise
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)

    async def exercise_sdk(self, origin, token):
        csrf = secrets.token_urlsafe(64)
        client = get_client(url=origin + "/api", headers={"X-DeerFlow-Internal-Token": token,
                            "X-CSRF-Token": csrf, "Cookie": "csrf_token=" + csrf})
        thread = await client.threads.create(metadata={"purpose": "runtime-security"})
        thread_id = thread["thread_id"]
        try:
            self.assertEqual((await client.threads.get(thread_id))["thread_id"], thread_id)
            matches = await client.threads.search(metadata={"purpose": "runtime-security"}, limit=1, offset=0)
            self.assertEqual([item["thread_id"] for item in matches], [thread_id])
            self.assertIsInstance(await client.threads.get_history(thread_id, limit=2), list)
        finally:
            await client.threads.delete(thread_id)


if __name__ == "__main__":
    unittest.main()
