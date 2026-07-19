// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useInfiniteWorkbenchWorkspaceMembers,
} from "./project-hooks";

const mocks = vi.hoisted(() => ({
  listWorkspaceMembers: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchProjectsApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench Workspace member hooks", () => {
  it("continues discovery with the opaque server cursor", async () => {
    mocks.listWorkspaceMembers
      .mockResolvedValueOnce({ items: [{ principalId: "principal-1" }], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [{ principalId: "principal-2" }], nextCursor: null });
    const queryClient = client();
    const rendered = renderHook(
      () => useInfiniteWorkbenchWorkspaceMembers("workspace-1", { q: "owner", limit: 1 }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(1));
    await act(() => rendered.result.current.fetchNextPage());
    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(2));
    expect(mocks.listWorkspaceMembers).toHaveBeenNthCalledWith(1, "workspace-1", {
      q: "owner",
      limit: 1,
      cursor: undefined,
    });
    expect(mocks.listWorkspaceMembers).toHaveBeenNthCalledWith(2, "workspace-1", {
      q: "owner",
      limit: 1,
      cursor: "cursor-2",
    });
    rendered.unmount();
    queryClient.clear();
  });

  it("starts a new cursor chain when the Workspace or search changes", async () => {
    mocks.listWorkspaceMembers.mockImplementation(async (workspaceId, options) => ({
      items: [{ principalId: `${workspaceId}:${options.q}` }],
      nextCursor: null,
    }));
    const queryClient = client();
    const rendered = renderHook(
      ({ workspaceId, q }) => useInfiniteWorkbenchWorkspaceMembers(workspaceId, { q, limit: 30 }),
      {
        initialProps: { workspaceId: "workspace-1", q: "owner" },
        wrapper: wrapper(queryClient),
      },
    );

    await waitFor(() => expect(rendered.result.current.data?.pages[0]?.items[0])
      .toEqual({ principalId: "workspace-1:owner" }));
    rendered.rerender({ workspaceId: "workspace-2", q: "editor" });
    await waitFor(() => expect(rendered.result.current.data?.pages[0]?.items[0])
      .toEqual({ principalId: "workspace-2:editor" }));

    expect(mocks.listWorkspaceMembers).toHaveBeenNthCalledWith(1, "workspace-1", {
      cursor: undefined,
      limit: 30,
      q: "owner",
    });
    expect(mocks.listWorkspaceMembers).toHaveBeenNthCalledWith(2, "workspace-2", {
      cursor: undefined,
      limit: 30,
      q: "editor",
    });
    rendered.unmount();
    queryClient.clear();
  });
});

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return function WorkbenchQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}
