// @vitest-environment jsdom

import type { Board, ReplaceBoardRequest } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { useWorkbenchBoardController } from "./index";

const mocks = vi.hoisted(() => ({
  getBoard: vi.fn(),
  replaceBoard: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchBoardApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench Board controller", () => {
  it("loads through the Board adapter and commits a versioned save to store and cache", async () => {
    const initial = board();
    const loaded = { value: initial, etag: '"1"' };
    mocks.getBoard.mockResolvedValue(loaded);
    mocks.replaceBoard.mockImplementation(async (
      projectId: string,
      request: ReplaceBoardRequest,
    ) => ({
      value: { ...initial, ...request, projectId, revision: 2 },
      etag: '"2"',
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useWorkbenchBoardController("project-1"),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.store).not.toBeNull());
    const store = rendered.result.current.store!;
    act(() => store.getState().setViewport({ x: 40, y: 25, zoom: 0.8 }));
    await act(async () => {
      await rendered.result.current.save();
    });

    expect(mocks.getBoard).toHaveBeenCalledWith("project-1");
    expect(mocks.replaceBoard).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ viewport: { x: 40, y: 25, zoom: 0.8 } }),
      '"1"',
      expect.any(String),
    );
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      serverRevision: 2,
      viewport: { x: 40, y: 25, zoom: 0.8 },
    });
    expect(queryClient.getQueryData(workbenchQueryKeys.board("project-1")))
      .toMatchObject({ value: { revision: 2 }, etag: '"2"' });

    rendered.unmount();
    queryClient.clear();
  });

  it("replays conflicted local state against a freshly loaded server revision", async () => {
    const initial = board();
    const remote = {
      ...initial,
      revision: 2,
      viewport: { x: 400, y: 500, zoom: 0.5 },
    };
    mocks.getBoard
      .mockResolvedValueOnce({ value: initial, etag: '"1"' })
      .mockResolvedValueOnce({ value: remote, etag: '"2"' });
    mocks.replaceBoard.mockImplementation(async (
      projectId: string,
      request: ReplaceBoardRequest,
    ) => ({ value: { ...remote, ...request, projectId, revision: 3 }, etag: '"3"' }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useWorkbenchBoardController("project-1"),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.store).not.toBeNull());
    const store = rendered.result.current.store!;
    act(() => {
      store.getState().setViewport({ x: 40, y: 25, zoom: 0.8 });
      store.getState().reconcileFromServer(remote, '"2"');
    });
    await act(async () => {
      await rendered.result.current.replayLocalConflict();
    });

    expect(mocks.getBoard).toHaveBeenCalledTimes(2);
    expect(mocks.replaceBoard).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ viewport: { x: 40, y: 25, zoom: 0.8 } }),
      '"2"',
      expect.any(String),
    );
    expect(store.getState()).toMatchObject({
      serverRevision: 3,
      viewport: { x: 40, y: 25, zoom: 0.8 },
      dirty: false,
      saveStatus: "clean",
    });

    rendered.unmount();
    queryClient.clear();
  });

  it("discards conflicted local state only through the explicit command", async () => {
    const initial = board();
    const remote = {
      ...initial,
      revision: 2,
      viewport: { x: 400, y: 500, zoom: 0.5 },
    };
    mocks.getBoard
      .mockResolvedValueOnce({ value: initial, etag: '"1"' })
      .mockResolvedValueOnce({ value: remote, etag: '"2"' });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useWorkbenchBoardController("project-1"),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.store).not.toBeNull());
    const store = rendered.result.current.store!;
    act(() => {
      store.getState().setViewport({ x: 40, y: 25, zoom: 0.8 });
      store.getState().reconcileFromServer(remote, '"2"');
    });
    await act(async () => {
      await rendered.result.current.discardLocalConflict();
    });

    expect(mocks.replaceBoard).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      serverRevision: 2,
      viewport: remote.viewport,
      dirty: false,
      saveStatus: "clean",
    });

    rendered.unmount();
    queryClient.clear();
  });
});

function board(): Board {
  return {
    id: "board-1",
    projectId: "project-1",
    revision: 1,
    viewport: { x: 10, y: 20, zoom: 1 },
    nodes: [],
    edges: [],
  };
}
