// @vitest-environment jsdom

import { runEventSchema, type Run, type RunEvent } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../query/keys";
import { useWorkbenchRunController } from "./run-controller";

const mocks = vi.hoisted(() => ({
  createProjector: vi.fn(),
  dispose: vi.fn(),
  ingest: vi.fn(),
  setScope: vi.fn(),
  settleTerminal: vi.fn(),
  subscribeRunEvents: vi.fn(),
  useWorkbenchRun: vi.fn(),
}));

vi.mock("../run/stream", () => ({
  subscribeRunEvents: mocks.subscribeRunEvents,
}));

vi.mock("../transport/context", () => ({
  useWorkbenchTransport: () => ({ baseUrl: "http://workbench.test/api/v1" }),
}));

vi.mock("./prototype-patches", () => ({
  createWorkbenchPrototypePatchProjector: mocks.createProjector,
}));

vi.mock("./runs", () => ({
  useWorkbenchRun: mocks.useWorkbenchRun,
}));

let authoritativeRun: Run | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  authoritativeRun = undefined;
  mocks.createProjector.mockReturnValue({
    dispose: mocks.dispose,
    ingest: mocks.ingest,
    setScope: mocks.setScope,
    settleTerminal: mocks.settleTerminal,
  });
  mocks.useWorkbenchRun.mockImplementation(() => ({ data: authoritativeRun }));
  mocks.subscribeRunEvents.mockImplementation(() => new Promise(() => undefined));
});

