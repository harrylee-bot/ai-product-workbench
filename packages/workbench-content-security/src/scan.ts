import { once } from "node:events";
import { createConnection, type Socket } from "node:net";

const MAX_INSTREAM_CHUNK = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const DEFAULT_SIGNATURE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_SIGNATURE_CLOCK_SKEW_MS = 15 * 60_000;

export type ScanBody = AsyncIterable<Uint8Array>;

export type ScanInput = {
  body: ScanBody;
  byteSize: number;
  sha256: string;
  mediaType: string;
  signal?: AbortSignal;
};

export type ScanEvidence = Record<string, string | number | boolean | null>;

export type ScanResult = {
  status: "clean" | "infected";
  scanner: string;
  scannerVersion: string;
  signatureVersion: string | null;
  evidence: ScanEvidence | null;
  startedAt: Date;
  finishedAt: Date;
};

export interface ScanPort {
  scan(input: ScanInput): Promise<ScanResult>;
}

export class RetryableScanError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "RetryableScanError";
  }
}

type Connect = (options: { host: string; port: number }) => Socket;

type ScannerIdentity = {
  engineVersion: string;
  signatureVersion: string;
  signatureUpdatedAt: string;
};

export class ClamAvScanAdapter implements ScanPort {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
    private readonly streamMaxBytes: number,
    private readonly signatureMaxAgeMs: number = DEFAULT_SIGNATURE_MAX_AGE_MS,
    private readonly connect: Connect = createConnection,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async assertReady(requiredStreamBytes: number, signal?: AbortSignal): Promise<ScannerIdentity> {
    this.assertStreamCapacity(requiredStreamBytes);
    return this.version(signal);
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    this.assertStreamCapacity(input.byteSize);
    const startedAt = new Date();
    try {
      const identity = await this.version(input.signal);
      const response = await this.instream(input);
      const finishedAt = new Date();
      if (response === "stream: OK") {
        return terminalResult("clean", identity, input.byteSize, startedAt, finishedAt, null);
      }
      const infected = response.match(/^stream: (\S(?:.*\S)?) FOUND$/);
      if (infected) {
        return terminalResult("infected", identity, input.byteSize, startedAt, finishedAt, infected[1] ?? "unknown");
      }
      if (/\bERROR$/i.test(response)) {
        const code = /size limit exceeded/i.test(response)
          ? "SCANNER_STREAM_LIMIT_MISMATCH"
          : "SCANNER_PROTOCOL_ERROR";
        throw new RetryableScanError(code, "Malware scanner rejected the scan request");
      }
      throw new RetryableScanError("SCANNER_PROTOCOL_ERROR", "Malware scanner returned an invalid response");
    } catch (error) {
      if (error instanceof RetryableScanError) throw error;
      if (input.signal?.aborted) {
        throw new RetryableScanError("SCANNER_ABORTED", "Malware scanning was interrupted", { cause: error });
      }
      if (error instanceof Error && error.message === "CLAMAV_SCAN_TIMEOUT") {
        throw new RetryableScanError("SCANNER_TIMEOUT", "Malware scanner timed out", { cause: error });
      }
      throw new RetryableScanError("SCANNER_UNAVAILABLE", "Malware scanner is unavailable", { cause: error });
    }
  }

  private async version(signal?: AbortSignal): Promise<ScannerIdentity> {
    const response = await this.command(Buffer.from("zVERSION\0"), signal);
    const match = response.match(/^ClamAV ([^/\s]+)\/([0-9]+)\/(\S(?:.*\S)?)$/);
    if (!match) {
      throw new RetryableScanError("SCANNER_VERSION_INVALID", "Malware scanner version response is invalid");
    }
    return {
      engineVersion: match[1] ?? "unknown",
      signatureVersion: match[2] ?? "unknown",
      signatureUpdatedAt: this.parseFreshSignatureTimestamp(match[3] ?? ""),
    };
  }

  private assertStreamCapacity(requiredStreamBytes: number) {
    if (requiredStreamBytes <= this.streamMaxBytes) return;
    throw new RetryableScanError(
      "SCANNER_STREAM_LIMIT_MISMATCH",
      "The malware scanner stream limit is below the product content limit",
    );
  }

