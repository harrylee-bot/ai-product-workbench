// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkbenchCanvasMediaInfrastructure } from "./index";

const mocks = vi.hoisted(() => ({
  artifactMutation: {
    isPending: true,
    mutateAsync: vi.fn(),
  },
  createArtifactHook: vi.fn(),
  createUpload: vi.fn(),
  fileTransferService: { port: "files" },
  fileTransferServiceHook: vi.fn(),
}));

vi.mock("../../artifacts", () => ({
  useCreateWorkbenchArtifact: mocks.createArtifactHook,
}));

vi.mock("../../files", () => ({
  createWorkbenchMultipartUpload: mocks.createUpload,
  useWorkbenchFileTransferService: mocks.fileTransferServiceHook,
}));

beforeEach(() => {
  mocks.artifactMutation.mutateAsync.mockReset();
  mocks.createArtifactHook.mockReset();
  mocks.createUpload.mockReset();
  mocks.fileTransferServiceHook.mockReset();
  mocks.createArtifactHook.mockReturnValue(mocks.artifactMutation);
  mocks.fileTransferServiceHook.mockReturnValue(mocks.fileTransferService);
  mocks.createUpload.mockResolvedValue({ upload: "controller" });
});

describe("Workbench canvas Media infrastructure adapter", () => {
  it("binds Artifact and multipart commands to the same Project infrastructure", async () => {
    const rendered = renderHook(() => useWorkbenchCanvasMediaInfrastructure("project-1"));
    const file = new File(["image"], "hero.png", { type: "image/png" });
    const artifactCommand = {
      idempotencyKey: "artifact:media:one",
      request: {
        kind: "image" as const,
        source: { kind: "file" as const, fileAssetId: "file-1" },
        title: "hero",
      },
    };

    expect(mocks.createArtifactHook).toHaveBeenCalledWith("project-1");
    expect(mocks.fileTransferServiceHook).toHaveBeenCalledOnce();
    expect(rendered.result.current.artifact.isPending).toBe(true);

    await act(async () => {
      await rendered.result.current.createUpload(file);
      await rendered.result.current.artifact.create(artifactCommand);
    });

    expect(mocks.createUpload).toHaveBeenCalledWith({
      file,
      projectId: "project-1",
      requestExtraction: false,
      service: mocks.fileTransferService,
    });
    expect(mocks.artifactMutation.mutateAsync).toHaveBeenCalledWith(artifactCommand);
  });
});
