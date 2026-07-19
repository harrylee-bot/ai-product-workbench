import { describe, expect, it } from "vitest";

import type { BoardFlowNode } from "../../../board";
import {
  createCanvasAgentClientStateSyncRequest,
  createCanvasAgentSnapshot,
  projectCanvasAgentScreens,
  screenReferenceFromBoardFlowNode,
} from "./snapshot";

describe("Canvas Agent screen snapshot", () => {
  it("projects strict selected and viewport-visible screen references", () => {
    const selectedOutside = artifactNode("node-selected", {
      position: { x: 500, y: 500 },
      selected: true,
    });
    const visible = artifactNode("node-visible", {
      position: { x: 60, y: 30 },
    });
    const hidden = artifactNode("node-hidden", {
      position: { x: 260, y: 30 },
    });

    const snapshot = projectCanvasAgentScreens({
      nodes: [selectedOutside, visible, hidden],
      stage: { width: 400, height: 300 },
      viewport: { x: -100, y: -50, zoom: 2 },
    });

    expect(snapshot).toEqual({
      selectedScreenCount: 1,
      selectedScreens: [reference("node-selected")],
      selectedScreensTruncated: false,
      visibleScreenCount: 1,
      visibleScreens: [reference("node-visible")],
      visibleScreensTruncated: false,
    });
  });

  it("uses absolute child coordinates when deciding visibility", () => {
    const frame = frameNode("frame", { position: { x: 500, y: 100 } });
    const child = artifactNode("child", {
      parentId: frame.id,
      position: { x: 20, y: 30 },
    });

    const snapshot = projectCanvasAgentScreens({
      nodes: [frame, child],
      stage: { width: 200, height: 200 },
      viewport: { x: -500, y: -100, zoom: 1 },
    });

    expect(snapshot.visibleScreens).toEqual([reference("child")]);
  });

  it("excludes incomplete references and non-screen nodes", () => {
    const noScreen = artifactNode("no-screen", {
      data: {
        protocol: "workbench.board-node.v1",
        nodeType: "artifact",
        title: "No screen",
        artifactKind: "prototype",
      },
      selected: true,
    });
    const noVersion = artifactNode("no-version", {
      selected: true,
      workbench: {
        kind: "artifact",
        order: 0,
        artifactId: "artifact-no-version",
        artifactVersionId: null,
        size: { width: 100, height: 100 },
      },
    });
    const frame = frameNode("frame", { selected: true });

    expect(screenReferenceFromBoardFlowNode(noScreen)).toBeNull();
    expect(screenReferenceFromBoardFlowNode(noVersion)).toBeNull();
    expect(screenReferenceFromBoardFlowNode(frame)).toBeNull();
    expect(projectCanvasAgentScreens({
      nodes: [noScreen, noVersion, frame],
      stage: { width: 1_000, height: 1_000 },
      viewport: { x: 0, y: 0, zoom: 1 },
    })).toMatchObject({
      selectedScreenCount: 0,
      selectedScreens: [],
      visibleScreenCount: 0,
      visibleScreens: [],
    });
  });

  it("bounds both lists while preserving their total counts", () => {
    const nodes = Array.from({ length: 4 }, (_, index) => artifactNode(`node-${index}`, {
      position: { x: index * 110, y: 0 },
      selected: true,
    }));

    const snapshot = projectCanvasAgentScreens({
      limits: { selectedScreens: 2, visibleScreens: 3 },
      nodes,
      stage: { width: 1_000, height: 1_000 },
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(snapshot.selectedScreenCount).toBe(4);
    expect(snapshot.selectedScreens.map(({ boardNodeId }) => boardNodeId))
      .toEqual(["node-0", "node-1"]);
    expect(snapshot.selectedScreensTruncated).toBe(true);
    expect(snapshot.visibleScreenCount).toBe(4);
    expect(snapshot.visibleScreens.map(({ boardNodeId }) => boardNodeId))
      .toEqual(["node-0", "node-1", "node-2"]);
    expect(snapshot.visibleScreensTruncated).toBe(true);
  });

  it("keeps selection but returns no visible screens for invalid geometry", () => {
    const first = artifactNode("first", { parentId: "second", selected: true });
    const second = artifactNode("second", { parentId: "first" });

    const snapshot = projectCanvasAgentScreens({
      nodes: [first, second],
      stage: { width: 1_000, height: 1_000 },
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(snapshot.selectedScreens).toEqual([reference("first")]);
    expect(snapshot.visibleScreens).toEqual([]);
  });

  it("assembles a contract-valid bounded snapshot from known screen summaries", () => {
    const known = artifactNode("known", { selected: true });
    const omitted = artifactNode("omitted", { selected: true });

    const snapshot = createCanvasAgentSnapshot({
      boardId: "board-1",
      boardRevision: 4,
      canvasStateRevision: 7,
      capturedAt: "2026-07-17T12:00:00.000Z",
      clientSessionId: "client-session-1",
      expiresAt: "2026-07-17T12:01:00.000Z",
      nodes: [known, omitted],
      projectId: "project-1",
      projectSessionGeneration: 1,
      runId: "run-1",
      screens: [{
        reference: reference("known"),
        name: "Known screen",
        route: "/known",
        phase: "complete",
        viewport: { width: 100, height: 100 },
      }],
      stage: { width: 1_000, height: 1_000 },
      threadId: "thread-1",
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(snapshot.protocol).toBe("workbench.canvas-snapshot.v1");
    expect(snapshot.screens).toHaveLength(1);
    expect(snapshot.selectedScreens).toEqual([reference("known")]);
    expect(snapshot.visibleScreens).toEqual([reference("known")]);

    expect(createCanvasAgentClientStateSyncRequest(snapshot)).toEqual({
      protocol: "workbench.canvas-client-state.v1",
      clientSessionId: "client-session-1",
      projectSessionGeneration: 1,
      boardId: "board-1",
      boardRevision: 4,
      canvasStateRevision: 7,
      viewport: { x: 0, y: 0, zoom: 1 },
      visibleScreens: [reference("known")],
      selectedScreens: [reference("known")],
    });
  });
});

function reference(nodeId: string) {
  return {
    artifactId: `artifact-${nodeId}`,
    artifactVersionId: `version-${nodeId}`,
    boardNodeId: nodeId,
    screenId: `screen-${nodeId}`,
  };
}

function artifactNode(
  id: string,
  overrides: Partial<BoardFlowNode> = {},
): BoardFlowNode {
  return {
    id,
    type: "artifact",
    position: { x: 0, y: 0 },
    data: {
      protocol: "workbench.board-node.v1",
      nodeType: "artifact",
      title: id,
      artifactKind: "prototype",
      screenId: `screen-${id}`,
    },
    style: { width: 100, height: 100 },
    workbench: {
      kind: "artifact",
      order: 0,
      artifactId: `artifact-${id}`,
      artifactVersionId: `version-${id}`,
      size: { width: 100, height: 100 },
    },
    ...overrides,
  } as BoardFlowNode;
}

function frameNode(
  id: string,
  overrides: Partial<BoardFlowNode> = {},
): BoardFlowNode {
  return {
    id,
    type: "frame",
    position: { x: 0, y: 0 },
    data: {
      protocol: "workbench.board-node.v1",
      nodeType: "frame",
      title: id,
      fill: null,
      stroke: "#000000",
    },
    style: { width: 400, height: 400 },
    workbench: {
      kind: "frame",
      order: 0,
      artifactId: null,
      artifactVersionId: null,
      size: { width: 400, height: 400 },
    },
    ...overrides,
  } as BoardFlowNode;
}
