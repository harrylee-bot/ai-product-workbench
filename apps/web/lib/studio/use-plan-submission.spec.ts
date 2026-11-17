// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  createPlan: vi.fn(),
  updatePlanInput: vi.fn(),
  createRevisionPlan: vi.fn(),
  createFeedback: vi.fn(),
  createSubmissionIntent: vi.fn(),
  submitSubmissionIntent: vi.fn(),
  createImportSource: vi.fn(),
  getImportSource: vi.fn(),
  uploadFiles: vi.fn(),
  completeUploadBatch: vi.fn(),
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
}));
vi.mock("@/lib/auth/workbench-auth", () => ({
  useWorkbenchAuth: () => ({ user: { id: "account-one" } }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks }));
vi.mock("@/lib/studio/api", () => ({
  useWorkbenchPrototypeV2Api: () => mocks,
  useWorkbenchSubmissionIntentsApi: () => mocks,
  useWorkbenchImportSourcesApi: () => mocks,
}));
vi.mock("@/lib/workbench/features/files", () => ({
  useWorkbenchFileTransferService: () => mocks,
  useWorkbenchUploadRegistry: () => ({ ...mocks, uploads: [] }),
}));
import { WorkbenchApiError } from "@/lib/workbench/api";
import { usePlanSubmission } from "./use-plan-submission";
import type { StudioSubmission } from "./types";
const input = (extra: Partial<StudioSubmission> = {}): StudioSubmission => ({
  prompt: "创建完整订单界面",
  modelId: "model-one",
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
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  sessionStorage.clear();
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.invalidateQueries.mockResolvedValue(undefined);
  mocks.createPlan.mockResolvedValue({ value: { id: "plan-one" } });
  mocks.updatePlanInput.mockResolvedValue({ value: { id: "plan-one" } });
  mocks.createRevisionPlan.mockResolvedValue({ value: { id: "plan-two" } });
  mocks.createFeedback.mockResolvedValue({ value: { id: "feedback-one" } });
  mocks.uploadFiles.mockResolvedValue({
    fileAssetIds: ["file-one"],
    batchId: "batch-one",
  });
  mocks.createImportSource.mockResolvedValue({ value: { id: "source-one" } });
  mocks.getImportSource.mockResolvedValue({
    value: { projectId: "project-one", status: "ready" },
  });
  mocks.createSubmissionIntent.mockResolvedValue({
    value: { id: "intent-one" },
  });
  mocks.submitSubmissionIntent.mockResolvedValue({
    value: { run: { id: "run-one" } },
  });
});
afterEach(cleanup);
describe("Studio durable submission commands", () => {
  it("replays an accepted plan across remount and file-to-source conversion using the exact request/key", async () => {
    mocks.createPlan.mockRejectedValueOnce(
      new Error("accepted; response lost"),
    );
    const first = renderHook(() => usePlanSubmission("project-one"));
    const file = new File(["input"], "requirements.txt");
    const converted = vi.fn();
    await act(async () => {
      await expect(
        first.result.current.create(
          input({ files: [file], onFileSource: converted }),
        ),
      ).rejects.toThrow("lost");
    });
    expect(converted).toHaveBeenCalledWith(file, "source-one");
    const original = mocks.createPlan.mock.calls[0];
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await second.result.current.create(input({ sourceIds: ["source-one"] }));
    });
    expect(mocks.createPlan.mock.calls[1]).toEqual(original);
    expect(mocks.uploadFiles).toHaveBeenCalledTimes(1);
    expect(mocks.createImportSource).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });
  it("a deliberate input change becomes a new command", async () => {
    mocks.createPlan.mockRejectedValueOnce(new Error("lost"));
    const hook = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(hook.result.current.create(input())).rejects.toThrow("lost");
    });
    await act(async () => {
      await hook.result.current.create(input({ prompt: "改为移动端订单界面" }));
    });
    expect(mocks.createPlan.mock.calls[0]![2]).not.toBe(
      mocks.createPlan.mock.calls[1]![2],
    );
  });
  it("uses the original CAS token after an accepted draft update advances its ETag", async () => {
    mocks.updatePlanInput.mockRejectedValueOnce(new Error("lost"));
    const first = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(
        first.result.current.saveInput(input(), {
          kind: "draft",
          id: "plan-one",
          etag: '"1"',
        }),
      ).rejects.toThrow("lost");
    });
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await second.result.current.saveInput(input(), {
        kind: "draft",
        id: "plan-one",
        etag: '"2"',
      });
    });
    expect(mocks.updatePlanInput.mock.calls[1]).toEqual(
      mocks.updatePlanInput.mock.calls[0],
    );
  });
  it("recovers the same run intent after a lost submission response", async () => {
    mocks.submitSubmissionIntent.mockRejectedValueOnce(new Error("lost"));
    const first = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(
        first.result.current.submitRun(
          input({ requestedArtifactKinds: ["prd"] }),
          "thread-one",
        ),
      ).rejects.toThrow("lost");
    });
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-one"));
    let result;
    await act(async () => {
      result = await second.result.current.submitRun(
        input({ requestedArtifactKinds: ["prd"] }),
        "thread-one",
      );
    });
    expect(result).toBe("run-one");
    expect(mocks.createSubmissionIntent.mock.calls[1]).toEqual(
      mocks.createSubmissionIntent.mock.calls[0],
    );
    expect(mocks.submitSubmissionIntent.mock.calls).toEqual([
      ["intent-one"],
      ["intent-one"],
    ]);
  });
  it("does not submit an intent whose creation response arrives after logout", async () => {
    const delayed = deferred<{ value: { id: string } }>();
    mocks.createSubmissionIntent.mockReturnValue(delayed.promise);
    const hook = renderHook(() => usePlanSubmission("project-one"));
    let result!: Promise<unknown>;
    await act(async () => {
      result = hook.result.current.submitRun(
        input({ requestedArtifactKinds: ["prd"] }),
        "thread-one",
      );
    });
    await act(async () => {
      window.dispatchEvent(new Event("workbench:logout"));
      delayed.resolve({ value: { id: "intent-one" } });
      expect(await result).toBeNull();
    });
    expect(mocks.submitSubmissionIntent).not.toHaveBeenCalled();
    expect(mocks.setQueryData).not.toHaveBeenCalled();
  });
  it("stops a late upload before source creation when the project changes", async () => {
    const delayed = deferred<{ fileAssetIds: string[]; batchId: string }>();
    mocks.uploadFiles.mockReturnValue(delayed.promise);
    const hook = renderHook(({ project }) => usePlanSubmission(project), {
      initialProps: { project: "project-one" },
    });
    let result!: Promise<unknown>;
    await act(async () => {
      result = hook.result.current.create(
        input({ files: [new File(["private"], "input.txt")] }),
      );
    });
    hook.rerender({ project: "project-two" });
    await act(async () => {
      delayed.resolve({ fileAssetIds: ["old-file"], batchId: "old-batch" });
      expect(await result).toBeNull();
    });
    expect(mocks.createImportSource).not.toHaveBeenCalled();
    expect(mocks.createPlan).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
  it("explicit recovery does not need the current composer inputs", async () => {
    mocks.createPlan.mockRejectedValueOnce(new Error("lost"));
    const first = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(first.result.current.create(input())).rejects.toThrow(
        "lost",
      );
    });
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await second.result.current.recover();
    });
    expect(mocks.createPlan.mock.calls[1]).toEqual(
      mocks.createPlan.mock.calls[0],
    );
  });
  it("an explicit rebase after a received CAS rejection uses a new key and current ETag", async () => {
    mocks.updatePlanInput.mockRejectedValueOnce(
      new WorkbenchApiError({
        type: "about:blank",
        title: "CAS rejected",
        status: 412,
        code: "PRECONDITION_FAILED",
      }),
    );
    const hook = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(
        hook.result.current.saveInput(input(), {
          kind: "draft",
          id: "plan-one",
          etag: '"1"',
        }),
      ).rejects.toThrow("CAS rejected");
    });
    await act(async () => {
      await hook.result.current.saveInput(input(), {
        kind: "draft",
        id: "plan-one",
        etag: '"2"',
      });
    });
    expect(mocks.updatePlanInput.mock.calls[1]![2]).toBe('"2"');
    expect(mocks.updatePlanInput.mock.calls[1]![4]).not.toBe(
      mocks.updatePlanInput.mock.calls[0]![4],
    );
  });
  it("does not reuse another project's pending intent", async () => {
    mocks.createPlan.mockRejectedValueOnce(new Error("lost"));
    const first = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(first.result.current.create(input())).rejects.toThrow(
        "lost",
      );
    });
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-two"));
    await act(async () => {
      await second.result.current.create(input());
    });
    expect(mocks.createPlan.mock.calls[0]![2]).not.toBe(
      mocks.createPlan.mock.calls[1]![2],
    );
    expect(sessionStorage.length).toBe(1);
  });
  it("persists element feedback key with revision plan submission and replays both across reload", async () => {
    mocks.createRevisionPlan.mockRejectedValueOnce(new Error("lost"));
    const first = renderHook(() => usePlanSubmission("project-one"));
    const target = {
      kind: "revision" as const,
      id: "rev-1",
      etag: '"1"',
      feedbackIds: [],
      feedback: {
        body: "调整按钮配色",
        anchor: {
          sourceRevisionId: "rev-1",
          scope: "node" as const,
          pageId: "home",
          nodeId: "save",
          quote: "保存",
        },
      },
    };
    await act(async () => {
      await expect(
        first.result.current.saveInput(
          input({
            prompt: "调整按钮配色",
            workflow: "edit",
            artifactTargets: [
              {
                artifactId: "proto-1",
                artifactVersionId: "ver-1",
                screenIds: [],
              },
            ],
          }),
          target,
        ),
      ).rejects.toThrow("lost");
    });
    const firstFeedbackCall = mocks.createFeedback.mock.calls[0];
    const firstPlanCall = mocks.createRevisionPlan.mock.calls[0];
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await second.result.current.recover();
    });
    expect(mocks.createFeedback.mock.calls[1]).toEqual(firstFeedbackCall);
    expect(mocks.createRevisionPlan.mock.calls[1]).toEqual(firstPlanCall);
    expect(firstPlanCall![3].feedbackIds).toEqual(["feedback-one"]);
  });
});
