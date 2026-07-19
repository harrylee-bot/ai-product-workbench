import { runEventSchema, type RunEvent } from "@workbench/workbench-contracts";
import { createParser, type EventSourceMessage, type ParseError } from "eventsource-parser";

import {
  getWorkbenchApiBaseUrl,
  normalizeWorkbenchApiBaseUrl,
  stripTrailingSlash,
} from "../api/config";
import {
  isWorkbenchApiError,
  throwForWorkbenchResponse,
} from "../api/problem-details";
import { createWorkbenchFetch } from "../api/request-fetch";
import { RunProtocolError } from "./protocol-error";

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;
const MAX_SSE_BUFFER_SIZE = 1_048_576;

type TerminalRunEvent = Extract<
  RunEvent,
  { type: "run.completed" | "run.failed" | "run.cancelled" }
>;

export type RunStreamState = "connecting" | "open" | "reconnecting" | "closed";

export type RunStreamResult = {
  lastSequence: number;
  terminalEvent: TerminalRunEvent;
};

export type SubscribeRunEventsOptions = {
  runId: string;
  afterSequence?: number;
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
  signal?: AbortSignal;
  onEvent: (event: RunEvent) => void;
  onStateChange?: (state: RunStreamState) => void;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  jitterRatio?: number;
};

export type ReadRunEventStreamOptions = Pick<
  SubscribeRunEventsOptions,
  "runId" | "afterSequence" | "baseUrl" | "fetch" | "signal" | "onEvent"
> & {
  onOpen?: () => void;
};

type StreamReadResult = {
  lastSequence: number;
  terminalEvent: TerminalRunEvent | null;
  retryDelayMs: number | null;
};

export async function subscribeRunEvents({
  runId,
  afterSequence = 0,
  baseUrl = getWorkbenchApiBaseUrl(),
  fetch,
  signal,
  onEvent,
  onStateChange,
  maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  jitterRatio = 0.2,
}: SubscribeRunEventsOptions): Promise<RunStreamResult> {
  assertCursor(afterSequence);
  if (!Number.isSafeInteger(maxReconnectAttempts) || maxReconnectAttempts < 0) {
    throw new RangeError("maxReconnectAttempts must be a non-negative safe integer");
  }

  let cursor = afterSequence;
  let consecutiveFailures = 0;
  let state: RunStreamState = "connecting";
  onStateChange?.(state);

  while (true) {
    throwIfAborted(signal);
    let receivedOnConnection = 0;

    try {
      const result = await readRunEventStream({
        runId,
        afterSequence: cursor,
        baseUrl,
        fetch,
        signal,
        onOpen() {
          state = "open";
          onStateChange?.(state);
        },
        onEvent(event) {
          try {
            onEvent(event);
          } catch (error) {
            throw new RunEventHandlerError(event, { cause: error });
          }
          cursor = event.sequence;
          receivedOnConnection += 1;
        },
      });
      cursor = result.lastSequence;
      if (result.terminalEvent) {
        onStateChange?.("closed");
        return { lastSequence: cursor, terminalEvent: result.terminalEvent };
      }

      consecutiveFailures = receivedOnConnection > 0 ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures > maxReconnectAttempts) {
        throw new RunStreamDisconnectedError(runId, cursor);
      }

      state = "reconnecting";
      onStateChange?.(state);
      await abortableDelay(
        withJitter(
          result.retryDelayMs ?? backoffDelay(reconnectDelayMs, consecutiveFailures),
          jitterRatio,
        ),
        signal,
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      if (!isRetryableStreamError(error)) throw error;

      consecutiveFailures = receivedOnConnection > 0 ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures > maxReconnectAttempts) {
        throw new RunStreamDisconnectedError(runId, cursor, { cause: error });
      }

      state = "reconnecting";
      onStateChange?.(state);
      const retryAfterMs = isWorkbenchApiError(error) ? error.retryAfterMs : null;
      await abortableDelay(
        withJitter(
          retryAfterMs ?? backoffDelay(reconnectDelayMs, consecutiveFailures),
          jitterRatio,
        ),
        signal,
      );
    }

    if (state === "reconnecting") {
      state = "connecting";
      onStateChange?.(state);
    }
  }
}

