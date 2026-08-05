import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv2020 from "@redocly/ajv/dist/2020.js";

import { assertProductionDeploymentConfig } from "./assert-production-deployment-config.mjs";
import {
  DEERFLOW_PRODUCTION_HOST_READ_PATHS,
  EFFECTIVE_CONFIG_FIELDS,
  INFRASTRUCTURE_IMAGE_DEFINITIONS,
  PRODUCTION_CONFIG_PATHS,
  PRODUCTION_SECRET_DEFINITIONS,
  createProductionDeploymentConfig,
  deploymentConfigBinding,
  loadVerifiedProductionDeploymentConfig,
  verifyCosignDeploymentConfigBlob,
  verifyProductionDeploymentConfig,
  verifyProductionDeploymentEnvironment,
  verifyProductionDeploymentRuntimeBinding,
} from "./production-deployment-config.mjs";
import { loadProductionImageInventory } from "./production-image-inventory.mjs";
import { productionDeploymentConfigFixtureEnvironment } from "./fixtures/production-deployment-config-fixture.mjs";
import { createProductionBuildConfiguration } from "./write-production-build-configuration.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCommit = "a".repeat(40);
const candidateId = `sha256:${"b".repeat(64)}`;
const releaseChainId = `sha256:${"c".repeat(64)}`;
const signedTag = "workbench-v1.0.0";
const imageManifestSha256 = "d".repeat(64);
const certificateIdentity = "https://github.com/example/workbench/.github/workflows/workbench-ci.yml@refs/heads/production";
const certificateOidcIssuer = "https://token.actions.githubusercontent.com";

