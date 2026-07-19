import { prototypeDocumentSchema } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { prototypeEditorDocumentFixture } from "../prototype-editor/test-fixtures";
import {
  applyPrototypeCanvasStyle,
  normalizePrototypeCanvasStyleDraft,
  prototypeCanvasStyleDraft,
} from "./prototype-style";

describe("prototype canvas style", () => {
  it("writes theme, radius, and motion through stable IR tokens", () => {
    const document = prototypeEditorDocumentFixture();
    document.motions = [{
      id: "motion-enter",
      nodeId: "node-card",
      trigger: "enter",
      stateId: null,
      actionId: null,
      property: "opacity",
      from: 0,
      to: 1,
      duration: { kind: "literal", value: 240 },
      delay: { kind: "literal", value: 0 },
      easing: "easeOut",
    }];
    document.nodes[1]!.motionIds = ["motion-enter"];

    const styled = applyPrototypeCanvasStyle(document, {
      theme: "dark",
      radius: 12,
      motionEnabled: false,
      color: "#8758F6",
    });

    expect(prototypeDocumentSchema.safeParse(styled).success).toBe(true);
    expect(styled.revision).toBe(2);
    expect(styled.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "产品工作台画布背景", type: "color", value: "#8758f6" }),
      expect.objectContaining({ name: "产品工作台画布前景色", type: "color", value: "#f1f3f4" }),
      expect.objectContaining({ name: "产品工作台画布圆角", type: "radius", value: 12 }),
      expect.objectContaining({ name: "产品工作台画布动效时长", type: "duration", value: 0 }),
    ]));
    expect(styled.nodes.every((node) => node.style.radii.topLeft.kind === "token")).toBe(true);
    expect(styled.motions[0]?.duration.kind).toBe("token");
    expect(prototypeCanvasStyleDraft(styled)).toEqual({
      theme: "dark",
      radius: 12,
      motionEnabled: false,
      color: "#8758f6",
    });
  });

  it("updates its own tokens without duplicating them", () => {
    const document = prototypeEditorDocumentFixture();
    const once = applyPrototypeCanvasStyle(document, {
      theme: "dark",
      radius: 8,
      motionEnabled: true,
      color: "#121315",
    });
    const twice = applyPrototypeCanvasStyle(once, {
      theme: "light",
      radius: 16,
      motionEnabled: true,
      color: "#f1f3f4",
    });

    expect(twice.tokens.filter((token) => token.name.startsWith("产品工作台画布"))).toHaveLength(4);
    expect(twice.revision).toBe(3);
    expect(prototypeCanvasStyleDraft(twice)).toMatchObject({
      theme: "light",
      radius: 16,
      color: "#f1f3f4",
    });
  });

  it("chooses the matching surface color when the theme toggle changes", () => {
    const previous = {
      theme: "dark" as const,
      radius: 8,
      motionEnabled: true,
      color: "#121315",
    };

    expect(normalizePrototypeCanvasStyleDraft(previous, { ...previous, theme: "light" })).toEqual({
      theme: "light",
      radius: 8,
      motionEnabled: true,
      color: "#f1f3f4",
    });
  });

});
