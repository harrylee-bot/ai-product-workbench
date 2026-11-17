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

describe("Studio feedback write and CAS boundaries", () => {
  const target = {
    kind: "revision" as const,
    id: "rev-1",
    etag: '"1"',
    feedback: {
      body: "调整按钮配色",
      anchor: {
        sourceRevisionId: "rev-1",
        scope: "node" as const,
        pageId: "home",
        nodeId: "save",
      },
    },
  };
  const edit = input({
    prompt: "调整按钮配色",
    workflow: "edit",
    artifactTargets: [
      { artifactId: "proto-1", artifactVersionId: "ver-1", screenIds: [] },
    ],
  });
  it("keeps the same feedback identity across a plan CAS rebase and remount", async () => {
    const receipts = new Map<string, string>();
    mocks.createFeedback.mockImplementation(async (_p, _r, _b, key: string) => {
      if (!receipts.has(key)) receipts.set(key, `saved-${receipts.size + 1}`);
      return { value: { id: receipts.get(key) } };
    });
    mocks.createRevisionPlan.mockRejectedValueOnce(
      new WorkbenchApiError({
        type: "about:blank",
        title: "stale",
        status: 412,
        code: "PRECONDITION_FAILED",
      }),
    );
    const first = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(
        first.result.current.saveInput(edit, target),
      ).rejects.toMatchObject({ status: 412 });
    });
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await second.result.current.saveInput(edit, { ...target, etag: '"2"' });
    });
    expect(receipts.size).toBe(1);
    expect(mocks.createFeedback.mock.calls[1]![3]).toBe(
      mocks.createFeedback.mock.calls[0]![3],
    );
    expect(mocks.createRevisionPlan.mock.calls[1]![4]).not.toBe(
      mocks.createRevisionPlan.mock.calls[0]![4],
    );
    expect(mocks.createRevisionPlan.mock.calls[1]![3].feedbackIds).toEqual([
      "saved-1",
    ]);
    expect(mocks.createRevisionPlan.mock.calls[1]![2]).toBe('"2"');
  });
  it("rejects a combined feedback selection over 100 before any write", async () => {
    const hook = renderHook(() => usePlanSubmission("project-one"));
    let error: unknown;
    await act(async () => {
      try {
        await hook.result.current.saveInput(
          { ...edit, files: [new File(["private"], "input.txt")] },
          {
            ...target,
            feedbackIds: Array.from({ length: 100 }, (_, i) => `selected-${i}`),
          },
        );
      } catch (cause) {
        error = cause;
      }
    });
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
    expect(mocks.createImportSource).not.toHaveBeenCalled();
    expect(mocks.createFeedback).not.toHaveBeenCalled();
    expect(mocks.createRevisionPlan).not.toHaveBeenCalled();
    expect(error).toBeDefined();
  });
  it("accepts 99 selected feedback items plus one element feedback", async () => {
    const hook = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await hook.result.current.saveInput(edit, {
        ...target,
        feedbackIds: Array.from({ length: 99 }, (_, i) => `selected-${i}`),
      });
    });
    expect(mocks.createFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.createRevisionPlan.mock.calls[0]![3].feedbackIds).toHaveLength(
      100,
    );
  });
  it("accepts 100 existing items with no new feedback and deduplicates repeated selections", async () => {
    const hook = renderHook(() => usePlanSubmission("project-one"));
    const ids = Array.from({ length: 100 }, (_, i) => `selected-${i}`);
    await act(async () => {
      await hook.result.current.saveInput(edit, {
        ...target,
        feedback: undefined,
        feedbackIds: [...ids, ids[0]!],
      });
    });
    expect(mocks.createFeedback).not.toHaveBeenCalled();
    expect(mocks.createRevisionPlan.mock.calls[0]![3].feedbackIds).toHaveLength(
      100,
    );
  });
  it("requires an explicit rebase after known 412 and reuses feedback even when plan text changes", async () => {
    mocks.createRevisionPlan.mockRejectedValueOnce(
      new WorkbenchApiError({
        type: "about:blank",
        title: "stale",
        status: 412,
        code: "PRECONDITION_FAILED",
      }),
    );
    const first = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(
        first.result.current.saveInput(edit, target),
      ).rejects.toMatchObject({ status: 412 });
    });
    first.unmount();
    const second = renderHook(() => usePlanSubmission("project-one"));
    expect(second.result.current.recoveryTitle).toBeUndefined();
    await act(async () => {
      await expect(second.result.current.recover()).rejects.toThrow(
        "核对最新版本",
      );
    });
    expect(mocks.createRevisionPlan).toHaveBeenCalledTimes(1);
    await act(async () => {
      await second.result.current.saveInput(
        { ...edit, prompt: "同时调整按钮间距" },
        { ...target, etag: '"2"' },
      );
    });
    expect(mocks.createFeedback.mock.calls[1]![3]).toBe(
      mocks.createFeedback.mock.calls[0]![3],
    );
    expect(mocks.createRevisionPlan.mock.calls[1]![2]).toBe('"2"');
    expect(mocks.createRevisionPlan.mock.calls[1]![4]).not.toBe(
      mocks.createRevisionPlan.mock.calls[0]![4],
    );
  });
  it("uses a new feedback identity if the anchor or body changes after a rejected plan", async () => {
    mocks.createRevisionPlan.mockRejectedValueOnce(
      new WorkbenchApiError({
        type: "about:blank",
        title: "stale",
        status: 412,
        code: "PRECONDITION_FAILED",
      }),
    );
    const hook = renderHook(() => usePlanSubmission("project-one"));
    await act(async () => {
      await expect(
        hook.result.current.saveInput(edit, target),
      ).rejects.toMatchObject({ status: 412 });
    });
    await act(async () => {
      await hook.result.current.saveInput(edit, {
        ...target,
        etag: '"2"',
        feedback: { ...target.feedback, body: "调整另一处颜色" },
      });
    });
    expect(mocks.createFeedback.mock.calls[1]![3]).not.toBe(
      mocks.createFeedback.mock.calls[0]![3],
    );
  });
});

import { createPrototypeRevisionPlanRequestSchema } from "@workbench/workbench-contracts";
it("contract independently accepts 100 selected feedback ids and rejects 101", () => {
  const generationRequest = {
    prompt: "调整按钮配色",
    modelId: "model-one",
    workflow: "edit",
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    requestedArtifactKinds: ["prototype"],
    artifactTargets: [
      { artifactId: "proto-1", artifactVersionId: "ver-1", screenIds: [] },
    ],
    generationIntent: null,
    canvasSnapshot: null,
  };
  const base = {
    title: "订单颜色修订",
    prompt: "调整按钮配色",
    generationRequest,
  };
  const ids = Array.from({ length: 100 }, (_, i) => `selected-${i}`);
  expect(
    createPrototypeRevisionPlanRequestSchema.safeParse({
      ...base,
      feedbackIds: ids,
    }).success,
  ).toBe(true);
  expect(
    createPrototypeRevisionPlanRequestSchema.safeParse({
      ...base,
      feedbackIds: [...ids, "new-feedback"],
    }).success,
  ).toBe(false);
});
