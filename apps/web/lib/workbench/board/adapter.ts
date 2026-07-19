import type {
  Board,
  BoardNodeData,
  ReplaceBoardRequest,
} from "@workbench/workbench-contracts";
import { orderBoardNodesByHierarchy } from "@workbench/workbench-contracts";
import type { EdgeBase, NodeBase, Viewport } from "@xyflow/system";
import type { CSSProperties } from "react";

export type BoardDomainNode = Board["nodes"][number];
export type BoardDomainEdge = Board["edges"][number];

export type BoardFlowNode = NodeBase<BoardNodeData, BoardDomainNode["kind"]> & {
  style?: CSSProperties;
  workbench: {
    kind: BoardDomainNode["kind"];
    order: number;
    artifactId: string | null;
    artifactVersionId: string | null;
    size: BoardDomainNode["size"];
  };
};

export type BoardFlowEdge = EdgeBase<Record<string, unknown>> & {
  workbench: {
    kind: string;
  };
};

export type BoardFlowProjection = {
  boardId: string;
  projectId: string;
  revision: number;
  viewport: Viewport;
  nodes: BoardFlowNode[];
  edges: BoardFlowEdge[];
};

export function boardToFlow(board: Board): BoardFlowProjection {
  return {
    boardId: board.id,
    projectId: board.projectId,
    revision: board.revision,
    viewport: { ...board.viewport },
    nodes: orderBoardNodesByHierarchy(board.nodes).map(boardNodeToFlow),
    edges: board.edges.map(boardEdgeToFlow),
  };
}

export function flowToBoardRequest(
  viewport: Viewport,
  nodes: BoardFlowNode[],
  edges: BoardFlowEdge[],
): ReplaceBoardRequest {
  return {
    viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
    nodes: orderBoardNodesByHierarchy(nodes.map(flowNodeToBoard)),
    edges: edges.map(flowEdgeToBoard),
  };
}

function boardNodeToFlow(node: BoardDomainNode): BoardFlowNode {
  return {
    id: node.id,
    type: node.kind,
    ...(node.parentNodeId === null ? {} : { parentId: node.parentNodeId }),
    position: { ...node.position },
    data: { ...node.data },
    style: node.size ? { width: node.size.width, height: node.size.height } : undefined,
    workbench: {
      kind: node.kind,
      order: node.order,
      artifactId: node.artifactId,
      artifactVersionId: node.artifactVersionId,
      size: node.size ? { ...node.size } : null,
    },
  };
}

function boardEdgeToFlow(edge: BoardDomainEdge): BoardFlowEdge {
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: edge.kind,
    data: { ...edge.data },
    workbench: { kind: edge.kind },
  };
}

function flowNodeToBoard(node: BoardFlowNode): BoardDomainNode {
  return {
    id: node.id,
    kind: node.workbench.kind,
    parentNodeId: node.parentId ?? null,
    order: node.workbench.order,
    position: { x: node.position.x, y: node.position.y },
    size: resolveNodeSize(node),
    artifactId: node.workbench.artifactId,
    artifactVersionId: node.workbench.artifactVersionId,
    data: { ...node.data },
  };
}

function flowEdgeToBoard(edge: BoardFlowEdge): BoardDomainEdge {
  return {
    id: edge.id,
    sourceNodeId: edge.source,
    targetNodeId: edge.target,
    kind: edge.workbench.kind,
    data: { ...(edge.data ?? {}) },
  };
}

export function orderFlowNodesByHierarchy(nodes: readonly BoardFlowNode[]): BoardFlowNode[] {
  return orderBoardNodesByHierarchy(nodes.map((node) => ({
    id: node.id,
    parentNodeId: node.parentId ?? null,
    order: node.workbench.order,
    node,
  }))).map(({ node }) => node);
}

function resolveNodeSize(node: BoardFlowNode): BoardDomainNode["size"] {
  const measured = node.measured;
  if (isPositiveFinite(measured?.width) && isPositiveFinite(measured?.height)) {
    return { width: measured.width, height: measured.height };
  }
  if (isPositiveFinite(node.width) && isPositiveFinite(node.height)) {
    return { width: node.width, height: node.height };
  }
  return node.workbench.size ? { ...node.workbench.size } : null;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
