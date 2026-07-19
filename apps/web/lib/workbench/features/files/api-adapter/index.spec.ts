// @vitest-environment jsdom

import type {
  FileAsset,
  FileExtraction,
  FileUploadSession,
} from "@workbench/workbench-contracts";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import type { WorkbenchFileTransferService } from "../../../files/uppy-multipart";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchTransportProvider } from "../../../transport/context";
import {
  useWorkbenchFilesApi,
  WorkbenchFilesApi,
} from "./index";

const timestamp = "2026-07-15T00:00:00.000Z";
const partSize = 5 * 1024 * 1024;
const readyFile: FileAsset = {
  id: "file-1",
  projectId: "project-1",
  blobId: "blob-1",
  originalName: "brief.pdf",
  declaredMediaType: "application/pdf",
  detectedMediaType: "application/pdf",
  byteSize: 1_024,
  status: "ready",
  revision: 2,
  sha256: "a".repeat(64),
  failure: null,
  currentExtraction: null,
  latestExtraction: null,
  verifiedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const uploadingFile: FileAsset = {
  ...readyFile,
  blobId: null,
  detectedMediaType: null,
  status: "uploading",
  revision: 1,
  sha256: null,
  verifiedAt: null,
};
const verifyingFile: FileAsset = {
  ...uploadingFile,
  status: "verifying",
  revision: 2,
};
const queuedExtraction: FileExtraction = {
  id: "extraction-1",
  fileAssetId: readyFile.id,
  attempt: 1,
  status: "queued",
  parser: "docling-serve",
  parserVersion: "1.26.0",
  outputSchemaVersion: 1,
  contentSha256: null,
  failure: null,
  startedAt: null,
  finishedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const upload: FileUploadSession = {
  id: "upload-1",
  fileAssetId: readyFile.id,
  status: "initiated",
  partSize,
  revision: 1,
  expiresAt: "2026-07-16T00:00:00.000Z",
};

describe("Files API contracts", () => {
  it("keeps one feature-owned adapter instance and satisfies the Uppy transfer port", () => {
    const rendered = renderHook(() => useWorkbenchFilesApi(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(
        WorkbenchTransportProvider,
        null,
        children,
      ),
    });
    const first = rendered.result.current;

    rendered.rerender();

    expect(rendered.result.current).toBe(first);
    expect(first).toBeInstanceOf(WorkbenchFilesApi);
    expectTypeOf(first).toMatchTypeOf<WorkbenchFileTransferService>();
    rendered.unmount();
  });

  it("owns File discovery, detail, deletion, and extraction CAS", async () => {
    const requests: Request[] = [];
    const api = createApi(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/projects/project-1/files")) {
        expect(url.searchParams.get("status")).toBe("ready");
        expect(url.searchParams.get("cursor")).toBe("cursor-1");
        expect(url.searchParams.get("limit")).toBe("25");
        return Response.json({ items: [readyFile], nextCursor: "cursor-2" });
      }
      if (request.method === "GET" && url.pathname.endsWith("/files/file-1")) {
        return Response.json(readyFile, { headers: { ETag: '"2"' } });
      }
      if (request.method === "POST" && url.pathname.endsWith("/files/file-1/extractions")) {
        return Response.json(queuedExtraction, { status: 202, headers: { ETag: '"3"' } });
      }
      if (request.method === "DELETE" && url.pathname.endsWith("/files/file-1")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });

    await expect(api.listFiles("project-1", {
      status: "ready",
      cursor: "cursor-1",
      limit: 25,
    })).resolves.toEqual({ items: [readyFile], nextCursor: "cursor-2" });
    await expect(api.getFile(readyFile.id))
      .resolves.toEqual({ value: readyFile, etag: '"2"' });
    await expect(api.createFileExtraction(
      readyFile.id,
      '  "2"  ',
      "extract:req_123",
    )).resolves.toEqual({ value: queuedExtraction, etag: '"3"' });
    await expect(api.deleteFile(readyFile.id, '  "3"  ')).resolves.toBeUndefined();

    const extractionRequest = requests.find((request) => request.method === "POST");
    const deleteRequest = requests.find((request) => request.method === "DELETE");
    expect(extractionRequest?.headers.get("if-match")).toBe('"2"');
    expect(extractionRequest?.headers.get("idempotency-key")).toBe("extract:req_123");
    expect(deleteRequest?.headers.get("if-match")).toBe('"3"');
  });

  it("owns multipart session creation, signing, completion, reconciliation, and abort", async () => {
    const requests: Request[] = [];
    const completedUpload = { ...upload, status: "completed" as const, revision: 2 };
    const api = createApi(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/projects/project-1/file-upload-sessions")) {
        return Response.json({ file: uploadingFile, upload }, {
          status: 201,
          headers: { ETag: '"1"' },
        });
      }
      if (request.method === "GET" && url.pathname.endsWith("/file-upload-sessions/upload-1/parts")) {
        return Response.json({
          parts: [{ partNumber: 1, etag: '"part-1"', byteSize: 1_024 }],
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/file-upload-sessions/upload-1/parts/1")) {
        return Response.json({
          uploadSessionId: upload.id,
          partNumber: 1,
          method: "PUT",
          url: "https://uploads.example.test/part-1",
          headers: { "content-length": "1024" },
          expiresAt: "2026-07-15T01:00:00.000Z",
        }, { headers: { ETag: '"1"' } });
      }
      if (request.method === "POST" && url.pathname.endsWith("/file-upload-sessions/upload-1/complete")) {
        return Response.json({ file: verifyingFile, upload: completedUpload }, {
          status: 202,
          headers: { ETag: '"2"' },
        });
      }
      if (request.method === "GET" && url.pathname.endsWith("/file-upload-sessions/upload-1")) {
        return Response.json(upload, { headers: { ETag: '"1"' } });
      }
      if (request.method === "DELETE" && url.pathname.endsWith("/file-upload-sessions/upload-1")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    const createRequest = {
      fileName: "brief.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    };

    await expect(api.createFileUpload("project-1", createRequest, "upload:req_123"))
      .resolves.toEqual({ value: { file: uploadingFile, upload }, etag: '"1"' });
    await expect(api.getFileUpload(upload.id))
      .resolves.toEqual({ value: upload, etag: '"1"' });
    await expect(api.listFileUploadParts(upload.id)).resolves.toEqual({
      parts: [{ partNumber: 1, etag: '"part-1"', byteSize: 1_024 }],
    });
    await expect(api.signFileUploadPart(upload.id, 1, { contentLength: 1_024 }, '  "1"  '))
      .resolves.toMatchObject({
        value: { uploadSessionId: upload.id, partNumber: 1 },
        etag: '"1"',
      });
    await expect(api.completeFileUpload(
      upload.id,
      { parts: [{ partNumber: 1, etag: '"part-1"' }] },
      '  "1"  ',
      "complete:req_123",
    )).resolves.toEqual({
      value: { file: verifyingFile, upload: completedUpload },
      etag: '"2"',
    });
    await expect(api.abortFileUpload(upload.id, '  "2"  ')).resolves.toBeUndefined();

    const create = requests.find((request) => request.url.endsWith("/file-upload-sessions"));
    const sign = requests.find((request) => request.url.endsWith("/parts/1"));
    const complete = requests.find((request) => request.url.endsWith("/complete"));
    const abort = requests.find((request) => request.method === "DELETE");
    expect(create?.headers.get("idempotency-key")).toBe("upload:req_123");
    await expect(create?.clone().json()).resolves.toEqual(createRequest);
    expect(sign?.headers.get("if-match")).toBe('"1"');
    await expect(sign?.clone().json()).resolves.toEqual({ contentLength: 1_024 });
    expect(complete?.headers.get("if-match")).toBe('"1"');
    expect(complete?.headers.get("idempotency-key")).toBe("complete:req_123");
    expect(abort?.headers.get("if-match")).toBe('"2"');
  });

  it("rejects a structurally invalid File response", async () => {
    const api = createApi(async () => Response.json(
      { id: "file-1" },
      { headers: { ETag: '"1"' } },
    ));

    await expect(api.getFile("file-1")).rejects
      .toBeInstanceOf(WorkbenchContractError);
  });
});

function createApi(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchFilesApi(createWorkbenchApiClient({
    baseUrl: `${window.location.origin}/api/v1`,
    fetch: vi.fn(fetch),
  }));
}
