import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "@redocly/ajv/dist/2020.js";
import sharp from "sharp";
import YAML from "yaml";

import {
  canonicalJson,
  canonicalJsonFile,
  sealEvidenceLedger,
  sha256Bytes,
} from "./evidence-ledger.mjs";
import {
  validateHardCutManifest,
  verifyHardCutReceipt,
} from "./workbench-hard-cut-manifest.mjs";
import {
  productionApprovalSignaturePayload,
  verifyHardCutAcceptancePackage,
} from "./verify-workbench-hard-cut-acceptance.mjs";
import { loadProductionTrustPolicy } from "./workbench-production-trust-policy.mjs";
import { loadProductionImageInventory } from "./production-image-inventory.mjs";
import {
  createProductionDeploymentConfig,
  deploymentConfigBinding,
} from "./production-deployment-config.mjs";
import { productionDeploymentConfigFixtureEnvironment } from "./fixtures/production-deployment-config-fixture.mjs";
import { createProductionBuildConfiguration } from "./write-production-build-configuration.mjs";
import { PRODUCTION_G11_MANIFEST_EVIDENCE_KIND } from "./production-acceptance/g11-real-stack-manifest.mjs";

const scopeId = "legacy-production-database";
const validationNow = new Date("2026-07-19T08:00:00Z");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlCatalogPath = path.join(
  repoRoot,
  "docs/evidence/governance/production-acceptance-control-catalog.v1.json",
);

test("the checked-in pre-cutover manifest is honest but cannot pass enforce", async () => {
  const report = await validateHardCutManifest({ now: validationNow });
  assert.equal(report.status, "pending");
  assert.deepEqual(report.findings, []);

  const enforced = await validateHardCutManifest({ enforce: true, now: validationNow });
  assert.equal(enforced.status, "invalid");
  assert(enforced.findings.includes("enforced hard cut requires candidateBinding"));
  assert(enforced.findings.includes("enforced hard cut requires expectedCandidateId"));
  assert(enforced.findings.includes("enforced hard cut requires expectedSourceCommit"));
  assert(enforced.findings.includes("enforced hard cut requires expectedSignedTag"));
  assert(enforced.findings.includes("enforced hard cut requires trustPolicyPath"));
  assert(enforced.findings.includes("enforced hard cut requires expectedTrustPolicySha256"));
  assert(enforced.findings.includes("enforced hard cut requires cutoverReceipts.productionAcceptance"));
});

test("production acceptance derives identity from signed CI evidence and external trust policy", async () => {
  const ci = await readFile(path.join(repoRoot, ".github/workflows/workbench-ci.yml"), "utf8");
  assert.doesNotMatch(ci, /hard-cut-release-gate/u);
  assert.doesNotMatch(ci, /hard-cut:manifest\s+--\s+--enforce/u);
  const workflow = YAML.parse(await readFile(
    path.join(repoRoot, ".github/workflows/workbench-production-acceptance.yml"),
    "utf8",
  ));
  const dispatch = workflow.on?.workflow_dispatch ?? workflow[true]?.workflow_dispatch;
  assert(dispatch, "production acceptance must be workflow_dispatch only");
  assert.deepEqual(Object.keys(dispatch.inputs).sort(), [
    "evidence_package_sha256",
    "evidence_package_url",
    "release_chain_run_id",
  ]);
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.jobs["production-acceptance"].environment.name, "production-acceptance");
  const steps = workflow.jobs["production-acceptance"].steps;
  const resolveRun = steps.find((step) => step.name === "Resolve successful production CI run").run;
  for (const marker of [
    "gh api",
    ".github/workflows/workbench-ci.yml",
    "head_branch: 'production'",
    "conclusion: 'success'",
  ]) assert.match(resolveRun, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(steps.find((step) => step.name === "Download CI-owned verified release chain").run, /gh run download/u);
  const imageDownload = steps.find((step) => step.name === "Download CI-owned production image manifest").run;
  assert.match(imageDownload, /gh run download "\$RELEASE_CHAIN_RUN_ID"/u);
  assert.match(imageDownload, /--name "production-image-manifest-\$RELEASE_CHAIN_RUN_ATTEMPT"/u);
  const deploymentConfigDownload = steps.find((step) => step.name === "Download CI-owned deployment configuration").run;
  assert.match(deploymentConfigDownload, /production-deployment-config-\$RELEASE_CHAIN_RUN_ATTEMPT/u);
  const checkout = workflow.jobs["production-acceptance"].steps.find((step) => step.name === "Checkout verifier source");
  assert.equal(checkout.with.ref, "${{ vars.WORKBENCH_ACCEPTANCE_VERIFIER_COMMIT }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const chainVerification = steps.find((step) => step.name === "Verify and recompute the signed G0-G2 release chain").run;
  assert.match(chainVerification, /cosign verify-blob/u);
  assert.match(chainVerification, /verify-release-chain\.mjs/u);
  const imageVerification = steps.find((step) => step.name === "Verify CI-owned G4 images and bind the control catalog").run;
  assert.match(imageVerification, /production-image-inventory\.mjs/u);
  assert.match(imageVerification, /--expected-commit "\$SOURCE_COMMIT"/u);
  assert.match(imageVerification, /--release-chain-id "\$RELEASE_CHAIN_ID"/u);
  assert.match(imageVerification, /--signature-bundle-root "\$IMAGE_ROOT"/u);
  const packageVerification = steps.find((step) => step.name === "Verify external G5-G11 evidence and independent approvals").run;
  assert.match(packageVerification, /--trust-policy "\$TRUST_POLICY_PATH"/u);
  assert.match(packageVerification, /--trust-policy-sha256 "\$TRUST_POLICY_SHA256"/u);
  assert.match(packageVerification, /--production-image-manifest "\$PRODUCTION_IMAGE_MANIFEST_PATH"/u);
  assert.match(packageVerification, /--deployment-config-manifest "\$DEPLOYMENT_CONFIG_MANIFEST_PATH"/u);
  assert.match(packageVerification, /--control-catalog "\$CONTROL_CATALOG_PATH"/u);
  const run = steps
    .find((step) => step.name.startsWith("Enforce candidate-bound hard cut")).run;
  for (const marker of [
    "--root \"$EVIDENCE_ROOT\"",
    "--manifest manifest.json",
    "--enforce",
    '--expected-candidate-id "$CANDIDATE_ID"',
    '--expected-source-commit "$SOURCE_COMMIT"',
    '--expected-signed-tag "$SIGNED_TAG"',
    '--expected-release-chain-id "$RELEASE_CHAIN_ID"',
    '--production-image-manifest "$PRODUCTION_IMAGE_MANIFEST_PATH"',
    '--production-image-manifest-sha256 "$PRODUCTION_IMAGE_MANIFEST_SHA256"',
    '--deployment-config-manifest "$DEPLOYMENT_CONFIG_MANIFEST_PATH"',
    '--deployment-config-manifest-sha256 "$DEPLOYMENT_CONFIG_MANIFEST_SHA256"',
    '--control-catalog "$CONTROL_CATALOG_PATH"',
    '--control-catalog-sha256 "$CONTROL_CATALOG_SHA256"',
    '--trust-policy "$TRUST_POLICY_PATH"',
    '--trust-policy-sha256 "$TRUST_POLICY_SHA256"',
  ]) {
    assert.match(run, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
});

test("verifies an external package with all G5-G11 PASS and four independent approvals", async (t) => {
  const fixture = await createAcceptancePackage();
  t.after(fixture.cleanup);
  const report = await verifyHardCutAcceptancePackage(fixture.options);
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.gates, ["G5", "G6", "G7", "G8", "G9", "G10", "G11"]);
  assert.deepEqual(report.approvals, ["Security", "Data", "Operations", "Release"]);
  assert.match(report.trustPolicySha256, /^[a-f0-9]{64}$/u);
  const files = await readdir(report.evidenceRoot);
  assert(files.includes("manifest.json"));
});

test("v3 JSON schemas accept trusted fixtures and reject legacy envelopes", async (t) => {
  const acceptance = await createAcceptancePackage();
  const receipt = await createReceiptFixture();
  t.after(acceptance.cleanup);
  t.after(receipt.cleanup);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const cases = [
    ["docs/evidence/hard-cut-acceptance-package.schema.json", acceptance.document],
    ["docs/evidence/hard-cut-receipt.schema.json", receipt.receipt],
    ["docs/evidence/governance/production-trust-policy.schema.json", JSON.parse(await readFile(receipt.trustPolicyPath, "utf8"))],
  ];
  for (const [schemaPath, value] of cases) {
    const schema = JSON.parse(await readFile(path.join(repoRoot, schemaPath), "utf8"));
    const validate = ajv.compile(schema);
    assert.equal(validate(value), true, `${schemaPath}: ${JSON.stringify(validate.errors)}`);
    const legacy = structuredClone(value);
    legacy.schemaVersion = `${legacy.schemaVersion}.legacy`;
    assert.equal(validate(legacy), false, `${schemaPath} must reject another schemaVersion`);
  }
});

test("rejects cross-candidate, missing approval, future evidence, and self-reference", async (t) => {
  const fixture = await createAcceptancePackage();
  t.after(fixture.cleanup);

  const crossCandidate = structuredClone(fixture.document);
  crossCandidate.candidate.sourceCommit = "9".repeat(40);
  await writeFile(fixture.packagePath, `${JSON.stringify(crossCandidate)}\n`);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({ ...fixture.options, expectedPackageSha256: sha256Bytes(Buffer.from(`${JSON.stringify(crossCandidate)}\n`)) }),
    /externally expected candidate/u,
  );

  const missingApproval = structuredClone(fixture.document);
  missingApproval.approvals = missingApproval.approvals.filter((approval) => approval.role !== "Release");
  await writeFile(fixture.packagePath, `${JSON.stringify(missingApproval)}\n`);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({ ...fixture.options, expectedPackageSha256: sha256Bytes(Buffer.from(`${JSON.stringify(missingApproval)}\n`)) }),
    /missing Release approval/u,
  );

  const future = structuredClone(fixture.document);
  future.gates[0].observedAtUtc = "2026-07-19T09:00:00Z";
  await writeFile(fixture.packagePath, `${JSON.stringify(future)}\n`);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({ ...fixture.options, expectedPackageSha256: sha256Bytes(Buffer.from(`${JSON.stringify(future)}\n`)) }),
    /observedAtUtc must be no later/u,
  );

  const nonProduction = structuredClone(fixture.document);
  const nonProductionFile = nonProduction.files.find((file) => file.path === "gates/g5.json");
  const nonProductionLedger = JSON.parse(Buffer.from(nonProductionFile.contentBase64, "base64").toString("utf8"));
  nonProductionLedger.payload.entries[0].environment.kind = "staging";
  const nonProductionRaw = Buffer.from(canonicalJsonFile(nonProductionLedger), "utf8");
  nonProductionFile.contentBase64 = nonProductionRaw.toString("base64");
  nonProductionFile.sha256 = sha256Bytes(nonProductionRaw);
  nonProduction.gates[0].evidenceSha256 = nonProductionFile.sha256;
  await writeFile(fixture.packagePath, `${JSON.stringify(nonProduction)}\n`);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({ ...fixture.options, expectedPackageSha256: sha256Bytes(Buffer.from(`${JSON.stringify(nonProduction)}\n`)) }),
    /production environment/u,
  );

  const selfReference = structuredClone(fixture.document);
  selfReference.hardCutManifest.path = "package.json";
  await writeFile(fixture.packagePath, `${JSON.stringify(selfReference)}\n`);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({ ...fixture.options, expectedPackageSha256: sha256Bytes(Buffer.from(`${JSON.stringify(selfReference)}\n`)) }),
    /acceptance package itself/u,
  );
});

