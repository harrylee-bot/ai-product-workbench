#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProductionTrustPolicy,
  resolveReceiptAuthority,
} from "./workbench-production-trust-policy.mjs";

const SCOPE_ID = "production-runtime.worker-execution";
const KEY_ID = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_PRIVATE_KEY_BYTES = 64 * 1024;

export async function assertRuntimeWorkerExecutionIdentity(options) {
  const privateKeyPath = absolutePath(options?.privateKeyPath);
  const trustPolicyPath = absolutePath(options?.trustPolicyPath);
  const expectedKeyId = exact(options?.expectedKeyId, KEY_ID);
  const signerId = exact(options?.signerId, IDENTIFIER);
  const environmentId = exact(options?.environmentId, IDENTIFIER);
  const trustPolicySha256 = exact(options?.trustPolicySha256, SHA256);
  const expectedPrivateKeyUid = numericId(options?.expectedPrivateKeyUid);
  const expectedPrivateKeyGid = numericId(options?.expectedPrivateKeyGid);

  const metadata = await lstat(privateKeyPath).catch(() => null);
  if (
    !metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 1
    || metadata.size > MAXIMUM_PRIVATE_KEY_BYTES
    || (metadata.mode & 0o777) !== 0o400
    || metadata.uid !== expectedPrivateKeyUid
    || metadata.gid !== expectedPrivateKeyGid
  ) throw invalidIdentity();
  let privateKey;
  try {
    privateKey = createPrivateKey(await readFile(privateKeyPath));
  } catch {
    throw invalidIdentity();
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw invalidIdentity();
  }
  const publicKeySpki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const derivedKeyId = `sha256:${createHash("sha256").update(publicKeySpki).digest("hex")}`;
  if (derivedKeyId !== expectedKeyId) throw invalidIdentity();

  let trustPolicy;
  try {
    trustPolicy = await loadProductionTrustPolicy({
      policyPath: trustPolicyPath,
      expectedSha256: trustPolicySha256,
    });
  } catch {
    throw invalidIdentity();
  }
  if (
    trustPolicy.environmentId !== environmentId
    || trustPolicy.approvalAuthorities.some(({ keyId }) => keyId === expectedKeyId)
    || trustPolicy.receiptAuthorities.some(({ scopeId, keyId }) => (
      scopeId !== SCOPE_ID && keyId === expectedKeyId
    ))
  ) throw invalidIdentity();
  let authority;
  try {
    authority = resolveReceiptAuthority(trustPolicy, {
      scopeId: SCOPE_ID,
      keyId: expectedKeyId,
      signedAt: new Date(),
    });
  } catch {
    throw invalidIdentity();
  }
  if (authority.signerId !== signerId) throw invalidIdentity();
  const trustedSpki = authority.key.publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.from(trustedSpki).equals(Buffer.from(publicKeySpki))) throw invalidIdentity();
  return Object.freeze({
    environmentId,
    keyId: expectedKeyId,
    scopeId: SCOPE_ID,
    signerId,
    trustPolicySha256,
  });
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--private-key", "privateKeyPath"],
    ["--expected-key-id", "expectedKeyId"],
    ["--signer-id", "signerId"],
    ["--environment-id", "environmentId"],
    ["--trust-policy", "trustPolicyPath"],
    ["--trust-policy-sha256", "trustPolicySha256"],
    ["--expected-private-key-uid", "expectedPrivateKeyUid"],
    ["--expected-private-key-gid", "expectedPrivateKeyGid"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const key = names.get(name);
    if (!key || Object.prototype.hasOwnProperty.call(options, key)) throw invalidIdentity();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw invalidIdentity();
    options[key] = value;
    index += 1;
  }
  if (Object.keys(options).length !== names.size) throw invalidIdentity();
  return options;
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 4_096) {
    throw invalidIdentity();
  }
  return value;
}

function exact(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw invalidIdentity();
  return value;
}

function numericId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/u.test(value)) throw invalidIdentity();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 4_294_967_294) throw invalidIdentity();
  return parsed;
}

function invalidIdentity() {
  return new Error("RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await assertRuntimeWorkerExecutionIdentity(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("runtime worker execution identity: RUNTIME_WORKER_EXECUTION_IDENTITY_INVALID\n");
    process.exitCode = 1;
  }
}
