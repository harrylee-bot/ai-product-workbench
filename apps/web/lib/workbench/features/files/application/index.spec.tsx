// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useWorkbenchFileTransferService } from "./index";

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

describe("Workbench File transfer service", () => {
  it("passes the feature-owned adapter directly to the multipart upload layer", () => {
    const rendered = renderHook(() => useWorkbenchFileTransferService());

    expect(rendered.result.current).toBe(mocks);
    rendered.unmount();
  });

});
