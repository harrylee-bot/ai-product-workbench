#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { canonicalJson } from "./evidence-ledger.mjs";
import { productionImageDigestBinding } from "./production-image-inventory.mjs";

export const PRODUCTION_DEPLOYMENT_CONFIG_SCHEMA_VERSION = "workbench.production-deployment-configuration.v1";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(moduleDirectory, "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;

export const PRODUCTION_CONFIG_PATHS = Object.freeze([
  "deploy/caddy-workbench.service.d/override.conf",
  "deploy/deerflow-extensions.production.json",
  "deploy/deerflow-production-preflight.sh",
  "deploy/deerflow-runtime-compose.yml",
  "deploy/edge/workbench-edge-preflight.sh",
  "deploy/edge/workbench-edge.Caddyfile",
  "deploy/edge/workbench-origin-wireguard-preflight.sh",
  "deploy/production-image-inventory.json",
  "deploy/server-deploy.sh",
  "deploy/workbench-caddy-reload.sh",
  "deploy/workbench-compose.yml",
  "deploy/workbench-migrate.sh",
  "deploy/workbench-nginx.conf",
  "deploy/workbench-oss-egress-nginx.conf.template",
  "deploy/workbench-postgres-extensions.sql",
  "deploy/workbench-preview-nginx.conf",
  "deploy/workbench-production-preflight.sh",
  "deploy/workbench-production.Caddyfile",
]);

export const INFRASTRUCTURE_IMAGE_DEFINITIONS = Object.freeze([
  {
    name: "gateway",
    environment: "WORKBENCH_NGINX_IMAGE",
    composeBindings: [
      "deploy/workbench-compose.yml#gateway",
      "deploy/workbench-compose.yml#object-storage-egress",
      "deploy/workbench-compose.yml#preview-gateway",
    ],
  },
  {
    name: "postgres",
    environment: "WORKBENCH_POSTGRES_IMAGE",
    composeBindings: ["deploy/workbench-compose.yml#postgres"],
  },
]);

export const EFFECTIVE_CONFIG_FIELDS = Object.freeze([
  ["WORKBENCH_WEB_ORIGIN", "https-url"],
  ["WORKBENCH_PREVIEW_ORIGIN", "https-url"],
  ["WORKBENCH_ENTERPRISE_SSO_ENABLED", "boolean"],
  ["WORKBENCH_S3_INTERNAL_ENDPOINT", "url"],
  ["WORKBENCH_S3_EGRESS_UPSTREAM_HOST", "hostname"],
  ["WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL", "https-url"],
  ["WORKBENCH_S3_BUCKET", "string"],
  ["WORKBENCH_S3_REGION", "string"],
  ["WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE", "boolean"],
  ["WORKBENCH_S3_CONDITIONAL_CREATE_MODE", "conditional-create-mode"],
  ["WORKBENCH_RUNTIME_WORKER_REPLICAS", "positive-integer"],
  ["WORKBENCH_RUNTIME_CONCURRENCY", "positive-integer"],
  ["WORKBENCH_RUNTIME_CANCELLATION_POLL_INTERVAL_MS", "positive-integer"],
  ["WORKBENCH_RUNTIME_CANCELLATION_QUERY_BATCH_SIZE", "positive-integer"],
  ["WORKBENCH_RUNTIME_EXECUTION_LEASE_MS", "positive-integer"],
  ["WORKBENCH_RUNTIME_EXECUTION_HEARTBEAT_MS", "positive-integer"],
  ["WORKBENCH_RUNTIME_EXECUTION_RECONCILE_BATCH_SIZE", "positive-integer"],
  ["WORKBENCH_CLAMAV_HOST", "hostname"],
  ["WORKBENCH_CLAMAV_PORT", "port"],
  ["WORKBENCH_CLAMAV_SIGNATURE_MAX_AGE_MS", "positive-integer"],
  ["WORKBENCH_CLAMAV_STREAM_MAX_BYTES", "positive-integer"],
  ["WORKBENCH_DOCLING_URL", "url"],
  ["WORKBENCH_FILE_PARSER_VERSION", "string"],
  ["WORKBENCH_DOCLING_RESULT_RETENTION_SECONDS", "positive-integer"],
  ["WORKBENCH_TEI_URL", "https-url"],
  ["WORKBENCH_TEI_IMAGE_DIGEST", "digest"],
  ["WORKBENCH_KNOWLEDGE_RERANKER_URL", "https-url"],
  ["WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST", "digest"],
  ["WORKBENCH_KNOWLEDGE_RERANKER_MODEL_ID", "string"],
  ["WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION", "string"],
  ["WORKBENCH_KNOWLEDGE_RERANKER_TEI_VERSION", "string"],
]);

const BASE_DEPENDENCY_NAMES = Object.freeze([
  "clamav",
  "docling",
  "edge-gateway",
  "gateway",
  "object-storage",
  "postgres",
  "reranker",
  "tei",
]);
const LOCAL_VALIDATION_IMAGE_KEYS = Object.freeze([
  "WORKBENCH_DEX_IMAGE",
  "WORKBENCH_MINIO_IMAGE",
  "WORKBENCH_MINIO_MC_IMAGE",
]);

export function createProductionDeploymentConfig({
  candidateId,
  sourceCommit,
  signedTag,
  releaseChainId,
  imageManifest,
  imageManifestSha256,
  githubRunId,
  githubRunAttempt,
  infrastructureEnvironment = process.env,
  repoRoot = defaultRepoRoot,
  configPaths = PRODUCTION_CONFIG_PATHS,
  migrationRoot = "packages/workbench-db/prisma/migrations",
} = {}) {
  const productionImages = productionImageDigestBinding({
    manifest: imageManifest,
    expectedCommit: sourceCommit,
    expectedReleaseChainId: releaseChainId,
  });
  assert(PREFIXED_SHA256_PATTERN.test(candidateId ?? ""), "candidateId must be a prefixed SHA-256");
  assert(COMMIT_PATTERN.test(sourceCommit ?? ""), "sourceCommit must be a lowercase 40-character Git SHA");
  assert(IDENTIFIER_PATTERN.test(signedTag ?? ""), "signedTag is invalid");
  assert(PREFIXED_SHA256_PATTERN.test(releaseChainId ?? ""), "releaseChainId must be a prefixed SHA-256");
  assert(SHA256_PATTERN.test(imageManifestSha256 ?? ""), "imageManifestSha256 is invalid");
  assert(RUN_ID_PATTERN.test(String(githubRunId ?? "")), "githubRunId must be a positive integer string");
  const runAttempt = normalizeRunAttempt(githubRunAttempt);

  const sourceConfiguration = createFileTreeDescriptor({ repoRoot, relativePaths: configPaths });
  const migrations = createMigrationTreeDescriptor({ repoRoot, migrationRoot });
  const deployedImages = INFRASTRUCTURE_IMAGE_DEFINITIONS.map((definition) => {
    assertComposeBindings({ definition, repoRoot });
    const imageRef = readEnvironmentValue(infrastructureEnvironment, definition.environment);
    assert(IMAGE_REFERENCE_PATTERN.test(imageRef), `${definition.environment} must be a complete immutable OCI image reference`);
    const digest = imageRef.slice(imageRef.lastIndexOf("@") + 1);
    assert(PREFIXED_SHA256_PATTERN.test(digest), `${definition.environment} digest is invalid`);
    return {
      name: definition.name,
      environment: definition.environment,
      imageRef,
      digest,
      composeBindings: [...definition.composeBindings],
    };
  });
  for (const name of LOCAL_VALIDATION_IMAGE_KEYS) {
    assert(!readOptionalEnvironmentValue(infrastructureEnvironment, name), `${name} must be empty for the production topology`);
  }
  const identity = createIdentityBinding(infrastructureEnvironment);
  const effectiveConfig = createEffectiveConfig(infrastructureEnvironment);
  const dependencies = createDependencyBindings({
    source: readJsonEnvironment(infrastructureEnvironment, "WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON"),
    deployedImages,
    effectiveConfig: effectiveConfig.values,
    identity,
  });
  const secretVersions = createSecretVersionBindings(
    readJsonEnvironment(infrastructureEnvironment, "WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON"),
  );
  const configurationSha256 = sha256(canonicalJson({
    sourceConfigurationSha256: sourceConfiguration.sha256,
    effectiveConfigSha256: effectiveConfig.sha256,
    dependencyAttestationsSha256: sha256(canonicalJson(dependencies)),
    secretVersionsSha256: secretVersions.sha256,
    identity,
  }));
  const payload = {
    schemaVersion: PRODUCTION_DEPLOYMENT_CONFIG_SCHEMA_VERSION,
    candidate: { candidateId, sourceCommit, signedTag, releaseChainId },
    workflowRun: { id: String(githubRunId), attempt: runAttempt },
    productionImages: { manifestSha256: imageManifestSha256, images: productionImages },
    configurationSha256,
    sourceConfiguration,
    effectiveConfig,
    secretVersions,
    identity,
    dependencies,
    migrations,
  };
  return { ...payload, payloadSha256: sha256(canonicalJson(payload)) };
}

export function verifyProductionDeploymentConfig(document, expected = {}, {
  repoRoot,
  verifySourceFiles = false,
} = {}) {
  assertObject(document, "deployment configuration manifest");
  assertExactKeys(document, [
    "candidate",
    "configurationSha256",
    "dependencies",
    "effectiveConfig",
    "identity",
    "migrations",
    "payloadSha256",
    "productionImages",
    "schemaVersion",
    "secretVersions",
    "sourceConfiguration",
    "workflowRun",
  ], "deployment configuration manifest");
  assert(document.schemaVersion === PRODUCTION_DEPLOYMENT_CONFIG_SCHEMA_VERSION, "deployment configuration schemaVersion is invalid");
  assertObject(document.candidate, "deployment configuration candidate");
  assertExactKeys(document.candidate, ["candidateId", "releaseChainId", "signedTag", "sourceCommit"], "deployment configuration candidate");
  assert(PREFIXED_SHA256_PATTERN.test(document.candidate.candidateId ?? ""), "deployment configuration candidateId is invalid");
  assert(COMMIT_PATTERN.test(document.candidate.sourceCommit ?? ""), "deployment configuration sourceCommit is invalid");
  assert(IDENTIFIER_PATTERN.test(document.candidate.signedTag ?? ""), "deployment configuration signedTag is invalid");
  assert(PREFIXED_SHA256_PATTERN.test(document.candidate.releaseChainId ?? ""), "deployment configuration releaseChainId is invalid");

  assertObject(document.workflowRun, "deployment configuration workflowRun");
  assertExactKeys(document.workflowRun, ["attempt", "id"], "deployment configuration workflowRun");
  assert(RUN_ID_PATTERN.test(document.workflowRun.id ?? ""), "deployment configuration workflow run ID is invalid");
  assert(Number.isSafeInteger(document.workflowRun.attempt) && document.workflowRun.attempt > 0, "deployment configuration workflow run attempt is invalid");

  verifyTreeDescriptor(document.sourceConfiguration, "production source configuration files");
  verifyTreeDescriptor(document.migrations, "deployment migration files");
  if (verifySourceFiles) {
    assert(repoRoot, "repoRoot is required when verifying deployment configuration source files");
    verifyTreeFiles(document.sourceConfiguration, repoRoot, "production source configuration files");
    verifyTreeFiles(document.migrations, repoRoot, "deployment migration files");
  }

  verifyIdentityBinding(document.identity);
  verifyEffectiveConfig(document.effectiveConfig);
  verifySecretVersionBindings(document.secretVersions);
  verifyDependencyBindings({
    dependencies: document.dependencies,
    effectiveConfig: document.effectiveConfig.values,
    identity: document.identity,
  });
  assert(SHA256_PATTERN.test(document.configurationSha256 ?? ""), "deployment configuration SHA-256 is invalid");
  assert(document.configurationSha256 === sha256(canonicalJson({
    sourceConfigurationSha256: document.sourceConfiguration.sha256,
    effectiveConfigSha256: document.effectiveConfig.sha256,
    dependencyAttestationsSha256: sha256(canonicalJson(document.dependencies)),
    secretVersionsSha256: document.secretVersions.sha256,
    identity: document.identity,
  })), "deployment configuration SHA-256 does not match the effective production topology");

  assertObject(document.productionImages, "deployment configuration productionImages");
  assertExactKeys(document.productionImages, ["images", "manifestSha256"], "deployment configuration productionImages");
  assert(SHA256_PATTERN.test(document.productionImages.manifestSha256 ?? ""), "deployment configuration image manifest SHA-256 is invalid");
  verifyImageDigestList(document.productionImages.images, "deployment configuration production images", 10);

  const payload = Object.fromEntries(Object.entries(document).filter(([key]) => key !== "payloadSha256"));
  assert(SHA256_PATTERN.test(document.payloadSha256 ?? ""), "deployment configuration payload SHA-256 is invalid");
  assert(document.payloadSha256 === sha256(canonicalJson(payload)), "deployment configuration payload SHA-256 mismatch");

  for (const [field, value] of [
    ["candidateId", expected.candidateId],
    ["sourceCommit", expected.sourceCommit],
    ["signedTag", expected.signedTag],
    ["releaseChainId", expected.releaseChainId],
  ]) {
    if (value !== undefined) assert(document.candidate[field] === value, `deployment configuration ${field} mismatch`);
  }
  if (expected.githubRunId !== undefined) {
    assert(document.workflowRun.id === String(expected.githubRunId), "deployment configuration GitHub run ID mismatch");
  }
  if (expected.githubRunAttempt !== undefined) {
    assert(document.workflowRun.attempt === normalizeRunAttempt(expected.githubRunAttempt), "deployment configuration GitHub run attempt mismatch");
  }
  if (expected.imageManifestSha256 !== undefined) {
    assert(document.productionImages.manifestSha256 === expected.imageManifestSha256, "deployment configuration G4 manifest SHA-256 mismatch");
  }
  if (expected.images !== undefined) {
    assertDeepEqual(document.productionImages.images, expected.images, "deployment configuration G4 image inventory mismatch");
  }
  if (expected.configSha256 !== undefined) {
    assert(document.configurationSha256 === expected.configSha256, "deployment configuration config SHA-256 mismatch");
  }
  if (expected.migrationSha256 !== undefined) {
    assert(document.migrations.sha256 === expected.migrationSha256, "deployment configuration migration SHA-256 mismatch");
  }
  return true;
}

export function loadVerifiedProductionDeploymentConfig({
  manifestPath,
  bundlePath,
  certificateIdentity,
  certificateOidcIssuer,
  expected = {},
  verifyBlob = verifyCosignDeploymentConfigBlob,
  readManifest = (filePath) => readFileSync(filePath),
} = {}) {
  const resolvedManifestPath = requiredRegularFile(manifestPath, "deployment configuration manifest");
  const resolvedBundlePath = requiredRegularFile(bundlePath, "deployment configuration signature bundle");
  assertHttps(certificateIdentity, "deployment configuration certificate identity");
  assertHttps(certificateOidcIssuer, "deployment configuration certificate OIDC issuer");
  const verified = verifyBlob({
    manifestPath: resolvedManifestPath,
    bundlePath: resolvedBundlePath,
    certificateIdentity,
    certificateOidcIssuer,
  });
  assert(verified === true, "deployment configuration signature verification failed");
  const bytes = Buffer.from(readManifest(resolvedManifestPath));
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("deployment configuration manifest JSON is invalid");
  }
  verifyProductionDeploymentConfig(document, expected);
  const manifestSha256 = sha256(bytes);
  return {
    document,
    manifestSha256,
    binding: deploymentConfigBinding(document, manifestSha256),
  };
}

