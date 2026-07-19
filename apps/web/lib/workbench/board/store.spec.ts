import { boardNodeProtocol, type Board } from "@workbench/workbench-contracts";
import type { EdgeChange, NodeChange } from "@xyflow/system";
import { describe, expect, it } from "vitest";

import {
  reduceWorkbenchProjectEdgeChanges,
  reduceWorkbenchProjectNodeChanges,
} from "@/components/workbench/workbench-project-react-flow-adapter";
import { WorkbenchApiError } from "../api/problem-details";
import {
  boardToFlow,
  flowToBoardRequest,
  type BoardFlowEdge,
  type BoardFlowNode,
} from "./adapter";
import { boardNodeActionAvailability } from "./node-actions";
import { createBoardStore, type BoardStore } from "./store";

const board: Board = {
  id: "board-1",
  projectId: "project-1",
  revision: 1,
  viewport: { x: 10, y: 20, zoom: 0.63 },
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
  edges: [],
};

describe("Board domain adapter", () => {
  it("round-trips persisted fields without leaking React Flow UI state", () => {
    const flow = boardToFlow(board);
    flow.nodes[0].selected = true;

    expect(flowToBoardRequest(flow.viewport, flow.nodes, flow.edges)).toEqual({
      viewport: board.viewport,
      nodes: board.nodes,
      edges: board.edges,
    });
  });

  it("projects parents before children and siblings by persisted order", () => {
    const frame = {
      ...board.nodes[0]!,
      id: "frame-1",
      kind: "frame" as const,
      order: 0,
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame" as const,
        title: "Frame",
        fill: "#ffffff",
        stroke: "#5f6368",
      },
    };
    const child = { ...board.nodes[0]!, id: "child-1", parentNodeId: frame.id, order: 0 };
    const root = { ...board.nodes[0]!, id: "root-2", order: 1 };
    const projection = boardToFlow({ ...board, nodes: [root, child, frame] });

    expect(projection.nodes.map((node) => node.id)).toEqual(["frame-1", "child-1", "root-2"]);
    expect(flowToBoardRequest(projection.viewport, projection.nodes, []).nodes)
      .toEqual([frame, child, root]);
  });
});

