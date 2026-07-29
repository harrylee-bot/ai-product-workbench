import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
} from "../evidence-ledger.mjs";
import { ProductionAcceptanceContractError } from "./catalog.mjs";
import { createStrictAjv2020, isCanonicalUtcDateTime } from "./schema.mjs";

export const PRODUCTION_G11_REAL_STACK_SCHEMA_VERSION = "workbench.production-g11-real-stack-manifest.v1";
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
const MANIFEST_URI = "file:./raw/g11/manifest.json";
const FILE_URI_PATTERN = /^file:\.\/(raw\/g11\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/u;
const FORBIDDEN_RUNTIME_MARKER = /(?:controlled|fixture|fake|mock|synthetic|localhost|loopback)/iu;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_FLOW_EVIDENCE_BYTES = 50 * 1024 * 1024;
const BROWSERS = Object.freeze(["chromium", "firefox", "webkit"]);
const VIEWPORTS = Object.freeze([
  Object.freeze({ id: "375x812", width: 375, height: 812 }),
  Object.freeze({ id: "768x1024", width: 768, height: 1024 }),
  Object.freeze({ id: "1440x900", width: 1440, height: 900 }),
]);
const MOTIONS = Object.freeze(["normal", "reduced"]);
const VISUAL_STATES = Object.freeze(["prd-active", "prd-pending", "prototype-after-prd"]);

const FLOW_SPECS = Object.freeze(new Map([
  ["account-project", booleanFlow([
    "accountCreated",
    "loginCompleted",
    "invitationAccepted",
    "workspaceOpened",
    "projectOpened",
    "membershipRolesEnforced",
    "revokedAccessDenied",
    "expiredInvitationDenied",
    "unauthorizedPathsClosed",
  ])],
  ["prd", booleanFlow([
    "requestAccepted",
    "loadingCompositionRendered",
    "activePanelContextRendered",
    "stageSequenceContinuous",
    "readyArtifactPersisted",
    "checksumVerified",
  ])],
  ["mixed-rejection", Object.freeze({
    keys: Object.freeze([
      "problemStatus",
      "queuePublishCount",
      "runCount",
      "runtimeAttemptCount",
      "artifactVersionCount",
      "providerInvocationCount",
      "sseEventCount",
    ]),
    passes: (checks) => Number.isInteger(checks.problemStatus)
      && checks.problemStatus >= 400
      && checks.problemStatus <= 499
      && [
        "queuePublishCount",
        "runCount",
        "runtimeAttemptCount",
        "artifactVersionCount",
        "providerInvocationCount",
        "sseEventCount",
      ].every((key) => checks[key] === 0),
  })],
  ["prototype-after-prd", booleanFlow([
    "startedAfterPrd",
    "nullGapPrdMotionAbsent",
    "thinkingGapPrdMotionAbsent",
    "prototypeMotionRendered",
    "readyArtifactPersisted",
  ])],
  ["refresh-reconnect", booleanFlow([
    "reconnectCursorAdvanced",
    "sequenceContinuous",
    "stateRestored",
    "artifactPersisted",
  ])],
  ["preview-import-export", booleanFlow([
    "fileImportCompleted",
    "knowledgeImportCompleted",
    "exportCompleted",
    "previewLoaded",
    "explicitPublicationConfirmation",
    "failureRecoveryPassed",
    "checksumVerified",
  ])],
  ["run-canvas-sse-artifact", booleanFlow([
    "runCompleted",
    "approvalPassed",
    "failurePassed",
    "cancelPassed",
    "retryPassed",
    "canvasGatewayUsed",
    "prototypePatchStableNodeIds",
    "sseDurable",
    "sequenceContinuous",
    "authorizationPassed",
    "idempotencyPreserved",
    "artifactPersisted",
    "checksumVerified",
    "revisionAdvanced",
  ])],
  ["accessibility-preview-security", booleanFlow([
    "keyboardPassed",
    "focusPassed",
    "accessibleNamesPassed",
    "contrastPassed",
    "reducedMotionPassed",
    "previewIndependentOrigin",
    "previewCredentialless",
    "previewAllowSameOriginAbsent",
    "previewNoReferrer",
    "previewCapabilityValidated",
    "previewRpcPassed",
    "previewTimeoutProtected",
    "previewGenerationProtected",
  ])],
  ["long-run-7686-plus", Object.freeze({
    keys: Object.freeze([
      "minimumEventCount",
      "observedEventCount",
      "crossedBoundary",
      "terminalStateCorrect",
      "retryRecoveryPassed",
    ]),
    passes: (checks) => Number.isInteger(checks.minimumEventCount)
      && checks.minimumEventCount >= 7_686
      && Number.isInteger(checks.observedEventCount)
      && checks.observedEventCount >= checks.minimumEventCount
      && checks.crossedBoundary === true
      && checks.terminalStateCorrect === true
      && checks.retryRecoveryPassed === true,
  })],
  ["knowledge-null-valid", booleanFlow([
    "nullReleaseGrantAbsent",
    "nullReleaseSecretAbsent",
    "nullReleaseCatalogAbsent",
    "validPinnedReleaseVisible",
    "validPinnedReleaseInvocationPassed",
    "concurrentScopeIsolated",
    "secretsNotPersisted",
  ])],
  ["provider-state-integrity", Object.freeze({
    keys: Object.freeze([
      "textComplete",
      "effectsComplete",
      "draftComplete",
      "artifactsComplete",
      "duplicateTextCount",
      "lostTextCount",
      "duplicateEffectCount",
      "lostEffectCount",
      "duplicateDraftCount",
      "lostDraftCount",
      "duplicateArtifactCount",
      "lostArtifactCount",
    ]),
    passes: (checks) => [
      "textComplete",
      "effectsComplete",
      "draftComplete",
      "artifactsComplete",
    ].every((key) => checks[key] === true)
      && [
        "duplicateTextCount",
        "lostTextCount",
        "duplicateEffectCount",
        "lostEffectCount",
        "duplicateDraftCount",
        "lostDraftCount",
        "duplicateArtifactCount",
        "lostArtifactCount",
      ].every((key) => checks[key] === 0),
  })],
]));

let schemaValidatorPromise;

export function isProductionG11RealStackControl(controlId) {
  return PRODUCTION_G11_REAL_STACK_CONTROL_IDS.includes(controlId);
}

export async function loadProductionG11RealStackManifest({
  reference,
  evidenceRoot,
  plan,
  executedAtUtc,
} = {}) {
  const findings = [];
  if (reference?.uri !== MANIFEST_URI) findings.push(`G11 execution evidence must be ${MANIFEST_URI}`);
  if (!/^[a-f0-9]{64}$/u.test(reference?.sha256 ?? "")) findings.push("G11 execution evidence SHA-256 is invalid");
  if (!plan?.payload) findings.push("G11 validation requires a frozen production acceptance plan");
  if (!isCanonicalUtcDateTime(executedAtUtc)) findings.push("G11 observation executedAtUtc is invalid");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const root = await canonicalDirectory(evidenceRoot, "G11 evidence root");
  const artifact = await readLocalReference(reference, root, "G11 real-stack manifest", MAX_MANIFEST_BYTES);
  if (artifact.bytes.toString("utf8") !== canonicalJsonFile(artifact.document)) {
    throw new ProductionAcceptanceContractError(["G11 real-stack manifest must be canonical JSON with one trailing LF"]);
  }
  const validate = await manifestSchemaValidator();
  if (!validate(artifact.document)) {
    throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
      `G11 real-stack manifest${error.instancePath || "/"} ${error.message}`
    )));
  }

  validateManifestSemantics({
    manifest: artifact.document,
    plan,
    executedAtUtc,
    findings,
  });

  const evidence = [];
  for (const cell of artifact.document.visualMatrix) {
    if (cell.screenshot.kind !== "browser-screenshot") {
      findings.push(`${visualCellKey(cell)} screenshot kind must be browser-screenshot`);
      continue;
    }
    if (!cell.screenshot.uri.startsWith("file:./raw/g11/screenshots/") || !cell.screenshot.uri.endsWith(".png")) {
      findings.push(`${visualCellKey(cell)} screenshot must be a PNG under file:./raw/g11/screenshots/`);
      continue;
    }
    const screenshot = await readLocalReference(
      cell.screenshot,
      root,
      `${visualCellKey(cell)} screenshot`,
      MAX_SCREENSHOT_BYTES,
      findings,
    );
    if (screenshot) {
      await validateScreenshot({ cell, bytes: screenshot.bytes, findings });
      evidence.push(structuredClone(cell.screenshot));
    }
  }

  for (const flow of artifact.document.flows) {
    for (const referenceValue of flow.evidence) {
      if (referenceValue.kind !== "browser-flow-evidence") {
        findings.push(`${flow.flowId} evidence kind must be browser-flow-evidence`);
        continue;
      }
      if (!referenceValue.uri.startsWith("file:./raw/g11/flows/")) {
        findings.push(`${flow.flowId} evidence must be under file:./raw/g11/flows/`);
        continue;
      }
      const flowArtifact = await readLocalReference(
        referenceValue,
        root,
        `${flow.flowId} evidence`,
        MAX_FLOW_EVIDENCE_BYTES,
        findings,
      );
      if (flowArtifact && flowArtifact.bytes.length === 0) findings.push(`${flow.flowId} evidence is empty`);
      if (flowArtifact) evidence.push(structuredClone(referenceValue));
    }
  }

  const uris = evidence.map(({ uri }) => uri);
  if (new Set(uris).size !== uris.length) findings.push("G11 manifest evidence URIs must be unique across the complete closure");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const derived = deriveProductionG11Values(artifact.document);
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

