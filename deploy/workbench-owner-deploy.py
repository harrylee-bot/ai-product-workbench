#!/usr/bin/env python3
"""Deploy an owner-approved immutable release without building on the server."""

import argparse
import copy
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


IDENTITY = "https://github.com/harrylee-bot/ai-product-workbench/.github/workflows/workbench-owner-release.yml@refs/heads/main"
QUEUE = ("workbench-api", "workbench-worker", "workbench-file-worker", "workbench-import-worker", "workbench-export-worker")
APPLICATION = (*QUEUE, "workbench-web", "knowledge")
GATEWAYS = ("preview-gateway", "gateway")
NGINX_TMPFS = ("/var/cache/nginx", "/var/run", "/tmp")
LIMITS = {
    "migrate": (1024, 1, 128),
    "workbench-api": (1024, 1, 256),
    "workbench-web": (512, 1, 128),
    "workbench-worker": (1024, 1, 256),
    "workbench-file-worker": (1024, 0.5, 128),
    "workbench-import-worker": (768, 1, 128),
    "workbench-export-worker": (1536, 1, 256),
    "workbench-preview": (256, 0.5, 128),
    "knowledge": (256, 0.5, 64),
    "deerflow": (1536, 1, 512),
    "preview-gateway": (128, 0.25, 64),
    "gateway": (128, 0.25, 64),
}


def fail(message):
    raise RuntimeError(message)


