// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ExternalExportDelivery } from "@workbench/workbench-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "../api/problem-details";
import { useWorkbenchPublicationController } from "./workbench-publication-controller";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  cancelDelivery: vi.fn(),
  confirmDelivery: vi.fn(),
  createDelivery: vi.fn(),
  deliveriesByExport: {} as Record<string, ExternalDeliveryFixture[]>,
  details: {} as Record<string, { value: ExportFixture; etag: string } | undefined>,
  getDelivery: vi.fn(),
  getContent: vi.fn(),
  jobsByProject: {} as Record<string, ExportFixture[]>,
  listDeliveries: vi.fn(),
  retryDelivery: vi.fn(),
}));

mocks.listDeliveries.mockImplementation(async (exportId: string) => ({
  items: mocks.deliveriesByExport[exportId] ?? [],
}));

vi.mock("./releases", () => ({
  useWorkbenchReleases: () => ({ data: { items: [] }, refetch: vi.fn() }),
  useCreateWorkbenchRelease: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock("./shares", () => ({
  useWorkbenchShareGrants: () => ({ data: { items: [], activeCount: 0, nextCursor: null } }),
  useRotateWorkbenchShareGrant: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useRevokeWorkbenchProjectShareGrants: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock("./exports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exports")>();
  const exportOperations = {
    createExternalExportDelivery: mocks.createDelivery,
    cancelExternalExportDelivery: mocks.cancelDelivery,
    confirmExternalExportDelivery: mocks.confirmDelivery,
    getExternalExportDelivery: mocks.getDelivery,
    getExportContent: mocks.getContent,
    listExternalExportDeliveries: mocks.listDeliveries,
    retryExternalExportDelivery: mocks.retryDelivery,
  };
  return {
    ...actual,
    useWorkbenchExportOperations: () => exportOperations,
    useWorkbenchExportCapabilities: () => ({
      data: {
        formats: {
          html: { available: true, authentication: "not_required", reasonCode: null },
          react: { available: true, authentication: "not_required", reasonCode: null },
          figma: { available: false, authentication: "not_required", reasonCode: "EXPORT_FIGMA_UNAVAILABLE" },
          mcp: { available: true, authentication: "not_required", reasonCode: null },
        },
        packaging: {
          single_file: { available: true, authentication: "not_required", reasonCode: null },
          zip: { available: true, authentication: "not_required", reasonCode: null },
        },
        external: {
          ai_studio: { available: false, authentication: "not_required", reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE" },
          netlify: { available: false, authentication: "required", reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" },
          lovable: { available: false, authentication: "required", reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" },
          bolt: { available: false, authentication: "required", reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" },
        },
      },
      error: null,
      refetch: vi.fn(),
    }),
    useWorkbenchExportJobs: (projectId: string) => ({
      data: projectId
        ? { items: mocks.jobsByProject[projectId] ?? [], nextCursor: null }
        : undefined,
      error: null,
      isError: false,
      isPending: false,
      isPlaceholderData: false,
    }),
    useWorkbenchExportJob: (_projectId: string, exportId: string) => ({
      data: mocks.details[exportId],
      error: null,
      refetch: vi.fn(),
    }),
    useCreateWorkbenchExportJob: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
    useCancelWorkbenchExportJob: () => ({
      mutateAsync: mocks.cancel,
      isPending: false,
      error: null,
    }),
  };
});

type ExportFixture = {
  id: string;
  releaseId: string;
  createdById: string;
  format: "html" | "react" | "figma" | "mcp";
  packaging: "single_file" | "zip";
  selection: { kind: "board" } | { kind: "board_nodes"; nodeIds: string[] };
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  revision: number;
  options: Record<string, never>;
  output: {
    mode: "blob";
    blobId: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
  } | null;
  failure: { code: string; detail: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

type ExternalDeliveryFixture = ExternalExportDelivery;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.createDelivery.mockReset();
  mocks.cancelDelivery.mockReset();
  mocks.confirmDelivery.mockReset();
  mocks.getDelivery.mockReset();
  mocks.listDeliveries.mockReset();
  mocks.listDeliveries.mockImplementation(async (exportId: string) => ({
    items: mocks.deliveriesByExport[exportId] ?? [],
  }));
  mocks.retryDelivery.mockReset();
  mocks.details = {};
  mocks.deliveriesByExport = {};
  mocks.jobsByProject = {};
});

describe("Workbench export recovery", () => {
  it("restores the active export and keeps it isolated when switching Projects", async () => {
    const runningA = exportJob({
      id: "export-a-running",
      status: "running",
      revision: 3,
      selection: { kind: "board_nodes", nodeIds: ["node-a"] },
      updatedAt: "2026-07-15T02:00:00.000Z",
    });
    const succeededB = exportJob({
      id: "export-b-succeeded",
      status: "succeeded",
      revision: 2,
      output: output("blob-b"),
      startedAt: "2026-07-15T03:00:00.000Z",
      finishedAt: "2026-07-15T03:00:01.000Z",
      updatedAt: "2026-07-15T03:00:01.000Z",
    });
    mocks.jobsByProject = {
      "project-a": [runningA],
      "project-b": [succeededB],
    };
    mocks.details[runningA.id] = { value: runningA, etag: '"3"' };
    mocks.details[succeededB.id] = { value: succeededB, etag: '"2"' };

    const rendered = renderHook(
      ({ projectId }: { projectId: string }) => useWorkbenchPublicationController({
        boardController: { store: null, save: vi.fn() },
        canExport: true,
        canPreview: true,
        canShare: false,
        projectId,
      }),
      { initialProps: { projectId: "project-a" } },
    );

    await waitFor(() => expect(rendered.result.current.activeExport?.id).toBe(runningA.id));
    expect(rendered.result.current.activeExportSelection).toEqual(runningA.selection);

    rendered.rerender({ projectId: "project-b" });
    await waitFor(() => expect(rendered.result.current.activeExport?.id).toBe(succeededB.id));
    expect(rendered.result.current.activeExport?.id).not.toBe(runningA.id);
    expect(rendered.result.current.activeExportSelection).toEqual(succeededB.selection);
    rendered.unmount();
  });

  it("cancels a restored active job with its persisted revision ETag", async () => {
    const running = exportJob({ id: "export-cancel", status: "queued", revision: 7 });
    mocks.jobsByProject = { "project-a": [running] };
    mocks.details[running.id] = { value: running, etag: '"7"' };
    const cancelled = exportJob({
      ...running,
      status: "cancelled",
      revision: 8,
      finishedAt: "2026-07-15T04:00:00.000Z",
      updatedAt: "2026-07-15T04:00:00.000Z",
    });
    mocks.cancel.mockImplementation(async ({ ifMatch }: { ifMatch: string }) => {
      expect(ifMatch).toBe('"7"');
      mocks.details[running.id] = { value: cancelled, etag: '"8"' };
      return { value: cancelled, etag: '"8"' };
    });
    const rendered = renderController("project-a");
    await waitFor(() => expect(rendered.result.current.activeExport?.id).toBe(running.id));

    await act(async () => {
      await rendered.result.current.cancelExport();
    });
    expect(mocks.cancel).toHaveBeenCalledWith({ ifMatch: '"7"' });
    rendered.unmount();
  });

  it("does not download a response that arrives after Project navigation", async () => {
    const succeeded = exportJob({
      id: "export-download",
      status: "succeeded",
      revision: 2,
      output: output("blob-download"),
      startedAt: "2026-07-15T01:00:00.000Z",
      finishedAt: "2026-07-15T01:00:01.000Z",
      updatedAt: "2026-07-15T01:00:01.000Z",
    });
    mocks.jobsByProject = { "project-a": [succeeded], "project-b": [] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    let resolveContent!: (result: { value: Blob }) => void;
    mocks.getContent.mockReturnValue(new Promise((resolve) => { resolveContent = resolve; }));
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const rendered = renderController("project-a");
    await waitFor(() => expect(rendered.result.current.activeExport?.id).toBe(succeeded.id));

    let download!: Promise<void>;
    await act(async () => {
      download = rendered.result.current.downloadExport();
    });
    rendered.rerender({ currentProjectId: "project-b", canExport: true });
    resolveContent({ value: new Blob(["late"]) });
    await act(async () => { await download; });

    expect(createObjectUrl).not.toHaveBeenCalled();
    createObjectUrl.mockRestore();
    rendered.unmount();
  });

  it("restores the latest external delivery for the active immutable Export", async () => {
    const succeeded = exportJob({
      id: "export-external",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-external"),
      startedAt: "2026-07-15T05:00:00.000Z",
      finishedAt: "2026-07-15T05:00:01.000Z",
    });
    const delivery = externalDelivery({ exportJobId: succeeded.id, target: "netlify" });
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [delivery];

    const rendered = renderController("project-a");
    await waitFor(() => expect(rendered.result.current.activeExternalDelivery?.id).toBe(delivery.id));
    expect(mocks.listDeliveries).toHaveBeenCalledWith(succeeded.id);
    rendered.unmount();
  });

  it("retries external delivery hydration after a transient list failure", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-hydration-retry",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-hydration-retry"),
      startedAt: "2026-07-15T05:10:00.000Z",
      finishedAt: "2026-07-15T05:10:01.000Z",
    });
    const delivery = externalDelivery({
      id: "delivery-hydration-retry",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
    });
    const hydrationError = new Error("delivery list temporarily unavailable");
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.listDeliveries
      .mockRejectedValueOnce(hydrationError)
      .mockResolvedValueOnce({ items: [delivery] });

    const rendered = renderController("project-a");
    await flushEffects();
    expect(mocks.listDeliveries).toHaveBeenCalledOnce();
    expect(rendered.result.current.activeExternalDelivery).toBeNull();
    expect(rendered.result.current.exportError).toBe(hydrationError);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.listDeliveries).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.activeExternalDelivery).toEqual(delivery);
    expect(rendered.result.current.exportError).toBeNull();
    rendered.unmount();
  });

  it("fences a late hydration failure after a new delivery is prepared", async () => {
    const succeeded = exportJob({
      id: "export-hydration-fence",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-hydration-fence"),
      startedAt: "2026-07-15T05:20:00.000Z",
      finishedAt: "2026-07-15T05:20:01.000Z",
    });
    const hydration = deferred<{ items: ExternalDeliveryFixture[] }>();
    const prepared = externalDelivery({
      id: "delivery-hydration-fence",
      exportJobId: succeeded.id,
    });
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.listDeliveries.mockReturnValue(hydration.promise);
    mocks.createDelivery.mockResolvedValue({ value: prepared, etag: '"0"' });

    const rendered = renderController("project-a");
    await waitFor(() => expect(mocks.listDeliveries).toHaveBeenCalledOnce());
    await act(async () => {
      await rendered.result.current.prepareExternalDelivery("Netlify");
      hydration.reject(new Error("late hydration failure"));
      await hydration.promise.catch(() => undefined);
    });

    expect(rendered.result.current.activeExternalDelivery).toEqual(prepared);
    expect(rendered.result.current.exportError).toBeNull();
    rendered.unmount();
  });

  it("fences an obsolete hydration request when the same Export hydration restarts", async () => {
    const succeeded = exportJob({
      id: "export-hydration-generation",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-hydration-generation"),
      startedAt: "2026-07-15T05:30:00.000Z",
      finishedAt: "2026-07-15T05:30:01.000Z",
    });
    const obsolete = externalDelivery({
      id: "delivery-obsolete-hydration",
      exportJobId: succeeded.id,
      status: "succeeded",
      revision: 4,
      remoteReference: "https://deploy.example/obsolete-hydration",
      finishedAt: "2026-07-15T05:30:05.000Z",
    });
    const current = externalDelivery({
      id: "delivery-current-hydration",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
    });
    const firstHydration = deferred<{ items: ExternalDeliveryFixture[] }>();
    const secondHydration = deferred<{ items: ExternalDeliveryFixture[] }>();
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.listDeliveries
      .mockReturnValueOnce(firstHydration.promise)
      .mockReturnValueOnce(secondHydration.promise);

    const rendered = renderController("project-a");
    await flushEffects();
    expect(mocks.listDeliveries).toHaveBeenCalledOnce();

    rendered.rerender({ currentProjectId: "project-a", canExport: false });
    await flushEffects();
    rendered.rerender({ currentProjectId: "project-a", canExport: true });
    await flushEffects();
    await flushEffects();
    expect(mocks.listDeliveries).toHaveBeenCalledTimes(2);

    await act(async () => {
      firstHydration.resolve({ items: [obsolete] });
      await firstHydration.promise;
    });
    expect(rendered.result.current.activeExternalDelivery).toBeNull();

    await act(async () => {
      secondHydration.resolve({ items: [current] });
      await secondHydration.promise;
    });
    expect(rendered.result.current.activeExternalDelivery).toEqual(current);
    rendered.unmount();
  });

  it("single-flights external delivery preparation", async () => {
    const succeeded = exportJob({
      id: "export-single-flight",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-single-flight"),
      startedAt: "2026-07-15T06:00:00.000Z",
      finishedAt: "2026-07-15T06:00:01.000Z",
    });
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    let resolveDelivery!: (value: { value: ExternalDeliveryFixture; etag: string }) => void;
    mocks.createDelivery.mockReturnValue(new Promise((resolve) => { resolveDelivery = resolve; }));
    const rendered = renderController("project-a");
    await waitFor(() => expect(rendered.result.current.activeExport?.id).toBe(succeeded.id));

    let first!: Promise<ExternalDeliveryFixture>;
    act(() => {
      first = rendered.result.current.prepareExternalDelivery("Netlify");
    });
    await expect(rendered.result.current.prepareExternalDelivery("Netlify"))
      .rejects.toThrow("already in progress");
    const delivery = externalDelivery({ exportJobId: succeeded.id, target: "netlify" });
    resolveDelivery({ value: delivery, etag: '"0"' });
    await act(async () => { await first; });

    expect(mocks.createDelivery).toHaveBeenCalledOnce();
    expect(rendered.result.current.activeExternalDelivery?.id).toBe(delivery.id);
    rendered.unmount();
  });

  it("recovers external delivery polling after transient failures with bounded backoff", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-poll-recovery",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-poll-recovery"),
      startedAt: "2026-07-15T07:00:00.000Z",
      finishedAt: "2026-07-15T07:00:01.000Z",
    });
    const running = externalDelivery({
      id: "delivery-poll-recovery",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
      confirmedAt: "2026-07-15T07:00:02.000Z",
      startedAt: "2026-07-15T07:00:03.000Z",
    });
    const completed = externalDelivery({
      ...running,
      status: "succeeded",
      revision: 3,
      remoteReference: "https://deploy.example/poll-recovery",
      transferAuthorizedAt: "2026-07-15T07:00:04.000Z",
      finishedAt: "2026-07-15T07:00:05.000Z",
      updatedAt: "2026-07-15T07:00:05.000Z",
    });
    const firstError = new Error("delivery API temporarily unavailable");
    const secondError = new Error("delivery API still unavailable");
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [running];
    mocks.getDelivery
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockResolvedValueOnce({ value: completed, etag: '"3"' });

    const rendered = renderController("project-a");
    await flushEffects();
    expect(rendered.result.current.activeExternalDelivery?.id).toBe(running.id);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.getDelivery).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.exportError).toBe(firstError);

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(mocks.getDelivery).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.getDelivery).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.exportError).toBe(secondError);

    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(mocks.getDelivery).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(mocks.getDelivery).toHaveBeenCalledTimes(3);
    expect(rendered.result.current.activeExternalDelivery).toEqual(completed);
    expect(rendered.result.current.exportError).toBeNull();
    rendered.unmount();
  });

  it("does not let a background poll replace a foreground Export error", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-poll-error-owner",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-poll-error-owner"),
      startedAt: "2026-07-15T07:10:00.000Z",
      finishedAt: "2026-07-15T07:10:01.000Z",
    });
    const running = externalDelivery({
      id: "delivery-poll-error-owner",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
    });
    const foregroundError = new Error("Export download failed");
    const pollError = new Error("delivery polling failed");
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [running];
    mocks.getContent.mockRejectedValue(foregroundError);
    mocks.getDelivery.mockRejectedValue(pollError);

    const rendered = renderController("project-a");
    await flushEffects();
    await act(async () => {
      await rendered.result.current.downloadExport().catch(() => undefined);
    });
    expect(rendered.result.current.exportError).toBe(foregroundError);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(rendered.result.current.exportError).toBe(foregroundError);
    rendered.unmount();
  });

  it("fences a late external mutation after polling observes a newer terminal revision", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-mutation-fence",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-mutation-fence"),
      startedAt: "2026-07-15T07:20:00.000Z",
      finishedAt: "2026-07-15T07:20:01.000Z",
    });
    const running = externalDelivery({
      id: "delivery-mutation-fence",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
      confirmedAt: "2026-07-15T07:20:02.000Z",
      startedAt: "2026-07-15T07:20:03.000Z",
    });
    const completed = externalDelivery({
      ...running,
      status: "succeeded",
      revision: 3,
      remoteReference: "https://deploy.example/mutation-fence",
      transferAuthorizedAt: "2026-07-15T07:20:04.000Z",
      finishedAt: "2026-07-15T07:20:05.000Z",
    });
    const staleCancellation = externalDelivery({
      ...running,
      status: "cancelled",
      revision: 3,
      finishedAt: "2026-07-15T07:20:05.000Z",
    });
    const cancellation = deferred<{ value: ExternalDeliveryFixture; etag: string }>();
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [running];
    mocks.getDelivery.mockResolvedValue({ value: completed, etag: '"3"' });
    mocks.cancelDelivery.mockReturnValue(cancellation.promise);

    const rendered = renderController("project-a");
    await flushEffects();
    let cancelOperation!: Promise<ExternalDeliveryFixture>;
    act(() => {
      cancelOperation = rendered.result.current.cancelExternalDelivery("Netlify");
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(rendered.result.current.activeExternalDelivery).toEqual(completed);

    await act(async () => {
      cancellation.resolve({ value: staleCancellation, etag: '"3"' });
      await cancelOperation;
    });
    expect(rendered.result.current.activeExternalDelivery).toEqual(completed);
    expect(rendered.result.current.exportError).toBeNull();
    rendered.unmount();
  });

  it("reports a 412 mutation failure after polling completes the same delivery", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-mutation-error-fence",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-mutation-error-fence"),
      startedAt: "2026-07-15T07:30:00.000Z",
      finishedAt: "2026-07-15T07:30:01.000Z",
    });
    const running = externalDelivery({
      id: "delivery-mutation-error-fence",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
      confirmedAt: "2026-07-15T07:30:02.000Z",
      startedAt: "2026-07-15T07:30:03.000Z",
    });
    const completed = externalDelivery({
      ...running,
      status: "succeeded",
      revision: 3,
      remoteReference: "https://deploy.example/mutation-error-fence",
      transferAuthorizedAt: "2026-07-15T07:30:04.000Z",
      finishedAt: "2026-07-15T07:30:05.000Z",
      updatedAt: "2026-07-15T07:30:05.000Z",
    });
    const cancellation = deferred<{ value: ExternalDeliveryFixture; etag: string }>();
    const cancellationError = new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_MISMATCH",
      detail: "External Export delivery revision does not match",
    });
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [running];
    mocks.getDelivery.mockResolvedValue({ value: completed, etag: '"3"' });
    mocks.cancelDelivery.mockReturnValue(cancellation.promise);

    const rendered = renderController("project-a");
    await flushEffects();
    let cancelOperation!: Promise<unknown>;
    act(() => {
      cancelOperation = rendered.result.current.cancelExternalDelivery("Netlify")
        .catch((error: unknown) => error);
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(rendered.result.current.activeExternalDelivery).toEqual(completed);

    await act(async () => {
      cancellation.reject(cancellationError);
      await cancelOperation;
    });
    expect(rendered.result.current.activeExternalDelivery).toEqual(completed);
    expect(rendered.result.current.exportError).toBe(cancellationError);
    rendered.unmount();
  });

  it("aborts and fences an in-flight delivery poll when the delivery identity changes", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-poll-switch",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-poll-switch"),
      startedAt: "2026-07-15T08:00:00.000Z",
      finishedAt: "2026-07-15T08:00:01.000Z",
    });
    const previous = externalDelivery({
      id: "delivery-before-switch",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
    });
    const replacement = externalDelivery({
      id: "delivery-after-switch",
      exportJobId: succeeded.id,
    });
    const stale = externalDelivery({
      ...previous,
      status: "failed",
      revision: 3,
      failure: { code: "STALE_FAILURE", detail: "late response" },
      finishedAt: "2026-07-15T08:00:05.000Z",
    });
    const pending = deferred<{ value: ExternalDeliveryFixture; etag: string }>();
    let pollSignal: AbortSignal | undefined;
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [previous];
    mocks.getDelivery.mockImplementation((_deliveryId: string, signal?: AbortSignal) => {
      pollSignal = signal;
      return pending.promise;
    });
    mocks.createDelivery.mockResolvedValue({ value: replacement, etag: '"0"' });

    const rendered = renderController("project-a");
    await flushEffects();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(pollSignal?.aborted).toBe(false);

    await act(async () => {
      await rendered.result.current.prepareExternalDelivery("Netlify");
      pending.resolve({ value: stale, etag: '"3"' });
      await pending.promise;
    });
    expect(pollSignal?.aborted).toBe(true);
    expect(rendered.result.current.activeExternalDelivery).toEqual(replacement);

    expect(rendered.result.current.activeExternalDelivery).toEqual(replacement);
    expect(rendered.result.current.exportError).toBeNull();
    rendered.unmount();
  });

  it("rejects a polling snapshot whose revision regresses", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-poll-revision",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-poll-revision"),
      startedAt: "2026-07-15T08:10:00.000Z",
      finishedAt: "2026-07-15T08:10:01.000Z",
    });
    const current = externalDelivery({
      id: "delivery-poll-revision",
      exportJobId: succeeded.id,
      status: "running",
      revision: 4,
      attempt: 2,
      confirmedAt: "2026-07-15T08:10:02.000Z",
      startedAt: "2026-07-15T08:10:03.000Z",
    });
    const stale = externalDelivery({
      ...current,
      revision: 3,
      attempt: 1,
      updatedAt: "2026-07-15T08:10:02.500Z",
    });
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [current];
    mocks.getDelivery.mockResolvedValue({ value: stale, etag: '"3"' });

    const rendered = renderController("project-a");
    await flushEffects();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(rendered.result.current.activeExternalDelivery).toEqual(current);
    expect(rendered.result.current.exportError).toMatchObject({
      message: "External Export delivery revision regressed while polling",
    });
    rendered.unmount();
  });

  it("releases polling error ownership when Export permission is revoked and restored", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-poll-permission",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-poll-permission"),
      startedAt: "2026-07-15T08:20:00.000Z",
      finishedAt: "2026-07-15T08:20:01.000Z",
    });
    const running = externalDelivery({
      id: "delivery-poll-permission",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
      confirmedAt: "2026-07-15T08:20:02.000Z",
      startedAt: "2026-07-15T08:20:03.000Z",
    });
    const pollError = new Error("delivery polling denied temporarily");
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [running];
    mocks.getDelivery
      .mockRejectedValueOnce(pollError)
      .mockResolvedValue({ value: running, etag: '"2"' });

    const rendered = renderController("project-a");
    await flushEffects();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(rendered.result.current.exportError).toBe(pollError);

    rendered.rerender({ currentProjectId: "project-a", canExport: false });
    await flushEffects();
    expect(rendered.result.current.activeExternalDelivery).toBeNull();
    expect(rendered.result.current.exportError).toBeNull();

    rendered.rerender({ currentProjectId: "project-a", canExport: true });
    await flushEffects();
    await flushEffects();
    expect(rendered.result.current.activeExternalDelivery).toEqual(running);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(rendered.result.current.exportError).toBeNull();
    rendered.unmount();
  });

  it("aborts an in-flight delivery poll on unmount without scheduling stale retries", async () => {
    vi.useFakeTimers();
    const succeeded = exportJob({
      id: "export-poll-unmount",
      format: "html",
      packaging: "zip",
      status: "succeeded",
      revision: 2,
      output: output("blob-poll-unmount"),
      startedAt: "2026-07-15T09:00:00.000Z",
      finishedAt: "2026-07-15T09:00:01.000Z",
    });
    const running = externalDelivery({
      id: "delivery-poll-unmount",
      exportJobId: succeeded.id,
      status: "running",
      revision: 2,
      attempt: 1,
    });
    const pending = deferred<{ value: ExternalDeliveryFixture; etag: string }>();
    let pollSignal: AbortSignal | undefined;
    mocks.jobsByProject = { "project-a": [succeeded] };
    mocks.details[succeeded.id] = { value: succeeded, etag: '"2"' };
    mocks.deliveriesByExport[succeeded.id] = [running];
    mocks.getDelivery.mockImplementation((_deliveryId: string, signal?: AbortSignal) => {
      pollSignal = signal;
      return pending.promise;
    });

    const rendered = renderController("project-a");
    await flushEffects();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.getDelivery).toHaveBeenCalledOnce();
    expect(pollSignal?.aborted).toBe(false);

    rendered.unmount();
    expect(pollSignal?.aborted).toBe(true);
    pending.reject(new Error("late delivery failure"));
    await flushEffects();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.getDelivery).toHaveBeenCalledOnce();
  });
});

