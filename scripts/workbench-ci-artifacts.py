#!/usr/bin/env python3
"""Durable evidence transport for the one guarded local runner; no cloud quota."""
import argparse
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import time

ROOT = Path('/var/lib/workbench-ci-artifacts')
REPOSITORY = 'harrylee-bot/ai-product-workbench'
MAX_BYTES = 256 * 1024**2


def require(value, message):
    if not value:
        raise RuntimeError(message)


def private_directory(path, *, create=False):
    require(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'ARTIFACT_DIRECTORY_UNSAFE')
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            'ARTIFACT_DIRECTORY_MUST_BE_PRIVATE')


def safe_file(path, root):
    require(path.is_relative_to(root) and path.resolve() == path and not path.is_symlink(), 'ARTIFACT_PATH_ESCAPE')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'ARTIFACT_REGULAR_FILE_REQUIRED')


def relative_file(name):
    p = PurePosixPath(name)
    require(bool(name) and not p.is_absolute() and str(p) == name and '\\' not in name
            and all(part not in ('.', '..') for part in p.parts), 'ARTIFACT_RELATIVE_PATH_INVALID')
    return p


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            value.update(chunk)
    return value.hexdigest()


def durable_json(path, value):
    with path.open('x') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


class Store:
    def __init__(self, root, workspace, identity):
        private_directory(root)
        require(workspace.is_absolute() and workspace.resolve() == workspace, 'ARTIFACT_WORKSPACE_INVALID')
        require(identity.get('repository') == REPOSITORY and re.fullmatch(r'[a-f0-9]{40}', identity.get('commit', '')),
                'ARTIFACT_SOURCE_INVALID')
        require(all(re.fullmatch(r'[1-9][0-9]*', identity.get(k, '')) for k in ('run', 'attempt')), 'ARTIFACT_RUN_INVALID')
        self.root, self.workspace, self.identity = root, workspace, identity
        self.directory = root / identity['run'] / identity['attempt']
        private_directory(self.directory.parent, create=True)
        private_directory(self.directory, create=True)

    def prune_expired(self):
        removed = 0
        for path in self.root.glob('*/*/*'):
            if path.parent == self.directory or path.name.startswith('.'):
                continue
            try:
                private_directory(path)
                safe_file(path / 'manifest.json', self.root)
                document = json.loads((path / 'manifest.json').read_text())
                require(document.get('schema') == 'workbench.local-artifact.v1'
                        and document.get('repository') == REPOSITORY
                        and document.get('run') == path.parent.parent.name
                        and document.get('attempt') == path.parent.name
                        and document.get('name') == path.name, 'ARTIFACT_BINDING_MISMATCH')
                require(isinstance(document.get('expiresAt'), int) and document['expiresAt'] < time.time(), 'NOT_EXPIRED')
                require(not any(p.is_symlink() for p in path.rglob('*')), 'ARTIFACT_SYMLINK_FORBIDDEN')
            except (RuntimeError, OSError, ValueError):
                continue
            shutil.rmtree(path)
            removed += 1
        return removed

    def upload(self, name, source, days):
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,180}', name or ''), 'ARTIFACT_NAME_INVALID')
        require(days in (1, 7), 'ARTIFACT_RETENTION_INVALID')
        source = self.workspace / relative_file(source)
        require(source.is_relative_to(self.workspace / 'output') and source.exists()
                and source.resolve() == source, 'ARTIFACT_OUTPUT_SOURCE_REQUIRED')
        paths = sorted(source.rglob('*')) if source.is_dir() else [source]
        require(not any(p.is_symlink() for p in paths), 'ARTIFACT_SYMLINK_FORBIDDEN')
        files = [p for p in paths if p.is_file()]
        require(0 < len(files) <= 2000, 'ARTIFACT_FILES_REQUIRED')
        require(sum(p.stat().st_size for p in files) <= MAX_BYTES, 'ARTIFACT_TOO_LARGE')
        target = self.directory / name
        require(not target.exists() and not target.is_symlink(), 'ARTIFACT_ALREADY_EXISTS')
        temporary = Path(tempfile.mkdtemp(prefix='.pending-', dir=self.directory))
        try:
            entries = {}
            base = source if source.is_dir() else source.parent
            for src in files:
                safe_file(src, self.workspace)
                relative = src.relative_to(base).as_posix()
                dest = temporary / 'files' / relative
                dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with src.open('rb') as reader, dest.open('xb') as writer:
                    os.chmod(dest, 0o600)
                    shutil.copyfileobj(reader, writer)
                    writer.flush()
                    os.fsync(writer.fileno())
                entries[relative] = {'sha256': digest(dest), 'bytes': dest.stat().st_size}
            now = int(time.time())
            manifest = {'schema': 'workbench.local-artifact.v1', **self.identity, 'name': name,
                        'createdAt': now, 'expiresAt': now + days * 86400, 'files': entries}
            durable_json(temporary / 'manifest.json', manifest)
            os.rename(temporary, target)
            descriptor = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            self.verify(target)
            return {'name': name, 'fileCount': len(files), 'manifestSha256': digest(target / 'manifest.json')}
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)

    def verify(self, path):
        private_directory(path)
        safe_file(path / 'manifest.json', self.root)
        manifest = json.loads((path / 'manifest.json').read_text())
        require(manifest.get('schema') == 'workbench.local-artifact.v1'
                and all(manifest.get(k) == v for k, v in self.identity.items())
                and manifest.get('name') == path.name, 'ARTIFACT_BINDING_MISMATCH')
        require(isinstance(manifest.get('expiresAt'), int) and manifest['expiresAt'] > time.time(), 'ARTIFACT_EXPIRED')
        entries = manifest.get('files')
        require(isinstance(entries, dict) and 0 < len(entries) <= 2000, 'ARTIFACT_MANIFEST_FILES_INVALID')
        actual = list((path / 'files').rglob('*'))
        require(not any(p.is_symlink() for p in actual), 'ARTIFACT_SYMLINK_FORBIDDEN')
        require({p.relative_to(path / 'files').as_posix() for p in actual if p.is_file()} == set(entries),
                'ARTIFACT_FILE_SET_MISMATCH')
        total = 0
        for name, record in entries.items():
            file = path / 'files' / relative_file(name)
            safe_file(file, self.root)
            require(file.stat().st_size == record['bytes'] and digest(file) == record['sha256'], 'ARTIFACT_HASH_MISMATCH')
            total += record['bytes']
        require(total <= MAX_BYTES, 'ARTIFACT_TOO_LARGE')
        return manifest

    def download(self, name, destination, *, pattern=False):
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,180}' + (r'\*?' if pattern else ''), name or ''),
                'ARTIFACT_NAME_INVALID')
        destination = self.workspace / relative_file(destination)
        require(destination.is_relative_to(self.workspace / 'output') and destination.resolve() == destination,
                'ARTIFACT_OUTPUT_DESTINATION_REQUIRED')
        matches = sorted(p for p in self.directory.iterdir() if fnmatch.fnmatchcase(p.name, name))
        require(bool(matches) and (pattern or len(matches) == 1), 'ARTIFACT_NOT_FOUND')
        manifests = [(p, self.verify(p)) for p in matches]
        names = [n for _, m in manifests for n in m['files']]
        require(len(names) == len(set(names)), 'ARTIFACT_MERGE_COLLISION')
        require(not any((destination / n).exists() or (destination / n).is_symlink() for n in names), 'ARTIFACT_DESTINATION_EXISTS')
        for path, manifest in manifests:
            for name, record in manifest['files'].items():
                target = destination / name
                require(target.resolve() == target, 'ARTIFACT_PATH_ESCAPE')
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with (path / 'files' / name).open('rb') as reader, target.open('xb') as writer:
                    os.chmod(target, 0o600)
                    shutil.copyfileobj(reader, writer)
                require(digest(target) == record['sha256'], 'ARTIFACT_COPY_HASH_MISMATCH')
        return {'artifacts': len(matches), 'files': len(names)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('upload', 'download'))
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('runner_guard', Path(__file__).with_name('workbench-local-runner.py'))
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    guard.preflight(resources=False)
    guard.owned_job()
    identity = {key: os.environ[env] for key, env in [('repository', 'GITHUB_REPOSITORY'), ('commit', 'GITHUB_SHA'),
                                                    ('run', 'GITHUB_RUN_ID'), ('attempt', 'GITHUB_RUN_ATTEMPT')]}
    workspace = Path(os.environ['GITHUB_WORKSPACE'])
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace, text=True).strip() == identity['commit'],
            'ARTIFACT_CHECKOUT_MISMATCH')
    store = Store(ROOT, workspace, identity)
    name = os.environ['WORKBENCH_ARTIFACT_NAME']
    path = os.environ['WORKBENCH_ARTIFACT_PATH']
    if args.operation == 'upload':
        store.prune_expired()
        result = store.upload(name, path, int(os.environ['WORKBENCH_ARTIFACT_RETENTION_DAYS']))
    else:
        result = store.download(name, path, pattern=os.environ.get('WORKBENCH_ARTIFACT_PATTERN') == 'true')
    print(json.dumps({'operation': args.operation, **identity, **result}))
    if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(summary, 'a') as stream:
            stream.write('Durable runner evidence (SHA-256 checked): `' + json.dumps(result) + '`\n')


if __name__ == '__main__':
    main()