def write_private(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def escape_compose_values(value):
    # For literal values from docker inspect or newly constructed data ONLY.
    # `docker compose config` already returns a reserializable escaped model.
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [escape_compose_values(item) for item in value]
    if isinstance(value, dict):
        return {key: escape_compose_values(item) for key, item in value.items()}
    return value


def write_compose(path, config):
    # Callers hold the serialized `compose config` model, whose dollars are
    # already escaped. Escaping it again changes passwords and shell commands.
    write_private(path, config)


def gateway_tmpfs(entries):
    """Keep mount sizes/options while granting the signed Nginx image its writable directories."""
    if not isinstance(entries, list) or any(not isinstance(entry, str) for entry in entries):
        fail("Resolved gateway tmpfs must be a list of mount specifications")
    result, seen = [], set()
    for entry in entries:
        destination, _, options = entry.partition(":")
        if destination in NGINX_TMPFS:
            if destination in seen:
                fail(f"Duplicate gateway tmpfs mount {destination}")
            seen.add(destination)
            retained = [option for option in options.split(",") if option and not option.startswith(("uid=", "gid=", "mode="))]
            result.append(destination + ":" + ",".join([*retained, "uid=101", "gid=101", "mode=1770"]))
        else:
            result.append(entry)
    result.extend(destination + ":uid=101,gid=101,mode=1770" for destination in NGINX_TMPFS if destination not in seen)
    return result


def prepare_config(original, images, runtime=False):
    """Only rewrite managed images/limits; preserve shared topology and data mounts."""
    config = copy.deepcopy(original)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", config.get("name", "")):
        fail("Resolved Compose project name is required")
    services = config.get("services", {})
    for service in services.values():
        service.pop("build", None)
    selected = [image for image in images if (image["id"] == "deerflow") == runtime]
    for image in selected:
        name = image["composeService"]
        if name not in services:
            fail(f"Resolved Compose is missing managed service {name}")
        if not re.search(r"@sha256:[a-f0-9]{64}$", image["imageRef"]):
            fail(f"Managed service {name} image must be immutable")
        services[name]["image"] = image["imageRef"]
    managed = [image["composeService"] for image in selected]
    if not runtime:
        quartz = [image for image in selected if image["id"] == "quartz"]
        if len(quartz) != 1:
            fail("Gateways require exactly one verified Quartz image")
        for name in GATEWAYS:
            if name not in services:
                fail(f"Resolved Compose is missing {name}")
            # The signed Quartz runtime is Nginx plus static content. Each
            # gateway mounts its own complete nginx.conf, without static roots
            # or the Quartz conf.d include. Reuse its scanned digest, not an old
            # unverified infrastructure image. Both gateways listen on 8080.
            services[name]["image"] = quartz[0]["imageRef"]
            services[name]["user"] = "101:101"
            services[name]["tmpfs"] = gateway_tmpfs(services[name].get("tmpfs", []))
        managed.extend(GATEWAYS)
    for name in managed:
        service = services[name]
        service["pull_policy"] = "never"
        healthcheck = service.get("healthcheck", {})
        if name != "migrate" and (healthcheck.get("disable") or not healthcheck.get("test")
                                   or healthcheck["test"][0] == "NONE"):
            fail(f"Managed service {name} requires an explicit healthcheck")
        memory_mib, cpu, pids = LIMITS[name]
        # Explicit limits also constrain pre-existing unbounded deployment definitions.
        service["mem_limit"] = memory_mib * 1024 * 1024
        service["cpus"] = cpu
        service["pids_limit"] = pids
        if "deploy" in service:
            limits = service["deploy"].setdefault("resources", {}).setdefault("limits", {})
            limits.update({"memory": service["mem_limit"], "cpus": str(cpu), "pids": pids})
    return config


def gateway_preflight_config(candidate):
    """Check real mounted configs and permissions even when upstream services are absent."""
    config = copy.deepcopy(candidate)
    upstreams = sorted(config["services"])
    config["name"] += "-nginx-check"
    config["services"] = {name: config["services"][name] for name in GATEWAYS}
    for service in config["services"].values():
        service["extra_hosts"] = [f"{name}=127.0.0.1" for name in upstreams]
        service["network_mode"] = "none"
        for field in ("networks", "ports", "depends_on", "container_name"):
            service.pop(field, None)
    return config


def make_rollback_config(original, running):
    config = copy.deepcopy(original)
    for name, service in config.get("services", {}).items():
        service.pop("build", None)
        if name in running:
            service["image"] = running[name]["imageId"]
        if name in LIMITS:
            service["pull_policy"] = "never"
    return config


class Deployment:
    def __init__(self, args):
        self.args = args
        self.logs = []
        self.backup = None
        self.mutated = False
        self.started = []

    def run(self, command, label, timeout=120, input_bytes=None):
        result = subprocess.run(command, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, cwd=self.args.source_root)
        if result.returncode:
            self.logs.append({"step": label, "code": result.returncode,
                              "stderr": result.stderr.decode("utf8", "replace")[-65536:]})
            fail(f"{label} failed (exit {result.returncode}); details stay in the private deployment directory")
        return result.stdout

    def compose(self, filename, project, *arguments):
        return ["docker", "compose", "--project-name", project, "--env-file", str(self.args.env_file),
                "--file", str(filename), *arguments]

    def resolve(self, filename):
        command = ["docker", "compose", "--profile", "*", "--env-file", str(self.args.env_file), "--file", str(filename),
                   "config", "--format", "json"]
        return json.loads(self.run(command, "Resolve private Compose configuration"))

    def verify(self, inspect_local=False):
        root = self.args.release_dir
        command = ["node", str(self.args.source_root / "scripts/owner-release.mjs"), "verify",
                   "--manifest", str(root / "owner-release.json"), "--bundle", str(root / "owner-release.bundle.json"),
                   "--image-manifest", str(root / "production-image-manifest.json"),
                   "--image-bundle", str(root / "production-image-manifest.bundle.json"),
                   "--certificate-identity", IDENTITY, "--expected-commit", self.args.commit,
                   "--source-root", str(self.args.source_root),
                   "--build-env-file", str(self.args.env_file)]
        if inspect_local:
            command += ["--inspect-local", "true"]
        return json.loads(self.run(command, "Verify owner release signatures and build configuration", timeout=600))

    def running(self, project):
        ids = self.run(["docker", "ps", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.ID}}"], "Inventory running containers").decode().split()
        if not ids:
            return {}
        result = {}
        for container in json.loads(self.run(["docker", "inspect", *ids], "Inspect current service images")):
            service = container["Config"]["Labels"].get("com.docker.compose.service")
            if service in result:
                fail(f"Multiple running replicas of {service}; this deployer requires the single-host service topology")
            result[service] = {"containerId": container["Id"], "imageId": container["Image"]}
        return result

    def check_resources(self, after_pull=False):
        target = self.args.backup_root
        while not target.exists():
            target = target.parent
        docker_root = Path(self.run(["docker", "info", "--format", "{{.DockerRootDir}}"],
                                    "Locate Docker image storage").decode().strip())
        if not docker_root.is_absolute() or not docker_root.is_dir():
            fail("Docker image storage must be an existing local absolute directory")
        required_gib = self.args.min_remaining_gib if after_pull else self.args.min_free_gib
        for label, directory in (("database backup", target), ("Docker image storage", docker_root)):
            if shutil.disk_usage(directory).free < required_gib * 1024**3:
                fail(f"Insufficient free disk space for {label}")
        if Path("/proc/meminfo").exists():
            entries = dict(re.findall(r"^(\w+):\s+(\d+) kB", Path("/proc/meminfo").read_text(), re.M))
            if int(entries.get("MemAvailable", "0")) < self.args.min_available_mib * 1024:
                fail("Insufficient available memory for safe service rollout")

    def health(self, filename, project, service):
        deadline = time.monotonic() + self.args.health_timeout
        while time.monotonic() < deadline:
            ids = self.run(self.compose(filename, project, "ps", "--all", "--quiet", service), f"Locate {service}").decode().split()
            if ids:
                states = json.loads(self.run(["docker", "inspect", "--format", "{{json .State}}", ids[0]], f"Check {service} health"))
                status = states.get("Status")
                health = states.get("Health", {}).get("Status")
                if status == "running" and health == "healthy":
                    print(f"Ready: {service}", flush=True)
                    return
                if status == "running" and health is None:
                    fail(f"{service} has no runtime healthcheck")
                if status in ("dead", "exited") or health == "unhealthy":
                    fail(f"{service} failed readiness")
            time.sleep(2)
        fail(f"{service} readiness timed out")

    def start(self, filename, project, service, recreate=False):
        self.started.append((filename, project, service))
        command = ["up", "--detach", "--no-build", "--no-deps"]
        if recreate:
            command.append("--force-recreate")
        self.run(self.compose(filename, project, *command, service), f"Start {service}", timeout=180)
        self.health(filename, project, service)

    def database_backup(self, postgres):
        archive = self.backup / "database.dump"
        descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            result = subprocess.run(["docker", "exec", postgres, "sh", "-c",
                'exec pg_dump -Fc -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'],
                stdout=stream, stderr=subprocess.PIPE, timeout=600)
        if result.returncode or archive.stat().st_size == 0:
            self.logs.append({"step": "Database backup", "stderr": result.stderr.decode("utf8", "replace")[-65536:]})
            fail("Database backup failed; live services remain unchanged")
        with archive.open("rb") as stream:
            result = subprocess.run(["docker", "exec", "-i", postgres, "pg_restore", "--list"],
                                    stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            fail("Database backup archive verification failed; live services remain unchanged")
        print("Database backup verified", flush=True)

    def rollback(self, previous_app, previous_runtime):
        print("Rollout failed; restoring previously running service images. Database restore requires explicit recovery.", flush=True)
        errors = []
        for config, running, filename in [(self.runtime_original, previous_runtime, "rollback-runtime.json"), (self.app_original, previous_app, "rollback-app.json")]:
            rollback_file = self.backup / filename
            write_compose(rollback_file, make_rollback_config(config, running))
            order = ["workbench-preview", "deerflow", *APPLICATION, *GATEWAYS]
            managed = [name for name in order if name in config["services"]]
            new_services = [name for name in managed if name not in running]
            if new_services:
                try:
                    self.run(self.compose(rollback_file, config["name"], "stop", "--timeout", "30", *new_services), "Stop newly introduced application services", timeout=180)
                except Exception as error:
                    errors.append(str(error))
            for name in managed:
                if name in running:
                    try:
                        self.start(rollback_file, config["name"], name, recreate=True)
                    except Exception as error:
                        errors.append(str(error))
        if errors:
            fail("Application rollback did not restore all service health; recovery snapshots were preserved")

    def execute(self):
        self.check_resources()
        release = self.verify()
        self.app_original = self.resolve(self.args.app_compose)
        self.runtime_original = self.resolve(self.args.runtime_compose)
        app = prepare_config(self.app_original, release["images"])
        runtime = prepare_config(self.runtime_original, release["images"], runtime=True)
        previous_app = self.running(app["name"])
        previous_runtime = self.running(runtime["name"])
        if "postgres" not in previous_app:
            fail("A running existing postgres service is required; this deployer never provisions or replaces data infrastructure")
        plan = {"version": "1.0.0", "sourceCommit": self.args.commit, "mode": "execute" if self.args.execute else "plan",
                "applicationProject": app["name"], "runtimeProject": runtime["name"],
                "images": [{"id": image["id"], "imageRef": image["imageRef"]} for image in release["images"]],
                "gatewayImages": {name: app["services"][name]["image"] for name in GATEWAYS},
                "sequence": ["pull all images", "verify local labels", "check gateway configuration and permissions", "verified database backup", "stop queue participants", "migrate", "preview", "deerflow", "api and workers and web and knowledge", "gateways", "health"],
                "runningApplicationServices": sorted(previous_app), "runningRuntimeServices": sorted(previous_runtime)}
        print(json.dumps(plan, ensure_ascii=False, indent=2), flush=True)
        if not self.args.execute:
            return
        self.args.backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.args.backup_root.is_symlink():
            fail("Backup root must not be a symbolic link")
        os.chmod(self.args.backup_root, 0o700)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.backup = self.args.backup_root / f"{stamp}-{self.args.commit[:12]}"
        self.backup.mkdir(mode=0o700)
        app_file, runtime_file = self.backup / "candidate-app.json", self.backup / "candidate-runtime.json"
        write_compose(app_file, app)
        write_compose(runtime_file, runtime)
        write_compose(self.backup / "before-app.json", self.app_original)
        write_compose(self.backup / "before-runtime.json", self.runtime_original)
        write_private(self.backup / "running-services.json", {"app": previous_app, "runtime": previous_runtime})
        write_private(self.backup / "plan.json", plan)
        self.run(self.compose(app_file, app["name"], "config", "--quiet"), "Validate materialized app Compose")
        self.run(self.compose(runtime_file, runtime["name"], "config", "--quiet"), "Validate materialized runtime Compose")
        for image in release["images"]:
            print(f"Pulling verified image: {image['id']}", flush=True)
            self.run(["docker", "pull", image["imageRef"]], f"Pull {image['id']}", timeout=1200)
        self.verify(inspect_local=True)
        self.check_resources(after_pull=True)
        gateway_check = gateway_preflight_config(app)
        gateway_check_file = self.backup / "gateway-check.json"
        write_compose(gateway_check_file, gateway_check)
        for name in GATEWAYS:
            self.run(self.compose(gateway_check_file, gateway_check["name"], "run", "--rm", "--no-deps",
                                  "--entrypoint", "nginx", name, "-t"), f"Check {name} configuration and permissions", timeout=120)
        self.database_backup(previous_app["postgres"]["containerId"])
        try:
            self.mutated = True
            self.run(self.compose(app_file, app["name"], "stop", "--timeout", "45", *QUEUE), "Stop Runtime queue participants", timeout=180)
            self.run(self.compose(app_file, app["name"], "run", "--rm", "--no-deps", "migrate"), "Apply additive migrations and reconcile Runtime queue", timeout=600)
            self.start(app_file, app["name"], "workbench-preview")
            self.start(runtime_file, runtime["name"], "deerflow")
            for name in APPLICATION:
                self.start(app_file, app["name"], name)
            for name in GATEWAYS:
                self.start(app_file, app["name"], name, recreate=True)
            write_private(self.backup / "result.json", {"status": "PASS", "sourceCommit": self.args.commit, "backup": str(self.backup)})
            print(f"Deployment healthy. Recovery materials: {self.backup}", flush=True)
        except Exception:
            try:
                self.rollback(previous_app, previous_runtime)
            except Exception as rollback_error:
                self.logs.append({"step": "rollback", "error": str(rollback_error)})
                print("Automatic application rollback incomplete; inspect private diagnostics and retained database archive.", file=sys.stderr)
            raise


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "release-dir", "app-compose", "runtime-compose", "env-file", "backup-root"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--execute", action="store_true", help="Pull, back up and deploy; omitted means read-only plan")
    parser.add_argument("--health-timeout", type=int, default=300)
    parser.add_argument("--min-free-gib", type=int, default=20)
    parser.add_argument("--min-remaining-gib", type=int, default=6)
    parser.add_argument("--min-available-mib", type=int, default=1536)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.commit):
        parser.error("--commit must be a full lowercase Git SHA")
    for name in ("source_root", "release_dir", "app_compose", "runtime_compose", "env_file", "backup_root"):
        value = getattr(args, name)
        if not value.is_absolute():
            parser.error(f"--{name.replace('_', '-')} must be absolute")
    try:
        args.backup_root.resolve().relative_to(args.source_root.resolve())
    except ValueError:
        pass
    else:
        parser.error("--backup-root must be outside the source repository because resolved Compose contains secrets")
    if args.health_timeout < 1 or args.min_free_gib < 1 or args.min_remaining_gib < 1 or args.min_available_mib < 512:
        parser.error("resource and health thresholds must be positive and safe")
    return args


def main():
    args = parse_args()
    # The lock is outside either checkout, so different invocations share one host lock.
    descriptor = os.open("/tmp/workbench-owner-deploy.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("Another owner deployment holds the host lock")
        deployment = Deployment(args)
        try:
            deployment.execute()
        finally:
            if deployment.backup and deployment.logs:
                write_private(deployment.backup / "diagnostics.json", deployment.logs)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Subprocess output is never interpolated here because Compose contains secrets.
        print(f"Owner deployment stopped: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
