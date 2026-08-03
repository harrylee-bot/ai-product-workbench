import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  G11_BROWSERS,
  G11_BROWSER_CONTRACT_SCHEMA_VERSION,
  G11_MAX_SSE_RECORDS,
  G11_MOTIONS,
  G11_RUN_EVENT_NAMES,
  G11_VIEWPORTS,
  G11_VISUAL_STATES,
  productionG11FlowCheckSpec,
  productionG11FlowChecksPass,
  productionG11FlowIds,
  productionG11OriginPolicy,
  productionG11OriginPolicySha256,
  productionG11RenderedStates,
  productionG11ScenarioId,
  productionG11ScenarioPlan,
} from "./g11-browser-evidence-contract.mjs";

const COMMON_BINDING_KEYS = ["projectId", "threadId"];

// This is intentionally independent from the implementation's registry. The concise
// assertion notation is expanded below only for comparison with public plans.
const FLOWS = {
  "account-project": {
    browser: ["loginCompleted", "invitationAccepted", "workspaceOpened", "projectOpened", "membershipRolesEnforced", "revokedAccessDenied", "expiredInvitationDenied", "unauthorizedPathsClosed"],
    observer: ["accountCreated"],
    states: ["login", "invitation-accepted", "workspace-open", "project-open", "revoked-denied", "expired-invitation-denied"],
    binding: ["deniedProjectId", "projectId", "threadId"],
    steps: [
      ["loginCompleted", "verify-session", "page.evaluate", ["session-authenticated:condition"]],
      ["invitationAccepted", "accept-invitation", "locator.click", ["invitation-accepted-status:visible", "invitation-project-bound:url-origin"]],
      ["workspaceOpened", "open-workspace", "page.goto", ["workspace-visible:visible"]],
      ["projectOpened", "open-project", "page.goto", ["project-document-ready:document-ready", "project-shell-visible:visible"]],
      ["membershipRolesEnforced", "verify-membership", "page.evaluate", ["membership-role-response:condition"]],
      ["revokedAccessDenied", "verify-revoked-access", "page.evaluate", ["revoked-project-response:condition"]],
      ["expiredInvitationDenied", "verify-expired-invitation", "page.evaluate", ["expired-invitation-response:condition"]],
      ["unauthorizedPathsClosed", "verify-unauthenticated-access", "page.evaluate", ["unauthenticated-project-response:condition"]],
    ],
    errors: [["revoked-access-rejection", "GET", "web", "api", [403, 404]], ["expired-invitation-rejection", "POST", "web", "auth", [409, 410]], ["unauthenticated-access-rejection", "GET", "web", "api", [401]]],
  },
  prd: {
    browser: ["requestAccepted", "loadingCompositionRendered", "activePanelContextRendered", "stageSequenceContinuous", "readyArtifactPersisted", "checksumVerified"], observer: [],
    states: ["initial-submit", "queued", "running-no-message", "running-message", "thinking", "collecting-prd-context", "structuring-prd", "drafting-prd", "validating-prd", "failure", "cancelled", "retry", "ready", "historical-prd-selected"],
    steps: [["requestAccepted", "submit-prd", "locator.click", ["prd-agent-panel-visible:visible", "prd-motion-visible:visible"]], ["loadingCompositionRendered", "observe-prd-loading", "expect.toBeVisible", ["prd-pending-visible:visible", "prd-skeleton-visible:visible"]], ["activePanelContextRendered", "observe-prd-context", "expect.toBeVisible", ["prd-prompt-context-visible:visible", "prd-activity-context-visible:visible"]], ["stageSequenceContinuous", "observe-prd-sequence", "page.evaluate", ["prd-stage-sequence-continuous:condition"]], ["readyArtifactPersisted", "observe-prd-ready", "page.evaluate", ["prd-run-complete:visible", "prd-artifact-version-visible:condition"]], ["checksumVerified", "verify-artifact-checksum", "page.evaluate", ["prd-artifact-checksum-valid:condition"]]],
  },
  "mixed-rejection": {
    keys: ["composerLocalizedError", "composerPromptPreserved", "composerActiveUiAbsent", "problemStatus", "queuePublishCount", "runCount", "runtimeAttemptCount", "artifactVersionCount", "providerInvocationCount", "sseEventCount"],
    browser: ["composerLocalizedError", "composerPromptPreserved", "composerActiveUiAbsent", "problemStatus", "runCount", "sseEventCount"], observer: ["queuePublishCount", "runtimeAttemptCount", "artifactVersionCount", "providerInvocationCount"], states: ["mixed-composer-rejected", "mixed-direct-api-rejected"],
    steps: [["composerLocalizedError", "submit-mixed-composer", "locator.click", ["mixed-composer-localized-error-visible:condition"]], ["composerPromptPreserved", "verify-mixed-composer-prompt", "page.evaluate", ["mixed-composer-prompt-preserved:condition"]], ["composerActiveUiAbsent", "verify-mixed-composer-inactive", "page.evaluate", ["mixed-composer-active-ui-absent:count"]], ["problemStatus", "submit-mixed-direct-api", "page.evaluate", ["mixed-problem-status-400:condition"]], ["runCount", "verify-mixed-run-count", "page.evaluate", ["mixed-run-count-unchanged:condition"]], ["sseEventCount", "verify-mixed-sse-count", "page.evaluate", ["mixed-sse-count-unchanged:condition"]]],
    errors: [["mixed-request-rejection", "POST", "web", "api", [400]]],
  },
  "prototype-after-prd": {
    browser: ["startedAfterPrd", "nullGapPrdMotionAbsent", "thinkingGapPrdMotionAbsent", "prototypeMotionRendered"], observer: ["readyArtifactPersisted"], states: ["prototype-null-gap", "prototype-thinking-gap", "design-system", "mapping-components", "creating-flows", "generating-ui", "screen-streaming", "summarizing", "screen-stable", "prototype-ready"],
    steps: [["startedAfterPrd", "start-prototype", "locator.click", ["prototype-start-accepted:condition"]], ["nullGapPrdMotionAbsent", "observe-prototype-null-gap", "page.evaluate", ["prototype-null-gap-prd-absent:count"]], ["thinkingGapPrdMotionAbsent", "observe-prototype-thinking-gap", "page.evaluate", ["prototype-thinking-gap-prd-absent:count"]], ["prototypeMotionRendered", "observe-prototype-motion", "expect.toBeVisible", ["prototype-motion-visible:visible"]]],
  },
  "refresh-reconnect": {
    browser: ["reconnectCursorAdvanced", "sequenceContinuous", "stateRestored"], observer: ["artifactPersisted"], states: ["refresh-restored", "reconnect-resumed", "sequence-continuous"],
    steps: [["reconnectCursorAdvanced", "reload-reconnect", "page.reload", ["reconnect-cursor-advanced:condition"]], ["sequenceContinuous", "verify-reconnect-sequence", "page.evaluate", ["reconnect-sequence-continuous:condition"]], ["stateRestored", "verify-restored-state", "expect.toBeVisible", ["restored-agent-panel-visible:visible", "restored-artifact-visible:condition"]]],
  },
  "preview-import-export": {
    browser: ["fileImportCompleted", "knowledgeImportCompleted", "exportCompleted", "previewLoaded", "explicitPublicationConfirmation", "failureRecoveryPassed"], observer: ["checksumVerified"], states: ["file-import-ready", "knowledge-import-ready", "export-ready", "preview-loaded", "failure-recovered"],
    steps: [["fileImportCompleted", "import-file", "locator.click", ["file-import-ready:condition"]], ["knowledgeImportCompleted", "import-knowledge", "locator.click", ["knowledge-import-ready:condition"]], ["exportCompleted", "prepare-export", "locator.click", ["export-ready:condition"]], ["previewLoaded", "open-preview", "locator.click", ["preview-frame-visible:visible"]], ["explicitPublicationConfirmation", "confirm-publication", "locator.click", ["publication-confirmed:condition"]], ["failureRecoveryPassed", "verify-export-recovery", "page.evaluate", ["export-failure-recovered:condition"]]],
  },
  "run-canvas-sse-artifact": {
    browser: ["runCompleted", "approvalPassed", "failurePassed", "cancelPassed", "retryPassed", "canvasGatewayUsed", "prototypePatchStableNodeIds", "sseDurable", "sequenceContinuous"], observer: ["authorizationPassed", "idempotencyPreserved", "artifactPersisted", "checksumVerified", "revisionAdvanced"], states: ["run-failed", "run-cancelled", "run-retried", "canvas-updated", "prototype-patch-applied", "artifact-ready"],
    steps: [["runCompleted", "complete-run", "locator.click", ["run-complete:visible"]], ["approvalPassed", "approve-run", "locator.click", ["approval-complete:condition"]], ["failurePassed", "observe-failed-run", "page.evaluate", ["run-failure-observed:condition"]], ["cancelPassed", "cancel-run", "locator.click", ["run-cancelled:visible"]], ["retryPassed", "retry-run", "locator.click", ["run-retry-complete:visible"]], ["canvasGatewayUsed", "verify-canvas-gateway", "page.evaluate", ["canvas-updated:condition"]], ["prototypePatchStableNodeIds", "verify-prototype-patch", "page.evaluate", ["prototype-patch-stable-ids:condition"]], ["sseDurable", "verify-sse-durable", "page.evaluate", ["sse-durable-events:condition"]], ["sequenceContinuous", "verify-sse-sequence", "page.evaluate", ["sse-sequence-continuous:condition"]]],
  },
  "accessibility-preview-security": {
    browser: ["keyboardPassed", "focusPassed", "accessibleNamesPassed", "contrastPassed", "reducedMotionPassed", "previewIndependentOrigin", "previewCredentialless", "previewAllowSameOriginAbsent", "previewNoReferrer", "previewCapabilityValidated", "previewRpcPassed", "previewTimeoutProtected", "previewGenerationProtected"], observer: [], states: ["keyboard-navigation", "focus-visible", "accessible-names", "contrast", "reduced-motion", "isolated-preview"],
    steps: [["keyboardPassed", "verify-keyboard", "page.evaluate", ["keyboard-navigation:condition"]], ["focusPassed", "verify-focus", "page.evaluate", ["focus-visible:condition"]], ["accessibleNamesPassed", "verify-accessible-names", "page.evaluate", ["accessible-names:condition"]], ["contrastPassed", "verify-contrast", "page.evaluate", ["contrast-threshold:condition"]], ["reducedMotionPassed", "verify-reduced-motion", "page.evaluate", ["reduced-motion-contract:condition"]], ["previewIndependentOrigin", "open-preview", "locator.click", ["preview-origin-independent:condition"]], ["previewCredentialless", "verify-preview-credentialless", "expect.toHaveAttribute", ["preview-credentialless:attribute"]], ["previewAllowSameOriginAbsent", "verify-preview-sandbox", "page.evaluate", ["preview-allow-same-origin-absent:condition"]], ["previewNoReferrer", "verify-preview-referrer", "expect.toHaveAttribute", ["preview-no-referrer:attribute"]], ["previewCapabilityValidated", "verify-preview-capability", "page.evaluate", ["preview-capability-validated:condition"]], ["previewRpcPassed", "verify-preview-rpc", "page.evaluate", ["preview-rpc-passed:condition"]], ["previewTimeoutProtected", "verify-preview-timeout", "page.evaluate", ["preview-timeout-protected:condition"]], ["previewGenerationProtected", "verify-preview-generation", "page.evaluate", ["preview-generation-protected:condition"]]],
  },
  "long-run-7686-plus": {
    keys: ["minimumEventCount", "observedEventCount", "crossedBoundary", "terminalStateCorrect", "retryRecoveryPassed"],
    browser: ["crossedBoundary", "terminalStateCorrect", "retryRecoveryPassed"], observer: ["minimumEventCount", "observedEventCount"], states: ["long-run-active", "long-run-retry", "long-run-terminal"], binding: ["projectId", "runId", "threadId"],
    steps: [["crossedBoundary", "observe-long-run-boundary", "page.evaluate", ["long-run-boundary-crossed:condition"]], ["terminalStateCorrect", "observe-long-run-terminal", "page.evaluate", ["long-run-terminal-correct:condition"]], ["retryRecoveryPassed", "retry-long-run", "locator.click", ["long-run-retry-recovered:condition"]]],
  },
  "knowledge-null-valid": {
    browser: ["validPinnedReleaseVisible", "validPinnedReleaseInvocationPassed"], observer: ["nullReleaseGrantAbsent", "nullReleaseSecretAbsent", "nullReleaseCatalogAbsent", "concurrentScopeIsolated", "secretsNotPersisted"], states: ["null-release-denied", "valid-release-visible", "concurrent-scope-isolated"], binding: ["knowledgeReleaseId", "projectId", "threadId"],
    steps: [["validPinnedReleaseVisible", "verify-knowledge-release", "page.evaluate", ["knowledge-release-visible:condition"]], ["validPinnedReleaseInvocationPassed", "invoke-pinned-knowledge", "locator.click", ["knowledge-invocation-complete:condition"]]],
  },
  "provider-state-integrity": {
    keys: ["textComplete", "effectsComplete", "draftComplete", "artifactsComplete", "duplicateTextCount", "lostTextCount", "duplicateEffectCount", "lostEffectCount", "duplicateDraftCount", "lostDraftCount", "duplicateArtifactCount", "lostArtifactCount"],
    browser: ["artifactsComplete"], observer: ["textComplete", "effectsComplete", "draftComplete", "duplicateTextCount", "lostTextCount", "duplicateEffectCount", "lostEffectCount", "duplicateDraftCount", "lostDraftCount", "duplicateArtifactCount", "lostArtifactCount"], states: ["provider-state-text", "provider-state-effects", "provider-state-draft", "provider-state-artifacts"], binding: ["artifactVersionId", "projectId", "runId", "threadId"],
    steps: [["artifactsComplete", "verify-provider-artifacts", "page.evaluate", ["provider-artifacts-complete:condition"]]],
  },
};

