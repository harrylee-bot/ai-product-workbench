// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useCreateWorkbenchRelease,
  useWorkbenchReleases,
} from "./index";

const mocks = vi.hoisted(() => ({
  createProjectRelease: vi.fn(),
  listProjectReleases: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchReleasesApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench Release hooks", () => {
  it("loads Release list state through its public hook", async () => {
    const queryClient = client();
    const list = { items: [{ id: "release-1" }], nextCursor: null };
    mocks.listProjectReleases.mockResolvedValue(list);
    const listHook = renderHook(
      () => useWorkbenchReleases("project-1", { limit: 25 }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(listHook.result.current.data).toEqual(list));
    expect(mocks.listProjectReleases).toHaveBeenCalledWith("project-1", { limit: 25 });
    expect(queryClient.getQueryData(
      workbenchQueryKeys.releaseList("project-1", { limit: 25 }),
    )).toEqual(list);

    listHook.unmount();
    queryClient.clear();
  });

  it("creates a Release with the cached Board CAS version", async () => {
    const queryClient = client();
    queryClient.setQueryData(workbenchQueryKeys.board("project-1"), {
      value: { id: "board-1" },
      etag: '"7"',
    });
    const result = { value: { id: "release-1" }, etag: '"digest"' };
    mocks.createProjectRelease.mockResolvedValue(result);
    const rendered = renderHook(() => useCreateWorkbenchRelease("project-1"), {
      wrapper: wrapper(queryClient),
    });

    await act(() => rendered.result.current.mutateAsync({
      request: { boardId: "board-1", boardRevision: 7 },
      idempotencyKey: "release:req_123",
    }));

    expect(mocks.createProjectRelease).toHaveBeenCalledWith(
      "project-1",
      { boardId: "board-1", boardRevision: 7 },
      '"7"',
      "release:req_123",
    );
    expect(queryClient.getQueryData(
      workbenchQueryKeys.release("project-1", "release-1"),
    )).toEqual(result);
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
