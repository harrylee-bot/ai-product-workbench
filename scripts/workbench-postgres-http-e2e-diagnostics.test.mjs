import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captureStableMotionFrameEvidence,
  classifyMotionFrameEvidence,
  diagnosticErrorClass,
  diagnosticFakeRuntimeState,
  evaluateMotionFrameEvidence,
  httpDiagnosticSuccessEvidence,
} from "./workbench-postgres-http-e2e-diagnostics.mjs";

const checksum = "a".repeat(64);

test("motion evidence tolerates duplicate early samples but never a replaced element", () => {
  const prdFrame = (position, connected = true) => ({
    connected,
    beforeBackgroundPosition: position,
    beforeTransform: "none",
  });
  const prototypeFrame = (transform, connected = true) => ({
    connected,
    beforeBackgroundPosition: "0% 0px",
    beforeTransform: transform,
  });

  assert.deepEqual(
    classifyMotionFrameEvidence([
      prdFrame("10% 0px"),
      prdFrame("10% 0px"),
      prdFrame("20% 0px"),
    ], "prd"),
    { advanced: true, stableConnected: true },
  );
  assert.deepEqual(
    classifyMotionFrameEvidence([
      prototypeFrame("matrix(1, 0, 0, 1, 0, 0)"),
      prototypeFrame("matrix(1, 0, 0, 1, 8, 0)"),
    ], "prototype"),
    { advanced: true, stableConnected: true },
  );
  assert.deepEqual(
    classifyMotionFrameEvidence([
      prdFrame("10% 0px"),
      prdFrame("10% 0px"),
    ], "prd"),
    { advanced: false, stableConnected: true },
  );
  assert.deepEqual(
    classifyMotionFrameEvidence([
      prdFrame("10% 0px"),
      prdFrame("20% 0px", false),
    ], "prd"),
    { advanced: false, stableConnected: false },
  );
  assert.throws(
    () => classifyMotionFrameEvidence([prdFrame("10% 0px"), prdFrame("20% 0px")], "unknown"),
    /must be prd or prototype/u,
  );
});

test("motion evidence binds advancement to the requested motion preference", () => {
  const frames = (positions, connected = true) => positions.map((beforeBackgroundPosition) => ({
    beforeBackgroundPosition,
    connected,
  }));
  const moving = frames(["10% 0px", "20% 0px"]);
  const still = frames(["10% 0px", "10% 0px"]);

  assert.equal(evaluateMotionFrameEvidence(moving, "prd", false).matchesPreference, true);
  assert.equal(evaluateMotionFrameEvidence(still, "prd", false).matchesPreference, false);
  assert.equal(evaluateMotionFrameEvidence(still, "prd", true).matchesPreference, true);
  assert.equal(evaluateMotionFrameEvidence(moving, "prd", true).matchesPreference, false);
  assert.equal(evaluateMotionFrameEvidence(frames(["10% 0px", "10% 0px"], false), "prd", true).matchesPreference, false);
  assert.throws(
    () => evaluateMotionFrameEvidence(still, "prd", "false"),
    /must be boolean/u,
  );
});

test("motion capture retries replaced nodes and stops at the exact attempt bound", async () => {
  const detached = {
    frames: [
      { beforeBackgroundPosition: "10% 0px", connected: true },
      { beforeBackgroundPosition: "10% 0px", connected: false },
    ],
  };
  const stable = {
    frames: [
      { beforeBackgroundPosition: "10% 0px", connected: true },
      { beforeBackgroundPosition: "20% 0px", connected: true },
    ],
  };
  let captures = 0;
  let remountWaits = 0;
  const recovered = await captureStableMotionFrameEvidence({
    capture: async () => (++captures === 1 ? detached : stable),
    kind: "prd",
    maximumAttempts: 3,
    waitForRemount: async () => { remountWaits += 1; },
  });
  assert.equal(recovered.captureAttempts, 2);
  assert.equal(captures, 2);
  assert.equal(remountWaits, 1);

  captures = 0;
  remountWaits = 0;
  await assert.rejects(
    captureStableMotionFrameEvidence({
      capture: async () => { captures += 1; return detached; },
      kind: "prd",
      maximumAttempts: 3,
      waitForRemount: async () => { remountWaits += 1; },
    }),
    /Unable to sample a stable connected prd motion element/u,
  );
  assert.equal(captures, 3);
  assert.equal(remountWaits, 2);
});

