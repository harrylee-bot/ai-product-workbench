import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertRuntimeWorkerExecutionIdentity } from "./assert-runtime-worker-execution-identity.mjs";

test("binds the private worker key to its unique external trust-policy authority", async () => {
  const fixture = await identityFixture();
  await assert.doesNotReject(() => assertRuntimeWorkerExecutionIdentity(fixture.options));
  await assert.rejects(
    () => assertRuntimeWorkerExecutionIdentity({ ...fixture.options, signerId: "other-signer" }),
    /RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID/u,
  );
  await assert.rejects(
    () => assertRuntimeWorkerExecutionIdentity({
      ...fixture.options,
      expectedKeyId: `sha256:${"0".repeat(64)}`,
    }),
    /RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID/u,
  );
});

test("rejects a shared receipt key, policy drift, and exposed private-key permissions", async () => {
  const fixture = await identityFixture();
  fixture.policy.receiptAuthorities.push({
    scopeId: "production.other-receipt",
    signerId: "other-signer",
    keyId: fixture.options.expectedKeyId,
  });
  const policySource = `${JSON.stringify(fixture.policy, null, 2)}\n`;
  await writeFile(fixture.options.trustPolicyPath, policySource);
  const sharedKeyOptions = {
    ...fixture.options,
    trustPolicySha256: createHash("sha256").update(policySource).digest("hex"),
  };
  await assert.rejects(
    () => assertRuntimeWorkerExecutionIdentity(sharedKeyOptions),
    /RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID/u,
  );
  await assert.rejects(
    () => assertRuntimeWorkerExecutionIdentity({
      ...fixture.options,
      trustPolicySha256: "0".repeat(64),
    }),
    /RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID/u,
  );
  fixture.policy.receiptAuthorities.pop();
  await writeFile(
    fixture.options.trustPolicyPath,
    `${JSON.stringify(fixture.policy, null, 2)}\n`,
  );
  await chmod(fixture.options.privateKeyPath, 0o644);
  await assert.rejects(
    () => assertRuntimeWorkerExecutionIdentity(fixture.options),
    /RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID/u,
  );
});

test("rejects a worker receipt key reused by a production approval authority", async () => {
  const fixture = await identityFixture();
  fixture.policy.approvalAuthorities[0].keyId = fixture.options.expectedKeyId;
  const policySource = `${JSON.stringify(fixture.policy, null, 2)}\n`;
  await writeFile(fixture.options.trustPolicyPath, policySource);

  await assert.rejects(
    () => assertRuntimeWorkerExecutionIdentity({
      ...fixture.options,
      trustPolicySha256: createHash("sha256").update(policySource).digest("hex"),
    }),
    /RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID/u,
  );
});

async function identityFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-worker-identity-"));
  const signers = Array.from({ length: 5 }, () => signer());
  const [worker, security, data, operations, release] = signers;
  const privateKeyPath = path.join(directory, "worker.key");
  const trustPolicyPath = path.join(directory, "trust-policy.json");
  await writeFile(privateKeyPath, worker.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o400,
  });
  const privateKeyMetadata = await stat(privateKeyPath);
  const policy = {
    schemaVersion: "workbench.production-trust-policy.v1",
    environmentId: "workbench-production",
    keys: signers.map(({ record }) => record),
    approvalAuthorities: [
      ["Security", "security-approver", security.keyId],
      ["Data", "data-approver", data.keyId],
      ["Operations", "operations-approver", operations.keyId],
      ["Release", "release-approver", release.keyId],
    ].map(([role, approverId, keyId]) => ({ role, approverId, keyId })),
    receiptAuthorities: [{
      scopeId: "production-runtime.worker-execution",
      signerId: "runtime-worker-production",
      keyId: worker.keyId,
    }],
  };
  const policySource = `${JSON.stringify(policy, null, 2)}\n`;
  await writeFile(trustPolicyPath, policySource);
  return {
    policy,
    options: {
      privateKeyPath,
      expectedKeyId: worker.keyId,
      signerId: "runtime-worker-production",
      environmentId: "workbench-production",
      trustPolicyPath,
      trustPolicySha256: createHash("sha256").update(policySource).digest("hex"),
      expectedPrivateKeyUid: String(privateKeyMetadata.uid),
      expectedPrivateKeyGid: String(privateKeyMetadata.gid),
    },
  };
}

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sha256 = createHash("sha256").update(spki).digest("hex");
  return {
    privateKey,
    keyId: `sha256:${sha256}`,
    record: {
      keyId: `sha256:${sha256}`,
      algorithm: "Ed25519",
      publicKeySpkiBase64: spki.toString("base64"),
      publicKeySha256: sha256,
      validFromUtc: "2026-01-01T00:00:00.000Z",
      validUntilUtc: "2030-01-01T00:00:00.000Z",
      revokedAtUtc: null,
    },
  };
}
