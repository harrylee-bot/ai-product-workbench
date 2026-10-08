import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  createImportSourceRequestSchema,
  importSourceProcessJobSchema,
  importSourceProcessQueue,
  importSourceProcessJobOptions,
  importSourceListSchema,
  importSourceSchema,
  type CreateImportSourceRequest,
  type ImportSource,
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
import { AccessService, projectMembershipFilter } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { importSourceStateConflictProblem } from "./import-source-problems.js";
import { importSourceSelect, mapImportSource, type ImportSourceRecord } from "./import-source.mapper.js";

type SourceCursor = { createdAt: string; id: string };

@Injectable()
export class ImportSourcesService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
    private readonly queue: WorkbenchQueueService,
  ) {}

  async list(
    principalId: string,
    projectId: string,
    cursor?: string,
    requestedLimit?: number,
  ) {
    await this.access.findProject(principalId, projectId, "read");
    const limit = Math.min(Math.max(requestedLimit ?? 30, 1), 100);
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.db.importSource.findMany({
      where: {
        projectId,
        status: { not: "deleted" },
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
        ...(decoded
          ? {
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
              ],
            }
          : {}),
      },
      select: importSourceSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return importSourceListSchema.parse({
      items: page.map((row) => mapImportSource(row as ImportSourceRecord)),
      nextCursor: hasNextPage && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    });
  }

  async get(principalId: string, sourceId: string): Promise<ImportSource> {
    const row = await this.db.importSource.findFirst({
      where: {
        id: sourceId,
        status: { not: "deleted" },
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
      },
      select: importSourceSelect,
    });
    if (!row) throw notFoundProblem("Import source");
    return mapImportSource(row as ImportSourceRecord);
  }

  async create(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    input: CreateImportSourceRequest,
  ): Promise<ImportSource> {
    validateIdempotencyKey(idempotencyKey);
    const request = createImportSourceRequestSchema.parse(input);
    const requestHash = hashRequest(request);
    await this.access.findProject(principalId, projectId, "edit");

    const replay = await this.db.importSource.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      select: importSourceSelect,
    });
    if (replay) return this.resolveReplay(replay as ImportSourceRecord, requestHash);

    try {
      const row = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "edit");
        const duplicate = await tx.importSource.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          select: importSourceSelect,
        });
        if (duplicate) return this.resolveReplay(duplicate as ImportSourceRecord, requestHash);
        const resolved = request.kind === "file" || request.kind === "design_md"
          ? await this.resolveLocalFile(tx, projectId, request)
          : {
              label: request.label ?? defaultExternalLabel(request),
              status: "pending" as const,
              descriptor: null,
              checksum: null,
              blob: null,
            };
        const created = await tx.importSource.create({
          data: {
            id: `source_${randomUUID()}`,
            projectId,
            createdById: principalId,
            kind: request.kind,
            // A local source is promoted only after its immutable manifest row
            // exists. External sources remain pending until their worker lease
            // commits a verified snapshot.
            status: "pending",
            label: resolved.label,
            descriptor: undefined,
            request: request as Prisma.InputJsonValue,
            requestHash,
            idempotencyKey,
            revision: 0,
          },
          select: importSourceSelect,
        });
        if (resolved.blob) {
          await tx.importSourceBlob.create({
            data: {
              id: `source_blob_${randomUUID()}`,
              importSourceId: created.id,
              projectId,
              position: 0,
              blobId: resolved.blob.id,
              fileAssetId: request.kind === "file" || request.kind === "design_md" ? request.fileAssetId : null,
              role: "primary",
              path: resolved.blob.path,
              mediaType: resolved.blob.mediaType,
              byteSize: resolved.blob.byteSize,
              sha256: resolved.blob.sha256,
            },
          });
          await tx.importSource.update({
            where: { id: created.id },
            data: {
              status: "ready",
              descriptor: resolved.descriptor as Prisma.InputJsonValue,
              checksum: resolved.checksum,
              revision: { increment: 1 },
            },
          });
        } else {
          const payload = importSourceProcessJobSchema.parse({
            sourceId: created.id,
            projectId,
            requestHash,
          });
          const queueJobId = await this.queue.sendInTransaction(
            tx,
            importSourceProcessQueue,
            payload,
            importSourceProcessJobOptions(payload),
          );
          await tx.importSourceAttempt.create({
            data: {
              id: `import_attempt_${randomUUID()}`,
              importSourceId: created.id,
              projectId,
              attempt: 1,
              queueJobId,
              status: "queued",
            },
          });
        }
        return tx.importSource.findUniqueOrThrow({ select: importSourceSelect, where: { id: created.id } });
      });
      return mapImportSource(row as ImportSourceRecord);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.db.importSource.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          select: importSourceSelect,
        });
        if (duplicate) return this.resolveReplay(duplicate as ImportSourceRecord, requestHash);
      }
      throw error;
    }
  }

  async materializeSubmissionFileSource(
    tx: Prisma.TransactionClient,
    input: Readonly<{
      principalId: string;
      projectId: string;
      submissionIntentId: string;
      position: number;
      fileAssetId: string;
    }>,
  ): Promise<string> {
    const idempotencyKey = `intent:${input.submissionIntentId}:source:${input.position}`;
    const request = createImportSourceRequestSchema.parse({
      kind: "file",
      fileAssetId: input.fileAssetId,
    }) as Extract<CreateImportSourceRequest, { kind: "file" }>;
    const requestHash = hashRequest(request);
    const replay = await tx.importSource.findUnique({
      where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey } },
      select: { id: true, status: true, requestHash: true },
    });
    if (replay) {
      if (replay.requestHash !== requestHash) throw idempotencyConflictProblem();
      if (replay.status !== "ready") {
        throw importSourceStateConflictProblem(
          "The materialized SubmissionIntent source is not ready",
          "IMPORT_SOURCE_FILE_NOT_READY",
        );
      }
      return replay.id;
    }

    const resolved = await this.resolveLocalFile(tx, input.projectId, request);
    const sourceId = `source_${randomUUID()}`;
    const created = await tx.importSource.create({
      data: {
        id: sourceId,
        projectId: input.projectId,
        createdById: input.principalId,
        kind: "file",
        status: "pending",
        label: resolved.label,
        descriptor: undefined,
        request,
        requestHash,
        idempotencyKey,
      },
    });
    await tx.importSourceBlob.create({
      data: {
        id: `source_blob_${randomUUID()}`,
        importSourceId: sourceId,
        projectId: input.projectId,
        position: 0,
        blobId: resolved.blob.id,
        fileAssetId: input.fileAssetId,
        role: "primary",
        path: resolved.blob.path,
        mediaType: resolved.blob.mediaType,
        byteSize: resolved.blob.byteSize,
        sha256: resolved.blob.sha256,
      },
    });
    await tx.importSource.update({
      where: { id: sourceId },
      data: {
        status: "ready",
        descriptor: resolved.descriptor,
        checksum: resolved.checksum,
        revision: { increment: 1 },
      },
    });
    return sourceId;
  }

  async delete(principalId: string, sourceId: string, expectedRevision: number): Promise<void> {
    const current = await this.requireForEdit(principalId, sourceId);
    await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, current.projectId, principalId, "edit");
      const result = await tx.importSource.updateMany({
        where: { id: sourceId, projectId: current.projectId, revision: expectedRevision, status: { not: "deleted" } },
        data: {
          status: "deleted",
          deletedAt: new Date(),
          failureCode: null,
          failureDetail: null,
          revision: { increment: 1 },
        },
      });
      if (result.count !== 1) throw revisionConflictProblem();
    });
  }

  private async requireForEdit(principalId: string, sourceId: string) {
    const source = await this.db.importSource.findFirst({
      where: {
        id: sourceId,
        status: { not: "deleted" },
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "edit"),
          },
        },
      },
      select: importSourceSelect,
    });
    if (!source) throw notFoundProblem("Import source");
    return source;
  }

  private resolveReplay(source: ImportSourceRecord, requestHash: string): ImportSource {
    if (source.requestHash !== requestHash) throw idempotencyConflictProblem();
    return mapImportSource(source);
  }

  private async resolveLocalFile(
    tx: Prisma.TransactionClient,
    projectId: string,
    request: Extract<CreateImportSourceRequest, { kind: "file" | "design_md" }>,
  ) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "file_assets"
      WHERE "id" = ${request.fileAssetId} AND "project_id" = ${projectId}
      FOR SHARE
    `);
    const file = await tx.fileAsset.findFirst({
      where: {
        id: request.fileAssetId,
        projectId,
        status: "ready",
      },
      include: { blob: { include: { scans: { orderBy: { attempt: "desc" }, take: 1 } } } },
    });
    if (
      !file
      || !file.blob
      || file.blob.status !== "ready"
      || file.blob.deletedAt
      || file.blob.scans[0]?.status !== "clean"
    ) {
      throw importSourceStateConflictProblem("Only a verified, ready File can become an Import Source", "IMPORT_SOURCE_FILE_NOT_READY");
    }
    if (request.kind === "design_md") {
      const mediaType = file.detectedMediaType ?? file.declaredMediaType;
      if (!/^(text\/markdown|text\/plain)$/u.test(mediaType) || !/design\.md$/iu.test(file.originalName)) {
        throw validationProblem("DESIGN.md sources must reference a text Markdown file named DESIGN.md");
      }
    }
    const descriptor = request.kind === "design_md"
      ? { kind: "design_md" as const, fileAssetId: file.id, originalName: file.originalName, mediaType: file.detectedMediaType ?? file.declaredMediaType }
      : { kind: "file" as const, fileAssetId: file.id, originalName: file.originalName, mediaType: file.detectedMediaType ?? file.declaredMediaType };
    return {
      label: request.label ?? file.originalName,
      status: "ready" as const,
      descriptor,
      checksum: file.blob.sha256,
      blob: {
        id: file.blob.id,
        path: file.originalName,
        mediaType: file.blob.mediaType,
        byteSize: file.blob.byteSize,
        sha256: file.blob.sha256,
      },
    };
  }
}

function encodeCursor(cursor: SourceCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): SourceCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SourceCursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error("invalid");
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    throw validationProblem("cursor is invalid");
  }
}

function defaultExternalLabel(request: Exclude<CreateImportSourceRequest, { kind: "file" | "design_md" }>) {
  if (request.kind === "url_snapshot") return request.sourceUrl;
  if (request.kind === "github_snapshot") return `${request.repository}@${request.ref}`;
  return `${request.fileKey}${request.versionId ? `@${request.versionId}` : ""}`;
}
