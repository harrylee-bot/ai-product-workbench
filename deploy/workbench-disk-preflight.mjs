#!/usr/bin/env node
import { statfsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GiB = 1024 ** 3;

// Read-only: low space must stop a build, never trigger an image/volume prune.
export function checkDiskSpace(checks, statfs = statfsSync) {
  return checks.map(({ path, minimumBytes }) => {
    const disk = statfs(path, { bigint: true });
    const availableBytes = disk.bavail * disk.bsize;
    if (availableBytes < BigInt(minimumBytes)) {
      throw new Error(`insufficient disk space at ${path}: ${availableBytes} bytes available, ${minimumBytes} required`);
    }
    if (disk.files > 0n && disk.ffree * 100n < disk.files) {
      throw new Error(`insufficient free inodes at ${path}: less than 1% remain`);
    }
    return { path, availableBytes: String(availableBytes), minimumBytes };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [releaseDir, ...extra] = process.argv.slice(2);
    if (!releaseDir?.startsWith("/") || extra.length) {
      throw new Error("usage: node workbench-disk-preflight.mjs /absolute/release/directory");
    }
    const checks = ["/", "/var/lib/docker", "/var/lib/containerd"]
      .map(path => ({ path, minimumBytes: 20 * GiB }));
    checks.push({ path: releaseDir, minimumBytes: 5 * GiB });
    console.log(JSON.stringify({ diskPreflight: "passed", checks: checkDiskSpace(checks) }));
  } catch (error) {
    console.error(`Workbench disk preflight: ${error.message}`);
    process.exitCode = 65;
  }
}