test("every production Compose input is signed or belongs to an explicit non-runtime channel", () => {
  const composeSource = [
    "deploy/workbench-compose.yml",
    "deploy/deerflow-runtime-compose.yml",
  ].map((relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8")).join("\n");
  const interpolatedNames = [...new Set(
    [...composeSource.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1]),
  )];
  const signedNames = new Set([
    ...EFFECTIVE_CONFIG_FIELDS.map(([name]) => name),
    ...PRODUCTION_SECRET_DEFINITIONS.map(([name]) => name),
    ...INFRASTRUCTURE_IMAGE_DEFINITIONS.map(({ environment }) => environment),
    ...loadProductionImageInventory().candidateImages.map(({ imageEnvironment }) => imageEnvironment),
    "WORKBENCH_OIDC_PROVIDER_ISSUER",
    "WORKBENCH_OIDC_CLIENT_ID",
    "WORKBENCH_SOURCE_COMMIT",
  ]);

  assert.deepEqual(interpolatedNames.filter((name) => !signedNames.has(name)).sort(), [
    // These values affect only image builds. Pinned deployment uses signed image digests and --no-build.
    "NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL",
    "NEXT_PUBLIC_WORKBENCH_FORUM_URL",
    "NEXT_PUBLIC_WORKBENCH_PRIVACY_URL",
    // This authorization exists only in the sanitized per-invocation process environment.
    "WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE",
    // These values belong only to explicitly disabled local validation profiles.
    "WORKBENCH_DOCLING_IMAGE",
    "WORKBENCH_LOCAL_S3_BIND_ADDRESS",
    "WORKBENCH_LOCAL_S3_PORT",
    "WORKBENCH_MINIO_IMAGE",
    "WORKBENCH_MINIO_MC_IMAGE",
    "WORKBENCH_MINIO_ROOT_PASSWORD",
    "WORKBENCH_MINIO_ROOT_USER",
    // Remaining build-only inputs are transitively bound by the signed production image manifest.
    "WORKBENCH_NODE_IMAGE",
    "WORKBENCH_QUARTZ_COMMIT",
    "WORKBENCH_QUARTZ_REF",
    // The key bytes are checked against the signed public-key ID before Docker receives this path.
    "WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_HOST_PATH",
  ]);
});

test("production deploy scripts consume only signed values or explicit evidence paths", () => {
  const deploySource = [
    "deploy/workbench-production-preflight.sh",
    "deploy/edge/workbench-edge-preflight.sh",
    "deploy/edge/workbench-origin-wireguard-preflight.sh",
    "deploy/workbench-caddy-reload.sh",
    "deploy/server-deploy.sh",
  ].map((relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8")).join("\n");
  const consumedNames = [...new Set(
    [...deploySource.matchAll(
      /(?:require_env|env_value|rollback_env_value)[ ("]+(WORKBENCH_[A-Z0-9_]+)/gu,
    )].map((match) => match[1]),
  )];
  const signedNames = new Set([
    ...EFFECTIVE_CONFIG_FIELDS.map(([name]) => name),
    ...PRODUCTION_SECRET_DEFINITIONS.map(([name]) => name),
    ...INFRASTRUCTURE_IMAGE_DEFINITIONS.map(({ environment }) => environment),
    ...loadProductionImageInventory().candidateImages.map(({ imageEnvironment }) => imageEnvironment),
    "WORKBENCH_SOURCE_COMMIT",
  ]);

  assert.deepEqual(consumedNames.filter((name) => !signedNames.has(name)).sort(), [
    "WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH",
    "WORKBENCH_IMAGE_INVENTORY_PATH",
    "WORKBENCH_NODE_IMAGE",
    // The origin manifest deterministically derives these from the signed HTTPS origins.
    "WORKBENCH_PREVIEW_HOSTNAME",
    // These paths are locally verified against their signed byte/key identities before use.
    "WORKBENCH_PRODUCTION_TRUST_POLICY_PATH",
    "WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_HOST_PATH",
    "WORKBENCH_WEB_HOSTNAME",
  ]);
});

test("CI injects the complete production deployment environment from trusted variables", () => {
  const workflow = YAML.parse(readFileSync(path.join(repoRoot, ".github/workflows/workbench-ci.yml"), "utf8"));
  const step = workflow.jobs["deployment-config-evidence"].steps.find(
    (candidate) => candidate.name === "Create candidate-bound deployment configuration",
  );
  assert(step, "deployment configuration creation step is missing");

  const effectiveConfigNames = EFFECTIVE_CONFIG_FIELDS.map(([name]) => name);
  const identityAndEvidenceNames = [
    "WORKBENCH_OIDC_PROVIDER_ISSUER",
    "WORKBENCH_OIDC_CLIENT_ID",
    "WORKBENCH_IDENTITY_HOSTNAME",
    "WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON",
    "WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON",
  ];
  const infrastructureNames = INFRASTRUCTURE_IMAGE_DEFINITIONS.map(({ environment }) => environment);
  const productionVariableNames = [
    ...effectiveConfigNames,
    ...identityAndEvidenceNames,
    ...infrastructureNames,
  ];
  const localValidationImageNames = [
    "WORKBENCH_DEX_IMAGE",
    "WORKBENCH_MINIO_IMAGE",
    "WORKBENCH_MINIO_MC_IMAGE",
  ];
  assert.deepEqual(Object.keys(step.env).sort(), [
    "CANDIDATE_ID",
    "RELEASE_CHAIN_ID",
    "SIGNED_TAG",
    ...productionVariableNames,
    ...localValidationImageNames,
  ].sort());
  for (const name of productionVariableNames) {
    assert.equal(step.env[name], `\${{ vars.${name} }}`, `${name} must come from the same-named GitHub variable`);
  }
  for (const name of localValidationImageNames) {
    assert.equal(step.env[name], "", `${name} must remain empty in production configuration evidence`);
  }
});

test("binds G1/G4/run attempt to the effective production topology without validation-only images", () => {
  const document = deploymentDocument();
  const images = imageManifest().images.map(({ id: name, digest }) => ({ name, digest }));
  assert.equal(verifyProductionDeploymentConfig(document, {
    candidateId,
    sourceCommit,
    signedTag,
    releaseChainId,
    imageManifestSha256,
    images,
    githubRunId: "81234",
    githubRunAttempt: 3,
  }, { repoRoot, verifySourceFiles: true }), true);
  assert.deepEqual(document.dependencies.map((dependency) => dependency.name), [
    "clamav", "docling", "edge-gateway", "gateway", "object-storage", "postgres", "reranker", "tei",
  ]);
  assert.equal(document.dependencies.find((dependency) => dependency.name === "docling").kind, "external-service");
  assert.equal(document.dependencies.find((dependency) => dependency.name === "gateway").kind, "deployed-image");
  assert.equal(document.identity.enterpriseSsoEnabled, false);
  assert.equal(document.identity.provider, null);
  assert.equal(document.sourceConfiguration.files.length > 10, true);
  assert.equal(document.migrations.files.length > 10, true);
  assert(PRODUCTION_CONFIG_PATHS.includes("deploy/edge/workbench-edge.Caddyfile"));
  assert(PRODUCTION_CONFIG_PATHS.includes("deploy/edge/workbench-origin-wireguard-preflight.sh"));
  assert(PRODUCTION_CONFIG_PATHS.includes("deploy/workbench-oss-egress-nginx.conf.template"));
  assert(PRODUCTION_CONFIG_PATHS.includes("scripts/assert-production-deployment-config.mjs"));
  for (const hostReadPath of DEERFLOW_PRODUCTION_HOST_READ_PATHS) {
    assert(PRODUCTION_CONFIG_PATHS.includes(hostReadPath), `${hostReadPath} must be signed before host-side verification`);
  }
  assert(PRODUCTION_CONFIG_PATHS.includes("package.json"));
  assert(PRODUCTION_CONFIG_PATHS.includes("package-lock.json"));
  assert.equal(
    INFRASTRUCTURE_IMAGE_DEFINITIONS.find((dependency) => dependency.name === "gateway")
      .composeBindings.includes("deploy/workbench-compose.yml#object-storage-egress"),
    true,
  );
  assert.equal(
    INFRASTRUCTURE_IMAGE_DEFINITIONS.find((dependency) => dependency.name === "gateway")
      .composeBindings.includes("deploy/workbench-compose.yml#netlify-egress"),
    true,
  );
  assert.equal(
    INFRASTRUCTURE_IMAGE_DEFINITIONS.find((dependency) => dependency.name === "gateway")
      .composeBindings.includes("deploy/workbench-compose.yml#netlify-egress-upstream"),
    true,
  );
  assert.equal(
    document.effectiveConfig.values.WORKBENCH_S3_EGRESS_UPSTREAM_HOST,
    "s3.internal.example.test",
  );
  assert.equal(
    document.effectiveConfig.values.WORKBENCH_RUNTIME_PROVIDER_STATE_MODE,
    "projection-required",
  );
  assert.equal(PRODUCTION_CONFIG_PATHS.some((file) => /server-validation|dex|minio/u.test(file)), false);

  const binding = deploymentConfigBinding(document, "f".repeat(64));
  assert.equal(binding.manifestSha256, "f".repeat(64));
  assert.equal(binding.configSha256, document.configurationSha256);
  assert.equal(binding.migrationSha256, document.migrations.sha256);
  assert.equal(binding.effectiveConfigSha256, document.effectiveConfig.sha256);
  assert.equal(binding.secretVersionsSha256, document.secretVersions.sha256);
  assert.deepEqual(binding.runtimeWorkerExecution, {
    scopeId: "production-runtime.worker-execution",
    environmentId: "workbench-production",
    keyId: `sha256:${"c".repeat(64)}`,
    signerId: "runtime-worker-production",
    trustPolicySha256: "d".repeat(64),
    uid: "1000",
    gid: "1000",
  });
  assert.equal(binding.dependencies.length, 8);
  assert.equal("effectiveConfig" in binding, false);
  assert.equal("secretVersions" in binding, false);
});

test("deployment configuration JSON Schema matches the exact current secret contract", () => {
  const schema = JSON.parse(readFileSync(
    path.join(repoRoot, "docs/evidence/governance/production-deployment-config-manifest.schema.json"),
    "utf8",
  ));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const document = deploymentDocument();
  assert.equal(validate(document), true, JSON.stringify(validate.errors));

  const missingValueBinding = structuredClone(document);
  delete missingValueBinding.secretVersions.entries[0].valueSha256;
  assert.equal(validate(missingValueBinding), false);
});

test("rejects plausible 64-hex substitutions unless they match signed structure and source bytes", () => {
  const treeDrift = deploymentDocument();
  treeDrift.sourceConfiguration.files[0].sha256 = "0".repeat(64);
  assert.throws(
    () => verifyProductionDeploymentConfig(treeDrift),
    /does not match its file inventory/u,
  );

  const sourceDrift = deploymentDocument();
  sourceDrift.sourceConfiguration.files[0].sha256 = "1".repeat(64);
  resealDocument(sourceDrift);
  assert.throws(
    () => verifyProductionDeploymentConfig(sourceDrift, {}, { repoRoot, verifySourceFiles: true }),
    /source .* SHA-256 mismatch/u,
  );

  const attemptDrift = deploymentDocument();
  assert.throws(
    () => verifyProductionDeploymentConfig(attemptDrift, { githubRunAttempt: 2 }),
    /run attempt mismatch/u,
  );

  const g4Drift = deploymentDocument();
  assert.throws(
    () => verifyProductionDeploymentConfig(g4Drift, { images: [{ name: "web", digest: `sha256:${"9".repeat(64)}` }] }),
    /G4 image inventory mismatch/u,
  );

  const effectiveDrift = deploymentDocument();
  const expectedConfigSha256 = effectiveDrift.configurationSha256;
  effectiveDrift.effectiveConfig.values.WORKBENCH_RUNTIME_CONCURRENCY = "3";
  resealDocument(effectiveDrift);
  assert.throws(
    () => verifyProductionDeploymentConfig(effectiveDrift, { configSha256: expectedConfigSha256 }),
    /config SHA-256 mismatch/u,
  );
});

test("enforces conditional enterprise identity and rejects dormant Dex or OIDC configuration", () => {
  const enterprise = deploymentDocument({ enterpriseSsoEnabled: true });
  assert.equal(enterprise.identity.enterpriseSsoEnabled, true);
  assert.equal(enterprise.identity.provider.issuer, "https://identity.example.test/realms/workbench");
  assert.equal(enterprise.dependencies.find((dependency) => dependency.name === "enterprise-identity").kind, "external-service");
  assert.equal(enterprise.dependencies.some((dependency) => dependency.name === "dex"), false);

  assert.throws(
    () => deploymentDocument({ overrides: { WORKBENCH_DEX_IMAGE: `ghcr.io/dexidp/dex@sha256:${"d".repeat(64)}` } }),
    /WORKBENCH_DEX_IMAGE must be empty/u,
  );
  assert.throws(
    () => deploymentDocument({ overrides: { WORKBENCH_OIDC_PROVIDER_ISSUER: "https://dormant.example.test" } }),
    /must be empty when enterprise SSO is disabled/u,
  );
  assert.throws(
    () => deploymentDocument({ enterpriseSsoEnabled: true, overrides: { WORKBENCH_OIDC_CLIENT_ID: "" } }),
    /OIDC_CLIENT_ID is required/u,
  );
});

test("binds provider-state mode into the signed configuration and rejects resealed drift", () => {
  const document = deploymentDocument();
  const effectiveConfigSha256 = document.effectiveConfig.sha256;
  const configSha256 = document.configurationSha256;

  document.effectiveConfig.values.WORKBENCH_RUNTIME_PROVIDER_STATE_MODE = "legacy-read";
  resealDocument(document);

  assert.notEqual(document.effectiveConfig.sha256, effectiveConfigSha256);
  assert.notEqual(document.configurationSha256, configSha256);
  assert.throws(
    () => verifyProductionDeploymentConfig(document, { configSha256 }),
    /WORKBENCH_RUNTIME_PROVIDER_STATE_MODE must be projection-required/u,
  );
});

const runtimeWorkerTrustConfigDrifts = [
  ["WORKBENCH_ENVIRONMENT_ID", "workbench-production-secondary"],
  ["WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID", `sha256:${"e".repeat(64)}`],
  ["WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID", "runtime-worker-production-secondary"],
  ["WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256", "f".repeat(64)],
  ["WORKBENCH_RUNTIME_WORKER_UID", "1001"],
  ["WORKBENCH_RUNTIME_WORKER_GID", "1002"],
];

const applicationEffectiveConfigDrifts = [
  ["WORKBENCH_INVITATION_TTL_HOURS", "720"],
  ["WORKBENCH_RELEASE_OWNER_UID", "1001"],
  ["WORKBENCH_EDGE_WIREGUARD_IP", "10.99.0.1"],
  ["WORKBENCH_ORIGIN_WIREGUARD_IP", "10.99.0.2"],
  ["WORKBENCH_EDGE_WIREGUARD_ENDPOINT", "edge-secondary.example.test:51820"],
  ["WORKBENCH_ORIGIN_HTTP_PORT", "9443"],
  ["WORKBENCH_POSTGRES_DB", "workbench_secondary"],
  ["WORKBENCH_POSTGRES_USER", "workbench_admin_secondary"],
  ["WORKBENCH_POSTGRES_MIGRATOR_USER", "workbench_migrator_secondary"],
  ["WORKBENCH_POSTGRES_RUNTIME_USER", "workbench_runtime_secondary"],
  ["WORKBENCH_KNOWLEDGE_VAULT_HOST_DIR", "/srv/workbench/knowledge-vault-secondary"],
  ["WORKBENCH_STORAGE_HOST_DIR", "/srv/workbench/storage-secondary"],
];

for (const [name, value] of applicationEffectiveConfigDrifts) {
  test(`binds ${name} into the signed effective configuration`, () => {
    const baseline = deploymentDocument();
    const drifted = deploymentDocument({ overrides: { [name]: value } });

    assert.equal(drifted.effectiveConfig.values[name], value);
    assert.notEqual(drifted.effectiveConfig.sha256, baseline.effectiveConfig.sha256);
    assert.notEqual(drifted.configurationSha256, baseline.configurationSha256);
  });
}

for (const [name, value] of runtimeWorkerTrustConfigDrifts) {
  test(`binds ${name} into the signed production configuration`, () => {
    const baseline = deploymentDocument();
    const drifted = deploymentDocument({ overrides: { [name]: value } });

    assert.equal(drifted.effectiveConfig.values[name], value);
    assert.notEqual(drifted.effectiveConfig.sha256, baseline.effectiveConfig.sha256);
    assert.notEqual(drifted.configurationSha256, baseline.configurationSha256);
    assert.throws(
      () => verifyProductionDeploymentConfig(drifted, {
        configSha256: baseline.configurationSha256,
      }),
      /config SHA-256 mismatch/u,
    );
  });
}

for (const [name, value] of [
  ["WORKBENCH_ENVIRONMENT_ID", "environment id with spaces"],
  ["WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID", "sha256:not-a-digest"],
  ["WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID", "signer id with spaces"],
  ["WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256", "not-a-digest"],
  ["WORKBENCH_RUNTIME_WORKER_UID", "0"],
  ["WORKBENCH_RUNTIME_WORKER_GID", "group"],
  ["WORKBENCH_EDGE_WIREGUARD_IP", "203.0.113.10"],
  ["WORKBENCH_ORIGIN_WIREGUARD_IP", "10.88.00.2"],
  ["WORKBENCH_EDGE_WIREGUARD_ENDPOINT", "https://edge.example.test:51820"],
  ["WORKBENCH_ORIGIN_HTTP_PORT", "443"],
  ["WORKBENCH_RELEASE_OWNER_UID", "-1"],
  ["WORKBENCH_KNOWLEDGE_VAULT_HOST_DIR", "relative/knowledge-vault"],
  ["WORKBENCH_STORAGE_HOST_DIR", "/srv/workbench/../storage"],
  ["WORKBENCH_DEERFLOW_LANGGRAPH_URL", "http://deerflow:8001/api?token=not-a-config-value"],
]) {
  test(`refuses to sign malformed ${name}`, () => {
    assert.throws(
      () => deploymentDocument({ overrides: { [name]: value } }),
      new RegExp(`${name} must be`, "u"),
    );
  });
}

test("verifies the full signed topology against the deployment environment", () => {
  const environment = productionDeploymentConfigFixtureEnvironment();
  const document = createProductionDeploymentConfig({
    candidateId,
    sourceCommit,
    signedTag,
    releaseChainId,
    imageManifest: imageManifest(),
    imageManifestSha256,
    githubRunId: "81234",
    githubRunAttempt: 3,
    infrastructureEnvironment: environment,
  });
  assert.equal(verifyProductionDeploymentEnvironment(document, environment), true);

  const drifted = new Map(environment);
  drifted.set("WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID", "different-runtime-worker");
  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, drifted),
    /effective configuration differs/u,
  );

  const dependencyDrift = new Map(environment);
  const dependencies = JSON.parse(dependencyDrift.get("WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON"));
  dependencies[0].configAttestationSha256 = "f".repeat(64);
  dependencyDrift.set("WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON", JSON.stringify(dependencies));
  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, dependencyDrift),
    /dependencies differ/u,
  );
});

test("rejects external production dependencies that claim an undeployed image", () => {
  const environment = productionDeploymentConfigFixtureEnvironment();
  const dependencies = JSON.parse(environment.get("WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON"));
  const docling = dependencies.find(({ name }) => name === "docling");
  docling.kind = "deployed-image";
  docling.digest = `sha256:${"f".repeat(64)}`;
  docling.imageRef = `registry.example.test/docling@${docling.digest}`;
  docling.version = docling.digest;
  environment.set("WORKBENCH_PRODUCTION_DEPENDENCY_ATTESTATIONS_JSON", JSON.stringify(dependencies));

  assert.throws(
    () => deploymentDocument({ environment }),
    /docling.*must be an external-service dependency/u,
  );
});

test("requires the exact complete production secret inventory", () => {
  for (const mutation of ["missing", "extra"]) {
    const environment = productionDeploymentConfigFixtureEnvironment();
    const entries = JSON.parse(environment.get("WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON"));
    if (mutation === "missing") {
      entries.pop();
    } else {
      entries.push({
        name: "WORKBENCH_UNTRACKED_SECRET",
        version: "fixture-v1",
        attestationSha256: "8".repeat(64),
        valueSha256: "9".repeat(64),
      });
    }
    environment.set("WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON", JSON.stringify(entries));
    assert.throws(
      () => deploymentDocument({ environment }),
      /exact production secret inventory/u,
    );
  }
});

test("rejects actual environment-secret and metadata hash drift", () => {
  const environment = productionDeploymentConfigFixtureEnvironment({
    overrides: { WORKBENCH_BETTER_AUTH_SECRET: "original-auth-secret" },
  });
  const document = deploymentDocument({ environment });

  const valueDrift = new Map(environment);
  valueDrift.set("WORKBENCH_BETTER_AUTH_SECRET", "different-auth-secret");
  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, valueDrift),
    /WORKBENCH_BETTER_AUTH_SECRET does not match the signed secret value binding/u,
  );

  const metadataDrift = new Map(environment);
  const entries = JSON.parse(metadataDrift.get("WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON"));
  entries.find(({ name }) => name === "WORKBENCH_BETTER_AUTH_SECRET").valueSha256 = "0".repeat(64);
  metadataDrift.set("WORKBENCH_PRODUCTION_SECRET_VERSIONS_JSON", JSON.stringify(entries));
  const driftedDocument = deploymentDocument({ environment: metadataDrift });
  assert.throws(
    () => verifyProductionDeploymentEnvironment(driftedDocument, metadataDrift),
    /WORKBENCH_BETTER_AUTH_SECRET does not match the signed secret value binding/u,
  );
});