export async function readRunEventStream({
  runId,
  afterSequence = 0,
  baseUrl = getWorkbenchApiBaseUrl(),
  fetch,
  signal,
  onEvent,
  onOpen,
}: ReadRunEventStreamOptions): Promise<StreamReadResult> {
  assertCursor(afterSequence);
  throwIfAborted(signal);

  const url = buildRunEventsUrl(baseUrl, runId, afterSequence);
  const headers = new Headers({
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  });
  if (afterSequence > 0) headers.set("Last-Event-ID", String(afterSequence));

  const workbenchFetch = createWorkbenchFetch({ fetch });
  const response = await workbenchFetch(new Request(url, {
    method: "GET",
    headers,
    credentials: "same-origin",
    signal,
  }));
  await throwForWorkbenchResponse(response);

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    throw new RunProtocolError(`Run stream returned unexpected content type: ${contentType || "missing"}`);
  }
  if (!response.body) throw new RunProtocolError("Run stream response has no body");
  onOpen?.();

  let cursor = afterSequence;
  let terminalEvent: TerminalRunEvent | null = null;
  let retryDelayMs: number | null = null;
  let parseFailure: RunProtocolError | null = null;
  const decoder = new TextDecoder();
  const parser = createParser({
    maxBufferSize: MAX_SSE_BUFFER_SIZE,
    onRetry(value) {
      retryDelayMs = Math.min(Math.max(value, 0), MAX_RECONNECT_DELAY_MS);
    },
    onError(error) {
      parseFailure ??= parserError(error);
    },
    onEvent(message) {
      const event = parseRunEvent(message, runId);
      if (terminalEvent) {
        throw new RunProtocolError(
          `Run stream emitted ${event.type} after terminal event ${terminalEvent.type}`,
        );
      }
      if (event.sequence <= cursor) return;
      if (event.sequence !== cursor + 1) {
        throw new RunProtocolError(
          `Run event sequence gap: expected ${cursor + 1}, received ${event.sequence}`,
        );
      }
      cursor = event.sequence;
      onEvent(event);
      if (isTerminalEvent(event)) terminalEvent = event;
    },
  });

  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (parseFailure) throw parseFailure;
    }
    parser.feed(decoder.decode());
    parser.reset({ consume: true });
    if (parseFailure) throw parseFailure;
  } finally {
    reader.releaseLock();
  }

  return { lastSequence: cursor, terminalEvent, retryDelayMs };
}

export class RunStreamDisconnectedError extends Error {
  readonly runId: string;
  readonly lastSequence: number;

  constructor(runId: string, lastSequence: number, options?: { cause?: unknown }) {
    super(
      `Run ${runId} event stream disconnected after sequence ${lastSequence}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RunStreamDisconnectedError";
    this.runId = runId;
    this.lastSequence = lastSequence;
  }
}

export class RunEventHandlerError extends Error {
  readonly event: RunEvent;

  constructor(event: RunEvent, options?: { cause?: unknown }) {
    super(
      `Run event handler failed at sequence ${event.sequence}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RunEventHandlerError";
    this.event = event;
  }
}

function parseRunEvent(message: EventSourceMessage, expectedRunId: string): RunEvent {
  let json: unknown;
  try {
    json = JSON.parse(message.data) as unknown;
  } catch (error) {
    throw new RunProtocolError("Run stream contained invalid JSON", { cause: error });
  }

  const parsed = runEventSchema.safeParse(json);
  if (!parsed.success) {
    throw new RunProtocolError(`Run stream event failed schema validation: ${parsed.error.message}`);
  }

  const event = parsed.data;
  if (event.runId !== expectedRunId) {
    throw new RunProtocolError(`Run stream returned event for ${event.runId}; expected ${expectedRunId}`);
  }
  if (message.id !== String(event.sequence)) {
    throw new RunProtocolError(
      `Run stream event id ${message.id ?? "missing"} does not match sequence ${event.sequence}`,
    );
  }
  if (message.event !== event.type) {
    throw new RunProtocolError(
      `Run stream event type ${message.event ?? "missing"} does not match payload type ${event.type}`,
    );
  }
  return event;
}

function buildRunEventsUrl(baseUrl: string, runId: string, afterSequence: number): URL {
  const normalizedBase = normalizeWorkbenchApiBaseUrl(baseUrl);
  const absoluteBase = /^https?:\/\//i.test(normalizedBase)
    ? normalizedBase
    : typeof window !== "undefined"
      ? new URL(normalizedBase, window.location.origin).toString()
      : null;
  if (!absoluteBase) {
    throw new RunProtocolError("An absolute Workbench API base URL is required outside the browser");
  }

  const url = new URL(`${stripTrailingSlash(absoluteBase)}/runs/${encodeURIComponent(runId)}/events`);
  url.searchParams.set("afterSequence", String(afterSequence));
  return url;
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("afterSequence must be a non-negative safe integer");
  }
}

function isTerminalEvent(event: RunEvent): event is TerminalRunEvent {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
}

function isRetryableStreamError(error: unknown): boolean {
  if (
    error instanceof RunProtocolError
    || error instanceof RunStreamDisconnectedError
    || error instanceof RunEventHandlerError
  ) return false;
  if (isWorkbenchApiError(error)) return error.retryable;
  return true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });

    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }

    function abort() {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError"));
    }
  });
}

function backoffDelay(baseDelay: number, failureCount: number): number {
  return Math.min(Math.max(baseDelay, 0) * (2 ** Math.max(0, failureCount - 1)), MAX_RECONNECT_DELAY_MS);
}

function withJitter(milliseconds: number, ratio: number): number {
  if (milliseconds <= 0 || ratio <= 0) return milliseconds;
  const boundedRatio = Math.min(ratio, 1);
  return Math.round(milliseconds * (1 - boundedRatio + Math.random() * boundedRatio * 2));
}

function parserError(error: ParseError): RunProtocolError {
  return new RunProtocolError(`Run stream SSE parse error: ${error.type}`);
}
