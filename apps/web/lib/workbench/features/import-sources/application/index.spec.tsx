// @vitest-environment jsdom

import type { ImportSource } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { WorkbenchVersionRequiredError } from "../../../transport/contracts";
import {
  useCreateWorkbenchImportSource,
  useDeleteWorkbenchImportSource,
  useWorkbenchImportSource,
  useWorkbenchImportSources,
} from "./index";

const mocks = vi.hoisted(() => ({
  createImportSource: vi.fn(),
  deleteImportSource: vi.fn(),
  getImportSource: vi.fn(),
  listImportSources: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useOptionalWorkbenchImportSourcesApi: () => mocks,
}));

const timestamp = "2026-07-18T00:00:00.000Z";
const source: ImportSource = {
  id: "source-1",
  projectId: "project-1",
  createdById: "user-1",
  kind: "url_snapshot",
  status: "ready",
  label: "example.com",
  descriptor: {
    kind: "url_snapshot",
    sourceUrl: "https://example.com",
    resolvedUrl: "https://example.com",
  },
  checksum: "a".repeat(64),
  revision: 2,
  failure: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("Import Source query/application hooks", () => {
  it("loads list and detail through the feature adapter", async () => {
    const queryClient = client();
    const list = { items: [source], nextCursor: null };
    const detail = { value: source, etag: '"2"' };
    mocks.listImportSources.mockResolvedValue(list);
    mocks.getImportSource.mockResolvedValue(detail);
    const listHook = renderHook(() => useWorkbenchImportSources("project-1"), { wrapper: wrapper(queryClient) });
    const detailHook = renderHook(() => useWorkbenchImportSource("project-1", source.id), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(listHook.result.current.data).toEqual(list));
    await waitFor(() => expect(detailHook.result.current.data).toEqual(detail));
    expect(mocks.listImportSources).toHaveBeenCalledWith("project-1", {});
    expect(mocks.getImportSource).toHaveBeenCalledWith(source.id);
    listHook.unmount();
    detailHook.unmount();
    queryClient.clear();
  });

  it("creates and invalidates the project source list", async () => {
    const queryClient = client();
    const result = { value: source, etag: '"2"' };
    mocks.createImportSource.mockResolvedValue(result);
    const hook = renderHook(() => useCreateWorkbenchImportSource("project-1"), { wrapper: wrapper(queryClient) });
    await act(() => hook.result.current.mutateAsync({
      request: { kind: "url_snapshot", sourceUrl: "https://example.com" },
      idempotencyKey: "import-source:req_1",
    }));
    expect(mocks.createImportSource).toHaveBeenCalledWith(
      "project-1",
      { kind: "url_snapshot", sourceUrl: "https://example.com" },
      "import-source:req_1",
    );
    expect(queryClient.getQueryData(workbenchQueryKeys.importSource("project-1", source.id)))
      .toEqual(result);
    hook.unmount();
    queryClient.clear();
  });

  it("deletes with cached revision and refuses an unknown source", async () => {
    const queryClient = client();
    queryClient.setQueryData(workbenchQueryKeys.importSource("project-1", source.id), {
      value: source,
      etag: '"2"',
    });
    mocks.deleteImportSource.mockResolvedValue(undefined);
    const hook = renderHook(() => useDeleteWorkbenchImportSource("project-1"), { wrapper: wrapper(queryClient) });
    await act(() => hook.result.current.mutateAsync({ sourceId: source.id }));
    expect(mocks.deleteImportSource).toHaveBeenCalledWith(source.id, '"2"');
    expect(queryClient.getQueryData(workbenchQueryKeys.importSource("project-1", source.id))).toBeUndefined();
    await expect(hook.result.current.mutateAsync({ sourceId: "missing" })).rejects.toBeInstanceOf(WorkbenchVersionRequiredError);
    hook.unmount();
    queryClient.clear();
  });
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}