function renderController(projectId: string, canExport = true) {
  return renderHook(
    ({
      currentProjectId,
      canExport: currentCanExport = true,
    }: {
      currentProjectId: string;
      canExport?: boolean;
    }) => useWorkbenchPublicationController({
      boardController: { store: null, save: vi.fn() },
      canExport: currentCanExport,
      canPreview: true,
      canShare: false,
      projectId: currentProjectId,
    }),
    { initialProps: { currentProjectId: projectId, canExport } },
  );
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function exportJob(overrides: Partial<ExportFixture>): ExportFixture {
  return {
    id: "export-default",
    releaseId: "release-1",
    createdById: "principal-1",
    format: "html",
    packaging: "single_file",
    selection: { kind: "board" },
    status: "queued",
    revision: 1,
    options: {},
    output: null,
    failure: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function output(blobId: string) {
  return {
    mode: "blob" as const,
    blobId,
    mediaType: "text/html",
    byteSize: 10,
    sha256: "a".repeat(64),
  };
}

function externalDelivery(overrides: Partial<ExternalDeliveryFixture> = {}): ExternalDeliveryFixture {
  const timestamp = "2026-07-15T05:00:02.000Z";
  return {
    id: "delivery-1",
    exportJobId: "export-external",
    createdById: "principal-1",
    target: "netlify",
    authentication: "authenticated",
    status: "pending_confirmation",
    revision: 0,
    attempt: 0,
    payload: {
      exportJobId: overrides.exportJobId ?? "export-external",
      releaseId: "release-1",
      format: "html",
      packaging: "zip",
      selection: { kind: "board" },
      output: {
        mediaType: "application/zip",
        byteSize: 10,
        sha256: "a".repeat(64),
        fileName: "project.zip",
      },
    },
    remoteReference: null,
    failure: null,
    createdAt: timestamp,
    confirmedAt: null,
    startedAt: null,
    transferAuthorizedAt: null,
    finishedAt: null,
    updatedAt: timestamp,
    ...overrides,
  };
}
