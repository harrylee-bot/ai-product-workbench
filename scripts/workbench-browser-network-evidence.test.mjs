import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRealStackBrowserMode,
  browserNetworkFailureClass,
  browserOriginClass,
  browserSseEventEvidence,
  clientRoutePrefetchAbortAttribution,
  connectionErrorClass,
  createScriptedNavigationAbortTracker,
  hasRequiredBrowserSseEvidence,
  httpOriginClass,
  httpPathClass,
  persistedTerminalSseAbortAttribution,
  shouldFailRealStackEvidenceForSourceDrift,
} from "./workbench-browser-network-evidence.mjs";

test("browser-only mode fails closed unless the real-stack browser lane is enabled", () => {
  assert.doesNotThrow(() => assertRealStackBrowserMode({ browserOnly: false, enabled: false }));
  assert.doesNotThrow(() => assertRealStackBrowserMode({ browserOnly: false, enabled: true }));
  assert.doesNotThrow(() => assertRealStackBrowserMode({ browserOnly: true, enabled: true }));
  assert.throws(
    () => assertRealStackBrowserMode({ browserOnly: true, enabled: false }),
    /requires the real-stack browser lane/u,
  );
});

test("source drift invalidates otherwise successful real-stack evidence", () => {
  assert.equal(shouldFailRealStackEvidenceForSourceDrift("passed", true), true);
  assert.equal(shouldFailRealStackEvidenceForSourceDrift("passed", false), false);
  assert.equal(shouldFailRealStackEvidenceForSourceDrift("failed", true), false);
  assert.equal(shouldFailRealStackEvidenceForSourceDrift("running", true), false);
});

test("attributes only a same-route client prefetch abort with successful route evidence", () => {
  const failure = {
    abortAttribution: null,
    originClass: "web",
    method: "GET",
    pathClass: "/projects/:id",
    errorText: "net::ERR_ABORTED",
    resourceType: "fetch",
  };
  const navigationEvidence = [{
    actualPathClass: "/projects/:id",
    status: 200,
    targetPathClass: "/projects/:id",
  }];
  assert.deepEqual(clientRoutePrefetchAbortAttribution({
    currentPathClass: "/projects/:id",
    failure,
    navigationEvidence,
  }), { cause: "client-route-prefetch" });
  assert.equal(clientRoutePrefetchAbortAttribution({
    currentPathClass: "/",
    failure,
    navigationEvidence,
  }), null);
  assert.equal(clientRoutePrefetchAbortAttribution({
    currentPathClass: "/projects/:id",
    failure: { ...failure, resourceType: "document" },
    navigationEvidence,
  }), null);
  assert.equal(clientRoutePrefetchAbortAttribution({
    currentPathClass: "/projects/:id",
    failure,
    navigationEvidence: [],
  }), null);
});

test("classifies browser origins and failures without retaining unknown locations or messages", () => {
  const origins = {
    webOrigin: "https://workbench.example.test",
    previewOrigin: "https://preview.example.test",
  };
  assert.equal(browserOriginClass("https://workbench.example.test/api/v1/runs/secret", origins), "web");
  assert.equal(browserOriginClass("https://preview.example.test/preview/secret", origins), "preview");
  assert.equal(browserOriginClass("https://other.example.test/private/secret", origins), "https-remote");
  assert.equal(browserOriginClass("not a url", origins), "invalid");
  assert.equal(browserNetworkFailureClass("net::ERR_ABORTED"), "net::ERR_ABORTED");
  assert.equal(browserNetworkFailureClass("private failure detail"), "unknown");
});

test("requires forward SSE replay plus completed and failed browser terminal evidence", () => {
  const evidence = [
    { afterSequence: 10, eventName: "run.phase.changed", sequence: 11 },
    { afterSequence: 1, eventName: "run.completed", sequence: 24 },
    { afterSequence: 1, eventName: "run.failed", sequence: 6 },
  ];
  assert.equal(hasRequiredBrowserSseEvidence(evidence, 10), true);
  assert.equal(
    hasRequiredBrowserSseEvidence([...evidence, {
      afterSequence: 1,
      eventName: "run.cancelled",
      sequence: 7,
    }], 10),
    true,
  );
  assert.equal(hasRequiredBrowserSseEvidence(evidence.filter((event) => (
    event.eventName !== "run.failed"
  )), 10), false);
  assert.equal(hasRequiredBrowserSseEvidence(evidence, 12), false);
  assert.equal(hasRequiredBrowserSseEvidence(evidence, -1), false);
});

