import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  INFRASTRUCTURE_IMAGE_DEFINITIONS,
  PRODUCTION_CONFIG_PATHS,
  createProductionDeploymentConfig,
  deploymentConfigBinding,
  loadVerifiedProductionDeploymentConfig,
  verifyCosignDeploymentConfigBlob,
  verifyProductionDeploymentConfig,
} from "./production-deployment-config.mjs";
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
  assert.equal(
    INFRASTRUCTURE_IMAGE_DEFINITIONS.find((dependency) => dependency.name === "gateway")
      .composeBindings.includes("deploy/workbench-compose.yml#object-storage-egress"),
    true,
  );
  assert.equal(
    document.effectiveConfig.values.WORKBENCH_S3_EGRESS_UPSTREAM_HOST,
    "s3.internal.example.test",
  );
  assert.equal(PRODUCTION_CONFIG_PATHS.some((file) => /server-validation|dex|minio|\.example/u.test(file)), false);

  const binding = deploymentConfigBinding(document, "f".repeat(64));
  assert.equal(binding.manifestSha256, "f".repeat(64));
  assert.equal(binding.configSha256, document.configurationSha256);
  assert.equal(binding.migrationSha256, document.migrations.sha256);
  assert.equal(binding.effectiveConfigSha256, document.effectiveConfig.sha256);
  assert.equal(binding.secretVersionsSha256, document.secretVersions.sha256);
  assert.equal(binding.dependencies.length, 8);
  assert.equal("effectiveConfig" in binding, false);
  assert.equal("secretVersions" in binding, false);
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
  assert.deepEqual(events, ["verify", "read"]);
  assert.equal(loaded.binding.manifestSha256, loaded.manifestSha256);
  assert.equal(loaded.binding.configSha256, loaded.document.configurationSha256);
});

test("Cosign deployment-config verification pins the exact workflow identity", () => {
  let invocation;
  assert.equal(verifyCosignDeploymentConfigBlob({
    manifestPath: "/tmp/deployment-config.json",
    bundlePath: "/tmp/deployment-config.bundle.json",
    certificateIdentity,
    certificateOidcIssuer,
    execute: (command, args, options) => {
      invocation = { command, args, options };
    },
  }), true);
  assert.deepEqual(invocation.args, [
    "verify-blob",
    "--bundle", "/tmp/deployment-config.bundle.json",
    "--certificate-identity", certificateIdentity,
    "--certificate-oidc-issuer", certificateOidcIssuer,
    "/tmp/deployment-config.json",
  ]);
});

function deploymentDocument(options = {}) {
  return createProductionDeploymentConfig({
    candidateId,
    sourceCommit,
    signedTag,
    releaseChainId,
    imageManifest: imageManifest(),
    imageManifestSha256,
    githubRunId: "81234",
    githubRunAttempt: 3,
    infrastructureEnvironment: productionDeploymentConfigFixtureEnvironment(options),
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
