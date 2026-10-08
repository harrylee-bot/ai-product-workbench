import {
  orderBoardNodesByHierarchy,
  type Board,
  type ReplaceBoardRequest,
} from "@workbench/workbench-contracts";
import type {
  EdgeChange,
  NodeChange,
  Viewport,
} from "@xyflow/system";
import equal from "fast-deep-equal";
import { nanoid } from "nanoid";
import { createStore, type StoreApi } from "zustand/vanilla";

import { isWorkbenchApiError } from "../api/problem-details";
import {
  boardToFlow,
  flowToBoardRequest,
  orderFlowNodesByHierarchy,
  type BoardFlowEdge,
  type BoardFlowNode,
} from "./adapter";
import {
  arrangeBoardNodes,
  type BoardNodeArrangeOperation,
  type BoardNodeArrangeOutcome,
} from "./arrange";
import {
  duplicateBoardNodes,
  removeBoardNodes,
  renameBoardNode,
} from "./node-actions";
import { boardFlowNodeSize } from "./geometry";
import { reparentBoardNodesAfterDrag } from "./reparent";
import {
  createBoardArtifact,
  createBoardDrawing,
  createBoardFrame,
  type CreateBoardArtifactInput,
  type BoardDrawingSample,
  type BoardRect,
  type CreateBoardDrawingOptions,
} from "./tool-actions";

export type BoardSaveStatus = "clean" | "dirty" | "saving" | "error" | "conflict";
export type BoardConflictResolution = "discard-local" | "replay-local";

export type BoardSaveSnapshot = {
  boardId: string;
  projectId: string;
  baseRevision: number;
  ifMatch: string;
  idempotencyKey: string;
  editVersion: number;
  request: ReplaceBoardRequest;
};

type BoardHistorySnapshot = {
  nodes: BoardFlowNode[];
  edges: BoardFlowEdge[];
};

type BoardHistoryGesture = "nodes" | null;

export type BoardNodeChangeReducer = (
  changes: NodeChange<BoardFlowNode>[],
  nodes: BoardFlowNode[],
) => BoardFlowNode[];

export type BoardEdgeChangeReducer = (
  changes: EdgeChange<BoardFlowEdge>[],
  edges: BoardFlowEdge[],
) => BoardFlowEdge[];

export type BoardStoreState = {
  boardId: string;
  projectId: string;
  serverRevision: number;
  etag: string;
  viewport: Viewport;
  nodes: BoardFlowNode[];
  edges: BoardFlowEdge[];
  editVersion: number;
  dirty: boolean;
  saveStatus: BoardSaveStatus;
  activeSaveVersion: number | null;
  retrySaveSnapshot: BoardSaveSnapshot | null;
  lastSaveError: unknown | null;
  canUndo: boolean;
  canRedo: boolean;
  historyPast: BoardHistorySnapshot[];
  historyFuture: BoardHistorySnapshot[];
  historyGesture: BoardHistoryGesture;
  applyNodeChanges: (
    changes: NodeChange<BoardFlowNode>[],
    reduceChanges: BoardNodeChangeReducer,
  ) => void;
  applyEdgeChanges: (
    changes: EdgeChange<BoardFlowEdge>[],
    reduceChanges: BoardEdgeChangeReducer,
  ) => void;
  addArtifact: (input: CreateBoardArtifactInput) => string;
  addDrawing: (
    samples: readonly BoardDrawingSample[],
    options?: CreateBoardDrawingOptions,
  ) => string;
  addFrame: (bounds: BoardRect) => string;
  arrangeNodes: (
    nodeIds: readonly string[],
    operation: BoardNodeArrangeOperation,
  ) => BoardNodeArrangeOutcome;
  duplicateNodes: (nodeIds: readonly string[]) => string[];
  replaceArtifactVersionPins: (
    artifactId: string,
    baseArtifactVersionId: string,
    resultArtifactVersionId: string,
  ) => string[];
  renameNode: (nodeId: string, title: string) => boolean;
  removeNodes: (nodeIds: readonly string[]) => string[];
  nudgeNodes: (nodeIds: readonly string[], delta: { x: number; y: number }) => string[];
  setViewport: (viewport: Viewport) => void;
  undo: () => void;
  redo: () => void;
  replaceFromServer: (board: Board, etag?: string) => void;
  reconcileFromServer: (board: Board, etag?: string) => void;
  resolveConflictFromServer: (
    board: Board,
    resolution: BoardConflictResolution,
    etag?: string,
  ) => void;
  prepareSave: () => BoardSaveSnapshot | null;
  completeSave: (snapshot: BoardSaveSnapshot, board: Board, etag?: string) => void;
  failSave: (snapshot: BoardSaveSnapshot, error: unknown) => void;
};

