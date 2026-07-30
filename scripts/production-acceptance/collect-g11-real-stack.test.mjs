import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJsonFile,
  sha256Bytes,
} from "../evidence-ledger.mjs";
import { createStrictAjv2020 } from "./schema.mjs";
import {
  G11_BROWSERS,
  G11_MOTIONS,
  G11_VIEWPORTS,
  G11_VISUAL_STATES,
  productionG11FlowIds,
} from "./g11-browser-evidence-contract.mjs";
import {
  PRODUCTION_G11_CAPTURE_COUNTS,
  __testOnly,
  collectProductionG11RealStack,
  productionG11CapturePlan,
} from "./collect-g11-real-stack.mjs";
import { __g11HarnessTestOnly } from "./g11-browser-evidence-harness.mjs";

test("production G11 capture plan is the exact protected 54 visual plus 198 flow matrix", () => {
  const plan = productionG11CapturePlan();
  assert.deepEqual(PRODUCTION_G11_CAPTURE_COUNTS, { visual: 54, flow: 198, total: 252 });
  assert.equal(plan.length, 252);
  assert.equal(new Set(plan.map(({ traceId }) => traceId)).size, 252);
  assert.equal(plan.filter(({ kind }) => kind === "visual").length, 54);
  assert.equal(plan.filter(({ kind }) => kind === "flow").length, 198);

  const visualKeys = plan.filter(({ kind }) => kind === "visual").map((capture) => (
    `${capture.browserName}/${capture.state}/${capture.viewport.id}/${capture.motion}`
  )).sort();
  const expectedVisualKeys = G11_BROWSERS.flatMap((browser) => G11_VISUAL_STATES.flatMap((state) => (
    G11_VIEWPORTS.flatMap((viewport) => G11_MOTIONS.map((motion) => (
      `${browser}/${state}/${viewport.id}/${motion}`
    )))
  ))).sort();
  assert.deepEqual(visualKeys, expectedVisualKeys);

  for (const flowId of productionG11FlowIds()) {
    const flowCaptures = plan.filter((capture) => capture.flowId === flowId);
    assert.equal(flowCaptures.length, 18);
    assert.equal(new Set(flowCaptures.map(({ browserName }) => browserName)).size, 3);
    assert.equal(new Set(flowCaptures.map(({ viewport }) => viewport.id)).size, 3);
    assert.equal(new Set(flowCaptures.map(({ motion }) => motion)).size, 2);
  }
  assert.throws(() => { plan[0].traceId = "changed"; }, TypeError);
});