const VISUALS = {
  "prd-active": [["reach-prd-active", "submit-prd", "locator.click", ["visual-prd-motion-visible:visible", "visual-prd-panel-visible:visible"]], ["visual-capture", "capture-visual", "page.evaluate", ["prd-active-document-ready:document-ready", "prd-active-origin-bound:url-origin", "prd-active-layout-captured:condition"]]],
  "prd-pending": [["reach-prd-pending", "submit-prd", "locator.click", ["visual-prd-pending-visible:visible", "visual-prd-skeleton-visible:visible"]], ["visual-capture", "capture-visual", "page.evaluate", ["prd-pending-document-ready:document-ready", "prd-pending-origin-bound:url-origin", "prd-pending-layout-captured:condition"]]],
  "prototype-after-prd": [["reach-prototype-after-prd", "start-prototype", "locator.click", ["visual-prototype-motion-visible:visible", "visual-prototype-prd-motion-absent:count"]], ["visual-capture", "capture-visual", "page.evaluate", ["prototype-after-prd-document-ready:document-ready", "prototype-after-prd-origin-bound:url-origin", "prototype-after-prd-layout-captured:condition"]]],
};

function bindingFor(keys) {
  return Object.fromEntries(keys.map((key) => [key, `${key}-stable-1`]));
}

