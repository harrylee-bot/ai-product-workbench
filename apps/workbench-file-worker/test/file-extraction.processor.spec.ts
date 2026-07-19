import { Readable } from "node:stream";
import { FileExtractionProcessor } from "../src/extraction/file-extraction.processor.js";
import { TerminalExtractionError } from "../src/extraction/extraction.errors.js";

describe("FileExtractionProcessor", () => {
  it("submits once, checkpoints before polling, and publishes both normalized outputs", async () => {
    const { processor, store, storage, parser, start } = fixture();

    await expect(processor.extract(start)).resolves.toBe("ready");

    expect(parser.submit).toHaveBeenCalledTimes(1);
    expect(store.checkpointTask).toHaveBeenCalledWith("extraction_1", "job_1:0", "task_1");
    expect(parser.poll).toHaveBeenCalledWith("task_1", undefined);
    expect(parser.result).toHaveBeenCalledWith("task_1", undefined);
    expect(store.reserveOutputBlob).toHaveBeenCalledTimes(2);
    expect(storage.putContentAddressed).toHaveBeenCalledTimes(2);
    expect(store.publishReady).toHaveBeenCalledWith(
      "extraction_1",
      "job_1:0",
      expect.arrayContaining([
        expect.objectContaining({ kind: "markdown" }),
        expect.objectContaining({ kind: "docling_json" }),
      ]),
      expect.objectContaining({ taskId: "task_1", doclingStatus: "success" }),
    );
  });

  it("resumes an existing task without reading or resubmitting the source", async () => {
    const { processor, start, storage, parser } = fixture();
    start.needsSubmission = false;
    start.command.externalTaskId = "task_existing";

    await expect(processor.extract(start)).resolves.toBe("ready");

    expect(storage.getObject).not.toHaveBeenCalled();
    expect(parser.submit).not.toHaveBeenCalled();
    expect(parser.poll).toHaveBeenCalledWith("task_existing", undefined);
    expect(parser.result).toHaveBeenCalledWith("task_existing", undefined);
  });

  it("does not publish incomplete, empty, or oversized parser output", async () => {
    const empty = fixture();
    empty.parser.result.mockResolvedValue({
      markdown: " \r\n",
      doclingJson: { schema_name: "DoclingDocument" },
      status: "success",
      processingTimeSeconds: 1,
      errorCount: 0,
    });
    await expect(empty.processor.extract(empty.start)).rejects.toMatchObject({
      terminalStatus: "unsupported",
      code: "EXTRACTION_EMPTY_CONTENT",
    });
    expect(empty.store.publishReady).not.toHaveBeenCalled();

    const oversized = fixture(8);
    await expect(oversized.processor.extract(oversized.start)).rejects.toMatchObject({
      code: "FILE_EXTRACTION_OUTPUT_SIZE_LIMIT_EXCEEDED",
    });
    expect(oversized.storage.putContentAddressed).not.toHaveBeenCalled();
  });

  it("propagates terminal task loss without submitting a replacement", async () => {
    const { processor, start, parser } = fixture();
    start.needsSubmission = false;
    start.command.externalTaskId = "task_lost";
    parser.poll.mockRejectedValue(new TerminalExtractionError(
      "failed",
      "DOCLING_TASK_LOST",
      "lost",
    ));

    await expect(processor.extract(start)).rejects.toMatchObject({ code: "DOCLING_TASK_LOST" });
    expect(parser.submit).not.toHaveBeenCalled();
  });
});

function fixture(maximumOutputBytes = 1024 ** 2) {
  const store = {
    checkpointTask: vi.fn().mockResolvedValue(undefined),
    reserveOutputBlob: vi.fn(async (identity: Record<string, unknown>) => ({
      ...identity,
      blobId: `blob_${identity.kind}`,
      generation: 1,
      storageKey: `pending/${identity.kind}`,
      canonicalStorageKey: `blobs/${identity.kind}`,
      storedMediaType: identity.mediaType,
      status: "pending",
    })),
    publishReady: vi.fn().mockResolvedValue("ready"),
  };
  const sourceBytes = Buffer.from("source");
  const storage = {
    getObject: vi.fn().mockResolvedValue({
      body: Readable.from([sourceBytes]),
      byteSize: sourceBytes.byteLength,
      mediaType: "text/plain",
    }),
    putContentAddressed: vi.fn().mockResolvedValue(undefined),
  };
  const parser = {
    optionsSha256: "a".repeat(64),
    submit: vi.fn().mockResolvedValue("task_1"),
    poll: vi.fn().mockResolvedValue({ state: "succeeded" }),
    result: vi.fn().mockResolvedValue({
      markdown: "# Source\r\n",
      doclingJson: { schema_name: "DoclingDocument", version: "1.0.0" },
      status: "success",
      processingTimeSeconds: 1,
      errorCount: 0,
    }),
  };
  const start = {
    kind: "run" as const,
    leaseToken: "job_1:0",
    needsSubmission: true,
    command: {
      id: "extraction_1",
      fileAssetId: "file_1",
      status: "running" as const,
      parser: "docling-serve",
      parserVersion: "docling-serve/1.26.0+docling/2.107.0+core/2.85.0+parse/7.2.0",
      outputSchemaVersion: 1,
      processingAttempts: 1,
      submissionGeneration: 1,
      startedAt: new Date(),
      externalTaskId: null as string | null,
      source: {
        storageKey: "blobs/source",
        sha256: "source-sha",
        byteSize: sourceBytes.byteLength,
        mediaType: "text/plain",
        fileName: "source.txt",
      },
    },
  };
  return {
    store,
    storage,
    parser,
    start,
    processor: new FileExtractionProcessor(store as never, storage as never, parser as never, maximumOutputBytes, 60_000),
  };
}
