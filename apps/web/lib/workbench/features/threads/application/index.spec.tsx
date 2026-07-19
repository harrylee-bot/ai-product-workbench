// @vitest-environment jsdom

import type { Thread } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { WorkbenchVersionRequiredError } from "../../../transport/contracts";
import {
  useArchiveWorkbenchThread,
  useCreateWorkbenchThread,
  useUpdateWorkbenchThread,
  useWorkbenchThread,
  useWorkbenchThreadEntries,
  useWorkbenchThreads,
} from "./index";

const mocks = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  createThread: vi.fn(),
  getThread: vi.fn(),
  listThreadEntries: vi.fn(),
  listThreads: vi.fn(),
  updateThread: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchThreadsApi: () => mocks,
}));

const timestamp = "2026-07-15T00:00:00.000Z";
const thread: Thread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Main thread",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench Thread hooks", () => {
  it("loads Thread list, detail, and entries through the feature adapter", async () => {
    const queryClient = client();
    const list = { items: [thread], nextCursor: null };
    const detail = { value: thread, etag: '"1"' };
    const entries = { items: [], nextAfterSequence: null };
    mocks.listThreads.mockResolvedValue(list);
    mocks.getThread.mockResolvedValue(detail);
    mocks.listThreadEntries.mockResolvedValue(entries);
    const listHook = renderHook(
      () => useWorkbenchThreads("project-1", { limit: 25 }),
      { wrapper: wrapper(queryClient) },
    );
    const detailHook = renderHook(
      () => useWorkbenchThread("project-1", thread.id),
      { wrapper: wrapper(queryClient) },
    );
    const entriesHook = renderHook(
      () => useWorkbenchThreadEntries("project-1", thread.id, { afterSequence: 4 }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(listHook.result.current.data).toEqual(list));
    await waitFor(() => expect(detailHook.result.current.data).toEqual(detail));
    await waitFor(() => expect(entriesHook.result.current.data).toEqual(entries));
    expect(mocks.listThreads).toHaveBeenCalledWith("project-1", { limit: 25 });
    expect(mocks.getThread).toHaveBeenCalledWith(thread.id);
    expect(mocks.listThreadEntries).toHaveBeenCalledWith(thread.id, { afterSequence: 4 });

    listHook.unmount();
    detailHook.unmount();
    entriesHook.unmount();
    queryClient.clear();
  });

  it("creates and updates Threads while preserving versioned cache ownership", async () => {
    const queryClient = client();
    seedProjectionCaches(queryClient);
    const created = { value: thread, etag: '"1"' };
    const updated = {
      value: { ...thread, title: "Renamed", revision: 2 },
      etag: '"2"',
    };
    mocks.createThread.mockResolvedValue(created);
    mocks.updateThread.mockResolvedValue(updated);
    const createHook = renderHook(
      () => useCreateWorkbenchThread("project-1"),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => createHook.result.current.mutateAsync({
      request: { title: "Main thread" },
      idempotencyKey: "thread:req_123",
    }));
    expect(mocks.createThread).toHaveBeenCalledWith(
      "project-1",
      { title: "Main thread" },
      "thread:req_123",
    );
    expect(queryClient.getQueryData(workbenchQueryKeys.thread("project-1", thread.id)))
      .toEqual(created);
    expect(queryClient.getQueryState(workbenchQueryKeys.threadList("project-1"))?.isInvalidated)
      .toBe(true);
    expect(queryClient.getQueryState(workbenchQueryKeys.bootstrap("project-1"))?.isInvalidated)
      .toBe(true);

    seedProjectionCaches(queryClient);
    const updateHook = renderHook(
      () => useUpdateWorkbenchThread("project-1", thread.id),
      { wrapper: wrapper(queryClient) },
    );
    await act(() => updateHook.result.current.mutateAsync({
      request: { title: "Renamed" },
    }));
    expect(mocks.updateThread).toHaveBeenCalledWith(
      thread.id,
      { title: "Renamed" },
      '"1"',
    );
    expect(queryClient.getQueryData(workbenchQueryKeys.thread("project-1", thread.id)))
      .toEqual(updated);
    expect(queryClient.getQueryState(workbenchQueryKeys.threadList("project-1"))?.isInvalidated)
      .toBe(true);
    expect(queryClient.getQueryState(workbenchQueryKeys.bootstrap("project-1"))?.isInvalidated)
      .toBe(true);

    queryClient.removeQueries({ queryKey: workbenchQueryKeys.thread("project-1", thread.id) });
    await expect(updateHook.result.current.mutateAsync({
      request: { title: "Missing version" },
    })).rejects.toBeInstanceOf(WorkbenchVersionRequiredError);

    createHook.unmount();
    updateHook.unmount();
    queryClient.clear();
  });

  it("archives with cached CAS state and removes stale Thread detail", async () => {
    const queryClient = client();
    seedProjectionCaches(queryClient);
    queryClient.setQueryData(
      workbenchQueryKeys.thread("project-1", thread.id),
      { value: thread, etag: '"7"' },
    );
    mocks.archiveThread.mockResolvedValue(undefined);
    const rendered = renderHook(
      () => useArchiveWorkbenchThread("project-1", thread.id),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => rendered.result.current.mutateAsync({}));

    expect(mocks.archiveThread).toHaveBeenCalledWith(thread.id, '"7"');
    expect(queryClient.getQueryData(workbenchQueryKeys.thread("project-1", thread.id)))
      .toBeUndefined();
    expect(queryClient.getQueryState(workbenchQueryKeys.threadList("project-1"))?.isInvalidated)
      .toBe(true);
    expect(queryClient.getQueryState(workbenchQueryKeys.bootstrap("project-1"))?.isInvalidated)
      .toBe(true);
    await expect(rendered.result.current.mutateAsync({})).rejects
      .toBeInstanceOf(WorkbenchVersionRequiredError);
    expect(mocks.archiveThread).toHaveBeenCalledOnce();
    rendered.unmount();
    queryClient.clear();
  });
});

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
  queryClient.setQueryData(workbenchQueryKeys.threadList("project-1"), {
    items: [thread],
    nextCursor: null,
  });
  queryClient.setQueryData(workbenchQueryKeys.bootstrap("project-1"), {
    value: { project: { id: "project-1" } },
    etag: '"1"',
  });
}