test("motion capture normalizes a bounded remount timeout", async () => {
  let captures = 0;
  let remountWaits = 0;
  await assert.rejects(
    captureStableMotionFrameEvidence({
      capture: async () => {
        captures += 1;
        return {
          frames: [
            { beforeTransform: "none", connected: true },
            { beforeTransform: "none", connected: false },
          ],
        };
      },
      kind: "prototype",
      maximumAttempts: 3,
      waitForRemount: async () => {
        remountWaits += 1;
        throw new Error("locator timeout");
      },
    }),
    /Unable to sample a stable connected prototype motion element/u,
  );
  assert.equal(captures, 1);
  assert.equal(remountWaits, 1);
});

test("fake runtime diagnostics retain stable evidence without raw identities or payload context", () => {
  const secret = "customer-secret-identity-81726354";
  const output = diagnosticFakeRuntimeState({
    threadCreates: 2,
    secretCounter: 99,
    canvasToolCalls: [{
      runId: secret,
      toolCallId: secret,
      toolName: "get_visible_screens",
      statuses: ["waiting_client", "succeeded"],
    }],
    objectReads: [{
      storageKey: `private/e2e/${secret}/source/original`,
      byteSize: 12,
      sha256: checksum,
    }],
    visualReads: [{
      storageKey: `canvas-visuals/${secret}/visual.png`,
      byteSize: 13,
      sha256: checksum,
    }],
    exportReads: [{
      storageKey: `blobs/${secret}/export.zip`,
      byteSize: 14,
      sha256: checksum,
      role: "preview",
    }],
    gatewayUploads: [{
      path: `/api/threads/${secret}/uploads?token=${secret}`,
      principalId: secret,
      byteSize: 15,
      contentType: `application/${secret}`,
      matchedStorageKeys: [`private/e2e/${secret}/source/original`],
    }],
    runRequests: [{ kind: "success", body: { prompt: secret } }],
    requests: [{
      method: "POST",
      path: `/threads/${secret}/runs/${secret}/stream?token=${secret}`,
      kind: "success",
      externalRunId: secret,
      body: { prompt: secret },
    }, {
      method: "POST",
      path: `/threads/${secret}/runs/stream`,
      kind: "success",
    }, { errorClass: "TypeError", error: secret }],
    runtimeRuns: new Map([[secret, {
      status: "success",
      kind: "success",
      metadata: { prompt: secret },
    }]]),
    multipartCreates: [{
      storageKey: `pending/exports/${secret}/bundle.zip`,
      uploadId: secret,
    }],
    storageWrites: [{
      storageKey: `canvas-visuals/${secret}/visual.png`,
      byteSize: 16,
      mediaType: `image/png; name=${secret}`,
      sha256: checksum,
    }],
  });
  const parsed = JSON.parse(output);

  assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.equal(parsed.secretCounter, undefined);
  assert.deepEqual(parsed.canvasToolCalls, [{
    toolName: "get_visible_screens",
    statuses: ["waiting_client", "succeeded"],
  }]);
  assert.deepEqual(parsed.objectReads, [{
    keyClass: "private/:object",
    byteSize: 12,
    checksum,
  }]);
  assert.deepEqual(parsed.visualReads, [{
    keyClass: "canvas-visuals/:object",
    byteSize: 13,
    checksum,
  }]);
  assert.deepEqual(parsed.exportReads, [{
    keyClass: "blobs/:object",
    byteSize: 14,
    checksum,
    role: "preview",
  }]);
  assert.deepEqual(parsed.gatewayUploads, [{
    pathClass: "/api/threads/:id/uploads",
    byteSize: 15,
    matchedObjectCount: 1,
  }]);
  assert.deepEqual(parsed.requests, [{
    method: "POST",
    pathClass: "/threads/:id/runs/:id/stream",
    kind: "success",
  }, {
    method: "POST",
    pathClass: "/threads/:id/runs/stream",
    kind: "success",
  }, { errorClass: "TypeError" }]);
  assert.deepEqual(parsed.runtimeRuns, [{ status: "success", kind: "success" }]);
  assert.deepEqual(parsed.multipartCreates, [{ keyClass: "pending/exports/:object" }]);
  assert.deepEqual(parsed.storageWrites, [{
    keyClass: "canvas-visuals/:object",
    byteSize: 16,
    checksum,
    mediaTypeClass: "image/*",
  }]);
});

