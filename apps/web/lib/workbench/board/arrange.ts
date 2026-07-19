import type { BoardFlowNode } from "./adapter";
import {
  absoluteNodePositions,
  absoluteNodeRect,
  type BoardFlowPoint,
  type BoardFlowRect,
} from "./geometry";

export type BoardNodeAlignment =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom";

export type BoardNodeDistributionAxis = "horizontal" | "vertical";

export type BoardNodeArrangeOperation =
  | { kind: "align"; alignment: BoardNodeAlignment }
  | { kind: "distribute"; axis: BoardNodeDistributionAxis };

export type BoardNodeArrangeNoopReason =
  | "insufficient-selection"
  | "missing-size"
  | "unchanged";

export type BoardNodeArrangeOutcome =
  | {
      changed: true;
      movedNodeIds: string[];
    }
  | {
      changed: false;
      movedNodeIds: [];
      reason: BoardNodeArrangeNoopReason;
    };

export type ArrangeBoardNodesResult = BoardNodeArrangeOutcome & {
  nodes: BoardFlowNode[];
};

type ArrangeTarget = {
  node: BoardFlowNode;
  rect: BoardFlowRect;
};

const COORDINATE_PRECISION = 1_000_000;

export function arrangeBoardNodes(
  nodes: readonly BoardFlowNode[],
  nodeIds: readonly string[],
  operation: BoardNodeArrangeOperation,
): ArrangeBoardNodesResult {
  const selectedRoots = selectedRootNodes(nodes, nodeIds);
  const minimumSelection = operation.kind === "distribute" ? 3 : 2;
  if (selectedRoots.length < minimumSelection) {
    return noop(nodes, "insufficient-selection");
  }

  const absolutePositions = absoluteNodePositions(nodes);
  const targets: ArrangeTarget[] = [];
  for (const node of selectedRoots) {
    const rect = absoluteNodeRect(node, absolutePositions);
    if (!rect) return noop(nodes, "missing-size");
    targets.push({ node, rect });
  }

  const arrangedPositions = operation.kind === "align"
    ? alignedAbsolutePositions(targets, operation.alignment)
    : distributedAbsolutePositions(targets, operation.axis);
  const replacements = new Map<string, BoardFlowNode>();

  for (const target of targets) {
    const absolute = arrangedPositions.get(target.node.id);
    if (!absolute) continue;
    const parentPosition = target.node.parentId
      ? absolutePositions.get(target.node.parentId) ?? { x: 0, y: 0 }
      : { x: 0, y: 0 };
    const position = {
      x: canonicalCoordinate(absolute.x - parentPosition.x),
      y: canonicalCoordinate(absolute.y - parentPosition.y),
    };
    if (
      position.x === target.node.position.x
      && position.y === target.node.position.y
    ) {
      continue;
    }
    replacements.set(target.node.id, { ...target.node, position });
  }

  if (replacements.size === 0) return noop(nodes, "unchanged");
  return {
    changed: true,
    movedNodeIds: nodes.flatMap((node) => replacements.has(node.id) ? [node.id] : []),
    nodes: nodes.map((node) => replacements.get(node.id) ?? node),
  };
}

function selectedRootNodes(
  nodes: readonly BoardFlowNode[],
  requestedNodeIds: readonly string[],
): BoardFlowNode[] {
  const requested = new Set(requestedNodeIds);
  const selectedIds = new Set(
    nodes.flatMap((node) => requested.has(node.id) ? [node.id] : []),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return nodes.filter((node) => (
    selectedIds.has(node.id) && !hasSelectedAncestor(node, selectedIds, byId)
  ));
}

function hasSelectedAncestor(
  node: BoardFlowNode,
  selectedIds: ReadonlySet<string>,
  nodesById: ReadonlyMap<string, BoardFlowNode>,
): boolean {
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId) {
    if (visited.has(parentId)) {
      throw new Error(`Board node hierarchy contains a cycle at ${parentId}`);
    }
    if (selectedIds.has(parentId)) return true;
    visited.add(parentId);
    parentId = nodesById.get(parentId)?.parentId;
  }
  return false;
}

function alignedAbsolutePositions(
  targets: readonly ArrangeTarget[],
  alignment: BoardNodeAlignment,
): ReadonlyMap<string, BoardFlowPoint> {
  const bounds = selectionBounds(targets);
  const centerX = bounds.x + bounds.width / 2;
  const middleY = bounds.y + bounds.height / 2;

  return new Map(targets.map(({ node, rect }) => {
    switch (alignment) {
      case "left":
        return [node.id, { x: bounds.x, y: rect.y }];
      case "center":
        return [node.id, { x: centerX - rect.width / 2, y: rect.y }];
      case "right":
        return [node.id, { x: bounds.x + bounds.width - rect.width, y: rect.y }];
      case "top":
        return [node.id, { x: rect.x, y: bounds.y }];
      case "middle":
        return [node.id, { x: rect.x, y: middleY - rect.height / 2 }];
      case "bottom":
        return [node.id, { x: rect.x, y: bounds.y + bounds.height - rect.height }];
    }
  }));
}

function distributedAbsolutePositions(
  targets: readonly ArrangeTarget[],
  axis: BoardNodeDistributionAxis,
): ReadonlyMap<string, BoardFlowPoint> {
  const horizontal = axis === "horizontal";
  const ordered = [...targets].sort((left, right) => (
    (horizontal ? left.rect.x - right.rect.x : left.rect.y - right.rect.y)
    || compareIds(left.node.id, right.node.id)
  ));
  const start = Math.min(...ordered.map(({ rect }) => horizontal ? rect.x : rect.y));
  const end = Math.max(...ordered.map(({ rect }) => (
    horizontal ? rect.x + rect.width : rect.y + rect.height
  )));
  const occupied = ordered.reduce((total, { rect }) => (
    total + (horizontal ? rect.width : rect.height)
  ), 0);
  const gap = (end - start - occupied) / (ordered.length - 1);
  const positions = new Map<string, BoardFlowPoint>();
  let cursor = start;

  for (const { node, rect } of ordered) {
    positions.set(node.id, horizontal
      ? { x: cursor, y: rect.y }
      : { x: rect.x, y: cursor });
    cursor += (horizontal ? rect.width : rect.height) + gap;
  }
  return positions;
}

function selectionBounds(targets: readonly ArrangeTarget[]): BoardFlowRect {
  const left = Math.min(...targets.map(({ rect }) => rect.x));
  const top = Math.min(...targets.map(({ rect }) => rect.y));
  const right = Math.max(...targets.map(({ rect }) => rect.x + rect.width));
  const bottom = Math.max(...targets.map(({ rect }) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function noop(
  nodes: readonly BoardFlowNode[],
  reason: BoardNodeArrangeNoopReason,
): ArrangeBoardNodesResult {
  return { changed: false, movedNodeIds: [], nodes: [...nodes], reason };
}

function canonicalCoordinate(value: number): number {
  const rounded = Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
