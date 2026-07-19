import {
  canvasClientCommandAckSchema,
  canvasClientCommandSchema,
  type CanvasVisualCaptureWire,
  type CanvasClientCommand,
  type CanvasClientCommandAck,
  type CanvasScreenReference,
} from "@workbench/workbench-contracts";
import type { Viewport } from "@xyflow/system";

import { BoundedLruLedger } from "./lru-ledger";
import { canvasAgentRevisionDisposition } from "./revision-policy";
import {
  CanvasAgentViewportMoveSuppression,
  type CanvasAgentViewportSuppressionToken,
} from "./viewport-suppression";

export type CanvasAgentCommandScope = {
  boardId: string;
  clientSessionId: string;
  projectId: string;
  projectSessionGeneration: number;
  runId: string | null;
  threadId: string;
};

export type ScopedCanvasAgentClientCommand = {
  command: unknown;
  scope: unknown;
};

export type CanvasAgentDispatchOutcome =
  | {
      kind: "ack";
      ack: CanvasClientCommandAck;
      /** Wire-only payload. It is deliberately absent from the durable ACK. */
      visualCapture?: CanvasVisualCaptureWire | null;
    }
  | {
      kind: "rejected";
      reason: "invalid-command" | "invalid-scope";
    };

export type CanvasAgentUiCommandContext = {
  armProgrammaticViewport: (viewport: Viewport) => CanvasAgentViewportSuppressionToken;
  signal: AbortSignal;
};

export type CanvasAgentUiPort = {
  getBoardRevision: () => number;
  getCanvasStateRevision: () => number;
  hasScreenReference: (reference: CanvasScreenReference) => boolean;
  navigateCanvas: (
    target: CanvasClientCommand & { kind: "viewport.navigate" },
    context: CanvasAgentUiCommandContext,
  ) => unknown;
  openPreview: (
    target: CanvasScreenReference,
    visualCapabilityId: string,
    context: CanvasAgentUiCommandContext,
  ) => Promise<CanvasVisualCaptureWire>;
  selectScreen: (
    targets: CanvasScreenReference[],
    mode: "replace" | "add" | "remove" | "toggle",
    context: CanvasAgentUiCommandContext,
  ) => unknown;
  waitForBoardRevision?: (revision: number, signal: AbortSignal) => Promise<number>;
  waitForCanvasStateRevision?: (revision: number, signal: AbortSignal) => Promise<number>;
};

export type ScopedCanvasAgentDispatcherOptions = {
  initialScope: CanvasAgentCommandScope;
  ledgerCapacity?: number;
  ui: CanvasAgentUiPort;
};

type AckedToolName = CanvasClientCommand["toolName"];

type CanvasAgentLedgerEntry = {
  command: CanvasClientCommand;
  fingerprint: string;
  outcome: Promise<CanvasAgentDispatchOutcome>;
};

export class ScopedCanvasAgentClientCommandDispatcher {
  readonly #ledger: BoundedLruLedger<CanvasAgentLedgerEntry>;
  readonly #suppression = new CanvasAgentViewportMoveSuppression();
  readonly #ui: CanvasAgentUiPort;
  #abortController = new AbortController();
  #scope: CanvasAgentCommandScope;
  #disposed = false;

  constructor(options: ScopedCanvasAgentDispatcherOptions) {
    this.#scope = cloneScope(options.initialScope);
    this.#ui = options.ui;
    this.#ledger = new BoundedLruLedger(options.ledgerCapacity ?? 256);
  }

