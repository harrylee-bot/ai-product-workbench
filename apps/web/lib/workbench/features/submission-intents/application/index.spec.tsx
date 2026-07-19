// @vitest-environment jsdom

import type {
  CurrentSubmissionIntent,
  Run,
  SubmissionIntent,
  SubmitSubmissionIntentResponse,
} from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type Versioned,
} from "../../../transport/contracts";
import {
  useCancelWorkbenchSubmissionIntent,
  useCreateWorkbenchSubmissionIntent,
  useCurrentWorkbenchSubmissionIntent,
  useSubmitWorkbenchSubmissionIntent,
  useWorkbenchSubmissionIntent,
} from "./index";

const mocks = vi.hoisted(() => ({
  cancelSubmissionIntent: vi.fn(),
  createSubmissionIntent: vi.fn(),
  getCurrentSubmissionIntent: vi.fn(),
  getSubmissionIntent: vi.fn(),
  submitSubmissionIntent: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchSubmissionIntentsApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("SubmissionIntent application hooks", () => {
  it("loads current and detail state and enables one-second verification polling", async () => {
    const queryClient = client();
    const verifying = currentIntent("verifying");
    const detail = { value: verifying.item, etag: '"1"' };
    mocks.getCurrentSubmissionIntent.mockResolvedValue(verifying);
    mocks.getSubmissionIntent.mockResolvedValue(detail);

    const current = renderHook(
      () => useCurrentWorkbenchSubmissionIntent("thread-1"),
      { wrapper: wrapper(queryClient) },
    );
    const intent = renderHook(
      () => useWorkbenchSubmissionIntent("intent-1"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(current.result.current.data).toEqual(verifying));
    await waitFor(() => expect(intent.result.current.data).toEqual(detail));
    expect(mocks.getCurrentSubmissionIntent).toHaveBeenCalledWith(
      "thread-1",
      expect.any(AbortSignal),
    );
    expect(mocks.getSubmissionIntent).toHaveBeenCalledWith("intent-1");

    const query = queryClient.getQueryCache().find({
      queryKey: workbenchQueryKeys.currentSubmissionIntent("thread-1"),
    });
    const interval = query ? Reflect.get(query.options, "refetchInterval") : undefined;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function" || !query) throw new Error("Missing poll interval");
    expect(interval(query)).toBe(1_000);

    current.unmount();
    intent.unmount();
    queryClient.clear();
  });

  it("creates an Intent and writes both current and versioned detail caches", async () => {
    const queryClient = client();
    const created = { value: pendingIntent(), etag: '"1"' };
    mocks.createSubmissionIntent.mockResolvedValue(created);
    const rendered = renderHook(
      () => useCreateWorkbenchSubmissionIntent("thread-1"),
      { wrapper: wrapper(queryClient) },
    );
    const request = {
      request: {
        prompt: "Build a dashboard",
        modelId: "quality",
        workflow: "generate" as const,
        targetSurface: "web" as const,
        designStyle: { kind: "automatic" as const },
      },
      attachments: [],
    };

    await act(() => rendered.result.current.mutateAsync({
      request,
      idempotencyKey: "submission:req_123",
    }));

    expect(mocks.createSubmissionIntent).toHaveBeenCalledWith(
      "thread-1",
      request,
      "submission:req_123",
    );
    expect(queryClient.getQueryData(workbenchQueryKeys.submissionIntent("intent-1")))
      .toEqual(created);
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: created.value });
    rendered.unmount();
    queryClient.clear();
  });

  it("submits into Run caches and invalidates every affected projection", async () => {
    const queryClient = client();
    seedProjectionCaches(queryClient);
    const intent = submittedIntent();
    const result = { value: { intent, run }, etag: '"2"' };
    mocks.submitSubmissionIntent.mockResolvedValue(result);
    const rendered = renderHook(
      () => useSubmitWorkbenchSubmissionIntent("project-1", "thread-1", "intent-1"),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => rendered.result.current.mutateAsync(undefined));

    expect(mocks.submitSubmissionIntent).toHaveBeenCalledWith("intent-1");
    expect(queryClient.getQueryData(workbenchQueryKeys.submissionIntent("intent-1")))
      .toEqual({ value: intent, etag: '"2"' });
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: null });
    expect(queryClient.getQueryData(workbenchQueryKeys.run("run-1"))).toEqual(run);
    expectInvalidated(queryClient, workbenchQueryKeys.currentSubmissionIntent("thread-1"));
    expectInvalidated(queryClient, workbenchQueryKeys.bootstrap("project-1"));
    expectInvalidated(queryClient, workbenchQueryKeys.runList("project-1", "thread-1"));
    expectInvalidated(queryClient, workbenchQueryKeys.entries("project-1", "thread-1"));
    expectInvalidated(queryClient, workbenchQueryKeys.thread("project-1", "thread-1"));
    rendered.unmount();
    queryClient.clear();
  });

  it("cancels with cached CAS state and invalidates current and detail", async () => {
    const queryClient = client();
    queryClient.setQueryData(
      workbenchQueryKeys.submissionIntent("intent-1"),
      { value: pendingIntent(), etag: '"7"' },
    );
    queryClient.setQueryData(
      workbenchQueryKeys.currentSubmissionIntent("thread-1"),
      { item: pendingIntent() },
    );
    mocks.cancelSubmissionIntent.mockResolvedValue(undefined);
    const rendered = renderHook(
      () => useCancelWorkbenchSubmissionIntent("thread-1", "intent-1"),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => rendered.result.current.mutateAsync({}));

    expect(mocks.cancelSubmissionIntent).toHaveBeenCalledWith("intent-1", '"7"');
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: null });
    expectInvalidated(queryClient, workbenchQueryKeys.currentSubmissionIntent("thread-1"));
    expectInvalidated(queryClient, workbenchQueryKeys.submissionIntent("intent-1"));

    queryClient.removeQueries({ queryKey: workbenchQueryKeys.submissionIntent("intent-1") });
    await expect(rendered.result.current.mutateAsync({})).rejects
      .toBeInstanceOf(WorkbenchVersionRequiredError);
    rendered.unmount();
    queryClient.clear();
  });
});