test("approval signatures bind the implementer and acceptance envelope", async (t) => {
  const fixture = await createAcceptancePackage();
  t.after(fixture.cleanup);
  for (const [field, value] of [
    ["implementerId", "replacement-implementer"],
    ["acceptedAtUtc", "2026-07-19T07:46:00Z"],
    ["createdAtUtc", "2026-07-19T08:01:00Z"],
  ]) {
    const mutated = structuredClone(fixture.document);
    mutated[field] = value;
    await assertPackageRejected(fixture, mutated, /signature verification failed/u);
  }
});

test("final verifier replays observedValue and rejects a hand-built PASS ledger", async (t) => {
  const fixture = await createAcceptancePackage({ forgeFailingObservation: true });
  t.after(fixture.cleanup);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage(fixture.options),
    /observation replay failed.*claims PASS.*threshold/u,
  );
});

test("fails closed on every v3 G4 image and control-catalog binding boundary", async (t) => {
  const fixture = await createAcceptancePackage();
  t.after(fixture.cleanup);

  const legacy = structuredClone(fixture.document);
  legacy.schemaVersion = "workbench.hard-cut-acceptance-package.v2";
  await assertPackageRejected(fixture, legacy, /schemaVersion must be workbench\.hard-cut-acceptance-package\.v3/u);

  const missingImage = structuredClone(fixture.document);
  missingImage.productionImages.images.pop();
  await assertPackageRejected(fixture, missingImage, /complete CI-owned G4 image inventory/u);

  const extraImage = structuredClone(fixture.document);
  extraImage.productionImages.images.push({
    name: "unexpected-image",
    digest: `sha256:${"9".repeat(64)}`,
  });
  await assertPackageRejected(fixture, extraImage, /complete CI-owned G4 image inventory/u);

  const manifestDrift = structuredClone(fixture.document);
  const manifestFile = manifestDrift.files.find((file) => file.path === "manifest.json");
  const manifest = JSON.parse(Buffer.from(manifestFile.contentBase64, "base64").toString("utf8"));
  manifest.candidateBinding.digests.images[0].digest = `sha256:${"9".repeat(64)}`;
  replacePackageFile(manifestDrift, "manifest.json", Buffer.from(`${JSON.stringify(manifest)}\n`));
  manifestDrift.hardCutManifest.sha256 = manifestDrift.files.find((file) => file.path === "manifest.json").sha256;
  await assertPackageRejected(fixture, manifestDrift, /hard-cut manifest candidateBinding\.digests\.images does not match/u);

  const ledgerDrift = structuredClone(fixture.document);
  const gate = ledgerDrift.gates.find((candidate) => candidate.gateId === "G5");
  const ledgerFile = ledgerDrift.files.find((file) => file.path === gate.evidencePath);
  const ledger = JSON.parse(Buffer.from(ledgerFile.contentBase64, "base64").toString("utf8"));
  ledger.payload.binding.digests.images[0].digest = `sha256:${"8".repeat(64)}`;
  for (const entry of ledger.payload.entries) entry.binding = structuredClone(ledger.payload.binding);
  const resealedLedger = Buffer.from(canonicalJsonFile(sealEvidenceLedger(ledger.payload)));
  replacePackageFile(ledgerDrift, gate.evidencePath, resealedLedger);
  gate.evidenceSha256 = ledgerDrift.files.find((file) => file.path === gate.evidencePath).sha256;
  await assertPackageRejected(
    fixture,
    ledgerDrift,
    /package\.gates\[0\]\.ledger\.binding\.digests\.images does not match/u,
  );

  const catalogDrift = structuredClone(fixture.document);
  const catalogFile = catalogDrift.files.find((file) => (
    file.path === "governance/production-acceptance-control-catalog.v1.json"
  ));
  const catalog = JSON.parse(Buffer.from(catalogFile.contentBase64, "base64").toString("utf8"));
  catalog.catalogId = "attacker-catalog";
  replacePackageFile(catalogDrift, catalogFile.path, Buffer.from(`${JSON.stringify(catalog)}\n`));
  catalogDrift.controlCatalog.sha256 = catalogDrift.files.find((file) => file.path === catalogFile.path).sha256;
  await assertPackageRejected(fixture, catalogDrift, /does not match the protected verifier catalog|bytes differ/u);

  await assert.rejects(
    () => verifyHardCutAcceptancePackage({
      ...fixture.options,
      expectedProductionImageManifestSha256: "0".repeat(64),
    }),
    /production image manifest SHA-256 mismatch/u,
  );
});