describe("Board store CAS lifecycle", () => {
  it("nudges selected roots as one undoable command", () => {
    const store = createBoardStore(connectedBoard());

    expect(store.getState().nudgeNodes(["node-1", "node-2"], { x: 10, y: -1 })).toEqual(["node-1", "node-2"]);
    expect(store.getState().nodes.map((node) => [node.id, node.position])).toEqual([
      ["node-1", { x: 110, y: 199 }],
      ["node-2", { x: 510, y: 199 }],
      ["node-3", { x: 900, y: 200 }],
    ]);
    expect(store.getState()).toMatchObject({ canUndo: true, historyPast: [{ nodes: expect.any(Array) }] });
    store.getState().undo();
    expect(store.getState().nodes[0]?.position).toEqual({ x: 100, y: 200 });
  });

  it("moves a selected Frame root once when both the Frame and its child are selected", () => {
    const store = createBoardStore(board);
    const frameId = store.getState().addFrame({ x: 80, y: 180, width: 900, height: 1_200 });
    const frameBefore = store.getState().nodes.find((node) => node.id === frameId)!;
    const childBefore = store.getState().nodes.find((node) => node.id === "node-1")!;

    expect(store.getState().nudgeNodes([frameId, "node-1"], { x: 8, y: 6 })).toEqual([frameId]);
    expect(store.getState().nodes.find((node) => node.id === frameId)?.position).toEqual({
      x: frameBefore.position.x + 8,
      y: frameBefore.position.y + 6,
    });
    expect(store.getState().nodes.find((node) => node.id === "node-1")?.position)
      .toEqual(childBefore.position);
  });

  it("does not mark selection dirty", () => {
    const store = createBoardStore(board);
    applyProjectNodeChanges(store, [{ id: "node-1", type: "select", selected: true }]);

    expect(store.getState().nodes[0].selected).toBe(true);
    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean", editVersion: 0 });
  });

  it("keeps edge selection transient and makes an upstream edge removal undoable", () => {
    const store = createBoardStore(connectedBoard());

    applyProjectEdgeChanges(store, [{
      id: "edge-internal",
      type: "select",
      selected: true,
    }]);
    expect(store.getState().edges[0]?.selected).toBe(true);
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      editVersion: 0,
      historyPast: [],
    });

    applyProjectEdgeChanges(store, [{ id: "edge-internal", type: "remove" }]);
    expect(store.getState().edges.map((edge) => edge.id)).toEqual(["edge-external"]);
    expect(store.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });

    store.getState().undo();
    expect(store.getState().edges.map((edge) => edge.id)).toEqual([
      "edge-internal",
      "edge-external",
    ]);
  });

  it("preserves edits made while a save is in flight and advances the CAS ETag", () => {
    const store = createBoardStore(board);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 110, y: 210 },
      dragging: false,
    }]);
    const snapshot = store.getState().prepareSave();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.ifMatch).toBe('"1"');

    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 120, y: 220 },
      dragging: false,
    }]);
    const savedBoard: Board = {
      ...board,
      revision: 2,
      nodes: [{ ...board.nodes[0], position: { x: 110, y: 210 } }],
    };
    store.getState().completeSave(snapshot!, savedBoard, '"2"');

    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      etag: '"2"',
      dirty: true,
      saveStatus: "dirty",
    });
    expect(store.getState().nodes[0].position).toEqual({ x: 120, y: 220 });
    expect(store.getState().prepareSave()).toMatchObject({
      ifMatch: '"2"',
      request: { nodes: [{ position: { x: 120, y: 220 } }] },
    });
  });

  it("enters conflict state on a 412 response", () => {
    const store = createBoardStore(board);
    store.getState().setViewport({ x: 11, y: 20, zoom: 0.63 });
    const snapshot = store.getState().prepareSave();
    const error = new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_CONFLICT",
    });

    store.getState().failSave(snapshot!, error);

    expect(store.getState()).toMatchObject({ dirty: true, saveStatus: "conflict", lastSaveError: error });
    expect(store.getState().prepareSave()).toBeNull();
  });

  it("reuses the failed snapshot key and recovers its revision before tailing newer edits", () => {
    const store = createBoardStore(board);
    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    const first = store.getState().prepareSave()!;

    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });
    store.getState().failSave(first, new Error("response lost"));
    const recovery = store.getState().prepareSave()!;

    expect(recovery).toEqual(first);
    store.getState().completeSave(recovery, {
      id: board.id,
      projectId: board.projectId,
      revision: 2,
      ...recovery.request,
    }, '"2"');
    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      etag: '"2"',
      dirty: true,
      saveStatus: "dirty",
      viewport: { x: 30, y: 20, zoom: 0.63 },
      retrySaveSnapshot: null,
    });

    const trailing = store.getState().prepareSave()!;
    expect(trailing.ifMatch).toBe('"2"');
    expect(trailing.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(trailing.request.viewport).toEqual({ x: 30, y: 20, zoom: 0.63 });
  });

  it("accepts a refreshed Board as proof that a lost response committed", () => {
    const store = createBoardStore(board);
    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    const first = store.getState().prepareSave()!;
    store.getState().setViewport({ x: 30, y: 20, zoom: 0.63 });
    store.getState().failSave(first, new Error("response lost"));

    store.getState().reconcileFromServer({
      id: board.id,
      projectId: board.projectId,
      revision: 2,
      ...first.request,
    }, '"2"');

    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      etag: '"2"',
      dirty: true,
      saveStatus: "dirty",
      viewport: { x: 30, y: 20, zoom: 0.63 },
      retrySaveSnapshot: null,
      lastSaveError: null,
    });
    expect(store.getState().prepareSave()).toMatchObject({
      ifMatch: '"2"',
      request: { viewport: { x: 30, y: 20, zoom: 0.63 } },
    });
  });

  it("treats an idempotency-key reuse response as a terminal conflict", () => {
    const store = createBoardStore(board);
    store.getState().setViewport({ x: 20, y: 20, zoom: 0.63 });
    const snapshot = store.getState().prepareSave()!;
    const error = new WorkbenchApiError({
      type: "about:blank",
      title: "Idempotency key reused",
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    store.getState().failSave(snapshot, error);

    expect(store.getState()).toMatchObject({
      dirty: true,
      saveStatus: "conflict",
      retrySaveSnapshot: null,
      lastSaveError: error,
    });
    expect(store.getState().prepareSave()).toBeNull();
  });

  it("does not overwrite dirty local state when a newer remote revision is observed", () => {
    const store = createBoardStore(board);
    store.getState().setViewport({ x: 30, y: 40, zoom: 0.63 });
    store.getState().reconcileFromServer({
      ...board,
      revision: 2,
      viewport: { x: 300, y: 400, zoom: 0.5 },
    }, '"2"');

    expect(store.getState()).toMatchObject({
      viewport: { x: 30, y: 40, zoom: 0.63 },
      serverRevision: 1,
      dirty: true,
      saveStatus: "conflict",
      activeSaveVersion: null,
    });
  });

  it("replays local conflict state against the latest server revision with a new CAS command", () => {
    const store = createBoardStore(board);
    store.getState().setViewport({ x: 30, y: 40, zoom: 0.63 });
    const remote = {
      ...board,
      revision: 2,
      viewport: { x: 300, y: 400, zoom: 0.5 },
    };
    store.getState().reconcileFromServer(remote, '"2"');
    const conflictedEditVersion = store.getState().editVersion;

    store.getState().resolveConflictFromServer(remote, "replay-local", '"2"');

    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      etag: '"2"',
      editVersion: conflictedEditVersion + 1,
      viewport: { x: 30, y: 40, zoom: 0.63 },
      dirty: true,
      saveStatus: "dirty",
      retrySaveSnapshot: null,
      lastSaveError: null,
    });
    expect(store.getState().prepareSave()).toMatchObject({
      baseRevision: 2,
      ifMatch: '"2"',
      request: { viewport: { x: 30, y: 40, zoom: 0.63 } },
    });
  });

  it("discards local conflict state only after an explicit server replacement", () => {
    const store = createBoardStore(board);
    store.getState().setViewport({ x: 30, y: 40, zoom: 0.63 });
    const remote = {
      ...board,
      revision: 2,
      viewport: { x: 300, y: 400, zoom: 0.5 },
    };
    store.getState().reconcileFromServer(remote, '"2"');

    store.getState().resolveConflictFromServer(remote, "discard-local", '"2"');

    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      etag: '"2"',
      viewport: remote.viewport,
      dirty: false,
      saveStatus: "clean",
      canUndo: false,
      canRedo: false,
    });
  });

  it("coalesces a drag gesture into one undo step and supports redo", () => {
    const store = createBoardStore(board);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 110, y: 210 },
      dragging: true,
    }]);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 120, y: 220 },
      dragging: true,
    }]);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 130, y: 230 },
      dragging: false,
    }]);

    expect(store.getState()).toMatchObject({
      canUndo: true,
      canRedo: false,
      historyGesture: null,
    });
    expect(store.getState().historyPast).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().nodes[0].position).toEqual({ x: 100, y: 200 });
    expect(store.getState()).toMatchObject({ canUndo: false, canRedo: true, dirty: true });

    store.getState().redo();
    expect(store.getState().nodes[0].position).toEqual({ x: 130, y: 230 });
    expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false, dirty: true });
  });

  it("treats repeated position and measured dimensions as UI-only no-ops", () => {
    const store = createBoardStore(board);

    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "dimensions",
      dimensions: { width: 619.5, height: 1_119.5 },
    }]);
    expect(store.getState().nodes[0].measured).toEqual({ width: 619.5, height: 1_119.5 });
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      editVersion: 0,
      historyPast: [],
    });

    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "dimensions",
      dimensions: { width: 620, height: 1_120 },
    }]);
    expect(store.getState().nodes[0].measured).toEqual({ width: 620, height: 1_120 });
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      editVersion: 0,
      historyPast: [],
    });

    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 110, y: 210 },
      dragging: true,
    }]);
    const editVersion = store.getState().editVersion;
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 110, y: 210 },
      dragging: false,
    }]);

    expect(store.getState()).toMatchObject({
      editVersion,
      historyGesture: null,
    });
    expect(store.getState().historyPast).toHaveLength(1);
  });

  it("persists an explicit resize gesture as one undo step", () => {
    const store = createBoardStore(board);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "dimensions",
      dimensions: { width: 700, height: 1_200 },
      resizing: true,
      setAttributes: true,
    }]);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "dimensions",
      dimensions: { width: 700, height: 1_200 },
      resizing: false,
    }]);

    expect(store.getState()).toMatchObject({
      dirty: true,
      historyGesture: null,
      canUndo: true,
    });
    expect(store.getState().historyPast).toHaveLength(1);
    expect(flowToBoardRequest(
      store.getState().viewport,
      store.getState().nodes,
      store.getState().edges,
    ).nodes[0]?.size).toEqual({ width: 700, height: 1_200 });

    store.getState().undo();
    expect(flowToBoardRequest(
      store.getState().viewport,
      store.getState().nodes,
      store.getState().edges,
    ).nodes[0]?.size).toEqual({ width: 620, height: 1_120 });
  });

  it("keeps a Drawing command as the next undo after server measurement replay", () => {
    const store = createBoardStore(board);
    const drawingId = store.getState().addDrawing([
      { x: 120, y: 240, pressure: 0.3 },
      { x: 180, y: 300, pressure: 0.8 },
    ]);
    const snapshot = store.getState().prepareSave()!;
    store.getState().completeSave(snapshot, {
      id: board.id,
      projectId: board.projectId,
      revision: 2,
      ...snapshot.request,
    }, '"2"');

    const historyLength = store.getState().historyPast.length;
    const editVersion = store.getState().editVersion;
    for (const node of store.getState().nodes) {
      if (!node.workbench.size) continue;
      applyProjectNodeChanges(store, [{
        id: node.id,
        type: "dimensions",
        dimensions: { ...node.workbench.size },
        resizing: false,
      }]);
    }

    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      editVersion,
    });
    expect(store.getState().historyPast).toHaveLength(historyLength);

    store.getState().undo();
    expect(store.getState().nodes.some((node) => node.id === drawingId)).toBe(false);
  });

  it("clears redo history after a new edit and clears all history on a server replacement", () => {
    const store = createBoardStore(board);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 110, y: 210 },
      dragging: false,
    }]);
    store.getState().undo();
    expect(store.getState().canRedo).toBe(true);

    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 140, y: 240 },
      dragging: false,
    }]);
    expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false });

    store.getState().replaceFromServer({
      ...board,
      revision: 2,
      nodes: [{ ...board.nodes[0], position: { x: 140, y: 240 } }],
    }, '"2"');
    expect(store.getState()).toMatchObject({
      canUndo: false,
      canRedo: false,
      historyPast: [],
      historyFuture: [],
    });
  });

  it("keeps local undo history after autosave advances the server revision", () => {
    const store = createBoardStore(board);
    applyProjectNodeChanges(store, [{
      id: "node-1",
      type: "position",
      position: { x: 110, y: 210 },
      dragging: false,
    }]);
    const snapshot = store.getState().prepareSave()!;
    store.getState().completeSave(snapshot, {
      ...board,
      revision: 2,
      nodes: [{ ...board.nodes[0], position: { x: 110, y: 210 } }],
    }, '"2"');

    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      saveStatus: "clean",
      canUndo: true,
    });
    store.getState().undo();
    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      saveStatus: "dirty",
      dirty: true,
      canRedo: true,
    });
    expect(store.getState().nodes[0].position).toEqual({ x: 100, y: 200 });
  });

  it("repins every matching Artifact node to an immutable edited version as one command", () => {
    const repeatedBoard: Board = {
      ...board,
      nodes: [
        board.nodes[0]!,
        {
          ...board.nodes[0]!,
          id: "node-2",
          order: 1,
          position: { x: 800, y: 200 },
        },
      ],
    };
    const store = createBoardStore(repeatedBoard);

    expect(store.getState().replaceArtifactVersionPins("artifact-1", "version-1", "version-2"))
      .toEqual(["node-1", "node-2"]);
    expect(store.getState().nodes.map((node) => node.workbench.artifactVersionId))
      .toEqual(["version-2", "version-2"]);
    expect(store.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });
    expect(store.getState().historyPast).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().nodes.map((node) => node.workbench.artifactVersionId))
      .toEqual(["version-1", "version-1"]);
  });

  it("adds an Artifact pin as one undoable Board command", () => {
    const store = createBoardStore(board);

    const nodeId = store.getState().addArtifact({
      artifactId: "artifact-image",
      artifactVersionId: "version-image-1",
      artifactKind: "image",
      title: "Hero image",
      x: 500,
      y: 300,
      width: 320,
      height: 180,
    });

    expect(store.getState().nodes.find((node) => node.id === nodeId)).toMatchObject({
      selected: true,
      data: { nodeType: "artifact", artifactKind: "image", title: "Hero image" },
      workbench: {
        artifactId: "artifact-image",
        artifactVersionId: "version-image-1",
      },
    });
    expect(store.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });

    store.getState().undo();
    expect(store.getState().nodes.some((node) => node.id === nodeId)).toBe(false);
  });

  it("duplicates multi-selection atomically with unique node ids and internal edges", () => {
    const store = createBoardStore(connectedBoard());
    applyProjectNodeChanges(store, [{ id: "node-1", type: "select", selected: true }]);

    expect(store.getState().duplicateNodes(["node-1", "node-2", "node-1"]))
      .toEqual(["node-1-copy", "node-2-copy"]);
    expect(store.getState().nodes.map((node) => node.id)).toEqual([
      "node-1",
      "node-2",
      "node-3",
      "node-1-copy",
      "node-2-copy",
    ]);
    expect(store.getState().edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "edge-internal-copy", source: "node-1-copy", target: "node-2-copy" }),
    ]));
    expect(store.getState().edges).toHaveLength(3);
    expect(store.getState().nodes.find((node) => node.id === "node-1")?.selected).toBe(true);
    expect(store.getState().nodes.find((node) => node.id === "node-1-copy")?.selected).toBeUndefined();
    expect(store.getState().nodes.find((node) => node.id === "node-2-copy")?.selected).toBeUndefined();
    expect(store.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });
    expect(store.getState().historyPast).toHaveLength(1);

    expect(store.getState().duplicateNodes(["node-1"])).toEqual(["node-1-copy-2"]);
    expect(new Set(store.getState().nodes.map((node) => node.id)).size).toBe(6);
    expect(store.getState().historyPast).toHaveLength(2);

    store.getState().undo();
    expect(store.getState().nodes.some((node) => node.id === "node-1-copy-2")).toBe(false);
    expect(store.getState().nodes.find((node) => node.id === "node-1")?.selected).toBe(true);
    store.getState().redo();
    expect(store.getState().nodes.some((node) => node.id === "node-1-copy-2")).toBe(true);
    expect(store.getState().nodes.find((node) => node.id === "node-1")?.selected).toBe(true);
  });

  it("renames once and treats repeated or missing targets as no-ops", () => {
    const store = createBoardStore(board);

    expect(store.getState().renameNode("node-1", "  Renamed screen  ")).toBe(true);
    expect(store.getState().nodes[0].data.title).toBe("Renamed screen");
    expect(store.getState().historyPast).toHaveLength(1);
    const editVersion = store.getState().editVersion;

    expect(store.getState().renameNode("node-1", "Renamed screen")).toBe(false);
    expect(store.getState().renameNode("missing", "Other")).toBe(false);
    expect(store.getState().editVersion).toBe(editVersion);
    expect(store.getState().historyPast).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().nodes[0].data.title).toBe("Screen");
  });

  it("deletes multiple nodes and every incident edge as one undoable command", () => {
    const store = createBoardStore(connectedBoard());

    expect(store.getState().removeNodes(["node-1", "node-2", "node-1"]))
      .toEqual(["node-1", "node-2"]);
    expect(store.getState().nodes.map((node) => node.id)).toEqual(["node-3"]);
    expect(store.getState().edges).toEqual([]);
    expect(store.getState().historyPast).toHaveLength(1);
    const editVersion = store.getState().editVersion;

    expect(store.getState().removeNodes(["node-1", "node-2"])).toEqual([]);
    expect(store.getState().editVersion).toBe(editVersion);
    expect(store.getState().historyPast).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().nodes).toHaveLength(3);
    expect(store.getState().edges).toHaveLength(2);
  });

  it("adds Frame and Drawing nodes as versioned undoable autosave commands", () => {
    const store = createBoardStore(board);
    const frameId = store.getState().addFrame({ x: 80, y: 180, width: 700, height: 1_200 });
    expect(frameId).toMatch(/^frame_/);
    expect(store.getState().nodes.find((node) => node.id === "node-1")).toMatchObject({
      parentId: frameId,
      position: { x: 20, y: 20 },
    });

    const drawingId = store.getState().addDrawing([
      { x: 120, y: 240, pressure: 0.3 },
      { x: 180, y: 300, pressure: 0.8 },
    ]);
    expect(drawingId).toMatch(/^drawing_/);
    expect(store.getState().nodes.find((node) => node.id === drawingId)).toMatchObject({
      parentId: frameId,
      data: { protocol: boardNodeProtocol, nodeType: "drawing" },
    });
    expect(store.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });
    expect(store.getState().historyPast).toHaveLength(2);
    expect(store.getState().prepareSave()?.request.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: frameId, kind: "frame", parentNodeId: null }),
      expect.objectContaining({ id: "node-1", parentNodeId: frameId }),
      expect.objectContaining({ id: drawingId, kind: "drawing", parentNodeId: frameId }),
    ]));

    store.getState().undo();
    expect(store.getState().nodes.some((node) => node.id === drawingId)).toBe(false);
  });

  it("duplicates and removes an entire Frame subtree atomically", () => {
    const store = createBoardStore(board);
    const frameId = store.getState().addFrame({ x: 80, y: 180, width: 700, height: 1_200 });
    const [frameCopyId] = store.getState().duplicateNodes([frameId]);
    const childCopy = store.getState().nodes.find((node) => node.id === "node-1-copy");
    expect(frameCopyId).toBe(`${frameId}-copy`);
    expect(childCopy?.parentId).toBe(frameCopyId);
    expect(childCopy?.position).toEqual({ x: 20, y: 20 });
    expect(childCopy?.workbench.order).toBe(0);
    expect(store.getState().nodes.find((node) => node.id === frameCopyId)?.workbench.order).toBe(2);

    expect(store.getState().removeNodes([frameId])).toEqual([frameId, "node-1"]);
    expect(store.getState().nodes.map((node) => node.id)).toEqual([frameCopyId, "node-1-copy"]);
  });

  it("defensively cascades React Flow remove changes through the domain command", () => {
    const store = createBoardStore(connectedBoard());
    const frameId = store.getState().addFrame({ x: 80, y: 180, width: 1_100, height: 1_220 });
    expect(store.getState().nodes.find((node) => node.id === "node-1")?.parentId).toBe(frameId);
    expect(store.getState().nodes.find((node) => node.id === "node-2")?.parentId).toBe(frameId);

    applyProjectNodeChanges(store, [{ id: frameId, type: "remove" }]);

    expect(store.getState().nodes.map((node) => node.id)).toEqual(["node-3"]);
    expect(store.getState().edges).toEqual([]);
    expect(store.getState().historyPast).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().nodes).toHaveLength(4);
    expect(store.getState().edges).toHaveLength(2);
  });
});

