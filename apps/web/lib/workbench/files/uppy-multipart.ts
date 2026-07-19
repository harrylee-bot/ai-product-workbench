"use client";

import AwsS3, {
  type AwsS3Part,
  type AwsS3UploadParameters,
} from "@uppy/aws-s3";
import { Uppy } from "@uppy/core";
import {
  maximumUserUploadByteSize,
  completeFileUploadRequestSchema,
  createFileUploadRequestSchema,
  fileNameSchema,
  isoDateTimeSchema,
  listUploadPartsResponseSchema,
  mediaTypeSchema,
  multipartEtagSchema,
  opaqueIdSchema,
  safeIntegerSchema,
  sha256Schema,
  submissionIntentUploadBindingSchema,
  uploadPartSizeSchema,
  type CompleteFileUploadRequest,
  type CompleteFileUploadResponse,
  type CreateFileUploadRequest,
  type CreateFileUploadResponse,
  type FileAsset,
  type FileExtraction,
  type FileUploadSession,
  type ListUploadPartsResponse,
  type SignUploadPartRequest,
  type SignUploadPartResponse,
  type SubmissionIntentUploadBinding,
} from "@workbench/workbench-contracts";
import { z } from "zod";

import { isWorkbenchApiError } from "../api/problem-details";
import {
  createIdempotencyKey,
  normalizeIdempotencyKey,
  type Versioned,
} from "../transport/contracts";
import {
  getDefaultWorkbenchUploadCheckpointStore,
} from "./upload-checkpoint-store";
import { sha256Blob } from "./upload-digest";
import {
  projectUploadLifecycle,
  type UploadLifecycleError,
  type UploadLifecyclePhase,
} from "./upload-lifecycle";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1_000;

export { sha256Blob } from "./upload-digest";

type AdapterMeta = {
  workbenchLocalUploadId: string;
};

type AdapterResponse = {
  location?: string;
};

export interface WorkbenchFileTransferService {
  createFileUpload(
    projectId: string,
    request: CreateFileUploadRequest,
    idempotencyKey?: string,
  ): Promise<Versioned<CreateFileUploadResponse>>;
  getFile(fileId: string): Promise<Versioned<FileAsset>>;
  createFileExtraction(
    fileId: string,
    ifMatch: string,
    idempotencyKey?: string,
  ): Promise<Versioned<FileExtraction>>;
  getFileUpload(uploadSessionId: string): Promise<Versioned<FileUploadSession>>;
  abortFileUpload(uploadSessionId: string, ifMatch: string): Promise<void>;
  listFileUploadParts(uploadSessionId: string): Promise<ListUploadPartsResponse>;
  signFileUploadPart(
    uploadSessionId: string,
    partNumber: number,
    request: SignUploadPartRequest,
    ifMatch: string,
  ): Promise<Versioned<SignUploadPartResponse>>;
  completeFileUpload(
    uploadSessionId: string,
    request: CompleteFileUploadRequest,
    ifMatch: string,
    idempotencyKey?: string,
  ): Promise<Versioned<CompleteFileUploadResponse>>;
}

export type WorkbenchUploadCheckpoint = {
  schemaVersion: 1;
  localUploadId: string;
  fingerprint: string;
  projectId: string;
  fileName: string;
  declaredMediaType: string;
  byteSize: number;
  lastModified: number;
  createIdempotencyKey: string;
  completionIdempotencyKey: string;
  extractionIdempotencyKey: string;
  submissionIntent: SubmissionIntentUploadBinding | null;
  clientSha256Hint: string | null;
  session: {
    fileAssetId: string;
    uploadSessionId: string;
    uploadEtag: string;
    partSize: number;
    expiresAt: string;
  } | null;
};

export interface WorkbenchUploadCheckpointStore {
  load(projectId: string, fingerprint: string): Promise<WorkbenchUploadCheckpoint | null>;
  save(checkpoint: WorkbenchUploadCheckpoint): Promise<void>;
  remove(projectId: string, fingerprint: string): Promise<void>;
}

export type WorkbenchUploadPhase = UploadLifecyclePhase;
export type WorkbenchUploadError = UploadLifecycleError;

export type WorkbenchUploadSnapshot = {
  id: string;
  projectId: string;
  fileAssetId: string | null;
  uploadSessionId: string | null;
  fileName: string;
  declaredMediaType: string;
  byteSize: number;
  phase: WorkbenchUploadPhase;
  /** Whether this controller was recreated from a durable checkpoint. */
  recoveryState: "new" | "restored";
  bytesUploaded: number;
  uploadPercent: number;
  bytesHashed: number;
  hashPercent: number;
  clientSha256Hint: string | null;
  submissionIntent: SubmissionIntentUploadBinding | null;
  file: FileAsset | null;
  extraction: FileExtraction | null;
  error: WorkbenchUploadError | null;
};

export type WorkbenchUploadPartRequest = {
  method: "PUT";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Blob;
  signal?: AbortSignal;
  reportProgress(bytesUploaded: number): void;
};

export type WorkbenchUploadPartTransport = (
  request: WorkbenchUploadPartRequest,
) => Promise<{ etag: string }>;

