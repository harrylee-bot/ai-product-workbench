import type {
  CanvasClientCommand,
  CanvasClientCommandAckRequest,
  CanvasClientStateSyncRequest,
  CanvasClientStateSyncResponse,
} from "@workbench/workbench-contracts";
import { canvasClientCommandAckRequestSchema } from "@workbench/workbench-contracts";
import type { Viewport } from "@xyflow/system";

import {
  type CanvasAgentCommandScope,
  type CanvasAgentDispatchOutcome,
  type CanvasAgentUiPort,
  ScopedCanvasAgentClientCommandDispatcher,
} from "../application/dispatcher";
import type { CanvasAgentCommandTransport } from "./client";

export type CanvasAgentPollingScope = CanvasAgentCommandScope;

export type CanvasAgentCommandPollerOptions = {
  captureState: () => CanvasClientStateSyncRequest | null;
  intervalMs?: number;
  onAcknowledged?: (command: CanvasClientCommand, outcome: CanvasAgentDispatchOutcome) => void;
  onError?: (error: unknown) => void;
  scope: CanvasAgentPollingScope;
  transport: CanvasAgentCommandTransport;
  ui: CanvasAgentUiPort;
};

export class CanvasAgentCommandPoller {
  readonly #intervalMs: number;
  readonly #captureState: CanvasAgentCommandPollerOptions["captureState"];
  readonly #onAcknowledged: CanvasAgentCommandPollerOptions["onAcknowledged"];
  readonly #onError: CanvasAgentCommandPollerOptions["onError"];
  readonly #scope: CanvasAgentPollingScope;
  readonly #transport: CanvasAgentCommandTransport;
  readonly #ui: CanvasAgentUiPort;
  #cursor: string | null = null;
  readonly #dispatcher: ScopedCanvasAgentClientCommandDispatcher;

  constructor(options: CanvasAgentCommandPollerOptions) {
    this.#captureState = options.captureState;
    this.#intervalMs = normalizeInterval(options.intervalMs);
    this.#onAcknowledged = options.onAcknowledged;
    this.#onError = options.onError;
    this.#scope = { ...options.scope };
    this.#transport = options.transport;
    this.#ui = options.ui;
    this.#dispatcher = new ScopedCanvasAgentClientCommandDispatcher({
      initialScope: this.#scope,
      ui: this.#ui,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.drain(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.#onError?.(error);
      }
      if (signal.aborted) break;
      await abortableDelay(this.#intervalMs, signal);
    }
  }

  stop(): void {
    this.#dispatcher.dispose();
  }

  consumeViewportMoveEnd(viewport: Viewport): boolean {
    return this.#dispatcher.consumeViewportMoveEnd(viewport);
  }

  cancelViewportMoveForUserGesture(): void {
    this.#dispatcher.cancelViewportMoveForUserGesture();
  }

  async drain(signal: AbortSignal): Promise<void> {
    const synchronized = await this.#synchronizeState(signal);
    if (!synchronized?.activeSession || signal.aborted) return;
    let cursor = this.#cursor;
    do {
      const page = await this.#transport.list(
        this.#scope.projectId,
        this.#scope.clientSessionId,
        this.#scope.projectSessionGeneration,
        cursor,
        signal,
      );
      for (const command of page.items) {
        if (signal.aborted) return;
        const outcome = await this.#dispatcher.dispatch({ command, scope: this.#scope });
        if (outcome.kind !== "ack") continue;
        const stateAfterDispatch = await this.#synchronizeState(signal);
        if (!stateAfterDispatch?.activeSession || signal.aborted) return;
        const acknowledgedOutcome: CanvasAgentDispatchOutcome = {
          kind: "ack",
          ack: stateAfterDispatch.canvasStateRevision === outcome.ack.canvasStateRevision
            ? outcome.ack
            : {
                ...outcome.ack,
                canvasStateRevision: stateAfterDispatch.canvasStateRevision,
              },
          visualCapture: outcome.visualCapture ?? null,
        };
        const wireAck: CanvasClientCommandAckRequest = canvasClientCommandAckRequestSchema.parse({
          ...acknowledgedOutcome.ack,
          visualCapture: acknowledgedOutcome.visualCapture ?? null,
        });
        await this.#transport.acknowledge(
          this.#scope.projectId,
          command.commandId,
          wireAck,
          signal,
        );
        this.#onAcknowledged?.(command, acknowledgedOutcome);
      }
      cursor = page.nextCursor;
      this.#cursor = cursor;
    } while (cursor && !signal.aborted);
  }

  async #synchronizeState(signal: AbortSignal): Promise<CanvasClientStateSyncResponse | null> {
    const state = this.#captureState();
    if (!state || signal.aborted) return null;
    if (
      state.boardId !== this.#scope.boardId
      || state.clientSessionId !== this.#scope.clientSessionId
      || state.projectSessionGeneration !== this.#scope.projectSessionGeneration
    ) {
      throw new Error("Canvas Agent client state is outside the polling scope");
    }
    const synchronized = await this.#transport.syncState(
      this.#scope.projectId,
      state,
      signal,
    );
    if (
      synchronized.activeSession
      && synchronized.canvasStateRevision !== state.canvasStateRevision
    ) {
      throw new Error("Canvas Agent client state revision was not accepted");
    }
    return synchronized;
  }

}

function normalizeInterval(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 100
    ? Math.min(value, 10_000)
    : 500;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
