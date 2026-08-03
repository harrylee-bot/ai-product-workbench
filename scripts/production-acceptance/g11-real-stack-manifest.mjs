import { lookup as dnsLookup } from "node:dns/promises";
import { lstat, readFile, realpath } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

import sharp from "sharp";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
  sha256Canonical,
} from "../evidence-ledger.mjs";
import {
  resolveReceiptAuthority,
  verifyTrustedEd25519Signature,
} from "../workbench-production-trust-policy.mjs";
import { ProductionAcceptanceContractError } from "./catalog.mjs";
import {
  G11_BROWSERS as BROWSERS,
  G11_MAX_SSE_RECORDS,
  G11_MOTIONS as MOTIONS,
  G11_RUN_EVENT_NAMES,
  G11_VIEWPORTS as VIEWPORTS,
  G11_VISUAL_STATES as VISUAL_STATES,
  productionG11FlowCheckSpec,
  productionG11FlowChecksPass,
  productionG11FlowIds,
  productionG11OriginPolicy,
  productionG11OriginPolicySha256,
  productionG11RenderedStates as protectedRenderedStates,
  productionG11ScenarioId,
  productionG11ScenarioPlan,
  productionG11ScenarioPlanSha256,
} from "./g11-browser-evidence-contract.mjs";
import { createStrictAjv2020, isCanonicalUtcDateTime } from "./schema.mjs";

export const PRODUCTION_G11_REAL_STACK_SCHEMA_VERSION = "workbench.production-g11-real-stack-manifest.v2";
export const PRODUCTION_G11_REAL_STACK_SCHEMA_PATH = "docs/evidence/production-g11-real-stack-manifest.schema.json";
export const PRODUCTION_G11_MANIFEST_EVIDENCE_KIND = "production-g11-real-stack-manifest";

export const PRODUCTION_G11_REAL_STACK_CONTROL_IDS = Object.freeze([
  "G11.ACCESSIBILITY.REDUCED_MOTION",
  "G11.BROWSER.VIEWPORT_MATRIX",
  "G11.PRODUCT.ACCOUNT_PROJECT",
  "G11.PRODUCT.IMPORT_EXPORT_PREVIEW",
  "G11.PRODUCT.RUN_CANVAS_PROTOTYPE",
  "G11.QUALITY.CONSOLE_ERRORS",
  "G11.QUALITY.FAILED_NETWORK_REQUESTS",
]);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const schemaPath = path.join(repoRoot, PRODUCTION_G11_REAL_STACK_SCHEMA_PATH);
const harnessPath = path.join(moduleDirectory, "g11-browser-evidence-harness.mjs");
const collectorPath = path.join(moduleDirectory, "collect-g11-real-stack.mjs");
const verifierPath = fileURLToPath(import.meta.url);
const runnerPath = path.join(moduleDirectory, "run-control.mjs");
const MANIFEST_URI = "file:./raw/g11/manifest.json";
const FILE_URI_PATTERN = /^file:\.\/(raw\/g11\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/u;
const FORBIDDEN_RUNTIME_MARKER = /(?:controlled|fixture|fake|mock|synthetic|localhost|loopback)/iu;
const FORBIDDEN_HOSTNAME_LABELS = new Set([
  "controlled",
  "fixture",
  "fake",
  "mock",
  "synthetic",
  "localhost",
  "loopback",
]);
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SANITIZED_TRACE_BYTES = 5 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const MIN_TRACE_BYTES = 128;
const MAX_TRACE_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_TRACE_UNCOMPRESSED_BYTES = 5 * 1024 * 1024;
const MAX_FINDINGS = 256;
const EXPECTED_CAPTURE_COUNT = 252;
const EXPECTED_VISUAL_IMAGE_COUNT = 162;
const COLLECTOR_SCOPE_ID = "production-g11.browser-evidence-collector";
const SERVER_OBSERVER_SCOPE_ID = "production-g11.server-observer";
const SANITIZED_SSE_EVENT_NAMES = new Set(G11_RUN_EVENT_NAMES);
const SANITIZED_ROUTE_TEMPLATE_IDS = new Set([
  "projects.bootstrap",
  "project-invitations.accept",
  "threads.submission-intents",
  "unclassified",
]);
const SSE_CAPTURE_SPECS = new Map([
  ["visual-prd-active", { minimumRecords: 1, requiredEventNames: [] }],
  ["visual-prd-pending", { minimumRecords: 1, requiredEventNames: [] }],
  ["visual-prototype-after-prd", { minimumRecords: 1, requiredEventNames: [] }],
  ["prd", { minimumRecords: 2, requiredEventNames: ["run.generation.stage.changed", "run.completed"] }],
  ["mixed-rejection", { minimumRecords: 0, requiredEventNames: [] }],
  ["refresh-reconnect", {
    minimumRecords: 2,
    requiredEventNames: ["run.generation.stage.changed", "run.completed"],
    requiresReconnectCursor: true,
  }],
  ["run-canvas-sse-artifact", {
    minimumRecords: 3,
    requiredEventNames: ["run.started", "artifact.prototype.patch.created", "run.completed"],
  }],
  ["long-run-7686-plus", {
    minimumRecords: 7_686,
    requiredEventNames: ["run.started", "run.completed"],
  }],
  ["provider-state-integrity", {
    minimumRecords: 4,
    requiredEventNames: ["message.delta", "activity.changed", "artifact.draft.created", "artifact.version.created"],
  }],
]);
const COLLECTOR_SIGNATURE_SCHEMA = "workbench.production-g11-collector-attestation-signature.v1";
const G11_BROWSER_HARNESS_SHA256 = "219acbab693a9db411109a18a0053980083fae5ab38b71db55e453163377de5e";
const MIN_SCREENSHOT_ENTROPY = 0.05;
const MIN_NORMAL_FRAME_PIXEL_RATIO = 0.0025;
const MAX_REDUCED_FRAME_PIXEL_RATIO = 0.0001;
const NON_PUBLIC_ADDRESS_BLOCKS = createNonPublicAddressBlockLists();

let schemaValidatorPromise;

export function isProductionG11RealStackControl(controlId) {
  return PRODUCTION_G11_REAL_STACK_CONTROL_IDS.includes(controlId);
}

export function productionG11RenderedStates(flowId) {
  return protectedRenderedStates(flowId);
}

export function productionG11CollectorAttestationPayload(manifest) {
  const subject = structuredClone(manifest);
  if (!subject?.collectorAttestation?.signature) return null;
  subject.collectorAttestation.signature = {
    algorithm: subject.collectorAttestation.signature.algorithm,
    keyId: subject.collectorAttestation.signature.keyId,
  };
  return {
    schemaVersion: COLLECTOR_SIGNATURE_SCHEMA,
    manifest: subject,
  };
}

export function productionG11ServerObserverReceiptPayload(receipt) {
  const subject = structuredClone(receipt);
  if (!subject?.signature) return null;
  subject.signature = {
    algorithm: subject.signature.algorithm,
    keyId: subject.signature.keyId,
  };
  return {
    schemaVersion: "workbench.production-g11-server-observer-signature.v1",
    receipt: subject,
  };
}

export async function loadProductionG11RealStackManifest({
  reference,
  evidenceRoot,
  plan,
  executedAtUtc,
  trustPolicy,
  resolveHostname = dnsLookup,
} = {}) {
  const findings = createBoundedFindings();
  if (reference?.uri !== MANIFEST_URI) findings.push(`G11 execution evidence must be ${MANIFEST_URI}`);
  if (!/^[a-f0-9]{64}$/u.test(reference?.sha256 ?? "")) findings.push("G11 execution evidence SHA-256 is invalid");
  if (!plan?.payload) findings.push("G11 validation requires a frozen production acceptance plan");
  if (!isCanonicalUtcDateTime(executedAtUtc)) findings.push("G11 observation executedAtUtc is invalid");
  if (!trustPolicy?.keys || !Array.isArray(trustPolicy?.receiptAuthorities)) {
    findings.push("G11 validation requires a loaded external production trust policy");
  }
  if (typeof resolveHostname !== "function") findings.push("G11 hostname resolver is invalid");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const root = await canonicalDirectory(evidenceRoot, "G11 evidence root");
  const artifact = await readLocalReference(reference, root, "G11 real-stack manifest", MAX_MANIFEST_BYTES);
  let canonicalManifest;
  try {
    canonicalManifest = canonicalJsonFile(artifact.document);
  } catch (error) {
    throw new ProductionAcceptanceContractError(["G11 real-stack manifest cannot be canonicalized"]);
  }
  if (artifact.bytes.toString("utf8") !== canonicalManifest) {
    throw new ProductionAcceptanceContractError(["G11 real-stack manifest must be canonical JSON with one trailing LF"]);
  }
  const validate = await manifestSchemaValidator();
  if (!validate(artifact.document)) {
    throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
      `G11 real-stack manifest${error.instancePath || "/"} ${error.message}`
    )));
  }

  await validateManifestSemantics({
    manifest: artifact.document,
    plan,
    executedAtUtc,
    trustPolicy,
    resolveHostname,
    findings,
  });

  const evidence = [];
  const verification = {
    visualCells: new Map(),
    flows: new Map(),
    unexpectedConsoleErrorCount: 0,
    unexpectedNetworkFailureCount: 0,
    unexpectedRuntimeFailureCount: 0,
    assertionCount: 0,
  };
  await verifyDeploymentAndHarnessEvidence({
    manifest: artifact.document,
    plan,
    root,
    evidence,
    findings,
  });

  for (const cell of artifact.document.visualMatrix) {
    const verified = await verifyVisualCellEvidence({
      cell,
      manifest: artifact.document,
      plan,
      root,
      trustPolicy,
      evidence,
      findings,
    });
    if (verified) {
      verification.visualCells.set(visualCellKey(cell), verified);
      verification.unexpectedConsoleErrorCount += verified.unexpectedConsoleErrorCount;
      verification.unexpectedNetworkFailureCount += verified.unexpectedNetworkFailureCount;
      verification.unexpectedRuntimeFailureCount += verified.unexpectedRuntimeFailureCount;
      verification.assertionCount += verified.assertionCount;
    }
  }
  validateDistinctVisualStates(verification.visualCells, findings);

  for (const flow of artifact.document.flows) {
    const verified = await verifyFlowEvidence({
      flow,
      manifest: artifact.document,
      plan,
      root,
      trustPolicy,
      evidence,
      findings,
    });
    if (verified) {
      verification.flows.set(flow.flowId, verified);
      verification.unexpectedConsoleErrorCount += verified.unexpectedConsoleErrorCount;
      verification.unexpectedNetworkFailureCount += verified.unexpectedNetworkFailureCount;
      verification.unexpectedRuntimeFailureCount += verified.unexpectedRuntimeFailureCount;
      verification.assertionCount += verified.assertionCount;
    }
  }

  const declaredConsoleErrorCount = artifact.document.unexpectedConsoleErrors
    .reduce((sum, item) => sum + item.count, 0);
  const declaredNetworkFailureCount = artifact.document.unexpectedNetworkFailures
    .reduce((sum, item) => sum + item.count, 0);
  if (declaredConsoleErrorCount !== verification.unexpectedConsoleErrorCount) {
    findings.push("G11 console error summary does not match complete cell and flow capture receipts");
  }
  if (declaredNetworkFailureCount !== verification.unexpectedNetworkFailureCount) {
    findings.push("G11 network failure summary does not match complete cell and flow capture receipts");
  }
  if (verification.unexpectedRuntimeFailureCount !== 0) {
    findings.push("G11 sanitized Playwright traces contain unexpected browser runtime failures");
  }

  verification.privacy = await verifyCollectorPrivacyEvidence({
    manifest: artifact.document,
    plan,
    root,
    evidence,
    findings,
  });
  const uris = evidence.map(({ uri }) => uri);
  if (new Set(uris).size !== uris.length) findings.push("G11 manifest evidence URIs must be unique across the complete closure");
  const traceEvidence = evidence.filter(({ kind }) => kind === "playwright-sanitized-trace");
  const traceHashes = traceEvidence.map(({ sha256 }) => sha256);
  if (new Set(traceHashes).size !== traceHashes.length) {
    findings.push("G11 sanitized Playwright trace archives must be unique for every independent capture");
  }
  const nativeTraceHashes = [
    ...[...verification.visualCells.values()].map(({ nativeTraceSha256 }) => nativeTraceSha256),
    ...[...verification.flows.values()].flatMap(({ nativeTraceSha256Values = [] }) => nativeTraceSha256Values),
  ].filter(validSha256);
  if (nativeTraceHashes.length !== traceHashes.length) {
    findings.push("G11 every sanitized trace must bind one valid native Playwright trace SHA-256");
  }
  if (new Set(nativeTraceHashes).size !== nativeTraceHashes.length) {
    findings.push("G11 native Playwright trace SHA-256 values must be unique for every independent capture");
  }
  await verifyCollectorAttestation({
    manifest: artifact.document,
    plan,
    root,
    executedAtUtc,
    trustPolicy,
    evidence,
    verification,
    nativeTraceHashes,
    findings,
  });
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const derived = deriveProductionG11Values(artifact.document, verification);
  return Object.freeze({
    manifest: artifact.document,
    manifestPath: artifact.path,
    manifestSha256: sha256Bytes(artifact.bytes),
    evidence: Object.freeze(evidence.sort(compareEvidence)),
    derived,
  });
}