function actualSteps(steps) {
  return steps.map(({ stepId, actionId, apiName, assertions }) => [
    stepId,
    actionId,
    apiName,
    assertions.map(({ assertionSpecId, kind }) => `${assertionSpecId}:${kind}`),
  ]);
}

function passingChecks(flowId, keys) {
  const checks = Object.fromEntries(keys.map((key) => [key, true]));
  if (flowId === "mixed-rejection") {
    Object.assign(checks, { problemStatus: 400, queuePublishCount: 0, runCount: 0, runtimeAttemptCount: 0, artifactVersionCount: 0, providerInvocationCount: 0, sseEventCount: 0 });
  }
  if (flowId === "long-run-7686-plus") Object.assign(checks, { minimumEventCount: 7686, observedEventCount: 7686 });
  if (flowId === "provider-state-integrity") {
    for (const key of keys.filter((key) => key.endsWith("Count"))) checks[key] = 0;
  }
  return checks;
}

function failingValue(flowId, key) {
  if (flowId === "mixed-rejection") return key === "problemStatus" ? 422 : 1;
  if (flowId === "long-run-7686-plus") return key === "minimumEventCount" || key === "observedEventCount" ? 7685 : false;
  if (flowId === "provider-state-integrity" && key.endsWith("Count")) return 1;
  return false;
}

