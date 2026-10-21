#!/usr/bin/env python3
"""Offline tests for the dedicated local runner guard."""
import importlib.util
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("local_runner", ROOT / "workbench-local-runner.py")
local_runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_runner)


def proxy_environment():
    return ['http_proxy=' + local_runner.LOCAL_BUILD_PROXY, 'https_proxy=' + local_runner.LOCAL_BUILD_PROXY,
            'no_proxy=' + local_runner.BUILDER_NO_PROXY]


def marker(machine="a" * 64):
    return {"schemaVersion": "workbench.local-runner.v1", "repository": local_runner.REPOSITORY,
            "runnerName": local_runner.RUNNER_NAME, "hostname": local_runner.HOSTNAME,
            "machineIdSha256": machine}


def observed(machine="a" * 64):
    return {"system": "Linux", "architecture": "aarch64", "hostname": local_runner.HOSTNAME,
            "machineIdSha256": machine, "apitable": False}


def environment(event_name="push", ref="refs/heads/main"):
    return {"RUNNER_NAME": local_runner.RUNNER_NAME, "RUNNER_ENVIRONMENT": "self-hosted",
            "RUNNER_OS": "Linux", "RUNNER_ARCH": "ARM64", "GITHUB_REPOSITORY": local_runner.REPOSITORY,
            "GITHUB_EVENT_NAME": event_name, "GITHUB_REF": ref}


class IdentityPolicyTests(unittest.TestCase):
    def test_main_push_and_same_repo_main_pr_are_accepted(self):
        local_runner.validate_identity(marker(), observed(), environment(), {})
        event = {"pull_request": {"head": {"repo": {"full_name": local_runner.REPOSITORY}},
                                   "base": {"repo": {"full_name": local_runner.REPOSITORY}, "ref": "main"}}}
        local_runner.validate_identity(marker(), observed(), environment("pull_request"), event)

    def test_production_and_untrusted_refs_are_rejected(self):
        for altered in ({"hostname": "C202607221115992"}, {"apitable": True}):
            with self.assertRaisesRegex(RuntimeError, "PRODUCTION_HOST_FORBIDDEN"):
                local_runner.validate_identity(marker(), {**observed(), **altered}, environment(), {})
        foreign = {"pull_request": {"head": {"repo": {"full_name": "attacker/fork"}},
                                     "base": {"repo": {"full_name": local_runner.REPOSITORY}, "ref": "main"}}}
        with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_PULL_REQUEST_FORBIDDEN"):
            local_runner.validate_identity(marker(), observed(), environment("pull_request"), foreign)
        with self.assertRaisesRegex(RuntimeError, "UNTRUSTED_REF_FORBIDDEN"):
            local_runner.validate_identity(marker(), observed(), environment("push", "refs/heads/feature"), {})

    def test_marker_and_runner_registration_are_exact(self):
        with self.assertRaisesRegex(RuntimeError, "LOCAL_RUNNER_IDENTITY_INVALID"):
            local_runner.validate_identity({**marker(), "runnerName": "other"}, observed(), environment(), {})
        with self.assertRaisesRegex(RuntimeError, "LOCAL_RUNNER_IDENTITY_INVALID"):
            local_runner.validate_identity(marker("b" * 64), observed(), environment(), {})
        with self.assertRaisesRegex(RuntimeError, "LOCAL_RUNNER_REGISTRATION_INVALID"):
            local_runner.validate_identity(marker(), observed(), {**environment(), "RUNNER_ARCH": "X64"}, {})

    def test_untrusted_marker_is_rejected_before_any_docker_operation(self):
        for mode, uid in [(stat.S_IFREG | 0o644, 1000), (stat.S_IFREG | 0o666, 0), (stat.S_IFLNK | 0o777, 0)]:
            identity = Mock()
            identity.lstat.return_value = SimpleNamespace(st_mode=mode, st_uid=uid)
            with self.subTest(mode=mode, uid=uid), patch.object(local_runner, 'IDENTITY', identity), \
                 patch.object(local_runner, 'command') as docker:
                with self.assertRaisesRegex(RuntimeError, 'ROOT_OWNED_RUNNER_IDENTITY_REQUIRED'):
                    local_runner.preflight()
                docker.assert_not_called()

    def test_pull_request_base_and_event_identity_cannot_bypass_trust_policy(self):
        event = {'pull_request': {'head': {'repo': {'full_name': local_runner.REPOSITORY}},
                                 'base': {'repo': {'full_name': local_runner.REPOSITORY}, 'ref': 'main'}}}
        for base in [{'repo': {'full_name': 'someone/else'}, 'ref': 'main'},
                     {'repo': {'full_name': local_runner.REPOSITORY}, 'ref': 'feature'}]:
            with self.assertRaisesRegex(RuntimeError, 'UNTRUSTED_PULL_REQUEST_FORBIDDEN'):
                local_runner.validate_identity(marker(), observed(), environment('pull_request'),
                                                {'pull_request': {**event['pull_request'], 'base': base}})
        for event_name, ref in [('pull_request_target', 'refs/heads/main'), ('workflow_dispatch', 'refs/heads/feature')]:
            with self.assertRaisesRegex(RuntimeError, 'UNTRUSTED_REF_FORBIDDEN'):
                local_runner.validate_identity(marker(), observed(), environment(event_name, ref), event)

    def test_docker_identity_and_resource_limits_are_exact(self):
        info = {"Name": local_runner.HOSTNAME, "OSType": "linux", "Architecture": "aarch64",
                "MemoryLimit": True, "SwapLimit": True, "CpuCfsPeriod": True, "CpuCfsQuota": True}
        local_runner.validate_docker(info, "unix:///var/run/docker.sock", [{"Config": {"Labels": {}}}])
        with self.assertRaisesRegex(RuntimeError, "REMOTE_DOCKER_FORBIDDEN"):
            local_runner.validate_docker(info, "tcp://remote:2375", [])
        with self.assertRaisesRegex(RuntimeError, "DOCKER_RESOURCE_LIMITS_REQUIRED"):
            local_runner.validate_docker({**info, "CpuCfsQuota": False}, "unix:///var/run/docker.sock", [])
        with self.assertRaisesRegex(RuntimeError, "PRODUCTION_CONTAINER_FORBIDDEN"):
            local_runner.validate_docker(info, "unix:///var/run/docker.sock",
                                         [{"Config": {"Labels": {"com.docker.compose.project": "workbench"}}}])


