import {
  applyPrototypePatch,
  assertPrototypePatchPayloadSize,
  canonicalJson,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
  prototypePatchCanonicalJson,
  type PrototypeDocument,
  type PrototypePatchDegradedReason,
  type PrototypePatchEventPayload,
  type RunEvent,
  type RunPrototypePatchCheckpoint,
} from "@workbench/workbench-contracts";

import type { PrototypePatchCheckpointTransport } from "../api-adapter";
import {
  PROTOTYPE_PATCH_QUEUE_MAX_BYTES,
  PROTOTYPE_PATCH_QUEUE_MAX_EVENTS,
  createPrototypePatchProjection,
  peekPrototypePatch,
  reducePrototypePatchProjection,
  type PrototypePatchProjectionIssue,
  type PrototypePatchProjectionPhase,
  type PrototypePatchProjectionState,
  type PrototypePatchQueueEvent,
} from "../domain";
import {
  PrototypeCheckpointRecoveryCoordinator,
  type PrototypeCheckpointRecoveryOptions,
} from "./recovery";

type PatchCreatedEvent = Extract<RunEvent, { type: "artifact.prototype.patch.created" }>;
type PatchDegradedEvent = Extract<RunEvent, { type: "artifact.prototype.patch.degraded" }>;
type ArtifactDraftEvent = Extract<RunEvent, { type: "artifact.draft.created" }>;

export type PrototypePatchProjectorScope = {
  attempt: number;
  projectId: string;
  requestId: string;
  runId: string;
};

export type PrototypePatchProjectionView = {
  artifactId: string;
  artifactIndex: number;
  artifactVersionId: string;
  checksum: string | null;
  documentChecksum: string | null;
  document: PrototypeDocument | null;
  issue: PrototypePatchProjectionIssue | null;
  phase: PrototypePatchProjectionPhase;
  revision: number | null;
  screenId: string;
};

export type PrototypePatchProjectorSnapshot = {
  projections: ReadonlyMap<string, PrototypePatchProjectionView>;
  revision: number;
  scope: PrototypePatchProjectorScope | null;
};

export type PrototypePatchProjectorErrorContext = {
  artifactVersionId?: string;
  eventId?: string;
  operation: "checkpoint" | "ingest" | "patch";
  screenId?: string;
};

export type PrototypePatchProjectorOptions = {
  onError?: (error: unknown, context: PrototypePatchProjectorErrorContext) => void;
  recovery?: PrototypeCheckpointRecoveryOptions;
  transport: PrototypePatchCheckpointTransport;
};

type StoredProjection = {
  coveredThroughSequence: number;
  state: PrototypePatchProjectionState<PrototypeDocument, PatchCreatedEvent>;
};

type PendingPatch = {
  byteSize: number;
  canonicalPayload: string;
  event: PatchCreatedEvent;
};

type ArtifactProjection = {
  artifactId: string;
  artifactIndex: number;
  artifactVersionId: string;
  document: PrototypeDocument | null;
  documentChecksum: string | null;
  draining: boolean;
  finalizing: boolean;
  inbox: PendingPatch[];
  inboxBytes: number;
  runtimeAttemptId: string | null;
  screens: Map<string, StoredProjection>;
};

const emptySnapshot: PrototypePatchProjectorSnapshot = {
  projections: new Map(),
  revision: 0,
  scope: null,
};

export class PrototypePatchProjectorStore {
  readonly #artifacts = new Map<string, ArtifactProjection>();
  readonly #listeners = new Set<() => void>();
  readonly #onError: PrototypePatchProjectorOptions["onError"];
  readonly #projectionListeners = new Map<string, Set<() => void>>();
  readonly #recovery: PrototypeCheckpointRecoveryCoordinator<RunPrototypePatchCheckpoint>;
  readonly #transport: PrototypePatchCheckpointTransport;
  #scope: PrototypePatchProjectorScope | null = null;
  #snapshot = emptySnapshot;

  constructor(options: PrototypePatchProjectorOptions) {
    this.#onError = options.onError;
    this.#recovery = new PrototypeCheckpointRecoveryCoordinator(options.recovery);
    this.#transport = options.transport;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): PrototypePatchProjectorSnapshot => this.#snapshot;

  subscribeProjection(
    artifactVersionId: string,
    screenId: string,
    listener: () => void,
  ): () => void {
    const key = prototypePatchProjectionKey(artifactVersionId, screenId);
    const listeners = this.#projectionListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.#projectionListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#projectionListeners.delete(key);
    };
  }

