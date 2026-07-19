#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { readDeploymentEnv } from "./workbench-origin-manifest.mjs";

const root = new URL("../", import.meta.url);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function loadProductionImageInventory() {
  return JSON.parse(readText("deploy/production-image-inventory.json"));
}

export function assertProductionImageContract({ inventory = loadProductionImageInventory() } = {}) {
  assert(inventory?.schemaVersion === 1, "production image inventory schemaVersion must be 1");
  assert(Array.isArray(inventory.candidateImages), "candidateImages must be an array");
  const ids = inventory.candidateImages.map((entry) => entry.id);
  assert(new Set(ids).size === ids.length, "candidate image IDs must be unique");
  assertDeepEqual(ids, [...ids].sort(), "candidate image inventory must be sorted by id");
  assert(ids.includes("import-worker"), "Import Worker must be a candidate image");
  assert(ids.includes("deerflow"), "the derived DeerFlow runtime must be a candidate image");

  const composeCache = new Map();
  for (const image of inventory.candidateImages) {
    assertImageDefinition(image);
    const compose = composeCache.get(image.composeFile) ?? readYaml(image.composeFile);
    composeCache.set(image.composeFile, compose);
    const service = compose.services?.[image.composeService];
    assert(service, `${image.id} Compose service ${image.composeService} is missing`);
    const imageTemplate = "${" + image.imageEnvironment;
    assert(
      String(service.image).includes(imageTemplate),
      `${image.id} Compose image must be controlled by ${image.imageEnvironment}`,
    );
    assert(
      readText(image.dockerfile).includes(` AS ${image.target}`),
      `${image.id} Dockerfile must expose target ${image.target}`,
    );
  }

  const ci = readYaml(".github/workflows/workbench-ci.yml");
  const matrix = ci.jobs?.["production-images"]?.strategy?.matrix?.include ?? [];
  const matrixById = new Map(matrix.map((entry) => [entry.name, entry]));
  for (const image of inventory.candidateImages) {
    const entry = matrixById.get(image.id);
    assert(entry, `production image CI matrix is missing ${image.id}`);
    assert(entry.dockerfile === image.dockerfile, `${image.id} CI Dockerfile differs from inventory`);
    assert(entry.target === image.target, `${image.id} CI target differs from inventory`);
  }
  assertDeepEqual(
    [...matrixById.keys()].sort(),
    [...ids].sort(),
    "production image CI matrix and deploy inventory must contain the same image IDs",
  );

  const workflowSource = readText(".github/workflows/workbench-ci.yml");
  for (const marker of [
    "mode=max",
    "sbom:",
    "docker/login-action",
    "actions/attest-build-provenance",
    "actions/attest-sbom",
    "aquasecurity/trivy-action",
    "cosign sign",
    "production-image-inventory.mjs --assemble",
  ]) {
    assert(workflowSource.includes(marker), `production image workflow is missing ${marker}`);
  }
  return inventory;
}

export function verifyProductionImageManifest({
  manifest,
  expectedCommit,
  deploymentEnvironment,
  onlyImageId,
  inventory = loadProductionImageInventory(),
}) {
  assertProductionImageContract({ inventory });
  assert(COMMIT_PATTERN.test(expectedCommit), "expected candidate commit must be 40 lowercase hex characters");
  assert(manifest?.schemaVersion === 1, "image evidence manifest schemaVersion must be 1");
  assert(manifest?.candidate?.sourceCommit === expectedCommit, "image evidence candidate commit mismatch");
  assert(Array.isArray(manifest.images), "image evidence manifest images must be an array");

  const expectedImages = onlyImageId
    ? inventory.candidateImages.filter((entry) => entry.id === onlyImageId)
    : inventory.candidateImages;
  assert(expectedImages.length > 0, `unknown candidate image: ${onlyImageId}`);
  const records = new Map(manifest.images.map((entry) => [entry.id, entry]));
  assert(records.size === manifest.images.length, "image evidence manifest contains duplicate IDs");
  if (!onlyImageId) {
    assertDeepEqual(
      [...records.keys()].sort(),
      inventory.candidateImages.map((entry) => entry.id).sort(),
      "image evidence manifest must contain the exact deploy inventory",
    );
  }

  for (const image of expectedImages) {
    const record = records.get(image.id);
    assert(record, `image evidence is missing ${image.id}`);
    verifyImageRecord(record, expectedCommit);
    if (deploymentEnvironment) {
      const deployedRef = deploymentEnvironment.get(image.imageEnvironment)?.trim();
      assert(deployedRef === record.imageRef, `${image.imageEnvironment} does not match signed image evidence`);
    }
  }
  return true;
}

