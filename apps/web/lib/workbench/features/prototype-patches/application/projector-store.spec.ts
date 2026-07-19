import {
  applyPrototypePatch,
  canonicalJson,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
  runEventSchema,
  type PrototypeDocument,
  type PrototypePatchBatch,
  type RunEvent,
  type RunPrototypePatchCheckpoint,
} from "@workbench/workbench-contracts";
import { sha256 } from "hash-wasm";
import { describe, expect, it, vi } from "vitest";

import { prototypeEditorDocumentFixture } from "../../../prototype-editor/test-fixtures";
import type { PrototypePatchCheckpointTransport } from "../api-adapter";
import {
  PrototypePatchProjectorStore,
  findPrototypePatchProjection,
} from "./projector-store";

const scope = {
  attempt: 1,
  projectId: "project-1",
  requestId: "request-1",
  runId: "run-1",
};

describe("Prototype patch projector store", () => {
  it("loads one staging checkpoint and atomically applies a contract patch", async () => {
    const document = prototypeEditorDocumentFixture();
    const transport = queuedTransport([await checkpoint(document, 0, 1)]);
    const store = new PrototypePatchProjectorStore({ transport });
    store.setScope(scope);
    store.ingest(await draftEvent(document, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");

    const patch = await patchEvent(document, 0, 2, "Patched copy");
    expect(() => store.ingest(patch)).not.toThrow();
    const projection = await waitForProjection(store, (value) => value.revision === 1);

    expect(projection.phase).toBe("live");
    expect(projection.document?.nodes.find((node) => node.id === "node-label"))
      .toMatchObject({ kind: "text", text: "Patched copy" });
    expect(transport.getCheckpoint).toHaveBeenCalledOnce();
  });

  it("loads a complete multi-screen Artifact checkpoint without a screen filter", async () => {
    const document = multiScreenDocumentFixture();
    const transport = queuedTransport([await checkpoint(document, 0, 1)]);
    const store = new PrototypePatchProjectorStore({ transport });
    store.setScope(scope);
    store.ingest(await draftEvent(document, 1));

    await waitForProjection(store, (projection) => projection.phase === "live");
    const details = findPrototypePatchProjection(
      store.getSnapshot(),
      "version-1",
      "screen-details",
    );
    expect(details).toMatchObject({ phase: "live", revision: 0 });
    expect(details?.document?.screens).toHaveLength(2);
    const [runId, artifactVersionId, signal, screenId] = transport.getCheckpoint.mock.calls[0]!;
    expect(runId).toBe(scope.runId);
    expect(artifactVersionId).toBe("version-1");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(screenId).toBeUndefined();
  });

  it("ignores replay events already covered by an ahead checkpoint lastSequence", async () => {
    const document = prototypeEditorDocumentFixture();
    const transport = queuedTransport([await checkpoint(document, 0, 5)]);
    const store = new PrototypePatchProjectorStore({ transport });
    store.setScope(scope);
    store.ingest(await draftEvent(document, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");

    store.ingest(await patchEvent(document, 0, 3, "Already checkpointed"));
    await flushTasks();

    const projection = selectedProjection(store);
    expect(projection).toMatchObject({ issue: null, phase: "live", revision: 0 });
    expect(projection.document?.nodes.find((node) => node.id === "node-label"))
      .toMatchObject({ kind: "text", text: "Prototype" });
    expect(transport.getCheckpoint).toHaveBeenCalledOnce();
  });

  it("keeps last-good content and recovers after a resulting checksum mismatch", async () => {
    const document = prototypeEditorDocumentFixture();
    const recovery = deferred<RunPrototypePatchCheckpoint>();
    const transport = queuedTransport([
      await checkpoint(document, 0, 1),
      recovery.promise,
    ]);
    const errors: unknown[] = [];
    const store = new PrototypePatchProjectorStore({
      transport,
      onError: (error) => errors.push(error),
    });
    store.setScope(scope);
    store.ingest(await draftEvent(document, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");
    const invalid = await patchEvent(document, 0, 2, "Rejected copy");
    invalid.payload.resultingChecksum = "f".repeat(64);

    store.ingest(invalid);
    const recovering = await waitForProjection(
      store,
      (projection) => projection.issue === "checksum_mismatch",
    );

    expect(recovering.phase).toBe("recovering");
    expect(recovering.document?.nodes.find((node) => node.id === "node-label"))
      .toMatchObject({ kind: "text", text: "Prototype" });
    expect(errors).toHaveLength(1);
    recovery.resolve(await checkpoint(document, 0, 2));
    await waitForProjection(store, (projection) => projection.phase === "live");
  });

  it("keeps last-good visible while ready finalization is pending, then converges once", async () => {
    const staging = prototypeEditorDocumentFixture();
    const ready = structuredClone(staging);
    ready.nodes = ready.nodes.map((node) => node.id === "node-label" && node.kind === "text"
      ? { ...node, text: "Ready copy" }
      : node);
    const readyCheckpoint = deferred<RunPrototypePatchCheckpoint>();
    const transport = queuedTransport([
      await checkpoint(staging, 0, 1),
      readyCheckpoint.promise,
    ]);
    const store = new PrototypePatchProjectorStore({ transport });
    store.setScope(scope);
    store.ingest(await draftEvent(staging, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");

    store.ingest(event(2, "artifact.version.created", {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      version: 1,
    }));
    const finalizing = selectedProjection(store);
    expect(finalizing).toMatchObject({ phase: "finalizing" });
    expect(finalizing.document?.nodes.find((node) => node.id === "node-label"))
      .toMatchObject({ kind: "text", text: "Prototype" });

    readyCheckpoint.resolve(await checkpoint(ready, 1, 2, "ready"));
    const finalized = await waitForProjection(store, (projection) => projection.phase === "finalized");
    expect(finalized.document?.nodes.find((node) => node.id === "node-label"))
      .toMatchObject({ kind: "text", text: "Ready copy" });
    const released = vi.fn();
    store.subscribeProjection("version-1", "screen-main", released);
    expect(store.releaseFinalized("version-1")).toBe(true);
    expect(store.getProjectionSnapshot("version-1", "screen-main")).toBeNull();
    expect(released).toHaveBeenCalledOnce();
    expect(store.releaseFinalized("version-1")).toBe(false);
  });

  it("retries a non-ready final checkpoint within the recovery attempt bound", async () => {
    const staging = prototypeEditorDocumentFixture();
    const ready = structuredClone(staging);
    const label = ready.nodes.find((node) => node.id === "node-label");
    if (!label || label.kind !== "text") throw new Error("label fixture missing");
    label.text = "Eventually ready";
    const transport = queuedTransport([
      await checkpoint(staging, 0, 1),
      await checkpoint(staging, 0, 2, "staging"),
      await checkpoint(ready, 1, 2, "ready"),
    ]);
    const store = new PrototypePatchProjectorStore({
      recovery: { initialDelayMs: 0 },
      transport,
    });
    store.setScope(scope);
    store.ingest(await draftEvent(staging, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");

    store.ingest(event(2, "artifact.version.created", {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      version: 1,
    }));

    const finalized = await waitForProjection(store, (projection) => (
      projection.phase === "finalized"
    ));
    expect(finalized.document?.nodes.find((node) => node.id === "node-label"))
      .toMatchObject({ kind: "text", text: "Eventually ready" });
    expect(transport.getCheckpoint).toHaveBeenCalledTimes(3);
  });

  it("keeps last-good content and reports finalization failure after retries are exhausted", async () => {
    const staging = prototypeEditorDocumentFixture();
    const initialCheckpoint = await checkpoint(staging, 0, 1);
    const checkpointError = new Error("ready checkpoint unavailable");
    let calls = 0;
    const transport: PrototypePatchCheckpointTransport & {
      getCheckpoint: ReturnType<typeof vi.fn>;
    } = {
      getCheckpoint: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return initialCheckpoint;
        throw checkpointError;
      }),
    };
    const errors: unknown[] = [];
    const store = new PrototypePatchProjectorStore({
      onError: (error) => errors.push(error),
      recovery: { initialDelayMs: 0, maxAttempts: 3 },
      transport,
    });
    store.setScope(scope);
    store.ingest(await draftEvent(staging, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");

    store.ingest(event(2, "artifact.version.created", {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      version: 1,
    }));

    const failed = await waitForProjection(store, (projection) => (
      projection.issue === "finalization_failed"
    ));
    expect(failed).toMatchObject({ phase: "finalizing", revision: 0 });
    expect(failed.document?.nodes.find((node) => node.id === "node-label"))
      .toMatchObject({ kind: "text", text: "Prototype" });
    expect(transport.getCheckpoint).toHaveBeenCalledTimes(4);
    expect(errors).toEqual([checkpointError]);
  });

  it("adopts the complete ready revision map and removes screens absent from the checkpoint", async () => {
    const staging = multiScreenDocumentFixture();
    const ready = prototypeEditorDocumentFixture();
    const readyValue = await checkpoint(ready, { "screen-main": 7 }, 2, "ready");
    const transport = queuedTransport([
      await checkpoint(staging, { "screen-details": 4, "screen-main": 1 }, 1),
      readyValue,
    ]);
    const store = new PrototypePatchProjectorStore({ transport });
    store.setScope(scope);
    store.ingest(await draftEvent(staging, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");
    expect(findPrototypePatchProjection(store.getSnapshot(), "version-1", "screen-details"))
      .toMatchObject({ revision: 4 });

    store.ingest(event(2, "artifact.version.created", {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      version: 1,
    }));

    const finalized = await waitForProjection(store, (projection) => projection.phase === "finalized");
    expect(finalized).toMatchObject({
      documentChecksum: readyValue.documentChecksum,
      revision: 7,
    });
    expect(findPrototypePatchProjection(store.getSnapshot(), "version-1", "screen-details"))
      .toBeNull();
  });

  it("aborts and fences a late checkpoint when the Project/Run scope changes", async () => {
    const pending = deferred<RunPrototypePatchCheckpoint>();
    let signal: AbortSignal | undefined;
    const transport: PrototypePatchCheckpointTransport = {
      getCheckpoint: vi.fn((_runId, _versionId, value) => {
        signal = value;
        return pending.promise;
      }),
    };
    const store = new PrototypePatchProjectorStore({ transport });
    const document = prototypeEditorDocumentFixture();
    store.setScope(scope);
    store.ingest(await draftEvent(document, 1));
    store.setScope({ ...scope, projectId: "project-2", runId: "run-2" });
    expect(signal?.aborted).toBe(true);

    pending.resolve(await checkpoint(document, 0, 1));
    await flushTasks();
    expect(store.getSnapshot().projections.size).toBe(0);
  });

  it("clears every staging projection on cancel or failure while waiting_input is retained", async () => {
    const document = prototypeEditorDocumentFixture();
    const transport = queuedTransport([await checkpoint(document, 0, 1)]);
    const store = new PrototypePatchProjectorStore({ transport });
    store.setScope(scope);
    store.ingest(await draftEvent(document, 1));
    await waitForProjection(store, (projection) => projection.phase === "live");

    store.ingest(event(2, "run.input.required", {
      approvalId: "approval-1",
      kind: "choice",
      prompt: "Choose",
      options: [{ id: "a", label: "A", description: null, value: "a" }],
      attempt: 1,
    }));
    expect(store.getSnapshot().projections.size).toBe(1);

    store.ingest(event(3, "run.cancelled", { reason: "Stopped" }));
    expect(store.getSnapshot().projections.size).toBe(0);
  });
});

async function checkpoint(
  document: PrototypeDocument,
  revision: number | Readonly<Record<string, number>>,
  lastSequence: number,
  status: "staging" | "ready" = "staging",
): Promise<RunPrototypePatchCheckpoint> {
  return {
    protocol: "workbench.prototype-patch-checkpoint.v1",
    ...scope,
    runtimeAttemptId: "runtime-attempt-1",
    artifactIndex: 0,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    status,
    document,
    documentChecksum: await sha256(canonicalJson(document)),
    screens: await Promise.all(document.screens.map(async (screen) => ({
      screenId: screen.id,
      revision: typeof revision === "number" ? revision : revision[screen.id] ?? 0,
      checksum: await computePrototypeScreenProjectionChecksum(
        projectPrototypeScreen(
          document,
          screen.id,
          typeof revision === "number" ? revision : revision[screen.id] ?? 0,
        ),
        sha256,
      ),
    }))),
    lastSequence,
  };
}

async function draftEvent(document: PrototypeDocument, sequence: number): Promise<RunEvent> {
  const value = await checkpoint(document, 0, sequence);
  return event(sequence, "artifact.draft.created", {
    attempt: 1,
    artifactIndex: 0,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    kind: "prototype",
    checksum: value.documentChecksum,
    draftChecksum: "d".repeat(64),
    screens: document.screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      route: screen.route,
      viewport: screen.viewport,
      revision: 0,
      checksum: value.screens.find((candidate) => candidate.screenId === screen.id)!.checksum,
    })),
  });
}

async function patchEvent(
  document: PrototypeDocument,
  baseRevision: number,
  sequence: number,
  text: string,
) {
  const current = document.nodes.find((node) => node.id === "node-label");
  if (!current || current.kind !== "text") throw new Error("label fixture missing");
  const batch: PrototypePatchBatch = {
    screenId: "screen-main",
    baseRevision,
    nextRevision: baseRevision + 1,
    operations: [{
      kind: "replace_node",
      nodeId: current.id,
      node: { ...current, text },
    }],
    resultingChecksum: "0".repeat(64),
  };
  const applied = applyPrototypePatch(document, batch);
  batch.resultingChecksum = await computePrototypeScreenProjectionChecksum(applied.projection, sha256);
  return event(sequence, "artifact.prototype.patch.created", {
    attempt: 1,
    runtimeAttemptId: "runtime-attempt-1",
    artifactIndex: 0,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    sourceEventId: `source-${sequence}`,
    requestSha256: "e".repeat(64),
    ...batch,
  }) as Extract<RunEvent, { type: "artifact.prototype.patch.created" }>;
}

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return runEventSchema.parse({
    protocol: "workbench.run.v1",
    id: `event-${sequence}`,
    projectId: scope.projectId,
    threadId: "thread-1",
    runId: scope.runId,
    requestId: scope.requestId,
    sequence,
    occurredAt: "2026-07-18T00:00:00.000Z",
    traceId: "trace-1",
    type,
    payload,
  });
}

function queuedTransport(
  checkpoints: Array<RunPrototypePatchCheckpoint | Promise<RunPrototypePatchCheckpoint>>,
): PrototypePatchCheckpointTransport & { getCheckpoint: ReturnType<typeof vi.fn> } {
  return {
    getCheckpoint: vi.fn(async () => {
      const next = checkpoints.shift();
      if (!next) throw new Error("Unexpected checkpoint request");
      return next;
    }),
  };
}

function multiScreenDocumentFixture(): PrototypeDocument {
  const document = prototypeEditorDocumentFixture();
  const mainRoot = document.nodes.find((node) => node.id === "node-root");
  if (!mainRoot || mainRoot.kind !== "frame") throw new Error("root fixture missing");
  document.screens.push({
    id: "screen-details",
    name: "Details",
    route: "/details",
    rootNodeId: "node-root-details",
    initialStateId: null,
    viewport: { width: 390, height: 844 },
  });
  document.nodes.push({
    ...structuredClone(mainRoot),
    id: "node-root-details",
    screenId: "screen-details",
    name: "Details root",
    childIds: [],
  });
  return document;
}

function selectedProjection(store: PrototypePatchProjectorStore) {
  const projection = findPrototypePatchProjection(
    store.getSnapshot(),
    "version-1",
    "screen-main",
  );
  if (!projection) throw new Error("projection missing");
  return projection;
}

async function waitForProjection(
  store: PrototypePatchProjectorStore,
  predicate: (projection: ReturnType<typeof selectedProjection>) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = findPrototypePatchProjection(
      store.getSnapshot(),
      "version-1",
      "screen-main",
    );
    if (projection && predicate(projection)) return projection;
    await flushTasks();
  }
  throw new Error(`Projection did not settle: ${JSON.stringify(selectedProjection(store))}`);
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
