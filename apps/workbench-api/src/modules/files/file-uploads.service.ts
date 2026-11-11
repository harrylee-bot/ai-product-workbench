import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  completeFileUploadResponseSchema,
  createFileUploadResponseSchema,
  fileVerifyQueue,
  listUploadPartsResponseSchema,
  signUploadPartResponseSchema,
  type CompleteFileUploadRequest,
  type CompleteFileUploadResponse,
  type CreateFileUploadRequest,
  type CreateFileUploadResponse,
  type ListUploadPartsResponse,
  type SignUploadPartResponse,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import { isUniqueConflict } from "../../common/prisma-errors.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  submissionIntentStateConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { WorkbenchQueueService } from "../../platform/queue/workbench-queue.service.js";
import { FileApiConfig } from "./file-api.config.js";
import { mapFileAsset, mapFileUploadSession, safeByteSize } from "./file.mapper.js";
import { uploadStateConflictProblem } from "./file-problems.js";
import { objectStorageUnavailableProblem } from "../../platform/object-storage/object-storage.problems.js";
import {
  MULTIPART_STORAGE_PORT,
  type MultipartStoragePort,
  type StoredMultipartPart,
} from "../../platform/object-storage/object-storage.port.js";
import { projectMembershipFilter } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";

const MEBIBYTE = 1024 * 1024;
const S3_MINIMUM_PART_SIZE = 5 * MEBIBYTE;
const MAXIMUM_PARTS = 10_000;

