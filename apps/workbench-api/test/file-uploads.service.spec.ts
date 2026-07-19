import { maximumUserUploadByteSize } from "@workbench/workbench-contracts";
import { hashRequest } from "../src/common/idempotency.js";
import { FileApiConfig } from "../src/modules/files/file-api.config.js";
import {
  choosePartSize,
  expectedPartLength,
  FileUploadsService,
  validateCompletedParts,
} from "../src/modules/files/file-uploads.service.js";
import type { MultipartStoragePort } from "../src/platform/object-storage/object-storage.port.js";

const MEBIBYTE = 1024 * 1024;
const now = new Date("2026-07-12T08:00:00.000Z");
const future = new Date(Date.now() + 60 * 60 * 1_000);

function fileRecord(status: "uploading" | "verifying" | "failed" = "uploading") {
  return {
    id: "file_1",
    projectId: "project_1",
    blobId: null,
    originalName: "requirements.pdf",
    declaredMediaType: "application/pdf",
    detectedMediaType: null,
    byteSize: 1_024n,
    status,
    revision: status === "verifying" ? 1 : 0,
    failureCode: status === "failed" ? "UPLOAD_FAILED" : null,
    failureDetail: null,
    verifiedAt: null,
    createdAt: now,
    updatedAt: now,
    blob: null,
    currentExtraction: null,
    extractions: [],
  };
}

function uploadBundle(
  status: "initiating" | "initiated" | "completing" | "completed" | "aborting" | "aborted" | "failed" = "initiated",
) {
  return {
    id: "upload_1",
    projectId: "project_1",
    fileAssetId: "file_1",
    providerUploadId: status === "initiating" ? null : "provider_1",
    stagingKey: "staging/files/project_1/upload_1",
    status,
    expectedByteSize: 1_024n,
    expectedSha256: null,
    partSize: 8 * MEBIBYTE,
    revision: status === "initiated" ? 1 : status === "completing" ? 2 : status === "completed" ? 3 : 1,
    idempotencyKey: "create-key-1",
    requestHash: hashRequest({
      fileName: "requirements.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    }),
    completionIdempotencyKey: ["completing", "completed"].includes(status) ? "complete-key-1" : null,
    completionRequestHash: ["completing", "completed"].includes(status)
      ? hashRequest({ parts: [{ partNumber: 1, etag: '"etag-1"' }] })
      : null,
    expiresAt: future,
    file: fileRecord(status === "completed" ? "verifying" : status === "failed" ? "failed" : "uploading"),
  };
}

function objectStorage(): MultipartStoragePort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: "provider_1" }),
    signMultipartPart: vi.fn().mockResolvedValue({
      url: "https://uploads.example.com/object?signature=opaque",
      headers: {},
      expiresAt: future,
    }),
    listMultipartParts: vi.fn().mockResolvedValue([]),
    completeMultipartUpload: vi.fn().mockResolvedValue(undefined),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    statObject: vi.fn().mockResolvedValue(null),
  } as never;
}

function config(): FileApiConfig {
  return {
    stagingPrefix: "staging/files",
    preferredPartSize: 8 * MEBIBYTE,
    sessionTtlSeconds: 86_400,
    signedUrlTtlSeconds: 900,
  } as FileApiConfig;
}

