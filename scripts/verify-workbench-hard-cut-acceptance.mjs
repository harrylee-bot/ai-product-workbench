#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, canonicalJsonFile } from "./evidence-ledger.mjs";
import {
  EvidenceValidationError,
  verifyEvidenceLedger,
} from "./evidence-ledger.mjs";
import {
  loadProductionTrustPolicy,
  PRODUCTION_APPROVAL_ROLES,
  ProductionTrustPolicyError,
  resolveApprovalAuthority,
  verifyTrustedEd25519Signature,
} from "./workbench-production-trust-policy.mjs";
import { loadProductionImageDigestBinding } from "./production-image-inventory.mjs";
import { loadVerifiedProductionDeploymentConfig } from "./production-deployment-config.mjs";
import {
  assertGateEntriesMatchCatalog,
  CONTROL_CATALOG_PACKAGE_PATH,
  CONTROL_CATALOG_SCHEMA_VERSION,
  DEFAULT_CONTROL_CATALOG_PATH,
  loadProductionAcceptanceControlCatalog,
  ProductionAcceptanceContractError,
} from "./production-acceptance/catalog.mjs";
import {
  validateProductionObservationCollection,
} from "./production-acceptance/collect.mjs";
import { loadProductionAcceptancePlan } from "./production-acceptance/plan.mjs";
import { replayProductionControlObservation } from "./production-acceptance/replay.mjs";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^[a-f0-9]{64}$/u;
const CANDIDATE_ID = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CHAIN_ID = /^sha256:[a-f0-9]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const EVIDENCE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const REQUIRED_GATES = Object.freeze(["G5", "G6", "G7", "G8", "G9", "G10", "G11"]);
const REQUIRED_APPROVALS = PRODUCTION_APPROVAL_ROLES;
const APPROVAL_PACKAGE_SCHEMA = "workbench.hard-cut-acceptance-package.v3";
const APPROVAL_SIGNATURE_SCHEMA = "workbench.production-approval-signature.v3";
const COLLECTION_PACKAGE_PATH = "collection.json";
const PLAN_PACKAGE_PATH = "governance/production-acceptance-plan.json";
const protectedControlCatalogPath = DEFAULT_CONTROL_CATALOG_PATH;

export class HardCutAcceptanceValidationError extends Error {
  constructor(findings) {
    const normalized = [...new Set(findings)].sort();
    super(`Hard-cut acceptance package validation failed (${normalized.length} finding${normalized.length === 1 ? "" : "s"}):\n${normalized.map((finding) => `- ${finding}`).join("\n")}`);
    this.name = "HardCutAcceptanceValidationError";
    this.findings = normalized;
  }
}

/**
 * Validate the transport URL before curl is allowed to fetch an evidence package.
 * Content-addressed SHA-256 is still mandatory; HTTPS alone is not immutability.
 */
export function validateImmutableHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("evidence package URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("evidence package URL must be HTTPS and credential-free");
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:token|secret|credential|signature|sig|auth|key)/iu.test(key)) {
      throw new Error("evidence package URL must not contain credential query parameters");
    }
  }
  if (/(?:^|[-_/])(?:latest|current|head)(?:[./_-]|$)/iu.test(url.pathname)) {
    throw new Error("evidence package URL must not use a mutable latest/current/head path");
  }
  return url.href;
}