export function assembleProductionImageManifest({ records, expectedCommit }) {
  const inventory = assertProductionImageContract();
  const manifest = {
    schemaVersion: 1,
    candidate: { sourceCommit: expectedCommit },
    images: [...records].sort((left, right) => left.id.localeCompare(right.id)),
  };
  verifyProductionImageManifest({ manifest, expectedCommit, inventory });
  return manifest;
}

function verifyImageRecord(record, expectedCommit) {
  assert(typeof record?.id === "string" && record.id.length > 0, "image record id is required");
  assert(DIGEST_PATTERN.test(record.digest), `${record.id} digest must be immutable sha256`);
  assert(record.imageRef?.endsWith(`@${record.digest}`), `${record.id} imageRef must end with its digest`);
  assert(record.sourceCommit === expectedCommit, `${record.id} source commit mismatch`);
  verifyEvidence(record.sbom, `${record.id} SBOM`);
  verifyEvidence(record.provenance, `${record.id} provenance`);
  verifyEvidence(record.signature, `${record.id} signature`);
  verifyEvidence(record.signature.verification, `${record.id} signature verification`);
  verifyEvidence(record.vulnerabilityReport, `${record.id} vulnerability report`);
  assert(record.signature.verified === true, `${record.id} signature was not independently verified`);
  assert(record.vulnerabilityReport.status === "PASS", `${record.id} vulnerability scan did not pass`);
  assert(record.vulnerabilityReport.critical === 0, `${record.id} has critical vulnerabilities`);
  assert(record.vulnerabilityReport.high === 0, `${record.id} has high vulnerabilities`);
}

function verifyEvidence(evidence, label) {
  assert(evidence && typeof evidence === "object", `${label} evidence is required`);
  assert(SHA256_PATTERN.test(evidence.sha256), `${label} SHA-256 is invalid`);
  assert(
    evidence.uri === `urn:sha256:${evidence.sha256}` || isImmutableUri(evidence.uri),
    `${label} URI must be content-addressed or version-fixed`,
  );
}

function isImmutableUri(value) {
  if (typeof value !== "string") return false;
  if (/^oci:\/\/[^@]+@sha256:[a-f0-9]{64}$/u.test(value)) return true;
  if (/^https:\/\//u.test(value) && /(?:sha256:[a-f0-9]{64}|[?&](?:versionId|generation|versionid)=[^&]+)/u.test(value)) return true;
  return false;
}

function assertImageDefinition(image) {
  for (const field of ["id", "composeFile", "composeService", "imageEnvironment", "dockerfile", "target"]) {
    assert(typeof image?.[field] === "string" && image[field].length > 0, `candidate image ${field} is required`);
  }
  assert(/^[A-Z][A-Z0-9_]*$/u.test(image.imageEnvironment), `${image.id} imageEnvironment is invalid`);
}

function parseArguments(argv) {
  const result = { recordPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--contract") result.contract = true;
    else if (argument === "--manifest") result.manifestPath = argv[++index];
    else if (argument === "--expected-commit") result.expectedCommit = argv[++index];
    else if (argument === "--env-file") result.envFile = argv[++index];
    else if (argument === "--image") result.onlyImageId = argv[++index];
    else if (argument === "--assemble") result.assembleOutput = argv[++index];
    else if (argument === "--record") result.recordPaths.push(argv[++index]);
    else throw new Error(`unsupported argument: ${argument}`);
  }
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.contract || (!args.manifestPath && !args.assembleOutput)) {
    assertProductionImageContract();
    console.log("Production image inventory contract passed.");
    return;
  }
  if (args.assembleOutput) {
    assert(args.expectedCommit, "--expected-commit is required with --assemble");
    assert(args.recordPaths.length > 0, "at least one --record is required with --assemble");
    const records = args.recordPaths.map((path) => JSON.parse(readFileSync(resolve(path), "utf8")));
    const manifest = assembleProductionImageManifest({ records, expectedCommit: args.expectedCommit });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  assert(args.expectedCommit, "--expected-commit is required with --manifest");
  const deploymentEnvironment = args.envFile
    ? readDeploymentEnv(readFileSync(resolve(args.envFile), "utf8"))
    : undefined;
  verifyProductionImageManifest({
    manifest: JSON.parse(readFileSync(resolve(args.manifestPath), "utf8")),
    expectedCommit: args.expectedCommit,
    deploymentEnvironment,
    onlyImageId: args.onlyImageId,
  });
  console.log("Production image evidence manifest passed.");
}

function readYaml(relativePath) {
  const document = YAML.parseDocument(readText(relativePath), { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  return document.toJS({ maxAliasCount: 100 });
}

function readText(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`production image inventory: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
