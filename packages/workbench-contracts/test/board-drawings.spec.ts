import { describe, expect, it } from "vitest";
import {
  boardDrawingNodeDataSchema,
  boardNodeProtocol,
  maximumBoardDrawingPointCount,
  maximumBoardEdgeCount,
  maximumBoardNodeCount,
  maximumBoardTotalDrawingPointCount,
  replaceBoardRequestSchema,
} from "../src/boards.js";

const drawingData = {
  protocol: boardNodeProtocol,
  nodeType: "drawing" as const,
  title: "Annotation",
  stroke: {
    algorithm: "perfect-freehand@1" as const,
    intrinsicSize: { width: 80, height: 60 },
    points: [[4, 4, 0.2], [76, 56, 0.9]],
    color: "#f1f3f4",
    size: 5,
    thinning: 0.55,
    smoothing: 0.65,
    streamline: 0.55,
    simulatePressure: false,
  },
};

describe("Board Drawing protocol", () => {
  it("persists the intrinsic stroke coordinate system", () => {
    expect(boardDrawingNodeDataSchema.parse(drawingData).stroke).toMatchObject({
      intrinsicSize: { width: 80, height: 60 },
      simulatePressure: false,
    });
  });

  it("rejects strokes without an intrinsic coordinate system", () => {
    const legacyStroke = { ...drawingData.stroke } as Partial<typeof drawingData.stroke>;
    delete legacyStroke.intrinsicSize;

    expect(boardDrawingNodeDataSchema.safeParse({
      ...drawingData,
      stroke: legacyStroke,
    }).success).toBe(false);
  });

  it("enforces the single-stroke point budget", () => {
    expect(boardDrawingNodeDataSchema.safeParse({
      ...drawingData,
      stroke: {
        ...drawingData.stroke,
        points: Array.from(
          { length: maximumBoardDrawingPointCount + 1 },
          () => [1, 1, 0.5],
        ),
      },
    }).success).toBe(false);
  });

  it("enforces aggregate Board node, edge and drawing-point budgets", () => {
    const drawingNodes = Array.from(
      { length: (maximumBoardTotalDrawingPointCount / maximumBoardDrawingPointCount) + 1 },
      (_, index) => ({
        id: `drawing-${index}`,
        kind: "drawing" as const,
        parentNodeId: null,
        order: index,
        position: { x: index * 10, y: 0 },
        size: { width: 80, height: 60 },
        artifactId: null,
        artifactVersionId: null,
        data: {
          ...drawingData,
          stroke: {
            ...drawingData.stroke,
            points: Array.from(
              { length: maximumBoardDrawingPointCount },
              () => [1, 1, 0.5] as [number, number, number],
            ),
          },
        },
      }),
    );
    const viewport = { x: 0, y: 0, zoom: 1 };
    expect(replaceBoardRequestSchema.safeParse({ viewport, nodes: drawingNodes, edges: [] }).success)
      .toBe(false);

    const artifactNode = {
      id: "artifact-0",
      kind: "artifact" as const,
      parentNodeId: null,
      order: 0,
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      artifactId: "artifact-0",
      artifactVersionId: "version-0",
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact" as const,
        title: "Artifact",
        artifactKind: "prototype" as const,
      },
    };
    const tooManyNodes = Array.from({ length: maximumBoardNodeCount + 1 }, (_, index) => ({
      ...artifactNode,
      id: `artifact-${index}`,
      order: index,
      artifactId: `artifact-${index}`,
      artifactVersionId: `version-${index}`,
    }));
    expect(replaceBoardRequestSchema.safeParse({ viewport, nodes: tooManyNodes, edges: [] }).success)
      .toBe(false);

    const tooManyEdges = Array.from({ length: maximumBoardEdgeCount + 1 }, (_, index) => ({
      id: `edge-${index}`,
      sourceNodeId: artifactNode.id,
      targetNodeId: artifactNode.id,
      kind: "flow",
      data: {},
    }));
    expect(replaceBoardRequestSchema.safeParse({
      viewport,
      nodes: [artifactNode],
      edges: tooManyEdges,
    }).success).toBe(false);
  });
});