test("fake runtime diagnostics fail closed for unknown path, key, enum, and checksum values", () => {
  const secret = "never-log-this-secret-value";
  const output = diagnosticFakeRuntimeState({
    canvasToolCalls: [{ toolName: secret, statuses: [secret] }],
    objectReads: [{ storageKey: `${secret}/object`, byteSize: -1, sha256: secret }],
    visualReads: [],
    exportReads: [{ storageKey: `${secret}/object`, role: secret }],
    gatewayUploads: [{ path: `/${secret}`, matchedStorageKeys: secret }],
    runRequests: [{ kind: secret }],
    requests: [{ method: secret, path: `/${secret}`, kind: secret, errorClass: secret }],
    runtimeRuns: new Map([[secret, { status: secret, kind: secret }]]),
    multipartCreates: [{ storageKey: `${secret}/object` }],
    storageWrites: [{ storageKey: `${secret}/object`, mediaType: secret, sha256: secret }],
  });
  const parsed = JSON.parse(output);

  assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.deepEqual(parsed.canvasToolCalls, [{ toolName: "unknown", statuses: ["unknown"] }]);
  assert.deepEqual(parsed.objectReads, [{ keyClass: "unknown", byteSize: null, checksum: "invalid" }]);
  assert.deepEqual(parsed.gatewayUploads, [{
    pathClass: "unknown",
    byteSize: null,
    matchedObjectCount: 0,
  }]);
  assert.deepEqual(parsed.requests, [{
    method: "unknown",
    pathClass: "unknown",
    kind: "unknown",
    errorClass: "UnknownError",
  }]);
  assert.deepEqual(parsed.storageWrites, [{
    keyClass: "unknown",
    byteSize: null,
    checksum: "invalid",
    mediaTypeClass: "unknown",
  }]);
});

test("diagnostic error classification never retains exception messages", () => {
  assert.equal(diagnosticErrorClass(new TypeError("postgresql://user:password@host/database")), "TypeError");
  assert.equal(
    diagnosticErrorClass(new Error("request failed", { cause: { code: "ECONNREFUSED", detail: "token=secret" } })),
    "ECONNREFUSED",
  );
  assert.equal(diagnosticErrorClass("authorization: bearer secret"), "UnknownError");
});

test("successful HTTP evidence retains results without raw identities, origins, or payloads", () => {
  const secret = "customer-secret-identity-81726354";
  const evidence = httpDiagnosticSuccessEvidence({
    candidateSha: "a".repeat(40),
    controlledProvider: "controlled-local-deerflow",
    sourceClean: true,
    fakeRuntimeState: {
      threadCreates: 4,
      successRuns: 1,
      prototypePatchRuns: 1,
      sourcePrototypeRuns: 1,
      generatePrototypeRuns: 1,
      approvalRuns: 2,
      approvalResumes: 1,
      cancelRuns: 1,
      canvasSeedRuns: 1,
      canvasQuickEditRuns: 1,
      canvasDirectEditRuns: 1,
      canvasToolCalls: [{ runId: secret, body: { prompt: secret } }],
      objectReads: [{ storageKey: secret }],
      visualReads: [{ storageKey: secret }],
      gatewayUploads: [{ path: `http://127.0.0.1:54321/${secret}` }],
      apiBaseUrl: `http://127.0.0.1:54321/${secret}`,
      projectId: secret,
      runId: secret,
    },
  });
  const output = JSON.stringify(evidence);

  assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.doesNotMatch(output, /127\.0\.0\.1|apiBaseUrl|projectId|runId/u);
  assert.equal(evidence.evidenceLevel, "real-stack-http");
  assert.equal(evidence.databaseClass, "isolated-postgresql");
  assert.equal(evidence.candidate.sourceCommit, "a".repeat(40));
  assert.equal(evidence.candidate.candidateBound, true);
  assert.equal(evidence.scenarios.length, 10);
  assert(evidence.scenarios.every(({ status }) => status === "passed"));
  assert.deepEqual(evidence.runtime, {
    threadCreates: 4,
    successRuns: 1,
    prototypePatchRuns: 1,
    sourcePrototypeRuns: 1,
    generatePrototypeRuns: 1,
    approvalRuns: 2,
    approvalResumes: 1,
    cancelRuns: 1,
    canvasSeedRuns: 1,
    canvasQuickEditRuns: 1,
    canvasDirectEditRuns: 1,
    canvasToolCalls: 1,
    objectReads: 1,
    visualReads: 1,
    gatewayUploads: 1,
  });
});

