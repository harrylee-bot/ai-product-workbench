import { Prisma } from "@workbench/workbench-db";
import type { ScanResult } from "@workbench/workbench-content-security";
import { PrismaVerificationStore } from "../src/verification/prisma-verification.store.js";
import { RetryableVerificationError } from "../src/errors.js";

const sha256 = "a".repeat(64);

describe("PrismaVerificationStore", () => {
  it("retries a concurrent partial-unique collision and advances Blob generation", async () => {
    const tx = transaction();
    tx.blob.findFirst.mockResolvedValue(null);
    tx.blob.aggregate.mockResolvedValue({ _max: { generation: 3 } });
    tx.blob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => blob({
      id: data.id,
      generation: data.generation,
      storageKey: data.storageKey,
      mediaType: data.mediaType,
      byteSize: data.byteSize,
    }));
    const uniqueConflict = new Prisma.PrismaClientKnownRequestError("active SHA collision", {
      code: "P2002",
      clientVersion: "6.19.3",
    });
    const db = {
      $transaction: vi.fn()
        .mockRejectedValueOnce(uniqueConflict)
        .mockImplementation(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const store = new PrismaVerificationStore(db as never, prefixes);

    await expect(store.reserveBlob({ sha256, byteSize: 4, mediaType: "text/plain" }))
      .resolves.toMatchObject({
        generation: 4,
        storageKey: `pending/blobs/aa/aa/${sha256}/g4`,
        status: "pending",
      });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.blob.create).toHaveBeenCalledTimes(1);
  });

  it("writes terminal scan evidence, Blob readiness, and File readiness in one transaction client", async () => {
    const tx = transaction();
    tx.blob.findUnique
      .mockResolvedValueOnce({ sha256 })
      .mockResolvedValueOnce(blob())
      .mockResolvedValueOnce(blob({ status: "ready", scans: [{ status: "clean" }] }));
    tx.fileUploadSession.findUnique.mockResolvedValue({
      status: "completed",
      file: { id: "file_1", status: "verifying" },
    });
    tx.blobScan.aggregate.mockResolvedValue({ _max: { attempt: null } });
    tx.blobScan.create.mockResolvedValue({ id: "scan_1" });
    tx.blob.update.mockResolvedValue(blob({ status: "ready", scans: [{ status: "clean" }] }));
    tx.fileAsset.updateMany.mockResolvedValue({ count: 1 });
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const store = new PrismaVerificationStore(db as never, prefixes);

    await expect(store.finalize({
      uploadSessionId: "upload_1",
      blobId: "blob_1",
      promotedStorageKey: `blobs/aa/aa/${sha256}/g1`,
      scan: cleanScan(),
    })).resolves.toBe("ready");

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.blobScan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        blobId: "blob_1",
        attempt: 1,
        status: "clean",
        evidence: { verdict: "clean" },
      }),
    }));
    expect(tx.blob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "blob_1" },
      data: expect.objectContaining({
        status: "ready",
        storageKey: `blobs/aa/aa/${sha256}/g1`,
      }),
    }));
    expect(tx.fileAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "file_1", status: "verifying" },
      data: expect.objectContaining({
        status: "ready",
        blobId: "blob_1",
        detectedMediaType: "text/plain",
        revision: { increment: 1 },
      }),
    }));
  });

  it("moves a ready Blob locator into quarantine before committing infected evidence", async () => {
    const tx = transaction();
    tx.blob.findUnique
      .mockResolvedValueOnce({ sha256 })
      .mockResolvedValueOnce(blob({ status: "ready", scans: [{ status: "clean" }] }))
      .mockResolvedValueOnce(blob({
        status: "quarantined",
        storageKey: `quarantine/blobs/aa/aa/${sha256}/g1`,
        scans: [{ status: "infected" }],
      }));
    tx.fileUploadSession.findUnique.mockResolvedValue({
      status: "completed",
      file: { id: "file_1", status: "verifying" },
    });
    tx.blob.update.mockResolvedValue(blob({
      status: "ready",
      storageKey: `quarantine/blobs/aa/aa/${sha256}/g1`,
      scans: [{ status: "clean" }],
    }));
    tx.blobScan.aggregate.mockResolvedValue({ _max: { attempt: 1 } });
    tx.blobScan.create.mockResolvedValue({ id: "scan_2" });
    tx.fileAsset.updateMany.mockResolvedValue({ count: 1 });
    const db = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const store = new PrismaVerificationStore(db as never, prefixes);

    await expect(store.finalize({
      uploadSessionId: "upload_1",
      blobId: "blob_1",
      promotedStorageKey: `quarantine/blobs/aa/aa/${sha256}/g1`,
      scan: { ...cleanScan(), status: "infected", evidence: { verdict: "infected", signature: "Eicar" } },
    })).resolves.toBe("quarantined");

    expect(tx.blob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { storageKey: `quarantine/blobs/aa/aa/${sha256}/g1` },
    }));
    expect(tx.blobScan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "infected", attempt: 2 }),
    }));
    expect(tx.fileAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "quarantined" }),
    }));
  });

  it("persists a new queue delivery and closes an interrupted running attempt in one transaction", async () => {
    const tx = transaction();
    tx.fileUploadSession.findUnique.mockResolvedValue({ file: { status: "verifying" } });
    tx.fileVerificationAttempt.findUnique.mockResolvedValue(null);
    tx.fileVerificationAttempt.updateMany.mockResolvedValue({ count: 1 });
    tx.fileVerificationAttempt.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { sequence: 1 },
    });
    tx.fileVerificationAttempt.create.mockResolvedValue({ id: "verify_2" });
    const db = { $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)) };
    const store = new PrismaVerificationStore(db as never, prefixes);

    await expect(store.beginAttempt("upload_1", {
      queueJobId: "job_1",
      retryCount: 1,
      retryLimit: 5,
    }, 6)).resolves.toEqual({ kind: "run", attemptId: "verify_2" });

    expect(tx.fileVerificationAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { uploadSessionId: "upload_1", status: "running" },
      data: expect.objectContaining({
        status: "retryable_failed",
        failureCode: "WORKER_DELIVERY_REPLACED",
      }),
    }));
    expect(tx.fileVerificationAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sequence: 2, queueJobId: "job_1", queueRetryCount: 1 }),
    }));
  });

  it("closes the final retry attempt and the verifying File in the same transaction", async () => {
    const tx = transaction();
    tx.fileVerificationAttempt.findUnique
      .mockResolvedValueOnce({ uploadSessionId: "upload_1" })
      .mockResolvedValueOnce({
        status: "running",
        fileStatus: null,
        uploadSessionId: "upload_1",
      });
    tx.fileUploadSession.findUnique
      .mockResolvedValueOnce({ file: { status: "verifying" } })
      .mockResolvedValueOnce({ file: { id: "file_1", status: "verifying" } });
    tx.fileAsset.updateMany.mockResolvedValue({ count: 1 });
    tx.fileVerificationAttempt.update.mockResolvedValue({ id: "attempt_1" });
    const db = { $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)) };
    const store = new PrismaVerificationStore(db as never, prefixes);
    const error = new RetryableVerificationError("SCANNER_TIMEOUT", "Malware scanner timed out");

    await expect(store.recordRetryableFailure("attempt_1", error, true)).resolves.toBe("failed");

    expect(tx.fileAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "failed",
        failureCode: "FILE_VERIFICATION_RETRY_EXHAUSTED",
        revision: { increment: 1 },
      }),
    }));
    expect(tx.fileVerificationAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "terminal_failed",
        fileStatus: "failed",
        failureCode: "FILE_VERIFICATION_RETRY_EXHAUSTED",
      }),
    }));
  });
});

function transaction() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    blob: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    blobScan: {
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    fileUploadSession: { findUnique: vi.fn() },
    fileVerificationAttempt: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    fileAsset: { updateMany: vi.fn() },
  };
}

function blob(overrides: Record<string, unknown> = {}) {
  return {
    id: "blob_1",
    sha256,
    generation: 1,
    storageKey: `pending/blobs/aa/aa/${sha256}/g1`,
    mediaType: "text/plain",
    byteSize: 4n,
    status: "pending",
    scans: [],
    ...overrides,
  };
}

function cleanScan(): ScanResult {
  const now = new Date();
  return {
    status: "clean",
    scanner: "test-scanner",
    scannerVersion: "1",
    signatureVersion: "test-signatures",
    evidence: { verdict: "clean" },
    startedAt: now,
    finishedAt: now,
  };
}

const prefixes = {
  pending: "pending/blobs",
  canonical: "blobs",
  quarantine: "quarantine/blobs",
};
