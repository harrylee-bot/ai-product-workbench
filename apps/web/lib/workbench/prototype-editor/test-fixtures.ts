import type {
  PrototypeDocument,
  PrototypeNode,
} from "@workbench/workbench-contracts";

export function prototypeEditorDocumentFixture(): PrototypeDocument {
  const root = frameNode("node-root", null, ["node-card", "node-label"]);
  const card = frameNode("node-card", root.id, []);
  card.layout.x = literal(24);
  card.layout.y = literal(48);
  card.layout.width = literal(160);
  card.layout.height = literal(96);
  const label: PrototypeNode = {
    ...nodeBase("node-label", root.id),
    kind: "text",
    text: "Prototype",
    maxLines: 1,
  };
  label.layout.x = literal(32);
  label.layout.y = literal(168);
  label.layout.width = literal(120);
  label.layout.height = literal(24);

  return {
    protocol: "workbench.prototype.v1",
    documentId: "document-editor-poc",
    title: "Editor PoC",
    revision: 1,
    screens: [{
      id: "screen-main",
      name: "Main",
      route: "/",
      rootNodeId: root.id,
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [root, card, label],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function frameNode(id: string, parentId: string | null, childIds: string[]): Extract<PrototypeNode, { kind: "frame" }> {
  return {
    ...nodeBase(id, parentId),
    kind: "frame",
    childIds,
    clipContent: true,
  };
}

function nodeBase(id: string, parentId: string | null) {
  return {
    id,
    screenId: "screen-main",
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: {
        top: literal(0),
        right: literal(0),
        bottom: literal(0),
        left: literal(0),
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
        topLeft: literal(0),
        topRight: literal(0),
        bottomRight: literal(0),
        bottomLeft: literal(0),
      },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
  };
}

function literal(value: number) {
  return { kind: "literal" as const, value };
}
