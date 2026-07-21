import { describe, expect, it } from "vitest";

import {
  canvasAgentToolContextSchema,
  canvasAgentToolDescriptorSchema,
  canvasAgentToolInputSchemas,
  canvasAgentToolNames,
  canvasAgentToolOutputSchemas,
  canvasAgentToolReferenceSchema,
  canvasAgentToolRequestSchema,
  canvasAgentToolResultSchema,
  canvasClientCommandAckSchema,
  canvasClientCommandAckRequestSchema,
  canvasClientCommandAckRequestMatchesCommand,
  canvasClientCommandAckMatchesCommand,
  canvasClientCommandSchema,
  canvasClientStateSyncRequestSchema,
  canvasClientStateSyncResponseSchema,
  canvasScreenReferenceSchema,
  canvasSnapshotSchema,
  declareCanvasAgentTools,
  declaredCanvasAgentToolNames,
} from "../src/canvas-agent-tools.js";

const hash = "a".repeat(64);
const timestamp = "2026-07-17T08:00:00.000Z";
const screenReference = {
  boardNodeId: "board-node-1",
  artifactId: "artifact-1",
  artifactVersionId: "artifact-version-1",
  screenId: "screen-1",
};
const screen = {
  reference: screenReference,
  name: "Overview",
  route: "/overview",
  phase: "complete" as const,
  viewport: { width: 1_440, height: 900 },
};
const context = {
  protocol: "workbench.canvas-agent-tool.v1",
  principalId: "principal-1",
  projectId: "project-1",
  threadId: "thread-1",
  runId: null,
  runtimeAttemptId: null,
  agentSessionId: "agent-session-1",
  toolCallId: "tool-call-1",
  requestId: "request-1",
  traceId: "trace-1",
  clientSessionId: "client-session-1",
  projectSessionGeneration: 2,
  boardId: "board-1",
  boardRevision: 4,
  canvasStateRevision: 8,
  declarationSha256: hash,
  capabilities: ["canvas:read", "canvas:interact", "artifact:edit", "run:create"],
};