export async function assertProductionG11Observation({
  observation,
  evidenceRoot,
  plan,
  trustPolicy,
  resolveHostname,
} = {}) {
  if (!isProductionG11RealStackControl(observation?.controlId)) return null;
  const findings = [];
  const manifestReferences = observation.evidence?.filter(({ kind }) => (
    kind === PRODUCTION_G11_MANIFEST_EVIDENCE_KIND
  )) ?? [];
  if (manifestReferences.length !== 1) {
    throw new ProductionAcceptanceContractError([
      `${observation.controlId} must reference exactly one typed G11 real-stack manifest`,
    ]);
  }
  const loaded = await loadProductionG11RealStackManifest({
    reference: manifestReferences[0],
    evidenceRoot,
    plan,
    executedAtUtc: observation.executedAtUtc,
    trustPolicy,
    resolveHostname,
  });
  const observedValue = loaded.derived.get(observation.controlId);
  if (canonicalJson(observation.result.observedValue) !== canonicalJson(observedValue)) {
    findings.push(`${observation.controlId} observedValue was not derived from its G11 real-stack manifest`);
  }
  const expectedStatus = observedValue === true || observedValue === 0 ? "PASS" : "FAIL";
  if (observation.result.executionStatus !== expectedStatus) {
    findings.push(`${observation.controlId} executionStatus was not derived from its G11 real-stack manifest`);
  }
  const expectedEvidence = [
    {
      kind: PRODUCTION_G11_MANIFEST_EVIDENCE_KIND,
      uri: manifestReferences[0].uri,
      sha256: manifestReferences[0].sha256,
    },
    ...loaded.evidence,
  ].sort(compareEvidence);
  const actualEvidence = structuredClone(observation.evidence).sort(compareEvidence);
  if (canonicalJson(actualEvidence) !== canonicalJson(expectedEvidence)) {
    findings.push(`${observation.controlId} evidence must exactly equal the validated G11 manifest closure`);
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
  return loaded;
}

export function deriveProductionG11Values(manifest, verification) {
  const flowPasses = new Map(manifest.flows.map((flow) => [
    flow.flowId,
    verification?.flows.get(flow.flowId)?.passed === true,
  ]));
  const allVisualCellsPass = verification?.visualCells.size === manifest.visualMatrix.length
    && manifest.visualMatrix.every((cell) => visualCellPasses(
      cell,
      verification.visualCells.get(visualCellKey(cell)),
    ));
  const allFlowsPass = [...flowPasses.values()].every(Boolean);
  const accessibility = manifest.flows.find(({ flowId }) => flowId === "accessibility-preview-security")?.checks;
  const accessibilityPassed = [
    "keyboardPassed",
    "focusPassed",
    "accessibleNamesPassed",
    "contrastPassed",
    "reducedMotionPassed",
  ].every((key) => accessibility?.[key] === true)
    && manifest.visualMatrix.every((cell) => (
      cell.layout.accessibleNamesPassed === true
      && (cell.motion !== "reduced" || reducedMotionCellPasses(
        cell,
        verification?.visualCells.get(visualCellKey(cell)),
      ))
    ));
  const previewSecurityPassed = [
    "previewIndependentOrigin",
    "previewCredentialless",
    "previewAllowSameOriginAbsent",
    "previewNoReferrer",
    "previewCapabilityValidated",
    "previewRpcPassed",
    "previewTimeoutProtected",
    "previewGenerationProtected",
  ].every((key) => accessibility?.[key] === true);
  const consoleErrorCount = verification?.unexpectedConsoleErrorCount ?? Number.POSITIVE_INFINITY;
  const failedRequestCount = verification?.unexpectedNetworkFailureCount ?? Number.POSITIVE_INFINITY;
  const runFlowIds = [
    "prd",
    "mixed-rejection",
    "prototype-after-prd",
    "refresh-reconnect",
    "run-canvas-sse-artifact",
    "long-run-7686-plus",
    "knowledge-null-valid",
    "provider-state-integrity",
  ];
  return Object.freeze(new Map([
    ["G11.ACCESSIBILITY.REDUCED_MOTION", accessibilityPassed],
    ["G11.BROWSER.VIEWPORT_MATRIX", allVisualCellsPass && allFlowsPass],
    ["G11.PRODUCT.ACCOUNT_PROJECT", flowPasses.get("account-project") === true],
    ["G11.PRODUCT.IMPORT_EXPORT_PREVIEW", flowPasses.get("preview-import-export") === true && previewSecurityPassed],
    ["G11.PRODUCT.RUN_CANVAS_PROTOTYPE", runFlowIds.every((flowId) => flowPasses.get(flowId) === true) && allVisualCellsPass],
    ["G11.QUALITY.CONSOLE_ERRORS", consoleErrorCount],
    ["G11.QUALITY.FAILED_NETWORK_REQUESTS", failedRequestCount],
  ]));
}

async function validateManifestSemantics({ manifest, plan, executedAtUtc, trustPolicy, resolveHostname, findings }) {
  const expectedPlan = {
    planId: plan.payload.planId,
    payloadSha256: plan.payloadSha256,
  };
  if (canonicalJson(manifest.plan) !== canonicalJson(expectedPlan)) findings.push("G11 manifest plan binding mismatch");
  if (canonicalJson(manifest.binding) !== canonicalJson(plan.payload.binding)) {
    findings.push("G11 manifest candidate/deploy/image/config/migration/catalog binding mismatch");
  }
  if (canonicalJson(manifest.environment) !== canonicalJson(plan.payload.environment)) {
    findings.push("G11 manifest environment binding mismatch");
  }
  if (trustPolicy?.environmentId !== plan.payload.binding.environmentId) {
    findings.push("G11 external trust policy environment differs from the candidate binding");
  }
  if (manifest.harness.sourceCommit !== plan.payload.binding.commitSha) {
    findings.push("G11 harness sourceCommit differs from the deployed candidate");
  }
  const runtimeIdentity = canonicalJson({
    manifestId: manifest.manifestId,
    planId: plan.payload.planId,
    plannerId: plan.payload.plannerId,
    deployId: plan.payload.binding.deployId,
    environmentId: plan.payload.binding.environmentId,
    tag: plan.payload.binding.tag,
    environment: plan.payload.environment,
    provider: manifest.deployment.provider,
  });
  if (FORBIDDEN_RUNTIME_MARKER.test(runtimeIdentity)) {
    findings.push("G11 production identity contains a controlled-local, synthetic, or fixture marker");
  }
  await validateProductionOrigins(manifest.deployment, resolveHostname, findings);

  const start = new Date(manifest.startedAtUtc);
  const finish = new Date(manifest.finishedAtUtc);
  if (start < new Date(plan.payload.createdAtUtc)) findings.push("G11 manifest predates the frozen plan");
  if (finish < start) findings.push("G11 manifest finishedAtUtc predates startedAtUtc");
  if (finish > new Date(executedAtUtc)) findings.push("G11 manifest finished after the control observation");

  const browserNames = manifest.browsers.map(({ name }) => name).sort(compareStrings);
  if (canonicalJson(browserNames) !== canonicalJson([...BROWSERS].sort(compareStrings))) {
    findings.push("G11 manifest browsers must be exactly Chromium, Firefox, and WebKit");
  }
  for (const browser of manifest.browsers) {
    if (FORBIDDEN_RUNTIME_MARKER.test(browser.version)) findings.push(`${browser.name} version contains a fixture marker`);
  }

  const expectedVisualKeys = [];
  for (const browser of BROWSERS) {
    for (const state of VISUAL_STATES) {
      for (const viewport of VIEWPORTS) {
        for (const motion of MOTIONS) expectedVisualKeys.push(`${browser}/${state}/${viewport.id}/${motion}`);
      }
    }
  }
  const actualVisualKeys = manifest.visualMatrix.map(visualCellKey).sort(compareStrings);
  if (canonicalJson(actualVisualKeys) !== canonicalJson(expectedVisualKeys.sort(compareStrings))) {
    findings.push("G11 visual matrix must contain exactly 54 unique browser/state/viewport/motion cells");
  }
  if (new Set(manifest.visualMatrix.map(({ captureId }) => captureId)).size !== manifest.visualMatrix.length) {
    findings.push("G11 visual matrix captureId values must be unique");
  }
  for (const cell of manifest.visualMatrix) {
    const expectedCaptureId = `capture-${cell.browser}-${cell.state}-${cell.viewport}-${cell.motion}`;
    if (cell.captureId !== expectedCaptureId) findings.push(`${visualCellKey(cell)} captureId is not deterministic`);
  }
  const actualFlowIds = manifest.flows.map(({ flowId }) => flowId).sort(compareStrings);
  const expectedFlowIds = productionG11FlowIds().sort(compareStrings);
  if (canonicalJson(actualFlowIds) !== canonicalJson(expectedFlowIds)) {
    findings.push("G11 manifest flows must exactly cover the protected product/runtime matrix");
  }
  for (const flow of manifest.flows) {
    const spec = productionG11FlowCheckSpec(flow.flowId);
    if (!spec) continue;
    const actualKeys = Object.keys(flow.checks).sort(compareStrings);
    const expectedKeys = [...spec.keys].sort(compareStrings);
    if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) {
      findings.push(`${flow.flowId} checks must exactly match its protected contract`);
      continue;
    }
  }
}

async function validateProductionOrigins(deployment, resolveHostname, findings) {
  let web;
  let preview;
  try {
    web = new URL(deployment.webOrigin);
    preview = new URL(deployment.previewOrigin);
  } catch {
    findings.push("G11 Web and Preview origins must be valid URLs");
    return;
  }
  const approved = Array.isArray(deployment.approvedThirdPartyOrigins)
    ? deployment.approvedThirdPartyOrigins
    : [];
  const origins = [
    ["Web", deployment.webOrigin, web],
    ["Preview", deployment.previewOrigin, preview],
    ...approved.map((value, index) => [`approvedThirdPartyOrigins[${index}]`, value, null]),
  ];
  const originIdentities = new Set();
  for (const [label, value, initialUrl] of origins) {
    let url = initialUrl;
    try {
      url ??= new URL(value);
    } catch {
      findings.push(`G11 ${label} origin must be a valid URL`);
      continue;
    }
    if (url.protocol !== "https:" || value !== url.origin || url.username || url.password || url.search || url.hash
      || url.hostname.endsWith(".")) {
      findings.push(`G11 ${label} origin must be a credential-free canonical HTTPS origin`);
    }
    const identity = canonicalOriginIdentity(url);
    if (originIdentities.has(identity)) findings.push(`G11 ${label} origin must not duplicate another approved origin`);
    originIdentities.add(identity);
    if (isNonProductionHostname(url.hostname)) {
      findings.push(`G11 ${label} origin must not be local, reserved, private, or documentation-only`);
      continue;
    }
    const normalizedHostname = normalizeHostname(url.hostname);
    if (isIP(normalizedHostname)) continue;
    try {
      const resolved = await resolveHostname(normalizedHostname, { all: true, verbatim: true });
      if (!Array.isArray(resolved) || resolved.length < 1
        || resolved.some(({ address }) => isNonPublicAddress(address))) {
        findings.push(`G11 ${label} origin DNS must resolve only to globally routable addresses`);
      }
    } catch {
      findings.push(`G11 ${label} origin DNS resolution failed`);
    }
  }
  if (canonicalOriginIdentity(web) === canonicalOriginIdentity(preview)) {
    findings.push("G11 Web and Preview origins must be distinct");
  }
  try {
    productionG11OriginPolicy(deployment);
  } catch {
    findings.push("G11 deployment origin policy is incomplete");
  }
}

function visualCellPasses(cell, verified) {
  const expectedKind = cell.state === "prototype-after-prd" ? "prototype" : "prd";
  const expectedPending = cell.state === "prd-pending";
  const layoutPassed = cell.layout.withinViewport === true
    && cell.layout.noOverlap === true
    && cell.layout.promptContextVisible === true
    && cell.layout.activityContextVisible === true
    && cell.layout.pendingCompositionVisible === expectedPending
    && cell.layout.accessibleNamesPassed === true;
  const statePassed = canonicalJson(cell.runState.requestedArtifactKinds) === canonicalJson([expectedKind])
    && cell.runState.terminal === false
    && cell.motionEvidence.semanticKind === expectedKind
    && cell.motionEvidence.animationName !== "none";
  const motionPassed = cell.motion === "reduced"
    ? reducedMotionCellPasses(cell, verified)
    : cell.motionEvidence.reducedMotionMedia === false
      && cell.motionEvidence.animationDurationMs > 1
      && verified?.framePixelDiffRatio >= MIN_NORMAL_FRAME_PIXEL_RATIO;
  return layoutPassed && statePassed && motionPassed && verified?.passed === true;
}

function reducedMotionCellPasses(cell, verified) {
  return cell.motionEvidence.reducedMotionMedia === true
    && cell.motionEvidence.animationDurationMs <= 1
    && verified?.framePixelDiffRatio <= MAX_REDUCED_FRAME_PIXEL_RATIO;
}

function flowPassesChecks(flow) {
  return productionG11FlowChecksPass(flow.flowId, flow.checks);
}

