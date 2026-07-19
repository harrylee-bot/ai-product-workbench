// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useCancelWorkbenchExportJob,
  useCreateWorkbenchExportJob,
  useWorkbenchExportOperations,
  useWorkbenchExportJobs,
} from "./index";
import { needsExportPolling } from "../domain";

const mocks = vi.hoisted(() => ({
  createExportJob: vi.fn(),
  cancelExportJob: vi.fn(),
  listExportJobs: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchExportsApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Export hooks", () => {
  it("passes the feature-owned adapter directly to publication operations", () => {
    const rendered = renderHook(() => useWorkbenchExportOperations());

    expect(rendered.result.current).toBe(mocks);
    rendered.unmount();
  });

  it("caches a newly queued Export and polls only active jobs", async () => {
    const queryClient = client();
    const job = { id: "export-1", status: "queued" };
    const result = { value: job, etag: '"1"' };
    mocks.createExportJob.mockResolvedValue(result);
    const rendered = renderHook(() => useCreateWorkbenchExportJob("project-1"), {
      wrapper: wrapper(queryClient),
    });

    await act(() => rendered.result.current.mutateAsync({
      request: {
        releaseId: "release-1",
        format: "html",
        packaging: "single_file",
        selection: { kind: "release" },
        options: {},
      },
    }));

    expect(queryClient.getQueryData(
      workbenchQueryKeys.exportJob("project-1", "export-1"),
    )).toEqual(result);
    expect(needsExportPolling(job as never)).toBe(true);
    expect(needsExportPolling({ ...job, status: "succeeded" } as never)).toBe(false);
    rendered.unmount();
    queryClient.clear();
  });

  it("does not carry one Project's export list into the next Project", async () => {
    const queryClient = client();
    const first = { items: [], nextCursor: null };
    const second = { items: [], nextCursor: null };
    mocks.listExportJobs
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const rendered = renderHook(
      ({ projectId }: { projectId: string }) => useWorkbenchExportJobs(projectId, { limit: 100 }),
      {
        initialProps: { projectId: "project-1" },
        wrapper: wrapper(queryClient),
      },
    );

    await waitFor(() => expect(rendered.result.current.data).toEqual(first));
    rendered.rerender({ projectId: "project-2" });
    expect(rendered.result.current.data).toBeUndefined();
    await waitFor(() => expect(rendered.result.current.data).toEqual(second));
    expect(mocks.listExportJobs).toHaveBeenNthCalledWith(1, "project-1", { limit: 100 });
    expect(mocks.listExportJobs).toHaveBeenNthCalledWith(2, "project-2", { limit: 100 });
    rendered.unmount();
    queryClient.clear();
  });

  it("cancels an Export with the revision ETag from its detail cache", async () => {
    const queryClient = client();
    const current = { id: "export-1", status: "running" };
    const cancelled = { value: { ...current, status: "cancelled" }, etag: '"2"' };
    queryClient.setQueryData(workbenchQueryKeys.exportJob("project-1", "export-1"), {
      value: current,
      etag: '"1"',
    });
    mocks.cancelExportJob.mockResolvedValue(cancelled);
    const rendered = renderHook(
      () => useCancelWorkbenchExportJob("project-1", "export-1"),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => rendered.result.current.mutateAsync({}));

    expect(mocks.cancelExportJob).toHaveBeenCalledWith("export-1", '"1"');
    expect(queryClient.getQueryData(
      workbenchQueryKeys.exportJob("project-1", "export-1"),
    )).toEqual(cancelled);
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
