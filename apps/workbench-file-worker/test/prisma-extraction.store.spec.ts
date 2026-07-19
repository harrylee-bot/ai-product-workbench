import {
  fileExtractionOutputSchemaVersion,
  fileExtractionParser,
  fileExtractionParserComponents,
  fileExtractionParserVersion,
} from "@workbench/workbench-contracts";
import { PrismaExtractionStore } from "../src/extraction/prisma-extraction.store.js";

const markdownSha = "a".repeat(64);
const jsonSha = "b".repeat(64);

describe("PrismaExtractionStore", () => {
  it("acquires the first lease and persists the single submission fence atomically", async () => {
    const tx = transaction();
    tx.fileExtraction.findUnique.mockResolvedValue(commandRow());
    tx.fileExtraction.update.mockResolvedValue(commandRow({
      status: "running",
      processingAttempts: 1,
      submissionGeneration: 1,
      submissionStartedAt: new Date(),
      startedAt: new Date(),
      leaseToken: "job_1:0",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }));
    const store = createStore(tx);

    await expect(store.beginDelivery("extraction_1", delivery, 6, 60_000)).resolves.toMatchObject({
      kind: "run",
      leaseToken: "job_1:0",
      needsSubmission: true,
      command: { processingAttempts: 1, submissionGeneration: 1, externalTaskId: null },
    });

    expect(tx.fileExtraction.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "extraction_1" },
      data: expect.objectContaining({
        status: "running",
        processingAttempts: { increment: 1 },
        submissionGeneration: 1,
        leaseToken: "job_1:0",
      }),
    }));
  });

  it("does not steal a live lease or repeat an ambiguous submission", async () => {
    const active = transaction();
    active.fileExtraction.findUnique.mockResolvedValue(commandRow({
      status: "running",
      processingAttempts: 6,
      submissionGeneration: 1,
      submissionStartedAt: new Date(),
      startedAt: new Date(),
      externalTaskId: "task_1",
      leaseToken: "other:0",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }));
    await expect(createStore(active).beginDelivery("extraction_1", delivery, 6, 60_000))
      .resolves.toEqual({ kind: "busy" });
    expect(active.fileExtraction.update).not.toHaveBeenCalled();

    const ambiguous = transaction();
    ambiguous.fileExtraction.findUnique.mockResolvedValue(commandRow({
      status: "running",
      processingAttempts: 1,
      submissionGeneration: 1,
      submissionStartedAt: new Date(),
      startedAt: new Date(),
      externalTaskId: null,
      leaseToken: null,
      leaseExpiresAt: null,
    }));
    ambiguous.fileExtraction.update.mockResolvedValue({ id: "extraction_1" });
    await expect(createStore(ambiguous).beginDelivery("extraction_1", delivery, 6, 60_000))
      .resolves.toEqual({ kind: "terminal", outcome: "failed" });
    expect(ambiguous.fileExtraction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "failed",
        failureCode: "DOCLING_SUBMISSION_AMBIGUOUS",
        leaseToken: null,
      }),
    }));
  });

  it("checkpoints one immutable external task under the current lease", async () => {
    const tx = transaction();
    tx.fileExtraction.findUnique.mockResolvedValue({
      status: "running",
      leaseToken: "job_1:0",
      submissionGeneration: 1,
      externalTaskId: null,
    });
    const store = createStore(tx);

    await store.checkpointTask("extraction_1", "job_1:0", "task_1");

    expect(tx.fileExtraction.update).toHaveBeenCalledWith({
      where: { id: "extraction_1" },
      data: { externalTaskId: "task_1", taskCheckpointedAt: expect.any(Date) },
    });
  });

  it("rejects reuse of an active digest with another media type", async () => {
    const tx = transaction();
    tx.blob.findFirst.mockResolvedValue({
      id: "blob_existing",
      sha256: markdownSha,
      generation: 1,
      storageKey: `blobs/aa/aa/${markdownSha}/g1`,
      mediaType: "application/json",
      byteSize: 4n,
      status: "ready",
    });
    const store = createStore(tx);

    await expect(store.reserveOutputBlob({
      kind: "markdown",
      position: 0,
      sha256: markdownSha,
      byteSize: 4,
      mediaType: "text/markdown",
    })).rejects.toMatchObject({ code: "FILE_EXTRACTION_OUTPUT_IDENTITY_CONFLICT" });
  });

  it("publishes output Blobs, output rows, ready status, and currentExtraction in one transaction", async () => {
    const tx = transaction();
    tx.fileExtraction.findUnique.mockResolvedValue({
      id: "extraction_1",
      fileAssetId: "file_1",
      sourceBlobId: "blob_source",
      status: "running",
      leaseToken: "job_1:0",
      externalTaskId: "task_1",
      submissionGeneration: 1,
    });
    tx.fileAsset.findUnique.mockResolvedValue({
      status: "ready",
      blobId: "blob_source",
      currentExtraction: null,
    });
    tx.blob.findUnique
      .mockResolvedValueOnce(outputBlob("blob_markdown", markdownSha, "text/markdown", 12n))
      .mockResolvedValueOnce(outputBlob("blob_json", jsonSha, "application/json", 16n));
    tx.fileExtractionOutput.findMany.mockResolvedValue([]);
    tx.fileExtraction.update.mockResolvedValue({ attempt: 1 });
    const store = createStore(tx);
    const outputs = [
      reservation("markdown", "blob_markdown", markdownSha, "text/markdown", 12),
      reservation("docling_json", "blob_json", jsonSha, "application/json", 16),
    ];

    await expect(store.publishReady("extraction_1", "job_1:0", outputs, {
      taskId: "task_1",
      doclingStatus: "success",
      processingTimeSeconds: 1,
      errorCount: 0,
    })).resolves.toBe("ready");

    expect(tx.blob.update).toHaveBeenCalledTimes(2);
    expect(tx.fileExtractionOutput.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ kind: "markdown", blobId: "blob_markdown" }),
        expect.objectContaining({ kind: "docling_json", blobId: "blob_json" }),
      ]),
    }));
    expect(tx.fileExtraction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ready",
        contentSha256: markdownSha,
        leaseToken: null,
        metadata: expect.objectContaining({
          externalTaskId: "task_1",
          parserComponents: fileExtractionParserComponents,
        }),
      }),
    }));
    expect(tx.fileAsset.update).toHaveBeenCalledWith({
      where: { id: "file_1" },
      data: { currentExtractionId: "extraction_1", revision: { increment: 1 } },
    });
  });
});

