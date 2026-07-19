import { describe, expect, it } from "vitest";
import {
  projectPrototypeSourceScreens,
  prototypeSourceProjectionSchema,
} from "../src/prototype-sources.js";
import { prototypeDocumentFixture } from "./prototype-fixture.js";

describe("Prototype Generate source projection", () => {
  it("keeps exact selected screen content and only a cross-screen navigation stub", () => {
    const document = prototypeDocumentFixture();
    const sourceNode = document.nodes.find((node) => node.id === "node-a")!;
    sourceNode.actionIds = ["action-next"];
    document.actions = [{
      id: "action-next",
      nodeId: sourceNode.id,
      event: "click",
      kind: "navigate",
      targetScreenId: "screen-b",
    }];

    const projection = projectPrototypeSourceScreens(
      document,
      ["screen-a"],
      "a".repeat(64),
    );

    expect(projection.selectedScreenIds).toEqual(["screen-a"]);
    expect(projection.screens.map((screen) => screen.id)).toEqual(["screen-a"]);
    expect(projection.nodes.map((node) => node.id)).toEqual(["node-a", "node-root-a"]);
    expect(JSON.stringify(projection)).not.toContain("node-b");
    expect(projection.navigationTargets).toEqual([{
      id: "screen-b",
      name: "Screen B",
      route: "/b",
      viewport: { width: 1440, height: 900 },
    }]);
    expect(projection.actions).toEqual([document.actions[0]]);
    expect(projection.variables).toEqual([]);
    expect(prototypeSourceProjectionSchema.safeParse({
      ...projection,
      projectionChecksum: "b".repeat(64),
    }).success).toBe(true);
  });

  it("is deterministic while preserving the explicit selected-screen order", () => {
    const document = prototypeDocumentFixture();
    const first = projectPrototypeSourceScreens(
      document,
      ["screen-b", "screen-a"],
      "a".repeat(64),
    );
    const second = projectPrototypeSourceScreens(
      structuredClone(document),
      ["screen-b", "screen-a"],
      "a".repeat(64),
    );

    expect(first).toEqual(second);
    expect(first.selectedScreenIds).toEqual(["screen-b", "screen-a"]);
    expect(first.screens.map((screen) => screen.id)).toEqual(["screen-b", "screen-a"]);
  });

  it("keeps only assets referenced by selected nodes, bindings, select options, and typography", () => {
    const document = prototypeDocumentFixture();
    const root = document.nodes.find((node) => node.id === "node-root-a");
    const text = document.nodes.find((node) => node.id === "node-a");
    if (!root || root.kind !== "frame" || !text) throw new Error("fixture nodes missing");
    const asset = (id: string, name: string) => ({
      id,
      kind: "image" as const,
      name,
      blobId: `blob-${id}`,
      mediaType: "image/png" as const,
      byteSize: 16,
      sha256: "d".repeat(64),
      width: 320,
      height: 180,
    });
    const hero = asset("hero-image", "Hero");
    const variableImage = asset("variable-image", "Variable image");
    const optionImage = asset("option-image", "Option image");
    const unused = asset("unused-image", "Unused");
    const font = {
      id: "font-inter",
      kind: "font" as const,
      name: "Inter",
      blobId: "blob-font-inter",
      mediaType: "font/woff2" as const,
      byteSize: 24,
      sha256: "e".repeat(64),
      family: "Inter",
      weight: 400,
      style: "normal" as const,
    };
    const imageNode = {
      id: "image-a",
      screenId: "screen-a",
      parentId: root.id,
      name: "Hero",
      visible: true,
      layout: root.layout,
      style: root.style,
      actionIds: [],
      bindingIds: ["binding-image"],
      motionIds: [],
      kind: "image" as const,
      assetId: hero.id,
      fit: "cover" as const,
      alt: "Hero",
    };
    const selectNode = {
      id: "select-a",
      screenId: "screen-a",
      parentId: root.id,
      name: "Image choice",
      visible: true,
      layout: root.layout,
      style: root.style,
      actionIds: [],
      bindingIds: ["binding-select"],
      motionIds: [],
      kind: "input" as const,
      inputType: "select" as const,
      fieldName: "image",
      label: "Image",
      placeholder: "Choose image",
      optionValue: null,
      options: [
        { value: variableImage.id, label: "Variable", disabled: false },
        { value: optionImage.id, label: "Option", disabled: false },
      ],
      required: false,
      disabled: false,
    };
    const typography = {
      fontFamily: { kind: "literal" as const, value: "Inter" },
      fontSize: { kind: "literal" as const, value: 16 },
      fontWeight: { kind: "literal" as const, value: 400 },
      lineHeight: { kind: "literal" as const, value: 1.4 },
      letterSpacing: { kind: "literal" as const, value: 0 },
      align: "left" as const,
      transform: "none" as const,
      decoration: "none" as const,
    };
    text.style = { ...text.style, typography };
    root.childIds = [imageNode.id, selectNode.id, text.id];
    document.nodes.push(imageNode, selectNode);
    document.assets = [hero, variableImage, optionImage, font, unused];
    document.variables = [{ path: "selected.image", initialValue: variableImage.id }];
    document.bindings = [
      {
        id: "binding-image",
        nodeId: imageNode.id,
        property: "imageAssetId" as const,
        source: { kind: "variable" as const, path: "selected.image" },
      },
      {
        id: "binding-select",
        nodeId: selectNode.id,
        property: "value" as const,
        source: { kind: "variable" as const, path: "selected.image" },
      },
    ];

    const projection = projectPrototypeSourceScreens(document, ["screen-a"], "a".repeat(64));

    expect(projection.assets.map((item) => item.id)).toEqual([
      font.id,
      hero.id,
      optionImage.id,
      variableImage.id,
    ]);
    expect(projection.variables).toEqual([{ path: "selected.image", initialValue: variableImage.id }]);
    expect(projection.bindings.map((binding) => binding.id)).toEqual(["binding-image", "binding-select"]);
    expect(projection.assets.map((item) => item.id)).not.toContain(unused.id);
  });

  it("rejects missing, duplicate, and unknown selections", () => {
    const document = prototypeDocumentFixture();
    expect(() => projectPrototypeSourceScreens(document, [], "a".repeat(64)))
      .toThrow("PROTOTYPE_SOURCE_SCREEN_SELECTION_INVALID");
    expect(() => projectPrototypeSourceScreens(
      document,
      ["screen-a", "screen-a"],
      "a".repeat(64),
    )).toThrow("PROTOTYPE_SOURCE_SCREEN_SELECTION_INVALID");
    expect(() => projectPrototypeSourceScreens(document, ["screen-forged"], "a".repeat(64)))
      .toThrow("PROTOTYPE_SOURCE_SCREEN_SELECTION_INVALID");
  });
});
