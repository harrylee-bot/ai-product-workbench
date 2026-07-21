import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const PRODUCTION_TRUST_POLICY_SCHEMA = "workbench.production-trust-policy.v1";
export const PRODUCTION_APPROVAL_ROLES = Object.freeze(["Security", "Data", "Operations", "Release"]);

const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_ID = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export class ProductionTrustPolicyError extends Error {
  constructor(findings) {
    const normalized = [...new Set(findings)].sort();
    super(`Production trust policy validation failed (${normalized.length} finding${normalized.length === 1 ? "" : "s"}):\n${normalized.map((finding) => `- ${finding}`).join("\n")}`);
    this.name = "ProductionTrustPolicyError";
    this.findings = normalized;
  }
}

export async function loadProductionTrustPolicy({ policyPath, expectedSha256 } = {}) {
  const findings = [];
  const resolvedPath = path.resolve(policyPath ?? "");
  if (!policyPath) findings.push("policyPath is required");
  if (expectedSha256 !== undefined && !SHA256.test(expectedSha256)) findings.push("expected trust policy SHA-256 is invalid");
  if (findings.length > 0) throw new ProductionTrustPolicyError(findings);

  let raw;
  try {
    const stat = await lstat(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) findings.push("trust policy must be a regular non-symlink file");
    raw = await readFile(resolvedPath);
  } catch (error) {
    findings.push(`cannot read trust policy: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || findings.length > 0) throw new ProductionTrustPolicyError(findings);
  const sha256 = sha256Bytes(raw);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) findings.push("trust policy SHA-256 mismatch");

  let document;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    findings.push(`trust policy JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(document)) findings.push("trust policy must be a JSON object");
  if (findings.length > 0) throw new ProductionTrustPolicyError(findings);

  exactKeys(document, ["schemaVersion", "environmentId", "keys", "approvalAuthorities", "receiptAuthorities"], "trustPolicy", findings);
  if (document.schemaVersion !== PRODUCTION_TRUST_POLICY_SCHEMA) {
    findings.push(`trustPolicy.schemaVersion must be ${PRODUCTION_TRUST_POLICY_SCHEMA}`);
  }
  if (!IDENTIFIER.test(document.environmentId ?? "")) findings.push("trustPolicy.environmentId is invalid");
  const keys = validateKeys(document.keys, findings);
  const approvalAuthorities = validateApprovalAuthorities(document.approvalAuthorities, keys, findings);
  const receiptAuthorities = validateReceiptAuthorities(document.receiptAuthorities, keys, findings);
  if (findings.length > 0) throw new ProductionTrustPolicyError(findings);
  return {
    path: resolvedPath,
    sha256,
    environmentId: document.environmentId,
    keys,
    approvalAuthorities,
    receiptAuthorities,
  };
}

export function resolveApprovalAuthority(policy, { role, approverId, keyId, signedAt }) {
  const matches = policy.approvalAuthorities.filter((authority) => (
    authority.role === role && authority.approverId === approverId && authority.keyId === keyId
  ));
  if (matches.length !== 1) throw new Error("approval signer is not uniquely authorized by the external trust policy");
  assertKeyValid(policy.keys.get(keyId), signedAt, "approval signer");
  return { ...matches[0], key: policy.keys.get(keyId) };
}

export function resolveReceiptAuthority(policy, { scopeId, keyId, signedAt }) {
  const matches = policy.receiptAuthorities.filter((authority) => authority.scopeId === scopeId);
  if (matches.length !== 1) throw new Error(`receipt scope ${scopeId} is not uniquely assigned by the external trust policy`);
  const authority = matches[0];
  if (authority.keyId !== keyId) throw new Error(`receipt scope ${scopeId} is signed by an unauthorized key`);
  assertKeyValid(policy.keys.get(keyId), signedAt, `receipt scope ${scopeId}`);
  return { ...authority, key: policy.keys.get(keyId) };
}

export function verifyTrustedEd25519Signature({ key, payload, signature }) {
  if (!key?.publicKey) throw new Error("trusted Ed25519 public key is unavailable");
  if (!isCanonicalBase64Url(signature)) throw new Error("signature must be canonical base64url");
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== 64) throw new Error("Ed25519 signature must decode to 64 bytes");
  return verifySignature(null, Buffer.from(payload), key.publicKey, signatureBytes);
}

