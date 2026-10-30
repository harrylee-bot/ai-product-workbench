import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const routeFile = fileURLToPath(new URL("./workbench-project-route.tsx", import.meta.url));
const viewFile = fileURLToPath(new URL("./workbench-project-screen-view.tsx", import.meta.url));

describe("Workbench canvas tool wiring", () => {
  it("shares the active-Run Design system read-only policy with the panel and commit guard", async () => {
    const [route, view] = await Promise.all([
      readFile(routeFile, "utf8"),
      readFile(viewFile, "utf8"),
    ]);

    expect(route).toContain("const designSystemPanelReadOnly = canvasPanelAccess(");
    expect(route).toContain("designSystemPanelReadOnly\n      || !artifactSelection.styleTargetReference");
    expect(route).toContain("designSystemPanelReadOnly,\n      onDesignSystemChange: commitCanvasStyle");
    expect(view).toContain("readOnly={artifactEditing.designSystemPanelReadOnly}");
  });

  it("uses design-tool viewport gestures on the React Flow canvas", async () => {
    const view = await readFile(viewFile, "utf8");

    expect(view).toContain("panOnDrag={canvas.activeTool === \"pan\" ? [0, 1, 2] : [1, 2]}");
    expect(view).toContain("panActivationKeyCode=\"Space\"");
    expect(view).toContain("selectionMode={SelectionMode.Partial}");
    expect(view).toContain("selectionOnDrag={!canvas.prototypeEditMode");
    expect(view).toContain("zoomActivationKeyCode={[\"Meta\", \"Control\", \"z\"]}");
    expect(view).toContain("zoomOnDoubleClick={false}");
  });
});
