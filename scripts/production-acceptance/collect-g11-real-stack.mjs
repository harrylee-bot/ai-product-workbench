import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
  sha256Canonical,
} from "../evidence-ledger.mjs";
import { verifyProductionDeploymentRuntimeBinding } from "../production-deployment-config.mjs";
import {
  resolveReceiptAuthority,
  verifyTrustedEd25519Signature,
} from "../workbench-production-trust-policy.mjs";
import {
  G11_BROWSERS,
  G11_MOTIONS,
  G11_VIEWPORTS,
  G11_VISUAL_STATES,
  productionG11FlowCheckSpec,
  productionG11FlowChecksPass,
  productionG11FlowIds,
  productionG11OriginPolicy,
  productionG11OriginPolicySha256,
  productionG11RenderedStates,
  productionG11ScenarioPlan,
  productionG11ScenarioPlanSha256,
} from "./g11-browser-evidence-contract.mjs";
import { collectG11SanitizedBrowserTrace } from "./g11-browser-evidence-harness.mjs";
import {
  PRODUCTION_G11_REAL_STACK_SCHEMA_PATH,
  PRODUCTION_G11_REAL_STACK_SCHEMA_VERSION,
  loadProductionG11RealStackManifest,
  productionG11CollectorAttestationPayload,
  productionG11ServerObserverReceiptPayload,
} from "./g11-real-stack-manifest.mjs";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const harnessPath = path.join(moduleDirectory, "g11-browser-evidence-harness.mjs");
const collectorPath = path.join(moduleDirectory, "collect-g11-real-stack.mjs");
const verifierPath = path.join(moduleDirectory, "g11-real-stack-manifest.mjs");
const runnerPath = path.join(moduleDirectory, "run-control.mjs");
const schemaPath = path.join(repoRoot, PRODUCTION_G11_REAL_STACK_SCHEMA_PATH);

const COLLECTOR_SCOPE_ID = "production-g11.browser-evidence-collector";
const SERVER_OBSERVER_SCOPE_ID = "production-g11.server-observer";
const MANIFEST_URI = "file:./raw/g11/manifest.json";
const EXPECTED_CAPTURE_COUNT = 252;
const EXPECTED_VISUAL_COUNT = 54;
const EXPECTED_FLOW_TRACE_COUNT = 198;
const EXPECTED_IMAGE_COUNT = 162;
const NORMAL_MOTION_PIXEL_THRESHOLD = 0.0025;
const REDUCED_MOTION_PIXEL_THRESHOLD = 0.0001;
const DEFAULT_CAPTURE_CONCURRENCY = 6;
const MAX_CAPTURE_CONCURRENCY = 12;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const FORBIDDEN_PRODUCTION_MARKER = /(?:controlled|fixture|fake|mock|synthetic|localhost|loopback)/iu;
const OPTION_KEYS = Object.freeze([
  "browserVersions",
  "captureConcurrency",
  "collectDatasetReceipt",
  "observeDeployment",
  "observeServerFlow",
  "outputDirectory",
  "plan",
  "resolveScenarioBinding",
  "resolveScenarioSecrets",
  "reviewImages",
  "signCollectorAttestation",
  "signServerObserverReceipt",
  "temporaryDirectory",
  "trustPolicy",
]);

export const PRODUCTION_G11_CAPTURE_COUNTS = Object.freeze({
  visual: EXPECTED_VISUAL_COUNT,
  flow: EXPECTED_FLOW_TRACE_COUNT,
  total: EXPECTED_CAPTURE_COUNT,
});

export function productionG11CapturePlan() {
  const captures = [];
  for (const browserName of G11_BROWSERS) {
    for (const state of G11_VISUAL_STATES) {
      for (const viewport of G11_VIEWPORTS) {
        for (const motion of G11_MOTIONS) {
          const traceId = `capture-${browserName}-${state}-${viewport.id}-${motion}`;
          captures.push({
            kind: "visual",
            browserName,
            viewport: structuredClone(viewport),
            motion,
            state,
            flowId: null,
            scenarioId: `visual-${state}`,
            traceId,
            outputRelativePath: `raw/g11/traces/${traceId}.zip`,
          });
        }
      }
    }
  }
  for (const flowId of productionG11FlowIds()) {
    for (const browserName of G11_BROWSERS) {
      for (const viewport of G11_VIEWPORTS) {
        for (const motion of G11_MOTIONS) {
          const traceId = `flow-${flowId}-${browserName}-${viewport.id}-${motion}`;
          captures.push({
            kind: "flow",
            browserName,
            viewport: structuredClone(viewport),
            motion,
            state: null,
            flowId,
            scenarioId: flowId,
            traceId,
            outputRelativePath: `raw/g11/flows/traces/${traceId}.zip`,
          });
        }
      }
    }
  }
  if (captures.length !== EXPECTED_CAPTURE_COUNT
    || captures.filter(({ kind }) => kind === "visual").length !== EXPECTED_VISUAL_COUNT
    || captures.filter(({ kind }) => kind === "flow").length !== EXPECTED_FLOW_TRACE_COUNT
    || new Set(captures.map(({ traceId }) => traceId)).size !== captures.length) {
    throw new Error("protected G11 capture registry does not cover the required 252 independent captures");
  }
  return deepFreeze(captures);
}

export async function collectProductionG11RealStack(options = {}) {
  return collectProductionG11RealStackWithDependencies(options, PRODUCTION_DEPENDENCIES);
}

