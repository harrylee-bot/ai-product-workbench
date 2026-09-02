// @vitest-environment jsdom

import type {
  CreateSubmissionIntentRequest,
  Run,
  SubmissionIntent,
} from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  createWorkbenchSubmissionPlan,
  matchSubmissionIntentFiles,
  resetWorkbenchSubmissionCoordinatorRegistryForTests,
  useWorkbenchSubmissionCoordinator,
  type WorkbenchSubmissionUploadPort,
} from "./coordinator";

const timestamp = "2026-07-15T00:00:00.000Z";
const mocks = vi.hoisted(() => ({
  cancelSubmissionIntent: vi.fn(),
  createSubmissionIntent: vi.fn(),
  getCurrentSubmissionIntent: vi.fn(),
  getSubmissionIntent: vi.fn(),
  submitSubmissionIntent: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchSubmissionIntentsApi: () => mocks,
}));

beforeEach(() => {
  resetWorkbenchSubmissionCoordinatorRegistryForTests();
  vi.clearAllMocks();
  mocks.cancelSubmissionIntent.mockResolvedValue(undefined);
});

describe("SubmissionIntent coordinator domain planning", () => {
  it("deduplicates source ids and assigns opaque ordered upload slots", () => {
    const files = [testFile("brief.pdf"), testFile("wireframe.png", "image/png")];
    const fingerprints = ["submission-file:one", "submission-file:two"];
    const plan = createWorkbenchSubmissionPlan({
      files,
      request: { ...runRequest(), sourceIds: ["source-existing", "source-existing"] },
    }, () => fingerprints.shift()!);

    expect(plan.request.request.sourceIds).toEqual(["source-existing"]);
    expect(plan.request.attachments).toEqual([
      expect.objectContaining({
        kind: "upload",
        clientFingerprint: "submission-file:one",
        fileName: "brief.pdf",
      }),
      expect.objectContaining({
        kind: "upload",
        clientFingerprint: "submission-file:two",
        fileName: "wireframe.png",
      }),
    ]);
    expect(plan.uploads.map(({ clientFingerprint, position }) => ({
      clientFingerprint,
      position,
    }))).toEqual([
      { clientFingerprint: "submission-file:one", position: 0 },
      { clientFingerprint: "submission-file:two", position: 1 },
    ]);
  });

  it("surfaces an actionable message for a source-free generic PRD request", () => {
    expect(() => createWorkbenchSubmissionPlan({
      request: {
        ...runRequest(),
        prompt: "帮我写个需求文档",
        requestedArtifactKinds: ["prd"],
      },
    })).toThrow("请先说明要建设或修改的业务功能、目标用户和核心变化");
  });

  it("matches reselected files by immutable metadata and consumes duplicate slots once", () => {
    const first = testFile("brief.pdf");
    const second = testFile("brief.pdf");
    const slots = [
      uploadSlot(0, "submission-file:one", null, null),
      uploadSlot(1, "submission-file:two", "file-2", "uploading"),
    ];

    expect(matchSubmissionIntentFiles(slots, [second, first]).map((match) => (
      match.slot.clientFingerprint
    ))).toEqual(["submission-file:one", "submission-file:two"]);
    expect(() => matchSubmissionIntentFiles(slots, [first]))
      .toThrow("请选择全部 2 个原附件");
    expect(() => matchSubmissionIntentFiles(slots, [
      first,
      testFile("different.pdf"),
    ])).toThrow("所选文件与原附件 brief.pdf 不一致");
  });
});