test("rejects forged, untrusted, and wrong-environment production approvals", async (t) => {
  const fixture = await createAcceptancePackage();
  t.after(fixture.cleanup);

  const forged = structuredClone(fixture.document);
  const signature = forged.approvals[0].signature.value;
  forged.approvals[0].signature.value = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const forgedRaw = Buffer.from(`${JSON.stringify(forged)}\n`);
  await writeFile(fixture.packagePath, forgedRaw);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({ ...fixture.options, expectedPackageSha256: sha256Bytes(forgedRaw) }),
    /signature verification failed/u,
  );

  const untrusted = structuredClone(fixture.document);
  untrusted.approvals[0].signature.keyId = "untrusted-security-key";
  const untrustedRaw = Buffer.from(`${JSON.stringify(untrusted)}\n`);
  await writeFile(fixture.packagePath, untrustedRaw);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({ ...fixture.options, expectedPackageSha256: sha256Bytes(untrustedRaw) }),
    /not uniquely authorized by the external trust policy/u,
  );

  const originalRaw = Buffer.from(`${JSON.stringify(fixture.document)}\n`);
  await writeFile(fixture.packagePath, originalRaw);
  const wrongEnvironmentTrust = JSON.parse(await readFile(fixture.options.trustPolicyPath, "utf8"));
  wrongEnvironmentTrust.environmentId = "another-production-environment";
  const wrongEnvironmentRaw = Buffer.from(`${JSON.stringify(wrongEnvironmentTrust)}\n`);
  await writeFile(fixture.options.trustPolicyPath, wrongEnvironmentRaw);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({
      ...fixture.options,
      expectedPackageSha256: sha256Bytes(originalRaw),
      expectedTrustPolicySha256: sha256Bytes(wrongEnvironmentRaw),
    }),
    /does not match the hard-cut candidate environment/u,
  );
});

