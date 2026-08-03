import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { crc32 } from "node:zlib";

import sharp from "sharp";

import { canonicalJsonFile } from "../evidence-ledger.mjs";
import {
  G11_BROWSERS,
  G11_MAX_SSE_RECORDS,
  G11_MOTIONS,
  G11_RUN_EVENT_NAMES,
  G11_VIEWPORTS,
  productionG11OriginPolicySha256,
  productionG11RouteBindingSha256,
  productionG11ScenarioId,
  productionG11ScenarioPlan,
  productionG11ScenarioPlanSha256,
} from "./g11-browser-evidence-contract.mjs";

const BROWSERS = new Set(G11_BROWSERS);
const MOTIONS = new Set(G11_MOTIONS);
const API_NAMES = new Set([
  "page.goto", "page.reload", "page.waitForResponse", "page.waitForTimeout", "page.evaluate",
  "locator.click", "locator.fill", "locator.waitFor", "expect.toBeVisible", "expect.toBeHidden",
  "expect.toHaveAttribute", "expect.toHaveCount", "expect.toHaveText", "expect.toHaveURL",
  "browserContext.newPage",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_SELECTOR_PATTERN = /^(?:(?:\[data-[a-z0-9-]+(?:=["'][A-Za-z0-9._:/-]{1,128}["'])?\])|(?:iframe\[data-preview-capability\])|(?:#[A-Za-z][A-Za-z0-9_-]{0,127})|(?:textarea\[aria-label="[^"]{1,128}"\])|(?:input\[placeholder="[^"]{1,256}"\]))(?:\s*,\s*(?:(?:\[data-[a-z0-9-]+(?:=["'][A-Za-z0-9._:/-]{1,128}["'])?\])|(?:iframe\[data-preview-capability\])|(?:#[A-Za-z][A-Za-z0-9_-]{0,127})|(?:textarea\[aria-label="[^"]{1,128}"\])|(?:input\[placeholder="[^"]{1,256}"\])))*$/u;
const ORIGIN_KEYS = Object.freeze(["approvedThirdParty", "preview", "schemaVersion", "web"]);
const MAX_VISUAL_BYTES = 20 * 1024 * 1024;
const VISUAL_SAMPLE_INTERVAL_MS = 180;
const SSE_EVENT_NAMES = new Set(G11_RUN_EVENT_NAMES);
const CONTEXT_BOUNDARIES = new WeakMap();
const VIEWPORTS = new Map(G11_VIEWPORTS.map((viewport) => [viewport.id, viewport]));
const OPERATION_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const MAX_STEPS = 5_000;
const PROTECTED_MIXED_COMPOSER_PROMPT = "生成一份需求文档和页面原型";
const PROTECTED_MIXED_REJECTION_MESSAGE =
  "一次运行只能生成需求文档或原型。请先完成需求文档，再发起原型生成。";

export async function collectG11SanitizedBrowserTrace({
  ...rawInput
}) {
  const input = validateCollectionInput(rawInput);
  const scenario = input.scenarioPlan;
  const approvedOriginAddresses = await validateOriginReachability(input.origins);
  const playwright = await import("playwright");
  const browserType = playwright[input.browserName];
  if (!browserType) throw new Error("unsupported Playwright browser");

  await mkdir(input.temporaryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(input.outputPath), { recursive: true, mode: 0o700 });
  const canonicalEvidenceRoot = await realpath(input.evidenceRoot);
  const canonicalTemporaryParent = await realpath(input.temporaryDirectory);
  const canonicalOutputParent = await realpath(path.dirname(input.outputPath));
  await assertSecureDirectory(canonicalEvidenceRoot, "G11 evidence root");
  await assertSecureDirectory(canonicalTemporaryParent, "native Playwright trace parent", { allowSticky: true });
  const outputParentIdentity = await assertSecureDirectory(canonicalOutputParent, "sanitized trace output directory");
  assertOutsideRoot(canonicalTemporaryParent, canonicalEvidenceRoot, "native Playwright trace directory");
  assertWithinRoot(canonicalOutputParent, canonicalEvidenceRoot, "sanitized Playwright trace directory");
  const privateTraceDirectory = await mkdtemp(path.join(canonicalTemporaryParent, ".g11-native-"));
  await chmod(privateTraceDirectory, 0o700);
  await assertSecureDirectory(privateTraceDirectory, "private native Playwright trace directory");
  const nativeTracePath = path.join(privateTraceDirectory, "trace.zip");
  const canonicalOutputPath = path.join(canonicalOutputParent, path.basename(input.outputPath));

  let browser;
  let context;
  let page;
  let nativeTraceSha256;
  let sanitized;
  let visualEvidence;
  let sseEvents = [];
  let primaryError;
  let tracingStarted = false;
  let tracingStopped = false;
  let capturesFrozen = false;
  let consoleSnapshot;
  let networkSnapshot;
  let runtimeSnapshot;
  let sseCaptureError;
  let sseObserver;
  const calls = [];
  const consoleCapture = createConsoleCapture();
  const runtimeCapture = createRuntimeCapture();
  const networkCapture = createNetworkCapture(
    input.origins,
    scenario.expectedHttpErrors,
    approvedOriginAddresses,
  );
  const recordSseEvidence = (value) => {
    try {
      const sanitized = sanitizeSseEvidence(value);
      if (!sanitized) throw new Error("SSE observer produced invalid evidence");
      if (sseEvents.length >= G11_MAX_SSE_RECORDS) throw new Error("SSE evidence exceeded its record limit");
      sseEvents.push(sanitized);
    } catch (error) {
      sseCaptureError ??= error;
      throw error;
    }
  };
  const startedAtUtc = new Date().toISOString();
  const startedAtMs = Date.now();
  try {
    browser = await withTimeout(
      "browser launch",
      browserType.launch({ headless: true, timeout: OPERATION_TIMEOUT_MS }),
      OPERATION_TIMEOUT_MS,
    );
    browser.on("disconnected", runtimeCapture.onBrowserDisconnected);
    const actualBrowserVersion = browser.version();
    if (actualBrowserVersion !== input.browserVersion) {
      throw new Error("browser version does not match the pinned collector input");
    }
    context = await withTimeout("browser context creation", browser.newContext({
      deviceScaleFactor: 1,
      viewport: { width: input.viewport.width, height: input.viewport.height },
      reducedMotion: input.motion === "reduced" ? "reduce" : "no-preference",
      serviceWorkers: "block",
    }), OPERATION_TIMEOUT_MS);
    await installContextEvidenceBoundary({ context, consoleCapture, networkCapture, runtimeCapture, origins: input.origins });
    sseObserver = await installSseEvidenceObserver(context, input.origins.web, recordSseEvidence);
    await withTimeout(
      "Playwright tracing start",
      context.tracing.start({ screenshots: true, snapshots: true, sources: false }),
      OPERATION_TIMEOUT_MS,
    );
    tracingStarted = true;
    page = await withTimeout("browser page creation", context.newPage(), OPERATION_TIMEOUT_MS);
    page.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(OPERATION_TIMEOUT_MS);

    await withTimeout(
      `${scenario.scenarioId} protected prelude`,
      runProtectedScenarioPrelude({ input, page, scenario }),
      OPERATION_TIMEOUT_MS,
    );
    for (const [index, step] of scenario.browserSteps.entries()) {
      const offsetMs = Date.now() - startedAtMs;
      const callStartedAtMs = Date.now();
      let status = "PASS";
      const assertionRecorder = createAssertionRecorder({
        callIndex: index + 1,
        page,
        specs: step.assertions,
        stepId: step.stepId,
        traceId: input.traceId,
      });
      try {
        await withTimeout(
          `${scenario.scenarioId}/${step.stepId}`,
          executeProtectedScenarioStep({
            assert: assertionRecorder.api,
            input,
            page,
            scenario,
            sseEvents,
            step,
          }),
          OPERATION_TIMEOUT_MS,
        );
        assertionRecorder.assertComplete();
      } catch (error) {
        status = "FAIL";
        primaryError ??= error;
      }
      calls.push({
        callId: `${input.traceId}-call-${index + 1}`,
        stepId: step.stepId,
        actionId: step.actionId,
        apiName: step.apiName,
        offsetMs,
        durationMs: Date.now() - callStartedAtMs,
        status,
        assertionCount: assertionRecorder.count(),
        assertions: assertionRecorder.records(),
      });
      if (status === "FAIL") break;
    }
    if (!primaryError && scenario.state !== null) {
      visualEvidence = await captureVisualEvidence({
        page,
        input,
        scenario,
        evidenceRoot: canonicalEvidenceRoot,
        outputParent: canonicalOutputParent,
      });
    }
    // Let late response/requestfailed events settle before freezing the context-wide capture.
    await page.waitForTimeout(25);
    await sseObserver?.stop();
    if (sseCaptureError) throw sseCaptureError;
    assertScenarioSseCapture(scenario, sseEvents);
    await networkCapture.drain();
    networkCapture.assertExpectedRejections();
    detachCaptureListeners({ browser, consoleCapture, networkCapture, runtimeCapture, context });
    consoleSnapshot = consoleCapture.freeze();
    networkSnapshot = await networkCapture.freeze();
    runtimeSnapshot = runtimeCapture.freeze();
    capturesFrozen = true;
    await withTimeout(
      "Playwright tracing stop",
      context.tracing.stop({ path: nativeTracePath }),
      OPERATION_TIMEOUT_MS,
    );
    tracingStopped = true;

    const nativeTraceBytes = await readFile(nativeTracePath);
    nativeTraceSha256 = createHash("sha256").update(nativeTraceBytes).digest("hex");
    const finishedAtUtc = new Date().toISOString();
    sanitized = createG11SanitizedTraceArchive({
      metadata: {
        schemaVersion: "workbench.production-g11-sanitized-playwright-trace.v1",
        traceId: input.traceId,
        nativeTraceSha256,
        browser: { name: input.browserName, version: input.browserVersion },
        viewport: input.viewport,
        motion: input.motion,
        startedAtUtc,
        finishedAtUtc,
        scenarioId: input.scenarioId,
        scenarioPlanSha256: input.scenarioPlanSha256,
        originPolicySha256: input.originPolicySha256,
        scenarioBinding: input.scenarioBinding,
        sseCapture: createSseCapture(sseEvents),
        consoleCapture: consoleSnapshot,
        runtimeCapture: runtimeSnapshot,
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
      },
      calls: {
        schemaVersion: "workbench.production-g11-sanitized-playwright-calls.v1",
        traceId: input.traceId,
        calls,
      },
      network: {
        schemaVersion: "workbench.production-g11-sanitized-playwright-network.v1",
        traceId: input.traceId,
        captureComplete: true,
        requests: networkSnapshot,
      },
    });
  } catch (error) {
    primaryError ??= error;
  } finally {
    if (sseObserver) {
      await sseObserver.stop().catch((error) => { primaryError ??= error; });
    }
    if (!capturesFrozen) {
      detachCaptureListeners({ browser, consoleCapture, networkCapture, runtimeCapture, context });
    }
    if (context && tracingStarted && !tracingStopped) {
      await withTimeout(
        "Playwright tracing cleanup",
        context.tracing.stop({ path: nativeTracePath }),
        CLEANUP_TIMEOUT_MS,
      ).catch((error) => { primaryError ??= error; });
    }
    if (context) {
      await withTimeout("browser context close", context.close(), CLEANUP_TIMEOUT_MS)
        .catch((error) => { primaryError ??= error; });
    }
    if (browser) {
      await withTimeout("browser close", browser.close(), CLEANUP_TIMEOUT_MS)
        .catch((error) => { primaryError ??= error; });
    }
    await rm(privateTraceDirectory, { recursive: true, force: true }).catch((error) => { primaryError ??= error; });
    const residualNativeTrace = await lstat(privateTraceDirectory).then(() => true).catch((error) => {
      if (error?.code === "ENOENT") return false;
      primaryError ??= error;
      return true;
    });
    if (residualNativeTrace) primaryError ??= new Error("private native trace directory deletion could not be verified");
  }

  if (primaryError) throw primaryError;
  if (!sanitized || !SHA256_PATTERN.test(nativeTraceSha256 ?? "")) {
    throw new Error("browser evidence capture did not produce a sanitized trace");
  }
  await assertDirectoryIdentity(canonicalOutputParent, outputParentIdentity, "sanitized trace output directory");
  const handle = await open(canonicalOutputPath, "wx", 0o600);
  try {
    await handle.writeFile(sanitized);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertDirectoryIdentity(canonicalOutputParent, outputParentIdentity, "sanitized trace output directory");
  return Object.freeze({
    nativeTraceSha256,
    sanitizedTraceSha256: createHash("sha256").update(sanitized).digest("hex"),
    originPolicySha256: input.originPolicySha256,
    scenarioPlanSha256: input.scenarioPlanSha256,
    startedAtUtc,
    finishedAtUtc: JSON.parse(readArchiveEntry(sanitized, "metadata.json")).finishedAtUtc,
    unexpectedConsoleErrorCount: consoleSnapshot.unexpectedErrorCount,
    unexpectedNetworkFailureCount: networkSnapshot.filter(isUnexpectedNetworkOutcome).length,
    unexpectedRuntimeFailureCount: runtimeSnapshot.unexpectedFailureCount,
    sseEvidence: summarizeSseEvidence(sseEvents),
    visualEvidence: visualEvidence ?? null,
  });
}

export function createG11SanitizedTraceArchive({ metadata, calls, network, extraEntries = [] }) {
  return createCanonicalStoredZip(new Map([
    ["metadata.json", Buffer.from(canonicalJsonFile(metadata), "utf8")],
    ["calls.json", Buffer.from(canonicalJsonFile(calls), "utf8")],
    ["network.json", Buffer.from(canonicalJsonFile(network), "utf8")],
    ...extraEntries,
  ]));
}

function createConsoleCapture() {
  const records = [];
  let captureError;
  let snapshot;
  const record = (sourceClass, message) => {
    try {
      if (snapshot) throw new Error("console capture changed after it was frozen");
      if (records.length >= 1_000) throw new Error("console capture exceeded its record limit");
      const consoleId = `console-${records.length + 1}`;
      records.push({
        consoleId,
        type: "error",
        sourceClass,
        fingerprint: createHash("sha256")
          .update(`${sourceClass}\0${String(message).slice(0, 16_384)}`)
          .digest("hex"),
        attributionCode: "unexpected-error",
      });
    } catch (error) {
      captureError ??= error;
    }
  };
  return {
    onConsole(message) {
      if (message.type() === "error") record("browser-console", message.text());
    },
    onPageError(error) {
      record("page-error", error?.message);
    },
    freeze() {
      if (captureError) throw captureError;
      snapshot ??= deepFreeze({
        complete: true,
        unexpectedErrorCount: records.length,
        records: structuredClone(records),
      });
      return snapshot;
    },
  };
}

function createRuntimeCapture() {
  let browserDisconnectCount = 0;
  let pageCrashCount = 0;
  let snapshot;
  const ensureMutable = () => {
    if (snapshot) throw new Error("runtime capture changed after it was frozen");
  };
  return {
    onBrowserDisconnected() {
      ensureMutable();
      browserDisconnectCount += 1;
    },
    onPageCrash() {
      ensureMutable();
      pageCrashCount += 1;
    },
    freeze() {
      snapshot ??= deepFreeze({
        complete: true,
        browserDisconnectCount,
        pageCrashCount,
        unexpectedFailureCount: browserDisconnectCount + pageCrashCount,
      });
      return snapshot;
    },
  };
}

async function installContextEvidenceBoundary({ context, consoleCapture, networkCapture, runtimeCapture }) {
  const attachPage = (candidate) => {
    candidate.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    candidate.setDefaultNavigationTimeout(OPERATION_TIMEOUT_MS);
    candidate.on("console", consoleCapture.onConsole);
    candidate.on("pageerror", consoleCapture.onPageError);
    candidate.on("crash", runtimeCapture.onPageCrash);
  };
  const routeHandler = async (route) => {
    if (networkCapture.isAllowedRequest(route.request())) {
      await route.continue();
      return;
    }
    networkCapture.rejectUnknownRequest();
    await route.abort("blockedbyclient");
  };
  context.on("page", attachPage);
  context.on("request", networkCapture.onRequest);
  context.on("response", networkCapture.onResponse);
  context.on("requestfailed", networkCapture.onRequestFailed);
  context.on("websocket", networkCapture.onWebSocket);
  await context.route("**/*", routeHandler);
  for (const candidate of context.pages()) attachPage(candidate);
  CONTEXT_BOUNDARIES.set(context, { attachPage, routeHandler });
}

async function installSseEvidenceObserver(context, webOrigin, record) {
  await context.exposeBinding("__workbenchRecordG11SseEvidence", (_source, value) => {
    const sanitized = sanitizeSseEvidence(value);
    if (!sanitized) return record(value);
    return record(sanitized);
  });
  await context.addInitScript(installBrowserSseEvidenceObserver, { webOrigin });
  let stopped = false;
  return Object.freeze({
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const candidate of context.pages()) {
        await candidate.evaluate(() => globalThis.__workbenchStopG11SseEvidence?.()).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });
}

function installBrowserSseEvidenceObserver({ webOrigin }) {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") {
    throw new Error("SSE evidence observer requires fetch");
  }
  const readers = new Set();
  globalThis.__workbenchStopG11SseEvidence = () => {
    for (const reader of readers) void reader.cancel().catch(() => undefined);
  };
  const reportFailure = (code) => {
    const binding = globalThis.__workbenchRecordG11SseEvidence;
    if (typeof binding !== "function") throw new Error("SSE evidence binding is unavailable");
    // This deliberately violates the strict evidence schema so the collector records a failure.
    void Promise.resolve(binding({
      afterSequence: -1,
      eventName: String(code),
      sequence: 0,
      streamPathname: "/invalid-sse-stream",
    })).catch(() => undefined);
  };
  globalThis.fetch = async function g11EvidenceFetch(...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const url = new URL(response.url);
      if (url.origin === webOrigin
        && /^\/api\/v1\/runs\/[^/]+\/events$/u.test(url.pathname)
        && response.headers.get("content-type")?.startsWith("text/event-stream")) {
        const afterSequence = Number(url.searchParams.get("afterSequence") ?? "0");
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
          reportFailure("invalid-after-sequence");
        } else {
          void observe(response.clone(), url.pathname, afterSequence)
            .catch(() => reportFailure("observer-failure"));
        }
      }
    } catch {
      reportFailure("invalid-sse-response");
    }
    return response;
  };

  async function observe(response, streamPathname, afterSequence) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is not readable");
    readers.add(reader);
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let eventId = null;
    let sawData = false;
    let recorded = 0;
    const emit = () => {
      const binding = globalThis.__workbenchRecordG11SseEvidence;
      const sequence = Number(eventId);
      const hadData = sawData;
      const shouldEmit = hadData && typeof binding === "function" && recorded < 12_000;
      const candidate = { afterSequence, eventName, sequence, streamPathname };
      eventName = "message";
      eventId = null;
      sawData = false;
      if (hadData && recorded >= 12_000) {
        reportFailure("event-capacity-exceeded");
      } else if (hadData && typeof binding !== "function") {
        throw new Error("SSE evidence binding is unavailable");
      } else if (shouldEmit) {
        recorded += 1;
        void Promise.resolve(binding(candidate)).catch(() => reportFailure("binding-rejected"));
      }
    };
    const consumeLine = (rawLine) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") return emit();
      if (line.startsWith(":")) return;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") eventName = value;
      else if (field === "id") eventId = value;
      else if (field === "data") sawData = true;
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        if (buffer.length > 1_048_576) {
          await reader.cancel();
          throw new Error("SSE evidence line buffer exceeded its limit");
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          consumeLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
        if (done) {
          if (buffer) consumeLine(buffer);
          emit();
          return;
        }
      }
    } finally {
      readers.delete(reader);
    }
  }
}

function sanitizeSseEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "afterSequence,eventName,sequence,streamPathname"
    || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0
    || !Number.isSafeInteger(value.sequence) || value.sequence <= value.afterSequence
    || !SSE_EVENT_NAMES.has(value.eventName)
    || !isCanonicalRunSsePathname(value.streamPathname)) return null;
  return Object.freeze({
    streamId: createHash("sha256").update(value.streamPathname, "utf8").digest("hex"),
    afterSequence: value.afterSequence,
    eventName: value.eventName,
    sequence: value.sequence,
  });
}

function isCanonicalRunSsePathname(value) {
  return typeof value === "string"
    && value.length <= 1_024
    && /^\/api\/v1\/runs\/[A-Za-z0-9._~!$&'()*+,;=:@%-]{1,512}\/events$/u.test(value);
}

function createSseCapture(events) {
  if (!Array.isArray(events) || events.length > G11_MAX_SSE_RECORDS
    || events.some((event) => !event || typeof event !== "object"
      || Object.keys(event).sort().join(",") !== "afterSequence,eventName,sequence,streamId"
      || !SHA256_PATTERN.test(event.streamId)
      || !Number.isSafeInteger(event.afterSequence) || event.afterSequence < 0
      || !Number.isSafeInteger(event.sequence) || event.sequence <= event.afterSequence
      || !SSE_EVENT_NAMES.has(event.eventName))) {
    throw new Error("SSE capture records do not match the protected evidence contract");
  }
  return deepFreeze({
    complete: true,
    records: events.map((event) => ({ ...event })),
  });
}

function assertScenarioSseCapture(scenario, events) {
  if (scenario.scenarioId === "refresh-reconnect"
    && !events.some(({ afterSequence }) => afterSequence > 0)) {
    throw new Error("refresh-reconnect did not capture an advanced SSE cursor");
  }
}

function summarizeSseEvidence(events) {
  const names = [...new Set(events.map(({ eventName }) => eventName))].sort();
  const sequences = events.map(({ sequence }) => sequence);
  const afterSequences = events.map(({ afterSequence }) => afterSequence);
  return deepFreeze({
    complete: true,
    eventCount: events.length,
    eventNames: names,
    minimumSequence: sequences.length > 0 ? Math.min(...sequences) : null,
    maximumSequence: sequences.length > 0 ? Math.max(...sequences) : null,
    maximumAfterSequence: afterSequences.length > 0 ? Math.max(...afterSequences) : null,
  });
}

function createNetworkCapture(origins, expectedHttpErrors, approvedOriginAddresses) {
  if (!(approvedOriginAddresses instanceof Map)) {
    throw new Error("network capture requires pinned approved origin addresses");
  }
  const records = new Map();
  const expectedCounts = new Map(expectedHttpErrors.map((rule) => [rule.ruleId, 0]));
  const pendingDrains = new Set();
  let sequence = 0;
  let captureError;
  let snapshot;
  const classifyRequest = (request) => {
    const url = new URL(request.url());
    return {
      url,
      originClass: classifyOrigin(url.origin, origins),
      pathClass: classifyPath(url.pathname),
      ...classifyRouteTemplate(url.pathname),
    };
  };
  const onRequest = (request) => {
    try {
      if (snapshot) throw new Error("network capture changed after it was frozen");
      sequence += 1;
      const {
        url,
        originClass,
        pathClass,
        routeTemplateId,
        routeBindingSha256,
      } = classifyRequest(request);
      records.set(request, {
        requestId: `request-${sequence}`,
        method: request.method(),
        origin: url.origin,
        originClass,
        pathClass,
        routeTemplateId,
        routeBindingSha256,
        resourceType: classifyResourceType(request.resourceType()),
        statusCode: 0,
        failureClass: "none",
        remoteAddress: null,
        remotePort: null,
        startedAtMs: Date.now(),
      });
    } catch (error) {
      captureError ??= error;
    }
  };
  const onResponse = (response) => {
    if (snapshot) {
      captureError ??= new Error("network response arrived after capture was frozen");
      return;
    }
    const drain = (async () => {
      const record = records.get(response.request());
      if (!record) throw new Error("network response has no auditable request record");
      record.statusCode = response.status();
      const serverAddr = await response.serverAddr();
      const remoteAddress = normalizeHostname(serverAddr?.ipAddress);
      const remotePort = serverAddr?.port;
      const allowedAddresses = approvedOriginAddresses.get(record.origin);
      if (!validPublicRemoteAddress(remoteAddress)
        || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535
        || !(allowedAddresses instanceof Set) || !allowedAddresses.has(remoteAddress)) {
        throw new Error("network response endpoint is outside the approved hostname/IP boundary");
      }
      record.remoteAddress = remoteAddress;
      record.remotePort = remotePort;
    })().catch((error) => {
      captureError ??= error;
    }).finally(() => pendingDrains.delete(drain));
    pendingDrains.add(drain);
  };
  const onRequestFailed = (request) => {
    if (snapshot) {
      captureError ??= new Error("network failure arrived after capture was frozen");
      return;
    }
    const record = records.get(request);
    if (record) record.failureClass = classifyFailure(request.failure()?.errorText);
    captureError ??= new Error("browser request failed before its public remote endpoint could be captured");
  };
  const sanitizedRecords = (finishedAtMs) => [...records.values()].map((record) => {
    const outcome = classifyNetworkOutcome(record, expectedHttpErrors);
    return {
      requestId: record.requestId,
      method: record.method,
      originClass: record.originClass,
      pathClass: record.pathClass,
      routeTemplateId: record.routeTemplateId,
      routeBindingSha256: record.routeBindingSha256,
      resourceType: record.resourceType,
      statusCode: record.statusCode,
      failureClass: record.failureClass,
      outcomeClass: outcome.outcomeClass,
      expectationRuleId: outcome.expectationRuleId,
      attributionCode: outcome.attributionCode,
      durationMs: Math.max(0, finishedAtMs - record.startedAtMs),
      origin: record.origin,
      remoteAddress: record.remoteAddress,
      remotePort: record.remotePort,
    };
  });
  const observedExpectedCounts = () => {
    const counts = new Map(expectedCounts);
    for (const record of records.values()) {
      const outcome = classifyNetworkOutcome(record, expectedHttpErrors);
      if (outcome.expectationRuleId !== "none") {
        counts.set(outcome.expectationRuleId, (counts.get(outcome.expectationRuleId) ?? 0) + 1);
      }
    }
    return counts;
  };
  return {
    onRequest,
    onResponse,
    onRequestFailed,
    onWebSocket(webSocket) {
      try {
        const url = new URL(webSocket.url());
        const httpsOrigin = url.protocol === "wss:" ? `https://${url.host}` : null;
        if (httpsOrigin === null || !approvedOriginAddresses.has(httpsOrigin)) {
          throw new Error("browser opened a WebSocket outside the approved origin boundary");
        }
        throw new Error("browser opened a WebSocket without auditable serverAddr evidence");
      } catch (error) {
        captureError ??= error;
      }
    },
    isAllowedRequest(request) {
      try {
        const { url } = classifyRequest(request);
        return url.protocol === "https:" && approvedOriginAddresses.has(url.origin);
      } catch {
        return false;
      }
    },
    rejectUnknownRequest() {
      captureError ??= new Error("browser requested an unapproved origin");
    },
    async drain() {
      await Promise.all([...pendingDrains]);
      if (captureError) throw captureError;
    },
    assertExpectedRejections() {
      for (const [, count] of observedExpectedCounts()) {
        if (count !== 1) throw new Error("expected protected HTTP rejection count was not exactly one");
      }
    },
    observed() {
      return observedExpectedCounts();
    },
    async freeze() {
      await this.drain();
      if (captureError) throw captureError;
      for (const record of records.values()) {
        if (record.failureClass !== "none" || !validPublicRemoteAddress(record.remoteAddress)
          || !Number.isInteger(record.remotePort) || record.remotePort < 1 || record.remotePort > 65_535) {
          throw new Error("network capture is incomplete for an observed request");
        }
      }
      const result = sanitizedRecords(Date.now());
      if (result.length < 1) throw new Error("browser trace captured no network requests");
      snapshot = deepFreeze(result);
      return snapshot;
    },
  };
}

function isUnexpectedNetworkOutcome({ outcomeClass }) {
  return outcomeClass === "transport-failure"
    || outcomeClass === "unexpected-http-error"
    || outcomeClass === "unexpected-unknown";
}

function classifyNetworkOutcome(record, expectedHttpErrors) {
  if (record.failureClass !== "none") {
    return { outcomeClass: "transport-failure", expectationRuleId: "none", attributionCode: "transport-failure" };
  }
  if (record.pathClass === "other" || record.resourceType === "other" || record.statusCode < 100) {
    return { outcomeClass: "unexpected-unknown", expectationRuleId: "none", attributionCode: "unknown-classification" };
  }
  if (record.statusCode >= 500) {
    return { outcomeClass: "unexpected-http-error", expectationRuleId: "none", attributionCode: "unexpected-http-status" };
  }
  if (record.statusCode >= 400) {
    const expectation = expectedHttpErrors.find((candidate) => (
      candidate.method === record.method
      && candidate.originClass === record.originClass
      && candidate.pathClass === record.pathClass
      && candidate.routeTemplateId === record.routeTemplateId
      && candidate.routeBindingSha256 === record.routeBindingSha256
      && (candidate.statusCode === record.statusCode || candidate.statusCodes?.includes(record.statusCode))
    ));
    return expectation
      ? {
        outcomeClass: "expected-http-error",
        expectationRuleId: expectation.ruleId,
        attributionCode: "expected-client-rejection",
      }
      : { outcomeClass: "unexpected-http-error", expectationRuleId: "none", attributionCode: "unexpected-http-status" };
  }
  return {
    outcomeClass: "expected-success",
    expectationRuleId: "none",
    attributionCode: record.originClass === "approved-third-party" ? "approved-third-party" : "first-party",
  };
}

function createAssertionRecorder({ callIndex, page, specs, stepId, traceId }) {
  if (!Array.isArray(specs) || specs.length < 1 || specs.some((spec) => (
    !spec || typeof spec !== "object" || Array.isArray(spec)
    || !IDENTIFIER_PATTERN.test(spec.assertionSpecId)
    || typeof spec.kind !== "string"
  ))) {
    throw new Error("protected assertion specifications are invalid");
  }
  const assertions = [];
  const record = async (assertionSpecId, kind, evaluate) => {
    const expected = specs[assertions.length];
    if (!expected || expected.assertionSpecId !== assertionSpecId || expected.kind !== kind) {
      throw new Error("browser assertion does not match the protected assertion sequence");
    }
    let passed = false;
    try {
      passed = await evaluate();
    } finally {
      assertions.push({
        assertionId: `${traceId}-call-${callIndex}-assertion-${assertions.length + 1}`,
        stepId,
        assertionSpecId,
        kind,
        status: passed === true ? "PASS" : "FAIL",
      });
    }
    if (passed !== true) throw new Error(`browser assertion failed for ${stepId}`);
  };
  const locator = (target) => resolveProtectedLocator(page, target);
  return {
    api: Object.freeze({
      documentReady: (assertionSpecId) => record(assertionSpecId, "document-ready", () => page.evaluate(() => document.readyState === "complete")),
      visible: (assertionSpecId, selector) => record(assertionSpecId, "visible", () => locator(selector).isVisible()),
      hidden: (assertionSpecId, selector) => record(assertionSpecId, "hidden", () => locator(selector).isHidden()),
      attribute: (assertionSpecId, selector, name, expected) => record(assertionSpecId, "attribute", async () => {
        if (!/^(?:data-[a-z0-9-]+|credentialless|referrerpolicy|sandbox)$/u.test(name)
          || typeof expected !== "string" || expected.length > 256) {
          throw new Error("attribute assertion contract is invalid");
        }
        return await locator(selector).getAttribute(name) === expected;
      }),
      count: (assertionSpecId, selector, expected) => record(assertionSpecId, "count", async () => (
        Number.isInteger(expected) && expected >= 0 && expected <= 10_000
        && await locator(selector).count() === expected
      )),
      condition: (assertionSpecId, evaluate) => record(assertionSpecId, "condition", async () => {
        if (typeof evaluate !== "function") throw new Error("protected condition must be a function");
        return (await evaluate()) === true;
      }),
      integerAttributeAtLeast: (assertionSpecId, selector, name, minimum) => record(assertionSpecId, "integer-attribute-at-least", async () => {
        if (!/^data-[a-z0-9-]+$/u.test(name) || !Number.isSafeInteger(minimum) || minimum < 0) {
          throw new Error("integer attribute assertion contract is invalid");
        }
        const value = await locator(selector).getAttribute(name);
        return /^(?:0|[1-9][0-9]*)$/u.test(value ?? "") && Number(value) >= minimum;
      }),
      urlOrigin: (assertionSpecId, expectedOrigin, expectedPathname = null) => record(assertionSpecId, "url-origin", () => {
        const current = new URL(page.url());
        return current.origin === expectedOrigin
          && (expectedPathname === null || current.pathname === expectedPathname);
      }),
    }),
    assertComplete() {
      if (assertions.length !== specs.length || assertions.some(({ status }) => status !== "PASS")) {
        throw new Error("protected browser action did not complete its assertion contract");
      }
    },
    count: () => assertions.filter(({ status }) => status === "PASS").length,
    records: () => structuredClone(assertions),
  };
}

function resolveProtectedLocator(page, target) {
  if (typeof target === "string") {
    if (!SAFE_SELECTOR_PATTERN.test(target)
      && !/^#[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(target)
      && !/^textarea\[aria-label="[^"]{1,128}"\]$/u.test(target)
      && !/^input\[placeholder="[^"]{1,256}"\]$/u.test(target)) {
      throw new Error("protected browser assertions require a fixed selector");
    }
    return page.locator(target);
  }
  if (!target || typeof target !== "object" || Array.isArray(target)
    || Object.keys(target).some((key) => !["role", "name", "exact", "label"].includes(key))) {
    throw new Error("protected browser assertion locator is invalid");
  }
  if (typeof target.label === "string" && target.label.length <= 128) return page.getByLabel(target.label);
  if (typeof target.role === "string" && /^[A-Za-z][A-Za-z0-9 -]{0,64}$/u.test(target.role)
    && ((typeof target.name === "string" && target.name.length <= 256)
      || (target.name instanceof RegExp && target.name.source.length <= 128))) {
    return page.getByRole(target.role, { name: target.name, exact: target.exact === true });
  }
  throw new Error("protected browser assertion locator is invalid");
}

function classifyOrigin(origin, origins) {
  if (origin === origins.web) return "web";
  if (origin === origins.preview) return "preview";
  if (origins.approvedThirdParty.includes(origin)) return "approved-third-party";
  throw new Error("browser requested an unapproved origin");
}

function classifyPath(pathname) {
  if (/\/api\/auth(?:\/|$)/u.test(pathname)
    || /\/(?:sign-in|sign-out|session|invitations?|project-invitations)(?:\/|$)/u.test(pathname)) return "auth";
  if (/\/events(?:\/|$)/u.test(pathname)) return "sse";
  if (/\/(?:artifacts?|exports?)(?:\/|$)/u.test(pathname)) return "artifact";
  if (/\/preview(?:\/|$)/u.test(pathname)) return "preview-rpc";
  if (/\/api(?:\/|$)/u.test(pathname)) return "api";
  if (/\.(?:css|js|png|jpe?g|webp|woff2?|ico)$/u.test(pathname)) return "asset";
  if (pathname === "/" || !path.extname(pathname)) return "document";
  return "other";
}

function classifyRouteTemplate(pathname) {
  const known = [
    [/^\/api\/v1\/projects\/([^/]+)\/bootstrap$/u, "projects.bootstrap", "projectId"],
    [/^\/api\/v1\/project-invitations\/accept$/u, "project-invitations.accept", null],
    [/^\/api\/v1\/threads\/([^/]+)\/submission-intents$/u, "threads.submission-intents", "threadId"],
  ];
  for (const [pattern, routeTemplateId, parameterName] of known) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    let parameterValue = null;
    if (parameterName) {
      try {
        parameterValue = decodeURIComponent(match[1]);
      } catch {
        return unclassifiedRouteBinding(pathname);
      }
      if (!parameterValue || parameterValue.includes("/")) return unclassifiedRouteBinding(pathname);
    }
    return {
      routeTemplateId,
      routeBindingSha256: productionG11RouteBindingSha256(
        routeTemplateId,
        parameterName ? { [parameterName]: parameterValue } : {},
      ),
    };
  }
  return unclassifiedRouteBinding(pathname);
}

function unclassifiedRouteBinding(pathname) {
  return {
    routeTemplateId: "unclassified",
    routeBindingSha256: createHash("sha256").update(String(pathname), "utf8").digest("hex"),
  };
}

function classifyResourceType(value) {
  return [
    "document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "eventsource", "websocket",
  ].includes(value) ? value : "other";
}

function classifyFailure(errorText = "") {
  if (/dns|name_not_resolved/iu.test(errorText)) return "dns";
  if (/ssl|tls|certificate/iu.test(errorText)) return "tls";
  if (/timed?_?out/iu.test(errorText)) return "timeout";
  if (/abort|cancel/iu.test(errorText)) return "aborted";
  if (/connection|refused|reset|closed/iu.test(errorText)) return "connection";
  return "other";
}

function validateCollectionInput(input) {
  const allowedKeys = new Set([
    "browserName", "browserVersion", "evidenceRoot", "motion", "origins", "outputPath", "scenarioBinding",
    "scenarioId", "scenarioSecrets", "temporaryDirectory", "traceId", "viewport",
  ]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) throw new Error("collection input contains an unsupported field");
  if (!BROWSERS.has(input.browserName)) throw new Error("browserName is invalid");
  if (typeof input.browserVersion !== "string"
    || input.browserVersion.length < 1 || input.browserVersion.length > 256) {
    throw new Error("browserVersion is invalid");
  }
  if (!MOTIONS.has(input.motion)) throw new Error("motion is invalid");
  if (!IDENTIFIER_PATTERN.test(input.traceId ?? "")) throw new Error("traceId is invalid");
  if (!validViewport(input.viewport)) throw new Error("viewport is invalid");
  const scenarioId = productionG11ScenarioId(input);
  if (scenarioId !== input.scenarioId) {
    throw new Error("scenarioId does not match the deterministic trace identity");
  }
  let scenarioPlan;
  try {
    scenarioPlan = productionG11ScenarioPlan({
      scenarioId: input.scenarioId,
      scenarioBinding: input.scenarioBinding,
    });
  } catch {
    throw new Error("scenarioBinding does not match the protected scenario contract");
  }
  validateScenarioSecrets(input.scenarioSecrets, input.scenarioId);
  validateOrigins(input.origins);
  for (const [name, value] of [
    ["evidenceRoot", input.evidenceRoot],
    ["outputPath", input.outputPath],
    ["temporaryDirectory", input.temporaryDirectory],
  ]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  if (!Array.isArray(scenarioPlan.browserSteps)
    || scenarioPlan.browserSteps.length < 1 || scenarioPlan.browserSteps.length > MAX_STEPS
    || scenarioPlan.browserSteps.some((step) => !IDENTIFIER_PATTERN.test(step.stepId)
      || !IDENTIFIER_PATTERN.test(step.actionId)
      || !API_NAMES.has(step.apiName)
      || !Array.isArray(step.assertions) || step.assertions.length < 1)) {
    throw new Error("protected scenario registry is invalid");
  }
  const originPolicySha256 = productionG11OriginPolicySha256({
    webOrigin: input.origins.web,
    previewOrigin: input.origins.preview,
    approvedThirdPartyOrigins: input.origins.approvedThirdParty,
  });
  const scenarioPlanSha256 = productionG11ScenarioPlanSha256({
    scenarioId: input.scenarioId,
    scenarioBinding: input.scenarioBinding,
  });
  return deepFreeze({
    ...structuredClone(input),
    scenarioPlan,
    scenarioBinding: { ...input.scenarioBinding },
    scenarioSecrets: { ...input.scenarioSecrets },
    originPolicySha256,
    scenarioPlanSha256,
  });
}

function validateOrigins(origins) {
  if (!origins || Object.keys(origins).sort().join(",") !== ORIGIN_KEYS.join(",")
    || origins.schemaVersion !== "workbench.production-g11-origin-policy.v1"
    || !Array.isArray(origins.approvedThirdParty) || origins.approvedThirdParty.length > 64) {
    throw new Error("origins must use the strict protected shape");
  }
  const entries = [origins?.web, origins?.preview, ...(origins?.approvedThirdParty ?? [])];
  if (entries.length < 2 || entries.some((value) => !isCanonicalPublicOrigin(value))) {
    throw new Error("origins must be canonical public HTTPS origins");
  }
  if (new Set(entries).size !== entries.length) throw new Error("origins must be unique");
  const normalizedHosts = entries.map((value) => normalizeHostname(new URL(value).hostname));
  if (new Set(normalizedHosts).size !== normalizedHosts.length) throw new Error("origins must use distinct host identities");
}

function validViewport(viewport) {
  const expected = VIEWPORTS.get(viewport?.id);
  return Boolean(expected)
    && viewport.width === expected.width
    && viewport.height === expected.height
    && Object.keys(viewport).sort().join(",") === "height,id,width";
}

function validateScenarioSecrets(value, scenarioId) {
  const accountScenario = scenarioId === "account-project";
  const expectedKeys = accountScenario
    ? "account,expiredInvitationToken,invitationToken,password"
    : "account,password";
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== expectedKeys
    || typeof value.account !== "string" || value.account.length < 1 || value.account.length > 320
    || typeof value.password !== "string" || value.password.length < 12 || value.password.length > 1024
    || (accountScenario && (!validInvitationToken(value.invitationToken)
      || !validInvitationToken(value.expiredInvitationToken)))) {
    throw new Error("scenarioSecrets do not match the protected scenario secret contract");
  }
}

function validInvitationToken(value) {
  return typeof value === "string"
    && value.length >= 96
    && value.length <= 256
    && /^wbi_[A-Za-z0-9_-]{48,128}\.[A-Za-z0-9_-]{43}$/u.test(value);
}

function isCanonicalPublicOrigin(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || url.port === "443"
      || url.hostname.endsWith(".")) return false;
    const hostname = normalizeHostname(url.hostname);
    if (!hostname || hostname.includes("%") || FORBIDDEN_HOST_MARKER.test(hostname)) return false;
    if (isIP(hostname)) return isGlobalIp(hostname);
    if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const FORBIDDEN_HOST_MARKER = /(?:^|[-.])(?:controlled|fixture|fake|mock|synthetic|localhost|loopback)(?:[-.]|$)/iu;

function normalizeHostname(hostname) {
  const normalized = String(hostname ?? "").replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (isIP(normalized) !== 6) return normalized;
  try {
    return new URL(`https://[${normalized}]/`).hostname.replace(/^\[|\]$/gu, "");
  } catch {
    return normalized;
  }
}

function isGlobalIp(address) {
  address = normalizeHostname(address);
  const version = isIP(address);
  if (version === 4) {
    const ipv4Number = (candidate) => candidate.split(".").map(Number)
      .reduce((result, octet) => (result * 256) + octet, 0) >>> 0;
    const value = ipv4Number(address);
    return ![
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([network, prefix]) => (
      (value >>> (32 - prefix)) === (ipv4Number(network) >>> (32 - prefix))
    ));
  }
  if (version !== 6 || address.includes("%")) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    const parts = mapped.includes(".") ? mapped.split(".").map(Number) : null;
    if (parts?.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return isGlobalIp(parts.join("."));
    }
    return false;
  }
  // Global unicast IPv6 is 2000::/3; special-purpose allocations are excluded below.
  const firstHextet = Number.parseInt(normalized.split(":").find(Boolean) ?? "0", 16);
  if (!Number.isInteger(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return false;
  const blocks = new BlockList();
  for (const [network, prefix] of [
    ["2001:db8::", 32], ["2001::", 23], ["2002::", 16], ["3fff::", 20], ["64:ff9b::", 96],
  ]) blocks.addSubnet(network, prefix, "ipv6");
  return !blocks.check(normalized, "ipv6");
}

async function validateOriginReachability(origins) {
  const addressesByOrigin = new Map();
  for (const origin of [origins.web, origins.preview, ...origins.approvedThirdParty]) {
    const hostname = normalizeHostname(new URL(origin).hostname);
    if (isIP(hostname)) {
      if (!isGlobalIp(hostname)) throw new Error("protected origin IP is not globally routable");
      addressesByOrigin.set(origin, new Set([hostname]));
      continue;
    }
    let addresses;
    try {
      addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("protected origin DNS resolution failed");
    }
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.some(({ address }) => !isGlobalIp(address))) {
      throw new Error("protected origin DNS resolution was not globally routable");
    }
    addressesByOrigin.set(origin, new Set(addresses.map(({ address }) => normalizeHostname(address))));
  }
  return addressesByOrigin;
}

function validPublicRemoteAddress(address) {
  const normalized = normalizeHostname(address);
  return typeof address === "string" && isIP(normalized) > 0 && isGlobalIp(normalized);
}

async function runProtectedScenarioPrelude({ input, page, scenario }) {
  await page.goto(`${input.origins.web}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("用户名或邮箱").fill(input.scenarioSecrets.account);
  await page.getByLabel("密码").fill(input.scenarioSecrets.password);
  await page.getByRole("button", { name: /^登录/u }).click();
  await page.waitForURL((url) => url.origin === input.origins.web && url.pathname !== "/login");
  if (scenario.flowId === "account-project") {
    await page.goto(
      `${input.origins.web}/invitations/accept#token=${encodeURIComponent(input.scenarioSecrets.invitationToken)}`,
      { waitUntil: "domcontentloaded" },
    );
    return;
  }
  await openBoundProject(page, input);
}

