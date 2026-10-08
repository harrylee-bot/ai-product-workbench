#!/usr/bin/env node

import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
  sha256Canonical,
  verifyEvidenceLedger,
} from "../evidence-ledger.mjs";
import { loadVerifiedProductionDeploymentConfig } from "../production-deployment-config.mjs";
import { loadProductionImageDigestBinding } from "../production-image-inventory.mjs";
import { validateHardCutManifest } from "../workbench-hard-cut-manifest.mjs";
import {
  productionApprovalSignaturePayload,
  verifyHardCutAcceptancePackage,
} from "../verify-workbench-hard-cut-acceptance.mjs";
import {
  PRODUCTION_APPROVAL_ROLES,
  loadProductionTrustPolicy,
  resolveApprovalAuthority,
  verifyTrustedEd25519Signature,
} from "../workbench-production-trust-policy.mjs";
import {
  CONTROL_CATALOG_PACKAGE_PATH,
  CONTROL_CATALOG_SCHEMA_VERSION,
  DEFAULT_CONTROL_CATALOG_PATH,
  ProductionAcceptanceContractError,
  REQUIRED_PRODUCTION_GATES,
  assertGateEntriesMatchCatalog,
  loadProductionAcceptanceControlCatalog,
} from "./catalog.mjs";
import {
  validateProductionObservationCollection,
} from "./collect.mjs";
import { loadProductionAcceptancePlan } from "./plan.mjs";
import { replayProductionControlObservation } from "./replay.mjs";
import { createStrictAjv2020, isCanonicalUtcDateTime } from "./schema.mjs";

export const HARD_CUT_ACCEPTANCE_PACKAGE_SCHEMA_VERSION = "workbench.hard-cut-acceptance-package.v3";
export const PRODUCTION_APPROVAL_SET_SCHEMA_VERSION = "workbench.production-approval-set.v1";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const packageSchemaPath = path.join(repoRoot, "schemas/evidence/hard-cut-acceptance-package.schema.json");
const approvalSetSchemaPath = path.join(repoRoot, "schemas/evidence/production-approval-set.schema.json");
const COLLECTION_SCHEMA_VERSION = "workbench.production-observation-collection.v1";
const PLAN_PACKAGE_PATH = "governance/production-acceptance-plan.json";
const COLLECTION_PACKAGE_PATH = "collection.json";
const HARD_CUT_MANIFEST_NAME = "manifest.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const PACKAGE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
let packageValidatorPromise;
let approvalSetValidatorPromise;

