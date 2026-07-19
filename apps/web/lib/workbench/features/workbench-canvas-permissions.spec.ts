import { describe, expect, it } from "vitest";

import {
  isWorkbenchNodeResizeVisible,
  workbenchCanvasPermissions,
  visibleWorkbenchNodeChanges,
} from "./workbench-canvas-permissions";

describe("Workbench canvas permissions", () => {
  it("lets a viewer select and navigate without exposing Board writes or resize handles", () => {
    const viewer = workbenchCanvasPermissions(false);

    expect(viewer).toEqual({
      canDragNodes: false,
      canResizeNodes: false,
      canSelectNodes: true,
      canWriteBoard: false,
    });
    expect(isWorkbenchNodeResizeVisible(viewer.canResizeNodes, true)).toBe(false);
    expect(visibleWorkbenchNodeChanges(viewer.canWriteBoard, [
      { type: "select", selected: true },
      { type: "position", x: 10 },
      { type: "remove" },
      { type: "dimensions", width: 100 },
    ])).toEqual([
      { type: "select", selected: true },
      { type: "dimensions", width: 100 },
    ]);
  });

  it("shows resize handles to an editor only for a selected ready node", () => {
    const editor = workbenchCanvasPermissions(true);

    expect(isWorkbenchNodeResizeVisible(editor.canResizeNodes, true)).toBe(true);
    expect(isWorkbenchNodeResizeVisible(editor.canResizeNodes, false)).toBe(false);
    expect(isWorkbenchNodeResizeVisible(editor.canResizeNodes, true, false)).toBe(false);
  });

  it("keeps selection read-only while a Run is active", () => {
    const activeRun = workbenchCanvasPermissions(true, true);

    expect(activeRun).toEqual({
      canDragNodes: false,
      canResizeNodes: false,
      canSelectNodes: true,
      canWriteBoard: false,
    });
    expect(visibleWorkbenchNodeChanges(activeRun.canWriteBoard, [
      { type: "select", selected: true },
      { type: "position", x: 10 },
      { type: "remove" },
      { type: "dimensions", width: 100 },
    ])).toEqual([
      { type: "select", selected: true },
      { type: "dimensions", width: 100 },
    ]);
  });
});
