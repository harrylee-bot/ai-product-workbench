import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sharp from "sharp";

import { productionG11RouteBindingSha256 } from "./g11-browser-evidence-contract.mjs";
import { __g11HarnessTestOnly } from "./g11-browser-evidence-harness.mjs";

test("G11 assertion recorder binds assertionSpecId, exact sequence, and real assertion kind", async () => {
  const recorder = __g11HarnessTestOnly.createAssertionRecorder({
    callIndex: 1,
    page: { evaluate: async (evaluate) => evaluate() },
    specs: [{ assertionSpecId: "condition-a", kind: "condition" }],
    stepId: "protected-step",
    traceId: "trace-stable-1",
  });

  await recorder.api.condition("condition-a", async () => true);
  recorder.assertComplete();
  assert.deepEqual(recorder.records(), [{
    assertionId: "trace-stable-1-call-1-assertion-1",
    assertionSpecId: "condition-a",
    kind: "condition",
    status: "PASS",
    stepId: "protected-step",
  }]);
  await assert.rejects(
    recorder.api.condition("unexpected", async () => true),
    /protected assertion sequence/u,
  );
});

test("G11 network capture drains public serverAddr and requires exactly one protected rejection", async () => {
  const origins = {
    web: "https://app.example.test",
    preview: "https://preview.example.test",
    approvedThirdParty: [],
  };
  const capture = __g11HarnessTestOnly.createNetworkCapture(
    origins,
    [{
      ruleId: "mixed-request-rejection",
      method: "POST",
      originClass: "web",
      pathClass: "api",
      routeTemplateId: "threads.submission-intents",
      routeBindingSha256: productionG11RouteBindingSha256("threads.submission-intents", { threadId: "thread-stable-1" }),
      statusCodes: [400],
    }],
    new Map([
      [origins.web, new Set(["8.8.8.8"])],
      [origins.preview, new Set(["1.1.1.1"])],
    ]),
  );
  const request = {
    method: () => "POST",
    resourceType: () => "fetch",
    url: () => "https://app.example.test/api/v1/threads/thread-stable-1/submission-intents",
  };
  capture.onRequest(request);
  capture.onResponse({
    request: () => request,
    serverAddr: async () => ({ ipAddress: "8.8.8.8", port: 443 }),
    status: () => 400,
  });
  await capture.drain();
  capture.assertExpectedRejections();
  const [record] = await capture.freeze();
  assert.deepEqual(record, {
    requestId: "request-1",
    method: "POST",
    originClass: "web",
    pathClass: "api",
    routeTemplateId: "threads.submission-intents",
    routeBindingSha256: productionG11RouteBindingSha256("threads.submission-intents", { threadId: "thread-stable-1" }),
    resourceType: "fetch",
    statusCode: 400,
    failureClass: "none",
    outcomeClass: "expected-http-error",
    expectationRuleId: "mixed-request-rejection",
    attributionCode: "expected-client-rejection",
    durationMs: record.durationMs,
    origin: origins.web,
    remoteAddress: "8.8.8.8",
    remotePort: 443,
  });
  assert.equal(Number.isInteger(record.durationMs), true);

  const duplicateCapture = __g11HarnessTestOnly.createNetworkCapture(
    origins,
    [{
      ruleId: "mixed-request-rejection",
      method: "POST",
      originClass: "web",
      pathClass: "api",
      routeTemplateId: "threads.submission-intents",
      routeBindingSha256: productionG11RouteBindingSha256("threads.submission-intents", { threadId: "thread-stable-1" }),
      statusCodes: [400],
    }],
    new Map([
      [origins.web, new Set(["8.8.8.8"])],
      [origins.preview, new Set(["1.1.1.1"])],
    ]),
  );
  for (const duplicateRequest of [request, { ...request }]) {
    duplicateCapture.onRequest(duplicateRequest);
    duplicateCapture.onResponse({
      request: () => duplicateRequest,
      serverAddr: async () => ({ ipAddress: "8.8.8.8", port: 443 }),
      status: () => 400,
    });
  }
  await duplicateCapture.drain();
  assert.throws(() => duplicateCapture.assertExpectedRejections(), /exactly one/u);
});

test("G11 network path classes keep account rejections distinct", () => {
  assert.equal(__g11HarnessTestOnly.classifyPath("/api/v1/projects/project-a/bootstrap"), "api");
  assert.equal(__g11HarnessTestOnly.classifyPath("/api/v1/project-invitations/accept"), "auth");
  assert.equal(__g11HarnessTestOnly.classifyPath("/api/auth/get-session"), "auth");
});

test("G11 origin and endpoint checks reject suffix, private IPv6, DNS rebinding, and unauditable WebSocket paths", async () => {
  assert.equal(__g11HarnessTestOnly.isCanonicalPublicOrigin("https://example.com."), false);
  assert.equal(__g11HarnessTestOnly.isCanonicalPublicOrigin("https://[2001:db8::1]"), false);
  assert.equal(__g11HarnessTestOnly.isCanonicalPublicOrigin("https://[2606:4700:4700::1111]"), true);
  assert.equal(__g11HarnessTestOnly.isGlobalIp("2001:db8::1"), false);
  assert.equal(__g11HarnessTestOnly.isGlobalIp("2606:4700:4700::1111"), true);

  const origins = {
    web: "https://app.example.test",
    preview: "https://preview.example.test",
    approvedThirdParty: [],
  };
  const expected = [{
    ruleId: "mixed-request-rejection",
    method: "POST",
    originClass: "web",
    pathClass: "api",
    routeTemplateId: "threads.submission-intents",
    routeBindingSha256: productionG11RouteBindingSha256("threads.submission-intents", { threadId: "thread-stable-1" }),
    statusCodes: [400],
  }];
  const rebinding = __g11HarnessTestOnly.createNetworkCapture(
    origins,
    expected,
    new Map([[origins.web, new Set(["8.8.8.8"])], [origins.preview, new Set(["1.1.1.1"])]]),
  );
  const request = {
    method: () => "POST",
    resourceType: () => "fetch",
    url: () => "https://app.example.test/api/v1/threads/thread-stable-1/submission-intents",
  };
  rebinding.onRequest(request);
  rebinding.onResponse({
    request: () => request,
    serverAddr: async () => ({ ipAddress: "9.9.9.9", port: 443 }),
    status: () => 400,
  });
  await assert.rejects(rebinding.drain(), /approved hostname\/IP boundary/u);

  const websocket = __g11HarnessTestOnly.createNetworkCapture(
    origins,
    [],
    new Map([[origins.web, new Set(["8.8.8.8"])], [origins.preview, new Set(["1.1.1.1"])]]),
  );
  websocket.onWebSocket({ url: () => "wss://app.example.test/socket" });
  await assert.rejects(websocket.drain(), /WebSocket without auditable serverAddr/u);
});

