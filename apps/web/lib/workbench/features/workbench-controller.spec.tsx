// @vitest-environment jsdom

import type { Board, CanvasSnapshot } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBoardStore, type BoardSaveSnapshot } from "./board";
import {
  resolveHomeSubmissionModel,
  resolveRunnableSubmissionModel,
  submissionIntentRunRequest,
  useWorkbenchController,
} from "./workbench-controller";

const mocks = vi.hoisted(() => ({
  archiveProject: vi.fn(),
  autosaveDispose: vi.fn(async () => undefined),
  bootstrapEntries: [] as unknown[],
  createImportSource: vi.fn(),
  createProject: vi.fn(),
  duplicateProject: vi.fn(),
  getProjectBootstrap: vi.fn(),
  releaseProjectUploads: vi.fn(),
  saveBoard: vi.fn(),
  selectedStore: null as ReturnType<typeof createBoardStore> | null,
}));

vi.mock("../transport/context", () => ({
  useWorkbenchTransport: () => ({ api: {}, baseUrl: "" }),
}));

vi.mock("./board", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./board")>();
  return {
    ...actual,
    createBoardAutosaveCoordinator: vi.fn(() => ({
      dispose: mocks.autosaveDispose,
      flush: vi.fn(async () => undefined),
      getState: vi.fn(() => ({ disposed: false, inFlight: false, paused: false, pending: false })),
      resume: vi.fn(() => true),
      setSave: vi.fn(),
    })),
    useWorkbenchBoardController: (projectId: string) => boardController(projectId),
  };
});

vi.mock("./design-presets", () => ({
  useWorkbenchDesignPresets: () => ({
    data: { items: [] },
    error: null,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("./projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./projects")>();
  return {
    ...actual,
    useArchiveWorkbenchProject: () => ({ mutateAsync: mocks.archiveProject, isPending: false }),
    useDuplicateWorkbenchProject: () => ({ mutateAsync: mocks.duplicateProject, isPending: false }),
    useInfiniteWorkbenchProjects: () => ({
      data: { pages: [{ items: [projectListItem()], nextCursor: null }] },
      isPending: false,
    }),
    useUpdateWorkbenchProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useWorkbenchProjectOperations: () => mocks,
    useWorkbenchProjectBootstrap: (projectId: string) => ({
      data: projectId ? bootstrap(projectId) : undefined,
      isPending: Boolean(projectId),
    }),
  };
});

vi.mock("./identity", () => ({
  useWorkbenchIdentity: () => ({
    data: { defaultWorkspaceId: "workspace-1" },
    isPending: false,
    isSuccess: true,
  }),
}));

vi.mock("./import-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./import-sources")>();
  return {
    ...actual,
    useWorkbenchImportSourcesOperations: () => ({
      createImportSource: mocks.createImportSource,
    }),
  };
});

vi.mock("./files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./files")>();
  return {
    ...actual,
    useWorkbenchUploadRegistry: () => ({
      cancelUpload: vi.fn(),
      completeUploadBatch: vi.fn(),
      pauseUpload: vi.fn(),
      releaseProjectUploads: mocks.releaseProjectUploads,
      resumeUpload: vi.fn(),
      retryUpload: vi.fn(),
      uploadFiles: vi.fn(async () => ({ batchId: null, fileAssetIds: [] })),
      uploads: [],
    }),
  };
});

vi.mock("./run-controller", () => ({
  useWorkbenchRunController: () => ({
    connectionState: "idle",
    error: null,
    projection: null,
    reconnect: vi.fn(),
  }),
}));

vi.mock("./runtime-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-models")>();
  return {
    ...actual,
    useWorkbenchRuntimeModels: () => ({
      data: { items: [] },
      error: null,
      isError: false,
      isFetching: false,
      isPending: false,
    }),
  };
});

beforeEach(() => {
  mocks.getProjectBootstrap.mockImplementation(async (projectId: string) => bootstrap(projectId));
});

afterEach(() => {
  mocks.selectedStore = null;
  mocks.bootstrapEntries = [];
  vi.clearAllMocks();
});