test("rejects provider and secret-channel file byte drift", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-secret-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerPath = path.join(root, "deerflow-provider.env");
  const attestationPath = path.join(root, "deerflow-secret-channel.json");
  await writeFile(providerPath, "MODEL_API_KEY=original\n", { mode: 0o600 });
  await writeFile(attestationPath, "{\"version\":1}\n", { mode: 0o600 });
  const environment = productionDeploymentConfigFixtureEnvironment({
    overrides: {
      WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE: providerPath,
      WORKBENCH_DEERFLOW_SECRET_CHANNEL_ATTESTATION_PATH: attestationPath,
    },
  });
  const document = deploymentDocument({ environment });

  await writeFile(providerPath, "MODEL_API_KEY=replaced\n", { mode: 0o600 });
  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, environment),
    /WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE does not match the signed secret value binding/u,
  );

  await writeFile(providerPath, "MODEL_API_KEY=original\n", { mode: 0o600 });
  await writeFile(attestationPath, "{\"version\":2}\n", { mode: 0o600 });
  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, environment),
    /WORKBENCH_DEERFLOW_SECRET_CHANNEL_ATTESTATION_PATH does not match the signed secret value binding/u,
  );
});

test("rejects provider env interpolation even when its literal bytes are signed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-provider-interpolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providerPath = path.join(root, "deerflow-provider.env");
  await writeFile(providerPath, [
    "UNTRACKED=runtime-secret-a",
    "OPENAI_API_KEY=$UNTRACKED",
    "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL=https://provider.example.test/v1",
    "WORKBENCH_DEERFLOW_PROVIDER_MODEL=gpt-5.5",
    "",
  ].join("\n"), { mode: 0o600 });
  const environment = productionDeploymentConfigFixtureEnvironment({
    overrides: { WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE: providerPath },
  });
  const document = deploymentDocument({ environment });

  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, environment),
    /OPENAI_API_KEY.*must not contain/u,
  );
});

