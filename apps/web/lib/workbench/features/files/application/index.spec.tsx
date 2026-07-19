// @vitest-environment jsdom

import type {
  FileAsset,
  FileExtraction,
  FileUploadSession,
} from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { WorkbenchVersionRequiredError } from "../../../transport/contracts";
import {
  useAbortWorkbenchFileUpload,
  useCreateWorkbenchFileExtraction,
  useCreateWorkbenchFileUpload,
  useDeleteWorkbenchFile,
  useWorkbenchFile,
  useWorkbenchFiles,
  useWorkbenchFileTransferService,
  useWorkbenchFileUpload,
} from "./index";

const mocks = vi.hoisted(() => ({
  abortFileUpload: vi.fn(),
  completeFileUpload: vi.fn(),
  createFileExtraction: vi.fn(),
  createFileUpload: vi.fn(),
  deleteFile: vi.fn(),
  getFile: vi.fn(),
  getFileUpload: vi.fn(),
  listFileUploadParts: vi.fn(),
  listFiles: vi.fn(),
  signFileUploadPart: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchFilesApi: () => mocks,
}));

const timestamp = "2026-07-15T00:00:00.000Z";
const file: FileAsset = {
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
const upload: FileUploadSession = {
  id: "upload-1",
  fileAssetId: file.id,
  status: "initiated",
  partSize: 5 * 1024 * 1024,
  revision: 1,
  expiresAt: "2026-07-16T00:00:00.000Z",
};
const extraction: FileExtraction = {
  id: "extraction-1",
  fileAssetId: file.id,
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench File hooks", () => {
  it("loads File list, detail, and upload session through the feature adapter", async () => {
    const queryClient = client();
    const list = { items: [file], nextCursor: null };
    const detail = { value: file, etag: '"2"' };
    const session = { value: upload, etag: '"1"' };
    mocks.listFiles.mockResolvedValue(list);
    mocks.getFile.mockResolvedValue(detail);
    mocks.getFileUpload.mockResolvedValue(session);
    const listHook = renderHook(
      () => useWorkbenchFiles("project-1", { status: "ready" }),
      { wrapper: wrapper(queryClient) },
    );
    const detailHook = renderHook(
      () => useWorkbenchFile("project-1", file.id),
      { wrapper: wrapper(queryClient) },
    );
    const uploadHook = renderHook(
      () => useWorkbenchFileUpload("project-1", upload.id),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(listHook.result.current.data).toEqual(list));
    await waitFor(() => expect(detailHook.result.current.data).toEqual(detail));
    await waitFor(() => expect(uploadHook.result.current.data).toEqual(session));
    expect(mocks.listFiles).toHaveBeenCalledWith("project-1", { status: "ready" });
    expect(mocks.getFile).toHaveBeenCalledWith(file.id);
    expect(mocks.getFileUpload).toHaveBeenCalledWith(upload.id);

    listHook.unmount();
    detailHook.unmount();
    uploadHook.unmount();
    queryClient.clear();
  });

  it("passes the feature-owned adapter directly to the multipart upload layer", () => {
    const rendered = renderHook(() => useWorkbenchFileTransferService());

    expect(rendered.result.current).toBe(mocks);
    rendered.unmount();
  });

  it("creates upload sessions and owns the upload-session cache", async () => {
    const queryClient = client();
    seedFileList(queryClient);
    const result = { value: { file, upload }, etag: '"1"' };
    mocks.createFileUpload.mockResolvedValue(result);
    const rendered = renderHook(
      () => useCreateWorkbenchFileUpload("project-1"),
      { wrapper: wrapper(queryClient) },
    );
    const request = {
      fileName: "brief.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    };

    await act(() => rendered.result.current.mutateAsync({
      request,
      idempotencyKey: "upload:req_123",
    }));

    expect(mocks.createFileUpload).toHaveBeenCalledWith(
      "project-1",
      request,
      "upload:req_123",
    );
    expect(queryClient.getQueryData(workbenchQueryKeys.fileUpload("project-1", upload.id)))
      .toEqual({ value: upload, etag: '"1"' });
    expect(queryClient.getQueryState(workbenchQueryKeys.fileList("project-1"))?.isInvalidated)
      .toBe(true);
    rendered.unmount();
    queryClient.clear();
  });

  it("uses cached File CAS state for extraction and deletion", async () => {
    const queryClient = client();
    seedFileList(queryClient);
    queryClient.setQueryData(
      workbenchQueryKeys.file("project-1", file.id),
      { value: file, etag: '"2"' },
    );
    mocks.createFileExtraction.mockResolvedValue({ value: extraction, etag: '"3"' });
    mocks.deleteFile.mockResolvedValue(undefined);
    const extractionHook = renderHook(
      () => useCreateWorkbenchFileExtraction("project-1", file.id),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => extractionHook.result.current.mutateAsync({
      idempotencyKey: "extract:req_123",
    }));
    expect(mocks.createFileExtraction).toHaveBeenCalledWith(
      file.id,
      '"2"',
      "extract:req_123",
    );
    expect(queryClient.getQueryState(workbenchQueryKeys.file("project-1", file.id))?.isInvalidated)
      .toBe(true);

    queryClient.setQueryData(
      workbenchQueryKeys.file("project-1", file.id),
      { value: file, etag: '"3"' },
    );
    seedFileList(queryClient);
    const deleteHook = renderHook(
      () => useDeleteWorkbenchFile("project-1", file.id),
      { wrapper: wrapper(queryClient) },
    );
    await act(() => deleteHook.result.current.mutateAsync({}));
    expect(mocks.deleteFile).toHaveBeenCalledWith(file.id, '"3"');
    expect(queryClient.getQueryData(workbenchQueryKeys.file("project-1", file.id)))
      .toBeUndefined();
    await expect(deleteHook.result.current.mutateAsync({})).rejects
      .toBeInstanceOf(WorkbenchVersionRequiredError);

    extractionHook.unmount();
    deleteHook.unmount();
    queryClient.clear();
  });

  it("aborts upload sessions with cached CAS state", async () => {
    const queryClient = client();
    seedFileList(queryClient);
    queryClient.setQueryData(
      workbenchQueryKeys.fileUpload("project-1", upload.id),
      { value: upload, etag: '"4"' },
    );
    mocks.abortFileUpload.mockResolvedValue(undefined);
    const rendered = renderHook(
      () => useAbortWorkbenchFileUpload("project-1", upload.id),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => rendered.result.current.mutateAsync({}));

    expect(mocks.abortFileUpload).toHaveBeenCalledWith(upload.id, '"4"');
    expect(queryClient.getQueryState(workbenchQueryKeys.fileUpload("project-1", upload.id))?.isInvalidated)
      .toBe(true);
    expect(queryClient.getQueryState(workbenchQueryKeys.fileList("project-1"))?.isInvalidated)
      .toBe(true);
    rendered.unmount();
    queryClient.clear();
  });
});

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return function WorkbenchQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function seedFileList(queryClient: QueryClient) {
  queryClient.setQueryData(workbenchQueryKeys.fileList("project-1"), {
    items: [file],
    nextCursor: null,
  });
}