export type BoardStore = StoreApi<BoardStoreState>;

export function createBoardStore(board: Board, etag = revisionEtag(board.revision)): BoardStore {
  const initial = serverState(board, etag);
  const saveSessionId = nanoid(24);
  let confirmedServerRequest = canonicalBoardRequestFromBoard(board);

  return createStore<BoardStoreState>((set, get) => ({
    ...initial,
    editVersion: 0,
    dirty: false,
    saveStatus: "clean",
    activeSaveVersion: null,
    retrySaveSnapshot: null,
    lastSaveError: null,
    canUndo: false,
    canRedo: false,
    historyPast: [],
    historyFuture: [],
    historyGesture: null,
    applyNodeChanges(changes, reduceChanges) {
      set((state) => {
        const removedNodeIds = changes.flatMap((change) => change.type === "remove" ? [change.id] : []);
        const removal = removeBoardNodes(state.nodes, state.edges, removedNodeIds);
        const remainingChanges = changes.filter((change) => change.type !== "remove");
        const changedNodes = reduceChanges(remainingChanges, removal.nodes);
        const reparented = reparentBoardNodesAfterDrag(
          changedNodes,
          remainingChanges.flatMap((change) => (
            change.type === "position" && change.dragging === false ? [change.id] : []
          )),
        );
        const nodes = reparented.nodes;
        const persistentNodeDelta = hasPersistentNodeDelta(
          removal.nodes,
          nodes,
          remainingChanges,
        );
        if (!removal.changed && !reparented.changed && !persistentNodeDelta) {
          return {
            nodes,
            historyGesture: completesNodeGesture(remainingChanges)
              ? null
              : state.historyGesture,
          };
        }
        const recordSnapshot = removal.changed || state.historyGesture === null;
        const historyPast = recordSnapshot
          ? appendHistory(state.historyPast, historySnapshot(state))
          : state.historyPast;
        return {
          ...editedState(state, { nodes, edges: removal.edges }),
          canUndo: historyPast.length > 0,
          canRedo: false,
          historyPast,
          historyFuture: [],
          historyGesture: remainingChanges.some(isActiveNodeGesture) ? "nodes" : null,
        };
      });
    },
    applyEdgeChanges(changes, reduceChanges) {
      set((state) => {
        const edges = reduceChanges(changes, state.edges);
        if (!changes.some(isPersistentChange)) return { edges };
        const historyPast = appendHistory(state.historyPast, historySnapshot(state));
        return {
          ...editedState(state, { edges }),
          canUndo: true,
          canRedo: false,
          historyPast,
          historyFuture: [],
          historyGesture: null,
        };
      });
    },
    addArtifact(input) {
      let nodeId = "";
      set((state) => {
        const result = createBoardArtifact(state.nodes, input);
        nodeId = result.nodeId;
        return commandState(state, { nodes: result.nodes });
      });
      return nodeId;
    },
    addDrawing(samples, options) {
      let nodeId = "";
      set((state) => {
        const result = createBoardDrawing(state.nodes, samples, options);
        nodeId = result.nodeId;
        return commandState(state, { nodes: result.nodes });
      });
      return nodeId;
    },
    addFrame(bounds) {
      let nodeId = "";
      set((state) => {
        const result = createBoardFrame(state.nodes, bounds);
        nodeId = result.nodeId;
        return commandState(state, { nodes: result.nodes });
      });
      return nodeId;
    },
    arrangeNodes(nodeIds, operation) {
      let outcome: BoardNodeArrangeOutcome = {
        changed: false,
        movedNodeIds: [],
        reason: "insufficient-selection",
      };
      set((state) => {
        const result = arrangeBoardNodes(state.nodes, nodeIds, operation);
        outcome = result.changed
          ? { changed: true, movedNodeIds: result.movedNodeIds }
          : { changed: false, movedNodeIds: [], reason: result.reason };
        return result.changed ? commandState(state, { nodes: result.nodes }) : state;
      });
      return outcome;
    },
    duplicateNodes(nodeIds) {
      let createdNodeIds: string[] = [];
      set((state) => {
        const result = duplicateBoardNodes(state.nodes, state.edges, nodeIds);
        createdNodeIds = result.createdNodeIds;
        return result.changed
          ? commandState(state, { nodes: result.nodes, edges: result.edges })
          : state;
      });
      return createdNodeIds;
    },
    replaceArtifactVersionPins(artifactId, baseArtifactVersionId, resultArtifactVersionId) {
      const updatedNodeIds: string[] = [];
      set((state) => {
        if (!artifactId || !baseArtifactVersionId || !resultArtifactVersionId) return state;
        const nodes = state.nodes.map((node) => {
          if (
            node.workbench.artifactId !== artifactId
            || node.workbench.artifactVersionId !== baseArtifactVersionId
          ) {
            return node;
          }
          updatedNodeIds.push(node.id);
          return {
            ...node,
            workbench: {
              ...node.workbench,
              artifactVersionId: resultArtifactVersionId,
            },
          };
        });
        return updatedNodeIds.length > 0 ? commandState(state, { nodes }) : state;
      });
      return updatedNodeIds;
    },
    renameNode(nodeId, title) {
      let renamed = false;
      set((state) => {
        const result = renameBoardNode(state.nodes, nodeId, title);
        renamed = result.changed;
        return result.changed ? commandState(state, { nodes: result.nodes }) : state;
      });
      return renamed;
    },
    removeNodes(nodeIds) {
      let removedNodeIds: string[] = [];
      set((state) => {
        const result = removeBoardNodes(state.nodes, state.edges, nodeIds);
        removedNodeIds = result.removedNodeIds;
        return result.changed
          ? commandState(state, { nodes: result.nodes, edges: result.edges })
          : state;
      });
      return removedNodeIds;
    },
    nudgeNodes(nodeIds, delta) {
      const movedNodeIds: string[] = [];
      set((state) => {
        if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y) || (delta.x === 0 && delta.y === 0)) {
          return state;
        }
        const requested = new Set(nodeIds);
        const parentById = new Map(state.nodes.map((node) => [node.id, node.parentId ?? null]));
        const roots = new Set([...requested].filter((nodeId) => {
          let parentId = parentById.get(nodeId) ?? null;
          const visited = new Set<string>();
          while (parentId) {
            if (visited.has(parentId)) return true;
            visited.add(parentId);
            if (requested.has(parentId)) return false;
            parentId = parentById.get(parentId) ?? null;
          }
          return true;
        }));
        const nodes = state.nodes.map((node) => {
          if (!roots.has(node.id)) return node;
          movedNodeIds.push(node.id);
          return {
            ...node,
            position: {
              x: node.position.x + delta.x,
              y: node.position.y + delta.y,
            },
          };
        });
        return movedNodeIds.length > 0 ? commandState(state, { nodes }) : state;
      });
      return movedNodeIds;
    },
    setViewport(viewport) {
      set((state) => viewportEquals(state.viewport, viewport)
        ? state
        : editedState(state, { viewport: { ...viewport } }));
    },
    undo() {
      set((state) => {
        const previous = state.historyPast.at(-1);
        if (!previous) return state;
        const historyPast = state.historyPast.slice(0, -1);
        const historyFuture = appendHistory(state.historyFuture, historySnapshot(state));
        return {
          ...editedState(state, cloneHistorySnapshot(previous)),
          canUndo: historyPast.length > 0,
          canRedo: true,
          historyPast,
          historyFuture,
          historyGesture: null,
        };
      });
    },
    redo() {
      set((state) => {
        const next = state.historyFuture.at(-1);
        if (!next) return state;
        const historyPast = appendHistory(state.historyPast, historySnapshot(state));
        const historyFuture = state.historyFuture.slice(0, -1);
        return {
          ...editedState(state, cloneHistorySnapshot(next)),
          canUndo: true,
          canRedo: historyFuture.length > 0,
          historyPast,
          historyFuture,
          historyGesture: null,
        };
      });
    },
    replaceFromServer(nextBoard, nextEtag = revisionEtag(nextBoard.revision)) {
      confirmedServerRequest = canonicalBoardRequestFromBoard(nextBoard);
      set((state) => ({
        ...serverState(nextBoard, nextEtag),
        editVersion: state.editVersion + 1,
        dirty: false,
        saveStatus: "clean",
        activeSaveVersion: null,
        retrySaveSnapshot: null,
        lastSaveError: null,
        canUndo: false,
        canRedo: false,
        historyPast: [],
        historyFuture: [],
        historyGesture: null,
      }));
    },
    reconcileFromServer(nextBoard, nextEtag = revisionEtag(nextBoard.revision)) {
      const state = get();
      assertMatchingBoard(state, nextBoard);
      if (nextBoard.revision === state.serverRevision) return;
      const retrySnapshot = state.retrySaveSnapshot;
      if (retrySnapshot && savedBoardMatchesSnapshot(nextBoard, retrySnapshot)) {
        confirmedServerRequest = canonicalBoardRequestFromBoard(nextBoard);
        if (state.editVersion === retrySnapshot.editVersion) {
          set({
            ...serverState(nextBoard, nextEtag),
            dirty: false,
            saveStatus: "clean",
            activeSaveVersion: null,
            retrySaveSnapshot: null,
            lastSaveError: null,
          });
        } else {
          set({
            serverRevision: nextBoard.revision,
            etag: normalizeEtag(nextEtag),
            dirty: true,
            saveStatus: "dirty",
            activeSaveVersion: null,
            retrySaveSnapshot: null,
            lastSaveError: null,
          });
        }
        return;
      }
      const artifactAdditions = nextBoard.revision > state.serverRevision
        && (
          state.saveStatus === "dirty"
          || state.saveStatus === "saving"
          || state.saveStatus === "conflict"
          || (state.saveStatus === "error" && retrySnapshot !== null)
        )
        && localBoardContentMatchesServer(state, confirmedServerRequest)
        ? serverAutoMergeableArtifactAdditions(confirmedServerRequest, nextBoard)
        : null;
      if (artifactAdditions) {
        const nextProjection = boardToFlow(nextBoard);
        const additionIds = new Set(artifactAdditions.map((node) => node.id));
        const addedFlowNodes = nextProjection.nodes.filter((node) => additionIds.has(node.id));
        const viewportDirty = !viewportEquals(state.viewport, nextBoard.viewport);
        confirmedServerRequest = canonicalBoardRequestFromBoard(nextBoard);
        set({
          serverRevision: nextBoard.revision,
          etag: normalizeEtag(nextEtag),
          nodes: mergeRemoteNodes(state.nodes, nextProjection.nodes),
          editVersion: state.editVersion + (
            state.saveStatus !== "dirty" && viewportDirty ? 1 : 0
          ),
          dirty: viewportDirty,
          saveStatus: viewportDirty ? "dirty" : "clean",
          activeSaveVersion: null,
          retrySaveSnapshot: null,
          lastSaveError: null,
          historyPast: mergeRemoteAdditionsIntoHistory(state.historyPast, addedFlowNodes),
          historyFuture: mergeRemoteAdditionsIntoHistory(state.historyFuture, addedFlowNodes),
        });
        return;
      }
      if (state.dirty || state.saveStatus === "saving") {
        set({
          saveStatus: "conflict",
          activeSaveVersion: null,
          retrySaveSnapshot: null,
          lastSaveError: new BoardRemoteRevisionError(
            state.boardId,
            state.serverRevision,
            nextBoard.revision,
          ),
        });
        return;
      }
      state.replaceFromServer(nextBoard, nextEtag);
    },
    resolveConflictFromServer(
      nextBoard,
      resolution,
      nextEtag = revisionEtag(nextBoard.revision),
    ) {
      const state = get();
      assertMatchingBoard(state, nextBoard);
      if (state.saveStatus !== "conflict") {
        throw new Error("Board conflict resolution requires a conflicted Board");
      }
      if (nextBoard.revision < state.serverRevision) {
        throw new Error("Board conflict resolution cannot use an older server revision");
      }
      if (resolution === "discard-local") {
        state.replaceFromServer(nextBoard, nextEtag);
        return;
      }
      confirmedServerRequest = canonicalBoardRequestFromBoard(nextBoard);
      set({
        serverRevision: nextBoard.revision,
        etag: normalizeEtag(nextEtag),
        editVersion: state.editVersion + 1,
        dirty: true,
        saveStatus: "dirty",
        activeSaveVersion: null,
        retrySaveSnapshot: null,
        lastSaveError: null,
        historyGesture: null,
      });
    },
    prepareSave() {
      const state = get();
      if (!state.dirty || state.saveStatus === "saving" || state.saveStatus === "conflict") {
        return null;
      }

      const snapshot = state.retrySaveSnapshot ?? {
          boardId: state.boardId,
          projectId: state.projectId,
          baseRevision: state.serverRevision,
          ifMatch: state.etag,
          idempotencyKey: `board:${saveSessionId}:${state.editVersion}`,
          editVersion: state.editVersion,
          request: flowToBoardRequest(state.viewport, state.nodes, state.edges),
        };
      set({
        saveStatus: "saving",
        activeSaveVersion: snapshot.editVersion,
        lastSaveError: null,
      });
      return snapshot;
    },
    completeSave(snapshot, savedBoard, nextEtag = revisionEtag(savedBoard.revision)) {
      set((state) => {
        if (state.activeSaveVersion !== snapshot.editVersion) return state;
        assertMatchingBoard(state, savedBoard);
        confirmedServerRequest = canonicalBoardRequestFromBoard(savedBoard);

        if (state.editVersion !== snapshot.editVersion) {
          return {
            serverRevision: savedBoard.revision,
            etag: normalizeEtag(nextEtag),
            dirty: true,
            saveStatus: "dirty",
            activeSaveVersion: null,
            retrySaveSnapshot: null,
            lastSaveError: null,
          };
        }

        return {
          ...serverState(savedBoard, nextEtag),
          dirty: false,
          saveStatus: "clean",
          activeSaveVersion: null,
          retrySaveSnapshot: null,
          lastSaveError: null,
        };
      });
    },
    failSave(snapshot, error) {
      set((state) => {
        if (state.activeSaveVersion !== snapshot.editVersion) return state;
        const apiError = isWorkbenchApiError(error) ? error : null;
        const conflict = apiError?.status === 412
          || (apiError?.status === 409 && apiError.code === "IDEMPOTENCY_KEY_REUSED");
        const mayHaveCommitted = apiError === null || apiError.retryable;
        return {
          dirty: true,
          saveStatus: conflict ? "conflict" : "error",
          activeSaveVersion: null,
          retrySaveSnapshot: !conflict && mayHaveCommitted ? snapshot : null,
          lastSaveError: error,
        };
      });
    },
  }));
}

