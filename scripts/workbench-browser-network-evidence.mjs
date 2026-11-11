import { isDeepStrictEqual } from "node:util";

export function recoveredBoardRevisionConflicts(writes) {
  return writes.filter((write) => write.status === 412 && write.code === "REVISION_CONFLICT")
    .flatMap((failed) => {
      const base = /^"(\d+)"$/u.exec(failed.ifMatch ?? "");
      if (!base || !Array.isArray(failed.request?.nodes) || !Array.isArray(failed.request?.edges)) return [];
      const baseRevision = Number(base[1]);
      const recovered = writes.find((write) => {
        const fresh = /^"(\d+)"$/u.exec(write.ifMatch ?? "");
        return write.responseIndex > failed.responseIndex && write.projectPath === failed.projectPath
          && write.status === 200 && fresh && Number(fresh[1]) > baseRevision
          && write.board?.revision > Number(fresh[1])
          && isDeepStrictEqual(write.board?.viewport, write.request?.viewport)
          && isDeepStrictEqual(write.board?.edges, failed.request.edges)
          && failed.request.nodes.every((node) => isDeepStrictEqual(
            node, write.board?.nodes?.find((candidate) => candidate.id === node.id),
          ));
      });
      return recovered ? [{
        responseIndex: failed.responseIndex,
        baseRevision, savedRevision: recovered.board.revision,
        cause: "recovered-board-revision-conflict",
        existingContentPreserved: true, latestViewportPersisted: true,
      }] : [];
    });
}

export function assertRealStackBrowserMode({ browserOnly, enabled }) {
  if (browserOnly && !enabled) {
    throw new Error("real-stack browser-only mode requires the real-stack browser lane");
  }
}

export function shouldFailRealStackEvidenceForSourceDrift(status, sourceDrift) {
  return status === "passed" && sourceDrift === true;
}

export function clientRoutePrefetchAbortAttribution({
  currentPathClass,
  failure,
  navigationEvidence,
}) {
  const route = failure?.routeFetch;
  if (
    failure?.abortAttribution !== null
    || failure?.originClass !== "web"
    || failure?.method !== "GET"
    || failure?.pathClass !== "/projects/:id"
    || failure?.errorText !== "net::ERR_ABORTED"
    || failure?.resourceType !== "fetch"
    || currentPathClass !== "/projects/:id"
    || route?.rsc !== true
    || route?.prefetch !== true
    || route?.navigationRequest !== false
    || !/^[a-f0-9]{64}$/u.test(route?.pathHash ?? "")
    || (route.responseStatus !== null && (!Number.isInteger(route.responseStatus) || route.responseStatus < 200 || route.responseStatus >= 300))
    || !Array.isArray(navigationEvidence)
    || !navigationEvidence.some((entry) => (
      entry?.actualPathClass === "/projects/:id"
      && entry?.targetPathClass === "/projects/:id"
      && entry?.pathHash === route.pathHash
      && ((entry?.kind === "client-route" && entry?.projectShellReady === true)
        || entry?.status === 200)
    ))
  ) {
    return null;
  }
  return { cause: "client-route-prefetch", nextRscPrefetchVerified: true, destinationRendered: true };
}

const browserSseEventNames = new Set([
  "activity.changed",
  "artifact.draft.created",
  "artifact.preview.updated",
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

// A rendered client shell can precede the end of its streamed RSC response.
// Finish that navigation before a scripted reload tests SSE reconnection.
// An abort or invalid response is a failure, never a successful settlement.
export function projectRouteFetchSettlement(records, pathHash) {
  // Production cached navigation can render entirely from completed prefetch
  // responses, with no additional non-prefetch request. The caller has already
  // verified the destination shell; every same-route RSC must still finish.
  const navigations = records.filter((record) => record.pathHash === pathHash && record.rsc === true);
  if (navigations.length === 0) return "pending";
  if (navigations.some((record) => record.state === "failed"
    || (record.responseStatus !== null && record.responseStatus !== 200)
    || (record.state === "finished" && record.flight !== true))) return "failed";
  return navigations.every((record) => record.state === "finished" && record.responseStatus === 200)
    ? "complete" : "pending";
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
    requestStarted(request, { navigationRequest = false, pathClass = null, resourceType = null } = {}) {
      inFlight.add(request);
      const committedRouteFetch = activeNavigation
        && activeNavigation.committed
        && !navigationRequest
        && resourceType === "fetch"
        && pathClass === activeNavigation.targetPathClass;
      if (activeNavigation && !navigationRequest && (!activeNavigation.committed || committedRouteFetch)) {
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