describe("Workbench Home Run boundary", () => {
  it("accepts linked PRD and Prototype work in one Home submission", () => {
    expect(() => resolveHomeSubmissionModel({
      prompt: "Create a PRD and a prototype",
      modelChoiceKey: "model:quality",
      targetSurface: "app",
      requestedArtifactKinds: ["prd", "prototype"],
    }, [{
      description: "Generate",
      key: "model:quality",
      label: "Quality",
      modelId: "quality",
      workflow: "generate",
    }])).not.toThrow();
  });

  it("rejects Edit and any Artifact targets before creating a Project", () => {
    const target = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenIds: ["screen-1"],
    };
    expect(() => resolveHomeSubmissionModel({
      prompt: "Edit the selected screen",
      modelChoiceKey: "workflow:edit:quality",
      targetSurface: "app",
      artifactTargets: [target],
    }, [{
      description: "Edit",
      key: "workflow:edit:quality",
      label: "Edit",
      modelId: "quality",
      workflow: "edit",
    }])).toThrow("Edit requires an existing Project Artifact selection");

    expect(() => resolveHomeSubmissionModel({
      prompt: "Generate a new screen",
      modelChoiceKey: "model:quality",
      targetSurface: "app",
      artifactTargets: [target],
    }, [{
      description: "Generate",
      key: "model:quality",
      label: "Quality",
      modelId: "quality",
      workflow: "generate",
    }])).toThrow("Artifact targets require an existing Project selection");
  });

  it("creates the Project before enqueueing its external Import Source", async () => {
    const importedSource = {
      id: "source-1",
      projectId: "project-import",
      createdById: "user-1",
      kind: "url_snapshot" as const,
      status: "pending" as const,
      label: "example.com",
      descriptor: null,
      checksum: null,
      revision: 0,
      failure: null,
      deletedAt: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    };
    mocks.createProject.mockResolvedValue({ value: { id: "project-import" }, etag: '"0"' });
    mocks.createImportSource.mockResolvedValue({ value: importedSource, etag: '"0"' });
    const rendered = renderController();

    let result: Awaited<ReturnType<typeof rendered.result.current.createProjectForImport>> | undefined;
    await act(async () => {
      result = await rendered.result.current.createProjectForImport({
        kind: "url_snapshot",
        sourceUrl: "https://example.com/docs",
      });
    });

    expect(mocks.createProject).toHaveBeenCalledWith("workspace-1", { title: "example.com" });
    expect(mocks.createImportSource).toHaveBeenCalledWith(
      "project-import",
      { kind: "url_snapshot", sourceUrl: "https://example.com/docs" },
      expect.stringMatching(/^import-source:/u),
    );
    expect(mocks.createProject.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createImportSource.mock.invocationCallOrder[0]);
    expect(result).toEqual({ projectId: "project-import", source: importedSource });
    rendered.unmount();
  });
});

describe("Workbench Project targeted Generate boundary", () => {
  const model = {
    description: "Generate",
    key: "model:quality",
    label: "Quality",
    modelId: "quality",
    workflow: "generate" as const,
  };
  const target = {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    screenIds: ["screen-1"],
  };

  it("accepts only explicit Prototype screen targets", () => {
    expect(resolveRunnableSubmissionModel({
      prompt: "Generate an interactive prototype",
      modelChoiceKey: model.key,
      targetSurface: "app",
      generationIntent: "interactive-prototype",
      artifactTargets: [target],
      requestedArtifactKinds: ["prototype"],
    }, [model])).toEqual(model);

    expect(() => resolveRunnableSubmissionModel({
      prompt: "Generate a document",
      modelChoiceKey: model.key,
      targetSurface: "app",
      generationIntent: "interactive-prototype",
      artifactTargets: [target],
      requestedArtifactKinds: ["prd"],
    }, [model])).toThrow("Targeted Generate requires a Prototype Artifact request");

    expect(() => resolveRunnableSubmissionModel({
      prompt: "Generate an interactive prototype",
      modelChoiceKey: model.key,
      targetSurface: "app",
      generationIntent: "interactive-prototype",
      artifactTargets: [{ ...target, screenIds: [] }],
      requestedArtifactKinds: ["prototype"],
    }, [model])).toThrow("Targeted Generate requires explicit screen targets");

    expect(() => resolveRunnableSubmissionModel({
      prompt: "Generate an interactive prototype",
      modelChoiceKey: model.key,
      targetSurface: "app",
      artifactTargets: [target],
      requestedArtifactKinds: ["prototype"],
    }, [model])).toThrow("Targeted Generate requires an explicit generation intent");
  });

  it("keeps an ordinary Generate targetless", () => {
    expect(resolveRunnableSubmissionModel({
      prompt: "Generate a new dashboard",
      modelChoiceKey: model.key,
      targetSurface: "app",
      artifactTargets: [],
      requestedArtifactKinds: ["prototype"],
    }, [model])).toEqual(model);
  });
});

