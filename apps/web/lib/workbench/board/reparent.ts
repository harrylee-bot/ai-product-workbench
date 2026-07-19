import { orderFlowNodesByHierarchy, type BoardFlowNode } from "./adapter";
import {
  absoluteNodePositions,
  absoluteNodeRect,
  containsBoardRect,
} from "./geometry";

export type ReparentBoardNodesResult = {
  changed: boolean;
  nodes: BoardFlowNode[];
};

export function reparentBoardNodesAfterDrag(
  nodes: readonly BoardFlowNode[],
  draggedNodeIds: readonly string[],
): ReparentBoardNodesResult {
  const requestedIds = new Set(draggedNodeIds);
  if (requestedIds.size === 0) return { changed: false, nodes: [...nodes] };

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const draggedRoots = nodes.filter((node) => (
    requestedIds.has(node.id) && !hasRequestedAncestor(node, requestedIds, byId)
  ));
  if (draggedRoots.length === 0) return { changed: false, nodes: [...nodes] };

  const absolutePositions = absoluteNodePositions(nodes);
  const excludedFrameIds = new Set(requestedIds);
  for (const root of draggedRoots) addDescendantIds(root.id, nodes, excludedFrameIds);

  const targets = new Map<string, BoardFlowNode | undefined>();
  for (const root of draggedRoots) {
    const rootRect = absoluteNodeRect(root, absolutePositions);
    if (!rootRect) continue;
    const target = nodes
      .filter((candidate) => (
        candidate.workbench.kind === "frame" && !excludedFrameIds.has(candidate.id)
      ))
      .flatMap((candidate) => {
        const candidateRect = absoluteNodeRect(candidate, absolutePositions);
        return candidateRect && containsBoardRect(candidateRect, rootRect)
          ? [{ candidate, area: candidateRect.width * candidateRect.height }]
          : [];
      })
      .sort((left, right) => (
        left.area - right.area
        || left.candidate.workbench.order - right.candidate.workbench.order
        || compareIds(left.candidate.id, right.candidate.id)
      ))[0]?.candidate;
    targets.set(root.id, target);
  }

  const rootsToMove = draggedRoots.filter((root) => (
    (root.parentId ?? undefined) !== targets.get(root.id)?.id
  ));
  if (rootsToMove.length === 0) return { changed: false, nodes: [...nodes] };

  const nextOrderByParent = nextSiblingOrders(nodes, new Set(rootsToMove.map((node) => node.id)));
  const replacements = new Map<string, BoardFlowNode>();
  for (const root of rootsToMove) {
    const absolute = absolutePositions.get(root.id)!;
    const target = targets.get(root.id);
    const targetPosition = target ? absolutePositions.get(target.id)! : { x: 0, y: 0 };
    const parentKey = target?.id ?? null;
    const order = nextOrderByParent.get(parentKey) ?? 0;
    nextOrderByParent.set(parentKey, order + 1);
    replacements.set(root.id, withParent(root, target?.id, {
      x: absolute.x - targetPosition.x,
      y: absolute.y - targetPosition.y,
    }, order));
  }

  return {
    changed: true,
    nodes: orderFlowNodesByHierarchy(nodes.map((node) => replacements.get(node.id) ?? node)),
  };
}

function hasRequestedAncestor(
  node: BoardFlowNode,
  requestedIds: ReadonlySet<string>,
  byId: ReadonlyMap<string, BoardFlowNode>,
): boolean {
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId) {
    if (visited.has(parentId)) throw new Error(`Board node hierarchy contains a cycle at ${parentId}`);
    if (requestedIds.has(parentId)) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

function addDescendantIds(
  parentId: string,
  nodes: readonly BoardFlowNode[],
  ids: Set<string>,
): void {
  for (const node of nodes) {
    if (node.parentId !== parentId || ids.has(node.id)) continue;
    ids.add(node.id);
    addDescendantIds(node.id, nodes, ids);
  }
}

function nextSiblingOrders(
  nodes: readonly BoardFlowNode[],
  movingIds: ReadonlySet<string>,
): Map<string | null, number> {
  const next = new Map<string | null, number>();
  for (const node of nodes) {
    if (movingIds.has(node.id)) continue;
    const parentId = node.parentId ?? null;
    next.set(parentId, Math.max(next.get(parentId) ?? 0, node.workbench.order + 1));
  }
  return next;
}

function withParent(
  node: BoardFlowNode,
  parentId: string | undefined,
  position: { x: number; y: number },
  order: number,
): BoardFlowNode {
  const { parentId: _oldParentId, ...withoutParent } = node;
  return {
    ...withoutParent,
    ...(parentId ? { parentId } : {}),
    position,
    workbench: { ...node.workbench, order },
  };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
