// @vitest-environment jsdom

import type {
  CreateSubmissionIntentRequest,
  CreateDesignSystemRequest,
  ProjectBootstrap,
  Run,
  SubmissionIntent,
} from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkbenchController } from "./workbench-controller";

const timestamp = "2026-07-13T00:00:00.000Z";
const mocks = vi.hoisted(() => ({
  createDesignSystem: vi.fn(),
  createSubmissionIntent: vi.fn(),
  createProject: vi.fn(),
  createdIntent: null as SubmissionIntent | null,
  getCurrentSubmissionIntent: vi.fn(),
  getProjectBootstrap: vi.fn(),
  importDesignSystem: vi.fn(),
  submitSubmissionIntent: vi.fn(),
  transportApi: {},
}));

vi.mock("../transport/context", () => ({
  useWorkbenchTransport: () => ({ api: mocks.transportApi, baseUrl: "" }),
}));

vi.mock("./submission-intents/api-adapter", () => ({
  useWorkbenchSubmissionIntentsApi: () => mocks,
}));

vi.mock("./board", () => ({
  createBoardAutosaveCoordinator: vi.fn(),
  useWorkbenchBoardController: () => ({
    query: { error: null, isError: false, isPending: false },
    reload: vi.fn(),
    save: vi.fn(),
    saveMutation: { isPending: false },
    state: null,
    store: null,
  }),
}));

vi.mock("./design-systems", () => ({
  useWorkbenchDesignSystemOperations: () => mocks,
  useInfiniteWorkbenchDesignSystemCatalog: () => ({
    data: {
      pages: [{
        items: [{
          projectId: "project-source",
          projectTitle: "Source",
          artifactId: "artifact-source",
          artifactTitle: "Source UI",
          artifactVersionId: "version-source",
          version: 3,
          checksum: "a".repeat(64),
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z",
        }],
        nextCursor: null,
      }],
    },
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isPending: false,
    refetch: vi.fn(),
  }),
}));

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
    useArchiveWorkbenchProject: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useDuplicateWorkbenchProject: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useInfiniteWorkbenchProjects: () => ({
      data: { pages: [{ items: [], nextCursor: null }] },
      isPending: false,
    }),
    useUpdateWorkbenchProject: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useWorkbenchProjectOperations: () => mocks,
    useWorkbenchProjectBootstrap: (projectId: string) => ({
      data: projectId ? versionedBootstrap(projectId) : undefined,
      error: null,
      isError: false,
      isPending: false,
    }),
  };
});

vi.mock("./identity", () => ({
  useWorkbenchIdentity: () => ({
    data: { defaultWorkspaceId: "workspace-1" },
    error: null,
    isError: false,
    isPending: false,
    isSuccess: true,
  }),
}));

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
      data: {
        items: [{
          id: "model-1",
          displayName: "Model One",
          description: null,
          supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
          supportsThinking: false,
          supportsReasoningEffort: false,
        }],
      },
      error: null,
      isError: false,
      isFetching: false,
      isPending: false,
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createProject.mockResolvedValue({
    value: project("project-target"),
    etag: '"1"',
  });
  mocks.getProjectBootstrap.mockImplementation(async (projectId: string) => versionedBootstrap(projectId));
  mocks.importDesignSystem.mockResolvedValue({
    targetArtifactVersionId: "version-imported",
  });
  mocks.createDesignSystem.mockResolvedValue({
    artifactVersionId: "version-created",
  });
  mocks.createdIntent = null;
  mocks.getCurrentSubmissionIntent.mockResolvedValue({ item: null });
  mocks.createSubmissionIntent.mockImplementation(async (
    threadId: string,
    request: CreateSubmissionIntentRequest,
  ) => {
    const intent = pendingIntent(threadId, request);
    mocks.createdIntent = intent;
    return { value: intent, etag: '"1"' };
  });
  mocks.submitSubmissionIntent.mockImplementation(async (intentId: string) => {
    const intent = mocks.createdIntent;
    if (!intent || intent.id !== intentId) throw new Error("missing created intent");
    const submitted = submittedIntent(intent);
    return { value: { intent: submitted, run: run(submitted) }, etag: '"2"' };
  });
});

