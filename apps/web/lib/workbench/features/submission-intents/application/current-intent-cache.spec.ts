import type {
  CurrentSubmissionIntent,
  SubmissionIntent,
} from "@workbench/workbench-contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  refreshCurrentWorkbenchSubmissionIntent,
  replaceCurrentWorkbenchSubmissionIntent,
} from "./current-intent-cache";

describe("current SubmissionIntent cache ordering", () => {
  it("keeps a replacement when an older Query GET resolves last", async () => {
    const queryClient = client();
    const oldGet = deferred<CurrentSubmissionIntent>();
    const queryKey = workbenchQueryKeys.currentSubmissionIntent("thread-1");
    const oldQuery = queryClient.fetchQuery({
      queryKey,
      queryFn: () => oldGet.promise,
    });
    const oldQueryOutcome = oldQuery.then(() => null, (error) => error);
    await waitUntil(() => queryClient.isFetching({ queryKey, exact: true }) === 1);
    const next = intent("intent-b", "ready");

    await replaceCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      { item: next },
      { value: next, etag: '"2"' },
    );
    oldGet.resolve({ item: null });
    await oldQueryOutcome;

    expect(queryClient.getQueryData(queryKey)).toEqual({ item: next });
    queryClient.clear();
  });

  it("discards a direct refresh superseded by a replacement", async () => {
    const queryClient = client();
    const oldRefresh = deferred<CurrentSubmissionIntent>();
    const load = vi.fn(() => oldRefresh.promise);
    const refreshing = refreshCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      load,
    );
    await waitUntil(() => load.mock.calls.length === 1);
    const next = intent("intent-b", "ready");

    await replaceCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      { item: next },
      { value: next, etag: '"2"' },
    );
    oldRefresh.resolve({ item: intent("intent-a", "verifying") });

    await expect(refreshing).resolves.toBeUndefined();
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: next });
    queryClient.clear();
  });

  it("keeps the latest same-Intent refresh when responses resolve out of order", async () => {
    const queryClient = client();
    const first = deferred<CurrentSubmissionIntent>();
    const second = deferred<CurrentSubmissionIntent>();
    const firstLoad = vi.fn(() => first.promise);
    const secondLoad = vi.fn(() => second.promise);
    const firstRefresh = refreshCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      firstLoad,
    );
    await waitUntil(() => firstLoad.mock.calls.length === 1);
    const secondRefresh = refreshCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      secondLoad,
    );
    await waitUntil(() => secondLoad.mock.calls.length === 1);

    const ready = intent("intent-a", "ready");
    second.resolve({ item: ready });
    await expect(secondRefresh).resolves.toEqual({ item: ready });
    first.resolve({ item: intent("intent-a", "verifying") });
    await expect(firstRefresh).resolves.toBeUndefined();

    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: ready });
    queryClient.clear();
  });

  it("uses a newer polled state instead of reporting a direct refresh as superseded", async () => {
    const queryClient = client();
    const direct = deferred<CurrentSubmissionIntent>();
    const load = vi.fn(() => direct.promise);
    const refreshing = refreshCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      load,
    );
    await waitUntil(() => load.mock.calls.length === 1);
    const ready = intent("intent-a", "ready");

    queryClient.setQueryData(
      workbenchQueryKeys.currentSubmissionIntent("thread-1"),
      { item: ready },
    );
    direct.resolve({ item: intent("intent-a", "verifying") });

    await expect(refreshing).resolves.toEqual({ item: ready });
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: ready });
    queryClient.clear();
  });

  it("does not let a later failing refresh suppress an authoritative replacement", async () => {
    const queryClient = client();
    const delayedCancellation = deferred<void>();
    const originalCancelQueries = queryClient.cancelQueries.bind(queryClient);
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries")
      .mockImplementationOnce(() => delayedCancellation.promise)
      .mockImplementation((filters, options) => originalCancelQueries(filters, options));
    const next = intent("intent-b", "ready");
    const replacement = replaceCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      { item: next },
      { value: next, etag: '"2"' },
    );
    await waitUntil(() => cancelQueries.mock.calls.length === 1);
    const refreshFailure = new Error("refresh failed");
    const refresh = refreshCurrentWorkbenchSubmissionIntent(
      queryClient,
      "thread-1",
      async () => {
        throw refreshFailure;
      },
    );
    const refreshOutcome = refresh.then(() => null, (error) => error);

    await expect(refreshOutcome).resolves.toBe(refreshFailure);
    delayedCancellation.resolve();
    await expect(replacement).resolves.toBe(true);
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: next });
    queryClient.clear();
  });
});

const timestamp = "2026-07-15T00:00:00.000Z";

function intent(
  id: string,
  fileStatus: "ready" | "verifying",
): SubmissionIntent {
  return {
    id,
    projectId: "project-1",
    threadId: "thread-1",
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
    attachments: [{
      position: 0,
      kind: "upload",
      fileAssetId: "file-1",
      clientFingerprint: "submission-file:fixture",
      fileName: "brief.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 3,
      lastModified: 1_786_771_200_000,
      fileStatus,
    }],
    runId: null,
    lastFailure: null,
    revision: 1,
    submittedAt: null,
    cancelledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function client() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}