export function revisionEtag(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError("Board revision must be a non-negative safe integer");
  }
  return `"${revision}"`;
}

export class BoardRemoteRevisionError extends Error {
  constructor(boardId: string, localRevision: number, remoteRevision: number) {
    super(`Board ${boardId} changed remotely from revision ${localRevision} to ${remoteRevision}`);
    this.name = "BoardRemoteRevisionError";
  }
}

function serverState(board: Board, etag: string) {
  const projection = boardToFlow(board);
  return {
    boardId: projection.boardId,
    projectId: projection.projectId,
    serverRevision: projection.revision,
    etag: normalizeEtag(etag),
    viewport: projection.viewport,
    nodes: projection.nodes,
    edges: projection.edges,
  };
}

function normalizeEtag(etag: string): string {
  const normalized = etag.trim();
  if (!/^(?:W\/)?"\d+"$/.test(normalized)) {
    throw new Error(`Invalid Board ETag: ${etag}`);
  }
  return normalized;
}

function editedState(
  state: BoardStoreState,
  patch: Partial<Pick<BoardStoreState, "viewport" | "nodes" | "edges">>,
): Partial<BoardStoreState> {
  return {
    ...patch,
    editVersion: state.editVersion + 1,
    dirty: true,
    saveStatus: state.saveStatus === "saving"
      ? "saving"
      : state.saveStatus === "conflict"
        ? "conflict"
        : "dirty",
    lastSaveError: null,
  };
}