test("production G11 collector builds and verifies the complete signed closure before atomic publication", async (t) => {
  const fixture = await collectorFixture(t);
  const captureInputs = [];
  let activeCaptures = 0;
  let maximumActiveCaptures = 0;
  const verifyCalls = [];
  const schema = JSON.parse(await readFile(new URL(
    "../../docs/evidence/production-g11-real-stack-manifest.schema.json",
    import.meta.url,
  ), "utf8"));
  const validateManifestSchema = createStrictAjv2020().compile(schema);
  const dependencies = {
    assertCandidateSource: async (commitSha) => assert.equal(commitSha, fixture.plan.payload.binding.commitSha),
    captureTrace: async (input) => {
      __g11HarnessTestOnly.validateScenarioSecrets(input.scenarioSecrets, input.scenarioId);
      captureInputs.push(input);
      activeCaptures += 1;
      maximumActiveCaptures = Math.max(maximumActiveCaptures, activeCaptures);
      try {
        await mkdir(path.dirname(input.outputPath), { recursive: true });
        const traceBytes = Buffer.from(`sanitized trace ${input.traceId}`, "utf8");
        await writeFile(input.outputPath, traceBytes);
        let visualEvidence = null;
        if (input.scenarioId.startsWith("visual-")) {
          const visualDirectory = path.join(path.dirname(input.outputPath), `.g11-visual-${input.traceId}`);
          await mkdir(visualDirectory, { recursive: true });
          const descriptors = {};
          for (const [name, fileName] of [
            ["screenshot", "screenshot.png"],
            ["frameBefore", "frame-before.png"],
            ["frameAfter", "frame-after.png"],
          ]) {
            const bytes = Buffer.from(`${name} pixels ${input.traceId}`, "utf8");
            const filePath = path.join(visualDirectory, fileName);
            await writeFile(filePath, bytes);
            descriptors[name] = { path: filePath, sha256: sha256Bytes(bytes), bytes: bytes.length };
          }
          const state = input.scenarioId.slice("visual-".length);
          const semanticKind = state === "prototype-after-prd" ? "prototype" : "prd";
          visualEvidence = {
            ...descriptors,
            targetSelector: "[data-canvas-generation-motion]",
            framePixelDiffRatio: input.motion === "normal" ? 0.01 : 0,
            sampleIntervalMs: 180,
            computedStyle: {
              animationName: semanticKind === "prototype" ? "prototype-ripple" : "prd-aurora",
              animationDuration: input.motion === "normal" ? "1.2s" : "0.001ms",
            },
            layout: {
              withinViewport: true,
              noOverlap: true,
              promptContextVisible: true,
              activityContextVisible: true,
              pendingCompositionVisible: state === "prd-pending",
              accessibleNamesPassed: true,
              targetBounds: { x: 8, y: 8, width: 120, height: 80 },
            },
          };
        }
        return {
          nativeTraceSha256: sha256Bytes(Buffer.from(`native trace ${input.traceId}`, "utf8")),
          sanitizedTraceSha256: sha256Bytes(traceBytes),
          startedAtUtc: "2026-07-29T00:01:00Z",
          finishedAtUtc: "2026-07-29T00:02:00Z",
          unexpectedConsoleErrorCount: 0,
          unexpectedNetworkFailureCount: 0,
          unexpectedRuntimeFailureCount: 0,
          visualEvidence,
        };
      } finally {
        activeCaptures -= 1;
      }
    },
    now: monotonicClock("2026-07-29T00:00:00Z"),
    playwrightVersion: "1.61.1",
    verifyManifest: async (input) => {
      verifyCalls.push(input);
      const raw = await readFile(path.join(input.evidenceRoot, "raw/g11/manifest.json"), "utf8");
      const manifest = JSON.parse(raw);
      assert.equal(raw, canonicalJsonFile(manifest));
      assert.equal(validateManifestSchema(manifest), true, JSON.stringify(validateManifestSchema.errors));
      assert.equal(manifest.visualMatrix.length, 54);
      assert.equal(manifest.flows.length, 11);
      assert.equal(manifest.flows.every((flow) => flow.evidence.length === 20), true);
      assert.equal(manifest.collectorAttestation.collector.captureCount, 252);
      assert.equal(manifest.collectorAttestation.collector.nativeTraceDeletedCount, 252);
    },
  };

  const result = await __testOnly.collectProductionG11RealStackWithDependencies(fixture.options, dependencies);
  assert.equal(captureInputs.length, 252);
  assert.equal(maximumActiveCaptures > 1, true);
  assert.equal(maximumActiveCaptures <= 6, true);
  assert.equal(verifyCalls.length, 1);
  assert.equal(verifyCalls[0].evidenceRoot.startsWith(fixture.outputDirectory), false);
  assert.equal(result.outputDirectory, fixture.outputDirectory);
  assert.equal(result.evidenceCount, 495);
  assert.deepEqual(result.captureCounts, { visual: 54, flow: 198, total: 252 });

  const manifestRaw = await readFile(result.manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifestRaw.includes(fixture.secretSentinel), false);
  assert.equal(manifest.visualMatrix.length, 54);
  assert.equal(manifest.flows.length, 11);
  assert.equal(manifest.flows.every((flow) => flow.status === "PASS"), true);
  assert.equal(manifest.flows.every((flow) => flow.evidence.length === 20), true);
  assert.equal(new Set(manifest.flows.map((flow) => flow.evidence[1].sha256)).size, 11);

  const observerSignatures = [];
  for (const flow of manifest.flows) {
    const observerPath = path.join(
      fixture.outputDirectory,
      flow.evidence[1].uri.replace(/^file:\.\//u, ""),
    );
    observerSignatures.push(JSON.parse(await readFile(observerPath, "utf8")).signature.value);
  }
  assert.equal(new Set(observerSignatures).size, 11);
  const allEntries = await readdir(fixture.outputDirectory, { recursive: true });
  assert.equal(allEntries.some((entry) => entry.includes(".g11-visual-")), false);
  assert.equal(allEntries.some((entry) => entry.includes(".g11-staging-")), false);
  assert.equal(await pathExists(`${fixture.outputDirectory}.g11-collector-lock`), false);

  const secretInputs = captureInputs.map(({ scenarioSecrets }) => scenarioSecrets);
  assert.equal(secretInputs.length, 252);
  assert.equal(secretInputs.every((value) => value.password === fixture.secretSentinel), true);
});

test("production G11 collector fails before capture when an authority callback is missing or capture override is injected", async (t) => {
  const fixture = await collectorFixture(t);
  let captureCount = 0;
  const dependencies = {
    assertCandidateSource: async () => undefined,
    captureTrace: async () => { captureCount += 1; },
    now: () => "2026-07-29T00:00:00Z",
    playwrightVersion: "1.61.1",
    verifyManifest: async () => undefined,
  };
  const withoutObserver = { ...fixture.options };
  delete withoutObserver.observeServerFlow;
  await assert.rejects(
    __testOnly.collectProductionG11RealStackWithDependencies(withoutObserver, dependencies),
    /collector options must contain only its protected fields/u,
  );
  assert.equal(captureCount, 0);
  await assert.rejects(readFile(path.join(fixture.outputDirectory, "raw/g11/manifest.json")), /ENOENT/u);

  await assert.rejects(
    collectProductionG11RealStack({ ...fixture.options, captureTrace: async () => undefined }),
    /collector options must contain only its protected fields/u,
  );
  assert.equal(captureCount, 0);
});

async function collectorFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workbench-g11-collector-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, "evidence");
  const temporaryDirectory = path.join(root, "native-traces");
  const collectorSigner = trustedSigner("collector-prod");
  const observerSigner = trustedSigner("observer-prod");
  const commitSha = "b".repeat(40);
  const binding = {
    candidateId: `sha256:${"a".repeat(64)}`,
    deployId: "deploy-prod-20260729",
    environmentId: "prod-eu-1",
    commitSha,
    tag: "workbench-v2.0.0-rc1",
    releaseChainId: `sha256:${"c".repeat(64)}`,
    digests: {
      images: [{ name: "workbench-web", digest: `sha256:${"d".repeat(64)}` }],
      configSha256: "e".repeat(64),
      migrationSha256: "f".repeat(64),
      deploymentConfigManifestSha256: "1".repeat(64),
      imageManifestSha256: "2".repeat(64),
      controlCatalogSha256: "3".repeat(64),
    },
  };
  const environment = {
    environmentId: binding.environmentId,
    kind: "production",
    description: "EU production acceptance environment",
    region: "eu-west-1",
  };
  const plan = {
    schemaVersion: "workbench.production-acceptance-plan.v1",
    payload: {
      planId: "production-plan-20260729-g11",
      createdAtUtc: "2026-07-28T23:00:00Z",
      plannerId: "release-planner-prod",
      binding,
      environment,
    },
    payloadSha256: "4".repeat(64),
  };
  const trustPolicy = {
    sha256: "5".repeat(64),
    environmentId: binding.environmentId,
    keys: new Map([
      [collectorSigner.keyId, collectorSigner.key],
      [observerSigner.keyId, observerSigner.key],
    ]),
    approvalAuthorities: [],
    receiptAuthorities: [
      { scopeId: "production-g11.browser-evidence-collector", signerId: collectorSigner.signerId, keyId: collectorSigner.keyId },
      { scopeId: "production-g11.server-observer", signerId: observerSigner.signerId, keyId: observerSigner.keyId },
    ],
  };
  const planIdentity = { planId: plan.payload.planId, payloadSha256: plan.payloadSha256 };
  const deployment = {
    stackKind: "deployed-production",
    webOrigin: "https://app.example.com",
    previewOrigin: "https://preview.example.com",
    approvedThirdPartyOrigins: ["https://cdn.example.com"],
    provider: { class: "approved-production-provider", id: "provider-live", version: "2026.07.29" },
    sessionBoundary: "better-auth",
    apiBoundary: "workbench-api",
    sseBoundary: "workbench-sse",
    queueBoundary: "pg-boss",
    databaseBoundary: "postgresql",
    artifactBoundary: "immutable-artifact-version",
  };
  const datasetSha256 = "6".repeat(64);
  const secretSentinel = "secret-password-never-persisted";
  const options = {
    browserVersions: { chromium: "140.0.1", firefox: "141.0.1", webkit: "26.0.1" },
    collectDatasetReceipt: async () => ({
      schemaVersion: "workbench.production-g11-synthetic-dataset-receipt.v1",
      datasetId: "g11-isolated-browser-dataset",
      datasetSha256,
      classification: "isolated-synthetic",
      plan: planIdentity,
      binding,
      environment,
      productionDataUsed: false,
      sensitiveSourceDataUsed: false,
    }),
    observeDeployment: async ({ collectionStartedAtUtc }) => ({
      schemaVersion: "workbench.production-g11-deployment-receipt.v2",
      receiptId: "deployment-receipt-prod-20260729",
      plan: planIdentity,
      binding,
      environment,
      deployment,
      observedAtUtc: collectionStartedAtUtc,
      tls: { webVerified: true, previewVerified: true },
    }),
    observeServerFlow: async ({ observerCheckIds }) => ({
      checks: Object.fromEntries(observerCheckIds.map((checkId) => [checkId, passingObserverValue(checkId)])),
      observedAtUtc: "2026-07-29T00:02:00Z",
    }),
    outputDirectory,
    plan,
    resolveScenarioSecrets: async ({ scenarioId, traceId }) => ({
      account: `${scenarioId}-${traceId}@example.com`,
      password: secretSentinel,
      ...(scenarioId === "account-project" ? {
        invitationToken: `wbi_${"A".repeat(48)}.${"B".repeat(43)}`,
        expiredInvitationToken: `wbi_${"C".repeat(48)}.${"D".repeat(43)}`,
      } : {}),
    }),
    reviewImages: async ({ images }) => ({
      schemaVersion: "workbench.production-g11-browser-image-privacy-review.v1",
      reviewId: "g11-image-review-prod-20260729",
      reviewedAtUtc: "2026-07-29T00:13:00Z",
      datasetSha256,
      scanner: { name: "scanner-prod", version: "2.1.0", rulesSha256: "7".repeat(64) },
      status: "PASS",
      images: images.map(({ uri, sha256 }) => ({
        uri,
        sha256,
        ocrScanComplete: true,
        secretMatches: 0,
        sensitiveContentMatches: 0,
        unapprovedTextMatches: 0,
        redactionApplied: false,
        securityReview: "PASS",
      })),
    }),
    scenarioBindings: scenarioBindings(),
    signCollectorAttestation: async ({ payload }) => (
      sign(null, Buffer.from(payload, "utf8"), collectorSigner.privateKey).toString("base64url")
    ),
    signServerObserverReceipt: async ({ payload }) => (
      sign(null, Buffer.from(payload, "utf8"), observerSigner.privateKey).toString("base64url")
    ),
    temporaryDirectory,
    trustPolicy,
  };
  return { options, outputDirectory, plan, secretSentinel };
}

