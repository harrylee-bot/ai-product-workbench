import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";

import sharp from "sharp";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
  sha256Canonical,
} from "../evidence-ledger.mjs";
import { createG11SanitizedTraceArchive } from "./g11-browser-evidence-harness.mjs";
import {
  productionG11CollectorAttestationPayload,
  productionG11ServerObserverReceiptPayload,
  productionG11RenderedStates,
} from "./g11-real-stack-manifest.mjs";
import {
  G11_BROWSERS as BROWSERS,
  G11_MOTIONS as MOTIONS,
  G11_VIEWPORTS as VIEWPORTS,
  G11_VISUAL_STATES as STATES,
  productionG11OriginPolicySha256,
  productionG11ScenarioPlan,
  productionG11ScenarioPlanSha256,
} from "./g11-browser-evidence-contract.mjs";

const CAPTURED_AT = "2026-07-19T06:30:00Z";
const VISUAL_TRACE_STARTED_AT = "2026-07-19T06:29:00Z";
const VISUAL_TRACE_FINISHED_AT = "2026-07-19T06:30:00Z";
const FLOW_TRACE_STARTED_AT = "2026-07-19T06:20:00Z";
const FLOW_TRACE_FINISHED_AT = "2026-07-19T06:40:00Z";

let visualAssetsPromise;