  get scope(): CanvasAgentCommandScope {
    return cloneScope(this.#scope);
  }

  replaceScope(nextScope: CanvasAgentCommandScope): void {
    if (sameScope(this.#scope, nextScope)) return;
    this.#abortController.abort();
    this.#abortController = new AbortController();
    this.#suppression.cancel();
    this.#ledger.clear();
    this.#scope = cloneScope(nextScope);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortController.abort();
    this.#suppression.cancel();
    this.#ledger.clear();
  }

  consumeViewportMoveEnd(viewport: Viewport): boolean {
    return this.#suppression.consumeIfMatches(viewport);
  }

  cancelViewportMoveForUserGesture(): void {
    this.#suppression.cancel();
  }

  dispatch(input: ScopedCanvasAgentClientCommand): Promise<CanvasAgentDispatchOutcome> {
    const parsedScope = parseScope(input?.scope);
    const parsedCommand = canvasClientCommandSchema.safeParse(input?.command);
    if (!parsedScope) return Promise.resolve({ kind: "rejected", reason: "invalid-scope" });
    if (!parsedCommand.success) return Promise.resolve({ kind: "rejected", reason: "invalid-command" });

    const command = parsedCommand.data;
    if (!sameScope(parsedScope, this.#scope)) {
      return this.#safeExecute(parsedScope, command);
    }
    const key = `${command.agentSessionId}\u0000${command.toolCallId}`;
    const cached = this.#ledger.get(key);
    if (cached) {
      if (cached.fingerprint !== commandReplayFingerprint(command)) {
        return Promise.resolve({
          kind: "ack",
          ack: this.#rejectedAck(command, "TOOL_CALL_REPLAY_MISMATCH", false),
        });
      }
      if (sameDispatchCommand(cached.command, command)) return cached.outcome;
      return cached.outcome.then((outcome) => this.#rebindReplayOutcome(outcome, command));
    }

    const work = this.#safeExecute(parsedScope, command);
    this.#ledger.set(key, {
      command,
      fingerprint: commandReplayFingerprint(command),
      outcome: work,
    });
    return work;
  }

  #safeExecute(
    scope: CanvasAgentCommandScope,
    command: CanvasClientCommand,
  ): Promise<CanvasAgentDispatchOutcome> {
    return this.#execute(scope, command).catch((error: unknown) => ({
      kind: "ack" as const,
      ack: this.#rejectedAck(
        command,
        isAbortError(error) ? "PROJECT_SESSION_CHANGED" : "CLIENT_COMMAND_FAILED",
        !isAbortError(error),
      ),
    }));
  }

  #rebindReplayOutcome(
    outcome: CanvasAgentDispatchOutcome,
    command: CanvasClientCommand,
  ): CanvasAgentDispatchOutcome {
    if (outcome.kind !== "ack") return outcome;
    if (outcome.ack.status === "applied") {
      return {
        kind: "ack",
        ack: this.#appliedAck(command, outcome.ack.result),
        visualCapture: outcome.visualCapture ?? null,
      };
    }
    return {
      kind: "ack",
      ack: this.#rejectedAck(
        command,
        outcome.ack.failure.code,
        outcome.ack.failure.retryable,
      ),
    };
  }

  async #execute(
    incomingScope: CanvasAgentCommandScope,
    command: CanvasClientCommand,
  ): Promise<CanvasAgentDispatchOutcome> {
    const signal = this.#abortController.signal;
    if (this.#disposed || signal.aborted) {
      return { kind: "ack", ack: this.#rejectedAck(command, "PROJECT_SESSION_CHANGED", false) };
    }
    if (!sameScope(incomingScope, this.#scope) || !commandBelongsToScope(command, incomingScope)) {
      return { kind: "ack", ack: this.#rejectedAck(command, "COMMAND_SCOPE_MISMATCH", false) };
    }
    const boardRevision = await this.#resolveRevision(
      command.boardRevision,
      this.#ui.getBoardRevision,
      this.#ui.waitForBoardRevision,
      signal,
    );
    if (boardRevision.disposition === "stale") {
      return { kind: "ack", ack: this.#rejectedAck(command, "STALE_BOARD_REVISION", false) };
    }
    if (boardRevision.disposition !== "current") {
      return { kind: "ack", ack: this.#rejectedAck(command, "BOARD_REVISION_UNAVAILABLE", true) };
    }

    const canvasStateRevision = await this.#resolveRevision(
      command.expectedCanvasStateRevision,
      this.#ui.getCanvasStateRevision,
      this.#ui.waitForCanvasStateRevision,
      signal,
    );
    if (canvasStateRevision.disposition === "stale") {
      return { kind: "ack", ack: this.#rejectedAck(command, "STALE_CANVAS_STATE_REVISION", false) };
    }
    if (canvasStateRevision.disposition !== "current") {
      return { kind: "ack", ack: this.#rejectedAck(command, "CANVAS_STATE_REVISION_UNAVAILABLE", true) };
    }

    if (!sameScope(incomingScope, this.#scope) || signal.aborted) {
      return { kind: "ack", ack: this.#rejectedAck(command, "PROJECT_SESSION_CHANGED", false) };
    }

    try {
      const context: CanvasAgentUiCommandContext = {
        armProgrammaticViewport: (viewport) => this.#suppression.arm(viewport),
        signal,
      };
      const result = await this.#executeUiCommand(command, context);
      if (!sameScope(incomingScope, this.#scope) || signal.aborted) {
        return { kind: "ack", ack: this.#rejectedAck(command, "PROJECT_SESSION_CHANGED", false) };
      }
      return {
        kind: "ack",
        ack: this.#appliedAck(command, result.result),
        visualCapture: result.visualCapture,
      };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return { kind: "ack", ack: this.#rejectedAck(command, "PROJECT_SESSION_CHANGED", false) };
      }
      if (error instanceof CanvasAgentCommandError) {
        return {
          kind: "ack",
          ack: this.#rejectedAck(command, error.code, error.code === "SCREEN_NOT_FOUND"),
        };
      }
      return { kind: "ack", ack: this.#rejectedAck(command, "CLIENT_COMMAND_FAILED", true) };
    }
  }

  async #executeUiCommand(
    command: CanvasClientCommand,
    context: CanvasAgentUiCommandContext,
  ): Promise<{ result: unknown; visualCapture: CanvasVisualCaptureWire | null }> {
    if (command.kind === "preview.open") {
      if (!this.#ui.hasScreenReference(command.target)) {
        throw new CanvasAgentCommandError("SCREEN_NOT_FOUND");
      }
      const visualCapture = await this.#ui.openPreview(
        command.target,
        command.view.visualCapabilityId,
        context,
      );
      if (visualCapture.visualCapabilityId !== command.view.visualCapabilityId) {
        throw new CanvasAgentCommandError("VISUAL_CAPTURE_MISMATCH");
      }
      return { result: { view: command.view }, visualCapture };
    }
    if (command.kind === "selection.change") {
      if (command.targets.some((target) => !this.#ui.hasScreenReference(target))) {
        throw new CanvasAgentCommandError("SCREEN_NOT_FOUND");
      }
      return {
        result: await this.#ui.selectScreen(command.targets, command.mode, context),
        visualCapture: null,
      };
    }
    if (command.target.kind === "screen" && !this.#ui.hasScreenReference(command.target.screen)) {
      throw new CanvasAgentCommandError("SCREEN_NOT_FOUND");
    }
    return {
      result: await this.#ui.navigateCanvas(command, context),
      visualCapture: null,
    };
  }

  #appliedAck(command: CanvasClientCommand, result: unknown): CanvasClientCommandAck {
    const currentCanvasStateRevision = normalizeRevision(
      this.#ui.getCanvasStateRevision(),
      command.expectedCanvasStateRevision,
    );
    return canvasClientCommandAckSchema.parse({
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
      canvasStateRevision: currentCanvasStateRevision,
      acknowledgedAt: new Date().toISOString(),
      status: "applied",
      result: toJsonValue(result),
      failure: null,
    });
  }

  #rejectedAck(
    command: CanvasClientCommand,
    code: string,
    retryable: boolean,
  ): CanvasClientCommandAck {
    return canvasClientCommandAckSchema.parse({
      protocol: "workbench.canvas-client-command-ack.v1",
      commandId: command.commandId,
      agentSessionId: command.agentSessionId,
      toolCallId: command.toolCallId,
      requestId: command.requestId,
      toolName: command.toolName as AckedToolName,
      projectId: command.projectId,
      threadId: command.threadId,
      runId: command.runId,
      boardId: command.boardId,
      clientSessionId: command.clientSessionId,
      projectSessionGeneration: command.projectSessionGeneration,
      boardRevision: command.boardRevision,
      canvasStateRevision: normalizeRevision(
        this.#ui.getCanvasStateRevision(),
        command.expectedCanvasStateRevision,
      ),
      acknowledgedAt: new Date().toISOString(),
      status: "rejected",
      result: null,
      failure: {
        code,
        message: failureMessage(code),
        retryable,
      },
    });
  }

  async #resolveRevision(
    expected: number,
    currentRevision: () => number,
    waitForRevision: ((revision: number, signal: AbortSignal) => Promise<number>) | undefined,
    signal: AbortSignal,
  ): Promise<{ disposition: "current" | "future" | "stale"; revision: number }> {
    let current = normalizeRevision(currentRevision(), 0);
    let disposition = canvasAgentRevisionDisposition(expected, current);
    if (disposition === "future" && waitForRevision) {
      current = normalizeRevision(await waitForRevision(expected, signal), current);
      disposition = canvasAgentRevisionDisposition(expected, current);
    }
    return { disposition, revision: current };
  }
}

class CanvasAgentCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function parseScope(value: unknown): CanvasAgentCommandScope | null {
  if (!isRecord(value)) return null;
  const scope = {
    boardId: value.boardId,
    clientSessionId: value.clientSessionId,
    projectId: value.projectId,
    projectSessionGeneration: value.projectSessionGeneration,
    runId: value.runId,
    threadId: value.threadId,
  };
  if (
    !isId(scope.boardId)
    || !isId(scope.clientSessionId)
    || !isId(scope.projectId)
    || !isId(scope.threadId)
    || !(scope.runId === null || isId(scope.runId))
    || typeof scope.projectSessionGeneration !== "number"
    || !Number.isInteger(scope.projectSessionGeneration)
    || scope.projectSessionGeneration <= 0
  ) return null;
  return scope as CanvasAgentCommandScope;
}

function commandBelongsToScope(
  command: CanvasClientCommand,
  scope: CanvasAgentCommandScope,
): boolean {
  return command.projectId === scope.projectId
    && command.boardId === scope.boardId
    && command.clientSessionId === scope.clientSessionId
    && command.projectSessionGeneration === scope.projectSessionGeneration
    && command.threadId === scope.threadId
    && command.runId === scope.runId;
}

function sameScope(left: CanvasAgentCommandScope, right: CanvasAgentCommandScope): boolean {
  return left.boardId === right.boardId
    && left.clientSessionId === right.clientSessionId
    && left.projectId === right.projectId
    && left.projectSessionGeneration === right.projectSessionGeneration
    && left.runId === right.runId
    && left.threadId === right.threadId;
}

function cloneScope(scope: CanvasAgentCommandScope): CanvasAgentCommandScope {
  return { ...scope };
}

function normalizeRevision(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return {};
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? {} : JSON.parse(serialized) as unknown;
  } catch {
    return {};
  }
}

function commandReplayFingerprint(command: CanvasClientCommand): string {
  const {
    commandId: _commandId,
    expiresAt: _expiresAt,
    issuedAt: _issuedAt,
    requestId: _requestId,
    ...stable
  } = command;
  return JSON.stringify(stable);
}

function sameDispatchCommand(left: CanvasClientCommand, right: CanvasClientCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function failureMessage(code: string): string {
  switch (code) {
    case "PROJECT_SESSION_CHANGED": return "The project session changed before this command completed.";
    case "COMMAND_SCOPE_MISMATCH": return "The command scope does not match the active Canvas Agent session.";
    case "STALE_BOARD_REVISION": return "The command targets an older Board revision.";
    case "BOARD_REVISION_UNAVAILABLE": return "The requested Board revision is not available.";
    case "STALE_CANVAS_STATE_REVISION": return "The command targets an older Canvas state revision.";
    case "CANVAS_STATE_REVISION_UNAVAILABLE": return "The requested Canvas state revision is not available.";
    case "SCREEN_NOT_FOUND": return "The requested screen is no longer present in this project.";
    case "VISUAL_CAPTURE_MISMATCH": return "The visual capture was not bound to the requested Canvas capability.";
    case "COMMAND_EXPIRED": return "The Canvas command has expired.";
    case "TOOL_CALL_REPLAY_MISMATCH": return "The tool call was replayed with different command parameters.";
    case "CLIENT_COMMAND_FAILED": return "The Canvas command could not be applied.";
    default: return "The Canvas command was rejected.";
  }
}