async function collectProductionG11RealStackWithDependencies(options, dependencies) {
  const input = validateOptions(options);
  validateDependencies(dependencies);
  await dependencies.assertCandidateSource(input.plan.payload.binding.commitSha);

  const paths = await prepareOutputPaths(input);
  let stagingRoot = null;
  try {
    stagingRoot = await mkdtemp(path.join(paths.outputParent, ".g11-staging-"));
    await chmod(stagingRoot, 0o700);
    await createEvidenceDirectories(stagingRoot);

    const startedAtUtc = canonicalNow(dependencies.now, "collection start");
    const planIdentity = Object.freeze({
      planId: input.plan.payload.planId,
      payloadSha256: input.plan.payloadSha256,
    });
    const binding = structuredClone(input.plan.payload.binding);
    const environment = structuredClone(input.plan.payload.environment);
    const evidence = [];

    const toolchain = await readToolchain();
    const harnessReference = await writeArtifact({
      stagingRoot,
      relativePath: "raw/g11/harness/real-stack-browser.mjs",
      kind: "browser-harness-source",
      bytes: toolchain.harness.bytes,
      evidence,
    });
    const collectorReference = await writeArtifact({
      stagingRoot,
      relativePath: "raw/g11/collector/collect-g11-real-stack.mjs",
      kind: "browser-collector-source",
      bytes: toolchain.collector.bytes,
      evidence,
    });

    const deploymentReceipt = await input.observeDeployment(deepFreeze({
      plan: structuredClone(planIdentity),
      binding: structuredClone(binding),
      environment: structuredClone(environment),
      collectionStartedAtUtc: startedAtUtc,
    }));
    const deployment = validateDeploymentReceiptInput({
      receipt: deploymentReceipt,
      planIdentity,
      binding,
      environment,
      startedAtUtc,
      observedBeforeUtc: canonicalNow(dependencies.now, "deployment observation completion"),
    });
    const deploymentReference = await writeJsonArtifact({
      stagingRoot,
      relativePath: "raw/g11/receipts/deployment.json",
      kind: "production-deployment-receipt",
      document: deploymentReceipt,
      evidence,
    });

    const datasetReceipt = await input.collectDatasetReceipt(deepFreeze({
      plan: structuredClone(planIdentity),
      binding: structuredClone(binding),
      environment: structuredClone(environment),
      deployment: structuredClone(deployment),
    }));
    validateDatasetReceipt({ receipt: datasetReceipt, planIdentity, binding, environment });
    const datasetReference = await writeJsonArtifact({
      stagingRoot,
      relativePath: "raw/g11/receipts/synthetic-dataset.json",
      kind: "synthetic-browser-dataset-receipt",
      document: datasetReceipt,
      evidence,
    });

    const captures = productionG11CapturePlan();
    const origins = productionG11OriginPolicy(deployment);
    const captureBindings = await resolveCaptureBindings({
      captures,
      datasetReceipt,
      deployment,
      input,
      planIdentity,
    });
    const captureResults = new Map();
    await mapWithConcurrency(captures, input.captureConcurrency, async (capture) => {
      const scenarioBinding = structuredClone(captureBindings.get(capture.traceId));
      productionG11ScenarioPlan({ scenarioId: capture.scenarioId, scenarioBinding });
      let scenarioSecrets = await input.resolveScenarioSecrets(deepFreeze({
        datasetId: datasetReceipt.datasetId,
        datasetSha256: datasetReceipt.datasetSha256,
        scenarioId: capture.scenarioId,
        traceId: capture.traceId,
        browserName: capture.browserName,
        viewport: structuredClone(capture.viewport),
        motion: capture.motion,
        scenarioBinding: structuredClone(scenarioBinding),
      }));
      try {
        const outputPath = path.join(stagingRoot, capture.outputRelativePath);
        const result = await dependencies.captureTrace({
          browserName: capture.browserName,
          browserVersion: input.browserVersions[capture.browserName],
          evidenceRoot: stagingRoot,
          motion: capture.motion,
          origins,
          outputPath,
          scenarioBinding,
          scenarioId: capture.scenarioId,
          scenarioSecrets,
          temporaryDirectory: paths.temporaryDirectory,
          traceId: capture.traceId,
          viewport: capture.viewport,
        });
        const normalized = await normalizeCaptureResult({
          capture,
          result,
          scenarioBinding,
          browserVersion: input.browserVersions[capture.browserName],
          stagingRoot,
          evidence,
        });
        captureResults.set(capture.traceId, normalized);
      } finally {
        scenarioSecrets = null;
      }
    });
    validateCompleteCaptureResults(captureResults);

    const browsers = G11_BROWSERS.map((name) => ({ name, version: input.browserVersions[name] }));
    const visualMatrix = captures
      .filter(({ kind }) => kind === "visual")
      .map((capture) => buildVisualCell({
        capture,
        captured: captureResults.get(capture.traceId),
        planIdentity,
        binding,
        environment,
        deployment,
        browsers,
      }));
    for (const cell of visualMatrix) {
      cell.receipt = await writeJsonArtifact({
        stagingRoot,
        relativePath: `raw/g11/receipts/${cell.captureId}.json`,
        kind: "browser-cell-receipt",
        document: cell.__receipt,
        evidence,
      });
      delete cell.__receipt;
    }

    const flows = [];
    const observerSignatures = new Set();
    for (const flowId of productionG11FlowIds()) {
      const flowCaptures = captures.filter((capture) => capture.flowId === flowId);
      const flowResult = await buildFlowEvidence({
        flowId,
        captures: flowCaptures,
        captureResults,
        planIdentity,
        binding,
        environment,
        deployment,
        trustPolicy: input.trustPolicy,
        observeServerFlow: input.observeServerFlow,
        signServerObserverReceipt: input.signServerObserverReceipt,
        now: dependencies.now,
      });
      const receiptReference = await writeJsonArtifact({
        stagingRoot,
        relativePath: `raw/g11/flows/${flowId}.json`,
        kind: "browser-flow-receipt",
        document: flowResult.receipt,
        evidence,
      });
      const observerReference = await writeJsonArtifact({
        stagingRoot,
        relativePath: `raw/g11/flows/${flowId}.observer.json`,
        kind: "server-observer-receipt",
        document: flowResult.observerReceipt,
        evidence,
      });
      if (observerSignatures.has(flowResult.observerReceipt.signature.value)) {
        throw new Error("server observer receipts must each carry an independent signature");
      }
      observerSignatures.add(flowResult.observerReceipt.signature.value);
      flows.push({
        flowId,
        status: flowResult.receipt.status,
        scenarioBinding: structuredClone(flowResult.receipt.scenarioBinding),
        checks: structuredClone(flowResult.receipt.checks),
        evidence: [receiptReference, observerReference, ...flowResult.traceReferences],
      });
    }
    if (observerSignatures.size !== productionG11FlowIds().length) {
      throw new Error("G11 collection did not produce 11 independently signed server observer receipts");
    }

    const imageInputs = visualMatrix.flatMap((cell) => [
      imageReviewInput(stagingRoot, cell.screenshot),
      imageReviewInput(stagingRoot, cell.frameBefore),
      imageReviewInput(stagingRoot, cell.frameAfter),
    ]).sort(compareImageInput);
    if (imageInputs.length !== EXPECTED_IMAGE_COUNT
      || new Set(imageInputs.map(({ uri }) => uri)).size !== EXPECTED_IMAGE_COUNT) {
      throw new Error("privacy review input must cover exactly 162 independent image paths");
    }
    const privacyReview = await input.reviewImages(deepFreeze({
      plan: structuredClone(planIdentity),
      binding: structuredClone(binding),
      environment: structuredClone(environment),
      deployment: structuredClone(deployment),
      dataset: structuredClone(datasetReceipt),
      images: structuredClone(imageInputs),
    }));
    validatePrivacyReview({ privacyReview, datasetReceipt, imageInputs, startedAtUtc });
    await assertImagesUnchanged(imageInputs);
    const privacyReference = await writeJsonArtifact({
      stagingRoot,
      relativePath: "raw/g11/receipts/image-privacy-review.json",
      kind: "browser-image-privacy-review",
      document: privacyReview,
      evidence,
    });

    const finishedAtUtc = canonicalNow(dependencies.now, "collection finish");
    assertTimeOrder(startedAtUtc, finishedAtUtc, "G11 collection window");
    for (const flow of flows) {
      const observer = JSON.parse((await readArtifactByReference(stagingRoot, flow.evidence[1])).toString("utf8"));
      assertTimeWithin(observer.signedAtUtc, startedAtUtc, finishedAtUtc, `${flow.flowId} observer signature`);
    }
    const toolchainAfter = await readToolchain();
    if (canonicalJson(toolchainHashes(toolchainAfter)) !== canonicalJson(toolchainHashes(toolchain))) {
      throw new Error("protected G11 toolchain changed during evidence collection");
    }
    await dependencies.assertCandidateSource(input.plan.payload.binding.commitSha);

    const nativeTraceHashes = [...captureResults.values()].map(({ nativeTraceSha256 }) => nativeTraceSha256);
    const sanitizedTraceHashes = [...captureResults.values()].map(({ trace }) => trace.sha256);
    if (new Set(nativeTraceHashes).size !== EXPECTED_CAPTURE_COUNT
      || new Set(sanitizedTraceHashes).size !== EXPECTED_CAPTURE_COUNT) {
      throw new Error("every G11 capture must bind a unique native and sanitized Playwright trace");
    }
    const assertionCount = captures.reduce((sum, capture) => {
      const scenario = productionG11ScenarioPlan({
        scenarioId: capture.scenarioId,
        scenarioBinding: captureBindings.get(capture.traceId),
      });
      return sum + scenario.browserSteps.reduce((stepSum, step) => stepSum + step.assertions.length, 0);
    }, 0);
    validateEvidenceClosureShape(evidence);
    const evidenceClosureSha256 = sha256Canonical({
      schemaVersion: "workbench.production-g11-evidence-closure.v1",
      evidence: structuredClone(evidence).sort(compareEvidence),
    });
    const manifestId = `g11-real-stack-${sha256Canonical({
      plan: planIdentity,
      evidenceClosureSha256,
    }).slice(0, 24)}`;
    const collectorSignedAtUtc = canonicalNow(dependencies.now, "collector signature");
    assertTimeOrder(finishedAtUtc, collectorSignedAtUtc, "collector signature time");
    const collectorAuthority = dedicatedAuthority(
      input.trustPolicy,
      COLLECTOR_SCOPE_ID,
      collectorSignedAtUtc,
    );
    const collectorAttestation = {
      schemaVersion: "workbench.production-g11-collector-attestation.v1",
      scopeId: COLLECTOR_SCOPE_ID,
      signerId: collectorAuthority.signerId,
      signedAtUtc: collectorSignedAtUtc,
      trustPolicySha256: input.trustPolicy.sha256,
      collector: {
        ...toolchainHashes(toolchain),
        sanitizerAlgorithm: "strict-allowlist-v1",
        captureCount: EXPECTED_CAPTURE_COUNT,
        assertionCount,
        unexpectedRuntimeFailureCount: 0,
        nativeTraceCount: EXPECTED_CAPTURE_COUNT,
        nativeTraceDeletedCount: EXPECTED_CAPTURE_COUNT,
      },
      evidenceClosureSha256,
      source: collectorReference,
      dataset: datasetReference,
      privacyReview: privacyReference,
      signature: {
        algorithm: "Ed25519",
        keyId: collectorAuthority.keyId,
        value: "A".repeat(86),
      },
    };
    const manifest = {
      schemaVersion: PRODUCTION_G11_REAL_STACK_SCHEMA_VERSION,
      manifestId,
      plan: structuredClone(planIdentity),
      binding,
      environment,
      deployment: { ...deployment, receipt: deploymentReference },
      harness: {
        name: "playwright",
        version: dependencies.playwrightVersion,
        sourceCommit: input.plan.payload.binding.commitSha,
        routeFulfillUsed: false,
        syntheticSessionUsed: false,
        syntheticApiUsed: false,
        syntheticSseUsed: false,
        source: harnessReference,
        traceCollection: "playwright-sanitized-trace",
      },
      collectorAttestation,
      startedAtUtc,
      finishedAtUtc,
      browsers,
      visualMatrix,
      flows,
      unexpectedConsoleErrors: [],
      unexpectedNetworkFailures: [],
    };
    const collectorPayload = productionG11CollectorAttestationPayload(manifest);
    collectorAttestation.signature.value = await signAndVerify({
      sign: input.signCollectorAttestation,
      payload: collectorPayload,
      authority: collectorAuthority,
      signedAtUtc: collectorSignedAtUtc,
      scopeId: COLLECTOR_SCOPE_ID,
      context: { manifestId },
    });

    const manifestRaw = Buffer.from(canonicalJsonFile(manifest), "utf8");
    const manifestReference = await writeArtifact({
      stagingRoot,
      relativePath: "raw/g11/manifest.json",
      kind: "production-g11-real-stack-manifest",
      bytes: manifestRaw,
      evidence: null,
    });
    const executedAtUtc = canonicalNow(dependencies.now, "manifest verification");
    assertTimeOrder(collectorSignedAtUtc, executedAtUtc, "manifest verification time");
    await dependencies.verifyManifest({
      reference: { uri: MANIFEST_URI, sha256: manifestReference.sha256 },
      evidenceRoot: stagingRoot,
      plan: input.plan,
      executedAtUtc,
      trustPolicy: input.trustPolicy,
    });

    await rename(stagingRoot, paths.outputDirectory);
    stagingRoot = null;
    return deepFreeze({
      outputDirectory: paths.outputDirectory,
      manifestPath: path.join(paths.outputDirectory, "raw/g11/manifest.json"),
      manifestReference: {
        kind: "production-g11-real-stack-manifest",
        uri: MANIFEST_URI,
        sha256: manifestReference.sha256,
      },
      captureCounts: structuredClone(PRODUCTION_G11_CAPTURE_COUNTS),
      evidenceCount: evidence.length,
      manifest: structuredClone(manifest),
    });
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    await rm(paths.lockDirectory, { recursive: true, force: true });
  }
}