test("binds actual DeerFlow base and materialized effective config bytes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-deerflow-config-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const basePath = path.join(root, "config.base.yaml");
  const effectivePath = path.join(root, "config.effective.yaml");
  const baseBytes = Buffer.from("config_version: 1\nmodels: []\n");
  const effectiveBytes = Buffer.from("config_version: 1\nmodels: []\ntools: []\n");
  await writeFile(basePath, baseBytes, { mode: 0o600 });
  await writeFile(effectivePath, effectiveBytes, { mode: 0o600 });
  const environment = productionDeploymentConfigFixtureEnvironment({
    overrides: {
      WORKBENCH_DEERFLOW_BASE_CONFIG_PATH: basePath,
      WORKBENCH_DEERFLOW_BASE_CONFIG_SHA256: sha256(baseBytes),
      DEER_FLOW_CONFIG_PATH: effectivePath,
      WORKBENCH_DEERFLOW_EFFECTIVE_CONFIG_SHA256: sha256(effectiveBytes),
    },
  });
  const document = deploymentDocument({ environment });
  assert.equal(verifyProductionDeploymentEnvironment(document, environment), true);

  await writeFile(basePath, "config_version: 2\n", { mode: 0o600 });
  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, environment),
    /BASE_CONFIG_PATH does not match WORKBENCH_DEERFLOW_BASE_CONFIG_SHA256/u,
  );

  await writeFile(basePath, baseBytes, { mode: 0o600 });
  await writeFile(effectivePath, "config_version: 2\n", { mode: 0o600 });
  assert.throws(
    () => verifyProductionDeploymentEnvironment(document, environment),
    /DEER_FLOW_CONFIG_PATH does not match WORKBENCH_DEERFLOW_EFFECTIVE_CONFIG_SHA256/u,
  );

  await writeFile(effectivePath, effectiveBytes, { mode: 0o600 });
  const incorrectMetadata = new Map(environment);
  incorrectMetadata.set("WORKBENCH_DEERFLOW_BASE_CONFIG_SHA256", "0".repeat(64));
  assert.throws(
    () => verifyProductionDeploymentEnvironment(deploymentDocument({ environment: incorrectMetadata }), incorrectMetadata),
    /BASE_CONFIG_PATH does not match WORKBENCH_DEERFLOW_BASE_CONFIG_SHA256/u,
  );

  await unlink(effectivePath);
  assert.equal(
    verifyProductionDeploymentEnvironment(document, environment),
    true,
    "fresh hosts defer the effective-config byte check until the deterministic merge gate",
  );
});