async function executeProtectedScenarioStep({ assert, input, page, scenario, sseEvents, step }) {
  await executeProtectedAction({ assert, input, page, scenario, sseEvents, step });
}

const PAGE_SCENARIO_STATE = new WeakMap();

function pageScenarioState(page) {
  let state = PAGE_SCENARIO_STATE.get(page);
  if (!state) {
    state = {
      exportPrepared: false,
      mixedBaselineRunCount: null,
      mixedBaselineSseCount: null,
      mixedProblemStatus: null,
      prdSubmitted: false,
      prototypeStarted: false,
      reconnectCursors: new Map(),
      reconnectEvidenceOffset: 0,
      reconnectStreamId: null,
    };
    PAGE_SCENARIO_STATE.set(page, state);
  }
  return state;
}

async function executeProtectedAction({ assert, input, page, scenario, sseEvents, step }) {
  const state = pageScenarioState(page);
  switch (step.actionId) {
    case "verify-session":
      await assert.condition("session-authenticated", async () => {
        const result = await browserJson(page, "/api/auth/get-session");
        return result.status === 200 && Boolean(result.body?.user?.id);
      });
      return;
    case "accept-invitation":
      await page.getByRole("button", { name: "接受邀请", exact: true }).click();
      await assert.visible("invitation-accepted-status", { role: "status", name: /邀请已接受/u });
      await page.getByRole("button", { name: /进入项目/u }).click();
      await page.waitForURL((url) => (
        url.origin === input.origins.web
        && url.pathname === `/projects/${input.scenarioBinding.projectId}`
      ));
      await assert.urlOrigin(
        "invitation-project-bound",
        input.origins.web,
        `/projects/${input.scenarioBinding.projectId}`,
      );
      return;
    case "open-workspace":
      await page.goto(input.origins.web, { waitUntil: "domcontentloaded" });
      await assert.visible("workspace-visible", "[data-home-composer]");
      return;
    case "open-project":
      await openBoundProject(page, input);
      await assert.documentReady("project-document-ready");
      await assert.visible("project-shell-visible", "[data-project-composer]");
      return;
    case "verify-membership":
      await assert.condition("membership-role-response", async () => {
        const result = await boundProjectBootstrap(page, input);
        return result.status === 200
          && result.body?.project?.id === input.scenarioBinding.projectId
          && result.body?.selectedThreadId === input.scenarioBinding.threadId
          && ["owner", "editor"].includes(result.body?.access?.role);
      });
      return;
    case "verify-revoked-access":
      await assert.condition("revoked-project-response", async () => {
        const result = await browserJson(
          page,
          `/api/v1/projects/${encodeURIComponent(input.scenarioBinding.deniedProjectId)}/bootstrap`,
        );
        return [403, 404].includes(result.status);
      });
      return;
    case "verify-expired-invitation":
      await assert.condition("expired-invitation-response", async () => {
        const result = await browserJson(page, "/api/v1/project-invitations/accept", {
          method: "POST",
          body: { ["token"]: input.scenarioSecrets.expiredInvitationToken },
        });
        return [409, 410].includes(result.status);
      });
      return;
    case "verify-unauthenticated-access":
      await assert.condition("unauthenticated-project-response", async () => {
        const result = await browserJson(
          page,
          `/api/v1/projects/${encodeURIComponent(input.scenarioBinding.projectId)}/bootstrap`,
          { credentials: "omit" },
        );
        return result.status === 401;
      });
      return;
    case "submit-prd":
      if (!state.prdSubmitted) {
        await installStageEvidenceObserver(page);
        await submitPrompt(page, "Generate the protected synthetic product requirements document.");
        state.prdSubmitted = true;
      }
      if (step.stepId === "reach-prd-pending") {
        await assert.visible("visual-prd-pending-visible", '[data-workbench-artifact-state="pending"]');
        await assert.visible("visual-prd-skeleton-visible", "[data-workbench-artifact-skeleton]");
      } else if (step.stepId === "reach-prd-active") {
        await assert.visible("visual-prd-motion-visible", '[data-canvas-generation-motion="prd"]');
        await assert.visible("visual-prd-panel-visible", responsiveRunPanelSelector(input.viewport.width));
      } else {
        await assert.visible("prd-agent-panel-visible", responsiveRunPanelSelector(input.viewport.width));
        await assert.visible("prd-motion-visible", '[data-canvas-generation-motion="prd"]');
      }
      return;
    case "observe-prd-loading":
      await assert.visible("prd-pending-visible", '[data-workbench-artifact-state="pending"]');
      await assert.visible("prd-skeleton-visible", "[data-workbench-artifact-skeleton]");
      return;
    case "observe-prd-context":
      await assert.visible("prd-prompt-context-visible", responsivePromptSelector(input.viewport.width));
      await assert.visible("prd-activity-context-visible", responsiveRunPanelSelector(input.viewport.width));
      return;
    case "observe-prd-sequence": {
      const expected = [
        "collecting-prd-context", "structuring-prd", "drafting-prd", "validating-prd",
      ];
      for (const stage of expected) {
        await page.locator(`[data-generation-stage="${stage}"]`).first().waitFor({ state: "attached" });
      }
      await assert.condition("prd-stage-sequence-continuous", async () => orderedSubsequence(
        await stageEvidence(page),
        expected,
      ));
      return;
    }
    case "observe-prd-ready":
      await waitForTerminalRunPanel(page, input.viewport.width, "succeeded");
      await assert.visible("prd-run-complete", responsiveRunPanelSelector(input.viewport.width));
      await assert.condition("prd-artifact-version-visible", () => visibleArtifactIdentity(page).then(Boolean));
      return;
    case "verify-artifact-checksum":
      await assert.condition("prd-artifact-checksum-valid", () => verifyVisibleArtifact(page));
      return;
    case "submit-mixed-composer":
      state.mixedBaselineRunCount = await browserRunCount(page, input.scenarioBinding.threadId);
      state.mixedBaselineSseCount = sseEvents.length;
      await submitPrompt(page, PROTECTED_MIXED_COMPOSER_PROMPT);
      await assert.condition("mixed-composer-localized-error-visible", () => waitForCondition(
        () => page.getByText(PROTECTED_MIXED_REJECTION_MESSAGE, { exact: true }).first().isVisible(),
      ));
      return;
    case "verify-mixed-composer-prompt":
      await assert.condition("mixed-composer-prompt-preserved", async () => (
        await (await visibleComposerInput(page)).inputValue() === PROTECTED_MIXED_COMPOSER_PROMPT
      ));
      return;
    case "verify-mixed-composer-inactive":
      await assert.count(
        "mixed-composer-active-ui-absent",
        '[data-phase="generating"], [data-workbench-artifact-state="pending"], [data-canvas-generation-motion]',
        0,
      );
      return;
    case "submit-mixed-direct-api": {
      const result = await browserJson(
        page,
        `/api/v1/threads/${encodeURIComponent(input.scenarioBinding.threadId)}/submission-intents`,
        {
          method: "POST",
          headers: { "idempotency-key": `g11-mixed:${input.traceId}` },
          body: protectedMixedSubmissionIntent(),
        },
      );
      state.mixedProblemStatus = result.status;
      await assert.condition("mixed-problem-status-400", () => state.mixedProblemStatus === 400);
      return;
    }
    case "verify-mixed-run-count":
      await assert.condition("mixed-run-count-unchanged", async () => (
        Number.isInteger(state.mixedBaselineRunCount)
        && await browserRunCount(page, input.scenarioBinding.threadId) === state.mixedBaselineRunCount
      ));
      return;
    case "verify-mixed-sse-count":
      await assert.condition("mixed-sse-count-unchanged", () => (
        Number.isInteger(state.mixedBaselineSseCount) && sseEvents.length === state.mixedBaselineSseCount
      ));
      return;
    case "start-prototype":
      if (!state.prototypeStarted) {
        await installStageEvidenceObserver(page, { reset: true });
        await (await firstVisibleLocator(page, [{ role: "button", name: /基于此 PRD 生成 UI/u }])).click();
        state.prototypeStarted = true;
      }
      if (step.stepId === "reach-prototype-after-prd") {
        await assert.visible("visual-prototype-motion-visible", '[data-canvas-generation-motion="prototype"]');
        await assert.count("visual-prototype-prd-motion-absent", '[data-canvas-generation-motion="prd"]', 0);
      } else {
        await assert.condition("prototype-start-accepted", () => page.locator('[data-phase="generating"]').count().then((count) => count > 0));
      }
      return;
    case "observe-prototype-null-gap":
      await assert.count("prototype-null-gap-prd-absent", '[data-canvas-generation-motion="prd"]', 0);
      return;
    case "observe-prototype-thinking-gap":
      await page.locator('[data-generation-stage="thinking"]').first().waitFor({ state: "attached" });
      await assert.count("prototype-thinking-gap-prd-absent", '[data-canvas-generation-motion="prd"]', 0);
      return;
    case "observe-prototype-motion":
      await assert.visible("prototype-motion-visible", '[data-canvas-generation-motion="prototype"]');
      return;
    case "reload-reconnect":
      state.reconnectEvidenceOffset = sseEvents.length;
      state.reconnectCursors = maximumSseSequenceByStream(sseEvents);
      await page.reload({ waitUntil: "domcontentloaded" });
      await assert.condition("reconnect-cursor-advanced", async () => waitForCondition(() => {
        const resumed = sseEvents.slice(state.reconnectEvidenceOffset).find((event) => {
          const previousMaximum = state.reconnectCursors.get(event.streamId);
          return Number.isSafeInteger(previousMaximum) && previousMaximum > 0
            && event.afterSequence >= previousMaximum
            && event.afterSequence > 0
            && event.sequence > event.afterSequence;
        });
        state.reconnectStreamId = resumed?.streamId ?? null;
        return resumed !== undefined;
      }));
      return;
    case "verify-reconnect-sequence":
      await assert.condition("reconnect-sequence-continuous", () => contiguousSseSequences(
        sseEvents.slice(state.reconnectEvidenceOffset).filter((event) => (
          event.streamId === state.reconnectStreamId && event.afterSequence > 0
        )),
      ));
      return;
    case "verify-restored-state":
      await assert.visible("restored-agent-panel-visible", responsiveRunPanelSelector(input.viewport.width));
      await assert.condition("restored-artifact-visible", () => visibleArtifactIdentity(page).then(Boolean));
      return;
    case "import-file":
      await importProtectedFile(page, input.traceId);
      await assert.condition("file-import-ready", () => page.getByText("g11-protected-source.txt", { exact: true }).isVisible());
      return;
    case "import-knowledge":
      await selectFirstReadyImportSource(page);
      await assert.condition("knowledge-import-ready", () => page.getByRole("button", { name: /^取消选择来源 /u }).count().then((count) => count === 1));
      return;
    case "prepare-export":
      await prepareProtectedExport(page, state);
      await assert.condition("export-ready", () => page.locator("[data-external-delivery-confirmation]").isVisible());
      return;
    case "open-preview":
      await ensurePreview(page);
      if (step.stepId === "previewLoaded") {
        await assert.visible("preview-frame-visible", "iframe[data-preview-capability]");
      } else {
        await assert.condition("preview-origin-independent", () => previewOriginIs(page, input.origins.preview));
      }
      return;
    case "confirm-publication":
      await confirmProtectedPublication(page);
      await assert.condition("publication-confirmed", () => exportSucceeded(page));
      return;
    case "verify-export-recovery":
      await assert.condition("export-failure-recovered", () => exportSucceeded(page));
      return;
    case "complete-run":
      await submitPrompt(page, "Complete the protected synthetic browser acceptance operation.");
      await waitForTerminalRunPanel(page, input.viewport.width, "succeeded");
      await assert.visible("run-complete", responsiveRunPanelSelector(input.viewport.width));
      return;
    case "approve-run":
      await submitPrompt(page, "Perform the protected operation that requires explicit user approval.");
      await page.getByRole("heading", { name: "需要您的确认" }).waitFor({ state: "visible" });
      await (await firstVisibleLocator(page, [
        { role: "button", name: "批准", exact: true },
        { role: "button", name: "确认选择", exact: true },
      ])).click();
      await assert.condition("approval-complete", async () => {
        await page.getByRole("heading", { name: "需要您的确认" }).waitFor({ state: "hidden" });
        return true;
      });
      return;
    case "observe-failed-run":
      await assert.condition("run-failure-observed", () => browserHasRunStatus(page, input.scenarioBinding.threadId, "failed"));
      return;
    case "cancel-run":
      await submitPrompt(page, "Run the protected long synthetic cancellation operation.");
      await page.locator('[data-phase="generating"]').first().waitFor({ state: "visible" });
      await (await firstVisibleLocator(page, [
        { role: "button", name: "取消当前任务", exact: true },
        { role: "button", name: "取消当前运行", exact: true },
      ])).click();
      await waitForTerminalRunPanel(page, input.viewport.width, "cancelled");
      await assert.visible("run-cancelled", responsiveRunPanelSelector(input.viewport.width));
      return;
    case "retry-run":
      await (await firstVisibleLocator(page, [{ role: "button", name: "重试当前运行", exact: true }])).click();
      await waitForTerminalRunPanel(page, input.viewport.width, "succeeded");
      await assert.visible("run-retry-complete", responsiveRunPanelSelector(input.viewport.width));
      return;
    case "verify-canvas-gateway":
      await assert.condition("canvas-updated", () => page.locator("[data-canvas-board-node-id]").count().then((count) => count > 0));
      return;
    case "verify-prototype-patch":
      await assert.condition("prototype-patch-stable-ids", verifyStablePrototypeNodeIds(page));
      return;
    case "verify-sse-durable":
      await assert.condition("sse-durable-events", () => sseEvents.length > 0 && maximumSseSequence(sseEvents) > 0);
      return;
    case "verify-sse-sequence":
      await assert.condition("sse-sequence-continuous", () => contiguousSseSequences(sseEvents));
      return;
    case "verify-keyboard":
      await page.keyboard.press("Tab");
      await assert.condition("keyboard-navigation", () => hasVisibleFocusedElement(page));
      return;
    case "verify-focus":
      await assert.condition("focus-visible", () => focusedElementHasIndicator(page));
      return;
    case "verify-accessible-names":
      await assert.condition("accessible-names", () => visibleControlsHaveNames(page));
      return;
    case "verify-contrast":
      await assert.condition("contrast-threshold", () => visibleTextMeetsContrast(page));
      return;
    case "verify-reduced-motion":
      await assert.condition("reduced-motion-contract", () => reducedMotionContractMatches(page, input.motion));
      return;
    case "verify-preview-credentialless":
      await assert.attribute("preview-credentialless", "iframe[data-preview-capability]", "credentialless", "");
      return;
    case "verify-preview-sandbox":
      await assert.condition("preview-allow-same-origin-absent", () => previewSandboxIsOpaque(page));
      return;
    case "verify-preview-referrer":
      await assert.attribute("preview-no-referrer", "iframe[data-preview-capability]", "referrerpolicy", "no-referrer");
      return;
    case "verify-preview-capability":
      await assert.condition("preview-capability-validated", () => previewOriginIs(page, input.origins.preview));
      return;
    case "verify-preview-rpc":
      await assert.condition("preview-rpc-passed", () => previewReady(page));
      return;
    case "verify-preview-timeout":
      await assert.condition("preview-timeout-protected", () => previewTimeoutContractMatches(page));
      return;
    case "verify-preview-generation":
      await assert.condition("preview-generation-protected", () => refreshPreviewGeneration(page));
      return;
    case "observe-long-run-boundary":
      await consumeBoundRunSse(page, input.scenarioBinding.runId);
      await assert.condition("long-run-boundary-crossed", () => waitForCondition(() => sseEvents.length >= 7_686));
      return;
    case "observe-long-run-terminal":
      await assert.condition("long-run-terminal-correct", async () => {
        const result = await browserJson(page, `/api/v1/runs/${encodeURIComponent(input.scenarioBinding.runId)}`);
        return result.status === 200 && ["succeeded", "failed", "cancelled"].includes(result.body?.status);
      });
      return;
    case "retry-long-run":
      await (await firstVisibleLocator(page, [{ role: "button", name: "重试当前运行", exact: true }])).click();
      await waitForTerminalRunPanel(page, input.viewport.width, "succeeded");
      await assert.condition("long-run-retry-recovered", () => browserHasRunStatus(page, input.scenarioBinding.threadId, "succeeded"));
      return;
    case "verify-knowledge-release":
      await assert.condition("knowledge-release-visible", () => visibleArtifactUsesKnowledgeRelease(
        page,
        input.scenarioBinding.knowledgeReleaseId,
      ));
      return;
    case "invoke-pinned-knowledge":
      await submitPrompt(page, "Use the pinned protected synthetic knowledge release.");
      await waitForTerminalRunPanel(page, input.viewport.width, "succeeded");
      await assert.condition("knowledge-invocation-complete", () => browserHasRunStatus(page, input.scenarioBinding.threadId, "succeeded"));
      return;
    case "verify-provider-artifacts":
      await assert.condition("provider-artifacts-complete", () => projectHasReadyArtifactVersion(
        page,
        input.scenarioBinding.projectId,
        input.scenarioBinding.artifactVersionId,
      ));
      return;
    case "capture-visual":
      await assert.documentReady(`${scenario.state}-document-ready`);
      await assert.urlOrigin(`${scenario.state}-origin-bound`, input.origins.web, `/projects/${input.scenarioBinding.projectId}`);
      await assert.condition(`${scenario.state}-layout-captured`, () => visualTargetIsVisible(page, scenario.state, input.viewport));
      return;
    default:
      throw new Error(`protected G11 action ${step.actionId} has no checked-in executor`);
  }
}