function createStore(tx: ReturnType<typeof transaction>) {
  const db = { $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)) };
  return new PrismaExtractionStore(db as never, {
    canonicalBlobPrefix: "blobs",
    pendingBlobPrefix: "pending/blobs",
    doclingImageDigest: `sha256:${"c".repeat(64)}`,
    parserOptionsSha256: "d".repeat(64),
    parserComponents: fileExtractionParserComponents,
  });
}

function transaction() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    fileExtraction: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    fileExtractionOutput: {
      findMany: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    fileAsset: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    blob: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
}

function commandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "extraction_1",
    fileAssetId: "file_1",
    status: "queued",
    parser: fileExtractionParser,
    parserVersion: fileExtractionParserVersion,
    outputSchemaVersion: fileExtractionOutputSchemaVersion,
    processingAttempts: 0,
    submissionGeneration: 0,
    submissionStartedAt: null,
    externalTaskId: null,
    startedAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    file: {
      status: "ready",
      originalName: "source.pdf",
      blobId: "blob_source",
      detectedMediaType: "application/pdf",
    },
    sourceBlob: {
      id: "blob_source",
      storageKey: "blobs/source",
      sha256: "e".repeat(64),
      byteSize: 100n,
      mediaType: "application/pdf",
      status: "ready",
      deletedAt: null,
      scans: [{ status: "clean" }],
    },
    ...overrides,
  };
}

function outputBlob(id: string, sha256: string, mediaType: string, byteSize: bigint) {
  return {
    id,
    sha256,
    generation: 1,
    storageKey: `pending/${id}`,
    mediaType,
    byteSize,
    status: "pending",
  };
}

function reservation(
  kind: "markdown" | "docling_json",
  blobId: string,
  sha256: string,
  mediaType: string,
  byteSize: number,
) {
  return {
    kind,
    position: 0 as const,
    blobId,
    sha256,
    generation: 1,
    storageKey: `pending/${blobId}`,
    canonicalStorageKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g1`,
    storedMediaType: mediaType,
    mediaType,
    byteSize,
    status: "pending" as const,
  };
}

const delivery = { queueJobId: "job_1", retryCount: 0, retryLimit: 5 };
