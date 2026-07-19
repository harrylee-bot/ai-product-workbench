import { boardNodeProtocol, type Board } from "@workbench/workbench-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "../api/problem-details";
import {
  createBoardAutosaveCoordinator,
  createBoardStore,
  type BoardAutosaveEventTarget,
  type BoardAutosaveResult,
  type BoardAutosaveVisibilityTarget,
  type BoardSaveSnapshot,
} from "./board";

const board: Board = {
  id: "board-1",
  projectId: "project-1",
  revision: 1,
  viewport: { x: 10, y: 20, zoom: 0.63 },
  nodes: [],
  edges: [],
};

const boardWithNode: Board = {
  ...board,
  nodes: [{
    id: "node-1",
    kind: "artifact",
    parentNodeId: null,
    order: 0,
    position: { x: 100, y: 200 },
    size: { width: 620, height: 1120 },
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title: "Screen",
      artifactKind: "prototype",
    },
  }],
};

describe("Board autosave coordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("debounces edits and coalesces them into the latest snapshot", async () => {
    const store = createBoardStore(board);
    const save = vi.fn(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 300,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    await vi.advanceTimersByTimeAsync(200);
    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({
      editVersion: 2,
      request: { viewport: { x: 30, y: 20, zoom: 0.63 } },
    });
    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean", serverRevision: 2 });
    await coordinator.dispose();
  });

  it("flushes Board node commands through the existing autosave snapshot", async () => {
    const store = createBoardStore(boardWithNode);
    const save = vi.fn(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 300,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    expect(store.getState().duplicateNodes(["node-1"])).toEqual(["node-1-copy"]);
    expect(store.getState().renameNode("node-1-copy", "Copied screen")).toBe(true);
    await coordinator.flush();

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({
      editVersion: 2,
      request: {
        nodes: [
          { id: "node-1", data: { title: "Screen" }, position: { x: 100, y: 200 } },
          { id: "node-1-copy", data: { title: "Copied screen" }, position: { x: 132, y: 232 } },
        ],
      },
    });
    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean", serverRevision: 2 });
    await coordinator.dispose();
  });

  it("keeps one save in flight and immediately tails edits made during it", async () => {
    const store = createBoardStore(board);
    const first = deferred<BoardAutosaveResult>();
    const second = deferred<BoardAutosaveResult>();
    const snapshots: BoardSaveSnapshot[] = [];
    const save = vi.fn((snapshot: BoardSaveSnapshot) => {
      snapshots.push(snapshot);
      return snapshots.length === 1 ? first.promise : second.promise;
    });
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 50,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    const draining = coordinator.flush();
    expect(save).toHaveBeenCalledOnce();

    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });
    await vi.advanceTimersByTimeAsync(50);
    expect(save).toHaveBeenCalledOnce();

    first.resolve(saved(snapshots[0]));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(snapshots[1]).toMatchObject({
      ifMatch: '"2"',
      request: { viewport: { x: 30, y: 20, zoom: 0.63 } },
    });
    second.resolve(saved(snapshots[1]));
    await draining;

    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean", serverRevision: 3 });
    expect(coordinator.getState()).toMatchObject({ inFlight: false, pending: false });
    await coordinator.dispose();
  });

  it.each([
    ["error", new Error("network unavailable")],
    ["conflict", new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_CONFLICT",
    })],
  ] as const)("pauses after a save %s without overwriting local state", async (expectedStatus, error) => {
    const store = createBoardStore(board);
    const save = vi.fn(async () => {
      throw error;
    });
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 10,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    store.getState().setViewport({ x: 99, y: 88, zoom: 0.5 });
    await coordinator.flush();

    expect(store.getState()).toMatchObject({
      viewport: { x: 99, y: 88, zoom: 0.5 },
      dirty: true,
      saveStatus: expectedStatus,
      serverRevision: 1,
    });
    expect(coordinator.getState().paused).toBe(true);

    store.getState().setViewport({ x: 100, y: 88, zoom: 0.5 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledOnce();
    expect(store.getState().viewport.x).toBe(100);
    await coordinator.dispose();
  });

  it("allows an explicit retry only after the store leaves its error state", async () => {
    const store = createBoardStore(board);
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockImplementation(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 20,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    await coordinator.flush();
    expect(coordinator.resume()).toBe(false);

    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });
    expect(coordinator.resume()).toBe(true);
    await coordinator.flush();

    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
    expect(save.mock.calls[2][0].idempotencyKey).not.toBe(save.mock.calls[0][0].idempotencyKey);
    expect(save.mock.calls[2][0]).toMatchObject({
      ifMatch: '"2"',
      request: { viewport: { x: 30, y: 20, zoom: 0.63 } },
    });
    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean", serverRevision: 3 });
    await coordinator.dispose();
  });

  it("automatically tails local edits after a refresh confirms the lost save response", async () => {
    const store = createBoardStore(board);
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 20,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    await coordinator.flush();
    const lostSnapshot = save.mock.calls[0][0];
    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });

    store.getState().reconcileFromServer({
      id: board.id,
      projectId: board.projectId,
      revision: 2,
      ...lostSnapshot.request,
    }, '"2"');
    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      dirty: true,
      saveStatus: "dirty",
      retrySaveSnapshot: null,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({
      ifMatch: '"2"',
      request: { viewport: { x: 30, y: 20, zoom: 0.63 } },
    });
    expect(save.mock.calls[1][0].idempotencyKey).not.toBe(lostSnapshot.idempotencyKey);
    expect(store.getState()).toMatchObject({
      serverRevision: 3,
      dirty: false,
      saveStatus: "clean",
    });
    await coordinator.dispose();
  });

  it("best-effort flushes on hidden visibility and pagehide", async () => {
    const store = createBoardStore(board);
    const visibility = new FakeVisibilityTarget();
    const lifecycle = new FakeEventTarget();
    const save = vi.fn(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 60_000,
      visibilityTarget: visibility,
      pageLifecycleTarget: lifecycle,
    });

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    visibility.setVisibility("hidden");
    await vi.waitFor(() => expect(store.getState().serverRevision).toBe(2));

    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });
    lifecycle.dispatch("pagehide");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(store.getState().serverRevision).toBe(3);
    await coordinator.dispose();
  });

  it("uses the latest save callback instead of retaining a stale closure", async () => {
    const store = createBoardStore(board);
    const stale = vi.fn(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const current = vi.fn(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save: stale,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });
    coordinator.setSave(current);

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    await coordinator.flush();

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    await coordinator.dispose();
  });

  it("commits the store before publishing the successful save to external caches", async () => {
    const store = createBoardStore(board);
    const onSaved = vi.fn(() => {
      expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean", serverRevision: 2 });
    });
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save: async (snapshot) => saved(snapshot),
      onSaved,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    store.getState().setViewport({ x: 42, y: 24, zoom: 0.72 });
    await coordinator.flush();

    expect(onSaved).toHaveBeenCalledOnce();
    await coordinator.dispose();
  });

  it("flushes pending edits before cancelling lifecycle listeners", async () => {
    const store = createBoardStore(board);
    const visibility = new FakeVisibilityTarget();
    const lifecycle = new FakeEventTarget();
    const save = vi.fn(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      debounceMs: 100,
      visibilityTarget: visibility,
      pageLifecycleTarget: lifecycle,
    });

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    await coordinator.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    visibility.setVisibility("hidden");
    lifecycle.dispatch("pagehide");

    expect(save).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean" });
    expect(visibility.listenerCount("visibilitychange")).toBe(0);
    expect(lifecycle.listenerCount("pagehide")).toBe(0);
    expect(coordinator.getState()).toMatchObject({ disposed: true, pending: false });
    await expect(coordinator.flush()).resolves.toBeUndefined();
  });

  it("drains trailing work when disposed during an in-flight save", async () => {
    const store = createBoardStore(board);
    const first = deferred<BoardAutosaveResult>();
    const second = deferred<BoardAutosaveResult>();
    const snapshots: BoardSaveSnapshot[] = [];
    const save = vi.fn((snapshot: BoardSaveSnapshot) => {
      snapshots.push(snapshot);
      return snapshots.length === 1 ? first.promise : second.promise;
    });
    const coordinator = createBoardAutosaveCoordinator({
      store,
      save,
      visibilityTarget: null,
      pageLifecycleTarget: null,
    });

    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    const draining = coordinator.flush();
    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });
    const disposing = coordinator.dispose();
    first.resolve(saved(snapshots[0]));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    second.resolve(saved(snapshots[1]));
    await Promise.all([draining, disposing]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(save).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toMatchObject({ disposed: true, inFlight: false, pending: false });
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      serverRevision: 3,
      viewport: { x: 30, y: 20, zoom: 0.63 },
    });
  });
});

function saved(snapshot: BoardSaveSnapshot): BoardAutosaveResult {
  return {
    value: {
      id: snapshot.boardId,
      projectId: snapshot.projectId,
      revision: snapshot.baseRevision + 1,
      ...snapshot.request,
    },
    etag: `"${snapshot.baseRevision + 1}"`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeEventTarget implements BoardAutosaveEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeVisibilityTarget extends FakeEventTarget implements BoardAutosaveVisibilityTarget {
  visibilityState = "visible";

  setVisibility(state: string): void {
    this.visibilityState = state;
    this.dispatch("visibilitychange");
  }
}