test("binds the Runtime Worker signer to one dedicated trust-policy scope", () => {
  const binding = deploymentConfigBinding(deploymentDocument(), "f".repeat(64));
  const runtime = binding.runtimeWorkerExecution;
  const policy = {
    sha256: runtime.trustPolicySha256,
    environmentId: runtime.environmentId,
    keys: new Map([[runtime.keyId, {}]]),
    approvalAuthorities: [],
    receiptAuthorities: [{
      scopeId: runtime.scopeId,
      signerId: runtime.signerId,
      keyId: runtime.keyId,
    }],
  };
  assert.equal(verifyProductionDeploymentRuntimeBinding(binding, {
    environmentId: runtime.environmentId,
    trustPolicy: policy,
  }), true);
  assert.throws(
    () => verifyProductionDeploymentRuntimeBinding(binding, {
      environmentId: "production-b",
      trustPolicy: policy,
    }),
    /signed deployment environment differs/u,
  );
  assert.throws(
    () => verifyProductionDeploymentRuntimeBinding(binding, {
      trustPolicy: { ...policy, sha256: "0".repeat(64) },
    }),
    /trust policy SHA-256 mismatch/u,
  );
  assert.throws(
    () => verifyProductionDeploymentRuntimeBinding(binding, {
      trustPolicy: {
        ...policy,
        approvalAuthorities: [{ role: "Release", approverId: "release", keyId: runtime.keyId }],
      },
    }),
    /must not authorize production approvals/u,
  );
  assert.throws(
    () => verifyProductionDeploymentRuntimeBinding(binding, {
      trustPolicy: {
        ...policy,
        receiptAuthorities: [
          ...policy.receiptAuthorities,
          { scopeId: "production.other", signerId: "other", keyId: runtime.keyId },
        ],
      },
    }),
    /must be dedicated/u,
  );
});