export async function createDiagnosticG11Fixture({
  addArtifact,
  binding,
  environment,
  plan,
  flowChecks,
  collectorSigner,
  observerSigner,
  trustPolicySha256,
}) {
  const evidence = [];
  const planIdentity = {
    planId: plan.payload.planId,
    payloadSha256: plan.payloadSha256,
  };
  const deploymentIdentity = {
    stackKind: "deployed-production",
    webOrigin: "https://8.8.8.8",
    previewOrigin: "https://1.1.1.1",
    approvedThirdPartyOrigins: [],
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
  };

  const deploymentReceipt = await addJsonArtifact(addArtifact, "receipts/deployment.json", "production-deployment-receipt", {
    schemaVersion: "workbench.production-g11-deployment-receipt.v2",
    receiptId: `deployment-receipt-${plan.payload.planId.slice(-24)}`,
    plan: planIdentity,
    binding,
    environment,
    deployment: deploymentIdentity,
    observedAtUtc: "2026-07-19T06:16:00Z",
    tls: { webVerified: true, previewVerified: true },
  }, evidence);
  const harnessSource = await readFile(new URL("./g11-browser-evidence-harness.mjs", import.meta.url));
  const harnessReference = await addBytesArtifact(
    addArtifact,
    "harness/real-stack-browser.mjs",
    "browser-harness-source",
    harnessSource,
    evidence,
  );
  const collectorSource = await readFile(new URL("./collect-g11-real-stack.mjs", import.meta.url));
  const collectorReference = await addBytesArtifact(
    addArtifact,
    "collector/collect-g11-real-stack.mjs",
    "browser-collector-source",
    collectorSource,
    evidence,
  );

  const browsers = BROWSERS.map((name, index) => ({ name, version: `140.0.${index + 1}` }));
  const assets = await diagnosticVisualAssets();
  const visualMatrix = [];
  for (const browser of BROWSERS) {
    for (const state of STATES) {
      for (const viewport of VIEWPORTS) {
        for (const motion of MOTIONS) {
          const key = `${browser}-${state}-${viewport.id}-${motion}`;
          const captureId = `capture-${key}`;
          const scenarioBinding = diagnosticScenarioBinding(`visual-${state}`, captureId);
          const scenarioPlan = productionG11ScenarioPlan({ scenarioId: `visual-${state}`, scenarioBinding });
          const asset = assets.get(key);
          const screenshot = await addBytesArtifact(
            addArtifact,
            `screenshots/${key}.png`,
            "browser-screenshot",
            asset.screenshot,
            evidence,
          );
          const frameBefore = await addBytesArtifact(
            addArtifact,
            `frames/${key}-before.png`,
            "browser-motion-frame",
            asset.frameBefore,
            evidence,
          );
          const frameAfter = await addBytesArtifact(
            addArtifact,
            `frames/${key}-after.png`,
            "browser-motion-frame",
            asset.frameAfter,
            evidence,
          );
          const trace = await addBytesArtifact(
            addArtifact,
            `traces/${key}.zip`,
            "playwright-sanitized-trace",
            createDiagnosticG11SanitizedTrace({
              traceId: captureId,
              browser,
              browserVersion: browsers.find(({ name }) => name === browser).version,
              viewport,
              motion,
              startedAtUtc: VISUAL_TRACE_STARTED_AT,
              finishedAtUtc: VISUAL_TRACE_FINISHED_AT,
              scenarioId: `visual-${state}`,
              scenarioBinding,
              scenarioPlan,
              originPolicySha256: productionG11OriginPolicySha256(deploymentIdentity),
            }).bytes,
            evidence,
          );
          const nativeTraceSha256 = diagnosticNativeTraceSha256(captureId, { browser, viewport, motion });
          const semanticKind = state === "prototype-after-prd" ? "prototype" : "prd";
          const runState = {
            requestedArtifactKinds: [semanticKind],
            generationStage: semanticKind === "prototype" ? "generating-ui" : "drafting-prd",
            terminal: false,
          };
          const motionEvidence = {
            semanticKind,
            animationName: semanticKind === "prototype" ? "prototype-ripple" : "prd-aurora",
            animationDurationMs: motion === "reduced" ? 1 : 1_200,
            reducedMotionMedia: motion === "reduced",
            targetSelector: "[data-canvas-generation-motion]",
            sampleIntervalMs: 120,
          };
          const layout = {
            withinViewport: true,
            noOverlap: true,
            promptContextVisible: true,
            activityContextVisible: true,
            pendingCompositionVisible: state === "prd-pending",
            accessibleNamesPassed: true,
          };
          const cell = {
            browser,
            captureId,
            capturedAtUtc: CAPTURED_AT,
            viewport: viewport.id,
            motion,
            state,
            status: "PASS",
            scenarioBinding,
            runState,
            motionEvidence,
            layout,
            screenshot,
            frameBefore,
            frameAfter,
            receipt: null,
            trace,
          };
          cell.receipt = await addJsonArtifact(addArtifact, `receipts/${key}.json`, "browser-cell-receipt", {
            schemaVersion: "workbench.production-g11-browser-cell-receipt.v2",
            captureId,
            plan: planIdentity,
            binding,
            environment,
            deployment: deploymentIdentity,
            browser: browsers.find(({ name }) => name === browser),
            viewport,
            motion,
            state,
            capturedAtUtc: CAPTURED_AT,
            targetSelector: motionEvidence.targetSelector,
            runState,
            motionEvidence,
            layout,
            capture: {
              documentReadyState: "complete",
              domCaptureComplete: true,
              consoleCaptureComplete: true,
              networkCaptureComplete: true,
              runtimeCaptureComplete: true,
              accessibilityCaptureComplete: true,
              traceComplete: true,
              routeFulfillUsed: false,
              syntheticSessionUsed: false,
              syntheticApiUsed: false,
              syntheticSseUsed: false,
              unexpectedConsoleErrorCount: 0,
              unexpectedNetworkFailureCount: 0,
              unexpectedRuntimeFailureCount: 0,
            },
            targetBounds: asset.targetBounds,
            framePixelDiffRatio: asset.framePixelDiffRatio,
            traceStartedAtUtc: VISUAL_TRACE_STARTED_AT,
            traceFinishedAtUtc: VISUAL_TRACE_FINISHED_AT,
            nativeTraceSha256,
            screenshot,
            frameBefore,
            frameAfter,
            trace,
            scenarioBinding,
          }, evidence);
          visualMatrix.push(cell);
        }
      }
    }
  }

  const flows = [];
  for (const [flowId, checks] of Object.entries(flowChecks)) {
    const traces = [];
    const coverage = [];
    for (const browser of BROWSERS) {
      for (const viewport of VIEWPORTS) {
        for (const motion of MOTIONS) {
          const key = `${flowId}-${browser}-${viewport.id}-${motion}`;
          const traceId = `flow-${key}`;
          const scenarioBinding = diagnosticScenarioBinding(flowId, traceId);
          const scenarioPlan = productionG11ScenarioPlan({ scenarioId: flowId, scenarioBinding });
          const browserVersion = browsers.find(({ name }) => name === browser).version;
          const nativeTraceSha256 = diagnosticNativeTraceSha256(traceId, { browser, viewport, motion });
          const trace = await addBytesArtifact(
            addArtifact,
            `flows/traces/${key}.zip`,
            "playwright-sanitized-trace",
            createDiagnosticG11SanitizedTrace({
              traceId,
              browser,
              browserVersion,
              viewport,
              motion,
              startedAtUtc: FLOW_TRACE_STARTED_AT,
              finishedAtUtc: FLOW_TRACE_FINISHED_AT,
              scenarioId: flowId,
              scenarioBinding,
              scenarioPlan,
              originPolicySha256: productionG11OriginPolicySha256(deploymentIdentity),
            }).bytes,
            evidence,
          );
          traces.push(trace);
          coverage.push({
            browser,
            browserVersion,
            viewport: viewport.id,
            motion,
            traceId,
            scenarioBinding,
            scenarioPlanSha256: productionG11ScenarioPlanSha256({ scenarioId: flowId, scenarioBinding }),
            nativeTraceSha256,
            startedAtUtc: FLOW_TRACE_STARTED_AT,
            finishedAtUtc: FLOW_TRACE_FINISHED_AT,
            status: "PASS",
            steps: scenarioPlan.browserSteps.map(({ stepId, actionId, apiName }) => ({
              stepId,
              actionId,
              apiName,
              status: "PASS",
              observedAtUtc: CAPTURED_AT,
            })),
            consoleCaptureComplete: true,
            networkCaptureComplete: true,
            runtimeCaptureComplete: true,
            unexpectedConsoleErrorCount: 0,
            unexpectedNetworkFailureCount: 0,
            unexpectedRuntimeFailureCount: 0,
            trace,
          });
        }
      }
    }
    const scenarioBinding = coverage[0].scenarioBinding;
    const scenarioPlan = productionG11ScenarioPlan({ scenarioId: flowId, scenarioBinding });
    const receipt = await addJsonArtifact(addArtifact, `flows/${flowId}.json`, "browser-flow-receipt", {
      schemaVersion: "workbench.production-g11-flow-evidence.v3",
      receiptId: `flow-receipt-${flowId}`,
      plan: planIdentity,
      binding,
      environment,
      deployment: deploymentIdentity,
      flowId,
      startedAtUtc: FLOW_TRACE_STARTED_AT,
      finishedAtUtc: FLOW_TRACE_FINISHED_AT,
      status: "PASS",
      scenarioBinding,
      checks,
      renderedStates: productionG11RenderedStates(flowId),
      coverage,
    }, evidence);
    const observerChecks = Object.fromEntries(scenarioPlan.observerCheckIds.map((checkId) => [checkId, checks[checkId]]));
    const captureObservations = coverage.map(({ traceId, scenarioBinding: captureBinding, scenarioPlanSha256 }) => ({
      traceId,
      scenarioBinding: captureBinding,
      scenarioPlanSha256,
      checks: structuredClone(observerChecks),
    }));
    const observerReceipt = {
      schemaVersion: "workbench.production-g11-server-observer-receipt.v2",
      receiptId: `server-observer-${flowId}`,
      plan: planIdentity,
      binding,
      environment,
      deployment: deploymentIdentity,
      scenarioId: flowId,
      scenarioBinding,
      scenarioPlanSha256: productionG11ScenarioPlanSha256({ scenarioId: flowId, scenarioBinding }),
      originPolicySha256: productionG11OriginPolicySha256(deploymentIdentity),
      flowId,
      coverage,
      captureObservations,
      checks: observerChecks,
      observedAtUtc: "2026-07-19T06:39:00Z",
      signedAtUtc: "2026-07-19T06:41:00Z",
      trustPolicySha256,
      scopeId: "production-g11.server-observer",
      signerId: observerSigner.signerId,
      signature: { algorithm: "Ed25519", keyId: observerSigner.keyId, value: "A".repeat(86) },
    };
    observerReceipt.signature.value = sign(
      null,
      Buffer.from(canonicalJson(productionG11ServerObserverReceiptPayload(observerReceipt)), "utf8"),
      observerSigner.privateKey,
    ).toString("base64url");
    const observerReference = await addJsonArtifact(
      addArtifact,
      `flows/${flowId}.observer.json`,
      "server-observer-receipt",
      observerReceipt,
      evidence,
    );
    flows.push({ flowId, status: "PASS", scenarioBinding, checks, evidence: [receipt, observerReference, ...traces] });
  }

  const datasetSha256 = sha256Canonical({
    schemaVersion: "workbench.production-g11-synthetic-dataset-seal.v1",
    plan: planIdentity,
    datasetId: "g11-isolated-browser-dataset",
    entityClasses: ["account", "artifact", "invitation", "project", "run", "workspace"],
  });
  const dataset = await addJsonArtifact(addArtifact, "receipts/synthetic-dataset.json", "synthetic-browser-dataset-receipt", {
    schemaVersion: "workbench.production-g11-synthetic-dataset-receipt.v1",
    datasetId: "g11-isolated-browser-dataset",
    datasetSha256,
    classification: "isolated-synthetic",
    plan: planIdentity,
    binding,
    environment,
    productionDataUsed: false,
    sensitiveSourceDataUsed: false,
  }, evidence);
  const imageReferences = visualMatrix.flatMap((cell) => [
    cell.screenshot,
    cell.frameBefore,
    cell.frameAfter,
  ]).map(({ uri, sha256 }) => ({
    uri,
    sha256,
    ocrScanComplete: true,
    secretMatches: 0,
    sensitiveContentMatches: 0,
    unapprovedTextMatches: 0,
    redactionApplied: false,
    securityReview: "PASS",
  })).sort((left, right) => `${left.uri}\0${left.sha256}`.localeCompare(`${right.uri}\0${right.sha256}`, "en"));
  const privacyReview = await addJsonArtifact(addArtifact, "receipts/image-privacy-review.json", "browser-image-privacy-review", {
    schemaVersion: "workbench.production-g11-browser-image-privacy-review.v1",
    reviewId: "g11-browser-image-privacy-review",
    reviewedAtUtc: "2026-07-19T06:56:00Z",
    datasetSha256,
    scanner: {
      name: "g11-image-privacy-scanner",
      version: "1.0.0",
      rulesSha256: sha256Bytes(Buffer.from("g11-image-privacy-rules-v1", "utf8")),
    },
    status: "PASS",
    images: imageReferences,
  }, evidence);

  const [schemaBytes, verifierBytes, runnerBytes] = await Promise.all([
    readFile(new URL("../../docs/evidence/production-g11-real-stack-manifest.schema.json", import.meta.url)),
    readFile(new URL("./g11-real-stack-manifest.mjs", import.meta.url)),
    readFile(new URL("./run-control.mjs", import.meta.url)),
  ]);
  const assertionCount = visualMatrix.reduce((sum, cell) => (
    sum + scenarioAssertionCount(productionG11ScenarioPlan({
      scenarioId: `visual-${cell.state}`,
      scenarioBinding: cell.scenarioBinding,
    }))
  ), 0) + Object.keys(flowChecks).reduce((sum, flowId) => (
    sum + scenarioAssertionCount(productionG11ScenarioPlan({
      scenarioId: flowId,
      scenarioBinding: diagnosticScenarioBinding(flowId, `diagnostic-${flowId}`),
    })) * (BROWSERS.length * VIEWPORTS.length * MOTIONS.length)
  ), 0);
  const collectorAttestation = {
    schemaVersion: "workbench.production-g11-collector-attestation.v1",
    scopeId: "production-g11.browser-evidence-collector",
    signerId: collectorSigner.signerId,
    signedAtUtc: "2026-07-19T06:57:00Z",
    trustPolicySha256,
    collector: {
      collectorSha256: collectorReference.sha256,
      harnessSha256: harnessReference.sha256,
      schemaSha256: sha256Bytes(schemaBytes),
      verifierSha256: sha256Bytes(verifierBytes),
      runnerSha256: sha256Bytes(runnerBytes),
      sanitizerAlgorithm: "strict-allowlist-v1",
      captureCount: 252,
      assertionCount,
      unexpectedRuntimeFailureCount: 0,
      nativeTraceCount: 252,
      nativeTraceDeletedCount: 252,
    },
    evidenceClosureSha256: sha256Canonical({
      schemaVersion: "workbench.production-g11-evidence-closure.v1",
      evidence: structuredClone(evidence).sort((left, right) => (
        `${left.uri}\0${left.kind}`.localeCompare(`${right.uri}\0${right.kind}`, "en")
      )),
    }),
    source: collectorReference,
    dataset,
    privacyReview,
    signature: {
      algorithm: "Ed25519",
      keyId: collectorSigner.keyId,
      value: "A".repeat(86),
    },
  };

  const manifest = {
    schemaVersion: "workbench.production-g11-real-stack-manifest.v2",
    manifestId: `g11-real-stack-${plan.payload.planId.slice(-24)}`,
    plan: planIdentity,
    binding,
    environment,
    deployment: { ...deploymentIdentity, receipt: deploymentReceipt },
    harness: {
      name: "playwright",
      version: "1.58.2",
      sourceCommit: binding.commitSha,
      routeFulfillUsed: false,
      syntheticSessionUsed: false,
      syntheticApiUsed: false,
      syntheticSseUsed: false,
      source: harnessReference,
      traceCollection: "playwright-sanitized-trace",
    },
    collectorAttestation,
    startedAtUtc: "2026-07-19T06:15:00Z",
    finishedAtUtc: "2026-07-19T06:55:00Z",
    browsers,
    visualMatrix,
    flows,
    unexpectedConsoleErrors: [],
    unexpectedNetworkFailures: [],
  };
  manifest.collectorAttestation.signature.value = sign(
    null,
    Buffer.from(canonicalJson(productionG11CollectorAttestationPayload(manifest)), "utf8"),
    collectorSigner.privateKey,
  ).toString("base64url");
  const manifestEvidence = await addArtifact(
    "manifest.json",
    Buffer.from(canonicalJsonFile(manifest), "utf8"),
    "production-g11-real-stack-manifest",
  );
  const manifestReference = {
    uri: manifestEvidence.uri,
    sha256: manifestEvidence.sha256,
  };
  const observationEvidence = [manifestEvidence, ...evidence]
    .sort((left, right) => left.uri.localeCompare(right.uri, "en"));
  return { manifest, manifestReference, evidence, observationEvidence };
}