describe("Project-scoped SubmissionIntent mutations", () => {
  it("keeps a deferred P1 create receipt out of the P2 current cache", async () => {
    const queryClient = client();
    const creation = deferred<Versioned<SubmissionIntent>>();
    mocks.createSubmissionIntent.mockReturnValue(creation.promise);
    const rendered = renderHook(
      ({ threadId }: { threadId: string }) => useCreateWorkbenchSubmissionIntent(threadId),
      { initialProps: { threadId: "thread-1" }, wrapper: wrapper(queryClient) },
    );
    const p2 = pendingIntent("2");
    queryClient.setQueryData(
      workbenchQueryKeys.currentSubmissionIntent("thread-2"),
      { item: p2 },
    );
    let pending!: Promise<Versioned<SubmissionIntent>>;

    act(() => {
      pending = rendered.result.current.mutateAsync({
        request: createIntentRequest(),
        idempotencyKey: "submission:p1",
      });
    });
    await waitFor(() => expect(rendered.result.current.isPending).toBe(true));
    rendered.rerender({ threadId: "thread-2" });
    const p1 = pendingIntent("1");
    creation.resolve({ value: p1, etag: '"1"' });
    await act(() => pending);

    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: p1 });
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-2")))
      .toEqual({ item: p2 });
  });

  it("keeps a deferred P1 submit receipt out of P2 current and Run caches", async () => {
    const queryClient = client();
    const submission = deferred<Versioned<SubmitSubmissionIntentResponse>>();
    mocks.submitSubmissionIntent.mockReturnValue(submission.promise);
    const rendered = renderHook((props: MutationIdentity) => (
      useSubmitWorkbenchSubmissionIntent(props.projectId, props.threadId, props.intentId)
    ), {
      initialProps: mutationIdentity("1"),
      wrapper: wrapper(queryClient),
    });
    const p2Intent = pendingIntent("2");
    const p2Run = runFor("2");
    queryClient.setQueryData(
      workbenchQueryKeys.currentSubmissionIntent("thread-2"),
      { item: p2Intent },
    );
    queryClient.setQueryData(workbenchQueryKeys.run("run-2"), p2Run);
    let pending!: Promise<Versioned<SubmitSubmissionIntentResponse>>;

    act(() => {
      pending = rendered.result.current.mutateAsync(undefined);
    });
    await waitFor(() => expect(rendered.result.current.isPending).toBe(true));
    rendered.rerender(mutationIdentity("2"));
    const p1Intent = submittedIntent("1");
    submission.resolve({
      value: { intent: p1Intent, run: runFor("1") },
      etag: '"2"',
    });
    await act(() => pending);

    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: null });
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-2")))
      .toEqual({ item: p2Intent });
    expect(queryClient.getQueryData(workbenchQueryKeys.run("run-2"))).toEqual(p2Run);
  });

  it("keeps a deferred P1 cancellation from clearing P2 current state", async () => {
    const queryClient = client();
    const cancellation = deferred<void>();
    mocks.cancelSubmissionIntent.mockReturnValue(cancellation.promise);
    const p1Intent = pendingIntent("1");
    const p2Intent = pendingIntent("2");
    queryClient.setQueryData(
      workbenchQueryKeys.submissionIntent("intent-1"),
      { value: p1Intent, etag: '"1"' },
    );
    queryClient.setQueryData(
      workbenchQueryKeys.currentSubmissionIntent("thread-1"),
      { item: p1Intent },
    );
    queryClient.setQueryData(
      workbenchQueryKeys.currentSubmissionIntent("thread-2"),
      { item: p2Intent },
    );
    const rendered = renderHook((props: Omit<MutationIdentity, "projectId">) => (
      useCancelWorkbenchSubmissionIntent(props.threadId, props.intentId)
    ), {
      initialProps: { threadId: "thread-1", intentId: "intent-1" },
      wrapper: wrapper(queryClient),
    });
    let pending!: Promise<void>;

    act(() => {
      pending = rendered.result.current.mutateAsync({});
    });
    await waitFor(() => expect(rendered.result.current.isPending).toBe(true));
    rendered.rerender({ threadId: "thread-2", intentId: "intent-2" });
    cancellation.resolve();
    await act(() => pending);

    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: null });
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-2")))
      .toEqual({ item: p2Intent });
  });
});