  private parseFreshSignatureTimestamp(value: string) {
    const timestamp = Date.parse(`${value} UTC`);
    if (!Number.isFinite(timestamp)) {
      throw new RetryableScanError(
        "SCANNER_SIGNATURE_TIME_INVALID",
        "Malware scanner signature timestamp is invalid",
      );
    }
    const ageMs = this.now().getTime() - timestamp;
    if (ageMs < -MAX_SIGNATURE_CLOCK_SKEW_MS) {
      throw new RetryableScanError(
        "SCANNER_SIGNATURE_TIME_INVALID",
        "Malware scanner signature timestamp is in the future",
      );
    }
    if (ageMs > this.signatureMaxAgeMs) {
      throw new RetryableScanError(
        "SCANNER_SIGNATURES_STALE",
        "Malware scanner signatures are stale",
      );
    }
    return new Date(timestamp).toISOString();
  }

  private async command(command: Buffer, signal?: AbortSignal) {
    const socket = await this.openSocket(signal);
    try {
      await write(socket, command);
      return await readStrictResponse(socket);
    } finally {
      socket.destroy();
    }
  }

  private async instream(input: ScanInput) {
    const socket = await this.openSocket(input.signal);
    let streamedBytes = 0;
    try {
      await write(socket, Buffer.from("zINSTREAM\0"));
      for await (const value of input.body) {
        if (input.signal?.aborted) throw input.signal.reason;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        streamedBytes += chunk.byteLength;
        if (streamedBytes > this.streamMaxBytes || streamedBytes > input.byteSize) {
          throw new RetryableScanError(
            "SCANNER_STREAM_IDENTITY_MISMATCH",
            "The malware scan stream exceeded its trusted byte count",
          );
        }
        for (let offset = 0; offset < chunk.byteLength; offset += MAX_INSTREAM_CHUNK) {
          const part = chunk.subarray(offset, Math.min(offset + MAX_INSTREAM_CHUNK, chunk.byteLength));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(part.byteLength);
          await write(socket, length);
          await write(socket, part);
        }
      }
      if (streamedBytes !== input.byteSize) {
        throw new RetryableScanError(
          "SCANNER_STREAM_IDENTITY_MISMATCH",
          "The malware scan stream did not match its trusted byte count",
        );
      }
      await write(socket, Buffer.alloc(4));
      return await readStrictResponse(socket);
    } finally {
      socket.destroy();
    }
  }

  private async openSocket(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    const socket = this.connect({ host: this.host, port: this.port });
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error("CLAMAV_SCAN_TIMEOUT")));
    const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error("CLAMAV_SCAN_ABORTED"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", abort));
    try {
      await once(socket, "connect");
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
}

export class FailClosedScanAdapter implements ScanPort {
  async scan(input: ScanInput): Promise<ScanResult> {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new RetryableScanError("SCANNER_NOT_CONFIGURED", "Malware scanning is not configured");
  }
}

function terminalResult(
  status: "clean" | "infected",
  identity: ScannerIdentity,
  streamedBytes: number,
  startedAt: Date,
  finishedAt: Date,
  signature: string | null,
): ScanResult {
  return {
    status,
    scanner: "clamav",
    scannerVersion: identity.engineVersion,
    signatureVersion: identity.signatureVersion,
    evidence: {
      protocol: "clamav.instream.v1",
      verdict: status,
      engineVersion: identity.engineVersion,
      signatureVersion: identity.signatureVersion,
      signatureUpdatedAt: identity.signatureUpdatedAt,
      streamedBytes,
      ...(signature ? { signature } : {}),
    },
    startedAt,
    finishedAt,
  };
}

async function write(socket: Socket, chunk: Buffer) {
  if (socket.write(chunk)) return;
  await once(socket, "drain");
}

async function readStrictResponse(socket: Socket) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of socket) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      throw new RetryableScanError("SCANNER_RESPONSE_TOO_LARGE", "Malware scanner response is too large");
    }
    chunks.push(chunk);
    const response = Buffer.concat(chunks, total);
    const terminator = response.indexOf(0);
    if (terminator >= 0) {
      if (response.subarray(terminator + 1).some((byte) => byte !== 0)) {
        throw new RetryableScanError("SCANNER_PROTOCOL_ERROR", "Malware scanner response has trailing bytes");
      }
      const text = response.subarray(0, terminator).toString("utf8").trim();
      if (!text || /[\r\n\0]/.test(text)) {
        throw new RetryableScanError("SCANNER_PROTOCOL_ERROR", "Malware scanner response is invalid");
      }
      return text;
    }
  }
  throw new RetryableScanError("SCANNER_RESPONSE_INCOMPLETE", "Malware scanner response is incomplete");
}
