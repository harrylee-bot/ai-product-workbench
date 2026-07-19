import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  publicShareSchema,
  revokeProjectShareGrantsResponseSchema,
  rotateShareGrantResponseSchema,
  shareTokenSchema,
  type PublicArtifactVersionDetail,
  type PublicShare,
  type RevokeProjectShareGrantsResponse,
  type RotateShareGrantRequest,
  type RotateShareGrantResponse,
  type ShareGrant,
  type ShareGrantList,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  shareStateConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import {
  READY_BLOB_STORAGE_PORT,
  type ReadyBlobStoragePort,
} from "../../platform/object-storage/object-storage.port.js";
import { readReadyObject } from "../../platform/object-storage/read-ready-object.js";
import { AccessService, projectMembershipFilter } from "../access/access.service.js";
import { assertProjectCapability, lockActiveProject } from "../projects/project-lock.js";
import {
  mapProjectRelease,
  orderedReleaseArtifactPins,
  projectPublicProjectRelease,
  type ReleaseRecord,
} from "../releases/release.mapper.js";
import {
  mapPublicArtifactVersion,
  mapShareGrant,
  publicArtifactVersionEtag,
  type ShareGrantRecord,
} from "./share.mapper.js";

type ShareCursor = { createdAt: string; id: string };

