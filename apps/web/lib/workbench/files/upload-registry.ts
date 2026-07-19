"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  createWorkbenchMultipartUpload,
  type WorkbenchFileTransferService,
  type WorkbenchMultipartUpload,
  type WorkbenchMultipartUploadOptions,
  type WorkbenchUploadError,
  type WorkbenchUploadPhase,
  type WorkbenchUploadSnapshot,
} from "./uppy-multipart";

export type WorkbenchUploadStage =
  | "hash"
  | "upload"
  | "verify"
  | "extract"
  | "ready"
  | "failed"
  | "cancelled";

export type WorkbenchUploadAction = "cancel" | "retry";

export type WorkbenchUploadItemViewModel = {
  id: string;
  controllerId: string;
  projectId: string;
  fileName: string;
  byteSize: number;
  phase: WorkbenchUploadPhase;
  stage: WorkbenchUploadStage;
  statusLabel: string;
  progress: number;
  hashPercent: number;
  uploadPercent: number;
  error: WorkbenchUploadError | null;
  submissionIntentId: string | null;
  actionPending: WorkbenchUploadAction | null;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRetry: boolean;
};

export type WorkbenchUploadRegistrySnapshot = {
  uploads: WorkbenchUploadItemViewModel[];
};

export type WorkbenchUploadBatchResult = {
  batchId: string | null;
  fileAssetIds: string[];
};

export type WorkbenchUploadInput = Pick<
  WorkbenchMultipartUploadOptions,
  "file" | "submissionIntent"
>;

export class WorkbenchUploadBatchDisposedError extends Error {
  constructor(readonly projectId: string) {
    super(`Upload batch for Project ${projectId} was released`);
    this.name = "WorkbenchUploadBatchDisposedError";
  }
}

type UploadController = Pick<
  WorkbenchMultipartUpload,
  "cancel" | "destroy" | "getSnapshot" | "pause" | "resume" | "retry" | "start" | "subscribe"
>;

type CreateUpload = (
  options: WorkbenchMultipartUploadOptions,
) => Promise<UploadController>;

type RegistryOptions = {
  service: WorkbenchFileTransferService;
  createUpload?: CreateUpload;
};

