import { describe, expect, it, vi } from "vitest";
import { RetryableImportError } from "../src/errors.js";
import { PrismaImportSourceStore } from "../src/import/import-source.store.js";
import { freezeImport } from "../src/import/source-types.js";

const prefixes = { pending: "pending/imports", canonical: "blobs" };

describe("PrismaImportSourceStore leases", () => {
  it("claims a queued attempt once and returns only the frozen external command", async () => {
    const tx = transaction();
    tx.importSource.findUnique.mockResolvedValue(source({
      attempts: [attempt({ status: "queued", leaseToken: null, leaseExpiresAt: null })],
    }));
    tx.importSourceAttempt.updateMany.mockResolvedValue({ count: 1 });
    const store = storeWith(tx);

    await expect(store.beginAttempt("source-1", { queueJobId: "job-1", leaseMs: 60_000 }))
      .resolves.toMatchObject({
        kind: "run",
        attemptId: "attempt-1",
        attemptNumber: 1,
        leaseToken: expect.any(String),
        command: {
          id: "source-1",
          projectId: "project-1",
          requestHash: "a".repeat(64),
          request: { kind: "url_snapshot", sourceUrl: "https://example.test" },
        },
      });
    expect(tx.importSourceAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "attempt-1", status: "queued" },
      data: expect.objectContaining({
        status: "running",
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
        startedAt: expect.any(Date),
      }),
    }));
  });

  it("does not share a live or expired running lease with a duplicate delivery", async () => {
    const tx = transaction();
    tx.importSource.findUnique.mockResolvedValue(source({
      attempts: [attempt({
        status: "running",
        leaseToken: "owner-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })],
    }));
    const store = storeWith(tx);

    await expect(store.beginAttempt("source-1", { queueJobId: "job-1", leaseMs: 60_000 }))
      .resolves.toEqual({ kind: "busy" });
    expect(tx.importSourceAttempt.updateMany).not.toHaveBeenCalled();

    tx.importSource.findUnique.mockResolvedValueOnce(source({
      attempts: [attempt({
        status: "running",
        leaseToken: "owner-1",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })],
    }));
    await expect(store.beginAttempt("source-1", { queueJobId: "job-1", leaseMs: 60_000 }))
      .resolves.toEqual({ kind: "busy" });
  });

  it("renews only an unexpired lease owned by the caller", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const store = new PrismaImportSourceStore({ importSourceAttempt: { updateMany } } as never, prefixes);

    await expect(store.touchAttempt("attempt-1", "lease-1", 60_000)).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "attempt-1",
        status: "running",
        leaseToken: "lease-1",
        leaseExpiresAt: { gt: expect.any(Date) },
      },
    }));
    await expect(store.touchAttempt("attempt-1", "lease-lost", 60_000))
      .rejects.toMatchObject({ code: "IMPORT_LEASE_LOST" });
  });

  it("refuses completion after the attempt lease has expired", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValueOnce([lockedAttempt({ leaseExpiresAt: new Date(Date.now() - 1) })]);
    const store = storeWith(tx);
    const frozen = frozenImport();

    await expect(store.completeReady("attempt-1", "lease-1", frozen, [reservedBlob()]))
      .rejects.toMatchObject({ code: "IMPORT_LEASE_LOST" });
    expect(tx.importSourceBlob.create).not.toHaveBeenCalled();
    expect(tx.importSource.update).not.toHaveBeenCalled();
  });
});

