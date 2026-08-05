// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ProjectPreview } from "@workbench/workbench-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { workbenchPreviewRenewalLeadMs } from "./preview-timing";
import { useWorkbenchPublicationController } from "./workbench-publication-controller";

const mocks = vi.hoisted(() => ({
  createPreview: vi.fn(),
  createToken: vi.fn(),
  getPreview: vi.fn(),
}));

vi.mock("./releases", () => ({
  useWorkbenchReleases: () => ({ data: { items: [] }, refetch: vi.fn() }),
  useCreateWorkbenchRelease: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock("./shares", () => ({
  useWorkbenchShareGrants: () => ({
    data: { items: [], activeCount: 0, nextCursor: null },
    error: null,
    isPending: false,
    isPlaceholderData: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useRotateWorkbenchShareGrant: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useRevokeWorkbenchProjectShareGrants: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock("./exports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exports")>();
  return {
    ...actual,
    useWorkbenchExportOperations: () => ({
      createProjectPreview: mocks.createPreview,
      createProjectPreviewToken: mocks.createToken,
      getProjectPreview: mocks.getPreview,
    }),
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
  };
});

beforeEach(() => {
  mocks.createPreview.mockReset();
  mocks.createToken.mockReset();
  mocks.getPreview.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Workbench publication Preview lifecycle", () => {
  it("stops after an already-succeeded first create is aborted without exposing a UI error", async () => {
    const creation = deferred<ProjectPreview>();
    let requestSignal: AbortSignal | undefined;
    mocks.createPreview.mockImplementation((
      _projectId: string,
      _request: unknown,
      _idempotencyKey?: string,
      signal?: AbortSignal,
    ) => {
      requestSignal = signal;
      return creation.promise;
    });
    const rendered = renderPreviewController();
    const controller = new AbortController();
    let operation!: Promise<unknown>;

    act(() => {
      operation = rendered.result.current.createPreview(previewRequest, controller.signal);
    });
    await waitFor(() => expect(mocks.createPreview).toHaveBeenCalledOnce());
    expect(requestSignal).toBe(controller.signal);

    controller.abort();
    await act(async () => {
      creation.resolve(projectPreview({ status: "succeeded" }));
      await operation.catch(() => undefined);
    });

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.createToken).not.toHaveBeenCalled();
    expect(rendered.result.current.previewError).toBeNull();
    expect(rendered.result.current.previewBusy).toBe(false);
  });

  it("does not expose a transport AbortError as a Preview UI error", async () => {
    mocks.createPreview.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const rendered = renderPreviewController();

    await act(async () => {
      await rendered.result.current.createPreview(previewRequest).catch(() => undefined);
    });

    expect(rendered.result.current.previewError).toBeNull();
    expect(rendered.result.current.previewBusy).toBe(false);
  });

  it("replaces a cached succeeded Preview inside the renewal lead window", async () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    vi.useFakeTimers({ now });
    const expiring = projectPreview({
      id: "preview-expiring",
      status: "succeeded",
      expiresAt: new Date(now + workbenchPreviewRenewalLeadMs).toISOString(),
    });
    const renewed = projectPreview({
      id: "preview-renewed",
      status: "succeeded",
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
    });
    mocks.createPreview
      .mockResolvedValueOnce(expiring)
      .mockResolvedValueOnce(renewed);
    mocks.getPreview.mockResolvedValueOnce(expiring);
    mocks.createToken.mockImplementation(async (previewId: string) => ({
      url: `https://preview.example.test/preview/${previewId}`,
      expiresAt: new Date(now + 60_000).toISOString(),
    }));
    const rendered = renderPreviewController();

    await act(async () => {
      await rendered.result.current.createPreview(previewRequest);
      await rendered.result.current.createPreview(previewRequest);
    });

    expect(mocks.getPreview).toHaveBeenCalledWith(expiring.id, undefined);
    expect(mocks.createPreview).toHaveBeenCalledTimes(2);
    expect(mocks.createToken).toHaveBeenNthCalledWith(1, expiring.id, undefined);
    expect(mocks.createToken).toHaveBeenNthCalledWith(2, renewed.id, undefined);
    expect(rendered.result.current.previewError).toBeNull();
  });
});

const previewRequest = {
  initialScreenId: "screen-home",
  selection: {
    kind: "artifact" as const,
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
  },
};

function renderPreviewController() {
  return renderHook(() => useWorkbenchPublicationController({
    boardController: {
      store: {
        getState: () => ({
          boardId: "board-1",
          serverRevision: 3,
          dirty: false,
          saveStatus: "clean",
        }),
      },
      save: vi.fn(),
    } as never,
    canExport: false,
    canPreview: true,
    canShare: false,
    projectId: "project-1",
  }));
}

function projectPreview(overrides: Partial<ProjectPreview> = {}): ProjectPreview {
  const timestamp = "2026-08-05T12:00:00.000Z";
  return {
    id: "preview-1",
    projectId: "project-1",
    boardId: "board-1",
    boardRevision: 3,
    selection: previewRequest.selection,
    initialScreenId: previewRequest.initialScreenId,
    status: "queued",
    revision: 0,
    failure: null,
    createdAt: timestamp,
    expiresAt: "2099-08-05T12:00:00.000Z",
    updatedAt: timestamp,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
