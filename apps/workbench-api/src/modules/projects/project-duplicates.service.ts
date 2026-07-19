import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  projectDuplicateSchema,
  type DuplicateProjectRequest,
  type ProjectDuplicate,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  projectStateConflictProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";
import { mapProject } from "./project.mapper.js";

const duplicateInclude = {
  targetProject: true,
} as const;
const insertChunkSize = 500;

type DuplicateReceipt = Prisma.ProjectDuplicateGetPayload<{ include: typeof duplicateInclude }>;

@Injectable()
export class ProjectDuplicatesService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async create(
    principalId: string,
    sourceProjectId: string,
    idempotencyKey: string,
    request: DuplicateProjectRequest,
  ): Promise<ProjectDuplicate> {
    validateIdempotencyKey(idempotencyKey);
    await this.access.findProject(principalId, sourceProjectId, "read");
    const requestHash = hashRequest(request);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await this.findReplay(sourceProjectId, principalId, idempotencyKey);
      if (replay) return resolveReplay(replay, requestHash);
      try {
        return await this.createOnce(
          principalId,
          sourceProjectId,
          idempotencyKey,
          requestHash,
          request,
        );
      } catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError
          && ["P2002", "P2034"].includes(error.code);
        if (!retryable) throw error;
        const raced = await this.findReplay(sourceProjectId, principalId, idempotencyKey);
        if (raced) return resolveReplay(raced, requestHash);
        if (error.code !== "P2034") throw error;
        if (attempt === 2) {
          throw projectStateConflictProblem(
            "Project duplicate conflicted with another write; retry the idempotent command",
          );
        }
      }
    }
    throw new Error("PROJECT_DUPLICATE_SERIALIZATION_RETRY_EXHAUSTED");
  }

  private createOnce(
    principalId: string,
    sourceProjectId: string,
    idempotencyKey: string,
    requestHash: string,
    request: DuplicateProjectRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const sourceLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "projects"
        WHERE "id" = ${sourceProjectId} AND "status" = 'active'
        FOR SHARE
      `);
      if (sourceLocks.length !== 1) throw notFoundProblem("Project");

      const source = await tx.project.findFirst({
        where: {
          id: sourceProjectId,
          status: "active",
          members: { some: { principalId } },
        },
      });
      if (!source) throw notFoundProblem("Project");

      const existing = await tx.projectDuplicate.findUnique({
        where: {
          sourceProjectId_createdById_idempotencyKey: {
            sourceProjectId,
            createdById: principalId,
            idempotencyKey,
          },
        },
        include: duplicateInclude,
      });
      if (existing) return resolveReplay(existing, requestHash);

      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "boards" WHERE "project_id" = ${sourceProjectId} FOR SHARE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "artifacts" WHERE "project_id" = ${sourceProjectId} ORDER BY "id" FOR SHARE
      `);
      const [sourceBoard, sourceArtifacts] = await Promise.all([
        tx.board.findUnique({
          where: { projectId: sourceProjectId },
          include: {
            nodes: { orderBy: { nodeKey: "asc" } },
            edges: { orderBy: { edgeKey: "asc" } },
          },
        }),
        tx.artifact.findMany({
          where: {
            projectId: sourceProjectId,
            currentVersionId: { not: null },
            currentVersion: { is: { status: "ready" } },
          },
          orderBy: { id: "asc" },
        }),
      ]);
      if (!sourceBoard) throw notFoundProblem("Project board");

      const selectedVersionIds = new Set<string>();
      for (const artifact of sourceArtifacts) {
        if (artifact.currentVersionId) selectedVersionIds.add(artifact.currentVersionId);
      }
      for (const node of sourceBoard.nodes) {
        if (node.artifactVersionId) selectedVersionIds.add(node.artifactVersionId);
      }
      const sourceVersions = selectedVersionIds.size === 0
        ? []
        : await tx.artifactVersion.findMany({
            where: {
              id: { in: [...selectedVersionIds] },
              projectId: sourceProjectId,
              status: "ready",
            },
            include: { assets: { orderBy: { assetId: "asc" } } },
            orderBy: [{ artifactId: "asc" }, { version: "asc" }],
          });
      if (sourceVersions.length !== selectedVersionIds.size) {
        throw projectStateConflictProblem(
          "Project snapshot contains a missing or non-ready Artifact version",
        );
      }

      const targetProject = await tx.project.create({
        data: {
          workspaceId: source.workspaceId,
          createdById: principalId,
          title: request.title ?? defaultDuplicateTitle(source.title),
          summary: source.summary,
        },
      });
      await tx.projectMember.create({
        data: {
          projectId: targetProject.id,
          workspaceId: source.workspaceId,
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
          viewport: sourceBoard.viewport as Prisma.InputJsonValue,
        },
      });

      const artifactIds = new Map<string, string>();
      for (const artifact of sourceArtifacts) {
        artifactIds.set(artifact.id, `artifact_${randomUUID()}`);
      }
      const targetArtifacts = sourceArtifacts.map((artifact) => ({
        id: requireMappedId(artifactIds, artifact.id, "Artifact"),
        projectId: targetProject.id,
        kind: artifact.kind,
        title: artifact.title,
      }));
      for (const data of chunks(targetArtifacts, insertChunkSize)) {
        await tx.artifact.createMany({ data });
      }

      const versionIds = new Map<string, string>();
      const nextVersionByArtifact = new Map<string, number>();
      const targetVersions = sourceVersions.map((version) => {
        const id = `version_${randomUUID()}`;
        versionIds.set(version.id, id);
        const targetArtifactId = requireMappedId(artifactIds, version.artifactId, "Artifact");
        const targetVersionNumber = (nextVersionByArtifact.get(version.artifactId) ?? 0) + 1;
        nextVersionByArtifact.set(version.artifactId, targetVersionNumber);
        return {
          id,
          artifactId: targetArtifactId,
          projectId: targetProject.id,
          version: targetVersionNumber,
          schemaVersion: version.schemaVersion,
          status: "staging" as const,
          ...(version.content === null
            ? { contentBlobId: requireValue(version.contentBlobId, "Artifact content Blob") }
            : { content: version.content as Prisma.InputJsonValue }),
          checksum: version.checksum,
          citations: version.citations as Prisma.InputJsonValue,
          knowledgeReleaseId: version.knowledgeReleaseId,
        };
      });
      for (const data of chunks(targetVersions, insertChunkSize)) {
        await tx.artifactVersion.createMany({ data });
      }

      const targetAssets = sourceVersions.flatMap((version) => {
        const targetVersionId = requireMappedId(versionIds, version.id, "Artifact version");
        const targetArtifactId = requireMappedId(artifactIds, version.artifactId, "Artifact");
        return version.assets.map((asset) => ({
          artifactVersionId: targetVersionId,
          artifactId: targetArtifactId,
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

      const currentVersionMappings = sourceArtifacts.flatMap((artifact) => (
        artifact.currentVersionId
          ? [[
              requireMappedId(artifactIds, artifact.id, "Artifact"),
              requireMappedId(versionIds, artifact.currentVersionId, "current Artifact version"),
            ] as const]
          : []
      ));
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

      const targetNodes = sourceBoard.nodes.map((node) => ({
        boardId: targetBoard.id,
        projectId: targetProject.id,
        nodeKey: node.nodeKey,
        parentNodeKey: node.parentNodeKey,
        sortOrder: node.sortOrder,
        kind: node.kind,
        position: node.position as Prisma.InputJsonValue,
        ...(node.size === null ? {} : { size: node.size as Prisma.InputJsonValue }),
        artifactId: node.artifactId === null
          ? null
          : requireMappedId(artifactIds, node.artifactId, "Board Artifact"),
        artifactVersionId: node.artifactVersionId === null
          ? null
          : requireMappedId(versionIds, node.artifactVersionId, "Board Artifact version"),
        data: node.data as Prisma.InputJsonValue,
      }));
      for (const data of chunks(targetNodes, insertChunkSize)) {
        await tx.boardNode.createMany({ data });
      }

      const targetEdges = sourceBoard.edges.map((edge) => ({
        boardId: targetBoard.id,
        edgeKey: edge.edgeKey,
        sourceNodeKey: edge.sourceNodeKey,
        targetNodeKey: edge.targetNodeKey,
        kind: edge.kind,
        data: edge.data as Prisma.InputJsonValue,
      }));
      for (const data of chunks(targetEdges, insertChunkSize)) {
        await tx.boardEdge.createMany({ data });
      }

      const receipt = await tx.projectDuplicate.create({
        data: {
          targetProjectId: targetProject.id,
          sourceProjectId,
          workspaceId: source.workspaceId,
          createdById: principalId,
          idempotencyKey,
          requestHash,
        },
        include: duplicateInclude,
      });
      return mapDuplicate(receipt);
    }, {
      // Membership administration takes the Project UPDATE lock. READ COMMITTED
      // makes the membership read after this SHARE lock observe a waited-on revoke.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 30_000,
    });
  }

  private findReplay(sourceProjectId: string, principalId: string, idempotencyKey: string) {
    return this.db.projectDuplicate.findUnique({
      where: {
        sourceProjectId_createdById_idempotencyKey: {
          sourceProjectId,
          createdById: principalId,
          idempotencyKey,
        },
      },
      include: duplicateInclude,
    });
  }
}

function resolveReplay(receipt: DuplicateReceipt, requestHash: string) {
  if (receipt.requestHash !== requestHash) throw idempotencyConflictProblem();
  return mapDuplicate(receipt);
}

function mapDuplicate(receipt: DuplicateReceipt): ProjectDuplicate {
  return projectDuplicateSchema.parse({
    sourceProjectId: receipt.sourceProjectId,
    project: mapProject(receipt.targetProject),
    createdAt: receipt.createdAt.toISOString(),
  });
}

function defaultDuplicateTitle(sourceTitle: string) {
  const suffix = " copy";
  return `${sourceTitle.slice(0, 160 - suffix.length)}${suffix}`;
}

function requireMappedId(values: Map<string, string>, sourceId: string, label: string) {
  const value = values.get(sourceId);
  if (!value) throw projectStateConflictProblem(`${label} ${sourceId} is not part of the snapshot`);
  return value;
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) throw projectStateConflictProblem(`${label} is missing`);
  return value;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
