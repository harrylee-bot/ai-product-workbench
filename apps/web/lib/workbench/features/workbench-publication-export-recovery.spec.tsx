// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  ExportSelection,
  ExternalExportDelivery,
  ProjectPreview,
} from "@workbench/workbench-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBoardStore } from "./board";
import { useWorkbenchPublicationController } from "./workbench-publication-controller";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  createDelivery: vi.fn(),
  createPreview: vi.fn(),
  createPreviewToken: vi.fn(),
  deliveriesByExport: {} as Record<string, ExternalDeliveryFixture[]>,
  details: {} as Record<string, { value: ExportFixture; etag: string } | undefined>,
  getDelivery: vi.fn(),
  getContent: vi.fn(),
  getPreview: vi.fn(),
  jobsByProject: {} as Record<string, ExportFixture[]>,
  listDeliveries: vi.fn(),
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
  return {
  ...actual,
  useWorkbenchExportOperations: () => ({
    createExternalExportDelivery: mocks.createDelivery,
    getExternalExportDelivery: mocks.getDelivery,
    getExportContent: mocks.getContent,
    createProjectPreview: mocks.createPreview,
    createProjectPreviewToken: mocks.createPreviewToken,
    getProjectPreview: mocks.getPreview,
    listExternalExportDeliveries: mocks.listDeliveries,
  }),
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
  vi.clearAllMocks();
  mocks.details = {};
  mocks.deliveriesByExport = {};
  mocks.jobsByProject = {};
  mocks.createPreview.mockReset();
  mocks.createPreviewToken.mockReset();
  mocks.getPreview.mockReset();
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
    rendered.rerender({ currentProjectId: "project-b" });
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
});

describe("Workbench Preview cache compatibility", () => {
  const home: ExportSelection = {
    kind: "artifact",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    screenId: "screen-home",
  };
  const artifact: ExportSelection = {
    kind: "artifact",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
  };

  it.each([
    { name: "legacy opening-screen metadata", selection: artifact, initialScreenId: "screen-home" },
    { name: "current selection metadata", selection: home, initialScreenId: undefined },
  ])("reuses a successful Preview with $name", async ({ selection, initialScreenId }) => {
    const preview = projectPreview({ selection, initialScreenId });
    const originalSelection = { ...selection };
    mocks.createPreview.mockResolvedValue(preview);
    mocks.getPreview.mockResolvedValue(preview);
    mockPreviewTokens();
    const rendered = renderPreviewController();

    await act(async () => {
      await rendered.result.current.createPreview(home);
      await rendered.result.current.createPreview(home);
    });

    expect(mocks.createPreview).toHaveBeenCalledOnce();
    expect(mocks.createPreview).toHaveBeenCalledWith("project-a", {
      boardId: "board-1",
      boardRevision: 3,
      selection: artifact,
      initialScreenId: "screen-home",
    });
    expect(mocks.getPreview).toHaveBeenCalledExactlyOnceWith(preview.id);
    expect(mocks.createPreviewToken.mock.calls).toEqual([[preview.id], [preview.id]]);
    expect(preview.selection).toEqual(originalSelection);
    rendered.unmount();
  });

  it.each([
    {
      name: "a different legacy opening screen",
      selection: artifact,
      initialScreenId: "screen-success",
    },
    {
      name: "an explicit different screen despite matching legacy metadata",
      selection: { ...home, screenId: "screen-success" },
      initialScreenId: "screen-home",
    },
    {
      name: "an unscoped artifact without legacy screen metadata",
      selection: artifact,
      initialScreenId: null,
    },
    {
      name: "a different pinned artifact version",
      selection: { ...artifact, artifactVersionId: "version-2" },
      initialScreenId: "screen-home",
    },
  ])("replaces the cached Preview when it returns $name", async ({ selection, initialScreenId }) => {
    const initial = projectPreview({ selection: home });
    const replacement = projectPreview({ id: "preview-replacement", selection: home });
    mocks.createPreview.mockResolvedValueOnce(initial).mockResolvedValueOnce(replacement);
    mocks.getPreview.mockResolvedValue(projectPreview({ selection, initialScreenId }));
    mockPreviewTokens();
    const rendered = renderPreviewController();

    await act(async () => {
      await rendered.result.current.createPreview(home);
      await rendered.result.current.createPreview(home);
    });

    expect(mocks.getPreview).toHaveBeenCalledExactlyOnceWith(initial.id);
    expect(mocks.createPreview).toHaveBeenCalledTimes(2);
    expect(mocks.createPreviewToken.mock.calls).toEqual([[initial.id], [replacement.id]]);
    rendered.unmount();
  });
});

function renderPreviewController() {
  const store = createBoardStore({
    id: "board-1",
    projectId: "project-a",
    revision: 3,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  });
  return renderHook(() => useWorkbenchPublicationController({
    boardController: { store, save: vi.fn() },
    canExport: false,
    canPreview: true,
    canShare: false,
    projectId: "project-a",
  }));
}

function projectPreview(overrides: Partial<ProjectPreview>): ProjectPreview {
  return {
    id: "preview-1",
    projectId: "project-a",
    boardId: "board-1",
    boardRevision: 3,
    selection: { kind: "board" },
    status: "succeeded",
    revision: 1,
    failure: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    expiresAt: "2099-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:01.000Z",
    ...overrides,
  };
}

function mockPreviewTokens() {
  mocks.createPreviewToken.mockImplementation(async (previewId: string) => ({
    url: `https://preview.example.test/preview/${previewId}`,
    expiresAt: "2099-09-16T00:00:00.000Z",
  }));
}

function renderController(projectId: string) {
  return renderHook(
    ({ currentProjectId }: { currentProjectId: string }) => useWorkbenchPublicationController({
      boardController: { store: null, save: vi.fn() },
      canExport: true,
      canPreview: true,
      canShare: false,
      projectId: currentProjectId,
    }),
    { initialProps: { currentProjectId: projectId } },
  );
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
