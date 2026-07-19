#!/usr/bin/env node

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  EvidenceValidationError,
  sha256Bytes,
  verifyEvidenceLedger,
} from "./evidence-ledger.mjs";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryKinds = new Set(["path", "dependency"]);
const externalKinds = new Set([
  "container",
  "database",
  "image",
  "log",
  "network",
  "object-prefix",
  "secret",
  "volume",
]);
const requiredExternalKinds = new Set(externalKinds);
const states = new Set(["pending", "removed"]);
const statusValues = new Set(["pre-cutover", "cutover-accepted", "completed"]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const fileUriPattern = /^file:\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const signaturePattern = /^[A-Za-z0-9_-]{64,256}$/u;
const cutoverScopeIds = Object.freeze({
  productionAcceptance: "hard-cut.production-acceptance",
  trafficSwitch: "hard-cut.traffic-switch",
  rollbackWindowClosure: "hard-cut.rollback-window-closure",
});

export async function validateHardCutManifest({
  manifestPath = path.join(defaultRepoRoot, "docs/workbench-hard-cut-deletion-manifest.json"),
  root = defaultRepoRoot,
  enforce = false,
  now = new Date(),
} = {}) {
  const repoRoot = path.resolve(root);
  const resolvedManifestPath = path.resolve(repoRoot, manifestPath);
  const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  const findings = [];
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const ids = new Set();
  const observedExternalKinds = new Set();
  const verifiedReceipts = new Map();
  let unverifiedReceiptCount = 0;

  if (manifest.version !== 3) findings.push("manifest version must be 3");
  if (manifest.product !== "产品工作台") findings.push("manifest product must be 产品工作台");
  if (manifest.technicalIdentifier !== "workbench") findings.push("manifest technicalIdentifier must be workbench");
  if (!statusValues.has(manifest.status)) {
    findings.push("manifest status must be pre-cutover, cutover-accepted, or completed");
  }
  if (manifest.policy?.allowConversationMigration !== false) findings.push("conversation migration must remain disabled");
  if (manifest.policy?.allowCompatibilityLayer !== false) findings.push("compatibility layer must remain disabled");
  if (manifest.policy?.allowDualWrite !== false) findings.push("dual write must remain disabled");
  if (manifest.policy?.preserveKnowledgeVault !== true) findings.push("knowledge-vault preservation must remain enabled");
  if (manifest.policy?.preserveOnlyReferencedStorage !== true) findings.push("referenced storage preservation must remain enabled");

  const candidateBinding = validateCandidateBinding(manifest.candidateBinding, findings, enforce);
  const cutoverReceipts = manifest.cutoverReceipts ?? {};
  for (const [name, scopeId] of Object.entries(cutoverScopeIds)) {
    const receipt = cutoverReceipts[name] ?? null;
    if (!receipt) {
      if (enforce) findings.push(`enforced hard cut requires cutoverReceipts.${name}`);
      continue;
    }
    if (!enforce || !candidateBinding) {
      unverifiedReceiptCount += 1;
      continue;
    }
    const verified = await validateReceipt(receipt, {
      label: `cutoverReceipts.${name}`,
      expectedScopeId: scopeId,
      expectedThreshold: name === "rollbackWindowClosure" ? "zero" : "true",
      candidateBinding,
      repoRoot,
      now,
      findings,
    });
    if (verified) verifiedReceipts.set(`cutover:${name}`, verified);
  }

  if (enforce && manifest.status !== "completed") {
    findings.push("enforced hard cut requires manifest status completed");
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push("entries must contain objects");
      continue;
    }
    const id = typeof entry.id === "string" && entry.id ? entry.id : "unknown";
    if (id === "unknown") findings.push("every entry needs a non-empty id");
    if (ids.has(id)) findings.push(`duplicate entry id: ${id}`);
    ids.add(id);
    if (!repositoryKinds.has(entry.kind) && !externalKinds.has(entry.kind)) {
      findings.push(`${id}: unsupported kind ${String(entry.kind)}`);
      continue;
    }
    if (!states.has(entry.state)) findings.push(`${id}: state must be pending or removed`);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) findings.push(`${id}: reason is required`);
    if (!Array.isArray(entry.preconditions) || entry.preconditions.length === 0
      || entry.preconditions.some((value) => typeof value !== "string" || !value.trim())) {
      findings.push(`${id}: at least one non-empty precondition is required`);
    }
    if (entry.state === "pending" && entry.receipt !== null) findings.push(`${id}: pending entry receipt must be null`);
    if (entry.state === "removed") {
      if (!entry.receipt) {
        if (enforce) findings.push(`${id}: removed entry needs a signed receipt`);
      } else if (!enforce || !candidateBinding) {
        unverifiedReceiptCount += 1;
      } else {
        const verified = await validateReceipt(entry.receipt, {
          label: `${id}.receipt`,
          expectedScopeId: id,
          expectedThreshold: externalKinds.has(entry.kind) ? "zero" : "true",
          candidateBinding,
          repoRoot,
          now,
          findings,
        });
        if (verified) verifiedReceipts.set(`entry:${id}`, verified);
      }
    }

    if (repositoryKinds.has(entry.kind)) {
      await validateRepositoryEntry(entry, id, repoRoot, enforce, findings);
      continue;
    }

    observedExternalKinds.add(entry.kind);
    if (typeof entry.scope !== "string" || !entry.scope.trim()) findings.push(`${id}: external resource scope is required`);
    if (typeof entry.provider !== "string" || !entry.provider.trim()) findings.push(`${id}: external resource provider is required`);
    if (!Array.isArray(entry.targets) || entry.targets.length === 0
      || entry.targets.some((value) => typeof value !== "string" || !value.trim())) {
      findings.push(`${id}: external resource targets are required`);
    }
  }

  for (const kind of requiredExternalKinds) {
    if (!observedExternalKinds.has(kind)) findings.push(`manifest must inventory legacy ${kind} resources`);
  }

  if (enforce) validateIndependentProductionAcceptance(verifiedReceipts, findings);
  const pending = entries.filter((entry) => entry?.state === "pending");
  const ready = findings.length === 0
    && pending.length === 0
    && unverifiedReceiptCount === 0
    && manifest.status === "completed";
  return {
    manifest: path.relative(repoRoot, resolvedManifestPath),
    enforce,
    status: findings.length > 0 ? "invalid" : ready ? "ready" : "pending",
    pending: pending.map((entry) => entry.id),
    verifiedReceiptCount: verifiedReceipts.size,
    unverifiedReceiptCount,
    findings,
  };
}

