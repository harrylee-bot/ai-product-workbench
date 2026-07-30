import { canonicalJsonFile, sha256Bytes, sha256Canonical } from "../evidence-ledger.mjs";

export const G11_BROWSER_CONTRACT_SCHEMA_VERSION =
  "workbench.production-g11-browser-evidence-contract.v1";

export const G11_BROWSERS = Object.freeze(["chromium", "firefox", "webkit"]);
export const G11_VIEWPORTS = Object.freeze([
  Object.freeze({ id: "375x812", width: 375, height: 812 }),
  Object.freeze({ id: "768x1024", width: 768, height: 1024 }),
  Object.freeze({ id: "1440x900", width: 1440, height: 900 }),
]);
export const G11_MOTIONS = Object.freeze(["normal", "reduced"]);
export const G11_VISUAL_STATES = Object.freeze([
  "prd-active",
  "prd-pending",
  "prototype-after-prd",
]);
export const G11_MAX_SSE_RECORDS = 12_000;
export const G11_RUN_EVENT_NAMES = Object.freeze([
  "run.queued",
  "run.started",
  "run.generation.stage.changed",
  "run.phase.changed",
  "run.input.required",
  "run.input.submitted",
  "message.started",
  "message.delta",
  "message.completed",
  "activity.changed",
  "artifact.draft.created",
  "artifact.prototype.patch.created",
  "artifact.prototype.patch.degraded",
  "artifact.version.created",
  "run.cancel.requested",
  "run.cancelled",
  "run.completed",
  "run.failed",
]);

const FLOW_CHECKS = new Map([
  ["account-project", splitBooleanChecks([
    "loginCompleted", "invitationAccepted", "workspaceOpened", "projectOpened", "membershipRolesEnforced",
    "revokedAccessDenied", "expiredInvitationDenied", "unauthorizedPathsClosed",
  ], ["accountCreated"])],
  ["prd", booleanChecks([
    "requestAccepted", "loadingCompositionRendered", "activePanelContextRendered", "stageSequenceContinuous",
    "readyArtifactPersisted", "checksumVerified",
  ])],
  ["mixed-rejection", Object.freeze({
    keys: Object.freeze([
      "problemStatus", "queuePublishCount", "runCount", "runtimeAttemptCount", "artifactVersionCount",
      "providerInvocationCount", "sseEventCount",
    ]),
    browserCheckIds: Object.freeze(["problemStatus", "runCount", "sseEventCount"]),
    observerCheckIds: Object.freeze([
      "queuePublishCount", "runtimeAttemptCount", "artifactVersionCount", "providerInvocationCount",
    ]),
    passes(checks) {
      return checks.problemStatus === 422
        && [
          "queuePublishCount", "runCount", "runtimeAttemptCount", "artifactVersionCount",
          "providerInvocationCount", "sseEventCount",
        ].every((key) => checks[key] === 0);
    },
  })],
  ["prototype-after-prd", splitBooleanChecks(
    ["startedAfterPrd", "nullGapPrdMotionAbsent", "thinkingGapPrdMotionAbsent", "prototypeMotionRendered"],
    ["readyArtifactPersisted"],
  )],
  ["refresh-reconnect", splitBooleanChecks(
    ["reconnectCursorAdvanced", "sequenceContinuous", "stateRestored"],
    ["artifactPersisted"],
  )],
  ["preview-import-export", splitBooleanChecks(
    [
      "fileImportCompleted", "knowledgeImportCompleted", "exportCompleted", "previewLoaded",
      "explicitPublicationConfirmation", "failureRecoveryPassed",
    ],
    ["checksumVerified"],
  )],
  ["run-canvas-sse-artifact", splitBooleanChecks(
    [
      "runCompleted", "approvalPassed", "failurePassed", "cancelPassed", "retryPassed", "canvasGatewayUsed",
      "prototypePatchStableNodeIds", "sseDurable", "sequenceContinuous",
    ],
    ["authorizationPassed", "idempotencyPreserved", "artifactPersisted", "checksumVerified", "revisionAdvanced"],
  )],
  ["accessibility-preview-security", booleanChecks([
    "keyboardPassed", "focusPassed", "accessibleNamesPassed", "contrastPassed", "reducedMotionPassed",
    "previewIndependentOrigin", "previewCredentialless", "previewAllowSameOriginAbsent", "previewNoReferrer",
    "previewCapabilityValidated", "previewRpcPassed", "previewTimeoutProtected", "previewGenerationProtected",
  ])],
  ["long-run-7686-plus", Object.freeze({
    keys: Object.freeze([
      "minimumEventCount", "observedEventCount", "crossedBoundary", "terminalStateCorrect", "retryRecoveryPassed",
    ]),
    browserCheckIds: Object.freeze(["crossedBoundary", "terminalStateCorrect", "retryRecoveryPassed"]),
    observerCheckIds: Object.freeze(["minimumEventCount", "observedEventCount"]),
    passes(checks) {
      return checks.minimumEventCount === 7_686
        && Number.isInteger(checks.observedEventCount)
        && checks.observedEventCount >= checks.minimumEventCount
        && ["crossedBoundary", "terminalStateCorrect", "retryRecoveryPassed"]
          .every((key) => checks[key] === true);
    },
  })],
  ["knowledge-null-valid", splitBooleanChecks(
    ["validPinnedReleaseVisible", "validPinnedReleaseInvocationPassed"],
    [
      "nullReleaseGrantAbsent", "nullReleaseSecretAbsent", "nullReleaseCatalogAbsent",
      "concurrentScopeIsolated", "secretsNotPersisted",
    ],
  )],
  ["provider-state-integrity", Object.freeze({
    keys: Object.freeze([
      "textComplete", "effectsComplete", "draftComplete", "artifactsComplete", "duplicateTextCount",
      "lostTextCount", "duplicateEffectCount", "lostEffectCount", "duplicateDraftCount", "lostDraftCount",
      "duplicateArtifactCount", "lostArtifactCount",
    ]),
    browserCheckIds: Object.freeze(["artifactsComplete"]),
    observerCheckIds: Object.freeze([
      "textComplete", "effectsComplete", "draftComplete", "duplicateTextCount", "lostTextCount",
      "duplicateEffectCount", "lostEffectCount", "duplicateDraftCount", "lostDraftCount",
      "duplicateArtifactCount", "lostArtifactCount",
    ]),
    passes(checks) {
      return ["textComplete", "effectsComplete", "draftComplete", "artifactsComplete"]
        .every((key) => checks[key] === true)
        && [
          "duplicateTextCount", "lostTextCount", "duplicateEffectCount", "lostEffectCount",
          "duplicateDraftCount", "lostDraftCount", "duplicateArtifactCount", "lostArtifactCount",
        ].every((key) => checks[key] === 0);
    },
  })],
]);

