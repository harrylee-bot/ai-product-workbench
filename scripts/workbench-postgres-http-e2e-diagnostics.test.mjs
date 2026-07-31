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

test("the real-stack browser prewarms protected routes and tears down complete process trees", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  assert.match(source, /from "\.\/e2e\/workbench-web-startup\.mjs";/u);
  const webSpawn = source.indexOf('spawnService("workbench-web-real-stack"');
  const waitForWeb = source.indexOf("await waitForWorkbenchWeb(webOrigin, web.exited);", webSpawn);
  const warmRoutes = source.indexOf("await warmWorkbenchProtectedRoutes(webOrigin, web.exited);", waitForWeb);
  const browserLaunch = source.indexOf("browser = await chromium.launch", warmRoutes);
  assert.ok(
    webSpawn >= 0 && webSpawn < waitForWeb && waitForWeb < warmRoutes && warmRoutes < browserLaunch,
    "the browser must start only after the managed Web process and both protected routes are ready",
  );
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

test("the real-stack visual lane proves early pending surfaces and responsive control separation", async () => {
  const source = await readFile(new URL("./workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");

  assert.match(source, /data-workbench-transient-artifact/u);
  assert.match(source, /pendingArtifactState/u);
  assert.match(source, /selected action remained visible during/u);
  assert.match(source, /\["utilityPill", "composer"\]/u);
  assert.match(source, /\["suggestions", "composer"\]/u);
  assert.match(source, /\["pendingArtifact", "mobileRunStatus"\]/u);
  assert.match(source, /\["pendingArtifact", "rightToolRail"\]/u);
  assert.match(source, /early \$\{kind\} pending surface was not visible/u);
});