for (const mode of ["legacy-read", "shadow-verify"]) {
  test(`refuses to sign a production configuration with provider-state mode ${mode}`, () => {
    assert.throws(
      () => deploymentDocument({
        overrides: { WORKBENCH_RUNTIME_PROVIDER_STATE_MODE: mode },
      }),
      /WORKBENCH_RUNTIME_PROVIDER_STATE_MODE must be projection-required/u,
    );
  });
}

test("verifies the Cosign blob before parsing and exposes an exact downstream binding", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-deployment-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "deployment-config.json");
  const bundlePath = path.join(root, "deployment-config.bundle.json");
  await writeFile(manifestPath, `${JSON.stringify(deploymentDocument())}\n`);
  await writeFile(bundlePath, "{}\n");
  const events = [];
  const loaded = loadVerifiedProductionDeploymentConfig({
    manifestPath,
    bundlePath,
    certificateIdentity,
    certificateOidcIssuer,
    expected: { githubRunId: "81234", githubRunAttempt: 3, releaseChainId },
    verifyBlob: () => {
      events.push("verify");
      return true;
    },
    readManifest: (filePath) => {
      events.push("read");
      return readFileSync(filePath);
    },
  });
  assert.deepEqual(events, ["read", "verify"]);
  assert.equal(loaded.binding.manifestSha256, loaded.manifestSha256);
  assert.equal(loaded.binding.configSha256, loaded.document.configurationSha256);
});