test("G11 registry fixes the three browsers, three viewports, motions, 54 visual identities, and 198 flow identities", () => {
  assert.equal(G11_BROWSER_CONTRACT_SCHEMA_VERSION, "workbench.production-g11-browser-evidence-contract.v1");
  assert.deepEqual(G11_BROWSERS, ["chromium", "firefox", "webkit"]);
  assert.deepEqual(G11_VIEWPORTS, [{ id: "375x812", width: 375, height: 812 }, { id: "768x1024", width: 768, height: 1024 }, { id: "1440x900", width: 1440, height: 900 }]);
  assert.deepEqual(G11_MOTIONS, ["normal", "reduced"]);
  assert.deepEqual(G11_VISUAL_STATES, ["prd-active", "prd-pending", "prototype-after-prd"]);
  assert.deepEqual(productionG11FlowIds(), Object.keys(FLOWS));

  let visualIdentities = 0;
  let flowIdentities = 0;
  for (const browserName of G11_BROWSERS) for (const viewport of G11_VIEWPORTS) for (const motion of G11_MOTIONS) {
    for (const state of G11_VISUAL_STATES) {
      const traceId = `capture-${browserName}-${state}-${viewport.id}-${motion}`;
      assert.equal(productionG11ScenarioId({ browserName, viewport, motion, traceId }), `visual-${state}`);
      visualIdentities += 1;
    }
    for (const flowId of Object.keys(FLOWS)) {
      const traceId = `flow-${flowId}-${browserName}-${viewport.id}-${motion}`;
      assert.equal(productionG11ScenarioId({ browserName, viewport, motion, traceId }), flowId);
      flowIdentities += 1;
    }
  }
  assert.equal(visualIdentities, 54);
  assert.equal(flowIdentities, 198);
  assert.equal(productionG11ScenarioId({ browserName: "chromium", viewport: G11_VIEWPORTS[0], motion: "normal", traceId: "capture-chromium-prd-active-375x812-fast" }), null);
  assert.equal(productionG11ScenarioId({ browserName: "chromium", viewport: G11_VIEWPORTS[0], motion: "normal", traceId: "flow-prd-firefox-375x812-normal" }), null);
});

