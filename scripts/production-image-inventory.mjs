#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { readDeploymentEnv } from "./workbench-origin-manifest.mjs";
import { verifyProductionBuildConfiguration } from "./write-production-build-configuration.mjs";

const root = new URL("../", import.meta.url);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CHAIN_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function loadProductionImageInventory() {
  return JSON.parse(readText("deploy/production-image-inventory.json"));
}

export function loadVerifiedProductionImageManifest({
  manifestPath,
  bundlePath,
  certificateIdentity,
  certificateOidcIssuer,
  verifyBlob = verifyCosignManifestBlob,
  readManifest = (path) => readFileSync(path, "utf8"),
}) {
  const resolvedManifestPath = requiredPath(manifestPath, "production image manifest");
  const resolvedBundlePath = requiredPath(bundlePath, "production image manifest bundle");
  assertHttpsIdentity(certificateIdentity, "production image manifest certificate identity");
  assertHttpsIdentity(certificateOidcIssuer, "production image manifest certificate OIDC issuer");
  const verified = verifyBlob({
    manifestPath: resolvedManifestPath,
    bundlePath: resolvedBundlePath,
    certificateIdentity,
    certificateOidcIssuer,
  });
  assert(verified === true, "production image manifest signature verification failed");
  return JSON.parse(readManifest(resolvedManifestPath));
}

export function verifyCosignManifestBlob({
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
    throw new Error("production image manifest signature verification failed");
  }
  return true;
}

export function loadProductionImageDigestBinding({
  manifestPath,
  expectedManifestSha256,
  expectedCommit,
  expectedReleaseChainId,
  inventory = loadProductionImageInventory(),
}) {
  const resolvedManifestPath = requiredPath(manifestPath, "production image manifest");
  assert(SHA256_PATTERN.test(expectedManifestSha256), "expected production image manifest SHA-256 is invalid");
  const stat = lstatSync(resolvedManifestPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), "production image manifest must be a regular file");
  const raw = readFileSync(resolvedManifestPath);
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  assert(manifestSha256 === expectedManifestSha256, "production image manifest SHA-256 mismatch");
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("production image manifest JSON is invalid");
  }
  return {
    manifest,
    manifestSha256,
    images: productionImageDigestBinding({
      manifest,
      expectedCommit,
      expectedReleaseChainId,
      inventory,
    }),
  };
}

