import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ScanPort, ScanResult } from "@workbench/workbench-content-security";
import { RetryableVerificationError } from "../errors.js";
import { MimePrefixCollector } from "../mime.js";
import type { FileStoragePort } from "../storage/storage.port.js";
import type {
  BlobReservation,
  VerificationOutcome,
  VerificationStore,
} from "./verification.store.js";

export class FileVerificationProcessor {
  constructor(
    private readonly store: VerificationStore,
    private readonly storage: FileStoragePort,
    private readonly scanner: ScanPort,
    private readonly maximumUploadByteSize: number,
  ) {}

  async verify(uploadSessionId: string, signal?: AbortSignal): Promise<VerificationOutcome> {
    const command = await this.store.load(uploadSessionId);
    if (!command) return "missing";

    const terminal = terminalOutcome(command.file.status);
    if (terminal) {
      await this.storage.deleteObject(command.stagingKey, signal);
      return terminal;
    }
    if (command.uploadStatus !== "completed" || command.file.status !== "verifying") {
      throw new Error("FILE_VERIFY_COMMAND_NOT_READY");
    }

    const expectedByteSize = safeByteSize(command.expectedByteSize);
    if (expectedByteSize > this.maximumUploadByteSize) {
      return this.failAndCleanup(command.uploadSessionId, command.stagingKey, "FILE_SIZE_LIMIT_EXCEEDED", null, signal);
    }
    if (safeByteSize(command.file.byteSize) !== expectedByteSize) {
      return this.failAndCleanup(command.uploadSessionId, command.stagingKey, "FILE_BYTE_SIZE_MISMATCH", null, signal);
    }

    const inspected = await this.inspect(command.stagingKey, expectedByteSize, signal);
    if (inspected.byteSize !== expectedByteSize) {
      return this.failAndCleanup(command.uploadSessionId, command.stagingKey, "FILE_BYTE_SIZE_MISMATCH", null, signal);
    }
    if (command.expectedSha256 !== null && command.expectedSha256 !== inspected.sha256) {
      return this.failAndCleanup(command.uploadSessionId, command.stagingKey, "FILE_SHA256_MISMATCH", null, signal);
    }

    const blob = await this.store.reserveBlob(inspected);
    const canonicalIdentity = { ...inspected, mediaType: blob.mediaType };
    let scan: ScanResult | null = null;
    if (mustScan(blob)) {
      scan = await this.scan(command.stagingKey, canonicalIdentity, signal);
    }

    const destinationKey = scan?.status === "infected"
      ? blob.quarantineStorageKey
      : blob.status === "pending"
        ? blob.canonicalStorageKey
        : blob.storageKey;

    await this.storage.promoteObject({
      sourceKey: command.stagingKey,
      destinationKey,
      byteSize: canonicalIdentity.byteSize,
      sha256: canonicalIdentity.sha256,
      mediaType: blob.mediaType,
    }, signal);
    const outcome = await this.store.finalize({
      uploadSessionId,
      blobId: blob.id,
      promotedStorageKey: destinationKey,
      scan,
    });
    await this.storage.deleteObject(command.stagingKey, signal);
    return outcome;
  }

  private async inspect(key: string, expectedByteSize: number, signal?: AbortSignal) {
    const stored = await this.storage.getObject(key, signal);
    if (stored.byteSize !== expectedByteSize) {
      stored.body.destroy();
      return { byteSize: stored.byteSize, sha256: "", mediaType: "application/octet-stream" };
    }

    const digest = createHash("sha256");
    const prefix = new MimePrefixCollector();
    let byteSize = 0;
    try {
      for await (const value of stored.body) {
        if (signal?.aborted) throw abortError(signal);
        const chunk = toBuffer(value);
        byteSize += chunk.byteLength;
        if (!Number.isSafeInteger(byteSize) || byteSize > expectedByteSize) {
          throw new ObjectSizeMismatchError(byteSize);
        }
        digest.update(chunk);
        prefix.append(chunk);
      }
    } catch (error) {
      stored.body.destroy();
      if (error instanceof ObjectSizeMismatchError) {
        return { byteSize: error.actualSize, sha256: "", mediaType: "application/octet-stream" };
      }
      throw error;
    }
    if (byteSize !== expectedByteSize) {
      return { byteSize, sha256: "", mediaType: "application/octet-stream" };
    }
    return {
      byteSize,
      sha256: digest.digest("hex"),
      mediaType: await prefix.detect(),
    };
  }

  private async scan(
    key: string,
    identity: { byteSize: number; sha256: string; mediaType: string },
    signal?: AbortSignal,
  ): Promise<ScanResult> {
    const stored = await this.storage.getObject(key, signal);
    if (stored.byteSize !== identity.byteSize) {
      stored.body.destroy();
      throw new RetryableVerificationError(
        "SCAN_INPUT_SIZE_MISMATCH",
        "The object changed before malware scanning",
      );
    }

    const digest = createHash("sha256");
    let byteSize = 0;
    const counted = countBody(stored.body, digest, (size) => { byteSize = size; }, signal);
    try {
      const result = await this.scanner.scan({ ...identity, body: counted, signal });
      const scannedSha256 = digest.digest("hex");
      if (byteSize !== identity.byteSize || scannedSha256 !== identity.sha256) {
        throw new RetryableVerificationError(
          "SCAN_INPUT_IDENTITY_MISMATCH",
          "The object changed during malware scanning",
        );
      }
      if (result.evidence === null) {
        throw new RetryableVerificationError(
          "SCANNER_EVIDENCE_MISSING",
          "The scanner returned no terminal evidence",
        );
      }
      return normalizeScan(result, identity);
    } finally {
      stored.body.destroy();
    }
  }

  private async failAndCleanup(
    uploadSessionId: string,
    stagingKey: string,
    code: string,
    detail: string | null,
    signal?: AbortSignal,
  ) {
    const outcome = await this.store.failFile(uploadSessionId, code, detail);
    await this.storage.deleteObject(stagingKey, signal);
    return outcome;
  }
}

function mustScan(blob: BlobReservation) {
  if (blob.status === "quarantined") return false;
  return blob.status !== "ready" || blob.latestScanStatus !== "clean";
}

async function* countBody(
  body: Readable,
  digest: ReturnType<typeof createHash>,
  setSize: (size: number) => void,
  signal?: AbortSignal,
) {
  let size = 0;
  for await (const value of body) {
    if (signal?.aborted) throw abortError(signal);
    const chunk = toBuffer(value);
    size += chunk.byteLength;
    setSize(size);
    digest.update(chunk);
    yield chunk;
  }
}

function normalizeScan(
  scan: ScanResult,
  identity: { byteSize: number; sha256: string; mediaType: string },
): ScanResult {
  return {
    ...scan,
    evidence: scan.evidence === null ? null : {
      ...scan.evidence,
      sha256: identity.sha256,
      byteSize: identity.byteSize,
      mediaType: identity.mediaType,
    },
  };
}

function terminalOutcome(status: string): VerificationOutcome | null {
  if (status === "ready" || status === "failed" || status === "quarantined" || status === "deleted") return status;
  return null;
}

function safeByteSize(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("FILE_VERIFY_SIZE_INVALID");
  return number;
}

function toBuffer(value: unknown) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("FILE_STORAGE_CHUNK_UNSUPPORTED");
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("FILE_VERIFY_ABORTED");
}

class ObjectSizeMismatchError extends Error {
  constructor(readonly actualSize: number) {
    super("FILE_STORAGE_SIZE_MISMATCH");
  }
}
