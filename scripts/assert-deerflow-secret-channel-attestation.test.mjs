import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./assert-deerflow-secret-channel-attestation.mjs", import.meta.url));
const commit = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;

test("accepts only a complete attestation pinned to the exact release", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const result = run(fixture.path);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "verified");
});

test("fails closed when a persistence or trace check is not proven", async (t) => {
  const fixture = await createFixture({ traceRedacted: false });
  t.after(fixture.cleanup);
  const result = run(fixture.path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEERFLOW_SECRET_ATTESTATION_CHECK_FAILED:traceRedacted/);
});

test("rejects evidence for another commit or image", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  let result = run(fixture.path, { commit: "c".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEERFLOW_SECRET_ATTESTATION_COMMIT_MISMATCH/);
  result = run(fixture.path, { imageDigest: `sha256:${"d".repeat(64)}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEERFLOW_SECRET_ATTESTATION_IMAGE_MISMATCH/);
});

async function createFixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-deerflow-attestation-"));
  const target = path.join(root, "attestation.json");
  const checks = {
    internalCallerOnly: true,
    toolRuntimeDelivery: true,
    runKwargsRedacted: true,
    checkpointRedacted: true,
    eventStreamRedacted: true,
    traceRedacted: true,
    ...overrides,
  };
  await writeFile(target, JSON.stringify({
    protocol: "workbench.deerflow-request-scoped-secrets-attestation.v1",
    deerflowCommit: commit,
    imageDigest,
    evidenceSha256: "e".repeat(64),
    checks,
  }), "utf8");
  return { path: target, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function run(attestationPath, overrides = {}) {
  return spawnSync(process.execPath, [
    scriptPath,
    "--attestation", attestationPath,
    "--commit", overrides.commit ?? commit,
    "--image-digest", overrides.imageDigest ?? imageDigest,
  ], { encoding: "utf8" });
}