function commandState(
  state: BoardStoreState,
  patch: Partial<Pick<BoardStoreState, "nodes" | "edges">>,
): Partial<BoardStoreState> {
  const historyPast = appendHistory(state.historyPast, historySnapshot(state));
  return {
    ...editedState(state, patch),
    canUndo: true,
    canRedo: false,
    historyPast,
    historyFuture: [],
    historyGesture: null,
  };
}

function isPersistentChange(change: NodeChange<BoardFlowNode> | EdgeChange<BoardFlowEdge>): boolean {
  return change.type !== "select";
}

function isActiveNodeGesture(change: NodeChange<BoardFlowNode>): boolean {
  if (change.type === "position") return change.dragging === true;
  if (change.type === "dimensions") return change.resizing === true;
  return false;
}

function completesNodeGesture(changes: NodeChange<BoardFlowNode>[]): boolean {
  return changes.some((change) => (
    (change.type === "position" && change.dragging === false)
    || (change.type === "dimensions" && change.resizing === false)
  ));
}

function hasPersistentNodeDelta(
  before: BoardFlowNode[],
  after: BoardFlowNode[],
  changes: NodeChange<BoardFlowNode>[],
): boolean {
  const beforeById = new Map(before.map((node) => [node.id, node]));
  const afterById = new Map(after.map((node) => [node.id, node]));

  return changes.some((change) => {
    if (change.type === "select") return false;
    if (change.type === "add") return true;

    const previous = beforeById.get(change.id);
    const next = afterById.get(change.id);
    if (!previous || !next) return previous !== next;

    if (change.type === "position") {
      return previous.position.x !== next.position.x || previous.position.y !== next.position.y;
    }
    if (change.type === "dimensions") {
      if (change.resizing === undefined) return false;
      return !nodeSizeEquals(boardFlowNodeSize(previous), boardFlowNodeSize(next));
    }
    if (change.type === "replace") {
      return JSON.stringify(persistentNodeProjection(previous))
        !== JSON.stringify(persistentNodeProjection(next));
    }
    return false;
  });
}

