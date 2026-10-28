import {
  connectionErrorClass,
  httpPathClass,
} from "./workbench-browser-network-evidence.mjs";

const counterNames = [
  "threadCreates",
  "successRuns",
  "prototypePatchRuns",
  "sourcePrototypeRuns",
  "generatePrototypeRuns",
  "approvalRuns",
  "approvalResumes",
  "cancelRuns",
  "canvasSeedRuns",
  "canvasQuickEditRuns",
  "canvasDirectEditRuns",
  "browserPrototypeRuns",
  "browserFailureAttempts",
  "browserFailureRejoinAttempts",
  "browserFailureRecoveryRuns",
  "activeCancelStreams",
];

const canvasToolNames = new Set([
  "get_visible_screens",
  "get_selected_screens",
  "view_screen",
  "select_screen",
  "navigate_canvas",
  "quick_edit",
  "rename_screen",
  "duplicate_screen",
]);

const canvasToolStatuses = new Set([
  "waiting_client",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

const requestKinds = new Set([
  "thread",
  "run-list",
  "browser-failure-rejoin",
  "run-cancel",
  "browser-failure",
  "browser-failure-recovery",
  "cancel",
  "approval-resume",
  "approval",
  "prototype-patch",
  "source-prototype",
  "generate-prototype",
  "canvas-seed",
  "canvas-quick-edit",
  "canvas-direct-edit",
  "prototype-generation",
  "success",
]);

const runtimeKinds = new Set([...requestKinds, "browser-failure-accepted"]);
const runtimeStatuses = new Set(["running", "success", "error", "interrupted", "cancelled"]);
const httpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const storageRoles = new Set(["export", "preview", "api-canvas-visual"]);
const mediaTypeClasses = new Set(["application", "audio", "font", "image", "model", "text", "video"]);
const previewHttpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const previewResourceTypes = new Set([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
  "manifest",
  "other",
]);
const previewFrameRoles = new Set(["top-level", "subframe", "unknown"]);
const previewFrameOrigins = new Set(["web", "preview", "http-loopback", "http-remote", "https-remote", "other-scheme", "invalid", "unknown"]);
const errorClasses = new Set([
  "AbortError",
  "AssertionError",
  "Error",
  "TypeError",
  "UnknownError",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);
const diagnosticPathClasses = new Set([
  "/threads",
  "/threads/:id/runs",
  "/threads/:id/runs/:id",
  "/threads/:id/runs/:id/stream",
  "/threads/:id/runs/:id/cancel",
  "/threads/:id/runs/stream",
  "/api/threads/:id/uploads",
]);

const successfulHttpScenarioNames = [
  "project-lifecycle",
  "sse-revocation",
  "mixed-request-zero-side-effects",
  "success-idempotency-replay",
  "prototype-patch",
  "canvas-gateway",
  "targeted-prototype",
  "approvals",
  "cancellation",
  "retry",
];

export function diagnosticErrorClass(error) {
  return enumClass(connectionErrorClass(error), errorClasses, "UnknownError");
}

export function previewRequestSecurityEvidence(requests) {
  return arrayOf(requests).map((request) => ({
    method: enumClass(request?.method, previewHttpMethods),
    pathClass: previewPathClass(request?.path),
    resourceType: enumClass(request?.resourceType, previewResourceTypes),
    isNavigationRequest: request?.isNavigationRequest === true,
    frameRole: enumClass(request?.frameRole, previewFrameRoles),
    frameOrigin: enumClass(request?.frameOrigin, previewFrameOrigins),
    headerInspection: request?.headerInspection === "complete" ? "complete" : "failed",
    hasCookie: typeof request?.hasCookie === "boolean" ? request.hasCookie : null,
    hasAuthorization: typeof request?.hasAuthorization === "boolean" ? request.hasAuthorization : null,
  }));
}

export function httpDiagnosticSuccessEvidence({
  candidateSha,
  controlledProvider,
  fakeRuntimeState,
  sourceClean,
}) {
  const state = fakeRuntimeState && typeof fakeRuntimeState === "object" ? fakeRuntimeState : {};
  return {
    ok: true,
    evidenceLevel: "real-stack-http",
    databaseClass: "isolated-postgresql",
    provider: controlledProvider === "controlled-local-deerflow"
      ? controlledProvider
      : "unknown",
    candidate: {
      sourceCommit: typeof candidateSha === "string" && /^[0-9a-f]{40}$/u.test(candidateSha)
        ? candidateSha
        : "invalid",
      sourceTreeAtStart: sourceClean === true ? "clean" : "dirty",
      candidateBound: sourceClean === true,
    },
    scenarios: successfulHttpScenarioNames.map((name) => ({ name, status: "passed" })),
    runtime: {
      threadCreates: counterValue(state.threadCreates),
      successRuns: counterValue(state.successRuns),
      prototypePatchRuns: counterValue(state.prototypePatchRuns),
      sourcePrototypeRuns: counterValue(state.sourcePrototypeRuns),
      generatePrototypeRuns: counterValue(state.generatePrototypeRuns),
      approvalRuns: counterValue(state.approvalRuns),
      approvalResumes: counterValue(state.approvalResumes),
      cancelRuns: counterValue(state.cancelRuns),
      canvasSeedRuns: counterValue(state.canvasSeedRuns),
      canvasQuickEditRuns: counterValue(state.canvasQuickEditRuns),
      canvasDirectEditRuns: counterValue(state.canvasDirectEditRuns),
      canvasToolCalls: arrayOf(state.canvasToolCalls).length,
      objectReads: arrayOf(state.objectReads).length,
      visualReads: arrayOf(state.visualReads).length,
      gatewayUploads: arrayOf(state.gatewayUploads).length,
    },
  };
}

export function diagnosticFakeRuntimeState(input) {
  const state = input && typeof input === "object" ? input : {};
  const counters = diagnosticCounters(state);

  return JSON.stringify({
    ...counters,
    canvasToolCalls: arrayOf(state.canvasToolCalls).map((call) => ({
      toolName: enumClass(call?.toolName, canvasToolNames),
      statuses: arrayOf(call?.statuses).map((status) => enumClass(status, canvasToolStatuses)),
    })),
    objectReads: arrayOf(state.objectReads).map(storageRecordSummary),
    visualReads: arrayOf(state.visualReads).map(storageRecordSummary),
    exportReads: arrayOf(state.exportReads).map((record) => ({
      ...storageRecordSummary(record),
      role: enumClass(record?.role, storageRoles),
    })),
    gatewayUploads: arrayOf(state.gatewayUploads).map((upload) => ({
      pathClass: httpDiagnosticPathClass(upload?.path),
      byteSize: byteSize(upload?.byteSize),
      matchedObjectCount: arrayOf(upload?.matchedStorageKeys).length,
    })),
    runRequests: arrayOf(state.runRequests).map((request) => ({
      kind: enumClass(request?.kind, requestKinds),
    })),
    requests: arrayOf(state.requests).map((request) => ({
      ...(request?.method ? { method: enumClass(request.method, httpMethods) } : {}),
      ...(request?.path ? { pathClass: httpDiagnosticPathClass(request.path) } : {}),
      ...(request?.kind ? { kind: enumClass(request.kind, requestKinds) } : {}),
      ...(request?.errorClass ? { errorClass: enumClass(request.errorClass, errorClasses, "UnknownError") } : {}),
    })),
    runtimeRuns: runtimeRunValues(state.runtimeRuns).map((run) => ({
      status: enumClass(run?.status, runtimeStatuses),
      kind: enumClass(run?.kind, runtimeKinds),
    })),
    multipartCreates: arrayOf(state.multipartCreates).map((record) => ({
      keyClass: storageObjectKeyClass(record?.storageKey),
    })),
    storageWrites: arrayOf(state.storageWrites).map((record) => ({
      ...storageRecordSummary(record),
      mediaTypeClass: mediaTypeClass(record?.mediaType),
    })),
  }, null, 2);
}

function httpDiagnosticPathClass(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "unknown";
  let pathname;
  try {
    pathname = new URL(value, "http://diagnostic.invalid").pathname;
  } catch {
    return "unknown";
  }
  if (/^\/threads\/[^/]+\/runs\/stream$/u.test(pathname)) return "/threads/:id/runs/stream";
  const pathClass = httpPathClass(pathname);
  return diagnosticPathClasses.has(pathClass) ? pathClass : "unknown";
}

function previewPathClass(value) {
  if (typeof value !== "string") return "unknown";
  let pathname;
  try {
    pathname = new URL(value, "http://preview-diagnostic.invalid").pathname;
  } catch {
    return "unknown";
  }
  if (pathname === "/healthz") return "/healthz";
  return /^\/preview\/[^/]+$/u.test(pathname) ? "/preview/:capability" : "other";
}

function storageRecordSummary(record) {
  return {
    keyClass: storageObjectKeyClass(record?.storageKey),
    byteSize: byteSize(record?.byteSize),
    checksum: checksum(record?.sha256),
  };
}

function storageObjectKeyClass(value) {
  if (typeof value !== "string") return "unknown";
  const segments = value.split("/");
  if (segments[0] === "canvas-visuals") return "canvas-visuals/:object";
  if (segments[0] === "blobs") return "blobs/:object";
  if (segments[0] === "private") return "private/:object";
  if (segments[0] === "pending" && segments[1] === "exports") return "pending/exports/:object";
  return "unknown";
}

function checksum(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : "invalid";
}

function byteSize(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function counterValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mediaTypeClass(value) {
  if (typeof value !== "string") return "unknown";
  const type = value.split("/", 1)[0].toLowerCase();
  return mediaTypeClasses.has(type) ? `${type}/*` : "unknown";
}

function enumClass(value, allowed, fallback = "unknown") {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function diagnosticCounters(state) {
  const counters = {};
  for (const name of counterNames) {
    if (Number.isSafeInteger(state[name]) && state[name] >= 0) counters[name] = state[name];
  }
  return counters;
}

function runtimeRunValues(value) {
  return value instanceof Map ? [...value.values()] : [];
}
