import { z } from "zod";
import { artifactKindSchema } from "./artifacts.js";
import { opaqueIdSchema, revisionSchema } from "./common.js";

export const boardNodeProtocol = "workbench.board-node.v1" as const;
export const maximumBoardNodeCount = 512;
export const maximumBoardEdgeCount = 2_048;
export const maximumBoardDrawingPointCount = 4_096;
export const maximumBoardTotalDrawingPointCount = 24_576;

export const boardPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const boardSizeSchema = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();

const boardNodeTitleSchema = z.string().trim().min(1).max(160);
const boardNodeProtocolSchema = z.literal(boardNodeProtocol);

export const boardArtifactNodeDataSchema = z.object({
  protocol: boardNodeProtocolSchema,
  nodeType: z.literal("artifact"),
  title: boardNodeTitleSchema,
  artifactKind: artifactKindSchema,
  screenId: opaqueIdSchema.optional(),
  route: z.string().min(1).max(2_048).optional(),
}).strict();

export const boardFrameNodeDataSchema = z.object({
  protocol: boardNodeProtocolSchema,
  nodeType: z.literal("frame"),
  title: boardNodeTitleSchema,
  fill: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
  stroke: z.string().regex(/^#[0-9a-f]{6}$/i),
}).strict();

export const boardDrawingPointSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite().min(0).max(1),
]);

export const boardDrawingNodeDataSchema = z.object({
  protocol: boardNodeProtocolSchema,
  nodeType: z.literal("drawing"),
  title: boardNodeTitleSchema,
  stroke: z.object({
    algorithm: z.literal("perfect-freehand@1"),
    intrinsicSize: boardSizeSchema,
    points: z.array(boardDrawingPointSchema).min(1).max(maximumBoardDrawingPointCount),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    size: z.number().finite().min(1).max(256),
    thinning: z.number().finite().min(-1).max(1),
    smoothing: z.number().finite().min(0).max(1),
    streamline: z.number().finite().min(0).max(1),
    simulatePressure: z.boolean(),
  }).strict(),
}).strict();

export const boardNodeDataSchema = z.discriminatedUnion("nodeType", [
  boardArtifactNodeDataSchema,
  boardFrameNodeDataSchema,
  boardDrawingNodeDataSchema,
]);

export const boardNodeKindSchema = z.enum(["artifact", "frame", "drawing"]);

export const boardNodeSchema = z.object({
  id: opaqueIdSchema,
  kind: boardNodeKindSchema,
  parentNodeId: opaqueIdSchema.nullable(),
  order: z.number().int().min(0).max(2_147_483_647),
  position: boardPointSchema,
  size: boardSizeSchema.nullable(),
  artifactId: opaqueIdSchema.nullable(),
  artifactVersionId: opaqueIdSchema.nullable(),
  data: boardNodeDataSchema,
}).strict().superRefine((node, context) => {
  if (node.kind !== node.data.nodeType) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["data", "nodeType"],
      message: "Board node kind must match data.nodeType",
    });
  }
  const hasArtifactReference = node.artifactId !== null && node.artifactVersionId !== null;
  if ((node.artifactId === null) !== (node.artifactVersionId === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["artifactVersionId"],
      message: "Board nodes must pin both artifactId and artifactVersionId or neither",
    });
  }
  if ((node.kind === "artifact") !== hasArtifactReference) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["artifactVersionId"],
      message: "Only artifact Board nodes may pin an ArtifactVersion",
    });
  }
  if ((node.kind === "frame" || node.kind === "drawing") && node.size === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["size"],
      message: `${node.kind} Board nodes require an explicit size`,
    });
  }
});

export const boardEdgeSchema = z.object({
  id: opaqueIdSchema,
  sourceNodeId: opaqueIdSchema,
  targetNodeId: opaqueIdSchema,
  kind: z.string().min(1).max(80),
  data: z.record(z.string(), z.unknown()),
});

export const boardNodesSchema = z.array(boardNodeSchema).max(maximumBoardNodeCount).superRefine((nodes, context) => {
  const ordersByParent = new Map<string | null, Set<number>>();
  let drawingPointCount = 0;
  nodes.forEach((node, index) => {
    const siblingOrders = ordersByParent.get(node.parentNodeId) ?? new Set<number>();
    if (siblingOrders.has(node.order)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "order"],
        message: `Board sibling order ${node.order} is duplicated under parent ${node.parentNodeId ?? "root"}`,
      });
    }
    siblingOrders.add(node.order);
    ordersByParent.set(node.parentNodeId, siblingOrders);
    if (node.data.nodeType === "drawing") {
      drawingPointCount += node.data.stroke.points.length;
    }
  });
  if (drawingPointCount > maximumBoardTotalDrawingPointCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Board drawings exceed ${maximumBoardTotalDrawingPointCount} total points`,
    });
  }
});

export const boardSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  revision: revisionSchema,
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive(),
  }),
  nodes: boardNodesSchema,
  edges: z.array(boardEdgeSchema).max(maximumBoardEdgeCount),
}).strict();

export const replaceBoardRequestSchema = boardSchema.pick({ viewport: true, nodes: true, edges: true });

export type Board = z.infer<typeof boardSchema>;
export type BoardNode = z.infer<typeof boardNodeSchema>;
export type BoardNodeData = z.infer<typeof boardNodeDataSchema>;
export type ReplaceBoardRequest = z.infer<typeof replaceBoardRequestSchema>;

export function orderBoardNodesByHierarchy<
  T extends { id: string; parentNodeId: string | null; order: number },
>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, T[]>();
  for (const node of nodes) {
    const parentId = node.parentNodeId !== null && byId.has(node.parentNodeId)
      ? node.parentNodeId
      : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.order - right.order || compareIds(left.id, right.id));
  }

  const ordered: T[] = [];
  const visited = new Set<string>();
  const visit = (node: T) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    children.get(node.id)?.forEach(visit);
  };
  children.get(null)?.forEach(visit);
  nodes.forEach(visit);
  return ordered;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