function database() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
    projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
    fileUploadSession: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    fileAsset: { create: vi.fn(), updateMany: vi.fn() },
    submissionIntentAttachment: { updateMany: vi.fn() },
  };
  const db = {
    project: { findFirst: vi.fn() },
    fileUploadSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    fileAsset: { updateMany: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { db, tx };
}

describe("FileUploadsService", () => {
  it("creates one durable upload receipt before initializing opaque S3 multipart state", async () => {
    const { db, tx } = database();
    const storage = objectStorage();
    const queue = { sendInTransaction: vi.fn() };
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.fileUploadSession.findUnique.mockResolvedValue(null);
    db.fileUploadSession.findFirst.mockResolvedValue(uploadBundle());
    tx.fileUploadSession.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(uploadBundle("initiating"));
    tx.fileUploadSession.updateMany.mockResolvedValue({ count: 1 });
    const service = new FileUploadsService(db as never, storage, queue as never, config());
    const request = {
      fileName: "requirements.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    };

    await expect(service.create("principal_1", "project_1", "create-key-1", request)).resolves.toMatchObject({
      file: { id: "file_1", status: "uploading" },
      upload: { id: "upload_1", status: "initiated", revision: 1 },
    });
    expect(tx.fileAsset.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ projectId: "project_1", uploadedById: "principal_1", byteSize: 1_024n }),
    }));
    expect(tx.fileUploadSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: "project_1",
        idempotencyKey: "create-key-1",
        expectedSha256: null,
        status: "initiating",
      }),
    }));
    expect(storage.createMultipartUpload).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/^staging\/files\/project_1\/upload_/),
      mediaType: "application/pdf",
    }));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("uses a uniform 404 boundary before reading or creating provider state", async () => {
    const { db } = database();
    const storage = objectStorage();
    db.project.findFirst.mockResolvedValue(null);
    const service = new FileUploadsService(db as never, storage, {} as never, config());

    await expect(service.create("principal_other", "project_1", "create-key-1", {
      fileName: "requirements.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    })).rejects.toMatchObject({ status: 404 });
    expect(db.fileUploadSession.findUnique).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("locks and atomically binds an opaque SubmissionIntent upload slot", async () => {
    const { db, tx } = database();
    const storage = objectStorage();
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.fileUploadSession.findUnique.mockResolvedValue(null);
    db.fileUploadSession.findFirst.mockResolvedValue({
      ...uploadBundle(),
      file: {
        ...fileRecord(),
        originalName: "中文 需求稿.pdf",
      },
    });
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: "project_1", revision: 0 }])
      .mockResolvedValueOnce([{
        intentId: "intent_1",
        projectId: "project_1",
        createdById: "principal_1",
        status: "pending",
        kind: "upload",
        fileAssetId: null,
        clientFingerprint: "submission-file:slot_1",
        fileName: "中文 需求稿.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 1_024n,
      }])
      .mockResolvedValue([]);
    tx.fileUploadSession.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...uploadBundle("initiating"),
        file: {
          ...fileRecord(),
          originalName: "中文 需求稿.pdf",
        },
      });
    tx.fileUploadSession.updateMany.mockResolvedValue({ count: 1 });
    tx.submissionIntentAttachment.updateMany.mockResolvedValue({ count: 1 });
    const service = new FileUploadsService(
      db as never,
      storage,
      { sendInTransaction: vi.fn() } as never,
      config(),
    );
    const request = {
      fileName: "中文 需求稿.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
      submissionIntent: {
        submissionIntentId: "intent_1",
        attachmentPosition: 0,
        clientFingerprint: "submission-file:slot_1",
      },
    };

    await expect(service.create("principal_1", "project_1", "binding-key-1", request))
      .resolves.toMatchObject({ file: { originalName: "中文 需求稿.pdf" } });
    expect(tx.submissionIntentAttachment.updateMany).toHaveBeenCalledWith({
      where: {
        submissionIntentId: "intent_1",
        position: 0,
        kind: "upload",
        fileAssetId: null,
        clientFingerprint: "submission-file:slot_1",
      },
      data: { fileAssetId: expect.stringMatching(/^file_/) },
    });
    expect(tx.fileAsset.create).toHaveBeenCalledBefore(tx.submissionIntentAttachment.updateMany);
    expect(storage.createMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it("rejects an upload whose metadata does not match the durable slot", async () => {
    const { db, tx } = database();
    const storage = objectStorage();
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.fileUploadSession.findUnique.mockResolvedValue(null);
    tx.fileUploadSession.findUnique.mockResolvedValue(null);
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: "project_1", revision: 0 }])
      .mockResolvedValueOnce([{
        intentId: "intent_1",
        projectId: "project_1",
        createdById: "principal_1",
        status: "pending",
        kind: "upload",
        fileAssetId: null,
        clientFingerprint: "submission-file:slot_1",
        fileName: "expected.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 1_024n,
      }]);
    const service = new FileUploadsService(db as never, storage, {} as never, config());

    await expect(service.create("principal_1", "project_1", "binding-key-2", {
      fileName: "different.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
      submissionIntent: {
        submissionIntentId: "intent_1",
        attachmentPosition: 0,
        clientFingerprint: "submission-file:slot_1",
      },
    })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "SUBMISSION_INTENT_UPLOAD_BINDING_MISMATCH" }),
    });
    expect(tx.fileAsset.create).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("replays a completed create receipt and rejects reuse with another body", async () => {
    const { db } = database();
    const storage = objectStorage();
    const existing = uploadBundle();
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.fileUploadSession.findUnique.mockResolvedValue(existing);
    const service = new FileUploadsService(db as never, storage, {} as never, config());

    await expect(service.create("principal_1", "project_1", "create-key-1", {
      fileName: "requirements.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    })).resolves.toMatchObject({ upload: { id: "upload_1" } });
    await expect(service.create("principal_1", "project_1", "create-key-1", {
      fileName: "other.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    })).rejects.toMatchObject({ status: 409 });
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("recovers a durable initiating receipt after a prior process or provider failure", async () => {
    const { db, tx } = database();
    const objectStore = objectStorage();
    const initiating = uploadBundle("initiating");
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.fileUploadSession.findUnique.mockResolvedValue(initiating);
    db.fileUploadSession.findFirst.mockResolvedValue(uploadBundle("initiated"));
    tx.fileUploadSession.findUnique.mockResolvedValue(initiating);
    tx.fileUploadSession.updateMany.mockResolvedValue({ count: 1 });
    objectStore.createMultipartUpload
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ uploadId: "provider_1" });
    const service = new FileUploadsService(db as never, objectStore, {} as never, config());
    const request = {
      fileName: "requirements.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    };

    await expect(service.create("principal_1", "project_1", "create-key-1", request))
      .rejects.toMatchObject({ status: 502 });
    await expect(service.create("principal_1", "project_1", "create-key-1", request))
      .resolves.toMatchObject({ upload: { status: "initiated" } });
    expect(objectStore.createMultipartUpload).toHaveBeenCalledTimes(2);
    expect(tx.fileUploadSession.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it("signs only the exact expected part length without changing the upload revision", async () => {
    const { db, tx } = database();
    const storage = objectStorage();
    const upload = { ...uploadBundle(), expectedByteSize: 10n * BigInt(MEBIBYTE) };
    db.fileUploadSession.findFirst.mockResolvedValue(upload);
    tx.fileUploadSession.findUnique.mockResolvedValue(upload);
    const service = new FileUploadsService(db as never, storage, {} as never, config());

    await expect(service.signPart("principal_1", "upload_1", 2, 1, 2 * MEBIBYTE)).resolves.toMatchObject({
      revision: 1,
      response: { uploadSessionId: "upload_1", partNumber: 2, method: "PUT" },
    });
    await expect(service.signPart("principal_1", "upload_1", 2, 1, MEBIBYTE)).rejects.toMatchObject({ status: 400 });
    expect(db.fileUploadSession.updateMany).not.toHaveBeenCalled();
    expect(storage.signMultipartPart).toHaveBeenCalledTimes(1);
  });

  it("does not sign storage parts after the Project member is demoted to viewer", async () => {
    const { db, tx } = database();
    const storage = objectStorage();
    db.fileUploadSession.findFirst.mockResolvedValue(uploadBundle());
    tx.projectMember.findUnique.mockResolvedValue({ role: "viewer" });
    const service = new FileUploadsService(db as never, storage, {} as never, config());

    await expect(service.signPart("principal_1", "upload_1", 1, 1, 1_024))
      .rejects.toMatchObject({ status: 404 });
    expect(tx.fileUploadSession.findUnique).not.toHaveBeenCalled();
    expect(storage.signMultipartPart).not.toHaveBeenCalled();
  });

  it("completes exact provider-confirmed parts and atomically queues trusted byte verification", async () => {
    const { db, tx } = database();
    const storage = objectStorage();
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    const initiated = uploadBundle("initiated");
    const completionRequest = {
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
      sha256: "c".repeat(64),
    };
    const completionRequestHash = hashRequest(completionRequest);
    const completing = { ...uploadBundle("completing"), completionRequestHash, expectedSha256: completionRequest.sha256 };
    const completed = { ...uploadBundle("completed"), completionRequestHash, expectedSha256: completionRequest.sha256 };
    db.fileUploadSession.findFirst
      .mockResolvedValueOnce(initiated)
      .mockResolvedValueOnce(completing)
      .mockResolvedValueOnce(completed);
    db.fileUploadSession.updateMany.mockResolvedValue({ count: 1 });
    storage.listMultipartParts.mockResolvedValue([{ partNumber: 1, etag: '"etag-1"', byteSize: 1_024 }]);
    storage.statObject
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ byteSize: 1_024, mediaType: "application/pdf", etag: '"multipart"' });
    tx.fileUploadSession.updateMany.mockResolvedValue({ count: 1 });
    tx.fileAsset.updateMany.mockResolvedValue({ count: 1 });
    const service = new FileUploadsService(db as never, storage, queue as never, config());

    await expect(service.complete("principal_1", "upload_1", 1, "complete-key-1", completionRequest)).resolves.toMatchObject({
      file: { id: "file_1", status: "verifying" },
      upload: { id: "upload_1", status: "completed", revision: 3 },
    });
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith({
      key: initiated.stagingKey,
      uploadId: "provider_1",
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    });
    expect(tx.fileUploadSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ expectedSha256: completionRequest.sha256 }),
    }));
    expect(queue.sendInTransaction).toHaveBeenCalledWith(
      tx,
      "file.verify",
      { uploadSessionId: "upload_1" },
      { singletonKey: "upload_1" },
    );
  });

  it("replays the persistent completion receipt without calling S3 or queueing twice", async () => {
    const { db } = database();
    const storage = objectStorage();
    db.fileUploadSession.findFirst.mockResolvedValue(uploadBundle("completed"));
    const queue = { sendInTransaction: vi.fn() };
    const service = new FileUploadsService(db as never, storage, queue as never, config());

    await expect(service.complete("principal_1", "upload_1", 1, "complete-key-1", {
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    })).resolves.toMatchObject({ upload: { status: "completed" } });
    expect(storage.listMultipartParts).not.toHaveBeenCalled();
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("rejects completion when provider parts differ from the immutable request", async () => {
    const { db } = database();
    const storage = objectStorage();
    db.fileUploadSession.findFirst.mockResolvedValue(uploadBundle());
    storage.listMultipartParts.mockResolvedValue([{ partNumber: 1, etag: '"different"', byteSize: 1_024 }]);
    const service = new FileUploadsService(db as never, storage, {} as never, config());

    await expect(service.complete("principal_1", "upload_1", 1, "complete-key-1", {
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    })).rejects.toMatchObject({ status: 400 });
    expect(db.fileUploadSession.updateMany).not.toHaveBeenCalled();
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("aborts provider state and persists an idempotent terminal receipt", async () => {
    const { db, tx } = database();
    const storage = objectStorage();
    db.fileUploadSession.findFirst
      .mockResolvedValueOnce(uploadBundle("initiated"))
      .mockResolvedValueOnce(uploadBundle("aborting"));
    db.fileUploadSession.updateMany.mockResolvedValue({ count: 1 });
    tx.fileUploadSession.updateMany.mockResolvedValue({ count: 1 });
    tx.fileAsset.updateMany.mockResolvedValue({ count: 1 });
    const service = new FileUploadsService(db as never, storage, {} as never, config());

    await expect(service.abort("principal_1", "upload_1", 1)).resolves.toBeUndefined();
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith({
      key: "staging/files/project_1/upload_1",
      uploadId: "provider_1",
    });
    expect(tx.fileUploadSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "aborted" }),
    }));
  });
});

describe("multipart sizing", () => {
  it("chooses legal multipart chunks within the bounded product upload ceiling", () => {
    const size = choosePartSize(maximumUserUploadByteSize, 8 * MEBIBYTE);
    expect(size).toBe(8 * MEBIBYTE);
    expect(Math.ceil(maximumUserUploadByteSize / size)).toBeLessThanOrEqual(10_000);
    expect(size % MEBIBYTE).toBe(0);
  });

  it("computes final part length and rejects missing, extra, reordered, or wrong-size parts", () => {
    expect(expectedPartLength(10 * MEBIBYTE, 8 * MEBIBYTE, 2)).toBe(2 * MEBIBYTE);
    expect(() => expectedPartLength(10 * MEBIBYTE, 8 * MEBIBYTE, 3)).toThrow();
    expect(() => validateCompletedParts(
      [{ partNumber: 1, etag: '"one"' }, { partNumber: 2, etag: '"two"' }],
      [
        { partNumber: 1, etag: '"one"', byteSize: 8 * MEBIBYTE },
        { partNumber: 2, etag: '"two"', byteSize: MEBIBYTE },
      ],
      10 * MEBIBYTE,
      8 * MEBIBYTE,
    )).toThrow();
  });
});