async function addJsonArtifact(addArtifact, relativePath, kind, value, evidence) {
  return addBytesArtifact(
    addArtifact,
    relativePath,
    kind,
    Buffer.from(canonicalJsonFile(value), "utf8"),
    evidence,
  );
}

async function addBytesArtifact(addArtifact, relativePath, kind, bytes, evidence) {
  const reference = await addArtifact(relativePath, bytes, kind);
  evidence.push(reference);
  return reference;
}

async function diagnosticVisualAssets() {
  visualAssetsPromise ??= buildDiagnosticVisualAssets();
  return visualAssetsPromise;
}

async function buildDiagnosticVisualAssets() {
  const assets = new Map();
  for (const [browserIndex, browser] of BROWSERS.entries()) {
    for (const [stateIndex, state] of STATES.entries()) {
      for (const viewport of VIEWPORTS) {
        for (const [motionIndex, motion] of MOTIONS.entries()) {
          const targetBounds = {
            x: 24,
            y: 88,
            width: Math.min(240, viewport.width - 48),
            height: 144,
          };
          const colors = diagnosticColors(stateIndex, browserIndex, motionIndex);
          const screenshot = await diagnosticPng(viewport, targetBounds, colors, 18);
          const frameBefore = await diagnosticPng(viewport, targetBounds, colors, 12);
          const frameAfter = motion === "normal"
            ? await diagnosticPng(viewport, targetBounds, colors, 42)
            : frameBefore;
          const framePixelDiffRatio = await pngDiffRatio(frameBefore, frameAfter, targetBounds);
          assets.set(`${browser}-${state}-${viewport.id}-${motion}`, {
            screenshot,
            frameBefore,
            frameAfter,
            targetBounds,
            framePixelDiffRatio,
          });
        }
      }
    }
  }
  return assets;
}

