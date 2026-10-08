#!/usr/bin/env node

import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
  sha256Canonical,
} from "../evidence-ledger.mjs";
import { loadProductionDeploymentConfigBinding } from "../production-deployment-config.mjs";
import { verifyProductionImageManifest } from "../production-image-inventory.mjs";
import {
  CONTROL_CATALOG_SCHEMA_VERSION,
  DEFAULT_CONTROL_CATALOG_PATH,
  ProductionAcceptanceContractError,
  loadProductionAcceptanceControlCatalog,
} from "./catalog.mjs";
import { createStrictAjv2020, isCanonicalUtcDateTime } from "./schema.mjs";

export const ACCEPTANCE_PLAN_SCHEMA_VERSION = "workbench.production-acceptance-plan.v1";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const planSchemaPath = path.join(repoRoot, "schemas/evidence/production-acceptance-plan.schema.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
let planValidatorPromise;

export async function createProductionAcceptancePlan({
  catalogPath = DEFAULT_CONTROL_CATALOG_PATH,
  catalogSha256,
  imageManifestPath,
  imageManifestSha256,
  deploymentConfigManifestPath,
  deploymentConfigManifestSha256,
  candidateId,
  commitSha,
  tag,
  releaseChainId,
  deployId,
  environmentId,
  environmentDescription,
  region,
  plannerId,
  createdAtUtc,
} = {}) {
  const inputFindings = [];
  requirePattern(catalogSha256, SHA256_PATTERN, "catalogSha256", inputFindings);
  requirePattern(imageManifestSha256, SHA256_PATTERN, "imageManifestSha256", inputFindings);
  requirePattern(deploymentConfigManifestSha256, SHA256_PATTERN, "deploymentConfigManifestSha256", inputFindings);
  requirePattern(candidateId, PREFIXED_SHA256_PATTERN, "candidateId", inputFindings);
  requirePattern(commitSha, COMMIT_PATTERN, "commitSha", inputFindings);
  requirePattern(tag, IDENTIFIER_PATTERN, "tag", inputFindings);
  requirePattern(releaseChainId, PREFIXED_SHA256_PATTERN, "releaseChainId", inputFindings);
  requirePattern(deployId, IDENTIFIER_PATTERN, "deployId", inputFindings);
  requirePattern(environmentId, IDENTIFIER_PATTERN, "environmentId", inputFindings);
  requireString(environmentDescription, "environmentDescription", inputFindings, 1024);
  requireString(region, "region", inputFindings, 128);
  requirePattern(plannerId, IDENTIFIER_PATTERN, "plannerId", inputFindings);
  requireUtc(createdAtUtc, "createdAtUtc", inputFindings);
  if (!imageManifestPath) inputFindings.push("imageManifestPath is required");
  if (!deploymentConfigManifestPath) inputFindings.push("deploymentConfigManifestPath is required");
  if (inputFindings.length > 0) throw new ProductionAcceptanceContractError(inputFindings);

  const catalog = await loadProductionAcceptanceControlCatalog({ catalogPath, expectedSha256: catalogSha256 });
  const imageManifestArtifact = await readStableRegularFile(imageManifestPath, "production image manifest");
  const actualImageManifestSha256 = sha256Bytes(imageManifestArtifact.bytes);
  if (actualImageManifestSha256 !== imageManifestSha256) {
    throw new ProductionAcceptanceContractError([
      `production image manifest SHA-256 mismatch: expected ${imageManifestSha256}, got ${actualImageManifestSha256}`,
    ]);
  }
  let imageManifest;
  try {
    imageManifest = JSON.parse(imageManifestArtifact.bytes.toString("utf8"));
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `production image manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  try {
    verifyProductionImageManifest({
      manifest: imageManifest,
      expectedCommit: commitSha,
      expectedReleaseChainId: releaseChainId,
    });
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `production image manifest validation failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const images = imageManifest.images
    .map((image) => ({ name: image.id, digest: image.digest }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  let deploymentConfig;
  try {
    deploymentConfig = loadProductionDeploymentConfigBinding({
      manifestPath: deploymentConfigManifestPath,
      expectedManifestSha256: deploymentConfigManifestSha256,
      expected: {
        candidateId,
        sourceCommit: commitSha,
        signedTag: tag,
        releaseChainId,
        imageManifestSha256,
        images,
      },
    });
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `production deployment configuration validation failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const binding = {
    candidateId,
    deployId,
    environmentId,
    commitSha,
    tag,
    releaseChainId,
    digests: {
      images,
      configSha256: deploymentConfig.binding.configSha256,
      migrationSha256: deploymentConfig.binding.migrationSha256,
      deploymentConfigManifestSha256: deploymentConfig.manifestSha256,
      imageManifestSha256,
      controlCatalogSha256: catalog.sha256,
    },
  };
  const payload = {
    planId: `production-plan-${sha256Canonical(binding).slice(0, 24)}`,
    createdAtUtc,
    plannerId,
    catalog: {
      schemaVersion: CONTROL_CATALOG_SCHEMA_VERSION,
      catalogId: catalog.document.catalogId,
      sha256: catalog.sha256,
    },
    deploymentConfig: deploymentConfig.binding,
    binding,
    environment: {
      environmentId,
      kind: "production",
      description: environmentDescription,
      region,
    },
    gates: catalog.document.gates.map((gate) => ({
      gateId: gate.gateId,
      controls: gate.controls.map((control) => control.controlId),
    })),
  };
  const plan = {
    schemaVersion: ACCEPTANCE_PLAN_SCHEMA_VERSION,
    payload,
    payloadSha256: sha256Canonical({ schemaVersion: ACCEPTANCE_PLAN_SCHEMA_VERSION, payload }),
  };
  await validatePlanDocument(plan);
  assertPlanMatchesCatalog(plan, catalog);
  return {
    plan,
    catalog,
    imageManifest,
    imageManifestBytes: imageManifestArtifact.bytes,
    deploymentConfig: deploymentConfig.document,
  };
}

export async function loadProductionAcceptancePlan({ planPath, catalog } = {}) {
  const artifact = await readStableRegularFile(planPath, "production acceptance plan");
  let plan;
  try {
    plan = JSON.parse(artifact.bytes.toString("utf8"));
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `production acceptance plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (artifact.bytes.toString("utf8") !== canonicalJsonFile(plan)) {
    throw new ProductionAcceptanceContractError(["production acceptance plan must be canonical JSON with one trailing LF"]);
  }
  await validatePlanDocument(plan);
  const expectedSeal = sha256Canonical({ schemaVersion: plan.schemaVersion, payload: plan.payload });
  if (plan.payloadSha256 !== expectedSeal) {
    throw new ProductionAcceptanceContractError(["production acceptance plan payload seal mismatch"]);
  }
  if (catalog) assertPlanMatchesCatalog(plan, catalog);
  return Object.freeze({ plan, raw: artifact.bytes, sha256: sha256Bytes(artifact.bytes), path: artifact.path });
}

export function assertPlanMatchesCatalog(plan, catalog) {
  const findings = [];
  if (plan?.payload?.catalog?.schemaVersion !== CONTROL_CATALOG_SCHEMA_VERSION) {
    findings.push("plan control catalog schemaVersion mismatch");
  }
  if (plan?.payload?.catalog?.catalogId !== catalog?.document?.catalogId) {
    findings.push("plan control catalog ID mismatch");
  }
  if (plan?.payload?.catalog?.sha256 !== catalog?.sha256) {
    findings.push("plan control catalog SHA-256 mismatch");
  }
  if (plan?.payload?.binding?.digests?.controlCatalogSha256 !== catalog?.sha256) {
    findings.push("plan binding controlCatalogSha256 mismatch");
  }
  const deploymentConfig = plan?.payload?.deploymentConfig;
  const digests = plan?.payload?.binding?.digests;
  if (deploymentConfig?.manifestSha256 !== digests?.deploymentConfigManifestSha256) {
    findings.push("plan deploymentConfig manifest SHA-256 mismatch");
  }
  if (deploymentConfig?.configSha256 !== digests?.configSha256) {
    findings.push("plan deploymentConfig config SHA-256 mismatch");
  }
  if (deploymentConfig?.migrationSha256 !== digests?.migrationSha256) {
    findings.push("plan deploymentConfig migration SHA-256 mismatch");
  }
  const expectedGates = catalog.document.gates.map((gate) => ({
    gateId: gate.gateId,
    controls: gate.controls.map((control) => control.controlId),
  }));
  if (canonicalJson(plan?.payload?.gates) !== canonicalJson(expectedGates)) {
    findings.push("plan gates and control IDs must exactly match the protected catalog");
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
  return true;
}

async function writePlan(outputPath, plan) {
  const resolvedOutput = path.resolve(outputPath);
  await assertOutsideRepository(resolvedOutput);
  const handle = await open(resolvedOutput, "wx", 0o600);
  try {
    await handle.writeFile(canonicalJsonFile(plan), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validatePlanDocument(plan) {
  const validate = await planSchemaValidator();
  if (validate(plan)) return true;
  throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
    `production acceptance plan${error.instancePath || "/"} ${error.message}`
  )));
}

async function planSchemaValidator() {
  planValidatorPromise ??= readFile(planSchemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return planValidatorPromise;
}

async function readStableRegularFile(candidatePath, label) {
  const resolvedPath = path.resolve(candidatePath ?? "");
  const before = await lstat(resolvedPath).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ProductionAcceptanceContractError([`${label} must be a regular non-symlink file`]);
  }
  const canonicalPath = await realpath(resolvedPath);
  const bytes = await readFile(canonicalPath);
  const after = await lstat(canonicalPath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new ProductionAcceptanceContractError([`${label} changed while it was read`]);
  }
  return { path: canonicalPath, bytes };
}

async function assertOutsideRepository(outputPath) {
  const canonicalRepo = await realpath(repoRoot);
  const canonicalParent = await realpath(path.dirname(outputPath));
  const resolved = path.join(canonicalParent, path.basename(outputPath));
  const relative = path.relative(canonicalRepo, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new ProductionAcceptanceContractError(["production acceptance outputs must be outside the source repository"]);
  }
}

function requirePattern(value, pattern, label, findings) {
  if (typeof value !== "string" || !pattern.test(value)) findings.push(`${label} is invalid`);
}

function requireString(value, label, findings, maxLength) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) findings.push(`${label} is invalid`);
}

function requireUtc(value, label, findings) {
  if (!isCanonicalUtcDateTime(value)) {
    findings.push(`${label} must be a valid UTC timestamp`);
  }
}

function parseArguments(argv) {
  const result = { catalogPath: DEFAULT_CONTROL_CATALOG_PATH };
  const names = new Map([
    ["--catalog", "catalogPath"],
    ["--catalog-sha256", "catalogSha256"],
    ["--image-manifest", "imageManifestPath"],
    ["--image-manifest-sha256", "imageManifestSha256"],
    ["--deployment-config-manifest", "deploymentConfigManifestPath"],
    ["--deployment-config-manifest-sha256", "deploymentConfigManifestSha256"],
    ["--candidate-id", "candidateId"],
    ["--source-commit", "commitSha"],
    ["--signed-tag", "tag"],
    ["--release-chain-id", "releaseChainId"],
    ["--deploy-id", "deployId"],
    ["--environment-id", "environmentId"],
    ["--environment-description", "environmentDescription"],
    ["--region", "region"],
    ["--planner-id", "plannerId"],
    ["--created-at", "createdAtUtc"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key) throw new Error(`unsupported argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index - 1]} requires a value`);
    if (result[key] !== undefined && key !== "catalogPath") throw new Error(`${argv[index - 1]} was provided more than once`);
    result[key] = value;
  }
  if (!result.outputPath) throw new Error("--output is required");
  return result;
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const { plan } = await createProductionAcceptancePlan(args);
    await writePlan(args.outputPath, plan);
    process.stdout.write(`${JSON.stringify({
      status: "READY",
      planId: plan.payload.planId,
      output: path.resolve(args.outputPath),
      payloadSha256: plan.payloadSha256,
      controlCount: plan.payload.gates.reduce((count, gate) => count + gate.controls.length, 0),
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