export type WorkbenchMultipartUploadOptions = {
  projectId: string;
  file: File;
  service: WorkbenchFileTransferService;
  checkpoint?: WorkbenchUploadCheckpoint | null;
  checkpointStore?: WorkbenchUploadCheckpointStore;
  submissionIntent?: SubmissionIntentUploadBinding;
  requestExtraction?: boolean;
  retryDelays?: readonly number[];
  concurrency?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  partTransport?: WorkbenchUploadPartTransport;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  localUploadId: z.string().min(1).max(128),
  fingerprint: z.string().min(1).max(2_000),
  projectId: opaqueIdSchema,
  fileName: fileNameSchema,
  declaredMediaType: mediaTypeSchema,
  byteSize: safeIntegerSchema.positive(),
  lastModified: safeIntegerSchema,
  createIdempotencyKey: z.string(),
  completionIdempotencyKey: z.string(),
  extractionIdempotencyKey: z.string(),
  submissionIntent: submissionIntentUploadBindingSchema.nullable().optional().default(null),
  clientSha256Hint: sha256Schema.nullable(),
  session: z.object({
    fileAssetId: opaqueIdSchema,
    uploadSessionId: opaqueIdSchema,
    uploadEtag: z.string(),
    partSize: uploadPartSizeSchema,
    expiresAt: isoDateTimeSchema,
  }).strict().nullable(),
}).strict();

export class WorkbenchUploadCheckpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkbenchUploadCheckpointError";
  }
}

export class WorkbenchUploadStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchUploadStateError";
  }
}

export class WorkbenchUploadPollingTimeoutError extends Error {
  constructor(readonly fileAssetId: string) {
    super(`Timed out while waiting for File ${fileAssetId} processing`);
    this.name = "WorkbenchUploadPollingTimeoutError";
  }
}

export async function createWorkbenchMultipartUpload(
  options: WorkbenchMultipartUploadOptions,
): Promise<WorkbenchMultipartUpload> {
  const declaredMediaType = normalizeDeclaredMediaType(options.file.type);
  createFileUploadRequestSchema.parse({
    fileName: options.file.name,
    declaredMediaType,
    byteSize: options.file.size,
    submissionIntent: options.submissionIntent,
  });
  validateControllerOptions(options);

  const checkpointStore = options.checkpointStore ?? getDefaultWorkbenchUploadCheckpointStore();
  const submissionIntent = options.submissionIntent
    ? submissionIntentUploadBindingSchema.parse(options.submissionIntent)
    : null;
  const fingerprint = createWorkbenchCheckpointFingerprint(
    options.projectId,
    options.file,
    submissionIntent,
  );
  const candidate = options.checkpoint
    ?? await checkpointStore?.load(options.projectId, fingerprint)
    ?? null;
  const checkpoint = candidate
    ? parseCheckpoint(
        candidate,
        options.projectId,
        options.file,
        fingerprint,
        declaredMediaType,
        submissionIntent,
      )
    : createCheckpoint(
        options.projectId,
        options.file,
        fingerprint,
        declaredMediaType,
        submissionIntent,
      );

  return new WorkbenchMultipartUpload(options, checkpoint, candidate !== null, checkpointStore);
}

export function createWorkbenchFileFingerprint(projectId: string, file: File): string {
  return [
    "workbench-file-v1",
    encodeURIComponent(projectId),
    String(file.size),
    String(file.lastModified),
    encodeURIComponent(normalizeDeclaredMediaType(file.type)),
    encodeURIComponent(file.name),
  ].join(":");
}

function createWorkbenchCheckpointFingerprint(
  projectId: string,
  file: File,
  submissionIntent: SubmissionIntentUploadBinding | null,
): string {
  if (!submissionIntent) return createWorkbenchFileFingerprint(projectId, file);
  return [
    "workbench-submission-file-v1",
    encodeURIComponent(projectId),
    encodeURIComponent(submissionIntent.submissionIntentId),
    String(submissionIntent.attachmentPosition),
    encodeURIComponent(submissionIntent.clientFingerprint),
  ].join(":");
}

export class WorkbenchMultipartUpload {
  private readonly service: WorkbenchFileTransferService;
  private readonly file: File;
  private readonly checkpointStore?: WorkbenchUploadCheckpointStore;
  private readonly requestExtraction: boolean;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly restoredCheckpointDigest: string | null;
  private readonly isRestoringPersistedCheckpoint: boolean;
  private readonly lifecycleAbort = new AbortController();
  private readonly hashAbort = new AbortController();
  private readonly listeners = new Set<(snapshot: WorkbenchUploadSnapshot) => void>();
  private readonly uppy: Uppy<AdapterMeta, AdapterResponse>;
  private readonly uppyFileId: string;
  private checkpoint: WorkbenchUploadCheckpoint;
  private uploadStatus: FileUploadSession["status"] | null = null;
  private hashPromise: Promise<string>;
  private activePromise: Promise<WorkbenchUploadSnapshot> | null = null;
  private cancellationPromise: Promise<void> | null = null;
  private sessionPreparationPromise: Promise<void> | null = null;
  private checkpointWrite: Promise<void> = Promise.resolve();
  private checkpointRemoved = false;
  private cancelRequested = false;
  private completionStarted = false;
  private createCommandStarted = false;
  private createRequest: Readonly<CreateFileUploadRequest> | null = null;
  private destroyed = false;
  private uppyFilePresent = false;
  private snapshot: WorkbenchUploadSnapshot;