const FLOW_RENDERED_STATES = new Map([
  ["account-project", [
    "login", "invitation-accepted", "workspace-open", "project-open", "revoked-denied",
    "expired-invitation-denied",
  ]],
  ["prd", [
    "initial-submit", "queued", "running-no-message", "running-message", "thinking",
    "collecting-prd-context", "structuring-prd", "drafting-prd", "validating-prd", "failure",
    "cancelled", "retry", "ready", "historical-prd-selected",
  ]],
  ["mixed-rejection", ["mixed-request-rejected"]],
  ["prototype-after-prd", [
    "prototype-null-gap", "prototype-thinking-gap", "design-system", "mapping-components",
    "creating-flows", "generating-ui", "screen-streaming", "summarizing", "screen-stable",
    "prototype-ready",
  ]],
  ["refresh-reconnect", ["refresh-restored", "reconnect-resumed", "sequence-continuous"]],
  ["preview-import-export", [
    "file-import-ready", "knowledge-import-ready", "export-ready", "preview-loaded", "failure-recovered",
  ]],
  ["run-canvas-sse-artifact", [
    "run-failed", "run-cancelled", "run-retried", "canvas-updated", "prototype-patch-applied",
    "artifact-ready",
  ]],
  ["accessibility-preview-security", [
    "keyboard-navigation", "focus-visible", "accessible-names", "contrast", "reduced-motion",
    "isolated-preview",
  ]],
  ["long-run-7686-plus", ["long-run-active", "long-run-retry", "long-run-terminal"]],
  ["knowledge-null-valid", [
    "null-release-denied", "valid-release-visible", "concurrent-scope-isolated",
  ]],
  ["provider-state-integrity", [
    "provider-state-text", "provider-state-effects", "provider-state-draft", "provider-state-artifacts",
  ]],
]);

