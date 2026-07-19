import { describe, expect, it } from "vitest";

import {
  applyFigmaImportPlan,
  mapTextAlignHorizontal,
  mapTextCase,
  positionForTransformOrigin,
  type FigmaImportApi,
  type FigmaImportFrameNode,
  type FigmaImportNode,
  type FigmaImportPage,
  type FigmaImportPaintNode,
  type FigmaImportRectangleNode,
  type FigmaImportSceneNode,
  type FigmaImportTextNode,
  type FigmaImportVectorNode,
} from "../src/figma-adapter";
import { buildFigmaImportPlan } from "../src/import-plan";
import { exportFixture } from "./fixtures";

type PropertyBag = Record<string, unknown>;

class FakeNode implements FigmaImportNode {
  name = "";
  removed = false;
  pluginData = new Map<string, string>();
  values = new Map<string, unknown>();

  remove() {
    this.removed = true;
  }

  setPluginData(key: string, value: string) {
    this.pluginData.set(key, value);
  }
}

class FakeScene extends FakeNode implements FigmaImportSceneNode {
  x = 0;
  y = 0;
  visible = true;
  opacity = 1;
  rotation = 0;
  width = 0;
  height = 0;

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

class FakePaint extends FakeScene implements FigmaImportPaintNode {
  fills = [];
  strokes = [];
  strokeWeight = 0;
  strokeAlign = "CENTER" as const;
  dashPattern = [];
  effects = [];
}

class FakeText extends FakePaint implements FigmaImportTextNode {
  characters = "";
  fontName = { family: "Inter", style: "Regular" };
  fontSize = 14;
  lineHeight = { unit: "PIXELS" as const, value: 20 };
  letterSpacing = { unit: "PIXELS" as const, value: 0 };
  textAlignHorizontal = "LEFT" as const;
  textCase = "ORIGINAL" as const;
  textDecoration = "NONE" as const;
}

class FakeRectangle extends FakePaint implements FigmaImportRectangleNode {
  cornerRadius = 0;
  topLeftRadius = 0;
  topRightRadius = 0;
  bottomRightRadius = 0;
  bottomLeftRadius = 0;
}

class FakeVector extends FakePaint implements FigmaImportVectorNode {
  cornerRadius = 0;
}

class FakeFrame extends FakeRectangle implements FigmaImportFrameNode {
  children: FigmaImportSceneNode[] = [];
  layoutMode = "NONE" as const;
  itemSpacing = 0;
  paddingTop = 0;
  paddingRight = 0;
  paddingBottom = 0;
  paddingLeft = 0;
  primaryAxisAlignItems = "MIN" as const;
  counterAxisAlignItems = "MIN" as const;
  clipsContent = false;

  appendChild(child: FigmaImportSceneNode) {
    this.children.push(child);
  }
}

class FakePage extends FakeNode implements FigmaImportPage {
  children: FigmaImportSceneNode[] = [];