export function loadProductionDeploymentConfigBinding({
  manifestPath,
  expectedManifestSha256,
  expected = {},
} = {}) {
  const resolvedManifestPath = requiredRegularFile(manifestPath, "deployment configuration manifest");
  assert(SHA256_PATTERN.test(expectedManifestSha256 ?? ""), "expected deployment configuration manifest SHA-256 is invalid");
  const bytes = readFileSync(resolvedManifestPath);
  const manifestSha256 = sha256(bytes);
  assert(manifestSha256 === expectedManifestSha256, "deployment configuration manifest SHA-256 mismatch");
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("deployment configuration manifest JSON is invalid");
  }
  verifyProductionDeploymentConfig(document, expected);
  return { document, manifestSha256, binding: deploymentConfigBinding(document, manifestSha256) };
}

export function deploymentConfigBinding(document, manifestSha256) {
  assert(SHA256_PATTERN.test(manifestSha256 ?? ""), "deployment configuration manifest SHA-256 is invalid");
  return {
    schemaVersion: document.schemaVersion,
    manifestSha256,
    configSha256: document.configurationSha256,
    migrationSha256: document.migrations.sha256,
    effectiveConfigSha256: document.effectiveConfig.sha256,
    secretVersionsSha256: document.secretVersions.sha256,
    identity: document.identity,
    dependencies: document.dependencies,
  };
}