describe("PrismaImportSourceStore failure and reconciliation", () => {
  it("writes exhausted attempt and Source receipts in one transaction", async () => {
    const tx = transaction();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedAttempt()])
      .mockResolvedValueOnce([]);
    const store = storeWith(tx);
    const error = new RetryableImportError("IMPORT_REMOTE_TIMEOUT", "Remote timeout");

    await store.recordFailure("attempt-1", "lease-1", error, "exhausted");

    expect(tx.importSourceAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "attempt-1" },
      data: expect.objectContaining({
        status: "terminal_failed",
        leaseToken: null,
        leaseExpiresAt: null,
        failureCode: "IMPORT_REMOTE_TIMEOUT",
      }),
    }));
    expect(tx.importSource.updateMany).toHaveBeenCalledWith({
      where: { id: "source-1", status: "pending" },
      data: {
        status: "failed",
        failureCode: "IMPORT_ATTEMPTS_EXHAUSTED",
        failureDetail: "The source could not be frozen after the maximum number of attempts",
        revision: { increment: 1 },
      },
    });
  });

  it("does not let a stale owner record a failure after lease loss", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValueOnce([lockedAttempt({ leaseToken: "another-owner" })]);
    const store = storeWith(tx);

    await store.recordFailure("attempt-1", "lease-1", new Error("late"), "retryable");

    expect(tx.importSourceAttempt.update).not.toHaveBeenCalled();
    expect(tx.importSource.updateMany).not.toHaveBeenCalled();
  });

  it("reaps stale running attempts and terminalizes those at the attempt limit", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValueOnce([
      { id: "attempt-1", sourceId: "source-1", attempt: 1 },
      { id: "attempt-3", sourceId: "source-2", attempt: 3 },
    ]);
    tx.importSourceAttempt.updateMany.mockResolvedValue({ count: 1 });
    const store = storeWith(tx);

    await expect(store.expireStaleAttempts(new Date(), 3, 50)).resolves.toEqual({
      expired: 2,
      retryable: 1,
      exhausted: 1,
    });

    expect(tx.importSourceAttempt.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ status: "retryable_failed", failureCode: "IMPORT_LEASE_EXPIRED" }),
    }));
    expect(tx.importSourceAttempt.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ status: "terminal_failed", failureCode: "IMPORT_LEASE_EXPIRED" }),
    }));
    expect(tx.importSource.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-2", status: "pending" },
      data: expect.objectContaining({ status: "failed", failureCode: "IMPORT_ATTEMPTS_EXHAUSTED" }),
    }));
  });

  it("returns only bounded retry candidates below the maximum attempt count", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { sourceId: "source-1", projectId: "project-1", requestHash: "a".repeat(64), attemptCount: 1n },
    ]);
    const store = new PrismaImportSourceStore({ $queryRaw: queryRaw } as never, prefixes);

    await expect(store.reconciliationCandidates(new Date(), 3, 50)).resolves.toEqual([{
      sourceId: "source-1",
      projectId: "project-1",
      requestHash: "a".repeat(64),
      nextAttempt: 2,
    }]);
    const sql = queryRaw.mock.calls[0]![0];
    expect(sql.strings.join(" ")).toContain("failed.\"failure_code\" = 'IMPORT_LEASE_EXPIRED'");
    expect(sql.strings.join(" ")).toContain("HAVING COUNT(attempt.\"id\") <");
  });

  it("creates the retry queue job and attempt atomically, rejecting stale candidates", async () => {
    const tx = transaction();
    tx.importSource.findUnique.mockResolvedValue(source({
      attempts: [attempt({ status: "retryable_failed", attempt: 1 })],
    }));
    const store = storeWith(tx);
    const enqueue = vi.fn().mockResolvedValue("job-2");
    const candidate = {
      sourceId: "source-1",
      projectId: "project-1",
      requestHash: "a".repeat(64),
      nextAttempt: 2,
    };

    await expect(store.scheduleRetry({ ...candidate, nextAttempt: 99 }, enqueue)).resolves.toBe(false);
    expect(enqueue).not.toHaveBeenCalled();

    await expect(store.scheduleRetry(candidate, enqueue)).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledWith(tx, {
      sourceId: "source-1",
      projectId: "project-1",
      requestHash: "a".repeat(64),
    });
    expect(tx.importSourceAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        importSourceId: "source-1",
        projectId: "project-1",
        attempt: 2,
        queueJobId: "job-2",
        status: "queued",
      }),
    });
  });
});

function storeWith(tx: ReturnType<typeof transaction>) {
  return new PrismaImportSourceStore({
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  } as never, prefixes);
}

function transaction() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    importSource: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    importSourceAttempt: {
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    importSourceBlob: { create: vi.fn() },
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
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    projectId: "project-1",
    status: "pending",
    request: { kind: "url_snapshot", sourceUrl: "https://example.test" },
    requestHash: "a".repeat(64),
    attempts: [],
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    attempt: 1,
    status: "queued",
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

function lockedAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    importSourceId: "source-1",
    projectId: "project-1",
    status: "running",
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function frozenImport() {
  return freezeImport({
    label: "Website",
    descriptor: {
      kind: "url_snapshot",
      sourceUrl: "https://example.test",
      resolvedUrl: "https://example.test",
    },
    blobs: [{ path: "index.txt", mediaType: "text/plain", bytes: Buffer.from("ready") }],
  });
}

function reservedBlob() {
  const frozen = frozenImport();
  return {
    id: "blob-1",
    generation: 1,
    status: "ready" as const,
    storageKey: `blobs/${frozen.blobs[0]!.sha256}`,
    canonicalStorageKey: `blobs/${frozen.blobs[0]!.sha256}`,
    sha256: frozen.blobs[0]!.sha256,
    mediaType: "text/plain",
    byteSize: 5,
    latestScanStatus: "clean",
  };
}