@Injectable()
export class SharesService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
    @Inject(READY_BLOB_STORAGE_PORT) private readonly storage: ReadyBlobStoragePort,
  ) {}

  async list(
    principalId: string,
    projectId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ShareGrantList> {
    await this.access.findProject(principalId, projectId, "owner");
    await this.expireProjectShares(projectId);
    const limit = clampLimit(requestedLimit);
    const decoded = cursor ? decodeShareCursor(cursor) : undefined;
    const [rows, activeCount] = await Promise.all([
      this.db.shareGrant.findMany({
        where: {
          projectId,
          ...(decoded ? {
            OR: [
              { createdAt: { lt: new Date(decoded.createdAt) } },
              { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
            ],
          } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
      this.db.shareGrant.count({
        where: { projectId, status: "active" },
      }),
    ]);
    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => mapShareGrant(row)),
      activeCount,
      nextCursor: hasNext && last
        ? encodeShareCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    };
  }

  async rotate(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    request: RotateShareGrantRequest,
  ): Promise<RotateShareGrantResponse> {
    validateIdempotencyKey(idempotencyKey);
    const expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now() + 1_000) {
      throw validationProblem("expiresAt must be at least one second in the future");
    }
    const requestHash = hashRequest(request);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = createShareToken();
      try {
        return await this.db.$transaction(async (tx) => {
          const projects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"
            FROM "projects"
            WHERE "id" = ${projectId} AND "status" = 'active'
            FOR UPDATE
          `);
          if (!projects[0]) throw notFoundProblem("Project");
          await assertProjectCapability(tx, projectId, principalId, "owner");

          const priorAttempt = await tx.shareGrant.findFirst({
            where: { projectId, idempotencyKey },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { createdById: true, requestHash: true },
          });
          if (priorAttempt && (
            priorAttempt.createdById !== principalId
            || priorAttempt.requestHash !== requestHash
          )) {
            throw idempotencyConflictProblem();
          }

          const release = await tx.projectRelease.findFirst({
            where: { id: request.releaseId, projectId, status: "ready" },
            include: { artifactPins: orderedReleaseArtifactPins },
          });
          if (!release) throw notFoundProblem("Ready Project release");
          mapProjectRelease(release as ReleaseRecord);

          const now = new Date();
          await tx.shareGrant.updateMany({
            where: { projectId, status: "active", expiresAt: { lte: now } },
            data: { status: "expired", revision: { increment: 1 } },
          });
          const revoked = await tx.shareGrant.updateMany({
            where: { projectId, status: "active" },
            data: {
              status: "revoked",
              revokedAt: now,
              revision: { increment: 1 },
            },
          });
          const share = await tx.shareGrant.create({
            data: {
              projectId,
              releaseId: release.id,
              createdById: principalId,
              idempotencyKey,
              requestHash,
              tokenHash: hashShareToken(token),
              scope: request.scope,
              expiresAt,
            },
          });
          const activeGrantCount = await tx.shareGrant.count({
            where: { projectId, status: "active" },
          });
          if (activeGrantCount !== 1) throw new Error("PROJECT_SHARE_ROTATION_INCOMPLETE");
          return rotateShareGrantResponseSchema.parse({
            share: mapShareGrant(share),
            token,
            revokedGrantCount: revoked.count,
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      } catch (error) {
        if (!isShareTokenHashCollision(error)) throw error;
      }
    }
    throw new Error("SHARE_TOKEN_COLLISION_RETRY_EXHAUSTED");
  }

  async revokeProjectShares(
    principalId: string,
    projectId: string,
  ): Promise<RevokeProjectShareGrantsResponse> {
    return this.db.$transaction(async (tx) => {
      const projects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "projects"
        WHERE "id" = ${projectId} AND "status" = 'active'
        FOR UPDATE
      `);
      if (!projects[0]) throw notFoundProblem("Project");
      await assertProjectCapability(tx, projectId, principalId, "owner");

      const now = new Date();
      await tx.shareGrant.updateMany({
        where: {
          status: "active",
          expiresAt: { lte: now },
          projectId,
        },
        data: { status: "expired", revision: { increment: 1 } },
      });
      await tx.shareGrant.updateMany({
        where: {
          status: "active",
          projectId,
        },
        data: {
          status: "revoked",
          revokedAt: now,
          revision: { increment: 1 },
        },
      });
      const activeGrantCount = await tx.shareGrant.count({
        where: { projectId, status: "active" },
      });
      if (activeGrantCount !== 0) throw new Error("PROJECT_SHARE_REVOCATION_INCOMPLETE");
      return revokeProjectShareGrantsResponseSchema.parse({ projectId, activeGrantCount });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async get(principalId: string, shareId: string): Promise<ShareGrant> {
    let share = await this.findAuthorized(principalId, shareId);
    share = await this.expireIfNeeded(share);
    return mapShareGrant(share);
  }

  async revoke(
    principalId: string,
    shareId: string,
    expectedRevision: number,
  ): Promise<ShareGrant> {
    let share = await this.findAuthorized(principalId, shareId);
    if (share.revision !== expectedRevision) throw revisionConflictProblem();
    share = await this.expireIfNeeded(share);
    if (share.status === "revoked") return mapShareGrant(share);
    if (share.status !== "active") {
      throw shareStateConflictProblem(`The Share cannot be revoked while it is ${share.status}`);
    }
    const release = await this.db.projectRelease.findUnique({
      where: { id: share.releaseId },
      select: { projectId: true },
    });
    if (!release) throw notFoundProblem("Project release");
    const updated = await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, release.projectId, principalId, "owner");
      const current = await tx.shareGrant.findUnique({ where: { id: share.id } });
      if (!current) throw notFoundProblem("Share grant");
      if (current.revision !== expectedRevision) throw revisionConflictProblem();
      if (current.status === "revoked") return current;
      if (current.status !== "active") {
        throw shareStateConflictProblem(`The Share cannot be revoked while it is ${current.status}`);
      }
      if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) {
        return tx.shareGrant.update({
          where: { id: current.id },
          data: { status: "expired", revision: { increment: 1 } },
        });
      }
      const result = await tx.shareGrant.updateMany({
        where: { id: current.id, status: "active", revision: expectedRevision },
        data: { status: "revoked", revokedAt: new Date(), revision: { increment: 1 } },
      });
      if (result.count !== 1) throw revisionConflictProblem();
      return tx.shareGrant.findUniqueOrThrow({ where: { id: current.id } });
    });
    if (updated.status === "expired") {
      throw shareStateConflictProblem("The Share cannot be revoked while it is expired");
    }
    return mapShareGrant(updated);
  }

  async getPublic(token: string): Promise<{ share: PublicShare; etag: string }> {
    const { row, release } = await this.findActivePublicShare(token);
    const publicRelease = projectPublicProjectRelease(release);
    return {
      share: publicShareSchema.parse({
        shareId: row.id,
        scope: row.scope,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        release: publicRelease,
      }),
      etag: `"${publicRelease.manifestSha256}"`,
    };
  }

  async getPublicArtifactVersion(
    token: string,
    artifactId: string,
    artifactVersionId: string,
  ): Promise<{ detail: PublicArtifactVersionDetail; etag: string }> {
    const { release } = await this.findActivePublicShare(token);
    const pin = release.artifactPins.find((candidate) => (
      candidate.artifactId === artifactId
      && candidate.artifactVersionId === artifactVersionId
    ));
    if (!pin) throw notFoundProblem("Shared artifact version");

    const version = await this.db.artifactVersion.findFirst({
      where: {
        id: artifactVersionId,
        artifactId,
        projectId: release.projectId,
        status: "ready",
        releasePins: { some: { releaseId: release.id } },
        OR: [
          { contentBlobId: null },
          { contentBlob: { is: { status: "ready", deletedAt: null } } },
        ],
      },
      select: {
        id: true,
        artifactId: true,
        projectId: true,
        version: true,
        schemaVersion: true,
        status: true,
        content: true,
        checksum: true,
        citations: true,
        createdAt: true,
        contentBlob: {
          select: {
            mediaType: true,
            byteSize: true,
            sha256: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!version) throw notFoundProblem("Shared artifact version");
    const detail = mapPublicArtifactVersion(version, pin);
    return { detail, etag: publicArtifactVersionEtag(detail) };
  }

  async getPublicArtifactAssetContent(
    token: string,
    artifactId: string,
    artifactVersionId: string,
    assetId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
  ) {
    const { release } = await this.findActivePublicShare(token);
    const pin = release.artifactPins.find((candidate) => (
      candidate.artifactId === artifactId
      && candidate.artifactVersionId === artifactVersionId
      && (candidate.kind === "prototype" || candidate.kind === "design_system")
    ));
    const assetPin = pin?.assets.find((candidate) => candidate.assetId === assetId);
    if (!pin || !assetPin) throw notFoundProblem("Shared artifact asset");

    const asset = await this.db.artifactVersionAsset.findFirst({
      where: {
        artifactVersionId,
        artifactId,
        projectId: release.projectId,
        assetId,
        blobId: assetPin.blobId,
        artifactVersion: {
          is: {
            status: "ready",
            releasePins: { some: { releaseId: release.id } },
          },
        },
        blob: { is: { status: "ready", deletedAt: null } },
      },
      select: {
        kind: true,
        mediaType: true,
        byteSize: true,
        sha256: true,
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
    if (!asset) throw notFoundProblem("Shared artifact asset");
    if (
      asset.kind !== assetPin.kind
      || asset.mediaType !== assetPin.mediaType
      || asset.byteSize !== BigInt(assetPin.byteSize)
      || asset.sha256 !== assetPin.sha256
      || asset.blob.status !== "ready"
      || asset.blob.deletedAt !== null
      || asset.blob.mediaType !== assetPin.mediaType
      || asset.blob.byteSize !== BigInt(assetPin.byteSize)
      || asset.blob.sha256 !== assetPin.sha256
    ) {
      throw new Error("PUBLIC_SHARE_ARTIFACT_ASSET_PIN_MISMATCH");
    }
    return readReadyObject(this.storage, {
      storageKey: asset.blob.storageKey,
      sha256: assetPin.sha256,
      byteSize: assetPin.byteSize,
      mediaType: assetPin.mediaType,
    }, rangeHeader, ifNoneMatch);
  }

  async getPublicArtifactContent(
    token: string,
    artifactId: string,
    artifactVersionId: string,
    rangeHeader?: string,
    ifNoneMatch?: string,
  ) {
    const { release } = await this.findActivePublicShare(token);
    const pin = release.artifactPins.find((candidate) => (
      candidate.artifactId === artifactId
      && candidate.artifactVersionId === artifactVersionId
    ));
    if (!pin) throw notFoundProblem("Shared artifact version content");

    const version = await this.db.artifactVersion.findFirst({
      where: {
        id: artifactVersionId,
        artifactId,
        projectId: release.projectId,
        status: "ready",
        contentBlobId: { not: null },
        artifact: {
          is: {
            id: artifactId,
            projectId: release.projectId,
            kind: pin.kind,
          },
        },
        releasePins: { some: { releaseId: release.id } },
        contentBlob: { is: { status: "ready", deletedAt: null } },
      },
      select: {
        id: true,
        artifactId: true,
        projectId: true,
        version: true,
        schemaVersion: true,
        status: true,
        checksum: true,
        contentBlobId: true,
        contentBlob: {
          select: {
            id: true,
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
    if (!version || !blob || blob.status !== "ready" || blob.deletedAt !== null) {
      throw notFoundProblem("Shared artifact version content");
    }
    if (
      version.id !== pin.artifactVersionId
      || version.artifactId !== pin.artifactId
      || version.projectId !== release.projectId
      || version.version !== pin.version
      || version.schemaVersion !== pin.schemaVersion
      || version.status !== "ready"
      || version.checksum !== pin.checksum
      || version.contentBlobId !== blob.id
      || blob.sha256 !== pin.checksum
    ) {
      throw new Error("PUBLIC_SHARE_ARTIFACT_CONTENT_PIN_MISMATCH");
    }
    const byteSize = Number(blob.byteSize);
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
      throw new Error("PUBLIC_SHARE_ARTIFACT_BYTE_SIZE_INVALID");
    }
    return readReadyObject(this.storage, {
      storageKey: blob.storageKey,
      sha256: pin.checksum,
      byteSize,
      mediaType: blob.mediaType,
    }, rangeHeader, ifNoneMatch);
  }

  private async findActivePublicShare(token: string) {
    if (!shareTokenSchema.safeParse(token).success) throw notFoundProblem("Share");
    const row = await this.db.shareGrant.findUnique({
      where: { tokenHash: hashShareToken(token) },
      include: {
        release: { include: { artifactPins: orderedReleaseArtifactPins } },
      },
    });
    if (!row || row.status !== "active" || row.release.status !== "ready") {
      throw notFoundProblem("Share");
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await this.expireIfNeeded(row);
      throw notFoundProblem("Share");
    }
    return { row, release: mapProjectRelease(row.release as ReleaseRecord) };
  }

  private async findAuthorized(principalId: string, shareId: string) {
    const share = await this.db.shareGrant.findFirst({
      where: {
        id: shareId,
        release: {
          is: {
            project: {
              is: {
                status: "active",
                members: projectMembershipFilter(principalId, "owner"),
              },
            },
          },
        },
      },
    });
    if (!share) throw notFoundProblem("Share grant");
    return share;
  }

  private async expireProjectShares(projectId: string) {
    await this.db.shareGrant.updateMany({
      where: {
        status: "active",
        expiresAt: { lte: new Date() },
        projectId,
      },
      data: { status: "expired", revision: { increment: 1 } },
    });
  }

  private async expireIfNeeded<T extends ShareGrantRecord>(share: T): Promise<T> {
    if (share.status !== "active" || !share.expiresAt || share.expiresAt.getTime() > Date.now()) {
      return share;
    }
    const result = await this.db.shareGrant.updateMany({
      where: { id: share.id, status: "active", revision: share.revision },
      data: { status: "expired", revision: { increment: 1 } },
    });
    if (result.count === 1) {
      const expired = await this.db.shareGrant.findUnique({ where: { id: share.id } });
      if (expired) return expired as unknown as T;
    }
    const current = await this.db.shareGrant.findUnique({ where: { id: share.id } });
    if (!current) throw notFoundProblem("Share grant");
    return current as unknown as T;
  }
}

export function createShareToken() {
  return shareTokenSchema.parse(`wbs_${randomBytes(32).toString("base64url")}`);
}

export function hashShareToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isShareTokenHashCollision(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return fields.some((field) => String(field).includes("token_hash"));
}

export function encodeShareCursor(cursor: ShareCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeShareCursor(value: string): ShareCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ShareCursor>;
    if (!parsed.id || !parsed.createdAt || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch {
    throw validationProblem("The Share cursor is invalid");
  }
}

function clampLimit(value?: number) {
  return Math.min(Math.max(value ?? 30, 1), 100);
}
