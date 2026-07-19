// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  WorkbenchUploadError,
  WorkbenchUploadPhase,
  WorkbenchUploadSnapshot,
} from "./uppy-multipart";
import {
  WorkbenchUploadBatchDisposedError,
  WorkbenchUploadRegistry,
  useWorkbenchUploadRegistry,
} from "./upload-registry";

describe("WorkbenchUploadRegistry", () => {
  it("projects every file and keeps progress stable across a retry", async () => {
    const first = new FakeUpload("local-a", "brief.pdf", "file-a");
    const second = new FakeUpload("local-b", "wireframe.png", "file-b");
    first.onStart = async () => first.transition("ready", { uploadPercent: 100 });
    second.onStart = async () => {
      second.transition("uploading", { uploadPercent: 52 });
      return second.transition("failed", { error: retryableError() });
    };
    second.onRetry = async () => second.transition("uploading", { uploadPercent: 8 });
    const controllers = [first, second];
    const registry = createRegistry(controllers);

    const resultPromise = registry.uploadFiles("project-1", [
      { file: testFile("brief.pdf") },
      { file: testFile("wireframe.png") },
    ]);
    await eventually(() => registry.getSnapshot().uploads[1]?.phase === "failed");

    expect(registry.getSnapshot().uploads).toHaveLength(2);
    expect(registry.getSnapshot().uploads.map((upload) => upload.fileName)).toEqual([
      "brief.pdf",
      "wireframe.png",
    ]);
    const progressBeforeRetry = registry.getSnapshot().uploads[1].progress;

    const retrying = registry.retry(registry.getSnapshot().uploads[1].id);
    await retrying;
    expect(registry.getSnapshot().uploads[1]).toMatchObject({
      phase: "uploading",
      stage: "upload",
      progress: progressBeforeRetry,
    });

    second.transition("ready", { uploadPercent: 100 });
    await expect(resultPromise).resolves.toMatchObject({
      fileAssetIds: ["file-a", "file-b"],
    });
  });

  it("continues the original batch after a retryable upload succeeds", async () => {
    const upload = new FakeUpload("local-a", "brief.pdf", "file-a");
    upload.onStart = async () => {
      upload.transition("failed", { error: retryableError() });
      throw new Error("transfer interrupted");
    };
    upload.onRetry = async () => upload.transition("ready", { uploadPercent: 100 });
    const registry = createRegistry([upload]);
    const startRun = vi.fn(async (fileAssetIds: string[]) => `run:${fileAssetIds.join(",")}`);
    let batchSettled = false;

    const batch = registry.uploadFiles("project-1", [{ file: testFile("brief.pdf") }]);
    const originalSubmission = batch.then((result) => startRun(result.fileAssetIds));
    void batch.finally(() => {
      batchSettled = true;
    });
    await eventually(() => registry.getSnapshot().uploads[0]?.phase === "failed");
    expect(batchSettled).toBe(false);

    await registry.retry(registry.getSnapshot().uploads[0].id);

    await expect(batch).resolves.toMatchObject({ fileAssetIds: ["file-a"] });
    await expect(originalSubmission).resolves.toBe("run:file-a");
    expect(upload.retry).toHaveBeenCalledOnce();
    expect(startRun).toHaveBeenCalledOnce();
  });

  it("delegates pause, resume and explicit cancellation to the matching controller", async () => {
    const upload = new FakeUpload("local-a", "brief.pdf", "file-a");
    upload.onStart = async () => upload.transition("uploading", { uploadPercent: 30 });
    const registry = createRegistry([upload]);
    const batch = registry.uploadFiles("project-1", [{ file: testFile("brief.pdf") }]);
    await eventually(() => registry.getSnapshot().uploads[0]?.phase === "uploading");
    const id = registry.getSnapshot().uploads[0].id;

    expect(registry.pause(id)).toBe(true);
    expect(registry.getSnapshot().uploads[0].phase).toBe("paused");
    expect(registry.resume(id)).toBe(true);
    expect(registry.getSnapshot().uploads[0].phase).toBe("uploading");
    await registry.cancel(id);

    await expect(batch).resolves.toMatchObject({ fileAssetIds: [] });
    expect(upload.cancel).toHaveBeenCalledOnce();
  });

  it("keeps SubmissionIntent-bound files under whole-submission cancellation", async () => {
    const upload = new FakeUpload("local-a", "brief.pdf", "file-a");
    upload.onStart = async () => upload.transition("uploading", {
      submissionIntent: {
        submissionIntentId: "intent-1",
        attachmentPosition: 0,
        clientFingerprint: "submission-file:one",
      },
      uploadPercent: 30,
    });
    const registry = createRegistry([upload]);
    const batch = registry.uploadFiles("project-1", [{
      file: testFile("brief.pdf"),
      submissionIntent: {
        submissionIntentId: "intent-1",
        attachmentPosition: 0,
        clientFingerprint: "submission-file:one",
      },
    }]);

    await eventually(() => registry.getSnapshot().uploads[0]?.phase === "uploading");

    expect(registry.getSnapshot().uploads[0]).toMatchObject({
      canCancel: false,
      submissionIntentId: "intent-1",
    });
    registry.releaseProject("project-1");
    await expect(batch).rejects.toBeInstanceOf(WorkbenchUploadBatchDisposedError);
  });

  it("destroys local controllers on Project release without aborting the server upload", async () => {
    const upload = new FakeUpload("local-a", "brief.pdf", "file-a");
    upload.onStart = () => new Promise(() => undefined);
    const registry = createRegistry([upload]);
    const batch = registry.uploadFiles("project-1", [{ file: testFile("brief.pdf") }]);
    await eventually(() => registry.getSnapshot().uploads.length === 1);

    registry.releaseProject("project-1");

    await expect(batch).rejects.toBeInstanceOf(WorkbenchUploadBatchDisposedError);
    expect(upload.destroy).toHaveBeenCalledOnce();
    expect(upload.cancel).not.toHaveBeenCalled();
    expect(registry.getSnapshot().uploads).toEqual([]);
  });

  it("disposes a controller that finishes creating after its Project was released", async () => {
    const upload = new FakeUpload("local-a", "brief.pdf", "file-a");
    const creation = deferred<FakeUpload>();
    const registry = new WorkbenchUploadRegistry({
      service: {} as never,
      createUpload: () => creation.promise,
    });
    const batch = registry.uploadFiles("project-1", [{ file: testFile("brief.pdf") }]);

    registry.releaseProject("project-1");
    creation.resolve(upload);

    await expect(batch).rejects.toBeInstanceOf(WorkbenchUploadBatchDisposedError);
    expect(upload.destroy).toHaveBeenCalledOnce();
    expect(upload.cancel).not.toHaveBeenCalled();
    expect(registry.getSnapshot().uploads).toEqual([]);
  });

  it("rejects terminal processing failures instead of offering an invalid retry", async () => {
    const upload = new FakeUpload("local-a", "brief.pdf", "file-a");
    upload.onStart = async () => upload.transition("failed", {
      error: { code: "FILE_QUARANTINED", message: "File was quarantined", retryable: false },
    });
    const registry = createRegistry([upload]);

    const batch = registry.uploadFiles("project-1", [{ file: testFile("brief.pdf") }]);

    await expect(batch).rejects.toThrow("File was quarantined");
    expect(registry.getSnapshot().uploads[0]).toMatchObject({
      canRetry: false,
      phase: "failed",
      stage: "failed",
    });
  });

  it("rejects an unexpected controller error that has no retryable failure projection", async () => {
    const upload = new FakeUpload("local-a", "brief.pdf", "file-a");
    upload.onStart = async () => {
      throw new Error("controller invariant failed");
    };
    const registry = createRegistry([upload]);

    await expect(registry.uploadFiles("project-1", [{ file: testFile("brief.pdf") }]))
      .rejects.toThrow("controller invariant failed");
  });

  it("keeps the memoized registry alive across the Strict Mode effect replay", async () => {
    const dispose = vi.spyOn(WorkbenchUploadRegistry.prototype, "dispose");
    const rendered = renderHook(
      () => useWorkbenchUploadRegistry({} as never),
      { wrapper: StrictModeWrapper },
    );

    await act(async () => Promise.resolve());
    expect(dispose).not.toHaveBeenCalled();

    rendered.unmount();
    await act(async () => Promise.resolve());
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return createElement(StrictMode, null, children);
}

class FakeUpload {
  private listeners = new Set<(snapshot: WorkbenchUploadSnapshot) => void>();
  private snapshot: WorkbenchUploadSnapshot;
  onStart: () => Promise<WorkbenchUploadSnapshot> = () => new Promise(() => undefined);
  onRetry: () => Promise<WorkbenchUploadSnapshot> = () => new Promise(() => undefined);

  constructor(id: string, fileName: string, fileAssetId: string) {
    this.snapshot = uploadSnapshot(id, fileName, fileAssetId);
  }

  getSnapshot = () => structuredClone(this.snapshot);

  subscribe = (listener: (snapshot: WorkbenchUploadSnapshot) => void) => {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  };

  start = vi.fn(() => this.onStart());
  retry = vi.fn(() => this.onRetry());
  destroy = vi.fn();

  pause = vi.fn(() => {
    if (this.snapshot.phase !== "uploading") return false;
    this.transition("paused");
    return true;
  });

  resume = vi.fn(() => {
    if (this.snapshot.phase !== "paused") return false;
    this.transition("uploading");
    return true;
  });

  cancel = vi.fn(async () => {
    this.transition("cancelled", { error: null });
  });

  transition(
    phase: WorkbenchUploadPhase,
    patch: Partial<WorkbenchUploadSnapshot> = {},
  ): WorkbenchUploadSnapshot {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      phase,
      file: phase === "failed" && patch.error?.retryable === false
        ? ({ id: this.snapshot.fileAssetId } as WorkbenchUploadSnapshot["file"])
        : this.snapshot.file,
    };
    for (const listener of this.listeners) listener(this.getSnapshot());
    return this.getSnapshot();
  }
}

function createRegistry(controllers: FakeUpload[]) {
  let index = 0;
  return new WorkbenchUploadRegistry({
    service: {} as never,
    createUpload: async () => controllers[index++],
  });
}

function uploadSnapshot(
  id: string,
  fileName: string,
  fileAssetId: string,
): WorkbenchUploadSnapshot {
  return {
    id,
    projectId: "project-1",
    fileAssetId,
    uploadSessionId: "upload-1",
    fileName,
    declaredMediaType: "application/pdf",
    byteSize: 1_024,
    phase: "queued",
    recoveryState: "new",
    bytesUploaded: 0,
    uploadPercent: 0,
    bytesHashed: 0,
    hashPercent: 0,
    clientSha256Hint: null,
    submissionIntent: null,
    file: null,
    extraction: null,
    error: null,
  };
}

function retryableError(): WorkbenchUploadError {
  return { code: "UPLOAD_FAILED", message: "Connection lost", retryable: true };
}

function testFile(name: string): File {
  return new File([new Uint8Array([1])], name, {
    type: name.endsWith(".png") ? "image/png" : "application/pdf",
    lastModified: 1_720_742_400_000,
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition did not become true");
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