export async function verifyHardCutReceipt({
  receipt,
  expectedScopeId,
  expectedThreshold = "zero",
  candidateBinding,
  root = defaultRepoRoot,
  now = new Date(),
} = {}) {
  const findings = [];
  const verified = await validateReceipt(receipt, {
    label: "receipt",
    expectedScopeId,
    expectedThreshold,
    candidateBinding,
    repoRoot: path.resolve(root),
    now,
    findings,
  });
  return { ok: findings.length === 0 && verified !== null, verified, findings };
}

async function validateReceipt(receipt, {
  label,
  expectedScopeId,
  expectedThreshold,
  candidateBinding,
  repoRoot,
  now,
  findings,
}) {
  const startFindings = findings.length;
  if (!isObject(receipt)) {
    findings.push(`${label} must be an object`);
    return null;
  }
  const expectedKeys = ["schemaVersion", "scopeId", "ledger", "signedAtUtc", "validUntilUtc", "signature"];
  validateExactKeys(receipt, expectedKeys, label, findings);
  if (receipt.schemaVersion !== "workbench.hard-cut-receipt.v1") {
    findings.push(`${label}.schemaVersion must be workbench.hard-cut-receipt.v1`);
  }
  if (receipt.scopeId !== expectedScopeId) findings.push(`${label}.scopeId must be ${expectedScopeId}`);
  const signedAt = parseUtc(receipt.signedAtUtc, `${label}.signedAtUtc`, findings);
  const validUntil = parseUtc(receipt.validUntilUtc, `${label}.validUntilUtc`, findings);
  if (signedAt && validUntil && signedAt >= validUntil) findings.push(`${label} validity window is empty`);
  if (signedAt && signedAt > now) findings.push(`${label} signature is not valid yet`);
  if (validUntil && validUntil < now) findings.push(`${label} signature has expired`);

  const ledger = receipt.ledger;
  if (!isObject(ledger)) {
    findings.push(`${label}.ledger must be an object`);
    return null;
  }
  validateExactKeys(ledger, ["ledgerId", "entryId", "uri", "sha256"], `${label}.ledger`, findings);
  if (!identifierPattern.test(ledger.ledgerId ?? "")) findings.push(`${label}.ledger.ledgerId is invalid`);
  if (!identifierPattern.test(ledger.entryId ?? "")) findings.push(`${label}.ledger.entryId is invalid`);
  if (!fileUriPattern.test(ledger.uri ?? "")) findings.push(`${label}.ledger.uri must be a repository-relative file URI`);
  if (!sha256Pattern.test(ledger.sha256 ?? "")) findings.push(`${label}.ledger.sha256 is invalid`);

  const signature = receipt.signature;
  if (!isObject(signature)) {
    findings.push(`${label}.signature must be an object`);
    return null;
  }
  validateExactKeys(signature, ["algorithm", "publicKeyUri", "publicKeySha256", "value"], `${label}.signature`, findings);
  if (signature.algorithm !== "Ed25519") findings.push(`${label}.signature.algorithm must be Ed25519`);
  if (!fileUriPattern.test(signature.publicKeyUri ?? "")) {
    findings.push(`${label}.signature.publicKeyUri must be a repository-relative file URI`);
  }
  if (!sha256Pattern.test(signature.publicKeySha256 ?? "")) findings.push(`${label}.signature.publicKeySha256 is invalid`);
  if (!signaturePattern.test(signature.value ?? "")) findings.push(`${label}.signature.value is invalid base64url`);
  if (findings.length !== startFindings) return null;

  let ledgerPath;
  let publicKeyPath;
  try {
    ledgerPath = await resolveLocalEvidenceFile(repoRoot, ledger.uri);
    publicKeyPath = await resolveLocalEvidenceFile(repoRoot, signature.publicKeyUri);
  } catch (error) {
    findings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const [ledgerRaw, publicKeyRaw] = await Promise.all([
    readFile(ledgerPath),
    readFile(publicKeyPath),
  ]);
  if (sha256Bytes(ledgerRaw) !== ledger.sha256) findings.push(`${label}.ledger SHA-256 mismatch`);
  if (sha256Bytes(publicKeyRaw) !== signature.publicKeySha256) findings.push(`${label}.public key SHA-256 mismatch`);
  if (findings.length !== startFindings) return null;

  let report;
  try {
    report = await verifyEvidenceLedger({
      ledgerPath,
      root: repoRoot,
      expectedBinding: {
        candidateId: candidateBinding.candidateId,
        deployId: candidateBinding.deployId,
        environmentId: candidateBinding.environmentId,
      },
    });
  } catch (error) {
    if (error instanceof EvidenceValidationError) {
      for (const detail of error.errors) findings.push(`${label}.ledger: ${detail}`);
    } else {
      findings.push(`${label}.ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
  if (report.ledgerId !== ledger.ledgerId) findings.push(`${label}.ledgerId mismatch`);
  if (canonicalJson(stripCandidateManifest(report.binding)) !== canonicalJson(candidateBinding)) {
    findings.push(`${label}.ledger candidate binding mismatch`);
  }

  const ledgerDocument = JSON.parse(ledgerRaw.toString("utf8"));
  const entry = ledgerDocument.payload.entries.find((candidate) => candidate.entryId === ledger.entryId);
  if (!entry) {
    findings.push(`${label}.ledger entry ${ledger.entryId} does not exist`);
    return null;
  }
  if (entry.executionStatus !== "PASS") findings.push(`${label}.ledger entry must be PASS`);
  if (!entry.relatedFindingsOrDecisions.some((related) => (
    related.kind === "decision" && related.id === expectedScopeId
  ))) {
    findings.push(`${label}.ledger entry is not bound to decision ${expectedScopeId}`);
  }
  if (entry.environment.kind !== "production") findings.push(`${label}.ledger entry must target production`);
  validateReceiptThreshold(entry.threshold, expectedThreshold, `${label}.ledger entry`, findings);
  const executedAt = parseUtc(entry.executedAtUtc, `${label}.ledger entry executedAtUtc`, findings);
  if (executedAt && signedAt && executedAt > signedAt) {
    findings.push(`${label} was signed before its evidence entry was executed`);
  }

  const signedPayload = Buffer.from(canonicalJson({
    schemaVersion: receipt.schemaVersion,
    scopeId: receipt.scopeId,
    candidateBinding,
    ledger: receipt.ledger,
    signedAtUtc: receipt.signedAtUtc,
    validUntilUtc: receipt.validUntilUtc,
  }), "utf8");
  try {
    const valid = verifySignature(
      null,
      signedPayload,
      createPublicKey(publicKeyRaw),
      Buffer.from(signature.value, "base64url"),
    );
    if (!valid) findings.push(`${label}.signature verification failed`);
  } catch (error) {
    findings.push(`${label}.signature could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (findings.length !== startFindings) return null;
  return {
    signerKeySha256: signature.publicKeySha256,
    executorId: entry.executor.id,
    executedAt,
  };
}

function validateIndependentProductionAcceptance(receipts, findings) {
  const acceptance = receipts.get("cutover:productionAcceptance");
  const traffic = receipts.get("cutover:trafficSwitch");
  const closure = receipts.get("cutover:rollbackWindowClosure");
  if (!acceptance || !traffic || !closure) return;
  for (const [name, receipt] of [["trafficSwitch", traffic], ["rollbackWindowClosure", closure]]) {
    if (acceptance.signerKeySha256 === receipt.signerKeySha256) {
      findings.push(`productionAcceptance must use an independent signer from ${name}`);
    }
    if (acceptance.executorId === receipt.executorId) {
      findings.push(`productionAcceptance executor must differ from ${name}`);
    }
  }
  if (acceptance.executedAt > traffic.executedAt) {
    findings.push("productionAcceptance must execute before trafficSwitch");
  }
  if (traffic.executedAt > closure.executedAt) {
    findings.push("trafficSwitch must execute before rollbackWindowClosure");
  }
}

function validateCandidateBinding(value, findings, required) {
  if (value === null || value === undefined) {
    if (required) findings.push("enforced hard cut requires candidateBinding");
    return null;
  }
  if (!isObject(value)) {
    findings.push("candidateBinding must be an object or null");
    return null;
  }
  validateExactKeys(value, ["candidateId", "deployId", "environmentId", "commitSha", "tag", "digests"], "candidateBinding", findings);
  for (const field of ["candidateId", "deployId", "environmentId", "tag"]) {
    if (!identifierPattern.test(value[field] ?? "")) findings.push(`candidateBinding.${field} is invalid`);
  }
  if (!commitPattern.test(value.commitSha ?? "")) findings.push("candidateBinding.commitSha is invalid");
  if (!isObject(value.digests)) {
    findings.push("candidateBinding.digests must be an object");
    return null;
  }
  validateExactKeys(value.digests, ["images", "configSha256", "migrationSha256"], "candidateBinding.digests", findings);
  for (const field of ["configSha256", "migrationSha256"]) {
    if (!sha256Pattern.test(value.digests[field] ?? "")) findings.push(`candidateBinding.digests.${field} is invalid`);
  }
  if (!Array.isArray(value.digests.images)) {
    findings.push("candidateBinding.digests.images must be an array");
  } else {
    for (const [index, image] of value.digests.images.entries()) {
      if (!isObject(image)
        || !identifierPattern.test(image.name ?? "")
        || !/^sha256:[0-9a-f]{64}$/u.test(image.digest ?? "")) {
        findings.push(`candidateBinding.digests.images[${index}] is invalid`);
      }
    }
  }
  return value;
}

async function validateRepositoryEntry(entry, id, repoRoot, enforce, findings) {
  if (typeof entry.path !== "string" || !entry.path || path.isAbsolute(entry.path)) {
    findings.push(`${id}: path must be a relative repository path`);
    return;
  }
  const absolutePath = path.resolve(repoRoot, entry.path);
  if (!isWithin(repoRoot, absolutePath)) {
    findings.push(`${id}: path escapes repository root`);
    return;
  }
  const exists = await fileExists(absolutePath);
  if (entry.state === "pending" && !exists) findings.push(`${id}: pending path does not exist: ${entry.path}`);
  if (entry.kind !== "dependency") {
    if (entry.state === "removed" && exists && enforce) findings.push(`${id}: removed path still exists: ${entry.path}`);
    return;
  }
  if (!Array.isArray(entry.names) || entry.names.length === 0) {
    findings.push(`${id}: dependency entry needs names`);
    return;
  }
  if (!exists) return;
  const source = await readFile(absolutePath, "utf8");
  for (const name of entry.names) {
    if (!containsDependencyReference(source, name)) {
      if (entry.state === "pending") findings.push(`${id}: dependency ${name} is already absent; update state to removed`);
    } else if (enforce) {
      findings.push(`${id}: dependency still present: ${name}`);
    }
  }
}

function validateReceiptThreshold(threshold, expected, label, findings) {
  if (expected === "zero") {
    if (threshold?.kind !== "number" || threshold.operator !== "eq" || threshold.expected !== 0) {
      findings.push(`${label} must prove a zero residual count`);
    }
    return;
  }
  if (threshold?.kind !== "boolean" || threshold.operator !== "eq" || threshold.expected !== true) {
    findings.push(`${label} must prove a true boolean outcome`);
  }
}

async function resolveLocalEvidenceFile(repoRoot, uri) {
  const candidate = path.resolve(repoRoot, uri.slice("file:./".length));
  if (!isWithin(repoRoot, candidate)) throw new Error(`evidence path escapes repository root: ${uri}`);
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(repoRoot), realpath(candidate)]);
  if (!isWithin(resolvedRoot, resolvedCandidate)) throw new Error(`evidence realpath escapes repository root: ${uri}`);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`evidence is not a regular file: ${uri}`);
  return candidate;
}

function validateExactKeys(value, expected, label, findings) {
  const keys = Object.keys(value).sort();
  const normalized = [...expected].sort();
  if (canonicalJson(keys) !== canonicalJson(normalized)) {
    findings.push(`${label} must contain exactly: ${normalized.join(", ")}`);
  }
}

function parseUtc(value, label, findings) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
    findings.push(`${label} must be an ISO UTC timestamp`);
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    findings.push(`${label} must be a valid timestamp`);
    return null;
  }
  return date;
}

function stripCandidateManifest(binding) {
  const { candidateManifest: _candidateManifest, ...rest } = binding;
  return rest;
}

function containsDependencyReference(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9@/_-])${escapedName}(?=$|[^A-Za-z0-9@/_-])`, "m").test(source);
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fileExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseCli(argv) {
  const options = {
    root: defaultRepoRoot,
    manifestPath: "docs/workbench-hard-cut-deletion-manifest.json",
    enforce: process.env.WORKBENCH_HARD_CUT === "1",
    now: new Date(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--enforce") {
      options.enforce = true;
      continue;
    }
    const field = argument === "--root" ? "root"
      : argument === "--manifest" ? "manifestPath"
        : argument === "--now" ? "now"
          : null;
    if (!field) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[field] = field === "now" ? new Date(value) : value;
    index += 1;
  }
  if (!Number.isFinite(options.now.getTime())) throw new Error("--now must be a valid timestamp");
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  validateHardCutManifest(parseCli(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.findings.length > 0 || (result.enforce && result.status !== "ready")) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