  getProjectionSnapshot(
    artifactVersionId: string,
    screenId: string,
  ): PrototypePatchProjectionView | null {
    return this.#snapshot.projections.get(
      prototypePatchProjectionKey(artifactVersionId, screenId),
    ) ?? null;
  }

  releaseFinalized(artifactVersionId: string): boolean {
    const artifact = this.#artifacts.get(artifactVersionId);
    if (
      !artifact
      || artifact.screens.size === 0
      || [...artifact.screens.values()].some((screen) => screen.state.phase !== "finalized")
    ) return false;
    return this.releaseReadyVersion(artifactVersionId);
  }

  // Call only after the authoritative ready ArtifactVersion is installed in Query.
  releaseReadyVersion(artifactVersionId: string): boolean {
    const artifact = this.#artifacts.get(artifactVersionId);
    if (!artifact) return false;
    const changedKeys = [...artifact.screens.keys()].map((screenId) => (
      prototypePatchProjectionKey(artifactVersionId, screenId)
    ));
    this.#recovery.abort(artifactVersionId);
    this.#artifacts.delete(artifactVersionId);
    this.#publish(changedKeys);
    return true;
  }

  setScope(scope: PrototypePatchProjectorScope | null): void {
    if (sameScope(this.#scope, scope)) return;
    this.#scope = scope ? { ...scope } : null;
    this.#artifacts.clear();
    this.#recovery.setScope(scopeKey(scope));
    this.#publish();
  }

  ingest(event: RunEvent): void {
    try {
      this.#ingest(event);
    } catch (error) {
      this.#report(error, { eventId: event.id, operation: "ingest" });
    }
  }

  dispose(): void {
    this.#scope = null;
    this.#artifacts.clear();
    this.#recovery.dispose();
    this.#listeners.clear();
    this.#projectionListeners.clear();
    this.#snapshot = emptySnapshot;
  }

  settleTerminal(status: "succeeded" | "failed" | "cancelled"): void {
    if (status !== "succeeded") {
      this.#discardAll();
      return;
    }
    for (const artifact of this.#artifacts.values()) {
      this.#startFinalization(artifact.artifactId, artifact.artifactVersionId);
    }
  }

  #ingest(event: RunEvent): void {
    const scope = this.#scope;
    if (!scope || !eventBelongsToScope(event, scope)) return;

    switch (event.type) {
      case "run.started":
        this.setScope({ ...scope, attempt: event.payload.attempt });
        return;
      case "artifact.draft.created":
        if (event.payload.kind === "prototype") this.#acceptDraftEvent(event);
        return;
      case "artifact.prototype.patch.created":
        this.#enqueuePatch(event);
        return;
      case "artifact.prototype.patch.degraded":
        this.#acceptDegradedEvent(event);
        return;
      case "artifact.version.created":
        this.#startFinalization(event.payload.artifactId, event.payload.artifactVersionId);
        return;
      case "run.completed":
        this.settleTerminal("succeeded");
        return;
      case "run.cancelled":
        this.settleTerminal("cancelled");
        return;
      case "run.failed":
        this.settleTerminal("failed");
        return;
      default:
        return;
    }
  }

  #acceptDraftEvent(event: ArtifactDraftEvent): void {
    const scope = this.#scope;
    if (!scope || event.payload.attempt !== scope.attempt) return;
    const artifact = this.#ensureArtifact({
      artifactId: event.payload.artifactId,
      artifactIndex: event.payload.artifactIndex,
      artifactVersionId: event.payload.artifactVersionId,
      runtimeAttemptId: null,
    });
    for (const screen of event.payload.screens) {
      this.#ensureScreen(artifact, screen.id);
    }
    const firstScreen = event.payload.screens[0];
    if (!firstScreen) return;
    this.#requestCheckpoint(artifact, firstScreen.id, false);
  }

  #enqueuePatch(event: PatchCreatedEvent): void {
    const scope = this.#scope;
    const payload = event.payload;
    if (!scope || payload.attempt !== scope.attempt) return;
    const artifact = this.#ensureArtifact(payload);
    const screen = this.#ensureScreen(artifact, payload.screenId);
    if (event.sequence <= screen.coveredThroughSequence) return;

    let byteSize: number;
    let canonicalPayload: string;
    try {
      byteSize = assertPrototypePatchPayloadSize(payload);
      canonicalPayload = prototypePatchCanonicalJson(payload);
    } catch (error) {
      screen.state = reducePrototypePatchProjection(screen.state, {
        type: "degraded",
        issue: "queue_overflow",
      });
      this.#publish([prototypePatchProjectionKey(
        artifact.artifactVersionId,
        payload.screenId,
      )]);
      this.#report(error, {
        artifactVersionId: payload.artifactVersionId,
        eventId: event.id,
        operation: "ingest",
        screenId: payload.screenId,
      });
      this.#requestCheckpoint(artifact, payload.screenId, false);
      return;
    }

    const pendingForScreen = artifact.inbox.filter(
      (item) => item.event.payload.screenId === payload.screenId,
    );
    const pendingBytes = pendingForScreen.reduce((total, item) => total + item.byteSize, 0);
    if (
      pendingForScreen.length + screen.state.queue.byBaseRevision.size >= PROTOTYPE_PATCH_QUEUE_MAX_EVENTS
      || pendingBytes + screen.state.queue.totalBytes + byteSize > PROTOTYPE_PATCH_QUEUE_MAX_BYTES
    ) {
      screen.state = reducePrototypePatchProjection(screen.state, {
        type: "degraded",
        issue: "queue_overflow",
      });
      this.#publish([prototypePatchProjectionKey(
        artifact.artifactVersionId,
        payload.screenId,
      )]);
      this.#requestCheckpoint(artifact, payload.screenId, false);
      return;
    }

    artifact.inbox.push({ byteSize, canonicalPayload, event });
    artifact.inboxBytes += byteSize;
    this.#drainArtifact(artifact);
  }

  #acceptDegradedEvent(event: PatchDegradedEvent): void {
    const scope = this.#scope;
    const payload = event.payload;
    if (!scope || payload.attempt !== scope.attempt) return;
    const artifact = this.#ensureArtifact(payload);
    const screen = this.#ensureScreen(artifact, payload.screenId);
    screen.state = reducePrototypePatchProjection(screen.state, {
      type: "degraded",
      issue: degradedIssue(payload.reason),
    });
    this.#publish([prototypePatchProjectionKey(
      artifact.artifactVersionId,
      payload.screenId,
    )]);
    this.#requestCheckpoint(artifact, payload.screenId, false);
  }

  #startFinalization(artifactId: string, artifactVersionId: string): void {
    const artifact = this.#artifacts.get(artifactVersionId);
    if (!artifact || artifact.artifactId !== artifactId || artifact.finalizing) return;
    artifact.finalizing = true;
    artifact.inbox = [];
    artifact.inboxBytes = 0;
    for (const screen of artifact.screens.values()) {
      screen.state = reducePrototypePatchProjection(screen.state, { type: "finalization_started" });
    }
    this.#publish();
    const firstScreen = artifact.screens.keys().next().value as string | undefined;
    if (firstScreen) this.#requestCheckpoint(artifact, firstScreen, true);
  }

  #ensureArtifact(input: {
    artifactId: string;
    artifactIndex: number;
    artifactVersionId: string;
    runtimeAttemptId?: string | null;
  }): ArtifactProjection {
    const current = this.#artifacts.get(input.artifactVersionId);
    if (current) {
      if (
        current.artifactId !== input.artifactId
        || current.artifactIndex !== input.artifactIndex
        || (
          input.runtimeAttemptId
          && current.runtimeAttemptId
          && current.runtimeAttemptId !== input.runtimeAttemptId
        )
      ) throw new Error("Prototype patch Artifact identity conflict");
      if (input.runtimeAttemptId && !current.runtimeAttemptId) {
        current.runtimeAttemptId = input.runtimeAttemptId;
      }
      return current;
    }
    const artifact: ArtifactProjection = {
      artifactId: input.artifactId,
      artifactIndex: input.artifactIndex,
      artifactVersionId: input.artifactVersionId,
      document: null,
      documentChecksum: null,
      draining: false,
      finalizing: false,
      inbox: [],
      inboxBytes: 0,
      runtimeAttemptId: input.runtimeAttemptId ?? null,
      screens: new Map(),
    };
    this.#artifacts.set(input.artifactVersionId, artifact);
    return artifact;
  }

  #ensureScreen(artifact: ArtifactProjection, screenId: string): StoredProjection {
    const current = artifact.screens.get(screenId);
    if (current) return current;
    const screen: StoredProjection = {
      state: createPrototypePatchProjection<PrototypeDocument, PatchCreatedEvent>(
        artifact.artifactVersionId,
        screenId,
      ),
      coveredThroughSequence: 0,
    };
    artifact.screens.set(screenId, screen);
    return screen;
  }

  #drainArtifact(artifact: ArtifactProjection): void {
    if (artifact.draining || artifact.finalizing) return;
    artifact.draining = true;
    void this.#drainArtifactQueue(artifact).catch((error: unknown) => {
      this.#report(error, {
        artifactVersionId: artifact.artifactVersionId,
        operation: "patch",
      });
    }).finally(() => {
      artifact.draining = false;
      if (
        this.#artifacts.get(artifact.artifactVersionId) === artifact
        && !artifact.finalizing
        && artifact.inbox.length > 0
      ) this.#drainArtifact(artifact);
    });
  }

  async #drainArtifactQueue(artifact: ArtifactProjection): Promise<void> {
    while (
      this.#artifacts.get(artifact.artifactVersionId) === artifact
      && !artifact.finalizing
      && artifact.inbox.length > 0
    ) {
      const pending = artifact.inbox[0]!;
      const fingerprint = await sha256Digest(pending.canonicalPayload);
      if (artifact.inbox[0] === pending) {
        artifact.inbox.shift();
        artifact.inboxBytes = Math.max(0, artifact.inboxBytes - pending.byteSize);
      }
      const screen = artifact.screens.get(pending.event.payload.screenId);
      if (!screen || pending.event.sequence <= screen.coveredThroughSequence) continue;
      const queuedEvent: PrototypePatchQueueEvent<PatchCreatedEvent> = {
        baseRevision: pending.event.payload.baseRevision,
        byteSize: pending.byteSize,
        eventId: pending.event.id,
        fingerprint,
        nextRevision: pending.event.payload.nextRevision,
        payload: pending.event,
        sourceEventId: pending.event.payload.sourceEventId,
      };
      const previous = screen.state;
      screen.state = reducePrototypePatchProjection(screen.state, {
        type: "patch_offered",
        event: queuedEvent,
      });
      if (screen.state !== previous) {
        this.#publish([prototypePatchProjectionKey(
          artifact.artifactVersionId,
          screen.state.screenId,
        )]);
      }
      if (screen.state.phase === "recovering") {
        this.#requestCheckpoint(artifact, screen.state.screenId, false);
      }
      if (artifact.document === null) {
        this.#requestCheckpoint(artifact, screen.state.screenId, false);
      } else {
        const applied = await this.#applyAvailablePatches(artifact);
        if (!applied) return;
      }
    }
    if (artifact.document !== null && !artifact.finalizing) {
      await this.#applyAvailablePatches(artifact);
    }
  }

  async #applyAvailablePatches(artifact: ArtifactProjection): Promise<boolean> {
    while (artifact.document !== null && !artifact.finalizing) {
      const candidate = nextPatchCandidate(artifact.screens);
      if (!candidate) return true;
      const event = candidate.patch.payload;
      const payload = event.payload;
      let applied: ReturnType<typeof applyPrototypePatch>;
      try {
        applied = applyPrototypePatch(artifact.document, patchBatch(payload));
      } catch (error) {
        this.#failPatch(artifact, candidate.screen, event, "apply_failed", error);
        return false;
      }
      const checksum = await computePrototypeScreenProjectionChecksum(
        applied.projection,
        sha256Digest,
      );
      if (
        this.#artifacts.get(artifact.artifactVersionId) !== artifact
        || artifact.finalizing
        || candidate.screen.state.revision !== payload.baseRevision
        || peekPrototypePatch(candidate.screen.state.queue, payload.baseRevision)?.payload !== event
      ) return false;
      if (checksum !== payload.resultingChecksum) {
        this.#failPatch(artifact, candidate.screen, event, "checksum_mismatch", new Error(
          "Prototype patch resulting checksum mismatch",
        ));
        return false;
      }

      artifact.document = applied.document;
      artifact.documentChecksum = null;
      candidate.screen.state = reducePrototypePatchProjection(candidate.screen.state, {
        type: "patch_applied",
        baseRevision: payload.baseRevision,
        checksum,
        document: applied.document,
        nextRevision: payload.nextRevision,
      });
      candidate.screen.coveredThroughSequence = Math.max(
        candidate.screen.coveredThroughSequence,
        event.sequence,
      );
      for (const screen of artifact.screens.values()) {
        if (screen === candidate.screen) continue;
        screen.state = reducePrototypePatchProjection(screen.state, {
          type: "document_reconciled",
          document: applied.document,
        });
      }
      this.#publish([prototypePatchProjectionKey(
        artifact.artifactVersionId,
        candidate.screen.state.screenId,
      )]);
    }
    return true;
  }

  #failPatch(
    artifact: ArtifactProjection,
    screen: StoredProjection,
    event: PatchCreatedEvent,
    issue: "apply_failed" | "checksum_mismatch",
    error: unknown,
  ): void {
    screen.state = reducePrototypePatchProjection(screen.state, {
      type: "patch_failed",
      baseRevision: event.payload.baseRevision,
      issue,
    });
    this.#publish([prototypePatchProjectionKey(
      artifact.artifactVersionId,
      screen.state.screenId,
    )]);
    this.#report(error, {
      artifactVersionId: artifact.artifactVersionId,
      eventId: event.id,
      operation: "patch",
      screenId: screen.state.screenId,
    });
    this.#requestCheckpoint(artifact, screen.state.screenId, false);
  }

  #requestCheckpoint(
    artifact: ArtifactProjection,
    screenId: string,
    requireReady: boolean,
  ): void {
    const scope = this.#scope;
    const screen = artifact.screens.get(screenId);
    if (!scope || !screen) return;
    if (!requireReady) {
      screen.state = reducePrototypePatchProjection(screen.state, { type: "checkpoint_requested" });
      this.#publish([prototypePatchProjectionKey(
        artifact.artifactVersionId,
        screenId,
      )]);
    }
    const capturedScope = scopeKey(scope);
    const waitsForActiveCheckpoint = requireReady
      && this.#recovery.isRecovering(artifact.artifactVersionId);
    void this.#recovery.recover(
      artifact.artifactVersionId,
      async (signal) => {
        const checkpoint = await this.#transport.getCheckpoint(
          scope.runId,
          artifact.artifactVersionId,
          signal,
        );
        await this.#acceptCheckpoint(artifact, checkpoint, requireReady, capturedScope);
        return checkpoint;
      },
    ).then((result) => {
      if (
        result.kind === "aborted"
        || result.kind === "stale"
        || scopeKey(this.#scope) !== capturedScope
        || this.#artifacts.get(artifact.artifactVersionId) !== artifact
      ) return;
      if (waitsForActiveCheckpoint) {
        const finalized = [...artifact.screens.values()].every(
          (candidate) => candidate.state.phase === "finalized",
        );
        if (!finalized) this.#requestCheckpoint(artifact, screenId, true);
        return;
      }
      if (result.kind === "failed") {
        this.#checkpointFailed(artifact, screenId, result.error);
      }
    }).catch((error: unknown) => {
      this.#checkpointFailed(artifact, screenId, error);
    });
  }

  async #acceptCheckpoint(
    artifact: ArtifactProjection,
    checkpoint: RunPrototypePatchCheckpoint,
    requireReady: boolean,
    capturedScope: string,
  ): Promise<void> {
    const scope = this.#scope;
    if (
      !scope
      || scopeKey(scope) !== capturedScope
      || checkpoint.projectId !== scope.projectId
      || checkpoint.runId !== scope.runId
      || checkpoint.requestId !== scope.requestId
      || checkpoint.attempt !== scope.attempt
      || checkpoint.artifactId !== artifact.artifactId
      || checkpoint.artifactVersionId !== artifact.artifactVersionId
      || checkpoint.artifactIndex !== artifact.artifactIndex
      || checkpoint.status === "rejected"
      || (requireReady && checkpoint.status !== "ready")
      || (
        artifact.runtimeAttemptId !== null
        && checkpoint.runtimeAttemptId !== artifact.runtimeAttemptId
      )
    ) throw new Error("Prototype patch checkpoint identity conflict");

    const [documentChecksum, screenChecksums] = await Promise.all([
      sha256Digest(canonicalJson(checkpoint.document)),
      Promise.all(checkpoint.screens.map(async (screen) => ({
        ...screen,
        actualChecksum: await computePrototypeScreenProjectionChecksum(
          projectPrototypeScreen(checkpoint.document, screen.screenId, screen.revision),
          sha256Digest,
        ),
      }))),
    ]);
    if (
      scopeKey(this.#scope) !== capturedScope
      || this.#artifacts.get(artifact.artifactVersionId) !== artifact
    ) return;
    if (documentChecksum !== checkpoint.documentChecksum) {
      throw new Error("Prototype patch checkpoint document checksum mismatch");
    }
    const byScreen = new Map(screenChecksums.map((screen) => [screen.screenId, screen]));
    if (
      checkpoint.document.screens.length !== byScreen.size
      || screenChecksums.some((screen) => screen.actualChecksum !== screen.checksum)
      || checkpoint.document.screens.some((screen) => !byScreen.has(screen.id))
    ) throw new Error("Prototype patch checkpoint screen checksum mismatch");

    artifact.document = checkpoint.document;
    artifact.documentChecksum = checkpoint.documentChecksum;
    artifact.runtimeAttemptId = checkpoint.runtimeAttemptId;
    artifact.inbox = artifact.inbox.filter((pending) => {
      if (pending.event.sequence > checkpoint.lastSequence) return true;
      artifact.inboxBytes = Math.max(0, artifact.inboxBytes - pending.byteSize);
      return false;
    });
    const checkpointScreenIds = new Set(screenChecksums.map((screen) => screen.screenId));
    for (const screenId of artifact.screens.keys()) {
      if (!checkpointScreenIds.has(screenId)) artifact.screens.delete(screenId);
    }
    for (const screenCheckpoint of screenChecksums) {
      const screen = this.#ensureScreen(artifact, screenCheckpoint.screenId);
      screen.coveredThroughSequence = Math.max(
        screen.coveredThroughSequence,
        checkpoint.lastSequence,
      );
      screen.state = reducePrototypePatchProjection(screen.state, checkpoint.status === "ready"
        ? {
            type: "finalization_accepted",
            checksum: screenCheckpoint.checksum,
            document: checkpoint.document,
            revision: screenCheckpoint.revision,
          }
        : {
            type: "checkpoint_accepted",
            checksum: screenCheckpoint.checksum,
            document: checkpoint.document,
            revision: screenCheckpoint.revision,
          });
    }
    if (checkpoint.status === "ready") artifact.finalizing = true;
    this.#publish();
    if (!artifact.finalizing) this.#drainArtifact(artifact);
  }

  #checkpointFailed(artifact: ArtifactProjection, screenId: string, error: unknown): void {
    if (this.#artifacts.get(artifact.artifactVersionId) !== artifact) return;
    const screen = artifact.screens.get(screenId);
    if (screen) {
      screen.state = reducePrototypePatchProjection(
        screen.state,
        artifact.finalizing
          ? { type: "finalization_failed" }
          : { type: "checkpoint_failed" },
      );
      this.#publish([prototypePatchProjectionKey(
        artifact.artifactVersionId,
        screenId,
      )]);
    }
    this.#report(error, {
      artifactVersionId: artifact.artifactVersionId,
      operation: "checkpoint",
      screenId,
    });
  }

  #discardAll(): void {
    for (const artifact of this.#artifacts.values()) {
      this.#recovery.abort(artifact.artifactVersionId);
      for (const screen of artifact.screens.values()) {
        screen.state = reducePrototypePatchProjection(screen.state, { type: "discarded" });
      }
    }
    this.#artifacts.clear();
    this.#publish();
  }

  #publish(changedProjectionKeys?: Iterable<string>): void {
    const projections = new Map<string, PrototypePatchProjectionView>();
    for (const artifact of this.#artifacts.values()) {
      for (const screen of artifact.screens.values()) {
        const key = prototypePatchProjectionKey(artifact.artifactVersionId, screen.state.screenId);
        const next: PrototypePatchProjectionView = {
          artifactId: artifact.artifactId,
          artifactIndex: artifact.artifactIndex,
          artifactVersionId: artifact.artifactVersionId,
          checksum: screen.state.checksum,
          documentChecksum: artifact.documentChecksum,
          document: screen.state.document,
          issue: screen.state.issue,
          phase: screen.state.phase,
          revision: screen.state.revision,
          screenId: screen.state.screenId,
        };
        const previous = this.#snapshot.projections.get(key);
        projections.set(key, previous && sameProjectionView(previous, next) ? previous : next);
      }
    }
    this.#snapshot = {
      projections,
      revision: this.#snapshot.revision + 1,
      scope: this.#scope ? { ...this.#scope } : null,
    };
    for (const listener of this.#listeners) listener();
    const changedKeys = changedProjectionKeys
      ? new Set(changedProjectionKeys)
      : new Set(this.#projectionListeners.keys());
    for (const key of changedKeys) {
      for (const listener of this.#projectionListeners.get(key) ?? []) listener();
    }
  }

  #report(error: unknown, context: PrototypePatchProjectorErrorContext): void {
    try {
      this.#onError?.(error, context);
    } catch {
      // Observability cannot affect Run stream consumption.
    }
  }
}

