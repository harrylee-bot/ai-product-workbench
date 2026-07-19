import type { FileAsset } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import {
  needsWorkbenchFilePolling,
  workbenchFileRefetchInterval,
} from "./files";

function file(status: FileAsset["status"], extractionStatus?: NonNullable<FileAsset["latestExtraction"]>["status"]): FileAsset {
  const extraction = extractionStatus ? {
    id: "extraction-1",
    fileAssetId: "file-1",
    attempt: 1,
    status: extractionStatus,
    parser: "docling",
    parserVersion: "1",
    outputSchemaVersion: 1,
    contentSha256: extractionStatus === "ready" ? "a".repeat(64) : null,
    failure: extractionStatus === "failed" ? { code: "EXTRACTION_FAILED", message: "failed" } : null,
    startedAt: extractionStatus === "queued" ? null : "2026-07-12T00:00:01.000Z",
    finishedAt: ["ready", "unsupported", "failed"].includes(extractionStatus)
      ? "2026-07-12T00:00:02.000Z"
      : null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  } satisfies NonNullable<FileAsset["latestExtraction"]> : null;

  return {
    id: "file-1",
    projectId: "project-1",
    blobId: status === "ready" ? "blob-1" : null,
    originalName: "brief.pdf",
    declaredMediaType: "application/pdf",
    detectedMediaType: status === "ready" ? "application/pdf" : null,
    byteSize: 10,
    status,
    revision: 1,
    sha256: status === "ready" ? "b".repeat(64) : null,
    failure: null,
    currentExtraction: extractionStatus === "ready" ? extraction : null,
    latestExtraction: extraction,
    verifiedAt: status === "ready" ? "2026-07-12T00:00:00.000Z" : null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

describe("File lifecycle polling", () => {
  it("polls verification and active extraction but stops at terminal states", () => {
    expect(needsWorkbenchFilePolling(file("verifying"))).toBe(true);
    expect(needsWorkbenchFilePolling(file("ready", "queued"))).toBe(true);
    expect(needsWorkbenchFilePolling(file("ready", "running"))).toBe(true);
    expect(needsWorkbenchFilePolling(file("ready", "ready"))).toBe(false);
    expect(needsWorkbenchFilePolling(file("ready", "failed"))).toBe(false);
    expect(needsWorkbenchFilePolling(file("ready", "unsupported"))).toBe(false);
    expect(needsWorkbenchFilePolling(file("failed"))).toBe(false);
    expect(workbenchFileRefetchInterval(file("verifying"), { intervalMs: 250 })).toBe(250);
    expect(workbenchFileRefetchInterval(file("verifying"), { enabled: false })).toBe(false);
  });

  it("rejects a hot polling loop", () => {
    expect(() => workbenchFileRefetchInterval(file("verifying"), { intervalMs: 0 }))
      .toThrow(/at least 100ms/);
  });
});
