import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { ClamAvScanAdapter } from "@workbench/workbench-content-security";

const maximumUploadByteSize = 25 * 1024 ** 2;
const versionResponse = "ClamAV 1.4.3/27806/Sun Jul 12 12:00:00 2026\0";

describe("ClamAvScanAdapter", () => {
  it.each([
    ["stream: OK\0", "clean", { verdict: "clean" }],
    ["stream: Eicar-Test-Signature FOUND\0", "infected", { verdict: "infected", signature: "Eicar-Test-Signature" }],
  ] as const)("records strict VERSION and INSTREAM terminal evidence", async (response, status, evidence) => {
    const received: Buffer[] = [];
    const server = await scannerServer(response, received);
    try {
      const adapter = adapterFor(server);
      const result = await adapter.scan({
        body: Readable.from([Buffer.from("hello"), Buffer.from(" world")]),
        byteSize: 11,
        sha256: "a".repeat(64),
        mediaType: "text/plain",
      });

      expect(result).toMatchObject({
        status,
        scanner: "clamav",
        scannerVersion: "1.4.3",
        signatureVersion: "27806",
        evidence: {
          ...evidence,
          protocol: "clamav.instream.v1",
          engineVersion: "1.4.3",
          signatureVersion: "27806",
          signatureUpdatedAt: "2026-07-12T12:00:00.000Z",
          streamedBytes: 11,
        },
      });
      const protocol = Buffer.concat(received);
      expect(protocol.includes(Buffer.from("zVERSION\0"))).toBe(true);
      expect(protocol.includes(Buffer.from("zINSTREAM\0"))).toBe(true);
      expect(protocol.includes(Buffer.from("hello"))).toBe(true);
      expect(protocol.includes(Buffer.from(" world"))).toBe(true);
    } finally {
      await close(server);
    }
  });

  it("throws a retryable infrastructure error when the scanner cannot connect", async () => {
    const adapter = new ClamAvScanAdapter("127.0.0.1", 1, 100, maximumUploadByteSize);
    await expect(adapter.scan(input())).rejects.toMatchObject({
      code: "SCANNER_UNAVAILABLE",
      safeDetail: "Malware scanner is unavailable",
    });
  });

  it("distinguishes a scanner response timeout from a connection failure", async () => {
    const server = trackedServer(() => undefined);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    try {
      const adapter = new ClamAvScanAdapter(
        "127.0.0.1",
        address.port,
        25,
        maximumUploadByteSize,
      );
      await expect(adapter.scan(input())).rejects.toMatchObject({
        code: "SCANNER_TIMEOUT",
        safeDetail: "Malware scanner timed out",
      });
    } finally {
      await close(server);
    }
  });

  it("rejects an invalid VERSION response before streaming bytes", async () => {
    const server = await scannerServer("stream: OK\0", [], "not-clamav\0");
    try {
      await expect(adapterFor(server).scan(input())).rejects.toMatchObject({
        code: "SCANNER_VERSION_INVALID",
      });
    } finally {
      await close(server);
    }
  });

  it("fails readiness and scanning when ClamAV signatures are stale", async () => {
    const server = await scannerServer(
      "stream: OK\0",
      [],
      "ClamAV 1.4.3/27700/Mon Jun 1 00:00:00 2026\0",
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    try {
      const adapter = new ClamAvScanAdapter(
        "127.0.0.1",
        address.port,
        2_000,
        maximumUploadByteSize,
        48 * 60 * 60_000,
        undefined,
        () => new Date("2026-07-15T00:00:00.000Z"),
      );
      await expect(adapter.assertReady(maximumUploadByteSize)).rejects.toMatchObject({
        code: "SCANNER_SIGNATURES_STALE",
      });
      await expect(adapter.scan(input())).rejects.toMatchObject({
        code: "SCANNER_SIGNATURES_STALE",
      });
    } finally {
      await close(server);
    }
  });

  it("fails readiness when the declared stream limit is below the product ceiling", async () => {
    const adapter = new ClamAvScanAdapter("127.0.0.1", 1, 100, 4);
    await expect(adapter.assertReady(maximumUploadByteSize)).rejects.toMatchObject({
      code: "SCANNER_STREAM_LIMIT_MISMATCH",
    });
  });

  it("rejects an incomplete NUL-delimited response", async () => {
    const server = await scannerServer("stream: OK", []);
    try {
      await expect(adapterFor(server).scan(input())).rejects.toMatchObject({
        code: "SCANNER_RESPONSE_INCOMPLETE",
      });
    } finally {
      await close(server);
    }
  });

  it("maps clamd StreamMaxLength rejection to retryable configuration failure", async () => {
    const server = await scannerServer("INSTREAM size limit exceeded. ERROR\0", []);
    try {
      await expect(adapterFor(server).scan(input())).rejects.toMatchObject({
        code: "SCANNER_STREAM_LIMIT_MISMATCH",
      });
    } finally {
      await close(server);
    }
  });

  it("fails before connecting when product bytes exceed the declared scanner limit", async () => {
    const adapter = new ClamAvScanAdapter("127.0.0.1", 1, 100, 4);
    await expect(adapter.scan(input())).rejects.toMatchObject({ code: "SCANNER_STREAM_LIMIT_MISMATCH" });
  });

  it("propagates AbortSignal as a retryable interruption instead of a clean/failed verdict", async () => {
    const server = trackedServer(() => undefined);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controller = new AbortController();
    try {
      const pending = adapterFor(server).scan({ ...input(), signal: controller.signal });
      setTimeout(() => controller.abort(new Error("shutdown")), 10);
      await expect(pending).rejects.toMatchObject({ code: "SCANNER_ABORTED" });
    } finally {
      await close(server);
    }
  });
});

function input() {
  return {
    body: Readable.from([Buffer.from("hello")]),
    byteSize: 5,
    sha256: "a".repeat(64),
    mediaType: "text/plain",
  };
}

function adapterFor(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return new ClamAvScanAdapter("127.0.0.1", address.port, 2_000, maximumUploadByteSize);
}

async function scannerServer(
  scanResponse: string,
  received: Buffer[],
  scannerVersionResponse = versionResponse,
) {
  const server = trackedServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      received.push(Buffer.from(chunk));
      const all = Buffer.concat(chunks);
      if (all.subarray(0, 8).toString() === "zVERSION" && all.includes(0)) {
        socket.end(scannerVersionResponse);
        return;
      }
      if (all.subarray(0, 9).toString() === "zINSTREAM" && all.byteLength >= 14
        && all.subarray(-4).equals(Buffer.alloc(4))) {
        socket.end(scanResponse);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function close(server: Server) {
  for (const socket of trackedSockets.get(server) ?? []) socket.destroy();
  server.close();
  await once(server, "close");
}

const trackedSockets = new WeakMap<Server, Set<Socket>>();

function trackedServer(handler: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handler(socket);
  });
  trackedSockets.set(server, sockets);
  return server;
}
