// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  mergeArtifactVersionPreferenceCache,
  useInfiniteWorkbenchArtifactVersionFavorites,
  useUpdateWorkbenchArtifactVersionPreference,
  useWorkbenchArtifactVersionPreference,
} from "./index";

const principalCacheNamespace = "principal-1";
const scopedEtag = (revision: number) => `"avp1.${revision}.${"a".repeat(43)}"`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  getArtifactVersionPreference: vi.fn(),
  listArtifactVersionFavorites: vi.fn(),
  updateArtifactVersionPreference: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchArtifactsApi: () => mocks,
}));

afterEach(() => {
  mocks.getArtifactVersionPreference.mockReset();
  mocks.listArtifactVersionFavorites.mockReset();
  mocks.updateArtifactVersionPreference.mockReset();
});

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("ArtifactVersion preference hooks", () => {
  it("merges cache representations monotonically by preference revision", () => {
    const representation = (revision: number, favorite: boolean) => ({
      value: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: null,
        favorite,
        reaction: null,
        revision,
        createdAt: "2026-07-14T08:20:00.000Z",
        updatedAt: `2026-07-14T08:2${revision}:00.000Z`,
      },
      etag: scopedEtag(revision),
    });
    const current = representation(3, true);

    expect(mergeArtifactVersionPreferenceCache(current, representation(2, false)))
      .toBe(current);
    expect(mergeArtifactVersionPreferenceCache(current, representation(3, false)))
      .toBe(current);
    expect(mergeArtifactVersionPreferenceCache(current, representation(4, false)))
      .toEqual(representation(4, false));
  });

  it("loads project favourites page by page with the server-provided cursor", async () => {
    mocks.listArtifactVersionFavorites
      .mockResolvedValueOnce({ items: [], nextCursor: "opaque-page-2" })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const { queryClient, wrapper } = setup();
    const rendered = renderHook(() => useInfiniteWorkbenchArtifactVersionFavorites(
      "project-1",
      { limit: 20 },
    ), { wrapper });

    await waitFor(() => expect(rendered.result.current.hasNextPage).toBe(true));
    await act(async () => {
      await rendered.result.current.fetchNextPage();
    });

    expect(mocks.listArtifactVersionFavorites).toHaveBeenNthCalledWith(1, "project-1", {
      limit: 20,
      cursor: undefined,
    });
    expect(mocks.listArtifactVersionFavorites).toHaveBeenNthCalledWith(2, "project-1", {
      limit: 20,
      cursor: "opaque-page-2",
    });
    await waitFor(() => expect(rendered.result.current.hasNextPage).toBe(false));
    expect(queryClient.getQueryData(workbenchQueryKeys.artifactVersionFavoriteInfiniteList(
      "project-1",
      { limit: 20 },
    ))).toBeDefined();
    rendered.unmount();
    queryClient.clear();
  });

  it("loads the principal's preference under the immutable version cache key", async () => {
    const result = {
      value: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-home",
        favorite: false,
        reaction: null,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      },
      etag: scopedEtag(0),
    };
    mocks.getArtifactVersionPreference.mockResolvedValue(result);
    const { queryClient, wrapper } = setup();
    const rendered = renderHook(() => useWorkbenchArtifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      "screen-home",
      true,
    ), { wrapper });

    await waitFor(() => expect(rendered.result.current.data).toEqual(result));
    expect(mocks.getArtifactVersionPreference).toHaveBeenCalledWith(
      "artifact-1",
      "version-1",
      "screen-home",
      undefined,
      expect.any(AbortSignal),
    );
    expect(queryClient.getQueryData(workbenchQueryKeys.artifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      "screen-home",
    ))).toEqual(result);
    rendered.unmount();
    queryClient.clear();
  });

  it("uses the cached ETag and replaces the exact preference cache after CAS", async () => {
    const { queryClient, wrapper } = setup();
    const queryKey = workbenchQueryKeys.artifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      "screen-home",
    );
    queryClient.setQueryData(queryKey, {
      value: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-home",
        favorite: false,
        reaction: null,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      },
      etag: scopedEtag(0),
    });
    const updated = {
      value: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-home",
        favorite: true,
        reaction: "like",
        revision: 1,
        createdAt: "2026-07-14T08:20:00.000Z",
        updatedAt: "2026-07-14T08:20:00.000Z",
      },
      etag: scopedEtag(1),
    };
    const projectFavoritesKey = workbenchQueryKeys.artifactVersionFavoriteInfiniteList(
      "project-1",
      { limit: 20 },
    );
    const otherProjectFavoritesKey = workbenchQueryKeys.artifactVersionFavoriteInfiniteList(
      "project-2",
      { limit: 20 },
    );
    queryClient.setQueryData(projectFavoritesKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(otherProjectFavoritesKey, { pages: [], pageParams: [] });
    mocks.updateArtifactVersionPreference.mockResolvedValue(updated);
    const rendered = renderHook(() => useUpdateWorkbenchArtifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      "screen-home",
    ), { wrapper });

    await act(async () => {
      await rendered.result.current.mutateAsync({
        request: { favorite: true, reaction: "like" },
      });
    });

    expect(mocks.updateArtifactVersionPreference).toHaveBeenCalledWith(
      "artifact-1",
      "version-1",
      { favorite: true, reaction: "like" },
      scopedEtag(0),
      "screen-home",
    );
    expect(queryClient.getQueryData(queryKey)).toEqual(updated);
    expect(queryClient.getQueryState(projectFavoritesKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherProjectFavoritesKey)?.isInvalidated).toBe(false);
    rendered.unmount();
    queryClient.clear();
  });

  it("refuses a mutation before the preference ETag has been loaded", async () => {
    const { queryClient, wrapper } = setup();
    const rendered = renderHook(() => useUpdateWorkbenchArtifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      "screen-home",
    ), { wrapper });

    await expect(rendered.result.current.mutateAsync({
      request: { favorite: true, reaction: null },
    })).rejects.toMatchObject({ name: "WorkbenchVersionRequiredError" });
    expect(mocks.updateArtifactVersionPreference).not.toHaveBeenCalled();
    rendered.unmount();
    queryClient.clear();
  });

  it("cancels a slow GET and never lets its older revision overwrite mutation success", async () => {
    const { queryClient, wrapper } = setup();
    const queryKey = workbenchQueryKeys.artifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      "screen-home",
    );
    const initial = {
      value: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-home",
        favorite: false,
        reaction: null,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      },
      etag: scopedEtag(0),
    } as const;
    const updated = {
      value: {
        ...initial.value,
        favorite: true,
        reaction: "like" as const,
        revision: 1,
        createdAt: "2026-07-14T08:20:00.000Z",
        updatedAt: "2026-07-14T08:20:00.000Z",
      },
      etag: scopedEtag(1),
    };
    const pendingGet = deferred<typeof initial>();
    let requestSignal: AbortSignal | undefined;
    queryClient.setQueryData(queryKey, initial);
    mocks.getArtifactVersionPreference.mockImplementation(
      async (_artifactId, _artifactVersionId, _screenId, cached, signal) => {
        expect(cached).toEqual(initial);
        requestSignal = signal;
        return pendingGet.promise;
      },
    );
    mocks.updateArtifactVersionPreference.mockResolvedValue(updated);
    const rendered = renderHook(() => ({
      preference: useWorkbenchArtifactVersionPreference(
        principalCacheNamespace,
        "project-1",
        "artifact-1",
        "version-1",
        "screen-home",
      ),
      update: useUpdateWorkbenchArtifactVersionPreference(
        principalCacheNamespace,
        "project-1",
        "artifact-1",
        "version-1",
        "screen-home",
      ),
    }), { wrapper });

    await waitFor(() => expect(mocks.getArtifactVersionPreference).toHaveBeenCalledOnce());
    await act(async () => {
      await rendered.result.current.update.mutateAsync({
        request: { favorite: true, reaction: "like" },
      });
    });

    expect(requestSignal?.aborted).toBe(true);
    expect(queryClient.getQueryData(queryKey)).toEqual(updated);
    await act(async () => {
      pendingGet.resolve(initial);
      await pendingGet.promise;
    });
    expect(queryClient.getQueryData(queryKey)).toEqual(updated);
    rendered.unmount();
    queryClient.clear();
  });

  it("keeps the current revision and invalidates it after a mutation failure", async () => {
    const { queryClient, wrapper } = setup();
    const queryKey = workbenchQueryKeys.artifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      null,
    );
    const current = {
      value: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: null,
        favorite: true,
        reaction: "like" as const,
        revision: 3,
        createdAt: "2026-07-14T08:20:00.000Z",
        updatedAt: "2026-07-14T08:22:00.000Z",
      },
      etag: scopedEtag(3),
    };
    queryClient.setQueryData(queryKey, current);
    mocks.updateArtifactVersionPreference.mockRejectedValue(new Error("write failed"));
    const rendered = renderHook(() => useUpdateWorkbenchArtifactVersionPreference(
      principalCacheNamespace,
      "project-1",
      "artifact-1",
      "version-1",
      null,
    ), { wrapper });

    await expect(rendered.result.current.mutateAsync({
      request: { favorite: false, reaction: null },
    })).rejects.toThrow("write failed");

    expect(queryClient.getQueryData(queryKey)).toEqual(current);
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    rendered.unmount();
    queryClient.clear();
  });
});