export function productionImageDigestBinding({
  manifest,
  expectedCommit,
  expectedReleaseChainId,
  inventory = loadProductionImageInventory(),
}) {
  verifyProductionImageManifest({
    manifest,
    expectedCommit,
    expectedReleaseChainId,
    inventory,
  });
  return manifest.images
    .map((record) => ({ name: record.id, digest: record.digest }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
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
  const workflowSource = readText(".github/workflows/workbench-ci.yml");
  assertPinnedWorkflowActions(ci);
  const releaseChainJob = ci.jobs?.["release-chain"];
  assert(releaseChainJob, "release-chain job is required before G3/G4 jobs");
  assertProductionWorkflowPermissions(ci);
  assert(
    String(releaseChainJob.outputs?.chain_id).includes("steps.verify_release_chain.outputs.chain_id"),
    "release-chain job must expose the verified chain ID",
  );
  for (const [output, source] of [
    ["candidate_id", "steps.verify_release_chain.outputs.candidate_id"],
    ["source_commit", "steps.verify_release_chain.outputs.source_commit"],
    ["signed_tag", "steps.verify_release_chain.outputs.signed_tag"],
  ]) {
    assert(
      String(releaseChainJob.outputs?.[output]).includes(source),
      `release-chain job must expose ${output}`,
    );
  }
  assertDeepEqual(
    ci.jobs?.quality?.needs,
    ["release-chain"],
    "quality must wait for the verified G0-G2 release chain",
  );
  const fileWorkerPostgresStep = ci.jobs?.quality?.steps?.find(
    (step) => step.name === "Run candidate-bound File Worker PostgreSQL integration",
  );
  assert(
    String(fileWorkerPostgresStep?.run).includes("@workbench/workbench-file-worker run test:postgres"),
    "G3 quality must execute the File Worker PostgreSQL integration",
  );
  assert(
    String(ci.jobs?.quality?.services?.postgres?.image).includes("WORKBENCH_CI_POSTGRES_IMAGE"),
    "CI PostgreSQL service must accept the production digest input",
  );
  assertDeepEqual(
    ci.jobs?.["deployment-config"]?.needs,
    ["release-chain"],
    "deployment configuration must wait for the verified G0-G2 release chain",
  );
  assert(
    String(releaseChainJob.steps?.map((step) => step.run ?? "").join("\n")).includes("verify-release-chain.mjs"),
    "production release-chain job must invoke the real G0-G2 verifier",
  );
  assert(
    String(releaseChainJob.steps?.map((step) => step.run ?? "").join("\n")).includes("curl --fail")
      && String(releaseChainJob.steps?.map((step) => step.run ?? "").join("\n")).includes("sha256"),
    "production release-chain job must download and hash external evidence",
  );
  for (const variable of [
    "WORKBENCH_G0_APPROVAL_URL",
    "WORKBENCH_G0_APPROVAL_SHA256",
    "WORKBENCH_G1_MANIFEST_URL",
    "WORKBENCH_G1_MANIFEST_SHA256",
    "WORKBENCH_G1_INVENTORY_URL",
    "WORKBENCH_G1_INVENTORY_SHA256",
    "WORKBENCH_G2_RECEIPT_URL",
    "WORKBENCH_G2_RECEIPT_SHA256",
    "WORKBENCH_RELEASE_SIGNED_TAG",
  ]) {
    assert(workflowSource.includes(variable), `release-chain input ${variable} is missing`);
  }
  assertDeepEqual(
    ci.jobs?.["production-images"]?.needs,
    ["release-chain", "release-chain-signing", "quality", "deployment-config"],
    "production image publication must wait for the verified chain and G3 gates",
  );
  assertDeepEqual(
    ci.jobs?.["image-evidence"]?.needs,
    ["production-images", "release-chain", "release-chain-signing"],
    "image evidence must retain the verified release-chain binding",
  );
  assert(
    String(ci.jobs?.["image-evidence"]?.steps?.map((step) => step.run ?? "").join("\n"))
      .includes("--release-chain-id \"${{ needs['release-chain'].outputs.chain_id }}\""),
    "image evidence must pass the verified release-chain ID to the manifest assembler",
  );
  assert(
    ci.jobs?.["image-evidence"]?.permissions?.["id-token"] === "write",
    "production image manifest signing requires GitHub OIDC id-token write permission",
  );
  assert(
    ci.jobs?.["deployment-config-evidence"]?.permissions?.["id-token"] === "write",
    "production deployment configuration signing requires GitHub OIDC id-token write permission",
  );
  const manifestSignatureStep = ci.jobs?.["image-evidence"]?.steps?.find(
    (step) => step.name === "Sign and verify candidate image manifest",
  );
  assert(manifestSignatureStep, "production image manifest signature step is required");
  assert(
    String(manifestSignatureStep.run).includes('--certificate-identity "$CERTIFICATE_IDENTITY"')
      && !String(manifestSignatureStep.run).includes("--certificate-identity-regexp"),
    "production image manifest verification must use an exact certificate identity",
  );
  assert(
    String(manifestSignatureStep.env?.CERTIFICATE_IDENTITY).endsWith("@refs/heads/production"),
    "production image manifest signer identity must bind the production branch workflow",
  );
  const imageSignatureStep = ci.jobs?.["production-images"]?.steps?.find(
    (step) => step.name === "Sign and verify immutable image",
  );
  assert(imageSignatureStep, "production image signature verification step is required");
  assert(
    String(imageSignatureStep.run).includes('--certificate-identity "$CERTIFICATE_IDENTITY"')
      && !String(imageSignatureStep.run).includes("--certificate-identity-regexp"),
    "production image signature verification must use an exact certificate identity",
  );
  assert(
    String(imageSignatureStep.env?.CERTIFICATE_IDENTITY).endsWith("@refs/heads/production"),
    "production image signer identity must bind the production branch workflow",
  );
  assertProductionImageMatrix({ ci, inventory, ids, workflowSource });
  const acceptance = readYaml(".github/workflows/workbench-production-acceptance.yml");
  const acceptanceSource = readText(".github/workflows/workbench-production-acceptance.yml");
  assertProductionAcceptanceImageWorkflow({ workflow: acceptance, workflowSource: acceptanceSource });
  return inventory;
}

export function assertProductionWorkflowPermissions(ci) {
  const privilegedPermissions = new Set(["id-token", "packages", "attestations"]);
  const productionOnlyJobs = new Set([
    "release-chain-signing",
    "production-images",
    "image-evidence",
    "deployment-config-evidence",
  ]);
  for (const [jobId, job] of Object.entries(ci.jobs ?? {})) {
    const writable = Object.entries(job.permissions ?? {})
      .filter(([permission, access]) => privilegedPermissions.has(permission) && access === "write")
      .map(([permission]) => permission);
    if (writable.length === 0) continue;
    assert(productionOnlyJobs.has(jobId), `${jobId} must not receive privileged GitHub token permissions`);
    const condition = String(job.if ?? "");
    assert(
      condition.includes("github.event_name == 'push'") && condition.includes("github.ref == 'refs/heads/production'"),
      `${jobId} privileged permissions must be guarded by a production-only job condition`,
    );
  }
  for (const jobId of ["release-chain", "quality", "deployment-config"]) {
    const permissions = ci.jobs?.[jobId]?.permissions ?? {};
    for (const permission of privilegedPermissions) {
      assert(permissions[permission] !== "write", `${jobId} must remain unprivileged on pull requests and untrusted pushes`);
    }
  }
  assert(
    ci.jobs?.["release-chain-signing"]?.permissions?.["id-token"] === "write",
    "release-chain signing must have production-only OIDC permission",
  );
  assert(
    ci.jobs?.["production-images"]?.permissions?.packages === "write"
      && ci.jobs?.["production-images"]?.permissions?.attestations === "write"
      && ci.jobs?.["production-images"]?.permissions?.["id-token"] === "write",
    "production image publication must own packages, attestations, and OIDC permissions",
  );
  return true;
}

export function assertProductionAcceptanceImageWorkflow({ workflow, workflowSource }) {
  assertPinnedWorkflowActions(workflow);
  const acceptanceSteps = workflow.jobs?.["production-acceptance"]?.steps ?? [];
  assert(acceptanceSteps.length > 0, "production acceptance job is required");
  const imageDownload = acceptanceSteps.find((step) => step.name === "Download CI-owned production image manifest");
  assert(
    String(imageDownload?.run).includes('gh run download "$RELEASE_CHAIN_RUN_ID"')
      && String(imageDownload?.run).includes('--name "production-image-manifest-$RELEASE_CHAIN_RUN_ATTEMPT"'),
    "production acceptance must download the G4 image manifest from the selected CI run",
  );
  const deploymentConfigDownload = acceptanceSteps.find(
    (step) => step.name === "Download CI-owned deployment configuration",
  );
  assert(
    String(deploymentConfigDownload?.run).includes('--name "production-deployment-config-$RELEASE_CHAIN_RUN_ATTEMPT"'),
    "production acceptance must download the deployment configuration from the selected CI run attempt",
  );
  const g4Verification = acceptanceSteps.find(
    (step) => step.name === "Verify CI-owned G4 images and bind the control catalog",
  );
  for (const marker of [
    "production-image-inventory.mjs",
    '--expected-commit "$SOURCE_COMMIT"',
    '--release-chain-id "$RELEASE_CHAIN_ID"',
    '--certificate-identity "$CERTIFICATE_IDENTITY"',
    '--signature-bundle-root "$IMAGE_ROOT"',
    "production-acceptance-control-catalog.v1.json",
  ]) {
    assert(String(g4Verification?.run).includes(marker), `production acceptance G4 verification is missing ${marker}`);
  }
  for (const marker of [
    "--production-image-manifest",
    "--production-image-manifest-sha256",
    "--deployment-config-manifest",
    "--deployment-config-manifest-sha256",
    "--control-catalog",
    "--control-catalog-sha256",
  ]) {
    assert(workflowSource.includes(marker), `production acceptance is missing ${marker}`);
  }
  for (const marker of [
    "steps.ci_run.outputs.run_attempt",
    "verified-release-chain-$RELEASE_CHAIN_RUN_ATTEMPT",
    "production-image-manifest-$RELEASE_CHAIN_RUN_ATTEMPT",
    "loadVerifiedProductionDeploymentConfig",
    "githubRunAttempt: process.env.RELEASE_CHAIN_RUN_ATTEMPT",
  ]) {
    assert(workflowSource.includes(marker), `production acceptance selected-run binding is missing ${marker}`);
  }
  return true;
}

function assertProductionImageMatrix({ ci, inventory, ids, workflowSource }) {
  const matrix = ci.jobs?.["production-images"]?.strategy?.matrix?.include ?? [];
  const matrixById = new Map(matrix.map((entry) => [entry.name, entry]));
  for (const image of inventory.candidateImages) {
    const entry = matrixById.get(image.id);
    assert(entry, `production image CI matrix is missing ${image.id}`);
    assert(entry.dockerfile === image.dockerfile, `${image.id} CI Dockerfile differs from inventory`);
    assert(entry.target === image.target, `${image.id} CI target differs from inventory`);
    const buildArgs = String(entry.build_args ?? "");
    const dockerfile = readText(image.dockerfile);
    if (dockerfile.includes("ARG NODE_IMAGE")) {
      assert(buildArgs.includes("NODE_IMAGE="), `${image.id} CI build must bind NODE_IMAGE`);
    }
    if (dockerfile.includes("ARG NGINX_IMAGE")) {
      assert(buildArgs.includes("NGINX_IMAGE="), `${image.id} CI build must bind NGINX_IMAGE`);
    }
  }
  assertDeepEqual(
    [...matrixById.keys()].sort(),
    [...ids].sort(),
    "production image CI matrix and deploy inventory must contain the same image IDs",
  );

  assert(
    !workflowSource.includes("ignore-unfixed: true"),
    "production vulnerability evidence must not hide unfixed HIGH or CRITICAL findings",
  );
  for (const marker of [
    "mode=max",
    "sbom:",
    "docker/login-action",
    "actions/attest-build-provenance",
    "steps.provenance.outputs.bundle-path",
    "output/provenance-${{ matrix.name }}.bundle.json",
    "actions/attest-sbom",
    "steps.sbom_attestation.outputs.bundle-path",
    "output/sbom-attestation-${{ matrix.name }}.bundle.json",
    "aquasecurity/trivy-action",
    "cosign sign",
    "cosign sign-blob",
    "cosign verify-blob",
    "production-image-manifest.bundle.json",
    "production-image-manifest-${{ github.run_attempt }}",
    "production-image-evidence-${{ github.run_attempt }}-",
    "output/cosign-*.bundle.json",
    "production-image-inventory.mjs --assemble",
    "--release-chain-id",
    "write-production-build-configuration.mjs",
    "io.workbench.build-configuration-sha256=",
    "--build-configuration-path",
    "vars.WORKBENCH_WEB_ORIGIN",
    "vars.WORKBENCH_PREVIEW_ORIGIN",
    "vars.WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL",
    "vars.WORKBENCH_KNOWLEDGE_BASE_URL",
    "vars.WORKBENCH_PUBLIC_REGISTRATION_ENABLED",
    "Require immutable production base image inputs",
    "WORKBENCH_CI_POSTGRES_IMAGE",
    "WORKBENCH_NODE_IMAGE",
    "WORKBENCH_NGINX_IMAGE",
    "WORKBENCH_POSTGRES_IMAGE",
    "WORKBENCH_DOCLING_IMAGE",
    "WORKBENCH_CLAMAV_IMAGE",
    "WORKBENCH_MINIO_IMAGE",
    "WORKBENCH_MINIO_MC_IMAGE",
    "WORKBENCH_DEX_IMAGE",
    "NODE_IMAGE=",
    "NGINX_IMAGE=",
    "production-deployment-config-${{ github.run_attempt }}",
    "createProductionDeploymentConfig",
    "production-deployment-config.json",
  ]) {
    assert(workflowSource.includes(marker), `production image workflow is missing ${marker}`);
  }
}

export function assertPinnedWorkflowActions(workflow) {
  const actions = [];
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const [stepIndex, step] of (job.steps ?? []).entries()) {
      if (typeof step?.uses === "string") actions.push({ jobId, stepIndex, uses: step.uses });
    }
  }
  assert(actions.length > 0, "workflow must contain action steps");
  for (const action of actions) {
    const match = action.uses.match(/^[^@\s]+@([^\s]+)$/u);
    assert(match && /^[a-f0-9]{40}$/u.test(match[1]), `${action.jobId} step ${action.stepIndex} must pin its action to a full commit SHA`);
  }
  return true;
}

