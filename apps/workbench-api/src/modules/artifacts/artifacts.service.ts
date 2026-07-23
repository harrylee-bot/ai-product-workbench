import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  artifactCreationSchema,
  artifactListSchema,
  artifactSchema,
  artifactVersionDetailSchema,
  artifactVersionListItemSchema,
  artifactVersionListSchema,
  canonicalJson,
  createArtifactRequestSchema,
  prdDocumentSchema,
  prototypeDocumentSchema,
  prototypeImageAssetSchema,
  type Artifact,
  type ArtifactCreation,
  type ArtifactList,
  type CreateArtifactRequest,
  type CreateArtifactVersionRequest,
  type ArtifactVersionDetail,
  type ArtifactVersionList,
  type PrdDocument,
  type PrototypeDocument,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  artifactCreationConflictProblem,
  artifactVersionWriteConflictProblem,
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import {
  READY_BLOB_STORAGE_PORT,
  type ReadyBlobStoragePort,
} from "../../platform/object-storage/object-storage.port.js";
import { readReadyObject } from "../../platform/object-storage/read-ready-object.js";
import { readyObjectIntegrityRecorder } from "../../platform/object-storage/ready-object-integrity.js";
import {
  projectMembershipFilter,
  type ProjectCapability,
} from "../access/access.service.js";
import { assertProjectCapability, lockActiveProject } from "../projects/project-lock.js";

type ArtifactCursor = { updatedAt: string; id: string };
type ArtifactVersionCursor = { version: number; id: string };
type StoredArtifactBlob = {
  storageKey: string;
  sha256: string;
  byteSize: bigint;
  mediaType: string;
  status: string;
  deletedAt: Date | null;
};

const currentVersionSelect = {
  id: true,
  artifactId: true,
  version: true,
  schemaVersion: true,
  status: true,
  checksum: true,
  createdByRunId: true,
  createdAt: true,
} as const;

const editedVersionSelect = {
  id: true,
  artifactId: true,
  version: true,
  schemaVersion: true,
  status: true,
  content: true,
  contentBlobId: true,
  checksum: true,
  citations: true,
  createdByRunId: true,
  knowledgeReleaseId: true,
  createdAt: true,
  artifact: { select: { kind: true } },
} as const;

const artifactCreationArtifactSelect = {
  id: true,
  projectId: true,
  kind: true,
  title: true,
  revision: true,
  currentVersionId: true,
  currentVersion: { select: currentVersionSelect },
  createdAt: true,
  updatedAt: true,
} as const;

const artifactCreationVersionSelect = {
  ...editedVersionSelect,
  contentBlob: {
    select: {
      id: true,
      mediaType: true,
      byteSize: true,
      sha256: true,
      status: true,
      deletedAt: true,
    },
  },
} as const;

const artifactCreationReceiptInclude = {
  artifact: { select: artifactCreationArtifactSelect },
  artifactVersion: { select: artifactCreationVersionSelect },
} as const;

export type CreateArtifactVersionResult = {
  detail: ArtifactVersionDetail;
  artifactRevision: number;
};

@Injectable()
export class ArtifactsService {
  constructor(
    private readonly db: WorkbenchDbService,
    @Inject(READY_BLOB_STORAGE_PORT) private readonly storage: ReadyBlobStoragePort,
  ) {}

