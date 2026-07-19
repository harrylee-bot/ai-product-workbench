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
});