const timestamp = "2026-07-15T00:00:00.000Z";

function pendingIntent(suffix = "1"): SubmissionIntent {
  return {
    id: `intent-${suffix}`,
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
    status: "pending",
    request: {
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      artifactTargets: [],
      requestedArtifactKinds: [],
      sourceIds: [],
      canvasSnapshot: null,
    },
    attachments: [],
    runId: null,
    lastFailure: null,
    revision: 1,
    submittedAt: null,
    cancelledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function currentIntent(fileStatus: "verifying"): CurrentSubmissionIntent {
  return {
    item: {
      ...pendingIntent(),
      attachments: [{
        position: 0,
        kind: "upload",
        fileAssetId: "file-1",
        clientFingerprint: "submission-file:fixture-1",
        fileName: "brief.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 42,
        lastModified: 1_786_771_200_000,
        fileStatus,
      }],
    },
  };
}

function submittedIntent(suffix = "1"): SubmissionIntent {
  return {
    ...pendingIntent(suffix),
    status: "submitted",
    runId: `run-${suffix}`,
    revision: 2,
    submittedAt: timestamp,
  };
}

const run: Run = runFor("1");

function runFor(suffix: string): Run {
  return {
    id: `run-${suffix}`,
    requestId: `request-${suffix}`,
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
    retryOfRunId: null,
    status: "queued",
    modelId: "quality",
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
    attempt: 0,
    lastEventSequence: 0,
    cancelRequestedAt: null,
    failure: null,
    cancellationReason: null,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
  };
}

type MutationIdentity = {
  intentId: string;
  projectId: string;
  threadId: string;
};

function mutationIdentity(suffix: string): MutationIdentity {
  return {
    intentId: `intent-${suffix}`,
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
  };
}

function createIntentRequest() {
  return {
    request: {
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "generate" as const,
      targetSurface: "web" as const,
      designStyle: { kind: "automatic" as const },
    },
    attachments: [],
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

function seedProjectionCaches(queryClient: QueryClient) {
  queryClient.setQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1"), {
    item: pendingIntent(),
  });
  queryClient.setQueryData(workbenchQueryKeys.bootstrap("project-1"), { project: {} });
  queryClient.setQueryData(workbenchQueryKeys.runList("project-1", "thread-1"), { items: [] });
  queryClient.setQueryData(workbenchQueryKeys.entries("project-1", "thread-1"), { items: [] });
  queryClient.setQueryData(workbenchQueryKeys.thread("project-1", "thread-1"), { value: {} });
}

function expectInvalidated(queryClient: QueryClient, queryKey: readonly unknown[]) {
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
