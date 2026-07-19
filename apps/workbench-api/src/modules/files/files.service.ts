import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  fileAssetSchema,
  fileExtractQueue,
  fileExtractionSchema,
  fileListSchema,
  type FileAsset,
  type FileExtraction,
  type FileList,
  type FileStatus,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { WorkbenchQueueService } from "../../platform/queue/workbench-queue.service.js";
import { FileApiConfig } from "./file-api.config.js";
import { mapFileAsset, mapFileExtraction, safeByteSize } from "./file.mapper.js";
import {
  fileStateConflictProblem,
} from "./file-problems.js";
import {
  READY_BLOB_STORAGE_PORT,
  type ReadyBlobStoragePort,
} from "../../platform/object-storage/object-storage.port.js";
import { readReadyObject } from "../../platform/object-storage/read-ready-object.js";
import {
  projectMembershipFilter,
  type ProjectCapability,
} from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";

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
  blob: { select: { sha256: true, status: true, deletedAt: true } },
  currentExtraction: { select: extractionSelect },
  extractions: { select: extractionSelect, orderBy: { attempt: "desc" as const }, take: 1 },
} as const;

type FileCursor = { createdAt: string; id: string };

@Injectable()
export class FilesService {
  constructor(
    private readonly db: WorkbenchDbService,
    @Inject(READY_BLOB_STORAGE_PORT) private readonly storage: ReadyBlobStoragePort,
    private readonly queue: WorkbenchQueueService,
    private readonly config: FileApiConfig,
  ) {}

  async list(
    principalId: string,
    projectId: string,
    status?: Exclude<FileStatus, "deleted">,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<FileList> {
    await this.requireAuthorizedProject(principalId, projectId);
    const decodedCursor = cursor ? decodeFileCursor(cursor) : undefined;
    const limit = Math.min(Math.max(requestedLimit ?? 30, 1), 100);
    const files = await this.db.fileAsset.findMany({
      where: {
        projectId,
        status: status ?? { not: "deleted" },
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
        ...(decodedCursor
          ? {
              OR: [
                { createdAt: { lt: new Date(decodedCursor.createdAt) } },
                { createdAt: new Date(decodedCursor.createdAt), id: { lt: decodedCursor.id } },
              ],
            }
          : {}),
      },
      select: fileSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasNextPage = files.length > limit;
    const page = hasNextPage ? files.slice(0, limit) : files;
    const last = page.at(-1);
    return fileListSchema.parse({
      items: page.map(mapFileAsset),
      nextCursor: hasNextPage && last
        ? encodeFileCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    });
  }

  async get(principalId: string, fileAssetId: string): Promise<FileAsset> {
    return fileAssetSchema.parse(mapFileAsset(
      await this.requireAuthorizedFile(principalId, fileAssetId, "read"),
    ));
  }

  async delete(principalId: string, fileAssetId: string, expectedRevision: number): Promise<void> {
    const file = await this.requireAuthorizedFile(principalId, fileAssetId, "edit");
    await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, file.projectId, principalId, "edit");
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "file_assets" WHERE "id" = ${fileAssetId} FOR UPDATE
      `);
      const current = await tx.fileAsset.findUnique({ where: { id: fileAssetId }, select: fileSelect });
      if (!current) throw notFoundProblem("File");
      if (current.status === "deleted") return;
      if (current.revision !== expectedRevision) throw revisionConflictProblem();
      if (["uploading", "verifying"].includes(current.status)) {
        throw fileStateConflictProblem("An active upload must finish or be aborted before the File can be deleted");
      }
      const latestExtraction = current.extractions[0];
      if (latestExtraction && ["queued", "running"].includes(latestExtraction.status)) {
        throw fileStateConflictProblem("An active extraction must finish before the File can be deleted");
      }
      const deleted = await tx.fileAsset.updateMany({
        where: { id: fileAssetId, revision: expectedRevision, status: { not: "deleted" } },
        data: { status: "deleted", deletedAt: new Date(), revision: { increment: 1 } },
      });
      if (deleted.count !== 1) throw revisionConflictProblem();
    });
  }

  async getContent(
    principalId: string,
    fileAssetId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
  ) {
    const file = await this.db.fileAsset.findFirst({
      where: {
        id: fileAssetId,
        status: { not: "deleted" },
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
      },
      select: {
        id: true,
        originalName: true,
        status: true,
        byteSize: true,
        detectedMediaType: true,
        blob: {
          select: {
            storageKey: true,
            sha256: true,
            byteSize: true,
            mediaType: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!file) throw notFoundProblem("File");
    if (file.status !== "ready" || !file.blob || file.blob.status !== "ready" || file.blob.deletedAt !== null) {
      throw fileStateConflictProblem("File content is not ready");
    }
    const byteSize = safeByteSize(file.byteSize);
    if (file.blob.byteSize !== file.byteSize || file.blob.mediaType !== file.detectedMediaType) {
      throw new Error("Ready File and Blob metadata diverged");
    }
    const content = await readReadyObject(this.storage, {
      storageKey: file.blob.storageKey,
      sha256: file.blob.sha256,
      byteSize,
      mediaType: file.blob.mediaType,
    }, rangeHeader, ifNoneMatch);
    return {
      ...content,
      fileName: file.originalName,
    };
  }

  async createExtraction(
    principalId: string,
    fileAssetId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<{ extraction: FileExtraction; fileRevision: number }> {
    validateIdempotencyKey(idempotencyKey);
    const file = await this.requireAuthorizedFile(principalId, fileAssetId, "edit");
    if (file.status !== "ready" || !file.blobId || !file.blob
      || file.blob.status !== "ready" || file.blob.deletedAt !== null) {
      throw fileStateConflictProblem("Only a verified ready File can be extracted");
    }
    const sourceBlobId = file.blobId;
    const requestHash = hashRequest({
      fileAssetId,
      sourceBlobId,
      parser: this.config.parser,
      parserVersion: this.config.parserVersion,
      outputSchemaVersion: this.config.extractionSchemaVersion,
    });
    const existing = await this.db.fileExtraction.findUnique({
      where: { fileAssetId_idempotencyKey: { fileAssetId, idempotencyKey } },
      select: { ...extractionSelect, requestHash: true },
    });
    if (existing) return this.resolveExtractionReplay(file.revision, existing, requestHash);
    if (file.revision !== expectedRevision) throw revisionConflictProblem();

    let extraction;
    try {
      extraction = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, file.projectId, principalId, "edit");
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "file_assets" WHERE "id" = ${fileAssetId} FOR UPDATE`);
        const duplicate = await tx.fileExtraction.findUnique({
          where: { fileAssetId_idempotencyKey: { fileAssetId, idempotencyKey } },
          select: { ...extractionSelect, requestHash: true },
        });
        if (duplicate) {
          if (duplicate.requestHash !== requestHash) throw idempotencyConflictProblem();
          return duplicate;
        }
        const lockedFile = await tx.fileAsset.findUnique({
          where: { id: fileAssetId },
          select: { status: true, revision: true, blobId: true, blob: { select: { status: true, deletedAt: true } } },
        });
        if (!lockedFile || lockedFile.status !== "ready" || lockedFile.revision !== expectedRevision
          || lockedFile.blobId !== sourceBlobId || lockedFile.blob?.status !== "ready"
          || lockedFile.blob.deletedAt !== null) {
          throw revisionConflictProblem();
        }
        const latest = await tx.fileExtraction.findFirst({
          where: { fileAssetId },
          select: { attempt: true },
          orderBy: { attempt: "desc" },
        });
        const created = await tx.fileExtraction.create({
          data: {
            fileAssetId,
            sourceBlobId,
            attempt: (latest?.attempt ?? 0) + 1,
            parser: this.config.parser,
            parserVersion: this.config.parserVersion,
            outputSchemaVersion: this.config.extractionSchemaVersion,
            idempotencyKey,
            requestHash,
            status: "queued",
          },
          select: { ...extractionSelect, requestHash: true },
        });
        await this.queue.sendInTransaction(tx, fileExtractQueue, { extractionId: created.id }, {
          singletonKey: created.id,
        });
        return created;
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const raced = await this.db.fileExtraction.findUnique({
        where: { fileAssetId_idempotencyKey: { fileAssetId, idempotencyKey } },
        select: { ...extractionSelect, requestHash: true },
      });
      if (!raced) throw error;
      const revision = await this.currentFileRevision(fileAssetId);
      return this.resolveExtractionReplay(revision, raced, requestHash);
    }
    const fileRevision = await this.currentFileRevision(fileAssetId);
    return {
      extraction: fileExtractionSchema.parse(mapFileExtraction(extraction)),
      fileRevision,
    };
  }

