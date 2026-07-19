// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkbenchPublicationController } from "./workbench-publication-controller";

const mocks = vi.hoisted(() => ({
  rotate: vi.fn(),
  revokeAll: vi.fn(),
  releaseRefetch: vi.fn(),
  shareQuery: vi.fn(),
}));

vi.mock("./releases", () => ({
  useWorkbenchReleases: () => ({
    data: undefined,
    refetch: mocks.releaseRefetch,
  }),
  useCreateWorkbenchRelease: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

vi.mock("./shares", () => ({
  useWorkbenchShareGrants: () => mocks.shareQuery(),
  useRotateWorkbenchShareGrant: () => ({
    mutateAsync: mocks.rotate,
    isPending: false,
    error: null,
  }),
  useRevokeWorkbenchProjectShareGrants: () => ({
    mutateAsync: mocks.revokeAll,
    isPending: false,
    error: null,
  }),
}));

vi.mock("./exports", () => ({
  useWorkbenchExportOperations: () => ({}),
  useWorkbenchExportCapabilities: () => ({ data: null, error: null, refetch: vi.fn() }),
  useWorkbenchExportJobs: () => ({
    data: { items: [], nextCursor: null },
    error: null,
    isError: false,
    isPending: false,
    isPlaceholderData: false,
  }),
  useCreateWorkbenchExportJob: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useWorkbenchExportJob: () => ({ data: null, error: null }),
  useCancelWorkbenchExportJob: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shareQuery.mockReturnValue({
    data: { items: [], activeCount: 1, nextCursor: null },
    error: null,
    isPending: false,
    isPlaceholderData: false,
    isSuccess: true,
    refetch: vi.fn(async () => ({
      data: { items: [], activeCount: 1, nextCursor: null },
    })),
  });
});

afterEach(() => vi.clearAllMocks());

describe("Workbench publication Share rotation", () => {
  it("rotates an existing active grant when a refreshed browser has lost its one-time token", async () => {
    mocks.releaseRefetch.mockResolvedValue({
      data: {
        items: [{
          id: "release-1",
          status: "ready",
          boardId: "board-1",
          boardRevision: 7,
        }],
      },
    });
    mocks.rotate.mockResolvedValue({
      value: {
        share: { id: "share-new" },
        token: `wbs_${"A".repeat(43)}`,
        revokedGrantCount: 1,
      },
      etag: '"0"',
    });
    const boardController = {
      store: {
        getState: () => ({
          boardId: "board-1",
          serverRevision: 7,
          dirty: false,
          saveStatus: "clean",
        }),
      },
      save: vi.fn(),
    };
    const rendered = renderHook(() => useWorkbenchPublicationController({
      boardController: boardController as never,
      canExport: false,
      canPreview: false,
      canShare: true,
      projectId: "project-1",
    }));

    let firstUrl = "";
    await act(async () => {
      firstUrl = await rendered.result.current.ensureShareLink();
    });
    expect(firstUrl).toBe(`${window.location.origin}/share/wbs_${"A".repeat(43)}`);
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
    expect(mocks.rotate).toHaveBeenCalledWith({
      request: { releaseId: "release-1", scope: "remix", expiresAt: null },
    });

    await act(async () => {
      await rendered.result.current.ensureShareLink();
    });
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.shareUrl).toBe(firstUrl);
  });

  it("keeps the existing toggle-off path as atomic revoke-all", async () => {
    mocks.revokeAll.mockResolvedValue({ projectId: "project-1", activeGrantCount: 0 });
    const rendered = renderHook(() => useWorkbenchPublicationController({
      boardController: { store: null, save: vi.fn() },
      canExport: false,
      canPreview: false,
      canShare: true,
      projectId: "project-1",
    }));

    await act(async () => {
      await rendered.result.current.toggleShare();
    });
    expect(mocks.revokeAll).toHaveBeenCalledOnce();
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it("keeps an unavailable Share query distinct from disabled sharing and refetches before toggling", async () => {
    const queryError = new Error("share query unavailable");
    const refetch = vi.fn(async () => ({
      data: { items: [], activeCount: 1, nextCursor: null },
    }));
    mocks.shareQuery.mockReturnValue({
      data: undefined,
      error: queryError,
      isPending: false,
      isPlaceholderData: false,
      isSuccess: false,
      refetch,
    });
    mocks.revokeAll.mockResolvedValue({ projectId: "project-1", activeGrantCount: 0 });
    const rendered = renderHook(() => useWorkbenchPublicationController({
      boardController: { store: null, save: vi.fn() },
      canExport: false,
      canPreview: false,
      canShare: true,
      projectId: "project-1",
    }));

    expect(rendered.result.current.shareStateError).toBe(queryError);
    expect(rendered.result.current.shareEnabled).toBe(false);
    await act(async () => {
      await rendered.result.current.toggleShare();
    });

    expect(refetch).toHaveBeenCalledWith({ throwOnError: true });
    expect(mocks.revokeAll).toHaveBeenCalledOnce();
    expect(mocks.rotate).not.toHaveBeenCalled();
  });

  it("does not expose a previous Project's late Share error or URL in the new Project", async () => {
    const rotation = deferred<{
      value: {
        share: { id: string };
        token: string;
        revokedGrantCount: number;
      };
      etag: string;
    }>();
    mocks.releaseRefetch.mockResolvedValue({
      data: {
        items: [{
          id: "release-1",
          status: "ready",
          boardId: "board-1",
          boardRevision: 7,
        }],
      },
    });
    mocks.rotate.mockReturnValue(rotation.promise);
    const boardController = {
      store: {
        getState: () => ({
          boardId: "board-1",
          serverRevision: 7,
          dirty: false,
          saveStatus: "clean",
        }),
      },
      save: vi.fn(),
    };
    const rendered = renderHook(
      ({ projectId }) => useWorkbenchPublicationController({
        boardController: boardController as never,
        canExport: false,
        canPreview: false,
        canShare: true,
        projectId,
      }),
      { initialProps: { projectId: "project-1" } },
    );
    let request!: Promise<string>;
    act(() => {
      request = rendered.result.current.ensureShareLink();
    });
    await waitFor(() => expect(mocks.rotate).toHaveBeenCalledOnce());

    rendered.rerender({ projectId: "project-2" });
    expect(rendered.result.current.shareUrl).toBeNull();
    expect(rendered.result.current.shareError).toBeNull();

    await act(async () => {
      rotation.reject(new Error("late project-1 rotation failure"));
      await request.catch(() => undefined);
    });
    expect(rendered.result.current.shareUrl).toBeNull();
    expect(rendered.result.current.shareError).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
