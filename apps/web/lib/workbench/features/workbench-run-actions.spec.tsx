// @vitest-environment jsdom

import type {
  ApprovalDecision,
  Run,
  RunApproval,
} from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  firstPendingApproval,
  isCancellableRun,
  isRetryableRun,
  useWorkbenchRunActions,
} from "./workbench-run-actions";

const mocks = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  listRunApprovals: vi.fn(),
  retryRun: vi.fn(),
  submitRunApproval: vi.fn(),
}));

vi.mock("./runs/api-adapter", () => ({
  useWorkbenchRunsApi: () => mocks,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRunApprovals.mockResolvedValue({ items: [approval()] });
  mocks.cancelRun.mockResolvedValue(run("cancelled"));
  mocks.retryRun.mockResolvedValue({ ...run("queued"), id: "run-2", retryOfRunId: "run-1" });
  mocks.submitRunApproval.mockResolvedValue({
    value: {
      approval: approval("submitted"),
      run: run("running"),
    },
    etag: '"2"',
  });
});

describe("Workbench Run actions", () => {
  it("loads the first pending approval and binds cancel to the current Run ids", async () => {
    const queryClient = client();
    const rendered = renderHook(() => useWorkbenchRunActions(run("running")), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.pendingApproval?.id).toBe("approval-1"));
    expect(rendered.result.current.canCancel).toBe(true);
    expect(mocks.listRunApprovals).toHaveBeenCalledWith("run-1");

    await act(() => rendered.result.current.cancel());

    expect(mocks.cancelRun).toHaveBeenCalledWith("run-1", undefined);
    expect(queryClient.getQueryData(["workbench", "runs", "run-1"]))
      .toMatchObject({ status: "cancelled" });
    rendered.unmount();
    queryClient.clear();
  });

  it("submits the pending approval with its id and preserves structured values", async () => {
    let approvals: RunApproval[] = [approval()];
    mocks.listRunApprovals.mockImplementation(async () => ({ items: approvals }));
    mocks.submitRunApproval.mockImplementation(async (
      runId: string,
      approvalId: string,
      request: { decision: ApprovalDecision },
    ) => {
      expect({ runId, approvalId, request }).toEqual({
        runId: "run-1",
        approvalId: "approval-1",
        request: { decision: "submit", value: { choice: "compact" } },
      });
      approvals = [approval("submitted")];
      return {
        value: { approval: approvals[0], run: run("running") },
        etag: '"2"',
      };
    });
    const queryClient = client();
    const rendered = renderHook(() => useWorkbenchRunActions(run("waiting_input")), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(rendered.result.current.pendingApproval).not.toBeNull());

    await act(() => rendered.result.current.submitApproval(
      "submit",
      { choice: "compact" },
    ));

    expect(mocks.submitRunApproval).toHaveBeenCalledWith(
      "run-1",
      "approval-1",
      { decision: "submit", value: { choice: "compact" } },
      undefined,
    );
    await waitFor(() => expect(rendered.result.current.pendingApproval).toBeNull());
    rendered.unmount();
    queryClient.clear();
  });

  it("exposes mutation busy and cancellation errors", async () => {
    let rejectCancel!: (error: unknown) => void;
    mocks.cancelRun.mockReturnValue(new Promise((_, reject) => {
      rejectCancel = reject;
    }));
    const queryClient = client();
    const rendered = renderHook(() => useWorkbenchRunActions(run("running")), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(rendered.result.current.pendingApproval).not.toBeNull());

    let cancellation!: Promise<unknown>;
    act(() => {
      cancellation = rendered.result.current.cancel();
    });
    await waitFor(() => expect(rendered.result.current.busy).toBe(true));
    expect(rendered.result.current.canCancel).toBe(false);
    act(() => rejectCancel(new Error("cancel failed")));
    await expect(cancellation).rejects.toThrow("cancel failed");
    await waitFor(() => expect(rendered.result.current.error).toMatchObject({
      message: "cancel failed",
    }));
    expect(mocks.cancelRun).toHaveBeenCalledOnce();
    rendered.unmount();
    queryClient.clear();
  });

  it("retries only a server-marked retryable failed Run and adopts the new Run", async () => {
    const onRetried = vi.fn();
    const queryClient = client();
    const rendered = renderHook(() => useWorkbenchRunActions(run("failed", true), onRetried), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.canRetry).toBe(true));
    await act(() => rendered.result.current.retry());

    expect(mocks.retryRun).toHaveBeenCalledWith("run-1", undefined);
    expect(onRetried).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-2",
      retryOfRunId: "run-1",
    }));
    rendered.unmount();
    queryClient.clear();
  });

  it("disables actions when there is no current or cancellable Run", async () => {
    const queryClient = client();
    const rendered = renderHook(() => useWorkbenchRunActions(null), {
      wrapper: wrapper(queryClient),
    });

    expect(rendered.result.current.canCancel).toBe(false);
    expect(rendered.result.current.pendingApproval).toBeNull();
    expect(mocks.listRunApprovals).not.toHaveBeenCalled();
    await expect(rendered.result.current.cancel()).rejects.toThrow("cannot be cancelled");
    await expect(rendered.result.current.submitApproval("approve"))
      .rejects.toThrow("no pending approval");
    rendered.unmount();
    queryClient.clear();
  });

  it("recovers a waiting-input approval query without retrying the Run mutation", async () => {
    mocks.listRunApprovals
      .mockRejectedValueOnce(new Error("approval list unavailable"))
      .mockResolvedValueOnce({ items: [approval()] });
    const queryClient = client();
    const rendered = renderHook(() => useWorkbenchRunActions(run("waiting_input")), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.approvalsError).toMatchObject({
      message: "approval list unavailable",
    }));
    expect(rendered.result.current.pendingApproval).toBeNull();
    expect(rendered.result.current.error).toBeNull();

    await act(async () => {
      await rendered.result.current.retryApprovals();
    });

    await waitFor(() => expect(rendered.result.current.pendingApproval?.id).toBe("approval-1"));
    expect(mocks.listRunApprovals).toHaveBeenCalledTimes(2);
    expect(mocks.retryRun).not.toHaveBeenCalled();
    rendered.unmount();
    queryClient.clear();
  });
});