async function verifyDeploymentAndHarnessEvidence({ manifest, plan, root, evidence, findings }) {
  const deploymentArtifact = await readExpectedReference({
    reference: manifest.deployment.receipt,
    kind: "production-deployment-receipt",
    prefix: "file:./raw/g11/receipts/",
    suffix: ".json",
    root,
    label: "G11 deployment receipt",
    maximumBytes: MAX_RECEIPT_BYTES,
    findings,
  });
  if (deploymentArtifact) {
    const receipt = parseCanonicalJsonArtifact(deploymentArtifact, "G11 deployment receipt", findings);
    if (receipt) validateDeploymentReceipt({ receipt, manifest, plan, findings });
    evidence.push(structuredClone(manifest.deployment.receipt));
  }

  const harnessArtifact = await readExpectedReference({
    reference: manifest.harness.source,
    kind: "browser-harness-source",
    prefix: "file:./raw/g11/harness/",
    suffix: ".mjs",
    root,
    label: "G11 browser harness source",
    maximumBytes: MAX_RECEIPT_BYTES,
    findings,
  });
  if (harnessArtifact) {
    const protectedHarnessBytes = await readFile(harnessPath);
    const protectedHarnessSha256 = sha256Bytes(protectedHarnessBytes);
    if (protectedHarnessSha256 !== G11_BROWSER_HARNESS_SHA256) {
      findings.push("G11 protected browser harness SHA-256 does not match the verifier pin");
    }
    if (!harnessArtifact.bytes.equals(protectedHarnessBytes)
      || manifest.harness.source.sha256 !== protectedHarnessSha256) {
      findings.push("G11 evidence harness bytes must exactly equal the protected checked-in collector");
    }
    evidence.push(structuredClone(manifest.harness.source));
  }
}

async function verifyCollectorPrivacyEvidence({ manifest, plan, root, evidence, findings }) {
  const attestation = manifest.collectorAttestation;
  const datasetArtifact = await readExpectedReference({
    reference: attestation.dataset,
    kind: "synthetic-browser-dataset-receipt",
    prefix: "file:./raw/g11/receipts/",
    suffix: ".json",
    root,
    label: "G11 synthetic dataset receipt",
    maximumBytes: MAX_RECEIPT_BYTES,
    findings,
  });
  const privacyArtifact = await readExpectedReference({
    reference: attestation.privacyReview,
    kind: "browser-image-privacy-review",
    prefix: "file:./raw/g11/receipts/",
    suffix: ".json",
    root,
    label: "G11 browser image privacy review",
    maximumBytes: MAX_RECEIPT_BYTES,
    findings,
  });
  if (datasetArtifact) evidence.push(structuredClone(attestation.dataset));
  if (privacyArtifact) evidence.push(structuredClone(attestation.privacyReview));
  if (!datasetArtifact || !privacyArtifact) return null;

  const dataset = parseCanonicalJsonArtifact(datasetArtifact, "G11 synthetic dataset receipt", findings);
  const privacy = parseCanonicalJsonArtifact(privacyArtifact, "G11 browser image privacy review", findings);
  if (!dataset || !privacy) return null;
  if (!hasExactKeys(dataset, [
    "schemaVersion", "datasetId", "datasetSha256", "classification", "plan", "binding", "environment",
    "productionDataUsed", "sensitiveSourceDataUsed",
  ], "G11 synthetic dataset receipt", findings)) return null;
  if (dataset.schemaVersion !== "workbench.production-g11-synthetic-dataset-receipt.v1"
    || !validIdentifier(dataset.datasetId)
    || !validSha256(dataset.datasetSha256)
    || dataset.classification !== "isolated-synthetic"
    || !canonicalEqual(dataset.plan, manifest.plan)
    || !canonicalEqual(dataset.binding, plan.payload.binding)
    || !canonicalEqual(dataset.environment, plan.payload.environment)
    || dataset.productionDataUsed !== false
    || dataset.sensitiveSourceDataUsed !== false) {
    findings.push("G11 browser dataset is not an isolated synthetic dataset bound to the candidate");
  }
  if (!hasExactKeys(privacy, [
    "schemaVersion", "reviewId", "reviewedAtUtc", "datasetSha256", "scanner", "status", "images",
  ], "G11 browser image privacy review", findings)) return null;
  if (privacy.schemaVersion !== "workbench.production-g11-browser-image-privacy-review.v1"
    || !validIdentifier(privacy.reviewId)
    || privacy.datasetSha256 !== dataset.datasetSha256
    || privacy.status !== "PASS"
    || !validateEvidenceTime(
      privacy.reviewedAtUtc,
      manifest.startedAtUtc,
      manifest.collectorAttestation.signedAtUtc,
      "G11 browser image privacy review",
      findings,
    )) {
    findings.push("G11 browser image privacy review identity or outcome is invalid");
  }
  if (!hasExactKeys(privacy.scanner, ["name", "version", "rulesSha256"], "G11 privacy scanner", findings)
    || !validIdentifier(privacy.scanner?.name)
    || typeof privacy.scanner?.version !== "string" || privacy.scanner.version.length < 1 || privacy.scanner.version.length > 128
    || !validSha256(privacy.scanner?.rulesSha256)) {
    findings.push("G11 browser image privacy scanner identity is invalid");
  }
  const expectedImages = manifest.visualMatrix.flatMap((cell) => [
    cell.screenshot,
    cell.frameBefore,
    cell.frameAfter,
  ]).map(({ uri, sha256 }) => ({ uri, sha256 })).sort(compareEvidenceReference);
  const actualImages = [];
  if (!Array.isArray(privacy.images) || privacy.images.length !== EXPECTED_VISUAL_IMAGE_COUNT) {
    findings.push(`G11 privacy review must cover exactly ${EXPECTED_VISUAL_IMAGE_COUNT} screenshots and motion frames`);
  } else {
    for (const [index, image] of privacy.images.entries()) {
      const label = `G11 privacy review images[${index}]`;
      if (!hasExactKeys(image, [
        "uri", "sha256", "ocrScanComplete", "secretMatches", "sensitiveContentMatches",
        "unapprovedTextMatches", "redactionApplied", "securityReview",
      ], label, findings)) continue;
      actualImages.push({ uri: image.uri, sha256: image.sha256 });
      if (!FILE_URI_PATTERN.test(image.uri ?? "") || !validSha256(image.sha256)
        || image.ocrScanComplete !== true
        || image.secretMatches !== 0
        || image.sensitiveContentMatches !== 0
        || image.unapprovedTextMatches !== 0
        || typeof image.redactionApplied !== "boolean"
        || image.securityReview !== "PASS") {
        findings.push(`${label} does not prove a complete zero-disclosure review`);
      }
    }
  }
  if (!canonicalEqual(actualImages.sort(compareEvidenceReference), expectedImages)) {
    findings.push("G11 privacy review image hashes must exactly cover every visual artifact");
  }
  return { datasetSha256: dataset.datasetSha256, reviewedImageCount: actualImages.length };
}

async function verifyCollectorAttestation({
  manifest,
  plan,
  root,
  executedAtUtc,
  trustPolicy,
  evidence,
  verification,
  nativeTraceHashes,
  findings,
}) {
  const label = "G11 collector attestation";
  const attestation = manifest.collectorAttestation;
  if (!hasExactKeys(attestation, [
    "schemaVersion", "scopeId", "signerId", "signedAtUtc", "trustPolicySha256", "collector",
    "evidenceClosureSha256", "source", "dataset", "privacyReview", "signature",
  ], label, findings)) return;
  if (attestation.schemaVersion !== "workbench.production-g11-collector-attestation.v1"
    || attestation.scopeId !== COLLECTOR_SCOPE_ID
    || !validIdentifier(attestation.signerId)
    || attestation.trustPolicySha256 !== trustPolicy?.sha256
    || !validateEvidenceTime(attestation.signedAtUtc, manifest.finishedAtUtc, executedAtUtc, label, findings)) {
    findings.push(`${label} identity, trust-policy binding, or signing time is invalid`);
  }
  if (!hasExactKeys(attestation.collector, [
    "collectorSha256", "harnessSha256", "schemaSha256", "verifierSha256", "runnerSha256", "sanitizerAlgorithm",
    "captureCount", "assertionCount", "unexpectedRuntimeFailureCount", "nativeTraceCount",
    "nativeTraceDeletedCount",
  ], `${label} collector`, findings)) return;
  const sourceArtifact = await readExpectedReference({
    reference: attestation.source,
    kind: "browser-collector-source",
    prefix: "file:./raw/g11/collector/",
    suffix: ".mjs",
    root,
    label: `${label} source`,
    maximumBytes: MAX_RECEIPT_BYTES,
    findings,
  });
  const [collectorBytes, schemaBytes, harnessBytes, verifierBytes, runnerBytes] = await Promise.all([
    readFile(collectorPath),
    readFile(schemaPath),
    readFile(harnessPath),
    readFile(verifierPath),
    readFile(runnerPath),
  ]);
  if (sourceArtifact) {
    if (!sourceArtifact.bytes.equals(collectorBytes) || attestation.source.sha256 !== sha256Bytes(collectorBytes)) {
      findings.push(`${label} source bytes differ from the protected checked-in collector`);
    }
    evidence.push(structuredClone(attestation.source));
  }
  const expectedCollector = {
    collectorSha256: sha256Bytes(collectorBytes),
    harnessSha256: sha256Bytes(harnessBytes),
    schemaSha256: sha256Bytes(schemaBytes),
    verifierSha256: sha256Bytes(verifierBytes),
    runnerSha256: sha256Bytes(runnerBytes),
    sanitizerAlgorithm: "strict-allowlist-v1",
    captureCount: EXPECTED_CAPTURE_COUNT,
    assertionCount: verification.assertionCount,
    unexpectedRuntimeFailureCount: verification.unexpectedRuntimeFailureCount,
    nativeTraceCount: nativeTraceHashes.length,
    nativeTraceDeletedCount: nativeTraceHashes.length,
  };
  if (!canonicalEqual(attestation.collector, expectedCollector)) {
    findings.push(`${label} collector toolchain, outcomes, assertions, or native-trace deletion counts mismatch`);
  }
  if (attestation.collector.harnessSha256 !== G11_BROWSER_HARNESS_SHA256) {
    findings.push(`${label} harness SHA-256 differs from the protected verifier pin`);
  }
  const evidenceClosureSha256 = sha256Canonical({
    schemaVersion: "workbench.production-g11-evidence-closure.v1",
    evidence: structuredClone(evidence).sort(compareEvidence),
  });
  if (attestation.evidenceClosureSha256 !== evidenceClosureSha256) {
    findings.push(`${label} evidence closure SHA-256 mismatch`);
  }
  if (!canonicalEqual(attestation.dataset, manifest.collectorAttestation.dataset)
    || !canonicalEqual(attestation.privacyReview, manifest.collectorAttestation.privacyReview)
    || verification.privacy?.reviewedImageCount !== EXPECTED_VISUAL_IMAGE_COUNT) {
    findings.push(`${label} does not bind a complete synthetic-data privacy review`);
  }
  if (!hasExactKeys(attestation.signature, ["algorithm", "keyId", "value"], `${label} signature`, findings)
    || attestation.signature?.algorithm !== "Ed25519") {
    findings.push(`${label} signature contract is invalid`);
    return;
  }
  let authority;
  try {
    authority = resolveReceiptAuthority(trustPolicy, {
      scopeId: attestation.scopeId,
      keyId: attestation.signature.keyId,
      signedAt: new Date(attestation.signedAtUtc),
    });
  } catch {
    findings.push(`${label} signer is not authorized by the external production trust policy`);
    return;
  }
  if (authority.signerId !== attestation.signerId) findings.push(`${label} signerId differs from its trusted authority`);
  if (trustPolicy.approvalAuthorities.some(({ keyId }) => keyId === attestation.signature.keyId)
    || trustPolicy.receiptAuthorities.some(({ scopeId, keyId }) => (
      scopeId !== COLLECTOR_SCOPE_ID && keyId === attestation.signature.keyId
    ))) {
    findings.push(`${label} key must be dedicated to the browser collector scope`);
  }
  const payload = productionG11CollectorAttestationPayload(manifest);
  try {
    if (!payload || !verifyTrustedEd25519Signature({
      key: authority.key,
      payload: canonicalJson(payload),
      signature: attestation.signature.value,
    })) findings.push(`${label} signature verification failed`);
  } catch {
    findings.push(`${label} signature verification failed`);
  }
}