const COMMON_BINDINGS = Object.freeze(["projectId", "threadId"]);
const FLOW_BINDINGS = new Map([
  ["account-project", Object.freeze(["deniedProjectId", "projectId", "threadId"])],
  ["long-run-7686-plus", Object.freeze(["projectId", "runId", "threadId"])],
  ["knowledge-null-valid", Object.freeze(["knowledgeReleaseId", "projectId", "threadId"])],
  ["provider-state-integrity", Object.freeze(["artifactVersionId", "projectId", "runId", "threadId"])],
]);

const FLOW_BROWSER_STEPS = new Map([
  ["account-project", [
    step("loginCompleted", "verify-session", "page.evaluate", [assertion("session-authenticated", "condition")]),
    step("invitationAccepted", "accept-invitation", "locator.click", [
      assertion("invitation-accepted-status", "visible"),
      assertion("invitation-project-bound", "url-origin"),
    ]),
    step("workspaceOpened", "open-workspace", "page.goto", [assertion("workspace-visible", "visible")]),
    step("projectOpened", "open-project", "page.goto", [
      assertion("project-document-ready", "document-ready"),
      assertion("project-shell-visible", "visible"),
    ]),
    step("membershipRolesEnforced", "verify-membership", "page.evaluate", [
      assertion("membership-role-response", "condition"),
    ]),
    step("revokedAccessDenied", "verify-revoked-access", "page.evaluate", [
      assertion("revoked-project-response", "condition"),
    ]),
    step("expiredInvitationDenied", "verify-expired-invitation", "page.evaluate", [
      assertion("expired-invitation-response", "condition"),
    ]),
    step("unauthorizedPathsClosed", "verify-unauthenticated-access", "page.evaluate", [
      assertion("unauthenticated-project-response", "condition"),
    ]),
  ]],
  ["prd", [
    step("requestAccepted", "submit-prd", "locator.click", [
      assertion("prd-agent-panel-visible", "visible"),
      assertion("prd-motion-visible", "visible"),
    ]),
    step("loadingCompositionRendered", "observe-prd-loading", "expect.toBeVisible", [
      assertion("prd-pending-visible", "visible"),
      assertion("prd-skeleton-visible", "visible"),
    ]),
    step("activePanelContextRendered", "observe-prd-context", "expect.toBeVisible", [
      assertion("prd-prompt-context-visible", "visible"),
      assertion("prd-activity-context-visible", "visible"),
    ]),
    step("stageSequenceContinuous", "observe-prd-sequence", "page.evaluate", [
      assertion("prd-stage-sequence-continuous", "condition"),
    ]),
    step("readyArtifactPersisted", "observe-prd-ready", "page.evaluate", [
      assertion("prd-run-complete", "visible"),
      assertion("prd-artifact-version-visible", "condition"),
    ]),
    step("checksumVerified", "verify-artifact-checksum", "page.evaluate", [
      assertion("prd-artifact-checksum-valid", "condition"),
    ]),
  ]],
  ["mixed-rejection", [
    step("problemStatus", "submit-mixed-intent", "page.evaluate", [
      assertion("mixed-problem-status-422", "condition"),
    ]),
    step("runCount", "verify-mixed-run-count", "page.evaluate", [
      assertion("mixed-run-count-unchanged", "condition"),
    ]),
    step("sseEventCount", "verify-mixed-sse-count", "page.evaluate", [
      assertion("mixed-sse-count-unchanged", "condition"),
    ]),
  ]],
  ["prototype-after-prd", [
    step("startedAfterPrd", "start-prototype", "locator.click", [
      assertion("prototype-start-accepted", "condition"),
    ]),
    step("nullGapPrdMotionAbsent", "observe-prototype-null-gap", "page.evaluate", [
      assertion("prototype-null-gap-prd-absent", "count"),
    ]),
    step("thinkingGapPrdMotionAbsent", "observe-prototype-thinking-gap", "page.evaluate", [
      assertion("prototype-thinking-gap-prd-absent", "count"),
    ]),
    step("prototypeMotionRendered", "observe-prototype-motion", "expect.toBeVisible", [
      assertion("prototype-motion-visible", "visible"),
    ]),
  ]],
  ["refresh-reconnect", [
    step("reconnectCursorAdvanced", "reload-reconnect", "page.reload", [
      assertion("reconnect-cursor-advanced", "condition"),
    ]),
    step("sequenceContinuous", "verify-reconnect-sequence", "page.evaluate", [
      assertion("reconnect-sequence-continuous", "condition"),
    ]),
    step("stateRestored", "verify-restored-state", "expect.toBeVisible", [
      assertion("restored-agent-panel-visible", "visible"),
      assertion("restored-artifact-visible", "condition"),
    ]),
  ]],
  ["preview-import-export", [
    step("fileImportCompleted", "import-file", "locator.click", [
      assertion("file-import-ready", "condition"),
    ]),
    step("knowledgeImportCompleted", "import-knowledge", "locator.click", [
      assertion("knowledge-import-ready", "condition"),
    ]),
    step("exportCompleted", "prepare-export", "locator.click", [
      assertion("export-ready", "condition"),
    ]),
    step("previewLoaded", "open-preview", "locator.click", [
      assertion("preview-frame-visible", "visible"),
    ]),
    step("explicitPublicationConfirmation", "confirm-publication", "locator.click", [
      assertion("publication-confirmed", "condition"),
    ]),
    step("failureRecoveryPassed", "verify-export-recovery", "page.evaluate", [
      assertion("export-failure-recovered", "condition"),
    ]),
  ]],
  ["run-canvas-sse-artifact", [
    step("runCompleted", "complete-run", "locator.click", [assertion("run-complete", "visible")]),
    step("approvalPassed", "approve-run", "locator.click", [assertion("approval-complete", "condition")]),
    step("failurePassed", "observe-failed-run", "page.evaluate", [assertion("run-failure-observed", "condition")]),
    step("cancelPassed", "cancel-run", "locator.click", [assertion("run-cancelled", "visible")]),
    step("retryPassed", "retry-run", "locator.click", [assertion("run-retry-complete", "visible")]),
    step("canvasGatewayUsed", "verify-canvas-gateway", "page.evaluate", [assertion("canvas-updated", "condition")]),
    step("prototypePatchStableNodeIds", "verify-prototype-patch", "page.evaluate", [
      assertion("prototype-patch-stable-ids", "condition"),
    ]),
    step("sseDurable", "verify-sse-durable", "page.evaluate", [assertion("sse-durable-events", "condition")]),
    step("sequenceContinuous", "verify-sse-sequence", "page.evaluate", [
      assertion("sse-sequence-continuous", "condition"),
    ]),
  ]],
  ["accessibility-preview-security", [
    step("keyboardPassed", "verify-keyboard", "page.evaluate", [assertion("keyboard-navigation", "condition")]),
    step("focusPassed", "verify-focus", "page.evaluate", [assertion("focus-visible", "condition")]),
    step("accessibleNamesPassed", "verify-accessible-names", "page.evaluate", [
      assertion("accessible-names", "condition"),
    ]),
    step("contrastPassed", "verify-contrast", "page.evaluate", [assertion("contrast-threshold", "condition")]),
    step("reducedMotionPassed", "verify-reduced-motion", "page.evaluate", [
      assertion("reduced-motion-contract", "condition"),
    ]),
    ...previewSecuritySteps(),
  ]],
  ["long-run-7686-plus", [
    step("crossedBoundary", "observe-long-run-boundary", "page.evaluate", [
      assertion("long-run-boundary-crossed", "condition"),
    ]),
    step("terminalStateCorrect", "observe-long-run-terminal", "page.evaluate", [
      assertion("long-run-terminal-correct", "condition"),
    ]),
    step("retryRecoveryPassed", "retry-long-run", "locator.click", [
      assertion("long-run-retry-recovered", "condition"),
    ]),
  ]],
  ["knowledge-null-valid", [
    step("validPinnedReleaseVisible", "verify-knowledge-release", "page.evaluate", [
      assertion("knowledge-release-visible", "condition"),
    ]),
    step("validPinnedReleaseInvocationPassed", "invoke-pinned-knowledge", "locator.click", [
      assertion("knowledge-invocation-complete", "condition"),
    ]),
  ]],
  ["provider-state-integrity", [
    step("artifactsComplete", "verify-provider-artifacts", "page.evaluate", [
      assertion("provider-artifacts-complete", "condition"),
    ]),
  ]],
]);