function persistentNodeProjection(node: BoardFlowNode) {
  return flowToBoardRequest(
    { x: 0, y: 0, zoom: 1 },
    [node],
    [],
  ).nodes[0];
}

function nodeSizeEquals(
  left: { width: number; height: number } | null,
  right: { width: number; height: number } | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.width === right.width && left.height === right.height;
}

function historySnapshot(
  state: Pick<BoardStoreState, "nodes" | "edges">,
): BoardHistorySnapshot {
  return cloneHistorySnapshot({ nodes: state.nodes, edges: state.edges });
}

function cloneHistorySnapshot(snapshot: BoardHistorySnapshot): BoardHistorySnapshot {
  return structuredClone(snapshot);
}

function appendHistory(
  history: BoardHistorySnapshot[],
  snapshot: BoardHistorySnapshot,
): BoardHistorySnapshot[] {
  const next = [...history, snapshot];
  return next.length > 100 ? next.slice(next.length - 100) : next;
}

function viewportEquals(left: Viewport, right: Viewport): boolean {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function assertMatchingBoard(state: BoardStoreState, board: Board): void {
  if (state.boardId !== board.id || state.projectId !== board.projectId) {
    throw new Error(`Saved Board ${board.id} does not match active Board ${state.boardId}`);
  }
}

function savedBoardMatchesSnapshot(board: Board, snapshot: BoardSaveSnapshot): boolean {
  if (
    board.id !== snapshot.boardId
    || board.projectId !== snapshot.projectId
    || board.revision !== snapshot.baseRevision + 1
  ) {
    return false;
  }
  return equal(
    canonicalBoardRequest({
      viewport: board.viewport,
      nodes: board.nodes,
      edges: board.edges,
    }),
    canonicalBoardRequest(snapshot.request),
  );
}

function canonicalBoardRequestFromBoard(board: Board): ReplaceBoardRequest {
  return structuredClone(canonicalBoardRequest({
    viewport: board.viewport,
    nodes: board.nodes,
    edges: board.edges,
  }));
}

function localBoardContentMatchesServer(
  state: Pick<BoardStoreState, "viewport" | "nodes" | "edges">,
  serverRequest: ReplaceBoardRequest,
): boolean {
  const localRequest = canonicalBoardRequest(flowToBoardRequest(
    state.viewport,
    state.nodes,
    state.edges,
  ));
  return equal(localRequest.nodes, serverRequest.nodes)
    && equal(localRequest.edges, serverRequest.edges);
}

function serverAutoMergeableArtifactAdditions(
  currentServerRequest: ReplaceBoardRequest,
  nextBoard: Board,
): Board["nodes"] | null {
  const nextRequest = canonicalBoardRequestFromBoard(nextBoard);
  if (
    !equal(nextRequest.viewport, currentServerRequest.viewport)
    || !equal(nextRequest.edges, currentServerRequest.edges)
    || nextRequest.nodes.length <= currentServerRequest.nodes.length
  ) {
    return null;
  }

  const nextNodesById = new Map(nextRequest.nodes.map((node) => [node.id, node]));
  for (const currentNode of currentServerRequest.nodes) {
    if (!equal(nextNodesById.get(currentNode.id), currentNode)) return null;
  }

  const currentNodeIds = new Set(currentServerRequest.nodes.map((node) => node.id));
  const additions = nextRequest.nodes.filter((node) => !currentNodeIds.has(node.id));
  return additions.length > 0 && additions.every(isAutoMergeableRootArtifactNode) ? additions : null;
}

function isAutoMergeableRootArtifactNode(node: Board["nodes"][number]): boolean {
  return node.kind === "artifact"
    && node.parentNodeId === null
    && node.artifactId !== null
    && node.artifactVersionId !== null
    && node.data.nodeType === "artifact"
    && (node.data.artifactKind === "prd" || node.data.artifactKind === "prototype");
}

function mergeRemoteNodes(
  localNodes: BoardFlowNode[],
  remoteNodes: BoardFlowNode[],
): BoardFlowNode[] {
  const localNodesById = new Map(localNodes.map((node) => [node.id, node]));
  return remoteNodes.map((remoteNode) => localNodesById.get(remoteNode.id) ?? remoteNode);
}

function mergeRemoteAdditionsIntoHistory(
  history: BoardHistorySnapshot[],
  additions: BoardFlowNode[],
): BoardHistorySnapshot[] {
  if (additions.length === 0 || history.length === 0) return history;
  return history.map((snapshot) => {
    const existingIds = new Set(snapshot.nodes.map((node) => node.id));
    const missing = additions.filter((node) => !existingIds.has(node.id));
    if (missing.length === 0) return snapshot;
    return {
      ...snapshot,
      nodes: orderFlowNodesByHierarchy([
        ...snapshot.nodes,
        ...structuredClone(missing),
      ]),
    };
  });
}

function canonicalBoardRequest(request: ReplaceBoardRequest): ReplaceBoardRequest {
  return {
    viewport: request.viewport,
    nodes: orderBoardNodesByHierarchy(request.nodes),
    edges: [...request.edges].sort((left, right) => (
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    )),
  };
}
