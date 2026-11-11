import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./assert-deerflow-production-deployment.mjs", import.meta.url));

test("the standalone DeerFlow runtime keeps the audited image, mount, and extension boundary", () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DeerFlow production deployment contract passed/);
});

test("the deployment contract binds the fixed DeerFlow source patch commit", () => {
  const accepted = spawnSync(process.execPath, [
    scriptPath,
    "--expected-commit",
    "345f08be00c8a9495079b732a39b46aa9af1584e",
  ], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);

  const rejected = spawnSync(process.execPath, [
    scriptPath,
    "--expected-commit",
    "a".repeat(40),
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /expected commit must match the audited DeerFlow patch commit/u);
});

test("the pinned base recovery rejects source drift and verifies Docker-save OCI identities", () => {
  const suite = fileURLToPath(new URL("../integrations/deerflow/base-recovery/test_recovery.py", import.meta.url));
  const result = spawnSync("python3", ["-B", suite], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 10 tests/u);
  assert.match(result.stderr, /\bOK\b/u);
});
