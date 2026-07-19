import { boardNodeProtocol } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import type { BoardFlowNode } from "./adapter";
import {
  arrangeBoardNodes,
  type BoardNodeAlignment,
} from "./arrange";
import {
  absoluteNodePositions,
  absoluteNodeRect,
} from "./geometry";

describe("Board node arrangement", () => {
  it.each<{
    alignment: BoardNodeAlignment;
    first: { x: number; y: number };
    second: { x: number; y: number };
  }>([
    { alignment: "left", first: { x: 10, y: 20 }, second: { x: 10, y: 80 } },
    { alignment: "center", first: { x: 45, y: 20 }, second: { x: 55, y: 80 } },
    { alignment: "right", first: { x: 80, y: 20 }, second: { x: 100, y: 80 } },
    { alignment: "top", first: { x: 10, y: 20 }, second: { x: 100, y: 20 } },
    { alignment: "middle", first: { x: 10, y: 60 }, second: { x: 100, y: 50 } },
    { alignment: "bottom", first: { x: 10, y: 100 }, second: { x: 100, y: 80 } },
  ])("aligns unequal nodes to $alignment", ({ alignment, first, second }) => {
    const nodes = [
      artifactNode("first", 10, 20, 40, 20),
      artifactNode("second", 100, 80, 20, 40),
    ];

    const result = arrangeBoardNodes(nodes, ["first", "second"], {
      kind: "align",
      alignment,
    });

    expect(result.changed).toBe(true);
    expect(absoluteNodePositions(result.nodes).get("first")).toEqual(first);
    expect(absoluteNodePositions(result.nodes).get("second")).toEqual(second);
  });

  it("aligns across Frames in absolute space and writes parent-relative positions", () => {
    const firstFrame = frameNode("first-frame", 100, 100, 300, 300);
    const first = artifactNode("first", 20, 40, 20, 30, firstFrame.id);
    const secondFrame = frameNode("second-frame", 500, 300, 300, 300);
    const second = artifactNode("second", 60, 10, 40, 50, secondFrame.id);

    const result = arrangeBoardNodes(
      [firstFrame, first, secondFrame, second],
      [first.id, second.id],
      { kind: "align", alignment: "left" },
    );
    const absolute = absoluteNodePositions(result.nodes);

    expect(result.changed).toBe(true);
    expect(absolute.get(first.id)).toEqual({ x: 120, y: 140 });
    expect(absolute.get(second.id)).toEqual({ x: 120, y: 310 });
    expect(result.nodes.find((node) => node.id === second.id)).toMatchObject({
      parentId: secondFrame.id,
      position: { x: -380, y: 10 },
    });
  });

  it("moves only selected roots when a selected Frame contains another selected node", () => {
    const frame = frameNode("frame", 100, 100, 200, 200);
    const child = artifactNode("child", 20, 30, 30, 30, frame.id);
    const other = artifactNode("other", 400, 180, 80, 60);

    const result = arrangeBoardNodes(
      [frame, child, other],
      [frame.id, child.id, other.id, child.id],
      { kind: "align", alignment: "top" },
    );

    expect(result).toMatchObject({ changed: true, movedNodeIds: [other.id] });
    expect(result.nodes.find((node) => node.id === child.id)).toMatchObject({
      parentId: frame.id,
      position: { x: 20, y: 30 },
    });
    expect(absoluteNodePositions(result.nodes).get(other.id)).toEqual({ x: 400, y: 100 });
  });

  it("returns a typed no-op when any selected root has no measurable size", () => {
    const first = artifactNode("first", 0, 0, 100, 100);
    const missingSize = artifactNode("missing-size", 200, 0, null, null);

    const result = arrangeBoardNodes(
      [first, missingSize],
      [first.id, missingSize.id],
      { kind: "align", alignment: "left" },
    );

    expect(result).toEqual({
      changed: false,
      movedNodeIds: [],
      nodes: [first, missingSize],
      reason: "missing-size",
    });
  });

  it.each(["horizontal", "vertical"] as const)(
    "distributes three nodes with stable position and id ordering on the %s axis",
    (axis) => {
      const horizontal = axis === "horizontal";
      const b = artifactNode(
        "b",
        horizontal ? 40 : 0,
        horizontal ? 0 : 40,
        horizontal ? 10 : 20,
        horizontal ? 20 : 10,
      );
      const z = artifactNode("z", 0, 0, 20, 20);
      const a = artifactNode(
        "a",
        horizontal ? 40 : 0,
        horizontal ? 0 : 40,
        horizontal ? 30 : 20,
        horizontal ? 20 : 30,
      );

      const result = arrangeBoardNodes([b, z, a], [b.id, z.id, a.id], {
        kind: "distribute",
        axis,
      });
      const rects = boardRects(result.nodes);

      expect(result.changed).toBe(true);
      expect(horizontal
        ? [rects.get("z")?.x, rects.get("a")?.x, rects.get("b")?.x]
        : [rects.get("z")?.y, rects.get("a")?.y, rects.get("b")?.y])
        .toEqual([0, 25, 60]);
    },
  );

  it("requires three selected roots for distribution and reports unchanged arrangements", () => {
    const first = artifactNode("first", 0, 0, 20, 20);
    const second = artifactNode("second", 40, 0, 20, 20);
    const third = artifactNode("third", 80, 0, 20, 20);

    expect(arrangeBoardNodes([first, second], [first.id, second.id], {
      kind: "distribute",
      axis: "horizontal",
    })).toMatchObject({ changed: false, reason: "insufficient-selection" });
    expect(arrangeBoardNodes([first, second, third], [first.id, second.id, third.id], {
      kind: "distribute",
      axis: "horizontal",
    })).toMatchObject({ changed: false, reason: "unchanged" });
  });
});

function boardRects(nodes: readonly BoardFlowNode[]) {
  const positions = absoluteNodePositions(nodes);
  return new Map(nodes.flatMap((node) => {
    const rect = absoluteNodeRect(node, positions);
    return rect ? [[node.id, rect] as const] : [];
  }));
}

function artifactNode(
  id: string,
  x: number,
  y: number,
  width: number | null,
  height: number | null,
  parentId?: string,
): BoardFlowNode {
  const size = width !== null && height !== null ? { width, height } : null;
  return {
    id,
    type: "artifact",
    ...(parentId ? { parentId } : {}),
    position: { x, y },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title: id,
      artifactKind: "prototype",
    },
    ...(size ? { style: { ...size } } : {}),
    workbench: {
      kind: "artifact",
      order: 0,
      artifactId: `artifact-${id}`,
      artifactVersionId: `version-${id}`,
      size,
    },
  };
}

function frameNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): BoardFlowNode {
  return {
    id,
    type: "frame",
    position: { x, y },
    style: { width, height },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "frame",
      title: id,
      fill: null,
      stroke: "#5f6368",
    },
    workbench: {
      kind: "frame",
      order: 0,
      artifactId: null,
      artifactVersionId: null,
      size: { width, height },
    },
  };
}