function sameProjectionView(
  left: PrototypePatchProjectionView,
  right: PrototypePatchProjectionView,
): boolean {
  return left.artifactId === right.artifactId
    && left.artifactIndex === right.artifactIndex
    && left.artifactVersionId === right.artifactVersionId
    && left.checksum === right.checksum
    && left.documentChecksum === right.documentChecksum
    && left.document === right.document
    && left.issue === right.issue
    && left.phase === right.phase
    && left.revision === right.revision
    && left.screenId === right.screenId;
}

let sha256Loader: Promise<(value: string) => Promise<string>> | null = null;

function sha256Digest(value: string): Promise<string> {
  sha256Loader ??= import("hash-wasm").then((module) => module.sha256);
  return sha256Loader.then((digest) => digest(value));
}

export function prototypePatchProjectionKey(artifactVersionId: string, screenId: string): string {
  return `${artifactVersionId}\u0000${screenId}`;
}

export function findPrototypePatchProjection(
  snapshot: PrototypePatchProjectorSnapshot,
  artifactVersionId: string,
  screenId: string | undefined,
): PrototypePatchProjectionView | null {
  if (!screenId) return null;
  return snapshot.projections.get(prototypePatchProjectionKey(artifactVersionId, screenId)) ?? null;
}

function nextPatchCandidate(screens: ReadonlyMap<string, StoredProjection>): {
  patch: PrototypePatchQueueEvent<PatchCreatedEvent>;
  screen: StoredProjection;
} | null {
  let selected: { patch: PrototypePatchQueueEvent<PatchCreatedEvent>; screen: StoredProjection } | null = null;
  for (const screen of screens.values()) {
    if (screen.state.revision === null) continue;
    const patch = peekPrototypePatch(screen.state.queue, screen.state.revision);
    if (!patch) continue;
    if (!selected || patch.payload.sequence < selected.patch.payload.sequence) {
      selected = { patch, screen };
    }
  }
  return selected;
}

