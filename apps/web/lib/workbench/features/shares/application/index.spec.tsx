// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useRevokeWorkbenchProjectShareGrants,
  useRevokeWorkbenchShareGrant,
  useRotateWorkbenchShareGrant,
  useWorkbenchShareGrant,
  useWorkbenchShareGrants,
} from "./index";

const mocks = vi.hoisted(() => ({
  getShareGrant: vi.fn(),
  listShareGrants: vi.fn(),
  revokeProjectShareGrants: vi.fn(),
  revokeShareGrant: vi.fn(),
  rotateShareGrant: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchSharesApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench Share hooks", () => {
  it("loads Share list and detail state through their public hooks", async () => {
    const queryClient = client();
    const list = { items: [{ id: "share-1" }], activeCount: 1, nextCursor: null };
    const detail = { value: { id: "share-1" }, etag: '"1"' };
    mocks.listShareGrants.mockResolvedValue(list);
    mocks.getShareGrant.mockResolvedValue(detail);
    const listHook = renderHook(
      () => useWorkbenchShareGrants("project-1", { limit: 25 }),
      { wrapper: wrapper(queryClient) },
    );
    const detailHook = renderHook(
      () => useWorkbenchShareGrant("project-1", "share-1"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(listHook.result.current.data).toEqual(list));
    await waitFor(() => expect(detailHook.result.current.data).toEqual(detail));
    expect(mocks.listShareGrants).toHaveBeenCalledWith("project-1", { limit: 25 });
    expect(mocks.getShareGrant).toHaveBeenCalledWith("share-1");
    expect(queryClient.getQueryData(
      workbenchQueryKeys.shareList("project-1", { limit: 25 }),
    )).toEqual(list);
    expect(queryClient.getQueryData(
      workbenchQueryKeys.share("project-1", "share-1"),
    )).toEqual(detail);

    listHook.unmount();
    detailHook.unmount();
    queryClient.clear();
  });

  it("keeps a one-time Share token out of the durable query cache", async () => {
    const queryClient = client();
    const share = { id: "share-1", revision: 1 };
    mocks.rotateShareGrant.mockResolvedValue({
      value: { share, token: "one-time-secret", revokedGrantCount: 1 },
      etag: '"1"',
    });
    const rendered = renderHook(() => useRotateWorkbenchShareGrant("project-1"), {
      wrapper: wrapper(queryClient),
    });

    await act(() => rendered.result.current.mutateAsync({
      request: { releaseId: "release-1", scope: "view", expiresAt: null },
      idempotencyKey: "share-rotate:req_123",
    }));

    expect(mocks.rotateShareGrant).toHaveBeenCalledWith(
      "project-1",
      { releaseId: "release-1", scope: "view", expiresAt: null },
      "share-rotate:req_123",
    );
    expect(queryClient.getQueryData(
      workbenchQueryKeys.share("project-1", "share-1"),
    )).toEqual({ value: share, etag: '"1"' });
    rendered.unmount();
    queryClient.clear();
  });

  it("revokes a Share with the revision ETag from its detail cache", async () => {
    const queryClient = client();
    const current = { id: "share-1", status: "active" };
    const revoked = { value: { ...current, status: "revoked" }, etag: '"2"' };
    queryClient.setQueryData(workbenchQueryKeys.share("project-1", "share-1"), {
      value: current,
      etag: '"1"',
    });
    mocks.revokeShareGrant.mockResolvedValue(revoked);
    const rendered = renderHook(
      () => useRevokeWorkbenchShareGrant("project-1", "share-1"),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => rendered.result.current.mutateAsync({}));

    expect(mocks.revokeShareGrant).toHaveBeenCalledWith("share-1", '"1"');
    expect(queryClient.getQueryData(
      workbenchQueryKeys.share("project-1", "share-1"),
    )).toEqual(revoked);
    rendered.unmount();
    queryClient.clear();
  });

  it("revokes all Project Shares with one command and invalidates list and detail state", async () => {
    const queryClient = client();
    const listKey = workbenchQueryKeys.shareList("project-1", { limit: 100 });
    const detailKey = workbenchQueryKeys.share("project-1", "share-1");
    queryClient.setQueryData(listKey, { items: [], activeCount: 3, nextCursor: null });
    queryClient.setQueryData(detailKey, { value: { id: "share-1" }, etag: '"1"' });
    mocks.revokeProjectShareGrants.mockResolvedValue({
      projectId: "project-1",
      activeGrantCount: 0,
    });
    const rendered = renderHook(
      () => useRevokeWorkbenchProjectShareGrants("project-1"),
      { wrapper: wrapper(queryClient) },
    );

    await act(() => rendered.result.current.mutateAsync());

    expect(mocks.revokeProjectShareGrants).toHaveBeenCalledOnce();
    expect(mocks.revokeProjectShareGrants).toHaveBeenCalledWith("project-1");
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
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
