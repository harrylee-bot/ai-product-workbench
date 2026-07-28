export function assertRealStackBrowserMode({ browserOnly, enabled }) {
  if (browserOnly && !enabled) {
    throw new Error("real-stack browser-only mode requires the real-stack browser lane");
  }
}

export function shouldFailRealStackEvidenceForSourceDrift(status, sourceDrift) {
  return status === "passed" && sourceDrift === true;
}

const browserSseEventNames = new Set([
  "activity.changed",
  "artifact.draft.created",
  "artifact.prototype.patch.created",
  "artifact.prototype.patch.degraded",
  "artifact.version.created",
  "message.completed",
  "message.delta",
  "message.started",
  "run.cancel.requested",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.generation.stage.changed",
  "run.input.required",
  "run.input.submitted",
  "run.phase.changed",
  "run.queued",
  "run.started",
]);

export function browserOriginClass(rawUrl, { previewOrigin, webOrigin }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "invalid";
  }
  if (url.origin === webOrigin) return "web";
  if (url.origin === previewOrigin) return "preview";
  if (url.protocol === "http:" || url.protocol === "https:") return httpOriginClass(url.href);
  return "other-scheme";
}

export function browserNetworkFailureClass(value) {
  return typeof value === "string" && /^net::ERR_[A-Z0-9_]+$/u.test(value)
    ? value
    : "unknown";
}

const approvedAuthSpotlightRequestClassByHref = new Map([
  [
    "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260609_195923_b0ba8ace-1d1d-4f2c-9a28-1ab84b330680.png&w=1280&q=85",
    "auth-spotlight-primary",
  ],
  [
    "https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260609_201152_bba90a12-bf12-459f-91f0-51f237dbaf3b.png&w=1280&q=85",
    "auth-spotlight-reveal",
  ],
]);

export function browserExternalRequestClass(rawUrl, {
  hasCredentials,
  initiatorOrigin,
  initiatorPathClass,
  isMainFrame,
  isNavigationRequest,
  method,
  redirected,
  resourceType,
  webOrigin,
}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    method !== "GET"
    || resourceType !== "image"
    || initiatorOrigin !== webOrigin
    || initiatorPathClass !== "/register"
    || isMainFrame !== true
    || isNavigationRequest !== false
    || redirected !== false
    || hasCredentials !== false
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    return null;
  }
  return approvedAuthSpotlightRequestClassByHref.get(url.href) ?? null;
}

export function hasRequiredBrowserSseEvidence(events, reconnectCursor) {
  if (!Array.isArray(events) || !Number.isSafeInteger(reconnectCursor) || reconnectCursor < 0) {
    return false;
  }
  const eventNames = new Set(events.map((event) => event?.eventName));
  return events.some((event) => (
    event?.afterSequence === reconnectCursor && event?.sequence > reconnectCursor
  ))
    && eventNames.has("run.completed")
    && eventNames.has("run.failed");
}

export function browserSseEventEvidence(value) {
  if (!value || typeof value !== "object") return null;
  const { afterSequence, eventName, sequence } = value;
  if (
    !browserSseEventNames.has(eventName)
    || !Number.isSafeInteger(sequence)
    || sequence <= 0
    || !Number.isSafeInteger(afterSequence)
    || afterSequence < 0
    || sequence <= afterSequence
  ) {
    return null;
  }
  return { afterSequence, eventName, sequence };
}

export function connectionErrorClass(error) {
  const causeCode = error && typeof error === "object" && "cause" in error
    && error.cause && typeof error.cause === "object" && "code" in error.cause
    ? error.cause.code
    : null;
  if (typeof causeCode === "string" && /^[A-Z][A-Z0-9_]+$/u.test(causeCode)) return causeCode;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)) return error.name;
  return "UnknownError";
}

export function httpOriginClass(rawUrl) {
  const url = new URL(rawUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  return `${url.protocol === "https:" ? "https" : "http"}-${loopback ? "loopback" : "remote"}`;
}

export function httpPathClass(pathname) {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ":id")
    .replace(
      /\/(?:approvals|artifact-drafts|artifacts|commands|export-deliveries|exports|file-upload-sessions|files|import-sources|invitations|members|preview|previews|projects|releases|runs|shares|submission-intents|threads|versions|workspaces)\/[^/]+/gu,
      (segment) => segment.slice(0, segment.lastIndexOf("/")) + "/:id",
    );
}

export function createScriptedNavigationAbortTracker() {
  const inFlight = new Set();
  const abortAttributions = new Map();
  let activeNavigation = null;

  return {
    requestStarted(request, { navigationRequest = false } = {}) {
      inFlight.add(request);
      if (activeNavigation && !activeNavigation.committed && !navigationRequest) {
        abortAttributions.set(request, attributionFor(activeNavigation));
      }
    },

    requestFinished(request) {
      inFlight.delete(request);
      abortAttributions.delete(request);
    },

    beginNavigation({ kind, targetPathClass }) {
      if (activeNavigation) {
        throw new Error("scripted hard-navigation scopes cannot overlap");
      }
      const scope = {
        committed: false,
        kind,
        targetPathClass,
      };
      for (const request of inFlight) {
        abortAttributions.set(request, attributionFor(scope));
      }
      activeNavigation = scope;
      return scope;
    },

    mainFrameNavigated() {
      if (activeNavigation) activeNavigation.committed = true;
    },

    classifyFailure(request, errorText) {
      const attribution = errorText === "net::ERR_ABORTED"
        ? abortAttributions.get(request) ?? null
        : null;
      inFlight.delete(request);
      abortAttributions.delete(request);
      return attribution;
    },

    endNavigation(scope) {
      if (activeNavigation !== scope) {
        throw new Error("scripted hard-navigation scope identity changed");
      }
      activeNavigation = null;
    },
  };
}

const terminalRunEventByStatus = Object.freeze({
  succeeded: "run.completed",
  failed: "run.failed",
  cancelled: "run.cancelled",
});

export function persistedTerminalSseAbortAttribution({
  afterSequence,
  failure,
  persistedRun,
  responseStatus,
}) {
  if (
    failure.abortAttribution !== null
    || failure.errorText !== "net::ERR_ABORTED"
    || failure.method !== "GET"
    || failure.pathClass !== "/api/v1/runs/:id/events"
    || (failure.resourceType !== "eventsource" && failure.resourceType !== "fetch")
    || responseStatus !== 200
    || !Number.isSafeInteger(afterSequence)
    || afterSequence < 0
    || !persistedRun
  ) {
    return null;
  }

  const expectedTerminalEvent = terminalRunEventByStatus[persistedRun.status];
  if (
    expectedTerminalEvent === undefined
    || persistedRun.terminalEventType !== expectedTerminalEvent
    || !Number.isSafeInteger(persistedRun.eventSequence)
    || !Number.isSafeInteger(persistedRun.terminalEventSequence)
    || persistedRun.eventSequence !== persistedRun.terminalEventSequence
    || persistedRun.terminalEventSequence <= afterSequence
  ) {
    return null;
  }

  return {
    cause: "persisted-terminal-run-sse-cleanup",
    terminalStatus: persistedRun.status,
    terminalEventType: persistedRun.terminalEventType,
    terminalSequence: persistedRun.terminalEventSequence,
  };
}

function attributionFor(scope) {
  return {
    cause: "scripted-hard-navigation",
    navigationKind: scope.kind,
    targetPathClass: scope.targetPathClass,
  };
}
