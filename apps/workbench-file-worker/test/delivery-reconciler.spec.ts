import { RetryableVerificationError } from "../src/errors.js";
import { ExtractionDeliveryRunner } from "../src/extraction/extraction-delivery.runner.js";
import { RetryableExtractionError, TerminalExtractionError } from "../src/extraction/extraction.errors.js";
import { ExtractionReconciler } from "../src/extraction/extraction-reconciler.js";
import { VerificationDeliveryRunner } from "../src/verification/verification-delivery.runner.js";
import { VerificationReconciler } from "../src/verification/verification-reconciler.js";

const delivery = { queueJobId: "job_1", retryCount: 0, retryLimit: 5 };

describe("VerificationDeliveryRunner", () => {
  it("persists a retryable scanner outage and rethrows so pg-boss retries", async () => {
    const error = new RetryableVerificationError("SCANNER_UNAVAILABLE", "Malware scanner is unavailable");
    const store = attemptStore();
    const processor = { verify: vi.fn().mockRejectedValue(error) };
    const runner = new VerificationDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("upload_1", delivery)).rejects.toBe(error);

    expect(store.recordRetryableFailure).toHaveBeenCalledWith("attempt_1", error, false);
    expect(store.completeAttempt).not.toHaveBeenCalled();
  });

  it("atomically closes the File when the final pg-boss retry is exhausted", async () => {
    const error = new RetryableVerificationError("SCANNER_TIMEOUT", "Malware scanner timed out");
    const store = attemptStore();
    store.recordRetryableFailure.mockResolvedValue("failed");
    const processor = { verify: vi.fn().mockRejectedValue(error) };
    const runner = new VerificationDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("upload_1", { ...delivery, retryCount: 5 })).resolves.toBe("failed");

    expect(store.recordRetryableFailure).toHaveBeenCalledWith("attempt_1", error, true);
  });

  it("recognizes a domain commit whose attempt receipt was lost instead of retrying work", async () => {
    const store = attemptStore();
    store.completeAttempt.mockRejectedValue(new Error("lost commit response"));
    store.recordRetryableFailure.mockResolvedValue("ready");
    const processor = { verify: vi.fn().mockResolvedValue("ready") };
    const runner = new VerificationDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("upload_1", delivery)).resolves.toBe("ready");
    expect(store.recordRetryableFailure).toHaveBeenCalledWith(
      "attempt_1",
      expect.objectContaining({ code: "FILE_VERIFICATION_INFRASTRUCTURE_ERROR" }),
      false,
    );
  });

  it("exhausts a replay of the already-persisted final retryable delivery", async () => {
    const store = attemptStore();
    store.beginAttempt.mockResolvedValue({
      kind: "retryable_replay",
      code: "SCANNER_UNAVAILABLE",
      detail: "Malware scanner is unavailable",
    });
    store.exhaustUpload.mockResolvedValue("failed");
    const processor = { verify: vi.fn() };
    const runner = new VerificationDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("upload_1", { ...delivery, retryCount: 5 })).resolves.toBe("failed");
    expect(store.exhaustUpload).toHaveBeenCalledWith("upload_1", "SCANNER_UNAVAILABLE");
    expect(processor.verify).not.toHaveBeenCalled();
  });

  it("replays a terminal File through the Processor so staging cleanup can converge", async () => {
    const store = attemptStore();
    store.beginAttempt.mockResolvedValue({ kind: "terminal", outcome: "ready" });
    const processor = { verify: vi.fn().mockResolvedValue("ready") };
    const runner = new VerificationDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("upload_1", { ...delivery, retryCount: 1 })).resolves.toBe("ready");

    expect(processor.verify).toHaveBeenCalledWith("upload_1", undefined);
    expect(store.completeAttempt).not.toHaveBeenCalled();
  });
});

describe("VerificationReconciler", () => {
  it("requeues stale work with budget and permanently closes exhausted verifying Files", async () => {
    const store = attemptStore();
    store.findReconciliationCandidates.mockResolvedValue([
      { uploadSessionId: "upload_retry", attemptCount: 2 },
      { uploadSessionId: "upload_exhausted", attemptCount: 6 },
    ]);
    store.exhaustUpload.mockResolvedValue("failed");
    const queue = { send: vi.fn().mockResolvedValue("job_reconciled") };
    const reconciler = new VerificationReconciler(store as never, queue, 6, 300_000, 100, 60_000);

    await reconciler.runOnce();

    expect(queue.send).toHaveBeenCalledWith(
      "file.verify",
      { uploadSessionId: "upload_retry" },
      { singletonKey: "upload_retry" },
    );
    expect(store.exhaustUpload).toHaveBeenCalledWith(
      "upload_exhausted",
      "VERIFICATION_RECONCILER_EXHAUSTED",
    );
  });
});

