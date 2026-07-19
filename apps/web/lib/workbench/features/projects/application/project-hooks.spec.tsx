// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "../../../api/problem-details";
import { workbenchQueryKeys } from "../../../query/keys";
import {
  useArchiveWorkbenchProject,
  useInfiniteWorkbenchProjects,
  useRemoveWorkbenchProjectMember,
  useSetWorkbenchProjectMemberRole,
  useWorkbenchProjectBootstrap,
  useWorkbenchProjectMembers,
} from "./project-hooks";

const mocks = vi.hoisted(() => ({
  archiveProject: vi.fn(),
  getProjectBootstrap: vi.fn(),
  listProjectMembers: vi.fn(),
  listProjects: vi.fn(),
  removeProjectMember: vi.fn(),
  setProjectMemberRole: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchProjectsApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workbench Project hooks", () => {
  it("continues a filtered Project list with the opaque server cursor", async () => {
    mocks.listProjects
      .mockResolvedValueOnce({ items: [{ id: "project-1" }], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [{ id: "project-2" }], nextCursor: null });
    const queryClient = client();
    const rendered = renderHook(() => useInfiniteWorkbenchProjects({
      limit: 50,
      q: "design",
      relationship: "shared",
    }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(1));
    await act(() => rendered.result.current.fetchNextPage());
    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(2));

    expect(mocks.listProjects).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      limit: 50,
      q: "design",
      relationship: "shared",
    });
    expect(mocks.listProjects).toHaveBeenNthCalledWith(2, {
      cursor: "cursor-2",
      limit: 50,
      q: "design",
      relationship: "shared",
    });
    expect(rendered.result.current.data?.pages.flatMap((page) => page.items))
      .toEqual([{ id: "project-1" }, { id: "project-2" }]);
    expect(rendered.result.current.hasNextPage).toBe(false);
    rendered.unmount();
    queryClient.clear();
  });

  it("archives with the loaded Bootstrap ETag and evicts Project-owned state", async () => {
    const queryClient = client();
    queryClient.setQueryData(workbenchQueryKeys.bootstrap("project-1"), {
      value: { project: { revision: 7 } },
      etag: '"7"',
    });
    mocks.archiveProject.mockResolvedValue({
      value: { id: "project-1", workspaceId: "workspace-1", status: "archived" },
      etag: '"8"',
    });
    const rendered = renderHook(() => useArchiveWorkbenchProject("project-1"), {
      wrapper: wrapper(queryClient),
    });

    await act(() => rendered.result.current.mutateAsync({}));

    expect(mocks.archiveProject).toHaveBeenCalledWith("project-1", '"7"');
    expect(queryClient.getQueryData(workbenchQueryKeys.bootstrap("project-1"))).toBeUndefined();
    rendered.unmount();
    queryClient.clear();
  });

  it("refetches the Bootstrap and Project list after a 412 before a confirmed retry", async () => {
    const queryClient = client();
    queryClient.setQueryData(workbenchQueryKeys.bootstrap("project-1"), {
      value: { project: { id: "project-1", revision: 7 } },
      etag: '"7"',
    });
    mocks.listProjects
      .mockResolvedValueOnce({
        items: [{ id: "project-1", revision: 7 }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [{ id: "project-1", revision: 8 }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null,
      });
    mocks.getProjectBootstrap.mockResolvedValue({
      value: { project: { id: "project-1", revision: 8 } },
      etag: '"8"',
    });
    mocks.archiveProject
      .mockRejectedValueOnce(new WorkbenchApiError({
        type: "about:blank",
        title: "Precondition failed",
        status: 412,
        code: "REVISION_CONFLICT",
      }))
      .mockResolvedValueOnce({
        value: { id: "project-1", workspaceId: "workspace-1", status: "archived" },
        etag: '"9"',
      });

    const rendered = renderHook(() => ({
      archive: useArchiveWorkbenchProject("project-1"),
      bootstrap: useWorkbenchProjectBootstrap("project-1"),
      projects: useInfiniteWorkbenchProjects({ relationship: "owned" }),
    }), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(rendered.result.current.projects.data).toBeDefined());

    let conflict: unknown;
    await act(async () => {
      try {
        await rendered.result.current.archive.mutateAsync({});
      } catch (error) {
        conflict = error;
      }
    });
    expect(conflict).toMatchObject({ status: 412 });
    await waitFor(() => {
      expect(rendered.result.current.bootstrap.data?.etag).toBe('"8"');
      expect(rendered.result.current.projects.data?.pages[0]?.items[0]?.revision).toBe(8);
    });
    expect(mocks.listProjects).toHaveBeenCalledTimes(2);

    await act(() => rendered.result.current.archive.mutateAsync({}));
    expect(mocks.archiveProject).toHaveBeenNthCalledWith(1, "project-1", '"7"');
    expect(mocks.archiveProject).toHaveBeenNthCalledWith(2, "project-1", '"8"');
    expect(mocks.getProjectBootstrap).toHaveBeenCalledWith("project-1", undefined);
    expect(mocks.listProjects).toHaveBeenCalledTimes(3);
    rendered.unmount();
    queryClient.clear();
  });

  it("refetches Bootstrap and members after member write conflicts without hiding the 412", async () => {
    const queryClient = client();
    queryClient.setQueryData(workbenchQueryKeys.bootstrap("project-1"), {
      value: { project: { id: "project-1", revision: 7 } },
      etag: '"7"',
    });
    queryClient.setQueryData(workbenchQueryKeys.projectMembers("project-1"), {
      items: [{ principalId: "principal-2", role: "viewer" }],
    });
    const setConflict = new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_CONFLICT",
    });
    const removeConflict = new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_CONFLICT",
    });
    mocks.setProjectMemberRole.mockRejectedValue(setConflict);
    mocks.removeProjectMember.mockRejectedValue(removeConflict);
    mocks.getProjectBootstrap
      .mockResolvedValueOnce({
        value: { project: { id: "project-1", revision: 8 } },
        etag: '"8"',
      })
      .mockResolvedValueOnce({
        value: { project: { id: "project-1", revision: 9 } },
        etag: '"9"',
      });
    mocks.listProjectMembers
      .mockResolvedValueOnce({ items: [{ principalId: "principal-2", role: "editor" }] })
      .mockResolvedValueOnce({ items: [] });

    const rendered = renderHook(() => ({
      bootstrap: useWorkbenchProjectBootstrap("project-1"),
      members: useWorkbenchProjectMembers("project-1"),
      setMember: useSetWorkbenchProjectMemberRole("project-1"),
      removeMember: useRemoveWorkbenchProjectMember("project-1"),
    }), { wrapper: wrapper(queryClient) });

    let observedSetConflict: unknown;
    await act(async () => {
      try {
        await rendered.result.current.setMember.mutateAsync({
          principalId: "principal-2",
          request: { role: "editor" },
        });
      } catch (error) {
        observedSetConflict = error;
      }
    });
    expect(observedSetConflict).toBe(setConflict);
    await waitFor(() => {
      expect(rendered.result.current.bootstrap.data?.etag).toBe('"8"');
      expect(rendered.result.current.members.data?.items[0]?.role).toBe("editor");
    });
    expect(mocks.setProjectMemberRole)
      .toHaveBeenCalledWith("project-1", "principal-2", { role: "editor" }, '"7"');

    let observedRemoveConflict: unknown;
    await act(async () => {
      try {
        await rendered.result.current.removeMember.mutateAsync({ principalId: "principal-2" });
      } catch (error) {
        observedRemoveConflict = error;
      }
    });
    expect(observedRemoveConflict).toBe(removeConflict);
    await waitFor(() => {
      expect(rendered.result.current.bootstrap.data?.etag).toBe('"9"');
      expect(rendered.result.current.members.data?.items).toEqual([]);
    });
    expect(mocks.removeProjectMember)
      .toHaveBeenCalledWith("project-1", "principal-2", '"8"');
    expect(mocks.getProjectBootstrap).toHaveBeenCalledTimes(2);
    expect(mocks.listProjectMembers).toHaveBeenCalledTimes(2);
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