export function verifyProductionImageManifest({
  manifest,
  expectedCommit,
  expectedReleaseChainId,
  deploymentEnvironment,
  onlyImageId,
  inventory = loadProductionImageInventory(),
}) {
  assertProductionImageContract({ inventory });
  assert(COMMIT_PATTERN.test(expectedCommit), "expected candidate commit must be 40 lowercase hex characters");
  assert(manifest?.schemaVersion === 1, "image evidence manifest schemaVersion must be 1");
  assert(manifest?.candidate?.sourceCommit === expectedCommit, "image evidence candidate commit mismatch");
  if (expectedReleaseChainId !== undefined) {
    assert(CHAIN_ID_PATTERN.test(expectedReleaseChainId), "expected release chain ID must be a prefixed SHA-256");
    assert(manifest?.candidate?.releaseChainId === expectedReleaseChainId, "image evidence release chain ID mismatch");
  }
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
    verifyImageRecord(record, expectedCommit, image);
    if (deploymentEnvironment) {
      const deployedRef = deploymentEnvironment.get(image.imageEnvironment)?.trim();
      assert(deployedRef === record.imageRef, `${image.imageEnvironment} does not match signed image evidence`);
      assertBuildConfigurationMatchesDeployment(record, expectedCommit, deploymentEnvironment);
    }
  }
  return true;
}

