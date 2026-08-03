import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareRuntimeWorkerExecutionPrivateKey } from "./prepare-runtime-worker-execution-private-key.mjs";

test("atomically prepares a private key for the configured non-root Runtime Worker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-worker-private-key-"));
  const privateKeyPath = path.join(directory, "worker.key");
  const identity = executionIdentity();
  await writeFile(privateKeyPath, identity.privateKey, { mode: 0o600 });
  const owner = await stat(privateKeyPath);

  await assert.doesNotReject(() => prepareRuntimeWorkerExecutionPrivateKey({
    privateKeyPath,
    uid: owner.uid,
    gid: owner.gid,
    expectedKeyId: identity.keyId,
  }));
  const prepared = await stat(privateKeyPath);
  assert.equal(prepared.uid, owner.uid);
  assert.equal(prepared.gid, owner.gid);
  assert.equal(prepared.mode & 0o777, 0o400);
});

test("rejects symlinks, relative paths, and invalid runtime identities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-worker-private-key-"));
  const privateKeyPath = path.join(directory, "worker.key");
  const linkPath = path.join(directory, "worker-link.key");
  const identity = executionIdentity();
  await writeFile(privateKeyPath, identity.privateKey, { mode: 0o600 });
  await symlink(privateKeyPath, linkPath);
  const owner = await stat(privateKeyPath);

  for (const options of [
    { privateKeyPath: linkPath, uid: owner.uid, gid: owner.gid, expectedKeyId: identity.keyId },
    { privateKeyPath: "worker.key", uid: owner.uid, gid: owner.gid, expectedKeyId: identity.keyId },
    { privateKeyPath, uid: 0, gid: owner.gid, expectedKeyId: identity.keyId },
    { privateKeyPath, uid: owner.uid, gid: "not-a-gid", expectedKeyId: identity.keyId },
    { privateKeyPath, uid: owner.uid, gid: owner.gid, expectedKeyId: `sha256:${"0".repeat(64)}` },
  ]) {
    await assert.rejects(
      () => prepareRuntimeWorkerExecutionPrivateKey(options),
      /RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_INVALID/u,
    );
  }
});

test("does not mutate an arbitrary regular file before authenticating its signed key ID", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-worker-private-key-"));
  const targetPath = path.join(directory, "not-a-private-key");
  await writeFile(targetPath, "ordinary-host-file\n", { mode: 0o640 });
  const before = await stat(targetPath);

  await assert.rejects(
    () => prepareRuntimeWorkerExecutionPrivateKey({
      privateKeyPath: targetPath,
      uid: before.uid,
      gid: before.gid,
      expectedKeyId: `sha256:${"0".repeat(64)}`,
    }),
    /RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_INVALID/u,
  );

  const after = await stat(targetPath);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
});

function executionIdentity() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: `sha256:${createHash("sha256").update(publicKey).digest("hex")}`,
  };
}
