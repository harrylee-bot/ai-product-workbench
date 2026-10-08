// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchPublicationController } from "./workbench-publication-controller";

const mocks = vi.hoisted(() => ({ saveDrafts: vi.fn(), releases: vi.fn(), export: vi.fn(), rotate: vi.fn() }));
vi.mock("../prd-editor/draft-context", () => ({ useWorkbenchPrdDraftStore: () => ({ saveProject: mocks.saveDrafts, hasDrafts: () => true }) }));
vi.mock("./releases", () => ({
  useWorkbenchReleases: () => ({ refetch: mocks.releases }),
  useCreateWorkbenchRelease: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("./shares", () => ({
  useWorkbenchShareGrants: () => ({ isSuccess: true, data: { items: [], activeCount: 0 } }),
  useRotateWorkbenchShareGrant: () => ({ mutateAsync: mocks.rotate, isPending: false }),
  useRevokeWorkbenchProjectShareGrants: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("./exports", () => ({
  selectLatestRestorableExport: () => null,
  useWorkbenchExportOperations: () => ({}),
  useWorkbenchExportCapabilities: () => ({ data: { formats: { docx: { available: true } }, packaging: { single_file: { available: true } } } }),
  useWorkbenchExportJobs: () => ({ data: { items: [] }, isPending: false }),
  useCreateWorkbenchExportJob: () => ({ mutateAsync: mocks.export, isPending: false }),
  useWorkbenchExportJob: () => ({ data: null }),
  useCancelWorkbenchExportJob: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveDrafts.mockResolvedValue([]);
  mocks.releases.mockResolvedValue({ data: { items: [{
    id: "release-2", status: "ready", boardId: "board-1", boardRevision: 2,
    artifactPins: [{ artifactId: "prd-1", artifactVersionId: "prd-v2", kind: "prd" }, { artifactId: "prototype-1", artifactVersionId: "prototype-v1", kind: "prototype" }],
  }] } });
  mocks.export.mockResolvedValue({ value: { id: "export-1", status: "queued", selection: { kind: "artifact", artifactId: "prd-1", artifactVersionId: "prd-v2" } } });
  mocks.rotate.mockResolvedValue({ value: { share: { id: "share-1" }, token: "token-1" } });
});
afterEach(cleanup);

function controller() {
  return renderHook(() => useWorkbenchPublicationController({
    projectId: "project-1", canExport: true, canPreview: true, canShare: true,
    boardController: {
      store: { getState: () => ({ boardId: "board-1", serverRevision: 2, dirty: false, saveStatus: "clean", nodes: [] }) },
      save: vi.fn(),
    } as never,
  }));
}

describe("PRD publication save barrier", () => {
  it("exports the saved PRD version only after the save barrier and release refresh", async () => {
    mocks.saveDrafts.mockResolvedValueOnce([{ projectId: "project-1", artifactId: "prd-1", artifactVersionId: "prd-v1", savedArtifactVersionId: "prd-v2" }]);
    const rendered = controller();
    await act(async () => { await rendered.result.current.startExport("Download Word", { kind: "artifact", artifactId: "prd-1", artifactVersionId: "prd-v1" }); });
    expect(mocks.export).toHaveBeenCalledWith({ request: {
      releaseId: "release-2", format: "docx", packaging: "single_file", options: {},
      selection: { kind: "artifact", artifactId: "prd-1", artifactVersionId: "prd-v2" },
    } });
    expect(mocks.saveDrafts.mock.invocationCallOrder[0]).toBeLessThan(mocks.releases.mock.invocationCallOrder[0]);
    expect(mocks.releases.mock.invocationCallOrder[0]).toBeLessThan(mocks.export.mock.invocationCallOrder[0]);
  });

  it("blocks sharing, export and preview when a draft cannot be saved", async () => {
    mocks.saveDrafts.mockRejectedValue(new Error("草稿保存失败"));
    const rendered = controller();
    await act(async () => {
      await expect(rendered.result.current.enableShare()).rejects.toThrow("草稿保存失败");
      await expect(rendered.result.current.startExport("Download Word", { kind: "board" })).rejects.toThrow("草稿保存失败");
      await expect(rendered.result.current.createPreview({ kind: "board" })).rejects.toThrow("草稿保存失败");
    });
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.releases).not.toHaveBeenCalled();
  });
});