describe("Workbench Run Canvas context boundary", () => {
  const generateModel = {
    description: "Generate",
    key: "model:quality",
    label: "Quality",
    modelId: "quality",
    workflow: "generate" as const,
  };
  const editModel = {
    description: "Edit",
    key: "workflow:edit:quality",
    label: "Edit",
    modelId: "quality",
    workflow: "edit" as const,
  };
  const snapshot = {} as CanvasSnapshot;

  it("does not capture or persist a Canvas snapshot for PRD-only Runs", () => {
    const captureCanvasSnapshot = vi.fn(() => snapshot);
    const request = submissionIntentRunRequest({
      captureCanvasSnapshot,
      modelChoiceKey: generateModel.key,
      prompt: "Generate a product requirements document",
      requestedArtifactKinds: ["prd"],
      targetSurface: "app",
    }, generateModel, { kind: "automatic" });

    expect(captureCanvasSnapshot).not.toHaveBeenCalled();
    expect(request.canvasSnapshot).toBeNull();
  });

  it("keeps Canvas context for Prototype and Edit Runs", () => {
    const prototypeCapture = vi.fn(() => snapshot);
    const prototypeRequest = submissionIntentRunRequest({
      captureCanvasSnapshot: prototypeCapture,
      modelChoiceKey: generateModel.key,
      prompt: "Generate an interactive prototype",
      requestedArtifactKinds: ["prototype"],
      targetSurface: "app",
    }, generateModel, { kind: "automatic" });
    const editCapture = vi.fn(() => snapshot);
    const editRequest = submissionIntentRunRequest({
      captureCanvasSnapshot: editCapture,
      modelChoiceKey: editModel.key,
      prompt: "Change the selected screen",
      requestedArtifactKinds: ["prototype"],
      targetSurface: "app",
      artifactTargets: [{
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenIds: ["screen-1"],
      }],
    }, editModel, { kind: "automatic" });

    expect(prototypeCapture).toHaveBeenCalledOnce();
    expect(prototypeRequest.canvasSnapshot).toBe(snapshot);
    expect(editCapture).toHaveBeenCalledOnce();
    expect(editRequest.canvasSnapshot).toBe(snapshot);
  });
});