  appendChild(child: FigmaImportSceneNode) {
    this.children.push(child);
  }
}

/** A proxy catches accidental writes to properties that the real node type does not expose. */
function strictNode<T extends object>(node: T, allowed: readonly string[]): T {
  const allowedKeys = new Set(allowed);
  return new Proxy(node, {
    set(target, key, value) {
      if (typeof key === "string" && !allowedKeys.has(key)) {
        throw new Error(`unsupported Figma property: ${key}`);
      }
      return Reflect.set(target, key, value);
    },
  });
}

const baseKeys = ["name", "removed"];
const sceneKeys = [...baseKeys, "x", "y", "visible", "opacity", "rotation", "width", "height"];
const paintKeys = [...sceneKeys, "fills", "strokes", "strokeWeight", "strokeAlign", "dashPattern", "effects"];
const textKeys = [...paintKeys, "characters", "fontName", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textCase", "textDecoration"];
const rectangleKeys = [...paintKeys, "cornerRadius", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
const vectorKeys = [...paintKeys, "cornerRadius"];
const frameKeys = [...rectangleKeys, "children", "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems", "clipsContent"];
const pageKeys = [...baseKeys, "children"];

function fakeApi(options: { failOnFontCall?: number } = {}) {
  const pages: FakePage[] = [];
  const nodes: FakeNode[] = [];
  const loadedFonts: Array<{ family: string; style: string }> = [];
  let fontCalls = 0;
  const make = <T extends FakeNode>(node: T, keys: readonly string[]) => {
    const strict = strictNode(node, keys);
    nodes.push(strict);
    return strict;
  };
  const api: FigmaImportApi = {
    createPage: () => {
      const page = make(new FakePage(), pageKeys);
      pages.push(page);
      return page;
    },
    createFrame: () => make(new FakeFrame(), frameKeys),
    createText: () => make(new FakeText(), textKeys),
    createRectangle: () => make(new FakeRectangle(), rectangleKeys),
    createImage: () => ({ hash: "image-hash" }),
    createNodeFromSvg: (svg) => {
      const node = make(new FakeVector(), vectorKeys);
      node.values.set("svg", svg);
      return node;
    },
    loadFontAsync: async (font) => {
      fontCalls += 1;
      if (options.failOnFontCall === fontCalls) throw new Error("font load failed");
      loadedFonts.push(font);
    },
    setCurrentPage: () => undefined,
    setSelection: () => undefined,
    scrollAndZoomIntoView: () => undefined,
  };
  return { api, pages, nodes, loadedFonts };
}

describe("official Figma adapter boundary", () => {
  it("maps text values to the exact Figma enums", () => {
    expect(mapTextAlignHorizontal("justify")).toBe("JUSTIFIED");
    expect(mapTextCase("none")).toBe("ORIGINAL");
    expect(mapTextCase("capitalize")).toBe("TITLE");
  });

  it("translates Figma center rotation to the Prototype transform origin", () => {
    const position = positionForTransformOrigin(0, 0, 100, 100, 90, { x: 0, y: 0 });
    expect(position.x).toBeCloseTo(-100);
    expect(position.y).toBeCloseTo(0);
  });

  it("creates editable pages/frames, preserves source metadata, and maps rotation origin", async () => {
    const plan = buildFigmaImportPlan(exportFixture(), {});
    const fake = fakeApi();
    const result = await applyFigmaImportPlan(plan, fake.api);
    const page = fake.pages[0]!;
    const frame = page.children[0]! as FakeFrame;
    const title = frame.children[0]! as FakeText;
    const generatedButtonLabel = (frame.children[1]! as FakeFrame).children[0]! as FakeText;

    expect(result).toMatchObject({ pageCount: 1, screenCount: 1, nodeCount: 3 });
    expect(page.name).toContain("产品工作台");
    expect(frame.width).toBe(640);
    expect(frame.rotation).toBe(12);
    expect(frame.x).toBeCloseTo(positionForTransformOrigin(0, 0, 640, 480, 12, { x: 0.25, y: 0.75 }).x);
    expect(frame.y).toBeCloseTo(positionForTransformOrigin(0, 0, 640, 480, 12, { x: 0.25, y: 0.75 }).y);
    expect(frame.pluginData.get("workbench.sourceId")).toBe("root-1");
    expect(frame.pluginData.get("workbench.transformOrigin")).toBe(JSON.stringify({ x: 0.25, y: 0.75 }));
    expect(title.characters).toBe("产品工作台");
    expect(generatedButtonLabel.characters).toBe("继续");
    expect(fake.loadedFonts).toContainEqual({ family: "Inter", style: "Regular" });
  });

  it("rolls back every node created by a failed attempt so retry starts clean", async () => {
    const plan = buildFigmaImportPlan(exportFixture(), {});
    const fake = fakeApi({ failOnFontCall: 2 });

    await expect(applyFigmaImportPlan(plan, fake.api)).rejects.toThrow("font load failed");
    expect(fake.nodes.every((node) => node.removed)).toBe(true);
    expect(fake.pages[0]?.children).toHaveLength(0);
  });
});