async function createAcceptancePackage({ forgeFailingObservation = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-hard-cut-acceptance-"));
  const packagePath = path.join(root, "package.json");
  const evidenceRoot = path.join(root, "evidence");
  const trustPolicyPath = path.join(root, "production-trust-policy.json");
  const productionImageManifestPath = path.join(root, "production-image-manifest.json");
  const candidate = {
    candidateId: `sha256:${"a".repeat(64)}`,
    sourceCommit: "1".repeat(40),
    signedTag: "workbench-v1.0.0-fixture",
    chainId: `sha256:${"b".repeat(64)}`,
  };
  const productionImageManifest = productionImageManifestFixture(candidate);
  const productionImageManifestRaw = Buffer.from(`${JSON.stringify(productionImageManifest)}\n`);
  const productionImageManifestSha256 = sha256Bytes(productionImageManifestRaw);
  await writeFile(productionImageManifestPath, productionImageManifestRaw);
  const images = productionImageManifest.images.map((image) => ({
    name: image.id,
    digest: image.digest,
  }));
  const deploymentConfigDocument = createProductionDeploymentConfig({
    candidateId: candidate.candidateId,
    sourceCommit: candidate.sourceCommit,
    signedTag: candidate.signedTag,
    releaseChainId: candidate.chainId,
    imageManifest: productionImageManifest,
    imageManifestSha256: productionImageManifestSha256,
    githubRunId: "81234",
    githubRunAttempt: 1,
    infrastructureEnvironment: productionDeploymentConfigFixtureEnvironment(),
  });
  const deploymentConfigManifestPath = path.join(root, "production-deployment-config.json");
  const deploymentConfigBundlePath = path.join(root, "production-deployment-config.bundle.json");
  const deploymentConfigRaw = Buffer.from(canonicalJsonFile(deploymentConfigDocument), "utf8");
  const deploymentConfigManifestSha256 = sha256Bytes(deploymentConfigRaw);
  await writeFile(deploymentConfigManifestPath, deploymentConfigRaw);
  await writeFile(deploymentConfigBundlePath, "{}\n");
  const deploymentConfig = deploymentConfigBinding(deploymentConfigDocument, deploymentConfigManifestSha256);
  const controlCatalogRaw = await readFile(controlCatalogPath);
  const controlCatalogSha256 = sha256Bytes(controlCatalogRaw);
  const controlCatalog = JSON.parse(controlCatalogRaw.toString("utf8"));
  const files = [];
  const addFile = (filePath, content) => {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const sha256 = sha256Bytes(raw);
    files.push({ path: filePath, sha256, contentBase64: raw.toString("base64") });
    return sha256;
  };
  addFile("governance/production-acceptance-control-catalog.v1.json", controlCatalogRaw);
  const manifest = {
    version: 3,
    product: "产品工作台",
    technicalIdentifier: "workbench",
    status: "completed",
    candidateBinding: {
      candidateId: candidate.candidateId,
      deployId: "deploy-fixture",
      environmentId: "production-fixture",
      commitSha: candidate.sourceCommit,
      tag: candidate.signedTag,
      releaseChainId: candidate.chainId,
      digests: {
        images,
        configSha256: deploymentConfig.configSha256,
        migrationSha256: deploymentConfig.migrationSha256,
        deploymentConfigManifestSha256,
        imageManifestSha256: productionImageManifestSha256,
        controlCatalogSha256,
      },
    },
  };
  const manifestSha256 = addFile("manifest.json", `${JSON.stringify(manifest)}\n`);
  const environment = {
    environmentId: manifest.candidateBinding.environmentId,
    kind: "production",
    description: "Fixture production environment.",
    region: "fixture",
  };
  const planPayload = {
    planId: "production-plan-hard-cut-fixture",
    createdAtUtc: "2026-07-19T00:00:00Z",
    plannerId: "planner-fixture",
    catalog: {
      schemaVersion: controlCatalog.schemaVersion,
      catalogId: controlCatalog.catalogId,
      sha256: controlCatalogSha256,
    },
    deploymentConfig,
    binding: manifest.candidateBinding,
    environment,
    gates: controlCatalog.gates.map((gate) => ({
      gateId: gate.gateId,
      controls: gate.controls.map((control) => control.controlId),
    })),
  };
  const plan = {
    schemaVersion: "workbench.production-acceptance-plan.v1",
    payload: planPayload,
    payloadSha256: sha256Bytes(Buffer.from(canonicalJson({
      schemaVersion: "workbench.production-acceptance-plan.v1",
      payload: planPayload,
    }), "utf8")),
  };
  const planRaw = Buffer.from(canonicalJsonFile(plan), "utf8");
  const planSha256 = addFile("governance/production-acceptance-plan.json", planRaw);
  const g11Evidence = await createHardCutG11Evidence({
    addFile,
    binding: manifest.candidateBinding,
    environment,
    plan,
  });
  const gates = controlCatalog.gates.map(({ gateId, controls }, index) => {
    const evidencePath = `gates/${gateId.toLowerCase()}.json`;
    const entries = controls.map((control) => {
      const rawEvidencePath = `gates/results/${control.controlId.toLowerCase().replaceAll(".", "-")}.json`;
      const observedValue = forgeFailingObservation && gateId === "G5" && control === controls[0]
        ? failingControlValue(control.threshold)
        : passingControlValue(control.threshold);
      const rawEvidence = Buffer.from(canonicalJsonFile({ controlId: control.controlId, observedValue }), "utf8");
      const rawEvidenceSha256 = addFile(rawEvidencePath, rawEvidence);
      const artifactSha256 = sha256Bytes(Buffer.from(`${control.tool.name}@${control.tool.version}`, "utf8"));
      const provenanceSha256 = sha256Bytes(Buffer.from(`provenance:${control.tool.name}@${control.tool.version}`, "utf8"));
      const toolAttestation = {
        name: control.tool.name,
        version: control.tool.version,
        artifact: { uri: `urn:sha256:${artifactSha256}`, sha256: artifactSha256 },
        provenance: { uri: `urn:sha256:${provenanceSha256}`, sha256: provenanceSha256 },
        provenanceSubjectSha256: artifactSha256,
      };
      const observationPath = `observations/${control.controlId}.json`;
      const executedAtUtc = `2026-07-19T0${index + 1}:00:00Z`;
      const observationEvidence = gateId === "G11" && control.controlId !== "G11.FIGMA.SCOPE"
        ? structuredClone(g11Evidence.observationEvidence)
        : [{ kind: "probe", uri: `file:./${rawEvidencePath}`, sha256: rawEvidenceSha256 }];
      const observation = {
        schemaVersion: "workbench.production-control-observation.v1",
        observationId: `observation-${control.controlId.toLowerCase()}`,
        controlId: control.controlId,
        gateId,
        catalog: { schemaVersion: controlCatalog.schemaVersion, sha256: controlCatalogSha256 },
        binding: manifest.candidateBinding,
        environment,
        executedAtUtc,
        executor: { id: `auditor-${gateId.toLowerCase()}`, kind: "auditor" },
        toolVersions: [control.tool],
        toolAttestation,
        evidenceLevel: control.evidenceLevel,
        result: {
          executionStatus: "PASS",
          observedValue,
          summary: `${control.controlId} passed its protected threshold.`,
        },
        evidence: observationEvidence,
        retryRecords: [],
      };
      const observationRaw = Buffer.from(canonicalJsonFile(observation), "utf8");
      const observationSha256 = addFile(observationPath, observationRaw);
      return {
        entryId: control.controlId,
        gateId,
        controlObjective: control.controlObjective,
        environment,
        prerequisites: control.prerequisites,
        procedure: control.procedure,
        expectedObservation: control.expectedObservation,
        threshold: control.threshold,
        findingStatus: "CONFIRMED",
        executionStatus: "PASS",
        evidenceLevel: control.evidenceLevel,
        executedAtUtc,
        executor: { id: `auditor-${gateId.toLowerCase()}`, kind: "auditor" },
        binding: manifest.candidateBinding,
        toolVersions: [control.tool],
        evidence: [
          { uri: `file:./${observationPath}`, sha256: observationSha256 },
          toolAttestation.artifact,
          toolAttestation.provenance,
          ...observationEvidence.map(({ uri, sha256 }) => ({ uri, sha256 })),
        ],
        retryRecords: [],
        relatedFindingsOrDecisions: control.relatedFindingsOrDecisions,
      };
    });
    const ledger = sealEvidenceLedger({
      ledgerId: `ledger-${gateId.toLowerCase()}`,
      createdAtUtc: `2026-07-19T0${index + 1}:15:00Z`,
      binding: manifest.candidateBinding,
      previousLedger: null,
      entries,
    });
    const evidenceSha256 = addFile(evidencePath, canonicalJsonFile(ledger));
    return {
      gateId,
      status: "PASS",
      observedAtUtc: `2026-07-19T0${index + 1}:00:00Z`,
      candidate,
      evidencePath,
      evidenceSha256,
    };
  });
  const collectionPayload = {
    collectionId: "production-collection-hard-cut-fixture",
    collectedAtUtc: "2026-07-19T07:15:00Z",
    status: "PASS",
    plan: { path: "governance/production-acceptance-plan.json", sha256: planSha256 },
    catalog: {
      schemaVersion: controlCatalog.schemaVersion,
      path: "governance/production-acceptance-control-catalog.v1.json",
      sha256: controlCatalogSha256,
    },
    binding: manifest.candidateBinding,
    gates: gates.map((gate) => ({
      gateId: gate.gateId,
      status: gate.status,
      controlCount: controlCatalog.gates.find((candidate) => candidate.gateId === gate.gateId).controls.length,
      observedAtUtc: gate.observedAtUtc,
      ledger: { path: gate.evidencePath, sha256: gate.evidenceSha256 },
    })),
  };
  addFile("collection.json", canonicalJsonFile({
    schemaVersion: "workbench.production-observation-collection.v1",
    payload: collectionPayload,
    payloadSha256: sha256Bytes(Buffer.from(canonicalJson({
      schemaVersion: "workbench.production-observation-collection.v1",
      payload: collectionPayload,
    }), "utf8")),
  }));
  const approvalSigners = new Map();
  const approvalAuthorities = [];
  const trustedKeys = ["Security", "Data", "Operations", "Release"].map((role) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const approverId = `approver-${role.toLowerCase()}`;
    const publicKeyBytes = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
    const publicKeySha256 = sha256Bytes(publicKeyBytes);
    const keyId = `sha256:${publicKeySha256}`;
    approvalSigners.set(role, { privateKey, keyId, approverId });
    approvalAuthorities.push({ role, approverId, keyId });
    return {
      keyId,
      algorithm: "Ed25519",
      publicKeySpkiBase64: publicKeyBytes.toString("base64"),
      publicKeySha256,
      validFromUtc: "2026-07-01T00:00:00Z",
      validUntilUtc: "2026-08-01T00:00:00Z",
      revokedAtUtc: null,
    };
  });
  const trustPolicyRaw = Buffer.from(`${JSON.stringify({
    schemaVersion: "workbench.production-trust-policy.v1",
    environmentId: manifest.candidateBinding.environmentId,
    keys: trustedKeys,
    approvalAuthorities,
    receiptAuthorities: [{
      scopeId: "legacy-production-database",
      signerId: "hard-cut-automation",
      keyId: trustedKeys[0].keyId,
    }],
  })}\n`);
  await writeFile(trustPolicyPath, trustPolicyRaw);
  const hardCutManifest = { path: "manifest.json", sha256: manifestSha256 };
  const approvals = ["Security", "Data", "Operations", "Release"].map((role, index) => {
    const evidencePath = `approvals/${role.toLowerCase()}.json`;
    const evidenceSha256 = addFile(evidencePath, `${JSON.stringify({ role, decision: "APPROVE" })}\n`);
    const signer = approvalSigners.get(role);
    const approval = {
      role,
      decision: "APPROVE",
      approverId: signer.approverId,
      signedAtUtc: `2026-07-19T07:3${index + 5}:00Z`,
      evidencePath,
      evidenceSha256,
      signature: {
        algorithm: "Ed25519",
        keyId: signer.keyId,
        value: "pending",
      },
    };
    approval.signature.value = sign(
      null,
      Buffer.from(canonicalJson(productionApprovalSignaturePayload({
        approval,
        implementerId: "implementer-fixture",
        createdAtUtc: "2026-07-19T08:00:00Z",
        acceptedAtUtc: "2026-07-19T07:45:00Z",
        candidate,
        productionImages: {
          manifestSha256: productionImageManifestSha256,
          images,
        },
        deploymentConfig,
        controlCatalog: {
          schemaVersion: controlCatalog.schemaVersion,
          sha256: controlCatalogSha256,
        },
        hardCutManifest,
        gates,
      })), "utf8"),
      signer.privateKey,
    ).toString("base64url");
    return approval;
  });
  const document = {
    schemaVersion: "workbench.hard-cut-acceptance-package.v3",
    product: "产品工作台",
    technicalIdentifier: "workbench",
    implementerId: "implementer-fixture",
    candidate,
    createdAtUtc: "2026-07-19T08:00:00Z",
    acceptedAtUtc: "2026-07-19T07:45:00Z",
    productionImages: {
      manifestSha256: productionImageManifestSha256,
      images,
    },
    deploymentConfig,
    controlCatalog: {
      schemaVersion: controlCatalog.schemaVersion,
      sha256: controlCatalogSha256,
    },
    hardCutManifest,
    files,
    gates,
    approvals,
  };
  const packageRaw = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  await writeFile(packagePath, packageRaw);
  return {
    document,
    packagePath,
    options: {
      packagePath,
      expectedPackageSha256: sha256Bytes(packageRaw),
      evidenceRoot,
      trustPolicyPath,
      expectedTrustPolicySha256: sha256Bytes(trustPolicyRaw),
      expectedCandidate: {
        candidateId: candidate.candidateId,
        sourceCommit: candidate.sourceCommit,
        signedTag: candidate.signedTag,
      },
      expectedChainId: candidate.chainId,
      productionImageManifestPath,
      expectedProductionImageManifestSha256: productionImageManifestSha256,
      deploymentConfigManifestPath,
      deploymentConfigBundlePath,
      deploymentConfigCertificateIdentity: "https://github.com/example/workbench/.github/workflows/workbench-ci.yml@refs/heads/production",
      deploymentConfigCertificateOidcIssuer: "https://token.actions.githubusercontent.com",
      expectedDeploymentConfigGithubRunId: "81234",
      expectedDeploymentConfigGithubRunAttempt: 1,
      verifyDeploymentConfigBlob: () => true,
      expectedDeploymentConfigManifestSha256: deploymentConfigManifestSha256,
      controlCatalogPath,
      expectedControlCatalogSha256: controlCatalogSha256,
      now: validationNow,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function assertPackageRejected(fixture, document, expected) {
  const raw = Buffer.from(`${JSON.stringify(document)}\n`);
  await writeFile(fixture.packagePath, raw);
  await assert.rejects(
    () => verifyHardCutAcceptancePackage({
      ...fixture.options,
      expectedPackageSha256: sha256Bytes(raw),
    }),
    expected,
  );
}

async function createHardCutG11Evidence({ addFile, binding, environment, plan }) {
  const browsers = ["chromium", "firefox", "webkit"];
  const states = ["prd-active", "prd-pending", "prototype-after-prd"];
  const viewports = [
    { id: "375x812", width: 375, height: 812 },
    { id: "768x1024", width: 768, height: 1024 },
    { id: "1440x900", width: 1440, height: 900 },
  ];
  const motions = ["normal", "reduced"];
  const screenshotBuffers = new Map();
  const marker = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#f4f4f5" },
  }).png().toBuffer();
  for (const viewport of viewports) {
    screenshotBuffers.set(viewport.id, await sharp({
      create: { width: viewport.width, height: viewport.height, channels: 3, background: "#111214" },
    }).composite([{ input: marker, left: 8, top: 8 }]).png().toBuffer());
  }

  const visualMatrix = [];
  for (const browser of browsers) {
    for (const state of states) {
      for (const viewport of viewports) {
        for (const motion of motions) {
          const fileName = `${browser}-${state}-${viewport.id}-${motion}.png`;
          const bytes = screenshotBuffers.get(viewport.id);
          const screenshotPath = `raw/g11/screenshots/${fileName}`;
          const screenshotSha256 = addFile(screenshotPath, bytes);
          const semanticKind = state === "prototype-after-prd" ? "prototype" : "prd";
          visualMatrix.push({
            browser,
            viewport: viewport.id,
            motion,
            state,
            status: "PASS",
            runState: {
              requestedArtifactKinds: [semanticKind],
              generationStage: semanticKind === "prototype" ? "generating-prototype" : "drafting-prd",
              terminal: false,
            },
            motionEvidence: {
              semanticKind,
              animationName: semanticKind === "prototype" ? "prototype-ripple" : "prd-aurora",
              animationDurationMs: motion === "reduced" ? 1 : 1_200,
              frameChanged: motion === "normal",
              reducedMotionMedia: motion === "reduced",
            },
            layout: {
              withinViewport: true,
              noOverlap: true,
              promptContextVisible: true,
              activityContextVisible: true,
              pendingCompositionVisible: state === "prd-pending",
              accessibleNamesPassed: true,
            },
            screenshot: {
              kind: "browser-screenshot",
              uri: `file:./${screenshotPath}`,
              sha256: screenshotSha256,
            },
          });
        }
      }
    }
  }

  const flows = [];
  for (const [flowId, checks] of Object.entries(hardCutPassingG11FlowChecks())) {
    const flowPath = `raw/g11/flows/${flowId}.json`;
    const flowRaw = Buffer.from(canonicalJsonFile({
      schemaVersion: "workbench.production-g11-flow-evidence.v1",
      flowId,
      binding,
      result: "PASS",
    }), "utf8");
    const flowSha256 = addFile(flowPath, flowRaw);
    flows.push({
      flowId,
      status: "PASS",
      checks,
      evidence: [{
        kind: "browser-flow-evidence",
        uri: `file:./${flowPath}`,
        sha256: flowSha256,
      }],
    });
  }

  const manifest = {
    schemaVersion: "workbench.production-g11-real-stack-manifest.v1",
    manifestId: `g11-real-stack-${plan.payload.planId.slice(-24)}`,
    plan: {
      planId: plan.payload.planId,
      payloadSha256: plan.payloadSha256,
    },
    binding,
    environment,
    deployment: {
      stackKind: "deployed-production",
      webOrigin: "https://workbench.example.com",
      previewOrigin: "https://preview.example.com",
      provider: {
        class: "approved-production-provider",
        id: "provider-production",
        version: "2026.07.19",
      },
      sessionBoundary: "better-auth",
      apiBoundary: "workbench-api",
      sseBoundary: "workbench-sse",
      queueBoundary: "pg-boss",
      databaseBoundary: "postgresql",
      artifactBoundary: "immutable-artifact-version",
    },
    harness: {
      name: "playwright",
      version: "1.58.2",
      sourceCommit: binding.commitSha,
      routeFulfillUsed: false,
      syntheticSessionUsed: false,
      syntheticApiUsed: false,
      syntheticSseUsed: false,
    },
    startedAtUtc: "2026-07-19T06:15:00Z",
    finishedAtUtc: "2026-07-19T06:55:00Z",
    browsers: browsers.map((name, index) => ({ name, version: `140.0.${index + 1}` })),
    visualMatrix,
    flows,
    unexpectedConsoleErrors: [],
    unexpectedNetworkFailures: [],
  };
  const manifestRaw = Buffer.from(canonicalJsonFile(manifest), "utf8");
  const manifestSha256 = addFile("raw/g11/manifest.json", manifestRaw);
  const manifestReference = {
    uri: "file:./raw/g11/manifest.json",
    sha256: manifestSha256,
  };
  const evidence = [
    ...visualMatrix.map(({ screenshot }) => structuredClone(screenshot)),
    ...flows.flatMap((flow) => structuredClone(flow.evidence)),
  ].sort(compareEvidenceReferences);
  const observationEvidence = [
    { kind: PRODUCTION_G11_MANIFEST_EVIDENCE_KIND, ...manifestReference },
    ...evidence,
  ].sort(compareEvidenceReferences);
  return { manifest, manifestReference, evidence, observationEvidence };
}

function hardCutPassingG11FlowChecks() {
  return {
    "account-project": {
      accountCreated: true,
      loginCompleted: true,
      invitationAccepted: true,
      workspaceOpened: true,
      projectOpened: true,
      membershipRolesEnforced: true,
      revokedAccessDenied: true,
      expiredInvitationDenied: true,
      unauthorizedPathsClosed: true,
    },
    prd: {
      requestAccepted: true,
      loadingCompositionRendered: true,
      activePanelContextRendered: true,
      stageSequenceContinuous: true,
      readyArtifactPersisted: true,
      checksumVerified: true,
    },
    "mixed-rejection": {
      problemStatus: 422,
      queuePublishCount: 0,
      runCount: 0,
      runtimeAttemptCount: 0,
      artifactVersionCount: 0,
      providerInvocationCount: 0,
      sseEventCount: 0,
    },
    "prototype-after-prd": {
      startedAfterPrd: true,
      nullGapPrdMotionAbsent: true,
      thinkingGapPrdMotionAbsent: true,
      prototypeMotionRendered: true,
      readyArtifactPersisted: true,
    },
    "refresh-reconnect": {
      reconnectCursorAdvanced: true,
      sequenceContinuous: true,
      stateRestored: true,
      artifactPersisted: true,
    },
    "preview-import-export": {
      fileImportCompleted: true,
      knowledgeImportCompleted: true,
      exportCompleted: true,
      previewLoaded: true,
      explicitPublicationConfirmation: true,
      failureRecoveryPassed: true,
      checksumVerified: true,
    },
    "run-canvas-sse-artifact": {
      runCompleted: true,
      approvalPassed: true,
      failurePassed: true,
      cancelPassed: true,
      retryPassed: true,
      canvasGatewayUsed: true,
      prototypePatchStableNodeIds: true,
      sseDurable: true,
      sequenceContinuous: true,
      authorizationPassed: true,
      idempotencyPreserved: true,
      artifactPersisted: true,
      checksumVerified: true,
      revisionAdvanced: true,
    },
    "accessibility-preview-security": {
      keyboardPassed: true,
      focusPassed: true,
      accessibleNamesPassed: true,
      contrastPassed: true,
      reducedMotionPassed: true,
      previewIndependentOrigin: true,
      previewCredentialless: true,
      previewAllowSameOriginAbsent: true,
      previewNoReferrer: true,
      previewCapabilityValidated: true,
      previewRpcPassed: true,
      previewTimeoutProtected: true,
      previewGenerationProtected: true,
    },
    "long-run-7686-plus": {
      minimumEventCount: 7_686,
      observedEventCount: 7_686,
      crossedBoundary: true,
      terminalStateCorrect: true,
      retryRecoveryPassed: true,
    },
    "knowledge-null-valid": {
      nullReleaseGrantAbsent: true,
      nullReleaseSecretAbsent: true,
      nullReleaseCatalogAbsent: true,
      validPinnedReleaseVisible: true,
      validPinnedReleaseInvocationPassed: true,
      concurrentScopeIsolated: true,
      secretsNotPersisted: true,
    },
    "provider-state-integrity": {
      textComplete: true,
      effectsComplete: true,
      draftComplete: true,
      artifactsComplete: true,
      duplicateTextCount: 0,
      lostTextCount: 0,
      duplicateEffectCount: 0,
      lostEffectCount: 0,
      duplicateDraftCount: 0,
      lostDraftCount: 0,
      duplicateArtifactCount: 0,
      lostArtifactCount: 0,
    },
  };
}

function compareEvidenceReferences(left, right) {
  return `${left.uri}\0${left.kind ?? ""}`.localeCompare(`${right.uri}\0${right.kind ?? ""}`, "en");
}

function passingControlValue(threshold) {
  if (threshold.kind === "boolean") return threshold.expected;
  if (["eq", "lte", "gte"].includes(threshold.operator)) return threshold.expected;
  if (threshold.operator === "lt") return threshold.expected - 1;
  if (threshold.operator === "gt") return threshold.expected + 1;
  throw new Error(`unsupported threshold operator ${threshold.operator}`);
}

function failingControlValue(threshold) {
  if (threshold.kind === "boolean") return !threshold.expected;
  if (threshold.operator === "eq") return threshold.expected + 1;
  if (threshold.operator === "lt") return threshold.expected;
  if (threshold.operator === "lte") return threshold.expected + 1;
  if (threshold.operator === "gt") return threshold.expected;
  if (threshold.operator === "gte") return threshold.expected - 1;
  throw new Error(`unsupported threshold operator ${threshold.operator}`);
}

function replacePackageFile(document, filePath, raw) {
  const file = document.files.find((candidate) => candidate.path === filePath);
  file.sha256 = sha256Bytes(raw);
  file.contentBase64 = raw.toString("base64");
}

function productionImageManifestFixture(candidate) {
  const evidence = () => ({
    sha256: "f".repeat(64),
    uri: `urn:sha256:${"f".repeat(64)}`,
  });
  const images = loadProductionImageInventory().candidateImages.map((definition, index) => {
    const digest = `sha256:${String(index + 1).padStart(64, "0")}`;
    return {
      id: definition.id,
      imageRef: `registry.example.test/workbench/${definition.id}@${digest}`,
      digest,
      sourceCommit: candidate.sourceCommit,
      buildConfiguration: createProductionBuildConfiguration({
        id: definition.id,
        sourceCommit: candidate.sourceCommit,
        dockerfile: definition.dockerfile,
        target: definition.target,
        buildArgsSource: "",
      }),
      sbom: evidence(),
      sbomAttestation: evidence(),
      provenance: evidence(),
      signature: { ...evidence(), verification: evidence(), verified: true },
      vulnerabilityReport: { ...evidence(), status: "PASS", critical: 0, high: 0 },
    };
  });
  return {
    schemaVersion: 1,
    candidate: {
      sourceCommit: candidate.sourceCommit,
      releaseChainId: candidate.chainId,
    },
    images,
  };
}

test("rejects a hard-cut manifest bound to another verified release candidate", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "workbench-hard-cut-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(
    path.join(repoRoot, "docs/workbench-hard-cut-deletion-manifest.json"),
    "utf8",
  ));
  manifest.candidateBinding = {
    candidateId: `sha256:${"a".repeat(64)}`,
    deployId: "deploy-production-fixture",
    environmentId: "production-cn-hangzhou",
    commitSha: "b".repeat(40),
    tag: "workbench-v1.0.0-fixture",
    releaseChainId: `sha256:${"a".repeat(64)}`,
    digests: {
      images: [{ name: "web", digest: `sha256:${"c".repeat(64)}` }],
      configSha256: "d".repeat(64),
      migrationSha256: "e".repeat(64),
      deploymentConfigManifestSha256: "9".repeat(64),
      imageManifestSha256: "f".repeat(64),
      controlCatalogSha256: "0".repeat(64),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const expected = {
    expectedCandidateId: manifest.candidateBinding.candidateId,
    expectedSourceCommit: manifest.candidateBinding.commitSha,
    expectedSignedTag: manifest.candidateBinding.tag,
  };
  const matching = await validateHardCutManifest({
    manifestPath,
    root: repoRoot,
    now: validationNow,
    ...expected,
  });
  assert.deepEqual(matching.findings, []);

  for (const [field, value, finding] of [
    ["expectedCandidateId", `sha256:${"0".repeat(64)}`, "candidateBinding.candidateId"],
    ["expectedSourceCommit", "0".repeat(40), "candidateBinding.commitSha"],
    ["expectedSignedTag", "workbench-v1.0.0-other", "candidateBinding.tag"],
  ]) {
    const report = await validateHardCutManifest({
      manifestPath,
      root: repoRoot,
      now: validationNow,
      ...expected,
      [field]: value,
    });
    assert(
      report.findings.includes(`${finding} does not match the verified release candidate`),
      report.findings.join("\n"),
    );
  }
});

