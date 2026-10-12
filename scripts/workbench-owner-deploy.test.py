#!/usr/bin/env python3

import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("owner_deploy", ROOT / "deploy/workbench-owner-deploy.py")
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)
IMAGES = [dict(item, composeService=item["composeService"], imageRef=f"registry.test/{item['id']}@sha256:{'a' * 64}")
          for item in json.loads((ROOT / "deploy/production-image-inventory.json").read_text())["candidateImages"]]
HAS_COMPOSE = bool(shutil.which("docker")) and subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def fixture(runtime=False):
    names = [image["composeService"] for image in IMAGES if (image["id"] == "deerflow") == runtime]
    if not runtime:
        names += ["postgres", "object-storage", *DEPLOY.GATEWAYS]
    return {"name": "workbench-runtime" if runtime else "workbench", "services": {
        name: {"image": f"old/{name}:current", "build": {"context": "/source"}, "environment": {"PASSWORD": "private-value"},
               "healthcheck": {"test": ["CMD", "true"]},
               "volumes": [{"type": "volume", "source": "persistent-data", "target": "/data"}], "networks": {"private": {}}}
        for name in names}, "volumes": {"persistent-data": {"external": True}}, "networks": {"private": {"external": True}}}


class FakeDeployment(DEPLOY.Deployment):
    def __init__(self, args, fail_step=None):
        super().__init__(args)
        self.calls = []
        self.fail_step = fail_step

    def check_resources(self, after_pull=False):
        self.calls.append(("resources", []))

    def verify(self, inspect_local=False):
        self.calls.append(("verify-local" if inspect_local else "verify", []))
        if self.fail_step == "signature":
            raise RuntimeError("signature rejected")
        return {"images": IMAGES}

    def resolve(self, filename):
        return fixture(runtime=filename == self.args.runtime_compose)

    def running(self, project):
        names = ["deerflow"] if project == "workbench-runtime" else ["postgres", "workbench-api", "gateway"]
        return {name: {"containerId": f"container-{name}", "imageId": f"sha256:{'b' * 64}"} for name in names}

    def run(self, command, label, **kwargs):
        self.calls.append((label, command))
        if self.fail_step and self.fail_step == label:
            raise RuntimeError("controlled rollout failure")
        return b""

    def database_backup(self, postgres):
        self.calls.append(("backup", [postgres]))
        if self.fail_step == "backup":
            raise RuntimeError("archive rejected")

    def health(self, filename, project, service):
        self.calls.append(("health", [service]))


