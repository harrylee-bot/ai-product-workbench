#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('artifacts', Path(__file__).with_name('workbench-ci-artifacts.py'))
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.store_root = self.root / 'persistent'
        self.store_root.mkdir(mode=0o700)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        (self.workspace / 'output').mkdir()
        self.identity = {'repository': artifacts.REPOSITORY, 'commit': 'a' * 40, 'run': '123', 'attempt': '2'}
        self.store = artifacts.Store(self.store_root, self.workspace, self.identity)

    def fixture(self, name='evidence.json', content='{"result":"PASS"}'):
        file = self.workspace / 'output' / name
        file.parent.mkdir(exist_ok=True, parents=True)
        file.write_text(content)
        return file

    def upload(self, name='evidence-2', source='output/evidence.json'):
        return self.store.upload(name, source, 1)

    def test_evidence_survives_clean_checkout_and_verified_copy(self):
        file = self.fixture()
        receipt = self.upload()
        file.unlink()
        self.assertEqual(receipt['fileCount'], 1)
        self.assertEqual(len(receipt['manifestSha256']), 64)
        self.assertEqual(self.store.download('evidence-2', 'output/restored'), {'artifacts': 1, 'files': 1})
        self.assertEqual((self.workspace / 'output/restored/evidence.json').read_text(), '{"result":"PASS"}')

    def test_missing_empty_and_duplicate_upload_fail(self):
        for source in ('output/missing', 'output'):
            with self.assertRaises(RuntimeError):
                self.upload(source=source)
        self.fixture()
        self.upload()
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_EXISTS'):
            self.upload()

    def test_repository_source_attempt_and_expiry_are_bound(self):
        self.fixture()
        self.upload()
        for key, value in [('commit', 'b' * 40), ('run', '456'), ('attempt', '3')]:
            other = artifacts.Store(self.store_root, self.workspace, {**self.identity, key: value})
            with self.assertRaises(RuntimeError):
                other.download('evidence-2', 'output/invalid')
        manifest = self.store.directory / 'evidence-2/manifest.json'
        document = json.loads(manifest.read_text())
        document['expiresAt'] = 1
        manifest.write_text(json.dumps(document))
        with self.assertRaisesRegex(RuntimeError, 'EXPIRED'):
            self.store.download('evidence-2', 'output/invalid')

    def test_corrupt_added_and_missing_files_fail_verification(self):
        self.fixture()
        self.upload()
        directory = self.store.directory / 'evidence-2/files'
        file = directory / 'evidence.json'
        file.write_text('{"result":"FAIL"}')
        with self.assertRaisesRegex(RuntimeError, 'HASH_MISMATCH'):
            self.store.download('evidence-2', 'output/invalid')
        file.unlink()
        with self.assertRaisesRegex(RuntimeError, 'FILE_SET_MISMATCH'):
            self.store.download('evidence-2', 'output/invalid')
        (directory / 'unexpected.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'FILE_SET_MISMATCH'):
            self.store.download('evidence-2', 'output/invalid')

    def test_source_destination_and_store_links_cannot_escape(self):
        file = self.fixture()
        (self.workspace / 'output/link').symlink_to(file)
        with self.assertRaises(RuntimeError):
            self.upload(source='output/link')
        with self.assertRaises(RuntimeError):
            self.upload(source='output')
        with self.assertRaises(RuntimeError):
            self.upload(source='output/../output/evidence.json')
        self.upload()
        (self.workspace / 'output/escape').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.store.download('evidence-2', 'output/escape')
        manifest = self.store.directory / 'evidence-2/manifest.json'
        manifest.unlink()
        manifest.symlink_to(file)
        with self.assertRaises(RuntimeError):
            self.store.download('evidence-2', 'output/restored')

    def test_merge_requires_every_file_to_be_unique_and_never_overwrites(self):
        self.fixture('api.json')
        self.fixture('web.json')
        self.upload('image-2-api', 'output/api.json')
        self.upload('image-2-web', 'output/web.json')
        self.assertEqual(self.store.download('image-2-*', 'output/merged', pattern=True)['files'], 2)
        with self.assertRaisesRegex(RuntimeError, 'DESTINATION_EXISTS'):
            self.store.download('image-2-*', 'output/merged', pattern=True)
        self.upload('image-2-duplicate', 'output/api.json')
        with self.assertRaisesRegex(RuntimeError, 'MERGE_COLLISION'):
            self.store.download('image-2-*', 'output/other', pattern=True)

    def test_archive_and_identity_validation(self):
        self.fixture()
        for name in ('../escape', '/absolute', '*'):
            with self.assertRaises(RuntimeError):
                self.upload(name)
        for key, value in [('repository', 'other/repo'), ('commit', 'latest'), ('run', '../123'), ('attempt', '0')]:
            with self.assertRaises(RuntimeError):
                artifacts.Store(self.store_root, self.workspace, {**self.identity, key: value})
        os.chmod(self.store_root, 0o755)
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE'):
            artifacts.Store(self.store_root, self.workspace, self.identity)

    def test_retention_only_removes_expired_owned_other_attempts(self):
        self.fixture()
        self.upload()
        old = artifacts.Store(self.store_root, self.workspace, {**self.identity, 'attempt': '1'})
        old.upload('expired', 'output/evidence.json', 1)
        file = old.directory / 'expired/manifest.json'
        data = json.loads(file.read_text())
        data['expiresAt'] = 1
        file.write_text(json.dumps(data))
        self.assertEqual(self.store.prune_expired(), 1)
        self.assertFalse(file.exists())
        self.assertTrue((self.store.directory / 'evidence-2/manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