export function deriveProductionG11Values(manifest) {
  const flowPasses = new Map(manifest.flows.map((flow) => [flow.flowId, flowPassesChecks(flow)]));
  const allVisualCellsPass = manifest.visualMatrix.every((cell) => visualCellPasses(cell));
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
      && (cell.motion !== "reduced" || reducedMotionCellPasses(cell))
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
  const consoleErrorCount = manifest.unexpectedConsoleErrors.reduce((sum, item) => sum + item.count, 0);
  const failedRequestCount = manifest.unexpectedNetworkFailures.reduce((sum, item) => sum + item.count, 0);
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

function validateManifestSemantics({ manifest, plan, executedAtUtc, findings }) {
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
  if (manifest.harness.sourceCommit !== plan.payload.binding.commitSha) {
    findings.push("G11 harness sourceCommit differs from the deployed candidate");
  }
  if (FORBIDDEN_RUNTIME_MARKER.test(`${manifest.deployment.provider.id} ${manifest.deployment.provider.version}`)) {
    findings.push("G11 manifest provider contains a controlled-local or fixture marker");
  }
  validateProductionOrigins(manifest.deployment, findings);

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
  for (const cell of manifest.visualMatrix) {
    const passed = visualCellPasses(cell);
    if (cell.status !== (passed ? "PASS" : "FAIL")) {
      findings.push(`${visualCellKey(cell)} status differs from its rendered evidence`);
    }
  }

  const actualFlowIds = manifest.flows.map(({ flowId }) => flowId).sort(compareStrings);
  const expectedFlowIds = [...FLOW_SPECS.keys()].sort(compareStrings);
  if (canonicalJson(actualFlowIds) !== canonicalJson(expectedFlowIds)) {
    findings.push("G11 manifest flows must exactly cover the protected product/runtime matrix");
  }
  for (const flow of manifest.flows) {
    const spec = FLOW_SPECS.get(flow.flowId);
    if (!spec) continue;
    const actualKeys = Object.keys(flow.checks).sort(compareStrings);
    const expectedKeys = [...spec.keys].sort(compareStrings);
    if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) {
      findings.push(`${flow.flowId} checks must exactly match its protected contract`);
      continue;
    }
    const passed = spec.passes(flow.checks);
    if (flow.status !== (passed ? "PASS" : "FAIL")) {
      findings.push(`${flow.flowId} status differs from its structured checks`);
    }
  }
}