test("hard-cut enforcement binds its candidate to the exact G4 manifest and catalog", async (t) => {
  const fixture = await createAcceptancePackage();
  const root = await mkdtemp(path.join(tmpdir(), "workbench-hard-cut-g4-binding-"));
  t.after(fixture.cleanup);
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagedManifest = fixture.document.files.find((file) => file.path === "manifest.json");
  const manifest = JSON.parse(Buffer.from(packagedManifest.contentBase64, "base64").toString("utf8"));
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const options = {
    root,
    manifestPath,
    expectedCandidateId: fixture.document.candidate.candidateId,
    expectedSourceCommit: fixture.document.candidate.sourceCommit,
    expectedSignedTag: fixture.document.candidate.signedTag,
    expectedReleaseChainId: fixture.document.candidate.chainId,
    productionImageManifestPath: fixture.options.productionImageManifestPath,
    expectedProductionImageManifestSha256: fixture.options.expectedProductionImageManifestSha256,
    deploymentConfigManifestPath: fixture.options.deploymentConfigManifestPath,
    expectedDeploymentConfigManifestSha256: fixture.options.expectedDeploymentConfigManifestSha256,
    controlCatalogPath,
    expectedControlCatalogSha256: fixture.options.expectedControlCatalogSha256,
    now: validationNow,
  };
  const matching = await validateHardCutManifest(options);
  assert.doesNotMatch(matching.findings.join("\n"), /G4 image manifest|control catalog|release chain/u);

  const configDrift = structuredClone(manifest);
  configDrift.candidateBinding.digests.configSha256 = "0".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(configDrift)}\n`);
  const configDrifted = await validateHardCutManifest(options);
  assert.match(configDrifted.findings.join("\n"), /configSha256 does not match the signed deployment configuration/u);

  manifest.candidateBinding.digests.images[0].digest = `sha256:${"7".repeat(64)}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const drifted = await validateHardCutManifest(options);
  assert.match(drifted.findings.join("\n"), /complete verified G4 image inventory/u);
});