async function verifyVisualCellEvidence({ cell, manifest, plan, root, evidence, findings }) {
  const key = visualCellKey(cell);
  const specs = [
    ["screenshot", "browser-screenshot", "file:./raw/g11/screenshots/", ".png", MAX_SCREENSHOT_BYTES],
    ["frameBefore", "browser-motion-frame", "file:./raw/g11/frames/", ".png", MAX_SCREENSHOT_BYTES],
    ["frameAfter", "browser-motion-frame", "file:./raw/g11/frames/", ".png", MAX_SCREENSHOT_BYTES],
    ["receipt", "browser-cell-receipt", "file:./raw/g11/receipts/", ".json", MAX_RECEIPT_BYTES],
    ["trace", "playwright-sanitized-trace", "file:./raw/g11/traces/", ".zip", MAX_SANITIZED_TRACE_BYTES],
  ];
  const artifacts = {};
  for (const [property, kind, prefix, suffix, maximumBytes] of specs) {
    const referenceValue = cell[property];
    const loaded = await readExpectedReference({
      reference: referenceValue,
      kind,
      prefix,
      suffix,
      root,
      label: `${key} ${property}`,
      maximumBytes,
      findings,
    });
    if (loaded) {
      artifacts[property] = loaded;
      evidence.push(structuredClone(referenceValue));
    }
  }
  if (Object.keys(artifacts).length !== specs.length) return null;

  const receipt = parseCanonicalJsonArtifact(artifacts.receipt, `${key} receipt`, findings);
  const traceVerification = validateSanitizedPlaywrightTrace(artifacts.trace.bytes, `${key} trace`, findings, {
    traceId: receipt?.captureId,
    nativeTraceSha256: receipt?.nativeTraceSha256,
    browser: cell.browser,
    browserVersion: manifest.browsers.find(({ name }) => name === cell.browser)?.version,
    viewport: VIEWPORTS.find(({ id }) => id === cell.viewport),
    motion: cell.motion,
    startedAtUtc: receipt?.traceStartedAtUtc,
    finishedAtUtc: receipt?.traceFinishedAtUtc,
    scenario: scenarioForTrace({
      manifest,
      browser: cell.browser,
      motion: cell.motion,
      traceId: receipt?.captureId,
      viewport: VIEWPORTS.find(({ id }) => id === cell.viewport),
      scenarioBinding: cell.scenarioBinding,
    }, `${key} trace`, findings),
  });
  const [screenshot, frameBefore, frameAfter] = await Promise.all([
    decodeVisiblePng({ cell, bytes: artifacts.screenshot.bytes, label: `${key} screenshot`, findings }),
    decodeVisiblePng({ cell, bytes: artifacts.frameBefore.bytes, label: `${key} frameBefore`, findings }),
    decodeVisiblePng({ cell, bytes: artifacts.frameAfter.bytes, label: `${key} frameAfter`, findings }),
  ]);
  if (!receipt || !screenshot || !frameBefore || !frameAfter) return null;

  const receiptValid = validateCellReceipt({ receipt, cell, manifest, plan, findings });
  const framePixelDiffRatio = pixelDiffRatio(
    frameBefore,
    frameAfter,
    receipt.targetBounds,
    `${key} targetBounds`,
    findings,
  );
  if (framePixelDiffRatio === null) return null;
  if (!numberNear(receipt.framePixelDiffRatio, framePixelDiffRatio, 0.000001)) {
    findings.push(`${key} receipt framePixelDiffRatio was not derived from the referenced PNG frames`);
  }
  const motionPassed = cell.motion === "normal"
    ? framePixelDiffRatio >= MIN_NORMAL_FRAME_PIXEL_RATIO
    : framePixelDiffRatio <= MAX_REDUCED_FRAME_PIXEL_RATIO;
  if (!motionPassed) {
    findings.push(`${key} motion frames violate the ${cell.motion} pixel-diff threshold`);
  }
  const traceCountsMatch = receipt?.capture?.unexpectedConsoleErrorCount
      === traceVerification.unexpectedConsoleErrorCount
    && receipt?.capture?.unexpectedNetworkFailureCount === traceVerification.unexpectedNetworkFailureCount
    && receipt?.capture?.unexpectedRuntimeFailureCount === traceVerification.unexpectedRuntimeFailureCount;
  if (!traceCountsMatch) {
    findings.push(`${key} receipt console, network, or runtime counts were not derived from its sanitized trace`);
  }
  const passed = receiptValid && traceVerification.valid && traceCountsMatch && motionPassed;
  if (cell.status !== (passed ? "PASS" : "FAIL")) {
    findings.push(`${key} status differs from its verified browser receipt and frame evidence`);
  }
  return Object.freeze({
    passed,
    receipt,
    nativeTraceSha256: traceVerification.nativeTraceSha256,
    unexpectedConsoleErrorCount: traceVerification.unexpectedConsoleErrorCount,
    unexpectedNetworkFailureCount: traceVerification.unexpectedNetworkFailureCount,
    unexpectedRuntimeFailureCount: traceVerification.unexpectedRuntimeFailureCount,
    assertionCount: traceVerification.assertionCount,
    screenshotPixelSha256: screenshot.pixelSha256,
    framePixelDiffRatio,
  });
}

async function verifyFlowEvidence({ flow, manifest, plan, root, trustPolicy, evidence, findings }) {
  const receiptReferences = flow.evidence.filter(({ kind }) => kind === "browser-flow-receipt");
  const observerReceiptReferences = flow.evidence.filter(({ kind }) => kind === "server-observer-receipt");
  const traceReferences = flow.evidence.filter(({ kind }) => kind === "playwright-sanitized-trace");
  if (receiptReferences.length !== 1 || observerReceiptReferences.length !== 1 || traceReferences.length !== 18) {
    findings.push(`${flow.flowId} evidence must contain exactly one browser receipt, one signed server observer receipt, and 18 sanitized Playwright traces`);
    return null;
  }
  if (flow.evidence.length !== receiptReferences.length + observerReceiptReferences.length + traceReferences.length) {
    findings.push(`${flow.flowId} evidence contains an unsupported evidence kind`);
    return null;
  }

  const receiptArtifact = await readExpectedReference({
    reference: receiptReferences[0],
    kind: "browser-flow-receipt",
    prefix: "file:./raw/g11/flows/",
    suffix: ".json",
    root,
    label: `${flow.flowId} flow receipt`,
    maximumBytes: MAX_RECEIPT_BYTES,
    findings,
  });
  if (!receiptArtifact) return null;
  evidence.push(structuredClone(receiptReferences[0]));
  const observerArtifact = await readExpectedReference({
    reference: observerReceiptReferences[0],
    kind: "server-observer-receipt",
    prefix: "file:./raw/g11/flows/",
    suffix: ".json",
    root,
    label: `${flow.flowId} server observer receipt`,
    maximumBytes: MAX_RECEIPT_BYTES,
    findings,
  });
  if (!observerArtifact) return null;
  evidence.push(structuredClone(observerReceiptReferences[0]));

  const traceArtifacts = new Map();
  for (const referenceValue of traceReferences) {
    const loaded = await readExpectedReference({
      reference: referenceValue,
      kind: "playwright-sanitized-trace",
      prefix: "file:./raw/g11/flows/traces/",
      suffix: ".zip",
      root,
      label: `${flow.flowId} flow trace`,
      maximumBytes: MAX_SANITIZED_TRACE_BYTES,
      findings,
    });
    if (loaded) {
      traceArtifacts.set(referenceValue.uri, { reference: referenceValue, bytes: loaded.bytes });
      evidence.push(structuredClone(referenceValue));
    }
  }
  const receipt = parseCanonicalJsonArtifact(receiptArtifact, `${flow.flowId} flow receipt`, findings);
  const observerReceipt = parseCanonicalJsonArtifact(observerArtifact, `${flow.flowId} server observer receipt`, findings);
  if (!receipt || !observerReceipt) return null;
  const validated = validateFlowReceipt({
    receipt,
    flow,
    manifest,
    plan,
    traceArtifacts,
    findings,
  });
  await validateServerObserverReceipt({
    receipt: observerReceipt,
    flow,
    flowReceipt: receipt,
    manifest,
    plan,
    trustPolicy,
    findings,
  });
  if (flow.status !== (validated.passed ? "PASS" : "FAIL")) {
    findings.push(`${flow.flowId} status differs from its typed flow receipt`);
  }
  return validated;
}

function validateDeploymentReceipt({ receipt, manifest, plan, findings }) {
  const label = "G11 deployment receipt";
  if (!hasExactKeys(receipt, [
    "schemaVersion", "receiptId", "plan", "binding", "environment", "deployment", "observedAtUtc", "tls",
  ], label, findings)) return;
  if (receipt.schemaVersion !== "workbench.production-g11-deployment-receipt.v2") {
    findings.push(`${label} schemaVersion is invalid`);
  }
  if (!validIdentifier(receipt.receiptId)) findings.push(`${label} receiptId is invalid`);
  if (!canonicalEqual(receipt.plan, manifest.plan)) findings.push(`${label} plan binding mismatch`);
  if (!canonicalEqual(receipt.binding, plan.payload.binding)) findings.push(`${label} candidate binding mismatch`);
  if (!canonicalEqual(receipt.environment, plan.payload.environment)) findings.push(`${label} environment binding mismatch`);
  if (!canonicalEqual(receipt.deployment, deploymentIdentity(manifest.deployment))) {
    findings.push(`${label} deployment identity mismatch`);
  }
  validateEvidenceTime(receipt.observedAtUtc, manifest.startedAtUtc, manifest.finishedAtUtc, label, findings);
  if (!hasExactKeys(receipt.tls, ["webVerified", "previewVerified"], `${label} tls`, findings)
    || receipt.tls?.webVerified !== true || receipt.tls?.previewVerified !== true) {
    findings.push(`${label} must prove TLS for Web and Preview origins`);
  }
}

function validateCellReceipt({ receipt, cell, manifest, plan, findings }) {
  const label = `${visualCellKey(cell)} receipt`;
  let valid = hasExactKeys(receipt, [
    "schemaVersion", "captureId", "plan", "binding", "environment", "deployment", "browser", "viewport",
    "motion", "state", "capturedAtUtc", "targetSelector", "runState", "motionEvidence", "layout", "capture",
    "targetBounds", "framePixelDiffRatio", "traceStartedAtUtc", "traceFinishedAtUtc", "nativeTraceSha256",
    "screenshot", "frameBefore", "frameAfter", "trace", "scenarioBinding",
  ], label, findings);
  const browserVersion = manifest.browsers.find(({ name }) => name === cell.browser)?.version;
  const viewport = VIEWPORTS.find(({ id }) => id === cell.viewport);
  const expectedFixed = {
    schemaVersion: "workbench.production-g11-browser-cell-receipt.v2",
    captureId: cell.captureId,
    plan: manifest.plan,
    binding: plan.payload.binding,
    environment: plan.payload.environment,
    deployment: deploymentIdentity(manifest.deployment),
    browser: { name: cell.browser, version: browserVersion },
    viewport,
    motion: cell.motion,
    state: cell.state,
    capturedAtUtc: cell.capturedAtUtc,
    targetSelector: cell.motionEvidence.targetSelector,
    runState: cell.runState,
    motionEvidence: cell.motionEvidence,
    layout: cell.layout,
    screenshot: cell.screenshot,
    frameBefore: cell.frameBefore,
    frameAfter: cell.frameAfter,
    trace: cell.trace,
    scenarioBinding: cell.scenarioBinding,
  };
  for (const [key, expected] of Object.entries(expectedFixed)) {
    if (!canonicalEqual(receipt?.[key], expected)) {
      findings.push(`${label} ${key} mismatch`);
      valid = false;
    }
  }
  if (!validateEvidenceTime(receipt?.capturedAtUtc, manifest.startedAtUtc, manifest.finishedAtUtc, label, findings)) {
    valid = false;
  }
  if (!validateEvidenceTime(receipt?.traceStartedAtUtc, manifest.startedAtUtc, receipt?.capturedAtUtc, label, findings)
    || !validateEvidenceTime(receipt?.traceFinishedAtUtc, receipt?.traceStartedAtUtc, receipt?.capturedAtUtc, label, findings)) {
    valid = false;
  }
  if (!validSha256(receipt?.nativeTraceSha256)) {
    findings.push(`${label} nativeTraceSha256 is invalid`);
    valid = false;
  }
  if (!hasExactKeys(receipt?.capture, [
    "documentReadyState", "domCaptureComplete", "consoleCaptureComplete", "networkCaptureComplete",
    "runtimeCaptureComplete", "accessibilityCaptureComplete", "traceComplete", "routeFulfillUsed",
    "syntheticSessionUsed", "syntheticApiUsed", "syntheticSseUsed", "unexpectedConsoleErrorCount",
    "unexpectedNetworkFailureCount", "unexpectedRuntimeFailureCount",
  ], `${label} capture`, findings)) valid = false;
  const capture = receipt?.capture ?? {};
  for (const key of [
    "domCaptureComplete", "consoleCaptureComplete", "networkCaptureComplete", "runtimeCaptureComplete",
    "accessibilityCaptureComplete", "traceComplete",
  ]) {
    if (capture[key] !== true) {
      findings.push(`${label} ${key} must be true`);
      valid = false;
    }
  }
  for (const key of ["routeFulfillUsed", "syntheticSessionUsed", "syntheticApiUsed", "syntheticSseUsed"]) {
    if (capture[key] !== false) {
      findings.push(`${label} ${key} must be false`);
      valid = false;
    }
  }
  if (capture.documentReadyState !== "complete") {
    findings.push(`${label} documentReadyState must be complete`);
    valid = false;
  }
  for (const key of [
    "unexpectedConsoleErrorCount", "unexpectedNetworkFailureCount", "unexpectedRuntimeFailureCount",
  ]) {
    if (!Number.isInteger(capture[key]) || capture[key] < 0) {
      findings.push(`${label} ${key} must be a non-negative integer`);
      valid = false;
    }
  }
  if (!validBounds(receipt?.targetBounds, viewport)) {
    findings.push(`${label} targetBounds must be a visible region inside the viewport`);
    valid = false;
  }
  if (!Number.isFinite(receipt?.framePixelDiffRatio)
    || receipt.framePixelDiffRatio < 0 || receipt.framePixelDiffRatio > 1) {
    findings.push(`${label} framePixelDiffRatio must be between zero and one`);
    valid = false;
  }
  return valid;
}