export async function assembleProductionAcceptancePackage({
  collectionRoot,
  hardCutRoot,
  approvalsPath,
  approvalEvidenceRoot,
  productionImageManifestPath,
  deploymentConfigManifestPath,
  deploymentConfigBundlePath,
  certificateIdentity,
  certificateOidcIssuer,
  githubRunId,
  githubRunAttempt,
  trustPolicyPath,
  expectedTrustPolicySha256,
  implementerId,
  acceptedAtUtc,
  createdAtUtc,
  outputPath,
  catalogPath = DEFAULT_CONTROL_CATALOG_PATH,
  verifyDeploymentConfigBlob,
  now = new Date(),
} = {}) {
  const findings = [];
  requireIdentifier(implementerId, "implementerId", findings);
  requireUtc(acceptedAtUtc, "acceptedAtUtc", findings);
  requireUtc(createdAtUtc, "createdAtUtc", findings);
  if (!SHA256_PATTERN.test(expectedTrustPolicySha256 ?? "")) findings.push("expectedTrustPolicySha256 is invalid");
  if (!collectionRoot) findings.push("collectionRoot is required");
  if (!hardCutRoot) findings.push("hardCutRoot is required");
  if (!approvalsPath) findings.push("approvalsPath is required");
  if (!approvalEvidenceRoot) findings.push("approvalEvidenceRoot is required");
  if (!productionImageManifestPath) findings.push("productionImageManifestPath is required");
  if (!deploymentConfigManifestPath) findings.push("deploymentConfigManifestPath is required");
  if (!deploymentConfigBundlePath) findings.push("deploymentConfigBundlePath is required");
  if (!certificateIdentity) findings.push("certificateIdentity is required");
  if (!certificateOidcIssuer) findings.push("certificateOidcIssuer is required");
  if (!/^[1-9][0-9]*$/u.test(String(githubRunId ?? ""))) findings.push("githubRunId is invalid");
  if (!Number.isSafeInteger(Number(githubRunAttempt)) || Number(githubRunAttempt) < 1) findings.push("githubRunAttempt is invalid");
  if (!trustPolicyPath) findings.push("trustPolicyPath is required");
  if (!outputPath) findings.push("outputPath is required");
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) findings.push("now is invalid");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const collectionDirectory = await canonicalExternalDirectory(collectionRoot, "collection root");
  const hardCutDirectory = await canonicalExternalDirectory(hardCutRoot, "hard-cut evidence root");
  const approvalDirectory = await canonicalExternalDirectory(approvalEvidenceRoot, "approval evidence root");
  assertRootsDoNotOverlap([
    [collectionDirectory, "collection root"],
    [hardCutDirectory, "hard-cut evidence root"],
    [approvalDirectory, "approval evidence root"],
  ]);
  const destination = await validateOutputPath(outputPath, [collectionDirectory, hardCutDirectory, approvalDirectory]);

  const catalog = await loadProductionAcceptanceControlCatalog({ catalogPath });
  const collection = await loadAndVerifyCollection({ collectionDirectory, catalog });
  const binding = collection.plan.payload.binding;
  let productionImages;
  try {
    productionImages = loadProductionImageDigestBinding({
      manifestPath: productionImageManifestPath,
      expectedManifestSha256: binding.digests.imageManifestSha256,
      expectedCommit: binding.commitSha,
      expectedReleaseChainId: binding.releaseChainId,
    });
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `production image manifest validation failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (canonicalJson(productionImages.images) !== canonicalJson(binding.digests.images)) {
    throw new ProductionAcceptanceContractError([
      "production image manifest inventory differs from the sealed acceptance binding",
    ]);
  }
  let deploymentConfig;
  try {
    deploymentConfig = loadVerifiedProductionDeploymentConfig({
      manifestPath: deploymentConfigManifestPath,
      bundlePath: deploymentConfigBundlePath,
      certificateIdentity,
      certificateOidcIssuer,
      expected: {
        candidateId: binding.candidateId,
        sourceCommit: binding.commitSha,
        signedTag: binding.tag,
        releaseChainId: binding.releaseChainId,
        imageManifestSha256: binding.digests.imageManifestSha256,
        images: binding.digests.images,
        configSha256: binding.digests.configSha256,
        migrationSha256: binding.digests.migrationSha256,
        githubRunId,
        githubRunAttempt,
      },
      verifyBlob: verifyDeploymentConfigBlob,
    });
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `production deployment configuration validation failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (deploymentConfig.manifestSha256 !== binding.digests.deploymentConfigManifestSha256) {
    throw new ProductionAcceptanceContractError([
      "production deployment configuration manifest differs from the sealed acceptance binding",
    ]);
  }

  const candidate = candidateFromBinding(binding);
  const gates = collection.summary.payload.gates.map((gate) => ({
    gateId: gate.gateId,
    status: gate.status,
    observedAtUtc: gate.observedAtUtc,
    candidate,
    evidencePath: gate.ledger.path,
    evidenceSha256: gate.ledger.sha256,
  }));
  const files = new Map(collection.files.map((file) => [file.path, file]));

  const hardCutFiles = await readHardCutTree(hardCutDirectory);
  const hardCutManifestPath = HARD_CUT_MANIFEST_NAME;
  const hardCutManifestFile = hardCutFiles.find((file) => file.path === hardCutManifestPath);
  if (!hardCutManifestFile) {
    throw new ProductionAcceptanceContractError([
      `hard-cut evidence root must contain ${HARD_CUT_MANIFEST_NAME}`,
    ]);
  }
  const hardCutManifest = parseJsonBytes(hardCutManifestFile.content, "hard-cut manifest");
  assertHardCutManifestBinding(hardCutManifest, binding);
  addUniqueFiles(files, hardCutFiles, "hard-cut evidence");
  const hardCutManifestDescriptor = {
    path: hardCutManifestPath,
    sha256: hardCutManifestFile.sha256,
  };

  const approvalsArtifact = await readCanonicalDocument(approvalsPath, "production approval set");
  await validateApprovalSetSchema(approvalsArtifact.document);
  const approvals = validateApprovalSet(approvalsArtifact.document);
  const approvalFiles = await readApprovalEvidenceFiles(approvalDirectory, approvals);
  addUniqueFiles(files, approvalFiles, "approval evidence");

  const packageDocument = {
    schemaVersion: HARD_CUT_ACCEPTANCE_PACKAGE_SCHEMA_VERSION,
    product: "产品工作台",
    technicalIdentifier: "workbench",
    implementerId,
    candidate,
    createdAtUtc,
    acceptedAtUtc,
    productionImages: {
      manifestSha256: productionImages.manifestSha256,
      images: productionImages.images,
    },
    deploymentConfig: deploymentConfig.binding,
    controlCatalog: {
      schemaVersion: CONTROL_CATALOG_SCHEMA_VERSION,
      sha256: catalog.sha256,
    },
    hardCutManifest: hardCutManifestDescriptor,
    files: [...files.values()]
      .sort((left, right) => compareStrings(left.path, right.path))
      .map(({ path: filePath, sha256, content }) => ({
        path: filePath,
        sha256,
        contentBase64: content.toString("base64"),
      })),
    gates,
    approvals,
  };

  const accepted = new Date(acceptedAtUtc);
  const created = new Date(createdAtUtc);
  const collected = new Date(collection.summary.payload.collectedAtUtc);
  if (accepted < collected) findings.push("acceptedAtUtc must be no earlier than evidence collection");
  if (created < accepted) findings.push("createdAtUtc must be no earlier than acceptedAtUtc");
  if (created > nowDate) findings.push("createdAtUtc must not be in the future");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  await validatePackageSchema(packageDocument);
  const trustPolicy = await loadProductionTrustPolicy({
    policyPath: trustPolicyPath,
    expectedSha256: expectedTrustPolicySha256,
  }).catch((error) => {
    throw new ProductionAcceptanceContractError([
      `production trust policy validation failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  });
  if (trustPolicy.environmentId !== binding.environmentId) {
    throw new ProductionAcceptanceContractError([
      "production trust policy environment differs from the acceptance binding",
    ]);
  }
  verifyApprovalSignatures({
    approvals,
    implementerId,
    createdAtUtc,
    acceptedAtUtc,
    acceptedAt: accepted,
    gates,
    candidate,
    productionImages: packageDocument.productionImages,
    deploymentConfig: packageDocument.deploymentConfig,
    controlCatalog: packageDocument.controlCatalog,
    hardCutManifest: hardCutManifestDescriptor,
    trustPolicy,
  });

  const raw = Buffer.from(canonicalJsonFile(packageDocument), "utf8");
  const sha256 = sha256Bytes(raw);
  await verifyAssembledPackage({
    raw,
    outputParent: path.dirname(destination),
    trustPolicyPath,
    expectedTrustPolicySha256,
    productionImageManifestPath,
    deploymentConfigManifestPath,
    deploymentConfigBundlePath,
    certificateIdentity,
    certificateOidcIssuer,
    githubRunId,
    githubRunAttempt,
    verifyDeploymentConfigBlob,
    candidate,
    catalog,
    now: nowDate,
  });
  await writeExclusive(destination, raw);
  return Object.freeze({
    status: "PASS",
    outputPath: destination,
    sha256,
    candidate,
    gates: REQUIRED_PRODUCTION_GATES,
    approvals: PRODUCTION_APPROVAL_ROLES,
    fileCount: packageDocument.files.length,
    document: packageDocument,
  });
}

export async function loadVerifiedProductionAcceptanceCollection({
  collectionRoot,
  catalogPath = DEFAULT_CONTROL_CATALOG_PATH,
} = {}) {
  const collectionDirectory = await canonicalExternalDirectory(collectionRoot, "collection root");
  const catalog = await loadProductionAcceptanceControlCatalog({ catalogPath });
  const collection = await loadAndVerifyCollection({ collectionDirectory, catalog });
  return Object.freeze({ collectionDirectory, catalog, ...collection });
}

async function loadAndVerifyCollection({ collectionDirectory, catalog }) {
  const summaryArtifact = await readCanonicalDocument(
    path.join(collectionDirectory, COLLECTION_PACKAGE_PATH),
    "production observation collection",
  );
  const summary = summaryArtifact.document;
  await validateProductionObservationCollection(summary);
  const findings = [];
  exactKeys(summary, ["schemaVersion", "payload", "payloadSha256"], "collection", findings);
  if (summary.schemaVersion !== COLLECTION_SCHEMA_VERSION) findings.push("collection schemaVersion is invalid");
  if (summary.payloadSha256 !== sha256Canonical({ schemaVersion: summary.schemaVersion, payload: summary.payload })) {
    findings.push("collection payload seal mismatch");
  }
  exactKeys(summary.payload, [
    "collectionId", "collectedAtUtc", "status", "plan", "catalog", "binding", "gates",
  ], "collection.payload", findings);
  requireIdentifier(summary.payload?.collectionId, "collection.payload.collectionId", findings);
  requireUtc(summary.payload?.collectedAtUtc, "collection.payload.collectedAtUtc", findings);
  if (summary.payload?.status !== "PASS") findings.push("collection status must be PASS");
  validateDescriptor(summary.payload?.plan, PLAN_PACKAGE_PATH, "collection.payload.plan", findings);
  exactKeys(summary.payload?.catalog, ["schemaVersion", "path", "sha256"], "collection.payload.catalog", findings);
  if (summary.payload?.catalog?.schemaVersion !== CONTROL_CATALOG_SCHEMA_VERSION) {
    findings.push("collection catalog schemaVersion mismatch");
  }
  if (summary.payload?.catalog?.path !== CONTROL_CATALOG_PACKAGE_PATH) findings.push("collection catalog path mismatch");
  if (summary.payload?.catalog?.sha256 !== catalog.sha256) findings.push("collection catalog SHA-256 mismatch");
  if (!Array.isArray(summary.payload?.gates)) findings.push("collection gates must be an array");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const embeddedCatalog = await readStableRegularFile(
    packagePath(collectionDirectory, CONTROL_CATALOG_PACKAGE_PATH),
    "embedded control catalog",
  );
  if (!embeddedCatalog.bytes.equals(catalog.raw)) {
    throw new ProductionAcceptanceContractError(["embedded control catalog differs from the protected catalog"]);
  }
  const loadedPlan = await loadProductionAcceptancePlan({
    planPath: packagePath(collectionDirectory, PLAN_PACKAGE_PATH),
    catalog,
  });
  if (loadedPlan.sha256 !== summary.payload.plan.sha256) findings.push("collection plan SHA-256 mismatch");
  if (canonicalJson(loadedPlan.plan.payload.binding) !== canonicalJson(summary.payload.binding)) {
    findings.push("collection binding differs from its sealed plan");
  }

  const actualGateIds = summary.payload.gates.map((gate) => gate?.gateId);
  if (canonicalJson(actualGateIds) !== canonicalJson(REQUIRED_PRODUCTION_GATES)) {
    findings.push("collection gates must be exactly G5-G11 in order");
  }
  const requiredFiles = new Set([
    COLLECTION_PACKAGE_PATH,
    PLAN_PACKAGE_PATH,
    CONTROL_CATALOG_PACKAGE_PATH,
  ]);
  for (const [index, gate] of summary.payload.gates.entries()) {
    const label = `collection.payload.gates[${index}]`;
    exactKeys(gate, ["gateId", "status", "controlCount", "observedAtUtc", "ledger"], label, findings);
    if (gate.status !== "PASS") findings.push(`${label}.status must be PASS`);
    requireUtc(gate.observedAtUtc, `${label}.observedAtUtc`, findings);
    exactKeys(gate.ledger, ["path", "sha256"], `${label}.ledger`, findings);
    if (gate.ledger?.path !== `gates/${String(gate.gateId).toLowerCase()}.json`) {
      findings.push(`${label}.ledger.path is not canonical`);
      continue;
    }
    if (!SHA256_PATTERN.test(gate.ledger?.sha256 ?? "")) findings.push(`${label}.ledger.sha256 is invalid`);
    requiredFiles.add(gate.ledger.path);
    const ledgerPath = packagePath(collectionDirectory, gate.ledger.path);
    const ledgerArtifact = await readStableRegularFile(ledgerPath, `${gate.gateId} ledger`);
    if (sha256Bytes(ledgerArtifact.bytes) !== gate.ledger.sha256) findings.push(`${gate.gateId} ledger SHA-256 mismatch`);
    let report;
    try {
      report = await verifyEvidenceLedger({
        ledgerPath,
        root: collectionDirectory,
        expectedBinding: summary.payload.binding,
      });
    } catch (error) {
      findings.push(`${gate.gateId} ledger verification failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const ledger = parseJsonBytes(ledgerArtifact.bytes, `${gate.gateId} ledger`);
    try {
      assertGateEntriesMatchCatalog({ gateId: gate.gateId, entries: ledger.payload.entries, catalog });
    } catch (error) {
      findings.push(...(error?.findings ?? [String(error)]));
    }
    if (report.entries !== gate.controlCount) findings.push(`${gate.gateId} controlCount mismatch`);
    if (ledger.payload.entries.some((entry) => entry.executionStatus !== "PASS")) {
      findings.push(`${gate.gateId} contains a non-PASS control`);
    }
    const latestTime = Math.max(...ledger.payload.entries.map((entry) => new Date(entry.executedAtUtc).getTime()));
    if (new Date(gate.observedAtUtc).getTime() !== latestTime) {
      findings.push(`${gate.gateId} observedAtUtc is not the latest control observation`);
    }
    for (const entry of ledger.payload.entries) {
      const observationPath = `observations/${entry.entryId}.json`;
      requiredFiles.add(observationPath);
      try {
        await replayProductionControlObservation({
          entry,
          root: collectionDirectory,
          plan: loadedPlan.plan,
          catalog,
          collectedAtUtc: summary.payload.collectedAtUtc,
        });
      } catch (error) {
        findings.push(`${entry.entryId} observation replay failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const reference of [
        ...entry.evidence,
        ...entry.retryRecords.flatMap((retry) => retry.evidence),
      ]) {
        if (reference.uri.startsWith("file:./")) requiredFiles.add(reference.uri.slice("file:./".length));
      }
    }
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const actualFiles = await walkRegularFiles(collectionDirectory);
  const actualPaths = actualFiles.map((file) => file.path);
  const expectedPaths = [...requiredFiles].sort(compareStrings);
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new ProductionAcceptanceContractError([
      "collection root must contain exactly its sealed governance, gate, observation, and raw evidence files",
    ]);
  }
  return {
    summary,
    plan: loadedPlan.plan,
    files: actualFiles,
  };
}

async function validateApprovalSetSchema(document) {
  const validate = await approvalSetSchemaValidator();
  if (validate(document)) return true;
  throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
    `production approval set${error.instancePath || "/"} ${error.message}`
  )));
}

function validateApprovalSet(document) {
  const findings = [];
  exactKeys(document, ["schemaVersion", "approvals"], "approval set", findings);
  if (document?.schemaVersion !== PRODUCTION_APPROVAL_SET_SCHEMA_VERSION) findings.push("approval set schemaVersion is invalid");
  if (!Array.isArray(document?.approvals)) findings.push("approval set approvals must be an array");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
  const actualRoles = document.approvals.map((approval) => approval?.role);
  if (canonicalJson(actualRoles) !== canonicalJson(PRODUCTION_APPROVAL_ROLES)) {
    findings.push("approval set must contain Security, Data, Operations, and Release in order");
  }
  for (const [index, approval] of document.approvals.entries()) {
    const label = `approval set approvals[${index}]`;
    exactKeys(approval, [
      "role", "decision", "approverId", "signedAtUtc", "evidencePath", "evidenceSha256", "signature",
    ], label, findings);
    if (approval.decision !== "APPROVE") findings.push(`${label}.decision must be APPROVE`);
    requireIdentifier(approval.approverId, `${label}.approverId`, findings);
    requireUtc(approval.signedAtUtc, `${label}.signedAtUtc`, findings);
    const expectedPath = `approvals/${String(approval.role).toLowerCase()}.json`;
    if (approval.evidencePath !== expectedPath) findings.push(`${label}.evidencePath must be ${expectedPath}`);
    if (!SHA256_PATTERN.test(approval.evidenceSha256 ?? "")) findings.push(`${label}.evidenceSha256 is invalid`);
    exactKeys(approval.signature, ["algorithm", "keyId", "value"], `${label}.signature`, findings);
    if (approval.signature?.algorithm !== "Ed25519") findings.push(`${label}.signature.algorithm must be Ed25519`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(approval.signature?.keyId ?? "")) findings.push(`${label}.signature.keyId is invalid`);
    if (!/^[A-Za-z0-9_-]{86}$/u.test(approval.signature?.value ?? "")) findings.push(`${label}.signature.value is invalid`);
  }
  if (new Set(document.approvals.map((approval) => approval.approverId)).size !== PRODUCTION_APPROVAL_ROLES.length) {
    findings.push("approval set approverId values must be unique");
  }
  if (new Set(document.approvals.map((approval) => approval.signature?.keyId)).size !== PRODUCTION_APPROVAL_ROLES.length) {
    findings.push("approval set signing keys must be unique");
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
  return structuredClone(document.approvals);
}

async function readApprovalEvidenceFiles(root, approvals) {
  const actual = await walkRegularFiles(root);
  const expected = approvals.map((approval) => approval.evidencePath.slice("approvals/".length)).sort(compareStrings);
  if (canonicalJson(actual.map((file) => file.path)) !== canonicalJson(expected)) {
    throw new ProductionAcceptanceContractError([
      "approval evidence root must contain exactly one evidence file for each required approval role",
    ]);
  }
  return actual.map((file) => {
    const packaged = { ...file, path: `approvals/${file.path}` };
    const approval = approvals.find((candidate) => candidate.evidencePath === packaged.path);
    if (!approval || approval.evidenceSha256 !== packaged.sha256) {
      throw new ProductionAcceptanceContractError([`${packaged.path} SHA-256 differs from the approval set`]);
    }
    return packaged;
  });
}

function verifyApprovalSignatures({
  approvals,
  implementerId,
  createdAtUtc,
  acceptedAtUtc,
  acceptedAt,
  gates,
  candidate,
  productionImages,
  deploymentConfig,
  controlCatalog,
  hardCutManifest,
  trustPolicy,
}) {
  const findings = [];
  const latestGate = new Date(Math.max(...gates.map((gate) => new Date(gate.observedAtUtc).getTime())));
  for (const approval of approvals) {
    const label = `${approval.role} approval`;
    const signedAt = new Date(approval.signedAtUtc);
    if (approval.approverId === implementerId) findings.push(`${label} approver must differ from implementerId`);
    if (signedAt < latestGate) findings.push(`${label} was signed before all G5-G11 observations`);
    if (signedAt > acceptedAt) findings.push(`${label} was signed after acceptedAtUtc`);
    let authority;
    try {
      authority = resolveApprovalAuthority(trustPolicy, {
        role: approval.role,
        approverId: approval.approverId,
        keyId: approval.signature.keyId,
        signedAt,
      });
      const payload = productionApprovalSignaturePayload({
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
      });
      if (!verifyTrustedEd25519Signature({
        key: authority.key,
        payload: canonicalJson(payload),
        signature: approval.signature.value,
      })) findings.push(`${label} signature verification failed`);
    } catch (error) {
      findings.push(`${label} signature validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
}

async function verifyAssembledPackage({
  raw,
  outputParent,
  trustPolicyPath,
  expectedTrustPolicySha256,
  productionImageManifestPath,
  deploymentConfigManifestPath,
  deploymentConfigBundlePath,
  certificateIdentity,
  certificateOidcIssuer,
  githubRunId,
  githubRunAttempt,
  verifyDeploymentConfigBlob,
  candidate,
  catalog,
  now,
}) {
  const temporaryRoot = await mkdtemp(path.join(outputParent, ".workbench-acceptance-verify-"));
  try {
    const temporaryPackage = path.join(temporaryRoot, "acceptance.json");
    const evidenceRoot = path.join(temporaryRoot, "evidence");
    await writeExclusive(temporaryPackage, raw);
    await verifyHardCutAcceptancePackage({
      packagePath: temporaryPackage,
      expectedPackageSha256: sha256Bytes(raw),
      evidenceRoot,
      trustPolicyPath,
      expectedTrustPolicySha256,
      expectedCandidate: {
        candidateId: candidate.candidateId,
        sourceCommit: candidate.sourceCommit,
        signedTag: candidate.signedTag,
      },
      expectedChainId: candidate.chainId,
      productionImageManifestPath,
      expectedProductionImageManifestSha256: rawPackageManifestSha256(raw),
      deploymentConfigManifestPath,
      deploymentConfigBundlePath,
      deploymentConfigCertificateIdentity: certificateIdentity,
      deploymentConfigCertificateOidcIssuer: certificateOidcIssuer,
      expectedDeploymentConfigGithubRunId: githubRunId,
      expectedDeploymentConfigGithubRunAttempt: githubRunAttempt,
      expectedDeploymentConfigManifestSha256: JSON.parse(raw.toString("utf8")).deploymentConfig.manifestSha256,
      verifyDeploymentConfigBlob,
      controlCatalogPath: catalog.path,
      expectedControlCatalogSha256: catalog.sha256,
      now,
    });
    const hardCutReport = await validateHardCutManifest({
      root: evidenceRoot,
      manifestPath: HARD_CUT_MANIFEST_NAME,
      enforce: true,
      expectedCandidateId: candidate.candidateId,
      expectedSourceCommit: candidate.sourceCommit,
      expectedSignedTag: candidate.signedTag,
      expectedReleaseChainId: candidate.chainId,
      productionImageManifestPath,
      expectedProductionImageManifestSha256: rawPackageManifestSha256(raw),
      deploymentConfigManifestPath,
      expectedDeploymentConfigManifestSha256: JSON.parse(raw.toString("utf8")).deploymentConfig.manifestSha256,
      controlCatalogPath: catalog.path,
      expectedControlCatalogSha256: catalog.sha256,
      trustPolicyPath,
      expectedTrustPolicySha256,
      now,
    });
    if (hardCutReport.findings.length > 0 || hardCutReport.status !== "ready") {
      throw new ProductionAcceptanceContractError([
        ...hardCutReport.findings.map((finding) => `hard-cut enforce: ${finding}`),
        ...(hardCutReport.status === "ready" ? [] : [`hard-cut enforce status is ${hardCutReport.status}`]),
      ]);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function rawPackageManifestSha256(raw) {
  return JSON.parse(raw.toString("utf8")).productionImages.manifestSha256;
}

function assertHardCutManifestBinding(manifest, binding) {
  const findings = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) findings.push("hard-cut manifest must be an object");
  if (manifest?.product !== "产品工作台") findings.push("hard-cut manifest product must be 产品工作台");
  if (manifest?.technicalIdentifier !== "workbench") findings.push("hard-cut manifest technicalIdentifier must be workbench");
  if (manifest?.status !== "completed") findings.push("hard-cut manifest status must be completed");
  if (canonicalJson(manifest?.candidateBinding) !== canonicalJson(binding)) {
    findings.push("hard-cut manifest candidateBinding differs from the sealed acceptance plan");
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
}

function candidateFromBinding(binding) {
  return Object.freeze({
    candidateId: binding.candidateId,
    sourceCommit: binding.commitSha,
    signedTag: binding.tag,
    chainId: binding.releaseChainId,
  });
}

async function validatePackageSchema(document) {
  const validate = await packageSchemaValidator();
  if (validate(document)) return true;
  throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
    `hard-cut acceptance package${error.instancePath || "/"} ${error.message}`
  )));
}

async function packageSchemaValidator() {
  packageValidatorPromise ??= readFile(packageSchemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return packageValidatorPromise;
}

async function approvalSetSchemaValidator() {
  approvalSetValidatorPromise ??= readFile(approvalSetSchemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return approvalSetValidatorPromise;
}

async function readHardCutTree(root) {
  const files = await walkRegularFiles(root);
  if (files.some((file) => path.basename(file.path) === "package.json")) {
    throw new ProductionAcceptanceContractError(["staged hard-cut evidence must not contain package.json"]);
  }
  return files;
}

async function walkRegularFiles(root, relative = "") {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (!safePackagePath(nextRelative)) {
      throw new ProductionAcceptanceContractError([`${nextRelative} is not a safe evidence path`]);
    }
    if (entry.isSymbolicLink()) throw new ProductionAcceptanceContractError([`${nextRelative} must not be a symbolic link`]);
    if (entry.isDirectory()) {
      files.push(...await walkRegularFiles(root, nextRelative));
      continue;
    }
    if (!entry.isFile()) throw new ProductionAcceptanceContractError([`${nextRelative} must be a regular file`]);
    const artifact = await readStableRegularFile(path.join(root, ...nextRelative.split("/")), `evidence ${nextRelative}`);
    files.push({ path: nextRelative, sha256: sha256Bytes(artifact.bytes), content: artifact.bytes });
  }
  return files.sort((left, right) => compareStrings(left.path, right.path));
}

function addUniqueFiles(target, files, label) {
  for (const file of files) {
    if (target.has(file.path)) {
      throw new ProductionAcceptanceContractError([`${label} path collides with ${file.path}`]);
    }
    target.set(file.path, file);
  }
}

async function readCanonicalDocument(candidatePath, label) {
  const artifact = await readStableRegularFile(candidatePath, label);
  const document = parseJsonBytes(artifact.bytes, label);
  if (artifact.bytes.toString("utf8") !== canonicalJsonFile(document)) {
    throw new ProductionAcceptanceContractError([`${label} must be canonical JSON with one trailing LF`]);
  }
  return { ...artifact, document };
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

async function readStableRegularFile(candidatePath, label) {
  const resolved = path.resolve(candidatePath ?? "");
  const before = await lstat(resolved).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ProductionAcceptanceContractError([`${label} must be a regular non-symlink file`]);
  }
  const canonical = await realpath(resolved);
  const bytes = await readFile(canonical);
  const after = await lstat(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new ProductionAcceptanceContractError([`${label} changed while it was read`]);
  }
  return { path: canonical, bytes };
}

async function canonicalExternalDirectory(candidatePath, label) {
  const resolved = path.resolve(candidatePath ?? "");
  const stat = await lstat(resolved).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProductionAcceptanceContractError([`${label} must be a real directory`]);
  }
  const canonical = await realpath(resolved);
  if (isWithin(repoRoot, canonical)) throw new ProductionAcceptanceContractError([`${label} must be outside the source repository`]);
  return canonical;
}

async function validateOutputPath(candidatePath, sourceRoots) {
  const resolved = path.resolve(candidatePath ?? "");
  const parent = await realpath(path.dirname(resolved)).catch((error) => {
    throw new ProductionAcceptanceContractError([`output parent cannot be read: ${error.message}`]);
  });
  const canonical = path.join(parent, path.basename(resolved));
  if (isWithin(repoRoot, canonical)) throw new ProductionAcceptanceContractError(["package output must be outside the source repository"]);
  for (const root of sourceRoots) {
    if (isWithin(root, canonical) || isWithin(canonical, root)) {
      throw new ProductionAcceptanceContractError(["package output must not overlap an evidence source root"]);
    }
  }
  try {
    await lstat(canonical);
    throw new ProductionAcceptanceContractError(["package output must not already exist"]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return canonical;
}

function assertRootsDoNotOverlap(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (isWithin(roots[left][0], roots[right][0]) || isWithin(roots[right][0], roots[left][0])) {
        throw new ProductionAcceptanceContractError([`${roots[left][1]} and ${roots[right][1]} must not overlap`]);
      }
    }
  }
}

function validateDescriptor(value, expectedPath, label, findings) {
  exactKeys(value, ["path", "sha256"], label, findings);
  if (value?.path !== expectedPath) findings.push(`${label}.path must be ${expectedPath}`);
  if (!SHA256_PATTERN.test(value?.sha256 ?? "")) findings.push(`${label}.sha256 is invalid`);
}

function packagePath(root, relativePath) {
  if (!safePackagePath(relativePath)) throw new ProductionAcceptanceContractError([`${relativePath} is not a safe package path`]);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, resolved)) throw new ProductionAcceptanceContractError([`${relativePath} escapes the evidence root`]);
  return resolved;
}

function safePackagePath(value) {
  return typeof value === "string"
    && PACKAGE_PATH_PATTERN.test(value)
    && !value.includes("\\")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function exactKeys(value, expected, label, findings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push(`${label} must be an object`);
    return;
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    findings.push(`${label} must contain exactly: ${[...expected].sort().join(", ")}`);
  }
}

function requireIdentifier(value, label, findings) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) findings.push(`${label} is invalid`);
}

function requireUtc(value, label, findings) {
  if (!isCanonicalUtcDateTime(value)) {
    findings.push(`${label} must be a valid UTC timestamp`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function writeExclusive(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

function parseArguments(argv) {
  const values = { catalogPath: DEFAULT_CONTROL_CATALOG_PATH };
  const aliases = new Map([
    ["--collection-root", "collectionRoot"],
    ["--hard-cut-root", "hardCutRoot"],
    ["--approvals", "approvalsPath"],
    ["--approval-evidence-root", "approvalEvidenceRoot"],
    ["--production-image-manifest", "productionImageManifestPath"],
    ["--deployment-config-manifest", "deploymentConfigManifestPath"],
    ["--deployment-config-bundle", "deploymentConfigBundlePath"],
    ["--certificate-identity", "certificateIdentity"],
    ["--certificate-oidc-issuer", "certificateOidcIssuer"],
    ["--github-run-id", "githubRunId"],
    ["--github-run-attempt", "githubRunAttempt"],
    ["--trust-policy", "trustPolicyPath"],
    ["--trust-policy-sha256", "expectedTrustPolicySha256"],
    ["--implementer-id", "implementerId"],
    ["--accepted-at", "acceptedAtUtc"],
    ["--created-at", "createdAtUtc"],
    ["--catalog", "catalogPath"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = aliases.get(argv[index]);
    if (!key) throw new Error(`unsupported argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index - 1]} requires a value`);
    if (Object.hasOwn(values, key) && key !== "catalogPath") throw new Error(`${argv[index - 1]} was provided more than once`);
    values[key] = value;
  }
  return values;
}

async function main() {
  try {
    const result = await assembleProductionAcceptancePackage(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      output: result.outputPath,
      sha256: result.sha256,
      fileCount: result.fileCount,
      gates: result.gates,
      approvals: result.approvals,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