describe("ExtractionDeliveryRunner", () => {
  it("commits terminal parser failures without asking pg-boss to retry", async () => {
    const error = new TerminalExtractionError("unsupported", "EXTRACTION_UNSUPPORTED", "unsupported");
    const store = extractionStore();
    store.fail.mockResolvedValue("unsupported");
    const processor = { extract: vi.fn().mockRejectedValue(error) };
    const runner = new ExtractionDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("extraction_1", delivery)).resolves.toBe("unsupported");

    expect(store.fail).toHaveBeenCalledWith("extraction_1", "job_1:0", error);
    expect(store.recordRetryableFailure).not.toHaveBeenCalled();
  });

  it("releases a retryable delivery and preserves the error code for pg-boss", async () => {
    const error = new RetryableExtractionError("DOCLING_STATUS_UNAVAILABLE", "unavailable");
    const store = extractionStore();
    const processor = { extract: vi.fn().mockRejectedValue(error) };
    const runner = new ExtractionDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("extraction_1", delivery)).rejects.toMatchObject({
      code: "DOCLING_STATUS_UNAVAILABLE",
      cause: error,
    });
    expect(store.recordRetryableFailure).toHaveBeenCalledWith(
      "extraction_1",
      "job_1:0",
      error,
      false,
    );
  });

  it("recognizes a ready transaction whose publish response was lost", async () => {
    const store = extractionStore();
    store.recordRetryableFailure.mockResolvedValue("ready");
    const processor = { extract: vi.fn().mockRejectedValue(new Error("commit response lost")) };
    const runner = new ExtractionDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("extraction_1", delivery)).resolves.toBe("ready");
    expect(store.recordRetryableFailure).toHaveBeenCalledWith(
      "extraction_1",
      "job_1:0",
      expect.objectContaining({ code: "FILE_EXTRACTION_INFRASTRUCTURE_ERROR" }),
      false,
    );
  });

  it("acknowledges a concurrent lease without duplicating parser work", async () => {
    const store = extractionStore();
    store.beginDelivery.mockResolvedValue({ kind: "busy" });
    const processor = { extract: vi.fn() };
    const runner = new ExtractionDeliveryRunner(store as never, processor as never, 6, 60_000);

    await expect(runner.run("extraction_1", delivery)).resolves.toBe("busy");
    expect(processor.extract).not.toHaveBeenCalled();
  });
});

describe("ExtractionReconciler", () => {
  it("requeues only stale attempts with budget and terminally exhausts the rest", async () => {
    const store = extractionStore();
    store.findReconciliationCandidates.mockResolvedValue([
      { extractionId: "extraction_retry", processingAttempts: 2 },
      { extractionId: "extraction_exhausted", processingAttempts: 6 },
    ]);
    const queue = { send: vi.fn().mockResolvedValue("job_reconciled") };
    const reconciler = new ExtractionReconciler(store as never, queue, 6, 300_000, 100, 60_000);

    await reconciler.runOnce();

    expect(queue.send).toHaveBeenCalledWith(
      "file.extract",
      { extractionId: "extraction_retry" },
      { singletonKey: "extraction_retry" },
    );
    expect(store.exhaust).toHaveBeenCalledWith(
      "extraction_exhausted",
      "FILE_EXTRACTION_RECONCILER_EXHAUSTED",
    );
  });
});

function attemptStore() {
  return {
    beginAttempt: vi.fn().mockResolvedValue({ kind: "run", attemptId: "attempt_1" }),
    touchAttempt: vi.fn().mockResolvedValue(undefined),
    completeAttempt: vi.fn().mockResolvedValue(undefined),
    recordRetryableFailure: vi.fn().mockResolvedValue(null),
    exhaustUpload: vi.fn().mockResolvedValue("failed"),
    findReconciliationCandidates: vi.fn().mockResolvedValue([]),
  };
}

function extractionStore() {
  return {
    beginDelivery: vi.fn().mockResolvedValue({
      kind: "run",
      leaseToken: "job_1:0",
      needsSubmission: false,
      command: {},
    }),
    fail: vi.fn().mockResolvedValue("failed"),
    recordRetryableFailure: vi.fn().mockResolvedValue(null),
    exhaust: vi.fn().mockResolvedValue("failed"),
    findReconciliationCandidates: vi.fn().mockResolvedValue([]),
  };
}