test("G11 SSE allowlist exactly follows the authoritative RunEvent union", async () => {
  const source = await readFile(
    new URL("../../packages/workbench-contracts/src/runs.ts", import.meta.url),
    "utf8",
  );
  const authoritativeNames = [...source.matchAll(/\bevent\(\s*"([a-z][a-z.]+)"/gu)]
    .map((match) => match[1]);
  assert.equal(authoritativeNames.length, 18);
  assert.deepEqual(G11_RUN_EVENT_NAMES, authoritativeNames);
  assert.equal(G11_MAX_SSE_RECORDS, 12_000);
});

test("G11 flow check identities, browser/observer partition, rendered states, and pass predicates are exact", () => {
  for (const [flowId, expected] of Object.entries(FLOWS)) {
    const spec = productionG11FlowCheckSpec(flowId);
    assert.deepEqual(spec, { keys: expected.keys ?? [...expected.browser, ...expected.observer], browserCheckIds: expected.browser, observerCheckIds: expected.observer }, flowId);
    assert.deepEqual(productionG11RenderedStates(flowId), expected.states, flowId);
    assert.equal(productionG11FlowCheckSpec(`${flowId}-unknown`), null);
    assert.deepEqual(productionG11RenderedStates(`${flowId}-unknown`), []);

    const passing = passingChecks(flowId, spec.keys);
    assert.equal(productionG11FlowChecksPass(flowId, passing), true, `${flowId} accepts only its passing predicate`);
    for (const key of spec.keys) {
      assert.equal(productionG11FlowChecksPass(flowId, { ...passing, [key]: failingValue(flowId, key) }), false, `${flowId}:${key}`);
    }
    const { [spec.keys[0]]: omitted, ...missing } = passing;
    assert.equal(productionG11FlowChecksPass(flowId, missing), false, `${flowId} rejects missing checks`);
    assert.equal(productionG11FlowChecksPass(flowId, { ...passing, unapproved: true }), false, `${flowId} rejects additional checks`);
    assert.equal(productionG11FlowChecksPass(flowId, []), false);
    assert.equal(productionG11FlowChecksPass(flowId, null), false);
  }
  assert.equal(productionG11FlowChecksPass("unregistered", { anything: true }), false);
});

test("G11 scenarios bind only stable independent identities and preserve ordered action and assertion contracts", () => {
  for (const [flowId, expected] of Object.entries(FLOWS)) {
    const bindingKeys = expected.binding ?? COMMON_BINDING_KEYS;
    const binding = bindingFor(bindingKeys);
    const plan = productionG11ScenarioPlan({ scenarioId: flowId, scenarioBinding: binding });
    assert.deepEqual(plan, {
      schemaVersion: G11_BROWSER_CONTRACT_SCHEMA_VERSION, scenarioId: flowId, flowId, state: null, route: "project", binding,
      browserSteps: plan.browserSteps, observerCheckIds: expected.observer, expectedHttpErrors: plan.expectedHttpErrors,
    }, flowId);
    assert.deepEqual(actualSteps(plan.browserSteps), expected.steps, flowId);
    assert.deepEqual(plan.expectedHttpErrors.map(({ ruleId, method, originClass, pathClass, statusCodes }) => [ruleId, method, originClass, pathClass, statusCodes]), expected.errors ?? [], `${flowId} HTTP errors`);

    for (const key of bindingKeys) {
      const { [key]: omitted, ...missing } = binding;
      assert.throws(() => productionG11ScenarioPlan({ scenarioId: flowId, scenarioBinding: missing }), /scenarioBinding/u);
      assert.throws(() => productionG11ScenarioPlan({ scenarioId: flowId, scenarioBinding: { ...binding, [key]: "not valid" } }), /invalid stable identity/u);
    }
    assert.throws(() => productionG11ScenarioPlan({ scenarioId: flowId, scenarioBinding: { ...binding, unexpectedId: "unexpectedId-stable-1" } }), /scenarioBinding/u);
  }

  // Account denial cases must remain separately named HTTP rejection rules, not a broad happy-path check.
  const accountPlan = productionG11ScenarioPlan({ scenarioId: "account-project", scenarioBinding: bindingFor(FLOWS["account-project"].binding) });
  assert.deepEqual(accountPlan.expectedHttpErrors.map((rule) => rule.ruleId), ["revoked-access-rejection", "expired-invitation-rejection", "unauthenticated-access-rejection"]);
  assert.throws(() => productionG11ScenarioPlan({ scenarioId: "unregistered", scenarioBinding: bindingFor(COMMON_BINDING_KEYS) }), /protected G11 registry/u);
});

test("G11 visual plans have exact capture contracts and common bindings", () => {
  for (const [state, expectedSteps] of Object.entries(VISUALS)) {
    const binding = bindingFor(COMMON_BINDING_KEYS);
    const plan = productionG11ScenarioPlan({ scenarioId: `visual-${state}`, scenarioBinding: binding });
    assert.equal(plan.flowId, null);
    assert.equal(plan.state, state);
    assert.equal(plan.route, "project");
    assert.deepEqual(plan.binding, binding);
    assert.deepEqual(plan.observerCheckIds, []);
    assert.deepEqual(plan.expectedHttpErrors, []);
    assert.deepEqual(actualSteps(plan.browserSteps), expectedSteps, state);
  }
});

test("G11 origin policy retains canonical deployment fields and hashes approved third parties", () => {
  const deployment = {
    webOrigin: "https://app.example.test",
    previewOrigin: "https://preview.example.test",
    approvedThirdPartyOrigins: ["https://assets.example.test", "https://telemetry.example.test"],
  };
  const expected = {
    schemaVersion: "workbench.production-g11-origin-policy.v1",
    web: "https://app.example.test",
    preview: "https://preview.example.test",
    approvedThirdParty: ["https://assets.example.test", "https://telemetry.example.test"],
  };
  assert.deepEqual(productionG11OriginPolicy(deployment), expected);
  assert.equal(productionG11OriginPolicySha256(deployment), "1280ef1364080f44b5b48f681b7d53e3498ce512f3e1997711b0b1e258ca5346");
  assert.notEqual(productionG11OriginPolicySha256({ ...deployment, approvedThirdPartyOrigins: [...deployment.approvedThirdPartyOrigins].reverse() }), productionG11OriginPolicySha256(deployment));
  assert.throws(() => productionG11OriginPolicy({ ...deployment, webOrigin: null }), /complete G11 origin policy/u);
  assert.throws(() => productionG11OriginPolicy({ ...deployment, previewOrigin: 42 }), /complete G11 origin policy/u);
  assert.throws(() => productionG11OriginPolicy({ ...deployment, approvedThirdPartyOrigins: "https://assets.example.test" }), /complete G11 origin policy/u);
});

test("G11 exported values and returned contract plans are deeply immutable", () => {
  assert.equal(Object.isFrozen(G11_BROWSERS), true);
  assert.equal(Object.isFrozen(G11_VIEWPORTS), true);
  assert.equal(Object.isFrozen(G11_VIEWPORTS[0]), true);
  assert.equal(Object.isFrozen(G11_MOTIONS), true);
  assert.equal(Object.isFrozen(G11_VISUAL_STATES), true);
  assert.equal(Object.isFrozen(G11_RUN_EVENT_NAMES), true);
  assert.throws(() => G11_BROWSERS.push("unapproved"), TypeError);
  assert.throws(() => { G11_VIEWPORTS[0].width = 1; }, TypeError);
  assert.throws(() => G11_RUN_EVENT_NAMES.push("unapproved.event"), TypeError);

  const plan = productionG11ScenarioPlan({ scenarioId: "account-project", scenarioBinding: bindingFor(FLOWS["account-project"].binding) });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.binding), true);
  assert.equal(Object.isFrozen(plan.browserSteps), true);
  assert.equal(Object.isFrozen(plan.browserSteps[0]), true);
  assert.equal(Object.isFrozen(plan.browserSteps[0].assertions), true);
  assert.equal(Object.isFrozen(plan.expectedHttpErrors[0].statusCodes), true);
  assert.throws(() => { plan.binding.projectId = "mutated"; }, TypeError);
  assert.throws(() => plan.browserSteps.push({}), TypeError);
  assert.throws(() => { plan.browserSteps[0].assertions[0].kind = "mutated"; }, TypeError);

  const firstStates = productionG11RenderedStates("prd");
  firstStates.push("mutated");
  assert.deepEqual(productionG11RenderedStates("prd"), FLOWS.prd.states);
  const firstSpec = productionG11FlowCheckSpec("prd");
  firstSpec.keys.push("mutated");
  assert.deepEqual(productionG11FlowCheckSpec("prd").keys, FLOWS.prd.browser);
  const policy = productionG11OriginPolicy({ webOrigin: "https://app.example.test", previewOrigin: "https://preview.example.test", approvedThirdPartyOrigins: ["https://assets.example.test"] });
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.approvedThirdParty), true);
  assert.throws(() => policy.approvedThirdParty.push("https://mutated.example.test"), TypeError);
});
