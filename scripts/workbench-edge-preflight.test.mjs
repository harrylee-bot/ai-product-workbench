import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const preflight = resolve("deploy/edge/workbench-edge-preflight.sh");
const edgeDir = resolve("deploy/edge");

test("Edge preflight accepts the fixed WireGuard origin contract", () => {
  const result = runPreflight();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workbench edge preflight: ok/u);
});

test("Edge preflight rejects a public WireGuard peer address", () => {
  const result = runPreflight({ WORKBENCH_EDGE_WIREGUARD_IP: "8.130.160.177" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an RFC1918 IPv4 address/u);
});

test("Edge preflight rejects a weak origin authentication secret", () => {
  const result = runPreflight({ WORKBENCH_EDGE_ORIGIN_AUTH_SECRET: "too-short" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain at least 32 random bytes/u);
});

test("Edge preflight rejects a WireGuard default route", () => {
  const result = runPreflight({}, "AllowedIPs = 0.0.0.0/0\nAllowedIPs = 10.88.0.2/32\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not route the public Internet/u);
});

function runPreflight(overrides = {}, peerSource = "AllowedIPs = 10.88.0.2/32\n") {
  const fixture = mkdtempSync(join(tmpdir(), "workbench-edge-preflight-"));
  const envFile = join(fixture, "workbench-edge.env");
  const wireguardConfig = join(fixture, "wg0.conf");
  const binDir = join(fixture, "bin");
  mkdirSync(binDir);
  const caddy = join(binDir, "caddy");
  writeFileSync(caddy, "#!/bin/sh\nexit 0\n");
  chmodSync(caddy, 0o755);

  const environment = {
    WORKBENCH_WEB_HOSTNAME: "aionbench.com",
    WORKBENCH_PREVIEW_HOSTNAME: "preview.aionbench.com",
    WORKBENCH_EDGE_WIREGUARD_IP: "10.88.0.1",
    WORKBENCH_ORIGIN_WIREGUARD_IP: "10.88.0.2",
    WORKBENCH_EDGE_WIREGUARD_ENDPOINT: "8.130.160.177:51820",
    WORKBENCH_ORIGIN_HTTP_PORT: "8080",
    WORKBENCH_EDGE_ORIGIN_AUTH_SECRET: "A".repeat(64),
    ...overrides,
  };
  writeFileSync(
    envFile,
    `${Object.entries(environment).map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
  );
  writeFileSync(wireguardConfig, [
    "[Interface]",
    "Address = 10.88.0.1/30",
    "ListenPort = 51820",
    `PrivateKey = ${"A".repeat(43)}=`,
    "[Peer]",
    `PublicKey = ${"B".repeat(43)}=`,
    peerSource.trimEnd(),
    "",
  ].join("\n"));

  try {
    return spawnSync("sh", [preflight], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        WORKBENCH_EDGE_DIR: edgeDir,
        WORKBENCH_EDGE_ENV_FILE: envFile,
        WORKBENCH_EDGE_WIREGUARD_CONFIG: wireguardConfig,
      },
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
