// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchCanvasFavouritesPanel } from "./workbench-canvas-favourites-panel";

const mocks = vi.hoisted(() => ({
  useFavorites: vi.fn(),
}));

vi.mock("@/lib/workbench/features", () => ({
  useInfiniteWorkbenchArtifactVersionFavorites: mocks.useFavorites,
}));

afterEach(() => {
  cleanup();
  mocks.useFavorites.mockReset();
});

describe("Workbench Canvas Favourites panel", () => {
  it("renders the canonical empty state without extra shortcut instructions", () => {
    mocks.useFavorites.mockReturnValue(favoritesQuery([]));

    render(
      <WorkbenchCanvasFavouritesPanel
        onClose={vi.fn()}
        projectId="project-1"
      />,
    );

    expect(screen.getByText("No favourites yet")).not.toBeNull();
    expect(screen.queryByText(/Shift\+F/)).toBeNull();
  });

  it("opens a favourite target and loads the next server page", () => {
    const fetchNextPage = vi.fn();
    const onSelect = vi.fn();
    const item = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      artifactKind: "prototype",
      artifactTitle: "Checkout flow",
      artifactVersion: 3,
      screenId: "screen-home",
      screenName: "Home",
      updatedAt: "2026-07-17T10:00:00.000Z",
    };
    mocks.useFavorites.mockReturnValue(favoritesQuery([item], {
      fetchNextPage,
      hasNextPage: true,
    }));

    render(
      <WorkbenchCanvasFavouritesPanel
        onClose={vi.fn()}
        onSelect={onSelect}
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Home/ }));
    expect(onSelect).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });
});

function favoritesQuery(
  items: readonly unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    data: { pages: [{ items, nextCursor: null }] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isPending: false,
    refetch: vi.fn(),
    ...overrides,
  };
}
