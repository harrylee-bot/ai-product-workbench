import { boardNodeProtocol, type ReplaceBoardRequest } from "@workbench/workbench-contracts";
import { validateBoardGraph } from "../src/modules/boards/boards.service.js";

const validBoard: ReplaceBoardRequest = {
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: "node_1",
      kind: "artifact",
      parentNodeId: null,
      order: 0,
      position: { x: 10, y: 20 },
      size: { width: 320, height: 480 },
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        title: "Prototype",
        artifactKind: "prototype",
      },
    },
  ],
  edges: [],
};

describe("Board graph validation", () => {
  it("accepts an artifact version pin", () => {
    expect(() => validateBoardGraph(validBoard)).not.toThrow();
  });

  it("rejects a floating artifact reference", () => {
    expect(() => validateBoardGraph({
      ...validBoard,
      nodes: [{ ...validBoard.nodes[0], artifactVersionId: null }],
    })).toThrow();
  });

  it("rejects duplicate nodes and dangling edges", () => {
    expect(() => validateBoardGraph({
      ...validBoard,
      nodes: [validBoard.nodes[0], validBoard.nodes[0]],
    })).toThrow();
    expect(() => validateBoardGraph({
      ...validBoard,
      edges: [{ id: "edge_1", sourceNodeId: "node_1", targetNodeId: "missing", kind: "flow", data: {} }],
    })).toThrow();
  });

  it("requires an acyclic frame-only parent hierarchy", () => {
    const frame = {
      id: "frame_1",
      kind: "frame" as const,
      parentNodeId: null,
      order: 0,
      position: { x: 0, y: 0 },
      size: { width: 640, height: 480 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame" as const,
        title: "Frame",
        fill: null,
        stroke: "#5f6368",
      },
    };
    expect(() => validateBoardGraph({
      ...validBoard,
      nodes: [frame, { ...validBoard.nodes[0]!, parentNodeId: frame.id }],
    })).not.toThrow();
    expect(() => validateBoardGraph({
      ...validBoard,
      nodes: [{ ...validBoard.nodes[0]!, parentNodeId: "missing" }],
    })).toThrow();
    expect(() => validateBoardGraph({
      ...validBoard,
      nodes: [
        validBoard.nodes[0]!,
        { ...validBoard.nodes[0]!, id: "node_2", parentNodeId: "node_1" },
      ],
    })).toThrow();
    expect(() => validateBoardGraph({
      ...validBoard,
      nodes: [
        { ...frame, parentNodeId: "frame_2" },
        { ...frame, id: "frame_2", parentNodeId: "frame_1" },
      ],
    })).toThrow();
  });

  it("requires a unique explicit order within each sibling scope", () => {
    let error: unknown;
    try {
      validateBoardGraph({
        ...validBoard,
        nodes: [
          validBoard.nodes[0]!,
          { ...validBoard.nodes[0]!, id: "node_2" },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      response: { detail: "Duplicate Board sibling order 0 under parent root" },
    });
  });
});
