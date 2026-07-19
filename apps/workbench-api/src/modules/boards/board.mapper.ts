import {
  boardSchema,
  orderBoardNodesByHierarchy,
  type Board,
} from "@workbench/workbench-contracts";

export function mapBoard(board: {
  id: string;
  projectId: string;
  revision: number;
  viewport: unknown;
  nodes: Array<{
    nodeKey: string;
    parentNodeKey: string | null;
    sortOrder: number;
    kind: string;
    position: unknown;
    size: unknown;
    artifactId: string | null;
    artifactVersionId: string | null;
    data: unknown;
  }>;
  edges: Array<{
    edgeKey: string;
    sourceNodeKey: string;
    targetNodeKey: string;
    kind: string;
    data: unknown;
  }>;
}): Board {
  return boardSchema.parse({
    id: board.id,
    projectId: board.projectId,
    revision: board.revision,
    viewport: board.viewport as Board["viewport"],
    nodes: orderBoardNodesByHierarchy(board.nodes.map((node) => ({
      id: node.nodeKey,
      kind: node.kind as Board["nodes"][number]["kind"],
      parentNodeId: node.parentNodeKey,
      order: node.sortOrder,
      position: node.position as Board["nodes"][number]["position"],
      size: node.size as Board["nodes"][number]["size"],
      artifactId: node.artifactId,
      artifactVersionId: node.artifactVersionId,
      data: node.data as Board["nodes"][number]["data"],
    }))),
    edges: board.edges.map((edge) => ({
      id: edge.edgeKey,
      sourceNodeId: edge.sourceNodeKey,
      targetNodeId: edge.targetNodeKey,
      kind: edge.kind,
      data: edge.data as Board["edges"][number]["data"],
    })),
  });
}
