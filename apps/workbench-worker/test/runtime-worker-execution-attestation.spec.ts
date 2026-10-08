import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";
import {
  createRuntimeWorkerExecutionSigner,
  loadRuntimeWorkerExecutionSignerFromEnvironment,
  runtimeWorkerExecutionProtocol,
} from "../src/runtime/runtime-worker-execution-attestation.js";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

describe("Runtime worker execution attestation", () => {
  it("signs a canonical v2 receipt whose result hash and signature verify", () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createRuntimeWorkerExecutionSigner({
      privateKey: keys.privateKey,
      signerId: "runtime-worker",
      environmentId: "production",
      candidateCommit: commit,
      runtimeWorkerImageDigest: digest,
    });
    const result = signer.attest({ runId: "run-1", artifactCount: 1 }, {
      jobId: "job-1",
      runtimeAttemptId: "attempt-1",
      containerHostname: "candidate-worker-1",
      signedAtUtc: "2026-08-03T00:00:00.000Z",
    });

    expect(result.workerExecution.protocol).toBe(runtimeWorkerExecutionProtocol);
    expect(result.workerExecution.statement.resultSha256).toBe(createHash("sha256")
      .update(canonicalJson({ runId: "run-1", artifactCount: 1 })).digest("hex"));
    expect(verify(null, Buffer.from(canonicalJson({
      protocol: result.workerExecution.protocol,
      statement: result.workerExecution.statement,
    })), keys.publicKey, Buffer.from(result.workerExecution.signature.value, "base64url"))).toBe(true);
  });

  it("detects result and statement identity tampering through the signature", () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = createRuntimeWorkerExecutionSigner({
      privateKey: keys.privateKey,
      signerId: "runtime-worker",
      environmentId: "production",
      candidateCommit: commit,
      runtimeWorkerImageDigest: digest,
    });
    const receipt = signer.attest({ runId: "run-1", artifactCount: 1 }, {
      jobId: "job-1", runtimeAttemptId: "attempt-1", containerHostname: "worker-1", signedAtUtc: "2026-08-03T00:00:00.000Z",
    }).workerExecution;
    const verifyReceipt = (statement: unknown) => verify(null, Buffer.from(canonicalJson({
      protocol: receipt.protocol,
      statement,
    })), keys.publicKey, Buffer.from(receipt.signature.value, "base64url"));
    expect(verifyReceipt({ ...receipt.statement, resultSha256: "0".repeat(64) })).toBe(false);
    expect(verifyReceipt({ ...receipt.statement, jobId: "job-2" })).toBe(false);
  });

  it("rejects collisions, invalid identity, and an unexpected public key id", () => {
    const keys = generateKeyPairSync("ed25519");
    const options = {
      privateKey: keys.privateKey, signerId: "runtime-worker", environmentId: "production",
      candidateCommit: commit, runtimeWorkerImageDigest: digest,
    };
    const signer = createRuntimeWorkerExecutionSigner(options);
    expect(() => signer.attest({ workerExecution: {} }, { jobId: "job-1", runtimeAttemptId: null }))
      .toThrow("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
    expect(() => signer.attest({}, { jobId: "", runtimeAttemptId: null }))
      .toThrow("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
    expect(() => createRuntimeWorkerExecutionSigner({ ...options, expectedKeyId: `sha256:${"0".repeat(64)}` }))
      .toThrow("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
  });

  it("loads a production key only from an absolute regular non-symlink file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "worker-attestation-"));
    const keys = generateKeyPairSync("ed25519");
    const keyPath = path.join(directory, "worker.key");
    await writeFile(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    await chmod(keyPath, 0o600);
    const keyId = `sha256:${createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
    const env = {
      NODE_ENV: "production",
      WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PATH: keyPath,
      WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID: keyId,
      WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID: "runtime-worker",
      WORKBENCH_ENVIRONMENT_ID: "production",
      WORKBENCH_SOURCE_COMMIT: commit,
      WORKBENCH_RUNTIME_WORKER_IMAGE_REF: `registry.example.test/runtime@${digest}`,
    };
    await expect(loadRuntimeWorkerExecutionSignerFromEnvironment(env)).resolves.toMatchObject({ keyId });
    await expect(loadRuntimeWorkerExecutionSignerFromEnvironment({ ...env,
      WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PATH: "relative.key",
    })).rejects.toThrow("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
    const linkPath = path.join(directory, "worker-link.key");
    await symlink(keyPath, linkPath);
    await expect(loadRuntimeWorkerExecutionSignerFromEnvironment({ ...env,
      WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_PATH: linkPath,
    })).rejects.toThrow("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
  });

  it("rejects missing or invalid production material and permits only a fully absent local configuration", async () => {
    await expect(loadRuntimeWorkerExecutionSignerFromEnvironment({ NODE_ENV: "production" }))
      .rejects.toThrow("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
    await expect(loadRuntimeWorkerExecutionSignerFromEnvironment({ NODE_ENV: "test", WORKBENCH_ENVIRONMENT_ID: "test" }))
      .rejects.toThrow("RUNTIME_WORKER_EXECUTION_ATTESTATION_INVALID");
    await expect(loadRuntimeWorkerExecutionSignerFromEnvironment({ NODE_ENV: "test" }))
      .resolves.toMatchObject({ signerId: "local-ephemeral", environmentId: "local" });
  });
});