function validateProductionOrigins(deployment, findings) {
  let web;
  let preview;
  try {
    web = new URL(deployment.webOrigin);
    preview = new URL(deployment.previewOrigin);
  } catch {
    findings.push("G11 Web and Preview origins must be valid URLs");
    return;
  }
  for (const [label, value, url] of [
    ["Web", deployment.webOrigin, web],
    ["Preview", deployment.previewOrigin, preview],
  ]) {
    if (url.protocol !== "https:" || value !== url.origin || url.username || url.password || url.search || url.hash) {
      findings.push(`G11 ${label} origin must be a credential-free canonical HTTPS origin`);
    }
    if (isLocalHostname(url.hostname)) findings.push(`G11 ${label} origin must not be local or private`);
  }
  if (web.origin === preview.origin) findings.push("G11 Web and Preview origins must be distinct");
}

function visualCellPasses(cell) {
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
    ? reducedMotionCellPasses(cell)
    : cell.motionEvidence.reducedMotionMedia === false
      && cell.motionEvidence.animationDurationMs > 1
      && cell.motionEvidence.frameChanged === true;
  return layoutPassed && statePassed && motionPassed;
}

function reducedMotionCellPasses(cell) {
  return cell.motionEvidence.reducedMotionMedia === true
    && cell.motionEvidence.animationDurationMs <= 1
    && cell.motionEvidence.frameChanged === false;
}