class OwnerDeployTests(unittest.TestCase):
    def args(self, root, execute=False):
        return SimpleNamespace(source_root=ROOT, release_dir=root / "release", app_compose=root / "app.yml",
                               runtime_compose=root / "runtime.yml", env_file=root / "private.env", backup_root=root / "backups",
                               commit="c" * 40, execute=execute, health_timeout=10, min_free_gib=20, min_remaining_gib=6, min_available_mib=1536)

    def invoke(self, deployment):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            deployment.execute()

    def test_materialization_pins_images_bounds_resources_and_preserves_data_topology(self):
        original = fixture()
        snapshot = copy.deepcopy(original)
        prepared = DEPLOY.prepare_config(original, IMAGES)
        self.assertEqual(original, snapshot)
        self.assertEqual(prepared["networks"], original["networks"])
        self.assertEqual(prepared["volumes"], original["volumes"])
        for name, service in prepared["services"].items():
            self.assertNotIn("build", service)
            self.assertEqual(service["volumes"], original["services"][name]["volumes"])
            self.assertEqual(service["environment"], original["services"][name]["environment"])
            if name in DEPLOY.LIMITS:
                self.assertEqual(service["pull_policy"], "never")
                self.assertGreater(service["mem_limit"], 0)
                self.assertGreater(service["cpus"], 0)
                self.assertGreater(service["pids_limit"], 0)
        self.assertEqual(prepared["services"]["postgres"]["image"], original["services"]["postgres"]["image"])
        self.assertNotIn("mem_limit", prepared["services"]["postgres"])
        invalid = copy.deepcopy(IMAGES)
        invalid[0]["imageRef"] = "registry.test/api:latest"
        with self.assertRaisesRegex(RuntimeError, "immutable"):
            DEPLOY.prepare_config(original, invalid)
        del original["services"]["workbench-web"]["healthcheck"]
        with self.assertRaisesRegex(RuntimeError, "explicit healthcheck"):
            DEPLOY.prepare_config(original, IMAGES)

    def test_dollar_escaping_preserves_structure_and_literal_values(self):
        value = {"environment": {"PASSWORD": "secret$x:${x}:$$"}, "command": ["sh", "-c", "echo $USER"], "cpus": 1}
        self.assertEqual(DEPLOY.escape_compose_values(value), {"environment": {"PASSWORD": "secret$$x:$${x}:$$$$"}, "command": ["sh", "-c", "echo $$USER"], "cpus": 1})
        self.assertEqual(value["environment"]["PASSWORD"], "secret$x:${x}:$$")

    @unittest.skipUnless(HAS_COMPOSE, "Docker Compose client is required for interpolation verification")
    def test_resolved_compose_dollars_survive_a_real_second_compose_parse(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "compose.json"
            value = "literal$PASSWORD:${MISSING_VALUE}:$$:$2b$12$bcrypt"
            health = 'echo "$POSTGRES_USER"'
            literal = {"name": "interpolation-test", "services": {"app": {
                "image": "alpine:3", "environment": {"PASSWORD": value}, "healthcheck": {"test": ["CMD-SHELL", health]}}}}
            DEPLOY.write_compose(output, DEPLOY.escape_compose_values(literal))
            result = subprocess.run(["docker", "compose", "--env-file", "/dev/null", "--file", str(output), "config", "--format", "json"], capture_output=True)
            self.assertEqual(result.returncode, 0, "Compose could not parse the private test configuration")
            parsed = json.loads(result.stdout)
            # Compose's public model is already escaped for another Compose load.
            self.assertEqual(parsed["services"]["app"]["environment"]["PASSWORD"], value.replace("$", "$$"))
            self.assertEqual(parsed["services"]["app"]["healthcheck"]["test"][1], health.replace("$", "$$"))
            second = Path(directory) / "second.json"
            DEPLOY.write_compose(second, parsed)
            repeated = subprocess.run(["docker", "compose", "--env-file", "/dev/null", "--file", str(second), "config", "--format", "json"], capture_output=True)
            self.assertEqual(repeated.returncode, 0)
            self.assertEqual(json.loads(repeated.stdout), parsed, "materialization must remain stable across repeated Compose loads")

    def test_compose_model_writer_never_double_escapes_resolved_literals(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"environment": {"PASSWORD": "literal$$x:$$$$"}, "healthcheck": {"test": ["CMD-SHELL", "echo $$USER"]}}
            output = Path(directory) / "resolved.json"
            DEPLOY.write_compose(output, config)
            self.assertEqual(json.loads(output.read_text()), config)

    def test_default_plan_verifies_without_pull_stop_backup_or_file_materialization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deployment = FakeDeployment(self.args(root))
            self.invoke(deployment)
            self.assertIn(("verify", []), deployment.calls)
            self.assertFalse((root / "backups").exists())
            self.assertEqual([call for call in deployment.calls if call[1]], [])

    def test_image_filesystem_capacity_is_checked_separately_from_backup_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker_root = root / "docker-images"
            docker_root.mkdir()
            deployment = DEPLOY.Deployment(self.args(root))
            def space(path):
                return SimpleNamespace(free=(5 if Path(path) == docker_root else 50) * 1024**3)
            with patch.object(deployment, "run", return_value=str(docker_root).encode()), \
                    patch.object(DEPLOY.shutil, "disk_usage", side_effect=space):
                for after_pull in (False, True):
                    with self.subTest(after_pull=after_pull), self.assertRaisesRegex(RuntimeError, "Docker image storage"):
                        deployment.check_resources(after_pull=after_pull)

    def test_signature_and_backup_failure_never_stop_live_services(self):
        for failure in ["signature", "backup"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                deployment = FakeDeployment(self.args(Path(directory), True), failure)
                with self.assertRaises(RuntimeError):
                    self.invoke(deployment)
                commands = [command for _, command in deployment.calls]
                self.assertFalse(any("stop" in command or "up" in command for command in commands))

    def test_all_ten_pulls_local_verification_and_backup_precede_first_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            deployment = FakeDeployment(self.args(Path(directory), True))
            self.invoke(deployment)
            names = [name for name, _ in deployment.calls]
            stop = names.index("Stop Runtime queue participants")
            pulls = [index for index, (_, command) in enumerate(deployment.calls) if command[:2] == ["docker", "pull"]]
            self.assertEqual(len(pulls), 10)
            self.assertLess(max(pulls), names.index("verify-local"))
            self.assertLess(names.index("verify-local"), names.index("backup"))
            self.assertLess(names.index("backup"), stop)
            self.assertLess(names.index("Start workbench-preview"), names.index("Start deerflow"))
            for _, command in deployment.calls:
                self.assertNotIn("down", command)
                self.assertNotIn("--remove-orphans", command)
                self.assertNotIn("build", command)
                if "up" in command:
                    self.assertIn("--no-build", command)
                    self.assertIn("--no-deps", command)
                    self.assertNotIn(command[-1], ["postgres", "object-storage"])
            self.assertEqual(deployment.backup.stat().st_mode & 0o777, 0o700)
            self.assertTrue(all(file.stat().st_mode & 0o777 == 0o600 for file in deployment.backup.iterdir()))

    def test_failed_migration_restores_original_image_ids_and_stops_new_services_without_database_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            deployment = FakeDeployment(self.args(Path(directory), True), "Apply additive migrations and reconcile Runtime queue")
            with self.assertRaises(RuntimeError):
                self.invoke(deployment)
            rollback = json.loads((deployment.backup / "rollback-app.json").read_text())
            self.assertEqual(rollback["services"]["workbench-api"]["image"], f"sha256:{'b' * 64}")
            self.assertEqual(rollback["services"]["workbench-api"]["pull_policy"], "never")
            self.assertEqual(rollback["services"]["postgres"]["image"], f"sha256:{'b' * 64}")
            commands = [command for _, command in deployment.calls]
            self.assertTrue(any("stop" in command and "workbench-web" in command for command in commands))
            self.assertTrue(any("up" in command and command[-1] == "workbench-api" for command in commands))
            self.assertFalse(any("pg_restore" in command for command in commands))
            self.assertFalse(any("up" in command and command[-1] == "postgres" for command in commands))


if __name__ == "__main__":
    unittest.main()
