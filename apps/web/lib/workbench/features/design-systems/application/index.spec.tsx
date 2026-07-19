// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useInfiniteWorkbenchDesignSystemCatalog,
  useWorkbenchDesignSystemOperations,
} from "./index";

const mocks = vi.hoisted(() => ({
  listDesignSystemCatalog: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchDesignSystemsApi: () => mocks,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDesignSystemCatalog.mockImplementation(async (
    _workspaceId: string,
    options: { cursor?: string },
  ) => options.cursor
    ? { items: [catalogItem("version-2", "Second")], nextCursor: null }
    : { items: [catalogItem("version-1", "First")], nextCursor: "cursor-2" });
});

describe("Workspace Design System catalog pagination", () => {
  it("passes the feature-owned adapter directly to provisioning operations", () => {
    const rendered = renderHook(() => useWorkbenchDesignSystemOperations());

    expect(rendered.result.current).toBe(mocks);
    rendered.unmount();
  });

  it("uses the server cursor to append the next catalog page", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useInfiniteWorkbenchDesignSystemCatalog("workspace-1", { limit: 20 }),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(1));
    expect(rendered.result.current.hasNextPage).toBe(true);
    await act(() => rendered.result.current.fetchNextPage());
    await waitFor(() => expect(rendered.result.current.data?.pages).toHaveLength(2));

    expect(mocks.listDesignSystemCatalog).toHaveBeenNthCalledWith(1, "workspace-1", {
      cursor: undefined,
      limit: 20,
    });
    expect(mocks.listDesignSystemCatalog).toHaveBeenNthCalledWith(2, "workspace-1", {
      cursor: "cursor-2",
      limit: 20,
    });
    expect(rendered.result.current.data?.pages.flatMap((page) => page.items).map((item) => item.artifactVersionId))
      .toEqual(["version-1", "version-2"]);
    queryClient.clear();
  });
});

function catalogItem(artifactVersionId: string, artifactTitle: string) {
  return {
    projectId: "project-source",
    projectTitle: "Source",
    artifactId: `artifact-${artifactVersionId}`,
    artifactTitle,
    artifactVersionId,
    version: 1,
    checksum: "a".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}
