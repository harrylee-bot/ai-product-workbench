// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useInfiniteWorkbenchProjectInvitations } from "./project-hooks";

const mocks = vi.hoisted(() => ({
  listProjectInvitations: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchProjectsApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench Project invitation hooks", () => {
  it("continues pending invitations with the opaque server cursor", async () => {
    mocks.listProjectInvitations
      .mockResolvedValueOnce({ items: [{ invitation: { id: "invitation-1" } }], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [{ invitation: { id: "invitation-31" } }], nextCursor: null });
    const queryClient = client();
    const rendered = renderHook(
      () => useInfiniteWorkbenchProjectInvitations("project-1", { status: "pending", limit: 30 }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(1));
    await act(() => rendered.result.current.fetchNextPage());
    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(2));

    expect(mocks.listProjectInvitations).toHaveBeenNthCalledWith(1, "project-1", {
      cursor: undefined,
      limit: 30,
      status: "pending",
    });
    expect(mocks.listProjectInvitations).toHaveBeenNthCalledWith(2, "project-1", {
      cursor: "cursor-2",
      limit: 30,
      status: "pending",
    });
    rendered.unmount();
    queryClient.clear();
  });

  it("does not carry an invitation cursor into another Project", async () => {
    mocks.listProjectInvitations.mockImplementation(async (projectId) => ({
      items: [{ invitation: { id: `${projectId}-invitation` } }],
      nextCursor: null,
    }));
    const queryClient = client();
    const rendered = renderHook(
      ({ projectId }) => useInfiniteWorkbenchProjectInvitations(projectId, {
        status: "pending",
        limit: 30,
      }),
      { initialProps: { projectId: "project-1" }, wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(rendered.result.current.data?.pages[0]?.items[0])
      .toEqual({ invitation: { id: "project-1-invitation" } }));
    rendered.rerender({ projectId: "project-2" });
    await waitFor(() => expect(rendered.result.current.data?.pages[0]?.items[0])
      .toEqual({ invitation: { id: "project-2-invitation" } }));

    expect(mocks.listProjectInvitations).toHaveBeenNthCalledWith(2, "project-2", {
      cursor: undefined,
      limit: 30,
      status: "pending",
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
