import type {
  CanvasClientCommand,
  CanvasClientCommandAck,
  CanvasClientCommandAckRequest,
  CanvasClientStateSyncRequest,
  CanvasScreenReference,
} from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import type { CanvasAgentUiPort } from "../application/dispatcher";
import {
  CanvasAgentCommandPoller,
  type CanvasAgentPollingScope,
} from "./poller";
import type { CanvasAgentCommandTransport } from "./client";

describe("CanvasAgentCommandPoller", () => {
  it("drains commands, applies them through the dispatcher, and ACKs durably", async () => {
    const command = makeCommand();
    const acknowledgements: CanvasClientCommandAckRequest[] = [];
    const events: string[] = [];
    const synchronizationCauses: Array<string | undefined> = [];
    let listed = false;
    const transport: CanvasAgentCommandTransport = {
      list: async () => {
        events.push("list");
        if (listed) return { items: [], nextCursor: null };
        listed = true;
        return { items: [command], nextCursor: null };
      },
      acknowledge: async (_projectId, _commandId, ack) => {
        events.push("ack");
        acknowledgements.push(ack);
        return ack;
      },
      syncState: async (_projectId, state) => {
        events.push("sync");
        synchronizationCauses.push(state.causedByCommandId);
        return synchronized(state.canvasStateRevision);
      },
    };
    const poller = new CanvasAgentCommandPoller({
      captureState: clientState,
      scope: pollingScope(),
      transport,
      ui: uiPort({ selectScreen: () => {
        events.push("ui");
        return {};
      } }),
    });

    await poller.drain(new AbortController().signal);

    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]!.status).toBe("applied");
    expect(events).toEqual(["sync", "list", "ui", "sync", "ack"]);
    expect(synchronizationCauses).toEqual([undefined, command.commandId]);
  });

  it("sends a view_screen capture only on the wire ACK", async () => {
    const command = previewCommand();
    const acknowledgements: CanvasClientCommandAckRequest[] = [];
    const capture = {
      protocol: "workbench.canvas-visual-capture.v1" as const,
      visualCapabilityId: "visual-capability-1",
      mediaType: "image/webp" as const,
      byteSize: 12,
      width: 1,
      height: 1,
      sha256: "a".repeat(64),
      dataBase64: "AQIDBAUGBwgJCgsM",
    };
    const transport: CanvasAgentCommandTransport = {
      list: async () => ({ items: [command], nextCursor: null }),
      acknowledge: async (_projectId, _commandId, ack) => {
        acknowledgements.push(ack);
        return ack as CanvasClientCommandAck;
      },
      syncState: async (_projectId, state) => synchronized(state.canvasStateRevision),
    };
    const poller = new CanvasAgentCommandPoller({
      captureState: clientState,
      scope: pollingScope(),
      transport,
      ui: uiPort({
        openPreview: async () => capture,
      }),
    });

    await poller.drain(new AbortController().signal);

    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]!.visualCapture).toEqual(capture);
    expect(JSON.stringify(acknowledgements[0]!.result)).not.toContain("dataBase64");
  });

  it("rejects an old stable scope without poisoning later command-scoped identities", async () => {
    const stale = makeCommand({ projectId: "old-project", toolCallId: "old-call" });
    const current = makeCommand({
      agentSessionId: "session-2",
      commandId: "command-2",
      requestId: "canvas-request-2",
      toolCallId: "tool-call-2",
    });
    const acknowledgements: CanvasClientCommandAckRequest[] = [];
    let page = 0;
    const transport: CanvasAgentCommandTransport = {
      list: async () => ({
        items: page++ === 0 ? [stale, current] : [],
        nextCursor: null,
      }),
      acknowledge: async (_projectId, _commandId, ack) => {
        acknowledgements.push(ack);
        return ack;
      },
      syncState: async (_projectId, state) => synchronized(state.canvasStateRevision),
    };
    const poller = new CanvasAgentCommandPoller({
      captureState: clientState,
      scope: pollingScope(),
      transport,
      ui: uiPort(),
    });

    await poller.drain(new AbortController().signal);

    expect(acknowledgements.map((ack) => ack.status)).toEqual(["rejected", "applied"]);
    expect(acknowledgements[0]!.failure?.code).toBe("COMMAND_SCOPE_MISMATCH");
  });

  it("retries a failed ACK without applying the UI command twice", async () => {
    const command = makeCommand();
    const selectScreen = vi.fn(() => ({}));
    let acknowledgeAttempts = 0;
    const transport: CanvasAgentCommandTransport = {
      list: async () => ({ items: [command], nextCursor: null }),
      acknowledge: async (_projectId, _commandId, ack) => {
        acknowledgeAttempts += 1;
        if (acknowledgeAttempts === 1) throw new Error("network unavailable");
        return ack;
      },
      syncState: async (_projectId, state) => synchronized(state.canvasStateRevision),
    };
    const poller = new CanvasAgentCommandPoller({
      captureState: clientState,
      scope: pollingScope(),
      transport,
      ui: { ...uiPort(), selectScreen },
    });

    await expect(poller.drain(new AbortController().signal)).rejects.toThrow("network unavailable");
    await expect(poller.drain(new AbortController().signal)).resolves.toBeUndefined();

    expect(acknowledgeAttempts).toBe(2);
    expect(selectScreen).toHaveBeenCalledTimes(1);
  });

  it("rebases a retried ACK onto client state that advanced after the UI command", async () => {
    const command = makeCommand();
    let canvasStateRevision = 1;
    const selectScreen = vi.fn(() => {
      canvasStateRevision = 2;
      return {};
    });
    const acknowledgedRevisions: number[] = [];
    const transport: CanvasAgentCommandTransport = {
      list: async () => ({ items: [command], nextCursor: null }),
      acknowledge: async (_projectId, _commandId, ack) => {
        acknowledgedRevisions.push(ack.canvasStateRevision);
        if (acknowledgedRevisions.length === 1) throw new Error("network unavailable");
        return ack;
      },
      syncState: async (_projectId, state) => synchronized(state.canvasStateRevision),
    };
    const poller = new CanvasAgentCommandPoller({
      captureState: () => ({ ...clientState(), canvasStateRevision }),
      scope: pollingScope(),
      transport,
      ui: uiPort({
        getCanvasStateRevision: () => canvasStateRevision,
        selectScreen,
      }),
    });

    await expect(poller.drain(new AbortController().signal)).rejects.toThrow("network unavailable");
    canvasStateRevision = 3;
    await expect(poller.drain(new AbortController().signal)).resolves.toBeUndefined();

    expect(acknowledgedRevisions).toEqual([2, 3]);
    expect(selectScreen).toHaveBeenCalledTimes(1);
  });

  it("retries post-dispatch state sync without applying the UI command twice", async () => {
    const command = makeCommand();
    const selectScreen = vi.fn(() => ({}));
    const acknowledge = vi.fn(async (
      _projectId,
      _commandId,
      ack: CanvasClientCommandAckRequest,
    ) => ack as CanvasClientCommandAck);
    let syncAttempts = 0;
    const transport: CanvasAgentCommandTransport = {
      list: async () => ({ items: [command], nextCursor: null }),
      acknowledge,
      syncState: async (_projectId, state) => {
        syncAttempts += 1;
        if (syncAttempts === 2) throw new Error("state sync unavailable");
        return synchronized(state.canvasStateRevision);
      },
    };
    const poller = new CanvasAgentCommandPoller({
      captureState: clientState,
      scope: pollingScope(),
      transport,
      ui: uiPort({ selectScreen }),
    });

    await expect(poller.drain(new AbortController().signal)).rejects.toThrow("state sync unavailable");
    await expect(poller.drain(new AbortController().signal)).resolves.toBeUndefined();

    expect(syncAttempts).toBe(4);
    expect(selectScreen).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("does not list commands until the server reports an active Canvas session", async () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: null }));
    const transport: CanvasAgentCommandTransport = {
      list,
      acknowledge: async (_projectId, _commandId, ack) => ack,
      syncState: async (_projectId, state) => ({
        ...synchronized(state.canvasStateRevision),
        activeSession: false,
      }),
    };
    const poller = new CanvasAgentCommandPoller({
      captureState: clientState,
      scope: pollingScope(),
      transport,
      ui: uiPort(),
    });

    await poller.drain(new AbortController().signal);

    expect(list).not.toHaveBeenCalled();
  });
});

