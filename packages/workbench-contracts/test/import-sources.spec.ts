import { describe, expect, it } from "vitest";

import {
  createImportSourceRequestSchema,
  importSourceSchema,
  runSourceSnapshotSchema,
} from "../src/index.js";

const timestamp = "2026-07-18T00:00:00.000Z";
const checksum = "a".repeat(64);

describe("Import Source contracts", () => {
  it("keeps local file sources frozen and external locators pending", () => {
    expect(createImportSourceRequestSchema.parse({
      kind: "file",
      fileAssetId: "file_1",
      label: "Requirements",
    })).toEqual({
      kind: "file",
      fileAssetId: "file_1",
      label: "Requirements",
    });
    expect(createImportSourceRequestSchema.parse({
      kind: "url_snapshot",
      sourceUrl: "https://example.com/design",
    })).toEqual({
      kind: "url_snapshot",
      sourceUrl: "https://example.com/design",
    });
    expect(createImportSourceRequestSchema.safeParse({
      kind: "url_snapshot",
      sourceUrl: "http://127.0.0.1/private",
    }).success).toBe(true);
    expect(createImportSourceRequestSchema.safeParse({
      kind: "github_snapshot",
      repository: "acme/workbench",
      ref: "main",
      commitSha: "a".repeat(40),
    }).success).toBe(false);
  });

  it("enforces lifecycle pairings and frozen ready descriptors", () => {
    const ready = {
      id: "source_1",
      projectId: "project_1",
      createdById: "principal_1",
      kind: "file",
      status: "ready",
      label: "requirements.pdf",
      descriptor: {
        kind: "file",
        fileAssetId: "file_1",
        originalName: "requirements.pdf",
        mediaType: "application/pdf",
      },
      checksum,
      revision: 1,
      failure: null,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(importSourceSchema.parse(ready)).toEqual(ready);
    expect(importSourceSchema.safeParse({
      ...ready,
      descriptor: { ...ready.descriptor, kind: "design_md" },
    }).success).toBe(false);
    expect(importSourceSchema.safeParse({ ...ready, checksum: null }).success).toBe(false);
    expect(importSourceSchema.safeParse({
      ...ready,
      status: "deleted",
      deletedAt: null,
    }).success).toBe(false);
    expect(importSourceSchema.safeParse({
      ...ready,
      status: "failed",
      failure: null,
      deletedAt: null,
    }).success).toBe(false);
  });

  it("requires a contiguous, checksum-matched immutable Run manifest", () => {
    const snapshot = {
      id: "run_source_1",
      runId: "run_1",
      projectId: "project_1",
      position: 0,
      sourceId: "source_1",
      kind: "file",
      label: "requirements.pdf",
      checksum,
      descriptor: {
        kind: "file",
        fileAssetId: "file_1",
        originalName: "requirements.pdf",
        mediaType: "application/pdf",
      },
      snapshot: {
        protocol: "workbench.import-source-snapshot.v1",
        sourceRevision: 1,
        checksum,
        blobs: [{
          position: 0,
          blobId: "blob_1",
          role: "primary",
          path: null,
          mediaType: "application/pdf",
          byteSize: 42,
          sha256: checksum,
        }],
      },
      createdAt: timestamp,
    };
    expect(runSourceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(runSourceSnapshotSchema.safeParse({
      ...snapshot,
      snapshot: { ...snapshot.snapshot, checksum: "b".repeat(64) },
    }).success).toBe(false);
    expect(runSourceSnapshotSchema.safeParse({
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        blobs: [{ ...snapshot.snapshot.blobs[0], position: 1 }],
      },
    }).success).toBe(false);
    expect(runSourceSnapshotSchema.safeParse({
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        blobs: [snapshot.snapshot.blobs[0], snapshot.snapshot.blobs[0]],
      },
    }).success).toBe(false);
  });
});