describe("useWorkbenchRunController recovery", () => {
  it("replays an active run to recover details missing from its cached snapshot", async () => {
    const queryClient = client();
    const submittedRun = run({ lastEventSequence: 0, status: "queued" });
    const cachedRun = run({ lastEventSequence: 7, status: "running" });
    queryClient.setQueryData(workbenchQueryKeys.run(submittedRun.id), cachedRun);

    const rendered = renderHook(
      () => useWorkbenchRunController({ run: submittedRun }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(mocks.subscribeRunEvents).toHaveBeenCalledOnce());
    expect(mocks.subscribeRunEvents).toHaveBeenCalledWith(expect.objectContaining({
      runId: submittedRun.id,
      afterSequence: 0,
    }));
    expect(rendered.result.current.projection?.lastSequence).toBe(0);
    act(() => {
      subscription(0).onEvent(event(1, "run.started", { attempt: 1 }));
      subscription(0).onEvent(event(2, "run.generation.stage.changed", { attempt: 1, stage: "collecting-prd-context" }));
      subscription(0).onEvent(event(3, "activity.changed", {
        activityId: "knowledge:retrieval", status: "succeeded", label: "知识库检索", detail: "返回 1 条资料片段",
      }));
    });
    expect(rendered.result.current.projection?.generationStage).toBe("collecting-prd-context");
    expect(rendered.result.current.projection?.activities["knowledge:retrieval"]?.detail).toBe("返回 1 条资料片段");
    expect(mocks.useWorkbenchRun).toHaveBeenCalledWith(submittedRun.id, {
      enabled: true,
      refetchIntervalMs: 3_000,
    });
  });

  it("keeps the consumed cursor on reconnect and rebuilds details on a full remount", async () => {
    const queryClient = client();
    const submittedRun = run({ lastEventSequence: 0, status: "queued" });
    const first = renderHook(
      () => useWorkbenchRunController({ run: submittedRun }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(mocks.subscribeRunEvents).toHaveBeenCalledOnce());

    const firstSubscription = subscription(0);
    act(() => firstSubscription.onEvent(event(1, "run.started", { attempt: 1 })));
    expect(first.result.current.projection).toMatchObject({
      lastSequence: 1,
      status: "running",
    });

    act(() => first.result.current.reconnect());
    await waitFor(() => expect(mocks.subscribeRunEvents).toHaveBeenCalledTimes(2));
    expect(subscription(1).afterSequence).toBe(1);

    first.unmount();
    mocks.subscribeRunEvents.mockClear();
    const remounted = renderHook(
      () => useWorkbenchRunController({ run: submittedRun }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(mocks.subscribeRunEvents).toHaveBeenCalledOnce());
    expect(subscription(0).afterSequence).toBe(0);
    expect(remounted.result.current.projection?.lastSequence).toBe(0);
  });

  it("uses a polled terminal Run to close the stream and refresh PRD dependencies", async () => {
    const queryClient = client();
    const invalidations = vi.spyOn(queryClient, "invalidateQueries");
    const submittedRun = run({ lastEventSequence: 0, status: "running" });
    authoritativeRun = submittedRun;
    const rendered = renderHook(
      () => useWorkbenchRunController({ run: submittedRun }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(mocks.subscribeRunEvents).toHaveBeenCalledOnce());
    const streamSignal = subscription(0).signal;

    authoritativeRun = run({
      finishedAt: timestamp,
      lastEventSequence: 28,
      phase: "publishing",
      phaseLabel: "已完成",
      progress: 1,
      status: "succeeded",
    });
    rendered.rerender();

    await waitFor(() => expect(rendered.result.current.projection).toMatchObject({
      lastSequence: 28,
      progress: 1,
      status: "succeeded",
    }));
    expect(rendered.result.current.connectionState).toBe("closed");
    expect(streamSignal.aborted).toBe(true);
    expect(mocks.settleTerminal).toHaveBeenCalledWith("succeeded");
    expect(queryClient.getQueryData<Run>(workbenchQueryKeys.run(submittedRun.id))?.status)
      .toBe("succeeded");
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.runLists(submittedRun.projectId, submittedRun.threadId),
    });
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.entryLists(submittedRun.projectId, submittedRun.threadId),
    });
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.board(submittedRun.projectId),
    });
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.artifacts(submittedRun.projectId),
    });
    expect(invalidations).toHaveBeenCalledWith({
      queryKey: workbenchQueryKeys.bootstraps(submittedRun.projectId),
    });
  });

  it("resubscribes from the last consumed cursor after the stream gives up", async () => {
    vi.useFakeTimers();
    const queryClient = client();
    const submittedRun = run({ lastEventSequence: 0, status: "running" });
    mocks.subscribeRunEvents
      .mockRejectedValueOnce(new Error("stream disconnected"))
      .mockImplementation(() => new Promise(() => undefined));

    const rendered = renderHook(
      () => useWorkbenchRunController({ run: submittedRun }),
      { wrapper: wrapper(queryClient) },
    );
    await act(async () => Promise.resolve());
    expect(rendered.result.current.connectionState).toBe("closed");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.subscribeRunEvents).toHaveBeenCalledTimes(2);
    expect(subscription(1).afterSequence).toBe(0);
    vi.useRealTimers();
  });
});

function subscription(index: number): {
  afterSequence: number;
  onEvent: (event: RunEvent) => void;
  signal: AbortSignal;
} {
  return mocks.subscribeRunEvents.mock.calls[index][0];
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

const timestamp = "2026-07-23T06:50:34.614Z";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    requestId: "request-1",
    projectId: "project-1",
    threadId: "thread-1",
    retryOfRunId: null,
    status: "queued",
    modelId: "model-1",
    workflow: "generate",
    generationIntent: null,
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    artifactTargets: [],
    requestedArtifactKinds: ["prd"],
    sources: [],
    knowledgeReleaseId: null,
    phase: null,
    phaseLabel: null,
    progress: null,
    attempt: 0,
    lastEventSequence: 0,
    cancelRequestedAt: null,
    failure: null,
    cancellationReason: null,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return runEventSchema.parse({
    protocol: "workbench.run.v1",
    id: `event-${sequence}`,
    projectId: "project-1",
    threadId: "thread-1",
    runId: "run-1",
    requestId: "request-1",
    sequence,
    occurredAt: timestamp,
    traceId: "trace-1",
    type,
    payload,
  });
}
