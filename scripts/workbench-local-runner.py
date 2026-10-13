#!/usr/bin/env python3
"""Guard the dedicated local Linux runner and only its current job resources."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess

REPOSITORY = 'harrylee-bot/ai-product-workbench'
RUNNER_NAME = 'workbench-local-build-1-0-0'
HOSTNAME = 'colima-workbench-build'
LOCAL_BUILD_PROXY = 'http://192.168.5.2:7892'
BUILDER_NO_PROXY = 'localhost'
IDENTITY = Path('/etc/workbench-local-runner.json')
MEMORY_BYTES = 4 * 1024**3
PRODUCTION_PROJECTS = {'workbench', 'workbench-runtime', 'workbench-apitable'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, *, check=True, timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check:
        require(result.returncode == 0, 'LOCAL_RUNNER_COMMAND_FAILED: ' + ' '.join(args[:3]))
    return result


def validate_identity(identity, observed, environment, event):
    require(observed['system'] == 'Linux' and observed['architecture'] in ('aarch64', 'arm64'), 'LOCAL_RUNNER_ARCHITECTURE_INVALID')
    require(observed['hostname'] != 'C202607221115992' and not observed['apitable'], 'PRODUCTION_HOST_FORBIDDEN')
    require(identity == {'schemaVersion': 'workbench.local-runner.v1', 'repository': REPOSITORY, 'runnerName': RUNNER_NAME, 'hostname': HOSTNAME,
                         'machineIdSha256': observed['machineIdSha256']}, 'LOCAL_RUNNER_IDENTITY_INVALID')
    require(observed['hostname'] == HOSTNAME, 'LOCAL_RUNNER_HOSTNAME_INVALID')
    require(environment.get('RUNNER_NAME') == RUNNER_NAME and environment.get('RUNNER_ENVIRONMENT') == 'self-hosted'
            and environment.get('RUNNER_OS') == 'Linux' and environment.get('RUNNER_ARCH') == 'ARM64', 'LOCAL_RUNNER_REGISTRATION_INVALID')
    require(environment.get('GITHUB_REPOSITORY') == REPOSITORY, 'LOCAL_RUNNER_REPOSITORY_INVALID')
    event_name = environment.get('GITHUB_EVENT_NAME')
    if event_name == 'pull_request':
        pr = event.get('pull_request', {})
        require(pr.get('head', {}).get('repo', {}).get('full_name') == REPOSITORY
                and pr.get('base', {}).get('repo', {}).get('full_name') == REPOSITORY
                and pr.get('base', {}).get('ref') == 'main', 'UNTRUSTED_PULL_REQUEST_FORBIDDEN')
    else:
        require(event_name in ('push', 'workflow_dispatch') and environment.get('GITHUB_REF') == 'refs/heads/main', 'UNTRUSTED_REF_FORBIDDEN')


def validate_docker(info, endpoint, containers):
    require(endpoint == 'unix:///var/run/docker.sock', 'REMOTE_DOCKER_FORBIDDEN')
    require(info.get('Name') == HOSTNAME and info.get('OSType') == 'linux'
            and info.get('Architecture') in ('aarch64', 'arm64'), 'LOCAL_DOCKER_IDENTITY_INVALID')
    require(all(info.get(key) is True for key in ('MemoryLimit', 'SwapLimit', 'CpuCfsPeriod', 'CpuCfsQuota')), 'DOCKER_RESOURCE_LIMITS_REQUIRED')
    for container in containers:
        labels = container.get('Config', {}).get('Labels') or {}
        require(labels.get('com.docker.compose.project') not in PRODUCTION_PROJECTS, 'PRODUCTION_CONTAINER_FORBIDDEN')


def preflight(*, resources=True):
    metadata = IDENTITY.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and not metadata.st_mode & 0o022, 'ROOT_OWNED_RUNNER_IDENTITY_REQUIRED')
    identity = json.loads(IDENTITY.read_text())
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    observed = {'system': platform.system(), 'architecture': platform.machine(), 'hostname': platform.node(),
                'machineIdSha256': hashlib.sha256(Path('/etc/machine-id').read_bytes().strip()).hexdigest(),
                'apitable': Path('/opt/apitable').exists() or Path('/opt/apitable').is_symlink()}
    validate_identity(identity, observed, os.environ, event)
    require(not os.environ.get('DOCKER_HOST') or os.environ['DOCKER_HOST'] == 'unix:///var/run/docker.sock', 'REMOTE_DOCKER_FORBIDDEN')
    context = command(['docker', 'context', 'show']).stdout.strip()
    endpoint = command(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', context]).stdout.strip()
    info = json.loads(command(['docker', 'info', '--format', '{{json .}}']).stdout)
    ids = command(['docker', 'ps', '-aq']).stdout.split()
    containers = json.loads(command(['docker', 'inspect', *ids]).stdout) if ids else []
    validate_docker(info, endpoint, containers)
    if resources:
        values = dict(re.findall(r'^(\w+):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M))
        require(int(values.get('MemAvailable', '0')) >= 6 * 1024**2, 'LOCAL_RUNNER_MEMORY_HEADROOM_REQUIRED')
        require(shutil.disk_usage(info['DockerRootDir']).free >= 20 * 1024**3, 'LOCAL_RUNNER_DISK_HEADROOM_REQUIRED')
    return info


def job_identity(environment):
    run, attempt, job = (environment.get(key, '') for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB'))
    image = environment.get('WORKBENCH_IMAGE_ID', '')
    require(re.fullmatch(r'[1-9][0-9]*', run) and re.fullmatch(r'[1-9][0-9]*', attempt)
            and re.fullmatch(r'[A-Za-z0-9_-]+', job) and re.fullmatch(r'[a-z0-9-]*', image), 'LOCAL_JOB_IDENTITY_INVALID')
    digest = hashlib.sha256(f'{run}:{attempt}:{job}:{image}'.encode()).hexdigest()[:24]
    return {'run': run, 'attempt': attempt, 'job': job, 'image': image, 'builder': 'workbench-job-' + digest}


def job_directory():
    identity = job_identity(os.environ)
    root = Path(os.environ['RUNNER_TEMP'])
    require(root.is_absolute() and root.is_dir() and not root.is_symlink() and root.resolve() == root, 'LOCAL_JOB_TEMP_INVALID')
    path = root / identity['builder']
    require(not path.is_symlink(), 'LOCAL_JOB_TEMP_SYMLINK_FORBIDDEN')
    return identity, path


def prepare():
    preflight()
    identity, path = job_directory()
    require(not path.exists(), 'LOCAL_JOB_DIRECTORY_ALREADY_EXISTS')
    path.mkdir(mode=0o700)
    (path / 'identity.json').write_text(json.dumps(identity))
    (path / 'docker').mkdir(mode=0o700)
    # This is the dedicated VM's verified local proxy, with no credentials.
    # Do not copy the host's Docker config or arbitrary environment proxies.
    proxy_config = {'proxies': {'default': {'httpProxy': LOCAL_BUILD_PROXY, 'httpsProxy': LOCAL_BUILD_PROXY,
                                           'noProxy': 'localhost,127.0.0.1,::1'}}}
    config = path / 'docker' / 'config.json'
    with config.open('x') as stream:
        os.chmod(config, 0o600)
        json.dump(proxy_config, stream)
    with Path(os.environ['GITHUB_ENV']).open('a') as stream:
        for key, value in {'WORKBENCH_JOB_BUILDER': identity['builder'], 'WORKBENCH_JOB_DIR': str(path),
                           'WORKBENCH_JOB_IMAGE': 'workbench-local-pr:' + identity['builder'],
                           'WORKBENCH_BUILD_PROXY': LOCAL_BUILD_PROXY, 'WORKBENCH_BUILD_NO_PROXY': BUILDER_NO_PROXY,
                           'DOCKER_CONFIG': str(path / 'docker'), 'TRIVY_CACHE_DIR': str(path / 'trivy')}.items():
            require('\n' not in value and '\r' not in value, 'LOCAL_JOB_ENV_INVALID')
            stream.write(f'{key}={value}\n')
    print('Dedicated ARM64 runner verified; current job resources prepared.')


def owned_job():
    identity, path = job_directory()
    require(path.is_dir() and (path / 'identity.json').is_file() and not (path / 'identity.json').is_symlink(), 'LOCAL_JOB_RECEIPT_REQUIRED')
    require(json.loads((path / 'identity.json').read_text()) == identity, 'LOCAL_JOB_RECEIPT_INVALID')
    require(os.environ.get('WORKBENCH_JOB_BUILDER') == identity['builder'] and os.environ.get('DOCKER_CONFIG') == str(path / 'docker'), 'LOCAL_JOB_SCOPE_INVALID')
    docker = path / 'docker'
    require(docker.is_dir() and not docker.is_symlink() and docker.resolve() == docker, 'LOCAL_JOB_DOCKER_DIRECTORY_INVALID')
    return identity, path


def validate_builder(builder, container, identity, *, require_running=True):
    require(builder.get('Name') == identity['builder'] and builder.get('Driver') == 'docker-container', 'UNOWNED_BUILDER_FORBIDDEN')
    nodes = builder.get('Nodes', [])
    require(len(nodes) == 1 and nodes[0].get('Endpoint') == 'unix:///var/run/docker.sock', 'REMOTE_BUILDER_FORBIDDEN')
    limits = container.get('HostConfig', {})
    require(container.get('Name') == '/buildx_buildkit_' + nodes[0]['Name'], 'BUILDER_CONTAINER_MISMATCH')
    require((not require_running or container.get('State', {}).get('Running') is True) and limits.get('Memory') == MEMORY_BYTES
            and limits.get('MemorySwap') == MEMORY_BYTES and limits.get('CpuPeriod') == 100000
            and limits.get('CpuQuota') == 200000 and limits.get('NetworkMode') == 'bridge', 'BUILDER_LIMITS_INVALID')
    flags = container.get('Config', {}).get('Cmd')
    base_flags = (['--config', '/etc/buildkit/buildkitd.toml', '--oci-worker-net=bridge'],
                  ['--oci-worker-net=bridge', '--config', '/etc/buildkit/buildkitd.toml'])
    # Buildx v0.34 adds network.host capability for container drivers even on
    # bridge networks (builder/builder.go). It refers to the isolated builder
    # network; build requests remain forbidden from asking for this entitlement.
    allowed = (*base_flags, *(value + ['--allow-insecure-entitlement=network.host'] for value in base_flags))
    require(flags in allowed, 'BUILDER_FLAGS_INVALID')
    environment = [value.partition('=') for value in container.get('Config', {}).get('Env', [])]
    expected = {'http_proxy': LOCAL_BUILD_PROXY, 'https_proxy': LOCAL_BUILD_PROXY, 'no_proxy': BUILDER_NO_PROXY}
    for key, value in expected.items():
        require([entry[2] for entry in environment if entry[0] == key] == [value], 'BUILDER_PROXY_INVALID')
        require(all(entry[2] == value for entry in environment if entry[0] == key.upper()), 'BUILDER_PROXY_INVALID')


def verify_builder(*, required=True, require_running=True):
    preflight(resources=False)
    identity, _path = owned_job()
    rows = [json.loads(line) for line in command(['docker', 'buildx', 'ls', '--format', '{{json .Builder}}']).stdout.splitlines() if line]
    # Buildx v0.34 emits the complete builder twice (builder and node rows).
    # Accept identical copies, but fail if the same name has conflicting data.
    matches = {json.dumps(row, sort_keys=True) for row in rows if isinstance(row, dict) and row.get('Name') == identity['builder']}
    if not matches and not required:
        orphan = command(['docker', 'ps', '-aq', '--filter', 'name=^/buildx_buildkit_' + identity['builder'] + '[0-9]+$']).stdout.strip()
        require(not orphan, 'ORPHANED_JOB_BUILDER_FORBIDDEN')
        return None
    require(len(matches) == 1, 'OWNED_BUILDER_REQUIRED')
    builder = json.loads(next(iter(matches)))
    nodes = builder.get('Nodes', [])
    require(len(nodes) == 1 and re.fullmatch(re.escape(identity['builder']) + r'[0-9]+', nodes[0].get('Name', '')), 'UNOWNED_BUILDER_NODE_FORBIDDEN')
    container = json.loads(command(['docker', 'inspect', '--type', 'container', 'buildx_buildkit_' + nodes[0]['Name']]).stdout)
    require(len(container) == 1, 'BUILDER_CONTAINER_REQUIRED')
    validate_builder(builder, container[0], identity, require_running=require_running)
    if container[0].get('State', {}).get('Running'):
        policy = command(['docker', 'exec', 'buildx_buildkit_' + nodes[0]['Name'], 'cat', '/etc/buildkit/buildkitd.toml']).stdout
    else:
        policy = base64.b64decode(nodes[0].get('Files', {}).get('buildkitd.toml', ''), validate=True).decode()
    normalized = re.sub(r'\s', '', re.sub(r'#[^\n]*', '', policy)).replace('[worker][worker.oci]', '[worker.oci]')
    require(normalized == '[worker.oci]max-parallelism=1', 'BUILDKIT_PARALLELISM_INVALID')
    return identity['builder']


def release_builder():
    builder = verify_builder()
    command(['docker', 'buildx', 'prune', '--builder', builder, '--all', '--force'])
    command(['docker', 'buildx', 'stop', builder])
    print('Released only the verified current job builder cache.')


def cleanup_container(identity, kind):
    """Remove a timed-out probe only after checking its exact name and owner."""
    require(kind in ('smoke', 'probe'), 'JOB_CONTAINER_KIND_INVALID')
    name = identity['builder'] + '-' + kind
    ids = command(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$']).stdout.split()
    if not ids:
        return
    require(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{8,64}', ids[0]), 'JOB_CONTAINER_AMBIGUOUS')
    inspected = command(['docker', 'inspect', '--type', 'container', ids[0]], check=False)
    if inspected.returncode != 0:
        # --rm containers may exit between list and inspect. Confirm this exact
        # ID is gone; a daemon/permission failure must still stop cleanup.
        remaining = command(['docker', 'ps', '-aq', '--filter', 'id=' + ids[0]]).stdout.strip()
        require(not remaining, 'JOB_CONTAINER_INSPECTION_FAILED')
        return
    container = json.loads(inspected.stdout)[0]
    config = container.get('Config', {})
    labels = config.get('Labels') or {}
    image = config.get('Image', '')
    require(container.get('Name') == '/' + name and labels.get('io.workbench.job') == identity['builder'], 'UNOWNED_JOB_CONTAINER_FORBIDDEN')
    if kind == 'probe':
        require(identity['job'] == 'pr-production-images' and image == 'workbench-local-pr:' + identity['builder'], 'UNOWNED_JOB_CONTAINER_IMAGE')
    else:
        require(re.fullmatch(r'ghcr\.io/harrylee-bot/workbench-' + re.escape(identity['image']) + ':'
                             + re.escape(os.environ.get('GITHUB_SHA', '')) + r'@sha256:[a-f0-9]{64}', image), 'UNOWNED_JOB_CONTAINER_IMAGE')
    removed = command(['docker', 'rm', '--force', ids[0]], check=False)
    if removed.returncode != 0:
        remaining = command(['docker', 'ps', '-aq', '--filter', 'id=' + ids[0]]).stdout.strip()
        require(not remaining, 'JOB_CONTAINER_REMOVAL_FAILED')


def cleanup():
    preflight(resources=False)
    _identity, path = job_directory()
    if not path.exists():
        return
    identity, path = owned_job()
    errors = []
    def attempt(action):
        try:
            action()
        except Exception as error:
            errors.append(str(error))
    for kind in ('smoke', 'probe'):
        attempt(lambda kind=kind: cleanup_container(identity, kind))
    def remove_image():
        if identity['job'] != 'pr-production-images':
            return
        image = 'workbench-local-pr:' + identity['builder']
        inspected = command(['docker', 'image', 'inspect', image], check=False)
        if inspected.returncode == 0:
            labels = json.loads(inspected.stdout)[0].get('Config', {}).get('Labels', {})
            require(labels.get('io.workbench.job') == identity['builder']
                    and labels.get('org.opencontainers.image.revision') == os.environ.get('GITHUB_SHA'), 'UNOWNED_JOB_IMAGE_FORBIDDEN')
            command(['docker', 'image', 'rm', image])
    def remove_builder():
        builder = verify_builder(required=False, require_running=False)
        if builder:
            command(['docker', 'buildx', 'rm', '--force', builder])
    attempt(remove_image)
    attempt(remove_builder)
    # Retain builder metadata for scoped repair if resource cleanup failed,
    # but always revoke this job's on-disk registry credentials.
    attempt(lambda: (path / 'docker' / 'config.json').unlink(missing_ok=True))
    if not errors:
        attempt(lambda: shutil.rmtree(path))
    require(not errors, 'LOCAL_JOB_CLEANUP_INCOMPLETE: ' + '; '.join(errors))
    print('Removed only verified current job builder and temporary credentials.')


def image_smoke(image, name, commit):
    preflight(resources=False)
    identity, _path = owned_job()
    require(name in ('api', 'api-migrator', 'deerflow', 'export-worker', 'file-worker', 'import-worker', 'preview', 'quartz', 'runtime-worker', 'web'), 'IMAGE_ID_INVALID')
    require(re.fullmatch(r'ghcr\.io/harrylee-bot/workbench-' + re.escape(name) + r':[a-f0-9]{40}@sha256:[a-f0-9]{64}', image), 'IMAGE_REFERENCE_INVALID')
    require(re.fullmatch(r'[a-f0-9]{40}', commit), 'IMAGE_COMMIT_INVALID')
    require(commit == os.environ.get('GITHUB_SHA') and image.split('@')[0].endswith(':' + commit), 'IMAGE_JOB_COMMIT_MISMATCH')
    require(name == identity['image'], 'IMAGE_JOB_ID_MISMATCH')
    cleanup_container(identity, 'smoke')
    existed = command(['docker', 'image', 'inspect', image], check=False).returncode == 0
    pulled = False
    try:
        command(['docker', 'pull', '--platform', 'linux/amd64', image], timeout=600)
        pulled = True
        inspected = json.loads(command(['docker', 'image', 'inspect', image]).stdout)[0]
        require(inspected.get('Os') == 'linux' and inspected.get('Architecture') == 'amd64'
                and inspected.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == commit, 'PRODUCTION_IMAGE_PLATFORM_OR_COMMIT_INVALID')
        runtime = ['nginx', '-v'] if name == 'quartz' else ['node', '-e', "if(process.platform!=='linux'||process.arch!=='x64')process.exit(1)"]
        args = ['docker', 'run', '--rm', '--name', identity['builder'] + '-smoke', '--platform', 'linux/amd64', '--network', 'none', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '1',
                '--pids-limit', '64', '--label', 'io.workbench.job=' + identity['builder'], '--entrypoint', runtime[0], image, *runtime[1:]]
        command(args)
        if name == 'deerflow':
            args[args.index('--entrypoint') + 1] = 'python3'
            args = args[:args.index(image) + 1] + ['-c', "import platform; assert platform.machine() == 'x86_64'"]
            command(args)
        print(json.dumps({'status': 'PASS', 'image': name, 'platform': 'linux/amd64', 'scope': 'Image architecture and isolated runtime binary compatibility; ARM64 host uses emulation.'}))
    finally:
        cleanup_container(identity, 'smoke')
        if pulled and not existed:
            command(['docker', 'image', 'rm', image])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('preflight', 'prepare', 'verify-builder', 'release-builder', 'cleanup', 'image-smoke'))
    parser.add_argument('--image')
    parser.add_argument('--name')
    parser.add_argument('--commit')
    parser.add_argument('--phase', choices=('before-job', 'job'), default='job')
    args = parser.parse_args()
    if args.operation == 'preflight':
        preflight(resources=args.phase != 'before-job')
    elif args.operation == 'image-smoke':
        image_smoke(args.image, args.name, args.commit)
    else:
        {'preflight': preflight, 'prepare': prepare, 'verify-builder': verify_builder,
         'release-builder': release_builder, 'cleanup': cleanup}[args.operation]()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(f'Local runner stopped: {error}')
