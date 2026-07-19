import type { PrototypeDocument, PrototypeNode } from "../src/prototype.js";

export function prototypeDocumentFixture(): PrototypeDocument {
  const rootA = prototypeFrameNodeFixture("node-root-a", "screen-a", null, ["node-a"]);
  const rootB = prototypeFrameNodeFixture("node-root-b", "screen-b", null, ["node-b"]);
  return {
    protocol: "workbench.prototype.v1",
    documentId: "document-patches",
    title: "Patch fixture",
    revision: 7,
    screens: [
      {
        id: "screen-a",
        name: "Screen A",
        route: "/a",
        rootNodeId: rootA.id,
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      },
      {
        id: "screen-b",
        name: "Screen B",
        route: "/b",
        rootNodeId: rootB.id,
        initialStateId: null,
        viewport: { width: 1440, height: 900 },
      },
    ],
    nodes: [
      rootA,
      prototypeTextNodeFixture("node-a", "screen-a", rootA.id, "A"),
      rootB,
      prototypeTextNodeFixture("node-b", "screen-b", rootB.id, "B"),
    ],
    tokens: [],
    assets: [],
    variables: [
      { path: "shared.second", initialValue: "second" },
      { path: "shared.first", initialValue: "first" },
    ],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

export function prototypeFrameNodeFixture(
  id: string,
  screenId: string,
  parentId: string | null,
  childIds: string[],
): Extract<PrototypeNode, { kind: "frame" }> {
  return {
    ...prototypeNodeBaseFixture(id, screenId, parentId),
    kind: "frame",
    childIds,
    clipContent: true,
  };
}

export function prototypeTextNodeFixture(
  id: string,
  screenId: string,
  parentId: string | null,
  text: string,
): Extract<PrototypeNode, { kind: "text" }> {
  return {
    ...prototypeNodeBaseFixture(id, screenId, parentId),
    kind: "text",
    text,
    maxLines: null,
  };
}

function prototypeNodeBaseFixture(id: string, screenId: string, parentId: string | null) {
  return {
    id,
    screenId,
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: prototypeLiteral(0),
      y: prototypeLiteral(0),
      width: prototypeLiteral(100),
      height: prototypeLiteral(40),
      display: "block" as const,
      direction: "column" as const,
      gap: prototypeLiteral(0),
      padding: {
        top: prototypeLiteral(0),
        right: prototypeLiteral(0),
        bottom: prototypeLiteral(0),
        left: prototypeLiteral(0),
      },
      align: "start" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: { kind: "literal" as const, value: "#ffffff" },
      stroke: null,
      radii: {
        topLeft: prototypeLiteral(0),
        topRight: prototypeLiteral(0),
        bottomRight: prototypeLiteral(0),
        bottomLeft: prototypeLiteral(0),
      },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [] as string[],
    bindingIds: [] as string[],
    motionIds: [] as string[],
  };
}

function prototypeLiteral(value: number) {
  return { kind: "literal" as const, value };
}