describe("SubmissionIntent coordinator application flow", () => {
  it("creates, binds, uploads and submits one durable command", async () => {
    const queryClient = client();
    const onRun = vi.fn();
    const uploads = uploadPort();
    let created: SubmissionIntent | null = null;
    mocks.createSubmissionIntent.mockImplementation(async (
      threadId: string,
      request: CreateSubmissionIntentRequest,
    ) => {
      created = pendingIntent(threadId, request);
      return { value: created, etag: '"1"' };
    });
    mocks.submitSubmissionIntent.mockImplementation(async () => {
      if (!created) throw new Error("intent was not created");
      const intent = submittedIntent(readyIntent(created));
      return { value: { intent, run: run(intent) }, etag: '"2"' };
    });
    const rendered = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: null,
      onRun,
      projectId: "project-1",
      uploads,
    }), { wrapper: wrapper(queryClient) });
    const file = testFile("brief.pdf");

    const result = await act(() => rendered.result.current.submitPrepared({
      projectId: "project-1",
      threadId: "thread-1",
      submission: { files: [file], request: runRequest() },
    }));

    expect(result?.id).toBe("run-1");
    expect(mocks.createSubmissionIntent).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        attachments: [expect.objectContaining({
          kind: "upload",
          clientFingerprint: expect.stringMatching(/^submission-file:/),
        })],
      }),
      expect.stringMatching(/^submission:/),
    );
    const createdIntent = created as SubmissionIntent | null;
    if (!createdIntent) throw new Error("intent was not created");
    expect(uploads.uploadFiles).toHaveBeenCalledWith("project-1", [{
      file,
      submissionIntent: {
        submissionIntentId: createdIntent.id,
        attachmentPosition: 0,
        clientFingerprint: createdIntent.attachments[0].kind === "upload"
          ? createdIntent.attachments[0].clientFingerprint
          : "",
      },
    }]);
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledWith("intent-1");
    expect(uploads.completeUploadBatch).toHaveBeenCalledWith("batch-1");
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1" }));
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: null });
    expect(queryClient.getQueryData(workbenchQueryKeys.run("run-1")))
      .toMatchObject({ id: "run-1" });

    rendered.unmount();
    queryClient.clear();
  });

  it("automatically replays a refresh-restored ready Intent exactly once", async () => {
    const queryClient = client();
    const onRun = vi.fn();
    const uploads = uploadPort();
    const ready = readyIntent(pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [{
        kind: "upload",
        clientFingerprint: "submission-file:one",
        fileName: "brief.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 3,
        lastModified: 1_786_771_200_000,
      }],
    }));
    const submitted = submittedIntent(ready);
    mocks.submitSubmissionIntent.mockResolvedValue({
      value: { intent: submitted, run: run(submitted) },
      etag: '"2"',
    });

    const rendered = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: ready,
      onRun,
      projectId: "project-1",
      uploads,
    }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce());
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledWith("intent-1");
    expect(onRun).toHaveBeenCalledOnce();
    expect(rendered.result.current.recovery).toMatchObject({ kind: "processing" });

    rendered.rerender();
    await act(async () => Promise.resolve());
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();
    rendered.unmount();
    queryClient.clear();
  });

  it("shares and does not replay a manual submit across a stale coordinator remount", async () => {
    const queryClient = client();
    const remountedQueryClient = client();
    const uploads = uploadPort();
    const created = pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [],
    });
    const receipt = deferred<{
      value: { intent: SubmissionIntent; run: Run };
      etag: string;
    }>();
    mocks.createSubmissionIntent.mockResolvedValue({ value: created, etag: '"1"' });
    mocks.submitSubmissionIntent.mockReturnValue(receipt.promise);
    const rendered = renderHook(({ currentIntent }: {
      currentIntent: SubmissionIntent | null;
    }) => useWorkbenchSubmissionCoordinator({
      currentIntent,
      onRun: vi.fn(),
      projectId: "project-1",
      uploads,
    }), {
      initialProps: { currentIntent: null },
      wrapper: wrapper(queryClient),
    });

    let submission!: Promise<Run | null>;
    act(() => {
      submission = rendered.result.current.submitPrepared({
        projectId: "project-1",
        threadId: "thread-1",
        submission: { request: runRequest() },
      });
    });
    await waitFor(() => expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce());
    rendered.unmount();

    const remounted = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: created,
      onRun: vi.fn(),
      projectId: "project-1",
      uploads,
    }), { wrapper: wrapper(remountedQueryClient) });
    await act(async () => Promise.resolve());
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();

    const submitted = submittedIntent(created);
    receipt.resolve({ value: { intent: submitted, run: run(submitted) }, etag: '"2"' });
    await act(() => submission);
    remounted.rerender();
    await act(async () => Promise.resolve());

    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();
    remounted.unmount();
    queryClient.clear();
    remountedQueryClient.clear();
  });

  it("replays a settled receipt without resubmitting after a stale QueryClient remount", async () => {
    const queryClient = client();
    const remountedQueryClient = client();
    const created = pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [],
    });
    const submitted = submittedIntent(created);
    const receipt = { value: { intent: submitted, run: run(submitted) }, etag: '"2"' };
    mocks.createSubmissionIntent.mockResolvedValue({ value: created, etag: '"1"' });
    mocks.submitSubmissionIntent.mockResolvedValue(receipt);
    const rendered = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: null,
      onRun: vi.fn(),
      projectId: "project-1",
      uploads: uploadPort(),
    }), { wrapper: wrapper(queryClient) });

    await act(() => rendered.result.current.submitPrepared({
      projectId: "project-1",
      threadId: "thread-1",
      submission: { request: runRequest() },
    }));
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();
    rendered.unmount();

    const onRecoveredRun = vi.fn();
    const remounted = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: created,
      onRun: onRecoveredRun,
      projectId: "project-1",
      uploads: uploadPort(),
    }), { wrapper: wrapper(remountedQueryClient) });

    await waitFor(() => expect(onRecoveredRun).toHaveBeenCalledWith(receipt.value.run));
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();
    remounted.unmount();
    queryClient.clear();
    remountedQueryClient.clear();
  });

  it("does not automatically resubmit after an ambiguous submit response", async () => {
    const queryClient = client();
    const remountedQueryClient = client();
    const created = pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [],
    });
    const submitted = submittedIntent(created);
    const receipt = { value: { intent: submitted, run: run(submitted) }, etag: '"2"' };
    mocks.createSubmissionIntent.mockResolvedValue({ value: created, etag: '"1"' });
    mocks.submitSubmissionIntent
      .mockRejectedValueOnce(new Error("submit response could not be verified"))
      .mockResolvedValueOnce(receipt);
    const rendered = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: null,
      onRun: vi.fn(),
      projectId: "project-1",
      uploads: uploadPort(),
    }), { wrapper: wrapper(queryClient) });

    await expect(act(() => rendered.result.current.submitPrepared({
      projectId: "project-1",
      threadId: "thread-1",
      submission: { request: runRequest() },
    }))).rejects.toThrow("submit response could not be verified");
    rendered.unmount();

    const onRecoveredRun = vi.fn();
    const remounted = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: created,
      onRun: onRecoveredRun,
      projectId: "project-1",
      uploads: uploadPort(),
    }), { wrapper: wrapper(remountedQueryClient) });
    await act(async () => Promise.resolve());
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();

    await act(() => remounted.result.current.retryRecovery());
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledTimes(2);
    expect(onRecoveredRun).toHaveBeenCalledWith(receipt.value.run);
    remounted.unmount();
    queryClient.clear();
    remountedQueryClient.clear();
  });

  it("shares one in-flight submit between a manual retry and automatic recovery", async () => {
    const queryClient = client();
    const intent = readyIntent(pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [],
    }));
    const receipt = deferred<{
      value: { intent: SubmissionIntent; run: Run };
      etag: string;
    }>();
    mocks.submitSubmissionIntent.mockReturnValue(receipt.promise);
    const rendered = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: intent,
      onRun: vi.fn(),
      projectId: "project-1",
      uploads: uploadPort(),
    }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce());
    const retry = rendered.result.current.retryRecovery();
    await act(async () => Promise.resolve());
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();

    const submitted = submittedIntent(intent);
    receipt.resolve({ value: { intent: submitted, run: run(submitted) }, etag: '"2"' });
    await act(() => retry);
    expect(mocks.submitSubmissionIntent).toHaveBeenCalledOnce();
    rendered.unmount();
    queryClient.clear();
  });

  it("cancels the whole Intent while a restored upload is active", async () => {
    const queryClient = client();
    const onRun = vi.fn();
    const transfer = deferred<{ batchId: string | null; fileAssetIds: string[] }>();
    const uploads = uploadPort();
    uploads.uploadFiles.mockImplementation(() => transfer.promise);
    uploads.releaseProjectUploads.mockImplementation(() => {
      transfer.reject(new Error("upload batch released"));
    });
    const pending = pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [{
        kind: "upload",
        clientFingerprint: "submission-file:one",
        fileName: "brief.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 3,
        lastModified: 1_786_771_200_000,
      }],
    });
    mocks.cancelSubmissionIntent.mockResolvedValue(undefined);
    const rendered = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: pending,
      onRun,
      projectId: "project-1",
      uploads,
    }), { wrapper: wrapper(queryClient) });

    let recovery!: Promise<Run | null>;
    act(() => {
      recovery = rendered.result.current.selectRecoveryFiles([testFile("brief.pdf")]);
    });
    await waitFor(() => expect(rendered.result.current.actionPending).toBe(true));
    await act(() => rendered.result.current.cancelRecovery());
    await expect(recovery).resolves.toBeNull();

    expect(mocks.cancelSubmissionIntent).toHaveBeenCalledWith("intent-1", '"1"');
    expect(uploads.releaseProjectUploads).toHaveBeenCalledWith("project-1");
    expect(mocks.submitSubmissionIntent).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(workbenchQueryKeys.currentSubmissionIntent("thread-1")))
      .toEqual({ item: null });
    rendered.unmount();
    queryClient.clear();
  });

  it("blocks a second submission while the Project has a durable current Intent", async () => {
    const queryClient = client();
    const current = pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [],
    });
    const rendered = renderHook(() => useWorkbenchSubmissionCoordinator({
      currentIntent: current,
      onRun: vi.fn(),
      projectId: "project-1",
      uploads: uploadPort(),
    }), { wrapper: wrapper(queryClient) });

    await expect(rendered.result.current.submitPrepared({
      projectId: "project-1",
      threadId: "thread-1",
      submission: { request: runRequest() },
    })).rejects.toThrow("Resolve the current SubmissionIntent");

    expect(mocks.createSubmissionIntent).not.toHaveBeenCalled();
    rendered.unmount();
    queryClient.clear();
  });

  it("does not expose a failed Intent action after another Intent becomes current", async () => {
    const queryClient = client();
    const first = pendingIntent("thread-1", {
      request: runRequest(),
      attachments: [{
        kind: "upload",
        clientFingerprint: "submission-file:first",
        fileName: "brief.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 3,
        lastModified: 1_786_771_200_000,
      }],
    });
    const failure = new Error("first Intent submit failed");
    mocks.submitSubmissionIntent.mockRejectedValueOnce(failure);
    const rendered = renderHook(({ currentIntent }: {
      currentIntent: SubmissionIntent;
    }) => useWorkbenchSubmissionCoordinator({
      currentIntent,
      onRun: vi.fn(),
      projectId: "project-1",
      uploads: uploadPort(),
    }), {
      initialProps: { currentIntent: first },
      wrapper: wrapper(queryClient),
    });

    let retry!: Promise<Run | null>;
    let retryOutcome!: Promise<unknown>;
    act(() => {
      retry = rendered.result.current.retryRecovery();
      retryOutcome = retry.then(() => null, (error) => error);
    });
    await waitFor(() => expect(rendered.result.current.actionPending).toBe(true));
    await act(async () => {
      await expect(retryOutcome).resolves.toBe(failure);
    });
    await waitFor(() => expect(rendered.result.current.actionError).toBe(failure));

    rendered.rerender({ currentIntent: { ...first, id: "intent-next", revision: 2 } });

    expect(rendered.result.current.actionError).toBeNull();
    expect(rendered.result.current.recovery?.error).toBeNull();
    rendered.unmount();
    queryClient.clear();
  });

  it("isolates concurrent Project actions and delivers receipts through the latest Project guard", async () => {
    const queryClient = client();
    const firstRunGuard = vi.fn();
    const latestRunGuard = vi.fn();
    const uploads = uploadPort();
    const creates = new Map([
      ["thread-1", deferred<{ value: SubmissionIntent; etag: string }>()],
      ["thread-2", deferred<{ value: SubmissionIntent; etag: string }>()],
    ]);
    mocks.createSubmissionIntent.mockImplementation((
      threadId: string,
      request: CreateSubmissionIntentRequest,
    ) => {
      const projectId = threadId === "thread-1" ? "project-1" : "project-2";
      const intent = pendingIntent(threadId, request, projectId);
      const creation = creates.get(threadId);
      if (!creation) throw new Error(`unexpected thread ${threadId}`);
      creation.intent = intent;
      return creation.promise;
    });
    mocks.submitSubmissionIntent.mockImplementation(async (intentId: string) => {
      const intent = [...creates.values()].find((creation) => creation.intent?.id === intentId)?.intent;
      if (!intent) throw new Error(`missing intent ${intentId}`);
      const runId = intent.projectId === "project-1" ? "run-1" : "run-2";
      const submitted = submittedIntent(intent, runId);
      return { value: { intent: submitted, run: run(submitted, runId) }, etag: '"2"' };
    });
    const rendered = renderHook(({
      onRun,
      projectId,
    }: {
      onRun: (value: Run) => void;
      projectId: string;
    }) => useWorkbenchSubmissionCoordinator({
      currentIntent: null,
      onRun,
      projectId,
      uploads,
    }), {
      initialProps: { onRun: firstRunGuard, projectId: "project-1" },
      wrapper: wrapper(queryClient),
    });

    let first!: Promise<Run | null>;
    act(() => {
      first = rendered.result.current.submitPrepared({
        projectId: "project-1",
        threadId: "thread-1",
        submission: { request: runRequest() },
      });
    });
    await waitFor(() => expect(rendered.result.current.actionPending).toBe(true));

    rendered.rerender({ onRun: latestRunGuard, projectId: "project-2" });
    expect(rendered.result.current.actionPending).toBe(false);
    let second!: Promise<Run | null>;
    act(() => {
      second = rendered.result.current.submitPrepared({
        projectId: "project-2",
        threadId: "thread-2",
        submission: { request: runRequest() },
      });
    });
    await waitFor(() => expect(rendered.result.current.actionPending).toBe(true));

    const secondCreation = creates.get("thread-2")!;
    secondCreation.resolve({ value: secondCreation.intent!, etag: '"1"' });
    await act(() => second);
    expect(rendered.result.current.actionPending).toBe(false);
    expect(latestRunGuard).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-2",
      projectId: "project-2",
    }));

    rendered.rerender({ onRun: latestRunGuard, projectId: "project-1" });
    expect(rendered.result.current.actionPending).toBe(true);
    const firstCreation = creates.get("thread-1")!;
    firstCreation.resolve({ value: firstCreation.intent!, etag: '"1"' });
    await act(() => first);
    expect(rendered.result.current.actionPending).toBe(false);
    expect(firstRunGuard).not.toHaveBeenCalled();
    expect(latestRunGuard).toHaveBeenCalledWith(expect.objectContaining({
      id: "run-1",
      projectId: "project-1",
    }));

    rendered.unmount();
    queryClient.clear();
  });
});