  constructor(
    options: WorkbenchMultipartUploadOptions,
    checkpoint: WorkbenchUploadCheckpoint,
    isRestoringPersistedCheckpoint: boolean,
    checkpointStore?: WorkbenchUploadCheckpointStore,
  ) {
    this.service = options.service;
    this.file = options.file;
    this.checkpoint = copyCheckpoint(checkpoint);
    this.isRestoringPersistedCheckpoint = isRestoringPersistedCheckpoint;
    this.restoredCheckpointDigest = checkpoint.clientSha256Hint;
    this.checkpointStore = checkpointStore ?? options.checkpointStore;
    this.requestExtraction = options.requestExtraction ?? false;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
    this.snapshot = {
      id: checkpoint.localUploadId,
      projectId: checkpoint.projectId,
      fileAssetId: checkpoint.session?.fileAssetId ?? null,
      uploadSessionId: checkpoint.session?.uploadSessionId ?? null,
      fileName: checkpoint.fileName,
      declaredMediaType: checkpoint.declaredMediaType,
      byteSize: checkpoint.byteSize,
      phase: "queued",
      recoveryState: isRestoringPersistedCheckpoint ? "restored" : "new",
      bytesUploaded: 0,
      uploadPercent: 0,
      bytesHashed: 0,
      hashPercent: 0,
      clientSha256Hint: checkpoint.clientSha256Hint,
      submissionIntent: checkpoint.submissionIntent
        ? { ...checkpoint.submissionIntent }
        : null,
      file: null,
      extraction: null,
      error: null,
    };

    this.uppy = new Uppy<AdapterMeta, AdapterResponse>({
      id: `workbench-${checkpoint.localUploadId}`,
      autoProceed: false,
      allowMultipleUploadBatches: false,
      restrictions: {
        minFileSize: 1,
        maxNumberOfFiles: 1,
        maxFileSize: maximumUserUploadByteSize,
      },
    });
    this.installMultipartPlugin(options);
    this.installEventProjection();
    this.uppyFileId = this.uppy.addFile({
      source: "workbench",
      name: this.file.name,
      type: checkpoint.declaredMediaType,
      data: this.file,
      meta: { workbenchLocalUploadId: checkpoint.localUploadId },
    });
    this.uppyFilePresent = true;
    this.hashPromise = this.computeClientDigest();
    void this.hashPromise.catch(() => undefined);
  }

  getSnapshot(): WorkbenchUploadSnapshot {
    return copySnapshot(this.snapshot);
  }

  getCheckpoint(): WorkbenchUploadCheckpoint {
    return copyCheckpoint(this.checkpoint);
  }

