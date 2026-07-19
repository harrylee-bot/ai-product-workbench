import {
  createPrototypePatchQueue,
  discardPrototypePatchesThrough,
  offerPrototypePatch,
  removePrototypePatch,
  type PrototypePatchQueue,
  type PrototypePatchQueueConflictReason,
  type PrototypePatchQueueEvent,
} from "./queue";

export type PrototypePatchProjectionPhase =
  | "empty"
  | "checkpoint_loading"
  | "live"
  | "recovering"
  | "finalizing"
  | "finalized"
  | "discarded";

export type PrototypePatchProjectionIssue =
  | PrototypePatchQueueConflictReason
  | "apply_failed"
  | "checksum_mismatch"
  | "checkpoint_failed"
  | "finalization_failed"
  | "queue_overflow"
  | "revision_gap"
  | "terminal_event_conflict";

export type PrototypePatchProjectionState<TDocument, TPayload> = {
  artifactVersionId: string;
  checksum: string | null;
  document: TDocument | null;
  issue: PrototypePatchProjectionIssue | null;
  phase: PrototypePatchProjectionPhase;
  queue: PrototypePatchQueue<TPayload>;
  revision: number | null;
  screenId: string;
};

export type PrototypePatchProjectionAction<TDocument, TPayload> =
  | { type: "checkpoint_requested" }
  | { type: "checkpoint_accepted"; checksum: string; document: TDocument; revision: number }
  | { type: "checkpoint_failed" }
  | { type: "degraded"; issue: PrototypePatchProjectionIssue }
  | { type: "patch_offered"; event: PrototypePatchQueueEvent<TPayload> }
  | {
      type: "patch_applied";
      baseRevision: number;
      checksum: string;
      document: TDocument;
      nextRevision: number;
    }
  | {
      type: "patch_failed";
      baseRevision: number;
      issue: "apply_failed" | "checksum_mismatch";
    }
  | { type: "document_reconciled"; document: TDocument }
  | { type: "finalization_started" }
  | { type: "finalization_failed" }
  | {
      type: "finalization_accepted";
      checksum: string;
      document: TDocument;
      revision: number;
    }
  | { type: "discarded" };

export function createPrototypePatchProjection<TDocument, TPayload>(
  artifactVersionId: string,
  screenId: string,
): PrototypePatchProjectionState<TDocument, TPayload> {
  if (!artifactVersionId || !screenId) throw new TypeError("Prototype patch projection key is invalid");
  return {
    artifactVersionId,
    checksum: null,
    document: null,
    issue: null,
    phase: "empty",
    queue: createPrototypePatchQueue(),
    revision: null,
    screenId,
  };
}

export function reducePrototypePatchProjection<TDocument, TPayload>(
  state: PrototypePatchProjectionState<TDocument, TPayload>,
  action: PrototypePatchProjectionAction<TDocument, TPayload>,
): PrototypePatchProjectionState<TDocument, TPayload> {
  switch (action.type) {
    case "checkpoint_requested":
      if (
        state.phase === "discarded"
        || state.phase === "finalized"
        || state.phase === "finalizing"
      ) return state;
      return {
        ...state,
        issue: state.issue,
        phase: state.document === null ? "checkpoint_loading" : "recovering",
      };
    case "checkpoint_accepted":
      if (state.phase === "discarded" || state.phase === "finalized") return state;
      return {
        ...state,
        checksum: action.checksum,
        document: action.document,
        issue: null,
        phase: state.phase === "finalizing" ? "finalizing" : "live",
        queue: discardPrototypePatchesThrough(state.queue, action.revision),
        revision: action.revision,
      };
    case "checkpoint_failed":
      if (
        state.phase === "discarded"
        || state.phase === "finalized"
        || state.phase === "finalizing"
      ) return state;
      return { ...state, issue: "checkpoint_failed", phase: "recovering" };
    case "degraded":
      if (
        state.phase === "discarded"
        || state.phase === "finalized"
        || state.phase === "finalizing"
      ) return state;
      return { ...state, issue: action.issue, phase: "recovering" };
    case "patch_offered": {
      if (state.phase === "discarded" || state.phase === "finalized" || state.phase === "finalizing") {
        return { ...state, issue: "terminal_event_conflict" };
      }
      const result = offerPrototypePatch(state.queue, state.revision ?? 0, action.event);
      if (result.kind === "duplicate") return result.queue === state.queue ? state : { ...state, queue: result.queue };
      if (result.kind === "conflict") {
        return { ...state, issue: result.reason, phase: "recovering", queue: result.queue };
      }
      if (result.kind === "overflow") {
        return { ...state, issue: "queue_overflow", phase: "recovering", queue: result.queue };
      }
      const revision = state.revision;
      const gap = revision !== null && action.event.baseRevision > revision;
      return {
        ...state,
        issue: gap ? "revision_gap" : state.issue,
        phase: gap ? "recovering" : state.phase,
        queue: result.queue,
      };
    }
    case "patch_applied":
      if (
        state.phase === "discarded"
        || state.phase === "finalized"
        || state.phase === "finalizing"
        || state.revision === null
        || state.revision !== action.baseRevision
        || action.nextRevision !== action.baseRevision + 1
      ) return state;
      return {
        ...state,
        checksum: action.checksum,
        document: action.document,
        issue: null,
        phase: "live",
        queue: removePrototypePatch(state.queue, action.baseRevision),
        revision: action.nextRevision,
      };
    case "patch_failed":
      if (
        state.phase === "discarded"
        || state.phase === "finalized"
        || state.phase === "finalizing"
      ) return state;
      return {
        ...state,
        issue: action.issue,
        phase: "recovering",
        queue: removePrototypePatch(state.queue, action.baseRevision),
      };
    case "document_reconciled":
      if (state.document === null || state.phase === "discarded") return state;
      return { ...state, document: action.document };
    case "finalization_started":
      if (state.phase === "discarded" || state.phase === "finalized") return state;
      return { ...state, phase: "finalizing" };
    case "finalization_failed":
      if (state.phase !== "finalizing") return state;
      return { ...state, issue: "finalization_failed" };
    case "finalization_accepted":
      if (state.phase === "discarded") return state;
      return {
        ...state,
        checksum: action.checksum,
        document: action.document,
        issue: null,
        phase: "finalized",
        queue: createPrototypePatchQueue(),
        revision: action.revision,
      };
    case "discarded":
      return {
        ...state,
        checksum: null,
        document: null,
        issue: null,
        phase: "discarded",
        queue: createPrototypePatchQueue(),
        revision: null,
      };
  }
}
