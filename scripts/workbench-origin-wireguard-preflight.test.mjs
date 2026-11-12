import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const preflight = resolve("deploy/edge/workbench-origin-wireguard-preflight.sh");

test("Origin WireGuard preflight accepts only the Edge peer /32", () => {
  const result = runPreflight("AllowedIPs = 10.88.0.1/32\n");
  assert.equal(result.status, 0, result.stderr);
});

test("Origin WireGuard preflight rejects a default route", () => {
  const result = runPreflight("AllowedIPs = 0.0.0.0/0\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not route the public Internet/u);
});

test("Origin WireGuard preflight rejects an extra routed network", () => {
  const result = runPreflight("AllowedIPs = 10.88.0.1/32, 10.0.0.0/8\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AllowedIPs must equal the Edge \/32/u);
});

function runPreflight(allowedIps) {
  const fixture = mkdtempSync(join(tmpdir(), "workbench-origin-wireguard-"));
  const envFile = join(fixture, "workbench.env");
  const wireguardConfig = join(fixture, "wg0.conf");
  writeFileSync(envFile, [
    "WORKBENCH_EDGE_WIREGUARD_IP=10.88.0.1",
    "WORKBENCH_ORIGIN_WIREGUARD_IP=10.88.0.2",
    "WORKBENCH_EDGE_WIREGUARD_ENDPOINT=8.130.160.177:51820",
    "",
  ].join("\n"));
  writeFileSync(wireguardConfig, [
    "[Interface]",
    "Address = 10.88.0.2/30",
    `PrivateKey = ${"A".repeat(43)}=`,
    "[Peer]",
    `PublicKey = ${"B".repeat(43)}=`,
    "Endpoint = 8.130.160.177:51820",
    allowedIps.trimEnd(),
    "",
  ].join("\n"));

  try {
    return spawnSync("sh", [preflight], {
      encoding: "utf8",
      env: {
        ...process.env,
        WORKBENCH_ENV_FILE: envFile,
        WORKBENCH_ORIGIN_WIREGUARD_CONFIG: wireguardConfig,
      },
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