async function buildFlowEvidence({
  flowId,
  captures,
  captureResults,
  planIdentity,
  binding,
  environment,
  deployment,
  trustPolicy,
  observeServerFlow,
  signServerObserverReceipt,
  now,
}) {
  if (captures.length !== 18) throw new Error(`${flowId} must contain exactly 18 browser captures`);
  const primaryCapture = captureResults.get(captures[0].traceId);
  const scenarioBinding = structuredClone(primaryCapture.scenarioBinding);
  const scenario = productionG11ScenarioPlan({ scenarioId: flowId, scenarioBinding });
  const coverage = captures.map((capture) => {
    const result = captureResults.get(capture.traceId);
    const captureScenario = productionG11ScenarioPlan({
      scenarioId: flowId,
      scenarioBinding: result.scenarioBinding,
    });
    return {
      browser: capture.browserName,
      browserVersion: result.browserVersion,
      viewport: capture.viewport.id,
      motion: capture.motion,
      traceId: capture.traceId,
      scenarioBinding: structuredClone(result.scenarioBinding),
      scenarioPlanSha256: productionG11ScenarioPlanSha256({
        scenarioId: flowId,
        scenarioBinding: result.scenarioBinding,
      }),
      nativeTraceSha256: result.nativeTraceSha256,
      startedAtUtc: result.startedAtUtc,
      finishedAtUtc: result.finishedAtUtc,
      status: "PASS",
      steps: captureScenario.browserSteps.map(({ stepId, actionId, apiName }) => ({
        stepId,
        actionId,
        apiName,
        status: "PASS",
        observedAtUtc: result.finishedAtUtc,
      })),
      consoleCaptureComplete: true,
      networkCaptureComplete: true,
      runtimeCaptureComplete: true,
      unexpectedConsoleErrorCount: 0,
      unexpectedNetworkFailureCount: 0,
      unexpectedRuntimeFailureCount: 0,
      trace: result.trace,
    };
  });
  const startedAtUtc = coverage.map(({ startedAtUtc: value }) => value).sort()[0];
  const latestTraceFinishedAtUtc = coverage.map(({ finishedAtUtc: value }) => value).sort().at(-1);
  const observation = await observeServerFlow(deepFreeze({
    plan: structuredClone(planIdentity),
    binding: structuredClone(binding),
    environment: structuredClone(environment),
    deployment: structuredClone(deployment),
    flowId,
    scenarioId: flowId,
    scenarioBinding: structuredClone(scenarioBinding),
    scenarioPlanSha256: productionG11ScenarioPlanSha256({ scenarioId: flowId, scenarioBinding }),
    coverage: structuredClone(coverage),
    traceWindow: { startedAtUtc, finishedAtUtc: latestTraceFinishedAtUtc },
    observerCheckIds: structuredClone(scenario.observerCheckIds),
  }));
  const observerChecks = validateObserverResult({
    value: observation,
    coverage,
    expectedCheckIds: scenario.observerCheckIds,
    flowId,
    latestTraceFinishedAtUtc,
  });
  const browserChecks = passingBrowserChecks(flowId);
  const checks = Object.fromEntries((productionG11FlowCheckSpec(flowId)?.keys ?? []).map((checkId) => [
    checkId,
    Object.hasOwn(browserChecks, checkId) ? browserChecks[checkId] : observerChecks[checkId],
  ]));
  const status = productionG11FlowChecksPass(flowId, checks) ? "PASS" : "FAIL";
  const receipt = {
    schemaVersion: "workbench.production-g11-flow-evidence.v3",
    receiptId: `flow-receipt-${flowId}`,
    plan: structuredClone(planIdentity),
    binding: structuredClone(binding),
    environment: structuredClone(environment),
    deployment: structuredClone(deployment),
    flowId,
    startedAtUtc,
    finishedAtUtc: observation.observedAtUtc,
    status,
    scenarioBinding: structuredClone(scenarioBinding),
    checks,
    renderedStates: productionG11RenderedStates(flowId),
    coverage,
  };
  const observerSignedAtUtc = canonicalNow(now, `${flowId} observer signature`);
  assertTimeOrder(observation.observedAtUtc, observerSignedAtUtc, `${flowId} observer signature`);
  const observerAuthority = dedicatedAuthority(
    trustPolicy,
    SERVER_OBSERVER_SCOPE_ID,
    observerSignedAtUtc,
  );
  const observerReceipt = {
    schemaVersion: "workbench.production-g11-server-observer-receipt.v2",
    receiptId: `server-observer-${flowId}`,
    plan: structuredClone(planIdentity),
    binding: structuredClone(binding),
    environment: structuredClone(environment),
    deployment: structuredClone(deployment),
    scenarioId: flowId,
    scenarioBinding: structuredClone(scenarioBinding),
    scenarioPlanSha256: productionG11ScenarioPlanSha256({ scenarioId: flowId, scenarioBinding }),
    originPolicySha256: productionG11OriginPolicySha256(deployment),
    flowId,
    coverage: structuredClone(coverage),
    captureObservations: structuredClone(observation.captureObservations),
    checks: structuredClone(observerChecks),
    observedAtUtc: observation.observedAtUtc,
    signedAtUtc: observerSignedAtUtc,
    trustPolicySha256: trustPolicy.sha256,
    scopeId: SERVER_OBSERVER_SCOPE_ID,
    signerId: observerAuthority.signerId,
    signature: { algorithm: "Ed25519", keyId: observerAuthority.keyId, value: "A".repeat(86) },
  };
  observerReceipt.signature.value = await signAndVerify({
    sign: signServerObserverReceipt,
    payload: productionG11ServerObserverReceiptPayload(observerReceipt),
    authority: observerAuthority,
    signedAtUtc: observerSignedAtUtc,
    scopeId: SERVER_OBSERVER_SCOPE_ID,
    context: { flowId },
  });
  return {
    receipt,
    observerReceipt,
    traceReferences: coverage.map(({ trace }) => trace),
  };
}

