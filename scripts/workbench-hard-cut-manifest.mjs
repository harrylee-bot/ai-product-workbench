#!/usr/bin/env node

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
import {
  loadProductionTrustPolicy,
  ProductionTrustPolicyError,
  resolveReceiptAuthority,
  verifyTrustedEd25519Signature,
} from "./workbench-production-trust-policy.mjs";
import { loadProductionImageDigestBinding } from "./production-image-inventory.mjs";
import { loadProductionDeploymentConfigBinding } from "./production-deployment-config.mjs";
import {
  DEFAULT_CONTROL_CATALOG_PATH,
  loadProductionAcceptanceControlCatalog,
  ProductionAcceptanceContractError,
} from "./production-acceptance/catalog.mjs";

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
const candidateIdPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const releaseCommitPattern = /^[0-9a-f]{40}$/u;
const fileUriPattern = /^file:\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const signaturePattern = /^[A-Za-z0-9_-]{64,256}$/u;
const cutoverScopeIds = Object.freeze({
  productionAcceptance: "hard-cut.production-acceptance",
  trafficSwitch: "hard-cut.traffic-switch",
  rollbackWindowClosure: "hard-cut.rollback-window-closure",
});

export async function validateHardCutManifest({
  manifestPath = null,
  root = defaultRepoRoot,
  enforce = false,
  expectedCandidateId,
  expectedSourceCommit,
  expectedSignedTag,
  expectedReleaseChainId,
  productionImageManifestPath,
  expectedProductionImageManifestSha256,
  deploymentConfigManifestPath,
  expectedDeploymentConfigManifestSha256,
  controlCatalogPath,
  expectedControlCatalogSha256,
  trustPolicyPath,
  expectedTrustPolicySha256,
  now = new Date(),
} = {}) {
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new Error("manifestPath is required");
  }
  const repoRoot = path.resolve(root);
  const resolvedManifestPath = path.resolve(repoRoot, manifestPath);
  const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  const findings = [];
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const ids = new Set();
  const observedExternalKinds = new Set();
  const verifiedReceipts = new Map();
  let unverifiedReceiptCount = 0;
  const trustPolicy = await resolveTrustPolicy({
    enforce,
    trustPolicyPath,
    expectedTrustPolicySha256,
    repoRoot,
    findings,
  });

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

  const expectedCandidate = validateExpectedCandidate({
    candidateId: expectedCandidateId,
    sourceCommit: expectedSourceCommit,
    signedTag: expectedSignedTag,
  }, findings, enforce);
  const productionBinding = await resolveProductionBinding({
    enforce,
    productionImageManifestPath,
    expectedProductionImageManifestSha256,
    expectedReleaseChainId,
    expectedSourceCommit,
    expectedCandidateId,
    expectedSignedTag,
    deploymentConfigManifestPath,
    expectedDeploymentConfigManifestSha256,
    controlCatalogPath,
    expectedControlCatalogSha256,
    repoRoot,
    findings,
  });
  const candidateBinding = validateCandidateBinding(
    manifest.candidateBinding,
    findings,
    enforce,
    productionBinding,
  );
  if (trustPolicy && candidateBinding && trustPolicy.environmentId !== candidateBinding.environmentId) {
    findings.push("trust policy environmentId does not match candidateBinding.environmentId");
  }
  validateCandidateAgainstExpected(candidateBinding, expectedCandidate, findings);
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
      trustPolicy,
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
          trustPolicy,
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