test("verifies a candidate-bound, sealed, signed hard-cut receipt", async (t) => {
  const fixture = await createReceiptFixture();
  t.after(fixture.cleanup);

  const report = await verifyFixture(fixture);
  assert.equal(report.ok, true, report.findings.join("\n"));
  assert.equal(report.verified.executorId, "hard-cut-automation");
});

test("rejects nonexistent evidence, digest mismatch, and signature tampering", async (t) => {
  const fixture = await createReceiptFixture();
  t.after(fixture.cleanup);

  const missing = structuredClone(fixture.receipt);
  missing.ledger.uri = "file:./missing-ledger.json";
  assert.match((await verifyFixture(fixture, missing)).findings.join("\n"), /realpath|ENOENT|no such file/iu);

  const wrongHash = structuredClone(fixture.receipt);
  wrongHash.ledger.sha256 = "0".repeat(64);
  assert.match((await verifyFixture(fixture, wrongHash)).findings.join("\n"), /ledger SHA-256 mismatch/u);

  const forged = structuredClone(fixture.receipt);
  forged.signature.value = `${forged.signature.value[0] === "A" ? "B" : "A"}${forged.signature.value.slice(1)}`;
  assert.match((await verifyFixture(fixture, forged)).findings.join("\n"), /signature verification failed/u);

  const attacker = generateKeyPairSync("ed25519");
  const attackerPublic = Buffer.from(attacker.publicKey.export({ type: "spki", format: "der" }));
  const attackerKeyId = `sha256:${sha256Bytes(attackerPublic)}`;
  const selfTrusted = structuredClone(fixture.receipt);
  selfTrusted.signature.keyId = attackerKeyId;
  selfTrusted.signature.value = sign(null, Buffer.from(canonicalJson({
    schemaVersion: selfTrusted.schemaVersion,
    scopeId: selfTrusted.scopeId,
    keyId: attackerKeyId,
    candidateBinding: fixture.candidateBinding,
    ledger: selfTrusted.ledger,
    signedAtUtc: selfTrusted.signedAtUtc,
    validUntilUtc: selfTrusted.validUntilUtc,
  }), "utf8"), attacker.privateKey).toString("base64url");
  assert.match((await verifyFixture(fixture, selfTrusted)).findings.join("\n"), /unauthorized key/u);

  const legacy = structuredClone(fixture.receipt);
  legacy.schemaVersion = "workbench.hard-cut-receipt.v1";
  assert.match((await verifyFixture(fixture, legacy)).findings.join("\n"), /must be workbench\.hard-cut-receipt\.v2/u);
});