describe("Workbench controller Design System provisioning", () => {
  it("selects the created Project only after its route gate and before bootstrap and Run work", async () => {
    const rendered = renderController();
    const routeCommitted = vi.fn(async (projectId: string) => {
      rendered.result.current.commitProjectOpen(projectId);
    });

    await act(() => rendered.result.current.startNewProject({
      prompt: "Create a routed product dashboard",
      modelChoiceKey: "model:model-1",
      targetSurface: "web",
    }, routeCommitted));

    expect(routeCommitted).toHaveBeenCalledWith("project-target");
    expect(rendered.result.current.selectedProjectId).toBe("project-target");
    expect(routeCommitted.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getProjectBootstrap.mock.invocationCallOrder[0]);
    expect(mocks.getProjectBootstrap.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createSubmissionIntent.mock.invocationCallOrder[0]);
  });

  it("keeps the Home submission owned by its created Project until the Run receipt arrives", async () => {
    const bootstrapGate = deferred<ReturnType<typeof versionedBootstrap>>();
    mocks.getProjectBootstrap.mockReturnValueOnce(bootstrapGate.promise);
    const rendered = renderController();
    const routeCommitted = vi.fn(async (projectId: string) => {
      rendered.result.current.commitProjectOpen(projectId);
    });
    let creation!: Promise<string | null>;

    await act(async () => {
      creation = rendered.result.current.startNewProject({
        prompt: "Create a routed product dashboard",
        modelChoiceKey: "model:model-1",
        targetSurface: "web",
      }, routeCommitted);
      await Promise.resolve();
    });

    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-target"));
    expect(rendered.result.current.submitting).toBe(true);
    expect(rendered.result.current.submissionError).toBeNull();
    expect(rendered.result.current.currentRun).toBeNull();

    let duplicate: string | null | undefined;
    await act(async () => {
      duplicate = await rendered.result.current.startProjectRun({
        prompt: "Do not start twice",
        modelChoiceKey: "model:model-1",
        targetSurface: "web",
      });
    });
    expect(duplicate).toBeNull();
    expect(mocks.createSubmissionIntent).not.toHaveBeenCalled();

    bootstrapGate.resolve(versionedBootstrap("project-target"));
    await act(() => creation);

    expect(rendered.result.current.submitting).toBe(false);
    expect(rendered.result.current.submissionError).toBeNull();
    expect(rendered.result.current.currentRun).toMatchObject({
      id: "run-1",
      projectId: "project-target",
    });
  });

  it("keeps a late creation failure on its target Project instead of the newly selected Project", async () => {
    const bootstrapGate = deferred<ReturnType<typeof versionedBootstrap>>();
    mocks.getProjectBootstrap.mockReturnValueOnce(bootstrapGate.promise);
    const rendered = renderController();
    let creation!: Promise<string | null>;

    await act(async () => {
      creation = rendered.result.current.startNewProject({
        prompt: "Create a delayed dashboard",
        modelChoiceKey: "model:model-1",
        targetSurface: "web",
      }, async (projectId) => {
        rendered.result.current.commitProjectOpen(projectId);
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-target"));
    expect(rendered.result.current.submitting).toBe(true);

    act(() => rendered.result.current.commitProjectOpen("project-other"));
    await waitFor(() => expect(rendered.result.current.submitting).toBe(false));
    bootstrapGate.reject(new Error("target bootstrap failed"));
    await act(() => creation);

    expect(rendered.result.current.selectedProjectId).toBe("project-other");
    expect(rendered.result.current.submissionError).toBeNull();

    act(() => rendered.result.current.commitProjectOpen("project-target"));
    expect(rendered.result.current.submissionError).toMatchObject({
      message: "target bootstrap failed",
    });
  });

  it("retains a Project submission owner across P1-to-P2-to-P1 navigation", async () => {
    const provision = deferred<{ artifactVersionId: string }>();
    mocks.createDesignSystem.mockReturnValueOnce(provision.promise);
    const rendered = renderController();
    act(() => rendered.result.current.commitProjectOpen("project-1"));
    await waitFor(() => expect(rendered.result.current.submitting).toBe(false));
    let first!: Promise<string | null>;

    act(() => {
      first = rendered.result.current.startProjectRun({
        prompt: "Create a durable dashboard",
        modelChoiceKey: "model:model-1",
        targetSurface: "web",
        designSystemProvision: {
          idempotencyKey: "design-system-create:project-1",
          kind: "create",
          request: customDesignSystemRequest(),
        },
      });
    });
    await waitFor(() => expect(mocks.createDesignSystem).toHaveBeenCalledOnce());
    expect(rendered.result.current.submitting).toBe(true);

    act(() => rendered.result.current.commitProjectOpen("project-2"));
    await waitFor(() => expect(rendered.result.current.submitting).toBe(false));
    act(() => rendered.result.current.commitProjectOpen("project-1"));
    expect(rendered.result.current.submitting).toBe(true);

    let duplicate: string | null | undefined;
    await act(async () => {
      duplicate = await rendered.result.current.startProjectRun({
        prompt: "Do not run the Project twice",
        modelChoiceKey: "model:model-1",
        targetSurface: "web",
      });
    });
    expect(duplicate).toBeNull();
    expect(mocks.createDesignSystem).toHaveBeenCalledOnce();
    expect(mocks.createSubmissionIntent).not.toHaveBeenCalled();

    provision.resolve({ artifactVersionId: "version-created" });
    await act(() => first);
    expect(rendered.result.current.submitting).toBe(false);
    expect(mocks.createSubmissionIntent).toHaveBeenCalledOnce();
  });

  it("blocks submission side effects until the current Intent query is known", async () => {
    const currentIntent = deferred<{ item: SubmissionIntent | null }>();
    mocks.getCurrentSubmissionIntent.mockReturnValueOnce(currentIntent.promise);
    const rendered = renderController();
    act(() => rendered.result.current.commitProjectOpen("project-1"));
    await waitFor(() => expect(mocks.getCurrentSubmissionIntent).toHaveBeenCalledOnce());
    expect(rendered.result.current.submitting).toBe(true);

    let result: string | null | undefined;
    await act(async () => {
      result = await rendered.result.current.startProjectRun({
        prompt: "Do not provision before recovery is known",
        modelChoiceKey: "model:model-1",
        targetSurface: "web",
        designSystemProvision: {
          idempotencyKey: "design-system-create:blocked",
          kind: "create",
          request: customDesignSystemRequest(),
        },
      });
    });

    expect(result).toBeNull();
    expect(mocks.createDesignSystem).not.toHaveBeenCalled();
    expect(mocks.createSubmissionIntent).not.toHaveBeenCalled();

    currentIntent.resolve({
      item: pendingIntent("thread-project-1", {
        request: {
          prompt: "Recover the existing submission",
          modelId: "model-1",
          workflow: "generate",
          generationIntent: null,
          targetSurface: "web",
          designStyle: { kind: "automatic" },
          artifactTargets: [],
          requestedArtifactKinds: [],
          sourceIds: [],
          canvasSnapshot: null,
        },
        attachments: [{
          kind: "upload",
          clientFingerprint: "submission-file:existing",
          fileName: "brief.pdf",
          declaredMediaType: "application/pdf",
          byteSize: 3,
          lastModified: 1_786_771_200_000,
        }],
      }),
    });
    await waitFor(() => expect(rendered.result.current.submissionRecovery).not.toBeNull());
    expect(rendered.result.current.submitting).toBe(true);
  });

  it("ignores a stale Project retry callback after another Project becomes current", () => {
    const rendered = renderController();
    act(() => rendered.result.current.commitProjectOpen("project-1"));
    const staleAdoptRun = rendered.result.current.adoptRun;

    act(() => rendered.result.current.commitProjectOpen("project-2"));
    act(() => rendered.result.current.adoptRun(runForProject("project-2", "run-p2")));
    act(() => staleAdoptRun(runForProject("project-1", "run-p1-retry")));

    expect(rendered.result.current.currentRun).toMatchObject({
      id: "run-p2",
      projectId: "project-2",
    });
  });

  it("clears a settled creation failure when the target Project adopts a recovered Run", async () => {
    const failure = new Error("target bootstrap failed");
    mocks.getProjectBootstrap.mockRejectedValueOnce(failure);
    const rendered = renderController();

    await act(() => rendered.result.current.startNewProject({
      prompt: "Create a recoverable dashboard",
      modelChoiceKey: "model:model-1",
      targetSurface: "web",
    }, async (projectId) => {
      rendered.result.current.commitProjectOpen(projectId);
    }));

    expect(rendered.result.current.selectedProjectId).toBe("project-target");
    expect(rendered.result.current.submissionError).toBe(failure);

    act(() => rendered.result.current.adoptRun(runForProject("project-target")));

    expect(rendered.result.current.submissionError).toBeNull();
    expect(rendered.result.current.currentRun).toMatchObject({
      id: "run-recovered",
      projectId: "project-target",
    });
  });

  it("imports a Workspace catalog version into the new Project before starting its Run", async () => {
    const rendered = renderController();

    await act(() => rendered.result.current.startNewProject({
      prompt: "Create a product dashboard",
      modelChoiceKey: "model:model-1",
      targetSurface: "web",
      designSystemProvision: {
        idempotencyKey: "design-system-import:test-1",
        kind: "import",
        sourceArtifactVersionId: "version-source",
      },
    }));

    expect(mocks.importDesignSystem).toHaveBeenCalledWith(
      "project-target",
      { sourceArtifactVersionId: "version-source" },
      "design-system-import:test-1",
    );
    expect(mocks.createSubmissionIntent).toHaveBeenCalledWith(
      "thread-project-target",
      expect.objectContaining({
        request: expect.objectContaining({
          designStyle: { kind: "artifact", artifactVersionId: "version-imported" },
        }),
      }),
      expect.stringMatching(/^submission:/),
    );
    expect(mocks.importDesignSystem.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createSubmissionIntent.mock.invocationCallOrder[0]);
    expect(mocks.createSubmissionIntent.mock.calls[0]?.[1].request.designStyle.artifactVersionId)
      .not.toBe("version-source");
  });

  it("creates a structured Design System before starting the Run with its new version", async () => {
    const rendered = renderController();
    const request = customDesignSystemRequest();

    await act(() => rendered.result.current.startNewProject({
      prompt: "Create a mobile checkout",
      modelChoiceKey: "model:model-1",
      targetSurface: "app",
      designSystemProvision: {
        idempotencyKey: "design-system-create:test-1",
        kind: "create",
        request,
      },
    }));

    expect(mocks.createDesignSystem).toHaveBeenCalledWith(
      "project-target",
      request,
      "design-system-create:test-1",
    );
    expect(mocks.createSubmissionIntent).toHaveBeenCalledWith(
      "thread-project-target",
      expect.objectContaining({
        request: expect.objectContaining({
          designStyle: { kind: "artifact", artifactVersionId: "version-created" },
        }),
      }),
      expect.stringMatching(/^submission:/),
    );
    expect(mocks.createDesignSystem.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createSubmissionIntent.mock.invocationCallOrder[0]);
  });

  it("does not start a Run when import or creation fails", async () => {
    mocks.importDesignSystem.mockRejectedValueOnce(new Error("import rejected"));
    const rendered = renderController();

    await act(() => rendered.result.current.startNewProject({
      prompt: "Create an analytics page",
      modelChoiceKey: "model:model-1",
      targetSurface: "web",
      designSystemProvision: {
        idempotencyKey: "design-system-import:test-failure",
        kind: "import",
        sourceArtifactVersionId: "version-source",
      },
    }));

    expect(mocks.createSubmissionIntent).not.toHaveBeenCalled();
    expect(rendered.result.current.submissionError).toMatchObject({ message: "import rejected" });

    mocks.createProject.mockResolvedValueOnce({ value: project("project-target-2"), etag: '"1"' });
    mocks.createDesignSystem.mockRejectedValueOnce(new Error("create rejected"));
    await act(() => rendered.result.current.startNewProject({
      prompt: "Create another analytics page",
      modelChoiceKey: "model:model-1",
      targetSurface: "web",
      designSystemProvision: {
        idempotencyKey: "design-system-create:test-failure",
        kind: "create",
        request: customDesignSystemRequest(),
      },
    }));
    expect(mocks.createSubmissionIntent).not.toHaveBeenCalled();
    expect(rendered.result.current.submissionError).toMatchObject({ message: "create rejected" });
  });

  it("aborts the selected data owner when the created Project route cannot commit", async () => {
    const routeError = new Error("Project route preload failed");
    const onProjectCreated = vi.fn(async () => {
      throw routeError;
    });
    const rendered = renderController();
    let result: string | null | undefined;

    await act(async () => {
      result = await rendered.result.current.startNewProject({
        prompt: "Create a dashboard whose route cannot load",
        modelChoiceKey: "model:model-1",
        targetSurface: "web",
      }, onProjectCreated);
    });

    expect(result).toBeNull();
    expect(onProjectCreated).toHaveBeenCalledWith("project-target");
    expect(rendered.result.current.selectedProjectId).toBe("");
    expect(rendered.result.current.submissionError).toBe(routeError);
    expect(mocks.getProjectBootstrap).not.toHaveBeenCalled();
    expect(mocks.importDesignSystem).not.toHaveBeenCalled();
    expect(mocks.createDesignSystem).not.toHaveBeenCalled();
    expect(mocks.createSubmissionIntent).not.toHaveBeenCalled();
    expect(mocks.submitSubmissionIntent).not.toHaveBeenCalled();
  });

  it("exposes only ready Design Systems from the current Project and submits their version directly", async () => {
    const rendered = renderController();
    await act(() => rendered.result.current.prepareProjectOpen("project-current"));
    act(() => rendered.result.current.commitProjectOpen("project-current"));
    await waitFor(() => expect(rendered.result.current.projectDesignSystemChoices).toEqual([{
      artifactId: "artifact-ready",
      artifactVersionId: "version-ready",
      label: "Ready UI",
      version: 2,
    }]));
    await waitFor(() => expect(rendered.result.current.submitting).toBe(false));

    await act(() => rendered.result.current.startProjectRun({
      prompt: "Refine the current screen",
      modelChoiceKey: "workflow:edit:model-1",
      targetSurface: "app",
      designStyle: { kind: "artifact", artifactVersionId: "version-ready" },
      artifactTargets: [
        { artifactId: "artifact-prototype", artifactVersionId: "version-prototype", screenIds: ["screen-main"] },
        { artifactId: "artifact-prd", artifactVersionId: "version-prd", screenIds: [] },
      ],
    }));

    expect(mocks.importDesignSystem).not.toHaveBeenCalled();
    expect(mocks.createDesignSystem).not.toHaveBeenCalled();
    expect(mocks.createSubmissionIntent).toHaveBeenCalledWith(
      "thread-project-current",
      expect.objectContaining({
        request: expect.objectContaining({
          designStyle: { kind: "artifact", artifactVersionId: "version-ready" },
          artifactTargets: [
            { artifactId: "artifact-prototype", artifactVersionId: "version-prototype", screenIds: ["screen-main"] },
            { artifactId: "artifact-prd", artifactVersionId: "version-prd", screenIds: [] },
          ],
        }),
      }),
      expect.stringMatching(/^submission:/),
    );
  });
});

function renderController() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWorkbenchController(), { wrapper });
}

function versionedBootstrap(projectId: string) {
  return { value: bootstrap(projectId), etag: '"1"' };
}

function bootstrap(projectId: string): ProjectBootstrap {
  return {
    project: project(projectId),
    access: { role: "owner" },
    threads: [{
      id: `thread-${projectId}`,
      projectId,
      title: "Main",
      status: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    selectedThreadId: `thread-${projectId}`,
    entries: [],
    board: {
      id: `board-${projectId}`,
      projectId,
      revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    },
    artifacts: projectId === "project-current" ? [
      artifact("artifact-ready", "Ready UI", "ready", "version-ready", 2),
      artifact("artifact-staging", "Staging UI", "staging", "version-staging", 1),
      artifact("artifact-code", "Code", "ready", "version-code", 1, "code"),
    ] : [],
    latestRun: null,
  };
}

function artifact(
  id: string,
  title: string,
  status: "ready" | "staging",
  artifactVersionId: string,
  version: number,
  kind: "design_system" | "code" = "design_system",
) {
  return {
    id,
    projectId: "project-current",
    kind,
    title,
    revision: 1,
    currentVersion: {
      artifactId: id,
      artifactVersionId,
      version,
      kind,
      schemaVersion: 1,
      status,
      checksum: "a".repeat(64),
      createdByRunId: null,
      createdAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function project(id: string) {
  return {
    id,
    workspaceId: "workspace-1",
    title: "Project",
    summary: null,
    status: "active" as const,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function run(intent: SubmissionIntent): Run {
  return {
    id: "run-1",
    requestId: "request-1",
    projectId: intent.projectId,
    threadId: intent.threadId,
    retryOfRunId: null,
    status: "queued",
    modelId: intent.request.modelId,
    workflow: intent.request.workflow,
    generationIntent: intent.request.generationIntent,
    targetSurface: intent.request.targetSurface,
    designStyle: intent.request.designStyle,
    artifactTargets: intent.request.artifactTargets,
    requestedArtifactKinds: intent.request.requestedArtifactKinds,
    sources: [],
    knowledgeReleaseId: null,
    phase: null,
    phaseLabel: null,
    progress: null,
    attempt: 0,
    lastEventSequence: 0,
    cancelRequestedAt: null,
    failure: null,
    cancellationReason: null,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
  };
}

function runForProject(projectId: string, runId = "run-recovered"): Run {
  const intent = pendingIntent(`thread-${projectId}`, {
    request: {
      prompt: "Recover the Project Run",
      modelId: "model-1",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      artifactTargets: [],
      requestedArtifactKinds: [],
      sourceIds: [],
      canvasSnapshot: null,
    },
    attachments: [],
  });
  return { ...run(intent), id: runId };
}

function pendingIntent(
  threadId: string,
  request: CreateSubmissionIntentRequest,
): SubmissionIntent {
  return {
    id: "intent-1",
    projectId: threadId.replace(/^thread-/, ""),
    threadId,
    status: "pending",
    request: {
      ...request.request,
      artifactTargets: request.request.artifactTargets ?? [],
      requestedArtifactKinds: request.request.requestedArtifactKinds ?? [],
    },
    attachments: request.attachments.map((attachment, position) => attachment.kind === "existing"
      ? { ...attachment, position, fileStatus: "ready" as const }
      : { ...attachment, position, fileAssetId: null, fileStatus: null }),
    runId: null,
    lastFailure: null,
    revision: 1,
    submittedAt: null,
    cancelledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function submittedIntent(intent: SubmissionIntent): SubmissionIntent {
  return {
    ...intent,
    status: "submitted",
    runId: "run-1",
    revision: intent.revision + 1,
    submittedAt: timestamp,
    updatedAt: timestamp,
  };
}

function customDesignSystemRequest(): CreateDesignSystemRequest {
  return {
    title: "Custom UI",
    document: {
      protocol: "workbench.design-system.v1",
      documentId: "design-custom",
      title: "Custom UI",
      tokens: [],
      assets: [],
      principles: [],
      guidelines: [],
      components: [],
    },
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