function diagnosticColors(stateIndex, browserIndex, motionIndex) {
  const bases = ["#e7f1ff", "#f3e9ff", "#e9f8ef"];
  const panels = ["#2563eb", "#9333ea", "#15803d"];
  const accents = ["#dc2626", "#d97706", "#0891b2"];
  return {
    base: bases[stateIndex],
    panel: panels[(stateIndex + browserIndex) % panels.length],
    accent: accents[(stateIndex + motionIndex) % accents.length],
  };
}

async function diagnosticPng(viewport, targetBounds, colors, motionOffset) {
  const panel = await sharp({
    create: { width: viewport.width - 32, height: Math.min(220, viewport.height - 180), channels: 4, background: colors.panel },
  }).png().toBuffer();
  const target = await sharp({
    create: { width: 56, height: 56, channels: 4, background: colors.accent },
  }).png().toBuffer();
  const footer = await sharp({
    create: { width: viewport.width - 64, height: 72, channels: 4, background: "#20242a" },
  }).png().toBuffer();
  return sharp({
    create: { width: viewport.width, height: viewport.height, channels: 4, background: colors.base },
  }).composite([
    { input: panel, left: 16, top: 48 },
    { input: target, left: targetBounds.x + motionOffset, top: targetBounds.y + 40 },
    { input: footer, left: 32, top: viewport.height - 104 },
  ]).png().toBuffer();
}