test("rejects candidate, environment, validity, and residual-threshold mismatches", async (t) => {
  const fixture = await createReceiptFixture();
  t.after(fixture.cleanup);

  const wrongCommit = {
    ...fixture.candidateBinding,
    commitSha: "9".repeat(40),
  };
  assert.match(
    (await verifyFixture(fixture, fixture.receipt, { candidateBinding: wrongCommit })).findings.join("\n"),
    /candidate binding mismatch|signature verification failed/u,
  );

  const wrongEnvironment = {
    ...fixture.candidateBinding,
    environmentId: "production-other",
  };
  assert.match(
    (await verifyFixture(fixture, fixture.receipt, { candidateBinding: wrongEnvironment })).findings.join("\n"),
    /environmentId mismatch|candidate binding mismatch/u,
  );

  const expired = await createReceiptFixture({
    signedAtUtc: "2026-07-17T08:00:00Z",
    validUntilUtc: "2026-07-18T08:00:00Z",
  });
  t.after(expired.cleanup);
  assert.match((await verifyFixture(expired)).findings.join("\n"), /signature has expired/u);

  const residual = await createReceiptFixture({ residualCount: 1 });
  t.after(residual.cleanup);
  assert.match((await verifyFixture(residual)).findings.join("\n"), /zero residual count/u);
});