  subscribe(listener: (snapshot: WorkbenchUploadSnapshot) => void): () => void {
    this.assertNotDestroyed();
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  start(): Promise<WorkbenchUploadSnapshot> {
    this.assertNotDestroyed();
    if (this.cancelRequested) {
      return Promise.reject(new WorkbenchUploadStateError("A cancelled upload cannot be started"));
    }
    if (this.snapshot.phase === "cancelled") {
      return Promise.reject(new WorkbenchUploadStateError("A cancelled upload cannot be started"));
    }
    if (this.snapshot.phase === "ready") return Promise.resolve(this.getSnapshot());
    if (this.activePromise) return this.activePromise;
    const operation = this.runUpload(false);
    const tracked = operation.finally(() => {
      if (this.activePromise === tracked) this.activePromise = null;
    });
    this.activePromise = tracked;
    return this.activePromise;
  }

  pause(): boolean {
    this.assertNotDestroyed();
    if (this.snapshot.phase !== "uploading") return false;
    const paused = this.uppy.pauseResume(this.uppyFileId);
    return paused === true;
  }

  resume(): boolean {
    this.assertNotDestroyed();
    if (this.snapshot.phase !== "paused") return false;
    const paused = this.uppy.pauseResume(this.uppyFileId);
    return paused === false;
  }

  async retry(): Promise<WorkbenchUploadSnapshot> {
    this.assertNotDestroyed();
    if (this.cancelRequested) {
      throw new WorkbenchUploadStateError(
        "Upload retry is unavailable after cancellation; retry the cancel command instead",
      );
    }
    if (this.snapshot.phase !== "failed") {
      throw new WorkbenchUploadStateError("Only a failed upload can be retried");
    }
    if (this.snapshot.error?.retryable === false) {
      throw new WorkbenchUploadStateError("This File failure is terminal and cannot be retried as an upload");
    }
    if (this.activePromise) return this.activePromise;
    const operation = this.runUpload(true);
    const tracked = operation.finally(() => {
      if (this.activePromise === tracked) this.activePromise = null;
    });
    this.activePromise = tracked;
    return this.activePromise;
  }

  async refresh(): Promise<WorkbenchUploadSnapshot> {
    this.assertNotDestroyed();
    const session = this.requireSession();
    const result = await this.service.getFile(session.fileAssetId);
    this.applyFile(result);
    return this.getSnapshot();
  }

  cancel(): Promise<void> {
    this.assertNotDestroyed();
    if (this.cancellationPromise) return this.cancellationPromise;
    if (this.completionStarted || ["verifying", "extracting", "ready"].includes(this.snapshot.phase)) {
      return Promise.reject(
        new WorkbenchUploadStateError("A completed upload must be removed through the File delete command"),
      );
    }
    this.cancelRequested = true;
    const operation = this.runCancellation();
    const tracked = operation.finally(() => {
      if (this.cancellationPromise === tracked) this.cancellationPromise = null;
    });
    this.cancellationPromise = tracked;
    return tracked;
  }

  private async runCancellation(): Promise<void> {
    this.stopLocalUpload();
    this.lifecycleAbort.abort("upload cancelled");
    this.hashAbort.abort("upload cancelled");
    try {
      const preparation = this.sessionPreparationPromise;
      if (preparation) {
        try {
          await preparation;
        } catch {
          // The create command is idempotent. Replay it so a response lost during
          // cancellation cannot leave an unknown multipart session behind.
          if (this.createCommandStarted && !this.checkpoint.session) {
            await this.createOrReplaySession();
          }
        }
      }
      const session = this.checkpoint.session;
      if (session) await this.abortServerUpload(session);
      this.patchSnapshot({ phase: "cancelled", error: null });
      await this.removeCheckpoint();
    } catch (error) {
      const failure = publicError(error, true);
      this.patchSnapshot({
        phase: "failed",
        error: {
          code: "UPLOAD_CANCEL_FAILED",
          message: failure.message,
          retryable: true,
        },
      });
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifecycleAbort.abort("upload controller destroyed");
    this.hashAbort.abort("upload controller destroyed");
    this.listeners.clear();
    this.uppy.destroy();
    this.uppyFilePresent = false;
  }

  private installMultipartPlugin(options: WorkbenchMultipartUploadOptions) {
    const pluginOptions = {
      shouldUseMultipart: true as const,
      allowedMetaFields: false,
      limit: options.concurrency ?? 4,
      retryDelays: options.retryDelays ? [...options.retryDelays] : [0, 1_000, 3_000, 5_000],
      getChunkSize: () => this.requireSession().partSize,
      createMultipartUpload: async () => {
        await this.ensureSession();
        const session = this.requireSession();
        return { uploadId: session.uploadSessionId, key: session.fileAssetId };
      },
      listParts: async (_file: unknown, state: { uploadId?: string; key: string }) => {
        const session = this.assertMultipartState(state);
        const result = listUploadPartsResponseSchema.parse(
          await this.service.listFileUploadParts(session.uploadSessionId),
        );
        return resumableUploadParts(this.file.size, session.partSize, result.parts).map<AwsS3Part>((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
          Size: part.byteSize,
        }));
      },
      // Uppy invokes this callback after exhausted transport retries too. Server
      // abort is reserved for the explicit cancel() command so manual retry can resume parts.
      abortMultipartUpload: async () => undefined,
      signPart: async (_file: unknown, state: {
        uploadId: string;
        key: string;
        partNumber: number;
        body: Blob;
        signal?: AbortSignal;
      }): Promise<AwsS3UploadParameters> => {
        const session = this.assertMultipartState(state);
        throwIfAborted(state.signal);
        const signed = await this.signPartWithRevisionRefresh(
          session,
          state.partNumber,
          state.body.size,
        );
        throwIfAborted(state.signal);
        return {
          method: signed.value.method,
          url: signed.value.url,
          headers: signed.value.headers,
          expires: Math.max(1, Math.floor((Date.parse(signed.value.expiresAt) - this.now()) / 1_000)),
        };
      },
      completeMultipartUpload: async (_file: unknown, state: {
        uploadId: string;
        key: string;
        parts: AwsS3Part[];
        signal: AbortSignal;
      }): Promise<AdapterResponse> => {
        const session = this.assertMultipartState(state);
        throwIfAborted(state.signal);
        const parts = state.parts.map((part) => {
          if (part.PartNumber === undefined || part.ETag === undefined) {
            throw new WorkbenchUploadStateError("Uppy returned an incomplete multipart result");
          }
          return { partNumber: part.PartNumber, etag: part.ETag };
        }).sort((left, right) => left.partNumber - right.partNumber);
        const clientSha256Hint = await this.hashPromise;
        const request = completeFileUploadRequestSchema.parse({
          parts,
          sha256: clientSha256Hint,
        });
        throwIfAborted(state.signal);
        if (this.cancelRequested) throw new DOMException("The upload was cancelled", "AbortError");
        this.completionStarted = true;
        this.patchSnapshot({ phase: "verifying", error: null });
        try {
          const result = await this.service.completeFileUpload(
            session.uploadSessionId,
            request,
            session.uploadEtag,
            this.checkpoint.completionIdempotencyKey,
          );
          this.updateSession(result.value.upload, result.etag);
          this.uploadStatus = result.value.upload.status;
          const projection = projectUploadLifecycle(result.value.file, this.requestExtraction);
          this.patchSnapshot({
            file: result.value.file,
            fileAssetId: result.value.file.id,
            ...projection,
          });
          await this.persistCheckpoint();
          return {};
        } finally {
          this.completionStarted = false;
        }
      },
      ...(options.partTransport
        ? { uploadPartBytes: createUppyPartTransport(options.partTransport) }
        : {}),
    };
    this.uppy.use(AwsS3<AdapterMeta, AdapterResponse>, pluginOptions);
  }

  private installEventProjection() {
    this.uppy.on("upload-start", () => {
      this.patchSnapshot({ phase: "uploading", error: null });
    });
    this.uppy.on("upload-progress", (file, progress) => {
      if (!file || file.id !== this.uppyFileId) return;
      const bytesUploaded = Math.min(this.file.size, progress.bytesUploaded);
      this.patchSnapshot({
        bytesUploaded,
        uploadPercent: percentage(bytesUploaded, this.file.size),
      });
    });
    this.uppy.on("upload-pause", (file, isPaused) => {
      if (!file || file.id !== this.uppyFileId) return;
      this.patchSnapshot({ phase: isPaused ? "paused" : "uploading" });
    });
    this.uppy.on("upload-error", (file, error) => {
      if (file && file.id !== this.uppyFileId) return;
      if (this.cancelRequested || this.snapshot.phase === "cancelled") return;
      this.patchSnapshot({ phase: "failed", error: publicError(error, true) });
    });
  }

  private async runUpload(retry: boolean): Promise<WorkbenchUploadSnapshot> {
    try {
      this.lifecycleAbort.signal.throwIfAborted();
      await this.ensureSession();
      this.lifecycleAbort.signal.throwIfAborted();
      const session = this.requireSession();

      if (this.uploadStatus === "completed") {
        await this.pollFileLifecycle(session.fileAssetId);
        return this.getSnapshot();
      }
      if (!this.uploadStatus || !["initiated", "completing"].includes(this.uploadStatus)) {
        throw new WorkbenchUploadStateError(`Upload session cannot transfer while ${this.uploadStatus ?? "unknown"}`);
      }

      this.seedUppyMultipartState(session);
      this.patchSnapshot({ phase: "uploading", error: null });
      if (retry) await this.uppy.retryUpload(this.uppyFileId);
      else await this.uppy.upload();
      if (this.snapshot.phase === "failed" || this.snapshot.phase === "cancelled") {
        return this.getSnapshot();
      }
      await this.pollFileLifecycle(session.fileAssetId);
    } catch (error) {
      if (this.lifecycleAbort.signal.aborted && this.cancellationPromise) {
        await this.cancellationPromise.catch(() => undefined);
      } else if (this.snapshot.phase !== "cancelled"
        && !this.lifecycleAbort.signal.aborted
        && !isAbortError(error)) {
        this.patchSnapshot({ phase: "failed", error: publicError(error, true) });
      }
    }
    return this.getSnapshot();
  }

  private ensureSession(): Promise<void> {
    if (this.sessionPreparationPromise) return this.sessionPreparationPromise;
    const operation = this.prepareSession();
    const tracked = operation.finally(() => {
      if (this.sessionPreparationPromise === tracked) this.sessionPreparationPromise = null;
    });
    this.sessionPreparationPromise = tracked;
    return tracked;
  }

  private async prepareSession(): Promise<void> {
    this.patchSnapshot({ phase: "preparing", error: null });
    const digest = await this.hashPromise;
    throwIfAborted(this.lifecycleAbort.signal);
    if (this.isRestoringPersistedCheckpoint) await this.assertRestoredFileIdentity(digest);
    this.freezeCreateRequest(digest);
    this.checkpoint.clientSha256Hint = digest;
    await this.persistCheckpoint();
    throwIfAborted(this.lifecycleAbort.signal);
    const existing = this.checkpoint.session;
    if (!existing) {
      await this.createOrReplaySession();
      return;
    }

    let current: Versioned<FileUploadSession>;
    try {
      current = await this.service.getFileUpload(existing.uploadSessionId);
    } catch (error) {
      // A browser can retain a checkpoint after server-side lifecycle cleanup.
      // The opaque session is no longer a safe source for retry; start a fresh
      // idempotent command while preserving the digest-bound File identity.
      if (isWorkbenchApiError(error) && error.status === 404) {
        await this.resetForFreshSession();
        await this.createOrReplaySession();
        return;
      }
      throw error;
    }
    if (current.value.fileAssetId !== existing.fileAssetId) {
      throw new WorkbenchUploadCheckpointError("Upload session no longer belongs to the checkpoint File");
    }
    this.updateSession(current.value, current.etag);
    this.uploadStatus = current.value.status;

    if (current.value.status === "initiating") {
      await this.createOrReplaySession();
      return;
    }
    if (["initiated", "completing", "completed"].includes(current.value.status)) {
      if (current.value.status === "completed") {
        const file = await this.service.getFile(current.value.fileAssetId);
        this.applyFile(file);
      }
      await this.persistCheckpoint();
      return;
    }
    if (["aborted", "expired", "failed"].includes(current.value.status)) {
      // Reconcile the old provider session before replacing its checkpoint. The
      // server abort is idempotent and keeps expired/failed multipart objects
      // from relying solely on bucket lifecycle cleanup.
      await this.abortServerUpload(this.requireSession());
      await this.resetForFreshSession();
      await this.createOrReplaySession();
      return;
    }
    throw new WorkbenchUploadStateError(`Upload session is ${current.value.status} and cannot be resumed`);
  }

  private async resetForFreshSession(): Promise<void> {
    if (this.checkpoint.submissionIntent) {
      throw new WorkbenchUploadStateError(
        "The durable submission upload session can no longer be resumed; cancel and retry the submission",
      );
    }
    await this.removeCheckpoint();
    this.checkpoint = {
      ...this.checkpoint,
      createIdempotencyKey: createIdempotencyKey("upload"),
      completionIdempotencyKey: createIdempotencyKey("complete"),
      extractionIdempotencyKey: createIdempotencyKey("extract"),
      session: null,
    };
    this.checkpointRemoved = false;
    this.createCommandStarted = false;
    this.uploadStatus = null;
    this.patchSnapshot({
      fileAssetId: null,
      uploadSessionId: null,
      file: null,
      extraction: null,
      phase: "preparing",
      error: null,
    });
    await this.persistCheckpoint();
  }

  private async createOrReplaySession(): Promise<void> {
    const request = this.requireCreateRequest();
    this.createCommandStarted = true;
    const result = await this.service.createFileUpload(
      this.checkpoint.projectId,
      request,
      this.checkpoint.createIdempotencyKey,
    );
    this.assertCreatedFile(result.value.file);
    this.updateSession(result.value.upload, result.etag);
    this.uploadStatus = result.value.upload.status;
    this.patchSnapshot({
      fileAssetId: result.value.file.id,
      uploadSessionId: result.value.upload.id,
      file: result.value.file,
    });
    await this.persistCheckpoint();
  }

  private async assertRestoredFileIdentity(digest: string): Promise<void> {
    if (this.restoredCheckpointDigest === digest) return;

    const reason = this.restoredCheckpointDigest
      ? "Selected File bytes do not match the persisted multipart upload"
      : "Persisted multipart upload has no digest proof and cannot be resumed safely";
    if (this.checkpoint.session) await this.discardUnsafeRestoredSession();
    else await this.removeCheckpoint();
    throw new WorkbenchUploadCheckpointError(reason);
  }

  private async discardUnsafeRestoredSession(): Promise<void> {
    const session = this.checkpoint.session;
    if (!session) return;
    try {
      const current = await this.service.getFileUpload(session.uploadSessionId);
      if (current.value.fileAssetId !== session.fileAssetId) {
        await this.removeCheckpoint();
        this.checkpoint.session = null;
        return;
      }
      this.updateSession(current.value, current.etag);
      if (["initiating", "initiated", "aborting", "aborted", "expired", "failed"].includes(current.value.status)) {
        await this.abortServerUpload(this.requireSession());
      }
    } catch (error) {
      if (!isWorkbenchApiError(error) || error.status !== 404) throw error;
    }
    await this.removeCheckpoint();
    this.checkpoint.session = null;
  }

  private async signPartWithRevisionRefresh(
    session: NonNullable<WorkbenchUploadCheckpoint["session"]>,
    partNumber: number,
    contentLength: number,
  ): Promise<Versioned<SignUploadPartResponse>> {
    try {
      return await this.signPart(session, partNumber, contentLength);
    } catch (error) {
      if (!isWorkbenchApiError(error) || error.status !== 412) throw error;
      const current = await this.service.getFileUpload(session.uploadSessionId);
      if (current.value.fileAssetId !== session.fileAssetId || current.value.status !== "initiated") {
        throw error;
      }
      this.updateSession(current.value, current.etag);
      await this.persistCheckpoint();
      return this.signPart(this.requireSession(), partNumber, contentLength);
    }
  }

  private async signPart(
    session: NonNullable<WorkbenchUploadCheckpoint["session"]>,
    partNumber: number,
    contentLength: number,
  ) {
    const result = await this.service.signFileUploadPart(
      session.uploadSessionId,
      partNumber,
      { contentLength },
      session.uploadEtag,
    );
    if (result.value.uploadSessionId !== session.uploadSessionId
      || result.value.partNumber !== partNumber) {
      throw new WorkbenchUploadStateError("Part signature does not match the requested upload session");
    }
    session.uploadEtag = result.etag;
    return result;
  }

  private async pollFileLifecycle(fileAssetId: string): Promise<void> {
    const deadline = this.now() + this.pollTimeoutMs;
    while (true) {
      throwIfAborted(this.lifecycleAbort.signal);
      const result = await this.service.getFile(fileAssetId);
      const file = result.value;
      const projection = this.applyFile(result);

      if (projection.phase === "failed" || projection.phase === "ready") {
        await this.removeCheckpoint();
        return;
      }

      if (file.status === "ready") {
        if (!this.requestExtraction) {
          throw new WorkbenchUploadStateError("Ready File lifecycle projection did not terminate");
        }
        const extraction = file.latestExtraction ?? file.currentExtraction;
        if (!extraction) {
          const queued = await this.service.createFileExtraction(
            file.id,
            result.etag,
            this.checkpoint.extractionIdempotencyKey,
          );
          const createdProjection = projectUploadLifecycle({
            ...file,
            latestExtraction: queued.value,
          }, true);
          this.patchSnapshot(createdProjection);
          if (createdProjection.phase === "failed" || createdProjection.phase === "ready") {
            await this.removeCheckpoint();
            return;
          }
        }
      }

      if (this.now() >= deadline) throw new WorkbenchUploadPollingTimeoutError(fileAssetId);
      await this.sleep(this.pollIntervalMs, this.lifecycleAbort.signal);
    }
  }

  private applyFile(result: Versioned<FileAsset>) {
    const projection = projectUploadLifecycle(result.value, this.requestExtraction);
    this.patchSnapshot({
      file: result.value,
      fileAssetId: result.value.id,
      ...projection,
    });
    return projection;
  }

  private async abortServerUpload(session: NonNullable<WorkbenchUploadCheckpoint["session"]>) {
    try {
      await this.service.abortFileUpload(session.uploadSessionId, session.uploadEtag);
    } catch (error) {
      if (!isWorkbenchApiError(error) || error.status !== 412) throw error;
      const current = await this.service.getFileUpload(session.uploadSessionId);
      if (current.value.fileAssetId !== session.fileAssetId) throw error;
      this.updateSession(current.value, current.etag);
      await this.service.abortFileUpload(current.value.id, current.etag);
    }
    this.uploadStatus = "aborted";
  }

  private updateSession(upload: FileUploadSession, uploadEtag: string) {
    normalizeEtagForCheckpoint(uploadEtag);
    const previous = this.checkpoint.session;
    if (previous && (
      previous.uploadSessionId !== upload.id
      || previous.fileAssetId !== upload.fileAssetId
      || previous.partSize !== upload.partSize
    )) {
      throw new WorkbenchUploadCheckpointError("Server upload session changed immutable checkpoint fields");
    }
    this.checkpoint.session = {
      fileAssetId: upload.fileAssetId,
      uploadSessionId: upload.id,
      uploadEtag,
      partSize: upload.partSize,
      expiresAt: upload.expiresAt,
    };
    this.patchSnapshot({
      fileAssetId: upload.fileAssetId,
      uploadSessionId: upload.id,
    });
  }

  private seedUppyMultipartState(session: NonNullable<WorkbenchUploadCheckpoint["session"]>) {
    this.uppy.setFileState(this.uppyFileId, {
      s3Multipart: {
        uploadId: session.uploadSessionId,
        key: session.fileAssetId,
      },
    } as never);
  }

  private assertMultipartState(state: { uploadId?: string; key: string }) {
    const session = this.requireSession();
    if (state.uploadId !== session.uploadSessionId || state.key !== session.fileAssetId) {
      throw new WorkbenchUploadStateError("Multipart state does not match the Workbench checkpoint");
    }
    return session;
  }

  private assertCreatedFile(file: FileAsset) {
    if (file.projectId !== this.checkpoint.projectId
      || file.originalName !== this.checkpoint.fileName
      || file.declaredMediaType !== this.checkpoint.declaredMediaType
      || file.byteSize !== this.checkpoint.byteSize) {
      throw new WorkbenchUploadCheckpointError("Created File does not match the local upload intent");
    }
  }

  private requireSession() {
    if (!this.checkpoint.session) {
      throw new WorkbenchUploadStateError("The Workbench upload session has not been prepared");
    }
    return this.checkpoint.session;
  }

  private async computeClientDigest(): Promise<string> {
    try {
      const digest = await sha256Blob(this.file, {
        signal: this.hashAbort.signal,
        onProgress: (bytesHashed) => this.patchSnapshot({
          bytesHashed,
          hashPercent: percentage(bytesHashed, this.file.size),
        }),
      });
      this.patchSnapshot({
        bytesHashed: this.file.size,
        hashPercent: 100,
        clientSha256Hint: digest,
      });
      return digest;
    } catch (error) {
      if (!isAbortError(error)) {
        this.patchSnapshot({ bytesHashed: 0, hashPercent: 0, clientSha256Hint: null });
      }
      throw error;
    }
  }

  private freezeCreateRequest(digest: string) {
    const request = createFileUploadRequestSchema.parse({
      fileName: this.checkpoint.fileName,
      declaredMediaType: this.checkpoint.declaredMediaType,
      byteSize: this.checkpoint.byteSize,
      sha256: digest,
      submissionIntent: this.checkpoint.submissionIntent ?? undefined,
    });
    if (this.createRequest) {
      if (this.createRequest.sha256 !== request.sha256) {
        throw new WorkbenchUploadStateError("The frozen upload create request changed");
      }
      return;
    }
    this.createRequest = Object.freeze(request);
  }

  private requireCreateRequest() {
    if (!this.createRequest) {
      throw new WorkbenchUploadStateError("The upload create request has not been frozen");
    }
    return this.createRequest;
  }

  private stopLocalUpload() {
    if (!this.uppyFilePresent) return;
    this.uppy.removeFile(this.uppyFileId);
    this.uppyFilePresent = false;
  }

  private async persistCheckpoint() {
    if (!this.checkpointStore || this.checkpointRemoved) return;
    const checkpoint = this.getCheckpoint();
    const write = this.checkpointWrite
      .catch(() => undefined)
      .then(() => this.checkpointStore?.save(checkpoint));
    this.checkpointWrite = write;
    await write;
  }

  private async removeCheckpoint() {
    if (!this.checkpointStore || this.checkpointRemoved) return;
    this.checkpointRemoved = true;
    try {
      await this.checkpointWrite.catch(() => undefined);
      await this.checkpointStore.remove(this.checkpoint.projectId, this.checkpoint.fingerprint);
    } catch (error) {
      this.checkpointRemoved = false;
      throw error;
    }
  }

  private patchSnapshot(patch: Partial<WorkbenchUploadSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.getSnapshot());
  }