async function firstVisibleLocator(page, candidates) {
  for (const candidate of candidates) {
    const locator = resolveProtectedLocator(page, candidate);
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  throw new Error("protected product control was not rendered");
}

async function ensurePreview(page) {
  const preview = page.locator("[data-project-preview]");
  if (await preview.isVisible().catch(() => false)) return;
  await (await firstVisibleLocator(page, [{ role: "button", name: "预览项目", exact: true }])).click();
  await preview.waitFor({ state: "visible" });
  await page.locator("iframe[data-preview-capability]").waitFor({ state: "visible" });
}

async function prepareProtectedExport(page, state) {
  const panel = page.locator("[data-workbench-export-panel]");
  if (!state.exportPrepared) {
    await (await firstVisibleLocator(page, [{ role: "button", name: "导出", exact: true }])).click();
    await panel.waitFor({ state: "visible" });
    if (await panel.getAttribute("data-export-state") === "empty") {
      await (await firstVisibleLocator(panel, [{ role: "button", name: "全选", exact: true }])).click();
    }
    await panel.getByRole("button", { name: /Netlify/u }).click();
    await panel.getByRole("button", { name: "生成并准备 Netlify", exact: true }).click();
    await panel.getByRole("button", { name: "准备发布至 Netlify", exact: true }).click();
    await panel.locator("[data-external-delivery-confirmation]").waitFor({ state: "visible" });
    state.exportPrepared = true;
  }
}

async function confirmProtectedPublication(page) {
  const panel = page.locator("[data-workbench-export-panel]");
  await panel.getByRole("button", { name: "确认发布至 Netlify", exact: true }).click();
  await waitForCondition(() => exportSucceeded(page));
}

async function exportSucceeded(page) {
  const panel = page.locator("[data-workbench-export-panel]");
  const state = await panel.getAttribute("data-external-delivery-state").catch(() => null);
  if (state === "succeeded") return true;
  const text = await panel.textContent().catch(() => "");
  return /发布成功|已发布|部署完成/u.test(text ?? "") && !/发布失败/u.test(text ?? "");
}

async function submitPrompt(page, prompt) {
  const composer = await visibleComposerInput(page);
  await composer.fill(prompt);
  await (await firstVisibleLocator(page, [
    { role: "button", name: "提交提示", exact: true },
    { role: "button", name: "提交项目请求", exact: true },
  ])).click();
}

function visibleComposerInput(page) {
  return firstVisibleLocator(page, [
    'textarea[aria-label="提示词"]',
    'input[placeholder="您想更改或创建什么内容?"]',
  ]);
}

async function openBoundProject(page, input) {
  const projectId = encodeURIComponent(input.scenarioBinding.projectId);
  const threadId = encodeURIComponent(input.scenarioBinding.threadId);
  await page.goto(`${input.origins.web}/projects/${projectId}?threadId=${threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("[data-project-composer]").waitFor({ state: "visible" });
}

async function browserJson(page, pathname, options = {}) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("protected browser request path is invalid");
  }
  const request = {
    body: options.body ?? null,
    credentials: options.credentials ?? "same-origin",
    headers: options.headers ?? {},
    method: options.method ?? "GET",
    pathname,
  };
  return page.evaluate(async (value) => {
    const headers = new Headers(value.headers);
    let body;
    if (value.body !== null) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(value.body);
    }
    const response = await fetch(value.pathname, {
      body,
      cache: "no-store",
      credentials: value.credentials,
      headers,
      method: value.method,
    });
    let parsed = null;
    try {
      parsed = await response.clone().json();
    } catch {
      parsed = null;
    }
    return { body: parsed, status: response.status };
  }, request);
}

function boundProjectBootstrap(page, input) {
  return browserJson(
    page,
    `/api/v1/projects/${encodeURIComponent(input.scenarioBinding.projectId)}/bootstrap?threadId=${encodeURIComponent(input.scenarioBinding.threadId)}`,
  );
}

function protectedMixedSubmissionIntent() {
  return {
    attachments: [],
    request: {
      artifactTargets: [],
      canvasSnapshot: null,
      designStyle: { kind: "automatic" },
      generationIntent: null,
      modelId: "production-acceptance",
      prompt: "Reject this protected mixed output request.",
      requestedArtifactKinds: ["prd", "prototype"],
      sourceIds: [],
      targetSurface: "web",
      workflow: "generate",
    },
  };
}

async function browserRunCount(page, threadId) {
  const result = await browserJson(
    page,
    `/api/v1/threads/${encodeURIComponent(threadId)}/runs?limit=100`,
  );
  if (result.status !== 200 || !Array.isArray(result.body?.items)) {
    throw new Error("protected Run list could not be observed");
  }
  return result.body.items.length;
}

async function browserHasRunStatus(page, threadId, status) {
  const result = await browserJson(
    page,
    `/api/v1/threads/${encodeURIComponent(threadId)}/runs?limit=100`,
  );
  return result.status === 200
    && Array.isArray(result.body?.items)
    && result.body.items.some((run) => run?.status === status);
}

async function installStageEvidenceObserver(page, { reset = false } = {}) {
  await page.evaluate(({ reset }) => {
    const evidenceKey = "__workbenchG11StageEvidence";
    const observerKey = "__workbenchG11StageObserver";
    if (reset || !Array.isArray(globalThis[evidenceKey])) globalThis[evidenceKey] = [];
    globalThis[observerKey]?.disconnect?.();
    const record = () => {
      const stages = [...document.querySelectorAll("[data-generation-stage]")]
        .filter((element) => {
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        })
        .map((element) => element.getAttribute("data-generation-stage"))
        .filter(Boolean);
      for (const stage of stages) {
        const evidence = globalThis[evidenceKey];
        if (evidence.at(-1) !== stage) evidence.push(stage);
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.documentElement, {
      attributeFilter: ["data-generation-stage"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    globalThis[observerKey] = observer;
    record();
  }, { reset });
}

function stageEvidence(page) {
  return page.evaluate(() => [...(globalThis.__workbenchG11StageEvidence ?? [])]);
}

function orderedSubsequence(actual, expected) {
  let cursor = 0;
  for (const value of actual) {
    if (value === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return false;
}

function responsiveRunPanelSelector(width) {
  return width < 768 ? "[data-mobile-run-status]" : '[data-panel-motion="agent-card"]';
}

function responsivePromptSelector(width) {
  return width < 768 ? "[data-mobile-run-prompt]" : '[data-panel-motion="agent-card"]';
}

async function waitForTerminalRunPanel(page, width, status) {
  const copy = status === "succeeded" ? "运行已完成" : status === "failed" ? "运行失败" : "运行已取消";
  await waitForCondition(async () => {
    const text = await page.locator(responsiveRunPanelSelector(width)).textContent().catch(() => "");
    return text?.includes(copy) === true;
  });
}

async function visibleArtifactIdentity(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("[data-canvas-artifact-id][data-canvas-artifact-version-id]")];
    const element = candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (!(element instanceof HTMLElement)) return null;
    const artifactId = element.dataset.canvasArtifactId;
    const artifactVersionId = element.dataset.canvasArtifactVersionId;
    return artifactId && artifactVersionId ? { artifactId, artifactVersionId } : null;
  });
}

async function verifyVisibleArtifact(page) {
  const identity = await visibleArtifactIdentity(page);
  if (!identity) return false;
  const result = await browserJson(
    page,
    `/api/v1/artifacts/${encodeURIComponent(identity.artifactId)}/versions/${encodeURIComponent(identity.artifactVersionId)}`,
  );
  return result.status === 200
    && result.body?.artifactVersionId === identity.artifactVersionId
    && result.body?.status === "ready"
    && /^[a-f0-9]{64}$/u.test(result.body?.checksum ?? "");
}

async function importProtectedFile(page, traceId) {
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await page.getByRole("menuitem", { name: "添加文档", exact: true }).click();
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({
    name: "g11-protected-source.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`protected synthetic G11 source ${traceId}\n`, "utf8"),
  });
}

async function selectFirstReadyImportSource(page) {
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await page.getByRole("menuitem", { name: "添加网站 / GitHub / Figma", exact: true }).click();
  const dialog = page.locator("[data-import-sources-dialog]");
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /^选择来源 /u }).first().click();
}

function maximumSseSequence(events) {
  return events.length === 0 ? 0 : Math.max(...events.map(({ sequence }) => sequence));
}

function maximumSseSequenceByStream(events) {
  const maximums = new Map();
  for (const { streamId, sequence } of events) {
    maximums.set(streamId, Math.max(maximums.get(streamId) ?? 0, sequence));
  }
  return maximums;
}

function contiguousSseSequences(events) {
  if (events.length === 0) return false;
  const groups = new Map();
  for (const event of events) {
    const key = `${event.streamId}\0${event.afterSequence}`;
    const group = groups.get(key) ?? { afterSequence: event.afterSequence, sequences: [] };
    group.sequences.push(event.sequence);
    groups.set(key, group);
  }
  return [...groups.values()].every(({ afterSequence, sequences: rawSequences }) => {
    const sequences = [...new Set(rawSequences)].sort((left, right) => left - right);
    return sequences[0] === afterSequence + 1
      && sequences.every((value, index) => index === 0 || value === sequences[index - 1] + 1);
  });
}

async function consumeBoundRunSse(page, runId) {
  const status = await page.evaluate(async (value) => {
    const response = await fetch(`/api/v1/runs/${encodeURIComponent(value)}/events?afterSequence=0`, {
      cache: "no-store",
    });
    if (response.status === 200) await response.text();
    return response.status;
  }, runId);
  if (status !== 200) throw new Error("protected long-Run SSE stream was not readable");
}

async function verifyStablePrototypeNodeIds(page) {
  return page.evaluate(() => {
    const ids = [...document.querySelectorAll("[data-canvas-board-node-id]")]
      .map((element) => element.getAttribute("data-canvas-board-node-id"))
      .filter(Boolean);
    return ids.length > 0 && new Set(ids).size === ids.length;
  });
}

function hasVisibleFocusedElement(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return false;
    const rect = active.getBoundingClientRect();
    const style = getComputedStyle(active);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
}

function focusedElementHasIndicator(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const style = getComputedStyle(active);
    return style.outlineStyle !== "none"
      || Number.parseFloat(style.outlineWidth) > 0
      || style.boxShadow !== "none"
      || active.matches(":focus-visible");
  });
}

function visibleControlsHaveNames(page) {
  return page.evaluate(() => [...document.querySelectorAll("button, a[href], input, textarea, select, iframe")]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })
    .every((element) => Boolean(
      element.getAttribute("aria-label")
      || element.getAttribute("aria-labelledby")
      || element.getAttribute("title")
      || element.getAttribute("alt")
      || element.textContent?.trim()
      || element.getAttribute("placeholder"),
    )));
}

function visibleTextMeetsContrast(page) {
  return page.evaluate(() => {
    const parse = (value) => {
      const match = value.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/u);
      return match ? match.slice(1, 4).map(Number) : null;
    };
    const luminance = (rgb) => {
      const values = rgb.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const contrast = (left, right) => {
      const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const controls = [...document.querySelectorAll("button, a[href], input, textarea")].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return controls.length > 0 && controls.every((element) => {
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      let parent = element;
      let background = null;
      while (parent && !background) {
        const candidate = getComputedStyle(parent).backgroundColor;
        if (!candidate.endsWith(", 0)") && candidate !== "transparent") background = parse(candidate);
        parent = parent.parentElement;
      }
      if (!foreground || !background) return true;
      const large = Number.parseFloat(style.fontSize) >= 18
        || (Number.parseFloat(style.fontSize) >= 14 && Number(style.fontWeight) >= 700);
      return contrast(foreground, background) >= (large ? 3 : 4.5);
    });
  });
}

function reducedMotionContractMatches(page, motion) {
  return page.evaluate((expected) => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced !== (expected === "reduced")) return false;
    if (!reduced) return true;
    return [...document.querySelectorAll("*")].every((element) => [null, "::before", "::after"].every((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      if (style.animationName === "none") return true;
      const durations = style.animationDuration.split(",").map((value) => value.trim().endsWith("ms")
        ? Number.parseFloat(value)
        : Number.parseFloat(value) * 1_000);
      return durations.every((duration) => Number.isFinite(duration) && duration <= 1);
    }));
  }, motion);
}

async function previewOriginIs(page, expectedOrigin) {
  const source = await page.locator("iframe[data-preview-capability]").getAttribute("src");
  try {
    return new URL(source).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function previewSandboxIsOpaque(page) {
  return page.locator("iframe[data-preview-capability]").getAttribute("sandbox").then((value) => {
    const tokens = new Set(String(value ?? "").split(/\s+/u).filter(Boolean));
    return !tokens.has("allow-same-origin") && !tokens.has("allow-top-navigation");
  });
}

async function previewReady(page) {
  const root = page.locator("[data-isolated-preview]");
  return await root.isVisible()
    && await root.locator("iframe[data-preview-capability]").isVisible()
    && await root.getByRole("status").count() === 0;
}

function previewTimeoutContractMatches(page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-isolated-preview]");
    if (!(root instanceof HTMLElement)) return false;
    const generation = Number(root.getAttribute("data-preview-generation"));
    const connectionGeneration = Number(root.getAttribute("data-preview-connection-generation"));
    return root.getAttribute("data-preview-state") === "ready"
      && Number.isSafeInteger(generation) && generation > 0
      && Number.isSafeInteger(connectionGeneration) && connectionGeneration === generation
      && root.getAttribute("data-preview-connection-timeout-ms") === "8000"
      && root.getAttribute("data-preview-handshake-timeout-ms") === "2000";
  });
}

async function refreshPreviewGeneration(page) {
  const before = await page.evaluate(() => {
    const root = document.querySelector("[data-isolated-preview]");
    if (!(root instanceof HTMLElement)) return null;
    const generation = Number(root.getAttribute("data-preview-generation"));
    const connectionGeneration = Number(root.getAttribute("data-preview-connection-generation"));
    return root.getAttribute("data-preview-state") === "ready"
      && Number.isSafeInteger(generation) && generation > 0
      && Number.isSafeInteger(connectionGeneration) && connectionGeneration === generation
      ? generation
      : null;
  });
  if (before === null) return false;
  const observedTransition = page.evaluate((previousGeneration) => new Promise((resolve) => {
    const root = document.querySelector("[data-isolated-preview]");
    if (!(root instanceof HTMLElement)) {
      resolve(false);
      return;
    }
    let sawConnectionGenerationCleared = false;
    const complete = () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
    const inspect = () => {
      const generation = Number(root.getAttribute("data-preview-generation"));
      const connectionGeneration = root.getAttribute("data-preview-connection-generation");
      if (connectionGeneration === null || connectionGeneration === "") sawConnectionGenerationCleared = true;
      if (sawConnectionGenerationCleared
        && root.getAttribute("data-preview-state") === "ready"
        && Number.isSafeInteger(generation) && generation > previousGeneration
        && connectionGeneration === String(generation)) {
        complete();
        resolve(true);
      }
    };
    const observer = new MutationObserver(inspect);
    const timeout = setTimeout(() => {
      complete();
      resolve(false);
    }, 12_000);
    observer.observe(root, { attributes: true, attributeFilter: [
      "data-preview-state",
      "data-preview-generation",
      "data-preview-connection-generation",
    ] });
    inspect();
  }), before);
  await page.getByRole("button", { name: "刷新预览", exact: true }).click();
  return await observedTransition;
}

async function visibleArtifactUsesKnowledgeRelease(page, knowledgeReleaseId) {
  const identity = await visibleArtifactIdentity(page);
  if (!identity) return false;
  const result = await browserJson(
    page,
    `/api/v1/artifacts/${encodeURIComponent(identity.artifactId)}/versions/${encodeURIComponent(identity.artifactVersionId)}`,
  );
  return result.status === 200 && result.body?.knowledgeReleaseId === knowledgeReleaseId;
}

async function projectHasReadyArtifactVersion(page, projectId, artifactVersionId) {
  const result = await browserJson(page, `/api/v1/projects/${encodeURIComponent(projectId)}/artifacts?limit=100`);
  return result.status === 200 && Array.isArray(result.body?.items)
    && result.body.items.some((artifact) => (
      artifact?.currentVersion?.artifactVersionId === artifactVersionId
      && artifact.currentVersion.status === "ready"
      && /^[a-f0-9]{64}$/u.test(artifact.currentVersion.checksum ?? "")
    ));
}

async function visualTargetIsVisible(page, state, viewport) {
  const selector = visualTargetSelector(state, viewport.width);
  return page.locator(selector).evaluate((element, expectedViewport) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.top >= 0
      && rect.right <= expectedViewport.width && rect.bottom <= expectedViewport.height
      && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
  }, viewport);
}

function visualTargetSelector(state, viewportWidth) {
  if (state === "prd-pending") return '[data-workbench-artifact-state="pending"]';
  return responsiveRunPanelSelector(viewportWidth);
}

async function waitForCondition(check, timeoutMs = OPERATION_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("protected browser condition timed out");
}

async function captureVisualEvidence({ page, input, scenario, evidenceRoot, outputParent }) {
  const visualDirectory = path.join(outputParent, `.g11-visual-${input.traceId}`);
  await mkdir(visualDirectory, { recursive: true, mode: 0o700 });
  await assertWithinRoot(visualDirectory, evidenceRoot, "visual evidence directory");
  await assertSecureDirectory(visualDirectory, "visual evidence directory");
  const targetSelector = visualTargetSelector(scenario.state, input.viewport.width);
  const before = await page.screenshot({ animations: input.motion === "reduced" ? "disabled" : "allow" });
  const beforeMetrics = await collectVisualMetrics(page, targetSelector, input.viewport);
  await page.waitForTimeout(VISUAL_SAMPLE_INTERVAL_MS);
  const after = await page.screenshot({ animations: input.motion === "reduced" ? "disabled" : "allow" });
  const afterMetrics = await collectVisualMetrics(page, targetSelector, input.viewport);
  const screenshot = await writeVisualArtifact(visualDirectory, "screenshot.png", before);
  const frameBefore = await writeVisualArtifact(visualDirectory, "frame-before.png", before);
  const frameAfter = await writeVisualArtifact(visualDirectory, "frame-after.png", after);
  const targetBounds = unionPixelBounds(
    beforeMetrics.layout.targetBounds,
    afterMetrics.layout.targetBounds,
    input.viewport,
  );
  const framePixelDiffRatio = await rgbaTargetPixelDiffRatio(
    before,
    after,
    targetBounds,
    input.viewport,
  );
  return deepFreeze({
    schemaVersion: "workbench.production-g11-visual-evidence.v1",
    targetSelector,
    viewport: input.viewport,
    motion: input.motion,
    screenshot,
    frameBefore,
    frameAfter,
    framePixelDiffRatio,
    computedStyle: afterMetrics.computedStyle,
    layout: { ...afterMetrics.layout, targetBounds },
    accessibility: afterMetrics.accessibility,
    before: beforeMetrics,
    after: afterMetrics,
  });
}

async function collectVisualMetrics(page, targetSelector, viewport) {
  return page.evaluate(({ targetSelector, viewport }) => {
    const styleSnapshot = (style) => ({
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      animationIterationCount: style.animationIterationCount,
      animationPlayState: style.animationPlayState,
      backgroundPosition: style.backgroundPosition,
      opacity: style.opacity,
      transform: style.transform,
    });
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) return null;
      const x = Math.floor(rect.left);
      const y = Math.floor(rect.top);
      const right = Math.ceil(rect.right);
      const bottom = Math.ceil(rect.bottom);
      return { x, y, width: right - x, height: bottom - y };
    };
    const target = document.querySelector(targetSelector);
    const targetStyle = target instanceof HTMLElement ? getComputedStyle(target) : null;
    const targetRect = rectFor(targetSelector);
    const regions = {
      target: targetRect,
      agentCard: rectFor('[data-panel-motion="agent-card"]'),
      composer: rectFor("[data-project-composer]"),
      artifact: rectFor('[data-workbench-artifact-state="pending"]'),
      rightToolRail: rectFor("[data-right-tool-rail]"),
      suggestions: rectFor("[data-project-suggestions]"),
      utilityPill: rectFor("[data-utility-pill]"),
    };
    const overlaps = (left, right) => left && right
      && left.x < right.x + right.width && left.x + left.width > right.x
      && left.y < right.y + right.height && left.y + left.height > right.y;
    const regionValues = [...new Map(Object.values(regions).filter(Boolean).map((rect) => [
      `${rect.x}/${rect.y}/${rect.width}/${rect.height}`,
      rect,
    ])).values()];
    const noOverlap = regionValues.every((left, index) => regionValues.slice(index + 1).every((right) => !overlaps(left, right)));
    const withinViewport = regionValues.every((rect) => rect.x >= 0 && rect.y >= 0
      && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height);
    const accessibleTargets = [
      "[data-panel-motion=\"agent-card\"]", "[data-project-composer]", targetSelector,
    ];
    const accessibleNamesPassed = accessibleTargets.every((selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return false;
      const hasName = Boolean(element.getAttribute("aria-label") || element.getAttribute("title")
        || element.textContent?.trim() || element.getAttribute("role"));
      return hasName;
    });
    return {
      computedStyle: targetStyle ? {
        ...styleSnapshot(targetStyle),
        before: styleSnapshot(getComputedStyle(target, "::before")),
      } : null,
      layout: {
        withinViewport,
        noOverlap,
        promptContextVisible: regions.agentCard !== null || regions.composer !== null,
        activityContextVisible: regions.agentCard !== null,
        pendingCompositionVisible: regions.artifact !== null,
        accessibleNamesPassed,
        targetBounds: targetRect,
      },
      accessibility: { accessibleNamesPassed },
    };
  }, { targetSelector, viewport });
}

async function writeVisualArtifact(directory, fileName, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_VISUAL_BYTES) {
    throw new Error("visual evidence image is outside the bounded size contract");
  }
  const target = path.join(directory, fileName);
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    path: target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}

async function rgbaTargetPixelDiffRatio(left, right, bounds, viewport) {
  if (!validPixelBounds(bounds, viewport)) {
    throw new Error("visual evidence requires integer target bounds inside the viewport");
  }
  const [before, after] = await Promise.all([
    sharp(left).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(right).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (before.info.width !== viewport.width || before.info.height !== viewport.height
    || after.info.width !== viewport.width || after.info.height !== viewport.height
    || before.info.width !== after.info.width || before.info.height !== after.info.height
    || before.info.channels !== 4 || after.info.channels !== 4) {
    throw new Error("visual evidence frames are not matching RGBA viewport images");
  }
  let changed = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = ((y * before.info.width) + x) * 4;
      if ([0, 1, 2, 3].some((channel) => Math.abs(before.data[offset + channel] - after.data[offset + channel]) > 2)) {
        changed += 1;
      }
    }
  }
  return changed / (bounds.width * bounds.height);
}

function unionPixelBounds(before, after, viewport) {
  if (!validPixelBounds(before, viewport) || !validPixelBounds(after, viewport)) {
    throw new Error("visual target bounds are invalid for frame comparison");
  }
  const x = Math.min(before.x, after.x);
  const y = Math.min(before.y, after.y);
  const right = Math.max(before.x + before.width, after.x + after.width);
  const bottom = Math.max(before.y + before.height, after.y + after.height);
  const bounds = { x, y, width: right - x, height: bottom - y };
  if (!validPixelBounds(bounds, viewport)) {
    throw new Error("visual target bounds union exceeds the viewport");
  }
  return bounds;
}

function validPixelBounds(bounds, viewport) {
  return bounds
    && Number.isInteger(bounds.x) && Number.isInteger(bounds.y)
    && Number.isInteger(bounds.width) && Number.isInteger(bounds.height)
    && bounds.x >= 0 && bounds.y >= 0 && bounds.width >= 16 && bounds.height >= 16
    && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height;
}

function detachCaptureListeners({ browser, consoleCapture, networkCapture, runtimeCapture, context }) {
  const boundary = context ? CONTEXT_BOUNDARIES.get(context) : null;
  for (const candidate of context?.pages?.() ?? []) {
    candidate.off("console", consoleCapture.onConsole);
    candidate.off("pageerror", consoleCapture.onPageError);
    candidate.off("crash", runtimeCapture.onPageCrash);
  }
  if (context) {
    if (boundary?.attachPage) context.off("page", boundary.attachPage);
    context.off("request", networkCapture.onRequest);
    context.off("response", networkCapture.onResponse);
    context.off("requestfailed", networkCapture.onRequestFailed);
    context.off("websocket", networkCapture.onWebSocket);
    if (boundary?.routeHandler) void context.unroute("**/*", boundary.routeHandler).catch(() => undefined);
  }
  browser?.off("disconnected", runtimeCapture.onBrowserDisconnected);
}

async function withTimeout(label, promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertSecureDirectory(candidate, label, { allowSticky = false } = {}) {
  const info = await stat(candidate);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the collector user`);
  }
  const permissions = info.mode & 0o7777;
  const writableByOthers = (permissions & 0o022) !== 0;
  const sticky = (permissions & 0o1000) !== 0;
  if (writableByOthers && !(allowSticky && sticky)) {
    throw new Error(`${label} must not be group- or world-writable`);
  }
  return Object.freeze({ dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode });
}