function patchBatch(payload: PrototypePatchEventPayload) {
  return {
    screenId: payload.screenId,
    baseRevision: payload.baseRevision,
    nextRevision: payload.nextRevision,
    operations: payload.operations,
    resultingChecksum: payload.resultingChecksum,
  };
}

function degradedIssue(reason: PrototypePatchDegradedReason): PrototypePatchProjectionIssue {
  switch (reason) {
    case "revision_gap": return "revision_gap";
    case "checksum_mismatch": return "checksum_mismatch";
    case "buffer_limit_exceeded": return "queue_overflow";
    case "checkpoint_unavailable": return "checkpoint_failed";
    case "patch_rejected": return "apply_failed";
  }
}

function eventBelongsToScope(event: RunEvent, scope: PrototypePatchProjectorScope): boolean {
  return event.projectId === scope.projectId
    && event.runId === scope.runId
    && event.requestId === scope.requestId;
}

function sameScope(
  left: PrototypePatchProjectorScope | null,
  right: PrototypePatchProjectorScope | null,
): boolean {
  return left?.attempt === right?.attempt
    && left?.projectId === right?.projectId
    && left?.requestId === right?.requestId
    && left?.runId === right?.runId;
}

function scopeKey(scope: PrototypePatchProjectorScope | null): string {
  return scope
    ? `${scope.projectId}\u0000${scope.runId}\u0000${scope.requestId}\u0000${scope.attempt}`
    : "none";
}