async function resolveProductionBinding({
  enforce,
  productionImageManifestPath,
  expectedProductionImageManifestSha256,
  expectedReleaseChainId,
  expectedSourceCommit,
  expectedCandidateId,
  expectedSignedTag,
  deploymentConfigManifestPath,
  expectedDeploymentConfigManifestSha256,
  controlCatalogPath,
  expectedControlCatalogSha256,
  repoRoot,
  findings,
}) {
  const provided = [
    productionImageManifestPath,
    expectedProductionImageManifestSha256,
    expectedReleaseChainId,
    deploymentConfigManifestPath,
    expectedDeploymentConfigManifestSha256,
    controlCatalogPath,
    expectedControlCatalogSha256,
  ].some((value) => value !== undefined && value !== null && value !== "");
  if (!provided && !enforce) return null;
  if (!productionImageManifestPath) findings.push("enforced hard cut requires productionImageManifestPath");
  if (!sha256Pattern.test(expectedProductionImageManifestSha256 ?? "")) {
    findings.push("enforced hard cut requires expectedProductionImageManifestSha256");
  }
  if (!candidateIdPattern.test(expectedReleaseChainId ?? "")) {
    findings.push("enforced hard cut requires expectedReleaseChainId");
  }
  if (!deploymentConfigManifestPath) findings.push("enforced hard cut requires deploymentConfigManifestPath");
  if (!sha256Pattern.test(expectedDeploymentConfigManifestSha256 ?? "")) {
    findings.push("enforced hard cut requires expectedDeploymentConfigManifestSha256");
  }
  if (!controlCatalogPath) findings.push("enforced hard cut requires controlCatalogPath");
  if (!sha256Pattern.test(expectedControlCatalogSha256 ?? "")) {
    findings.push("enforced hard cut requires expectedControlCatalogSha256");
  }
  if (!releaseCommitPattern.test(expectedSourceCommit ?? "")) return null;
  if (
    !productionImageManifestPath
    || !sha256Pattern.test(expectedProductionImageManifestSha256 ?? "")
    || !candidateIdPattern.test(expectedReleaseChainId ?? "")
    || !deploymentConfigManifestPath
    || !sha256Pattern.test(expectedDeploymentConfigManifestSha256 ?? "")
    || !controlCatalogPath
    || !sha256Pattern.test(expectedControlCatalogSha256 ?? "")
  ) return null;

  const resolvedImageManifestPath = path.resolve(productionImageManifestPath);
  const resolvedDeploymentConfigPath = path.resolve(deploymentConfigManifestPath);
  const resolvedControlCatalogPath = path.resolve(controlCatalogPath);
  if (isWithin(repoRoot, resolvedImageManifestPath)) {
    findings.push("production image manifest must be outside the hard-cut evidence root");
  }
  if (isWithin(repoRoot, resolvedDeploymentConfigPath)) {
    findings.push("production deployment configuration must be outside the hard-cut evidence root");
  }
  if (isWithin(repoRoot, resolvedControlCatalogPath)) {
    findings.push("production control catalog must be outside the hard-cut evidence root");
  }
  if (resolvedControlCatalogPath !== DEFAULT_CONTROL_CATALOG_PATH) {
    findings.push("production control catalog must identify the catalog in the protected verifier checkout");
  }
  let imageBinding;
  let deploymentConfigBinding;
  try {
    imageBinding = loadProductionImageDigestBinding({
      manifestPath: resolvedImageManifestPath,
      expectedManifestSha256: expectedProductionImageManifestSha256,
      expectedCommit: expectedSourceCommit,
      expectedReleaseChainId,
    });
  } catch (error) {
    findings.push(`production image manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (imageBinding) {
    try {
      deploymentConfigBinding = loadProductionDeploymentConfigBinding({
        manifestPath: resolvedDeploymentConfigPath,
        expectedManifestSha256: expectedDeploymentConfigManifestSha256,
        expected: {
          candidateId: expectedCandidateId,
          sourceCommit: expectedSourceCommit,
          signedTag: expectedSignedTag,
          releaseChainId: expectedReleaseChainId,
          imageManifestSha256: imageBinding.manifestSha256,
          images: imageBinding.images,
        },
      });
    } catch (error) {
      findings.push(`production deployment configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await loadProductionAcceptanceControlCatalog({
      catalogPath: resolvedControlCatalogPath,
      expectedSha256: expectedControlCatalogSha256,
    });
  } catch (error) {
    if (error instanceof ProductionAcceptanceContractError) {
      findings.push(...error.findings.map((finding) => `production control catalog is invalid: ${finding}`));
    } else {
      findings.push(`production control catalog is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!imageBinding || !deploymentConfigBinding) return null;
  return {
    images: imageBinding.images,
    imageManifestSha256: imageBinding.manifestSha256,
    controlCatalogSha256: expectedControlCatalogSha256,
    releaseChainId: expectedReleaseChainId,
    deploymentConfigManifestSha256: deploymentConfigBinding.manifestSha256,
    configSha256: deploymentConfigBinding.binding.configSha256,
    migrationSha256: deploymentConfigBinding.binding.migrationSha256,
  };
}

export async function verifyHardCutReceipt({
  receipt,
  expectedScopeId,
  expectedThreshold = "zero",
  candidateBinding,
  root = defaultRepoRoot,
  trustPolicy,
  trustPolicyPath,
  expectedTrustPolicySha256,
  now = new Date(),
} = {}) {
  const findings = [];
  const resolvedTrustPolicy = trustPolicy ?? await resolveTrustPolicy({
    enforce: true,
    trustPolicyPath,
    expectedTrustPolicySha256,
    repoRoot: path.resolve(root),
    findings,
  });
  if (resolvedTrustPolicy && candidateBinding && resolvedTrustPolicy.environmentId !== candidateBinding.environmentId) {
    findings.push("trust policy environmentId does not match candidateBinding.environmentId");
  }
  const verified = await validateReceipt(receipt, {
    label: "receipt",
    expectedScopeId,
    expectedThreshold,
    candidateBinding,
    repoRoot: path.resolve(root),
    trustPolicy: resolvedTrustPolicy,
    now,
    findings,
  });
  return { ok: findings.length === 0 && verified !== null, verified, findings };
}

async function resolveTrustPolicy({ enforce, trustPolicyPath, expectedTrustPolicySha256, repoRoot, findings }) {
  if (!trustPolicyPath && !expectedTrustPolicySha256 && !enforce) return null;
  if (!trustPolicyPath) findings.push("enforced hard cut requires trustPolicyPath");
  if (!expectedTrustPolicySha256 || !sha256Pattern.test(expectedTrustPolicySha256)) {
    findings.push("enforced hard cut requires expectedTrustPolicySha256");
  }
  if (!trustPolicyPath || !sha256Pattern.test(expectedTrustPolicySha256 ?? "")) return null;
  const resolvedPath = path.resolve(trustPolicyPath);
  if (isWithin(repoRoot, resolvedPath)) {
    findings.push("production trust policy must be outside the hard-cut evidence root");
    return null;
  }
  try {
    return await loadProductionTrustPolicy({
      policyPath: resolvedPath,
      expectedSha256: expectedTrustPolicySha256,
    });
  } catch (error) {
    if (error instanceof ProductionTrustPolicyError) findings.push(...error.findings);
    else findings.push(`cannot load production trust policy: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function validateReceipt(receipt, {
  label,
  expectedScopeId,
  expectedThreshold,
  candidateBinding,
  repoRoot,
  trustPolicy,
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
  if (receipt.schemaVersion !== "workbench.hard-cut-receipt.v2") {
    findings.push(`${label}.schemaVersion must be workbench.hard-cut-receipt.v2`);
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
  validateExactKeys(signature, ["algorithm", "keyId", "value"], `${label}.signature`, findings);
  if (signature.algorithm !== "Ed25519") findings.push(`${label}.signature.algorithm must be Ed25519`);
  if (!candidateIdPattern.test(signature.keyId ?? "")) findings.push(`${label}.signature.keyId is invalid`);
  if (!signaturePattern.test(signature.value ?? "")) findings.push(`${label}.signature.value is invalid base64url`);
  if (!trustPolicy) findings.push(`${label} requires an external production trust policy`);
  if (findings.length !== startFindings) return null;

  let ledgerPath;
  try {
    ledgerPath = await resolveLocalEvidenceFile(repoRoot, ledger.uri);
  } catch (error) {
    findings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const ledgerRaw = await readFile(ledgerPath);
  if (sha256Bytes(ledgerRaw) !== ledger.sha256) findings.push(`${label}.ledger SHA-256 mismatch`);
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

  let authority;
  try {
    authority = resolveReceiptAuthority(trustPolicy, {
      scopeId: expectedScopeId,
      keyId: signature.keyId,
      signedAt,
    });
  } catch (error) {
    findings.push(`${label}.signature ${error instanceof Error ? error.message : String(error)}`);
  }
  if (authority && entry.executor.id !== authority.signerId) {
    findings.push(`${label}.ledger executor is not the trusted receipt authority`);
  }

  const signedPayload = Buffer.from(canonicalJson({
    schemaVersion: receipt.schemaVersion,
    scopeId: receipt.scopeId,
    keyId: signature.keyId,
    candidateBinding,
    ledger: receipt.ledger,
    signedAtUtc: receipt.signedAtUtc,
    validUntilUtc: receipt.validUntilUtc,
  }), "utf8");
  try {
    const valid = authority && verifyTrustedEd25519Signature({
      key: authority.key,
      payload: signedPayload,
      signature: signature.value,
    });
    if (!valid) findings.push(`${label}.signature verification failed`);
  } catch (error) {
    findings.push(`${label}.signature could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (findings.length !== startFindings) return null;
  return {
    signerKeySha256: authority.key.publicKeySha256,
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

function validateCandidateBinding(value, findings, required, expectedProductionBinding) {
  if (value === null || value === undefined) {
    if (required) findings.push("enforced hard cut requires candidateBinding");
    return null;
  }
  if (!isObject(value)) {
    findings.push("candidateBinding must be an object or null");
    return null;
  }
  validateExactKeys(value, [
    "candidateId",
    "deployId",
    "environmentId",
    "commitSha",
    "tag",
    "releaseChainId",
    "digests",
  ], "candidateBinding", findings);
  for (const field of ["candidateId", "deployId", "environmentId", "tag"]) {
    if (!identifierPattern.test(value[field] ?? "")) findings.push(`candidateBinding.${field} is invalid`);
  }
  if (!commitPattern.test(value.commitSha ?? "")) findings.push("candidateBinding.commitSha is invalid");
  if (!candidateIdPattern.test(value.releaseChainId ?? "")) findings.push("candidateBinding.releaseChainId is invalid");
  if (!isObject(value.digests)) {
    findings.push("candidateBinding.digests must be an object");
    return null;
  }
  validateExactKeys(value.digests, [
    "images",
    "configSha256",
    "migrationSha256",
    "deploymentConfigManifestSha256",
    "imageManifestSha256",
    "controlCatalogSha256",
  ], "candidateBinding.digests", findings);
  for (const field of [
    "configSha256",
    "migrationSha256",
    "deploymentConfigManifestSha256",
    "imageManifestSha256",
    "controlCatalogSha256",
  ]) {
    if (!sha256Pattern.test(value.digests[field] ?? "")) findings.push(`candidateBinding.digests.${field} is invalid`);
  }
  validateImageDigests(value.digests.images, "candidateBinding.digests.images", findings);
  if (expectedProductionBinding) {
    if (value.releaseChainId !== expectedProductionBinding.releaseChainId) {
      findings.push("candidateBinding.releaseChainId does not match the verified release chain");
    }
    if (value.digests.imageManifestSha256 !== expectedProductionBinding.imageManifestSha256) {
      findings.push("candidateBinding.digests.imageManifestSha256 does not match the verified G4 image manifest");
    }
    if (value.digests.controlCatalogSha256 !== expectedProductionBinding.controlCatalogSha256) {
      findings.push("candidateBinding.digests.controlCatalogSha256 does not match the protected control catalog");
    }
    if (value.digests.deploymentConfigManifestSha256 !== expectedProductionBinding.deploymentConfigManifestSha256) {
      findings.push("candidateBinding.digests.deploymentConfigManifestSha256 does not match the signed deployment configuration");
    }
    if (value.digests.configSha256 !== expectedProductionBinding.configSha256) {
      findings.push("candidateBinding.digests.configSha256 does not match the signed deployment configuration");
    }
    if (value.digests.migrationSha256 !== expectedProductionBinding.migrationSha256) {
      findings.push("candidateBinding.digests.migrationSha256 does not match the signed deployment configuration");
    }
    if (canonicalJson(value.digests.images) !== canonicalJson(expectedProductionBinding.images)) {
      findings.push("candidateBinding.digests.images does not match the complete verified G4 image inventory");
    }
  }
  return value;
}

function validateImageDigests(value, label, findings) {
  if (!Array.isArray(value) || value.length === 0) {
    findings.push(`${label} must be a non-empty array`);
    return;
  }
  const names = new Set();
  let previousName = "";
  for (const [index, image] of value.entries()) {
    if (!isObject(image)
      || Object.keys(image).sort().join(",") !== "digest,name"
      || !identifierPattern.test(image.name ?? "")
      || !/^sha256:[0-9a-f]{64}$/u.test(image.digest ?? "")) {
      findings.push(`${label}[${index}] is invalid`);
      continue;
    }
    if (names.has(image.name)) findings.push(`${label}[${index}].name is duplicated`);
    if (previousName && previousName.localeCompare(image.name, "en") >= 0) {
      findings.push(`${label} must be sorted by unique name`);
    }
    names.add(image.name);
    previousName = image.name;
  }
}

function validateExpectedCandidate(value, findings, required) {
  const fields = [
    ["expectedCandidateId", value.candidateId, candidateIdPattern],
    ["expectedSourceCommit", value.sourceCommit, releaseCommitPattern],
    ["expectedSignedTag", value.signedTag, identifierPattern],
  ];
  const provided = fields.some(([, candidate]) => candidate !== undefined && candidate !== null && candidate !== "");
  if (!provided && !required) return null;
  let valid = true;
  for (const [name, candidate, pattern] of fields) {
    if (typeof candidate !== "string" || !pattern.test(candidate)) {
      findings.push(`${required ? "enforced hard cut requires" : "invalid"} ${name}`);
      valid = false;
    }
  }
  return valid ? value : null;
}

function validateCandidateAgainstExpected(binding, expected, findings) {
  if (!binding || !expected) return;
  for (const [bindingField, expectedField] of [
    ["candidateId", "candidateId"],
    ["commitSha", "sourceCommit"],
    ["tag", "signedTag"],
  ]) {
    if (binding[bindingField] !== expected[expectedField]) {
      findings.push(`candidateBinding.${bindingField} does not match the verified release candidate`);
    }
  }
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
    manifestPath: null,
    enforce: process.env.WORKBENCH_HARD_CUT === "1",
    now: new Date(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--enforce") {
      options.enforce = true;
      continue;
    }
    const field = ({
      "--root": "root",
      "--manifest": "manifestPath",
      "--now": "now",
      "--expected-candidate-id": "expectedCandidateId",
      "--expected-source-commit": "expectedSourceCommit",
      "--expected-signed-tag": "expectedSignedTag",
      "--expected-release-chain-id": "expectedReleaseChainId",
      "--production-image-manifest": "productionImageManifestPath",
      "--production-image-manifest-sha256": "expectedProductionImageManifestSha256",
      "--deployment-config-manifest": "deploymentConfigManifestPath",
      "--deployment-config-manifest-sha256": "expectedDeploymentConfigManifestSha256",
      "--control-catalog": "controlCatalogPath",
      "--control-catalog-sha256": "expectedControlCatalogSha256",
      "--trust-policy": "trustPolicyPath",
      "--trust-policy-sha256": "expectedTrustPolicySha256",
    })[argument] ?? null;
    if (!field) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[field] = field === "now" ? new Date(value) : value;
    index += 1;
  }
  if (!options.manifestPath) throw new Error("--manifest is required");
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