const VISUAL_STEPS = new Map([
  ["prd-active", [
    step("reach-prd-active", "submit-prd", "locator.click", [
      assertion("visual-prd-motion-visible", "visible"),
      assertion("visual-prd-panel-visible", "visible"),
    ]),
    visualCaptureStep("prd-active"),
  ]],
  ["prd-pending", [
    step("reach-prd-pending", "submit-prd", "locator.click", [
      assertion("visual-prd-pending-visible", "visible"),
      assertion("visual-prd-skeleton-visible", "visible"),
    ]),
    visualCaptureStep("prd-pending"),
  ]],
  ["prototype-after-prd", [
    step("reach-prototype-after-prd", "start-prototype", "locator.click", [
      assertion("visual-prototype-motion-visible", "visible"),
      assertion("visual-prototype-prd-motion-absent", "count"),
    ]),
    visualCaptureStep("prototype-after-prd"),
  ]],
]);

const EXPECTED_HTTP_ERRORS = new Map([
  ["account-project", Object.freeze([
    httpError("revoked-access-rejection", "GET", "web", "api", "projects.bootstrap", "deniedProjectId", [403, 404]),
    httpError("expired-invitation-rejection", "POST", "web", "auth", "project-invitations.accept", null, [409, 410]),
    httpError("unauthenticated-access-rejection", "GET", "web", "api", "projects.bootstrap", "projectId", [401]),
  ])],
  ["mixed-rejection", Object.freeze([
    httpError("mixed-request-rejection", "POST", "web", "api", "threads.submission-intents", "threadId", [422]),
  ])],
]);

