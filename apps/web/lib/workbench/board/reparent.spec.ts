import { boardNodeProtocol, type Board } from "@workbench/workbench-contracts";
import type { NodeChange } from "@xyflow/system";
import { describe, expect, it } from "vitest";

import { reduceWorkbenchProjectNodeChanges } from "@/components/workbench/workbench-project-react-flow-adapter";
import type { BoardFlowNode } from "./adapter";
import { absoluteNodePositions } from "./geometry";
import { reparentBoardNodesAfterDrag } from "./reparent";
import { createBoardStore, type BoardStore } from "./store";

describe("Board drag reparenting", () => {
  it("moves a top-level node into the smallest nested Frame without a visual jump", () => {
    const outer = frameNode("outer", 100, 100, 600, 600, 0);
    const inner = frameNode("inner", 100, 100, 300, 300, 0, "outer");
    const artifact = artifactNode("artifact", 250, 250, 50, 50, 1);
    const before = absoluteNodePositions([outer, inner, artifact]).get("artifact");

    const result = reparentBoardNodesAfterDrag([outer, inner, artifact], ["artifact"]);
    const moved = result.nodes.find((node) => node.id === "artifact")!;

    expect(result.changed).toBe(true);
    expect(moved).toMatchObject({ parentId: "inner", position: { x: 50, y: 50 } });
    expect(absoluteNodePositions(result.nodes).get("artifact")).toEqual(before);
  });

  it("moves a child out of its Frame and into a sibling Frame using absolute coordinates", () => {
    const first = frameNode("first", 0, 0, 200, 200, 0);
    const second = frameNode("second", 400, 0, 200, 200, 1);
    const child = artifactNode("child", 450, 50, 50, 50, 0, "first");

    const switched = reparentBoardNodesAfterDrag([first, second, child], ["child"]);
    expect(switched.nodes.find((node) => node.id === "child")).toMatchObject({
      parentId: "second",
      position: { x: 50, y: 50 },
      workbench: { order: 0 },
    });

    const movedOutside = switched.nodes.map((node) => node.id === "child"
      ? { ...node, position: { x: 300, y: 300 } }
      : node);
    const outside = reparentBoardNodesAfterDrag(movedOutside, ["child"]);
    const outsideChild = outside.nodes.find((node) => node.id === "child")!;
    expect(outsideChild.parentId).toBeUndefined();
    expect(outsideChild.position).toEqual({ x: 700, y: 300 });
    expect(outsideChild.workbench.order).toBe(2);
  });

  it("excludes dragged Frames and their descendants as candidate parents", () => {
    const outer = frameNode("outer", 100, 100, 500, 500, 0);
    const inner = frameNode("inner", 20, 20, 450, 450, 0, "outer");

    const result = reparentBoardNodesAfterDrag([outer, inner], ["outer"]);

    expect(result.changed).toBe(false);
    expect(result.nodes.find((node) => node.id === "outer")?.parentId).toBeUndefined();
  });

  it("records drag and reparent as one undoable Store gesture", () => {
    const initial: Board = {
      id: "board-1",
      projectId: "project-1",
      revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        flowNodeToBoard(frameNode("frame", 100, 100, 400, 400, 0)),
        flowNodeToBoard(artifactNode("artifact", 600, 100, 100, 100, 1)),
      ],
      edges: [],
    };
    const store = createBoardStore(initial);

    applyProjectNodeChanges(store, [{
      id: "artifact",
      type: "position",
      position: { x: 150, y: 150 },
      dragging: true,
    }]);
    applyProjectNodeChanges(store, [{
      id: "artifact",
      type: "position",
      position: { x: 150, y: 150 },
      dragging: false,
    }]);

    expect(store.getState().nodes.find((node) => node.id === "artifact")).toMatchObject({
      parentId: "frame",
      position: { x: 50, y: 50 },
    });
    expect(store.getState().historyPast).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().nodes.find((node) => node.id === "artifact")).toMatchObject({
      position: { x: 600, y: 100 },
    });
    expect(store.getState().nodes.find((node) => node.id === "artifact")?.parentId).toBeUndefined();

    store.getState().redo();
    expect(store.getState().nodes.find((node) => node.id === "artifact")).toMatchObject({
      parentId: "frame",
      position: { x: 50, y: 50 },
    });
  });
});

function frameNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  order: number,
  parentId?: string,
): BoardFlowNode {
  return {
    id,
    type: "frame",
    ...(parentId ? { parentId } : {}),
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
      order,
      artifactId: null,
      artifactVersionId: null,
      size: { width, height },
    },
  };
}

function artifactNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  order: number,
  parentId?: string,
): BoardFlowNode {
  return {
    id,
    type: "artifact",
    ...(parentId ? { parentId } : {}),
    position: { x, y },
    style: { width, height },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title: id,
      artifactKind: "prototype",
    },
    workbench: {
      kind: "artifact",
      order,
      artifactId: `artifact-${id}`,
      artifactVersionId: `version-${id}`,
      size: { width, height },
    },
  };
}

function flowNodeToBoard(node: BoardFlowNode): Board["nodes"][number] {
  return {
    id: node.id,
    kind: node.workbench.kind,
    parentNodeId: node.parentId ?? null,
    order: node.workbench.order,
    position: { ...node.position },
    size: node.workbench.size ? { ...node.workbench.size } : null,
    artifactId: node.workbench.artifactId,
    artifactVersionId: node.workbench.artifactVersionId,
    data: structuredClone(node.data),
  };
}

function applyProjectNodeChanges(
  store: BoardStore,
  changes: NodeChange<BoardFlowNode>[],
): void {
  store.getState().applyNodeChanges(changes, reduceWorkbenchProjectNodeChanges);
}