async function assertDirectoryIdentity(candidate, expected, label) {
  const actual = await stat(candidate);
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.uid !== expected.uid || actual.mode !== expected.mode) {
    throw new Error(`${label} changed during collection`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const __g11HarnessTestOnly = Object.freeze({
  contiguousSseSequences,
  createSseCapture,
  createAssertionRecorder,
  createNetworkCapture,
    classifyPath,
    classifyRouteTemplate,
  isCanonicalPublicOrigin,
  isGlobalIp,
  maxSseEvents: G11_MAX_SSE_RECORDS,
  rgbaTargetPixelDiffRatio,
  sanitizeSseEvidence,
  sseEventNames: G11_RUN_EVENT_NAMES,
  validateScenarioSecrets,
});

function assertOutsideRoot(candidate, root, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`${label} must remain outside the evidence root`);
  }
}

function assertWithinRoot(candidate, root, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must be inside the evidence root`);
}

function createCanonicalStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function readArchiveEntry(bytes, expectedName) {
  const nameLength = bytes.readUInt16LE(26);
  const name = bytes.subarray(30, 30 + nameLength).toString("utf8");
  if (name !== expectedName) throw new Error(`sanitized archive does not start with ${expectedName}`);
  const length = bytes.readUInt32LE(22);
  return bytes.subarray(30 + nameLength, 30 + nameLength + length).toString("utf8");
}