async function normalizeCaptureResult({
  capture,
  result,
  scenarioBinding,
  browserVersion,
  stagingRoot,
  evidence,
}) {
  if (!result || !SHA256_PATTERN.test(result.nativeTraceSha256 ?? "")
    || !SHA256_PATTERN.test(result.sanitizedTraceSha256 ?? "")
    || !validUtc(result.startedAtUtc) || !validUtc(result.finishedAtUtc)
    || new Date(result.finishedAtUtc) < new Date(result.startedAtUtc)) {
    throw new Error(`${capture.traceId} returned an invalid browser capture identity`);
  }
  for (const key of [
    "unexpectedConsoleErrorCount", "unexpectedNetworkFailureCount", "unexpectedRuntimeFailureCount",
  ]) {
    if (result[key] !== 0) {
      throw new Error(`${capture.traceId} contains an unexpected ${key}`);
    }
  }
  const trace = await referenceExistingArtifact({
    stagingRoot,
    relativePath: capture.outputRelativePath,
    kind: "playwright-sanitized-trace",
    evidence,
  });
  if (trace.sha256 !== result.sanitizedTraceSha256) {
    throw new Error(`${capture.traceId} sanitized trace hash differs from the collector result`);
  }
  let visual = null;
  if (capture.kind === "visual") {
    visual = await materializeVisualEvidence({ capture, result: result.visualEvidence, stagingRoot, evidence });
  } else if (result.visualEvidence !== null && result.visualEvidence !== undefined) {
    throw new Error(`${capture.traceId} unexpectedly returned visual evidence for a flow trace`);
  }
  return deepFreeze({
    browserVersion,
    nativeTraceSha256: result.nativeTraceSha256,
    startedAtUtc: result.startedAtUtc,
    finishedAtUtc: result.finishedAtUtc,
    scenarioBinding: structuredClone(scenarioBinding),
    trace,
    visual,
  });
}

async function materializeVisualEvidence({ capture, result, stagingRoot, evidence }) {
  if (!result || typeof result !== "object") throw new Error(`${capture.traceId} did not return visual evidence`);
  const key = `${capture.browserName}-${capture.state}-${capture.viewport.id}-${capture.motion}`;
  const expectedSourceDirectory = path.join(
    stagingRoot,
    path.dirname(capture.outputRelativePath),
    `.g11-visual-${capture.traceId}`,
  );
  const specs = [
    ["screenshot", "screenshot.png", `raw/g11/screenshots/${key}.png`, "browser-screenshot"],
    ["frameBefore", "frame-before.png", `raw/g11/frames/${key}-before.png`, "browser-motion-frame"],
    ["frameAfter", "frame-after.png", `raw/g11/frames/${key}-after.png`, "browser-motion-frame"],
  ];
  const references = {};
  for (const [property, sourceName, relativePath, kind] of specs) {
    const source = result[property];
    if (!source || typeof source.path !== "string" || !path.isAbsolute(source.path)
      || !SHA256_PATTERN.test(source.sha256 ?? "")
      || path.resolve(source.path) !== path.join(expectedSourceDirectory, sourceName)) {
      throw new Error(`${capture.traceId} ${property} descriptor is invalid`);
    }
    assertPathWithin(stagingRoot, source.path, `${capture.traceId} ${property}`);
    const bytes = await readStableRegularFile(source.path, `${capture.traceId} ${property}`);
    if (sha256Bytes(bytes) !== source.sha256) throw new Error(`${capture.traceId} ${property} hash mismatch`);
    references[property] = await writeArtifact({ stagingRoot, relativePath, kind, bytes, evidence });
  }
  await rm(expectedSourceDirectory, { recursive: true, force: true });
  const targetBounds = normalizeBounds(result.layout?.targetBounds ?? result.targetBounds, capture.viewport);
  const framePixelDiffRatio = Number(result.framePixelDiffRatio);
  if (!Number.isFinite(framePixelDiffRatio) || framePixelDiffRatio < 0 || framePixelDiffRatio > 1) {
    throw new Error(`${capture.traceId} framePixelDiffRatio is invalid`);
  }
  return deepFreeze({
    ...references,
    targetSelector: result.targetSelector,
    framePixelDiffRatio,
    targetBounds,
    computedStyle: structuredClone(result.computedStyle),
    runState: result.runState ? structuredClone(result.runState) : null,
    sampleIntervalMs: result.sampleIntervalMs,
    layout: {
      withinViewport: result.layout?.withinViewport === true,
      noOverlap: result.layout?.noOverlap === true,
      promptContextVisible: result.layout?.promptContextVisible === true,
      activityContextVisible: result.layout?.activityContextVisible === true,
      pendingCompositionVisible: result.layout?.pendingCompositionVisible === true,
      accessibleNamesPassed: result.layout?.accessibleNamesPassed === true,
    },
  });
}