describe("Board arrangement store commands", () => {
  it("commits a multi-node arrangement as one edit and one undo step", () => {
    const initial = connectedBoard();
    initial.nodes[1] = {
      ...initial.nodes[1]!,
      position: { x: 650, y: 320 },
    };
    const originalPositions = initial.nodes.map((node) => ({ ...node.position }));
    const store = createBoardStore(initial);

    expect(store.getState().arrangeNodes(
      ["node-3", "node-1", "node-2", "node-1"],
      { kind: "distribute", axis: "horizontal" },
    )).toEqual({ changed: true, movedNodeIds: ["node-2"] });
    expect(store.getState()).toMatchObject({
      dirty: true,
      editVersion: 1,
      canUndo: true,
      canRedo: false,
    });
    expect(store.getState().historyPast).toHaveLength(1);
    expect(store.getState().nodes.map((node) => node.position)).toEqual([
      { x: 100, y: 200 },
      { x: 500, y: 320 },
      { x: 900, y: 200 },
    ]);

    store.getState().undo();
    expect(store.getState().nodes.map((node) => node.position)).toEqual(originalPositions);
    expect(store.getState()).toMatchObject({ canUndo: false, canRedo: true, editVersion: 2 });

    store.getState().redo();
    expect(store.getState().nodes.map((node) => node.position)).toEqual([
      { x: 100, y: 200 },
      { x: 500, y: 320 },
      { x: 900, y: 200 },
    ]);
    expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false, editVersion: 3 });
  });

  it("does not edit history or revision for a typed arrangement no-op", () => {
    const noSizeBoard: Board = {
      ...board,
      nodes: [
        board.nodes[0]!,
        {
          ...board.nodes[0]!,
          id: "node-2",
          order: 1,
          position: { x: 800, y: 200 },
          size: null,
          artifactId: "artifact-2",
          artifactVersionId: "version-2",
        },
      ],
    };
    const store = createBoardStore(noSizeBoard);

    expect(store.getState().arrangeNodes(
      ["node-1", "node-2"],
      { kind: "align", alignment: "left" },
    )).toEqual({ changed: false, movedNodeIds: [], reason: "missing-size" });
    expect(store.getState()).toMatchObject({
      dirty: false,
      editVersion: 0,
      canUndo: false,
      canRedo: false,
      historyPast: [],
    });
  });
});

