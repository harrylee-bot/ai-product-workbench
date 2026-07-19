import type { FileAsset, FileExtraction } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { projectUploadLifecycle } from "./upload-lifecycle";

const CREATED_AT = "2026-07-12T00:00:00.000Z";

function extraction(
  status: FileExtraction["status"],
  failure: FileExtraction["failure"] = null,
): FileExtraction {
  const started = status !== "queued";
  const terminal = ["ready", "unsupported", "failed"].includes(status);
  return {
    id: "extraction-1",
    fileAssetId: "file-1",
    attempt: 1,
    status,
    parser: "docling",
    parserVersion: "1.0.0",
    outputSchemaVersion: 1,
    contentSha256: status === "ready" ? "c".repeat(64) : null,
    failure,
    startedAt: started ? "2026-07-12T00:00:01.000Z" : null,
    finishedAt: terminal ? "2026-07-12T00:00:02.000Z" : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function file(
  status: FileAsset["status"],
  latestExtraction: FileExtraction | null = null,
  failure: FileAsset["failure"] = null,
): FileAsset {
  const ready = status === "ready";
  return {
    id: "file-1",
    projectId: "project-1",
    blobId: ready ? "blob-1" : null,
    originalName: "brief.pdf",
    declaredMediaType: "application/pdf",
    detectedMediaType: ready ? "application/pdf" : null,
    byteSize: 10,
    status,
    revision: 1,
    sha256: ready ? "b".repeat(64) : null,
    failure,
    currentExtraction: latestExtraction?.status === "ready" ? latestExtraction : null,
    latestExtraction,
    verifiedAt: ready ? CREATED_AT : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe("upload lifecycle projection", () => {
  it("projects transfer and verification phases before file readiness", () => {
    expect(projectUploadLifecycle(file("uploading"), false)).toMatchObject({
      phase: "uploading",
      error: null,
    });
    expect(projectUploadLifecycle(file("verifying"), false)).toMatchObject({
      phase: "verifying",
      error: null,
    });
    expect(projectUploadLifecycle(file("ready"), false)).toMatchObject({
      phase: "ready",
      error: null,
    });
  });

  it("keeps requested extraction active until its ready terminal state", () => {
    for (const status of ["queued", "running"] as const) {
      expect(projectUploadLifecycle(file("ready", extraction(status)), true)).toMatchObject({
        phase: "extracting",
        error: null,
      });
    }
    expect(projectUploadLifecycle(file("ready", extraction("ready")), true)).toMatchObject({
      phase: "ready",
      error: null,
    });
  });

  it("projects failed and unsupported extraction as explicit non-retryable failures", () => {
    expect(projectUploadLifecycle(file("ready", extraction("failed", {
      code: "PARSER_CRASHED",
      message: "Parser process exited",
    })), true)).toMatchObject({
      phase: "failed",
      error: {
        code: "PARSER_CRASHED",
        message: "Parser process exited",
        retryable: false,
      },
    });
    expect(projectUploadLifecycle(file("ready", extraction("unsupported")), true)).toMatchObject({
      phase: "failed",
      error: {
        code: "FILE_EXTRACTION_UNSUPPORTED",
        retryable: false,
      },
    });
  });

  it("preserves file failure details and supplies terminal fallbacks", () => {
    expect(projectUploadLifecycle(file("failed", null, {
      code: "MALWARE_SCAN_FAILED",
      message: "Scanner unavailable",
    }), false)).toMatchObject({
      phase: "failed",
      error: {
        code: "MALWARE_SCAN_FAILED",
        message: "Scanner unavailable",
        retryable: false,
      },
    });
    expect(projectUploadLifecycle(file("quarantined"), false)).toMatchObject({
      phase: "failed",
      error: { code: "FILE_QUARANTINED", retryable: false },
    });
  });
});
