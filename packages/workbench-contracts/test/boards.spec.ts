import { describe, expect, it } from "vitest";
import {
  boardNodeProtocol,
  boardSchema,
  orderBoardNodesByHierarchy,
} from "../src/boards.js";

describe("Board sibling order", () => {
  it("orders each parent before children and siblings by explicit order", () => {
    const nodes = [
      { id: "child-high", parentNodeId: "frame", order: 9 },
      { id: "root-high", parentNodeId: null, order: 4 },
      { id: "child-low", parentNodeId: "frame", order: 2 },
      { id: "frame", parentNodeId: null, order: 1 },
    ];

    expect(orderBoardNodesByHierarchy(nodes).map((node) => node.id)).toEqual([
      "frame",
      "child-low",
      "child-high",
      "root-high",
    ]);
  });

  it("rejects duplicate order values only within the same parent scope", () => {
    const frame = frameNode("frame", null, 0);
    const child = frameNode("child", "frame", 0);
    const valid = {
      id: "board",
      projectId: "project",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [frame, child],
      edges: [],
    };
    expect(boardSchema.safeParse(valid).success).toBe(true);
    expect(boardSchema.safeParse({
      ...valid,
      nodes: [frame, frameNode("duplicate", null, 0)],
    }).success).toBe(false);
  });
});

function frameNode(id: string, parentNodeId: string | null, order: number) {
  return {
    id,
    kind: "frame" as const,
    parentNodeId,
    order,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    artifactId: null,
    artifactVersionId: null,
    data: {
      protocol: boardNodeProtocol,
      nodeType: "frame" as const,
      title: id,
      fill: null,
      stroke: "#5f6368",
    },
  };
}