type Settlement<T> = {
  settled: boolean;
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

type UploadRecord = {
  id: string;
  batchId: string;
  controller: UploadController;
  snapshot: WorkbenchUploadSnapshot;
  progress: number;
  actionPending: WorkbenchUploadAction | null;
  settlement: Settlement<string | null>;
  unsubscribe: () => void;
};

export class WorkbenchUploadRegistry {
  private readonly service: WorkbenchFileTransferService;
  private readonly createUpload: CreateUpload;
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<string, UploadRecord>();
  private readonly batchProjects = new Map<string, string>();
  private batchSequence = 0;
  private state: WorkbenchUploadRegistrySnapshot = { uploads: [] };
  private disposed = false;

  constructor(options: RegistryOptions) {
    this.service = options.service;
    this.createUpload = options.createUpload ?? createWorkbenchMultipartUpload;
  }

  getSnapshot = (): WorkbenchUploadRegistrySnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async uploadFiles(
    projectId: string,
    inputs: readonly WorkbenchUploadInput[],
  ): Promise<WorkbenchUploadBatchResult> {
    this.assertActive();
    this.releaseProject(projectId);
    if (inputs.length === 0) return { batchId: null, fileAssetIds: [] };

    const batchId = `upload-batch-${++this.batchSequence}`;
    this.batchProjects.set(batchId, projectId);
    const batchRecords: UploadRecord[] = [];

    try {
      for (const [index, input] of inputs.entries()) {
        const { file, submissionIntent } = input;
        const controller = await this.createUpload({
          projectId,
          file,
          service: this.service,
          requestExtraction: shouldExtractFile(file),
          submissionIntent,
        });
        if (this.disposed || this.batchProjects.get(batchId) !== projectId) {
          controller.destroy();
          throw new WorkbenchUploadBatchDisposedError(projectId);
        }
        const snapshot = controller.getSnapshot();
        const id = `${snapshot.id}:${index}`;
        const settlement = createSettlement<string | null>();
        void settlement.promise.catch(() => undefined);
        const record: UploadRecord = {
          id,
          batchId,
          controller,
          snapshot,
          progress: projectedProgress(snapshot),
          actionPending: null,
          settlement,
          unsubscribe: () => undefined,
        };
        this.records.set(id, record);
        batchRecords.push(record);
        record.unsubscribe = controller.subscribe((nextSnapshot) => {
          if (!this.records.has(id)) return;
          this.applySnapshot(record, nextSnapshot);
        });
        this.emit();
      }
    } catch (error) {
      this.releaseBatch(batchId, error);
      throw error;
    }

    for (const record of batchRecords) {
      void this.run(record, () => record.controller.start()).catch(() => undefined);
    }

    const fileAssetIds = (await Promise.all(
      batchRecords.map((record) => record.settlement.promise),
    )).filter((fileAssetId): fileAssetId is string => Boolean(fileAssetId));
    return { batchId, fileAssetIds: [...new Set(fileAssetIds)] };
  }

  pause(id: string): boolean {
    const record = this.requireRecord(id);
    return record.controller.pause();
  }

  resume(id: string): boolean {
    const record = this.requireRecord(id);
    return record.controller.resume();
  }

  async retry(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.actionPending) return;
    record.actionPending = record.snapshot.error?.code === "UPLOAD_CANCEL_FAILED"
      ? "cancel"
      : "retry";
    this.emit();
    try {
      if (record.actionPending === "cancel") {
        await this.run(record, async () => {
          await record.controller.cancel();
          return record.controller.getSnapshot();
        });
      } else {
        await this.run(record, () => record.controller.retry());
      }
    } finally {
      if (this.records.has(id)) {
        record.actionPending = null;
        this.emit();
      }
    }
  }

  async cancel(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.actionPending) return;
    record.actionPending = "cancel";
    this.emit();
    try {
      await this.run(record, async () => {
        await record.controller.cancel();
        return record.controller.getSnapshot();
      });
    } finally {
      if (this.records.has(id)) {
        record.actionPending = null;
        this.emit();
      }
    }
  }

  completeBatch(batchId: string | null): void {
    if (!batchId) return;
    this.releaseBatch(batchId);
  }

  releaseProject(projectId: string): void {
    const error = new WorkbenchUploadBatchDisposedError(projectId);
    for (const [batchId, batchProjectId] of this.batchProjects) {
      if (batchProjectId === projectId) this.batchProjects.delete(batchId);
    }
    for (const record of [...this.records.values()]) {
      if (record.snapshot.projectId === projectId) this.releaseRecord(record, error);
    }
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.batchProjects.clear();
    for (const record of [...this.records.values()]) {
      this.releaseRecord(record, new WorkbenchUploadBatchDisposedError(record.snapshot.projectId));
    }
    this.emit();
    this.listeners.clear();
  }

  private async run(
    record: UploadRecord,
    operation: () => Promise<WorkbenchUploadSnapshot>,
  ): Promise<void> {
    try {
      const snapshot = await operation();
      if (this.records.has(record.id)) this.applySnapshot(record, snapshot);
    } catch (error) {
      if (this.records.has(record.id)) {
        const snapshot = record.controller.getSnapshot();
        this.applySnapshot(record, snapshot);
        const awaitsUserRecovery = snapshot.phase === "failed"
          && snapshot.error?.retryable === true;
        if (!awaitsUserRecovery && !record.settlement.settled) {
          record.settlement.reject(error);
        }
      }
      throw error;
    }
  }

  private applySnapshot(record: UploadRecord, snapshot: WorkbenchUploadSnapshot): void {
    record.snapshot = snapshot;
    record.progress = Math.max(record.progress, projectedProgress(snapshot));
    if (snapshot.phase === "ready") {
      if (!snapshot.fileAssetId) {
        record.settlement.reject(new Error(`File ${snapshot.fileName} is ready without a File Asset id`));
      } else {
        record.settlement.resolve(snapshot.fileAssetId);
      }
    } else if (snapshot.phase === "cancelled") {
      record.settlement.resolve(null);
    } else if (snapshot.phase === "failed" && snapshot.error?.retryable === false) {
      record.settlement.reject(new Error(snapshot.error.message));
    }
    this.emit();
  }

  private releaseBatch(batchId: string, reason?: unknown): void {
    this.batchProjects.delete(batchId);
    for (const record of [...this.records.values()]) {
      if (record.batchId === batchId) this.releaseRecord(record, reason);
    }
    this.emit();
  }

  private releaseRecord(record: UploadRecord, reason?: unknown): void {
    if (!this.records.delete(record.id)) return;
    record.unsubscribe();
    // Local disposal deliberately does not call cancel(): completed server-side
    // verification/extraction continues, and multipart checkpoints remain resumable.
    record.controller.destroy();
    if (!record.settlement.settled) {
      record.settlement.reject(reason ?? new WorkbenchUploadBatchDisposedError(record.snapshot.projectId));
    }
  }

  private requireRecord(id: string): UploadRecord {
    this.assertActive();
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown Workbench upload ${id}`);
    return record;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Workbench upload registry has been disposed");
  }

  private emit(): void {
    this.state = {
      uploads: [...this.records.values()].map(toViewModel),
    };
    for (const listener of this.listeners) listener();
  }
}

export function useWorkbenchUploadRegistry(service: WorkbenchFileTransferService) {
  const registry = useMemo(() => new WorkbenchUploadRegistry({ service }), [service]);
  const disposalTokens = useRef(new WeakMap<WorkbenchUploadRegistry, symbol>());
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );

  useEffect(() => {
    const token = Symbol("workbench-upload-registry-lifetime");
    disposalTokens.current.set(registry, token);
    return () => {
      // React Strict Mode replays effects with the same memoized registry. Defer
      // disposal so the replayed setup can claim it before real unmount cleanup.
      queueMicrotask(() => {
        if (disposalTokens.current.get(registry) !== token) return;
        disposalTokens.current.delete(registry);
        registry.dispose();
      });
    };
  }, [registry]);

  return {
    uploads: snapshot.uploads,
    uploadFiles: useCallback(
      (projectId: string, inputs: readonly WorkbenchUploadInput[]) => (
        registry.uploadFiles(projectId, inputs)
      ),
      [registry],
    ),
    pauseUpload: useCallback((id: string) => registry.pause(id), [registry]),
    resumeUpload: useCallback((id: string) => registry.resume(id), [registry]),
    retryUpload: useCallback((id: string) => registry.retry(id), [registry]),
    cancelUpload: useCallback((id: string) => registry.cancel(id), [registry]),
    completeUploadBatch: useCallback((batchId: string | null) => registry.completeBatch(batchId), [registry]),
    releaseProjectUploads: useCallback((projectId: string) => registry.releaseProject(projectId), [registry]),
  };
}

function toViewModel(record: UploadRecord): WorkbenchUploadItemViewModel {
  const snapshot = record.snapshot;
  const canCancel = snapshot.submissionIntent === null && (
    ["queued", "preparing", "uploading", "paused"].includes(snapshot.phase)
      || (snapshot.phase === "failed" && snapshot.file === null)
  );
  return {
    id: record.id,
    controllerId: snapshot.id,
    projectId: snapshot.projectId,
    fileName: snapshot.fileName,
    byteSize: snapshot.byteSize,
    phase: snapshot.phase,
    stage: uploadStage(snapshot),
    statusLabel: uploadStatusLabel(snapshot),
    progress: Math.round(record.progress),
    hashPercent: snapshot.hashPercent,
    uploadPercent: snapshot.uploadPercent,
    error: snapshot.error ? { ...snapshot.error } : null,
    submissionIntentId: snapshot.submissionIntent?.submissionIntentId ?? null,
    actionPending: record.actionPending,
    canPause: snapshot.phase === "uploading" && record.actionPending === null,
    canResume: snapshot.phase === "paused" && record.actionPending === null,
    canCancel: canCancel && record.actionPending === null,
    canRetry: snapshot.phase === "failed"
      && snapshot.error?.retryable === true
      && record.actionPending === null,
  };
}

function uploadStage(snapshot: WorkbenchUploadSnapshot): WorkbenchUploadStage {
  if (snapshot.phase === "queued" || snapshot.phase === "preparing") return "hash";
  if (snapshot.phase === "uploading" || snapshot.phase === "paused") return "upload";
  if (snapshot.phase === "verifying") return "verify";
  if (snapshot.phase === "extracting") return "extract";
  return snapshot.phase;
}

function uploadStatusLabel(snapshot: WorkbenchUploadSnapshot): string {
  if (snapshot.phase === "queued" || snapshot.phase === "preparing") return "正在计算文件哈希";
  if (snapshot.phase === "uploading") return "正在上传";
  if (snapshot.phase === "paused") return "上传已暂停";
  if (snapshot.phase === "verifying") return "正在校验文件";
  if (snapshot.phase === "extracting") return "正在提取内容";
  if (snapshot.phase === "ready") return "文件已就绪";
  if (snapshot.phase === "cancelled") return "上传已取消";
  if (snapshot.error?.code === "UPLOAD_CANCEL_FAILED") return "取消失败";
  return "处理失败";
}

function projectedProgress(snapshot: WorkbenchUploadSnapshot): number {
  if (snapshot.phase === "queued" || snapshot.phase === "preparing") {
    return Math.min(15, snapshot.hashPercent * 0.15);
  }
  if (snapshot.phase === "uploading" || snapshot.phase === "paused") {
    return 15 + (snapshot.uploadPercent * 0.75);
  }
  if (snapshot.phase === "verifying") return 92;
  if (snapshot.phase === "extracting") return 96;
  if (snapshot.phase === "ready") return 100;
  return 0;
}

function shouldExtractFile(file: File): boolean {
  return !file.type.startsWith("image/") && !file.type.startsWith("font/");
}

function createSettlement<T>(): Settlement<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const settlement: Settlement<T> = {
    settled: false,
    promise,
    resolve: (_value: T) => undefined,
    reject: (_reason?: unknown) => undefined,
  };
  settlement.resolve = (value: T) => {
    if (settlement.settled) return;
    settlement.settled = true;
    resolvePromise(value);
  };
  settlement.reject = (reason?: unknown) => {
    if (settlement.settled) return;
    settlement.settled = true;
    rejectPromise(reason);
  };
  return settlement;
}
