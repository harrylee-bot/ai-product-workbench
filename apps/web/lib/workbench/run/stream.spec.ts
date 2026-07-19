import { runEventSchema, type RunEvent } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { RunProtocolError } from "./protocol-error";
import { readRunEventStream, RunEventHandlerError, subscribeRunEvents } from "./stream";

describe("Run SSE stream", () => {
  it("authenticates, parses split frames, and reconnects from the durable cursor", async () => {
    const queued = event(1, "run.queued", { position: null });
    const completed = event(2, "run.completed", { artifactCount: 0 });
    const requests: Request[] = [];
    const responses = [
      sseResponse(splitIntoChunks(`: heartbeat\n\n${serialize(queued)}`, 7)),
      sseResponse(splitIntoChunks(serialize(completed), 11)),
    ];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected reconnect");
      return response;
    });
    const received: RunEvent[] = [];
    const states: string[] = [];

    const result = await subscribeRunEvents({
      runId: "run-1",
      baseUrl: "http://workbench.test/api/v1",
      fetch,
      reconnectDelayMs: 0,
      jitterRatio: 0,
      onEvent: (value) => received.push(value),
      onStateChange: (state) => states.push(state),
    });

    expect(result).toEqual({ lastSequence: 2, terminalEvent: completed });
    expect(received).toEqual([queued, completed]);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).searchParams.get("afterSequence")).toBe("0");
    expect(new URL(requests[1].url).searchParams.get("afterSequence")).toBe("1");
    expect(requests[0].credentials).toBe("same-origin");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[1].headers.get("last-event-id")).toBe("1");
    expect(states).toEqual([
      "connecting",
      "open",
      "reconnecting",
      "connecting",
      "open",
      "closed",
    ]);
  });

  it("rejects a sequence gap instead of presenting incomplete state", async () => {
    const request = readRunEventStream({
      runId: "run-1",
      baseUrl: "http://workbench.test/api/v1",
      fetch: async () => sseResponse([serialize(event(2, "run.started", { attempt: 1 }))]),
      onEvent: () => undefined,
    });

    await expect(request).rejects.toThrowError(RunProtocolError);
  });

  it("surfaces RFC 9457 responses without retrying non-retryable status codes", async () => {
    const request = subscribeRunEvents({
      runId: "run-1",
      baseUrl: "http://workbench.test/api/v1",
      fetch: async () => new Response(JSON.stringify({
        type: "about:blank",
        title: "Not found",
        status: 404,
        code: "RUN_NOT_FOUND",
      }), {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      }),
      reconnectDelayMs: 0,
      jitterRatio: 0,
      onEvent: () => undefined,
    });

    await expect(request).rejects.toMatchObject({
      status: 404,
      code: "RUN_NOT_FOUND",
    });
  });

  it("does not reconnect past an event rejected by the state consumer", async () => {
    const fetch = vi.fn(async () => sseResponse([
      serialize(event(1, "run.queued", { position: null })),
    ]));
    const consumerError = new Error("Reducer invariant failed");
    const request = subscribeRunEvents({
      runId: "run-1",
      baseUrl: "http://workbench.test/api/v1",
      fetch,
      reconnectDelayMs: 0,
      jitterRatio: 0,
      onEvent: () => {
        throw consumerError;
      },
    });

    await expect(request).rejects.toMatchObject({
      name: "RunEventHandlerError",
      cause: consumerError,
    } satisfies Partial<RunEventHandlerError>);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return runEventSchema.parse({
    protocol: "workbench.run.v1",
    id: `event-${sequence}`,
    projectId: "project-1",
    threadId: "thread-1",
    runId: "run-1",
    requestId: "request-1",
    sequence,
    occurredAt: "2026-07-12T00:00:00.000Z",
    traceId: "trace-1",
    type,
    payload,
  });
}

function serialize(value: RunEvent): string {
  return `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function splitIntoChunks(value: string, size: number): string[] {
  return Array.from({ length: Math.ceil(value.length / size) }, (_, index) =>
    value.slice(index * size, (index + 1) * size));
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}
