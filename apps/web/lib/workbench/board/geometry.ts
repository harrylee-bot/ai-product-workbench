import type { BoardFlowNode } from "./adapter";

export type BoardFlowPoint = {
  x: number;
  y: number;
};

export type BoardFlowRect = BoardFlowPoint & {
  width: number;
  height: number;
};

export function absoluteNodePositions(
  nodes: readonly BoardFlowNode[],
): ReadonlyMap<string, BoardFlowPoint> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map<string, BoardFlowPoint>();
  const resolving = new Set<string>();

  const resolve = (node: BoardFlowNode): BoardFlowPoint => {
    const cached = positions.get(node.id);
    if (cached) return cached;
    if (resolving.has(node.id)) {
      throw new Error(`Board node hierarchy contains a cycle at ${node.id}`);
    }
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

export function absoluteNodeRect(
  node: BoardFlowNode,
  absolutePositions: ReadonlyMap<string, BoardFlowPoint>,
): BoardFlowRect | null {
  const position = absolutePositions.get(node.id);
  const size = boardFlowNodeSize(node);
  return position && size ? { ...position, ...size } : null;
}

export function boardFlowNodeSize(
  node: BoardFlowNode,
): { width: number; height: number } | null {
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

export function containsBoardRect(container: BoardFlowRect, child: BoardFlowRect): boolean {
  return child.x >= container.x
    && child.y >= container.y
    && child.x + child.width <= container.x + container.width
    && child.y + child.height <= container.y + container.height;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
