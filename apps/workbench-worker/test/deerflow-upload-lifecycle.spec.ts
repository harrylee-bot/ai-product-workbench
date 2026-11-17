import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeerFlowRuntimeAdapter } from "../src/runtime/deerflow-runtime.adapter.js";
import type { RuntimeContentLocator } from "../src/runtime/runtime.port.js";

const bytes = Buffer.from("Real HTTP upload lifecycle fixture");
const locator: RuntimeContentLocator = {
  storageKey: "fixture",
  mediaType: "text/plain",
  byteSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const handle = { virtualPath: "/mnt/user-data/uploads/fixture.txt", markdownVirtualPath: null };
const responseText = JSON.stringify({ files: [{ virtual_path: handle.virtualPath }] });
type UploadPort = {
  uploadContent(
    threadId: string,
    ownerId: string,
    fileName: string,
    locator: RuntimeContentLocator,
    signal?: AbortSignal,
  ): Promise<unknown>;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded<T>(operation: Promise<T>, ms = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("HTTP_FIXTURE_DEADLINE")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("DeerFlow upload HTTP lifecycle", () => {
  it.each([
    { phase: "response", mode: "caller-abort" },
    { phase: "response", mode: "request-timeout" },
    { phase: "upload", mode: "caller-abort" },
    { phase: "upload", mode: "request-timeout" },
  ])(
    "closes stalled $phase resources after $mode",
    async ({ phase, mode }) => {
      const accepted = deferred(),
        headers = deferred(),
        closed = deferred();
      let response: ServerResponse | undefined;
      const server = await listen((request, reply) => {
        response = reply;
        reply.once("close", closed.resolve);
        request.on("error", () => undefined);
        request.resume();
        accepted.resolve();
        const begin = () => {
          reply.writeHead(200, { "content-type": "application/json" });
          reply.write('{"files":[');
        };
        if (phase === "response") request.once("end", begin);
        else begin();
      });
      const nativeFetch = globalThis.fetch;
      let transportSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        transportSignal = init?.signal ?? undefined;
        const result = await nativeFetch(input, init);
        headers.resolve();
        return result;
      });
      let emitted = false;
      const source =
        phase === "response"
          ? Readable.from([bytes])
          : new Readable({
              read() {
                if (!emitted) {
                  emitted = true;
                  this.push(bytes.subarray(0, 4));
                }
              },
            });
      const controller = new AbortController();
      const adapter = new DeerFlowRuntimeAdapter(
        {
          deerFlowGatewayUrl: server.url,
          deerFlowTimeoutMs: mode === "request-timeout" ? 80 : 3000,
        } as never,
        { getObject: async () => ({ body: source, byteSize: bytes.length }) },
      );
      const operation = (adapter as unknown as UploadPort)
        .uploadContent("fixture-thread", "fixture-owner", "fixture.txt", locator, controller.signal)
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
      try {
        await bounded(phase === "response" ? headers.promise : accepted.promise);
        await delay(0); // Let the actual response reader await its next chunk.
        if (mode === "caller-abort") controller.abort(new Error("CALLER_CANCELLED"));
        const outcome = await bounded(operation);
        expect(outcome.value).toBeNull();
        expect(outcome.error).toBeInstanceOf(Error);
        expect(transportSignal?.aborted).toBe(true);
        expect(source.destroyed).toBe(true);
        await bounded(closed.promise);
        expect(response?.destroyed).toBe(true);
      } finally {
        controller.abort();
        source.destroy();
        response?.destroy();
        await server.close();
        await bounded(operation);
      }
    },
    5000,
  );
  it("accepts a complete verified upload and releases its deadline and streams", async () => {
    const nativeFetch = globalThis.fetch;
    let transportSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      transportSignal = init?.signal ?? undefined;
      return nativeFetch(input, init);
    });
    const server = await listen((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(responseText);
      });
    });
    const source = Readable.from([bytes]),
      controller = new AbortController();
    const adapter = new DeerFlowRuntimeAdapter(
      { deerFlowGatewayUrl: server.url, deerFlowTimeoutMs: 1000 } as never,
      { getObject: async () => ({ body: source, byteSize: bytes.length }) },
    );
    try {
      await expect(
        (adapter as unknown as UploadPort).uploadContent(
          "fixture-thread",
          "fixture-owner",
          "fixture.txt",
          locator,
          controller.signal,
        ),
      ).resolves.toEqual(handle);
      expect(source.destroyed).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      await delay(1100);
      expect(transportSignal?.aborted).toBe(false);
    } finally {
      controller.abort();
      source.destroy();
      await server.close();
    }
  });
});