async function pngDiffRatio(before, after, bounds) {
  const [left, right] = await Promise.all([
    sharp(before).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(after).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let changed = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = (y * left.info.width + x) * left.info.channels;
      for (let channel = 0; channel < left.info.channels; channel += 1) {
        if (Math.abs(left.data[offset + channel] - right.data[offset + channel]) > 2) {
          changed += 1;
          break;
        }
      }
    }
  }
  return changed / (bounds.width * bounds.height);
}

export function createDiagnosticG11SanitizedTrace({
  traceId,
  browser,
  browserVersion,
  viewport,
  motion,
  startedAtUtc,
  finishedAtUtc,
  scenarioId,
  scenarioBinding,
  scenarioPlan,
  originPolicySha256,
  nativeTraceSha256 = diagnosticNativeTraceSha256(traceId, { browser, viewport, motion }),
  mutateMetadata,
  mutateCalls,
  mutateNetwork,
  extraEntries = [],
}) {
  const metadata = {
    schemaVersion: "workbench.production-g11-sanitized-playwright-trace.v1",
    traceId,
    nativeTraceSha256,
    browser: { name: browser, version: browserVersion },
    viewport,
    motion,
    startedAtUtc,
    finishedAtUtc,
    scenarioId,
    scenarioPlanSha256: productionG11ScenarioPlanSha256({ scenarioId, scenarioBinding }),
    originPolicySha256,
    scenarioBinding,
    sseCapture: diagnosticSseCapture(scenarioId),
    consoleCapture: { complete: true, unexpectedErrorCount: 0, records: [] },
    runtimeCapture: {
      complete: true,
      browserDisconnectCount: 0,
      pageCrashCount: 0,
      unexpectedFailureCount: 0,
    },
    sanitization: {
      algorithm: "strict-allowlist-v1",
      nativeTraceExcluded: true,
      temporaryNativeTraceOutsideEvidenceRoot: true,
      nativeTraceDeleted: true,
      headersRemoved: true,
      bodiesRemoved: true,
      cookiesRemoved: true,
      queryValuesRemoved: true,
    },
  };
  const calls = {
    schemaVersion: "workbench.production-g11-sanitized-playwright-calls.v1",
    traceId,
    calls: scenarioPlan.browserSteps.map((step, index) => ({
      callId: `${traceId}-call-${index + 1}`,
      stepId: step.stepId,
      actionId: step.actionId,
      apiName: step.apiName,
      offsetMs: index * 10,
      durationMs: index === 0 ? 120 : 5,
      status: "PASS",
      assertionCount: step.assertions.length,
      assertions: step.assertions.map((assertion, assertionIndex) => ({
        assertionId: `${traceId}-call-${index + 1}-assertion-${assertionIndex + 1}`,
        stepId: step.stepId,
        assertionSpecId: assertion.assertionSpecId,
        kind: assertion.kind,
        status: "PASS",
      })),
    })),
  };
  const network = {
    schemaVersion: "workbench.production-g11-sanitized-playwright-network.v1",
    traceId,
    captureComplete: true,
    requests: [{
      requestId: "request-1",
      method: "GET",
      originClass: "web",
      pathClass: "document",
      routeTemplateId: "unclassified",
      routeBindingSha256: sha256Bytes(Buffer.from("/", "utf8")),
      resourceType: "document",
      statusCode: 200,
      failureClass: "none",
      outcomeClass: "expected-success",
      expectationRuleId: "none",
      attributionCode: "first-party",
      durationMs: 84,
      origin: "https://8.8.8.8",
      remoteAddress: "8.8.8.8",
      remotePort: 443,
    }],
  };
  mutateMetadata?.(metadata);
  mutateCalls?.(calls);
  mutateNetwork?.(network);
  return {
    bytes: createG11SanitizedTraceArchive({ metadata, calls, network, extraEntries }),
    nativeTraceSha256,
  };
}

