import type {
  CompleteFileUploadRequest,
  CreateFileUploadRequest,
  FileAsset,
  FileExtraction,
  FileUploadSession,
} from "@workbench/workbench-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkbenchMultipartUpload,
  resumableUploadParts,
  sha256Blob,
  type WorkbenchFileTransferService,
  type WorkbenchUploadCheckpoint,
  type WorkbenchUploadCheckpointStore,
  type WorkbenchUploadPartTransport,
} from "./uppy-multipart";

const MEBIBYTE = 1024 * 1024;
const PART_SIZE = 5 * MEBIBYTE;
const CREATED_AT = "2026-07-12T00:00:00.000Z";

const queuedExtraction: FileExtraction = {
  id: "extraction-1",
  fileAssetId: "file-1",
  attempt: 1,
  status: "queued",
  parser: "docling",
  parserVersion: "1.0.0",
  outputSchemaVersion: 1,
  contentSha256: null,
  failure: null,
  startedAt: null,
  finishedAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const runningExtraction: FileExtraction = {
  ...queuedExtraction,
  status: "running",
  startedAt: "2026-07-12T00:00:01.000Z",
  updatedAt: "2026-07-12T00:00:01.000Z",
};

const readyExtraction: FileExtraction = {
  ...runningExtraction,
  status: "ready",
  contentSha256: "c".repeat(64),
  finishedAt: "2026-07-12T00:00:02.000Z",
  updatedAt: "2026-07-12T00:00:02.000Z",
};

const failedExtraction: FileExtraction = {
  ...runningExtraction,
  status: "failed",
  failure: { code: "PARSER_CRASHED", message: "Parser process exited" },
  finishedAt: "2026-07-12T00:00:02.000Z",
  updatedAt: "2026-07-12T00:00:02.000Z",
};

const unsupportedExtraction: FileExtraction = {
  ...runningExtraction,
  status: "unsupported",
  finishedAt: "2026-07-12T00:00:02.000Z",
  updatedAt: "2026-07-12T00:00:02.000Z",
};

function fileAsset(
  status: FileAsset["status"],
  extraction: FileExtraction | null = null,
): FileAsset {
  const ready = status === "ready";
  return {
    id: "file-1",
    projectId: "project-1",
    blobId: ready ? "blob-1" : null,
    originalName: "brief.pdf",
    declaredMediaType: "application/pdf",
    detectedMediaType: ready ? "application/pdf" : null,
    byteSize: PART_SIZE + MEBIBYTE,
    status,
    revision: status === "uploading" ? 0 : 1,
    sha256: ready ? "b".repeat(64) : null,
    failure: null,
    currentExtraction: extraction?.status === "ready" ? extraction : null,
    latestExtraction: extraction,
    verifiedAt: ready ? "2026-07-12T00:00:03.000Z" : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function uploadSession(status: FileUploadSession["status"]): FileUploadSession {
  return {
    id: "upload-1",
    fileAssetId: "file-1",
    status,
    partSize: PART_SIZE,
    revision: status === "initiated" ? 1 : 2,
    expiresAt: "2026-07-13T00:00:00.000Z",
  };
}

function testFile() {
  return new File([new Uint8Array(PART_SIZE + MEBIBYTE)], "brief.pdf", {
    type: "application/pdf",
    lastModified: 1_720_742_400_000,
  });
}

function createService({
  listedParts = [],
  lifecycle = [fileAsset("ready")],
}: {
  listedParts?: { partNumber: number; etag: string; byteSize: number }[];
  lifecycle?: FileAsset[];
} = {}) {
  let completed = false;
  const lifecycleQueue = [...lifecycle];
  let latestFile = lifecycleQueue.at(-1) ?? fileAsset("ready");
  const service = {
    createFileUpload: vi.fn(async (
      _projectId: string,
      _request: CreateFileUploadRequest,
      _idempotencyKey?: string,
    ) => ({
      value: { file: fileAsset("uploading"), upload: uploadSession("initiated") },
      etag: '"1"',
    })),
    getFile: vi.fn(async () => {
      latestFile = lifecycleQueue.shift() ?? latestFile;
      return { value: latestFile, etag: `"${latestFile.revision}"` };
    }),
    createFileExtraction: vi.fn(async () => ({ value: queuedExtraction, etag: '"2"' })),
    getFileUpload: vi.fn(async () => ({
      value: uploadSession(completed ? "completed" : "initiated"),
      etag: completed ? '"2"' : '"1"',
    })),
    abortFileUpload: vi.fn(async () => undefined),
    listFileUploadParts: vi.fn(async () => ({ parts: listedParts })),
    signFileUploadPart: vi.fn(async (
      uploadSessionId: string,
      partNumber: number,
      request: { contentLength: number },
    ) => ({
      value: {
        uploadSessionId,
        partNumber,
        method: "PUT" as const,
        url: `https://uploads.example.test/part-${partNumber}`,
        headers: { "content-length": String(request.contentLength) },
        expiresAt: "2026-07-12T01:00:00.000Z",
      },
      etag: '"1"',
    })),
    completeFileUpload: vi.fn(async (
      _uploadSessionId: string,
      _request: CompleteFileUploadRequest,
      _ifMatch: string,
      _idempotencyKey?: string,
    ) => {
      completed = true;
      return {
        value: { file: fileAsset("verifying"), upload: uploadSession("completed") },
        etag: '"2"',
      };
    }),
  } satisfies WorkbenchFileTransferService;
  return service;
}

function memoryCheckpointStore() {
  const values = new Map<string, WorkbenchUploadCheckpoint>();
  const history: WorkbenchUploadCheckpoint[] = [];
  const key = (projectId: string, fingerprint: string) => `${projectId}\0${fingerprint}`;
  const store = {
    async load(projectId, fingerprint) {
      return values.get(key(projectId, fingerprint)) ?? null;
    },
    async save(checkpoint) {
      const copy = structuredClone(checkpoint);
      values.set(key(checkpoint.projectId, checkpoint.fingerprint), copy);
      history.push(copy);
    },
    async remove(projectId, fingerprint) {
      values.delete(key(projectId, fingerprint));
    },
  } satisfies WorkbenchUploadCheckpointStore;
  return { store, history, values };
}

function successfulPartTransport(calls: Array<{ url: string; size: number }>): WorkbenchUploadPartTransport {
  return async (request) => {
    calls.push({ url: request.url, size: request.body.size });
    request.reportProgress(request.body.size);
    const partNumber = request.url.endsWith("part-1") ? 1 : 2;
    return { etag: `"etag-${partNumber}"` };
  };
}

type FakeXhrOptions = {
  autoRespond?: boolean;
  onSend?: (xhr: FakeXMLHttpRequest) => void;
  onAbort?: (xhr: FakeXMLHttpRequest) => void;
};

class FakeXMLHttpRequest {
  readonly upload = new EventTarget();
  readonly requestHeaders: Record<string, string> = {};
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  responseType: XMLHttpRequestResponseType = "";
  responseText = "";
  status = 0;
  timeout = 0;
  aborted = false;
  private readonly events = new EventTarget();

  constructor(private readonly options: FakeXhrOptions) {}

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.events.addEventListener(...args);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
    this.options.onSend?.(this);
    if (this.options.autoRespond !== false) queueMicrotask(() => this.respond());
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.options.onAbort?.(this);
    this.events.dispatchEvent(new Event("abort"));
  }

  getAllResponseHeaders() {
    const partNumber = this.url.endsWith("part-1") ? 1 : 2;
    return `etag: "xhr-etag-${partNumber}"\r\n`;
  }

  respond() {
    if (this.aborted) return;
    this.status = 200;
    this.events.dispatchEvent(new Event("load"));
  }
}

function installFakeXhr(options: FakeXhrOptions = {}) {
  const instances: FakeXMLHttpRequest[] = [];
  class InstalledFakeXMLHttpRequest extends FakeXMLHttpRequest {
    constructor() {
      super(options);
      instances.push(this);
    }
  }
  vi.stubGlobal("XMLHttpRequest", InstalledFakeXMLHttpRequest);
  return instances;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workbench Uppy multipart adapter", () => {
  it("uploads exact backend-sized parts, sends a final digest hint, and polls verification/extraction", async () => {
    const service = createService({
      lifecycle: [
        fileAsset("verifying"),
        fileAsset("ready"),
        fileAsset("ready", runningExtraction),
        fileAsset("ready", readyExtraction),
      ],
    });
    const { store, history, values } = memoryCheckpointStore();
    const partCalls: Array<{ url: string; size: number }> = [];
    const phases: string[] = [];
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      checkpointStore: store,
      requestExtraction: true,
      partTransport: successfulPartTransport(partCalls),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });
    upload.subscribe((snapshot) => phases.push(snapshot.phase));

    const result = await upload.start();

    expect(result.phase).toBe("ready");
    expect(result.file?.status).toBe("ready");
    expect(result.extraction?.status).toBe("ready");
    expect(result.clientSha256Hint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.hashPercent).toBe(100);
    expect(partCalls.map((part) => part.size).sort((a, b) => b - a))
      .toEqual([PART_SIZE, MEBIBYTE]);
    expect(service.signFileUploadPart.mock.calls.map((call) => call[2].contentLength).sort((a, b) => b - a))
      .toEqual([PART_SIZE, MEBIBYTE]);
    expect(service.completeFileUpload).toHaveBeenCalledTimes(1);
    const completion = service.completeFileUpload.mock.calls[0][1];
    expect(completion.parts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);
    expect(completion.sha256).toBe(result.clientSha256Hint);
    expect(service.createFileExtraction).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(expect.arrayContaining(["preparing", "uploading", "verifying", "extracting", "ready"]));
    expect(values.size).toBe(0);
    expect(JSON.stringify(history)).not.toMatch(/s3Multipart|PartNumber|providerUpload|stagingKey/);

    upload.destroy();
  }, 20_000);

  it("binds a durable SubmissionIntent slot with deterministic upload command keys", async () => {
    const service = createService({
      lifecycle: [
        fileAsset("ready"),
        fileAsset("ready", readyExtraction),
      ],
    });
    const submissionIntent = {
      submissionIntentId: "intent-1",
      attachmentPosition: 3,
      clientFingerprint: "submission-file:slot-1",
    };
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      submissionIntent,
      requestExtraction: true,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    expect(upload.getCheckpoint()).toMatchObject({
      fingerprint: expect.stringContaining("workbench-submission-file-v1"),
      createIdempotencyKey: "submission-upload:intent-1:3",
      completionIdempotencyKey: "submission-complete:intent-1:3",
      extractionIdempotencyKey: "submission-extract:intent-1:3",
      submissionIntent,
    });

    const result = await upload.start();

    expect(result.phase).toBe("ready");
    expect(service.createFileUpload).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ submissionIntent }),
      "submission-upload:intent-1:3",
    );
    expect(service.completeFileUpload.mock.calls[0][3])
      .toBe("submission-complete:intent-1:3");
    expect(service.createFileExtraction).toHaveBeenCalledWith(
      "file-1",
      '"1"',
      "submission-extract:intent-1:3",
    );

    upload.destroy();
  }, 20_000);

  it("replays a lost create response with the identical digest-bound command", async () => {
    const service = createService();
    const created = {
      value: { file: fileAsset("uploading"), upload: uploadSession("initiated") },
      etag: '"1"',
    };
    service.createFileUpload.mockRejectedValueOnce(new Error("create response lost"));
    service.createFileUpload.mockResolvedValue(created);
    const { store, history } = memoryCheckpointStore();
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      checkpointStore: store,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const first = await upload.start();
    expect(first).toMatchObject({ phase: "failed", error: { retryable: true } });
    expect(history.at(-1)?.clientSha256Hint).toMatch(/^[a-f0-9]{64}$/);

    const result = await upload.retry();

    expect(result.phase).toBe("ready");
    expect(service.createFileUpload).toHaveBeenCalledTimes(2);
    const firstCall = service.createFileUpload.mock.calls[0];
    const replayCall = service.createFileUpload.mock.calls[1];
    expect(firstCall[1]).toBe(replayCall[1]);
    expect(Object.isFrozen(firstCall[1])).toBe(true);
    expect(firstCall[1].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(replayCall[1]).toEqual(firstCall[1]);
    expect(replayCall[2]).toBe(firstCall[2]);

    upload.destroy();
  }, 20_000);

  it("restores a digest-proven pre-session checkpoint and safely replays create", async () => {
    const file = testFile();
    const digest = await sha256Blob(file);
    const seed = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service: createService(),
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
    });
    const checkpoint = seed.getCheckpoint();
    checkpoint.clientSha256Hint = digest;
    expect(checkpoint.session).toBeNull();
    seed.destroy();

    const service = createService();
    const restored = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service,
      checkpoint,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const result = await restored.start();

    expect(result.phase).toBe("ready");
    expect(service.createFileUpload).toHaveBeenCalledTimes(1);
    expect(service.createFileUpload).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ sha256: digest }),
      checkpoint.createIdempotencyKey,
    );

    restored.destroy();
  }, 20_000);

  it("restores an opaque checkpoint and skips provider-confirmed parts", async () => {
    const service = createService({
      listedParts: [{ partNumber: 1, etag: '"existing-1"', byteSize: PART_SIZE }],
    });
    const file = testFile();
    const pending = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
    });
    const checkpoint = pending.getCheckpoint();
    checkpoint.clientSha256Hint = await sha256Blob(file);
    checkpoint.session = {
      fileAssetId: "file-1",
      uploadSessionId: "upload-1",
      uploadEtag: '"1"',
      partSize: PART_SIZE,
      expiresAt: "2026-07-13T00:00:00.000Z",
    };
    pending.destroy();
    const partCalls: Array<{ url: string; size: number }> = [];
    const restored = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service,
      checkpoint,
      partTransport: successfulPartTransport(partCalls),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const result = await restored.start();

    expect(result.phase).toBe("ready");
    expect(service.createFileUpload).not.toHaveBeenCalled();
    expect(service.listFileUploadParts).toHaveBeenCalledWith("upload-1");
    expect(service.signFileUploadPart).toHaveBeenCalledTimes(1);
    expect(service.signFileUploadPart.mock.calls[0][1]).toBe(2);
    expect(partCalls).toEqual([{ url: "https://uploads.example.test/part-2", size: MEBIBYTE }]);
    expect(service.completeFileUpload.mock.calls[0][1].parts).toEqual([
      { partNumber: 1, etag: '"existing-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);

    restored.destroy();
  }, 20_000);

  it("replaces an expired server session with a fresh idempotent session", async () => {
    const file = testFile();
    const seed = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service: createService(),
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
    });
    const checkpoint = seed.getCheckpoint();
    checkpoint.clientSha256Hint = await sha256Blob(file);
    checkpoint.session = {
      fileAssetId: "file-1",
      uploadSessionId: "expired-upload",
      uploadEtag: '"4"',
      partSize: PART_SIZE,
      expiresAt: "2026-07-12T00:00:00.000Z",
    };
    seed.destroy();

    const service = createService();
    service.getFileUpload.mockResolvedValueOnce({
      value: { ...uploadSession("expired"), id: "expired-upload", fileAssetId: "file-1" },
      etag: '"4"',
    });
    const restored = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service,
      checkpoint,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const result = await restored.start();

    expect(result.phase).toBe("ready");
    expect(service.createFileUpload).toHaveBeenCalledTimes(1);
    expect(service.createFileUpload.mock.calls[0][2]).not.toBe(checkpoint.createIdempotencyKey);
    expect(service.abortFileUpload).toHaveBeenCalledWith("expired-upload", '"4"');
    restored.destroy();
  }, 20_000);

  it("re-uploads a listed part whose stored byte size is wrong", async () => {
    const service = createService({
      listedParts: [{ partNumber: 1, etag: '"stale-1"', byteSize: PART_SIZE - 1 }],
    });
    const partCalls: Array<{ url: string; size: number }> = [];
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      partTransport: successfulPartTransport(partCalls),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const result = await upload.start();

    expect(result.phase).toBe("ready");
    expect(partCalls.map((part) => part.size).sort((a, b) => b - a))
      .toEqual([PART_SIZE, MEBIBYTE]);
    expect(service.completeFileUpload.mock.calls[0][1].parts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);

    upload.destroy();
  }, 20_000);

  it("rejects provider parts outside the expected multipart range", () => {
    expect(() => resumableUploadParts(PART_SIZE + MEBIBYTE, PART_SIZE, [{
      partNumber: 3,
      etag: '"unexpected-3"',
      byteSize: MEBIBYTE,
    }])).toThrow(/unexpected part 3/);
  });

  it("rejects a same-metadata File with different bytes before listing persisted parts", async () => {
    const service = createService({
      listedParts: [{ partNumber: 1, etag: '"existing-1"', byteSize: PART_SIZE }],
    });
    const file = testFile();
    const pending = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
    });
    const checkpoint = pending.getCheckpoint();
    checkpoint.clientSha256Hint = "a".repeat(64);
    checkpoint.session = {
      fileAssetId: "file-1",
      uploadSessionId: "upload-1",
      uploadEtag: '"1"',
      partSize: PART_SIZE,
      expiresAt: "2026-07-13T00:00:00.000Z",
    };
    pending.destroy();
    const restored = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file,
      service,
      checkpoint,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
    });

    const result = await restored.start();

    expect(result.phase).toBe("failed");
    expect(result.error).toMatchObject({
      code: "UPLOAD_CHECKPOINT_MISMATCH",
      retryable: false,
    });
    expect(service.abortFileUpload).toHaveBeenCalledWith("upload-1", '"1"');
    expect(service.listFileUploadParts).not.toHaveBeenCalled();
    expect(service.signFileUploadPart).not.toHaveBeenCalled();
    expect(service.completeFileUpload).not.toHaveBeenCalled();

    restored.destroy();
  }, 20_000);

  it("keeps the server multipart session after an exhausted transfer error and retries it", async () => {
    const service = createService();
    let fail = true;
    const transport: WorkbenchUploadPartTransport = async (request) => {
      if (fail) throw new Error("temporary object-store failure");
      request.reportProgress(request.body.size);
      return { etag: request.url.endsWith("part-1") ? '"etag-1"' : '"etag-2"' };
    };
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      partTransport: transport,
      concurrency: 1,
      retryDelays: [],
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const first = await upload.start();
    expect(first.phase).toBe("failed");
    expect(first.error?.retryable).toBe(true);
    expect(service.abortFileUpload).not.toHaveBeenCalled();

    fail = false;
    const retried = await upload.retry();
    expect(retried.phase).toBe("ready");
    expect(service.getFileUpload).toHaveBeenCalled();
    expect(service.completeFileUpload).toHaveBeenCalledTimes(1);
    expect(service.abortFileUpload).not.toHaveBeenCalled();

    upload.destroy();
  }, 20_000);

  it("uses Uppy default XHR transport, reads exposed ETags, and completes multipart", async () => {
    const requests = installFakeXhr();
    const service = createService();
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      retryDelays: [],
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const result = await upload.start();

    expect(result.phase).toBe("ready");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === "PUT")).toBe(true);
    expect(service.completeFileUpload.mock.calls[0][1].parts).toEqual([
      { partNumber: 1, etag: '"xhr-etag-1"' },
      { partNumber: 2, etag: '"xhr-etag-2"' },
    ]);

    upload.destroy();
  }, 20_000);

  it.each([
    ["failed", failedExtraction, "PARSER_CRASHED"],
    ["unsupported", unsupportedExtraction, "FILE_EXTRACTION_UNSUPPORTED"],
  ] as const)("projects %s extraction as an explicit terminal failure", async (
    _status,
    extraction,
    expectedCode,
  ) => {
    const service = createService({ lifecycle: [fileAsset("ready", extraction)] });
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      requestExtraction: true,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const result = await upload.start();

    expect(result).toMatchObject({
      phase: "failed",
      extraction: { status: extraction.status },
      error: { code: expectedCode, retryable: false },
    });
    expect(service.createFileExtraction).not.toHaveBeenCalled();
    await expect(upload.retry()).rejects.toThrow(/terminal/);

    upload.destroy();
  }, 20_000);

  it("projects pause/resume state and continues from the same upload session", async () => {
    const service = createService();
    let first = true;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const transport: WorkbenchUploadPartTransport = async (request) => {
      if (first) {
        first = false;
        notifyStarted();
        await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new DOMException("paused", "AbortError"));
          }, { once: true });
        });
      }
      request.reportProgress(request.body.size);
      return { etag: request.url.endsWith("part-1") ? '"etag-1"' : '"etag-2"' };
    };
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      partTransport: transport,
      concurrency: 1,
      retryDelays: [],
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const completion = upload.start();
    await started;
    expect(upload.pause()).toBe(true);
    expect(upload.getSnapshot().phase).toBe("paused");
    expect(upload.resume()).toBe(true);

    const result = await completion;
    expect(result.phase).toBe("ready");
    expect(service.listFileUploadParts).toHaveBeenCalled();
    expect(service.createFileUpload).toHaveBeenCalledTimes(1);

    upload.destroy();
  }, 20_000);

  it("cancels during digest preparation without creating or aborting a server session", async () => {
    const service = createService();
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
    });

    const completion = upload.start();
    await upload.cancel();
    const result = await completion;

    expect(result.phase).toBe("cancelled");
    expect(service.createFileUpload).not.toHaveBeenCalled();
    expect(service.abortFileUpload).not.toHaveBeenCalled();

    upload.destroy();
  }, 20_000);

  it("stops Uppy default XHR before issuing the server abort command", async () => {
    const events: string[] = [];
    let notifySent!: () => void;
    const sent = new Promise<void>((resolve) => { notifySent = resolve; });
    let firstSend = true;
    installFakeXhr({
      autoRespond: false,
      onSend() {
        if (!firstSend) return;
        firstSend = false;
        notifySent();
      },
      onAbort() {
        events.push("xhr-abort");
      },
    });
    const service = createService();
    service.abortFileUpload.mockImplementation(async () => {
      events.push("server-abort");
    });
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      concurrency: 1,
      retryDelays: [],
      pollIntervalMs: 100,
    });

    const completion = upload.start();
    await sent;
    await upload.cancel();
    const result = await completion;

    expect(result.phase).toBe("cancelled");
    expect(events).toEqual(["xhr-abort", "server-abort"]);

    upload.destroy();
  }, 20_000);

  it("preserves a checkpoint after abort failure and lets cancel retry cleanup", async () => {
    const service = createService();
    let abortAttempts = 0;
    service.abortFileUpload.mockImplementation(async () => {
      abortAttempts += 1;
      if (abortAttempts === 1) throw new Error("abort service unavailable");
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const transport: WorkbenchUploadPartTransport = async (request) => {
      notifyStarted();
      await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
      throw new Error("unreachable");
    };
    const { store, values } = memoryCheckpointStore();
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      checkpointStore: store,
      partTransport: transport,
      concurrency: 1,
      retryDelays: [],
      pollIntervalMs: 100,
    });

    const completion = upload.start();
    await started;
    await expect(upload.cancel()).rejects.toThrow("abort service unavailable");
    const failed = await completion;

    expect(failed).toMatchObject({
      phase: "failed",
      error: { code: "UPLOAD_CANCEL_FAILED", retryable: true },
    });
    expect(values.size).toBe(1);
    await expect(upload.retry()).rejects.toThrow(/after cancellation/);

    await upload.cancel();
    expect(upload.getSnapshot().phase).toBe("cancelled");
    expect(service.abortFileUpload).toHaveBeenCalledTimes(2);
    expect(values.size).toBe(0);

    upload.destroy();
  }, 20_000);

  it("rejects cancellation after completion starts and finishes deterministically", async () => {
    const service = createService();
    let notifyCompleteStarted!: () => void;
    const completeStarted = new Promise<void>((resolve) => { notifyCompleteStarted = resolve; });
    let releaseComplete!: () => void;
    const completeGate = new Promise<void>((resolve) => { releaseComplete = resolve; });
    service.completeFileUpload.mockImplementation(async () => {
      notifyCompleteStarted();
      await completeGate;
      return {
        value: { file: fileAsset("verifying"), upload: uploadSession("completed") },
        etag: '"2"',
      };
    });
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      partTransport: successfulPartTransport([]),
      pollIntervalMs: 100,
      sleep: async () => undefined,
    });

    const completion = upload.start();
    await completeStarted;
    await expect(upload.cancel()).rejects.toThrow(/removed through the File delete command/);
    expect(service.abortFileUpload).not.toHaveBeenCalled();
    releaseComplete();

    const result = await completion;
    expect(result.phase).toBe("ready");
    expect(service.completeFileUpload).toHaveBeenCalledTimes(1);

    upload.destroy();
  }, 20_000);

  it("aborts the server only for explicit cancellation", async () => {
    const service = createService();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const transport: WorkbenchUploadPartTransport = async (request) => {
      notifyStarted();
      await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
      throw new Error("unreachable");
    };
    const upload = await createWorkbenchMultipartUpload({
      projectId: "project-1",
      file: testFile(),
      service,
      partTransport: transport,
      concurrency: 1,
      retryDelays: [],
      pollIntervalMs: 100,
    });

    const completion = upload.start();
    await started;
    await upload.cancel();
    const result = await completion;

    expect(result.phase).toBe("cancelled");
    expect(service.abortFileUpload).toHaveBeenCalledWith("upload-1", '"1"');
    upload.destroy();
  }, 20_000);
});
