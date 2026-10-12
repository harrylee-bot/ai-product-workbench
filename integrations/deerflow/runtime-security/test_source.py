"""Fail-closed tests for the source archive and current-code round trip."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import tarfile
import unittest

from prepare_source import prepare, verify_inventory
from verify_source import verify


HERE = Path(__file__).resolve().parent
RECOVERY = HERE.parent / "base-recovery"
PATCH = HERE.parent / "source-patches/7a6c4a994a86583d2a3c056ee9d0f157d4f030c2"


class SourceIntegrity(unittest.TestCase):
    def test_current_archive_and_source_patch_round_trip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            receipt = verify(HERE / "source.tar.gz", HERE / "source-snapshot.json", source)
            self.assertEqual(receipt["verifiedFiles"], 340)
            destination = root / "runtime/backend"
            prepare(source, destination, RECOVERY, PATCH)
            policy = json.loads((RECOVERY / "manifest.json").read_text())
            spec = importlib.util.spec_from_file_location("source_recovery_test", RECOVERY / "recover.py")
            recovery = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(recovery)
            candidate = recovery.load_candidate(PATCH, policy)
            for item in policy["restoreSources"]:
                value = (destination / Path(item["path"]).relative_to("/app/backend")).read_bytes()
                recovery.verify_candidate_round_trip(value, recovery.source_entry(candidate, item),
                                                     item["manifestGroup"] == "agent")
            for filename in policy["preservedSourcePaths"]:
                self.assertEqual((destination / Path(filename).relative_to("/app/backend")).read_bytes(),
                                 (source / filename.lstrip("/")).read_bytes())
            self.assertFalse((destination / ".venv").exists())
            self.assertEqual((destination / "uv.lock").read_bytes(), (HERE / "uv.lock").read_bytes())

    def test_archive_byte_drift_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "drift.tar.gz"
            archive.write_bytes((HERE / "source.tar.gz").read_bytes() + b"drift")
            destination = Path(temporary) / "source"
            with self.assertRaisesRegex(ValueError, "SOURCE_ARCHIVE_HASH_MISMATCH"):
                verify(archive, HERE / "source-snapshot.json", destination)
            self.assertFalse(destination.exists())

    def test_links_and_parent_traversal_are_rejected_even_with_matching_archive_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for filename, symbolic in [("app/backend/app/link", True), ("../escape", False)]:
                with self.subTest(filename=filename):
                    archive = root / "unsafe.tar.gz"
                    with tarfile.open(archive, "w:gz") as bundle:
                        entry = tarfile.TarInfo(filename)
                        if symbolic:
                            entry.type = tarfile.SYMTYPE
                            entry.linkname = "/etc/passwd"
                            bundle.addfile(entry)
                        else:
                            entry.size = 1
                            bundle.addfile(entry, io.BytesIO(b"x"))
                    policy = json.loads((HERE / "source-snapshot.json").read_text())
                    policy["archiveSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
                    manifest = root / "manifest.json"
                    manifest.write_text(json.dumps(policy))
                    with self.assertRaisesRegex(ValueError, "SOURCE_ARCHIVE_UNSAFE_ENTRY"):
                        verify(archive, manifest)

    def test_unlisted_source_code_cannot_enter_the_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            verify(HERE / "source.tar.gz", HERE / "source-snapshot.json", source)
            (source / "app/backend/app/unlisted.py").write_text("raise RuntimeError('unlisted')\n")
            policy = json.loads((HERE / "source-snapshot.json").read_text())
            with self.assertRaisesRegex(ValueError, "RUNTIME_SOURCE_INVENTORY_MISMATCH"):
                verify_inventory(source / "app/backend", policy)


if __name__ == "__main__":
    unittest.main()