function buildVisualCell({ capture, captured, planIdentity, binding, environment, deployment, browsers }) {
  const visual = captured.visual;
  const semanticKind = capture.state === "prototype-after-prd" ? "prototype" : "prd";
  const expectedRunState = {
    requestedArtifactKinds: [semanticKind],
    generationStage: semanticKind === "prototype" ? "generating-ui" : "drafting-prd",
    terminal: false,
  };
  const runState = visual.runState ?? expectedRunState;
  const style = visual.computedStyle?.before
    ?? visual.computedStyle?.pseudoElement
    ?? visual.computedStyle
    ?? {};
  const animationName = typeof style.animationName === "string" && style.animationName.length > 0
    ? style.animationName
    : "none";
  const animationDurationMs = Number.isFinite(style.animationDurationMs)
    ? Number(style.animationDurationMs)
    : parseCssDurationMs(style.animationDuration);
  const sampleIntervalMs = Number.isInteger(visual.sampleIntervalMs)
    ? visual.sampleIntervalMs
    : 180;
  const motionEvidence = {
    semanticKind,
    animationName,
    animationDurationMs,
    reducedMotionMedia: capture.motion === "reduced",
    targetSelector: visual.targetSelector,
    sampleIntervalMs,
  };
  const motionPassed = capture.motion === "normal"
    ? visual.framePixelDiffRatio >= NORMAL_MOTION_PIXEL_THRESHOLD
    : visual.framePixelDiffRatio <= REDUCED_MOTION_PIXEL_THRESHOLD;
  const traceReference = captured.trace;
  const cell = {
    browser: capture.browserName,
    captureId: capture.traceId,
    capturedAtUtc: captured.finishedAtUtc,
    viewport: capture.viewport.id,
    motion: capture.motion,
    state: capture.state,
    status: motionPassed ? "PASS" : "FAIL",
    scenarioBinding: structuredClone(captured.scenarioBinding),
    runState,
    motionEvidence,
    layout: visual.layout,
    screenshot: visual.screenshot,
    frameBefore: visual.frameBefore,
    frameAfter: visual.frameAfter,
    receipt: null,
    trace: traceReference,
  };
  cell.__receipt = {
    schemaVersion: "workbench.production-g11-browser-cell-receipt.v2",
    captureId: cell.captureId,
    plan: structuredClone(planIdentity),
    binding: structuredClone(binding),
    environment: structuredClone(environment),
    deployment: structuredClone(deployment),
    browser: browsers.find(({ name }) => name === capture.browserName),
    viewport: structuredClone(capture.viewport),
    motion: capture.motion,
    state: capture.state,
    capturedAtUtc: cell.capturedAtUtc,
    targetSelector: motionEvidence.targetSelector,
    runState: structuredClone(runState),
    motionEvidence: structuredClone(motionEvidence),
    layout: structuredClone(visual.layout),
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
    targetBounds: visual.targetBounds,
    framePixelDiffRatio: visual.framePixelDiffRatio,
    traceStartedAtUtc: captured.startedAtUtc,
    traceFinishedAtUtc: captured.finishedAtUtc,
    nativeTraceSha256: captured.nativeTraceSha256,
    screenshot: visual.screenshot,
    frameBefore: visual.frameBefore,
    frameAfter: visual.frameAfter,
    trace: traceReference,
    scenarioBinding: structuredClone(captured.scenarioBinding),
  };
  return cell;
}

function passingBrowserChecks(flowId) {
  const spec = productionG11FlowCheckSpec(flowId);
  if (!spec) throw new Error(`${flowId} is not a protected G11 flow`);
  const checks = Object.fromEntries(spec.browserCheckIds.map((checkId) => [checkId, true]));
  if (flowId === "mixed-rejection") {
    Object.assign(checks, { problemStatus: 400, runCount: 0, sseEventCount: 0 });
  }
  return checks;
}

function validateObserverResult({ value, coverage, expectedCheckIds, flowId, latestTraceFinishedAtUtc }) {
  exactKeys(value, ["captureObservations", "observedAtUtc"], "server observer result");
  if (!validUtc(value.observedAtUtc)) throw new Error("server observer result observedAtUtc is invalid");
  assertTimeOrder(latestTraceFinishedAtUtc, value.observedAtUtc, "server observation time");
  if (!Array.isArray(value.captureObservations) || value.captureObservations.length !== coverage.length) {
    throw new Error("server observer result must cover all 18 capture bindings");
  }
  const observations = new Map();
  for (const captureObservation of value.captureObservations) {
    exactKeys(captureObservation, [
      "traceId", "scenarioBinding", "scenarioPlanSha256", "checks",
    ], "server observer capture result");
    if (observations.has(captureObservation.traceId)) {
      throw new Error("server observer result contains a duplicate capture binding");
    }
    if (!captureObservation.checks || typeof captureObservation.checks !== "object"
      || Array.isArray(captureObservation.checks)
      || canonicalJson(Object.keys(captureObservation.checks).sort())
        !== canonicalJson([...expectedCheckIds].sort())) {
      throw new Error("server observer capture checks do not match the protected observer partition");
    }
    for (const check of Object.values(captureObservation.checks)) {
      if (typeof check !== "boolean" && (!Number.isInteger(check) || check < 0)) {
        throw new Error("server observer checks must contain only booleans or non-negative integers");
      }
    }
    observations.set(captureObservation.traceId, captureObservation);
  }
  for (const captured of coverage) {
    const observed = observations.get(captured.traceId);
    if (!observed
      || !canonicalEqual(observed.scenarioBinding, captured.scenarioBinding)
      || observed.scenarioPlanSha256 !== captured.scenarioPlanSha256) {
      throw new Error("server observer result does not bind every browser capture identity");
    }
  }
  return aggregateObserverChecks(flowId, value.captureObservations, expectedCheckIds);
}

function aggregateObserverChecks(flowId, captureObservations, expectedCheckIds) {
  return Object.fromEntries(expectedCheckIds.map((checkId) => {
    const values = captureObservations.map(({ checks }) => checks[checkId]);
    if (values.every((value) => typeof value === "boolean")) {
      return [checkId, values.every((value) => value === true)];
    }
    if (!values.every((value) => Number.isInteger(value) && value >= 0)) {
      throw new Error("server observer checks change type across capture bindings");
    }
    const aggregate = flowId === "long-run-7686-plus"
      ? Math.min(...values)
      : values.reduce((sum, value) => sum + value, 0);
    return [checkId, aggregate];
  }));
}

