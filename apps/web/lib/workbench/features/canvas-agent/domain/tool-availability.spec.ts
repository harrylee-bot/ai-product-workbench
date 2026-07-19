import type { CanvasSnapshot } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { requestScopedCanvasAgentTools } from "./tool-availability";

describe("requestScopedCanvasAgentTools", () => {
  it("uses the contract profile for a fresh editable single selection", () => {
    expect(toolNames({
      capabilities: ["canvas:read", "canvas:interact", "artifact:edit", "run:create"],
      selectedScreenEditable: true,
      snapshot: snapshot(),
    })).toEqual([
      "get_visible_screens",
      "get_selected_screens",
      "view_screen",
      "select_screen",
      "quick_edit",
      "duplicate_screen",
      "rename_screen",
      "navigate_canvas",
    ]);
  });

  it("exposes only read tools without interaction or edit capabilities", () => {
    expect(toolNames({
      capabilities: ["canvas:read"],
      snapshot: snapshot(),
    })).toEqual(["get_visible_screens", "get_selected_screens"]);
  });

  it("removes conflicting mutations while a mutation is active", () => {
    expect(toolNames({
      activeMutation: true,
      capabilities: ["canvas:read", "canvas:interact", "artifact:edit", "run:create"],
      selectedScreenEditable: true,
      snapshot: snapshot(),
    })).toEqual([
      "get_visible_screens",
      "get_selected_screens",
      "view_screen",
      "select_screen",
      "navigate_canvas",
    ]);
  });

  it("declares no tools from an expired or missing snapshot", () => {
    expect(toolNames({
      capabilities: ["canvas:read", "canvas:interact"],
      now: Date.parse("2026-07-17T12:02:00.000Z"),
      snapshot: snapshot(),
    })).toEqual([]);
    expect(toolNames({
      capabilities: ["canvas:read", "canvas:interact"],
      snapshot: null,
    })).toEqual([]);
  });
});

function toolNames(overrides: Partial<Parameters<typeof requestScopedCanvasAgentTools>[0]>) {
  return requestScopedCanvasAgentTools({
    activeMutation: false,
    capabilities: [],
    editModelAvailable: true,
    now: Date.parse("2026-07-17T12:00:30.000Z"),
    selectedScreenEditable: false,
    snapshot: null,
    ...overrides,
  }).map(({ toolName }) => toolName);
}

function snapshot(): CanvasSnapshot {
  const reference = {
    boardNodeId: "node-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    screenId: "screen-1",
  };
  return {
    protocol: "workbench.canvas-snapshot.v1",
    projectId: "project-1",
    threadId: "thread-1",
    runId: "run-1",
    boardId: "board-1",
    clientSessionId: "client-session-1",
    projectSessionGeneration: 1,
    boardRevision: 1,
    canvasStateRevision: 1,
    capturedAt: "2026-07-17T12:00:00.000Z",
    expiresAt: "2026-07-17T12:01:00.000Z",
    viewport: { x: 0, y: 0, zoom: 1 },
    screens: [{
      reference,
      name: "Dashboard",
      route: "/dashboard",
      phase: "complete",
      viewport: { width: 1440, height: 900 },
    }],
    visibleScreens: [reference],
    selectedScreens: [reference],
  };
}
