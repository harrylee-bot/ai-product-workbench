import type { ArtifactVersionDetail } from "@workbench/workbench-contracts";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  artifactVersionEtag,
  ArtifactsService,
  decodeArtifactCursor,
  decodeArtifactVersionCursor,
  encodeArtifactCursor,
  encodeArtifactVersionCursor,
} from "../src/modules/artifacts/artifacts.service.js";

const checksum = "a".repeat(64);
const createdAt = new Date("2026-07-12T00:00:00.000Z");

const artifact = {
  id: "artifact_1",
  projectId: "project_1",
  kind: "data" as const,
  title: "Research",
  revision: 4,
  currentVersionId: "version_1",
  currentVersion: {
    id: "version_1",
    artifactId: "artifact_1",
    version: 1,
    schemaVersion: 1,
    status: "ready" as const,
    checksum,
    createdByRunId: "run_1",
    createdAt,
  },
  createdAt,
  updatedAt: createdAt,
};

const inlineVersion = {
  id: "version_1",
  artifactId: "artifact_1",
  version: 1,
  schemaVersion: 1,
  status: "ready" as const,
  content: { rows: [1, 2, 3] },
  contentBlobId: null,
  checksum,
  citations: [],
  createdByRunId: "run_1",
  knowledgeReleaseId: "release_1",
  createdAt,
  artifact: { kind: "data" as const },
  contentBlob: null,
};

const exactReadableVersionWhere = {
  OR: [
    { status: "ready" },
    { status: "staging", createdByRunId: { not: null } },
  ],
};

function createDb() {
  return {
    project: { findFirst: vi.fn() },
    artifact: { findFirst: vi.fn(), findMany: vi.fn() },
    artifactVersion: { findFirst: vi.fn(), findMany: vi.fn() },
    artifactVersionAsset: { findFirst: vi.fn() },
  };
}

function storage() {
  return {
    getObject: vi.fn().mockResolvedValue({
      body: Readable.from("artifact"),
      byteSize: 8,
      mediaType: "application/octet-stream",
      contentRange: null,
    }),
  };
}

function createService(db: ReturnType<typeof createDb>, objectStorage = storage()) {
  return new ArtifactsService(db as never, objectStorage as never);
}

