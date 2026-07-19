import type {
  CanvasClientCommand,
  CanvasScreenReference,
  CanvasVisualCaptureWire,
} from "@workbench/workbench-contracts";
import { canvasClientCommandAckMatchesCommand } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  type CanvasAgentCommandScope,
  type CanvasAgentUiPort,
  ScopedCanvasAgentClientCommandDispatcher,
} from "./dispatcher";

describe("ScopedCanvasAgentClientCommandDispatcher", () => {
  it("applies a scoped selection command and returns a contract ACK", async () => {
    const calls: string[] = [];
    const dispatcher = createDispatcher({
      selectScreen: (targets) => {
        calls.push(targets[0]!.screenId);
        return { selected: targets };
      },
    });

    const selectionCommand = command("selection.change");
    const outcome = await dispatcher.dispatch(envelope(selectionCommand));

    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack") return;
    expect(outcome.ack.status).toBe("applied");
    expect(outcome.ack.requestId).toBe("request-1");
    expect(outcome.ack.threadId).toBe("thread-1");
    expect(outcome.ack.runId).toBeNull();
    expect(outcome.ack.projectSessionGeneration).toBe(1);
    expect(outcome.ack.boardRevision).toBe(selectionCommand.boardRevision);
    expect(canvasClientCommandAckMatchesCommand(selectionCommand, outcome.ack)).toBe(true);
    expect(calls).toEqual(["screen-1"]);
  });

  it("keeps visual capture wire data separate from the durable preview ACK", async () => {
    const openPreview = vi.fn(async (_target, visualCapabilityId) => visualCapture(visualCapabilityId));
    const dispatcher = createDispatcher({ openPreview });
    const previewCommand = command("preview.open") as Extract<
      CanvasClientCommand,
      { kind: "preview.open" }
    >;

    const outcome = await dispatcher.dispatch(envelope(previewCommand));

    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack" || outcome.ack.status !== "applied") return;
    expect(openPreview).toHaveBeenCalledWith(
      TARGET,
      "visual-capability-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(outcome.visualCapture?.visualCapabilityId).toBe("visual-capability-1");
    expect(outcome.ack.result).toEqual({ view: previewCommand.view });
    expect(JSON.stringify(outcome.ack)).not.toContain("dataBase64");
    expect(canvasClientCommandAckMatchesCommand(previewCommand, outcome.ack)).toBe(true);
  });

  it("rejects a capture returned for a different capability", async () => {
    const dispatcher = createDispatcher({
      openPreview: async () => visualCapture("other-capability"),
    });
    const outcome = await dispatcher.dispatch(envelope(command("preview.open")));

    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack" || outcome.ack.status !== "rejected") return;
    expect(outcome.ack.failure.code).toBe("VISUAL_CAPTURE_MISMATCH");
    expect(outcome.visualCapture).toBeUndefined();
  });

  it("deduplicates concurrent and replayed tool calls with the bounded ledger", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const select = vi.fn(async () => {
      await pending;
      return {};
    });
    const dispatcher = createDispatcher({ selectScreen: select });
    const input = envelope(command("selection.change"));

    const first = dispatcher.dispatch(input);
    const second = dispatcher.dispatch(input);
    expect(second).toBe(first);
    release();
    await first;
    await dispatcher.dispatch(input);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rebinds a replay ACK to the current command envelope without repeating UI", async () => {
    const select = vi.fn(() => ({ selection: "unchanged" }));
    const dispatcher = createDispatcher({ selectScreen: select });
    const first = command("selection.change");
    await dispatcher.dispatch(envelope(first));
    const replay = command("selection.change", {
      commandId: "command-replay",
      issuedAt: new Date(Date.now() - 500).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const outcome = await dispatcher.dispatch(envelope(replay));

    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack") return;
    expect(outcome.ack.commandId).toBe("command-replay");
    expect(canvasClientCommandAckMatchesCommand(replay, outcome.ack)).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects a toolCallId replay whose command parameters changed", async () => {
    const select = vi.fn(() => ({}));
    const dispatcher = createDispatcher({ selectScreen: select });
    await dispatcher.dispatch(envelope(command("selection.change")));
    const replay = command("selection.change", {
      commandId: "command-replay",
      targets: [{ ...TARGET, screenId: "screen-other" }],
    } as Partial<CanvasClientCommand>);

    const outcome = await dispatcher.dispatch(envelope(replay));

    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack") return;
    expect(outcome.ack.status).toBe("rejected");
    if (outcome.ack.status !== "rejected") return;
    expect(outcome.ack.failure.code).toBe("TOOL_CALL_REPLAY_MISMATCH");
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["projectId", "other-project"],
    ["threadId", "other-thread"],
    ["clientSessionId", "other-client"],
    ["projectSessionGeneration", 2],
    ["runId", "run-2"],
  ] as const)("rejects a command with a mismatched %s", async (field, value) => {
    const dispatcher = createDispatcher();
    const bad = command("selection.change", { [field]: value });
    const outcome = await dispatcher.dispatch(envelope(bad));

    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack") return;
    expect(outcome.ack.status).toBe("rejected");
    if (outcome.ack.status !== "rejected") return;
    expect(outcome.ack.failure.code).toBe("COMMAND_SCOPE_MISMATCH");
  });

  it("treats request and agent session identities as command-scoped", async () => {
    const select = vi.fn(() => ({}));
    const dispatcher = createDispatcher({ selectScreen: select });
    const first = await dispatcher.dispatch(envelope(command("selection.change")));
    const second = await dispatcher.dispatch(envelope(command("selection.change", {
      agentSessionId: "session-2",
      commandId: "command-2",
      requestId: "canvas-request-2",
      toolCallId: "tool-call-2",
    })));

    expect(first.kind === "ack" && first.ack.status).toBe("applied");
    expect(second.kind === "ack" && second.ack.status).toBe("applied");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed scope without manufacturing an ACK", async () => {
    const dispatcher = createDispatcher();
    const outcome = await dispatcher.dispatch({
      command: command("selection.change"),
      scope: { ...scope(), threadId: "" },
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "invalid-scope" });
  });

  it("discards stale revisions and waits for a future revision", async () => {
    const stale = createDispatcher({ boardRevision: 8 });
    const staleOutcome = await stale.dispatch(envelope(command("selection.change", { boardRevision: 7 })));
    expect(staleOutcome.kind).toBe("ack");
    if (staleOutcome.kind === "ack") expect(staleOutcome.ack.status).toBe("rejected");
    if (staleOutcome.kind === "ack" && staleOutcome.ack.status === "rejected") {
      expect(staleOutcome.ack.failure.code).toBe("STALE_BOARD_REVISION");
      expect(staleOutcome.ack.boardRevision).toBe(7);
    }

    const waitForBoardRevision = vi.fn(async () => 9);
    const future = createDispatcher({ boardRevision: 8, waitForBoardRevision });
    const futureOutcome = await future.dispatch(envelope(command("selection.change", { boardRevision: 9 })));
    expect(waitForBoardRevision).toHaveBeenCalledWith(9, expect.any(AbortSignal));
    expect(futureOutcome.kind).toBe("ack");
    if (futureOutcome.kind === "ack") expect(futureOutcome.ack.status).toBe("applied");
  });

  it("aborts a future-revision command when the project session changes", async () => {
    let rejectWait!: (error: unknown) => void;
    const waitForBoardRevision = vi.fn((_revision: number, signal: AbortSignal) => (
      new Promise<number>((_resolve, reject) => {
        rejectWait = reject;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })
    ));
    const dispatcher = createDispatcher({ boardRevision: 4, waitForBoardRevision });
    const pending = dispatcher.dispatch(envelope(command("selection.change", { boardRevision: 5 })));
    dispatcher.replaceScope({ ...scope(), projectSessionGeneration: 2 });
    rejectWait(new DOMException("aborted", "AbortError"));

    const outcome = await pending;
    expect(outcome.kind).toBe("ack");
    if (outcome.kind === "ack") expect(outcome.ack.status).toBe("rejected");
    if (outcome.kind === "ack" && outcome.ack.status === "rejected") {
      expect(outcome.ack.failure.code).toBe("PROJECT_SESSION_CHANGED");
    }
  });

  it("re-resolves screen references and never persists Board state", async () => {
    const select = vi.fn(() => ({}));
    const dispatcher = createDispatcher({
      hasScreenReference: () => false,
      selectScreen: select,
    });
    const outcome = await dispatcher.dispatch(envelope(command("selection.change")));

    expect(outcome.kind).toBe("ack");
    if (outcome.kind === "ack") expect(outcome.ack.status).toBe("rejected");
    if (outcome.kind === "ack" && outcome.ack.status === "rejected") {
      expect(outcome.ack.failure.code).toBe("SCREEN_NOT_FOUND");
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("arms and consumes navigation suppression once, while user movement cancels it", async () => {
    const navigate = vi.fn((_command, context) => {
      context.armProgrammaticViewport({ x: 20, y: 30, zoom: 1.25 });
      return { viewport: { x: 20, y: 30, zoom: 1.25 } };
    });
    const dispatcher = createDispatcher({ navigateCanvas: navigate });
    const outcome = await dispatcher.dispatch(envelope(command("viewport.navigate")));

    expect(outcome.kind).toBe("ack");
    expect(dispatcher.consumeViewportMoveEnd({ x: 20.1, y: 29.9, zoom: 1.25001 })).toBe(true);
    expect(dispatcher.consumeViewportMoveEnd({ x: 20, y: 30, zoom: 1.25 })).toBe(false);
    navigate.mockImplementation((_command, context) => {
      context.armProgrammaticViewport({ x: 20, y: 30, zoom: 1.25 });
      return { viewport: { x: 20, y: 30, zoom: 1.25 } };
    });
    await dispatcher.dispatch(envelope(command("viewport.navigate", { commandId: "command-2", toolCallId: "tool-call-2" })));
    dispatcher.cancelViewportMoveForUserGesture();
    expect(dispatcher.consumeViewportMoveEnd({ x: 20, y: 30, zoom: 1.25 })).toBe(false);
  });
});

const TARGET: CanvasScreenReference = {
  boardNodeId: "node-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  screenId: "screen-1",
};

function scope(): CanvasAgentCommandScope {
  return {
    boardId: "board-1",
    clientSessionId: "client-session-1",
    projectId: "project-1",
    projectSessionGeneration: 1,
    runId: null,
    threadId: "thread-1",
  };
}

function command(
  kind: CanvasClientCommand["kind"],
  overrides: Partial<CanvasClientCommand> = {},
): CanvasClientCommand {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const base = {
    protocol: "workbench.canvas-client-command.v1" as const,
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
    boardRevision: 7,
    expectedCanvasStateRevision: 3,
    issuedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  if (kind === "preview.open") {
    return {
      ...base,
      kind,
      toolName: "view_screen",
      target: TARGET,
      view: {
        screen: {
          reference: TARGET,
          name: "Home",
          route: "/",
          phase: "complete",
          viewport: { width: 390, height: 844 },
        },
        structure: { nodeCount: 4, actionCount: 1, stateCount: 1, motionCount: 2 },
        visualCapabilityId: "visual-capability-1",
      },
      ...overrides,
    } as CanvasClientCommand;
  }
  if (kind === "selection.change") {
    return {
      ...base,
      kind,
      toolName: "select_screen",
      targets: [TARGET],
      mode: "replace",
      ...overrides,
    } as CanvasClientCommand;
  }
  return {
    ...base,
    kind,
    toolName: "navigate_canvas",
    target: { kind: "screen", screen: TARGET },
    behavior: "instant",
    ...overrides,
  } as CanvasClientCommand;
}

function envelope(value: CanvasClientCommand) {
  return { command: value, scope: scope() };
}

function createDispatcher(options: {
  boardRevision?: number;
  canvasStateRevision?: number;
  hasScreenReference?: (reference: CanvasScreenReference) => boolean;
  navigateCanvas?: CanvasAgentUiPort["navigateCanvas"];
  openPreview?: CanvasAgentUiPort["openPreview"];
  selectScreen?: CanvasAgentUiPort["selectScreen"];
  waitForBoardRevision?: CanvasAgentUiPort["waitForBoardRevision"];
} = {}) {
  let boardRevision = options.boardRevision ?? 7;
  const canvasStateRevision = options.canvasStateRevision ?? 3;
  const ui: CanvasAgentUiPort = {
    getBoardRevision: () => boardRevision,
    getCanvasStateRevision: () => canvasStateRevision,
    hasScreenReference: options.hasScreenReference ?? (() => true),
    navigateCanvas: options.navigateCanvas ?? (() => ({})),
    openPreview: options.openPreview ?? ((_target, visualCapabilityId) => Promise.resolve(
      visualCapture(visualCapabilityId),
    )),
    selectScreen: options.selectScreen ?? (() => ({})),
    waitForBoardRevision: options.waitForBoardRevision
      ? async (revision, signal) => {
        const resolved = await options.waitForBoardRevision!(revision, signal);
        boardRevision = resolved;
        return resolved;
      }
      : undefined,
  };
  return new ScopedCanvasAgentClientCommandDispatcher({
    initialScope: scope(),
    ui,
  });
}

function visualCapture(visualCapabilityId: string): CanvasVisualCaptureWire {
  return {
    protocol: "workbench.canvas-visual-capture.v1",
    visualCapabilityId,
    mediaType: "image/webp",
    byteSize: 12,
    width: 1,
    height: 1,
    sha256: "a".repeat(64),
    dataBase64: "AQIDBAUGBwgJCgsM",
  };
}