export function verifyCosignDeploymentConfigBlob({
  manifestPath,
  bundlePath,
  certificateIdentity,
  certificateOidcIssuer,
  execute = execFileSync,
}) {
  try {
    execute("cosign", [
      "verify-blob",
      "--bundle", bundlePath,
      "--certificate-identity", certificateIdentity,
      "--certificate-oidc-issuer", certificateOidcIssuer,
      manifestPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    throw new Error("deployment configuration signature verification failed");
  }
  return true;
}

function createFileTreeDescriptor({ repoRoot, relativePaths }) {
  const files = [...relativePaths].sort((left, right) => left.localeCompare(right, "en")).map((relativePath) => {
    assertSafeRelativePath(relativePath, "deployment configuration path");
    const filePath = path.resolve(repoRoot, relativePath);
    assertWithinRoot(repoRoot, filePath, "deployment configuration path");
    const stat = lstatSync(filePath);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${relativePath} must be a regular file`);
    return { path: relativePath, sha256: sha256(readFileSync(filePath)) };
  });
  assert(files.length > 0, "deployment configuration file inventory must not be empty");
  return { sha256: sha256(canonicalJson(files)), files };
}

function createMigrationTreeDescriptor({ repoRoot, migrationRoot }) {
  const rootPath = path.resolve(repoRoot, migrationRoot);
  assertWithinRoot(repoRoot, rootPath, "migration root");
  const directory = lstatSync(rootPath);
  assert(directory.isDirectory() && !directory.isSymbolicLink(), "migration root must be a regular directory");
  const relativePaths = [];
  for (const entry of readDirectoryEntries(rootPath)) {
    if (entry.endsWith("/migration.sql")) relativePaths.push(path.posix.join(migrationRoot, entry));
  }
  assert(relativePaths.length > 0, "migration inventory must contain migration.sql files");
  return createFileTreeDescriptor({ repoRoot, relativePaths });
}

function readDirectoryEntries(rootPath, relative = "") {
  const directoryPath = path.join(rootPath, relative);
  const entries = [];
  for (const name of readdirSync(directoryPath).sort((left, right) => left.localeCompare(right, "en"))) {
    const childRelative = relative ? path.posix.join(relative, name) : name;
    const childPath = path.join(rootPath, childRelative);
    const stat = lstatSync(childPath);
    assert(!stat.isSymbolicLink(), `migration path must not be a symbolic link: ${childRelative}`);
    if (stat.isDirectory()) entries.push(...readDirectoryEntries(rootPath, childRelative));
    else if (stat.isFile()) entries.push(childRelative);
  }
  return entries.sort((left, right) => left.localeCompare(right, "en"));
}

function verifyTreeDescriptor(tree, label) {
  assertObject(tree, label);
  assertExactKeys(tree, ["files", "sha256"], label);
  assert(Array.isArray(tree.files) && tree.files.length > 0, `${label}.files must be a non-empty array`);
  let previous = "";
  for (const [index, file] of tree.files.entries()) {
    assertObject(file, `${label}.files[${index}]`);
    assertExactKeys(file, ["path", "sha256"], `${label}.files[${index}]`);
    assertSafeRelativePath(file.path, `${label}.files[${index}].path`);
    assert(SHA256_PATTERN.test(file.sha256 ?? ""), `${label}.files[${index}].sha256 is invalid`);
    assert(!previous || previous.localeCompare(file.path, "en") < 0, `${label}.files must be sorted and unique`);
    previous = file.path;
  }
  assert(SHA256_PATTERN.test(tree.sha256 ?? ""), `${label}.sha256 is invalid`);
  assert(tree.sha256 === sha256(canonicalJson(tree.files)), `${label}.sha256 does not match its file inventory`);
}

function verifyTreeFiles(tree, repoRoot, label) {
  for (const file of tree.files) {
    const filePath = path.resolve(repoRoot, file.path);
    assertWithinRoot(repoRoot, filePath, `${label} path`);
    const stat = lstatSync(filePath);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} source ${file.path} must be a regular file`);
    assert(sha256(readFileSync(filePath)) === file.sha256, `${label} source ${file.path} SHA-256 mismatch`);
  }
}

function createIdentityBinding(environment) {
  const enabledValue = readEnvironmentValue(environment, "WORKBENCH_ENTERPRISE_SSO_ENABLED").toLowerCase();
  assert(enabledValue === "true" || enabledValue === "false", "WORKBENCH_ENTERPRISE_SSO_ENABLED must be true or false");
  const enterpriseSsoEnabled = enabledValue === "true";
  const issuerValue = readOptionalEnvironmentValue(environment, "WORKBENCH_OIDC_PROVIDER_ISSUER");
  const clientId = readOptionalEnvironmentValue(environment, "WORKBENCH_OIDC_CLIENT_ID");
  const configuredHostname = readOptionalEnvironmentValue(environment, "WORKBENCH_IDENTITY_HOSTNAME");
  if (!enterpriseSsoEnabled) {
    for (const [name, value] of [
      ["WORKBENCH_OIDC_PROVIDER_ISSUER", issuerValue],
      ["WORKBENCH_OIDC_CLIENT_ID", clientId],
      ["WORKBENCH_IDENTITY_HOSTNAME", configuredHostname],
    ]) {
      assert(!value, `${name} must be empty when enterprise SSO is disabled`);
    }
    return { enterpriseSsoEnabled: false, provider: null };
  }
  const issuer = normalizeUrl(issuerValue, "WORKBENCH_OIDC_PROVIDER_ISSUER", { httpsOnly: true });
  assert(clientId, "WORKBENCH_OIDC_CLIENT_ID is required when enterprise SSO is enabled");
  const hostname = new URL(issuer).hostname;
  if (configuredHostname) assert(configuredHostname === hostname, "WORKBENCH_IDENTITY_HOSTNAME must match the OIDC issuer hostname");
  return {
    enterpriseSsoEnabled: true,
    provider: {
      issuer,
      identityHostname: hostname,
      clientIdSha256: sha256(clientId),
    },
  };
}

function verifyIdentityBinding(identity) {
  assertObject(identity, "deployment identity policy");
  assertExactKeys(identity, ["enterpriseSsoEnabled", "provider"], "deployment identity policy");
  assert(typeof identity.enterpriseSsoEnabled === "boolean", "deployment identity enterpriseSsoEnabled is invalid");
  if (!identity.enterpriseSsoEnabled) {
    assert(identity.provider === null, "disabled enterprise SSO must not retain a dormant provider");
    return;
  }
  assertObject(identity.provider, "deployment identity provider");
  assertExactKeys(identity.provider, ["clientIdSha256", "identityHostname", "issuer"], "deployment identity provider");
  const issuer = normalizeUrl(identity.provider.issuer, "deployment identity issuer", { httpsOnly: true });
  assert(issuer === identity.provider.issuer, "deployment identity issuer must be normalized");
  assert(new URL(issuer).hostname === identity.provider.identityHostname, "deployment identity hostname mismatch");
  assert(SHA256_PATTERN.test(identity.provider.clientIdSha256 ?? ""), "deployment identity clientIdSha256 is invalid");
}

function createEffectiveConfig(environment) {
  const values = {};
  for (const [name, type] of EFFECTIVE_CONFIG_FIELDS) {
    values[name] = normalizeEffectiveValue(readEnvironmentValue(environment, name), name, type);
  }
  return { sha256: sha256(canonicalJson(values)), values };
}

function verifyEffectiveConfig(effectiveConfig) {
  assertObject(effectiveConfig, "deployment effectiveConfig");
  assertExactKeys(effectiveConfig, ["sha256", "values"], "deployment effectiveConfig");
  assertObject(effectiveConfig.values, "deployment effectiveConfig.values");
  assertDeepEqual(
    Object.keys(effectiveConfig.values).sort(),
    EFFECTIVE_CONFIG_FIELDS.map(([name]) => name).sort(),
    "deployment effectiveConfig fields are incomplete or untracked",
  );
  for (const [name, type] of EFFECTIVE_CONFIG_FIELDS) {
    assert(
      normalizeEffectiveValue(String(effectiveConfig.values[name] ?? ""), name, type) === effectiveConfig.values[name],
      `deployment effectiveConfig ${name} is not normalized`,
    );
  }
  assert(SHA256_PATTERN.test(effectiveConfig.sha256 ?? ""), "deployment effectiveConfig SHA-256 is invalid");
  assert(effectiveConfig.sha256 === sha256(canonicalJson(effectiveConfig.values)), "deployment effectiveConfig SHA-256 mismatch");
}

function normalizeEffectiveValue(value, name, type) {
  const trimmed = value.trim();
  assert(trimmed.length > 0, `${name} is required for the effective production configuration`);
  if (type === "https-url") return normalizeUrl(trimmed, name, { httpsOnly: true });
  if (type === "url") return normalizeUrl(trimmed, name);
  if (type === "boolean") {
    const normalized = trimmed.toLowerCase();
    assert(normalized === "true" || normalized === "false", `${name} must be true or false`);
    return normalized;
  }
  if (type === "conditional-create-mode") {
    assert(
      trimmed === "s3-if-none-match" || trimmed === "oss-forbid-overwrite",
      `${name} must be s3-if-none-match or oss-forbid-overwrite`,
    );
    return trimmed;
  }
  if (type === "positive-integer") {
    assert(/^[1-9][0-9]*$/u.test(trimmed) && Number.isSafeInteger(Number(trimmed)), `${name} must be a positive integer`);
    return String(Number(trimmed));
  }
  if (type === "port") {
    assert(/^[1-9][0-9]*$/u.test(trimmed) && Number(trimmed) <= 65535, `${name} must be a valid port`);
    return String(Number(trimmed));
  }
  if (type === "digest") {
    assert(PREFIXED_SHA256_PATTERN.test(trimmed), `${name} must be an immutable SHA-256 digest`);
    return trimmed;
  }
  if (type === "hostname") {
    assert(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(trimmed), `${name} must be a hostname`);
    return trimmed;
  }
  assert(!/[\0\r\n]/u.test(trimmed), `${name} is invalid`);
  return trimmed;
}

function createDependencyBindings({ source, deployedImages, effectiveConfig, identity }) {
  assert(Array.isArray(source), "WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON must be a JSON array");
  const dependencies = structuredClone(source).sort((left, right) => String(left?.name).localeCompare(String(right?.name), "en"));
  verifyDependencyBindings({ dependencies, effectiveConfig, identity, deployedImages });
  return dependencies;
}

function verifyDependencyBindings({ dependencies, effectiveConfig, identity, deployedImages }) {
  assert(Array.isArray(dependencies), "deployment dependencies must be an array");
  const expectedNames = [...BASE_DEPENDENCY_NAMES, ...(identity.enterpriseSsoEnabled ? ["enterprise-identity"] : [])].sort();
  assertDeepEqual(dependencies.map((entry) => entry?.name), expectedNames, "deployment dependencies must exactly match the active production topology");
  const deployedByName = new Map((deployedImages ?? dependencies.filter((entry) => ["gateway", "postgres"].includes(entry?.name)))
    .map((entry) => [entry.name, entry]));
  let previous = "";
  for (const [index, dependency] of dependencies.entries()) {
    const label = `deployment dependencies[${index}]`;
    assertObject(dependency, label);
    assertExactKeys(dependency, ["configAttestationSha256", "digest", "endpoint", "imageRef", "kind", "name", "version"], label);
    assert(IDENTIFIER_PATTERN.test(dependency.name ?? ""), `${label}.name is invalid`);
    assert(!previous || previous.localeCompare(dependency.name, "en") < 0, "deployment dependencies must be sorted and unique");
    previous = dependency.name;
    assert(SHA256_PATTERN.test(dependency.configAttestationSha256 ?? ""), `${label}.configAttestationSha256 is invalid`);
    if (dependency.kind === "deployed-image") {
      assert(IMAGE_REFERENCE_PATTERN.test(dependency.imageRef ?? ""), `${label}.imageRef must be immutable`);
      assert(PREFIXED_SHA256_PATTERN.test(dependency.digest ?? ""), `${label}.digest is invalid`);
      assert(dependency.imageRef.endsWith(`@${dependency.digest}`), `${label}.imageRef digest mismatch`);
      assert(dependency.version === dependency.digest, `${label}.version must equal the deployed image digest`);
    } else {
      assert(dependency.kind === "external-service", `${label}.kind is invalid`);
      assert(dependency.imageRef === null && dependency.digest === null, `${label} external service must not claim a deployed image`);
      assert(typeof dependency.version === "string" && VERSION_PATTERN.test(dependency.version), `${label}.version is not immutable`);
    }
    validateDependencyTarget(dependency, { effectiveConfig, identity, deployedByName, label });
  }
}

function validateDependencyTarget(dependency, { effectiveConfig, identity, deployedByName, label }) {
  if (["gateway", "postgres"].includes(dependency.name)) {
    const deployed = deployedByName.get(dependency.name);
    assert(dependency.kind === "deployed-image", `${label} must be a deployed-image dependency`);
    if (deployed?.imageRef) assert(dependency.imageRef === deployed.imageRef, `${label}.imageRef differs from the effective deployment`);
    assert(dependency.endpoint === null, `${label}.endpoint must be null`);
    return;
  }
  const endpoints = {
    clamav: `tcp://${effectiveConfig.WORKBENCH_CLAMAV_HOST}:${effectiveConfig.WORKBENCH_CLAMAV_PORT}`,
    docling: effectiveConfig.WORKBENCH_DOCLING_URL,
    "edge-gateway": effectiveConfig.WORKBENCH_WEB_ORIGIN,
    "object-storage": effectiveConfig.WORKBENCH_S3_INTERNAL_ENDPOINT,
    tei: effectiveConfig.WORKBENCH_TEI_URL,
    reranker: effectiveConfig.WORKBENCH_KNOWLEDGE_RERANKER_URL,
    "enterprise-identity": identity.provider?.issuer,
  };
  assert(dependency.endpoint === endpoints[dependency.name], `${label}.endpoint differs from the effective deployment`);
  if (["edge-gateway", "object-storage", "enterprise-identity"].includes(dependency.name)) {
    assert(dependency.kind === "external-service", `${label} must be an external-service dependency`);
  }
  if (dependency.name === "docling" && dependency.kind === "external-service") {
    assert(dependency.version === effectiveConfig.WORKBENCH_FILE_PARSER_VERSION, `${label}.version differs from WORKBENCH_FILE_PARSER_VERSION`);
  }
  if (dependency.name === "tei" && dependency.kind === "external-service") {
    assert(dependency.version === effectiveConfig.WORKBENCH_TEI_IMAGE_DIGEST, `${label}.version differs from WORKBENCH_TEI_IMAGE_DIGEST`);
  }
  if (dependency.name === "reranker" && dependency.kind === "external-service") {
    const expected = `${effectiveConfig.WORKBENCH_KNOWLEDGE_RERANKER_IMAGE_DIGEST}/${effectiveConfig.WORKBENCH_KNOWLEDGE_RERANKER_MODEL_REVISION}`;
    assert(dependency.version === expected, `${label}.version differs from the reranker image/model revision`);
  }
}

function createSecretVersionBindings(source) {
  assert(Array.isArray(source) && source.length > 0, "WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON must be a non-empty JSON array");
  const entries = structuredClone(source).sort((left, right) => String(left?.name).localeCompare(String(right?.name), "en"));
  const result = { sha256: sha256(canonicalJson(entries)), entries };
  verifySecretVersionBindings(result);
  return result;
}

function verifySecretVersionBindings(value) {
  assertObject(value, "deployment secretVersions");
  assertExactKeys(value, ["entries", "sha256"], "deployment secretVersions");
  assert(Array.isArray(value.entries) && value.entries.length > 0, "deployment secretVersions.entries must be non-empty");
  let previous = "";
  for (const [index, entry] of value.entries.entries()) {
    const label = `deployment secretVersions.entries[${index}]`;
    assertObject(entry, label);
    assertExactKeys(entry, ["attestationSha256", "name", "version"], label);
    assert(IDENTIFIER_PATTERN.test(entry.name ?? ""), `${label}.name is invalid`);
    assert(IDENTIFIER_PATTERN.test(entry.version ?? ""), `${label}.version is invalid`);
    assert(SHA256_PATTERN.test(entry.attestationSha256 ?? ""), `${label}.attestationSha256 is invalid`);
    assert(!previous || previous.localeCompare(entry.name, "en") < 0, "deployment secretVersions.entries must be sorted and unique");
    previous = entry.name;
  }
  assert(value.sha256 === sha256(canonicalJson(value.entries)), "deployment secretVersions SHA-256 mismatch");
}

function verifyImageDigestList(images, label, expectedCount) {
  assert(Array.isArray(images) && images.length === expectedCount, `${label} must contain exactly ${expectedCount} images`);
  let previous = "";
  for (const [index, image] of images.entries()) {
    assertObject(image, `${label}[${index}]`);
    assertExactKeys(image, ["digest", "name"], `${label}[${index}]`);
    assert(IDENTIFIER_PATTERN.test(image.name ?? ""), `${label}[${index}].name is invalid`);
    assert(PREFIXED_SHA256_PATTERN.test(image.digest ?? ""), `${label}[${index}].digest is invalid`);
    assert(!previous || previous.localeCompare(image.name, "en") < 0, `${label} must be sorted and unique`);
    previous = image.name;
  }
}

function assertComposeBindings({ definition, repoRoot }) {
  for (const binding of definition.composeBindings) {
    const separator = binding.lastIndexOf("#");
    const composePath = binding.slice(0, separator);
    const service = binding.slice(separator + 1);
    const source = readFileSync(path.join(repoRoot, composePath), "utf8");
    const parsed = YAML.parseDocument(source, { strict: true, uniqueKeys: true });
    assert(parsed.errors.length === 0, `${composePath} is not valid YAML`);
    const image = parsed.toJS({ maxAliasCount: 100 })?.services?.[service]?.image;
    assert(typeof image === "string", `${binding} service image is missing`);
    assert(image.includes("${" + definition.environment), `${binding} does not use ${definition.environment}`);
  }
}

function readEnvironmentValue(environment, name) {
  const value = environment instanceof Map ? environment.get(name) : environment?.[name];
  assert(typeof value === "string" && value.trim().length > 0, `${name} is required`);
  return value.trim();
}

function readOptionalEnvironmentValue(environment, name) {
  const value = environment instanceof Map ? environment.get(name) : environment?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function readJsonEnvironment(environment, name) {
  const source = readEnvironmentValue(environment, name);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function normalizeUrl(value, label, { httpsOnly = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  assert(["http:", "https:"].includes(parsed.protocol), `${label} must use HTTP or HTTPS`);
  if (httpsOnly) assert(parsed.protocol === "https:", `${label} must use HTTPS`);
  assert(!parsed.username && !parsed.password && !parsed.hash, `${label} must not contain credentials or a fragment`);
  assert(!parsed.port, `${label} must not use a non-standard port`);
  return parsed.href.replace(/\/$/u, "");
}

function requiredRegularFile(filePath, label) {
  assert(typeof filePath === "string" && filePath.length > 0, `${label} path is required`);
  const resolved = path.resolve(filePath);
  const stat = lstatSync(resolved);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
  return resolved;
}

function assertHttps(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  assert(parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash, `${label} must be an HTTPS URL`);
}

function normalizeRunAttempt(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, "githubRunAttempt must be a positive integer");
  return parsed;
}

function assertSafeRelativePath(value, label) {
  assert(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value), `${label} is invalid`);
  assert(!path.isAbsolute(value) && !value.split("/").includes("..") && !value.includes("//"), `${label} is unsafe`);
}

function assertWithinRoot(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `${label} escapes the repository root`);
}

function assertObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertExactKeys(value, expected, label) {
  assertDeepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields are invalid`);
}

function assertDeepEqual(actual, expected, message) {
  assert(canonicalJson(actual) === canonicalJson(expected), message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
