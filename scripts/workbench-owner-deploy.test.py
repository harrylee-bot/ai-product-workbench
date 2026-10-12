#!/usr/bin/env python3

import contextlib
import copy
import importlib.util
import io
import json
import os
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
COMMIT = "c" * 40
IMAGES = [dict(item, composeService=item["composeService"], imageRef=f"registry.test/{item['id']}@sha256:{'a' * 64}")
          for item in json.loads((ROOT / "deploy/production-image-inventory.json").read_text())["candidateImages"]]
HAS_COMPOSE = bool(shutil.which("docker")) and subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def fixture(runtime=False):
    names = [image["composeService"] for image in IMAGES if (image["id"] == "deerflow") == runtime]
    if not runtime:
        names += ["postgres", "object-storage", *DEPLOY.GATEWAYS]
    result = {"name": "workbench-runtime" if runtime else "workbench", "services": {
        name: {"image": f"old/{name}:current", "build": {"context": "/source"}, "environment": {"PASSWORD": "private-value"},
               "healthcheck": {"test": ["CMD", "true"]},
               "volumes": [{"type": "volume", "source": "persistent-data", "target": "/data"}], "networks": {"private": {}}}
        for name in names}, "volumes": {"persistent-data": {"external": True}}, "networks": {"private": {"external": True}}}
    if not runtime:
        result["services"]["workbench-worker"]["environment"].update({
            "NODE_ENV": "production",
            "WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PATH": "/run/secrets/worker.key",
            "WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID": "sha256:" + "d" * 64,
            "WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID": "runtime-worker",
            "WORKBENCH_ENVIRONMENT_ID": "production",
            "WORKBENCH_SOURCE_COMMIT": "e" * 40,
            "WORKBENCH_RUNTIME_WORKER_IMAGE_REF": "old/worker@sha256:" + "e" * 64,
        })
    return result


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
        return {"status": "PASS", "sourceCommit": self.args.commit, "images": IMAGES}

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
        prepared = DEPLOY.prepare_config(original, IMAGES, COMMIT)
        self.assertEqual(original, snapshot)
        self.assertEqual(prepared["networks"], original["networks"])
        self.assertEqual(prepared["volumes"], original["volumes"])
        for name, service in prepared["services"].items():
            self.assertNotIn("build", service)
            self.assertEqual(service["volumes"], original["services"][name]["volumes"])
            if name != "workbench-worker":
                self.assertEqual(service["environment"], original["services"][name]["environment"])
            else:
                expected = dict(original["services"][name]["environment"], WORKBENCH_SOURCE_COMMIT=COMMIT,
                                WORKBENCH_RUNTIME_WORKER_IMAGE_REF=service["image"])
                self.assertEqual(service["environment"], expected)
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
            DEPLOY.prepare_config(original, invalid, COMMIT)
        del original["services"]["workbench-web"]["healthcheck"]
        with self.assertRaisesRegex(RuntimeError, "explicit healthcheck"):
            DEPLOY.prepare_config(original, IMAGES, COMMIT)

    def test_gateways_reuse_the_verified_quartz_image_with_writable_nonroot_tmpfs(self):
        original = fixture()
        original["services"]["gateway"].update({
            "user": "0:0", "entrypoint": ["nginx", "-g", "daemon off;"], "command": [],
            "ports": [{"target": 8080, "published": "4180", "host_ip": "127.0.0.1"}],
            "tmpfs": ["/var/cache/nginx:size=32m,uid=0,gid=0,mode=0755", "/var/run", "/tmp", "/extra:size=4m"],
        })
        original["services"]["preview-gateway"]["tmpfs"] = ["/tmp:uid=101,gid=101,mode=1770"]
        snapshot = copy.deepcopy(original)
        prepared = DEPLOY.prepare_config(original, IMAGES, COMMIT)
        quartz = next(image["imageRef"] for image in IMAGES if image["id"] == "quartz")
        self.assertEqual(original, snapshot)
        for name in DEPLOY.GATEWAYS:
            service = prepared["services"][name]
            self.assertEqual(service["image"], quartz)
            self.assertEqual(service["user"], "101:101")
            mounts = dict(entry.partition(":")[::2] for entry in service["tmpfs"])
            for destination in DEPLOY.NGINX_TMPFS:
                options = mounts[destination].split(",")
                self.assertTrue({"uid=101", "gid=101", "mode=1770"}.issubset(options))
                self.assertEqual(len([option for option in options if option.startswith("uid=")]), 1)
            for field in ("command", "entrypoint", "ports", "volumes", "networks"):
                self.assertEqual(service.get(field), original["services"][name].get(field))
        self.assertIn("/var/cache/nginx:size=32m,uid=101,gid=101,mode=1770", prepared["services"]["gateway"]["tmpfs"])
        self.assertIn("/extra:size=4m", prepared["services"]["gateway"]["tmpfs"])
        for images in ([image for image in IMAGES if image["id"] != "quartz"],
                       [*IMAGES, next(image for image in IMAGES if image["id"] == "quartz")]):
            with self.assertRaisesRegex(RuntimeError, "exactly one verified Quartz"):
                DEPLOY.prepare_config(original, images, COMMIT)

    def test_worker_identity_replaces_stale_commit_and_digest_without_changing_static_signer(self):
        original = fixture()
        prepared = DEPLOY.prepare_config(original, IMAGES, COMMIT)
        worker = prepared["services"]["workbench-worker"]
        self.assertEqual(worker["environment"]["WORKBENCH_SOURCE_COMMIT"], COMMIT)
        self.assertEqual(worker["environment"]["WORKBENCH_RUNTIME_WORKER_IMAGE_REF"], worker["image"])
        for name in DEPLOY.WORKER_SIGNING_ENV[:4]:
            self.assertEqual(worker["environment"][name], original["services"]["workbench-worker"]["environment"][name])
        for name in DEPLOY.WORKER_SIGNING_ENV[:4]:
            missing = fixture()
            del missing["services"]["workbench-worker"]["environment"][name]
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "signing configuration is missing"):
                DEPLOY.prepare_config(missing, IMAGES, COMMIT)
        for images in ([image for image in IMAGES if image["id"] != "runtime-worker"],
                       [*IMAGES, next(image for image in IMAGES if image["id"] == "runtime-worker")]):
            with self.assertRaisesRegex(RuntimeError, "exactly one verified Runtime worker"):
                DEPLOY.prepare_config(original, images, COMMIT)
        with self.assertRaisesRegex(RuntimeError, "Verified release source commit"):
            DEPLOY.prepare_config(original, IMAGES, "not-a-commit")

    def test_worker_signer_preflight_uses_actual_uid_and_mounts_without_network_or_unrelated_secrets(self):
        candidate = DEPLOY.prepare_config(fixture(), IMAGES, COMMIT)
        worker = candidate["services"]["workbench-worker"]
        worker.update({"user": "1000:1000", "depends_on": {"postgres": {}},
                       "ports": ["3005:3005"], "container_name": "live-worker"})
        worker["volumes"].append({"type": "bind", "source": "/private/worker.key", "target": "/run/secrets/worker.key"})
        snapshot = copy.deepcopy(candidate)
        checked = DEPLOY.worker_signer_preflight_config(candidate)
        self.assertEqual(candidate, snapshot)
        self.assertNotEqual(checked["name"], candidate["name"])
        self.assertEqual(set(checked["services"]), {"workbench-worker"})
        isolated = checked["services"]["workbench-worker"]
        self.assertEqual(isolated["image"], worker["image"])
        self.assertEqual(isolated["user"], worker["user"])
        self.assertEqual(isolated["network_mode"], "none")
        self.assertTrue(isolated["read_only"])
        self.assertEqual(set(isolated["environment"]), {*DEPLOY.WORKER_SIGNING_ENV, "NODE_ENV"})
        self.assertEqual(isolated["environment"]["NODE_ENV"], "production")
        self.assertEqual(isolated["volumes"], [dict(mount, read_only=True) for mount in worker["volumes"]])
        for name in ("ports", "networks", "depends_on", "container_name", "env_file"):
            self.assertNotIn(name, isolated)
        for name in ("mem_limit", "cpus", "pids_limit", "pull_policy"):
            self.assertEqual(isolated[name], worker[name])
        if HAS_COMPOSE:
            with tempfile.TemporaryDirectory() as directory:
                filename = Path(directory) / "signer-check.json"
                DEPLOY.write_compose(filename, checked)
                result = subprocess.run(["docker", "compose", "--env-file", "/dev/null", "--file", str(filename), "config", "--quiet"], capture_output=True)
                self.assertEqual(result.returncode, 0, "Isolated signer preflight must be valid Compose")

    @unittest.skipUnless(shutil.which("node") and (ROOT / "apps/workbench-worker/dist/runtime/runtime-worker-execution-attestation.js").exists(),
                         "Built worker and Node are required for the real signer preflight")
    def test_preflight_script_loads_real_key_and_refuses_wrong_key_id_or_exposed_key_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "worker.key"
            generation = """const { generateKeyPairSync, createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const pair = generateKeyPairSync('ed25519');
writeFileSync(process.argv[1], pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
process.stdout.write('sha256:' + createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));"""
            generated = subprocess.run(["node", "-e", generation, str(key)], capture_output=True, text=True, check=True)
            worker = DEPLOY.prepare_config(fixture(), IMAGES, COMMIT)["services"]["workbench-worker"]
            environment = {**os.environ, **worker["environment"],
                           "WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PATH": str(key),
                           "WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID": generated.stdout}
            script = DEPLOY.WORKER_SIGNER_CHECK.replace("/app/apps/workbench-worker/", str(ROOT / "apps/workbench-worker") + "/")
            def invoke(env):
                return subprocess.run(["node", "--input-type=module", "-e", script], env=env, capture_output=True, text=True)
            self.assertEqual(invoke(environment).returncode, 0)
            invalid = invoke(dict(environment, WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID="sha256:" + "0" * 64))
            self.assertEqual(invalid.returncode, 1)
            self.assertNotIn("PRIVATE KEY", invalid.stderr)
            key.chmod(0o644)
            self.assertEqual(invoke(environment).returncode, 1)

    def test_gateway_checks_resolve_missing_upstreams_without_network_or_candidate_dns_overrides(self):
        candidate = DEPLOY.prepare_config(fixture(), IMAGES, COMMIT)
        candidate["services"]["gateway"].update({"depends_on": {"workbench-web": {}}, "ports": ["127.0.0.1:4180:8080"]})
        snapshot = copy.deepcopy(candidate)
        checked = DEPLOY.gateway_preflight_config(candidate)
        self.assertEqual(candidate, snapshot)
        self.assertEqual(set(checked["services"]), set(DEPLOY.GATEWAYS))
        self.assertNotEqual(checked["name"], candidate["name"])
        for name, service in checked["services"].items():
            self.assertEqual(service["network_mode"], "none")
            self.assertEqual(set(service["extra_hosts"]), {f"{upstream}=127.0.0.1" for upstream in candidate["services"]})
            for field in ("ports", "networks", "depends_on"):
                self.assertNotIn(field, service)
            for field in ("image", "user", "tmpfs", "volumes"):
                self.assertEqual(service[field], candidate["services"][name][field])
            self.assertNotIn("extra_hosts", candidate["services"][name])
            self.assertNotIn("network_mode", candidate["services"][name])
        if HAS_COMPOSE:
            with tempfile.TemporaryDirectory() as directory:
                filename = Path(directory) / "gateway-check.json"
                DEPLOY.write_compose(filename, checked)
                result = subprocess.run(["docker", "compose", "--env-file", "/dev/null", "--file", str(filename), "config", "--quiet"], capture_output=True)
                self.assertEqual(result.returncode, 0, "Isolated gateway preflight must be valid Compose")

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

    def test_release_commit_mismatch_is_rejected_before_configuration_or_live_service_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            deployment = FakeDeployment(self.args(Path(directory), True))
            with patch.object(deployment, "verify", return_value={"status": "PASS", "sourceCommit": "d" * 40, "images": IMAGES}):
                with self.assertRaisesRegex(RuntimeError, "match the requested source commit"):
                    self.invoke(deployment)
            self.assertFalse(deployment.backup)
            self.assertFalse(any(command for _, command in deployment.calls))

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
        for failure in ["signature", "backup", "Check Runtime worker signing identity and key permissions", "Check preview-gateway configuration and permissions", "Check gateway configuration and permissions"]:
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
            for name in DEPLOY.GATEWAYS:
                check = names.index(f"Check {name} configuration and permissions")
                self.assertLess(names.index("verify-local"), check)
                self.assertLess(check, names.index("backup"))
            signer_check = names.index("Check Runtime worker signing identity and key permissions")
            self.assertLess(names.index("verify-local"), signer_check)
            self.assertLess(signer_check, names.index("backup"))
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
            candidate = json.loads((deployment.backup / "candidate-app.json").read_text())
            checked = json.loads((deployment.backup / "gateway-check.json").read_text())
            for name in DEPLOY.GATEWAYS:
                self.assertEqual(candidate["services"][name]["image"], candidate["services"]["knowledge"]["image"])
                self.assertNotIn("extra_hosts", candidate["services"][name])
                self.assertEqual(checked["services"][name]["network_mode"], "none")

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
