#!/usr/bin/env node

import {
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
} from "../evidence-ledger.mjs";
import { loadVerifiedProductionDeploymentConfig } from "../production-deployment-config.mjs";
import { loadProductionImageDigestBinding } from "../production-image-inventory.mjs";
import { productionApprovalSignaturePayload } from "../verify-workbench-hard-cut-acceptance.mjs";
import { PRODUCTION_APPROVAL_ROLES } from "../workbench-production-trust-policy.mjs";
import {
  ProductionAcceptanceContractError,
} from "./catalog.mjs";
import { loadVerifiedProductionAcceptanceCollection } from "./assemble-package.mjs";
import { isCanonicalUtcDateTime } from "./schema.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const KEY_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export async function prepareProductionApprovalPayload({
  collectionRoot,
  hardCutRoot,
  productionImageManifestPath,
  deploymentConfigManifestPath,
  deploymentConfigBundlePath,
  certificateIdentity,
  certificateOidcIssuer,
  githubRunId,
  githubRunAttempt,
  verifyDeploymentConfigBlob,
  role,
  approverId,
  keyId,
  signedAtUtc,
  approvalEvidencePath,
  implementerId,
  acceptedAtUtc,
  createdAtUtc,
  outputPath,
  now = new Date(),
} = {}) {
  const findings = [];
  if (!PRODUCTION_APPROVAL_ROLES.includes(role)) findings.push("role is invalid");
  requireIdentifier(approverId, "approverId", findings);
  requireIdentifier(implementerId, "implementerId", findings);
  if (!KEY_ID_PATTERN.test(keyId ?? "")) findings.push("keyId is invalid");
  for (const [label, value] of [
    ["signedAtUtc", signedAtUtc],
    ["acceptedAtUtc", acceptedAtUtc],
    ["createdAtUtc", createdAtUtc],
  ]) requireUtc(value, label, findings);
  if (!collectionRoot) findings.push("collectionRoot is required");
  if (!hardCutRoot) findings.push("hardCutRoot is required");
  if (!productionImageManifestPath) findings.push("productionImageManifestPath is required");
  if (!deploymentConfigManifestPath) findings.push("deploymentConfigManifestPath is required");
  if (!deploymentConfigBundlePath) findings.push("deploymentConfigBundlePath is required");
  if (!certificateIdentity) findings.push("certificateIdentity is required");
  if (!certificateOidcIssuer) findings.push("certificateOidcIssuer is required");
  if (!/^[1-9][0-9]*$/u.test(String(githubRunId ?? ""))) findings.push("githubRunId is invalid");
  if (!Number.isSafeInteger(Number(githubRunAttempt)) || Number(githubRunAttempt) < 1) {
    findings.push("githubRunAttempt is invalid");
  }
  if (!approvalEvidencePath) findings.push("approvalEvidencePath is required");
  if (!outputPath) findings.push("outputPath is required");
  if (approverId === implementerId) findings.push("approverId must differ from implementerId");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const loadedCollection = await loadVerifiedProductionAcceptanceCollection({ collectionRoot });
  const binding = loadedCollection.plan.payload.binding;
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
    throw new ProductionAcceptanceContractError(["production image inventory differs from the acceptance plan"]);
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
  if (deploymentConfig.manifestSha256 !== binding.digests.deploymentConfigManifestSha256
    || canonicalJson(deploymentConfig.binding) !== canonicalJson(loadedCollection.plan.payload.deploymentConfig)) {
    throw new ProductionAcceptanceContractError([
      "production deployment configuration differs from the sealed acceptance plan",
    ]);
  }

  const hardCutDirectory = await canonicalExternalDirectory(hardCutRoot, "hard-cut evidence root");
  const manifestArtifact = await readStableRegularFile(path.join(hardCutDirectory, "manifest.json"), "hard-cut manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestArtifact.bytes.toString("utf8"));
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `hard-cut manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (manifest.product !== "产品工作台"
    || manifest.technicalIdentifier !== "workbench"
    || manifest.status !== "completed"
    || canonicalJson(manifest.candidateBinding) !== canonicalJson(binding)) {
    throw new ProductionAcceptanceContractError([
      "hard-cut manifest is not a completed manifest for the acceptance plan binding",
    ]);
  }
  const evidenceArtifact = await readStableRegularFile(approvalEvidencePath, `${role} approval evidence`);
  if (isWithin(repoRoot, evidenceArtifact.path)) {
    throw new ProductionAcceptanceContractError(["approval evidence must be outside the source repository"]);
  }
  if (path.basename(evidenceArtifact.path) !== `${role.toLowerCase()}.json`) {
    throw new ProductionAcceptanceContractError([
      `${role} approval evidence file must be named ${role.toLowerCase()}.json`,
    ]);
  }
  const evidencePath = `approvals/${role.toLowerCase()}.json`;
  const candidate = {
    candidateId: binding.candidateId,
    sourceCommit: binding.commitSha,
    signedTag: binding.tag,
    chainId: binding.releaseChainId,
  };
  const gates = loadedCollection.summary.payload.gates.map((gate) => ({
    gateId: gate.gateId,
    status: gate.status,
    observedAtUtc: gate.observedAtUtc,
    candidate,
    evidencePath: gate.ledger.path,
    evidenceSha256: gate.ledger.sha256,
  }));
  const approval = {
    role,
    decision: "APPROVE",
    approverId,
    signedAtUtc,
    evidencePath,
    evidenceSha256: sha256Bytes(evidenceArtifact.bytes),
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: "A".repeat(86),
    },
  };
  const payload = productionApprovalSignaturePayload({
    approval,
    implementerId,
    createdAtUtc,
    acceptedAtUtc,
    candidate,
    productionImages: {
      manifestSha256: productionImages.manifestSha256,
      images: productionImages.images,
    },
    deploymentConfig: deploymentConfig.binding,
    controlCatalog: {
      schemaVersion: loadedCollection.catalog.document.schemaVersion,
      sha256: loadedCollection.catalog.sha256,
    },
    hardCutManifest: {
      path: "manifest.json",
      sha256: sha256Bytes(manifestArtifact.bytes),
    },
    gates,
  });
  const signedAt = new Date(signedAtUtc);
  const acceptedAt = new Date(acceptedAtUtc);
  const createdAt = new Date(createdAtUtc);
  const nowDate = now instanceof Date ? now : new Date(now);
  const latestGate = Math.max(...gates.map((gate) => new Date(gate.observedAtUtc).getTime()));
  if (signedAt.getTime() < latestGate) findings.push("signedAtUtc must be no earlier than all gate observations");
  if (acceptedAt < new Date(loadedCollection.summary.payload.collectedAtUtc)) {
    findings.push("acceptedAtUtc must be no earlier than evidence collection");
  }
  if (signedAt > acceptedAt) findings.push("signedAtUtc must be no later than acceptedAtUtc");
  if (acceptedAt > createdAt) findings.push("acceptedAtUtc must be no later than createdAtUtc");
  if (!Number.isFinite(nowDate.getTime()) || createdAt > nowDate) findings.push("createdAtUtc must not be in the future");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const output = await validateOutputPath(outputPath);
  const raw = Buffer.from(canonicalJsonFile(payload), "utf8");
  await writeExclusive(output, raw);
  return Object.freeze({
    status: "READY",
    outputPath: output,
    sha256: sha256Bytes(raw),
    approval: {
      role,
      decision: "APPROVE",
      approverId,
      signedAtUtc,
      evidencePath,
      evidenceSha256: approval.evidenceSha256,
      signature: { algorithm: "Ed25519", keyId },
    },
    payload,
  });
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

async function validateOutputPath(candidatePath) {
  const resolved = path.resolve(candidatePath ?? "");
  const parent = await realpath(path.dirname(resolved)).catch((error) => {
    throw new ProductionAcceptanceContractError([`approval payload output parent cannot be read: ${error.message}`]);
  });
  const output = path.join(parent, path.basename(resolved));
  if (isWithin(repoRoot, output)) throw new ProductionAcceptanceContractError(["approval payload output must be outside the source repository"]);
  try {
    await lstat(output);
    throw new ProductionAcceptanceContractError(["approval payload output must not already exist"]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return output;
}

async function writeExclusive(destination, bytes) {
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
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

function parseArguments(argv) {
  const values = {};
  const aliases = new Map([
    ["--collection-root", "collectionRoot"],
    ["--hard-cut-root", "hardCutRoot"],
    ["--production-image-manifest", "productionImageManifestPath"],
    ["--deployment-config-manifest", "deploymentConfigManifestPath"],
    ["--deployment-config-bundle", "deploymentConfigBundlePath"],
    ["--certificate-identity", "certificateIdentity"],
    ["--certificate-oidc-issuer", "certificateOidcIssuer"],
    ["--github-run-id", "githubRunId"],
    ["--github-run-attempt", "githubRunAttempt"],
    ["--role", "role"],
    ["--approver-id", "approverId"],
    ["--key-id", "keyId"],
    ["--signed-at", "signedAtUtc"],
    ["--approval-evidence", "approvalEvidencePath"],
    ["--implementer-id", "implementerId"],
    ["--accepted-at", "acceptedAtUtc"],
    ["--created-at", "createdAtUtc"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = aliases.get(argv[index]);
    if (!key) throw new Error(`unsupported argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index - 1]} requires a value`);
    if (Object.hasOwn(values, key)) throw new Error(`${argv[index - 1]} was provided more than once`);
    values[key] = value;
  }
  return values;
}

async function main() {
  try {
    const report = await prepareProductionApprovalPayload(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      output: report.outputPath,
      sha256: report.sha256,
      approval: report.approval,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