function validateFlowReceipt({ receipt, flow, manifest, plan, traceArtifacts, findings }) {
  const label = `${flow.flowId} flow receipt`;
  let valid = hasExactKeys(receipt, [
    "schemaVersion", "receiptId", "plan", "binding", "environment", "deployment", "flowId", "startedAtUtc",
    "finishedAtUtc", "status", "scenarioBinding", "checks", "renderedStates", "coverage",
  ], label, findings);
  const fixed = {
    schemaVersion: "workbench.production-g11-flow-evidence.v3",
    plan: manifest.plan,
    binding: plan.payload.binding,
    environment: plan.payload.environment,
    deployment: deploymentIdentity(manifest.deployment),
    flowId: flow.flowId,
    scenarioBinding: flow.scenarioBinding,
    checks: flow.checks,
    renderedStates: protectedRenderedStates(flow.flowId),
  };
  for (const [key, expected] of Object.entries(fixed)) {
    if (!canonicalEqual(receipt?.[key], expected)) {
      findings.push(`${label} ${key} mismatch`);
      valid = false;
    }
  }
  if (!validIdentifier(receipt?.receiptId)) {
    findings.push(`${label} receiptId is invalid`);
    valid = false;
  }
  if (!validateEvidenceTime(receipt?.startedAtUtc, manifest.startedAtUtc, manifest.finishedAtUtc, label, findings)) valid = false;
  if (!validateEvidenceTime(receipt?.finishedAtUtc, receipt?.startedAtUtc, manifest.finishedAtUtc, label, findings)) valid = false;
  if (!Array.isArray(receipt?.coverage) || receipt.coverage.length !== 18) {
    findings.push(`${label} coverage must contain all 18 browser/viewport/motion cells`);
    return {
      passed: false,
      unexpectedConsoleErrorCount: 0,
      unexpectedNetworkFailureCount: 0,
      unexpectedRuntimeFailureCount: 0,
      assertionCount: 0,
      nativeTraceSha256Values: [],
    };
  }

  const expectedCoverage = [];
  for (const browser of BROWSERS) {
    for (const viewport of VIEWPORTS) {
      for (const motion of MOTIONS) expectedCoverage.push(`${browser}/${viewport.id}/${motion}`);
    }
  }
  const actualCoverage = [];
  let unexpectedConsoleErrorCount = 0;
  let unexpectedNetworkFailureCount = 0;
  let unexpectedRuntimeFailureCount = 0;
  let assertionCount = 0;
  let coveragePassed = true;
  const captureIdentityOwners = new Map([
    ["projectId", new Map()],
    ["threadId", new Map()],
    ["deniedProjectId", new Map()],
    ["runId", new Map()],
    ["artifactVersionId", new Map()],
  ]);
  for (const [coverageIndex, cell] of receipt.coverage.entries()) {
    const cellLabel = `${label} coverage[${coverageIndex}]`;
    if (!hasExactKeys(cell, [
      "browser", "browserVersion", "viewport", "motion", "traceId", "scenarioBinding", "scenarioPlanSha256",
      "nativeTraceSha256", "startedAtUtc", "finishedAtUtc", "status", "steps",
      "consoleCaptureComplete", "networkCaptureComplete", "runtimeCaptureComplete",
      "unexpectedConsoleErrorCount", "unexpectedNetworkFailureCount", "unexpectedRuntimeFailureCount", "trace",
    ], cellLabel, findings)) coveragePassed = false;
    actualCoverage.push(`${cell?.browser}/${cell?.viewport}/${cell?.motion}`);
    const browserVersion = manifest.browsers.find(({ name }) => name === cell?.browser)?.version;
    if (cell?.browserVersion !== browserVersion) {
      findings.push(`${cellLabel} browserVersion mismatch`);
      coveragePassed = false;
    }
    if (!validIdentifier(cell?.traceId) || !validSha256(cell?.nativeTraceSha256)) {
      findings.push(`${cellLabel} trace identity is invalid`);
      coveragePassed = false;
    }
    const expectedTraceId = `flow-${flow.flowId}-${cell?.browser}-${cell?.viewport}-${cell?.motion}`;
    if (cell?.traceId !== expectedTraceId) {
      findings.push(`${cellLabel} traceId is not deterministic`);
      coveragePassed = false;
    }
    if (!validateEvidenceTime(cell?.startedAtUtc, receipt.startedAtUtc, receipt.finishedAtUtc, cellLabel, findings)) {
      coveragePassed = false;
    }
    if (!validateEvidenceTime(cell?.finishedAtUtc, cell?.startedAtUtc, receipt.finishedAtUtc, cellLabel, findings)) {
      coveragePassed = false;
    }
    const scenario = scenarioForTrace({
      manifest,
      browser: cell?.browser,
      motion: cell?.motion,
      traceId: cell?.traceId,
      viewport: VIEWPORTS.find(({ id }) => id === cell?.viewport),
      scenarioBinding: cell?.scenarioBinding,
    }, cellLabel, findings);
    if (!validSha256(cell?.scenarioPlanSha256)
      || cell.scenarioPlanSha256 !== scenario?.scenarioPlanSha256) {
      findings.push(`${cellLabel} scenarioPlanSha256 does not bind its capture-specific resources`);
      coveragePassed = false;
    }
    for (const [identityKey, owners] of captureIdentityOwners) {
      const identity = cell?.scenarioBinding?.[identityKey];
      if (identity === undefined) continue;
      const previousTraceId = owners.get(identity);
      if (previousTraceId) {
        findings.push(`${cellLabel} reuses ${identityKey} from ${previousTraceId}`);
        coveragePassed = false;
      } else {
        owners.set(identity, cell?.traceId);
      }
    }
    const expectedSteps = scenario?.scenarioPlan.browserSteps.map(({ stepId }) => stepId) ?? [];
    const steps = Array.isArray(cell?.steps) ? cell.steps : [];
    const actualSteps = steps.map((step) => step?.stepId);
    const stepIdsValid = actualSteps.every((stepId) => typeof stepId === "string");
    const expectedStepRecords = scenario?.scenarioPlan.browserSteps.map(({ stepId, actionId, apiName }) => (
      { stepId, actionId, apiName }
    )) ?? [];
    const actualStepRecords = steps.map(({ stepId, actionId, apiName }) => ({ stepId, actionId, apiName }));
    if (!stepIdsValid || !canonicalEqual(actualSteps, expectedSteps)
      || !canonicalEqual(actualStepRecords, expectedStepRecords)
      || steps.some((step) => !hasExactKeys(step, ["stepId", "actionId", "apiName", "status", "observedAtUtc"], cellLabel, findings)
        || step.status !== "PASS"
        || !validateEvidenceTime(step.observedAtUtc, cell.startedAtUtc, cell.finishedAtUtc, cellLabel, findings))) {
      findings.push(`${cellLabel} steps must prove every structured flow check`);
      coveragePassed = false;
    }
    if (cell?.consoleCaptureComplete !== true || cell?.networkCaptureComplete !== true
      || cell?.runtimeCaptureComplete !== true) {
      findings.push(`${cellLabel} console, network, and runtime capture must be complete`);
      coveragePassed = false;
    }
    for (const key of [
      "unexpectedConsoleErrorCount", "unexpectedNetworkFailureCount", "unexpectedRuntimeFailureCount",
    ]) {
      if (!Number.isInteger(cell?.[key]) || cell[key] < 0) {
        findings.push(`${cellLabel} ${key} must be a non-negative integer`);
        coveragePassed = false;
      }
    }
    if (cell?.status !== "PASS") coveragePassed = false;
    const traceArtifact = traceArtifacts.get(cell?.trace?.uri);
    if (!traceArtifact || !canonicalEqual(traceArtifact.reference, cell?.trace)) {
      findings.push(`${cellLabel} trace is not present in the verified evidence closure`);
      coveragePassed = false;
    } else {
      const traceVerification = validateSanitizedPlaywrightTrace(traceArtifact.bytes, `${cellLabel} trace`, findings, {
        traceId: cell.traceId,
        nativeTraceSha256: cell.nativeTraceSha256,
        browser: cell.browser,
        browserVersion: cell.browserVersion,
        viewport: VIEWPORTS.find(({ id }) => id === cell.viewport),
        motion: cell.motion,
        startedAtUtc: cell.startedAtUtc,
        finishedAtUtc: cell.finishedAtUtc,
        scenario,
        flowId: flow.flowId,
      });
      if (!traceVerification.valid) coveragePassed = false;
      if (cell?.unexpectedConsoleErrorCount !== traceVerification.unexpectedConsoleErrorCount
        || cell?.unexpectedNetworkFailureCount !== traceVerification.unexpectedNetworkFailureCount
        || cell?.unexpectedRuntimeFailureCount !== traceVerification.unexpectedRuntimeFailureCount) {
        findings.push(`${cellLabel} console, network, or runtime counts were not derived from its sanitized trace`);
        coveragePassed = false;
      }
      unexpectedConsoleErrorCount += traceVerification.unexpectedConsoleErrorCount;
      unexpectedNetworkFailureCount += traceVerification.unexpectedNetworkFailureCount;
      unexpectedRuntimeFailureCount += traceVerification.unexpectedRuntimeFailureCount;
      assertionCount += traceVerification.assertionCount;
    }
  }
  if (canonicalJson(actualCoverage.sort(compareStrings)) !== canonicalJson(expectedCoverage.sort(compareStrings))) {
    findings.push(`${label} coverage must contain exactly 18 unique browser/viewport/motion cells`);
    coveragePassed = false;
  }
  if (!canonicalEqual(receipt.scenarioBinding, receipt.coverage[0]?.scenarioBinding)) {
    findings.push(`${label} primary scenarioBinding must equal its first deterministic capture binding`);
    coveragePassed = false;
  }
  const passed = valid
    && coveragePassed
    && flowPassesChecks(flow)
    && unexpectedConsoleErrorCount === 0
    && unexpectedNetworkFailureCount === 0
    && unexpectedRuntimeFailureCount === 0;
  if (receipt.status !== (passed ? "PASS" : "FAIL")) {
    findings.push(`${label} status differs from its checks and complete capture coverage`);
  }
  return {
    passed,
    unexpectedConsoleErrorCount,
    unexpectedNetworkFailureCount,
    unexpectedRuntimeFailureCount,
    assertionCount,
    nativeTraceSha256Values: receipt.coverage.map((cell) => cell?.nativeTraceSha256),
  };
}

async function validateServerObserverReceipt({ receipt, flow, flowReceipt, manifest, plan, trustPolicy, findings }) {
  const label = `${flow.flowId} server observer receipt`;
  if (!hasExactKeys(receipt, [
    "schemaVersion", "receiptId", "plan", "binding", "environment", "deployment", "scenarioId", "scenarioBinding",
    "scenarioPlanSha256", "originPolicySha256", "flowId", "coverage", "captureObservations", "checks",
    "observedAtUtc", "signedAtUtc", "trustPolicySha256", "scopeId", "signerId", "signature",
  ], label, findings)) return;
  let scenarioPlan;
  try {
    scenarioPlan = productionG11ScenarioPlan({ scenarioId: flow.flowId, scenarioBinding: flow.scenarioBinding });
  } catch {
    findings.push(`${label} scenario binding is not protected`);
    return;
  }
  const observerCheckIds = productionG11FlowCheckSpec(flow.flowId)?.observerCheckIds ?? [];
  const expectedChecks = Object.fromEntries(observerCheckIds.map((checkId) => [checkId, flow.checks[checkId]]));
  const fixed = {
    schemaVersion: "workbench.production-g11-server-observer-receipt.v2",
    plan: manifest.plan,
    binding: plan.payload.binding,
    environment: plan.payload.environment,
    deployment: deploymentIdentity(manifest.deployment),
    scenarioId: flow.flowId,
    scenarioBinding: flow.scenarioBinding,
    scenarioPlanSha256: productionG11ScenarioPlanSha256({ scenarioId: flow.flowId, scenarioBinding: flow.scenarioBinding }),
    originPolicySha256: productionG11OriginPolicySha256(manifest.deployment),
    flowId: flow.flowId,
    coverage: flowReceipt.coverage,
    checks: expectedChecks,
    trustPolicySha256: trustPolicy?.sha256,
    scopeId: SERVER_OBSERVER_SCOPE_ID,
  };
  for (const [key, expected] of Object.entries(fixed)) {
    if (!canonicalEqual(receipt[key], expected)) findings.push(`${label} ${key} mismatch`);
  }
  const observedChecks = validateCaptureObserverCoverage({
    captureObservations: receipt.captureObservations,
    coverage: flowReceipt.coverage,
    flowId: flow.flowId,
    observerCheckIds,
    label,
    findings,
  });
  if (!canonicalEqual(observedChecks, expectedChecks)) {
    findings.push(`${label} aggregate checks were not derived from all 18 capture observations`);
  }
  if (!validIdentifier(receipt.receiptId) || !validIdentifier(receipt.signerId)
    || !validateEvidenceTime(receipt.observedAtUtc, flowReceipt.startedAtUtc, flowReceipt.finishedAtUtc, label, findings)
    || !validateEvidenceTime(receipt.signedAtUtc, receipt.observedAtUtc, manifest.finishedAtUtc, label, findings)) {
    findings.push(`${label} identity or observation time is invalid`);
  }
  if (!hasExactKeys(receipt.signature, ["algorithm", "keyId", "value"], `${label} signature`, findings)
    || receipt.signature?.algorithm !== "Ed25519") {
    findings.push(`${label} signature contract is invalid`);
    return;
  }
  let authority;
  try {
    authority = resolveReceiptAuthority(trustPolicy, {
      scopeId: SERVER_OBSERVER_SCOPE_ID,
      keyId: receipt.signature.keyId,
      signedAt: new Date(receipt.signedAtUtc),
    });
  } catch {
    findings.push(`${label} signer is not authorized by the external production trust policy`);
    return;
  }
  if (authority.signerId !== receipt.signerId
    || trustPolicy.approvalAuthorities.some(({ keyId }) => keyId === receipt.signature.keyId)
    || trustPolicy.receiptAuthorities.some(({ scopeId, keyId }) => (
      scopeId !== SERVER_OBSERVER_SCOPE_ID && keyId === receipt.signature.keyId
    ))) {
    findings.push(`${label} key is not dedicated to the external server observer authority`);
  }
  const payload = productionG11ServerObserverReceiptPayload(receipt);
  try {
    if (!verifyTrustedEd25519Signature({
      key: authority.key,
      payload: canonicalJson(payload),
      signature: receipt.signature.value,
    })) findings.push(`${label} signature verification failed`);
  } catch {
    findings.push(`${label} signature verification failed`);
  }
}