export function assembleProductionImageManifest({ records, expectedCommit, releaseChainId }) {
  const inventory = assertProductionImageContract();
  if (releaseChainId !== undefined) {
    assert(CHAIN_ID_PATTERN.test(releaseChainId), "release chain ID must be a prefixed SHA-256");
  }
  const manifest = {
    schemaVersion: 1,
    candidate: {
      sourceCommit: expectedCommit,
      ...(releaseChainId === undefined ? {} : { releaseChainId }),
    },
    images: [...records].sort((left, right) => left.id.localeCompare(right.id)),
  };
  verifyProductionImageManifest({ manifest, expectedCommit, inventory });
  return manifest;
}

export function verifyProductionImageSignatureBundles({
  manifest,
  signatureBundleRoot,
  certificateIdentity,
  certificateOidcIssuer,
  expectedCommit,
  expectedReleaseChainId,
  onlyImageId,
  execute = execFileSync,
  inventory = loadProductionImageInventory(),
}) {
  verifyProductionImageManifest({
    manifest,
    expectedCommit,
    expectedReleaseChainId,
    onlyImageId,
    inventory,
  });
  assertHttpsIdentity(certificateIdentity, "production image certificate identity");
  assertHttpsIdentity(certificateOidcIssuer, "production image certificate OIDC issuer");
  const rootPath = requiredPath(signatureBundleRoot, "production image signature bundle root");
  const rootStat = lstatSync(rootPath);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "production image signature bundle root must be a regular directory");
  const expectedImages = onlyImageId
    ? inventory.candidateImages.filter((image) => image.id === onlyImageId)
    : inventory.candidateImages;
  const expectedBundleNames = expectedImages.map((image) => `cosign-${image.id}.bundle.json`).sort();
  const actualBundleNames = readdirSync(rootPath)
    .filter((name) => /^cosign-[a-z0-9-]+\.bundle\.json$/u.test(name))
    .sort();
  assertDeepEqual(actualBundleNames, expectedBundleNames, "production image signature bundle inventory is incomplete or contains untracked bundles");
  const records = new Map(manifest.images.map((record) => [record.id, record]));
  for (const image of expectedImages) {
    const record = records.get(image.id);
    const bundlePath = join(rootPath, `cosign-${image.id}.bundle.json`);
    const stat = lstatSync(bundlePath);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${image.id} Cosign bundle must be a regular file`);
    const bundleSha256 = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
    assert(bundleSha256 === record.signature.sha256, `${image.id} Cosign bundle SHA-256 mismatch`);
    try {
      execute("cosign", [
        "verify",
        "--bundle", bundlePath,
        "--certificate-identity", certificateIdentity,
        "--certificate-oidc-issuer", certificateOidcIssuer,
        record.imageRef,
      ], { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      throw new Error(`${image.id} Cosign subject/digest verification failed`);
    }
  }
  return true;
}

export function verifyLocalProductionImageBindings({
  manifest,
  expectedCommit,
  onlyImageId,
  excludeImageIds = [],
  inspectImage = inspectLocalImage,
  inventory = loadProductionImageInventory(),
}) {
  const excluded = new Set(excludeImageIds);
  const selected = inventory.candidateImages.filter((image) => (
    (!onlyImageId || image.id === onlyImageId) && !excluded.has(image.id)
  ));
  assert(selected.length > 0, "local image inspection did not select any candidate images");
  const records = new Map(manifest.images.map((record) => [record.id, record]));
  for (const image of selected) {
    const record = records.get(image.id);
    assert(record, `local image inspection is missing ${image.id}`);
    const labels = inspectImage(record.imageRef);
    assert(labels && typeof labels === "object" && !Array.isArray(labels), `${image.id} image labels are unavailable`);
    assert(
      labels["org.opencontainers.image.revision"] === expectedCommit,
      `${image.id} image source revision label mismatch`,
    );
    assert(
      labels["io.workbench.build-configuration-sha256"] === record.buildConfiguration.payloadSha256,
      `${image.id} image build configuration label mismatch`,
    );
  }
  return true;
}

function verifyImageRecord(record, expectedCommit, image) {
  assert(typeof record?.id === "string" && record.id.length > 0, "image record id is required");
  assert(DIGEST_PATTERN.test(record.digest), `${record.id} digest must be immutable sha256`);
  assert(record.imageRef?.endsWith(`@${record.digest}`), `${record.id} imageRef must end with its digest`);
  assert(record.sourceCommit === expectedCommit, `${record.id} source commit mismatch`);
  verifyProductionBuildConfiguration(record.buildConfiguration, {
    id: image.id,
    sourceCommit: expectedCommit,
    dockerfile: image.dockerfile,
    target: image.target,
  });
  verifyEvidence(record.sbom, `${record.id} SBOM`);
  verifyEvidence(record.sbomAttestation, `${record.id} signed SBOM attestation`);
  verifyEvidence(record.provenance, `${record.id} provenance`);
  verifyEvidence(record.signature, `${record.id} signature`);
  verifyEvidence(record.signature.verification, `${record.id} signature verification`);
  verifyEvidence(record.vulnerabilityReport, `${record.id} vulnerability report`);
  assert(record.vulnerabilityReport.status === "PASS", `${record.id} vulnerability scan did not pass`);
  assert(record.vulnerabilityReport.critical === 0, `${record.id} has critical vulnerabilities`);
  assert(record.vulnerabilityReport.high === 0, `${record.id} has high vulnerabilities`);
}

function assertBuildConfigurationMatchesDeployment(record, expectedCommit, environment) {
  const required = (name) => {
    const value = environment.get(name)?.trim();
    assert(value, `${record.id} build verification requires ${name}`);
    return value;
  };
  const withNodeImage = (buildArgs) => ({
    ...buildArgs,
    NODE_IMAGE: required("WORKBENCH_NODE_IMAGE"),
  });
  let expectedBuildArgs;
  switch (record.id) {
    case "web": {
      const knowledgeBaseUrl = required("WORKBENCH_KNOWLEDGE_BASE_URL");
      expectedBuildArgs = withNodeImage({
        NEXT_PUBLIC_KNOWLEDGE_APP_URL: `https://${knowledgeBaseUrl}`,
        NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL: environment.get("NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL")?.trim() ?? "",
        NEXT_PUBLIC_WORKBENCH_FORUM_URL: environment.get("NEXT_PUBLIC_WORKBENCH_FORUM_URL")?.trim() ?? "",
        NEXT_PUBLIC_WORKBENCH_PRIVACY_URL: environment.get("NEXT_PUBLIC_WORKBENCH_PRIVACY_URL")?.trim() ?? "",
        NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED: required("WORKBENCH_PUBLIC_REGISTRATION_ENABLED"),
        WORKBENCH_PREVIEW_ORIGIN: required("WORKBENCH_PREVIEW_ORIGIN"),
        WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: required("WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL"),
      });
      break;
    }
    case "quartz":
      expectedBuildArgs = {
        ...withNodeImage({}),
        NGINX_IMAGE: required("WORKBENCH_NGINX_IMAGE"),
        KNOWLEDGE_WEB_URL: required("WORKBENCH_WEB_ORIGIN"),
        QUARTZ_BASE_URL: required("WORKBENCH_KNOWLEDGE_BASE_URL"),
      };
      break;
    case "deerflow":
      expectedBuildArgs = {
        DEERFLOW_BASE_IMAGE: required("WORKBENCH_DEERFLOW_BASE_IMAGE_REF"),
        DEERFLOW_SOURCE_COMMIT: required("WORKBENCH_DEERFLOW_COMMIT"),
        WORKBENCH_SOURCE_COMMIT: expectedCommit,
      };
      break;
    case "api":
    case "api-migrator":
    case "runtime-worker":
    case "file-worker":
    case "import-worker":
    case "export-worker":
    case "preview":
      expectedBuildArgs = withNodeImage({});
      break;
    default:
      expectedBuildArgs = {};
  }
  assertDeepEqual(
    record.buildConfiguration.buildArgs,
    expectedBuildArgs,
    `${record.id} image build configuration does not match the deployment environment`,
  );
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

