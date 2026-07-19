import { describe, expect, it } from "vitest";

import { selectLatestRestorableExport } from "./index";

const base = {
  id: "export-1",
  releaseId: "release-1",
  createdById: "principal-1",
  format: "html" as const,
  packaging: "single_file" as const,
  selection: { kind: "board" as const },
  revision: 1,
  options: {},
  output: null,
  failure: null,
  createdAt: "2026-07-15T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  updatedAt: "2026-07-15T00:00:00.000Z",
};

describe("Export restore selection", () => {
  it("does not let an older unfinished job hide a newer successful result", () => {
    const succeeded = {
      ...base,
      id: "export-succeeded",
      status: "succeeded" as const,
      revision: 2,
      startedAt: base.createdAt,
      finishedAt: "2026-07-15T03:00:00.000Z",
      output: {
        mode: "blob" as const,
        blobId: "blob-1",
        mediaType: "text/html",
        byteSize: 10,
        sha256: "a".repeat(64),
        fileName: null,
      },
      updatedAt: "2026-07-15T03:00:00.000Z",
    };
    const running = {
      ...base,
      id: "export-running",
      status: "running" as const,
      revision: 1,
      startedAt: "2026-07-15T02:00:00.000Z",
      updatedAt: "2026-07-15T02:00:00.000Z",
    };

    expect(selectLatestRestorableExport([succeeded, running])?.id).toBe("export-succeeded");
  });

  it("restores a newer unfinished job so polling can continue", () => {
    const succeeded = {
      ...base,
      id: "export-succeeded",
      status: "succeeded" as const,
      revision: 2,
      startedAt: base.createdAt,
      finishedAt: "2026-07-15T01:00:00.000Z",
      output: {
        mode: "blob" as const,
        blobId: "blob-1",
        mediaType: "text/html",
        byteSize: 10,
        sha256: "a".repeat(64),
        fileName: null,
      },
      updatedAt: "2026-07-15T01:00:00.000Z",
    };
    const running = {
      ...base,
      id: "export-running",
      status: "running" as const,
      revision: 1,
      startedAt: "2026-07-15T02:00:00.000Z",
      updatedAt: "2026-07-15T02:00:00.000Z",
    };

    expect(selectLatestRestorableExport([succeeded, running])?.id).toBe("export-running");
  });

  it("returns the newest successful job when no active job remains", () => {
    const older = {
      ...base,
      id: "export-old",
      status: "succeeded" as const,
      revision: 2,
      startedAt: base.createdAt,
      finishedAt: "2026-07-15T01:00:00.000Z",
      output: {
        mode: "blob" as const,
        blobId: "blob-old",
        mediaType: "text/html",
        byteSize: 10,
        sha256: "b".repeat(64),
        fileName: null,
      },
      updatedAt: "2026-07-15T01:00:00.000Z",
    };
    const newest = {
      ...older,
      id: "export-new",
      updatedAt: "2026-07-15T02:00:00.000Z",
      finishedAt: "2026-07-15T02:00:00.000Z",
    };

    expect(selectLatestRestorableExport([
      { ...base, id: "export-failed", status: "failed" as const, finishedAt: base.createdAt, failure: { code: "FAILED", detail: null } },
      { ...base, id: "export-cancelled", status: "cancelled" as const, finishedAt: base.createdAt },
      older,
      newest,
    ])?.id).toBe("export-new");
  });
});