function validateCaptureObserverCoverage({
  captureObservations,
  coverage,
  flowId,
  observerCheckIds,
  label,
  findings,
}) {
  if (!Array.isArray(coverage) || coverage.some((captured) => (
    !captured || typeof captured !== "object" || Array.isArray(captured)
  ))) {
    findings.push(`${label} coverage entries must be objects before observer binding`);
    return null;
  }
  if (!Array.isArray(captureObservations) || captureObservations.length !== coverage.length) {
    findings.push(`${label} must include one server observation for every capture binding`);
    return null;
  }
  const observations = new Map();
  for (const [index, observation] of captureObservations.entries()) {
    const observationLabel = `${label} captureObservations[${index}]`;
    if (!hasExactKeys(observation, [
      "traceId", "scenarioBinding", "scenarioPlanSha256", "checks",
    ], observationLabel, findings)) continue;
    if (observations.has(observation.traceId)) {
      findings.push(`${observationLabel} duplicates traceId ${observation.traceId}`);
      continue;
    }
    if (!observation.checks || typeof observation.checks !== "object" || Array.isArray(observation.checks)
      || !canonicalEqual(Object.keys(observation.checks).sort(compareStrings), [...observerCheckIds].sort(compareStrings))) {
      findings.push(`${observationLabel} checks do not match the protected observer partition`);
      continue;
    }
    if (Object.values(observation.checks).some((value) => (
      typeof value !== "boolean" && (!Number.isInteger(value) || value < 0)
    ))) {
      findings.push(`${observationLabel} checks must be booleans or non-negative integers`);
      continue;
    }
    observations.set(observation.traceId, observation);
  }
  for (const captured of coverage) {
    const observed = observations.get(captured.traceId);
    if (!observed
      || !canonicalEqual(observed.scenarioBinding, captured.scenarioBinding)
      || observed.scenarioPlanSha256 !== captured.scenarioPlanSha256) {
      findings.push(`${label} does not bind server checks to ${captured.traceId}`);
    }
  }
  if (observations.size !== coverage.length) return null;
  return Object.fromEntries(observerCheckIds.map((checkId) => {
    const values = coverage.map(({ traceId }) => observations.get(traceId).checks[checkId]);
    if (values.every((value) => typeof value === "boolean")) {
      return [checkId, values.every((value) => value === true)];
    }
    if (!values.every((value) => Number.isInteger(value) && value >= 0)) return [checkId, null];
    return [
      checkId,
      flowId === "long-run-7686-plus"
        ? Math.min(...values)
        : values.reduce((sum, value) => sum + value, 0),
    ];
  }));
}

function validateDistinctVisualStates(verifiedCells, findings) {
  for (const browser of BROWSERS) {
    for (const viewport of VIEWPORTS) {
      for (const motion of MOTIONS) {
        const hashes = VISUAL_STATES.map((state) => (
          verifiedCells.get(`${browser}/${state}/${viewport.id}/${motion}`)?.screenshotPixelSha256
        ));
        if (hashes.some((value) => !value) || new Set(hashes).size !== VISUAL_STATES.length) {
          findings.push(`${browser}/${viewport.id}/${motion} screenshots must contain distinct decoded pixels for every visual state`);
        }
      }
    }
  }
}

async function decodeVisiblePng({ cell, bytes, label, findings }) {
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: 2_000_000 });
    const [metadata, stats, raw] = await Promise.all([
      image.metadata(),
      image.clone().stats(),
      image.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    const viewport = VIEWPORTS.find(({ id }) => id === cell.viewport);
    if (metadata.format !== "png") findings.push(`${label} is not PNG`);
    if (metadata.width !== viewport?.width || metadata.height !== viewport?.height) {
      findings.push(`${label} dimensions do not match ${cell.viewport}`);
    }
    const entropy = Number(stats.entropy ?? 0);
    if (!Number.isFinite(entropy) || entropy < MIN_SCREENSHOT_ENTROPY) {
      findings.push(`${label} has insufficient visible pixel entropy`);
    }
    let opaquePixels = 0;
    for (let index = 3; index < raw.data.length; index += 4) {
      if (raw.data[index] >= 250) opaquePixels += 1;
    }
    const pixelCount = raw.info.width * raw.info.height;
    if (opaquePixels / pixelCount < 0.99) findings.push(`${label} must be at least 99% opaque`);
    return {
      data: raw.data,
      width: raw.info.width,
      height: raw.info.height,
      channels: raw.info.channels,
      pixelSha256: sha256Bytes(raw.data),
    };
  } catch (error) {
    findings.push(`${label} is not a decodable PNG`);
    return null;
  }
}

async function readExpectedReference({
  reference,
  kind,
  prefix,
  suffix,
  root,
  label,
  maximumBytes,
  findings,
}) {
  if (reference?.kind !== kind) {
    findings.push(`${label} kind must be ${kind}`);
    return null;
  }
  if (!reference.uri.startsWith(prefix) || !reference.uri.endsWith(suffix)) {
    findings.push(`${label} must be a ${suffix} under ${prefix}`);
    return null;
  }
  return readLocalReference(reference, root, label, maximumBytes, findings);
}

function parseCanonicalJsonArtifact(artifact, label, findings) {
  let document;
  let canonical;
  try {
    document = JSON.parse(artifact.bytes.toString("utf8"));
    canonical = canonicalJsonFile(document);
  } catch {
    findings.push(`${label} is not valid canonical JSON`);
    return null;
  }
  if (artifact.bytes.toString("utf8") !== canonical) {
    findings.push(`${label} must be canonical JSON with one trailing LF`);
    return null;
  }
  return document;
}

function validateSanitizedPlaywrightTrace(bytes, label, findings, expectedContext) {
  const initialFindingCount = findings.length;
  if (bytes.length < MIN_TRACE_BYTES) {
    findings.push(`${label} is too small to be a sanitized Playwright trace archive`);
    return traceValidationResult(false);
  }
  try {
    const entries = readZipEntries(bytes);
    const expectedEntries = ["calls.json", "metadata.json", "network.json"];
    if (!canonicalEqual([...entries.keys()].sort(compareStrings), expectedEntries)) {
      findings.push(`${label} must contain only calls.json, metadata.json, and network.json`);
    }
    const metadata = parseCanonicalJsonBytes(entries.get("metadata.json"), `${label} metadata`, findings);
    const calls = parseCanonicalJsonBytes(entries.get("calls.json"), `${label} calls`, findings);
    const network = parseCanonicalJsonBytes(entries.get("network.json"), `${label} network`, findings);
    if (!metadata || !calls || !network) return traceValidationResult(false);

    validateSanitizedTraceMetadata(metadata, label, expectedContext, findings);
    const assertionCount = validateSanitizedTraceCalls(calls, metadata, label, expectedContext, findings);
    const unexpectedNetworkFailureCount = validateSanitizedTraceNetwork(
      network,
      metadata,
      label,
      expectedContext,
      findings,
    );
    const unexpectedConsoleErrorCount = Number.isInteger(metadata.consoleCapture?.unexpectedErrorCount)
      ? metadata.consoleCapture.unexpectedErrorCount
      : 0;
    const unexpectedRuntimeFailureCount = Number.isInteger(metadata.runtimeCapture?.unexpectedFailureCount)
      ? metadata.runtimeCapture.unexpectedFailureCount
      : 0;
    return {
      valid: findings.length === initialFindingCount,
      nativeTraceSha256: metadata.nativeTraceSha256,
      unexpectedConsoleErrorCount,
      unexpectedNetworkFailureCount,
      unexpectedRuntimeFailureCount,
      assertionCount,
    };
  } catch {
    findings.push(`${label} is not a valid canonical sanitized ZIP trace`);
    return traceValidationResult(false);
  }
}

function validateSanitizedTraceMetadata(metadata, label, expected, findings) {
  hasExactKeys(metadata, [
    "schemaVersion", "traceId", "nativeTraceSha256", "browser", "viewport", "motion", "startedAtUtc",
    "finishedAtUtc", "scenarioId", "scenarioPlanSha256", "originPolicySha256", "scenarioBinding", "sseCapture",
    "consoleCapture", "runtimeCapture", "sanitization",
  ], `${label} metadata`, findings);
  if (metadata.schemaVersion !== "workbench.production-g11-sanitized-playwright-trace.v1") {
    findings.push(`${label} metadata schemaVersion is invalid`);
  }
  if (!validIdentifier(metadata.traceId) || !validSha256(metadata.nativeTraceSha256)) {
    findings.push(`${label} metadata trace identity is invalid`);
  }
  hasExactKeys(metadata.browser, ["name", "version"], `${label} browser`, findings);
  hasExactKeys(metadata.viewport, ["id", "width", "height"], `${label} viewport`, findings);
  if (!hasExactKeys(metadata.consoleCapture, ["complete", "unexpectedErrorCount", "records"], `${label} consoleCapture`, findings)
    || metadata.consoleCapture?.complete !== true
    || !Number.isInteger(metadata.consoleCapture?.unexpectedErrorCount)
    || metadata.consoleCapture.unexpectedErrorCount < 0
    || !Array.isArray(metadata.consoleCapture?.records)
    || metadata.consoleCapture.records.length !== metadata.consoleCapture.unexpectedErrorCount
    || metadata.consoleCapture.records.length > 1_000) {
    findings.push(`${label} console capture summary is invalid`);
  }
  const consoleIds = [];
  for (const [index, record] of (metadata.consoleCapture?.records ?? []).entries()) {
    const recordLabel = `${label} consoleCapture.records[${index}]`;
    if (!hasExactKeys(record, [
      "consoleId", "type", "sourceClass", "fingerprint", "attributionCode",
    ], recordLabel, findings)) continue;
    consoleIds.push(record.consoleId);
    if (record.consoleId !== `console-${index + 1}`
      || record.type !== "error"
      || !["browser-console", "page-error"].includes(record.sourceClass)
      || !validSha256(record.fingerprint)
      || record.attributionCode !== "unexpected-error") {
      findings.push(`${recordLabel} categorical attribution is invalid`);
    }
  }
  if (new Set(consoleIds).size !== consoleIds.length) findings.push(`${label} console IDs must be unique`);
  if (!hasExactKeys(metadata.runtimeCapture, [
    "complete", "browserDisconnectCount", "pageCrashCount", "unexpectedFailureCount",
  ], `${label} runtimeCapture`, findings)
    || metadata.runtimeCapture?.complete !== true
    || !Number.isInteger(metadata.runtimeCapture?.browserDisconnectCount)
    || metadata.runtimeCapture.browserDisconnectCount < 0
    || !Number.isInteger(metadata.runtimeCapture?.pageCrashCount)
    || metadata.runtimeCapture.pageCrashCount < 0
    || !Number.isInteger(metadata.runtimeCapture?.unexpectedFailureCount)
    || metadata.runtimeCapture.unexpectedFailureCount < 0
    || metadata.runtimeCapture.unexpectedFailureCount
      !== metadata.runtimeCapture.browserDisconnectCount + metadata.runtimeCapture.pageCrashCount) {
    findings.push(`${label} runtime capture summary is invalid`);
  } else if (metadata.runtimeCapture.unexpectedFailureCount !== 0) {
    findings.push(`${label} runtime capture contains an unexpected browser disconnect or page crash`);
  }
  const sanitizationKeys = [
    "algorithm", "nativeTraceExcluded", "temporaryNativeTraceOutsideEvidenceRoot", "nativeTraceDeleted",
    "headersRemoved", "bodiesRemoved", "cookiesRemoved", "queryValuesRemoved",
  ];
  if (!hasExactKeys(metadata.sanitization, sanitizationKeys, `${label} sanitization`, findings)
    || metadata.sanitization?.algorithm !== "strict-allowlist-v1"
    || sanitizationKeys.slice(1).some((key) => metadata.sanitization?.[key] !== true)) {
    findings.push(`${label} does not prove strict removal of native trace, headers, bodies, cookies, and query values`);
  }
  if (!isCanonicalUtcDateTime(metadata.startedAtUtc)
    || !isCanonicalUtcDateTime(metadata.finishedAtUtc)
    || new Date(metadata.finishedAtUtc) < new Date(metadata.startedAtUtc)) {
    findings.push(`${label} trace time window is invalid`);
  }
  validateSanitizedSseCapture(metadata.sseCapture, expected?.scenario?.scenarioId, `${label} sseCapture`, findings);
  const expectedValue = {
    traceId: expected?.traceId,
    nativeTraceSha256: expected?.nativeTraceSha256,
    browser: { name: expected?.browser, version: expected?.browserVersion },
    viewport: expected?.viewport,
    motion: expected?.motion,
    startedAtUtc: expected?.startedAtUtc,
    finishedAtUtc: expected?.finishedAtUtc,
    scenarioId: expected?.scenario?.scenarioId,
    scenarioPlanSha256: expected?.scenario?.scenarioPlanSha256,
    originPolicySha256: expected?.scenario?.originPolicySha256,
    scenarioBinding: expected?.scenario?.scenarioBinding,
  };
  for (const [key, value] of Object.entries(expectedValue)) {
    if (!canonicalEqual(metadata[key], value)) findings.push(`${label} metadata ${key} does not match its bound receipt`);
  }
}

