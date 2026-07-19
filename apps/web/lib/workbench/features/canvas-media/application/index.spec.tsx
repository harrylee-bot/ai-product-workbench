// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchCanvasMediaUpload } from "../api-adapter";
import {
  useWorkbenchCanvasMediaController,
  type WorkbenchCanvasMediaControllerOptions,
  type WorkbenchCanvasMediaPort,
} from "./index";

const mocks = vi.hoisted(() => ({
  artifactMutations: new Map<string, {
    create: ReturnType<typeof vi.fn>;
    isPending: boolean;
  }>(),
  artifactPending: false,
  createArtifact: vi.fn(),
  createUpload: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchCanvasMediaInfrastructure: (projectId: string) => ({
    artifact: mocks.artifactMutations.get(projectId) ?? {
      create: mocks.createArtifact,
      isPending: mocks.artifactPending,
    },
    createUpload: mocks.createUpload,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

beforeEach(() => {
  mocks.artifactMutations.clear();
  mocks.artifactPending = false;
  mocks.createArtifact.mockReset();
  mocks.createUpload.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.createArtifact.mockResolvedValue(artifactCreation());
  vi.stubGlobal("createImageBitmap", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workbench canvas Media controller", () => {
  it("fences same-tick inserts synchronously and honors edit permission", async () => {
    const uploadResult = deferred<ReturnType<typeof readyUploadSnapshot>>();
    const upload = testUpload(uploadResult.promise);
    mocks.createUpload.mockResolvedValue(upload.controller);
    const allowed = renderController();
    let first!: Promise<void>;
    let duplicate!: Promise<void>;

    act(() => {
      first = allowed.result.current.insertMedia(imageFile(), "media:one");
      duplicate = allowed.result.current.insertMedia(imageFile(), "media:one");
    });
    await waitFor(() => expect(upload.start).toHaveBeenCalledOnce());
    expect(mocks.createUpload).toHaveBeenCalledOnce();
    expect(allowed.result.current.busy).toBe(true);

    await act(async () => {
      uploadResult.resolve(readyUploadSnapshot("file-1"));
      await Promise.all([first, duplicate]);
    });
    expect(mocks.createArtifact).toHaveBeenCalledOnce();

    const blocked = renderController({ canEdit: false });
    await act(async () => {
      await blocked.result.current.insertMedia(imageFile(), "media:blocked");
    });
    expect(mocks.createUpload).toHaveBeenCalledOnce();
    expect(mocks.createArtifact).toHaveBeenCalledOnce();
  });

  it("reuses the uploaded File when Artifact creation fails and the operation retries", async () => {
    const upload = testUpload();
    mocks.createUpload.mockResolvedValue(upload.controller);
    mocks.createArtifact
      .mockRejectedValueOnce(new Error("artifact failed"))
      .mockResolvedValueOnce(artifactCreation());
    const rendered = renderController();

    await act(async () => {
      await rendered.result.current.insertMedia(imageFile(), "media:retry");
    });
    expect(rendered.result.current.error).toBe("artifact failed");
    expect(rendered.port.addBoardArtifact).not.toHaveBeenCalled();

    await act(async () => {
      await rendered.result.current.insertMedia(imageFile(), "media:retry");
    });
    expect(mocks.createUpload).toHaveBeenCalledOnce();
    expect(upload.start).toHaveBeenCalledOnce();
    expect(mocks.createArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.createArtifact).toHaveBeenNthCalledWith(1, {
      idempotencyKey: "artifact:media:retry",
      request: {
        kind: "image",
        source: { kind: "file", fileAssetId: "file-1" },
        title: "hero",
      },
    });
    expect(mocks.createArtifact).toHaveBeenNthCalledWith(2, {
      idempotencyKey: "artifact:media:retry",
      request: {
        kind: "image",
        source: { kind: "file", fileAssetId: "file-1" },
        title: "hero",
      },
    });
    expect(rendered.result.current.error).toBeNull();
    expect(rendered.port.addBoardArtifact).toHaveBeenCalledOnce();
  });

  it("preserves upload, Artifact, and closed-Board errors", async () => {
    const failedUpload = testUpload(Promise.reject(new Error("upload failed")));
    mocks.createUpload.mockResolvedValueOnce(failedUpload.controller);
    const uploadFailure = renderController();
    await act(async () => {
      await uploadFailure.result.current.insertMedia(imageFile(), "media:upload-failure");
    });
    expect(uploadFailure.result.current.error).toBe("upload failed");

    const artifactUpload = testUpload();
    mocks.createUpload.mockResolvedValueOnce(artifactUpload.controller);
    mocks.createArtifact.mockRejectedValueOnce(new Error("artifact failed"));
    const artifactFailure = renderController();
    await act(async () => {
      await artifactFailure.result.current.insertMedia(imageFile(), "media:artifact-failure");
    });
    expect(artifactFailure.result.current.error).toBe("artifact failed");

    const boardUpload = testUpload();
    mocks.createUpload.mockResolvedValueOnce(boardUpload.controller);
    const boardClosed = renderController({}, { nodeId: "" });
    await act(async () => {
      await boardClosed.result.current.insertMedia(imageFile(), "media:board-closed");
    });
    expect(boardClosed.result.current.error).toBe("图片产物已创建，但项目画布已经关闭");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    act(() => boardClosed.result.current.close());
    expect(boardClosed.result.current.error).toBeNull();
    expect(boardClosed.result.current.progress).toBeNull();
    expect(boardClosed.port.selectTool).toHaveBeenCalledWith("select");
  });

  it("reports an unavailable stage before uploading", async () => {
    const rendered = renderController({}, { stage: null });
    await act(async () => {
      await rendered.result.current.insertMedia(imageFile(), "media:no-stage");
    });

    expect(rendered.result.current.error).toBe("项目画布尚未就绪");
    expect(mocks.createUpload).not.toHaveBeenCalled();
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it("rejects a ready upload without a File id", async () => {
    const upload = testUpload(Promise.resolve(readyUploadSnapshot(null)));
    mocks.createUpload.mockResolvedValue(upload.controller);
    const rendered = renderController();
    await act(async () => {
      await rendered.result.current.insertMedia(imageFile(), "media:no-file");
    });

    expect(rendered.result.current.error).toBe("图片 hero.png 未完成上传");
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it("keeps the successful call order, Board geometry, and Artifact idempotency key", async () => {
    const calls: string[] = [];
    const upload = testUpload(Promise.resolve(readyUploadSnapshot("file-success")), calls);
    mocks.createUpload.mockImplementation(async () => {
      calls.push("create-upload");
      return upload.controller;
    });
    mocks.createArtifact.mockImplementation(async () => {
      calls.push("create-artifact");
      return artifactCreation();
    });
    mocks.toastSuccess.mockImplementation(() => {
      calls.push("toast");
    });
    const rendered = renderController(
      { exportOpen: true },
      { calls, flowPosition: { x: 30, y: 20 } },
    );

    await act(async () => {
      await rendered.result.current.insertMedia(imageFile(), "media:success");
    });

    expect(calls).toEqual([
      "get-stage",
      "screen-to-flow",
      "create-upload",
      "subscribe",
      "start-upload",
      "create-artifact",
      "add-board",
      "select-node",
      "write-url",
      "update-export",
      "toast",
      "select-tool",
      "unsubscribe",
      "destroy",
    ]);
    expect(mocks.createUpload).toHaveBeenCalledWith(expect.any(File));
    expect(mocks.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "artifact:media:success",
    }));
    expect(rendered.port.addBoardArtifact).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      artifactKind: "image",
      artifactVersionId: "version-1",
      height: 320,
      title: "Hero",
      width: 480,
      x: -210,
      y: -140,
    });
    expect(rendered.result.current).toMatchObject({
      busy: false,
      error: null,
      progress: 100,
    });
    expect(rendered.port.updateExportSelection).toHaveBeenCalledWith({
      artifact: {
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        projectId: "project-1",
      },
      hasSelection: true,
      nodeIds: ["node-1"],
    });
  });

  it("destroys and unsubscribes on unmount without applying a late Artifact result", async () => {
    const artifactResult = deferred<ReturnType<typeof artifactCreation>>();
    const upload = testUpload();
    mocks.createUpload.mockResolvedValue(upload.controller);
    mocks.createArtifact.mockReturnValue(artifactResult.promise);
    const rendered = renderController();
    let insertion!: Promise<void>;

    act(() => {
      insertion = rendered.result.current.insertMedia(imageFile(), "media:unmount");
    });
    await waitFor(() => expect(mocks.createArtifact).toHaveBeenCalledOnce());
    rendered.unmount();
    expect(upload.unsubscribe).toHaveBeenCalledOnce();
    expect(upload.destroy).toHaveBeenCalledOnce();

    artifactResult.resolve(artifactCreation());
    await insertion;
    expect(upload.unsubscribe).toHaveBeenCalledOnce();
    expect(upload.destroy).toHaveBeenCalledOnce();
    expect(rendered.port.addBoardArtifact).not.toHaveBeenCalled();
    expect(rendered.port.selectNode).not.toHaveBeenCalled();
    expect(rendered.port.writeSelectedNodeUrl).not.toHaveBeenCalled();
    expect(rendered.port.updateExportSelection).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("invalidates a late upload when the Project changes", async () => {
    const uploadResult = deferred<ReturnType<typeof readyUploadSnapshot>>();
    const oldUpload = testUpload(uploadResult.promise);
    const oldMutation = vi.fn().mockResolvedValue(artifactCreation());
    const newMutation = vi.fn().mockResolvedValue(artifactCreation());
    mocks.artifactMutations.set("project-1", { create: oldMutation, isPending: false });
    mocks.artifactMutations.set("project-2", { create: newMutation, isPending: false });
    mocks.createUpload.mockResolvedValue(oldUpload.controller);
    const oldPort = mediaPort();
    const newPort = mediaPort();
    const rendered = renderSwitchableController("project-1", oldPort);
    let insertion!: Promise<void>;

    act(() => {
      insertion = rendered.result.current.insertMedia(imageFile(), "media:switch-upload");
    });
    await waitFor(() => expect(oldUpload.start).toHaveBeenCalledOnce());
    act(() => rendered.rerender({ projectId: "project-2", port: newPort }));
    expect(oldUpload.unsubscribe).toHaveBeenCalledOnce();
    expect(oldUpload.destroy).toHaveBeenCalledOnce();
    expect(rendered.result.current).toMatchObject({
      busy: false,
      error: null,
      progress: null,
    });

    await act(async () => {
      uploadResult.resolve(readyUploadSnapshot("file-old"));
      await insertion;
    });
    expect(oldMutation).not.toHaveBeenCalled();
    expect(newMutation).not.toHaveBeenCalled();
    expect(oldPort.addBoardArtifact).not.toHaveBeenCalled();
    expect(newPort.addBoardArtifact).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("clears the operation File cache and fences a late Artifact across Projects", async () => {
    const artifactResult = deferred<ReturnType<typeof artifactCreation>>();
    const oldUpload = testUpload(Promise.resolve(readyUploadSnapshot("file-old")));
    const newUpload = testUpload(Promise.resolve(readyUploadSnapshot("file-new")));
    const oldMutation = vi.fn().mockReturnValue(artifactResult.promise);
    const newMutation = vi.fn().mockResolvedValue(artifactCreation());
    mocks.artifactMutations.set("project-1", { create: oldMutation, isPending: false });
    mocks.artifactMutations.set("project-2", { create: newMutation, isPending: false });
    mocks.createUpload
      .mockResolvedValueOnce(oldUpload.controller)
      .mockResolvedValueOnce(newUpload.controller);
    const oldPort = mediaPort();
    const newPort = mediaPort();
    const rendered = renderSwitchableController("project-1", oldPort);
    let oldInsertion!: Promise<void>;

    act(() => {
      oldInsertion = rendered.result.current.insertMedia(imageFile(), "media:same-operation");
    });
    await waitFor(() => expect(oldMutation).toHaveBeenCalledOnce());
    act(() => rendered.rerender({ projectId: "project-2", port: newPort }));

    await act(async () => {
      artifactResult.resolve(artifactCreation());
      await oldInsertion;
    });
    expect(newMutation).not.toHaveBeenCalled();
    expect(oldPort.addBoardArtifact).not.toHaveBeenCalled();
    expect(newPort.addBoardArtifact).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    await act(async () => {
      await rendered.result.current.insertMedia(imageFile(), "media:same-operation");
    });
    expect(mocks.createUpload).toHaveBeenCalledTimes(2);
    expect(newMutation).toHaveBeenCalledWith({
      idempotencyKey: "artifact:media:same-operation",
      request: {
        kind: "image",
        source: { kind: "file", fileAssetId: "file-new" },
        title: "hero",
      },
    });
    expect(newPort.addBoardArtifact).toHaveBeenCalledOnce();
    expect(oldPort.addBoardArtifact).not.toHaveBeenCalled();
  });

  it("runs two different operations serially", async () => {
    const firstUpload = testUpload(Promise.resolve(readyUploadSnapshot("file-1")));
    const secondUpload = testUpload(Promise.resolve(readyUploadSnapshot("file-2")));
    mocks.createUpload
      .mockResolvedValueOnce(firstUpload.controller)
      .mockResolvedValueOnce(secondUpload.controller);
    const rendered = renderController();

    await act(async () => {
      await rendered.result.current.insertMedia(imageFile("one.png"), "media:one");
      await rendered.result.current.insertMedia(imageFile("two.png"), "media:two");
    });

    expect(mocks.createUpload).toHaveBeenCalledTimes(2);
    expect(mocks.createArtifact).toHaveBeenCalledTimes(2);
    expect(mocks.createArtifact).toHaveBeenNthCalledWith(1, expect.objectContaining({
      idempotencyKey: "artifact:media:one",
      request: expect.objectContaining({ source: { kind: "file", fileAssetId: "file-1" } }),
    }));
    expect(mocks.createArtifact).toHaveBeenNthCalledWith(2, expect.objectContaining({
      idempotencyKey: "artifact:media:two",
      request: expect.objectContaining({ source: { kind: "file", fileAssetId: "file-2" } }),
    }));
  });
});

function renderController(
  overrides: Partial<WorkbenchCanvasMediaControllerOptions> = {},
  portOptions: PortOptions = {},
) {
  const port = mediaPort(portOptions);
  const options: WorkbenchCanvasMediaControllerOptions = {
    canEdit: true,
    exportOpen: false,
    port,
    projectId: "project-1",
    ...overrides,
  };
  const rendered = renderHook(() => useWorkbenchCanvasMediaController(options));
  return { ...rendered, port };
}

function renderSwitchableController(projectId: string, port: WorkbenchCanvasMediaPort) {
  return renderHook(
    ({ projectId: activeProjectId, port: activePort }: {
      projectId: string;
      port: WorkbenchCanvasMediaPort;
    }) => useWorkbenchCanvasMediaController({
      canEdit: true,
      exportOpen: true,
      port: activePort,
      projectId: activeProjectId,
    }),
    { initialProps: { projectId, port } },
  );
}

type PortOptions = {
  calls?: string[];
  flowPosition?: { x: number; y: number };
  nodeId?: string;
  stage?: { x: number; y: number; width: number; height: number } | null;
};

function mediaPort({
  calls = [],
  flowPosition,
  nodeId = "node-1",
  stage = { x: 100, y: 50, width: 400, height: 300 },
}: PortOptions = {}): WorkbenchCanvasMediaPort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    addBoardArtifact: vi.fn(() => {
      calls.push("add-board");
      return nodeId;
    }),
    getStageRect: vi.fn(() => {
      calls.push("get-stage");
      return stage;
    }),
    screenToFlowPosition: vi.fn((point) => {
      calls.push("screen-to-flow");
      return flowPosition ?? point;
    }),
    selectNode: vi.fn(() => {
      calls.push("select-node");
    }),
    selectTool: vi.fn(() => {
      calls.push("select-tool");
    }),
    updateExportSelection: vi.fn(() => {
      calls.push("update-export");
    }),
    writeSelectedNodeUrl: vi.fn(() => {
      calls.push("write-url");
    }),
  };
}

function testUpload(
  startResult: Promise<ReturnType<typeof readyUploadSnapshot>> = Promise.resolve(readyUploadSnapshot("file-1")),
  calls: string[] = [],
) {
  const unsubscribe = vi.fn(() => {
    calls.push("unsubscribe");
  });
  const destroy = vi.fn(() => {
    calls.push("destroy");
  });
  const start = vi.fn(() => {
    calls.push("start-upload");
    return startResult;
  });
  const subscribe = vi.fn((listener: (snapshot: ReturnType<typeof uploadSnapshot>) => void) => {
    calls.push("subscribe");
    listener(uploadSnapshot());
    return unsubscribe;
  });
  return {
    controller: { destroy, start, subscribe } as unknown as WorkbenchCanvasMediaUpload,
    destroy,
    start,
    subscribe,
    unsubscribe,
  };
}

function uploadSnapshot() {
  return {
    fileAssetId: null,
    hashPercent: 20,
    phase: "uploading",
    uploadPercent: 50,
  };
}

function readyUploadSnapshot(fileAssetId: string | null = "file-1") {
  return {
    fileAssetId,
    hashPercent: 100,
    phase: "ready",
    uploadPercent: 100,
  };
}

function artifactCreation() {
  return {
    artifact: { id: "artifact-1", title: "Hero" },
    artifactVersion: { artifactVersionId: "version-1" },
  };
}

function imageFile(name = "hero.png") {
  return new File(["image"], name, { type: "image/png", lastModified: 1 });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
