// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  uploadFiles: vi.fn(),
  completeUploadBatch: vi.fn(),
  createImportSource: vi.fn(),
  getImportSource: vi.fn(),
  invalidateQueries: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks }));
vi.mock("./api", () => ({ useWorkbenchImportSourcesApi: () => mocks }));
vi.mock("@/lib/workbench/features/files", () => ({
  useWorkbenchFileTransferService: () => mocks,
  useWorkbenchUploadRegistry: () => ({ ...mocks, uploads: [] }),
}));
import { useStudioInputPreparation } from "./use-input-preparation";
import type { StudioSubmission } from "./types";
const input = (extra: Partial<StudioSubmission> = {}): StudioSubmission => ({
  prompt: "增加领取次数规则",
  modelId: "chosen-model",
  workflow: "generate",
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  sourceIds: [],
  files: [],
  requestedArtifactKinds: ["prototype"],
  artifactTargets: [],
  generationIntent: null,
  ...extra,
});
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.uploadFiles.mockResolvedValue({
    fileAssetIds: ["asset-one"],
    batchId: "batch-one",
  });
  mocks.createImportSource.mockResolvedValue({ value: { id: "source-one" } });
  mocks.getImportSource.mockResolvedValue({
    value: { projectId: "project-one", status: "ready" },
  });
  mocks.invalidateQueries.mockResolvedValue(undefined);
});
afterEach(cleanup);
it("reuses a successfully uploaded file when an unknown discussion reply must be recovered", async () => {
  const hook = renderHook(() => useStudioInputPreparation("project-one"));
  const file = new File(["private bytes"], "requirement.txt");
  const bind = vi.fn();
  const submission = input({ files: [file], onFileSource: bind });
  const first = await hook.result.current.prepare(submission, () => {});
  const second = await hook.result.current.prepare(submission, () => {});
  expect(mocks.uploadFiles).toHaveBeenCalledTimes(1);
  expect(mocks.createImportSource).toHaveBeenCalledTimes(1);
  expect(first.sourceIds).toEqual(["source-one"]);
  expect(second).toEqual(first);
  expect(mocks.createImportSource).toHaveBeenCalledWith(
    "project-one",
    { kind: "file", fileAssetId: "asset-one" },
    "studio-source-asset-one",
  );
  expect(bind).toHaveBeenCalledWith(file, "source-one");
});
it("rejects references that have moved to another project or are not ready", async () => {
  const hook = renderHook(() => useStudioInputPreparation("project-one"));
  mocks.getImportSource.mockResolvedValueOnce({
    value: { projectId: "other-project", status: "ready" },
  });
  await expect(
    hook.result.current.prepare(input({ sourceIds: ["source-one"] }), () => {}),
  ).rejects.toThrow("引用资料尚未就绪");
  mocks.getImportSource.mockResolvedValueOnce({
    value: { projectId: "project-one", status: "processing" },
  });
  await expect(
    hook.result.current.prepare(input({ sourceIds: ["source-one"] }), () => {}),
  ).rejects.toThrow("引用资料尚未就绪");
  expect(mocks.createImportSource).not.toHaveBeenCalled();
});
it("preserves pinned historical source references without replacing them with live descriptors", async () => {
  const hook = renderHook(() => useStudioInputPreparation("project-one"));
  const result = await hook.result.current.prepare(
    input({ sourceIds: ["source-fixed"], pinnedSourceIds: ["source-fixed"] }),
    () => {},
  );
  expect(result.sourceIds).toEqual(["source-fixed"]);
  expect(mocks.getImportSource).not.toHaveBeenCalled();
});
it("does not reuse a file asset cached under a different project", async () => {
  const hook = renderHook(
    ({ projectId }) => useStudioInputPreparation(projectId),
    { initialProps: { projectId: "project-one" } },
  );
  const file = new File(["bytes"], "requirement.txt");
  await hook.result.current.prepare(input({ files: [file] }), () => {});
  hook.rerender({ projectId: "project-two" });
  mocks.uploadFiles.mockResolvedValueOnce({
    fileAssetIds: ["asset-two"],
    batchId: "batch-two",
  });
  mocks.createImportSource.mockResolvedValueOnce({
    value: { id: "source-two" },
  });
  mocks.getImportSource.mockResolvedValueOnce({
    value: { projectId: "project-two", status: "ready" },
  });
  const next = await hook.result.current.prepare(
    input({ files: [file] }),
    () => {},
  );
  expect(next.sourceIds).toEqual(["source-two"]);
  expect(mocks.uploadFiles).toHaveBeenCalledTimes(2);
  expect(mocks.createImportSource).toHaveBeenLastCalledWith(
    "project-two",
    { kind: "file", fileAssetId: "asset-two" },
    "studio-source-asset-two",
  );
});
it("stops after an in-flight upload if its composer scope has been left", async () => {
  let resolve!: (value: { fileAssetIds: string[]; batchId: string }) => void;
  mocks.uploadFiles.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const hook = renderHook(() => useStudioInputPreparation("project-one"));
  let active = true;
  const bind = vi.fn();
  const pending = hook.result.current.prepare(
    input({
      files: [new File(["bytes"], "requirement.txt")],
      onFileSource: bind,
    }),
    () => {
      if (!active) throw new Error("scope left");
    },
  );
  active = false;
  resolve({ fileAssetIds: ["asset-one"], batchId: "batch-one" });
  await expect(pending).rejects.toThrow("scope left");
  expect(mocks.createImportSource).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
});
