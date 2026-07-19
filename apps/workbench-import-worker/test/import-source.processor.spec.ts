import { RetryableScanError, type ScanResult } from "@workbench/workbench-content-security";
import { describe, expect, it, vi } from "vitest";
import { RetryableImportError, TerminalImportError } from "../src/errors.js";
import { ImportSourceProcessor } from "../src/import/import-source.processor.js";
import { freezeImport, maximumImportSourceManifestBlobs } from "../src/import/source-types.js";

describe("ImportSourceProcessor", () => {
  it("does no provider or storage work when the delivery is already owned", async () => {
    const test = harness();
    test.store.beginAttempt.mockResolvedValueOnce({ kind: "busy" });

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("busy");
    expect(test.providers.freeze).not.toHaveBeenCalled();
    expect(test.storage.put).not.toHaveBeenCalled();
  });

  it("scans, stores, publishes, and attaches every blob before marking the Source ready", async () => {
    const test = harness();

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("ready");

    expect(test.scanner.scan).toHaveBeenCalledTimes(1);
    expect(test.store.reserveBlob).toHaveBeenCalledWith({
      sha256: test.frozen.blobs[0]!.sha256,
      mediaType: "text/plain",
      byteSize: 5,
    });
    expect(test.storage.put).toHaveBeenCalledWith(expect.objectContaining({
      storageKey: "blobs/aa/content/g1",
      sha256: test.frozen.blobs[0]!.sha256,
      byteSize: 5,
    }), Buffer.from("ready"), undefined);
    expect(test.store.publishCleanBlob).toHaveBeenCalledWith(test.reservation, expect.objectContaining({ status: "clean" }));
    expect(test.store.completeReady).toHaveBeenCalledWith("attempt-1", "lease-1", test.frozen, [test.reservation]);
  });

  it("records provider validation errors as terminal failures", async () => {
    const test = harness();
    const error = new TerminalImportError("IMPORT_MEDIA_TYPE_UNSUPPORTED", "Unsupported media");
    test.providers.freeze.mockRejectedValueOnce(error);

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("failed");
    expect(test.store.recordFailure).toHaveBeenCalledWith("attempt-1", "lease-1", error, "terminal");
  });

  it("keeps transient failures retryable before the attempt budget is exhausted", async () => {
    const test = harness({ attemptNumber: 2 });
    const error = new RetryableImportError("IMPORT_REMOTE_TIMEOUT", "Remote timeout");
    test.providers.freeze.mockRejectedValueOnce(error);

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("retryable_failed");
    expect(test.store.recordFailure).toHaveBeenCalledWith("attempt-1", "lease-1", error, "retryable");
  });

  it("writes the final transient failure as an exhausted terminal receipt", async () => {
    const test = harness({ attemptNumber: 3 });
    const error = new RetryableImportError("IMPORT_REMOTE_TIMEOUT", "Remote timeout");
    test.providers.freeze.mockRejectedValueOnce(error);

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("failed");
    expect(test.store.recordFailure).toHaveBeenCalledWith("attempt-1", "lease-1", error, "exhausted");
  });

  it("normalizes scanner outages into retryable import failures", async () => {
    const test = harness();
    test.scanner.scan.mockRejectedValueOnce(new RetryableScanError("SCANNER_TIMEOUT", "Scanner timeout"));

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("retryable_failed");
    expect(test.store.recordFailure).toHaveBeenCalledWith(
      "attempt-1",
      "lease-1",
      expect.objectContaining({ code: "SCANNER_TIMEOUT", safeDetail: "Scanner timeout" }),
      "retryable",
    );
  });

  it("fails closed when malware is detected", async () => {
    const test = harness();
    test.scanner.scan.mockResolvedValueOnce({ ...cleanScan(), status: "infected" });

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("failed");
    expect(test.store.recordFailure).toHaveBeenCalledWith(
      "attempt-1",
      "lease-1",
      expect.objectContaining({ code: "IMPORT_MALWARE_DETECTED" }),
      "terminal",
    );
    expect(test.storage.put).not.toHaveBeenCalled();
  });

  it("enforces the shared 50-blob manifest limit before scanning", async () => {
    const test = harness();
    const blobs = Array.from({ length: maximumImportSourceManifestBlobs + 1 }, (_, index) => ({
      path: `file-${index}.txt`,
      mediaType: "text/plain",
      bytes: Buffer.from("x"),
    }));
    test.providers.freeze.mockResolvedValueOnce(freezeImport({
      label: "oversized",
      descriptor: { kind: "github_snapshot", repository: "acme/product", commitSha: "a".repeat(40) },
      blobs,
    }));

    await expect(test.processor.process("source-1", "job-1", 60_000, 3)).resolves.toBe("failed");
    expect(test.store.recordFailure).toHaveBeenCalledWith(
      "attempt-1",
      "lease-1",
      expect.objectContaining({ code: "IMPORT_SOURCE_LIMIT" }),
      "terminal",
    );
    expect(test.scanner.scan).not.toHaveBeenCalled();
  });

  it("renews the attempt lease while a provider freeze is in progress", async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      let release!: () => void;
      test.providers.freeze.mockReturnValueOnce(new Promise((resolve) => {
        release = () => resolve(test.frozen);
      }));

      const outcome = test.processor.process("source-1", "job-1", 3_000, 3);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(test.store.touchAttempt).toHaveBeenCalledWith("attempt-1", "lease-1", 3_000);
      release();
      await expect(outcome).resolves.toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });
});

function harness(overrides: { attemptNumber?: number } = {}) {
  const frozen = freezeImport({
    label: "Website",
    descriptor: {
      kind: "url_snapshot",
      sourceUrl: "https://example.test/start",
      resolvedUrl: "https://example.test/final",
    },
    blobs: [{ path: "index.txt", mediaType: "text/plain", bytes: Buffer.from("ready") }],
  });
  const reservation = {
    id: "blob-1",
    generation: 1,
    status: "pending" as const,
    storageKey: "pending/aa/content/g1",
    canonicalStorageKey: "blobs/aa/content/g1",
    sha256: frozen.blobs[0]!.sha256,
    mediaType: "text/plain",
    byteSize: 5,
    latestScanStatus: null,
  };
  const store = {
    beginAttempt: vi.fn().mockResolvedValue({
      kind: "run",
      attemptId: "attempt-1",
      attemptNumber: overrides.attemptNumber ?? 1,
      leaseToken: "lease-1",
      command: {
        id: "source-1",
        projectId: "project-1",
        requestHash: "a".repeat(64),
        request: { kind: "url_snapshot", sourceUrl: "https://example.test/start" },
      },
    }),
    touchAttempt: vi.fn().mockResolvedValue(undefined),
    reserveBlob: vi.fn().mockResolvedValue(reservation),
    publishCleanBlob: vi.fn().mockResolvedValue(undefined),
    completeReady: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
  };
  const providers = { freeze: vi.fn().mockResolvedValue(frozen) };
  const scanner = { scan: vi.fn().mockResolvedValue(cleanScan()) };
  const storage = { put: vi.fn().mockResolvedValue(undefined) };
  return {
    processor: new ImportSourceProcessor(store as never, providers as never, scanner, storage as never, 10 * 1_024 * 1_024),
    store,
    providers,
    scanner,
    storage,
    frozen,
    reservation,
  };
}

function cleanScan(): ScanResult {
  const now = new Date();
  return {
    status: "clean",
    scanner: "clamav",
    scannerVersion: "1.4.3",
    signatureVersion: "42",
    evidence: { verdict: "clean" },
    startedAt: now,
    finishedAt: now,
  };
}
