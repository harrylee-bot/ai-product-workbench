import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  canonicalJson,
  designSystemImportSchema,
  materializeRuntimeDesignStyleSnapshot,
  type DesignSystemImport,
  type ImportDesignSystemRequest,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  designSystemImportConflictProblem,
  idempotencyConflictProblem,
  notFoundProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";
import { assertProjectCapability } from "../projects/project-lock.js";

const sourceVersionInclude = {
  artifact: { include: { project: true } },
  assets: { orderBy: { assetId: "asc" as const } },
} as const;

type SourceVersion = Prisma.ArtifactVersionGetPayload<{ include: typeof sourceVersionInclude }>;

@Injectable()
export class DesignSystemImportsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async create(
    principalId: string,
    targetProjectId: string,
    idempotencyKey: string,
    request: ImportDesignSystemRequest,
  ): Promise<DesignSystemImport> {
    validateIdempotencyKey(idempotencyKey);
    const target = await this.access.findProject(principalId, targetProjectId, "edit");
    const requestHash = hashRequest(request);
    const replay = await this.findReplay(targetProjectId, idempotencyKey);
    if (replay) return resolveReplay(replay, principalId, requestHash);

    const source = await this.findAuthorizedSource(principalId, request.sourceArtifactVersionId);
    if (!source) throw notFoundProblem("Design System version");
    assertImportProjects(source.projectId, targetProjectId, source.artifact.project.workspaceId, target.workspaceId);
    validateSourceVersion(source);

    try {
      return await this.createOnce(
        principalId,
        targetProjectId,
        idempotencyKey,
        requestHash,
        source,
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findReplay(targetProjectId, idempotencyKey);
        if (raced) return resolveReplay(raced, principalId, requestHash);
      }
      throw error;
    }
  }

  private async createOnce(
    principalId: string,
    targetProjectId: string,
    idempotencyKey: string,
    requestHash: string,
    preflight: SourceVersion,
  ) {
    return this.db.$transaction(async (tx) => {
      const projectIds = [targetProjectId, preflight.projectId].sort();
      const lockedProjects = await tx.$queryRaw<Array<{ id: string; workspaceId: string }>>(Prisma.sql`
        SELECT "id", "workspace_id" AS "workspaceId"
        FROM "projects"
        WHERE "id" IN (${Prisma.join(projectIds)}) AND "status" = 'active'
        ORDER BY "id"
        FOR SHARE
      `);
      if (lockedProjects.length !== 2) throw notFoundProblem("Project");
      await assertProjectCapability(tx, targetProjectId, principalId, "edit");
      await assertProjectCapability(tx, preflight.projectId, principalId, "read");

      const replay = await tx.designSystemImport.findUnique({
        where: { targetProjectId_idempotencyKey: { targetProjectId, idempotencyKey } },
      });
      if (replay) return resolveReplay(replay, principalId, requestHash);

      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "artifact_versions"
        WHERE "id" = ${preflight.id}
        FOR SHARE
      `);
      const source = await tx.artifactVersion.findFirst({
        where: { id: preflight.id, projectId: preflight.projectId },
        include: sourceVersionInclude,
      });
      if (!source) throw notFoundProblem("Design System version");
      const targetWorkspaceId = lockedProjects.find((project) => project.id === targetProjectId)?.workspaceId;
      const sourceWorkspaceId = lockedProjects.find((project) => project.id === source.projectId)?.workspaceId;
      if (!targetWorkspaceId || !sourceWorkspaceId) throw notFoundProblem("Project");
      assertImportProjects(source.projectId, targetProjectId, sourceWorkspaceId, targetWorkspaceId);
      validateSourceVersion(source);

      const targetArtifact = await tx.artifact.create({
        data: {
          projectId: targetProjectId,
          kind: "design_system",
          title: source.artifact.title,
        },
      });
      const targetVersion = await tx.artifactVersion.create({
        data: {
          artifactId: targetArtifact.id,
          projectId: targetProjectId,
          version: 1,
          schemaVersion: 1,
          status: "staging",
          content: source.content as Prisma.InputJsonValue,
          checksum: source.checksum,
          citations: source.citations as Prisma.InputJsonValue,
          knowledgeReleaseId: source.knowledgeReleaseId,
        },
      });
      if (source.assets.length > 0) {
        await tx.artifactVersionAsset.createMany({
          data: source.assets.map((asset) => ({
            artifactVersionId: targetVersion.id,
            artifactId: targetArtifact.id,
            projectId: targetProjectId,
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
      await tx.artifactVersion.update({
        where: { id: targetVersion.id },
        data: { status: "ready" },
      });
      await tx.artifact.update({
        where: { id: targetArtifact.id },
        data: { currentVersionId: targetVersion.id },
      });
      const receipt = await tx.designSystemImport.create({
        data: {
          targetProjectId,
          targetArtifactId: targetArtifact.id,
          targetArtifactVersionId: targetVersion.id,
          sourceProjectId: source.projectId,
          sourceArtifactId: source.artifactId,
          sourceArtifactVersionId: source.id,
          sourceChecksum: source.checksum,
          createdById: principalId,
          idempotencyKey,
          requestHash,
        },
      });
      return mapDesignSystemImport(receipt);
    });
  }

  private findReplay(targetProjectId: string, idempotencyKey: string) {
    return this.db.designSystemImport.findUnique({
      where: { targetProjectId_idempotencyKey: { targetProjectId, idempotencyKey } },
    });
  }

  private findAuthorizedSource(principalId: string, artifactVersionId: string) {
    return this.db.artifactVersion.findFirst({
      where: {
        id: artifactVersionId,
        artifact: {
          is: {
            project: {
              is: {
                status: "active",
                members: { some: { principalId } },
              },
            },
          },
        },
      },
      include: sourceVersionInclude,
    });
  }
}

function validateSourceVersion(source: SourceVersion) {
  if (
    source.artifact.kind !== "design_system"
    || source.schemaVersion !== 1
    || source.status !== "ready"
    || source.content === null
    || source.contentBlobId !== null
  ) {
    throw designSystemImportConflictProblem(
      "DESIGN_SYSTEM_SOURCE_INVALID",
      "The source must be a ready inline workbench.design-system.v1 ArtifactVersion",
    );
  }
  let parsed;
  try {
    parsed = materializeRuntimeDesignStyleSnapshot({
      projectId: source.projectId,
      artifactId: source.artifactId,
      artifactVersionId: source.id,
      checksum: source.checksum,
      document: source.content,
      assetPins: source.assets,
    });
  } catch {
    throw designSystemImportConflictProblem(
      "DESIGN_SYSTEM_SOURCE_INVALID",
      "The source Design System content or asset pins are invalid",
    );
  }
  const checksum = createHash("sha256").update(canonicalJson(source.content)).digest("hex");
  if (checksum !== source.checksum || parsed.source.checksum !== checksum) {
    throw designSystemImportConflictProblem(
      "DESIGN_SYSTEM_SOURCE_CHECKSUM_MISMATCH",
      "The source Design System checksum does not match its immutable content",
    );
  }
}

function assertImportProjects(
  sourceProjectId: string,
  targetProjectId: string,
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
) {
  if (sourceProjectId === targetProjectId) {
    throw designSystemImportConflictProblem(
      "DESIGN_SYSTEM_IMPORT_SAME_PROJECT",
      "A Design System import must copy from another Project",
    );
  }
  if (sourceWorkspaceId !== targetWorkspaceId) {
    throw designSystemImportConflictProblem(
      "DESIGN_SYSTEM_IMPORT_CROSS_WORKSPACE",
      "Direct Design System imports are limited to one Workspace",
    );
  }
}

function resolveReplay(
  receipt: Parameters<typeof mapDesignSystemImport>[0],
  principalId: string,
  requestHash: string,
) {
  if (receipt.createdById !== principalId || receipt.requestHash !== requestHash) {
    throw idempotencyConflictProblem();
  }
  return mapDesignSystemImport(receipt);
}

function mapDesignSystemImport(receipt: {
  id: string;
  targetProjectId: string;
  targetArtifactId: string;
  targetArtifactVersionId: string;
  sourceProjectId: string;
  sourceArtifactId: string;
  sourceArtifactVersionId: string;
  sourceChecksum: string;
  createdById: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: Date;
}) {
  return designSystemImportSchema.parse({
    ...receipt,
    createdAt: receipt.createdAt.toISOString(),
  });
}
