import { describe, expect, it, vi } from "vitest";
import { PrismaExportStore } from "../src/export/export.store.js";

const identity = { sha256: "a".repeat(64), byteSize: 128, mediaType: "text/html; charset=utf-8" };

describe("PrismaExportStore", () => {
  it("claims queued work with a single revision increment", async () => {
    const db = {
      exportJob: {
        findUnique: vi.fn(async () => ({ status: "queued" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const store = new PrismaExportStore(db as never, prefixes());
    vi.spyOn(store, "loadRunning").mockResolvedValue({ id: "export-1" } as never);
    await expect(store.start("export-1")).resolves.toEqual({ kind: "run", command: { id: "export-1" } });
    expect(db.exportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "export-1", status: "queued" }),
      data: expect.objectContaining({ status: "running", revision: { increment: 1 } }),
    }));
  });

  it("rehydrates a persisted Prototype screen selection", async () => {
    const db = {
      exportJob: {
        findUnique: vi.fn(async () => ({
          id: "export-1",
          format: "html",
          purpose: "export",
          selectionKind: "artifact",
          selectionArtifactId: "artifact-1",
          selectionArtifactVersionId: "version-1",
          selectionScreenId: "screen-success",
          selectionNodeIds: [],
          status: "running",
          startedAt: new Date(),
          finishedAt: null,
          outputBlobId: null,
          options: {},
          release: {},
          preview: null,
        })),
      },
    };
    const store = new PrismaExportStore(db as never, prefixes());
    await expect(store.loadRunning("export-1")).resolves.toMatchObject({
      selection: {
        kind: "artifact",
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-success",
      },
    });
  });

  it("rehydrates the exact persisted Board-node selection", async () => {
    const db = {
      exportJob: {
        findUnique: vi.fn(async () => ({
          id: "export-1",
          format: "html",
          purpose: "export",
          selectionKind: "board_nodes",
          selectionArtifactId: null,
          selectionArtifactVersionId: null,
          selectionScreenId: null,
          selectionNodeIds: ["node-a", "node-b"],
          status: "running",
          startedAt: new Date(),
          finishedAt: null,
          outputBlobId: null,
          options: {},
          release: {},
          preview: null,
        })),
      },
    };
    const store = new PrismaExportStore(db as never, prefixes());
    await expect(store.loadRunning("export-1")).resolves.toMatchObject({
      selection: { kind: "board_nodes", nodeIds: ["node-a", "node-b"] },
    });
  });

  it("rehydrates only the snapshot selected by ExportJob purpose", async () => {
    const preview = { id: "preview-1", artifactPins: [] };
    const job = {
      id: "preview-export-1",
      createdById: "viewer-1",
      format: "html",
      purpose: "preview",
      selectionKind: "release",
      selectionArtifactId: null,
      selectionArtifactVersionId: null,
      selectionScreenId: null,
      selectionNodeIds: [],
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      outputBlobId: null,
      options: {},
      release: null,
      preview,
    };
    const findUnique = vi.fn(async () => job);
    const store = new PrismaExportStore({ exportJob: { findUnique } } as never, prefixes());

    await expect(store.loadRunning(job.id)).resolves.toMatchObject({
      purpose: "preview",
      release: null,
      preview: { id: "preview-1" },
    });

    findUnique.mockResolvedValueOnce({ ...job, release: {} });
    await expect(store.loadRunning(job.id)).rejects.toThrow("EXPORT_JOB_SOURCE_SNAPSHOT_MISSING");
  });

  it("reuses the database storage key of an existing ready Blob", async () => {
    const tx = transaction({
      id: "blob-existing",
      ...identity,
      byteSize: BigInt(identity.byteSize),
      generation: 7,
      status: "ready",
      storageKey: "legacy-canonical/custom-key",
    });
    const store = new PrismaExportStore({ $transaction: vi.fn(async (callback) => callback(tx)) } as never, prefixes());
    await expect(store.reserveOutput(identity)).resolves.toMatchObject({
      blobId: "blob-existing",
      generation: 7,
      canonicalStorageKey: "legacy-canonical/custom-key",
    });
  });

  it("does not hijack an unrelated pending Blob with the same digest", async () => {
    const tx = transaction({
      id: "blob-upload",
      ...identity,
      byteSize: BigInt(identity.byteSize),
      generation: 1,
      status: "pending",
      storageKey: "pending/blobs/aa/upload",
    });
    const store = new PrismaExportStore({ $transaction: vi.fn(async (callback) => callback(tx)) } as never, prefixes());
    await expect(store.reserveOutput(identity)).rejects.toThrow("EXPORT_OUTPUT_DIGEST_BUSY");
  });

  it("publishes Blob readiness and the succeeded ExportJob in one transaction", async () => {
    const tx = {
      exportJob: {
        findUnique: vi.fn(async () => ({ status: "running", outputBlobId: null })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      blob: {
        findUnique: vi.fn(async () => ({
          id: "blob-1",
          ...identity,
          byteSize: BigInt(identity.byteSize),
          generation: 1,
          status: "pending",
          storageKey: "pending/exports/aa/output/g1",
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const db = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const store = new PrismaExportStore(db as never, prefixes());
    await expect(store.publishSucceeded("export-1", {
      ...identity,
      blobId: "blob-1",
      generation: 1,
      canonicalStorageKey: "blobs/aa/output/g1",
    })).resolves.toBe("succeeded");
    expect(tx.blob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ready", storageKey: "blobs/aa/output/g1" }),
    }));
    expect(tx.exportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "running", outputBlobId: null }),
      data: expect.objectContaining({ status: "succeeded", outputBlobId: "blob-1", revision: { increment: 1 } }),
    }));
  });
});

function prefixes() {
  return { pendingBlobPrefix: "pending/exports", canonicalBlobPrefix: "blobs" };
}

function transaction(active: object) {
  return {
    $queryRaw: vi.fn(async () => [{ lock_receipt: "ok" }]),
    blob: {
      findFirst: vi.fn(async () => active),
      aggregate: vi.fn(),
      create: vi.fn(),
    },
  };
}
