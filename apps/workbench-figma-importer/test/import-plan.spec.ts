import { describe, expect, it } from "vitest";

import { buildFigmaImportPlan } from "../src/import-plan";
import { exportFixture } from "./fixtures";

describe("Figma import plan", () => {
  it("keeps only selected screens and resolves geometry/style for the adapter", () => {
    const document = exportFixture();
    const plan = buildFigmaImportPlan(document, {});
    const root = plan.prototypes[0]?.screens[0]?.root;

    expect(plan.prototypes[0]?.screens).toHaveLength(1);
    expect(root).toBeDefined();
    expect(root?.layout).toMatchObject({ width: 640, height: 480 });
    expect(root?.style.rotation).toBe(12);
    expect(root?.source.style.transformOrigin).toEqual({ x: 0.25, y: 0.75 });
    expect(root?.children.map((child) => child.source.id)).toEqual(["title-1", "button-1"]);
  });
});