class JobAndBuilderTests(unittest.TestCase):
    def setUp(self):
        self.environment = {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": "quality",
                            "WORKBENCH_IMAGE_ID": "web"}

    def test_job_scope_hash_rejects_unsafe_values(self):
        result = local_runner.job_identity(self.environment)
        self.assertRegex(result["builder"], r"^workbench-job-[0-9a-f]{24}$")
        with self.assertRaisesRegex(RuntimeError, "LOCAL_JOB_IDENTITY_INVALID"):
            local_runner.job_identity({**self.environment, "GITHUB_JOB": "quality/../../prod"})
        with self.assertRaisesRegex(RuntimeError, "LOCAL_JOB_IDENTITY_INVALID"):
            local_runner.job_identity({**self.environment, "GITHUB_RUN_ID": "0"})

    def test_prepare_uses_only_local_proxy_in_private_job_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            env = {**self.environment, 'RUNNER_TEMP': str(root), 'GITHUB_ENV': str(root / 'github-env'),
                   'HTTP_PROXY': 'http://foreign.invalid:9999'}
            with patch.dict(os.environ, env, clear=True), patch.object(local_runner, 'preflight'):
                local_runner.prepare()
            job = local_runner.job_identity(env)
            config = root / job['builder'] / 'docker' / 'config.json'
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
            self.assertEqual(json.loads(config.read_text()), {'proxies': {'default': {
                'httpProxy': 'http://192.168.5.2:7892', 'httpsProxy': 'http://192.168.5.2:7892',
                'noProxy': 'localhost,127.0.0.1,::1'}}})
            self.assertIn('WORKBENCH_BUILD_PROXY=http://192.168.5.2:7892\n', (root / 'github-env').read_text())

    def test_builder_caps_endpoint_flags_and_parallelism(self):
        identity = local_runner.job_identity(self.environment)
        node = {"Name": identity["builder"] + "0", "Endpoint": "unix:///var/run/docker.sock"}
        builder = {"Name": identity["builder"], "Driver": "docker-container", "Nodes": [node]}
        host = {"Memory": local_runner.MEMORY_BYTES, "MemorySwap": local_runner.MEMORY_BYTES,
                "CpuPeriod": 100000, "CpuQuota": 200000, "NetworkMode": "bridge"}
        container = {"Name": "/buildx_buildkit_" + node["Name"], "State": {"Running": True},
                     "HostConfig": host, "Config": {"Env": proxy_environment(), "Cmd": ["--config", "/etc/buildkit/buildkitd.toml", "--oci-worker-net=bridge"]}}
        local_runner.validate_builder(builder, container, identity)
        local_runner.validate_builder(builder, {**container, 'Config': {'Env': proxy_environment(), 'Cmd': container['Config']['Cmd']
            + ['--allow-insecure-entitlement=network.host']}}, identity)
        with self.assertRaisesRegex(RuntimeError, 'BUILDER_LIMITS_INVALID'):
            local_runner.validate_builder(builder, {**container, 'HostConfig': {**host, 'NetworkMode': 'host'}}, identity)
        with self.assertRaisesRegex(RuntimeError, "BUILDER_LIMITS_INVALID"):
            local_runner.validate_builder(builder, {**container, "HostConfig": {**host, "CpuQuota": 1}}, identity)
        with self.assertRaisesRegex(RuntimeError, "BUILDER_FLAGS_INVALID"):
            local_runner.validate_builder(builder, {**container, "Config": {"Cmd": ["--allow-insecure-entitlement", "network.host"]}}, identity)
        for entries in [[], proxy_environment() + ['HTTP_PROXY=http://foreign.invalid'],
                        proxy_environment() + ['http_proxy=http://foreign.invalid']]:
            with self.assertRaisesRegex(RuntimeError, 'BUILDER_PROXY_INVALID'):
                local_runner.validate_builder(builder, {**container, 'Config': {**container['Config'], 'Env': entries}}, identity)
        local_runner.validate_builder(builder, {**container, "State": {"Running": False}}, identity, require_running=False)
        with self.assertRaisesRegex(RuntimeError, "BUILDER_LIMITS_INVALID"):
            local_runner.validate_builder(builder, {**container, "State": {"Running": False}}, identity, require_running=True)