const target: CanvasScreenReference = {
  boardNodeId: "node-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  screenId: "screen-1",
};

function pollingScope(): CanvasAgentPollingScope {
  return {
    boardId: "board-1",
    clientSessionId: "client-session-1",
    projectId: "project-1",
    projectSessionGeneration: 1,
    runId: null,
    threadId: "thread-1",
  };
}

function clientState(): CanvasClientStateSyncRequest {
  return {
    protocol: "workbench.canvas-client-state.v1",
    clientSessionId: "client-session-1",
    projectSessionGeneration: 1,
    boardId: "board-1",
    boardRevision: 1,
    canvasStateRevision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    visibleScreens: [target],
    selectedScreens: [],
  };
}

function synchronized(canvasStateRevision: number) {
  return {
    protocol: "workbench.canvas-client-state.v1" as const,
    activeSession: true,
    canvasStateRevision,
  };
}

function makeCommand(overrides: Partial<CanvasClientCommand> = {}): CanvasClientCommand {
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  return {
    protocol: "workbench.canvas-client-command.v1",
    commandId: "command-1",
    agentSessionId: "session-1",
    toolCallId: "tool-call-1",
    requestId: "request-1",
    projectId: "project-1",
    threadId: "thread-1",
    runId: null,
    boardId: "board-1",
    clientSessionId: "client-session-1",
    projectSessionGeneration: 1,
    boardRevision: 1,
    expectedCanvasStateRevision: 1,
    issuedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    kind: "selection.change",
    toolName: "select_screen",
    targets: [target],
    mode: "replace",
    ...overrides,
  } as CanvasClientCommand;
}

function previewCommand(): CanvasClientCommand {
  const selection = makeCommand() as Extract<CanvasClientCommand, { kind: "selection.change" }>;
  const { mode: _mode, targets: _targets, ...base } = selection;
  return {
    ...base,
    kind: "preview.open",
    toolName: "view_screen",
    target,
    view: {
      screen: {
        reference: target,
        name: "Home",
        route: "/",
        phase: "complete",
        viewport: { width: 390, height: 844 },
      },
      structure: { nodeCount: 1, actionCount: 0, stateCount: 0, motionCount: 0 },
      visualCapabilityId: "visual-capability-1",
    },
  } as CanvasClientCommand;
}

function uiPort(overrides: Partial<CanvasAgentUiPort> = {}): CanvasAgentUiPort {
  return {
    getBoardRevision: () => 1,
    getCanvasStateRevision: () => 1,
    hasScreenReference: () => true,
    navigateCanvas: () => ({}),
    openPreview: (_target, visualCapabilityId) => Promise.resolve({
      protocol: "workbench.canvas-visual-capture.v1" as const,
      visualCapabilityId,
      mediaType: "image/webp" as const,
      byteSize: 12,
      width: 1,
      height: 1,
      sha256: "a".repeat(64),
      dataBase64: "AQIDBAUGBwgJCgsM",
    }),
    selectScreen: () => ({}),
    ...overrides,
  };
}