function validateDeploymentReceiptInput({
  receipt,
  planIdentity,
  binding,
  environment,
  startedAtUtc,
  observedBeforeUtc,
}) {
  exactKeys(receipt, [
    "schemaVersion", "receiptId", "plan", "binding", "environment", "deployment", "observedAtUtc", "tls",
  ], "deployment receipt");
  if (receipt.schemaVersion !== "workbench.production-g11-deployment-receipt.v2"
    || !IDENTIFIER_PATTERN.test(receipt.receiptId ?? "")
    || !canonicalEqual(receipt.plan, planIdentity)
    || !canonicalEqual(receipt.binding, binding)
    || !canonicalEqual(receipt.environment, environment)
    || receipt.tls?.webVerified !== true || receipt.tls?.previewVerified !== true
    || !canonicalEqual(Object.keys(receipt.tls ?? {}).sort(), ["previewVerified", "webVerified"])) {
    throw new Error("deployment receipt is not bound to the frozen production candidate and verified TLS endpoints");
  }
  assertTimeWithin(receipt.observedAtUtc, startedAtUtc, observedBeforeUtc, "deployment receipt");
  const deployment = receipt.deployment;
  exactKeys(deployment, [
    "stackKind", "webOrigin", "previewOrigin", "approvedThirdPartyOrigins", "provider", "sessionBoundary",
    "apiBoundary", "sseBoundary", "queueBoundary", "databaseBoundary", "artifactBoundary",
  ], "deployment identity");
  exactKeys(deployment.provider, ["class", "id", "version"], "deployment provider");
  if (deployment.stackKind !== "deployed-production"
    || deployment.provider.class !== "approved-production-provider"
    || !IDENTIFIER_PATTERN.test(deployment.provider.id ?? "")
    || typeof deployment.provider.version !== "string" || deployment.provider.version.length < 1
    || deployment.sessionBoundary !== "better-auth"
    || deployment.apiBoundary !== "workbench-api"
    || deployment.sseBoundary !== "workbench-sse"
    || deployment.queueBoundary !== "pg-boss"
    || deployment.databaseBoundary !== "postgresql"
    || deployment.artifactBoundary !== "immutable-artifact-version"
    || FORBIDDEN_PRODUCTION_MARKER.test(canonicalJson(deployment))) {
    throw new Error("deployment receipt does not identify an approved real production stack");
  }
  productionG11OriginPolicy(deployment);
  return structuredClone(deployment);
}

function validateDatasetReceipt({ receipt, planIdentity, binding, environment }) {
  exactKeys(receipt, [
    "schemaVersion", "datasetId", "datasetSha256", "classification", "plan", "binding", "environment",
    "productionDataUsed", "sensitiveSourceDataUsed",
  ], "dataset receipt");
  if (receipt.schemaVersion !== "workbench.production-g11-synthetic-dataset-receipt.v1"
    || !IDENTIFIER_PATTERN.test(receipt.datasetId ?? "")
    || !SHA256_PATTERN.test(receipt.datasetSha256 ?? "")
    || receipt.classification !== "isolated-synthetic"
    || !canonicalEqual(receipt.plan, planIdentity)
    || !canonicalEqual(receipt.binding, binding)
    || !canonicalEqual(receipt.environment, environment)
    || receipt.productionDataUsed !== false
    || receipt.sensitiveSourceDataUsed !== false) {
    throw new Error("dataset receipt does not prove an isolated synthetic dataset bound to the candidate");
  }
}

function validatePrivacyReview({ privacyReview, datasetReceipt, imageInputs, startedAtUtc }) {
  exactKeys(privacyReview, [
    "schemaVersion", "reviewId", "reviewedAtUtc", "datasetSha256", "scanner", "status", "images",
  ], "privacy review");
  exactKeys(privacyReview.scanner, ["name", "version", "rulesSha256"], "privacy scanner");
  if (privacyReview.schemaVersion !== "workbench.production-g11-browser-image-privacy-review.v1"
    || !IDENTIFIER_PATTERN.test(privacyReview.reviewId ?? "")
    || !validUtc(privacyReview.reviewedAtUtc)
    || new Date(privacyReview.reviewedAtUtc) < new Date(startedAtUtc)
    || privacyReview.datasetSha256 !== datasetReceipt.datasetSha256
    || privacyReview.status !== "PASS"
    || !IDENTIFIER_PATTERN.test(privacyReview.scanner?.name ?? "")
    || typeof privacyReview.scanner?.version !== "string" || privacyReview.scanner.version.length < 1
    || !SHA256_PATTERN.test(privacyReview.scanner?.rulesSha256 ?? "")) {
    throw new Error("privacy review identity, scanner, dataset binding, or status is invalid");
  }
  if (!Array.isArray(privacyReview.images) || privacyReview.images.length !== EXPECTED_IMAGE_COUNT) {
    throw new Error("privacy review must contain exactly 162 image results");
  }
  const expected = imageInputs.map(({ uri, sha256 }) => ({ uri, sha256 })).sort(compareEvidenceReference);
  const actual = [];
  for (const image of privacyReview.images) {
    exactKeys(image, [
      "uri", "sha256", "ocrScanComplete", "secretMatches", "sensitiveContentMatches",
      "unapprovedTextMatches", "redactionApplied", "securityReview",
    ], "privacy image result");
    actual.push({ uri: image.uri, sha256: image.sha256 });
    if (image.ocrScanComplete !== true || image.secretMatches !== 0
      || image.sensitiveContentMatches !== 0 || image.unapprovedTextMatches !== 0
      || image.redactionApplied !== false || image.securityReview !== "PASS") {
      throw new Error("privacy review did not prove zero disclosure for every captured image");
    }
  }
  if (!canonicalEqual(actual.sort(compareEvidenceReference), expected)) {
    throw new Error("privacy review image closure differs from the 162 captured image artifacts");
  }
}

async function signAndVerify({ sign, payload, authority, signedAtUtc, scopeId, context }) {
  if (!payload) throw new Error(`${scopeId} signing payload is unavailable`);
  const canonicalPayload = canonicalJson(payload);
  const signature = await sign(deepFreeze({
    scopeId,
    signerId: authority.signerId,
    keyId: authority.keyId,
    signedAtUtc,
    payload: canonicalPayload,
    ...context,
  }));
  if (!SIGNATURE_PATTERN.test(signature ?? "")) throw new Error(`${scopeId} signer returned an invalid signature`);
  if (!verifyTrustedEd25519Signature({ key: authority.key, payload: canonicalPayload, signature })) {
    throw new Error(`${scopeId} signer returned a signature that does not verify against the trust policy`);
  }
  return signature;
}

function dedicatedAuthority(trustPolicy, scopeId, signedAtUtc) {
  const matches = trustPolicy.receiptAuthorities.filter((entry) => entry.scopeId === scopeId);
  if (matches.length !== 1) throw new Error(`${scopeId} must have exactly one external trust authority`);
  const authority = resolveReceiptAuthority(trustPolicy, {
    scopeId,
    keyId: matches[0].keyId,
    signedAt: new Date(signedAtUtc),
  });
  if (trustPolicy.approvalAuthorities.some(({ keyId }) => keyId === authority.keyId)
    || trustPolicy.receiptAuthorities.some(({ scopeId: otherScope, keyId }) => (
      otherScope !== scopeId && keyId === authority.keyId
    ))) {
    throw new Error(`${scopeId} must use a dedicated signing key`);
  }
  return authority;
}