describe("Workbench controller Project save barriers", () => {
  it("preloads a Project before synchronously committing its data owner", async () => {
    const preparedBootstrap = deferred<ReturnType<typeof bootstrap>>();
    mocks.getProjectBootstrap.mockReturnValueOnce(preparedBootstrap.promise);
    const rendered = renderController();
    let preparation!: Promise<void>;

    act(() => {
      preparation = rendered.result.current.prepareProjectOpen("project-1");
    });
    await waitFor(() => expect(mocks.getProjectBootstrap).toHaveBeenCalledWith("project-1"));
    expect(rendered.result.current.selectedProjectId).toBe("");

    preparedBootstrap.resolve(bootstrap("project-1"));
    await act(() => preparation);
    expect(rendered.result.current.selectedProjectId).toBe("");

    act(() => rendered.result.current.commitProjectOpen("project-1"));
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    rendered.unmount();
  });

  it("commits a debounced edit before finalizing the return home", async () => {
    const store = createBoardStore(board());
    mocks.selectedStore = store;
    mocks.saveBoard.mockImplementation(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    const rendered = renderController();
    await openControllerProject(rendered, "project-1");

    act(() => store.getState().setViewport({ x: 40, y: 25, zoom: 0.8 }));
    await act(() => rendered.result.current.prepareProjectClose());

    expect(mocks.saveBoard).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean", serverRevision: 2 });
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    expect(mocks.releaseProjectUploads).not.toHaveBeenCalled();

    act(() => rendered.result.current.finalizeProjectClose("project-1"));
    expect(rendered.result.current.selectedProjectId).toBe("");
    expect(mocks.releaseProjectUploads).toHaveBeenCalledOnce();
    expect(mocks.releaseProjectUploads).toHaveBeenCalledWith("project-1");
    rendered.unmount();
  });

  it("waits for an in-flight save and commits its trailing edit before returning home", async () => {
    const store = createBoardStore(board());
    const first = deferred<ReturnType<typeof saved>>();
    const snapshots: BoardSaveSnapshot[] = [];
    mocks.selectedStore = store;
    mocks.saveBoard.mockImplementation((snapshot: BoardSaveSnapshot) => {
      snapshots.push(snapshot);
      return snapshots.length === 1 ? first.promise : Promise.resolve(saved(snapshot));
    });
    const rendered = renderController();
    await openControllerProject(rendered, "project-1");

    act(() => store.getState().setViewport({ x: 20, y: 10, zoom: 0.9 }));
    const firstSave = boardController("project-1").save();
    act(() => store.getState().setViewport({ x: 55, y: 35, zoom: 0.7 }));
    const closing = rendered.result.current.prepareProjectClose();
    expect(rendered.result.current.selectedProjectId).toBe("project-1");

    first.resolve(saved(snapshots[0]));
    await act(async () => {
      await Promise.all([firstSave, closing]);
    });

    expect(mocks.saveBoard).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      serverRevision: 3,
      viewport: { x: 55, y: 35, zoom: 0.7 },
    });
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    act(() => rendered.result.current.finalizeProjectClose("project-1"));
    expect(rendered.result.current.selectedProjectId).toBe("");
    rendered.unmount();
  });

  it("ignores a stale Project exit completion after the route is recommitted", async () => {
    const rendered = renderController();
    await openControllerProject(rendered, "project-1");
    await act(() => rendered.result.current.prepareProjectClose());

    act(() => rendered.result.current.commitProjectOpen("project-1"));
    act(() => rendered.result.current.finalizeProjectClose("project-1"));

    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    expect(mocks.releaseProjectUploads).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("flushes the selected Project before duplicating its server snapshot", async () => {
    const store = createBoardStore(board());
    mocks.selectedStore = store;
    mocks.saveBoard.mockImplementation(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    mocks.duplicateProject.mockResolvedValue({
      value: { project: { id: "project-copy", workspaceId: "workspace-1" } },
    });
    const rendered = renderController();
    await openControllerProject(rendered, "project-1");

    act(() => store.getState().setViewport({ x: 75, y: 45, zoom: 0.6 }));
    await act(() => rendered.result.current.duplicateProject());

    expect(mocks.saveBoard).toHaveBeenCalledOnce();
    expect(mocks.duplicateProject).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mocks.saveBoard.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.duplicateProject.mock.invocationCallOrder[0]);
    rendered.unmount();
  });

  it("flushes the selected Project before archiving it", async () => {
    const store = createBoardStore(board());
    mocks.selectedStore = store;
    mocks.saveBoard.mockImplementation(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    mocks.archiveProject.mockResolvedValue({
      value: { id: "project-1", workspaceId: "workspace-1", status: "archived" },
    });
    const rendered = renderController();
    await openControllerProject(rendered, "project-1");

    act(() => store.getState().setViewport({ x: 90, y: 60, zoom: 0.55 }));
    await act(() => rendered.result.current.archiveProject());

    expect(mocks.saveBoard).toHaveBeenCalledOnce();
    expect(mocks.archiveProject).toHaveBeenCalledWith({ projectId: "project-1", ifMatch: undefined });
    expect(mocks.saveBoard.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.archiveProject.mock.invocationCallOrder[0]);
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    rendered.unmount();
  });

  it("blocks navigation and destructive commands when the Board cannot be saved", async () => {
    const store = createBoardStore(board());
    mocks.selectedStore = store;
    mocks.saveBoard.mockRejectedValue(new Error("network unavailable"));
    const rendered = renderController();
    await openControllerProject(rendered, "project-1");
    act(() => store.getState().setViewport({ x: 33, y: 22, zoom: 0.75 }));

    let closeError: unknown;
    await act(async () => {
      try {
        await rendered.result.current.prepareProjectClose();
      } catch (error) {
        closeError = error;
      }
    });
    expect(closeError).toBeInstanceOf(Error);
    expect(rendered.result.current.selectedProjectId).toBe("project-1");

    await expect(rendered.result.current.archiveProject()).rejects.toThrow("network unavailable");
    expect(mocks.archiveProject).not.toHaveBeenCalled();

    mocks.saveBoard.mockImplementation(async (snapshot: BoardSaveSnapshot) => saved(snapshot));
    await act(() => rendered.result.current.retryBoardSave());
    expect(store.getState()).toMatchObject({ dirty: false, saveStatus: "clean" });
    await act(() => rendered.result.current.prepareProjectClose());
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    act(() => rendered.result.current.finalizeProjectClose("project-1"));
    expect(rendered.result.current.selectedProjectId).toBe("");
    rendered.unmount();
  });

  it("hydrates the latest persisted user prompt from a deep-linked Project Bootstrap", async () => {
    mocks.selectedStore = createBoardStore(board());
    mocks.bootstrapEntries = [
      threadEntry(1, "Earlier prompt"),
      threadEntry(2, "Persisted prompt from Bootstrap"),
    ];
    const rendered = renderController();

    await openControllerProject(rendered, "project-1");

    expect(rendered.result.current.latestPrompt).toBe("Persisted prompt from Bootstrap");
    rendered.unmount();
  });
});

function renderController() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWorkbenchController(), { wrapper });
}

