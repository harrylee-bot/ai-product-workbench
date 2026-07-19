import {
  canvasClientStateSyncRequestSchema,
  canvasSnapshotSchema,
  maximumCanvasScreenCount,
  type CanvasClientStateSyncRequest,
  type CanvasScreenReference,
  type CanvasScreenSummary,
  type CanvasSnapshot,
} from "@workbench/workbench-contracts";
import type { Viewport } from "@xyflow/system";

import type { BoardFlowNode } from "../../../board";

export const DEFAULT_CANVAS_AGENT_SELECTED_SCREEN_LIMIT = maximumCanvasScreenCount;
export const DEFAULT_CANVAS_AGENT_VISIBLE_SCREEN_LIMIT = maximumCanvasScreenCount;

export type CanvasAgentScreenReference = CanvasScreenReference;

export type CanvasAgentStageSize = {
  height: number;
  width: number;
};

type BoardFlowRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type CanvasAgentScreenProjection = {
  selectedScreenCount: number;
  selectedScreens: CanvasAgentScreenReference[];
  selectedScreensTruncated: boolean;
  visibleScreenCount: number;
  visibleScreens: CanvasAgentScreenReference[];
  visibleScreensTruncated: boolean;
};

export type ProjectCanvasAgentScreensInput = {
  nodes: readonly BoardFlowNode[];
  stage: CanvasAgentStageSize;
  viewport: Viewport;
  limits?: {
    selectedScreens?: number;
    visibleScreens?: number;
  };
};

export type CreateCanvasAgentSnapshotInput = {
  boardId: string;
  boardRevision: number;
  canvasStateRevision: number;
  capturedAt: string;
  clientSessionId: string;
  expiresAt: string;
  nodes: readonly BoardFlowNode[];
  projectId: string;
  projectSessionGeneration: number;
  runId: string | null;
  screens: readonly CanvasScreenSummary[];
  stage: CanvasAgentStageSize;
  threadId: string;
  viewport: Viewport;
};

export function createCanvasAgentSnapshot(
  input: CreateCanvasAgentSnapshotInput,
): CanvasSnapshot {
  const screens = input.screens.slice(0, maximumCanvasScreenCount);
  const knownReferences = new Set(screens.map(({ reference }) => screenReferenceKey(reference)));
  const projection = projectCanvasAgentScreens({
    nodes: input.nodes,
    stage: input.stage,
    viewport: input.viewport,
  });
  return canvasSnapshotSchema.parse({
    protocol: "workbench.canvas-snapshot.v1",
    projectId: input.projectId,
    threadId: input.threadId,
    runId: input.runId,
    boardId: input.boardId,
    clientSessionId: input.clientSessionId,
    projectSessionGeneration: input.projectSessionGeneration,
    boardRevision: input.boardRevision,
    canvasStateRevision: input.canvasStateRevision,
    capturedAt: input.capturedAt,
    expiresAt: input.expiresAt,
    viewport: input.viewport,
    screens,
    visibleScreens: projection.visibleScreens.filter((reference) => (
      knownReferences.has(screenReferenceKey(reference))
    )),
    selectedScreens: projection.selectedScreens.filter((reference) => (
      knownReferences.has(screenReferenceKey(reference))
    )),
  });
}

export function createCanvasAgentClientStateSyncRequest(
  snapshot: CanvasSnapshot,
): CanvasClientStateSyncRequest {
  return canvasClientStateSyncRequestSchema.parse({
    protocol: "workbench.canvas-client-state.v1",
    clientSessionId: snapshot.clientSessionId,
    projectSessionGeneration: snapshot.projectSessionGeneration,
    boardId: snapshot.boardId,
    boardRevision: snapshot.boardRevision,
    canvasStateRevision: snapshot.canvasStateRevision,
    viewport: snapshot.viewport,
    visibleScreens: snapshot.visibleScreens,
    selectedScreens: snapshot.selectedScreens,
  });
}

export function projectCanvasAgentScreens(
  input: ProjectCanvasAgentScreensInput,
): CanvasAgentScreenProjection {
  const screenNodes = input.nodes.flatMap((node) => {
    const reference = screenReferenceFromBoardFlowNode(node);
    return reference ? [{ node, reference }] : [];
  });
  const selected = screenNodes
    .filter(({ node }) => node.selected === true)
    .map(({ reference }) => reference);
  const visible = visibleWorldRect(input.viewport, input.stage);
  const visibleScreens = visible
    ? selectVisibleScreens(screenNodes, input.nodes, visible)
    : [];
  const selectedLimit = normalizeLimit(
    input.limits?.selectedScreens,
    DEFAULT_CANVAS_AGENT_SELECTED_SCREEN_LIMIT,
  );
  const visibleLimit = normalizeLimit(
    input.limits?.visibleScreens,
    DEFAULT_CANVAS_AGENT_VISIBLE_SCREEN_LIMIT,
  );

  return {
    selectedScreenCount: selected.length,
    selectedScreens: selected.slice(0, selectedLimit),
    selectedScreensTruncated: selected.length > selectedLimit,
    visibleScreenCount: visibleScreens.length,
    visibleScreens: visibleScreens.slice(0, visibleLimit),
    visibleScreensTruncated: visibleScreens.length > visibleLimit,
  };
}

