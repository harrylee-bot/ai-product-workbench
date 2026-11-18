import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { verifyStudioRuntime } from "../test-support/studio-live-runtime.mjs";

export async function verifyPrdRuntime({
  serviceRoot,
  backendCommit,
  runtimeCommit,
  proofPath,
  gatewayUrl,
}) {
  assert.match(runtimeCommit, /^[a-f0-9]{40}$/);
  const revision = (ref, name) =>
    execFileSync("git", ["rev-parse", ref + ":" + name], {
      cwd: serviceRoot,
      encoding: "utf8",
    }).trim();
  const inputs = {};
  for (const name of [
    "integrations/deerflow",
    "integrations/deerflow/Dockerfile",
    "deploy/deerflow-extensions.production.json",
  ]) {
    inputs[name] = revision(runtimeCommit, name);
    assert.equal(
      inputs[name],
      revision(backendCommit, name),
      "Runtime source differs from the fixed backend at " + name,
    );
  }
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  const receipt = await verifyStudioRuntime(
    serviceRoot,
    runtimeCommit,
    proofPath,
  );
  const docker = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const actual = JSON.parse(
    docker([
      "inspect",
      "--format",
      '{"image":{{json .Image}},"running":{{json .State.Running}},"bindings":{{json .NetworkSettings.Ports}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}',
      receipt.containerId,
    ]),
  );
  assert.equal(actual.running, true);
  assert.equal(actual.image, receipt.imageId);
  assert.equal(actual.revision, runtimeCommit);
  const gateway = new URL(gatewayUrl);
  assert.ok(
    actual.bindings["8001/tcp"].some(
      (item) =>
        item.HostIp === gateway.hostname && item.HostPort === gateway.port,
    ),
    "Proof must identify the serving gateway",
  );
  const hashes = docker([
    "exec",
    receipt.containerId,
    "sha256sum",
    ...proof.files.map((item) => item.path),
  ]).split("\n");
  assert.equal(hashes.length, proof.files.length);
  hashes.forEach((line, index) =>
    assert.equal(
      line,
      proof.files[index].sha256 + "  " + proof.files[index].path,
    ),
  );
  const dockerfile = execFileSync(
    "git",
    ["show", runtimeCommit + ":integrations/deerflow/Dockerfile"],
    { cwd: serviceRoot, encoding: "utf8" },
  );
  const patchCommit = dockerfile.match(
    /^COPY integrations\/deerflow\/source-patches\/([a-f0-9]{40})\//m,
  )?.[1];
  assert.ok(patchCommit);
  docker([
    "exec",
    receipt.containerId,
    "python3",
    "/opt/workbench/deerflow/source-patch/apply.py",
    "--root",
    "/app/backend/packages/harness",
    "--gateway-root",
    "/app/backend",
    "--source-commit",
    patchCommit,
    "--check",
  ]);
  return {
    ...receipt,
    backendCommit,
    runtimeCommit,
    inputs,
    checkedInstalledPatch: patchCommit,
  };
}