function inspectLocalImage(imageRef) {
  let output;
  try {
    output = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{json .Config.Labels}}", imageRef],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error(`pinned image is not available for local inspection: ${imageRef}`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`pinned image returned invalid labels: ${imageRef}`);
  }
}

function parseArguments(argv) {
  const result = { recordPaths: [], excludeImageIds: [] };
  const singleValue = (argument, key, index) => {
    const value = argv[index + 1];
    assert(value !== undefined && !value.startsWith("--"), `${argument} requires a value`);
    assert(result[key] === undefined, `${argument} must not be repeated`);
    result[key] = value;
    return index + 1;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--contract") {
      assert(!result.contract, "--contract must not be repeated");
      result.contract = true;
    } else if (argument === "--manifest") index = singleValue(argument, "manifestPath", index);
    else if (argument === "--bundle") index = singleValue(argument, "bundlePath", index);
    else if (argument === "--certificate-identity") index = singleValue(argument, "certificateIdentity", index);
    else if (argument === "--certificate-oidc-issuer") index = singleValue(argument, "certificateOidcIssuer", index);
    else if (argument === "--signature-bundle-root") index = singleValue(argument, "signatureBundleRoot", index);
    else if (argument === "--expected-commit") index = singleValue(argument, "expectedCommit", index);
    else if (argument === "--release-chain-id") index = singleValue(argument, "releaseChainId", index);
    else if (argument === "--env-file") index = singleValue(argument, "envFile", index);
    else if (argument === "--image") index = singleValue(argument, "onlyImageId", index);
    else if (argument === "--exclude-image") {
      const value = argv[index + 1];
      assert(value !== undefined && !value.startsWith("--"), `${argument} requires a value`);
      result.excludeImageIds.push(value);
      index += 1;
    } else if (argument === "--inspect-local-images") {
      assert(!result.inspectLocalImages, "--inspect-local-images must not be repeated");
      result.inspectLocalImages = true;
    } else if (argument === "--assemble") {
      assert(!result.assemble, "--assemble must not be repeated");
      result.assemble = true;
    } else if (argument === "--record") {
      const value = argv[index + 1];
      assert(value !== undefined && !value.startsWith("--"), `${argument} requires a value`);
      result.recordPaths.push(value);
      index += 1;
    }
    else throw new Error(`unsupported argument: ${argument}`);
  }
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.contract && !args.manifestPath && !args.assemble) {
    assertProductionImageContract();
    console.log("Production image inventory contract passed.");
    return;
  }
  if (args.contract) {
    assert(!args.manifestPath && !args.assemble, "--contract cannot be combined with manifest or assemble mode");
    assertProductionImageContract();
    console.log("Production image inventory contract passed.");
    return;
  }
  assert(!(args.manifestPath && args.assemble), "--manifest and --assemble are mutually exclusive");
  if (args.assemble) {
    assert(args.expectedCommit, "--expected-commit is required with --assemble");
    assert(args.recordPaths.length > 0, "at least one --record is required with --assemble");
    const records = args.recordPaths.map((path) => JSON.parse(readFileSync(resolve(path), "utf8")));
    const manifest = assembleProductionImageManifest({
      records,
      expectedCommit: args.expectedCommit,
      releaseChainId: args.releaseChainId,
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  assert(args.expectedCommit, "--expected-commit is required with --manifest");
  assert(args.bundlePath, "--bundle is required with --manifest");
  assert(args.certificateIdentity, "--certificate-identity is required with --manifest");
  assert(args.certificateOidcIssuer, "--certificate-oidc-issuer is required with --manifest");
  const manifest = loadVerifiedProductionImageManifest({
    manifestPath: args.manifestPath,
    bundlePath: args.bundlePath,
    certificateIdentity: args.certificateIdentity,
    certificateOidcIssuer: args.certificateOidcIssuer,
  });
  const deploymentEnvironment = args.envFile
    ? readDeploymentEnv(readFileSync(resolve(args.envFile), "utf8"))
    : undefined;
  verifyProductionImageManifest({
    manifest,
    expectedCommit: args.expectedCommit,
    expectedReleaseChainId: args.releaseChainId,
    deploymentEnvironment,
    onlyImageId: args.onlyImageId,
  });
  if (args.signatureBundleRoot) {
    verifyProductionImageSignatureBundles({
      manifest,
      signatureBundleRoot: args.signatureBundleRoot,
      certificateIdentity: args.certificateIdentity,
      certificateOidcIssuer: args.certificateOidcIssuer,
      expectedCommit: args.expectedCommit,
      expectedReleaseChainId: args.releaseChainId,
      onlyImageId: args.onlyImageId,
    });
  }
  if (args.inspectLocalImages) {
    verifyLocalProductionImageBindings({
      manifest,
      expectedCommit: args.expectedCommit,
      onlyImageId: args.onlyImageId,
      excludeImageIds: args.excludeImageIds,
    });
  }
  console.log("Production image evidence manifest passed.");
}

function requiredPath(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} path is required`);
  return resolve(value);
}

function assertHttpsIdentity(value, label) {
  assert(
    typeof value === "string" && /^https:\/\/[^\s]+$/u.test(value),
    `${label} must be an exact HTTPS identity`,
  );
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
  assert(JSON.stringify(sortValue(actual)) === JSON.stringify(sortValue(expected)), message);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
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
