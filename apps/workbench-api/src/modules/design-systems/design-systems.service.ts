import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  canonicalJson,
  designSystemCreationSchema,
  type CreateDesignSystemRequest,
  type DesignSystemCreation,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  designSystemCreationConflictProblem,
  idempotencyConflictProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";

@Injectable()
export class DesignSystemsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async create(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    request: CreateDesignSystemRequest,
  ): Promise<DesignSystemCreation> {
    validateIdempotencyKey(idempotencyKey);
    await this.access.findProject(principalId, projectId, "edit");
    const requestHash = hashRequest(request);
    const replay = await this.findReplay(projectId, idempotencyKey);
    if (replay) return resolveReplay(replay, principalId, requestHash);

    try {
      return await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "edit");
        const duplicate = await tx.designSystemCreation.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        });
        if (duplicate) return resolveReplay(duplicate, principalId, requestHash);

        const pins = await resolveAuthorizedAssetPins(tx, projectId, request);
        const checksum = createHash("sha256").update(canonicalJson(request.document)).digest("hex");
        const artifact = await tx.artifact.create({
          data: { projectId, kind: "design_system", title: request.title },
        });
        const version = await tx.artifactVersion.create({
          data: {
            artifactId: artifact.id,
            projectId,
            version: 1,
            schemaVersion: 1,
            status: "staging",
            content: request.document as Prisma.InputJsonValue,
            checksum,
            citations: [],
          },
        });
        if (pins.length > 0) {
          await tx.artifactVersionAsset.createMany({
            data: pins.map((pin) => ({
              artifactVersionId: version.id,
              artifactId: artifact.id,
              projectId,
              ...pin,
            })),
          });
        }
        await tx.artifactVersion.update({
          where: { id: version.id },
          data: { status: "ready" },
        });
        await tx.artifact.update({
          where: { id: artifact.id },
          data: { currentVersionId: version.id },
        });
        const receipt = await tx.designSystemCreation.create({
          data: {
            projectId,
            artifactId: artifact.id,
            artifactVersionId: version.id,
            checksum,
            createdById: principalId,
            idempotencyKey,
            requestHash,
          },
        });
        return mapCreation(receipt);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findReplay(projectId, idempotencyKey);
        if (raced) return resolveReplay(raced, principalId, requestHash);
      }
      throw error;
    }
  }

  private findReplay(projectId: string, idempotencyKey: string) {
    return this.db.designSystemCreation.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
  }
}

async function resolveAuthorizedAssetPins(
  tx: Prisma.TransactionClient,
  projectId: string,
  request: CreateDesignSystemRequest,
) {
  if (request.document.assets.length === 0) return [];
  const blobIds = [...new Set(request.document.assets.map((asset) => asset.blobId))];
  const files = await tx.fileAsset.findMany({
    where: {
      projectId,
      blobId: { in: blobIds },
      status: "ready",
      deletedAt: null,
      blob: { is: { status: "ready", deletedAt: null } },
    },
    include: { blob: true },
  });
  const byBlob = new Map(files.map((file) => [file.blobId, file]));
  return request.document.assets.map((asset) => {
    const file = byBlob.get(asset.blobId);
    if (
      !file?.blob
      || file.blob.mediaType !== asset.mediaType
      || file.blob.byteSize !== BigInt(asset.byteSize)
      || file.blob.sha256 !== asset.sha256
    ) {
      throw designSystemCreationConflictProblem(
        "DESIGN_SYSTEM_ASSET_NOT_AUTHORIZED",
        "Every Design System asset must match a ready File in the target Project",
      );
    }
    return {
      assetId: asset.id,
      kind: asset.kind,
      blobId: asset.blobId,
      mediaType: asset.mediaType,
      byteSize: BigInt(asset.byteSize),
      sha256: asset.sha256,
      metadata: asset as Prisma.InputJsonValue,
    };
  });
}

function resolveReplay(
  receipt: Parameters<typeof mapCreation>[0],
  principalId: string,
  requestHash: string,
) {
  if (receipt.createdById !== principalId || receipt.requestHash !== requestHash) {
    throw idempotencyConflictProblem();
  }
  return mapCreation(receipt);
}

function mapCreation(receipt: {
  id: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  checksum: string;
  createdById: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: Date;
}) {
  return designSystemCreationSchema.parse({ ...receipt, createdAt: receipt.createdAt.toISOString() });
}
