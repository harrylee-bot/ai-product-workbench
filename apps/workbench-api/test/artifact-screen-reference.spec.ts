import { describe, expect, it } from "vitest";
import { artifactVersionScreenIds } from "../src/modules/artifacts/artifact-screen-reference.js";

describe("ArtifactVersion screen references", () => {
  it("returns only screens owned by the exact inline Prototype version", () => {
    expect(artifactVersionScreenIds({
      artifact: { kind: "prototype" },
      contentBlobId: null,
      content: prototypeDocument(),
    })).toEqual(new Set(["screen-home", "screen-success"]));
  });

  it("rejects non-Prototype, blob-backed and invalid documents", () => {
    expect(artifactVersionScreenIds({
      artifact: { kind: "data" },
      contentBlobId: null,
      content: prototypeDocument(),
    })).toBeNull();
    expect(artifactVersionScreenIds({
      artifact: { kind: "prototype" },
      contentBlobId: "blob-1",
      content: null,
    })).toBeNull();
    expect(artifactVersionScreenIds({
      artifact: { kind: "prototype" },
      contentBlobId: null,
      content: { screens: [{ id: "screen-forged" }] },
    })).toBeNull();
  });
});

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const frame = (id: string, screenId: string) => ({
    id,
    screenId,
    parentId: null,
    name: id,
    kind: "frame" as const,
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
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: null,
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
    childIds: [],
    clipContent: true,
  });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "document-1",
    title: "Prototype",
    revision: 1,
    screens: [
      { id: "screen-home", name: "Home", route: "/", rootNodeId: "root-home", initialStateId: null, viewport: { width: 390, height: 844 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: "root-success", initialStateId: null, viewport: { width: 390, height: 844 } },
    ],
    nodes: [frame("root-home", "screen-home"), frame("root-success", "screen-success")],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}