function validateSanitizedSseCapture(capture, scenarioId, label, findings) {
  if (!hasExactKeys(capture, ["complete", "records"], label, findings)
    || capture?.complete !== true
    || !Array.isArray(capture?.records) || capture.records.length > G11_MAX_SSE_RECORDS) {
    findings.push(`${label} must contain a complete, bounded sanitized SSE sequence`);
    return;
  }
  const priorByStreamCursor = new Map();
  const segmentsByStream = new Map();
  const names = new Set();
  for (const [index, record] of capture.records.entries()) {
    const recordLabel = `${label}.records[${index}]`;
    const hasStrictShape = hasExactKeys(
      record,
      ["streamId", "afterSequence", "eventName", "sequence"],
      recordLabel,
      findings,
    );
    const validStreamId = validSha256(record?.streamId);
    const validCursor = Number.isInteger(record?.afterSequence)
      && record.afterSequence >= 0
      && record.afterSequence <= Number.MAX_SAFE_INTEGER;
    const validSequence = Number.isInteger(record?.sequence)
      && record.sequence > 0
      && record.sequence <= Number.MAX_SAFE_INTEGER;
    const groupKey = validStreamId && validCursor ? `${record.streamId}:${record.afterSequence}` : null;
    const prior = groupKey === null
      ? null
      : priorByStreamCursor.get(groupKey) ?? record.afterSequence;
    if (!hasStrictShape
      || !validStreamId
      || !validCursor
      || !SANITIZED_SSE_EVENT_NAMES.has(record?.eventName)
      || !validSequence
      || record.sequence !== prior + 1
    ) {
      findings.push(`${recordLabel} must be a contiguous sanitized RunEvent in its stream and reconnect cursor`);
      continue;
    }
    priorByStreamCursor.set(groupKey, record.sequence);
    const streamSegments = segmentsByStream.get(record.streamId) ?? new Map();
    const segment = streamSegments.get(record.afterSequence) ?? { end: record.afterSequence, count: 0 };
    segment.end = record.sequence;
    segment.count += 1;
    streamSegments.set(record.afterSequence, segment);
    segmentsByStream.set(record.streamId, streamSegments);
    names.add(record.eventName);
  }
  for (const [streamId, segments] of segmentsByStream) {
    const ordered = [...segments.entries()].sort(([left], [right]) => left - right);
    let previousEnd = null;
    for (const [afterSequence, segment] of ordered) {
      if (previousEnd !== null && afterSequence !== previousEnd) {
        findings.push(`${label} stream ${streamId} has a reconnect cursor gap or overlap`);
      }
      previousEnd = segment.end;
    }
  }
  const spec = SSE_CAPTURE_SPECS.get(scenarioId) ?? { minimumRecords: 0, requiredEventNames: [] };
  if (capture.records.length < spec.minimumRecords
    || (spec.maximumRecords !== undefined && capture.records.length > spec.maximumRecords)
    || spec.requiredEventNames.some((name) => !names.has(name))
    || (spec.requiresReconnectCursor === true
      && !capture.records.some(({ afterSequence }) => Number.isInteger(afterSequence) && afterSequence > 0))) {
    findings.push(`${label} does not contain sufficient flow-bound SSE evidence`);
  }
}

function validateSanitizedTraceCalls(document, metadata, label, expected, findings) {
  if (!hasExactKeys(document, ["schemaVersion", "traceId", "calls"], `${label} calls`, findings)) return 0;
  if (document.schemaVersion !== "workbench.production-g11-sanitized-playwright-calls.v1"
    || document.traceId !== metadata.traceId) {
    findings.push(`${label} calls identity is invalid`);
  }
  if (!Array.isArray(document.calls) || document.calls.length < 1 || document.calls.length > 5_000) {
    findings.push(`${label} calls must contain between 1 and 5000 sanitized call records`);
    return 0;
  }
  const traceDurationMs = new Date(metadata.finishedAtUtc).getTime() - new Date(metadata.startedAtUtc).getTime();
  const callIds = [];
  let assertionCount = 0;
  for (const [index, call] of document.calls.entries()) {
    const callLabel = `${label} calls[${index}]`;
    if (!hasExactKeys(call, [
      "callId", "stepId", "actionId", "apiName", "offsetMs", "durationMs", "status", "assertionCount", "assertions",
    ], callLabel, findings)) continue;
    callIds.push(call.callId);
    const expectedStep = expected?.scenario?.scenarioPlan?.browserSteps?.[index];
    if (call.callId !== `${metadata.traceId}-call-${index + 1}`
      || !expectedStep
      || !canonicalEqual({ stepId: call.stepId, actionId: call.actionId, apiName: call.apiName }, {
        stepId: expectedStep.stepId, actionId: expectedStep.actionId, apiName: expectedStep.apiName,
      })) {
      findings.push(`${callLabel} identity is invalid`);
    }
    if (!validTraceDuration(call.offsetMs) || !validTraceDuration(call.durationMs)
      || call.offsetMs + call.durationMs > traceDurationMs) {
      findings.push(`${callLabel} timing is outside the trace window`);
    }
    if (call.status !== "PASS") findings.push(`${callLabel} status must be PASS`);
    if (!Number.isInteger(call.assertionCount) || call.assertionCount < 1 || call.assertionCount > 10_000) {
      findings.push(`${callLabel} must contain at least one successful browser assertion`);
    }
    if (!Array.isArray(call.assertions) || call.assertions.length !== call.assertionCount
      || call.assertions.length < 1 || call.assertions.length > 10_000) {
      findings.push(`${callLabel} assertion records do not match assertionCount`);
      continue;
    }
    if (call.assertions.length !== expectedStep?.assertions?.length) {
      findings.push(`${callLabel} assertions must exactly equal the protected scenario assertion sequence`);
    }
    for (const [assertionIndex, assertion] of call.assertions.entries()) {
      const assertionLabel = `${callLabel} assertions[${assertionIndex}]`;
      if (!hasExactKeys(assertion, ["assertionId", "stepId", "assertionSpecId", "kind", "status"], assertionLabel, findings)) continue;
      const expectedAssertion = expectedStep?.assertions?.[assertionIndex];
      if (assertion.assertionId !== `${metadata.traceId}-call-${index + 1}-assertion-${assertionIndex + 1}`
        || assertion.stepId !== call.stepId
        || !expectedAssertion
        || assertion.assertionSpecId !== expectedAssertion.assertionSpecId
        || assertion.kind !== expectedAssertion.kind
        || assertion.status !== "PASS") {
        findings.push(`${assertionLabel} outcome or deterministic identity is invalid`);
      }
    }
    assertionCount += call.assertions.length;
  }
  if (new Set(callIds).size !== callIds.length) findings.push(`${label} callId values must be unique`);
  const expectedCalls = expected?.scenario?.scenarioPlan?.browserSteps ?? [];
  if (!Array.isArray(expectedCalls) || expectedCalls.length < 1 || document.calls.length !== expectedCalls.length) {
    findings.push(`${label} calls must exactly equal the protected scenario step count`);
  }
  return assertionCount;
}