test("successful HTTP evidence fails closed for invalid candidate and provider values", () => {
  const secret = "never-log-this-provider-or-candidate";
  const evidence = httpDiagnosticSuccessEvidence({
    candidateSha: secret,
    controlledProvider: secret,
    sourceClean: false,
    fakeRuntimeState: { threadCreates: -1 },
  });
  const output = JSON.stringify(evidence);

  assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.equal(evidence.provider, "unknown");
  assert.equal(evidence.candidate.sourceCommit, "invalid");
  assert.equal(evidence.candidate.sourceTreeAtStart, "dirty");
  assert.equal(evidence.candidate.candidateBound, false);
  assert.equal(evidence.runtime.threadCreates, null);
});

test("the real-stack harness records error classes and delegates diagnostic serialization", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  assert.match(source, /from "\.\/workbench-postgres-http-e2e-diagnostics\.mjs";/u);
  assert.match(source, /httpDiagnosticSuccessEvidence\(\{/u);
  assert.doesNotMatch(source, /database: databaseName,/u);
  assert.doesNotMatch(source, /apiBaseUrl,\n\s+projectLifecycle,/u);
  assert.match(source, /state\.requests\.push\(\{ errorClass: diagnosticErrorClass\(error\) \}\);/u);
  assert.doesNotMatch(source, /state\.requests\.push\(\{ error:/u);
  assert.doesNotMatch(source, /function diagnosticFakeRuntimeState\(/u);
  assert.match(source, /shouldFailRealStackEvidenceForSourceDrift\(/u);
  assert.match(source, /evidenceManifest\.failure = \{ class: "SourceDriftError" \};/u);
  assert.match(source, /throw new Error\("REAL_STACK_SOURCE_DRIFT"\);/u);
  assert.match(source, /context\.addInitScript\(installBrowserSseEvidenceObserver/u);
  assert.match(source, /sseEvents: browserSseEvents,/u);
  assert.match(source, /httpResponses,/u);
  assert.match(source, /previewEvidence,/u);
  assert.match(source, /unknownRequests\.length,/u);
  assert.match(source, /originClass === "web" \|\| originClass === "preview"/u);
});

test("the real-stack browser waits for full-header credential classification and fails closed", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /const headers = request\.headers\(\);/u);
  assert.match(source, /const headers = await request\.allHeaders\(\);/u);
  assert.match(source, /externalRequestClassifications\.push\(classification\);/u);
  assert.match(source, /return \{ \.\.\.evidence, inspection: "failed", requestClass: null \};/u);
  assert.match(source, /else unknownRequests\.push\(evidence\);/u);

  const stopCapture = source.indexOf('page.off("request", captureBrowserRequest);');
  const awaitClassifications = source.indexOf("await Promise.all(externalRequestClassifications)");
  const firstNetworkAssertion = source.indexOf("assert.ok(bffRequests.some", awaitClassifications);
  assert.ok(stopCapture >= 0, "the harness must stop accepting new classification work before asserting");
  assert.ok(
    stopCapture < awaitClassifications && awaitClassifications < firstNetworkAssertion,
    "the harness must drain credential classifications before its network assertions",
  );
});

test("the real-stack harness prepares every shared package before application builds", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  const prepare = source.indexOf('"workbench:prepare",\n    npm,\n    ["run", "workbench:prepare"]');
  const apiBuild = source.indexOf('runCommand("api:build"', prepare);
  assert.ok(prepare >= 0, "the fresh-checkout harness must run the complete root prepare contract");
  assert.ok(apiBuild > prepare, "shared package preparation must finish before API and Worker builds");
  assert.doesNotMatch(source, /runCommand\("contracts:build"/u);
  assert.doesNotMatch(source, /runCommand\("canvas-tools:build"/u);
});

test("the real-stack browser prewarms auth and protected routes before launch", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  assert.match(source, /from "\.\/e2e\/workbench-web-startup\.mjs";/u);
  const webSpawn = source.indexOf('spawnService("workbench-web-real-stack"');
  const waitForWeb = source.indexOf("await waitForWorkbenchWeb(webOrigin, web.exited);", webSpawn);
  const warmAuthRoutes = source.indexOf("await warmWorkbenchAuthRoutes(webOrigin, web.exited);", waitForWeb);
  const warmProtectedRoutes = source.indexOf("await warmWorkbenchProtectedRoutes(webOrigin, web.exited);", warmAuthRoutes);
  const browserLaunch = source.indexOf("browser = await chromium.launch", warmProtectedRoutes);
  assert.ok(
    webSpawn >= 0
      && webSpawn < waitForWeb
      && waitForWeb < warmAuthRoutes
      && warmAuthRoutes < warmProtectedRoutes
      && warmProtectedRoutes < browserLaunch,
    "the browser must start only after every auth and protected entry route is ready",
  );
  assert.match(source, /const warmedPaths = \[\.\.\.authPaths, \.\.\.protectedPaths\];/u);
  assert.match(source, /detached: process\.platform !== "win32"/u);
  assert.match(source, /await stopProcessTree\(service\.child, service\.exited\);/u);
  assert.doesNotMatch(source, /service\.child\.kill\("SIGTERM"\)/u);
});

test("the real-stack browser records bounded Playwright cleanup before writing evidence", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  const contextCleanup = source.indexOf('"browser-context",\n        () => context.close()');
  const browserCleanup = source.indexOf('"browser",\n        () => browser.close()', contextCleanup);
  const manifestWrite = source.indexOf(
    "const manifestSha256 = await writeEvidenceManifest(evidenceManifestPath, evidenceManifest);",
    browserCleanup,
  );
  assert.ok(
    contextCleanup >= 0 && contextCleanup < browserCleanup && browserCleanup < manifestWrite,
    "bounded browser cleanup must complete and be recorded before the evidence manifest is finalized",
  );
  assert.doesNotMatch(source, /await context\?\.close\(\)|await browser\?\.close\(\)/u);
});

test("the real-stack product Preview flow uses the stable action hook and preserves accessibility", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  const action = source.indexOf('const previewAction = page.locator(\'[data-project-action="preview"]\');');
  const visible = source.indexOf('previewAction.waitFor({ state: "visible", timeout: scenarioTimeoutMs })', action);
  const accessibleName = source.indexOf('previewAction.getAttribute("aria-label")', visible);
  const enabled = source.indexOf("previewAction.isEnabled()", accessibleName);
  const click = source.indexOf("previewAction.click({ timeout: scenarioTimeoutMs })", enabled);
  assert.ok(
    action >= 0 && action < visible && visible < accessibleName && accessibleName < enabled && enabled < click,
    "the Preview action must be visible, accessibly named, and enabled before the flow clicks it",
  );
  assert.doesNotMatch(source, /getByRole\("button", \{ name: "预览项目" \}\)\.click\(\)/u);
});

test("the real-stack visual sampler rejects detached nodes without weakening frame movement", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  assert.match(source, /const motionFrameSampleCount = 6;/u);
  assert.match(source, /const maximumMotionCaptureAttempts = 3;/u);
  assert.match(source, /const motionElementRemountTimeoutMs = 5_000;/u);
  assert.match(source, /connected: element\.isConnected/u);
  assert.match(source, /captureStableMotionFrameEvidence\(\{/u);
  assert.match(source, /evaluateMotionFrameEvidence\(item\.motion\.frames, kind, item\.reducedMotion\)/u);
  assert.match(source, /frameEvidence\.stableConnected/u);
  assert.match(source, /frameEvidence\.advanced/u);
  assert.match(source, /frameEvidence\.matchesPreference/u);
  assert.doesNotMatch(source, /setTimeout\(resolve, 180\)/u);
});

test("the real-stack PRD draft gate preserves pending evidence and always releases both gates", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  const fakeRuntimeStart = source.indexOf("async function startFakeDeerFlow");
  const fakeRuntimeEnd = source.indexOf("async function handleFakeDeerFlow", fakeRuntimeStart);
  const fakeRuntime = source.slice(fakeRuntimeStart, fakeRuntimeEnd);
  const cleanupStart = fakeRuntime.indexOf("async close() {");
  const cleanupEnd = fakeRuntime.indexOf("for (const socket of sockets)", cleanupStart);
  const cleanup = fakeRuntime.slice(cleanupStart, cleanupEnd);
  assert.match(fakeRuntime, /const browserPrdDraftGate = controlledGate\(\);/u);
  assert.match(fakeRuntime, /releaseBrowserPrdDraft\(\) \{\s+browserPrdDraftGate\.release\(\);/u);
  assert.match(fakeRuntime, /releaseBrowserPrdFinalization\(\) \{\s+browserPrdFinalizationGate\.release\(\);/u);
  assert.match(cleanup, /browserPrdDraftGate\.release\(\);/u);
  assert.match(cleanup, /browserPrdFinalizationGate\.release\(\);/u);

  assert.match(source, /draftGate: browserVisualPrd \? browserPrdDraftGate : null,/u);
  const streamStart = source.indexOf("async function writeSuccessfulRuntimeStream");
  const streamEnd = source.indexOf("async function writePrototypePatchRuntimeStream", streamStart);
  const stream = source.slice(streamStart, streamEnd);
  const draftGateWait = stream.indexOf("if (draftGate) await waitForControlledProviderGate(response, draftGate);");
  const draftSnapshotEmission = stream.indexOf("values: { messages: draftSnapshot }");
  const finalizationGateWait = stream.indexOf("if (finalizationGate) await waitForControlledProviderGate(response, finalizationGate);");
  const finalizationEmission = stream.indexOf('node: "finalize"', draftSnapshotEmission);
  assert.ok(draftGateWait >= 0, "the browser PRD stream must wait for draft evidence capture");
  assert.ok(
    draftSnapshotEmission >= 0 && draftGateWait < draftSnapshotEmission,
    "the browser PRD draft gate must be awaited before the draft snapshot is emitted",
  );
  assert.ok(
    finalizationGateWait >= 0 && finalizationEmission >= 0 && finalizationGateWait < finalizationEmission,
    "the browser PRD finalization gate must be awaited before finalization is emitted",
  );
  const heartbeatStart = source.indexOf("async function waitForControlledProviderGate");
  const heartbeatEnd = source.indexOf("function spawnService", heartbeatStart);
  const heartbeat = source.slice(heartbeatStart, heartbeatEnd);
  assert.match(heartbeat, /controlledProviderHeartbeatMs/u);
  assert.match(heartbeat, /response\.write\(": workbench-e2e-provider-heartbeat\\n\\n"\)/u);

  const browserStart = source.indexOf("async function runRealStackBrowserScenario");
  const browserEnd = source.indexOf("async function captureActiveGenerationVisualEvidence", browserStart);
  const browserScenario = source.slice(browserStart, browserEnd);
  const pendingEvidenceDeclaration = browserScenario.indexOf("let pendingDocumentEvidence = [];");
  const networkEmulation = browserScenario.indexOf(
    'await cdpSession.send("Network.emulateNetworkConditions", {',
    pendingEvidenceDeclaration,
  );
  const draftRelease = browserScenario.indexOf(
    "fakeRuntime.releaseBrowserPrdDraft();",
    pendingEvidenceDeclaration,
  );
  const pendingCapture = browserScenario.indexOf(
    "pendingDocumentEvidence = await capturePendingDocumentVisualEvidence",
    pendingEvidenceDeclaration,
  );
  const pendingFinally = browserScenario.indexOf("} finally {", pendingCapture);
  const finalizationRelease = browserScenario.indexOf(
    "fakeRuntime.releaseBrowserPrdFinalization();",
    pendingFinally,
  );
  const cdpDetach = browserScenario.indexOf("await cdpSession.detach();", pendingFinally);
  assert.ok(
    pendingEvidenceDeclaration >= 0
      && networkEmulation >= 0
      && draftRelease >= 0
      && pendingCapture >= 0
      && networkEmulation < draftRelease
      && draftRelease < pendingCapture,
    "the browser must enable network emulation before releasing the PRD draft gate and capturing evidence",
  );
  assert.ok(
    pendingFinally >= 0 && pendingFinally < finalizationRelease && finalizationRelease < cdpDetach,
    "the pending-evidence finally block must release the finalization gate",
  );
});

test("the real-stack Prototype finalization gate settles staging and ready checkpoints before navigation", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  const fakeRuntimeStart = source.indexOf("async function startFakeDeerFlow");
  const fakeRuntimeEnd = source.indexOf("async function handleFakeDeerFlow", fakeRuntimeStart);
  const fakeRuntime = source.slice(fakeRuntimeStart, fakeRuntimeEnd);
  const cleanupStart = fakeRuntime.indexOf("async close() {");
  const cleanupEnd = fakeRuntime.indexOf("for (const socket of sockets)", cleanupStart);
  const cleanup = fakeRuntime.slice(cleanupStart, cleanupEnd);
  assert.match(fakeRuntime, /const browserPrototypeFinalizationGate = controlledGate\(\);/u);
  assert.match(
    fakeRuntime,
    /releaseBrowserPrototypeFinalization\(\) \{\s+browserPrototypeFinalizationGate\.release\(\);/u,
  );
  assert.match(cleanup, /browserPrototypeFinalizationGate\.release\(\);/u);
  assert.match(source, /finalizationGate: browserPrototypeFinalizationGate,/u);

  const streamStart = source.indexOf("async function writePrototypeCreateRuntimeStream");
  const streamEnd = source.indexOf("function sourcePrototypeDocument", streamStart);
  const stream = source.slice(streamStart, streamEnd);
  const draftSnapshot = stream.indexOf("const draftSnapshot = structuredClone(messages);");
  const resultMessage = stream.indexOf("const result = {", draftSnapshot);
  const draftEmission = stream.indexOf("values: { messages: draftSnapshot }", resultMessage);
  const finalizationGateWait = stream.indexOf(
    "await waitForControlledProviderGate(response, finalizationGate);",
    draftEmission,
  );
  const finalizationEmission = stream.indexOf('node: "finalize"', finalizationGateWait);
  assert.ok(
    draftSnapshot >= 0
      && draftSnapshot < resultMessage
      && resultMessage < draftEmission
      && draftEmission < finalizationGateWait
      && finalizationGateWait < finalizationEmission,
    "the controlled Prototype stream must publish only its draft snapshot before awaiting finalization",
  );

  const browserStart = source.indexOf("async function runRealStackBrowserScenario");
  const browserEnd = source.indexOf("async function captureActiveGenerationVisualEvidence", browserStart);
  const browserScenario = source.slice(browserStart, browserEnd);
  const checkpointCollection = browserScenario.indexOf("const prototypeCheckpointResponses = [];");
  const responseListener = browserScenario.indexOf(
    'page.on("response", capturePrototypeCheckpointResponse);',
    checkpointCollection,
  );
  const prototypeSubmission = browserScenario.indexOf(
    'await page.getByRole("button", { name: /基于此 PRD 生成 UI/u }).click();',
    responseListener,
  );
  const prototypeVisualCapture = browserScenario.indexOf(
    "await captureActiveGenerationVisualEvidence({",
    prototypeSubmission,
  );
  const stagingCheckpointWait = browserScenario.indexOf(
    "() => prototypeCheckpointResponses.length >= 1",
    prototypeVisualCapture,
  );
  const stagingCheckpointFinished = browserScenario.indexOf(
    "await stagingEntry.response.finished()",
    stagingCheckpointWait,
  );
  const stagingStatus = browserScenario.indexOf(
    'assert.equal(stagingCheckpoint.status, "staging"',
    stagingCheckpointFinished,
  );
  const finalizationRelease = browserScenario.indexOf(
    "fakeRuntime.releaseBrowserPrototypeFinalization();",
    stagingStatus,
  );
  const prototypeComplete = browserScenario.indexOf(
    "await page.locator('[data-phase=\"complete\"]')",
    finalizationRelease,
  );
  const readyCheckpointWait = browserScenario.indexOf(
    "() => prototypeCheckpointResponses.length >= 2",
    prototypeComplete,
  );
  const readyCheckpointFinished = browserScenario.indexOf(
    "await response.finished()",
    readyCheckpointWait,
  );
  const readyIdentity = browserScenario.indexOf(
    "response.body.runId === prototypeCheckpointIdentity.runId",
    readyCheckpointFinished,
  );
  const readyStatus = browserScenario.indexOf(
    'response.body.status === "ready"',
    readyIdentity,
  );
  const responseListenerRemoval = browserScenario.indexOf(
    'page.off("response", capturePrototypeCheckpointResponse);',
    readyStatus,
  );
  const persistenceIdentity = browserScenario.indexOf(
    "projectId,\n      prototypeCheckpointIdentity,",
    responseListenerRemoval,
  );
  const nextNavigation = browserScenario.indexOf(
    "await runScriptedHardNavigation({",
    persistenceIdentity,
  );
  assert.ok(
    checkpointCollection >= 0
      && checkpointCollection < responseListener
      && responseListener < prototypeSubmission
      && prototypeSubmission < prototypeVisualCapture
      && prototypeVisualCapture < stagingCheckpointWait
      && stagingCheckpointWait < stagingCheckpointFinished
      && stagingCheckpointFinished < stagingStatus
      && stagingStatus < finalizationRelease
      && finalizationRelease < prototypeComplete
      && prototypeComplete < readyCheckpointWait
      && readyCheckpointWait < readyCheckpointFinished
      && readyCheckpointFinished < readyIdentity
      && readyIdentity < readyStatus
      && readyStatus < responseListenerRemoval
      && responseListenerRemoval < persistenceIdentity
      && persistenceIdentity < nextNavigation,
    "the Prototype flow must bind staged and ready checkpoints before persistence proof and navigation",
  );
});

test("the real-stack visual lane separates active motion from pending document assertions", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  const activeStart = source.indexOf("function assertActiveGenerationVisualEvidence");
  const activeEnd = source.indexOf("async function captureStableMotionFrames", activeStart);
  const pendingCaptureStart = source.indexOf("async function capturePendingDocumentVisualEvidence", activeEnd);
  const pendingLayoutWaitStart = source.indexOf("async function waitForStableViewportRect", pendingCaptureStart);
  const pendingStart = source.indexOf("function assertPendingDocumentVisualEvidence", activeStart);
  const pendingEnd = source.indexOf("function browserUrlClass", pendingStart);
  assert.ok(
    activeStart >= 0
      && activeEnd > activeStart
      && pendingCaptureStart > activeEnd
      && pendingLayoutWaitStart > pendingCaptureStart
      && pendingStart > pendingLayoutWaitStart
      && pendingEnd > pendingStart,
  );
  const activeAssertions = source.slice(activeStart, activeEnd);
  const pendingCapture = source.slice(pendingCaptureStart, pendingLayoutWaitStart);
  const pendingLayoutWait = source.slice(pendingLayoutWaitStart, pendingStart);
  const pendingAssertions = source.slice(pendingStart, pendingEnd);
  const pendingSemanticAssertions = [
    ...source.matchAll(/assert\.(?:equal|ok|deepEqual)\(\s*item\.(?:ariaLive|hasSkeleton|hasSpinner)\b/gu),
  ];

  assert.doesNotMatch(activeAssertions, /pendingArtifact|hasSkeleton|hasSpinner|ariaLive|pending surface/u);
  assert.equal(pendingSemanticAssertions.length, 3);
  assert.ok(
    pendingSemanticAssertions.every(({ index }) => index >= pendingStart && index < pendingEnd),
    "pending document semantic assertions must remain in their dedicated assertion function",
  );
  assert.match(pendingAssertions, /item\.ariaLive/u);
  assert.match(pendingAssertions, /item\.hasSkeleton/u);
  assert.match(pendingAssertions, /item\.hasSpinner/u);
  assert.match(pendingAssertions, /pending PRD document escaped the viewport/u);
  assert.match(pendingAssertions, /pending PRD document was obscured by/u);
  assert.match(pendingCapture, /await waitForStableViewportRect\(pendingDocument, viewport/u);
  assert.match(pendingCapture, /connected: spinner\.isConnected/u);
  assert.match(pendingCapture, /sampleCount: motionFrameSampleCount/u);
  assert.match(pendingLayoutWait, /stableSamples >= 2/u);
  assert.match(pendingLayoutWait, /rect\.x \+ rect\.width <= viewport\.width/u);
  assert.match(pendingAssertions, /spinnerFrames\.every\(\(frame\) => frame\?\.connected\)/u);
  assert.match(pendingAssertions, /spinnerTransforms\.size > 1/u);
  assert.match(pendingAssertions, /spinnerTransforms\.size, 1/u);
  assert.match(source, /selected action remained visible during/u);
  assert.match(source, /\["utilityPill", "composer"\]/u);
  assert.match(source, /\["suggestions", "composer"\]/u);
  assert.match(source, /capturePendingDocumentVisualEvidence\(\{/u);
});