  private assertNotDestroyed() {
    if (this.destroyed) throw new WorkbenchUploadStateError("Upload controller has been destroyed");
  }
}

function createCheckpoint(
  projectId: string,
  file: File,
  fingerprint: string,
  declaredMediaType: string,
  submissionIntent: SubmissionIntentUploadBinding | null,
): WorkbenchUploadCheckpoint {
  const position = submissionIntent?.attachmentPosition;
  const intentId = submissionIntent?.submissionIntentId;
  return {
    schemaVersion: 1,
    localUploadId: createIdempotencyKey("local"),
    fingerprint,
    projectId,
    fileName: file.name,
    declaredMediaType,
    byteSize: file.size,
    lastModified: file.lastModified,
    createIdempotencyKey: intentId === undefined
      ? createIdempotencyKey("upload")
      : `submission-upload:${intentId}:${position}`,
    completionIdempotencyKey: intentId === undefined
      ? createIdempotencyKey("complete")
      : `submission-complete:${intentId}:${position}`,
    extractionIdempotencyKey: intentId === undefined
      ? createIdempotencyKey("extract")
      : `submission-extract:${intentId}:${position}`,
    submissionIntent,
    clientSha256Hint: null,
    session: null,
  };
}

function parseCheckpoint(
  checkpoint: WorkbenchUploadCheckpoint,
  projectId: string,
  file: File,
  fingerprint: string,
  declaredMediaType: string,
  submissionIntent: SubmissionIntentUploadBinding | null,
) {
  const parsed = checkpointSchema.safeParse(checkpoint);
  if (!parsed.success) {
    throw new WorkbenchUploadCheckpointError("Stored upload checkpoint is invalid", {
      cause: parsed.error,
    });
  }
  for (const key of [
    parsed.data.createIdempotencyKey,
    parsed.data.completionIdempotencyKey,
    parsed.data.extractionIdempotencyKey,
  ]) normalizeIdempotencyKey(key);
  if (parsed.data.projectId !== projectId
    || parsed.data.fingerprint !== fingerprint
    || parsed.data.fileName !== file.name
    || parsed.data.declaredMediaType !== declaredMediaType
    || parsed.data.byteSize !== file.size
    || parsed.data.lastModified !== file.lastModified
    || !sameSubmissionIntentBinding(parsed.data.submissionIntent, submissionIntent)) {
    throw new WorkbenchUploadCheckpointError("Stored upload checkpoint belongs to a different File");
  }
  if (parsed.data.session) normalizeEtagForCheckpoint(parsed.data.session.uploadEtag);
  return parsed.data;
}