function diagnosticNativeTraceSha256(traceId, { browser, viewport, motion }) {
  const temporaryNativeTrace = Buffer.from(canonicalJsonFile({
    traceId,
    browser,
    viewport,
    motion,
    url: "https://workbench.acceptance.aionbench.com/project?diagnostic-secret=removed",
    headers: { cookie: "diagnostic-secret-removed" },
    body: "diagnostic-user-content-removed",
  }), "utf8");
  return sha256Bytes(temporaryNativeTrace);
}

function diagnosticScenarioBinding(scenarioId, traceId) {
  const binding = {
    projectId: `project-${traceId}`,
    threadId: `thread-${traceId}`,
  };
  if (scenarioId === "account-project") binding.deniedProjectId = `denied-${traceId}`;
  if (scenarioId === "long-run-7686-plus") binding.runId = `run-${traceId}`;
  if (scenarioId === "knowledge-null-valid") binding.knowledgeReleaseId = "knowledge-release-diagnostic";
  if (scenarioId === "provider-state-integrity") {
    binding.artifactVersionId = `artifact-${traceId}`;
    binding.runId = `run-${traceId}`;
  }
  return binding;
}

function scenarioAssertionCount(scenarioPlan) {
  return scenarioPlan.browserSteps.reduce((sum, step) => sum + step.assertions.length, 0);
}

