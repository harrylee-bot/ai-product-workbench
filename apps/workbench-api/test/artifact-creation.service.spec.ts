import { describe, expect, it, vi } from "vitest";
import { hashRequest } from "../src/common/idempotency.js";
import { ArtifactsService } from "../src/modules/artifacts/artifacts.service.js";

const createdAt = new Date("2026-07-14T07:00:00.000Z");
const checksum = "c".repeat(64);
const request = {
  kind: "image" as const,
  title: "Hero image",
  source: { kind: "file" as const, fileAssetId: "file_image" },
};

describe("ArtifactsService image creation", () => {
  it("locks the editable Project and atomically publishes the verified File Blob", async () => {
    const { db, tx } = database();
    const service = new ArtifactsService(db as never, {} as never);

    await expect(service.create(
      "principal_1",
      "project_1",
      "artifact:create-1",
      request,
    )).resolves.toEqual(expectedCreation());

    expect(db.project.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "project_1",
        status: "active",
        members: { some: { principalId: "principal_1", role: { in: ["owner", "editor"] } } },
      },
    }));
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.projectMember.findUnique).toHaveBeenCalledWith({
      where: { projectId_principalId: { projectId: "project_1", principalId: "principal_1" } },
      select: { role: true },
    });
    expect(tx.fileAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "file_image", projectId: "project_1" },
    }));
    expect(tx.artifact.create).toHaveBeenCalledWith({
      data: { projectId: "project_1", kind: "image", title: "Hero image" },
    });
    expect(tx.artifactVersion.create).toHaveBeenCalledWith({
      data: {
        artifactId: "artifact_image",
        projectId: "project_1",
        version: 1,
        schemaVersion: 1,
        status: "staging",
        contentBlobId: "blob_image",
        checksum,
        citations: [],
      },
    });
    expect(tx.artifactVersion.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "version_image" },
      data: { status: "ready" },
    }));
    expect(tx.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "artifact_image" },
      data: { currentVersionId: "version_image" },
    }));
    expect(tx.artifactCreationReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project_1",
        artifactId: "artifact_image",
        artifactVersionId: "version_image",
        sourceFileAssetId: "file_image",
        sourceBlobId: "blob_image",
        createdById: "principal_1",
        idempotencyKey: "artifact:create-1",
        requestHash: hashRequest(request),
      }),
    });
  });

  it("replays the same receipt and rejects key reuse by another request", async () => {
    const replay = creationReceipt();
    const { db } = database();
    db.artifactCreationReceipt.findUnique.mockResolvedValue(replay);
    const service = new ArtifactsService(db as never, {} as never);

    await expect(service.create(
      "principal_1",
      "project_1",
      "artifact:create-1",
      request,
    )).resolves.toEqual(expectedCreation());
    expect(db.$transaction).not.toHaveBeenCalled();

    await expect(service.create(
      "principal_1",
      "project_1",
      "artifact:create-1",
      { ...request, title: "Different image" },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });
  });

  it("rejects non-ready and unsupported source files before creating an Artifact", async () => {
    const { db, tx } = database();
    tx.fileAsset.findFirst
      .mockResolvedValueOnce({ ...sourceFile(), status: "verifying" })
      .mockResolvedValueOnce({
        ...sourceFile(),
        detectedMediaType: "image/svg+xml",
        blob: { ...sourceFile().blob, mediaType: "image/svg+xml" },
      });
    const service = new ArtifactsService(db as never, {} as never);

    await expect(service.create(
      "principal_1", "project_1", "artifact:create-2", request,
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ARTIFACT_SOURCE_FILE_NOT_READY" }),
    });
    await expect(service.create(
      "principal_1", "project_1", "artifact:create-3", request,
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ARTIFACT_SOURCE_MEDIA_TYPE_UNSUPPORTED" }),
    });
    expect(tx.artifact.create).not.toHaveBeenCalled();
  });
});

function database() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
    projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
    artifactCreationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "receipt_1" }),
    },
    fileAsset: { findFirst: vi.fn().mockResolvedValue(sourceFile()) },
    artifact: {
      create: vi.fn().mockResolvedValue({ id: "artifact_image" }),
      update: vi.fn().mockResolvedValue(readyArtifact()),
    },
    artifactVersion: {
      create: vi.fn().mockResolvedValue({ id: "version_image" }),
      update: vi.fn().mockResolvedValue(readyVersion()),
    },
  };
  const db = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: "project_1" }) },
    artifactCreationReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { db, tx };
}

function sourceFile() {
  return {
    id: "file_image",
    projectId: "project_1",
    blobId: "blob_image",
    status: "ready",
    detectedMediaType: "image/png",
    deletedAt: null,
    blob: {
      id: "blob_image",
      sha256: checksum,
      mediaType: "image/png",
      byteSize: 42n,
      status: "ready",
      deletedAt: null,
    },
  };
}

function readyArtifact() {
  return {
    id: "artifact_image",
    projectId: "project_1",
    kind: "image" as const,
    title: "Hero image",
    revision: 1,
    currentVersionId: "version_image",
    currentVersion: {
      id: "version_image",
      artifactId: "artifact_image",
      version: 1,
      schemaVersion: 1,
      status: "ready" as const,
      checksum,
      createdByRunId: null,
      createdAt,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function readyVersion() {
  return {
    id: "version_image",
    artifactId: "artifact_image",
    version: 1,
    schemaVersion: 1,
    status: "ready",
    content: null,
    contentBlobId: "blob_image",
    checksum,
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    createdAt,
    artifact: { kind: "image" },
    contentBlob: {
      id: "blob_image",
      mediaType: "image/png",
      byteSize: 42n,
      sha256: checksum,
      status: "ready",
      deletedAt: null,
    },
  };
}

function creationReceipt() {
  return {
    id: "receipt_1",
    projectId: "project_1",
    artifactId: "artifact_image",
    artifactVersionId: "version_image",
    sourceFileAssetId: "file_image",
    sourceBlobId: "blob_image",
    createdById: "principal_1",
    idempotencyKey: "artifact:create-1",
    requestHash: hashRequest(request),
    createdAt,
    artifact: readyArtifact(),
    artifactVersion: readyVersion(),
  };
}

function expectedCreation() {
  const currentVersion = {
    artifactId: "artifact_image",
    artifactVersionId: "version_image",
    version: 1,
    kind: "image" as const,
    schemaVersion: 1,
    status: "ready" as const,
    checksum,
    createdByRunId: null,
    createdAt: createdAt.toISOString(),
  };
  return {
    artifact: {
      id: "artifact_image",
      projectId: "project_1",
      kind: "image" as const,
      title: "Hero image",
      revision: 1,
      currentVersion,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
    },
    artifactVersion: {
      ...currentVersion,
      citations: [],
      knowledgeReleaseId: null,
      contentMode: "blob" as const,
      blob: {
        blobId: "blob_image",
        mediaType: "image/png",
        byteSize: 42,
        sha256: checksum,
        fileName: null,
      },
    },
  };
}
