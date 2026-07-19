import {
  boardNodeProtocol,
  maximumBoardDrawingPointCount,
  type Artifact,
} from "@workbench/workbench-contracts";
import { nanoid } from "nanoid";

import { orderFlowNodesByHierarchy, type BoardFlowNode } from "./adapter";

export type BoardRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BoardDrawingSample = {
  x: number;
  y: number;
  pressure: number;
};

export type CreateBoardDrawingOptions = {
  size?: number;
  color?: string;
  simulatePressure?: boolean;
};

export type CreateBoardArtifactInput = BoardRect & {
  artifactId: string;
  artifactVersionId: string;
  artifactKind: Artifact["kind"];
  title: string;
  screenId?: string;
  route?: string;
};

export type CreateBoardToolNodeResult = {
  nodeId: string;
  nodes: BoardFlowNode[];
};

type IdFactory = () => string;

const defaultFrameStroke = "#5f6368";
const defaultDrawingColor = "#f1f3f4";

export function createBoardArtifact(
  nodes: readonly BoardFlowNode[],
  input: CreateBoardArtifactInput,
  idFactory: IdFactory = () => nanoid(16),
): CreateBoardToolNodeResult {
  const bounds = normalizedRect(input);
  const artifactId = requiredArtifactId(input.artifactId, "Artifact id");
  const artifactVersionId = requiredArtifactId(input.artifactVersionId, "Artifact version id");
  const title = normalizedArtifactTitle(input.title);
  const absolutePositions = absoluteNodePositions(nodes);
  const parent = smallestContainingFrame(nodes, bounds, absolutePositions);
  const parentPosition = parent ? absolutePositions.get(parent.id)! : { x: 0, y: 0 };
  const nodeId = uniqueNodeId("artifact", nodes, idFactory);
  const artifact: BoardFlowNode = {
    id: nodeId,
    type: "artifact",
    ...(parent ? { parentId: parent.id } : {}),
    position: {
      x: bounds.x - parentPosition.x,
      y: bounds.y - parentPosition.y,
    },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title,
      artifactKind: input.artifactKind,
      ...(input.screenId ? { screenId: input.screenId } : {}),
      ...(input.route ? { route: input.route } : {}),
    },
    draggable: true,
    selected: true,
    style: { width: bounds.width, height: bounds.height },
    workbench: {
      kind: "artifact",
      order: nextSiblingOrder(nodes, parent?.id),
      artifactId,
      artifactVersionId,
      size: { width: bounds.width, height: bounds.height },
    },
  };

  return {
    nodeId,
    nodes: orderFlowNodesByHierarchy([
      ...nodes.map((node) => node.selected ? { ...node, selected: false } : node),
      artifact,
    ]),
  };
}

export function createBoardFrame(
  nodes: readonly BoardFlowNode[],
  input: BoardRect,
  idFactory: IdFactory = () => nanoid(16),
): CreateBoardToolNodeResult {
  const bounds = normalizedRect(input);
  const nodeId = uniqueNodeId("frame", nodes, idFactory);
  const absolutePositions = absoluteNodePositions(nodes);
  const parent = smallestContainingFrame(nodes, bounds, absolutePositions);
  const parentPosition = parent ? absolutePositions.get(parent.id)! : { x: 0, y: 0 };
  const parentId = parent?.id;
  const directChildren = nodes.filter((node) => (node.parentId ?? undefined) === parentId);
  const enclosed = directChildren
    .filter((node) => {
      const rect = absoluteNodeRect(node, absolutePositions);
      return rect !== null && containsRect(bounds, rect);
    })
    .sort(compareFlowNodeOrder);
  const enclosedOrder = new Map(enclosed.map((node, index) => [node.id, index]));
  const title = `Frame ${nodes.filter((node) => node.workbench.kind === "frame").length + 1}`;
  const frame: BoardFlowNode = {
    id: nodeId,
    type: "frame",
    ...(parentId ? { parentId } : {}),
    position: {
      x: bounds.x - parentPosition.x,
      y: bounds.y - parentPosition.y,
    },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "frame",
      title,
      fill: null,
      stroke: defaultFrameStroke,
    },
    selected: true,
    style: { width: bounds.width, height: bounds.height },
    workbench: {
      kind: "frame",
      order: nextSiblingOrder(nodes, parentId),
      artifactId: null,
      artifactVersionId: null,
      size: { width: bounds.width, height: bounds.height },
    },
  };

  const nextNodes = nodes.map((node) => {
    const absolute = absolutePositions.get(node.id)!;
    if (enclosedOrder.has(node.id)) {
      return {
        ...node,
        parentId: nodeId,
        position: { x: absolute.x - bounds.x, y: absolute.y - bounds.y },
        selected: false,
        workbench: { ...node.workbench, order: enclosedOrder.get(node.id)! },
      };
    }
    return node.selected ? { ...node, selected: false } : node;
  });

  return { nodeId, nodes: orderFlowNodesByHierarchy([...nextNodes, frame]) };
}

