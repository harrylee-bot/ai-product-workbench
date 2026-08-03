#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadVerifiedProductionDeploymentConfig,
  verifyProductionDeploymentEnvironment,
  verifyProductionDeploymentRuntimeBinding,
} from "./production-deployment-config.mjs";
import { loadProductionImageDigestBinding } from "./production-image-inventory.mjs";
import { loadProductionTrustPolicy } from "./workbench-production-trust-policy.mjs";
import { readDeploymentEnv } from "./workbench-origin-manifest.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(moduleDirectory, "..");
const SHA256 = /^[a-f0-9]{64}$/u;

export async function assertProductionDeploymentConfig({
  environment,
  repoRoot = defaultRepoRoot,
  verifyBlob,
} = {}) {
  const values = environment instanceof Map ? environment : new Map(Object.entries(environment ?? {}));
  const manifestPath = required(values, "WORKBENCH_DEPLOYMENT_CONFIG_MANIFEST_PATH");
  const bundlePath = required(values, "WORKBENCH_DEPLOYMENT_CONFIG_BUNDLE_PATH");
  const expectedManifestSha256 = requiredSha256(values, "WORKBENCH_DEPLOYMENT_CONFIG_MANIFEST_SHA256");
  const sourceCommit = required(values, "WORKBENCH_SOURCE_COMMIT");
  const releaseChainId = required(values, "WORKBENCH_RELEASE_CHAIN_ID");
  const imageManifestPath = required(values, "WORKBENCH_IMAGE_INVENTORY_PATH");
  const imageManifestSha256 = sha256(readFileSync(path.resolve(imageManifestPath)));
  const productionImages = loadProductionImageDigestBinding({
    manifestPath: imageManifestPath,
    expectedManifestSha256: imageManifestSha256,
    expectedCommit: sourceCommit,
    expectedReleaseChainId: releaseChainId,
  });
  const loaded = loadVerifiedProductionDeploymentConfig({
    manifestPath,
    bundlePath,
    certificateIdentity: required(values, "WORKBENCH_COSIGN_CERTIFICATE_IDENTITY"),
    certificateOidcIssuer: required(values, "WORKBENCH_COSIGN_OIDC_ISSUER"),
    expected: {
      candidateId: required(values, "WORKBENCH_CANDIDATE_ID"),
      sourceCommit,
      signedTag: required(values, "WORKBENCH_SIGNED_TAG"),
      releaseChainId,
      imageManifestSha256,
      images: productionImages.images,
      githubRunId: required(values, "WORKBENCH_RELEASE_CHAIN_RUN_ID"),
      githubRunAttempt: required(values, "WORKBENCH_RELEASE_CHAIN_RUN_ATTEMPT"),
    },
    repoRoot,
    verifySourceFiles: true,
    verifyBlob,
  });
  if (loaded.manifestSha256 !== expectedManifestSha256) {
    throw new Error("deployment configuration manifest SHA-256 mismatch");
  }
  verifyProductionDeploymentEnvironment(loaded.document, values);
  const trustPolicy = await loadProductionTrustPolicy({
    policyPath: required(values, "WORKBENCH_PRODUCTION_TRUST_POLICY_PATH"),
    expectedSha256: requiredSha256(values, "WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256"),
  });
  verifyProductionDeploymentRuntimeBinding(loaded.binding, {
    environmentId: required(values, "WORKBENCH_ENVIRONMENT_ID"),
    trustPolicy,
  });
  return Object.freeze({
    status: "PASS",
    candidateId: loaded.document.candidate.candidateId,
    environmentId: loaded.binding.runtimeWorkerExecution.environmentId,
    manifestSha256: loaded.manifestSha256,
    workflowRun: loaded.document.workflowRun,
  });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--env-file", "--repo-root"].includes(name)
      || !value
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw new Error("usage: assert-production-deployment-config.mjs --env-file <path> [--repo-root <path>]");
    }
    values.set(name, value);
  }
  if (!values.has("--env-file")) {
    throw new Error("usage: assert-production-deployment-config.mjs --env-file <path> [--repo-root <path>]");
  }
  return {
    envFile: path.resolve(values.get("--env-file")),
    repoRoot: path.resolve(values.get("--repo-root") ?? defaultRepoRoot),
  };
}

function required(environment, name) {
  const value = environment.get(name)?.trim();
  if (!value || value.includes("REPLACE_WITH_")) throw new Error(`${name} is required`);
  return value;
}

function requiredSha256(environment, name) {
  const value = required(environment, name);
  if (!SHA256.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  try {
    const { envFile, repoRoot } = parseArguments(process.argv.slice(2));
    const environment = readDeploymentEnv(readFileSync(envFile));
    process.stdout.write(`${JSON.stringify(await assertProductionDeploymentConfig({ environment, repoRoot }))}\n`);
  } catch (error) {
    process.stderr.write(`production deployment configuration: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
