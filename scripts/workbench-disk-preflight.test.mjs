import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkDiskSpace } from "../deploy/workbench-disk-preflight.mjs";

const GiB = 1024 ** 3;
const healthy = { bavail: 20n * 1024n ** 3n / 4096n, bsize: 4096n, files: 10000n, ffree: 100n };
const checks = [{ path: "/image-store", minimumBytes: 20 * GiB }];

test("accepts the exact byte and inode reserve boundaries", () => {
  assert.deepEqual(checkDiskSpace(checks, () => healthy), [
    { ...checks[0], availableBytes: String(20 * GiB) },
  ]);
});

test("uses unprivileged available space, not root-reserved free blocks", () => {
  assert.throws(() => checkDiskSpace(checks, () => ({ ...healthy, bavail: healthy.bavail - 1n, bfree: healthy.bavail * 2n })), /insufficient disk space/);
});

test("checks the source filesystem independently of the image filesystem", () => {
  assert.throws(() => checkDiskSpace([...checks, { path: "/releases", minimumBytes: 5 * GiB }], path =>
    path === "/releases" ? { ...healthy, bavail: 1n } : healthy), /at \/releases/);
});

test("rejects inode exhaustion and unreadable storage", () => {
  assert.throws(() => checkDiskSpace(checks, () => ({ ...healthy, ffree: 99n })), /inodes/);
  assert.throws(() => checkDiskSpace(checks, () => { throw new Error("storage unavailable"); }), /storage unavailable/);
});

test("CLI rejects missing or relative release directories", () => {
  for (const args of [[], ["relative"], ["/tmp", "unexpected"]]) {
    const result = spawnSync(process.execPath, ["deploy/workbench-disk-preflight.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 65, result.stderr);
    assert.match(result.stderr, /usage:/);
  }
});

test("direct release checks disk before installing dependencies and bounded builds check again", () => {
  const direct = readFileSync("deploy/workbench-direct-release.sh", "utf8");
  const directGate = direct.indexOf('node "$source_root/deploy/workbench-disk-preflight.mjs"');
  assert(directGate > 0 && directGate < direct.indexOf("npm ci"));
  const build = readFileSync("deploy/workbench-build-resources.sh", "utf8");
  const buildGate = build.indexOf('node "${BASH_SOURCE[0]%/*}/workbench-disk-preflight.mjs"');
  assert(buildGate > 0 && buildGate < build.indexOf("docker buildx create"));
});
