"""Verify 2.1.0 source and lock drift fail before a runtime is prepared."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from prepare_release import prepare
from verify_source import verify

HERE = Path(__file__).resolve().parent
RELEASE = HERE / "upstream-2.1.0"
PATCH = HERE.parent / "source-patches/345f08be00c8a9495079b732a39b46aa9af1584e"


class ReleaseSourceIntegrity(unittest.TestCase):
    def test_release_archive_prepare_and_all_source_patches_round_trip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = verify(RELEASE / "source.tar.gz", RELEASE / "source-snapshot.json", root / "source")
            self.assertEqual(receipt["verifiedFiles"], 746)
            self.assertIsNone(receipt["sourceImageId"])
            destination = root / "runtime/backend"
            prepare(root / "source", destination, RELEASE, PATCH)
            self.assertFalse((destination / ".venv").exists())
            self.assertEqual((destination / "uv.lock").read_bytes(), (RELEASE / "uv.lock").read_bytes())
            command = [sys.executable, "-B", str(PATCH / "apply.py"), "--root", str(destination / "packages/harness"),
                       "--gateway-root", str(destination), "--source-commit", "345f08be00c8a9495079b732a39b46aa9af1584e"]
            subprocess.run(command, check=True, capture_output=True)
            subprocess.run([*command, "--check"], check=True, capture_output=True)

    def test_release_source_drift_never_creates_the_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            verify(RELEASE / "source.tar.gz", RELEASE / "source-snapshot.json", root / "source")
            (root / "source/app/backend/app/gateway/services.py").write_text("# changed\n")
            with self.assertRaisesRegex(ValueError, "RUNTIME_SOURCE_HASH_MISMATCH"):
                prepare(root / "source", root / "runtime", RELEASE, PATCH)
            self.assertFalse((root / "runtime").exists())

    def test_release_lock_drift_never_creates_the_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            verify(RELEASE / "source.tar.gz", RELEASE / "source-snapshot.json", root / "source")
            shutil.copytree(RELEASE, root / "release")
            with (root / "release/uv.lock").open("a") as file:
                file.write("\n# changed\n")
            with self.assertRaisesRegex(ValueError, "RUNTIME_SOURCE_HASH_MISMATCH"):
                prepare(root / "source", root / "runtime", root / "release", PATCH)
            self.assertFalse((root / "runtime").exists())

    def test_another_release_cannot_reuse_the_pinned_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            policy = json.loads((RELEASE / "source-snapshot.json").read_text())
            policy["upstreamCommit"] = "a" * 40
            (root / "snapshot.json").write_text(json.dumps(policy))
            with self.assertRaisesRegex(ValueError, "SOURCE_ARCHIVE_IDENTITY_MISMATCH"):
                verify(RELEASE / "source.tar.gz", root / "snapshot.json", root / "source")
            self.assertFalse((root / "source").exists())


if __name__ == "__main__":
    unittest.main()