function scenarioBindings() {
  const common = { projectId: "project-prod-a", threadId: "thread-prod-a" };
  return {
    "visual-prd-active": { ...common },
    "visual-prd-pending": { ...common },
    "visual-prototype-after-prd": { ...common },
    "account-project": { deniedProjectId: "project-denied-a", ...common },
    prd: { ...common },
    "mixed-rejection": { ...common },
    "prototype-after-prd": { ...common },
    "refresh-reconnect": { ...common },
    "preview-import-export": { ...common },
    "run-canvas-sse-artifact": { ...common },
    "accessibility-preview-security": { ...common },
    "long-run-7686-plus": { ...common, runId: "run-long-a" },
    "knowledge-null-valid": { knowledgeReleaseId: "knowledge-release-a", ...common },
    "provider-state-integrity": { artifactVersionId: "artifact-version-a", ...common, runId: "run-provider-a" },
  };
}

function passingObserverValue(checkId) {
  if (checkId === "minimumEventCount" || checkId === "observedEventCount") return 7_686;
  if (/Count$/u.test(checkId)) return 0;
  return true;
}

function trustedSigner(signerId) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const publicKeySha256 = sha256Bytes(spki);
  return {
    signerId,
    privateKey,
    keyId: `sha256:${publicKeySha256}`,
    key: {
      publicKey,
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validUntil: new Date("2027-01-01T00:00:00Z"),
      revokedAt: null,
    },
  };
}

function monotonicClock(startedAtUtc) {
  let current = new Date(startedAtUtc).getTime();
  return () => {
    const value = new Date(current);
    current += 60_000;
    return value;
  };
}

async function pathExists(candidate) {
  return readFile(candidate).then(() => true).catch((error) => {
    if (["EISDIR", "EACCES"].includes(error?.code)) return true;
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}