function copyCheckpoint(checkpoint: WorkbenchUploadCheckpoint): WorkbenchUploadCheckpoint {
  return {
    ...checkpoint,
    submissionIntent: checkpoint.submissionIntent
      ? { ...checkpoint.submissionIntent }
      : null,
    session: checkpoint.session ? { ...checkpoint.session } : null,
  };
}

function sameSubmissionIntentBinding(
  left: SubmissionIntentUploadBinding | null,
  right: SubmissionIntentUploadBinding | null,
): boolean {
  return left?.submissionIntentId === right?.submissionIntentId
    && left?.attachmentPosition === right?.attachmentPosition
    && left?.clientFingerprint === right?.clientFingerprint;
}

function copySnapshot(snapshot: WorkbenchUploadSnapshot): WorkbenchUploadSnapshot {
  return {
    ...snapshot,
    file: snapshot.file ? structuredClone(snapshot.file) : null,
    extraction: snapshot.extraction ? structuredClone(snapshot.extraction) : null,
    error: snapshot.error ? { ...snapshot.error } : null,
  };
}

function normalizeDeclaredMediaType(value: string): string {
  const normalized = value.trim().toLowerCase() || "application/octet-stream";
  return mediaTypeSchema.parse(normalized);
}

function normalizeEtagForCheckpoint(value: string) {
  if (!/^(?:W\/)?"\d+"$/.test(value.trim())) {
    throw new WorkbenchUploadCheckpointError("Upload checkpoint contains an invalid ETag");
  }
}