function client() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function wrapper(queryClient: QueryClient) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function uploadPort() {
  return {
    completeUploadBatch: vi.fn<(batchId: string | null) => void>(),
    releaseProjectUploads: vi.fn<(projectId: string) => void>(),
    uploadFiles: vi.fn<WorkbenchSubmissionUploadPort["uploadFiles"]>(
      async () => ({ batchId: "batch-1", fileAssetIds: ["file-1"] }),
    ),
  } satisfies WorkbenchSubmissionUploadPort;
}

function runRequest() {
  return {
    prompt: "Build a dashboard",
    modelId: "quality",
    workflow: "generate" as const,
    generationIntent: null,
    targetSurface: "web" as const,
    designStyle: { kind: "automatic" as const },
    artifactTargets: [],
    requestedArtifactKinds: [],
    sourceIds: [],
    canvasSnapshot: null,
  };
}

function testFile(name: string, type = "application/pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, {
    type,
    lastModified: 1_786_771_200_000,
  });
}

function pendingIntent(
  threadId: string,
  request: CreateSubmissionIntentRequest,
  projectId = "project-1",
): SubmissionIntent {
  return {
    id: projectId === "project-1" ? "intent-1" : "intent-2",
    projectId,
    threadId,
    status: "pending",
    request: request.request,
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

function readyIntent(intent: SubmissionIntent): SubmissionIntent {
  return {
    ...intent,
    attachments: intent.attachments.map((attachment, index) => attachment.kind === "upload"
      ? {
          ...attachment,
          fileAssetId: attachment.fileAssetId ?? `file-${index + 1}`,
          fileStatus: "ready" as const,
        }
      : attachment),
  };
}

function submittedIntent(intent: SubmissionIntent, runId = "run-1"): SubmissionIntent {
  return {
    ...intent,
    status: "submitted",
    runId,
    revision: intent.revision + 1,
    submittedAt: timestamp,
  };
}

function uploadSlot(
  position: number,
  clientFingerprint: string,
  fileAssetId: string | null,
  fileStatus: "uploading" | null,
) {
  return {
    position,
    kind: "upload" as const,
    fileAssetId,
    clientFingerprint,
    fileName: "brief.pdf",
    declaredMediaType: "application/pdf",
    byteSize: 3,
    lastModified: 1_786_771_200_000,
    fileStatus,
  };
}

function run(intent: SubmissionIntent, runId = "run-1"): Run {
  return {
    id: runId,
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

function deferred<T>() {
  let intent: SubmissionIntent | null = null;
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    get intent() {
      return intent;
    },
    set intent(value: SubmissionIntent | null) {
      intent = value;
    },
    promise,
    reject,
    resolve,
  };
}