function validateSanitizedTraceNetwork(document, metadata, label, expected, findings) {
  if (!hasExactKeys(document, ["schemaVersion", "traceId", "captureComplete", "requests"], `${label} network`, findings)) {
    return 0;
  }
  if (document.schemaVersion !== "workbench.production-g11-sanitized-playwright-network.v1"
    || document.traceId !== metadata.traceId || document.captureComplete !== true) {
    findings.push(`${label} network identity or capture completeness is invalid`);
  }
  if (!Array.isArray(document.requests) || document.requests.length < 1 || document.requests.length > 10_000) {
    findings.push(`${label} network must contain between 1 and 10000 categorized requests`);
    return 0;
  }
  const requestIds = [];
  let unexpectedFailureCount = 0;
  for (const [index, request] of document.requests.entries()) {
    const requestLabel = `${label} network.requests[${index}]`;
    if (!hasExactKeys(request, [
      "requestId", "method", "originClass", "pathClass", "resourceType", "statusCode", "failureClass",
      "routeTemplateId", "routeBindingSha256", "outcomeClass", "expectationRuleId", "attributionCode",
      "durationMs", "origin", "remoteAddress", "remotePort",
    ], requestLabel, findings)) continue;
    requestIds.push(request.requestId);
    if (request.requestId !== `request-${index + 1}`
      || !["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(request.method)
      || !["web", "preview", "approved-third-party"].includes(request.originClass)
      || !["document", "auth", "api", "sse", "asset", "preview-rpc", "artifact", "other"].includes(request.pathClass)
      || !SANITIZED_ROUTE_TEMPLATE_IDS.has(request.routeTemplateId)
      || !validSha256(request.routeBindingSha256)
      || !["document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "eventsource", "websocket", "other"].includes(request.resourceType)
      || !["none", "dns", "tls", "connection", "timeout", "aborted", "other"].includes(request.failureClass)) {
      findings.push(`${requestLabel} contains non-categorical or invalid metadata`);
    }
    if (!validPublicRemoteAddress(request.remoteAddress)
      || !Number.isInteger(request.remotePort) || request.remotePort < 1 || request.remotePort > 65_535
      || !requestOriginMatchesPolicy(request, expected?.scenario?.originPolicySha256, expected?.scenario?.scenarioPlan, expected)) {
      findings.push(`${requestLabel} remote endpoint or origin-policy attribution is invalid`);
    }
    if (!Number.isInteger(request.statusCode) || request.statusCode < 0 || request.statusCode > 599
      || !validTraceDuration(request.durationMs)) {
      findings.push(`${requestLabel} status or timing is invalid`);
    }
    const expectedOutcome = deriveExpectedNetworkOutcome(request, expected);
    if (!canonicalEqual({
      outcomeClass: request.outcomeClass,
      expectationRuleId: request.expectationRuleId,
      attributionCode: request.attributionCode,
    }, expectedOutcome)) findings.push(`${requestLabel} HTTP outcome attribution is invalid`);
    if (["transport-failure", "unexpected-http-error", "unexpected-unknown"].includes(request.outcomeClass)) {
      unexpectedFailureCount += 1;
    }
  }
  if (new Set(requestIds).size !== requestIds.length) findings.push(`${label} requestId values must be unique`);
  return unexpectedFailureCount;
}

function deriveExpectedNetworkOutcome(request, expected) {
  if (request.failureClass !== "none") {
    return { outcomeClass: "transport-failure", expectationRuleId: "none", attributionCode: "transport-failure" };
  }
  if (request.pathClass === "other" || request.resourceType === "other" || request.statusCode < 100) {
    return { outcomeClass: "unexpected-unknown", expectationRuleId: "none", attributionCode: "unknown-classification" };
  }
  if (request.statusCode >= 500) {
    return { outcomeClass: "unexpected-http-error", expectationRuleId: "none", attributionCode: "unexpected-http-status" };
  }
  if (request.statusCode >= 400) {
    const rule = expected?.scenario?.scenarioPlan?.expectedHttpErrors
      ?.find(({ ruleId }) => ruleId === request.expectationRuleId);
    if (rule
      && rule.method === request.method
      && rule.originClass === request.originClass
      && rule.pathClass === request.pathClass
      && rule.routeTemplateId === request.routeTemplateId
      && rule.routeBindingSha256 === request.routeBindingSha256
      && rule.statusCodes.includes(request.statusCode)) {
      return {
        outcomeClass: "expected-http-error",
        expectationRuleId: request.expectationRuleId,
        attributionCode: "expected-client-rejection",
      };
    }
    return { outcomeClass: "unexpected-http-error", expectationRuleId: "none", attributionCode: "unexpected-http-status" };
  }
  return {
    outcomeClass: "expected-success",
    expectationRuleId: "none",
    attributionCode: request.originClass === "approved-third-party" ? "approved-third-party" : "first-party",
  };
}

function validPublicRemoteAddress(address) {
  return typeof address === "string" && isIP(normalizeHostname(address)) > 0 && !isNonPublicAddress(address);
}

function requestOriginMatchesPolicy(request, originPolicySha256, scenarioPlan, expected) {
  if (!validSha256(originPolicySha256) || !scenarioPlan || typeof request.origin !== "string") return false;
  const policy = expected?.scenario?.originPolicy;
  if (!policy) return false;
  let origin;
  try {
    origin = new URL(request.origin);
  } catch {
    return false;
  }
  if (request.origin !== origin.origin || origin.protocol !== "https:") return false;
  if (request.originClass === "web") return request.origin === policy.web;
  if (request.originClass === "preview") return request.origin === policy.preview;
  return request.originClass === "approved-third-party" && policy.approvedThirdParty.includes(request.origin);
}

function parseCanonicalJsonBytes(bytes, label, findings) {
  if (!Buffer.isBuffer(bytes)) {
    findings.push(`${label} is missing`);
    return null;
  }
  return parseCanonicalJsonArtifact({ bytes }, label, findings);
}

function scenarioForTrace({ manifest, browser, motion, traceId, viewport, scenarioBinding }, label, findings) {
  const scenarioId = productionG11ScenarioId({
    browserName: browser,
    motion,
    traceId,
    viewport,
  });
  try {
    const scenarioPlan = productionG11ScenarioPlan({ scenarioId, scenarioBinding });
    return {
      scenarioId,
      scenarioBinding: structuredClone(scenarioBinding),
      scenarioPlan,
      scenarioPlanSha256: productionG11ScenarioPlanSha256({ scenarioId, scenarioBinding }),
      originPolicy: productionG11OriginPolicy(manifest.deployment),
      originPolicySha256: productionG11OriginPolicySha256(manifest.deployment),
    };
  } catch {
    findings.push(`${label} cannot bind to a protected G11 scenario`);
    return null;
  }
}

function traceValidationResult(valid) {
  return {
    valid,
    nativeTraceSha256: null,
    unexpectedConsoleErrorCount: 0,
    unexpectedNetworkFailureCount: 0,
    unexpectedRuntimeFailureCount: 0,
    assertionCount: 0,
  };
}

function validTraceDuration(value) {
  return Number.isFinite(value) && value >= 0 && value <= 3_600_000;
}


function readZipEntries(bytes) {
  const minimumEocdOffset = Math.max(0, bytes.length - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("end-of-central-directory record is missing");
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entryCountOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entryCountOnDisk !== 3 || entryCount !== 3) {
    throw new Error("sanitized traces must be single-disk ZIP files with exactly three entries");
  }
  if (commentLength !== 0 || eocdOffset + 22 !== bytes.length) {
    throw new Error("sanitized traces must not contain a ZIP comment or trailing data");
  }
  if (centralOffset + centralSize !== eocdOffset) throw new Error("central-directory bounds are inconsistent");

  const expectedEntryOrder = ["metadata.json", "calls.json", "network.json"];
  const entries = new Map();
  const localRanges = [];
  let totalUncompressedBytes = 0;
  let offset = centralOffset;
  let expectedLocalOffset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("central-directory entry is invalid");
    }
    const versionMadeBy = bytes.readUInt16LE(offset + 4);
    const versionNeeded = bytes.readUInt16LE(offset + 6);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const modifiedTime = bytes.readUInt16LE(offset + 12);
    const modifiedDate = bytes.readUInt16LE(offset + 14);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const internalAttributes = bytes.readUInt16LE(offset + 36);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (nameLength === 0 || offset + 46 + nameLength + extraLength + entryCommentLength > eocdOffset) {
      throw new Error("central-directory entry bounds are invalid");
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const entryLabel = `sanitized trace entry ${index + 1}`;
    if (versionMadeBy !== 20 || versionNeeded !== 20 || flags !== 0 || method !== 0
      || modifiedTime !== 0 || modifiedDate !== 0
      || diskStart !== 0 || internalAttributes !== 0 || externalAttributes !== 0
      || compressedSize !== uncompressedSize) {
      throw new Error(`${entryLabel} is not canonical`);
    }
    if (extraLength !== 0 || entryCommentLength !== 0) {
      throw new Error(`${entryLabel} has forbidden metadata`);
    }
    if (!name || name.startsWith("/") || name.split("/").some((segment) => segment === "..")) {
      throw new Error("trace entry path is unsafe");
    }
    if (name !== expectedEntryOrder[index]) throw new Error(`${entryLabel} is out of canonical order`);
    if (entries.has(name)) throw new Error(`${entryLabel} is duplicated`);
    if (compressedSize > MAX_TRACE_ENTRY_BYTES || uncompressedSize > MAX_TRACE_ENTRY_BYTES) {
      throw new Error(`${entryLabel} exceeds the size limit`);
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_TRACE_UNCOMPRESSED_BYTES) {
      throw new Error("sanitized trace exceeds the total uncompressed-size limit");
    }
    // The physical local-header order is part of the canonical archive, not just
    // the central-directory order. This prevents a byte-different ZIP from
    // being accepted after its local blocks are rearranged.
    if (localOffset !== expectedLocalOffset) {
      throw new Error(`${entryLabel} local header is out of canonical order`);
    }
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${entryLabel} local header is invalid`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localVersionNeeded = bytes.readUInt16LE(localOffset + 4);
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localModifiedTime = bytes.readUInt16LE(localOffset + 10);
    const localModifiedDate = bytes.readUInt16LE(localOffset + 12);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localVersionNeeded !== 20 || localFlags !== flags || localMethod !== method
      || localModifiedTime !== 0 || localModifiedDate !== 0
      || localName !== name || localExtraLength !== 0
      || localCrc !== expectedCrc || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize) {
      throw new Error(`${entryLabel} local and central headers differ`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    if (compressed.length !== compressedSize || dataOffset + compressedSize > centralOffset) {
      throw new Error(`${entryLabel} content is truncated`);
    }
    const data = compressed;
    if (data.length !== uncompressedSize || (crc32(data) >>> 0) !== expectedCrc) {
      throw new Error(`${entryLabel} size or CRC is invalid`);
    }
    entries.set(name, data);
    expectedLocalOffset = dataOffset + compressedSize;
    localRanges.push({ start: localOffset, end: expectedLocalOffset });
    offset += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (offset !== eocdOffset) throw new Error("central-directory size does not match its entries");
  if (expectedLocalOffset !== centralOffset
    || localRanges[0]?.start !== 0
    || localRanges.at(-1)?.end !== centralOffset
    || localRanges.some((range, index) => index > 0 && localRanges[index - 1].end !== range.start)) {
    throw new Error("sanitized trace local entries must be contiguous with no hidden or overlapping bytes");
  }
  return entries;
}

function pixelDiffRatio(before, after, bounds, label, findings) {
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) {
    findings.push(`${label} frame dimensions or channels differ`);
    return null;
  }
  if (!validBounds(bounds, { width: before.width, height: before.height })) {
    findings.push(`${label} is invalid for the decoded frame dimensions`);
    return null;
  }
  let changed = 0;
  const channels = before.channels;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = (y * before.width + x) * channels;
      let pixelChanged = false;
      for (let channel = 0; channel < channels; channel += 1) {
        if (Math.abs(before.data[offset + channel] - after.data[offset + channel]) > 2) {
          pixelChanged = true;
          break;
        }
      }
      if (pixelChanged) changed += 1;
    }
  }
  return changed / (bounds.width * bounds.height);
}

function validBounds(value, viewport) {
  return value
    && Number.isInteger(value.x)
    && Number.isInteger(value.y)
    && Number.isInteger(value.width)
    && Number.isInteger(value.height)
    && value.x >= 0
    && value.y >= 0
    && value.width >= 16
    && value.height >= 16
    && value.x + value.width <= viewport?.width
    && value.y + value.height <= viewport?.height;
}

function hasExactKeys(value, expectedKeys, label, findings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push(`${label} must be an object`);
    return false;
  }
  const actualKeys = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  if (canonicalJson(actualKeys) !== canonicalJson(expected)) {
    findings.push(`${label} keys do not match the strict evidence contract`);
    return false;
  }
  return true;
}

function validateEvidenceTime(value, minimum, maximum, label, findings) {
  if (!isCanonicalUtcDateTime(value)) {
    findings.push(`${label} timestamp is invalid`);
    return false;
  }
  const time = new Date(value);
  if (!isCanonicalUtcDateTime(minimum) || !isCanonicalUtcDateTime(maximum)
    || time < new Date(minimum) || time > new Date(maximum)) {
    findings.push(`${label} timestamp is outside its parent evidence window`);
    return false;
  }
  return true;
}

function deploymentIdentity(deployment) {
  const { receipt: _receipt, ...identity } = deployment;
  return identity;
}

function validIdentifier(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u.test(value);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function numberNear(left, right, tolerance) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function canonicalEqual(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

async function readLocalReference(reference, root, label, maximumBytes, findings) {
  try {
    const match = reference?.uri?.match(FILE_URI_PATTERN);
    if (!match || match[1].split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("must be a traversal-free file:./raw/g11/ reference");
    }
    const candidate = path.resolve(root, ...match[1].split("/"));
    assertWithin(root, candidate, `${label} escapes the G11 evidence root`);
    const artifact = await readStableRegularFile(candidate, label, maximumBytes);
    assertWithin(root, artifact.path, `${label} resolves outside the G11 evidence root`);
    const actualSha256 = sha256Bytes(artifact.bytes);
    if (actualSha256 !== reference.sha256) {
      throw new Error(`SHA-256 mismatch: expected ${reference.sha256}, got ${actualSha256}`);
    }
    if (label === "G11 real-stack manifest") {
      let document;
      try {
        document = JSON.parse(artifact.bytes.toString("utf8"));
      } catch {
        throw new Error("is not valid JSON");
      }
      return { ...artifact, document };
    }
    return artifact;
  } catch (error) {
    const message = `${label} cannot be verified`;
    if (findings) {
      findings.push(message);
      return null;
    }
    throw new ProductionAcceptanceContractError([message]);
  }
}

async function readStableRegularFile(candidatePath, label, maximumBytes) {
  const before = await lstat(candidatePath).catch((error) => {
    throw new Error(`${label} cannot be read: ${error.message}`);
  });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("must be a regular non-symlink file");
  if (before.size < 1 || before.size > maximumBytes) throw new Error(`must contain 1-${maximumBytes} bytes`);
  const canonicalPath = await realpath(candidatePath);
  const bytes = await readFile(canonicalPath);
  const after = await lstat(canonicalPath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("changed while it was read");
  }
  return { path: canonicalPath, bytes };
}

async function canonicalDirectory(candidatePath, label) {
  const resolved = path.resolve(candidatePath ?? "");
  const info = await lstat(resolved).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read`]);
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ProductionAcceptanceContractError([`${label} must be a real non-symlink directory`]);
  }
  return realpath(resolved);
}

async function manifestSchemaValidator() {
  schemaValidatorPromise ??= readFile(schemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return schemaValidatorPromise;
}

function visualCellKey(cell) {
  return `${cell.browser}/${cell.state}/${cell.viewport}/${cell.motion}`;
}

function compareEvidence(left, right) {
  return compareStrings(`${left.uri}\0${left.kind}`, `${right.uri}\0${right.kind}`);
}

function compareEvidenceReference(left, right) {
  return compareStrings(`${left.uri}\0${left.sha256}`, `${right.uri}\0${right.sha256}`);
}

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

function assertWithin(root, candidate, message) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/u, "");
}

function canonicalOriginIdentity(url) {
  const hostname = normalizeHostname(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${hostname}:${port}`;
}

function isNonProductionHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized || normalized.split(".").some((label) => FORBIDDEN_HOSTNAME_LABELS.has(label))) return true;
  if (/^(?:localhost|localhost\.|.*\.(?:local|localhost|test|invalid|example|internal|home\.arpa|onion))$/u.test(normalized)) {
    return true;
  }
  if (/(?:^|\.)example\.(?:com|net|org)$/u.test(normalized)) return true;
  return isIP(normalized) > 0 && isNonPublicAddress(normalized);
}

function isNonPublicAddress(address) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 0) return true;
  return family === 4
    ? NON_PUBLIC_ADDRESS_BLOCKS.ipv4.check(normalized, "ipv4")
    : NON_PUBLIC_ADDRESS_BLOCKS.ipv6.check(normalized, "ipv6");
}

function createNonPublicAddressBlockLists() {
  const ipv4 = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ]) ipv4.addSubnet(network, prefix, "ipv4");
  const ipv6 = new BlockList();
  for (const [network, prefix] of [
    // IPv4-compatible, unspecified, loopback, and mapped IPv6 forms.
    ["::", 96], ["::1", 128], ["::ffff:0:0", 96],
    // IPv6 special-purpose and documentation ranges which are not public origins.
    ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2002::", 16], ["3fff::", 20],
    ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ]) ipv6.addSubnet(network, prefix, "ipv6");
  return Object.freeze({ ipv4, ipv6 });
}

function createBoundedFindings() {
  const findings = [];
  let truncated = false;
  Object.defineProperty(findings, "push", {
    value: (...values) => {
      for (const value of values) {
        if (findings.length < MAX_FINDINGS - 1) Array.prototype.push.call(findings, String(value).slice(0, 1_024));
        else if (!truncated) {
          Array.prototype.push.call(findings, "G11 validation stopped after the bounded finding limit");
          truncated = true;
        }
      }
      return findings.length;
    },
  });
  return findings;
}