describe("Board node action permissions", () => {
  it("allows a viewer to copy a single deep link but never mutate Board state", () => {
    expect(boardNodeActionAvailability(false, 1)).toEqual({
      canCopyLink: true,
      canDelete: false,
      canDuplicate: false,
      canRename: false,
    });
  });

  it("supports editor batch duplicate/delete while keeping rename/link singular", () => {
    expect(boardNodeActionAvailability(true, 2)).toEqual({
      canCopyLink: false,
      canDelete: true,
      canDuplicate: true,
      canRename: false,
    });
  });
});

function connectedBoard(): Board {
  return {
    ...board,
    nodes: [
      board.nodes[0]!,
      {
        ...board.nodes[0]!,
        id: "node-2",
        position: { x: 500, y: 200 },
        artifactId: "artifact-2",
        artifactVersionId: "version-2",
        data: { ...board.nodes[0]!.data, title: "Second screen" },
      },
      {
        ...board.nodes[0]!,
        id: "node-3",
        position: { x: 900, y: 200 },
        artifactId: "artifact-3",
        artifactVersionId: "version-3",
        data: { ...board.nodes[0]!.data, title: "Third screen" },
      },
    ],
    edges: [
      { id: "edge-internal", sourceNodeId: "node-1", targetNodeId: "node-2", kind: "flow", data: {} },
      { id: "edge-external", sourceNodeId: "node-2", targetNodeId: "node-3", kind: "flow", data: {} },
    ],
  };
}

function applyProjectNodeChanges(
  store: BoardStore,
  changes: NodeChange<BoardFlowNode>[],
): void {
  store.getState().applyNodeChanges(changes, reduceWorkbenchProjectNodeChanges);
}

function applyProjectEdgeChanges(
  store: BoardStore,
  changes: EdgeChange<BoardFlowEdge>[],
): void {
  store.getState().applyEdgeChanges(changes, reduceWorkbenchProjectEdgeChanges);
}