test("accepts only allowlisted browser-observed SSE names and forward sequences", () => {
  assert.deepEqual(browserSseEventEvidence({
    afterSequence: 7,
    eventName: "run.completed",
    sequence: 8,
  }), {
    afterSequence: 7,
    eventName: "run.completed",
    sequence: 8,
  });
  assert.equal(browserSseEventEvidence({
    afterSequence: 7,
    eventName: "run.private-payload",
    sequence: 8,
  }), null);
  assert.equal(browserSseEventEvidence({
    afterSequence: 8,
    eventName: "run.completed",
    sequence: 8,
  }), null);
});

test("redacts route identities without collapsing stable endpoint names", () => {
  assert.equal(
    httpPathClass("/api/v1/artifacts/cms3ebv14001kcb6277qtb7e4/versions/cms3ebv15001mcb62secret"),
    "/api/v1/artifacts/:id/versions/:id",
  );
  assert.equal(
    httpPathClass("/api/v1/projects/31c714e8-3500-4917-a834-91a9e3355af3/canvas-agent/state"),
    "/api/v1/projects/:id/canvas-agent/state",
  );
  assert.equal(
    httpPathClass("/api/v1/runs/cms3ebv14001kcb6277qtb7e4/artifact-drafts/cms3ebv15001mcb62secret/checkpoint"),
    "/api/v1/runs/:id/artifact-drafts/:id/checkpoint",
  );
  assert.equal(
    httpPathClass("/api/v1/public/shares/not-a-log-safe-token"),
    "/api/v1/public/shares/:id",
  );
  assert.equal(httpPathClass("/preview/not-a-log-safe-token"), "/preview/:id");
});

test("classifies readiness origins and connection errors without retaining URLs or messages", () => {
  const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  assert.equal(connectionErrorClass(refused), "ECONNREFUSED");
  assert.equal(connectionErrorClass(new Error("sensitive detail")), "Error");
  assert.equal(connectionErrorClass("sensitive detail"), "UnknownError");
  assert.equal(httpOriginClass("http://127.0.0.1:4317/system/ready"), "http-loopback");
  assert.equal(httpOriginClass("https://service.example.test/ready?token=secret"), "https-remote");
});

test("attributes old-document cleanup until the main frame navigates", () => {
  const tracker = createScriptedNavigationAbortTracker();
  const existingRequest = {};
  const preCommitRequest = {};
  const navigationRequest = {};
  const newDocumentRequest = {};
  tracker.requestStarted(existingRequest);

  const scope = tracker.beginNavigation({
    kind: "goto",
    targetPathClass: "/projects/:id",
  });
  tracker.requestStarted(preCommitRequest);
  tracker.requestStarted(navigationRequest, { navigationRequest: true });
  tracker.mainFrameNavigated();
  tracker.requestStarted(newDocumentRequest, {
    pathClass: "/projects/:id",
    resourceType: "document",
  });
  tracker.endNavigation(scope);

  assert.deepEqual(tracker.classifyFailure(existingRequest, "net::ERR_ABORTED"), {
    cause: "scripted-hard-navigation",
    navigationKind: "goto",
    targetPathClass: "/projects/:id",
  });
  assert.deepEqual(tracker.classifyFailure(preCommitRequest, "net::ERR_ABORTED"), {
    cause: "scripted-hard-navigation",
    navigationKind: "goto",
    targetPathClass: "/projects/:id",
  });
  assert.equal(
    tracker.classifyFailure(navigationRequest, "net::ERR_ABORTED"),
    null,
    "the main navigation request must not be hidden",
  );
  assert.equal(
    tracker.classifyFailure(newDocumentRequest, "net::ERR_ABORTED"),
    null,
    "a request started by the committed new document must not be hidden",
  );

  const committedRouteFetch = {};
  const secondScope = tracker.beginNavigation({
    kind: "goto",
    targetPathClass: "/projects/:id",
  });
  tracker.mainFrameNavigated();
  tracker.requestStarted(committedRouteFetch, {
    pathClass: "/projects/:id",
    resourceType: "fetch",
  });
  assert.deepEqual(tracker.classifyFailure(committedRouteFetch, "net::ERR_ABORTED"), {
    cause: "scripted-hard-navigation",
    navigationKind: "goto",
    targetPathClass: "/projects/:id",
  });
  tracker.endNavigation(secondScope);
});