async function verifyFixture(fixture, receipt = fixture.receipt, overrides = {}) {
  return verifyHardCutReceipt({
    receipt,
    expectedScopeId: scopeId,
    expectedThreshold: "zero",
    candidateBinding: fixture.candidateBinding,
    root: fixture.root,
    trustPolicy: fixture.trustPolicy,
    now: validationNow,
    ...overrides,
  });
}

async function createReceiptFixture({
  residualCount = 0,
  signedAtUtc = "2026-07-19T07:30:00Z",
  validUntilUtc = "2026-07-20T08:00:00Z",
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-hard-cut-receipt-"));
  const rawDirectory = path.join(root, "raw");
  await mkdir(rawDirectory);
  const rawPath = path.join(rawDirectory, "cleanup.json");
  const raw = Buffer.from(`${JSON.stringify({ residualCount })}\n`, "utf8");
  await writeFile(rawPath, raw);

  const candidateBinding = {
    candidateId: "rc-20260719-fixture",
    deployId: "deploy-20260719-fixture",
    environmentId: "production-cn-hangzhou",
    commitSha: "1".repeat(40),
    tag: "workbench-v1.0.0-fixture",
    releaseChainId: `sha256:${"1".repeat(64)}`,
    digests: {
      images: [{ name: "web", digest: `sha256:${"4".repeat(64)}` }],
      configSha256: "2".repeat(64),
      migrationSha256: "3".repeat(64),
      deploymentConfigManifestSha256: "7".repeat(64),
      imageManifestSha256: "5".repeat(64),
      controlCatalogSha256: "6".repeat(64),
    },
  };
  const entry = {
    entryId: "entry-hard-cut-database",
    gateId: "G12",
    controlObjective: "Prove the legacy production database has no residual objects.",
    environment: {
      environmentId: candidateBinding.environmentId,
      kind: "production",
      description: "Isolated product workbench production environment.",
      region: "cn-hangzhou",
    },
    prerequisites: ["The frozen candidate is deployed and healthy."],
    procedure: { kind: "command", command: "server-hard-cut --scope legacy-production-database" },
    expectedObservation: "The residual object count is zero.",
    threshold: { kind: "number", operator: "eq", expected: residualCount, unit: "objects" },
    findingStatus: "CONFIRMED",
    executionStatus: "PASS",
    evidenceLevel: "E1",
    executedAtUtc: "2026-07-19T07:00:00Z",
    executor: { id: "hard-cut-automation", kind: "automation" },
    binding: candidateBinding,
    toolVersions: [{ name: "server-hard-cut", version: "1.0.0" }],
    evidence: [{ uri: "file:./raw/cleanup.json", sha256: sha256Bytes(raw) }],
    retryRecords: [],
    relatedFindingsOrDecisions: [{ kind: "decision", id: scopeId }],
  };
  const ledger = sealEvidenceLedger({
    ledgerId: "ledger-hard-cut-fixture",
    createdAtUtc: "2026-07-19T07:15:00Z",
    binding: candidateBinding,
    previousLedger: null,
    entries: [entry],
  });
  const ledgerRaw = Buffer.from(canonicalJsonFile(ledger), "utf8");
  const ledgerPath = path.join(root, "ledger.json");
  await writeFile(ledgerPath, ledgerRaw);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  const publicKeySha256 = sha256Bytes(publicKeyRaw);
  const keyId = `sha256:${publicKeySha256}`;
  const trustKeys = [{
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: publicKeyRaw.toString("base64"),
    publicKeySha256,
    validFromUtc: "2026-07-01T00:00:00Z",
    validUntilUtc: "2026-08-01T00:00:00Z",
    revokedAtUtc: null,
  }];
  const approvalAuthorities = ["Security", "Data", "Operations", "Release"].map((role) => {
    const pair = generateKeyPairSync("ed25519");
    const bytes = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }));
    const digest = sha256Bytes(bytes);
    const approvalKeyId = `sha256:${digest}`;
    trustKeys.push({
      keyId: approvalKeyId,
      algorithm: "Ed25519",
      publicKeySpkiBase64: bytes.toString("base64"),
      publicKeySha256: digest,
      validFromUtc: "2026-07-01T00:00:00Z",
      validUntilUtc: "2026-08-01T00:00:00Z",
      revokedAtUtc: null,
    });
    return { role, approverId: `approver-${role.toLowerCase()}`, keyId: approvalKeyId };
  });
  const trustPolicyRaw = Buffer.from(`${JSON.stringify({
    schemaVersion: "workbench.production-trust-policy.v1",
    environmentId: candidateBinding.environmentId,
    keys: trustKeys,
    approvalAuthorities,
    receiptAuthorities: [{ scopeId, signerId: entry.executor.id, keyId }],
  })}\n`);
  const trustPolicyPath = path.join(root, "production-trust-policy.json");
  await writeFile(trustPolicyPath, trustPolicyRaw);
  const trustPolicy = await loadProductionTrustPolicy({
    policyPath: trustPolicyPath,
    expectedSha256: sha256Bytes(trustPolicyRaw),
  });
  const unsignedReceipt = {
    schemaVersion: "workbench.hard-cut-receipt.v2",
    scopeId,
    ledger: {
      ledgerId: ledger.payload.ledgerId,
      entryId: entry.entryId,
      uri: "file:./ledger.json",
      sha256: sha256Bytes(ledgerRaw),
    },
    signedAtUtc,
    validUntilUtc,
  };
  const signature = sign(null, Buffer.from(canonicalJson({
    ...unsignedReceipt,
    keyId,
    candidateBinding,
  }), "utf8"), privateKey).toString("base64url");
  const receipt = {
    ...unsignedReceipt,
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: signature,
    },
  };
  return {
    root,
    receipt,
    candidateBinding,
    trustPolicy,
    trustPolicyPath,
    ledgerPath,
    raw: JSON.parse((await readFile(rawPath, "utf8")).trim()),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