export function productionG11RouteBindingSha256(routeTemplateId, parameters = {}) {
  if (typeof routeTemplateId !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/u.test(routeTemplateId)
    || !parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error("route binding identity is invalid");
  }
  return sha256Canonical({ routeTemplateId, parameters: structuredClone(parameters) });
}

export function productionG11FlowIds() {
  return [...FLOW_CHECKS.keys()];
}

export function productionG11FlowCheckSpec(flowId) {
  const spec = FLOW_CHECKS.get(flowId);
  return spec ? {
    keys: [...spec.keys],
    browserCheckIds: [...spec.browserCheckIds],
    observerCheckIds: [...spec.observerCheckIds],
  } : null;
}

export function productionG11FlowChecksPass(flowId, checks) {
  const spec = FLOW_CHECKS.get(flowId);
  if (!spec || !checks || typeof checks !== "object" || Array.isArray(checks)) return false;
  const actualKeys = Object.keys(checks).sort(compareStrings);
  const expectedKeys = [...spec.keys].sort(compareStrings);
  return canonicalEqual(actualKeys, expectedKeys) && spec.passes(checks);
}

export function productionG11RenderedStates(flowId) {
  return structuredClone(FLOW_RENDERED_STATES.get(flowId) ?? []);
}

export function productionG11ScenarioId({ browserName, motion, traceId, viewport }) {
  for (const state of G11_VISUAL_STATES) {
    if (traceId === `capture-${browserName}-${state}-${viewport?.id}-${motion}`) return `visual-${state}`;
  }
  for (const flowId of FLOW_CHECKS.keys()) {
    if (traceId === `flow-${flowId}-${browserName}-${viewport?.id}-${motion}`) return flowId;
  }
  return null;
}

export function productionG11ScenarioPlan({ scenarioId, scenarioBinding }) {
  const visualState = scenarioId?.startsWith("visual-") ? scenarioId.slice("visual-".length) : null;
  const flowId = visualState ? null : scenarioId;
  const steps = visualState ? VISUAL_STEPS.get(visualState) : FLOW_BROWSER_STEPS.get(flowId);
  if (!steps) throw new Error("scenarioId is not in the protected G11 registry");
  const bindingKeys = visualState ? COMMON_BINDINGS : FLOW_BINDINGS.get(flowId) ?? COMMON_BINDINGS;
  validateScenarioBinding(scenarioBinding, bindingKeys);
  const plan = {
    schemaVersion: G11_BROWSER_CONTRACT_SCHEMA_VERSION,
    scenarioId,
    flowId,
    state: visualState,
    route: "project",
    binding: structuredClone(scenarioBinding),
    browserSteps: structuredClone(steps),
    observerCheckIds: structuredClone(flowId ? FLOW_CHECKS.get(flowId).observerCheckIds : []),
    expectedHttpErrors: (flowId ? EXPECTED_HTTP_ERRORS.get(flowId) ?? [] : []).map((rule) => ({
      ruleId: rule.ruleId,
      method: rule.method,
      originClass: rule.originClass,
      pathClass: rule.pathClass,
      routeTemplateId: rule.routeTemplateId,
      routeBindingSha256: productionG11RouteBindingSha256(
        rule.routeTemplateId,
        rule.routeBindingKey ? { [rule.routeBindingKey]: scenarioBinding[rule.routeBindingKey] } : {},
      ),
      statusCodes: [...rule.statusCodes],
    })),
  };
  return deepFreeze(plan);
}