function publicError(error: unknown, defaultRetryable: boolean): WorkbenchUploadError {
  if (isWorkbenchApiError(error)) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof WorkbenchUploadPollingTimeoutError) {
    return { code: "FILE_POLL_TIMEOUT", message: error.message, retryable: true };
  }
  if (error instanceof WorkbenchUploadCheckpointError) {
    return { code: "UPLOAD_CHECKPOINT_MISMATCH", message: error.message, retryable: false };
  }
  if (error instanceof Error) {
    return { code: error.name || "UPLOAD_FAILED", message: error.message, retryable: defaultRetryable };
  }
  return { code: "UPLOAD_FAILED", message: "File upload failed", retryable: defaultRetryable };
}

function percentage(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 10_000) / 100));
}

function createUppyPartTransport(transport: WorkbenchUploadPartTransport) {
  return async ({
    signature,
    body,
    onProgress,
    onComplete,
    signal,
  }: {
    signature: AwsS3UploadParameters;
    body: FormData | Blob;
    size?: number;
    onProgress: (event: ProgressEvent) => void;
    onComplete: (etag: string) => void;
    signal?: AbortSignal;
  }) => {
    if (!(body instanceof Blob) || signature.method !== "PUT") {
      throw new WorkbenchUploadStateError("Workbench multipart transport requires a signed PUT Blob");
    }
    const result = await transport({
      method: "PUT",
      url: signature.url,
      headers: signature.headers ?? {},
      body,
      signal,
      reportProgress(bytesUploaded) {
        onProgress({
          lengthComputable: true,
          loaded: bytesUploaded,
          total: body.size,
        } as ProgressEvent);
      },
    });
    const etag = multipartEtagSchema.parse(result.etag);
    onComplete(etag);
    return { ETag: etag };
  };
}

export function resumableUploadParts(
  byteSize: number,
  partSize: number,
  parts: ListUploadPartsResponse["parts"],
) {
  const expectedPartCount = Math.ceil(byteSize / partSize);
  const resumable = [];
  const normalizedParts = listUploadPartsResponseSchema.parse({ parts }).parts;
  for (const part of normalizedParts) {
    if (part.partNumber > expectedPartCount) {
      throw new WorkbenchUploadCheckpointError(
        `Multipart session contains unexpected part ${part.partNumber}`,
      );
    }
    const expectedSize = Math.min(partSize, byteSize - (part.partNumber - 1) * partSize);
    if (part.byteSize === expectedSize) resumable.push(part);
  }
  return resumable;
}

function validateControllerOptions(options: WorkbenchMultipartUploadOptions) {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error("Multipart upload concurrency must be an integer between 1 and 12");
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) {
    throw new Error("Upload lifecycle poll interval must be at least 100ms");
  }
  if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs < pollIntervalMs) {
    throw new Error("Upload lifecycle poll timeout must be at least one interval");
  }
  if (options.retryDelays?.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error("Multipart retry delays must be non-negative numbers");
  }
}

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