async function openControllerProject(
  rendered: ReturnType<typeof renderController>,
  projectId: string,
) {
  await act(() => rendered.result.current.prepareProjectOpen(projectId));
  act(() => rendered.result.current.commitProjectOpen(projectId));
}

function boardController(projectId: string) {
  const store = projectId ? mocks.selectedStore : null;
  const save = async () => {
    if (!store) return null;
    const snapshot = store.getState().prepareSave();
    if (!snapshot) return null;
    try {
      const result = await mocks.saveBoard(snapshot);
      store.getState().completeSave(snapshot, result.value, result.etag);
      return result;
    } catch (error) {
      store.getState().failSave(snapshot, error);
      throw error;
    }
  };
  return {
    query: { isPending: false },
    reload: vi.fn(),
    save,
    saveMutation: { isPending: false },
    state: store?.getState() ?? null,
    store,
  };
}

function board(): Board {
  return {
    id: "board-1",
    projectId: "project-1",
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  };
}

function bootstrap(projectId: string) {
  return {
    value: {
      access: { role: "owner" },
      artifacts: [],
      board: board(),
      entries: mocks.bootstrapEntries,
      latestRun: null,
      project: { ...projectListItem(), id: projectId },
      selectedThreadId: null,
    },
    etag: '"1"',
  };
}

function projectListItem() {
  return {
    id: "project-1",
    workspaceId: "workspace-1",
    title: "Project",
    summary: null,
    status: "active" as const,
    revision: 1,
    role: "owner" as const,
    relationship: "owned" as const,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function saved(snapshot: BoardSaveSnapshot) {
  return {
    value: {
      id: snapshot.boardId,
      projectId: snapshot.projectId,
      revision: snapshot.baseRevision + 1,
      ...snapshot.request,
    },
    etag: `"${snapshot.baseRevision + 1}"`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function threadEntry(sequence: number, text: string) {
  return {
    id: `entry-${sequence}`,
    threadId: "thread-1",
    sequence,
    role: "user" as const,
    kind: "message" as const,
    content: {
      protocol: "workbench.entry.v1" as const,
      type: "user.prompt" as const,
      text,
      sourceIds: [],
    },
    producedByRunId: null,
    createdAt: `2026-07-13T00:00:0${sequence}.000Z`,
  };
}
