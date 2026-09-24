#!/usr/bin/env python3
"""Read-only filesystem capacity checks; never deletes data or controls services."""

import argparse
import json
import math
import os
from pathlib import Path
import tempfile
import time

GIB = 1024 ** 3


def measure(path, statvfs=os.statvfs):
    try:
        stat = statvfs(path)
        used = (stat.f_blocks - stat.f_bfree) * stat.f_frsize
        available = stat.f_bavail * stat.f_frsize
        denominator = used + available
        if denominator <= 0:
            raise OSError("Invalid filesystem size")
        used_percent = 100 * used / denominator
        inode_percent = 100 * (stat.f_files - stat.f_favail) / stat.f_files if stat.f_files else 0
        severity = 0
        if used_percent >= 80 or inode_percent >= 80 or available < 10 * GIB:
            severity = 1
        if used_percent >= 90 or inode_percent >= 90 or available < 5 * GIB:
            severity = 2
        return {
            "path": path, "availableBytes": available,
            "usedPercent": round(used_percent, 2), "inodeUsedPercent": round(inode_percent, 2),
            "severity": severity,
        }
    except OSError as error:
        return {"path": path, "severity": 2, "error": "STATVFS_FAILED", "errno": error.errno}


def atomic_write(path, text):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish(directory, snapshot):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    previous = {}
    try:
        previous = json.loads((directory / "status.json").read_text())
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError):
        pass
    previous_report = previous.get("lastReportedAt")
    if not isinstance(previous_report, (int, float)) or not math.isfinite(previous_report):
        previous_report = 0
    report = (
        snapshot["severity"] != previous.get("severity")
        or (snapshot["severity"] > 0 and snapshot["checkedAt"] - previous_report >= 86400)
    )
    snapshot["lastReportedAt"] = snapshot["checkedAt"] if report else previous_report
    lines = [
        f'workbench_capacity_checked_at_seconds {snapshot["checkedAt"]}',
        f'workbench_capacity_severity {snapshot["severity"]}',
    ]
    for sample in snapshot["filesystems"]:
        label = json.dumps(sample["path"])
        lines.append(f'workbench_filesystem_capacity_severity{{path={label}}} {sample["severity"]}')
        if "availableBytes" in sample:
            lines.append(f'workbench_filesystem_available_bytes{{path={label}}} {sample["availableBytes"]}')
    atomic_write(directory / "capacity.prom", "\n".join(lines) + "\n")
    atomic_write(directory / "status.json", json.dumps(snapshot, sort_keys=True) + "\n")
    if report:
        print(json.dumps(snapshot, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", action="append")
    parser.add_argument("--state-dir", type=Path)
    options = parser.parse_args()
    samples = [measure(path) for path in options.path or ["/", "/home/data"]]
    snapshot = {"checkedAt": int(time.time()), "severity": max(s["severity"] for s in samples), "filesystems": samples}
    if options.state_dir:
        publish(options.state_dir, snapshot)
    else:
        print(json.dumps(snapshot, sort_keys=True))
    return snapshot["severity"]


if __name__ == "__main__":
    raise SystemExit(main())