export function screenReferenceFromBoardFlowNode(
  node: BoardFlowNode,
): CanvasAgentScreenReference | null {
  if (
    node.workbench.kind !== "artifact"
    || node.data.nodeType !== "artifact"
    || !isNonEmptyString(node.id)
    || !isNonEmptyString(node.workbench.artifactId)
    || !isNonEmptyString(node.workbench.artifactVersionId)
    || !isNonEmptyString(node.data.screenId)
  ) {
    return null;
  }
  return {
    artifactId: node.workbench.artifactId,
    artifactVersionId: node.workbench.artifactVersionId,
    boardNodeId: node.id,
    screenId: node.data.screenId,
  };
}

function selectVisibleScreens(
  screenNodes: readonly {
    node: BoardFlowNode;
    reference: CanvasAgentScreenReference;
  }[],
  allNodes: readonly BoardFlowNode[],
  visible: BoardFlowRect,
): CanvasAgentScreenReference[] {
  try {
    const absolutePositions = absoluteNodePositions(allNodes);
    return screenNodes.flatMap(({ node, reference }) => {
      const rect = absoluteNodeRect(node, absolutePositions);
      return rect && intersects(rect, visible) ? [reference] : [];
    });
  } catch {
    return [];
  }
}

function absoluteNodePositions(
  nodes: readonly BoardFlowNode[],
): ReadonlyMap<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map<string, { x: number; y: number }>();
  const resolving = new Set<string>();
  const resolve = (node: BoardFlowNode): { x: number; y: number } => {
    const cached = positions.get(node.id);
    if (cached) return cached;
    if (resolving.has(node.id)) throw new Error("Board node hierarchy contains a cycle");
    resolving.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const parentPosition = parent ? resolve(parent) : { x: 0, y: 0 };
    const position = {
      x: parentPosition.x + node.position.x,
      y: parentPosition.y + node.position.y,
    };
    resolving.delete(node.id);
    positions.set(node.id, position);
    return position;
  };
  nodes.forEach(resolve);
  return positions;
}

function absoluteNodeRect(
  node: BoardFlowNode,
  absolutePositions: ReadonlyMap<string, { x: number; y: number }>,
): BoardFlowRect | null {
  const position = absolutePositions.get(node.id);
  const size = boardFlowNodeSize(node);
  return position && size ? { ...position, ...size } : null;
}

function boardFlowNodeSize(node: BoardFlowNode): { height: number; width: number } | null {
  if (isPositiveFinite(node.measured?.width) && isPositiveFinite(node.measured?.height)) {
    return { width: node.measured.width, height: node.measured.height };
  }
  if (isPositiveFinite(node.width) && isPositiveFinite(node.height)) {
    return { width: node.width, height: node.height };
  }
  if (node.workbench.size) return { ...node.workbench.size };
  const width = typeof node.style?.width === "number" ? node.style.width : undefined;
  const height = typeof node.style?.height === "number" ? node.style.height : undefined;
  return isPositiveFinite(width) && isPositiveFinite(height) ? { width, height } : null;
}

function visibleWorldRect(
  viewport: Viewport,
  stage: CanvasAgentStageSize,
): BoardFlowRect | null {
  if (
    !isFiniteNumber(viewport.x)
    || !isFiniteNumber(viewport.y)
    || !isPositiveFinite(viewport.zoom)
    || !isPositiveFinite(stage.width)
    || !isPositiveFinite(stage.height)
  ) {
    return null;
  }
  const rect = {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: stage.width / viewport.zoom,
    height: stage.height / viewport.zoom,
  };
  return Object.values(rect).every(isFiniteNumber) ? rect : null;
}

function intersects(left: BoardFlowRect, right: BoardFlowRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0
    ? value
    : fallback;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function screenReferenceKey(reference: CanvasScreenReference): string {
  return [
    reference.boardNodeId,
    reference.artifactId,
    reference.artifactVersionId,
    reference.screenId,
  ].join("\u0000");
}