test("does not attribute failures outside the exact navigation abort contract", () => {
  const tracker = createScriptedNavigationAbortTracker();
  const completedRequest = {};
  const failedRequest = {};
  tracker.requestStarted(completedRequest);
  tracker.requestFinished(completedRequest);
  tracker.requestStarted(failedRequest);

  const scope = tracker.beginNavigation({ kind: "reload", targetPathClass: "/projects/:id" });
  assert.equal(tracker.classifyFailure(completedRequest, "net::ERR_ABORTED"), null);
  assert.equal(tracker.classifyFailure(failedRequest, "net::ERR_FAILED"), null);
  tracker.endNavigation(scope);

  const laterAbort = {};
  tracker.requestStarted(laterAbort);
  assert.equal(
    tracker.classifyFailure(laterAbort, "net::ERR_ABORTED"),
    null,
    "an abort after the scripted navigation window must remain unexpected",
  );
});

test("rejects overlapping or mismatched scripted navigation scopes", () => {
  const tracker = createScriptedNavigationAbortTracker();
  const scope = tracker.beginNavigation({ kind: "goto", targetPathClass: "/register" });
  assert.throws(
    () => tracker.beginNavigation({ kind: "reload", targetPathClass: "/register" }),
    /cannot overlap/u,
  );
  assert.throws(
    () => tracker.endNavigation({}),
    /scope identity changed/u,
  );
  tracker.endNavigation(scope);
});

test("attributes an SSE abort only to a matching persisted terminal Run", () => {
  const failure = {
    method: "GET",
    pathClass: "/api/v1/runs/:id/events",
    errorText: "net::ERR_ABORTED",
    resourceType: "fetch",
    abortAttribution: null,
  };

  assert.deepEqual(persistedTerminalSseAbortAttribution({
    afterSequence: 12,
    failure,
    persistedRun: {
      status: "succeeded",
      eventSequence: 13,
      terminalEventSequence: 13,
      terminalEventType: "run.completed",
    },
    responseStatus: 200,
  }), {
    cause: "persisted-terminal-run-sse-cleanup",
    terminalStatus: "succeeded",
    terminalEventType: "run.completed",
    terminalSequence: 13,
  });
});

test("attributes a cancelled SSE abort only to a matching persisted cancellation", () => {
  const failure = {
    method: "GET",
    pathClass: "/api/v1/runs/:id/events",
    errorText: "net::ERR_ABORTED",
    resourceType: "fetch",
    abortAttribution: null,
  };
  const cancelledRun = {
    status: "cancelled",
    eventSequence: 9,
    terminalEventSequence: 9,
    terminalEventType: "run.cancelled",
  };

  assert.deepEqual(persistedTerminalSseAbortAttribution({
    afterSequence: 8,
    failure,
    persistedRun: cancelledRun,
    responseStatus: 200,
  }), {
    cause: "persisted-terminal-run-sse-cleanup",
    terminalStatus: "cancelled",
    terminalEventType: "run.cancelled",
    terminalSequence: 9,
  });
  assert.equal(persistedTerminalSseAbortAttribution({
    afterSequence: 8,
    failure,
    persistedRun: { ...cancelledRun, terminalEventType: "run.failed" },
    responseStatus: 200,
  }), null);
});

test("does not whitelist an SSE abort without complete terminal persistence evidence", () => {
  const failure = {
    method: "GET",
    pathClass: "/api/v1/runs/:id/events",
    errorText: "net::ERR_ABORTED",
    resourceType: "fetch",
    abortAttribution: null,
  };
  const validRun = {
    status: "failed",
    eventSequence: 8,
    terminalEventSequence: 8,
    terminalEventType: "run.failed",
  };
  const cases = [
    { responseStatus: null },
    { afterSequence: 8 },
    { persistedRun: null },
    { persistedRun: { ...validRun, status: "running" } },
    { persistedRun: { ...validRun, terminalEventType: "run.completed" } },
    { persistedRun: { ...validRun, eventSequence: 9 } },
    { failure: { ...failure, abortAttribution: { cause: "scripted-hard-navigation" } } },
    { failure: { ...failure, pathClass: "/api/v1/projects/:id" } },
  ];

  for (const overrides of cases) {
    assert.equal(persistedTerminalSseAbortAttribution({
      afterSequence: 7,
      failure,
      persistedRun: validRun,
      responseStatus: 200,
      ...overrides,
    }), null);
  }
});