export function productionG11ScenarioPlanSha256(input) {
  return sha256Bytes(Buffer.from(canonicalJsonFile(productionG11ScenarioPlan(input)), "utf8"));
}

export function productionG11OriginPolicy(deployment) {
  const approvedThirdPartyOrigins = deployment?.approvedThirdPartyOrigins ?? [];
  const policy = {
    schemaVersion: "workbench.production-g11-origin-policy.v1",
    web: deployment?.webOrigin,
    preview: deployment?.previewOrigin,
    approvedThirdParty: structuredClone(approvedThirdPartyOrigins),
  };
  if (typeof policy.web !== "string" || typeof policy.preview !== "string"
    || !Array.isArray(policy.approvedThirdParty)) {
    throw new Error("deployment does not define a complete G11 origin policy");
  }
  return deepFreeze(policy);
}

export function productionG11OriginPolicySha256(deployment) {
  return sha256Bytes(Buffer.from(canonicalJsonFile(productionG11OriginPolicy(deployment)), "utf8"));
}

function booleanChecks(keys) {
  return splitBooleanChecks(keys, []);
}

function splitBooleanChecks(browserCheckIds, observerCheckIds) {
  const keys = Object.freeze([...browserCheckIds, ...observerCheckIds]);
  return Object.freeze({
    keys,
    browserCheckIds: Object.freeze([...browserCheckIds]),
    observerCheckIds: Object.freeze([...observerCheckIds]),
    passes: (checks) => keys.every((key) => checks[key] === true),
  });
}

function step(stepId, actionId, apiName, assertions) {
  return Object.freeze({
    stepId,
    actionId,
    apiName,
    assertions: Object.freeze(assertions),
  });
}

function assertion(assertionSpecId, kind) {
  return Object.freeze({ assertionSpecId, kind });
}

function visualCaptureStep(state) {
  return step("visual-capture", "capture-visual", "page.evaluate", [
    assertion(`${state}-document-ready`, "document-ready"),
    assertion(`${state}-origin-bound`, "url-origin"),
    assertion(`${state}-layout-captured`, "condition"),
  ]);
}

function previewSecuritySteps() {
  return [
    step("previewIndependentOrigin", "open-preview", "locator.click", [
      assertion("preview-origin-independent", "condition"),
    ]),
    step("previewCredentialless", "verify-preview-credentialless", "expect.toHaveAttribute", [
      assertion("preview-credentialless", "attribute"),
    ]),
    step("previewAllowSameOriginAbsent", "verify-preview-sandbox", "page.evaluate", [
      assertion("preview-allow-same-origin-absent", "condition"),
    ]),
    step("previewNoReferrer", "verify-preview-referrer", "expect.toHaveAttribute", [
      assertion("preview-no-referrer", "attribute"),
    ]),
    step("previewCapabilityValidated", "verify-preview-capability", "page.evaluate", [
      assertion("preview-capability-validated", "condition"),
    ]),
    step("previewRpcPassed", "verify-preview-rpc", "page.evaluate", [
      assertion("preview-rpc-passed", "condition"),
    ]),
    step("previewTimeoutProtected", "verify-preview-timeout", "page.evaluate", [
      assertion("preview-timeout-protected", "condition"),
    ]),
    step("previewGenerationProtected", "verify-preview-generation", "page.evaluate", [
      assertion("preview-generation-protected", "condition"),
    ]),
  ];
}

function httpError(ruleId, method, originClass, pathClass, routeTemplateId, routeBindingKey, statusCodes) {
  return Object.freeze({
    ruleId,
    method,
    originClass,
    pathClass,
    routeTemplateId,
    routeBindingKey,
    statusCodes: Object.freeze(statusCodes),
  });
}

function validateScenarioBinding(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !canonicalEqual(Object.keys(value).sort(compareStrings), [...expectedKeys].sort(compareStrings))) {
    throw new Error("scenarioBinding does not match the protected G11 scenario");
  }
  for (const key of expectedKeys) {
    if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value[key])) {
      throw new Error("scenarioBinding contains an invalid stable identity");
    }
  }
}

function canonicalEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareStrings(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