export function createBoardDrawing(
  nodes: readonly BoardFlowNode[],
  samples: readonly BoardDrawingSample[],
  options: CreateBoardDrawingOptions = {},
  idFactory: IdFactory = () => nanoid(16),
): CreateBoardToolNodeResult {
  if (samples.length === 0) throw new Error("A Board drawing requires at least one point");
  if (samples.length > maximumBoardDrawingPointCount) {
    throw new Error(`A Board drawing cannot exceed ${maximumBoardDrawingPointCount} points`);
  }
  const size = clamp(options.size ?? 5, 1, 256);
  const padding = Math.max(2, (size / 2) + 1);
  const sampleBounds = pointsBounds(samples);
  const bounds = {
    x: sampleBounds.x - padding,
    y: sampleBounds.y - padding,
    width: Math.max(size + 2, sampleBounds.width + (padding * 2)),
    height: Math.max(size + 2, sampleBounds.height + (padding * 2)),
  };
  const absolutePositions = absoluteNodePositions(nodes);
  const parent = smallestContainingFrame(nodes, bounds, absolutePositions);
  const parentPosition = parent ? absolutePositions.get(parent.id)! : { x: 0, y: 0 };
  const nodeId = uniqueNodeId("drawing", nodes, idFactory);
  const title = `Drawing ${nodes.filter((node) => node.workbench.kind === "drawing").length + 1}`;
  const drawing: BoardFlowNode = {
    id: nodeId,
    type: "drawing",
    ...(parent ? { parentId: parent.id } : {}),
    position: {
      x: bounds.x - parentPosition.x,
      y: bounds.y - parentPosition.y,
    },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "drawing",
      title,
      stroke: {
        algorithm: "perfect-freehand@1",
        intrinsicSize: { width: bounds.width, height: bounds.height },
        points: samples.map((point) => [
          point.x - bounds.x,
          point.y - bounds.y,
          clamp(point.pressure, 0, 1),
        ]),
        color: options.color ?? defaultDrawingColor,
        size,
        thinning: 0.55,
        smoothing: 0.65,
        streamline: 0.55,
        simulatePressure: options.simulatePressure ?? true,
      },
    },
    draggable: true,
    selected: true,
    style: { width: bounds.width, height: bounds.height },
    workbench: {
      kind: "drawing",
      order: nextSiblingOrder(nodes, parent?.id),
      artifactId: null,
      artifactVersionId: null,
      size: { width: bounds.width, height: bounds.height },
    },
  };

  return {
    nodeId,
    nodes: orderFlowNodesByHierarchy([
      ...nodes.map((node) => node.selected ? { ...node, selected: false } : node),
      drawing,
    ]),
  };
}

function normalizedRect(rect: BoardRect): BoardRect {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  const width = Math.abs(rect.width);
  const height = Math.abs(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error("Board tool bounds must be finite and positive");
  }
  return { x, y, width, height };
}

function requiredArtifactId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 128) throw new Error(`${label} cannot exceed 128 characters`);
  return normalized;
}

function normalizedArtifactTitle(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Artifact title is required");
  if (normalized.length > 160) throw new Error("Artifact title cannot exceed 160 characters");
  return normalized;
}

function pointsBounds(points: readonly BoardDrawingSample[]): BoardRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  if (![...xs, ...ys].every(Number.isFinite)) throw new Error("Board drawing points must be finite");
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function uniqueNodeId(prefix: string, nodes: readonly BoardFlowNode[], idFactory: IdFactory): string {
  const ids = new Set(nodes.map((node) => node.id));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = `${prefix}_${idFactory()}`.slice(0, 128);
    if (!ids.has(id)) return id;
  }
  throw new Error(`Unable to allocate a unique ${prefix} node id`);
}

function smallestContainingFrame(
  nodes: readonly BoardFlowNode[],
  rect: BoardRect,
  absolutePositions: ReadonlyMap<string, { x: number; y: number }>,
): BoardFlowNode | undefined {
  return nodes
    .filter((node) => node.workbench.kind === "frame")
    .flatMap((node) => {
      const frameRect = absoluteNodeRect(node, absolutePositions);
      return frameRect && containsRect(frameRect, rect) ? [{ node, area: frameRect.width * frameRect.height }] : [];
    })
    .sort((left, right) => left.area - right.area)[0]?.node;
}

function absoluteNodeRect(
  node: BoardFlowNode,
  absolutePositions: ReadonlyMap<string, { x: number; y: number }>,
): BoardRect | null {
  const position = absolutePositions.get(node.id);
  const size = nodeSize(node);
  return position && size ? { ...position, ...size } : null;
}

function nodeSize(node: BoardFlowNode): { width: number; height: number } | null {
  if (node.workbench.size) return node.workbench.size;
  const width = typeof node.style?.width === "number" ? node.style.width : node.width;
  const height = typeof node.style?.height === "number" ? node.style.height : node.height;
  return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0
    ? { width: width!, height: height! }
    : null;
}

function absoluteNodePositions(nodes: readonly BoardFlowNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map<string, { x: number; y: number }>();
  const resolving = new Set<string>();
  const resolve = (node: BoardFlowNode): { x: number; y: number } => {
    const cached = positions.get(node.id);
    if (cached) return cached;
    if (resolving.has(node.id)) throw new Error(`Board node hierarchy contains a cycle at ${node.id}`);
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

function containsRect(container: BoardRect, child: BoardRect): boolean {
  return child.x >= container.x
    && child.y >= container.y
    && child.x + child.width <= container.x + container.width
    && child.y + child.height <= container.y + container.height;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function nextSiblingOrder(nodes: readonly BoardFlowNode[], parentId: string | undefined): number {
  return nodes.reduce((maximum, node) => (
    (node.parentId ?? undefined) === parentId
      ? Math.max(maximum, node.workbench.order)
      : maximum
  ), -1) + 1;
}

function compareFlowNodeOrder(left: BoardFlowNode, right: BoardFlowNode): number {
  if (left.workbench.order !== right.workbench.order) {
    return left.workbench.order - right.workbench.order;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
