// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useCreateWorkbenchArtifact,
  useCreateWorkbenchArtifactVersion,
  usePersistWorkbenchPrdVersion,
  useInfiniteWorkbenchArtifactVersions,
  useWorkbenchArtifactVersionBatch,
  useWorkbenchArtifactVersions,
  useWorkbenchArtifactVersionContent,
  useWorkbenchArtifactVersionAsset,
} from "./index";

const mocks = vi.hoisted(() => ({
  getArtifact: vi.fn(),
  getArtifactVersionAssetContent: vi.fn(),
  getArtifactVersionContent: vi.fn(),
  createArtifact: vi.fn(),
  createArtifactVersion: vi.fn(),
  getArtifactVersion: vi.fn(),
  listArtifactVersions: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchArtifactsApi: () => mocks,
}));

afterEach(() => {
  mocks.getArtifact.mockReset();
  mocks.getArtifactVersionAssetContent.mockReset();
  mocks.getArtifactVersionContent.mockReset();
  mocks.createArtifact.mockReset();
  mocks.createArtifactVersion.mockReset();
  mocks.getArtifactVersion.mockReset();
  mocks.listArtifactVersions.mockReset();
});

describe("Workbench Artifact creation mutation", () => {
  it("forwards the File source and invalidates project Artifact projections", async () => {
    mocks.createArtifact.mockResolvedValue({
      artifact: { id: "artifact-image" },
      artifactVersion: { artifactVersionId: "version-image" },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(workbenchQueryKeys.artifactList("project-1"), { items: [] });
    queryClient.setQueryData(workbenchQueryKeys.bootstrap("project-1"), { artifacts: [] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(() => useCreateWorkbenchArtifact("project-1"), { wrapper });
    const request = {
      kind: "image" as const,
      title: "Hero image",
      source: { kind: "file" as const, fileAssetId: "file-1" },
    };

    await act(async () => {
      await rendered.result.current.mutateAsync({
        request,
        idempotencyKey: "artifact:create-1",
      });
    });

    expect(mocks.createArtifact).toHaveBeenCalledWith(
      "project-1",
      request,
      "artifact:create-1",
    );
    expect(queryClient.getQueryState(workbenchQueryKeys.artifactList("project-1"))?.isInvalidated)
      .toBe(true);
    expect(queryClient.getQueryState(workbenchQueryKeys.bootstrap("project-1"))?.isInvalidated)
      .toBe(true);
    rendered.unmount();
    queryClient.clear();
  });
});

describe("Workbench ArtifactVersion mutation", () => {
  it("saves a deselected PRD against its own fresh artifact ETag and caches the new version", async () => {
    mocks.getArtifact.mockResolvedValue({ value: { id: "prd-1", projectId: "project-1" }, etag: '"7"' });
    const saved = { value: { artifactVersionId: "prd-v2", artifactId: "prd-1" }, etag: '"8"' };
    mocks.createArtifactVersion.mockResolvedValue(saved);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(workbenchQueryKeys.artifact("project-1", "prd-1"), { value: { id: "prd-1" }, etag: '"2"' });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const rendered = renderHook(() => usePersistWorkbenchPrdVersion("project-1"), { wrapper });
    await act(async () => { await rendered.result.current.mutateAsync({
      reference: { projectId: "project-1", artifactId: "prd-1", artifactVersionId: "prd-v1" },
      document: prdDocumentV2Example,
    }); });
    expect(mocks.getArtifact).toHaveBeenCalledWith("prd-1");
    expect(mocks.createArtifactVersion).toHaveBeenCalledWith("prd-1", {
      kind: "prd", baseArtifactVersionId: "prd-v1", document: prdDocumentV2Example,
    }, '"7"', expect.any(String));
    expect(queryClient.getQueryData(workbenchQueryKeys.artifactVersion("project-1", "prd-1", "prd-v2"))).toEqual(saved);
    rendered.unmount();
    queryClient.clear();
  });

  it("does not create a PRD version when the loaded artifact belongs to another project", async () => {
    mocks.getArtifact.mockResolvedValue({ value: { id: "prd-1", projectId: "project-2" }, etag: '"7"' });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const rendered = renderHook(() => usePersistWorkbenchPrdVersion("project-1"), { wrapper });
    await act(async () => { await expect(rendered.result.current.mutateAsync({
      reference: { projectId: "project-1", artifactId: "prd-1", artifactVersionId: "prd-v1" },
      document: prdDocumentV2Example,
    })).rejects.toThrow("文档不属于当前项目"); });
    expect(mocks.createArtifactVersion).not.toHaveBeenCalled();
    rendered.unmount();
    queryClient.clear();
  });

  it("uses the cached Artifact ETag and forwards the caller-owned receipt key", async () => {
    mocks.createArtifactVersion.mockResolvedValue({
      value: { artifactVersionId: "version-2" },
      etag: '"6"',
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(
      workbenchQueryKeys.artifact("project-1", "artifact-1"),
      { value: { id: "artifact-1" }, etag: '"5"' },
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useCreateWorkbenchArtifactVersion("project-1", "artifact-1"),
      { wrapper },
    );
    const request = {
      kind: "prototype",
      baseArtifactVersionId: "version-1",
      document: { protocol: "workbench.prototype.v1" },
    } as never;

    await act(async () => {
      await rendered.result.current.mutateAsync({
        request,
        idempotencyKey: "artifact-version:request-1",
      });
    });

    expect(mocks.createArtifactVersion).toHaveBeenCalledWith(
      "artifact-1",
      request,
      '"5"',
      "artifact-version:request-1",
    );
    rendered.unmount();
    queryClient.clear();
  });
});

describe("Workbench ArtifactVersion list query", () => {
  it("loads a dynamic screen selection through canonical per-version query keys", async () => {
    mocks.getArtifactVersion.mockImplementation(async (artifactId: string, artifactVersionId: string) => ({
      value: { artifactId, artifactVersionId },
      etag: `"${artifactVersionId}"`,
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const references = [
      { artifactId: "artifact-1", artifactVersionId: "version-1" },
      { artifactId: "artifact-2", artifactVersionId: "version-2" },
    ];
    const rendered = renderHook(
      () => useWorkbenchArtifactVersionBatch("project-1", references),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.every((query) => query.isSuccess)).toBe(true));
    expect(mocks.getArtifactVersion).toHaveBeenCalledWith("artifact-1", "version-1");
    expect(mocks.getArtifactVersion).toHaveBeenCalledWith("artifact-2", "version-2");
    expect(queryClient.getQueryData(
      workbenchQueryKeys.artifactVersion("project-1", "artifact-2", "version-2"),
    )).toMatchObject({ value: { artifactVersionId: "version-2" } });

    rendered.unmount();
    queryClient.clear();
  });

  it("requests the explicit first-100 version window", async () => {
    mocks.listArtifactVersions.mockResolvedValue({ items: [], nextCursor: "version-100" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useWorkbenchArtifactVersions("project-1", "artifact-1", { limit: 100 }),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.data?.nextCursor).toBe("version-100"));
    expect(mocks.listArtifactVersions).toHaveBeenCalledWith("artifact-1", { limit: 100 });

    rendered.unmount();
    queryClient.clear();
  });

  it("requests older version pages with the server-provided cursor", async () => {
    mocks.listArtifactVersions
      .mockResolvedValueOnce({ items: [], nextCursor: "version-100" })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useInfiniteWorkbenchArtifactVersions("project-1", "artifact-1", { limit: 100 }),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.hasNextPage).toBe(true));
    await act(async () => {
      await rendered.result.current.fetchNextPage();
    });

    expect(mocks.listArtifactVersions).toHaveBeenNthCalledWith(1, "artifact-1", {
      limit: 100,
      cursor: undefined,
    });
    expect(mocks.listArtifactVersions).toHaveBeenNthCalledWith(2, "artifact-1", {
      limit: 100,
      cursor: "version-100",
    });
    await waitFor(() => expect(rendered.result.current.hasNextPage).toBe(false));

    rendered.unmount();
    queryClient.clear();
  });
});

describe("Workbench Artifact asset query", () => {
  it("loads and caches authorized immutable bytes through the feature adapter", async () => {
    const content = new Blob(["asset"], { type: "image/png" });
    mocks.getArtifactVersionAssetContent.mockResolvedValue(content);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const rendered = renderHook(() => useWorkbenchArtifactVersionAsset(
      "project-1",
      "artifact-1",
      "version-1",
      "image-1",
    ), { wrapper });

    await waitFor(() => expect(rendered.result.current.data).toBe(content));
    expect(mocks.getArtifactVersionAssetContent).toHaveBeenCalledOnce();
    expect(mocks.getArtifactVersionAssetContent).toHaveBeenCalledWith(
      "artifact-1",
      "version-1",
      "image-1",
    );

    rendered.unmount();
    queryClient.clear();
  });
});

describe("Workbench Artifact content query", () => {
  it("loads and caches immutable Artifact bytes", async () => {
    const content = new Blob(["image"], { type: "image/png" });
    mocks.getArtifactVersionContent.mockResolvedValue(content);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => useWorkbenchArtifactVersionContent("project-1", "artifact-1", "version-1"),
      { wrapper },
    );

    await waitFor(() => expect(rendered.result.current.data).toBe(content));
    expect(mocks.getArtifactVersionContent).toHaveBeenCalledWith("artifact-1", "version-1");

    rendered.unmount();
    queryClient.clear();
  });
});