test("preflight verifier binds the signed configuration to the complete deployment environment", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-deployment-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = trustSigner("runtime-worker-production");
  const approvals = ["security", "data", "operations", "release"].map(trustSigner);
  const policy = {
    schemaVersion: "workbench.production-trust-policy.v1",
    environmentId: "workbench-production",
    keys: [worker, ...approvals].map(({ trustEntry }) => trustEntry),
    approvalAuthorities: ["Security", "Data", "Operations", "Release"].map((role, index) => ({
      role,
      approverId: `${role.toLowerCase()}-approver`,
      keyId: approvals[index].keyId,
    })),
    receiptAuthorities: [{
      scopeId: "production-runtime.worker-execution",
      signerId: worker.signerId,
      keyId: worker.keyId,
    }],
  };
  const trustPolicyPath = path.join(root, "production-trust-policy.json");
  const trustPolicyRaw = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
  await writeFile(trustPolicyPath, trustPolicyRaw);
  const environment = productionDeploymentConfigFixtureEnvironment({
    overrides: {
      WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID: worker.keyId,
      WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID: worker.signerId,
      WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256: sha256(trustPolicyRaw),
      WORKBENCH_COSIGN_CERTIFICATE_IDENTITY: certificateIdentity,
      WORKBENCH_COSIGN_OIDC_ISSUER: certificateOidcIssuer,
    },
  });
  const productionImages = imageManifest();
  const imageManifestPath = path.join(root, "production-image-manifest.json");
  const imageManifestRaw = Buffer.from(`${JSON.stringify(productionImages, null, 2)}\n`);
  await writeFile(imageManifestPath, imageManifestRaw);
  const document = createProductionDeploymentConfig({
    candidateId,
    sourceCommit,
    signedTag,
    releaseChainId,
    imageManifest: productionImages,
    imageManifestSha256: sha256(imageManifestRaw),
    githubRunId: "81234",
    githubRunAttempt: 3,
    infrastructureEnvironment: environment,
  });
  const manifestPath = path.join(root, "production-deployment-config.json");
  const bundlePath = path.join(root, "production-deployment-config.bundle.json");
  const manifestRaw = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await writeFile(manifestPath, manifestRaw);
  await writeFile(bundlePath, "{}\n");
  for (const [name, value] of Object.entries({
    WORKBENCH_DEPLOYMENT_CONFIG_MANIFEST_PATH: manifestPath,
    WORKBENCH_DEPLOYMENT_CONFIG_BUNDLE_PATH: bundlePath,
    WORKBENCH_DEPLOYMENT_CONFIG_MANIFEST_SHA256: sha256(manifestRaw),
    WORKBENCH_IMAGE_INVENTORY_PATH: imageManifestPath,
    WORKBENCH_PRODUCTION_TRUST_POLICY_PATH: trustPolicyPath,
    WORKBENCH_COSIGN_CERTIFICATE_IDENTITY: certificateIdentity,
    WORKBENCH_COSIGN_OIDC_ISSUER: certificateOidcIssuer,
    WORKBENCH_CANDIDATE_ID: candidateId,
    WORKBENCH_SOURCE_COMMIT: sourceCommit,
    WORKBENCH_SIGNED_TAG: signedTag,
    WORKBENCH_RELEASE_CHAIN_ID: releaseChainId,
    WORKBENCH_RELEASE_CHAIN_RUN_ID: "81234",
    WORKBENCH_RELEASE_CHAIN_RUN_ATTEMPT: "3",
  })) environment.set(name, value);

  const verified = await assertProductionDeploymentConfig({
    environment,
    repoRoot,
    verifyBlob: () => true,
  });
  assert.equal(verified.status, "PASS");
  assert.equal(verified.manifestSha256, sha256(manifestRaw));

  const drifted = new Map(environment);
  drifted.set("WORKBENCH_RELEASE_CHAIN_RUN_ATTEMPT", "2");
  await assert.rejects(
    assertProductionDeploymentConfig({ environment: drifted, repoRoot, verifyBlob: () => true }),
    /run attempt mismatch/u,
  );
});