function sha256Bytes(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("ArtifactsService", () => {
  it("lists only through an active project membership boundary and maps a ready current version", async () => {
    const db = createDb();
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.artifact.findMany.mockResolvedValue([artifact]);
    const service = createService(db);

    await expect(service.list("principal_1", "project_1", "data")).resolves.toEqual({
      items: [{
        id: "artifact_1",
        projectId: "project_1",
        kind: "data",
        title: "Research",
        revision: 4,
        currentVersion: {
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          version: 1,
          kind: "data",
          schemaVersion: 1,
          status: "ready",
          checksum,
          createdByRunId: "run_1",
          createdAt: createdAt.toISOString(),
        },
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
      }],
      nextCursor: null,
    });
    expect(db.project.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "project_1",
        status: "active",
        members: { some: { principalId: "principal_1" } },
      }),
    }));
    expect(db.artifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        projectId: "project_1",
        kind: "data",
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
        project: {
          is: {
            status: "active",
            members: { some: { principalId: "principal_1" } },
          },
        },
      }),
    }));
  });

  it("returns the same 404 and does not enumerate Artifacts when project membership is absent", async () => {
    const db = createDb();
    db.project.findFirst.mockResolvedValue(null);
    const service = createService(db);

    await expect(service.list("principal_2", "project_1")).rejects.toMatchObject({ status: 404 });
    expect(db.artifact.findMany).not.toHaveBeenCalled();
  });

  it("gets an authorized Artifact and rejects a non-ready or mismatched current pointer as 404", async () => {
    const db = createDb();
    db.artifact.findFirst
      .mockResolvedValueOnce(artifact)
      .mockResolvedValueOnce(null);
    const service = createService(db);

    await expect(service.get("principal_1", "artifact_1")).resolves.toMatchObject({
      id: "artifact_1",
      revision: 4,
      currentVersion: { artifactVersionId: "version_1", status: "ready" },
    });
    await expect(service.get("principal_1", "artifact_2")).rejects.toMatchObject({ status: 404 });
    expect(db.artifact.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: "artifact_1",
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
        project: {
          is: {
            status: "active",
            members: { some: { principalId: "principal_1" } },
          },
        },
      }),
    }));
  });

  it("keeps Artifacts without a ready current version hidden from list and get", async () => {
    const db = createDb();
    db.project.findFirst.mockResolvedValue({ id: "project_1" });
    db.artifact.findMany.mockResolvedValue([]);
    db.artifact.findFirst.mockResolvedValue({
      ...artifact,
      currentVersionId: null,
      currentVersion: null,
    });
    const service = createService(db);

    await expect(service.list("principal_1", "project_1")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(service.get("principal_1", "artifact_staging"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.artifact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
      }),
    }));
    expect(db.artifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "artifact_staging",
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
      }),
    }));
  });

  it("maps and validates an inline version while scoping id, pairing, status, project and membership", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue(inlineVersion);
    const service = createService(db);

    const result = await service.getVersion("principal_1", "artifact_1", "version_1");

    expect(result.detail).toEqual({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      version: 1,
      kind: "data",
      schemaVersion: 1,
      status: "ready",
      checksum,
      citations: [],
      createdByRunId: "run_1",
      knowledgeReleaseId: "release_1",
      createdAt: createdAt.toISOString(),
      contentMode: "inline",
      content: { rows: [1, 2, 3] },
    });
    expect(result.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(db.artifactVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "version_1",
        artifactId: "artifact_1",
        artifact: {
          is: {
            id: "artifact_1",
            project: {
              is: {
                status: "active",
                members: { some: { principalId: "principal_1" } },
              },
            },
          },
        },
        AND: [
          exactReadableVersionWhere,
          {
            OR: [
              { contentBlobId: null },
              { contentBlob: { is: { status: "ready", deletedAt: null } } },
            ],
          },
        ],
      },
    }));
  });

  it("reads a Run-created staging version by exact id and rejects ordinary staging", async () => {
    const db = createDb();
    db.artifactVersion.findFirst
      .mockResolvedValueOnce({ ...inlineVersion, status: "staging" as const })
      .mockResolvedValueOnce({
        ...inlineVersion,
        status: "staging" as const,
        createdByRunId: null,
      });
    const service = createService(db);

    await expect(service.getVersion("principal_1", "artifact_1", "version_1"))
      .resolves.toMatchObject({
        detail: {
          artifactVersionId: "version_1",
          status: "staging",
          createdByRunId: "run_1",
        },
      });
    await expect(service.getVersion("principal_1", "artifact_1", "version_untrusted"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersion.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: "version_1",
        AND: expect.arrayContaining([exactReadableVersionWhere]),
      }),
    }));
  });

  it("returns only safe Blob metadata and never serializes its storage key", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue({
      ...inlineVersion,
      content: null,
      contentBlobId: "blob_1",
      contentBlob: {
        id: "blob_1",
        mediaType: "application/pdf",
        byteSize: 1234n,
        sha256: "b".repeat(64),
        status: "ready",
        deletedAt: null,
        storageKey: "private/tenant/secret.pdf",
      },
    });
    const service = createService(db);

    const result = await service.getVersion("principal_1", "artifact_1", "version_1");

    expect(result.detail).toMatchObject({
      contentMode: "blob",
      blob: {
        blobId: "blob_1",
        mediaType: "application/pdf",
        byteSize: 1234,
        sha256: "b".repeat(64),
        fileName: null,
      },
    });
    expect(JSON.stringify(result.detail)).not.toContain("storageKey");
    expect(JSON.stringify(result.detail)).not.toContain("secret.pdf");
    const selection = db.artifactVersion.findFirst.mock.calls[0]?.[0]?.select?.contentBlob?.select;
    expect(selection).not.toHaveProperty("storageKey");
  });

  it("does not expose a ready Artifact version after its content Blob is quarantined", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue({
      ...inlineVersion,
      content: null,
      contentBlobId: "blob_1",
      contentBlob: {
        id: "blob_1",
        mediaType: "application/pdf",
        byteSize: 1234n,
        sha256: "b".repeat(64),
        status: "quarantined",
        deletedAt: null,
      },
    });
    const service = createService(db);

    await expect(service.getVersion("principal_1", "artifact_1", "version_1"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("streams authorized immutable Blob bytes with digest ETag and an exact byte range", async () => {
    const objectSha256 = sha256Bytes("0123456789");
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue({
      status: "ready",
      createdByRunId: "run_1",
      contentBlob: {
        storageKey: "blobs/bb/content",
        sha256: objectSha256,
        byteSize: 10n,
        mediaType: "text/plain",
        status: "ready",
        deletedAt: null,
      },
    });
    const body = Readable.from("0123456789");
    const objectStorage = storage();
    objectStorage.getObject.mockResolvedValue({
      body,
      byteSize: 10,
      mediaType: "text/plain",
      contentRange: null,
    });
    const service = createService(db, objectStorage);

    await expect(service.getContent(
      "principal_1",
      "artifact_1",
      "version_1",
      "bytes=3-6",
      '"different"',
    )).resolves.toEqual({
      notModified: false,
      etag: `"${objectSha256}"`,
      body: expect.any(Readable),
      byteSize: 4,
      mediaType: "text/plain",
      range: { start: 3, end: 6 },
      contentRange: "bytes 3-6/10",
    });
    expect(objectStorage.getObject).toHaveBeenCalledWith({ key: "blobs/bb/content" });
    expect(db.artifactVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "version_1",
        artifactId: "artifact_1",
        ...exactReadableVersionWhere,
        contentBlobId: { not: null },
        contentBlob: { is: { status: "ready", deletedAt: null } },
        artifact: {
          is: {
            id: "artifact_1",
            project: {
              is: {
                status: "active",
                members: { some: { principalId: "principal_1" } },
              },
            },
          },
        },
      }),
    }));
  });

  it("short-circuits matching content ETags and never exposes inline or unauthorized content", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValueOnce({
      status: "ready",
      createdByRunId: "run_1",
      contentBlob: {
        storageKey: "blobs/bb/content",
        sha256: "b".repeat(64),
        byteSize: 10n,
        mediaType: "text/plain",
        status: "ready",
        deletedAt: null,
      },
    }).mockResolvedValueOnce(null);
    const objectStorage = storage();
    const service = createService(db, objectStorage);

    await expect(service.getContent(
      "principal_1",
      "artifact_1",
      "version_1",
      undefined,
      `W/"${"b".repeat(64)}"`,
    )).resolves.toEqual({
      notModified: true,
      etag: `"${"b".repeat(64)}"`,
      byteSize: 10,
      mediaType: "text/plain",
    });
    expect(objectStorage.getObject).not.toHaveBeenCalled();
    await expect(service.getContent("principal_2", "artifact_1", "version_1"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("streams Blob content for Run-created staging by exact id and rejects ordinary staging", async () => {
    const objectSha256 = sha256Bytes("draft-text");
    const db = createDb();
    const contentBlob = {
      storageKey: "blobs/bb/draft",
      sha256: objectSha256,
      byteSize: 10n,
      mediaType: "text/plain",
      status: "ready",
      deletedAt: null,
    };
    db.artifactVersion.findFirst
      .mockResolvedValueOnce({
        status: "staging",
        createdByRunId: "run_1",
        contentBlob,
      })
      .mockResolvedValueOnce({
        status: "staging",
        createdByRunId: null,
        contentBlob,
      });
    const objectStorage = storage();
    objectStorage.getObject.mockResolvedValue({
      body: Readable.from("draft-text"),
      byteSize: 10,
      mediaType: "text/plain",
      contentRange: null,
    });
    const service = createService(db, objectStorage);

    await expect(service.getContent("principal_1", "artifact_1", "version_draft"))
      .resolves.toMatchObject({
        notModified: false,
        etag: `"${objectSha256}"`,
      });
    await expect(service.getContent("principal_1", "artifact_1", "version_untrusted"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersion.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: "version_draft",
        ...exactReadableVersionWhere,
        contentBlob: { is: { status: "ready", deletedAt: null } },
      }),
    }));
    expect(objectStorage.getObject).toHaveBeenCalledTimes(1);
  });

  it("streams only a ready Blob pinned by asset id to an authorized Prototype or Design System version", async () => {
    const objectSha256 = sha256Bytes("image-bytes!");
    const db = createDb();
    db.artifactVersionAsset.findFirst.mockResolvedValue({
      artifactVersion: { status: "ready", createdByRunId: "run_1" },
      blob: {
        storageKey: "blobs/cc/hero",
        sha256: objectSha256,
        byteSize: 12n,
        mediaType: "image/png",
        status: "ready",
        deletedAt: null,
      },
    });
    const objectStorage = storage();
    const body = Readable.from("image-bytes!");
    objectStorage.getObject.mockResolvedValue({
      body,
      byteSize: 12,
      mediaType: "image/png",
      contentRange: null,
    });
    const service = createService(db, objectStorage);

    await expect(service.getAssetContent(
      "principal_1",
      "artifact_1",
      "version_1",
      "hero-image",
    )).resolves.toEqual({
      notModified: false,
      etag: `"${objectSha256}"`,
      body: expect.any(Readable),
      byteSize: 12,
      mediaType: "image/png",
      range: undefined,
      contentRange: null,
    });
    expect(db.artifactVersionAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        artifactVersionId: "version_1",
        artifactId: "artifact_1",
        assetId: "hero-image",
        artifactVersion: {
          is: {
            id: "version_1",
            artifactId: "artifact_1",
            ...exactReadableVersionWhere,
            artifact: {
              is: {
                id: "artifact_1",
                kind: { in: ["prototype", "design_system"] },
                project: {
                  is: {
                    status: "active",
                    members: { some: { principalId: "principal_1" } },
                  },
                },
              },
            },
          },
        },
        blob: { is: { status: "ready", deletedAt: null } },
      },
    }));
    expect(objectStorage.getObject).toHaveBeenCalledWith({ key: "blobs/cc/hero" });
  });

  it("streams an asset for Run-created staging by exact id and rejects ordinary staging", async () => {
    const objectSha256 = sha256Bytes("image-bytes!");
    const db = createDb();
    const blob = {
      storageKey: "blobs/cc/draft-hero",
      sha256: objectSha256,
      byteSize: 12n,
      mediaType: "image/png",
      status: "ready",
      deletedAt: null,
    };
    db.artifactVersionAsset.findFirst
      .mockResolvedValueOnce({
        artifactVersion: { status: "staging", createdByRunId: "run_1" },
        blob,
      })
      .mockResolvedValueOnce({
        artifactVersion: { status: "staging", createdByRunId: null },
        blob,
      });
    const objectStorage = storage();
    objectStorage.getObject.mockResolvedValue({
      body: Readable.from("image-bytes!"),
      byteSize: 12,
      mediaType: "image/png",
      contentRange: null,
    });
    const service = createService(db, objectStorage);

    await expect(service.getAssetContent(
      "principal_1",
      "artifact_1",
      "version_draft",
      "hero-image",
    )).resolves.toMatchObject({
      notModified: false,
      etag: `"${objectSha256}"`,
    });
    await expect(service.getAssetContent(
      "principal_1",
      "artifact_1",
      "version_untrusted",
      "hero-image",
    )).rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersionAsset.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        artifactVersionId: "version_draft",
        artifactVersion: {
          is: expect.objectContaining({
            id: "version_draft",
            ...exactReadableVersionWhere,
          }),
        },
      }),
    }));
    expect(objectStorage.getObject).toHaveBeenCalledTimes(1);
  });

  it("supports immutable ETag and byte-range reads for private Design System assets", async () => {
    const objectSha256 = sha256Bytes("0123456789");
    const db = createDb();
    db.artifactVersionAsset.findFirst.mockResolvedValue({
      artifactVersion: { status: "ready", createdByRunId: null },
      blob: {
        storageKey: "blobs/dd/design-font",
        sha256: objectSha256,
        byteSize: 10n,
        mediaType: "font/woff2",
        status: "ready",
        deletedAt: null,
      },
    });
    const objectStorage = storage();
    const rangedBody = Readable.from("0123456789");
    objectStorage.getObject.mockResolvedValue({
      body: rangedBody,
      byteSize: 10,
      mediaType: "font/woff2",
      contentRange: null,
    });
    const service = createService(db, objectStorage);

    await expect(service.getAssetContent(
      "principal_1",
      "design_artifact",
      "design_version",
      "font_inter",
      undefined,
      `W/\"${objectSha256}\"`,
    )).resolves.toEqual({
      notModified: true,
      etag: `"${objectSha256}"`,
      byteSize: 10,
      mediaType: "font/woff2",
    });
    expect(objectStorage.getObject).not.toHaveBeenCalled();

    await expect(service.getAssetContent(
      "principal_1",
      "design_artifact",
      "design_version",
      "font_inter",
      "bytes=3-6",
      '"different"',
    )).resolves.toEqual({
      notModified: false,
      etag: `"${objectSha256}"`,
      body: expect.any(Readable),
      byteSize: 4,
      mediaType: "font/woff2",
      range: { start: 3, end: 6 },
      contentRange: "bytes 3-6/10",
    });
    expect(objectStorage.getObject).toHaveBeenCalledWith({ key: "blobs/dd/design-font" });
  });

  it("returns the same 404 after membership revocation or any Artifact/version/asset mismatch", async () => {
    const db = createDb();
    db.artifactVersionAsset.findFirst.mockResolvedValue(null);
    const objectStorage = storage();
    const service = createService(db, objectStorage);

    for (const request of [
      ["principal_revoked", "design_artifact", "design_version", "brand"],
      ["principal_1", "artifact_other", "design_version", "brand"],
      ["principal_1", "design_artifact", "version_other", "brand"],
      ["principal_1", "design_artifact", "design_version", "asset_other"],
    ] as const) {
      await expect(service.getAssetContent(...request)).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ code: "RESOURCE_NOT_FOUND" }),
      });
    }
    expect(objectStorage.getObject).not.toHaveBeenCalled();
    expect(db.artifactVersionAsset.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        artifactVersionId: "design_version",
        artifactId: "design_artifact",
        assetId: "brand",
        artifactVersion: expect.objectContaining({
          is: expect.objectContaining({
            artifact: expect.objectContaining({
              is: expect.objectContaining({
                project: {
                  is: {
                    status: "active",
                    members: { some: { principalId: "principal_revoked" } },
                  },
                },
              }),
            }),
          }),
        }),
      }),
    }));
  });

  it("defensively rejects a non-ready or deleted asset Blob even if a stale query result is returned", async () => {
    const db = createDb();
    const baseBlob = {
      storageKey: "blobs/ee/stale",
      sha256: "e".repeat(64),
      byteSize: 10n,
      mediaType: "image/png",
      status: "ready",
      deletedAt: null,
    };
    db.artifactVersionAsset.findFirst
      .mockResolvedValueOnce({
        artifactVersion: { status: "ready", createdByRunId: "run_1" },
        blob: { ...baseBlob, status: "quarantined" },
      })
      .mockResolvedValueOnce({
        artifactVersion: { status: "ready", createdByRunId: "run_1" },
        blob: { ...baseBlob, deletedAt: createdAt },
      });
    const objectStorage = storage();
    const service = createService(db, objectStorage);

    await expect(service.getAssetContent(
      "principal_1", "design_artifact", "design_version", "brand",
    )).rejects.toMatchObject({ status: 404 });
    await expect(service.getAssetContent(
      "principal_1", "design_artifact", "design_version", "brand",
    )).rejects.toMatchObject({ status: 404 });
    expect(objectStorage.getObject).not.toHaveBeenCalled();
  });

  it("uses a uniform 404 when an asset id is not pinned to that version or tenant", async () => {
    const db = createDb();
    db.artifactVersionAsset.findFirst.mockResolvedValue(null);
    const objectStorage = storage();
    const service = createService(db, objectStorage);

    await expect(service.getAssetContent(
      "principal_2",
      "artifact_1",
      "version_1",
      "asset_other",
    )).rejects.toMatchObject({ status: 404 });
    expect(objectStorage.getObject).not.toHaveBeenCalled();
  });

  it("uses a uniform 404 for a cross-Artifact pair, non-ready version or unauthorized tenant", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue(null);
    const service = createService(db);

    await expect(service.getVersion("principal_2", "artifact_other", "version_1"))
      .rejects.toMatchObject({ status: 404, response: expect.objectContaining({ code: "RESOURCE_NOT_FOUND" }) });
  });

  it("does not query versions when Artifact authorization fails", async () => {
    const db = createDb();
    db.artifact.findFirst.mockResolvedValue(null);
    const service = createService(db);

    await expect(service.listVersions("principal_2", "artifact_1")).rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersion.findMany).not.toHaveBeenCalled();
  });

  it("lists ready immutable versions with an opaque newest-first cursor", async () => {
    const db = createDb();
    db.artifact.findFirst.mockResolvedValue({ id: "artifact_1" });
    db.artifactVersion.findMany.mockResolvedValue([
      inlineVersion,
      { ...inlineVersion, id: "version_0", version: 0 },
    ]);
    const service = createService(db);

    const result = await service.listVersions("principal_1", "artifact_1", undefined, 1);

    expect(result.items).toEqual([{
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      version: 1,
      kind: "data",
      schemaVersion: 1,
      status: "ready",
      checksum,
      createdByRunId: "run_1",
      createdAt: createdAt.toISOString(),
      contentMode: "inline",
    }]);
    expect(result.nextCursor).not.toBeNull();
    expect(db.artifactVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        artifactId: "artifact_1",
        status: "ready",
        artifact: {
          is: {
            id: "artifact_1",
            project: {
              is: {
                status: "active",
                members: { some: { principalId: "principal_1" } },
              },
            },
          },
        },
      }),
      orderBy: [{ version: "desc" }, { id: "desc" }],
      take: 2,
    }));
  });

  it("hashes the complete canonical response manifest into a stable strong ETag", () => {
    const detail = {
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      version: 1,
      kind: "data",
      schemaVersion: 1,
      status: "ready",
      checksum,
      citations: [],
      createdByRunId: "run_1",
      knowledgeReleaseId: "release_1",
      createdAt: createdAt.toISOString(),
      contentMode: "inline",
      content: { alpha: 1, beta: 2 },
    } satisfies ArtifactVersionDetail;
    const reordered = {
      ...detail,
      content: { beta: 2, alpha: 1 },
    } satisfies ArtifactVersionDetail;

    expect(artifactVersionEtag(detail)).toBe(artifactVersionEtag(reordered));
    expect(artifactVersionEtag(detail)).not.toBe(artifactVersionEtag({
      ...detail,
      knowledgeReleaseId: "release_2",
    }));
    expect(artifactVersionEtag(detail)).not.toBe(artifactVersionEtag({
      ...detail,
      content: { alpha: 1, beta: 3 },
    }));
    const semanticMutations: ArtifactVersionDetail[] = [
      { ...detail, kind: "document" },
      { ...detail, schemaVersion: 2 },
      { ...detail, status: "staging" },
      { ...detail, checksum: "b".repeat(64) },
      { ...detail, createdByRunId: null },
      {
        ...detail,
        citations: [{
          id: "citation.1",
          documentId: "document_1",
          chunkId: "chunk_1",
          sourcePath: "knowledge-vault/source.md",
          title: null,
          quote: "Evidence",
          locator: { heading: null, startLine: 1, endLine: 1 },
        }],
      },
    ];
    for (const mutation of semanticMutations) {
      expect(artifactVersionEtag(mutation)).not.toBe(artifactVersionEtag(detail));
    }
  });

  it("round-trips stable Artifact and version cursors and rejects malformed values", () => {
    const artifactCursor = { updatedAt: createdAt.toISOString(), id: "artifact_1" };
    const versionCursor = { version: 7, id: "version_7" };
    expect(decodeArtifactCursor(encodeArtifactCursor(artifactCursor))).toEqual(artifactCursor);
    expect(decodeArtifactVersionCursor(encodeArtifactVersionCursor(versionCursor))).toEqual(versionCursor);
    expect(() => decodeArtifactCursor("bad")).toThrow();
    expect(() => decodeArtifactVersionCursor("bad")).toThrow();
  });
});