function validateOptions(options) {
  exactKeys(options, OPTION_KEYS.filter((key) => key !== "captureConcurrency"), "collector options", {
    optional: ["captureConcurrency"],
  });
  const captureConcurrency = options.captureConcurrency ?? DEFAULT_CAPTURE_CONCURRENCY;
  if (!Number.isInteger(captureConcurrency) || captureConcurrency < 1 || captureConcurrency > MAX_CAPTURE_CONCURRENCY) {
    throw new Error(`captureConcurrency must be between 1 and ${MAX_CAPTURE_CONCURRENCY}`);
  }
  if (!options.plan?.payload || !COMMIT_PATTERN.test(options.plan.payload.binding?.commitSha ?? "")
    || !validUtc(options.plan.payload.createdAtUtc)
    || !IDENTIFIER_PATTERN.test(options.plan.payload.planId ?? "")
    || !SHA256_PATTERN.test(options.plan.payloadSha256 ?? "")) {
    throw new Error("collector requires a valid frozen production acceptance plan");
  }
  if (options.trustPolicy?.environmentId !== options.plan.payload.binding.environmentId
    || !SHA256_PATTERN.test(options.trustPolicy?.sha256 ?? "")
    || !(options.trustPolicy?.keys instanceof Map)
    || !Array.isArray(options.trustPolicy?.approvalAuthorities)
    || !Array.isArray(options.trustPolicy?.receiptAuthorities)) {
    throw new Error("collector requires the loaded external production trust policy for the plan environment");
  }
  verifyProductionDeploymentRuntimeBinding(options.plan.payload.deploymentConfig, {
    environmentId: options.plan.payload.binding.environmentId,
    trustPolicy: options.trustPolicy,
  });
  exactKeys(options.browserVersions, G11_BROWSERS, "browserVersions");
  for (const browserName of G11_BROWSERS) {
    const version = options.browserVersions[browserName];
    if (typeof version !== "string" || version.length < 1 || version.length > 256
      || FORBIDDEN_PRODUCTION_MARKER.test(version)) {
      throw new Error(`${browserName} browserVersion is invalid`);
    }
  }
  for (const callback of [
    "collectDatasetReceipt", "observeDeployment", "observeServerFlow", "resolveScenarioBinding",
    "resolveScenarioSecrets", "reviewImages", "signCollectorAttestation", "signServerObserverReceipt",
  ]) {
    if (typeof options[callback] !== "function") throw new Error(`${callback} must be an explicit production callback`);
  }
  for (const [key, value] of [
    ["outputDirectory", options.outputDirectory],
    ["temporaryDirectory", options.temporaryDirectory],
  ]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  }
  return { ...options, captureConcurrency };
}

async function resolveCaptureBindings({ captures, datasetReceipt, deployment, input, planIdentity }) {
  const bindings = new Map();
  for (const capture of captures) {
    const resolved = await input.resolveScenarioBinding(deepFreeze({
      datasetId: datasetReceipt.datasetId,
      datasetSha256: datasetReceipt.datasetSha256,
      plan: structuredClone(planIdentity),
      deployment: structuredClone(deployment),
      scenarioId: capture.scenarioId,
      traceId: capture.traceId,
      browserName: capture.browserName,
      viewport: structuredClone(capture.viewport),
      motion: capture.motion,
    }));
    const scenarioBinding = structuredClone(resolved);
    productionG11ScenarioPlan({ scenarioId: capture.scenarioId, scenarioBinding });
    bindings.set(capture.traceId, deepFreeze(scenarioBinding));
  }
  assertIndependentCaptureBindings(captures, bindings);
  return bindings;
}

function assertIndependentCaptureBindings(captures, bindings) {
  if (bindings.size !== captures.length) {
    throw new Error("every G11 capture must resolve exactly one scenario binding");
  }
  const protectedIdentityKeys = ["projectId", "threadId", "deniedProjectId", "runId", "artifactVersionId"];
  const identities = new Map(protectedIdentityKeys.map((key) => [key, new Map()]));
  for (const capture of captures) {
    const scenarioBinding = bindings.get(capture.traceId);
    for (const key of protectedIdentityKeys) {
      const value = scenarioBinding[key];
      if (value === undefined) continue;
      const previousTraceId = identities.get(key).get(value);
      if (previousTraceId) {
        throw new Error(
          `G11 captures ${previousTraceId} and ${capture.traceId} reuse ${key}; every capture requires isolated mutable resources`,
        );
      }
      identities.get(key).set(value, capture.traceId);
    }
  }
}

function validateDependencies(value) {
  exactKeys(value, ["assertCandidateSource", "captureTrace", "now", "playwrightVersion", "verifyManifest"], "collector dependencies");
  for (const key of ["assertCandidateSource", "captureTrace", "now", "verifyManifest"]) {
    if (typeof value[key] !== "function") throw new Error(`collector dependency ${key} is invalid`);
  }
  if (typeof value.playwrightVersion !== "string" || value.playwrightVersion.length < 1) {
    throw new Error("collector Playwright version is invalid");
  }
}

async function prepareOutputPaths(input) {
  const requestedOutputDirectory = path.resolve(input.outputDirectory);
  const requestedOutputParent = path.dirname(requestedOutputDirectory);
  await mkdir(requestedOutputParent, { recursive: true, mode: 0o700 });
  const canonicalOutputParent = await realpath(requestedOutputParent);
  const outputDirectory = path.join(canonicalOutputParent, path.basename(requestedOutputDirectory));
  if (await pathExists(outputDirectory)) throw new Error("outputDirectory must not already exist");
  if (isWithin(repoRoot, outputDirectory)) throw new Error("G11 production evidence output must be outside the source repository");

  await mkdir(input.temporaryDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await realpath(input.temporaryDirectory);
  if (temporaryDirectory !== path.resolve(input.temporaryDirectory)) {
    throw new Error("temporaryDirectory must not traverse a symlink");
  }
  if (isWithin(repoRoot, temporaryDirectory) || isWithin(outputDirectory, temporaryDirectory)) {
    throw new Error("native Playwright traces must remain outside the repository and evidence root");
  }
  const lockDirectory = `${outputDirectory}.g11-collector-lock`;
  await mkdir(lockDirectory, { mode: 0o700 });
  if (await pathExists(outputDirectory)) {
    await rm(lockDirectory, { recursive: true, force: true });
    throw new Error("outputDirectory appeared while the exclusive collector lock was being acquired");
  }
  return { outputDirectory, outputParent: canonicalOutputParent, temporaryDirectory, lockDirectory };
}

async function createEvidenceDirectories(stagingRoot) {
  for (const relativePath of [
    "raw/g11/flows/traces",
    "raw/g11/frames",
    "raw/g11/collector",
    "raw/g11/harness",
    "raw/g11/receipts",
    "raw/g11/screenshots",
    "raw/g11/traces",
  ]) {
    await mkdir(path.join(stagingRoot, relativePath), { recursive: true, mode: 0o700 });
  }
}

async function writeJsonArtifact(input) {
  return writeArtifact({ ...input, bytes: Buffer.from(canonicalJsonFile(input.document), "utf8") });
}

async function writeArtifact({ stagingRoot, relativePath, kind, bytes, evidence }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) throw new Error(`${relativePath} artifact is empty`);
  const target = path.join(stagingRoot, relativePath);
  assertPathWithin(stagingRoot, target, relativePath);
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const reference = Object.freeze({
    kind,
    uri: `file:./${relativePath}`,
    sha256: sha256Bytes(bytes),
  });
  if (evidence) evidence.push(reference);
  return reference;
}