class CleanupScopeTests(unittest.TestCase):
    def test_cleanup_refuses_symlinked_docker_directory_and_temp_ancestor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            runner = root / 'runner'
            runner.mkdir()
            env = {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_JOB': 'images',
                   'WORKBENCH_IMAGE_ID': 'web', 'RUNNER_TEMP': str(runner)}
            job = local_runner.job_identity(env)
            path = runner / job['builder']
            path.mkdir()
            (path / 'identity.json').write_text(json.dumps(job))
            external = root / 'external'
            external.mkdir()
            sentinel = external / 'config.json'
            sentinel.write_text('external sentinel, must survive')
            (path / 'docker').symlink_to(external, target_is_directory=True)
            env.update({'DOCKER_CONFIG': str(path / 'docker'), 'WORKBENCH_JOB_BUILDER': job['builder']})
            with patch.dict(os.environ, env, clear=True), patch.object(local_runner, 'preflight'), \
                 patch.object(local_runner, 'command') as docker:
                with self.assertRaisesRegex(RuntimeError, 'LOCAL_JOB_DOCKER_DIRECTORY_INVALID'):
                    local_runner.cleanup()
                docker.assert_not_called()
            self.assertEqual(sentinel.read_text(), 'external sentinel, must survive')
            alias = root / 'alias'
            alias.symlink_to(runner, target_is_directory=True)
            nested = runner / 'nested'
            nested.mkdir()
            with patch.dict(os.environ, {**env, 'RUNNER_TEMP': str(alias / 'nested')}, clear=True):
                with self.assertRaisesRegex(RuntimeError, 'LOCAL_JOB_TEMP_INVALID'):
                    local_runner.job_directory()

    def test_cleanup_removes_only_current_job_image_and_builder(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = str(Path(temp).resolve())
            env = {"GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "pr-production-images",
                   "WORKBENCH_IMAGE_ID": "web", "RUNNER_TEMP": temp, "WORKBENCH_JOB_BUILDER": "",
                   "DOCKER_CONFIG": "", "GITHUB_SHA": "a" * 40}
            job = local_runner.job_identity(env)
            env["WORKBENCH_JOB_BUILDER"] = job["builder"]
            env["DOCKER_CONFIG"] = str(Path(temp) / job["builder"] / "docker")
            path = Path(temp) / job["builder"]
            (path / "docker").mkdir(parents=True)
            (path / "identity.json").write_text(json.dumps(job))
            calls = []
            def fake_command(args, **kwargs):
                calls.append(args)
                if args[:3] == ["docker", "image", "inspect"]:
                    labels = {"io.workbench.job": job["builder"], "org.opencontainers.image.revision": env["GITHUB_SHA"]}
                    return type("Result", (), {"returncode": 0, "stdout": json.dumps([{"Config": {"Labels": labels}}])})()
                if args[:3] == ["docker", "buildx", "ls"]:
                    return SimpleNamespace(returncode=0, stdout="")
                return type("Result", (), {"returncode": 0, "stdout": ""})()
            with patch.dict(os.environ, env, clear=True), patch.object(local_runner, "preflight", return_value={}), \
                 patch.object(local_runner, "command", side_effect=fake_command):
                local_runner.cleanup()
            self.assertFalse(path.exists())
            self.assertIn(["docker", "image", "rm", "workbench-local-pr:" + job["builder"]], calls)
            self.assertNotIn(["docker", "system", "prune", "--all", "--force"], calls)


class BuilderInspectionTests(unittest.TestCase):
    def setUp(self):
        self.job = local_runner.job_identity({"GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1",
                                              "GITHUB_JOB": "images", "WORKBENCH_IMAGE_ID": "web"})
        node = {"Name": self.job['builder'] + '0', "Endpoint": 'unix:///var/run/docker.sock',
                "Files": {"buildkitd.toml": "W3JlZ2lzdHJ5XQpbcmVnaXN0cnkuJ2RvY2tlci5pbyddCm1pcnJvcnMgPSBbJ2RvY2tlci5tLmRhb2Nsb3VkLmlvJ10KW3dvcmtlcl0KW3dvcmtlci5vY2ldCm1heC1wYXJhbGxlbGlzbSA9IDEK"}}
        self.builder = {"Name": self.job['builder'], "Driver": "docker-container", "Nodes": [node]}
        self.container = {"Name": "/buildx_buildkit_" + node['Name'], "State": {"Running": True},
                          "HostConfig": {"Memory": local_runner.MEMORY_BYTES, "MemorySwap": local_runner.MEMORY_BYTES,
                                         "CpuPeriod": 100000, "CpuQuota": 200000, "NetworkMode": "bridge"},
                          "Config": {"Env": proxy_environment(), "Cmd": ['--oci-worker-net=bridge', '--config', '/etc/buildkit/buildkitd.toml']}}

    def invoke(self, fake, **kwargs):
        with patch.object(local_runner, 'preflight'), patch.object(local_runner, 'owned_job', return_value=(self.job, Path('/tmp/unused'))), \
             patch.object(local_runner, 'command', side_effect=fake):
            return local_runner.verify_builder(**kwargs)

    def test_duplicate_builder_node_rows_are_accepted_only_if_identical(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[:3] == ['docker', 'buildx', 'ls']:
                return SimpleNamespace(returncode=0, stdout=json.dumps(self.builder) + '\n' + json.dumps(self.builder))
            if args[:2] == ['docker', 'inspect']:
                return SimpleNamespace(returncode=0, stdout=json.dumps([self.container]))
            return SimpleNamespace(returncode=0, stdout='[registry]\n[registry.\'docker.io\']\nmirrors = [\'docker.m.daocloud.io\']\n[worker]\n[worker.oci]\nmax-parallelism = 1\n')
        self.assertEqual(self.invoke(fake), self.job['builder'])
        self.assertIn(['docker', 'buildx', 'ls', '--format', '{{json .Builder}}'], calls)
        self.container['State']['Running'] = False
        self.assertEqual(self.invoke(fake, require_running=False), self.job['builder'])

    def test_absent_builder_is_safe_only_without_orphan_container(self):
        def missing(args, **kwargs):
            return SimpleNamespace(returncode=0, stdout='')
        self.assertIsNone(self.invoke(missing, required=False))
        with self.assertRaisesRegex(RuntimeError, 'OWNED_BUILDER_REQUIRED'):
            self.invoke(missing)
        with self.assertRaisesRegex(RuntimeError, 'ORPHANED_JOB_BUILDER_FORBIDDEN'):
            self.invoke(lambda args, **_kw: SimpleNamespace(returncode=0, stdout='' if args[:3] == ['docker', 'buildx', 'ls'] else 'orphan'), required=False)
        conflicting = json.dumps(self.builder) + '\n' + json.dumps({**self.builder, 'Driver': 'remote'})
        with self.assertRaisesRegex(RuntimeError, 'OWNED_BUILDER_REQUIRED'):
            self.invoke(lambda *_args, **_kw: SimpleNamespace(returncode=0, stdout=conflicting))
        with self.assertRaisesRegex(RuntimeError, 'daemon unavailable'):
            self.invoke(lambda *_args, **_kw: (_ for _ in ()).throw(RuntimeError('daemon unavailable')), required=False)

    def test_actual_parallelism_drift_is_rejected(self):
        def fake(args, **kwargs):
            if args[:3] == ['docker', 'buildx', 'ls']:
                return SimpleNamespace(returncode=0, stdout=json.dumps(self.builder))
            if args[:2] == ['docker', 'inspect']:
                return SimpleNamespace(returncode=0, stdout=json.dumps([self.container]))
            return SimpleNamespace(returncode=0, stdout='[worker.oci]\nmax-parallelism = 2\n')
        with self.assertRaisesRegex(RuntimeError, 'BUILDKIT_PARALLELISM_INVALID'):
            self.invoke(fake)


class ImageSmokeTests(unittest.TestCase):
    def setUp(self):
        self.commit = 'a' * 40
        self.image = 'ghcr.io/harrylee-bot/workbench-web:' + self.commit + '@sha256:' + 'b' * 64
        self.job = local_runner.job_identity({'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_JOB': 'images', 'WORKBENCH_IMAGE_ID': 'web'})

    def smoke(self, fake, **overrides):
        with patch.dict(os.environ, {'GITHUB_SHA': self.commit}, clear=True), patch.object(local_runner, 'preflight'), \
             patch.object(local_runner, 'owned_job', return_value=(self.job, Path('/tmp/unused'))), \
             patch.object(local_runner, 'command', side_effect=fake):
            return local_runner.image_smoke(overrides.get('image', self.image), overrides.get('name', 'web'), overrides.get('commit', self.commit))

    def test_commit_and_job_image_mismatch_fail_before_pull(self):
        for change in [{'commit': 'c' * 40}, {'image': self.image.replace(self.commit, 'c' * 40)}, {'name': 'api'}]:
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'IMAGE_'):
                self.smoke(lambda *_args, **_kw: self.fail('Docker must not run before image binding checks'), **change)

    def test_timeout_removes_only_owned_container_and_exact_pulled_image(self):
        calls = []
        running = False
        inspections = 0
        def fake(args, **kwargs):
            nonlocal running, inspections
            calls.append(args)
            if args[:3] == ['docker', 'ps', '-aq']:
                return SimpleNamespace(returncode=0, stdout='deadbeef\n' if running else '')
            if args[:3] == ['docker', 'image', 'inspect']:
                inspections += 1
                data = [{'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': {'org.opencontainers.image.revision': self.commit}}}]
                return SimpleNamespace(returncode=1 if inspections == 1 else 0, stdout=json.dumps(data))
            if args[:2] == ['docker', 'run']:
                self.assertIn('linux/amd64', args)
                for expected in ['--read-only', '--cap-drop', '--memory', '--cpus', '--pids-limit', '--name']:
                    self.assertIn(expected, args)
                running = True
                raise subprocess.TimeoutExpired(args[:2], 180)
            if args[:2] == ['docker', 'inspect']:
                data = [{'Name': '/' + self.job['builder'] + '-smoke', 'Config': {'Image': self.image,
                         'Labels': {'io.workbench.job': self.job['builder']}}}]
                return SimpleNamespace(returncode=0, stdout=json.dumps(data))
            return SimpleNamespace(returncode=0, stdout='')
        with self.assertRaises(subprocess.TimeoutExpired):
            self.smoke(fake)
        self.assertIn(['docker', 'rm', '--force', 'deadbeef'], calls)
        self.assertIn(['docker', 'image', 'rm', self.image], calls)

    def test_foreign_container_is_never_removed(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[:3] == ['docker', 'ps', '-aq']:
                return SimpleNamespace(returncode=0, stdout='deadbeef\n')
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'Name': '/' + self.job['builder'] + '-smoke',
                'Config': {'Image': self.image, 'Labels': {'io.workbench.job': 'someone-else'}}}]))
        with self.assertRaisesRegex(RuntimeError, 'UNOWNED_JOB_CONTAINER_FORBIDDEN'):
            self.smoke(fake)
        self.assertFalse(any(args[:2] == ['docker', 'rm'] for args in calls))

    def test_auto_removed_container_race_is_safe(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[:3] == ['docker', 'ps', '-aq']:
                return SimpleNamespace(returncode=0, stdout='deadbeef' if args[-1].startswith('name=') else '')
            return SimpleNamespace(returncode=1, stdout='[]')
        with patch.object(local_runner, 'command', side_effect=fake):
            local_runner.cleanup_container(self.job, 'smoke')
        self.assertIn(['docker', 'ps', '-aq', '--filter', 'id=deadbeef'], calls)
        self.assertFalse(any(args[:2] == ['docker', 'rm'] for args in calls))

    def test_cleanup_failure_still_removes_credentials_and_checks_builder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'docker').mkdir()
            credentials = root / 'docker' / 'config.json'
            credentials.write_text('{"auths":{}}')
            with patch.object(local_runner, 'preflight'), \
                 patch.object(local_runner, 'job_directory', return_value=(self.job, root)), \
                 patch.object(local_runner, 'owned_job', return_value=(self.job, root)), \
                 patch.object(local_runner, 'cleanup_container', side_effect=[RuntimeError('UNOWNED_JOB_CONTAINER_FORBIDDEN'), None]) as container_cleanup, \
                 patch.object(local_runner, 'verify_builder', return_value=None) as builder_check:
                with self.assertRaisesRegex(RuntimeError, 'LOCAL_JOB_CLEANUP_INCOMPLETE'):
                    local_runner.cleanup()
                self.assertEqual(container_cleanup.call_count, 2)
                builder_check.assert_called_once_with(required=False, require_running=False)
            self.assertFalse(credentials.exists())
            self.assertTrue(root.exists(), 'preserve metadata for scoped repair after failure')


if __name__ == "__main__":
    unittest.main(verbosity=2)