test("Cosign deployment-config verification pins the exact workflow identity", () => {
  let invocation;
  const manifestBytes = Buffer.from("signed deployment config\n");
  const bundleBytes = Buffer.from("signed bundle\n");
  assert.equal(verifyCosignDeploymentConfigBlob({
    manifestPath: "/tmp/deployment-config.json",
    bundlePath: "/tmp/deployment-config.bundle.json",
    certificateIdentity,
    certificateOidcIssuer,
    manifestBytes,
    bundleBytes,
    execute: (command, args, options) => {
      invocation = {
        command,
        args,
        options,
        manifest: readFileSync(args.at(-1)),
        bundle: readFileSync(args[2]),
      };
    },
  }), true);
  assert.equal(invocation.args[0], "verify-blob");
  assert.equal(invocation.args[1], "--bundle");
  assert.equal(path.basename(invocation.args[2]), "deployment-config.bundle.json");
  assert.deepEqual(invocation.args.slice(3, 7), [
    "--certificate-identity", certificateIdentity,
    "--certificate-oidc-issuer", certificateOidcIssuer,
  ]);
  assert.equal(path.basename(invocation.args[7]), "deployment-config.json");
  assert.deepEqual(invocation.manifest, manifestBytes);
  assert.deepEqual(invocation.bundle, bundleBytes);
});

function deploymentDocument(options = {}) {
  const environment = options.environment ?? productionDeploymentConfigFixtureEnvironment(options);
  return createProductionDeploymentConfig({
    candidateId,
    sourceCommit,
    signedTag,
    releaseChainId,
    imageManifest: imageManifest(),
    imageManifestSha256,
    githubRunId: "81234",
    githubRunAttempt: 3,
    infrastructureEnvironment: environment,
  });
}

function imageManifest() {
  return {
    schemaVersion: 1,
    candidate: { sourceCommit, releaseChainId },
    images: imageDefinitions().map(([id, dockerfile, target], index) => {
      const digest = `sha256:${String(index).repeat(64)}`;
      const evidence = () => ({ sha256: "e".repeat(64), uri: `urn:sha256:${"e".repeat(64)}` });
      return {
        id,
        imageRef: `registry.example.test/workbench/${id}@${digest}`,
        digest,
        sourceCommit,
        buildConfiguration: createProductionBuildConfiguration({ id, sourceCommit, dockerfile, target }),
        sbom: evidence(),
        sbomAttestation: evidence(),
        provenance: evidence(),
        signature: { ...evidence(), verification: evidence(), verified: true },
        vulnerabilityReport: { ...evidence(), status: "PASS", critical: 0, high: 0 },
      };
    }),
  };
}

function imageDefinitions() {
  return [
    ["api", "apps/workbench-api/Dockerfile", "runner"],
    ["api-migrator", "apps/workbench-api/Dockerfile", "migrator"],
    ["deerflow", "integrations/deerflow/Dockerfile", "runtime"],
    ["export-worker", "apps/workbench-export-worker/Dockerfile", "runner"],
    ["file-worker", "apps/workbench-file-worker/Dockerfile", "runner"],
    ["import-worker", "apps/workbench-import-worker/Dockerfile", "runner"],
    ["preview", "apps/workbench-preview/Dockerfile", "runner"],
    ["quartz", "apps/knowledge/Dockerfile", "immutable-runner"],
    ["runtime-worker", "apps/workbench-worker/Dockerfile", "runner"],
    ["web", "apps/web/Dockerfile", "runner"],
  ];
}

function withoutPayloadSha(document) {
  return Object.fromEntries(Object.entries(document).filter(([key]) => key !== "payloadSha256"));
}

function resealDocument(document) {
  document.sourceConfiguration.sha256 = sha256(JSON.stringify(canonical(document.sourceConfiguration.files)));
  document.effectiveConfig.sha256 = sha256(JSON.stringify(canonical(document.effectiveConfig.values)));
  document.secretVersions.sha256 = sha256(JSON.stringify(canonical(document.secretVersions.entries)));
  document.configurationSha256 = sha256(JSON.stringify(canonical({
    sourceConfigurationSha256: document.sourceConfiguration.sha256,
    effectiveConfigSha256: document.effectiveConfig.sha256,
    dependencyAttestationsSha256: sha256(JSON.stringify(canonical(document.dependencies))),
    secretVersionsSha256: document.secretVersions.sha256,
    identity: document.identity,
  })));
  document.payloadSha256 = sha256(JSON.stringify(canonical(withoutPayloadSha(document))));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function trustSigner(signerId) {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeySha256 = sha256(spki);
  return {
    signerId,
    keyId: `sha256:${publicKeySha256}`,
    trustEntry: {
      keyId: `sha256:${publicKeySha256}`,
      algorithm: "Ed25519",
      publicKeySpkiBase64: spki.toString("base64"),
      publicKeySha256,
      validFromUtc: "2026-01-01T00:00:00Z",
      validUntilUtc: "2027-01-01T00:00:00Z",
      revokedAtUtc: null,
    },
  };
}
