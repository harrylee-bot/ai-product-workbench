import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location(
    "capacity", Path(__file__).resolve().parents[1] / "deploy/workbench-capacity-check.py",
)
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)


class CapacityTest(unittest.TestCase):
    def test_percentage_and_free_space_thresholds(self):
        for used, available, expected in [(70, 30, 0), (80, 20, 1), (90, 10, 2), (1, 9, 1), (1, 4, 2)]:
            with self.subTest(used=used, available=available):
                sample = SimpleNamespace(
                    f_blocks=used + available + 5, f_bfree=available + 5, f_bavail=available,
                    f_frsize=capacity.GIB, f_files=100, f_favail=80,
                )
                self.assertEqual(capacity.measure("/", lambda _: sample)["severity"], expected)

    def test_inode_exhaustion_and_missing_mount_fail_closed(self):
        sample = SimpleNamespace(f_blocks=100, f_bfree=60, f_bavail=60, f_frsize=capacity.GIB, f_files=100, f_favail=5)
        self.assertEqual(capacity.measure("/", lambda _: sample)["severity"], 2)

        def unavailable(_):
            raise FileNotFoundError(2, "missing")

        self.assertEqual(capacity.measure("/missing", unavailable)["error"], "STATVFS_FAILED")

    def test_bounded_state_and_transition_only_journal(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            def snapshot(at, level):
                return {"checkedAt": at, "severity": level, "filesystems": [{"path": "/", "severity": level}]}
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                capacity.publish(directory, snapshot(100, 0))
                capacity.publish(directory, snapshot(400, 0))
                capacity.publish(directory, snapshot(700, 1))
                capacity.publish(directory, snapshot(1000, 1))
                capacity.publish(directory, snapshot(87100, 1))
                capacity.publish(directory, snapshot(87400, 0))
            self.assertEqual(len(output.getvalue().splitlines()), 4)
            self.assertEqual(sorted(p.name for p in directory.iterdir()), ["capacity.prom", "status.json"])
            self.assertEqual(json.loads((directory / "status.json").read_text())["severity"], 0)


if __name__ == "__main__":
    unittest.main()