const extractionSelect = {
  id: true,
  fileAssetId: true,
  attempt: true,
  status: true,
  parser: true,
  parserVersion: true,
  outputSchemaVersion: true,
  contentSha256: true,
  failureCode: true,
  failureDetail: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const fileSelect = {
  id: true,
  projectId: true,
  blobId: true,
  originalName: true,
  declaredMediaType: true,
  detectedMediaType: true,
  byteSize: true,
  status: true,
  revision: true,
  failureCode: true,
  failureDetail: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
  blob: { select: { sha256: true } },
  currentExtraction: { select: extractionSelect },
  extractions: { select: extractionSelect, orderBy: { attempt: "desc" as const }, take: 1 },
} as const;

const uploadBundleSelect = {
  id: true,
  projectId: true,
  fileAssetId: true,
  providerUploadId: true,
  stagingKey: true,
  status: true,
  expectedByteSize: true,
  expectedSha256: true,
  partSize: true,
  revision: true,
  idempotencyKey: true,
  requestHash: true,
  completionIdempotencyKey: true,
  completionRequestHash: true,
  expiresAt: true,
  file: { select: fileSelect },
} as const;

type UploadBundle = Prisma.FileUploadSessionGetPayload<{ select: typeof uploadBundleSelect }>;
type SubmissionIntentUploadSlot = Readonly<{
  intentId: string;
  projectId: string;
  createdById: string;
  status: string;
  kind: string;
  fileAssetId: string | null;
  clientFingerprint: string | null;
  fileName: string | null;
  declaredMediaType: string | null;
  byteSize: bigint | null;
}>;

@Injectable()
export class FileUploadsService {
  constructor(
    private readonly db: WorkbenchDbService,
    @Inject(MULTIPART_STORAGE_PORT) private readonly storage: MultipartStoragePort,
    private readonly queue: WorkbenchQueueService,
    private readonly config: FileApiConfig,
  ) {}

  async create(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    request: CreateFileUploadRequest,
  ): Promise<CreateFileUploadResponse> {
    validateIdempotencyKey(idempotencyKey);
    await this.requireAuthorizedProject(principalId, projectId);
    const requestHash = hashRequest(request);
    const existing = await this.db.fileUploadSession.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      select: uploadBundleSelect,
    });
    if (existing) {
      await this.assertUploadBindingReplay(principalId, projectId, request, existing.fileAssetId);
      return this.resumeCreate(principalId, existing, requestHash);
    }

    const fileAssetId = `file_${randomUUID()}`;
    const uploadSessionId = `upload_${randomUUID()}`;
    const stagingKey = `${this.config.stagingPrefix}/${projectId}/${uploadSessionId}`;
    const partSize = choosePartSize(request.byteSize, this.config.preferredPartSize);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1_000);

    try {
      const created = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "edit");
        const duplicate = await tx.fileUploadSession.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          select: { requestHash: true },
        });
        if (duplicate) {
          if (duplicate.requestHash !== requestHash) throw idempotencyConflictProblem();
          return false;
        }
        await this.lockSubmissionIntentUploadSlot(tx, principalId, projectId, request);
        await tx.fileAsset.create({
          data: {
            id: fileAssetId,
            projectId,
            uploadedById: principalId,
            originalName: request.fileName,
            declaredMediaType: request.declaredMediaType,
            byteSize: BigInt(request.byteSize),
            status: "uploading",
          },
        });
        await tx.fileUploadSession.create({
          data: {
            id: uploadSessionId,
            projectId,
            fileAssetId,
            stagingKey,
            status: "initiating",
            expectedByteSize: BigInt(request.byteSize),
            expectedSha256: request.sha256 ?? null,
            partSize,
            idempotencyKey,
            requestHash,
            expiresAt,
          },
        });
        if (request.submissionIntent) {
          const bound = await tx.submissionIntentAttachment.updateMany({
            where: {
              submissionIntentId: request.submissionIntent.submissionIntentId,
              position: request.submissionIntent.attachmentPosition,
              kind: "upload",
              fileAssetId: null,
              clientFingerprint: request.submissionIntent.clientFingerprint,
            },
            data: { fileAssetId },
          });
          if (bound.count !== 1) {
            throw submissionIntentStateConflictProblem(
              "The SubmissionIntent upload slot could not be bound",
              "SUBMISSION_INTENT_UPLOAD_BINDING_CONFLICT",
            );
          }
        }
        return true;
      });
      if (!created) {
        const raced = await this.db.fileUploadSession.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          select: uploadBundleSelect,
        });
        if (!raced) throw new Error("Idempotent upload receipt disappeared");
        await this.assertUploadBindingReplay(principalId, projectId, request, raced.fileAssetId);
        return this.resumeCreate(principalId, raced, requestHash);
      }
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const raced = await this.db.fileUploadSession.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        select: uploadBundleSelect,
      });
      if (raced) {
        await this.assertUploadBindingReplay(principalId, projectId, request, raced.fileAssetId);
        return this.resumeCreate(principalId, raced, requestHash);
      }
      throw error;
    }
    await this.initializeReceipt(uploadSessionId);
    return createFileUploadResponseSchema.parse(
      this.mapBundle(await this.requireAuthorizedUpload(principalId, uploadSessionId)),
    );
  }

  async get(principalId: string, uploadSessionId: string) {
    return mapFileUploadSession(await this.requireAuthorizedUpload(principalId, uploadSessionId));
  }

  async signPart(
    principalId: string,
    uploadSessionId: string,
    partNumber: number,
    expectedRevision: number,
    contentLength: number,
  ): Promise<{ response: SignUploadPartResponse; revision: number }> {
    const visible = await this.requireAuthorizedUpload(principalId, uploadSessionId);
    return this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, visible.projectId, principalId, "edit");
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "file_upload_sessions" WHERE "id" = ${uploadSessionId} FOR UPDATE
      `);
      const upload = await tx.fileUploadSession.findUnique({
        where: { id: uploadSessionId },
        select: uploadBundleSelect,
      });
      if (!upload) throw notFoundProblem("File upload session");
      this.assertUploadCanTransfer(upload);
      if (upload.revision !== expectedRevision) throw revisionConflictProblem();
      const expectedLength = expectedPartLength(
        safeByteSize(upload.expectedByteSize),
        upload.partSize,
        partNumber,
      );
      if (contentLength !== expectedLength) {
        throw validationProblem(`Part ${partNumber} must contain exactly ${expectedLength} bytes`);
      }
      const providerUploadId = requireProviderUploadId(upload);
      const secondsUntilExpiry = Math.floor((upload.expiresAt.getTime() - Date.now()) / 1_000);
      const expiresInSeconds = Math.min(this.config.signedUrlTtlSeconds, secondsUntilExpiry);
      if (expiresInSeconds < 1) {
        throw uploadStateConflictProblem("The upload session has expired", "UPLOAD_EXPIRED");
      }
      let signed;
      try {
        signed = await this.storage.signMultipartPart({
          key: upload.stagingKey,
          uploadId: providerUploadId,
          partNumber,
          contentLength,
          expiresInSeconds,
        });
      } catch {
        throw objectStorageUnavailableProblem();
      }
      return {
        response: signUploadPartResponseSchema.parse({
          uploadSessionId,
          partNumber,
          method: "PUT",
          url: signed.url,
          headers: signed.headers,
          expiresAt: signed.expiresAt.toISOString(),
        }),
        revision: upload.revision,
      };
    });
  }

  async listParts(principalId: string, uploadSessionId: string): Promise<ListUploadPartsResponse> {
    const upload = await this.requireAuthorizedUpload(principalId, uploadSessionId);
    if (!["initiated", "completing"].includes(upload.status)) {
      throw uploadStateConflictProblem(`Parts cannot be listed while the upload is ${upload.status}`);
    }
    if (upload.expiresAt.getTime() <= Date.now() && upload.status === "initiated") {
      throw uploadStateConflictProblem("The upload session has expired", "UPLOAD_EXPIRED");
    }
    try {
      const parts = await this.storage.listMultipartParts({
        key: upload.stagingKey,
        uploadId: requireProviderUploadId(upload),
      });
      return listUploadPartsResponseSchema.parse({ parts });
    } catch {
      throw objectStorageUnavailableProblem();
    }
  }

  async complete(
    principalId: string,
    uploadSessionId: string,
    expectedRevision: number,
    idempotencyKey: string,
    request: CompleteFileUploadRequest,
  ): Promise<CompleteFileUploadResponse> {
    validateIdempotencyKey(idempotencyKey);
    const requestHash = hashRequest(request);
    let upload = await this.requireAuthorizedUpload(principalId, uploadSessionId);
    await this.assertMutationCapability(principalId, upload);

    if (upload.completionIdempotencyKey !== null) {
      this.assertCompletionReceipt(upload, idempotencyKey, requestHash);
      if (upload.status === "completed") return completeFileUploadResponseSchema.parse(this.mapBundle(upload));
      if (upload.status !== "completing") {
        throw uploadStateConflictProblem(`Upload completion cannot be resumed while the upload is ${upload.status}`);
      }
      return this.finishCompletion(principalId, upload, request);
    }

    this.assertUploadCanTransfer(upload);
    if (upload.revision !== expectedRevision) throw revisionConflictProblem();
    if (request.sha256 && upload.expectedSha256 && request.sha256 !== upload.expectedSha256) {
      throw validationProblem("The final client digest differs from the upload-session digest");
    }

    let storedParts: StoredMultipartPart[];
    try {
      storedParts = await this.storage.listMultipartParts({
        key: upload.stagingKey,
        uploadId: requireProviderUploadId(upload),
      });
    } catch {
      throw objectStorageUnavailableProblem();
    }
    validateCompletedParts(
      request.parts,
      storedParts,
      safeByteSize(upload.expectedByteSize),
      upload.partSize,
    );

    const claimed = await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, upload.projectId, principalId, "edit");
      return tx.fileUploadSession.updateMany({
        where: {
          id: uploadSessionId,
          revision: expectedRevision,
          status: "initiated",
          completionIdempotencyKey: null,
        },
        data: {
          status: "completing",
          completionIdempotencyKey: idempotencyKey,
          completionRequestHash: requestHash,
          expectedSha256: upload.expectedSha256 ?? request.sha256 ?? null,
          revision: { increment: 1 },
        },
      });
    });
    if (claimed.count !== 1) {
      upload = await this.requireAuthorizedUpload(principalId, uploadSessionId);
      if (upload.completionIdempotencyKey !== null) {
        this.assertCompletionReceipt(upload, idempotencyKey, requestHash);
        if (upload.status === "completed") return completeFileUploadResponseSchema.parse(this.mapBundle(upload));
        if (upload.status === "completing") return this.finishCompletion(principalId, upload, request);
      }
      throw revisionConflictProblem();
    }

    upload = await this.requireAuthorizedUpload(principalId, uploadSessionId);
    return this.finishCompletion(principalId, upload, request);
  }

  async abort(principalId: string, uploadSessionId: string, expectedRevision: number): Promise<void> {
    let upload = await this.requireAuthorizedUpload(principalId, uploadSessionId);
    await this.assertMutationCapability(principalId, upload);
    if (upload.status === "aborted") return;
    if (upload.status === "aborting") return this.finishAbort(upload);
    if (upload.revision !== expectedRevision) throw revisionConflictProblem();
    if (!["initiating", "initiated", "expired", "failed"].includes(upload.status)) {
      throw uploadStateConflictProblem(`The upload cannot be aborted while it is ${upload.status}`);
    }
    const claimed = await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, upload.projectId, principalId, "edit");
      return tx.fileUploadSession.updateMany({
        where: { id: uploadSessionId, revision: expectedRevision, status: upload.status },
        data: { status: "aborting", revision: { increment: 1 } },
      });
    });
    if (claimed.count !== 1) {
      upload = await this.requireAuthorizedUpload(principalId, uploadSessionId);
      if (upload.status === "aborted") return;
      if (upload.status === "aborting") return this.finishAbort(upload);
      throw revisionConflictProblem();
    }
    await this.finishAbort(await this.requireAuthorizedUpload(principalId, uploadSessionId));
  }

  private async finishCompletion(
    principalId: string,
    upload: UploadBundle,
    request: CompleteFileUploadRequest,
  ): Promise<CompleteFileUploadResponse> {
    const objectRef = {
      key: upload.stagingKey,
      uploadId: requireProviderUploadId(upload),
    };
    const expectedByteSize = safeByteSize(upload.expectedByteSize);
    try {
      let stored = await this.storage.statObject(upload.stagingKey);
      if (!stored) {
        try {
          await this.storage.completeMultipartUpload({ ...objectRef, parts: request.parts });
        } catch (error) {
          stored = await this.storage.statObject(upload.stagingKey).catch(() => null);
          if (!stored) throw error;
        }
        stored ??= await this.storage.statObject(upload.stagingKey);
      }
      if (!stored || stored.byteSize !== expectedByteSize) {
        throw uploadStateConflictProblem(
          "The completed object size does not match the upload session",
          "UPLOAD_BYTE_SIZE_MISMATCH",
        );
      }
    } catch (error) {
      if (isPublicProblem(error)) throw error;
      throw objectStorageUnavailableProblem();
    }

    await this.db.$transaction(async (tx) => {
      const completed = await tx.fileUploadSession.updateMany({
        where: {
          id: upload.id,
          status: "completing",
          completionIdempotencyKey: upload.completionIdempotencyKey,
          completionRequestHash: upload.completionRequestHash,
        },
        data: { status: "completed", completedAt: new Date(), revision: { increment: 1 } },
      });
      if (completed.count === 0) {
        const current = await tx.fileUploadSession.findUnique({ where: { id: upload.id }, select: { status: true } });
        if (current?.status !== "completed") throw uploadStateConflictProblem("Upload completion ownership was lost");
        return;
      }
      const verifying = await tx.fileAsset.updateMany({
        where: { id: upload.fileAssetId, status: "uploading" },
        data: {
          status: "verifying",
          failureCode: null,
          failureDetail: null,
          revision: { increment: 1 },
        },
      });
      if (verifying.count !== 1) throw uploadStateConflictProblem("The File is no longer awaiting verification");
      await this.queue.sendInTransaction(tx, fileVerifyQueue, { uploadSessionId: upload.id }, {
        singletonKey: upload.id,
      });
    });

    return completeFileUploadResponseSchema.parse(
      this.mapBundle(await this.requireAuthorizedUpload(principalId, upload.id)),
    );
  }

  private async finishAbort(upload: UploadBundle) {
    if (upload.providerUploadId) {
      try {
        await this.storage.abortMultipartUpload({ key: upload.stagingKey, uploadId: upload.providerUploadId });
      } catch {
        throw objectStorageUnavailableProblem();
      }
    }
    await this.db.$transaction(async (tx) => {
      await tx.fileUploadSession.updateMany({
        where: { id: upload.id, status: "aborting" },
        data: { status: "aborted", abortedAt: new Date(), revision: { increment: 1 } },
      });
      await tx.fileAsset.updateMany({
        where: { id: upload.fileAssetId, status: "uploading" },
        data: {
          status: "failed",
          failureCode: "UPLOAD_ABORTED",
          failureDetail: null,
          revision: { increment: 1 },
        },
      });
    });
  }

  private assertUploadCanTransfer(upload: UploadBundle) {
    if (upload.status !== "initiated") {
      throw uploadStateConflictProblem(`The upload cannot transfer data while it is ${upload.status}`);
    }
    if (upload.expiresAt.getTime() <= Date.now()) {
      throw uploadStateConflictProblem("The upload session has expired", "UPLOAD_EXPIRED");
    }
  }

  private assertCompletionReceipt(upload: UploadBundle, idempotencyKey: string, requestHash: string) {
    if (upload.completionIdempotencyKey !== idempotencyKey) {
      throw uploadStateConflictProblem("This upload already has a different completion command", "UPLOAD_ALREADY_COMPLETING");
    }
    if (upload.completionRequestHash !== requestHash) throw idempotencyConflictProblem();
  }

  private async resumeCreate(principalId: string, upload: UploadBundle, requestHash: string) {
    if (upload.requestHash !== requestHash) throw idempotencyConflictProblem();
    if (upload.status === "initiating") {
      await this.initializeReceipt(upload.id);
      upload = await this.requireAuthorizedUpload(principalId, upload.id);
    }
    if (upload.status === "failed" || upload.status === "expired") {
      throw uploadStateConflictProblem(
        upload.status === "expired" ? "The upload session expired during initialization" : "The upload session failed to initialize",
        upload.status === "expired" ? "UPLOAD_EXPIRED" : "UPLOAD_FAILED",
      );
    }
    return createFileUploadResponseSchema.parse(this.mapBundle(upload));
  }

  private async initializeReceipt(uploadSessionId: string) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${uploadSessionId}, 0))::TEXT AS "lock_receipt"`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "file_upload_sessions" WHERE "id" = ${uploadSessionId} FOR UPDATE`,
        );
        const receipt = await tx.fileUploadSession.findUnique({
          where: { id: uploadSessionId },
          select: {
            id: true,
            projectId: true,
            fileAssetId: true,
            stagingKey: true,
            status: true,
            providerUploadId: true,
            expiresAt: true,
            file: { select: { declaredMediaType: true } },
          },
        });
        if (!receipt) throw notFoundProblem("File upload session");
        if (receipt.status !== "initiating") return;
        if (receipt.expiresAt.getTime() <= Date.now()) {
          await tx.fileUploadSession.updateMany({
            where: { id: receipt.id, status: "initiating" },
            data: { status: "expired", revision: { increment: 1 } },
          });
          await tx.fileAsset.updateMany({
            where: { id: receipt.fileAssetId, status: "uploading" },
            data: {
              status: "failed",
              failureCode: "UPLOAD_FAILED",
              failureDetail: null,
              revision: { increment: 1 },
            },
          });
          return;
        }
        const provider = await this.storage.createMultipartUpload({
          key: receipt.stagingKey,
          mediaType: receipt.file.declaredMediaType,
          metadata: { "file-asset-id": receipt.fileAssetId, "project-id": receipt.projectId },
        });
        const initialized = await tx.fileUploadSession.updateMany({
          where: { id: receipt.id, status: "initiating", providerUploadId: null },
          data: { providerUploadId: provider.uploadId, status: "initiated", revision: { increment: 1 } },
        });
        if (initialized.count !== 1) throw new Error("Upload initialization ownership was lost");
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (isPublicProblem(error)) throw error;
      // A process can lose the transaction result after S3 accepted the upload. Leave any
      // incomplete multipart object to bucket lifecycle cleanup and let this receipt retry.
      throw objectStorageUnavailableProblem();
    }
  }

  private mapBundle(upload: UploadBundle) {
    return {
      file: mapFileAsset(upload.file),
      upload: mapFileUploadSession(upload),
    };
  }

  private async requireAuthorizedProject(principalId: string, projectId: string) {
    const project = await this.db.project.findFirst({
      where: {
        id: projectId,
        status: "active",
        members: projectMembershipFilter(principalId, "edit"),
      },
      select: { id: true },
    });
    if (!project) throw notFoundProblem("Project");
  }

  private async findAuthorizedUpload(principalId: string, uploadSessionId: string) {
    return this.db.fileUploadSession.findFirst({
      where: {
        id: uploadSessionId,
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "edit"),
          },
        },
      },
      select: uploadBundleSelect,
    });
  }

  private async requireAuthorizedUpload(principalId: string, uploadSessionId: string) {
    const upload = await this.findAuthorizedUpload(principalId, uploadSessionId);
    if (!upload) throw notFoundProblem("File upload session");
    return upload;
  }

  private assertMutationCapability(principalId: string, upload: UploadBundle) {
    return this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, upload.projectId, principalId, "edit");
    });
  }

  private async lockSubmissionIntentUploadSlot(
    tx: Prisma.TransactionClient,
    principalId: string,
    projectId: string,
    request: CreateFileUploadRequest,
  ) {
    const binding = request.submissionIntent;
    if (!binding) return;
    const rows = await tx.$queryRaw<SubmissionIntentUploadSlot[]>(Prisma.sql`
      SELECT
        intent."id" AS "intentId",
        intent."project_id" AS "projectId",
        intent."created_by_id" AS "createdById",
        intent."status"::text AS "status",
        attachment."kind"::text AS "kind",
        attachment."file_asset_id" AS "fileAssetId",
        attachment."client_fingerprint" AS "clientFingerprint",
        attachment."file_name" AS "fileName",
        attachment."declared_media_type" AS "declaredMediaType",
        attachment."byte_size" AS "byteSize"
      FROM "submission_intents" AS intent
      JOIN "submission_intent_attachments" AS attachment
        ON attachment."submission_intent_id" = intent."id"
       AND attachment."project_id" = intent."project_id"
      WHERE intent."id" = ${binding.submissionIntentId}
        AND attachment."position" = ${binding.attachmentPosition}
      FOR UPDATE OF intent, attachment
    `);
    const slot = rows[0];
    if (
      !slot
      || slot.projectId !== projectId
      || slot.createdById !== principalId
      || slot.status !== "pending"
    ) throw notFoundProblem("Submission intent upload slot");
    this.assertUploadSlotMatches(slot, request, null);
  }

  private async assertUploadBindingReplay(
    principalId: string,
    projectId: string,
    request: CreateFileUploadRequest,
    fileAssetId: string,
  ) {
    const binding = request.submissionIntent;
    if (!binding) return;
    const rows = await this.db.$queryRaw<SubmissionIntentUploadSlot[]>(Prisma.sql`
      SELECT
        intent."id" AS "intentId",
        intent."project_id" AS "projectId",
        intent."created_by_id" AS "createdById",
        intent."status"::text AS "status",
        attachment."kind"::text AS "kind",
        attachment."file_asset_id" AS "fileAssetId",
        attachment."client_fingerprint" AS "clientFingerprint",
        attachment."file_name" AS "fileName",
        attachment."declared_media_type" AS "declaredMediaType",
        attachment."byte_size" AS "byteSize"
      FROM "submission_intents" AS intent
      JOIN "submission_intent_attachments" AS attachment
        ON attachment."submission_intent_id" = intent."id"
       AND attachment."project_id" = intent."project_id"
      WHERE intent."id" = ${binding.submissionIntentId}
        AND attachment."position" = ${binding.attachmentPosition}
    `);
    const slot = rows[0];
    if (!slot || slot.projectId !== projectId || slot.createdById !== principalId) {
      throw notFoundProblem("Submission intent upload slot");
    }
    this.assertUploadSlotMatches(slot, request, fileAssetId);
  }

  private assertUploadSlotMatches(
    slot: SubmissionIntentUploadSlot,
    request: CreateFileUploadRequest,
    expectedFileAssetId: string | null,
  ) {
    const binding = request.submissionIntent;
    if (!binding) throw new Error("SubmissionIntent upload binding is missing");
    if (
      slot.kind !== "upload"
      || slot.fileAssetId !== expectedFileAssetId
      || slot.clientFingerprint !== binding.clientFingerprint
      || slot.fileName !== request.fileName
      || slot.declaredMediaType !== request.declaredMediaType
      || slot.byteSize !== BigInt(request.byteSize)
    ) {
      throw submissionIntentStateConflictProblem(
        "The upload request does not match the durable SubmissionIntent slot",
        "SUBMISSION_INTENT_UPLOAD_BINDING_MISMATCH",
      );
    }
  }

}

export function choosePartSize(byteSize: number, preferredPartSize: number) {
  const minimumForPartLimit = Math.ceil(byteSize / MAXIMUM_PARTS);
  const desired = Math.max(S3_MINIMUM_PART_SIZE, preferredPartSize, minimumForPartLimit);
  const rounded = Math.ceil(desired / MEBIBYTE) * MEBIBYTE;
  if (!Number.isSafeInteger(rounded) || rounded > 2_147_483_647) {
    throw validationProblem("The file cannot be represented by at most 10,000 multipart upload parts");
  }
  return rounded;
}

export function expectedPartLength(byteSize: number, partSize: number, partNumber: number) {
  const partCount = Math.ceil(byteSize / partSize);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    throw validationProblem(`partNumber must be between 1 and ${partCount}`);
  }
  return partNumber === partCount ? byteSize - partSize * (partCount - 1) : partSize;
}

export function validateCompletedParts(
  requested: Array<{ partNumber: number; etag: string }>,
  stored: StoredMultipartPart[],
  byteSize: number,
  partSize: number,
) {
  const expectedCount = Math.ceil(byteSize / partSize);
  if (requested.length !== expectedCount || stored.length !== expectedCount) {
    throw validationProblem(`The upload requires exactly ${expectedCount} completed parts`);
  }
  for (let index = 0; index < expectedCount; index += 1) {
    const requestedPart = requested[index];
    const storedPart = stored[index];
    const partNumber = index + 1;
    if (!requestedPart || !storedPart
      || requestedPart.partNumber !== partNumber
      || storedPart.partNumber !== partNumber
      || requestedPart.etag !== storedPart.etag) {
      throw validationProblem(`Completed part ${partNumber} does not match object storage`);
    }
    const expectedLength = expectedPartLength(byteSize, partSize, partNumber);
    if (storedPart.byteSize !== expectedLength) {
      throw validationProblem(`Stored part ${partNumber} must contain exactly ${expectedLength} bytes`);
    }
  }
}

function requireProviderUploadId(upload: { providerUploadId: string | null }) {
  if (!upload.providerUploadId) throw uploadStateConflictProblem("The upload has no provider session");
  return upload.providerUploadId;
}


function isPublicProblem(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error;
}