function diagnosticSseCapture(scenarioId) {
  const spec = {
    "visual-prd-active": [
      diagnosticSseSegment(scenarioId, 0, ["run.generation.stage.changed"]),
    ],
    "visual-prd-pending": [
      diagnosticSseSegment(scenarioId, 0, ["run.generation.stage.changed"]),
    ],
    "visual-prototype-after-prd": [
      diagnosticSseSegment(scenarioId, 0, ["run.generation.stage.changed"]),
    ],
    prd: [
      diagnosticSseSegment(scenarioId, 0, ["run.generation.stage.changed", "run.completed"]),
    ],
    "mixed-rejection": [],
    "refresh-reconnect": [
      diagnosticSseSegment(scenarioId, 0, ["run.started", "run.generation.stage.changed"]),
      diagnosticSseSegment(scenarioId, 2, ["run.generation.stage.changed", "run.completed"]),
    ],
    "run-canvas-sse-artifact": [
      diagnosticSseSegment(scenarioId, 0, [
        "run.started", "artifact.prototype.patch.created", "run.failed",
      ], "failed"),
      diagnosticSseSegment(scenarioId, 0, [
        "run.started", "artifact.version.created", "run.completed",
      ], "retry"),
    ],
    "long-run-7686-plus": {
      names: Array.from({ length: 7_686 }, (_, index) => {
        if (index === 0) return "run.started";
        if (index === 7_685) return "run.completed";
        return "message.delta";
      }),
    },
    "provider-state-integrity": [
      diagnosticSseSegment(scenarioId, 0, [
        "message.delta", "activity.changed", "artifact.draft.created", "artifact.version.created",
      ]),
    ],
  }[scenarioId] ?? [];
  const segments = scenarioId === "long-run-7686-plus"
    ? [diagnosticSseSegment(scenarioId, 0, spec.names)]
    : spec;
  return {
    complete: true,
    records: segments.flat(),
  };
}

function diagnosticSseSegment(scenarioId, afterSequence, eventNames, runSuffix = "primary") {
  const streamId = sha256Bytes(Buffer.from(
    `/api/projects/project-diagnostic/runs/${scenarioId}-${runSuffix}/events`,
    "utf8",
  ));
  return eventNames.map((eventName, index) => ({
    streamId,
    afterSequence,
    eventName,
    sequence: afterSequence + index + 1,
  }));
}
