import {
  boardNodeProtocol,
  maximumBoardDrawingPointCount,
} from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import type { BoardFlowNode } from "./adapter";
import { createBoardArtifact, createBoardDrawing, createBoardFrame } from "./tool-actions";

describe("Board tool commands", () => {
  it("pins a new immutable Artifact version and nests it in the containing frame", () => {
    const frame = createBoardFrame(
      [],
      { x: 100, y: 100, width: 500, height: 400 },
      () => "parent",
    ).nodes[0]!;
    const result = createBoardArtifact(
      [frame],
      {
        artifactId: "artifact-image",
        artifactVersionId: "version-image-1",
        artifactKind: "image",
        title: "Hero image",
        x: 160,
        y: 170,
        width: 320,
        height: 180,
      },
      () => "image",
    );

    expect(result.nodeId).toBe("artifact_image");
    expect(result.nodes.find((node) => node.id === result.nodeId)).toMatchObject({
      parentId: "frame_parent",
      position: { x: 60, y: 70 },
      selected: true,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        artifactKind: "image",
        title: "Hero image",
      },
      workbench: {
        kind: "artifact",
        order: 0,
        artifactId: "artifact-image",
        artifactVersionId: "version-image-1",
        size: { width: 320, height: 180 },
      },
    });
  });

  it("creates a versioned frame and reparents enclosed siblings without moving them", () => {
    const inside = artifactNode("inside", 120, 130, 80, 60, 0);
    const outside = artifactNode("outside", 600, 600, 80, 60, 1);

    const result = createBoardFrame(
      [inside, outside],
      { x: 100, y: 100, width: 300, height: 240 },
      () => "fixed",
    );

    expect(result.nodeId).toBe("frame_fixed");
    expect(result.nodes.find((node) => node.id === "frame_fixed")).toMatchObject({
      id: "frame_fixed",
      position: { x: 100, y: 100 },
      data: { protocol: boardNodeProtocol, nodeType: "frame", title: "Frame 1" },
      workbench: { kind: "frame", order: 2, size: { width: 300, height: 240 } },
    });
    expect(result.nodes.find((node) => node.id === "inside")).toMatchObject({
      parentId: "frame_fixed",
      position: { x: 20, y: 30 },
      workbench: { order: 0 },
    });
    const outsideResult = result.nodes.find((node) => node.id === "outside")!;
    expect(outsideResult.parentId).toBeUndefined();
    expect(outsideResult.position).toEqual({ x: 600, y: 600 });
    expect(result.nodes.map((node) => node.id)).toEqual(["outside", "frame_fixed", "inside"]);
  });

  it("normalizes a freehand stroke and nests it in the smallest containing frame", () => {
    const frame = createBoardFrame(
      [],
      { x: 100, y: 100, width: 400, height: 300 },
      () => "parent",
    ).nodes[0]!;
    const result = createBoardDrawing(
      [frame],
      [
        { x: 160, y: 170, pressure: 0.2 },
        { x: 220, y: 230, pressure: 1.2 },
      ],
      { color: "#abcdef", size: 6, simulatePressure: false },
      () => "stroke",
    );
    const drawing = result.nodes.find((node) => node.id === "drawing_stroke")!;

    expect(drawing.parentId).toBe("frame_parent");
    expect(drawing.workbench.order).toBe(0);
    expect(drawing.position).toEqual({ x: 56, y: 66 });
    expect(drawing.data).toMatchObject({
      protocol: boardNodeProtocol,
      nodeType: "drawing",
      title: "Drawing 1",
      stroke: {
        algorithm: "perfect-freehand@1",
        intrinsicSize: { width: 68, height: 68 },
        color: "#abcdef",
        size: 6,
        points: [[4, 4, 0.2], [64, 64, 1]],
        simulatePressure: false,
      },
    });
  });

  it("simulates pressure by default for pointer input", () => {
    const result = createBoardDrawing(
      [],
      [{ x: 10, y: 20, pressure: 0.5 }],
      {},
      () => "default-pressure",
    );

    expect(result.nodes[0]?.data).toMatchObject({
      nodeType: "drawing",
      stroke: {
        intrinsicSize: { width: 7, height: 7 },
        simulatePressure: true,
      },
    });
  });

  it("rejects a stroke beyond the transport-safe point budget", () => {
    expect(() => createBoardDrawing(
      [],
      Array.from(
        { length: maximumBoardDrawingPointCount + 1 },
        (_, index) => ({ x: index, y: index, pressure: 0.5 }),
      ),
    )).toThrow(`cannot exceed ${maximumBoardDrawingPointCount} points`);
  });
});

function artifactNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  order: number,
): BoardFlowNode {
  return {
    id,
    type: "artifact",
    position: { x, y },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title: id,
      artifactKind: "prototype",
    },
    style: { width, height },
    workbench: {
      kind: "artifact",
      order,
      artifactId: `artifact-${id}`,
      artifactVersionId: `version-${id}`,
      size: { width, height },
    },
  };
}