function validateKeys(value, findings) {
  const keys = new Map();
  const fingerprints = new Set();
  if (!Array.isArray(value) || value.length === 0) {
    findings.push("trustPolicy.keys must be a non-empty array");
    return keys;
  }
  for (const [index, entry] of value.entries()) {
    const label = `trustPolicy.keys[${index}]`;
    exactKeys(entry, [
      "keyId", "algorithm", "publicKeySpkiBase64", "publicKeySha256",
      "validFromUtc", "validUntilUtc", "revokedAtUtc",
    ], label, findings);
    if (!isObject(entry)) continue;
    if (!KEY_ID.test(entry.keyId ?? "")) findings.push(`${label}.keyId is invalid`);
    if (keys.has(entry.keyId)) findings.push(`${label}.keyId is duplicated`);
    if (entry.algorithm !== "Ed25519") findings.push(`${label}.algorithm must be Ed25519`);
    if (!isCanonicalBase64(entry.publicKeySpkiBase64)) findings.push(`${label}.publicKeySpkiBase64 must be canonical base64`);
    const publicKeyBytes = isCanonicalBase64(entry.publicKeySpkiBase64)
      ? Buffer.from(entry.publicKeySpkiBase64, "base64")
      : Buffer.alloc(0);
    if (!SHA256.test(entry.publicKeySha256 ?? "")) findings.push(`${label}.publicKeySha256 is invalid`);
    if (publicKeyBytes.length > 0 && sha256Bytes(publicKeyBytes) !== entry.publicKeySha256) {
      findings.push(`${label}.publicKeySha256 does not match publicKeySpkiBase64`);
    }
    if (entry.keyId !== `sha256:${entry.publicKeySha256}`) findings.push(`${label}.keyId must equal the SPKI SHA-256`);
    if (fingerprints.has(entry.publicKeySha256)) findings.push(`${label}.public key is duplicated`);
    fingerprints.add(entry.publicKeySha256);
    const validFrom = parseUtc(entry.validFromUtc, `${label}.validFromUtc`, findings);
    const validUntil = parseUtc(entry.validUntilUtc, `${label}.validUntilUtc`, findings);
    const revokedAt = entry.revokedAtUtc === null ? null : parseUtc(entry.revokedAtUtc, `${label}.revokedAtUtc`, findings);
    if (validFrom && validUntil && validUntil <= validFrom) findings.push(`${label}.validUntilUtc must be after validFromUtc`);
    if (revokedAt && validFrom && revokedAt < validFrom) findings.push(`${label}.revokedAtUtc must not precede validFromUtc`);
    let publicKey = null;
    if (publicKeyBytes.length > 0) {
      try {
        publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
        if (publicKey.asymmetricKeyType !== "ed25519") findings.push(`${label}.public key must be Ed25519`);
      } catch (error) {
        findings.push(`${label}.public key is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (KEY_ID.test(entry.keyId ?? "") && !keys.has(entry.keyId)) {
      keys.set(entry.keyId, { ...entry, publicKey, validFrom, validUntil, revokedAt });
    }
  }
  return keys;
}

function validateApprovalAuthorities(value, keys, findings) {
  if (!Array.isArray(value) || value.length === 0) {
    findings.push("trustPolicy.approvalAuthorities must be a non-empty array");
    return [];
  }
  const seen = new Set();
  const approverRoles = new Map();
  const keyRoles = new Map();
  const normalized = [];
  for (const [index, entry] of value.entries()) {
    const label = `trustPolicy.approvalAuthorities[${index}]`;
    exactKeys(entry, ["role", "approverId", "keyId"], label, findings);
    if (!isObject(entry)) continue;
    if (!PRODUCTION_APPROVAL_ROLES.includes(entry.role)) findings.push(`${label}.role is invalid`);
    if (!IDENTIFIER.test(entry.approverId ?? "")) findings.push(`${label}.approverId is invalid`);
    if (!keys.has(entry.keyId)) findings.push(`${label}.keyId is not present in trustPolicy.keys`);
    const identity = `${entry.role}\0${entry.approverId}\0${entry.keyId}`;
    if (seen.has(identity)) findings.push(`${label} is duplicated`);
    seen.add(identity);
    const priorRole = approverRoles.get(entry.approverId);
    if (priorRole && priorRole !== entry.role) findings.push(`${label}.approverId cannot approve multiple roles`);
    approverRoles.set(entry.approverId, entry.role);
    const priorKeyRole = keyRoles.get(entry.keyId);
    if (priorKeyRole && priorKeyRole !== entry.role) findings.push(`${label}.keyId cannot authorize multiple approval roles`);
    keyRoles.set(entry.keyId, entry.role);
    normalized.push({ role: entry.role, approverId: entry.approverId, keyId: entry.keyId });
  }
  for (const role of PRODUCTION_APPROVAL_ROLES) {
    if (!normalized.some((entry) => entry.role === role)) findings.push(`trustPolicy.approvalAuthorities is missing ${role}`);
  }
  return normalized;
}

function validateReceiptAuthorities(value, keys, findings) {
  if (!Array.isArray(value) || value.length === 0) {
    findings.push("trustPolicy.receiptAuthorities must be a non-empty array");
    return [];
  }
  const scopes = new Set();
  const normalized = [];
  for (const [index, entry] of value.entries()) {
    const label = `trustPolicy.receiptAuthorities[${index}]`;
    exactKeys(entry, ["scopeId", "signerId", "keyId"], label, findings);
    if (!isObject(entry)) continue;
    if (!IDENTIFIER.test(entry.scopeId ?? "")) findings.push(`${label}.scopeId is invalid`);
    if (!IDENTIFIER.test(entry.signerId ?? "")) findings.push(`${label}.signerId is invalid`);
    if (!keys.has(entry.keyId)) findings.push(`${label}.keyId is not present in trustPolicy.keys`);
    if (scopes.has(entry.scopeId)) findings.push(`${label}.scopeId must have exactly one authority`);
    scopes.add(entry.scopeId);
    normalized.push({ scopeId: entry.scopeId, signerId: entry.signerId, keyId: entry.keyId });
  }
  return normalized;
}

function assertKeyValid(key, signedAt, label) {
  if (!key) throw new Error(`${label} key is missing from the external trust policy`);
  if (!(signedAt instanceof Date) || !Number.isFinite(signedAt.getTime())) throw new Error(`${label} signedAtUtc is invalid`);
  if (key.revokedAt) throw new Error(`${label} key is revoked`);
  if (signedAt < key.validFrom) throw new Error(`${label} key was not valid at signedAtUtc`);
  if (signedAt >= key.validUntil) throw new Error(`${label} key had expired at signedAtUtc`);
}

function parseUtc(value, label, findings) {
  if (typeof value !== "string" || !UTC.test(value)) {
    findings.push(`${label} must be an ISO UTC timestamp`);
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) findings.push(`${label} must be a valid timestamp`);
  return parsed;
}

function exactKeys(value, expected, label, findings) {
  if (!isObject(value)) {
    findings.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) findings.push(`${label} must contain exactly: ${wanted.join(", ")}`);
}

function isCanonicalBase64(value) {
  return typeof value === "string" && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    && Buffer.from(value, "base64").toString("base64") === value;
}

function isCanonicalBase64Url(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value)
    && Buffer.from(value, "base64url").toString("base64url") === value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
