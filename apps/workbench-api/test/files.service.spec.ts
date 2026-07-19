import { Readable } from "node:stream";
import { FileApiConfig } from "../src/modules/files/file-api.config.js";
import {
  decodeFileCursor,
  encodeFileCursor,
  FilesService,
} from "../src/modules/files/files.service.js";
import { entityTagMatches, parseByteRange } from "../src/common/byte-content.js";
import type { ReadyBlobStoragePort } from "../src/platform/object-storage/object-storage.port.js";

const createdAt = new Date("2026-07-12T08:00:00.000Z");
const sha256 = "a".repeat(64);

function extraction(status: "queued" | "running" | "ready" = "queued") {
  return {
    id: "extraction_1",
    fileAssetId: "file_1",
    attempt: 1,
    status,
    parser: "docling",
    parserVersion: "2.0.0",
    outputSchemaVersion: 1,
    contentSha256: status === "ready" ? "b".repeat(64) : null,
    failureCode: null,
    failureDetail: null,
    startedAt: status === "queued" ? null : createdAt,
    finishedAt: status === "ready" ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
  };
}

function readyFile() {
  return {
    id: "file_1",
    projectId: "project_1",
    blobId: "blob_1",
    originalName: "knowledge.txt",
    declaredMediaType: "text/plain",
    detectedMediaType: "text/plain",
    byteSize: 10n,
    status: "ready" as const,
    revision: 4,
    failureCode: null,
    failureDetail: null,
    verifiedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    blob: { sha256, status: "ready" as const, deletedAt: null },
    currentExtraction: null,
    extractions: [],
  };
}

function storage(): ReadyBlobStoragePort & { getObject: ReturnType<typeof vi.fn> } {
  return {
    getObject: vi.fn().mockResolvedValue({
      body: Readable.from("0123456789"),
      byteSize: 10,
      mediaType: "text/plain",
      contentRange: null,
    }),
  } as never;
}

function config(): FileApiConfig {
  return {
    parser: "docling",
    parserVersion: "2.0.0",
    extractionSchemaVersion: 1,
  } as FileApiConfig;
}

function database() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
    projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
    fileAsset: { findUnique: vi.fn() },
    fileExtraction: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  };
  const db = {
    project: { findFirst: vi.fn() },
    fileAsset: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    fileExtraction: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { db, tx };
}