test("G11 SSE evidence is bounded at 12,000 and rejects malformed events", () => {
  assert.equal(__g11HarnessTestOnly.maxSseEvents, 12_000);
  const streamPathname = "/api/v1/runs/run-stable-1/events";
  const streamId = createHash("sha256").update(streamPathname, "utf8").digest("hex");
  assert.deepEqual(__g11HarnessTestOnly.sanitizeSseEvidence({
    afterSequence: 7,
    eventName: "run.generation.stage.changed",
    sequence: 8,
    streamPathname,
  }), { afterSequence: 7, eventName: "run.generation.stage.changed", sequence: 8, streamId });
  assert.equal(__g11HarnessTestOnly.sanitizeSseEvidence({
    afterSequence: 8,
    eventName: "run.generation.stage.changed",
    sequence: 8,
    streamPathname,
  }), null);
  assert.equal(__g11HarnessTestOnly.sanitizeSseEvidence({
    afterSequence: 7,
    eventName: "run.progress",
    sequence: 8,
    streamPathname,
  }), null);
  assert.equal(__g11HarnessTestOnly.sanitizeSseEvidence({
    afterSequence: 7,
    eventName: "unknown.event",
    sequence: 8,
    streamPathname,
  }), null);
  assert.equal(__g11HarnessTestOnly.sanitizeSseEvidence({
    afterSequence: 7,
    eventName: "run.completed",
    sequence: 8,
    streamPathname: "/api/v1/runs/run-stable-1/events?token=secret",
  }), null);
});

test("G11 SSE allowlist exactly follows the authoritative RunEvent union", async () => {
  const source = await readFile(
    new URL("../../packages/workbench-contracts/src/runs.ts", import.meta.url),
    "utf8",
  );
  const authoritativeNames = [...source.matchAll(/\bevent\(\s*"([a-z][a-z.]+)"/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual([...__g11HarnessTestOnly.sseEventNames].sort(), authoritativeNames);
});

test("G11 scenario secrets are exact and account-only invitation tokens use the product contract", () => {
  const base = { account: "acceptance@example.com", password: "correct-horse-battery" };
  assert.doesNotThrow(() => __g11HarnessTestOnly.validateScenarioSecrets(base, "prd"));
  assert.throws(
    () => __g11HarnessTestOnly.validateScenarioSecrets({ ...base, invitationToken: "unexpected" }, "prd"),
    /scenario secret contract/u,
  );
  const invitationToken = `wbi_${"A".repeat(48)}.${"B".repeat(43)}`;
  assert.doesNotThrow(() => __g11HarnessTestOnly.validateScenarioSecrets({
    ...base,
    invitationToken,
    expiredInvitationToken: invitationToken,
  }, "account-project"));
  assert.throws(
    () => __g11HarnessTestOnly.validateScenarioSecrets(base, "account-project"),
    /scenario secret contract/u,
  );
});

test("G11 visual evidence compares decoded RGBA pixels only inside integer target bounds", async () => {
  const viewport = { width: 32, height: 32 };
  const before = await sharp({
    create: { width: viewport.width, height: viewport.height, channels: 4, background: "#101010" },
  }).png().toBuffer();
  const changedTarget = await sharp({
    create: { width: 16, height: 16, channels: 4, background: "#ffffff" },
  }).png().toBuffer();
  const after = await sharp(before).composite([{ input: changedTarget, left: 0, top: 0 }]).png().toBuffer();
  assert.equal(
    await __g11HarnessTestOnly.rgbaTargetPixelDiffRatio(before, after, { x: 0, y: 0, width: 16, height: 16 }, viewport),
    1,
  );
  assert.equal(
    await __g11HarnessTestOnly.rgbaTargetPixelDiffRatio(before, after, { x: 16, y: 16, width: 16, height: 16 }, viewport),
    0,
  );
  await assert.rejects(
    __g11HarnessTestOnly.rgbaTargetPixelDiffRatio(before, after, { x: 0.5, y: 0, width: 16, height: 16 }, viewport),
    /integer target bounds/u,
  );
});

test("G11 protected harness source is safe to seal as raw evidence", async () => {
  const source = await readFile(new URL("./g11-browser-evidence-harness.mjs", import.meta.url), "utf8");
  const assignedCredential = /\b(?:api[_-]?key|authorization|client[_-]?secret|cookie|password|private[_-]?key|refresh[_-]?token|secret|token)\b\s*[:=]\s*["']?(?!\$\{|\$[A-Z_]|<redacted>|\[redacted\]|redacted\b|none\b|null\b)[A-Za-z0-9._~+\/-]{8,}/iu;
  assert.doesNotMatch(source, assignedCredential);
});