describe("Canvas Agent tool contracts", () => {
  it("covers the first eight tools in stable declaration order", () => {
    expect(canvasAgentToolNames).toEqual([
      "get_visible_screens",
      "get_selected_screens",
      "view_screen",
      "select_screen",
      "quick_edit",
      "duplicate_screen",
      "rename_screen",
      "navigate_canvas",
    ]);
    expect(Object.keys(canvasAgentToolInputSchemas)).toEqual(canvasAgentToolNames);
  });

  it("keeps trusted scope out of model supplied tool arguments", () => {
    expect(canvasAgentToolContextSchema.safeParse(context).success).toBe(true);
    expect(canvasAgentToolContextSchema.safeParse({
      ...context,
      runId: null,
      runtimeAttemptId: "attempt-1",
    }).success).toBe(false);

    const request = canvasAgentToolRequestSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      context,
      toolName: "quick_edit",
      input: { target: screenReference, instruction: "Change the title" },
    });
    expect(request.context.principalId).toBe("principal-1");
    expect(canvasAgentToolInputSchemas.quick_edit.safeParse({
      target: screenReference,
      instruction: "Change the title",
      endpoint: "https://attacker.invalid",
    }).success).toBe(false);
    expect(canvasAgentToolOutputSchemas.quick_edit.safeParse({
      runId: "run-1",
      target: screenReference,
      accepted: true,
    }).success).toBe(true);
    expect(canvasAgentToolOutputSchemas.quick_edit.safeParse({
      runId: "run-1",
      target: screenReference,
      result: screenReference,
    }).success).toBe(false);
    expect(canvasAgentToolOutputSchemas.duplicate_screen.safeParse({
      runId: "run-1",
      target: screenReference,
      accepted: true,
    }).success).toBe(true);
    expect(canvasAgentToolOutputSchemas.rename_screen.safeParse({
      runId: "run-1",
      target: screenReference,
      title: "Updated screen",
      accepted: true,
    }).success).toBe(true);
    expect(canvasAgentToolInputSchemas.navigate_canvas.safeParse({
      target: { kind: "all" },
      behavior: "instant",
      url: "https://attacker.invalid",
    }).success).toBe(false);
    expect(canvasScreenReferenceSchema.safeParse({
      ...screenReference,
      artifactId: "https://attacker.invalid/artifact",
    }).success).toBe(false);
    expect(canvasScreenReferenceSchema.safeParse({
      ...screenReference,
      artifactId: "data:application/json,{}",
    }).success).toBe(false);
  });

  it("binds Canvas snapshots to exact listed screen references", () => {
    const snapshot = {
      protocol: "workbench.canvas-snapshot.v1",
      projectId: "project-1",
      threadId: "thread-1",
      runId: null,
      boardId: "board-1",
      clientSessionId: "client-session-1",
      projectSessionGeneration: 2,
      boardRevision: 4,
      canvasStateRevision: 8,
      capturedAt: timestamp,
      expiresAt: "2026-07-17T08:00:30.000Z",
      viewport: { x: 0, y: 0, zoom: 1 },
      screens: [screen],
      visibleScreens: [screenReference],
      selectedScreens: [screenReference],
    };
    expect(canvasSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(canvasSnapshotSchema.safeParse({
      ...snapshot,
      visibleScreens: [{ ...screenReference, screenId: "unlisted" }],
    }).success).toBe(false);
    expect(canvasSnapshotSchema.safeParse({
      ...snapshot,
      expiresAt: snapshot.capturedAt,
    }).success).toBe(false);
  });

  it("requires result data and failure fields to agree with status", () => {
    const base = {
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: "agent-session-1",
      toolCallId: "tool-call-1",
      toolName: "rename_screen",
      boardRevision: 5,
      canvasStateRevision: 8,
      responseSha256: hash,
      approvalId: null,
      clientCommandId: null,
    };
    const data = { runId: "run-1", target: screenReference, title: "Renamed", accepted: true };
    expect(canvasAgentToolResultSchema.safeParse({
      ...base,
      status: "succeeded",
      data,
      failure: null,
    }).success).toBe(true);
    expect(canvasAgentToolResultSchema.safeParse({
      ...base,
      status: "succeeded",
      data: { target: screenReference },
      failure: null,
    }).success).toBe(false);
    expect(canvasAgentToolResultSchema.safeParse({
      ...base,
      status: "failed",
      data: null,
      failure: null,
    }).success).toBe(false);
    expect(canvasAgentToolResultSchema.safeParse({
      ...base,
      status: "failed",
      data: null,
      failure: { code: "REVISION_CONFLICT", message: "Board changed", retryable: true },
    }).success).toBe(true);
  });

  it("validates browser-owned Canvas state synchronization without duplicate references", () => {
    const state = {
      protocol: "workbench.canvas-client-state.v1",
      clientSessionId: "client-session-1",
      projectSessionGeneration: 2,
      boardId: "board-1",
      boardRevision: 4,
      canvasStateRevision: 9,
      viewport: { x: 12, y: -8, zoom: 1.25 },
      visibleScreens: [screenReference],
      selectedScreens: [screenReference],
    };
    expect(canvasClientStateSyncRequestSchema.safeParse(state).success).toBe(true);
    expect(canvasClientStateSyncRequestSchema.safeParse({
      ...state,
      causedByCommandId: "command-1",
    }).success).toBe(true);
    expect(canvasClientStateSyncRequestSchema.safeParse({
      ...state,
      causedByCommandId: "https://attacker.example/command",
    }).success).toBe(false);
    expect(canvasClientStateSyncRequestSchema.safeParse({
      ...state,
      selectedScreens: [screenReference, screenReference],
    }).success).toBe(false);
    expect(canvasClientStateSyncRequestSchema.safeParse({
      ...state,
      projectSessionGeneration: 0,
    }).success).toBe(false);
    expect(canvasClientStateSyncResponseSchema.safeParse({
      protocol: "workbench.canvas-client-state.v1",
      activeSession: true,
      canvasStateRevision: 9,
    }).success).toBe(true);
  });

  it("binds client commands and ACKs to the originating tool call", () => {
    const command = {
      protocol: "workbench.canvas-client-command.v1",
      commandId: "command-1",
      agentSessionId: "agent-session-1",
      toolCallId: "tool-call-1",
      requestId: "request-1",
      toolName: "view_screen",
      projectId: "project-1",
      threadId: "thread-1",
      runId: null,
      boardId: "board-1",
      clientSessionId: "client-session-1",
      projectSessionGeneration: 2,
      boardRevision: 4,
      expectedCanvasStateRevision: 8,
      issuedAt: timestamp,
      expiresAt: "2026-07-17T08:00:30.000Z",
      kind: "preview.open",
      target: screenReference,
      view: {
        screen: {
          reference: screenReference,
          name: "Home",
          route: "/",
          phase: "complete",
          viewport: { width: 390, height: 844 },
        },
        structure: { nodeCount: 4, actionCount: 1, stateCount: 1, motionCount: 2 },
        visualCapabilityId: "visual-capability-1",
      },
    };
    expect(canvasClientCommandSchema.safeParse(command).success).toBe(true);
    expect(canvasClientCommandSchema.safeParse({ ...command, toolName: "navigate_canvas" }).success).toBe(false);

    const ack = {
      protocol: "workbench.canvas-client-command-ack.v1",
      commandId: command.commandId,
      agentSessionId: command.agentSessionId,
      toolCallId: command.toolCallId,
      requestId: command.requestId,
      toolName: command.toolName,
      projectId: command.projectId,
      threadId: command.threadId,
      runId: command.runId,
      boardId: command.boardId,
      clientSessionId: command.clientSessionId,
      projectSessionGeneration: command.projectSessionGeneration,
      boardRevision: command.boardRevision,
      canvasStateRevision: 9,
      acknowledgedAt: "2026-07-17T08:00:01.000Z",
      status: "applied",
      result: { view: command.view },
      failure: null,
    };
    expect(canvasClientCommandAckSchema.safeParse(ack).success).toBe(true);
    expect(canvasClientCommandAckMatchesCommand(command, ack)).toBe(true);
    expect(canvasClientCommandAckMatchesCommand(command, {
      ...ack,
      projectSessionGeneration: ack.projectSessionGeneration + 1,
    })).toBe(false);
    expect(canvasClientCommandAckMatchesCommand(command, {
      ...ack,
      requestId: "request-2",
    })).toBe(false);
    expect(canvasClientCommandAckSchema.safeParse({
      ...ack,
      clientSessionId: "https://attacker.invalid/session",
    }).success).toBe(false);
    const wireAck = {
      ...ack,
      visualCapture: {
        protocol: "workbench.canvas-visual-capture.v1",
        visualCapabilityId: command.view.visualCapabilityId,
        mediaType: "image/png",
        byteSize: 68,
        width: 1,
        height: 1,
        sha256: hash,
        dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    };
    expect(canvasClientCommandAckRequestSchema.safeParse(wireAck).success).toBe(true);
    expect(canvasClientCommandAckRequestMatchesCommand(command, wireAck)).toBe(true);
    expect(canvasClientCommandAckRequestSchema.safeParse({
      ...wireAck,
      visualCapture: { ...wireAck.visualCapture, visualCapabilityId: "other-visual" },
    }).success).toBe(false);
    expect(canvasClientCommandAckSchema.safeParse({
      ...ack,
      status: "rejected",
      result: null,
      failure: null,
    }).success).toBe(false);
  });

  it("declares tools from capability and live Canvas state without ambient state", () => {
    const viewer = {
      capabilities: ["canvas:read", "canvas:interact"] as const,
      hasFreshSnapshot: true,
      screenCount: 2,
      selectedScreenCount: 1,
      selectedScreenEditable: false,
      activeMutation: false,
      editModelAvailable: false,
    };
    expect(declaredCanvasAgentToolNames(viewer)).toEqual([
      "get_visible_screens",
      "get_selected_screens",
      "view_screen",
      "select_screen",
      "navigate_canvas",
    ]);

    const editor = {
      ...viewer,
      capabilities: ["canvas:read", "canvas:interact", "artifact:edit", "run:create"] as const,
      selectedScreenEditable: true,
      editModelAvailable: true,
    };
    expect(declaredCanvasAgentToolNames(editor)).toEqual(canvasAgentToolNames);
    expect(declaredCanvasAgentToolNames({ ...editor, activeMutation: true })).toEqual([
      "get_visible_screens",
      "get_selected_screens",
      "view_screen",
      "select_screen",
      "navigate_canvas",
    ]);
    expect(declareCanvasAgentTools({ ...editor, hasFreshSnapshot: false })).toEqual([]);
    expect(declareCanvasAgentTools({ ...editor, screenCount: 0, selectedScreenCount: 0, selectedScreenEditable: false }))
      .toEqual([]);
  });

  it("separates the signed transport descriptor from the model-visible reference", () => {
    const reference = canvasAgentToolReferenceSchema.parse({
      protocol: "workbench.canvas-agent-tool-reference.v1",
      declarationRevision: 3,
      declarationSha256: hash,
      declaredTools: ["get_visible_screens", "view_screen"],
    });
    const descriptor = canvasAgentToolDescriptorSchema.parse({
      protocol: "workbench.canvas-agent-tool-descriptor.v1",
      endpoint: "https://workbench.test/internal/canvas-tools/invoke",
      visualEndpoint: "https://workbench.test/internal/canvas-visuals/visual-capability-1",
      token: `wbct1.${"a".repeat(64)}.${"b".repeat(43)}`,
      expiresAt: "2026-07-17T08:05:00.000Z",
      reference,
    });
    expect(descriptor.reference).toEqual(reference);
    expect(JSON.stringify(reference)).not.toMatch(/endpoint|token|expiresAt|wbct1/u);
    expect(canvasAgentToolReferenceSchema.safeParse({ ...reference, token: descriptor.token }).success).toBe(false);
    expect(canvasAgentToolDescriptorSchema.safeParse({
      ...descriptor,
      endpoint: "https://user:pass@workbench.test/invoke#secret",
    }).success).toBe(false);
  });
});