describe("FilesService", () => {
  it("lists only non-deleted Files through an active project membership boundary", async () => {
    const { db } = database();
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.fileAsset.findMany.mockResolvedValue([readyFile()]);
    const service = new FilesService(db as never, storage(), {} as never, config());

    await expect(service.list("principal_1", "project_1")).resolves.toEqual({
      items: [expect.objectContaining({ id: "file_1", status: "ready", sha256 })],
      nextCursor: null,
    });
    expect(db.fileAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        projectId: "project_1",
        status: { not: "deleted" },
        project: {
          is: {
            status: "active",
            members: { some: { principalId: "principal_1" } },
          },
        },
      }),
    }));
  });

  it("returns a uniform 404 for an unauthorized File without exposing tenant existence", async () => {
    const { db } = database();
    db.fileAsset.findFirst.mockResolvedValue(null);
    const service = new FilesService(db as never, storage(), {} as never, config());

    await expect(service.get("principal_other", "file_1")).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: "RESOURCE_NOT_FOUND" }),
    });
    expect(db.fileAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "file_1",
        project: { is: { status: "active", members: { some: { principalId: "principal_other" } } } },
      }),
    }));
  });

  it("returns only safe File metadata and never serializes storage keys or raw failures", async () => {
    const { db } = database();
    db.fileAsset.findFirst.mockResolvedValue({
      ...readyFile(),
      storageKey: "private/tenant/secret.txt",
      failureDetail: "stack at /private/tenant/secret.txt",
    });
    const service = new FilesService(db as never, storage(), {} as never, config());

    const file = await service.get("principal_1", "file_1");
    expect(file).toMatchObject({ id: "file_1", blobId: "blob_1", sha256 });
    expect(JSON.stringify(file)).not.toContain("storageKey");
    expect(JSON.stringify(file)).not.toContain("private/tenant");
  });

  it("serves a verified single byte range and skips object storage on a digest ETag hit", async () => {
    const { db } = database();
    const objectStorage = storage();
    const contentFile = {
      id: "file_1",
      originalName: "knowledge.txt",
      status: "ready",
      byteSize: 10n,
      detectedMediaType: "text/plain",
      blob: {
        storageKey: "blobs/aa/hash",
        sha256,
        byteSize: 10n,
        mediaType: "text/plain",
        status: "ready",
        deletedAt: null,
      },
    };
    db.fileAsset.findFirst.mockResolvedValue(contentFile);
    const service = new FilesService(db as never, objectStorage, {} as never, config());

    await expect(service.getContent("principal_1", "file_1", "bytes=3-6")).resolves.toMatchObject({
      notModified: false,
      etag: `"${sha256}"`,
      byteSize: 4,
      range: { start: 3, end: 6 },
      contentRange: "bytes 3-6/10",
    });
    expect(objectStorage.getObject).toHaveBeenCalledWith({ key: "blobs/aa/hash" });

    objectStorage.getObject.mockClear();
    await expect(service.getContent("principal_1", "file_1", undefined, `W/"${sha256}"`)).resolves.toMatchObject({
      notModified: true,
    });
    expect(objectStorage.getObject).not.toHaveBeenCalled();
  });

  it("refuses File content immediately when a later scan quarantines its Blob", async () => {
    const { db } = database();
    const objectStorage = storage();
    db.fileAsset.findFirst.mockResolvedValue({
      id: "file_1",
      originalName: "knowledge.txt",
      status: "quarantined",
      byteSize: 10n,
      detectedMediaType: "text/plain",
      blob: {
        storageKey: "blobs/aa/hash",
        sha256,
        byteSize: 10n,
        mediaType: "text/plain",
        status: "quarantined",
        deletedAt: null,
      },
    });
    const service = new FilesService(db as never, objectStorage, {} as never, config());

    await expect(service.getContent("principal_1", "file_1")).rejects.toMatchObject({ status: 409 });
    expect(objectStorage.getObject).not.toHaveBeenCalled();
  });

  it("creates one Extraction attempt and queues it in the same transaction", async () => {
    const { db, tx } = database();
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    db.fileAsset.findFirst.mockResolvedValue(readyFile());
    db.fileExtraction.findUnique.mockResolvedValue(null);
    tx.fileExtraction.findUnique.mockResolvedValue(null);
    tx.fileAsset.findUnique.mockResolvedValue({
      status: "ready",
      revision: 4,
      blobId: "blob_1",
      blob: { status: "ready", deletedAt: null },
    });
    tx.fileExtraction.findFirst.mockResolvedValue(null);
    tx.fileExtraction.create.mockResolvedValue({ ...extraction(), requestHash: "receipt_hash" });
    db.fileAsset.findUnique.mockResolvedValue({ revision: 5 });
    const service = new FilesService(db as never, storage(), queue as never, config());

    await expect(service.createExtraction("principal_1", "file_1", 4, "extract-key-1")).resolves.toMatchObject({
      extraction: { id: "extraction_1", attempt: 1, status: "queued" },
      fileRevision: 5,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.fileExtraction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fileAssetId: "file_1",
        sourceBlobId: "blob_1",
        idempotencyKey: "extract-key-1",
        parser: "docling",
        parserVersion: "2.0.0",
      }),
    }));
    expect(queue.sendInTransaction).toHaveBeenCalledWith(
      tx,
      "file.extract",
      { extractionId: "extraction_1" },
      { singletonKey: "extraction_1" },
    );
  });

  it("replays a persistent Extraction receipt before enforcing a stale If-Match", async () => {
    const { db } = database();
    const file = { ...readyFile(), revision: 5 };
    db.fileAsset.findFirst.mockResolvedValue(file);
    const requestHash = (await import("../src/common/idempotency.js")).hashRequest({
      fileAssetId: "file_1",
      sourceBlobId: "blob_1",
      parser: "docling",
      parserVersion: "2.0.0",
      outputSchemaVersion: 1,
    });
    db.fileExtraction.findUnique.mockResolvedValue({ ...extraction(), requestHash });
    const queue = { sendInTransaction: vi.fn() };
    const service = new FilesService(db as never, storage(), queue as never, config());

    await expect(service.createExtraction("principal_1", "file_1", 4, "extract-key-1")).resolves.toMatchObject({
      extraction: { id: "extraction_1" },
      fileRevision: 5,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("requires active upload and extraction work to settle before logical deletion", async () => {
    const { db, tx } = database();
    const activeFile = {
      ...readyFile(),
      extractions: [extraction("running")],
    };
    db.fileAsset.findFirst.mockResolvedValue(activeFile);
    tx.fileAsset.findUnique.mockResolvedValue(activeFile);
    const service = new FilesService(db as never, storage(), {} as never, config());

    await expect(service.delete("principal_1", "file_1", 4)).rejects.toMatchObject({ status: 409 });
    expect(db.fileAsset.updateMany).not.toHaveBeenCalled();
  });
});

describe("File HTTP value helpers", () => {
  it("round-trips cursors and rejects malformed cursor values", () => {
    const cursor = { createdAt: createdAt.toISOString(), id: "file_1" };
    expect(decodeFileCursor(encodeFileCursor(cursor))).toEqual(cursor);
    expect(() => decodeFileCursor("not-a-cursor")).toThrow();
  });

  it("parses bounded, open, and suffix ranges and rejects multiple or unsatisfiable ranges", () => {
    expect(parseByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange("bytes=8-", 10)).toEqual({ start: 8, end: 9 });
    expect(parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(() => parseByteRange("bytes=10-12", 10)).toThrow();
    expect(() => parseByteRange("bytes=0-1,3-4", 10)).toThrow();
  });

  it("uses weak comparison semantics for safe GET validators", () => {
    expect(entityTagMatches('"other", W/"4"', '"4"')).toBe(true);
    expect(entityTagMatches("*", '"4"')).toBe(true);
    expect(entityTagMatches('"3"', '"4"')).toBe(false);
  });
});