  async list(
    principalId: string,
    projectId: string,
    kind?: Artifact["kind"],
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ArtifactList> {
    await this.requireAuthorizedProject(principalId, projectId);
    const limit = clampLimit(requestedLimit);
    const decodedCursor = cursor ? decodeArtifactCursor(cursor) : undefined;
    const items = await this.db.artifact.findMany({
      where: {
        projectId,
        ...(kind ? { kind } : {}),
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
        ...(decodedCursor
          ? {
              OR: [
                { updatedAt: { lt: new Date(decodedCursor.updatedAt) } },
                { updatedAt: new Date(decodedCursor.updatedAt), id: { lt: decodedCursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        projectId: true,
        kind: true,
        title: true,
        revision: true,
        currentVersionId: true,
        currentVersion: { select: currentVersionSelect },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasNextPage = items.length > limit;
    const page = hasNextPage ? items.slice(0, limit) : items;
    const last = page.at(-1);
    return artifactListSchema.parse({
      items: page.map(mapArtifact),
      nextCursor: hasNextPage && last
        ? encodeArtifactCursor({ updatedAt: last.updatedAt.toISOString(), id: last.id })
        : null,
    });
  }

  async get(principalId: string, artifactId: string): Promise<Artifact> {
    const artifact = await this.db.artifact.findFirst({
      where: {
        id: artifactId,
        currentVersionId: { not: null },
        currentVersion: { is: { status: "ready" } },
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
      },
      select: {
        id: true,
        projectId: true,
        kind: true,
        title: true,
        revision: true,
        currentVersionId: true,
        currentVersion: { select: currentVersionSelect },
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!artifact || !hasValidCurrentVersion(artifact)) throw notFoundProblem("Artifact");
    return mapArtifact(artifact);
  }

  async create(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    request: CreateArtifactRequest,
  ): Promise<ArtifactCreation> {
    validateIdempotencyKey(idempotencyKey);
    const command = createArtifactRequestSchema.parse(request);
    await this.requireAuthorizedProject(principalId, projectId, "edit");
    const requestHash = hashRequest(command);
    const replay = await this.findCreationReceipt(projectId, idempotencyKey);
    if (replay) return resolveCreationReplay(replay, principalId, requestHash);

    try {
      return await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "edit");
        const duplicate = await tx.artifactCreationReceipt.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          include: artifactCreationReceiptInclude,
        });
        if (duplicate) return resolveCreationReplay(duplicate, principalId, requestHash);

        const sourceFile = await tx.fileAsset.findFirst({
          where: { id: command.source.fileAssetId, projectId },
          select: {
            id: true,
            projectId: true,
            blobId: true,
            status: true,
            detectedMediaType: true,
            deletedAt: true,
            blob: {
              select: {
                id: true,
                sha256: true,
                mediaType: true,
                byteSize: true,
                status: true,
                deletedAt: true,
              },
            },
          },
        });
        if (
          !sourceFile
          || sourceFile.status !== "ready"
          || sourceFile.deletedAt !== null
          || !sourceFile.blobId
          || !sourceFile.blob
          || sourceFile.blob.id !== sourceFile.blobId
          || sourceFile.blob.status !== "ready"
          || sourceFile.blob.deletedAt !== null
          || sourceFile.detectedMediaType !== sourceFile.blob.mediaType
        ) {
          throw artifactCreationConflictProblem(
            "ARTIFACT_SOURCE_FILE_NOT_READY",
            "source.fileAssetId must identify a ready verified File in the target Project",
          );
        }
        if (!prototypeImageAssetSchema.shape.mediaType.safeParse(sourceFile.detectedMediaType).success) {
          throw artifactCreationConflictProblem(
            "ARTIFACT_SOURCE_MEDIA_TYPE_UNSUPPORTED",
            "Image Artifacts support image/png, image/jpeg, image/webp, or image/gif",
          );
        }
        safeByteSize(sourceFile.blob.byteSize);

        const artifact = await tx.artifact.create({
          data: { projectId, kind: "image", title: command.title },
        });
        const version = await tx.artifactVersion.create({
          data: {
            artifactId: artifact.id,
            projectId,
            version: 1,
            schemaVersion: 1,
            status: "staging",
            contentBlobId: sourceFile.blob.id,
            checksum: sourceFile.blob.sha256,
            citations: [],
          },
        });
        const readyVersion = await tx.artifactVersion.update({
          where: { id: version.id },
          data: { status: "ready" },
          select: artifactCreationVersionSelect,
        });
        const readyArtifact = await tx.artifact.update({
          where: { id: artifact.id },
          data: { currentVersionId: readyVersion.id },
          select: artifactCreationArtifactSelect,
        });
        await tx.artifactCreationReceipt.create({
          data: {
            projectId,
            artifactId: readyArtifact.id,
            artifactVersionId: readyVersion.id,
            sourceFileAssetId: sourceFile.id,
            sourceBlobId: sourceFile.blob.id,
            createdById: principalId,
            idempotencyKey,
            requestHash,
          },
        });
        return mapImageArtifactCreation(readyArtifact, readyVersion);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findCreationReceipt(projectId, idempotencyKey);
        if (raced) return resolveCreationReplay(raced, principalId, requestHash);
      }
      throw error;
    }
  }

  async createVersion(
    principalId: string,
    artifactId: string,
    expectedArtifactRevision: number,
    idempotencyKey: string,
    request: CreateArtifactVersionRequest,
  ): Promise<CreateArtifactVersionResult> {
    validateIdempotencyKey(idempotencyKey);
    await this.requireAuthorizedArtifact(principalId, artifactId, "edit");
    const documentSchemaVersion = editableDocumentSchemaVersion(request);
    const requestHash = hashRequest(request);
    const replay = await this.findEditReceipt(artifactId, idempotencyKey);
    if (replay) return resolveEditReplay(replay, principalId, requestHash);

    try {
      return await this.db.$transaction(async (tx) => {
        const artifacts = await tx.$queryRaw<Array<{
          id: string;
          projectId: string;
          kind: string;
          revision: number;
          currentVersionId: string | null;
        }>>(Prisma.sql`
          SELECT
            artifact."id",
            artifact."project_id" AS "projectId",
            artifact."kind"::TEXT AS "kind",
            artifact."revision",
            artifact."current_version_id" AS "currentVersionId"
          FROM "artifacts" AS artifact
          JOIN "projects" AS project ON project."id" = artifact."project_id"
          WHERE artifact."id" = ${artifactId}
            AND project."status" = 'active'
          FOR UPDATE OF artifact
        `);
        const artifact = artifacts[0];
        if (!artifact) throw notFoundProblem("Artifact");
        await assertProjectCapability(tx, artifact.projectId, principalId, "edit");

        const duplicate = await tx.artifactVersionEditReceipt.findUnique({
          where: { artifactId_idempotencyKey: { artifactId, idempotencyKey } },
          include: { resultVersion: { select: editedVersionSelect } },
        });
        if (duplicate) return resolveEditReplay(duplicate, principalId, requestHash);
        if (artifact.revision !== expectedArtifactRevision) throw revisionConflictProblem();
        if (
          (artifact.kind !== "prototype" && artifact.kind !== "prd")
          || artifact.kind !== request.kind
        ) {
          throw artifactVersionWriteConflictProblem(
            "ARTIFACT_KIND_NOT_EDITABLE",
            "ArtifactVersion write v1 only supports PRD and Prototype Artifacts",
          );
        }

        const base = await tx.artifactVersion.findUnique({
          where: {
            id_artifactId: {
              id: request.baseArtifactVersionId,
              artifactId,
            },
          },
          include: { assets: { orderBy: { assetId: "asc" } } },
        });
        if (
          !base
          || artifact.currentVersionId !== base.id
          || base.projectId !== artifact.projectId
          || base.status !== "ready"
          || (request.kind === "prototype"
            ? base.schemaVersion !== 1
            : base.schemaVersion !== 1 && base.schemaVersion !== 2)
          || base.content === null
          || base.contentBlobId !== null
        ) {
          throw artifactVersionWriteConflictProblem(
            "ARTIFACT_VERSION_BASE_NOT_CURRENT",
            "baseArtifactVersionId must be the current ready inline version",
          );
        }

        if (request.kind === "prototype") {
          const baseDocument = prototypeDocumentSchema.parse(base.content);
          assertPrototypeEditContinuity(baseDocument, request.document, base.assets);
        } else {
          const baseDocument = prdDocumentSchema.parse(base.content);
          if (prdDocumentSchemaVersion(baseDocument) !== base.schemaVersion) {
            throw artifactVersionWriteConflictProblem(
              "ARTIFACT_VERSION_BASE_NOT_CURRENT",
              "baseArtifactVersionId must be the current ready inline version",
            );
          }
          if (base.schemaVersion !== documentSchemaVersion) {
            throw artifactVersionWriteConflictProblem(
              "ARTIFACT_DOCUMENT_SCHEMA_VERSION_MISMATCH",
              "Edited PrdDocument must retain the base schema version",
            );
          }
          assertPrdEditContinuity(baseDocument, request.document);
          if (base.assets.length > 0) {
            throw artifactVersionWriteConflictProblem(
              "ARTIFACT_VERSION_ASSET_CONFLICT",
              "Edited PRDDocument cannot inherit binary asset pins",
            );
          }
        }
        const latest = await tx.artifactVersion.findFirst({
          where: { artifactId },
          select: { version: true },
          orderBy: { version: "desc" },
        });
        const checksum = createHash("sha256")
          .update(canonicalJson(request.document))
          .digest("hex");
        const created = await tx.artifactVersion.create({
          data: {
            artifactId,
            projectId: artifact.projectId,
            version: (latest?.version ?? 0) + 1,
            schemaVersion: documentSchemaVersion,
            status: "staging",
            content: request.document as Prisma.InputJsonValue,
            checksum,
            citations: base.citations as Prisma.InputJsonValue,
            createdByRunId: null,
            knowledgeReleaseId: base.knowledgeReleaseId,
          },
        });
        if (base.assets.length > 0) {
          await tx.artifactVersionAsset.createMany({
            data: base.assets.map((asset) => ({
              artifactVersionId: created.id,
              artifactId,
              projectId: artifact.projectId,
              assetId: asset.assetId,
              kind: asset.kind,
              blobId: asset.blobId,
              mediaType: asset.mediaType,
              byteSize: asset.byteSize,
              sha256: asset.sha256,
              metadata: asset.metadata as Prisma.InputJsonValue,
            })),
          });
        }
        const ready = await tx.artifactVersion.update({
          where: { id: created.id },
          data: { status: "ready" },
          select: editedVersionSelect,
        });
        const updatedArtifact = await tx.artifact.update({
          where: { id: artifactId },
          data: {
            currentVersionId: ready.id,
            revision: { increment: 1 },
          },
          select: { revision: true },
        });
        await tx.artifactVersionEditReceipt.create({
          data: {
            artifactId,
            baseArtifactVersionId: base.id,
            resultArtifactVersionId: ready.id,
            expectedArtifactRevision,
            resultArtifactRevision: updatedArtifact.revision,
            createdById: principalId,
            idempotencyKey,
            requestHash,
          },
        });
        return {
          detail: mapEditedArtifactVersion(ready),
          artifactRevision: updatedArtifact.revision,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findEditReceipt(artifactId, idempotencyKey);
        if (raced) return resolveEditReplay(raced, principalId, requestHash);
      }
      throw error;
    }
  }

  async listVersions(
    principalId: string,
    artifactId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ArtifactVersionList> {
    await this.requireAuthorizedArtifact(principalId, artifactId);
    const limit = clampLimit(requestedLimit);
    const decodedCursor = cursor ? decodeArtifactVersionCursor(cursor) : undefined;
    const versions = await this.db.artifactVersion.findMany({
      where: {
        artifactId,
        status: "ready",
        artifact: {
          is: {
            id: artifactId,
            project: {
              is: {
                status: "active",
                members: projectMembershipFilter(principalId, "read"),
              },
            },
          },
        },
        AND: [
          {
            OR: [
              { contentBlobId: null },
              { contentBlob: { is: { status: "ready", deletedAt: null } } },
            ],
          },
          ...(decodedCursor
            ? [{
                OR: [
                  { version: { lt: decodedCursor.version } },
                  { version: decodedCursor.version, id: { lt: decodedCursor.id } },
                ],
              }]
            : []),
        ],
      },
      select: {
        id: true,
        artifactId: true,
        version: true,
        schemaVersion: true,
        status: true,
        contentBlobId: true,
        checksum: true,
        createdByRunId: true,
        createdAt: true,
        artifact: { select: { kind: true } },
      },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasNextPage = versions.length > limit;
    const page = hasNextPage ? versions.slice(0, limit) : versions;
    const last = page.at(-1);
    return artifactVersionListSchema.parse({
      items: page.map((version) => artifactVersionListItemSchema.parse({
        artifactId: version.artifactId,
        artifactVersionId: version.id,
        version: version.version,
        kind: version.artifact.kind,
        schemaVersion: version.schemaVersion,
        status: version.status,
        checksum: version.checksum,
        createdByRunId: version.createdByRunId,
        createdAt: version.createdAt.toISOString(),
        contentMode: version.contentBlobId === null ? "inline" : "blob",
      })),
      nextCursor: hasNextPage && last
        ? encodeArtifactVersionCursor({ version: last.version, id: last.id })
        : null,
    });
  }

  async getVersion(
    principalId: string,
    artifactId: string,
    artifactVersionId: string,
  ): Promise<{ detail: ArtifactVersionDetail; etag: string }> {
    const version = await this.db.artifactVersion.findFirst({
      where: {
        id: artifactVersionId,
        artifactId,
        artifact: {
          is: {
            id: artifactId,
            project: {
              is: {
                status: "active",
                members: projectMembershipFilter(principalId, "read"),
              },
            },
          },
        },
        AND: [
          exactArtifactVersionReadFilter(),
          {
            OR: [
              { contentBlobId: null },
              { contentBlob: { is: { status: "ready", deletedAt: null } } },
            ],
          },
        ],
      },
      select: {
        id: true,
        artifactId: true,
        version: true,
        schemaVersion: true,
        status: true,
        content: true,
        contentBlobId: true,
        checksum: true,
        citations: true,
        createdByRunId: true,
        knowledgeReleaseId: true,
        createdAt: true,
        artifact: { select: { kind: true } },
        contentBlob: {
          select: {
            id: true,
            mediaType: true,
            byteSize: true,
            sha256: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!version || !isExactlyReadableArtifactVersion(version)) {
      throw notFoundProblem("Artifact version");
    }

    const common = {
      artifactId: version.artifactId,
      artifactVersionId: version.id,
      version: version.version,
      kind: version.artifact.kind,
      schemaVersion: version.schemaVersion,
      status: version.status,
      checksum: version.checksum,
      citations: version.citations,
      createdByRunId: version.createdByRunId,
      knowledgeReleaseId: version.knowledgeReleaseId,
      createdAt: version.createdAt.toISOString(),
    };
    let detail: ArtifactVersionDetail;
    if (version.contentBlobId === null) {
      if (version.contentBlob !== null) throw new Error("Artifact version content mode invariant violated");
      detail = artifactVersionDetailSchema.parse({
        ...common,
        contentMode: "inline",
        content: version.content,
      });
    } else {
      if (version.content !== null || !version.contentBlob
        || version.contentBlob.status !== "ready" || version.contentBlob.deletedAt !== null) {
        throw notFoundProblem("Artifact version");
      }
      detail = artifactVersionDetailSchema.parse({
        ...common,
        contentMode: "blob",
        blob: {
          blobId: version.contentBlob.id,
          mediaType: version.contentBlob.mediaType,
          byteSize: safeByteSize(version.contentBlob.byteSize),
          sha256: version.contentBlob.sha256,
          fileName: null,
        },
      });
    }
    return { detail, etag: artifactVersionEtag(detail) };
  }

  async getContent(
    principalId: string,
    artifactId: string,
    artifactVersionId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
    signal?: AbortSignal,
  ) {
    const version = await this.db.artifactVersion.findFirst({
      where: {
        id: artifactVersionId,
        artifactId,
        contentBlobId: { not: null },
        ...exactArtifactVersionReadFilter(),
        artifact: {
          is: {
            id: artifactId,
            project: {
              is: {
                status: "active",
                members: projectMembershipFilter(principalId, "read"),
              },
            },
          },
        },
        contentBlob: { is: { status: "ready", deletedAt: null } },
      },
      select: {
        status: true,
        createdByRunId: true,
        contentBlob: {
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
    const blob = version?.contentBlob;
    if (
      !version
      || !isExactlyReadableArtifactVersion(version)
      || !blob
      || blob.status !== "ready"
      || blob.deletedAt !== null
    ) {
      throw notFoundProblem("Artifact version content");
    }

    return this.readBlob(blob, rangeHeader, ifNoneMatch, signal);
  }

  async getAssetContent(
    principalId: string,
    artifactId: string,
    artifactVersionId: string,
    assetId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
    signal?: AbortSignal,
  ) {
    const pin = await this.db.artifactVersionAsset.findFirst({
      where: {
        artifactVersionId,
        artifactId,
        assetId,
        artifactVersion: {
          is: {
            id: artifactVersionId,
            artifactId,
            ...exactArtifactVersionReadFilter(),
            artifact: {
              is: {
                id: artifactId,
                kind: { in: ["prototype", "design_system"] },
                project: {
                  is: {
                    status: "active",
                    members: projectMembershipFilter(principalId, "read"),
                  },
                },
              },
            },
          },
        },
        blob: { is: { status: "ready", deletedAt: null } },
      },
      select: {
        artifactVersion: {
          select: {
            status: true,
            createdByRunId: true,
          },
        },
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
    if (
      !pin
      || !isExactlyReadableArtifactVersion(pin.artifactVersion)
      || pin.blob.status !== "ready"
      || pin.blob.deletedAt !== null
    ) {
      throw notFoundProblem("Artifact version asset");
    }
    return this.readBlob(pin.blob, rangeHeader, ifNoneMatch, signal);
  }

  private async readBlob(
    blob: StoredArtifactBlob,
    rangeHeader?: string,
    ifNoneMatch?: string,
    signal?: AbortSignal,
  ) {
    return readReadyObject(this.storage, {
      storageKey: blob.storageKey,
      sha256: blob.sha256,
      byteSize: safeByteSize(blob.byteSize),
      mediaType: blob.mediaType,
    }, rangeHeader, ifNoneMatch, {
      signal,
      recordIntegrityFailure: readyObjectIntegrityRecorder(this.db),
    });
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

  private findCreationReceipt(projectId: string, idempotencyKey: string) {
    return this.db.artifactCreationReceipt.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      include: artifactCreationReceiptInclude,
    });
  }

  private findEditReceipt(artifactId: string, idempotencyKey: string) {
    return this.db.artifactVersionEditReceipt.findUnique({
      where: { artifactId_idempotencyKey: { artifactId, idempotencyKey } },
      include: { resultVersion: { select: editedVersionSelect } },
    });
  }

  private async requireAuthorizedArtifact(
    principalId: string,
    artifactId: string,
    capability: ProjectCapability = "read",
  ) {
    const artifact = await this.db.artifact.findFirst({
      where: {
        id: artifactId,
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, capability),
          },
        },
      },
      select: { id: true },
    });
    if (!artifact) throw notFoundProblem("Artifact");
  }
}

function resolveCreationReplay(
  receipt: {
    createdById: string;
    requestHash: string;
    artifact: Parameters<typeof mapImageArtifactCreation>[0];
    artifactVersion: Parameters<typeof mapImageArtifactCreation>[1];
  },
  principalId: string,
  requestHash: string,
): ArtifactCreation {
  if (receipt.createdById !== principalId || receipt.requestHash !== requestHash) {
    throw idempotencyConflictProblem();
  }
  return mapImageArtifactCreation(receipt.artifact, receipt.artifactVersion);
}

function mapImageArtifactCreation(
  artifact: Parameters<typeof mapArtifact>[0],
  version: {
    id: string;
    artifactId: string;
    version: number;
    schemaVersion: number;
    status: string;
    content: unknown;
    contentBlobId: string | null;
    checksum: string;
    citations: unknown;
    createdByRunId: string | null;
    knowledgeReleaseId: string | null;
    createdAt: Date;
    artifact: { kind: string };
    contentBlob: {
      id: string;
      mediaType: string;
      byteSize: bigint;
      sha256: string;
      status: string;
      deletedAt: Date | null;
    } | null;
  },
): ArtifactCreation {
  if (
    artifact.kind !== "image"
    || version.artifact.kind !== "image"
    || version.content !== null
    || version.contentBlobId === null
    || !version.contentBlob
    || version.contentBlob.id !== version.contentBlobId
    || version.contentBlob.status !== "ready"
    || version.contentBlob.deletedAt !== null
  ) {
    throw new Error("Artifact creation receipt invariant violated");
  }
  const detail = artifactVersionDetailSchema.parse({
    artifactId: version.artifactId,
    artifactVersionId: version.id,
    version: version.version,
    kind: version.artifact.kind,
    schemaVersion: version.schemaVersion,
    status: version.status,
    checksum: version.checksum,
    citations: version.citations,
    createdByRunId: version.createdByRunId,
    knowledgeReleaseId: version.knowledgeReleaseId,
    createdAt: version.createdAt.toISOString(),
    contentMode: "blob",
    blob: {
      blobId: version.contentBlob.id,
      mediaType: version.contentBlob.mediaType,
      byteSize: safeByteSize(version.contentBlob.byteSize),
      sha256: version.contentBlob.sha256,
      fileName: null,
    },
  });
  return artifactCreationSchema.parse({
    artifact: mapArtifact(artifact),
    artifactVersion: detail,
  });
}

function resolveEditReplay(
  receipt: {
    createdById: string;
    requestHash: string;
    resultArtifactRevision: number;
    resultVersion: Parameters<typeof mapEditedArtifactVersion>[0];
  },
  principalId: string,
  requestHash: string,
): CreateArtifactVersionResult {
  if (receipt.createdById !== principalId || receipt.requestHash !== requestHash) {
    throw idempotencyConflictProblem();
  }
  return {
    detail: mapEditedArtifactVersion(receipt.resultVersion),
    artifactRevision: receipt.resultArtifactRevision,
  };
}

function mapEditedArtifactVersion(version: {
  id: string;
  artifactId: string;
  version: number;
  schemaVersion: number;
  status: string;
  content: unknown;
  contentBlobId: string | null;
  checksum: string;
  citations: unknown;
  createdByRunId: string | null;
  knowledgeReleaseId: string | null;
  createdAt: Date;
  artifact: { kind: string };
}): ArtifactVersionDetail {
  if (
    (version.artifact.kind !== "prototype" && version.artifact.kind !== "prd")
    || version.contentBlobId !== null
  ) {
    throw new Error("ArtifactVersion edit receipt invariant violated");
  }
  return artifactVersionDetailSchema.parse({
    artifactId: version.artifactId,
    artifactVersionId: version.id,
    version: version.version,
    kind: version.artifact.kind,
    schemaVersion: version.schemaVersion,
    status: version.status,
    checksum: version.checksum,
    citations: version.citations,
    createdByRunId: version.createdByRunId,
    knowledgeReleaseId: version.knowledgeReleaseId,
    createdAt: version.createdAt.toISOString(),
    contentMode: "inline",
    content: version.content,
  });
}

function assertPrdEditContinuity(base: PrdDocument, next: PrdDocument) {
  if (next.documentId !== base.documentId) {
    throw artifactVersionWriteConflictProblem(
      "ARTIFACT_DOCUMENT_ID_MISMATCH",
      "Edited PrdDocument must retain the base documentId",
    );
  }
  if (next.revision.number <= base.revision.number) {
    throw artifactVersionWriteConflictProblem(
      "ARTIFACT_DOCUMENT_REVISION_CONFLICT",
      "Edited PrdDocument revision number must advance beyond the base revision",
    );
  }
  if (canonicalJson(next.citations) !== canonicalJson(base.citations)) {
    throw artifactVersionWriteConflictProblem(
      "ARTIFACT_CITATIONS_CONFLICT",
      "Edited PrdDocument must retain the base citations",
    );
  }
}

function editableDocumentSchemaVersion(request: CreateArtifactVersionRequest): 1 | 2 {
  return request.kind === "prd" ? prdDocumentSchemaVersion(request.document) : 1;
}

function prdDocumentSchemaVersion(document: PrdDocument): 1 | 2 {
  return document.protocol === "workbench.prd.v2" ? 2 : 1;
}

function assertPrototypeEditContinuity(
  base: PrototypeDocument,
  next: PrototypeDocument,
  pins: Array<{ assetId: string; metadata: unknown }>,
) {
  if (next.documentId !== base.documentId) {
    throw artifactVersionWriteConflictProblem(
      "ARTIFACT_DOCUMENT_ID_MISMATCH",
      "Edited PrototypeDocument must retain the base documentId",
    );
  }
  if (next.revision <= base.revision) {
    throw artifactVersionWriteConflictProblem(
      "ARTIFACT_DOCUMENT_REVISION_CONFLICT",
      "Edited PrototypeDocument revision must advance beyond the base revision",
    );
  }

  const binaryAssets = next.assets.filter((asset) => asset.kind === "image" || asset.kind === "font");
  const pinMetadata = new Map(pins.map((pin) => [pin.assetId, canonicalJson(pin.metadata)]));
  if (
    binaryAssets.length !== pins.length
    || binaryAssets.some((asset) => pinMetadata.get(asset.id) !== canonicalJson(asset))
  ) {
    throw artifactVersionWriteConflictProblem(
      "ARTIFACT_VERSION_ASSET_CONFLICT",
      "Edited PrototypeDocument must retain every binary asset pinned by the base version",
    );
  }
}

function hasValidCurrentVersion(artifact: {
  id: string;
  currentVersionId: string | null;
  currentVersion: { id: string; artifactId: string; status: string } | null;
}) {
  return artifact.currentVersionId !== null
    && artifact.currentVersion?.id === artifact.currentVersionId
    && artifact.currentVersion.artifactId === artifact.id
    && artifact.currentVersion.status === "ready";
}

function exactArtifactVersionReadFilter(): Prisma.ArtifactVersionWhereInput {
  return {
    OR: [
      { status: "ready" },
      { status: "staging", createdByRunId: { not: null } },
    ],
  };
}

function isExactlyReadableArtifactVersion(version: {
  status: string;
  createdByRunId: string | null;
}) {
  return version.status === "ready"
    || (version.status === "staging" && version.createdByRunId !== null);
}

function mapArtifact(artifact: {
  id: string;
  projectId: string;
  kind: Artifact["kind"];
  title: string;
  revision: number;
  currentVersionId: string | null;
  currentVersion: {
    id: string;
    artifactId: string;
    version: number;
    schemaVersion: number;
    status: "staging" | "ready" | "rejected";
    checksum: string;
    createdByRunId: string | null;
    createdAt: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}): Artifact {
  if (!hasValidCurrentVersion(artifact)) throw new Error("Artifact current version invariant violated");
  return artifactSchema.parse({
    id: artifact.id,
    projectId: artifact.projectId,
    kind: artifact.kind,
    title: artifact.title,
    revision: artifact.revision,
    currentVersion: artifact.currentVersion
      ? {
          artifactId: artifact.id,
          artifactVersionId: artifact.currentVersion.id,
          version: artifact.currentVersion.version,
          kind: artifact.kind,
          schemaVersion: artifact.currentVersion.schemaVersion,
          status: artifact.currentVersion.status,
          checksum: artifact.currentVersion.checksum,
          createdByRunId: artifact.currentVersion.createdByRunId,
          createdAt: artifact.currentVersion.createdAt.toISOString(),
        }
      : null,
    createdAt: artifact.createdAt.toISOString(),
    updatedAt: artifact.updatedAt.toISOString(),
  });
}

function clampLimit(requestedLimit?: number) {
  return Math.min(Math.max(requestedLimit ?? 30, 1), 100);
}

function safeByteSize(value: bigint) {
  const byteSize = Number(value);
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) {
    throw new Error("Artifact Blob byte size is outside the JSON safe integer range");
  }
  return byteSize;
}

export function artifactVersionEtag(detail: ArtifactVersionDetail) {
  const digest = createHash("sha256").update(canonicalJson(detail)).digest("hex");
  return "\"" + digest + "\"";
}

export function encodeArtifactCursor(cursor: ArtifactCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeArtifactCursor(value: string): ArtifactCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ArtifactCursor>;
    if (!parsed.id || !parsed.updatedAt || Number.isNaN(Date.parse(parsed.updatedAt))) throw new Error("invalid cursor");
    return { id: parsed.id, updatedAt: parsed.updatedAt };
  } catch {
    throw validationProblem("The Artifact cursor is invalid");
  }
}

export function encodeArtifactVersionCursor(cursor: ArtifactVersionCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeArtifactVersionCursor(value: string): ArtifactVersionCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ArtifactVersionCursor>;
    if (!parsed.id || !Number.isSafeInteger(parsed.version) || (parsed.version ?? 0) < 1) {
      throw new Error("invalid cursor");
    }
    return { id: parsed.id, version: parsed.version } as ArtifactVersionCursor;
  } catch {
    throw validationProblem("The Artifact version cursor is invalid");
  }
}