function flowPassesChecks(flow) {
  const spec = FLOW_SPECS.get(flow.flowId);
  if (!spec) return false;
  const actualKeys = Object.keys(flow.checks).sort(compareStrings);
  const expectedKeys = [...spec.keys].sort(compareStrings);
  return canonicalJson(actualKeys) === canonicalJson(expectedKeys) && spec.passes(flow.checks);
}

async function validateScreenshot({ cell, bytes, findings }) {
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: 2_000_000 });
    const [metadata, stats] = await Promise.all([image.metadata(), image.clone().stats()]);
    const viewport = VIEWPORTS.find(({ id }) => id === cell.viewport);
    if (metadata.format !== "png") findings.push(`${visualCellKey(cell)} screenshot is not PNG`);
    if (metadata.width !== viewport?.width || metadata.height !== viewport?.height) {
      findings.push(`${visualCellKey(cell)} screenshot dimensions do not match ${cell.viewport}`);
    }
    if (!stats.channels.some((channel) => channel.max > channel.min)) {
      findings.push(`${visualCellKey(cell)} screenshot is a blank single-color image`);
    }
  } catch (error) {
    findings.push(`${visualCellKey(cell)} screenshot is not a decodable PNG: ${error.message}`);
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
      } catch (error) {
        throw new Error(`is not valid JSON: ${error.message}`);
      }
      return { ...artifact, document };
    }
    return artifact;
  } catch (error) {
    const message = `${label} cannot be verified: ${error.message}`;
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
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
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

function booleanFlow(keys) {
  return Object.freeze({
    keys: Object.freeze(keys),
    passes: (checks) => keys.every((key) => checks[key] === true),
  });
}

function visualCellKey(cell) {
  return `${cell.browser}/${cell.state}/${cell.viewport}/${cell.motion}`;
}

function compareEvidence(left, right) {
  return compareStrings(`${left.uri}\0${left.kind}`, `${right.uri}\0${right.kind}`);
}

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

function assertWithin(root, candidate, message) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

function isLocalHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (["localhost", "::1", "0.0.0.0"].includes(normalized)) return true;
  if (/\.(?:local|localhost|test|invalid)$/u.test(normalized)) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}