describe("Workbench Run action selectors", () => {
  it("selects pending approvals and only permits active lifecycle states", () => {
    expect(firstPendingApproval([
      approval("approved", "approval-0"),
      approval("pending", "approval-1"),
    ])?.id).toBe("approval-1");
    expect(firstPendingApproval([approval("expired")])).toBeNull();
    expect(["queued", "running", "waiting_input"].every((status) => (
      isCancellableRun({ status } as Pick<Run, "status">)
    ))).toBe(true);
    expect(["cancelling", "succeeded", "failed", "cancelled"].every((status) => (
      !isCancellableRun({ status } as Pick<Run, "status">)
    ))).toBe(true);
    expect(isRetryableRun(run("failed", true))).toBe(true);
    expect(isRetryableRun(run("failed", false))).toBe(false);
    expect(isRetryableRun(run("cancelled"))).toBe(false);
  });
});

function run(status: Run["status"], retryable = false): Run {
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  return {
    id: "run-1",
    requestId: "request-1",
    projectId: "project-1",
    threadId: "thread-1",
    retryOfRunId: null,
    status,
    modelId: "model-1",
    workflow: "generate",
    generationIntent: null,
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    artifactTargets: [],
    requestedArtifactKinds: [],
    sources: [],
    knowledgeReleaseId: null,
    phase: status === "running" ? "generating" : null,
    phaseLabel: status === "running" ? "Generating" : null,
    progress: status === "running" ? 0.5 : null,
    attempt: 1,
    lastEventSequence: 2,
    cancelRequestedAt: status === "cancelling" ? timestamp : null,
    failure: status === "failed"
      ? { code: "FAILED", message: "failed", retryable }
      : null,
    cancellationReason: null,
    createdAt: timestamp,
    startedAt: status === "queued" ? null : timestamp,
    finishedAt: terminal ? timestamp : null,
  };
}

function approval(
  status: RunApproval["status"] = "pending",
  id = "approval-1",
): RunApproval {
  const decided = status !== "pending" && status !== "expired";
  return {
    id,
    runId: "run-1",
    kind: "design-choice",
    prompt: "Choose a layout",
    options: [{
      id: "compact",
      label: "Compact",
      description: null,
      value: { choice: "compact" },
    }],
    attempt: 0,
    status,
    response: decided ? { decision: status === "rejected" ? "reject" : "submit" } : null,
    decidedById: decided ? "principal-1" : null,
    decidedAt: decided ? timestamp : null,
    revision: decided ? 2 : 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

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

const timestamp = "2026-07-13T00:00:00.000Z";
