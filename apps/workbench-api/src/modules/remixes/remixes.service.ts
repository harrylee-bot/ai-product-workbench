import { createHash, randomUUID } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  canonicalJson,
  createProjectRemixResponseSchema,
  projectReleaseBoardSnapshotSchema,
  projectReleaseManifestSchema,
  shareTokenSchema,
  type CreateProjectRemixRequest,
  type CreateProjectRemixResponse,
  type JsonValue,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  ProblemException,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";

const defaultRemixTitle = "Remixed project";
const insertChunkSize = 500;

const remixShareSelect = {
  id: true,
  scope: true,
  status: true,
  expiresAt: true,
  release: {
    select: {
      id: true,
      projectId: true,
      status: true,
      boardSnapshot: true,
      boardChecksum: true,
      manifest: true,
      manifestSha256: true,
      artifactPins: {
        orderBy: { position: "asc" as const },
        select: {
          position: true,
          artifactId: true,
          artifactVersionId: true,
          title: true,
          kind: true,
          artifactVersion: {
            select: {
              id: true,
              artifactId: true,
              projectId: true,
              version: true,
              schemaVersion: true,
              status: true,
              content: true,
              contentBlobId: true,
              checksum: true,
              citations: true,
              knowledgeReleaseId: true,
              artifact: {
                select: {
                  id: true,
                  projectId: true,
                },
              },
              contentBlob: {
                select: {
                  id: true,
                  status: true,
                  byteSize: true,
                  deletedAt: true,
                },
              },
              knowledgeRelease: {
                select: {
                  id: true,
                  status: true,
                  workspaceId: true,
                },
              },
              assets: {
                orderBy: { assetId: "asc" as const },
                select: {
                  artifactVersionId: true,
                  artifactId: true,
                  projectId: true,
                  assetId: true,
                  kind: true,
                  blobId: true,
                  mediaType: true,
                  byteSize: true,
                  sha256: true,
                  metadata: true,
                  blob: {
                    select: {
                      id: true,
                      status: true,
                      deletedAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ShareGrantSelect;

type RemixShare = Prisma.ShareGrantGetPayload<{ select: typeof remixShareSelect }>;
type RemixLineage = Prisma.ProjectLineageGetPayload<{ include: { targetProject: true } }>;

@Injectable()
export class RemixesService {
  constructor(private readonly db: WorkbenchDbService) {}

  async create(
    principalId: string,
    rawToken: string,
    idempotencyKey: string,
    input: CreateProjectRemixRequest,
  ): Promise<CreateProjectRemixResponse> {
    if (!shareTokenSchema.safeParse(rawToken).success) throw notFoundProblem("Share");
    validateIdempotencyKey(idempotencyKey);
    const tokenHash = hashShareToken(rawToken);
    const requestHash = hashRequest(input);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.createOnce(principalId, tokenHash, idempotencyKey, requestHash, input);
      } catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError
          && ["P2002", "P2034"].includes(error.code);
        if (!retryable) throw error;
        const replay = await this.findReplay(principalId, tokenHash, idempotencyKey);
        if (replay) return resolveIdempotentRemix(replay, requestHash);
        if (error.code !== "P2034" || attempt === 2) throw error;
      }
    }
    throw new Error("REMIX_SERIALIZATION_RETRY_EXHAUSTED");
  }

  private createOnce(
    principalId: string,
    tokenHash: string,
    idempotencyKey: string,
    requestHash: string,
    input: CreateProjectRemixRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const lockedShares = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "share_grants"
        WHERE "token_hash" = ${tokenHash}
        FOR SHARE
      `);
      if (lockedShares.length !== 1) throw notFoundProblem("Share");

      const share = await tx.shareGrant.findUnique({
        where: { tokenHash },
        select: remixShareSelect,
      });
      if (share === null) throw notFoundProblem("Share");

      const memberships = await tx.$queryRaw<Array<{ workspaceId: string }>>(Prisma.sql`
        SELECT "workspace_id" AS "workspaceId"
        FROM "workspace_members"
        WHERE "workspace_id" = ${input.workspaceId}
          AND "principal_id" = ${principalId}
        FOR SHARE
      `);
      if (memberships.length !== 1) throw notFoundProblem("Workspace");

      const existing = await tx.projectLineage.findUnique({
        where: {
          sourceShareId_createdById_idempotencyKey: {
            sourceShareId: share.id,
            createdById: principalId,
            idempotencyKey,
          },
        },
        include: { targetProject: true },
      });
      if (existing) return resolveIdempotentRemix(existing, requestHash);

      assertRemixableShare(share, new Date());
      const source = validateSourceRelease(share, input.workspaceId);
      const targetProject = await tx.project.create({
        data: {
          workspaceId: input.workspaceId,
          createdById: principalId,
          title: input.title ?? defaultRemixTitle,
        },
      });
      await tx.projectMember.create({
        data: {
          projectId: targetProject.id,
          workspaceId: input.workspaceId,
          principalId,
          role: "owner",
        },
      });
      await tx.thread.create({
        data: {
          projectId: targetProject.id,
          createdById: principalId,
          title: "Main",
        },
      });
      const targetBoard = await tx.board.create({
        data: {
          projectId: targetProject.id,
          viewport: source.board.viewport as Prisma.InputJsonValue,
        },
      });

      const artifactIds = new Map<string, string>();
      const versionIds = new Map<string, string>();
      for (const pin of source.pins) {
        artifactIds.set(pin.artifactId, `artifact_${randomUUID()}`);
        versionIds.set(pin.artifactVersionId, `version_${randomUUID()}`);
      }

      const targetArtifacts = source.pins.map((pin) => ({
        id: requireMappedId(artifactIds, pin.artifactId, "artifact"),
        projectId: targetProject.id,
        kind: pin.kind,
        title: pin.title,
      }));
      for (const data of chunks(targetArtifacts, insertChunkSize)) {
        await tx.artifact.createMany({ data });
      }

      const targetVersions = source.pins.map((pin) => {
        const sourceVersion = pin.artifactVersion;
        return {
          id: requireMappedId(versionIds, pin.artifactVersionId, "artifact version"),
          artifactId: requireMappedId(artifactIds, pin.artifactId, "artifact"),
          projectId: targetProject.id,
          version: 1,
          schemaVersion: sourceVersion.schemaVersion,
          status: "staging" as const,
          ...(sourceVersion.content === null
            ? { contentBlobId: requireValue(sourceVersion.contentBlobId, "Artifact content Blob") }
            : { content: sourceVersion.content as Prisma.InputJsonValue }),
          checksum: sourceVersion.checksum,
          citations: sourceVersion.citations as Prisma.InputJsonValue,
          knowledgeReleaseId: sourceVersion.knowledgeReleaseId,
        };
      });
      for (const data of chunks(targetVersions, insertChunkSize)) {
        await tx.artifactVersion.createMany({ data });
      }

      const targetAssets = source.pins.flatMap((pin) => {
        const sourceVersion = pin.artifactVersion;
        return sourceVersion.assets.map((asset) => ({
          artifactVersionId: requireMappedId(versionIds, pin.artifactVersionId, "artifact version"),
          artifactId: requireMappedId(artifactIds, pin.artifactId, "artifact"),
          projectId: targetProject.id,
          assetId: asset.assetId,
          kind: asset.kind,
          blobId: asset.blobId,
          mediaType: asset.mediaType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          metadata: asset.metadata as Prisma.InputJsonValue,
        }));
      });
      for (const data of chunks(targetAssets, insertChunkSize)) {
        await tx.artifactVersionAsset.createMany({ data });
      }

      for (const ids of chunks([...versionIds.values()], insertChunkSize)) {
        await tx.artifactVersion.updateMany({
          where: { id: { in: ids } },
          data: { status: "ready" },
        });
      }
      const currentVersionMappings = source.pins.map((pin) => [
        requireMappedId(artifactIds, pin.artifactId, "artifact"),
        requireMappedId(versionIds, pin.artifactVersionId, "artifact version"),
      ] as const);
      for (const mappings of chunks(currentVersionMappings, insertChunkSize)) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "artifacts" AS artifact
          SET "current_version_id" = mapping."version_id", "updated_at" = clock_timestamp()
          FROM (
            VALUES ${Prisma.join(mappings.map(([artifactId, versionId]) => Prisma.sql`
              (${artifactId}::text, ${versionId}::text)
            `))}
          ) AS mapping("artifact_id", "version_id")
          WHERE artifact."id" = mapping."artifact_id"
            AND artifact."project_id" = ${targetProject.id}
        `);
      }

      if (source.board.nodes.length > 0) {
        await tx.boardNode.createMany({
          data: source.board.nodes.map((node) => {
            const targetArtifactId = node.artifactId === null
              ? null
              : requireMappedId(artifactIds, node.artifactId, "artifact");
            const targetVersionId = node.artifactVersionId === null
              ? null
              : requireMappedId(versionIds, node.artifactVersionId, "artifact version");
            return {
              boardId: targetBoard.id,
              projectId: targetProject.id,
              nodeKey: node.id,
              parentNodeKey: node.parentNodeId,
              sortOrder: node.order,
              kind: node.kind,
              position: node.position,
              ...(node.size === null ? {} : { size: node.size }),
              artifactId: targetArtifactId,
              artifactVersionId: targetVersionId,
              data: node.data as Prisma.InputJsonValue,
            };
          }),
        });
      }
      if (source.board.edges.length > 0) {
        await tx.boardEdge.createMany({
          data: source.board.edges.map((edge) => ({
            boardId: targetBoard.id,
            edgeKey: edge.id,
            sourceNodeKey: edge.sourceNodeId,
            targetNodeKey: edge.targetNodeId,
            kind: edge.kind,
            data: edge.data as Prisma.InputJsonValue,
          })),
        });
      }

      const lineage = await tx.projectLineage.create({
        data: {
          targetProjectId: targetProject.id,
          sourceReleaseId: share.release.id,
          sourceShareId: share.id,
          createdById: principalId,
          workspaceId: input.workspaceId,
          idempotencyKey,
          requestHash,
        },
        include: { targetProject: true },
      });

      return mapRemixResult(lineage);
    }, {
      // Share revocation and Workspace membership removal take row locks.
      // READ COMMITTED makes the reads after a waited-on lock observe that change.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 30_000,
    });
  }

  private findReplay(principalId: string, tokenHash: string, idempotencyKey: string) {
    return this.db.projectLineage.findFirst({
      where: {
        createdById: principalId,
        idempotencyKey,
        sourceShare: { is: { tokenHash } },
        targetProject: {
          is: {
            members: { some: { principalId } },
          },
        },
      },
      include: { targetProject: true },
    });
  }
}

function resolveIdempotentRemix(lineage: RemixLineage, requestHash: string) {
  if (lineage.requestHash !== requestHash) throw idempotencyConflictProblem();
  return mapRemixResult(lineage);
}

function mapRemixResult(lineage: RemixLineage): CreateProjectRemixResponse {
  const project = lineage.targetProject;
  return createProjectRemixResponseSchema.parse({
    project: {
      id: project.id,
      workspaceId: project.workspaceId,
      title: project.title,
      summary: project.summary,
      status: project.status,
      revision: project.revision,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    lineage: {
      targetProjectId: lineage.targetProjectId,
      sourceReleaseId: lineage.sourceReleaseId,
      sourceShareId: lineage.sourceShareId,
      createdById: lineage.createdById,
      workspaceId: lineage.workspaceId,
      createdAt: lineage.createdAt.toISOString(),
    },
  });
}

function assertRemixableShare(share: RemixShare | null, now: Date): asserts share is RemixShare {
  if (
    share === null
    || share.scope !== "remix"
    || share.status !== "active"
    || (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime())
    || share.release.status !== "ready"
  ) {
    throw notFoundProblem("Share");
  }
}

function validateSourceRelease(share: RemixShare, targetWorkspaceId: string) {
  const release = share.release;
  const board = projectReleaseBoardSnapshotSchema.parse(release.boardSnapshot);
  const manifest = projectReleaseManifestSchema.parse(release.manifest);
  if (sha256Canonical(board) !== release.boardChecksum) {
    throw new Error("Source ProjectRelease board checksum is invalid");
  }
  if (sha256Canonical(manifest) !== release.manifestSha256) {
    throw new Error("Source ProjectRelease manifest checksum is invalid");
  }
  if (
    board.projectId !== release.projectId
    || manifest.projectId !== release.projectId
    || manifest.board.id !== board.id
    || manifest.board.revision !== board.revision
    || manifest.board.checksum !== release.boardChecksum
    || manifest.artifacts.length !== release.artifactPins.length
  ) {
    throw new Error("Source ProjectRelease snapshot does not match its manifest");
  }

  for (const [index, pin] of release.artifactPins.entries()) {
    const manifestPin = manifest.artifacts[index];
    const version = pin.artifactVersion;
    if (
      pin.position !== index
      || manifestPin?.position !== index
      || manifestPin.artifactId !== pin.artifactId
      || manifestPin.artifactVersionId !== pin.artifactVersionId
      || manifestPin.title !== pin.title
      || manifestPin.kind !== pin.kind
      || manifestPin.version !== version.version
      || manifestPin.schemaVersion !== version.schemaVersion
      || manifestPin.checksum !== version.checksum
      || version.id !== pin.artifactVersionId
      || version.artifactId !== pin.artifactId
      || version.artifact.id !== pin.artifactId
      || version.projectId !== release.projectId
      || version.artifact.projectId !== release.projectId
      || version.status !== "ready"
      || (version.content === null) === (version.contentBlobId === null)
    ) {
      throw new Error(`Source ProjectRelease artifact pin ${index} is invalid`);
    }
    if (
      version.contentBlobId !== null
      && (
        version.contentBlob?.id !== version.contentBlobId
        || version.contentBlob.status !== "ready"
        || version.contentBlob.deletedAt !== null
        || version.contentBlob.byteSize <= 0n
      )
    ) {
      throw new Error(`Source ProjectRelease Blob pin ${index} is unavailable`);
    }
    if (
      version.knowledgeReleaseId !== null
      && (
        version.knowledgeRelease?.id !== version.knowledgeReleaseId
        || !["ready", "retired"].includes(version.knowledgeRelease.status)
      )
    ) {
      throw new Error(`Source ProjectRelease knowledge pin ${index} is invalid`);
    }
    if (
      version.knowledgeRelease?.workspaceId != null
      && version.knowledgeRelease.workspaceId !== targetWorkspaceId
    ) {
      throw remixKnowledgeScopeProblem();
    }
    for (const asset of version.assets) {
      if (
        asset.artifactVersionId !== version.id
        || asset.artifactId !== version.artifactId
        || asset.projectId !== version.projectId
        || !["image", "font"].includes(asset.kind)
        || asset.blob.id !== asset.blobId
        || asset.blob.status !== "ready"
        || asset.blob.deletedAt !== null
        || asset.byteSize <= 0n
        || !/^[0-9a-f]{64}$/.test(asset.sha256)
      ) {
        throw new Error(`Source ProjectRelease asset pin ${index}:${asset.assetId} is invalid`);
      }
    }
    const versionAssetPins = version.assets.map((asset) => {
      const byteSize = Number(asset.byteSize);
      if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
        throw new Error(`Source ProjectRelease asset pin ${index}:${asset.assetId} has an invalid byte size`);
      }
      return {
        assetId: asset.assetId,
        kind: asset.kind,
        blobId: asset.blobId,
        mediaType: asset.mediaType,
        byteSize,
        sha256: asset.sha256,
        metadata: asset.metadata,
      };
    });
    if (canonicalJson(manifestPin.assets) !== canonicalJson(versionAssetPins as never)) {
      throw new Error(`Source ProjectRelease asset manifest ${index} does not match its immutable pins`);
    }
  }

  const pinsByArtifact = new Map(
    release.artifactPins.map((pin) => [pin.artifactId, pin.artifactVersionId]),
  );
  for (const node of board.nodes) {
    if (
      node.artifactId !== null
      && pinsByArtifact.get(node.artifactId) !== node.artifactVersionId
    ) {
      throw new Error(`Source ProjectRelease board node ${node.id} is not pinned by its manifest`);
    }
  }
  return {
    board,
    pins: release.artifactPins,
  };
}

function remixKnowledgeScopeProblem() {
  return new ProblemException({
    title: "Knowledge scope conflict",
    status: HttpStatus.CONFLICT,
    detail: "This release uses a Workspace-private Knowledge release and can only be remixed into that Workspace",
    code: "REMIX_KNOWLEDGE_SCOPE_CONFLICT",
  });
}

function requireMappedId(ids: Map<string, string>, sourceId: string, kind: string) {
  const targetId = ids.get(sourceId);
  if (!targetId) throw new Error(`Source ProjectRelease references an unknown ${kind}`);
  return targetId;
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Source ProjectRelease ${label} is missing`);
  return value;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sha256Canonical(value: JsonValue) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashShareToken(rawToken: string) {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}