export async function verifyHardCutAcceptancePackage({
  packagePath,
  expectedPackageSha256,
  evidenceRoot,
  trustPolicyPath,
  expectedTrustPolicySha256,
  expectedCandidate,
  expectedChainId,
  productionImageManifestPath,
  expectedProductionImageManifestSha256,
  deploymentConfigManifestPath,
  deploymentConfigBundlePath,
  deploymentConfigCertificateIdentity,
  deploymentConfigCertificateOidcIssuer,
  expectedDeploymentConfigGithubRunId,
  expectedDeploymentConfigGithubRunAttempt,
  expectedDeploymentConfigManifestSha256,
  verifyDeploymentConfigBlob,
  controlCatalogPath,
  expectedControlCatalogSha256,
  now = new Date(),
} = {}) {
  const findings = [];
  const nowDate = parseDate(now, "now", findings);
  const resolvedPackagePath = path.resolve(packagePath ?? "");
  const resolvedEvidenceRoot = path.resolve(evidenceRoot ?? "");
  const resolvedTrustPolicyPath = path.resolve(trustPolicyPath ?? "");
  const resolvedProductionImageManifestPath = path.resolve(productionImageManifestPath ?? "");
  const resolvedDeploymentConfigManifestPath = path.resolve(deploymentConfigManifestPath ?? "");
  const resolvedDeploymentConfigBundlePath = path.resolve(deploymentConfigBundlePath ?? "");
  const resolvedControlCatalogPath = path.resolve(controlCatalogPath ?? "");
  if (!packagePath) findings.push("packagePath is required");
  if (!evidenceRoot) findings.push("evidenceRoot is required");
  if (!trustPolicyPath) findings.push("trustPolicyPath is required");
  if (!productionImageManifestPath) findings.push("productionImageManifestPath is required");
  if (!deploymentConfigManifestPath) findings.push("deploymentConfigManifestPath is required");
  if (!deploymentConfigBundlePath) findings.push("deploymentConfigBundlePath is required");
  if (!deploymentConfigCertificateIdentity) findings.push("deploymentConfigCertificateIdentity is required");
  if (!deploymentConfigCertificateOidcIssuer) findings.push("deploymentConfigCertificateOidcIssuer is required");
  if (!/^[1-9][0-9]*$/u.test(String(expectedDeploymentConfigGithubRunId ?? ""))) {
    findings.push("expectedDeploymentConfigGithubRunId is invalid");
  }
  if (!Number.isSafeInteger(Number(expectedDeploymentConfigGithubRunAttempt))
    || Number(expectedDeploymentConfigGithubRunAttempt) < 1) {
    findings.push("expectedDeploymentConfigGithubRunAttempt is invalid");
  }
  if (!expectedDeploymentConfigManifestSha256 || !SHA256.test(expectedDeploymentConfigManifestSha256)) {
    findings.push("expectedDeploymentConfigManifestSha256 is invalid");
  }
  if (!controlCatalogPath) findings.push("controlCatalogPath is required");
  if (!expectedTrustPolicySha256 || !SHA256.test(expectedTrustPolicySha256)) findings.push("expectedTrustPolicySha256 is invalid");
  if (!expectedProductionImageManifestSha256 || !SHA256.test(expectedProductionImageManifestSha256)) {
    findings.push("expectedProductionImageManifestSha256 is invalid");
  }
  if (!expectedControlCatalogSha256 || !SHA256.test(expectedControlCatalogSha256)) {
    findings.push("expectedControlCatalogSha256 is invalid");
  }
  if (isWithin(defaultRepoRoot, resolvedPackagePath)) findings.push("packagePath must be outside the source checkout");
  if (isWithin(defaultRepoRoot, resolvedEvidenceRoot)) findings.push("evidenceRoot must be outside the source checkout");
  if (isWithin(defaultRepoRoot, resolvedTrustPolicyPath)) findings.push("trustPolicyPath must be outside the source checkout");
  if (isWithin(resolvedEvidenceRoot, resolvedTrustPolicyPath)) findings.push("trustPolicyPath must be outside the materialized evidence root");
  if (resolvedTrustPolicyPath === resolvedPackagePath) findings.push("trustPolicyPath must be independent from packagePath");
  if (isWithin(defaultRepoRoot, resolvedProductionImageManifestPath)) {
    findings.push("productionImageManifestPath must be outside the source checkout");
  }
  if (isWithin(resolvedEvidenceRoot, resolvedProductionImageManifestPath)) {
    findings.push("productionImageManifestPath must be outside the materialized evidence root");
  }
  if (resolvedProductionImageManifestPath === resolvedPackagePath) {
    findings.push("productionImageManifestPath must be independent from packagePath");
  }
  for (const [candidatePath, label] of [
    [resolvedDeploymentConfigManifestPath, "deploymentConfigManifestPath"],
    [resolvedDeploymentConfigBundlePath, "deploymentConfigBundlePath"],
  ]) {
    if (isWithin(defaultRepoRoot, candidatePath)) findings.push(`${label} must be outside the source checkout`);
    if (isWithin(resolvedEvidenceRoot, candidatePath)) findings.push(`${label} must be outside the materialized evidence root`);
    if (candidatePath === resolvedPackagePath) findings.push(`${label} must be independent from packagePath`);
  }
  if (resolvedControlCatalogPath !== protectedControlCatalogPath) {
    findings.push("controlCatalogPath must identify the catalog in the protected verifier checkout");
  }
  if (!expectedPackageSha256 || !SHA256.test(expectedPackageSha256)) {
    findings.push("expectedPackageSha256 must be 64 lowercase hexadecimal characters");
  }
  const candidate = validateExpectedCandidate(expectedCandidate, findings);
  if (!expectedChainId || !CHAIN_ID.test(expectedChainId)) findings.push("expectedChainId is invalid");
  if (findings.length) throw new HardCutAcceptanceValidationError(findings);

  let productionBinding;
  try {
    productionBinding = loadProductionImageDigestBinding({
      manifestPath: resolvedProductionImageManifestPath,
      expectedManifestSha256: expectedProductionImageManifestSha256,
      expectedCommit: candidate.sourceCommit,
      expectedReleaseChainId: expectedChainId,
    });
  } catch (error) {
    findings.push(`production image manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (productionBinding) {
    try {
      const deploymentConfig = loadVerifiedProductionDeploymentConfig({
        manifestPath: resolvedDeploymentConfigManifestPath,
        bundlePath: resolvedDeploymentConfigBundlePath,
        certificateIdentity: deploymentConfigCertificateIdentity,
        certificateOidcIssuer: deploymentConfigCertificateOidcIssuer,
        expected: {
          candidateId: candidate.candidateId,
          sourceCommit: candidate.sourceCommit,
          signedTag: candidate.signedTag,
          releaseChainId: expectedChainId,
          imageManifestSha256: productionBinding.manifestSha256,
          images: productionBinding.images,
          githubRunId: expectedDeploymentConfigGithubRunId,
          githubRunAttempt: expectedDeploymentConfigGithubRunAttempt,
        },
        verifyBlob: verifyDeploymentConfigBlob,
      });
      if (deploymentConfig.manifestSha256 !== expectedDeploymentConfigManifestSha256) {
        throw new Error(
          `manifest SHA-256 mismatch: expected ${expectedDeploymentConfigManifestSha256}, got ${deploymentConfig.manifestSha256}`,
        );
      }
      productionBinding = {
        ...productionBinding,
        deploymentConfig: deploymentConfig.binding,
      };
    } catch (error) {
      findings.push(`production deployment configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const controlCatalog = await loadProtectedControlCatalog({
    catalogPath: resolvedControlCatalogPath,
    expectedSha256: expectedControlCatalogSha256,
    findings,
  });
  if (!productionBinding || !controlCatalog || findings.length > 0) {
    throw new HardCutAcceptanceValidationError(findings);
  }

  let trustPolicy;
  try {
    trustPolicy = await loadProductionTrustPolicy({
      policyPath: resolvedTrustPolicyPath,
      expectedSha256: expectedTrustPolicySha256,
    });
  } catch (error) {
    if (error instanceof ProductionTrustPolicyError) findings.push(...error.findings);
    else findings.push(`cannot load production trust policy: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!trustPolicy || findings.length > 0) throw new HardCutAcceptanceValidationError(findings);

  try {
    const packageStat = await lstat(resolvedPackagePath);
    if (!packageStat.isFile() || packageStat.isSymbolicLink()) findings.push("packagePath must reference a regular file");
  } catch (error) {
    findings.push(`cannot stat evidence package: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (findings.length) throw new HardCutAcceptanceValidationError(findings);
  const packageRaw = await readFile(resolvedPackagePath);
  const packageSha256 = sha256Bytes(packageRaw);
  if (packageSha256 !== expectedPackageSha256) findings.push("evidence package SHA-256 mismatch");
  let document;
  try {
    document = JSON.parse(packageRaw.toString("utf8"));
  } catch (error) {
    findings.push(`evidence package JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(document)) findings.push("evidence package must be a JSON object");
  if (findings.length) throw new HardCutAcceptanceValidationError(findings);

  validateExactKeys(document, [
    "schemaVersion", "product", "technicalIdentifier", "implementerId", "candidate",
    "createdAtUtc", "acceptedAtUtc", "productionImages", "deploymentConfig", "controlCatalog",
    "hardCutManifest", "files", "gates", "approvals",
  ], "package", findings);
  if (document.schemaVersion !== APPROVAL_PACKAGE_SCHEMA) findings.push(`package schemaVersion must be ${APPROVAL_PACKAGE_SCHEMA}`);
  if (document.product !== "产品工作台") findings.push("package product must be 产品工作台");
  if (document.technicalIdentifier !== "workbench") findings.push("package technicalIdentifier must be workbench");
  if (!identifier(document.implementerId)) findings.push("package implementerId is invalid");
  const createdAt = parseDate(document.createdAtUtc, "package.createdAtUtc", findings);
  const acceptedAt = parseDate(document.acceptedAtUtc, "package.acceptedAtUtc", findings);
  if (createdAt && acceptedAt && acceptedAt > createdAt) findings.push("package acceptedAtUtc must not be after createdAtUtc");
  if (createdAt && nowDate && createdAt > nowDate) findings.push("package.createdAtUtc is in the future");
  if (acceptedAt && nowDate && acceptedAt > nowDate) findings.push("package.acceptedAtUtc is in the future");

  validateCandidate(document.candidate, "package.candidate", findings);
  validateCandidateEquality(document.candidate, candidate, "package.candidate", findings);
  if (document.candidate?.chainId !== expectedChainId) findings.push("package.candidate.chainId does not match the expected release chain");

  const files = validateFiles(document.files, findings);
  validateProductionImages(document.productionImages, productionBinding, findings);
  validateDeploymentConfig(document.deploymentConfig, productionBinding.deploymentConfig, findings);
  validateControlCatalogDescriptor(document.controlCatalog, controlCatalog, files, findings);
  const manifestDescriptor = validateManifestDescriptor(document.hardCutManifest, files, findings);
  const manifest = manifestDescriptor ? parseManifest(files.get(manifestDescriptor.path), findings) : null;
  if (manifest) validateManifestBinding(manifest, document.candidate, productionBinding, controlCatalog, findings);
  validateApprovalTrustEnvironment(trustPolicy, manifest?.candidateBinding?.environmentId, findings);

  validateGates(
    document.gates,
    document.candidate,
    createdAt,
    nowDate,
    files,
    productionBinding,
    controlCatalog,
    findings,
  );
  const latestGateObservedAt = latestGateTimestamp(document.gates, findings);
  validateApprovals({
    value: document.approvals,
    implementerId: document.implementerId,
    createdAtUtc: document.createdAtUtc,
    acceptedAtUtc: document.acceptedAtUtc,
    acceptedAt,
    latestGateObservedAt,
    nowDate,
    files,
    findings,
    candidate: document.candidate,
    productionImages: document.productionImages,
    deploymentConfig: document.deploymentConfig,
    controlCatalog: document.controlCatalog,
    manifestDescriptor,
    gates: document.gates,
    trustPolicy,
  });
  validateSelfReferences(document, manifestDescriptor, findings);

  if (findings.length) throw new HardCutAcceptanceValidationError(findings);
  await materializeEvidenceRoot(resolvedEvidenceRoot, files);
  await validateGateLedgers(
    document.gates,
    manifest,
    resolvedEvidenceRoot,
    acceptedAt,
    productionBinding,
    controlCatalog,
    findings,
  );
  if (findings.length) throw new HardCutAcceptanceValidationError(findings);
  return {
    status: "PASS",
    packageSha256,
    candidate: document.candidate,
    evidenceRoot: resolvedEvidenceRoot,
    manifestPath: path.join(resolvedEvidenceRoot, manifestDescriptor.path),
    trustPolicySha256: trustPolicy.sha256,
    productionImageManifestSha256: productionBinding.manifestSha256,
    deploymentConfigManifestSha256: productionBinding.deploymentConfig.manifestSha256,
    controlCatalogSha256: controlCatalog.sha256,
    gates: REQUIRED_GATES,
    approvals: REQUIRED_APPROVALS,
  };
}

async function loadProtectedControlCatalog({ catalogPath, expectedSha256, findings }) {
  try {
    const stat = await lstat(catalogPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("catalog must be a regular file");
    return await loadProductionAcceptanceControlCatalog({ catalogPath, expectedSha256 });
  } catch (error) {
    if (error instanceof ProductionAcceptanceContractError) {
      findings.push(...error.findings.map((finding) => `protected control catalog: ${finding}`));
    } else {
      findings.push(`cannot read protected control catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

function validateProductionImages(value, expected, findings) {
  validateExactKeys(value, ["manifestSha256", "images"], "package.productionImages", findings);
  if (!isObject(value)) return;
  if (!SHA256.test(value.manifestSha256 ?? "")) findings.push("package.productionImages.manifestSha256 is invalid");
  validateImageDigests(value.images, "package.productionImages.images", findings);
  if (value.manifestSha256 !== expected.manifestSha256) {
    findings.push("package.productionImages.manifestSha256 does not match the CI-owned G4 manifest");
  }
  if (canonicalJson(value.images) !== canonicalJson(expected.images)) {
    findings.push("package.productionImages.images does not match the complete CI-owned G4 image inventory");
  }
}

function validateDeploymentConfig(value, expected, findings) {
  validateExactKeys(value, [
    "schemaVersion",
    "manifestSha256",
    "configSha256",
    "migrationSha256",
    "effectiveConfigSha256",
    "secretVersionsSha256",
    "identity",
    "dependencies",
  ], "package.deploymentConfig", findings);
  if (!isObject(value) || !isObject(expected)) return;
  if (value.schemaVersion !== "workbench.production-deployment-configuration.v1") {
    findings.push("package.deploymentConfig.schemaVersion is invalid");
  }
  for (const field of ["manifestSha256", "configSha256", "migrationSha256", "effectiveConfigSha256", "secretVersionsSha256"]) {
    if (!SHA256.test(value[field] ?? "")) findings.push(`package.deploymentConfig.${field} is invalid`);
  }
  if (canonicalJson(value) !== canonicalJson(expected)) {
    findings.push("package.deploymentConfig differs from the verified CI-owned deployment configuration");
  }
}

function validateControlCatalogDescriptor(value, expected, files, findings) {
  validateExactKeys(value, ["schemaVersion", "sha256"], "package.controlCatalog", findings);
  if (!isObject(value)) return;
  if (value.schemaVersion !== CONTROL_CATALOG_SCHEMA_VERSION) findings.push("package.controlCatalog.schemaVersion is invalid");
  if (!SHA256.test(value.sha256 ?? "")) findings.push("package.controlCatalog.sha256 is invalid");
  if (value.sha256 !== expected.sha256) findings.push("package.controlCatalog.sha256 does not match the protected verifier catalog");
  const embedded = files.get(CONTROL_CATALOG_PACKAGE_PATH);
  if (!embedded) {
    findings.push(`package.files must contain ${CONTROL_CATALOG_PACKAGE_PATH}`);
  } else {
    if (embedded.sha256 !== expected.sha256) findings.push("embedded control catalog SHA-256 mismatch");
    if (!embedded.content.equals(expected.raw)) findings.push("embedded control catalog bytes differ from the protected verifier catalog");
  }
}

async function validateGateLedgers(
  gates,
  manifest,
  evidenceRoot,
  acceptedAt,
  productionBinding,
  controlCatalog,
  findings,
) {
  const expectedBinding = manifest?.candidateBinding;
  if (!isObject(expectedBinding)) return;
  const collection = await loadProductionCollectionContext({
    evidenceRoot,
    gates,
    expectedBinding,
    acceptedAt,
    controlCatalog,
    findings,
  });
  for (const gate of gates) {
    const ledgerPath = path.join(evidenceRoot, ...gate.evidencePath.split("/"));
    let report;
    try {
      report = await verifyEvidenceLedger({
        ledgerPath,
        root: evidenceRoot,
        expectedBinding,
      });
    } catch (error) {
      const details = error instanceof EvidenceValidationError ? error.errors.join("; ") : error instanceof Error ? error.message : String(error);
      findings.push(`${gate.gateId} evidence ledger is invalid: ${details}`);
      continue;
    }
    const document = JSON.parse(await readFile(ledgerPath, "utf8"));
    const entries = document.payload.entries;
    if (entries.length === 0 || entries.some((entry) => entry.gateId !== gate.gateId)) {
      findings.push(`${gate.gateId} evidence ledger entries must all target ${gate.gateId}`);
    }
    for (const entry of entries) {
      if (entry.executionStatus !== "PASS") findings.push(`${gate.gateId} evidence ledger entry ${entry.entryId} must be PASS`);
      if (!["E1", "E2"].includes(entry.evidenceLevel)) findings.push(`${gate.gateId} evidence ledger entry ${entry.entryId} must be E1 or E2`);
      const executedAt = new Date(entry.executedAtUtc);
      if (acceptedAt && executedAt > acceptedAt) findings.push(`${gate.gateId} evidence was executed after package.acceptedAtUtc`);
      const observedAt = new Date(gate.observedAtUtc);
      if (executedAt > observedAt) findings.push(`${gate.gateId} evidence was executed after gate.observedAtUtc`);
      if (collection) {
        try {
          await replayProductionControlObservation({
            entry,
            root: evidenceRoot,
            plan: collection.plan,
            catalog: controlCatalog,
            collectedAtUtc: collection.summary.payload.collectedAtUtc,
          });
        } catch (error) {
          const details = error?.findings?.join("; ") ?? (error instanceof Error ? error.message : String(error));
          findings.push(`${gate.gateId} evidence ledger entry ${entry.entryId} observation replay failed: ${details}`);
        }
      }
    }
    if (report.entries !== entries.length) findings.push(`${gate.gateId} evidence ledger entry count changed during verification`);
    validateBoundDigests(
      report.binding?.digests,
      `${gate.gateId} evidence ledger binding.digests`,
      productionBinding,
      controlCatalog,
      findings,
    );
    validateCatalogEntries(
      entries,
      gate.gateId,
      controlCatalog,
      `${gate.gateId} evidence ledger`,
      findings,
    );
  }
}

async function loadProductionCollectionContext({
  evidenceRoot,
  gates,
  expectedBinding,
  acceptedAt,
  controlCatalog,
  findings,
}) {
  const startFindings = findings.length;
  const collectionPath = path.join(evidenceRoot, COLLECTION_PACKAGE_PATH);
  const planPath = path.join(evidenceRoot, ...PLAN_PACKAGE_PATH.split("/"));
  let raw;
  let summary;
  try {
    raw = await readFile(collectionPath);
    summary = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    findings.push(`production observation collection cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (raw.toString("utf8") !== canonicalJsonFile(summary)) {
    findings.push("production observation collection must be canonical JSON with one trailing LF");
  }
  try {
    await validateProductionObservationCollection(summary);
  } catch (error) {
    findings.push(...(error?.findings ?? [error instanceof Error ? error.message : String(error)]));
  }
  if (summary?.payloadSha256 !== sha256Bytes(Buffer.from(canonicalJson({
    schemaVersion: summary?.schemaVersion,
    payload: summary?.payload,
  }), "utf8"))) {
    findings.push("production observation collection payload seal mismatch");
  }
  if (summary?.payload?.status !== "PASS") findings.push("production observation collection status must be PASS");
  if (canonicalJson(summary?.payload?.binding) !== canonicalJson(expectedBinding)) {
    findings.push("production observation collection binding differs from the hard-cut manifest");
  }
  if (summary?.payload?.catalog?.path !== CONTROL_CATALOG_PACKAGE_PATH
    || summary?.payload?.catalog?.sha256 !== controlCatalog.sha256) {
    findings.push("production observation collection catalog binding mismatch");
  }
  if (summary?.payload?.plan?.path !== PLAN_PACKAGE_PATH) {
    findings.push("production observation collection plan path is not canonical");
  }
  let plan;
  try {
    const loaded = await loadProductionAcceptancePlan({ planPath, catalog: controlCatalog });
    plan = loaded.plan;
    if (loaded.sha256 !== summary?.payload?.plan?.sha256) {
      findings.push("production observation collection plan SHA-256 mismatch");
    }
    if (canonicalJson(plan.payload.binding) !== canonicalJson(expectedBinding)) {
      findings.push("production acceptance plan binding differs from the hard-cut manifest");
    }
  } catch (error) {
    findings.push(`production acceptance plan cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  const collectionGates = summary?.payload?.gates ?? [];
  if (collectionGates.length !== gates.length) findings.push("production observation collection gate count mismatch");
  for (const gate of gates) {
    const collectedGate = collectionGates.find((candidate) => candidate?.gateId === gate.gateId);
    if (!collectedGate) {
      findings.push(`production observation collection is missing ${gate.gateId}`);
      continue;
    }
    if (collectedGate.status !== gate.status
      || collectedGate.observedAtUtc !== gate.observedAtUtc
      || collectedGate.ledger?.path !== gate.evidencePath
      || collectedGate.ledger?.sha256 !== gate.evidenceSha256) {
      findings.push(`production observation collection ${gate.gateId} descriptor differs from the package gate`);
    }
    const expectedCount = controlCatalog.byGate.get(gate.gateId)?.controls.length;
    if (collectedGate.controlCount !== expectedCount) {
      findings.push(`production observation collection ${gate.gateId} controlCount mismatch`);
    }
  }
  const collectedAt = new Date(summary?.payload?.collectedAtUtc);
  if (acceptedAt && collectedAt > acceptedAt) {
    findings.push("production observation collection was sealed after package.acceptedAtUtc");
  }
  if (findings.length > startFindings || !plan) return null;
  return { summary, plan };
}

function validateExpectedCandidate(value, findings) {
  if (!isObject(value)) {
    findings.push("expectedCandidate is required");
    return null;
  }
  const candidate = {
    candidateId: value.candidateId,
    sourceCommit: value.sourceCommit,
    signedTag: value.signedTag,
  };
  if (!CANDIDATE_ID.test(candidate.candidateId ?? "")) findings.push("expected candidateId is invalid");
  if (!COMMIT.test(candidate.sourceCommit ?? "")) findings.push("expected sourceCommit is invalid");
  if (!identifier(candidate.signedTag)) findings.push("expected signedTag is invalid");
  return candidate;
}

function validateCandidate(value, label, findings) {
  validateExactKeys(value, ["candidateId", "sourceCommit", "signedTag", "chainId"], label, findings);
  if (!isObject(value)) return;
  if (!CANDIDATE_ID.test(value.candidateId ?? "")) findings.push(`${label}.candidateId is invalid`);
  if (!COMMIT.test(value.sourceCommit ?? "")) findings.push(`${label}.sourceCommit is invalid`);
  if (!identifier(value.signedTag)) findings.push(`${label}.signedTag is invalid`);
  if (!CHAIN_ID.test(value.chainId ?? "")) findings.push(`${label}.chainId is invalid`);
}

function validateCandidateEquality(actual, expected, label, findings) {
  if (!actual || !expected) return;
  for (const field of ["candidateId", "sourceCommit", "signedTag", "chainId"]) {
    if (expected[field] === undefined) continue;
    if (actual[field] !== expected[field]) findings.push(`${label}.${field} does not match the externally expected candidate`);
  }
}

function validateFiles(value, findings) {
  const files = new Map();
  if (!Array.isArray(value) || value.length === 0) {
    findings.push("package.files must be a non-empty array");
    return files;
  }
  for (const [index, entry] of value.entries()) {
    const label = `package.files[${index}]`;
    validateExactKeys(entry, ["path", "sha256", "contentBase64"], label, findings);
    if (!isObject(entry)) continue;
    const filePath = validateEvidencePath(entry.path, `${label}.path`, findings);
    if (files.has(filePath)) findings.push(`${label}.path is duplicated`);
    if (!SHA256.test(entry.sha256 ?? "")) findings.push(`${label}.sha256 is invalid`);
    if (typeof entry.contentBase64 !== "string" || !isCanonicalBase64(entry.contentBase64)) {
      findings.push(`${label}.contentBase64 must be canonical base64`);
      continue;
    }
    const content = Buffer.from(entry.contentBase64, "base64");
    if (sha256Bytes(content) !== entry.sha256) findings.push(`${label}.sha256 does not match content`);
    files.set(filePath, { path: filePath, sha256: entry.sha256, content });
  }
  return files;
}

function validateManifestDescriptor(value, files, findings) {
  validateExactKeys(value, ["path", "sha256"], "package.hardCutManifest", findings);
  if (!isObject(value)) return null;
  const filePath = validateEvidencePath(value.path, "package.hardCutManifest.path", findings);
  if (!SHA256.test(value.sha256 ?? "")) findings.push("package.hardCutManifest.sha256 is invalid");
  const file = files.get(filePath);
  if (!file) findings.push("package.hardCutManifest.path must be present in package.files");
  else if (file.sha256 !== value.sha256) findings.push("package.hardCutManifest.sha256 does not match its package file");
  return { path: filePath, sha256: value.sha256 };
}

function parseManifest(file, findings) {
  if (!file) return null;
  try {
    const manifest = JSON.parse(file.content.toString("utf8"));
    if (!isObject(manifest)) findings.push("hard-cut manifest must be a JSON object");
    return manifest;
  } catch (error) {
    findings.push(`hard-cut manifest JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validateManifestBinding(manifest, candidate, productionBinding, controlCatalog, findings) {
  if (manifest.product !== "产品工作台") findings.push("hard-cut manifest product must be 产品工作台");
  if (manifest.technicalIdentifier !== "workbench") findings.push("hard-cut manifest technicalIdentifier must be workbench");
  if (manifest.status !== "completed") findings.push("hard-cut manifest status must be completed before acceptance");
  const binding = manifest.candidateBinding;
  if (!isObject(binding)) {
    findings.push("hard-cut manifest candidateBinding is required");
    return;
  }
  validateExactKeys(binding, [
    "candidateId",
    "deployId",
    "environmentId",
    "commitSha",
    "tag",
    "releaseChainId",
    "digests",
  ], "hard-cut manifest candidateBinding", findings);
  for (const [field, expected] of [["candidateId", candidate.candidateId], ["commitSha", candidate.sourceCommit], ["tag", candidate.signedTag]]) {
    if (binding[field] !== expected) findings.push(`hard-cut manifest candidateBinding.${field} does not match the expected candidate`);
  }
  if (binding.releaseChainId !== candidate.chainId) {
    findings.push("hard-cut manifest candidateBinding.releaseChainId does not match the expected release chain");
  }
  validateBoundDigests(
    binding.digests,
    "hard-cut manifest candidateBinding.digests",
    productionBinding,
    controlCatalog,
    findings,
  );
}

function validateGates(
  value,
  candidate,
  createdAt,
  nowDate,
  files,
  productionBinding,
  controlCatalog,
  findings,
) {
  if (!Array.isArray(value)) {
    findings.push("package.gates must be an array");
    return;
  }
  const byId = new Map();
  for (const [index, gate] of value.entries()) {
    const label = `package.gates[${index}]`;
    validateExactKeys(gate, ["gateId", "status", "observedAtUtc", "candidate", "evidencePath", "evidenceSha256"], label, findings);
    if (!isObject(gate)) continue;
    if (byId.has(gate.gateId)) findings.push(`${label}.gateId is duplicated`);
    byId.set(gate.gateId, gate);
    if (!REQUIRED_GATES.includes(gate.gateId)) findings.push(`${label}.gateId must be one of G5-G11`);
    if (gate.status !== "PASS") findings.push(`${label}.status must be PASS`);
    validateCandidate(gate.candidate, `${label}.candidate`, findings);
    validateCandidateEquality(gate.candidate, candidate, `${label}.candidate`, findings);
    const observedAt = parseDate(gate.observedAtUtc, `${label}.observedAtUtc`, findings);
    if (observedAt && createdAt && observedAt > createdAt) findings.push(`${label}.observedAtUtc must be no later than package.createdAtUtc`);
    if (observedAt && nowDate && observedAt > nowDate) findings.push(`${label}.observedAtUtc is in the future`);
    validateEvidenceReference(gate, label, files, findings);
    const evidence = files.get(gate.evidencePath);
    if (evidence) validateGateLedger(
      evidence.content,
      gate,
      candidate,
      files,
      label,
      productionBinding,
      controlCatalog,
      findings,
    );
  }
  for (const gateId of REQUIRED_GATES) if (!byId.has(gateId)) findings.push(`package.gates is missing ${gateId} PASS evidence`);
  if (byId.size !== REQUIRED_GATES.length) findings.push("package.gates must contain exactly G5-G11");
}

function validateGateLedger(
  raw,
  gate,
  candidate,
  files,
  label,
  productionBinding,
  controlCatalog,
  findings,
) {
  let document;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    findings.push(`${label}.evidencePath must contain a JSON evidence ledger: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  validateExactKeys(document, ["schemaVersion", "payload", "payloadSha256"], `${label}.ledger`, findings);
  if (!isObject(document)) return;
  if (document.schemaVersion !== "workbench.evidence-ledger.v1") {
    findings.push(`${label}.evidencePath must contain workbench.evidence-ledger.v1`);
  }
  if (!SHA256.test(document.payloadSha256 ?? "")) {
    findings.push(`${label}.ledger.payloadSha256 is invalid`);
  } else {
    const expectedSeal = sha256Bytes(Buffer.from(canonicalJson({
      schemaVersion: document.schemaVersion,
      payload: document.payload,
    }), "utf8"));
    if (document.payloadSha256 !== expectedSeal) findings.push(`${label}.ledger payload seal mismatch`);
  }
  const payload = document.payload;
  if (!isObject(payload)) return;
  const binding = payload.binding;
  if (!isObject(binding)) {
    findings.push(`${label}.ledger.binding is required`);
  } else {
    validateExactKeys(binding, [
      "candidateId",
      "deployId",
      "environmentId",
      "commitSha",
      "tag",
      "releaseChainId",
      "digests",
    ], `${label}.ledger.binding`, findings);
    for (const [field, expected] of [
      ["candidateId", candidate.candidateId],
      ["commitSha", candidate.sourceCommit],
      ["tag", candidate.signedTag],
      ["releaseChainId", candidate.chainId],
    ]) {
      if (binding[field] !== expected) findings.push(`${label}.ledger.binding.${field} does not match the candidate`);
    }
    if (!identifier(binding.deployId)) findings.push(`${label}.ledger.binding.deployId is invalid`);
    if (!identifier(binding.environmentId)) findings.push(`${label}.ledger.binding.environmentId is invalid`);
    validateBoundDigests(
      binding.digests,
      `${label}.ledger.binding.digests`,
      productionBinding,
      controlCatalog,
      findings,
    );
  }
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    findings.push(`${label}.ledger.entries must be non-empty`);
    return;
  }
  const matchingEntries = payload.entries.filter((entry) => entry?.gateId === gate.gateId);
  if (matchingEntries.length === 0) findings.push(`${label}.ledger must contain an entry for ${gate.gateId}`);
  for (const [index, entry] of payload.entries.entries()) {
    if (!isObject(entry)) {
      findings.push(`${label}.ledger.entries[${index}] must be an object`);
      continue;
    }
    if (entry.gateId !== gate.gateId) findings.push(`${label}.ledger.entries[${index}] must target ${gate.gateId}`);
    if (!isObject(entry.environment) || entry.environment.kind !== "production") {
      findings.push(`${label}.ledger.entries[${index}] must target a production environment`);
    }
    if (entry.executionStatus !== "PASS") findings.push(`${label}.ledger.entries[${index}] must have executionStatus PASS`);
    if (!(["E1", "E2"].includes(entry.evidenceLevel))) {
      findings.push(`${label}.ledger.entries[${index}] must have evidenceLevel E1 or E2`);
    }
    if (entry.binding && binding && canonicalJson(entry.binding) !== canonicalJson(binding)) {
      findings.push(`${label}.ledger.entries[${index}] binding diverges from the ledger`);
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      findings.push(`${label}.ledger.entries[${index}] must contain immutable evidence references`);
    } else {
      for (const [evidenceIndex, evidence] of entry.evidence.entries()) {
        if (!isImmutableEvidenceReference(evidence)) {
          findings.push(`${label}.ledger.entries[${index}].evidence[${evidenceIndex}] is not immutable`);
        } else if (typeof evidence.uri === "string" && evidence.uri.startsWith("file:./")) {
          const referenced = files.get(evidence.uri.slice("file:./".length));
          if (!referenced) findings.push(`${label}.ledger.entries[${index}].evidence[${evidenceIndex}] file is not in the package`);
          else if (referenced.sha256 !== evidence.sha256) findings.push(`${label}.ledger.entries[${index}].evidence[${evidenceIndex}] file hash mismatch`);
        }
      }
    }
  }
  validateCatalogEntries(
    payload.entries,
    gate.gateId,
    controlCatalog,
    `${label}.ledger`,
    findings,
  );
}

function validateBoundDigests(value, label, productionBinding, controlCatalog, findings) {
  validateExactKeys(value, [
    "images",
    "configSha256",
    "migrationSha256",
    "deploymentConfigManifestSha256",
    "imageManifestSha256",
    "controlCatalogSha256",
  ], label, findings);
  if (!isObject(value)) return;
  for (const field of [
    "configSha256",
    "migrationSha256",
    "deploymentConfigManifestSha256",
    "imageManifestSha256",
    "controlCatalogSha256",
  ]) {
    if (!SHA256.test(value[field] ?? "")) findings.push(`${label}.${field} is invalid`);
  }
  validateImageDigests(value.images, `${label}.images`, findings);
  if (value.imageManifestSha256 !== productionBinding.manifestSha256) {
    findings.push(`${label}.imageManifestSha256 does not match the CI-owned G4 manifest`);
  }
  if (value.deploymentConfigManifestSha256 !== productionBinding.deploymentConfig.manifestSha256) {
    findings.push(`${label}.deploymentConfigManifestSha256 does not match the signed deployment configuration`);
  }
  if (value.configSha256 !== productionBinding.deploymentConfig.configSha256) {
    findings.push(`${label}.configSha256 does not match the signed deployment configuration`);
  }
  if (value.migrationSha256 !== productionBinding.deploymentConfig.migrationSha256) {
    findings.push(`${label}.migrationSha256 does not match the signed deployment configuration`);
  }
  if (value.controlCatalogSha256 !== controlCatalog.sha256) {
    findings.push(`${label}.controlCatalogSha256 does not match the protected control catalog`);
  }
  if (canonicalJson(value.images) !== canonicalJson(productionBinding.images)) {
    findings.push(`${label}.images does not match the complete CI-owned G4 image inventory`);
  }
}

function validateImageDigests(value, label, findings) {
  if (!Array.isArray(value) || value.length === 0) {
    findings.push(`${label} must be a non-empty array`);
    return;
  }
  const names = new Set();
  let previousName = "";
  for (const [index, image] of value.entries()) {
    const imageLabel = `${label}[${index}]`;
    validateExactKeys(image, ["name", "digest"], imageLabel, findings);
    if (!isObject(image)) continue;
    if (!identifier(image.name)) findings.push(`${imageLabel}.name is invalid`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(image.digest ?? "")) findings.push(`${imageLabel}.digest is invalid`);
    if (names.has(image.name)) findings.push(`${imageLabel}.name is duplicated`);
    if (previousName && previousName.localeCompare(image.name, "en") >= 0) {
      findings.push(`${label} must be sorted by unique name`);
    }
    names.add(image.name);
    previousName = image.name;
  }
}

function validateCatalogEntries(entries, gateId, catalog, label, findings) {
  try {
    assertGateEntriesMatchCatalog({ gateId, entries, catalog });
  } catch (error) {
    if (error instanceof ProductionAcceptanceContractError) {
      findings.push(...error.findings.map((finding) => `${label}: ${finding}`));
    } else {
      findings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isImmutableEvidenceReference(value) {
  if (!isObject(value) || !SHA256.test(value.sha256 ?? "") || typeof value.uri !== "string") return false;
  if (/^file:\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value.uri)) return true;
  if (/^urn:sha256:[a-f0-9]{64}$/u.test(value.uri)) return value.uri.slice("urn:sha256:".length) === value.sha256;
  if (/^oci:\/\/[^\s?#]+@sha256:[a-f0-9]{64}$/u.test(value.uri)) return value.uri.endsWith(value.sha256);
  try {
    const url = new URL(value.uri);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.hash
      && ![...url.searchParams.keys()].some((key) => /(?:token|secret|credential|signature|sig|auth|key)/iu.test(key))
      && url.href.includes(value.sha256);
  } catch {
    return false;
  }
}

function validateApprovalTrustEnvironment(trustPolicy, expectedEnvironmentId, findings) {
  if (!identifier(expectedEnvironmentId)) {
    findings.push("hard-cut manifest candidateBinding.environmentId is invalid");
    return;
  }
  if (trustPolicy.environmentId !== expectedEnvironmentId) {
    findings.push("trustPolicy.environmentId does not match the hard-cut candidate environment");
  }
}

export function productionApprovalSignaturePayload({
  approval,
  implementerId,
  createdAtUtc,
  acceptedAtUtc,
  candidate,
  productionImages,
  deploymentConfig,
  controlCatalog,
  hardCutManifest,
  gates,
}) {
  const normalizedGates = gates.map((gate) => ({
    gateId: gate.gateId,
    status: gate.status,
    observedAtUtc: gate.observedAtUtc,
    candidate: {
      candidateId: gate.candidate.candidateId,
      sourceCommit: gate.candidate.sourceCommit,
      signedTag: gate.candidate.signedTag,
      chainId: gate.candidate.chainId,
    },
    evidencePath: gate.evidencePath,
    evidenceSha256: gate.evidenceSha256,
  })).sort((left, right) => left.gateId.localeCompare(right.gateId, "en"));
  return {
    schemaVersion: APPROVAL_SIGNATURE_SCHEMA,
    role: approval.role,
    decision: approval.decision,
    approverId: approval.approverId,
    signedAtUtc: approval.signedAtUtc,
    keyId: approval.signature.keyId,
    acceptanceEnvelope: {
      implementerId,
      createdAtUtc,
      acceptedAtUtc,
    },
    candidate: {
      candidateId: candidate.candidateId,
      sourceCommit: candidate.sourceCommit,
      signedTag: candidate.signedTag,
      chainId: candidate.chainId,
    },
    productionImages: {
      manifestSha256: productionImages.manifestSha256,
      images: productionImages.images.map((image) => ({
        name: image.name,
        digest: image.digest,
      })),
    },
    deploymentConfig: {
      schemaVersion: deploymentConfig.schemaVersion,
      manifestSha256: deploymentConfig.manifestSha256,
      configSha256: deploymentConfig.configSha256,
      migrationSha256: deploymentConfig.migrationSha256,
      effectiveConfigSha256: deploymentConfig.effectiveConfigSha256,
      secretVersionsSha256: deploymentConfig.secretVersionsSha256,
      identity: deploymentConfig.identity,
      dependencies: deploymentConfig.dependencies,
    },
    controlCatalog: {
      schemaVersion: controlCatalog.schemaVersion,
      sha256: controlCatalog.sha256,
    },
    hardCutManifest: {
      path: hardCutManifest.path,
      sha256: hardCutManifest.sha256,
    },
    gates: normalizedGates,
    evidence: {
      path: approval.evidencePath,
      sha256: approval.evidenceSha256,
    },
  };
}

function validateApprovals({
  value,
  implementerId,
  createdAtUtc,
  acceptedAtUtc,
  acceptedAt,
  latestGateObservedAt,
  nowDate,
  files,
  findings,
  candidate,
  productionImages,
  deploymentConfig,
  controlCatalog,
  manifestDescriptor,
  gates,
  trustPolicy,
}) {
  if (!Array.isArray(value)) {
    findings.push("package.approvals must be an array");
    return;
  }
  const byRole = new Map();
  const approvers = new Set();
  for (const [index, approval] of value.entries()) {
    const label = `package.approvals[${index}]`;
    validateExactKeys(approval, ["role", "decision", "approverId", "signedAtUtc", "evidencePath", "evidenceSha256", "signature"], label, findings);
    if (!isObject(approval)) continue;
    if (byRole.has(approval.role)) findings.push(`${label}.role is duplicated`);
    byRole.set(approval.role, approval);
    if (!REQUIRED_APPROVALS.includes(approval.role)) findings.push(`${label}.role is not an independent production approval role`);
    if (approval.decision !== "APPROVE") findings.push(`${label}.decision must be APPROVE`);
    if (!identifier(approval.approverId)) findings.push(`${label}.approverId is invalid`);
    if (approval.approverId === implementerId) findings.push(`${label}.approverId must differ from implementerId`);
    if (approvers.has(approval.approverId)) findings.push(`${label}.approverId must be unique across approval roles`);
    approvers.add(approval.approverId);
    const signedAt = parseDate(approval.signedAtUtc, `${label}.signedAtUtc`, findings);
    if (signedAt && acceptedAt && signedAt > acceptedAt) findings.push(`${label}.signedAtUtc must be no later than package.acceptedAtUtc`);
    if (signedAt && latestGateObservedAt && signedAt < latestGateObservedAt) findings.push(`${label}.signedAtUtc must be after all G5-G11 observations`);
    if (signedAt && nowDate && signedAt > nowDate) findings.push(`${label}.signedAtUtc is in the future`);
    validateEvidenceReference(approval, label, files, findings);
    validateApprovalSignature({
      approval,
      label,
      signedAt,
      implementerId,
      createdAtUtc,
      acceptedAtUtc,
      candidate,
      productionImages,
      deploymentConfig,
      controlCatalog,
      manifestDescriptor,
      gates,
      trustPolicy,
      findings,
    });
  }
  for (const role of REQUIRED_APPROVALS) if (!byRole.has(role)) findings.push(`package.approvals is missing ${role} approval`);
  if (byRole.size !== REQUIRED_APPROVALS.length) findings.push("package.approvals must contain exactly Security, Data, Operations, and Release");
}

function validateApprovalSignature({
  approval,
  label,
  signedAt,
  implementerId,
  createdAtUtc,
  acceptedAtUtc,
  candidate,
  productionImages,
  deploymentConfig,
  controlCatalog,
  manifestDescriptor,
  gates,
  trustPolicy,
  findings,
}) {
  validateExactKeys(approval.signature, ["algorithm", "keyId", "value"], `${label}.signature`, findings);
  if (!isObject(approval.signature)) return;
  if (approval.signature.algorithm !== "Ed25519") findings.push(`${label}.signature.algorithm must be Ed25519`);
  if (!identifier(approval.signature.keyId)) findings.push(`${label}.signature.keyId is invalid`);
  if (!isCanonicalBase64Url(approval.signature.value)) findings.push(`${label}.signature.value must be canonical base64url`);
  let authority;
  try {
    authority = resolveApprovalAuthority(trustPolicy, {
      role: approval.role,
      approverId: approval.approverId,
      keyId: approval.signature.keyId,
      signedAt,
    });
  } catch (error) {
    findings.push(`${label}.signature ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (
    !isCanonicalBase64Url(approval.signature.value)
    || !isObject(productionImages)
    || !isObject(deploymentConfig)
    || !isObject(controlCatalog)
    || !manifestDescriptor
    || !Array.isArray(gates)
  ) return;
  try {
    const payload = productionApprovalSignaturePayload({
      approval,
      implementerId,
      createdAtUtc,
      acceptedAtUtc,
      candidate,
      productionImages,
      deploymentConfig,
      controlCatalog,
      hardCutManifest: manifestDescriptor,
      gates,
    });
    const verified = verifyTrustedEd25519Signature({
      key: authority.key,
      payload: canonicalJson(payload),
      signature: approval.signature.value,
    });
    if (!verified) findings.push(`${label}.signature verification failed`);
  } catch (error) {
    findings.push(`${label}.signature could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function latestGateTimestamp(value, findings) {
  if (!Array.isArray(value)) return null;
  const timestamps = value
    .map((gate, index) => parseDate(gate?.observedAtUtc, `package.gates[${index}].observedAtUtc`, findings))
    .filter(Boolean);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps.map((timestamp) => timestamp.getTime()))) : null;
}

function validateEvidenceReference(value, label, files, findings) {
  const evidencePath = validateEvidencePath(value.evidencePath, `${label}.evidencePath`, findings);
  if (!SHA256.test(value.evidenceSha256 ?? "")) findings.push(`${label}.evidenceSha256 is invalid`);
  const file = files.get(evidencePath);
  if (!file) findings.push(`${label}.evidencePath must be present in package.files`);
  else if (file.sha256 !== value.evidenceSha256) findings.push(`${label}.evidenceSha256 does not match its package file`);
}

function validateSelfReferences(document, manifestDescriptor, findings) {
  if (manifestDescriptor?.path === "package.json") findings.push("hard-cut manifest cannot be the acceptance package itself");
  for (const [index, file] of (document.files ?? []).entries()) {
    if (file?.path === "package.json") findings.push(`package.files[${index}] must not contain the acceptance package itself`);
  }
  const serialized = JSON.stringify(document);
  if (serialized.includes("packageSha256")) findings.push("acceptance package must not self-reference its own SHA-256");
}

async function materializeEvidenceRoot(root, files) {
  try {
    const existingStat = await lstat(root);
    if (existingStat.isSymbolicLink()) throw new HardCutAcceptanceValidationError(["evidenceRoot must not be a symbolic link"]);
    if (!existingStat.isDirectory()) throw new HardCutAcceptanceValidationError(["evidenceRoot must be a directory"]);
  } catch (error) {
    if (error instanceof HardCutAcceptanceValidationError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(root, { recursive: true });
  const existing = await readdir(root);
  if (existing.length > 0) throw new HardCutAcceptanceValidationError(["evidenceRoot must be an empty independent directory"]);
  for (const file of files.values()) {
    const destination = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: "wx" });
  }
  for (const file of files.values()) {
    const stat = await lstat(path.join(root, ...file.path.split("/")));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HardCutAcceptanceValidationError([`materialized evidence is not a regular file: ${file.path}`]);
  }
}

function validateEvidencePath(value, label, findings) {
  if (typeof value !== "string" || !EVIDENCE_PATH.test(value) || value.includes("\\") || value.split("/").some((segment) => segment === ".." || segment === "")) {
    findings.push(`${label} must be a repository-relative immutable evidence path`);
    return typeof value === "string" ? value : "";
  }
  return value;
}

function parseDate(value, label, findings) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) findings.push(`${label} is invalid`);
    return value;
  }
  if (typeof value !== "string" || !UTC.test(value)) {
    findings.push(`${label} must be an ISO UTC timestamp`);
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) findings.push(`${label} must be a valid timestamp`);
  return date;
}

function validateExactKeys(value, expected, label, findings) {
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

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseCli(argv) {
  const values = {};
  const aliases = new Map([
    ["--package", "packagePath"],
    ["--package-sha256", "expectedPackageSha256"],
    ["--evidence-root", "evidenceRoot"],
    ["--trust-policy", "trustPolicyPath"],
    ["--trust-policy-sha256", "expectedTrustPolicySha256"],
    ["--expected-candidate-id", "candidateId"],
    ["--expected-source-commit", "sourceCommit"],
    ["--expected-signed-tag", "signedTag"],
    ["--expected-chain-id", "expectedChainId"],
    ["--production-image-manifest", "productionImageManifestPath"],
    ["--production-image-manifest-sha256", "expectedProductionImageManifestSha256"],
    ["--deployment-config-manifest", "deploymentConfigManifestPath"],
    ["--deployment-config-bundle", "deploymentConfigBundlePath"],
    ["--deployment-config-manifest-sha256", "expectedDeploymentConfigManifestSha256"],
    ["--certificate-identity", "deploymentConfigCertificateIdentity"],
    ["--certificate-oidc-issuer", "deploymentConfigCertificateOidcIssuer"],
    ["--github-run-id", "expectedDeploymentConfigGithubRunId"],
    ["--github-run-attempt", "expectedDeploymentConfigGithubRunAttempt"],
    ["--control-catalog", "controlCatalogPath"],
    ["--control-catalog-sha256", "expectedControlCatalogSha256"],
    ["--now", "now"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = aliases.get(argv[index]);
    if (!field) throw new Error(`unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index]} requires a value`);
    if (Object.hasOwn(values, field)) throw new Error(`${argv[index]} was provided more than once`);
    values[field] = value;
    index += 1;
  }
  return values;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = parseCli(process.argv.slice(2));
  verifyHardCutAcceptancePackage({
    packagePath: args.packagePath,
    expectedPackageSha256: args.expectedPackageSha256,
    evidenceRoot: args.evidenceRoot,
    trustPolicyPath: args.trustPolicyPath,
    expectedTrustPolicySha256: args.expectedTrustPolicySha256,
    expectedCandidate: {
      candidateId: args.candidateId,
      sourceCommit: args.sourceCommit,
      signedTag: args.signedTag,
    },
    expectedChainId: args.expectedChainId,
    productionImageManifestPath: args.productionImageManifestPath,
    expectedProductionImageManifestSha256: args.expectedProductionImageManifestSha256,
    deploymentConfigManifestPath: args.deploymentConfigManifestPath,
    deploymentConfigBundlePath: args.deploymentConfigBundlePath,
    deploymentConfigCertificateIdentity: args.deploymentConfigCertificateIdentity,
    deploymentConfigCertificateOidcIssuer: args.deploymentConfigCertificateOidcIssuer,
    expectedDeploymentConfigGithubRunId: args.expectedDeploymentConfigGithubRunId,
    expectedDeploymentConfigGithubRunAttempt: args.expectedDeploymentConfigGithubRunAttempt,
    expectedDeploymentConfigManifestSha256: args.expectedDeploymentConfigManifestSha256,
    controlCatalogPath: args.controlCatalogPath,
    expectedControlCatalogSha256: args.expectedControlCatalogSha256,
    now: args.now ? new Date(args.now) : new Date(),
  }).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
