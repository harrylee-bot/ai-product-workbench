import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  FailClosedScanAdapter,
  type ScanInput,
  type ScanPort,
  type ScanResult,
} from "@workbench/workbench-content-security";
import type { FileStoragePort, PromotedObject } from "../src/storage/storage.port.js";
import { FileVerificationProcessor } from "../src/verification/file-verification.processor.js";
import type {
  BlobReservation,
  ContentIdentity,
  FinalizeVerificationInput,
  VerificationCommand,
  VerificationOutcome,
  VerificationStore,
} from "../src/verification/verification.store.js";

const bytes = Buffer.from("trusted server bytes\n", "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const maximumUploadByteSize = 25 * 1024 ** 2;

describe("FileVerificationProcessor", () => {
  it("streams trusted bytes twice, ignores declared MIME, and finalizes clean evidence atomically", async () => {
    const store = new MemoryStore(command());
    const storage = new MemoryStorage(bytes);
    const scanner = new ConsumingScanner("clean");
    const processor = new FileVerificationProcessor(store, storage, scanner, maximumUploadByteSize);

    await expect(processor.verify("upload_1")).resolves.toBe("ready");

    expect(storage.reads).toBe(2);
    expect(scanner.calls).toBe(1);
    expect(store.reservedIdentity).toEqual({ sha256, byteSize: bytes.byteLength, mediaType: "text/plain" });
    expect(storage.promotions[0]).toMatchObject({ sha256, byteSize: bytes.byteLength, mediaType: "text/plain" });
    expect(store.finalizeInputs[0]?.scan).toMatchObject({
      status: "clean",
      evidence: { sha256, byteSize: bytes.byteLength, mediaType: "text/plain" },
    });
    expect(storage.deleted).toEqual(["staging/upload_1"]);
  });

  it("treats a client SHA as an integrity hint and never creates a Blob from it", async () => {
    const store = new MemoryStore(command({ expectedSha256: "0".repeat(64) }));
    const storage = new MemoryStorage(bytes);
    const scanner = new ConsumingScanner("clean");

    await expect(new FileVerificationProcessor(store, storage, scanner, maximumUploadByteSize).verify("upload_1"))
      .resolves.toBe("failed");

    expect(store.failure).toEqual({ code: "FILE_SHA256_MISMATCH", detail: null });
    expect(store.reservedIdentity).toBeNull();
    expect(scanner.calls).toBe(0);
    expect(storage.promotions).toHaveLength(0);
  });

  it("fails closed without ClamAV and never manufactures clean evidence", async () => {
    const store = new MemoryStore(command());
    const storage = new MemoryStorage(bytes);
    const processor = new FileVerificationProcessor(store, storage, new FailClosedScanAdapter(), maximumUploadByteSize);

    await expect(processor.verify("upload_1")).rejects.toMatchObject({ code: "SCANNER_NOT_CONFIGURED" });

    expect(store.status).toBe("verifying");
    expect(store.finalizeInputs).toHaveLength(0);
    expect(storage.promotions).toHaveLength(0);
    expect(storage.deleted).toHaveLength(0);
  });

  it("promotes infected bytes only to the reserved stable key and quarantines the File", async () => {
    const store = new MemoryStore(command());
    const storage = new MemoryStorage(bytes);
    const scanner = new ConsumingScanner("infected");

    await expect(new FileVerificationProcessor(store, storage, scanner, maximumUploadByteSize).verify("upload_1"))
      .resolves.toBe("quarantined");

    expect(storage.promotions).toHaveLength(1);
    expect(storage.promotions[0]?.destinationKey).toBe(reservation().quarantineStorageKey);
    expect(storage.promotions[0]?.destinationKey.startsWith("blobs/")).toBe(false);
    expect(store.finalizeInputs[0]?.scan).toMatchObject({ status: "infected" });
  });

  it("reuses a ready Blob only when its latest immutable scan is clean", async () => {
    const store = new MemoryStore(command(), reservation({
      status: "ready",
      latestScanStatus: "clean",
      storageKey: reservation().canonicalStorageKey,
    }));
    const storage = new MemoryStorage(bytes);
    const scanner = new ConsumingScanner("clean");

    await expect(new FileVerificationProcessor(store, storage, scanner, maximumUploadByteSize).verify("upload_1"))
      .resolves.toBe("ready");

    expect(scanner.calls).toBe(0);
    expect(store.finalizeInputs[0]?.scan).toBeNull();
  });

  it("replays safely after promotion succeeded but the process lost the result", async () => {
    const store = new MemoryStore(command());
    const storage = new MemoryStorage(bytes);
    storage.crashAfterFirstPromotion = true;
    const scanner = new ConsumingScanner("clean");
    const processor = new FileVerificationProcessor(store, storage, scanner, maximumUploadByteSize);

    await expect(processor.verify("upload_1")).rejects.toThrow("SIMULATED_PROMOTION_RESULT_LOSS");
    expect(store.status).toBe("verifying");
    expect(storage.stable.has(reservation().canonicalStorageKey)).toBe(true);

    await expect(processor.verify("upload_1")).resolves.toBe("ready");
    expect(store.scanEvidenceCount).toBe(1);
    expect(scanner.calls).toBe(2);
  });

  it("replays cleanup without re-scanning after the final transaction committed", async () => {
    const store = new MemoryStore(command());
    const storage = new MemoryStorage(bytes);
    storage.crashBeforeFirstDelete = true;
    const scanner = new ConsumingScanner("clean");
    const processor = new FileVerificationProcessor(store, storage, scanner, maximumUploadByteSize);

    await expect(processor.verify("upload_1")).rejects.toThrow("SIMULATED_DELETE_RESULT_LOSS");
    expect(store.status).toBe("ready");
    expect(store.scanEvidenceCount).toBe(1);

    await expect(processor.verify("upload_1")).resolves.toBe("ready");
    expect(scanner.calls).toBe(1);
    expect(storage.promotions).toHaveLength(1);
  });

  it("converges concurrent duplicate jobs on one terminal evidence record", async () => {
    const store = new MemoryStore(command());
    const storage = new MemoryStorage(bytes);
    const scanner = new ConsumingScanner("clean");
    const processor = new FileVerificationProcessor(store, storage, scanner, maximumUploadByteSize);

    await expect(Promise.all([
      processor.verify("upload_1"),
      processor.verify("upload_1"),
    ])).resolves.toEqual(["ready", "ready"]);

    expect(store.scanEvidenceCount).toBe(1);
    expect(store.status).toBe("ready");
  });

  it("detects a body that exceeds its S3 Content-Length instead of hashing a prefix", async () => {
    const store = new MemoryStore(command());
    const storage = new MemoryStorage(Buffer.concat([bytes, Buffer.from("extra")]));
    storage.reportedSize = bytes.byteLength;

    await expect(new FileVerificationProcessor(store, storage, new ConsumingScanner("clean"), maximumUploadByteSize).verify("upload_1"))
      .resolves.toBe("failed");

    expect(store.failure?.code).toBe("FILE_BYTE_SIZE_MISMATCH");
    expect(store.reservedIdentity).toBeNull();
  });

  it("rejects a legacy oversized command before reading or scanning storage", async () => {
    const oversized = BigInt(maximumUploadByteSize + 1);
    const store = new MemoryStore(command({
      expectedByteSize: oversized,
      file: { id: "file_1", status: "verifying", byteSize: oversized, blobId: null },
    }));
    const storage = new MemoryStorage(bytes);

    await expect(new FileVerificationProcessor(
      store,
      storage,
      new ConsumingScanner("clean"),
      maximumUploadByteSize,
    ).verify("upload_1")).resolves.toBe("failed");

    expect(store.failure?.code).toBe("FILE_SIZE_LIMIT_EXCEEDED");
    expect(storage.reads).toBe(0);
  });
});

class MemoryStore implements VerificationStore {
  status: VerificationOutcome | "verifying";
  reservedIdentity: ContentIdentity | null = null;
  finalizeInputs: FinalizeVerificationInput[] = [];
  scanEvidenceCount = 0;
  failure: { code: string; detail: string | null } | null = null;

  constructor(
    private readonly value: VerificationCommand,
    private readonly blob: BlobReservation = reservation(),
  ) {
    this.status = value.file.status as "verifying";
  }

  async load() {
    return {
      ...this.value,
      file: { ...this.value.file, status: this.status },
    };
  }

  async reserveBlob(identity: ContentIdentity) {
    this.reservedIdentity = identity;
    return { ...this.blob, sha256: identity.sha256, byteSize: BigInt(identity.byteSize) };
  }

  async finalize(input: FinalizeVerificationInput) {
    if (this.status !== "verifying") return this.status;
    this.finalizeInputs.push(input);
    if (input.scan) this.scanEvidenceCount += 1;
    this.status = input.scan?.status === "infected" || this.blob.status === "quarantined"
      ? "quarantined"
      : "ready";
    return this.status;
  }

  async failFile(_uploadSessionId: string, code: string, detail: string | null) {
    if (this.status !== "verifying") return this.status;
    this.failure = { code, detail };
    this.status = "failed";
    return this.status;
  }
}

class MemoryStorage implements FileStoragePort {
  reads = 0;
  reportedSize: number;
  promotions: PromotedObject[] = [];
  deleted: string[] = [];
  stable = new Map<string, Buffer>();
  crashAfterFirstPromotion = false;
  crashBeforeFirstDelete = false;

  constructor(private readonly bytes: Buffer) {
    this.reportedSize = bytes.byteLength;
  }

  async getObject() {
    this.reads += 1;
    return {
      body: Readable.from([this.bytes]),
      byteSize: this.reportedSize,
      mediaType: "application/x-untrusted",
    };
  }

  async promoteObject(object: PromotedObject) {
    this.promotions.push(object);
    this.stable.set(object.destinationKey, Buffer.from(this.bytes));
    if (this.crashAfterFirstPromotion) {
      this.crashAfterFirstPromotion = false;
      throw new Error("SIMULATED_PROMOTION_RESULT_LOSS");
    }
  }

  async deleteObject(key: string) {
    if (this.crashBeforeFirstDelete) {
      this.crashBeforeFirstDelete = false;
      throw new Error("SIMULATED_DELETE_RESULT_LOSS");
    }
    this.deleted.push(key);
  }
}

class ConsumingScanner implements ScanPort {
  calls = 0;

  constructor(private readonly status: "clean" | "infected") {}

  async scan(input: ScanInput): Promise<ScanResult> {
    this.calls += 1;
    for await (const _chunk of input.body) {
      // Consuming the complete stream is part of a valid terminal verdict.
    }
    const now = new Date();
    return {
      status: this.status,
      scanner: "test-scanner",
      scannerVersion: "1",
      signatureVersion: "test-signatures",
      evidence: this.status === "clean"
        ? { verdict: "clean" }
        : { verdict: "infected", signature: "test-signature" },
      startedAt: now,
      finishedAt: now,
    };
  }
}

function command(overrides: Partial<VerificationCommand> = {}): VerificationCommand {
  return {
    uploadSessionId: "upload_1",
    uploadStatus: "completed",
    stagingKey: "staging/upload_1",
    expectedByteSize: BigInt(bytes.byteLength),
    expectedSha256: null,
    file: {
      id: "file_1",
      status: "verifying",
      byteSize: BigInt(bytes.byteLength),
      blobId: null,
    },
    ...overrides,
  };
}

function reservation(overrides: Partial<BlobReservation> = {}): BlobReservation {
  return {
    id: "blob_1",
    sha256,
    generation: 1,
    storageKey: "pending/blobs/aa/content/g1",
    canonicalStorageKey: "blobs/aa/content/g1",
    quarantineStorageKey: "quarantine/blobs/aa/content/g1",
    mediaType: "text/plain",
    byteSize: BigInt(bytes.byteLength),
    status: "pending",
    latestScanStatus: null,
    ...overrides,
  };
}
