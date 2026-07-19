// @vitest-environment jsdom

import type {
  Run,
  RunApproval,
  SubmitApprovalResponse,
} from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import type { Versioned } from "../../../transport/contracts";
import {
  useCancelWorkbenchRun,
  useRetryWorkbenchRun,
  useSubmitWorkbenchRunApproval,
} from "./index";

const timestamp = "2026-07-15T00:00:00.000Z";
const mocks = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  submitRunApproval: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchRunsApi: () => mocks,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Project-scoped Run mutations", () => {
  it("keeps a deferred P1 cancellation on the P1 cache after switching to P2", async () => {
    const queryClient = client();
    const cancellation = deferred<Run>();
    mocks.cancelRun.mockReturnValue(cancellation.promise);
    const rendered = renderHook((props: RunIdentity) => useCancelWorkbenchRun(
      props.projectId,
      props.threadId,
      props.runId,
    ), {
      initialProps: identity("1"),
      wrapper: wrapper(queryClient),
    });
    const p2Sentinel = run("2", "running");
    queryClient.setQueryData(workbenchQueryKeys.run("run-2"), p2Sentinel);
    let pending!: Promise<Run>;

    act(() => {
      pending = rendered.result.current.mutateAsync({});
    });
    await waitFor(() => expect(rendered.result.current.isPending).toBe(true));
    rendered.rerender(identity("2"));

    const cancelled = run("1", "cancelled");
    cancellation.resolve(cancelled);
    await act(() => pending);

    expect(queryClient.getQueryData(workbenchQueryKeys.run("run-1"))).toEqual(cancelled);
    expect(queryClient.getQueryData(workbenchQueryKeys.run("run-2"))).toEqual(p2Sentinel);
  });

  it("invalidates only P1 lists when a deferred P1 retry resolves after switching to P2", async () => {
    const queryClient = client();
    const invalidations = vi.spyOn(queryClient, "invalidateQueries");
    const retry = deferred<Run>();
    mocks.retryRun.mockReturnValue(retry.promise);
    const rendered = renderHook((props: RunIdentity) => useRetryWorkbenchRun(
      props.projectId,
      props.threadId,
      props.runId,
    ), {
      initialProps: identity("1"),
      wrapper: wrapper(queryClient),
    });
    let pending!: Promise<Run>;

    act(() => {
      pending = rendered.result.current.mutateAsync({});
    });
    await waitFor(() => expect(rendered.result.current.isPending).toBe(true));
    rendered.rerender(identity("2"));
    invalidations.mockClear();

    retry.resolve(run("1-retry", "queued"));
    await act(() => pending);

    expect(invalidations).toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.bootstraps("project-1"),
    });
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.runLists("project-1", "thread-1"),
    });
    expect(invalidations).not.toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.bootstraps("project-2"),
    });
  });

  it("keeps a deferred P1 approval receipt out of P2 Run and Approval caches", async () => {
    const queryClient = client();
    const submission = deferred<Versioned<SubmitApprovalResponse>>();
    mocks.submitRunApproval.mockReturnValue(submission.promise);
    const rendered = renderHook((props: RunIdentity & { approvalId: string }) => (
      useSubmitWorkbenchRunApproval(props)
    ), {
      initialProps: { ...identity("1"), approvalId: "approval-1" },
      wrapper: wrapper(queryClient),
    });
    const p2Run = run("2", "waiting_input");
    const p2Approval = approval("2", "pending");
    queryClient.setQueryData(workbenchQueryKeys.run("run-2"), p2Run);
    queryClient.setQueryData(
      workbenchQueryKeys.approval("run-2", "approval-2"),
      { value: p2Approval, etag: '"1"' },
    );
    let pending!: Promise<Versioned<SubmitApprovalResponse>>;

    act(() => {
      pending = rendered.result.current.mutateAsync({ request: { decision: "approve" } });
    });
    await waitFor(() => expect(rendered.result.current.isPending).toBe(true));
    rendered.rerender({ ...identity("2"), approvalId: "approval-2" });

    const p1Run = run("1", "running");
    const p1Approval = approval("1", "approved");
    submission.resolve({
      value: { approval: p1Approval, run: p1Run },
      etag: '"2"',
    });
    await act(() => pending);

    expect(queryClient.getQueryData(workbenchQueryKeys.run("run-1"))).toEqual(p1Run);
    expect(queryClient.getQueryData(
      workbenchQueryKeys.approval("run-1", "approval-1"),
    )).toEqual({ value: p1Approval, etag: '"2"' });
    expect(queryClient.getQueryData(workbenchQueryKeys.run("run-2"))).toEqual(p2Run);
    expect(queryClient.getQueryData(
      workbenchQueryKeys.approval("run-2", "approval-2"),
    )).toEqual({ value: p2Approval, etag: '"1"' });
  });
});

type RunIdentity = {
  projectId: string;
  runId: string;
  threadId: string;
};

function identity(suffix: string): RunIdentity {
  return {
    projectId: `project-${suffix}`,
    runId: `run-${suffix}`,
    threadId: `thread-${suffix}`,
  };
}

function client() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function wrapper(queryClient: QueryClient) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function run(suffix: string, status: Run["status"]): Run {
  return {
    id: `run-${suffix}`,
    requestId: `request-${suffix}`,
    projectId: `project-${suffix.replace(/-retry$/u, "")}`,
    threadId: `thread-${suffix.replace(/-retry$/u, "")}`,
    retryOfRunId: suffix.endsWith("-retry") ? `run-${suffix.replace(/-retry$/u, "")}` : null,
    status,
    modelId: "model-1",
    workflow: "generate",
    generationIntent: null,
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    artifactTargets: [],
    requestedArtifactKinds: [],
    sources: [],
    knowledgeReleaseId: null,
    phase: null,
    phaseLabel: null,
    progress: null,
    attempt: suffix.endsWith("-retry") ? 1 : 0,
    lastEventSequence: 0,
    cancelRequestedAt: status === "cancelled" ? timestamp : null,
    failure: null,
    cancellationReason: status === "cancelled" ? "cancelled by test" : null,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: status === "cancelled" ? timestamp : null,
  };
}

function approval(
  suffix: string,
  status: RunApproval["status"],
): RunApproval {
  return {
    id: `approval-${suffix}`,
    runId: `run-${suffix}`,
    kind: "confirm",
    prompt: "Continue?",
    options: [],
    attempt: 0,
    status,
    response: status === "approved" ? { decision: "approve" } : null,
    decidedById: status === "approved" ? "principal-1" : null,
    decidedAt: status === "approved" ? timestamp : null,
    revision: status === "approved" ? 2 : 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