  private resolveExtractionReplay(
    fileRevision: number,
    extraction: Parameters<typeof mapFileExtraction>[0] & { requestHash: string },
    requestHash: string,
  ) {
    if (extraction.requestHash !== requestHash) throw idempotencyConflictProblem();
    return { extraction: mapFileExtraction(extraction), fileRevision };
  }

  private async currentFileRevision(fileAssetId: string) {
    const file = await this.db.fileAsset.findUnique({ where: { id: fileAssetId }, select: { revision: true } });
    if (!file) throw notFoundProblem("File");
    return file.revision;
  }

  private async requireAuthorizedProject(
    principalId: string,
    projectId: string,
    capability: ProjectCapability = "read",
  ) {
    const project = await this.db.project.findFirst({
      where: {
        id: projectId,
        status: "active",
        members: projectMembershipFilter(principalId, capability),
      },
      select: { id: true },
    });
    if (!project) throw notFoundProblem("Project");
  }

  private async requireAuthorizedFile(
    principalId: string,
    fileAssetId: string,
    capability: ProjectCapability,
  ) {
    const file = await this.db.fileAsset.findFirst({
      where: {
        id: fileAssetId,
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, capability),
          },
        },
      },
      select: fileSelect,
    });
    if (!file) throw notFoundProblem("File");
    return file;
  }
}

export function encodeFileCursor(cursor: FileCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeFileCursor(value: string): FileCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<FileCursor>;
    if (!parsed.id || !parsed.createdAt || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("invalid cursor");
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch {
    throw validationProblem("The File cursor is invalid");
  }
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