async function referenceExistingArtifact({ stagingRoot, relativePath, kind, evidence }) {
  const target = path.join(stagingRoot, relativePath);
  const bytes = await readStableRegularFile(target, relativePath);
  const reference = Object.freeze({ kind, uri: `file:./${relativePath}`, sha256: sha256Bytes(bytes) });
  evidence.push(reference);
  return reference;
}

async function readArtifactByReference(stagingRoot, reference) {
  const match = /^file:\.\/(raw\/g11\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/u.exec(reference.uri ?? "");
  if (!match) throw new Error("artifact reference URI is invalid");
  const bytes = await readStableRegularFile(path.join(stagingRoot, match[1]), reference.uri);
  if (sha256Bytes(bytes) !== reference.sha256) throw new Error(`${reference.uri} hash changed during collection`);
  return bytes;
}

async function readStableRegularFile(filePath, label) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || after.size !== bytes.length || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`${label} changed while it was being read`);
  }
  return bytes;
}

async function readToolchain() {
  const [collector, harness, schema, verifier, runner] = await Promise.all([
    readStableRegularFile(collectorPath, "protected G11 collector"),
    readStableRegularFile(harnessPath, "protected browser harness"),
    readStableRegularFile(schemaPath, "protected G11 schema"),
    readStableRegularFile(verifierPath, "protected G11 verifier"),
    readStableRegularFile(runnerPath, "protected production control runner"),
  ]);
  return {
    collector: { bytes: collector, sha256: sha256Bytes(collector) },
    harness: { bytes: harness, sha256: sha256Bytes(harness) },
    schema: { bytes: schema, sha256: sha256Bytes(schema) },
    verifier: { bytes: verifier, sha256: sha256Bytes(verifier) },
    runner: { bytes: runner, sha256: sha256Bytes(runner) },
  };
}

function toolchainHashes(value) {
  return {
    collectorSha256: value.collector.sha256,
    harnessSha256: value.harness.sha256,
    schemaSha256: value.schema.sha256,
    verifierSha256: value.verifier.sha256,
    runnerSha256: value.runner.sha256,
  };
}

function imageReviewInput(stagingRoot, reference) {
  const match = /^file:\.\/(raw\/g11\/(?:screenshots|frames)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.png)$/u.exec(reference.uri);
  if (!match) throw new Error("visual artifact reference is outside the privacy review boundary");
  return { uri: reference.uri, sha256: reference.sha256, path: path.join(stagingRoot, match[1]) };
}

async function assertImagesUnchanged(images) {
  for (const image of images) {
    const bytes = await readStableRegularFile(image.path, image.uri);
    if (sha256Bytes(bytes) !== image.sha256) throw new Error(`${image.uri} changed during privacy review`);
  }
}

function validateCompleteCaptureResults(results) {
  if (results.size !== EXPECTED_CAPTURE_COUNT) throw new Error("G11 collection did not complete all 252 captures");
  for (const result of results.values()) {
    if (!result.browserVersion) throw new Error("browser capture did not bind its pinned browser version");
  }
}

function validateEvidenceClosureShape(evidence) {
  const expectedKinds = new Map([
    ["browser-collector-source", 1],
    ["browser-cell-receipt", 54],
    ["browser-flow-receipt", 11],
    ["browser-harness-source", 1],
    ["browser-image-privacy-review", 1],
    ["browser-motion-frame", 108],
    ["browser-screenshot", 54],
    ["playwright-sanitized-trace", 252],
    ["production-deployment-receipt", 1],
    ["server-observer-receipt", 11],
    ["synthetic-browser-dataset-receipt", 1],
  ]);
  const actualKinds = new Map();
  for (const reference of evidence) {
    exactKeys(reference, ["kind", "uri", "sha256"], "G11 evidence reference");
    if (!SHA256_PATTERN.test(reference.sha256 ?? "")
      || !/^file:\.\/raw\/g11\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(reference.uri ?? "")) {
      throw new Error("G11 evidence closure contains an invalid local reference");
    }
    actualKinds.set(reference.kind, (actualKinds.get(reference.kind) ?? 0) + 1);
  }
  if (evidence.length !== 495
    || new Set(evidence.map(({ uri }) => uri)).size !== evidence.length
    || canonicalJson([...actualKinds.entries()].sort()) !== canonicalJson([...expectedKinds.entries()].sort())) {
    throw new Error("G11 evidence closure must contain exactly the protected 495 artifacts");
  }
}

async function mapWithConcurrency(values, limit, operation) {
  let index = 0;
  let firstError = null;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!firstError) {
      const current = index;
      index += 1;
      if (current >= values.length) return;
      try {
        await operation(values[current], current);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
}

function normalizeBounds(value, viewport) {
  if (!value || typeof value !== "object") throw new Error("visual target bounds are missing");
  exactKeys(value, ["x", "y", "width", "height"], "visual target bounds");
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1
    || x + width > viewport.width || y + height > viewport.height) {
    throw new Error("visual target bounds must be an integer region inside the viewport");
  }
  return { x, y, width, height };
}

function parseCssDurationMs(value) {
  if (typeof value !== "string") return 0;
  const first = value.split(",")[0]?.trim() ?? "";
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/u.exec(first);
  if (!match) return 0;
  const duration = Number(match[1]) * (match[2] === "s" ? 1_000 : 1);
  return Number.isFinite(duration) ? duration : 0;
}

function canonicalNow(now, label) {
  const value = now();
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (!validUtc(normalized)) throw new Error(`${label} clock did not return a canonical UTC timestamp`);
  return normalized;
}

function assertTimeWithin(value, minimum, maximum, label) {
  if (!validUtc(value) || new Date(value) < new Date(minimum) || new Date(value) > new Date(maximum)) {
    throw new Error(`${label} is outside its authoritative collection window`);
  }
}

function assertTimeOrder(minimum, maximum, label) {
  if (!validUtc(minimum) || !validUtc(maximum) || new Date(maximum) < new Date(minimum)) {
    throw new Error(`${label} is not monotonically ordered`);
  }
}

function validUtc(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && Number.isFinite(new Date(value).getTime());
}

function exactKeys(value, required, label, { optional = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const requiredSorted = [...required].sort();
  const allowed = new Set([...required, ...optional]);
  if (requiredSorted.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) {
    throw new Error(`${label} must contain only its protected fields`);
  }
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function compareEvidence(left, right) {
  return `${left.uri}\0${left.kind}`.localeCompare(`${right.uri}\0${right.kind}`, "en");
}

function compareEvidenceReference(left, right) {
  return `${left.uri}\0${left.sha256}`.localeCompare(`${right.uri}\0${right.sha256}`, "en");
}

function compareImageInput(left, right) {
  return compareEvidenceReference(left, right);
}

function assertPathWithin(root, candidate, label) {
  if (!isWithin(root, path.resolve(candidate))) throw new Error(`${label} escapes the G11 evidence root`);
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertCandidateSource(commitSha) {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }),
    execFile("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }),
  ]);
  if (head.trim() !== commitSha) throw new Error("collector source checkout differs from the frozen candidate commit");
  if (status.trim() !== "") throw new Error("collector requires a clean candidate checkout");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  assertCandidateSource,
  captureTrace: collectG11SanitizedBrowserTrace,
  now: () => new Date(),
  playwrightVersion: require("playwright/package.json").version,
  verifyManifest: loadProductionG11RealStackManifest,
});

export const __testOnly = Object.freeze({
  collectProductionG11RealStackWithDependencies,
});
