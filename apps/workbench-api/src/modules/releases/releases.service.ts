import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  projectReleaseManifestSchema,
  projectReleaseProtocol,
  type CreateProjectReleaseRequest,
  type ProjectRelease,
  type ProjectReleaseList,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService, projectMembershipFilter } from "../access/access.service.js";
import { assertProjectCapability } from "../projects/project-lock.js";
import {
  canonicalSha256,
  mapProjectRelease,
  orderedReleaseArtifactPins,
  type ReleaseRecord,
} from "./release.mapper.js";
import { loadPinnedProjectSnapshot } from "./project-snapshot.js";

type ReleaseCursor = { version: number; id: string };

@Injectable()
export class ReleasesService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async list(
    principalId: string,
    projectId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ProjectReleaseList> {
    await this.access.findProject(principalId, projectId, "read");
    const limit = clampLimit(requestedLimit);
    const decoded = cursor ? decodeReleaseCursor(cursor) : undefined;
    const rows = await this.db.projectRelease.findMany({
      where: {
        projectId,
        ...(decoded ? {
          OR: [
            { version: { lt: decoded.version } },
            { version: decoded.version, id: { lt: decoded.id } },
          ],
        } : {}),
      },
      include: { artifactPins: orderedReleaseArtifactPins },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((row) => mapProjectRelease(row as ReleaseRecord)),
      nextCursor: hasNext && last
        ? encodeReleaseCursor({ version: last.version, id: last.id })
        : null,
    };
  }

  async get(principalId: string, releaseId: string): Promise<ProjectRelease> {
    const row = await this.db.projectRelease.findFirst({
      where: {
        id: releaseId,
        project: {
          is: {
            status: "active",
            members: projectMembershipFilter(principalId, "read"),
          },
        },
      },
      include: { artifactPins: orderedReleaseArtifactPins },
    });
    if (!row) throw notFoundProblem("Project release");
    return mapProjectRelease(row as ReleaseRecord);
  }

  async create(
    principalId: string,
    projectId: string,
    expectedBoardRevision: number,
    idempotencyKey: string,
    request: CreateProjectReleaseRequest,
  ): Promise<ProjectRelease> {
    validateIdempotencyKey(idempotencyKey);
    if (request.boardRevision !== expectedBoardRevision) {
      throw validationProblem("boardRevision must match the If-Match Board revision");
    }
    await this.access.findProject(principalId, projectId, "edit");
    const requestHash = hashRequest(request);
    const existing = await this.findByReceipt(projectId, idempotencyKey);
    if (existing) return this.resolveIdempotent(existing, principalId, requestHash);

    try {
      const created = await this.db.$transaction(async (tx) => {
        const projects = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${projectId} AND "status" = 'active' FOR UPDATE`,
        );
        if (!projects[0]) throw notFoundProblem("Project");
        await assertProjectCapability(tx, projectId, principalId, "edit");

        const duplicate = await tx.projectRelease.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
          include: { artifactPins: orderedReleaseArtifactPins },
        });
        if (duplicate) return this.resolveIdempotent(duplicate as ReleaseRecord & Receipt, principalId, requestHash);

        const {
          board,
          boardSnapshot,
          boardChecksum,
          artifactPins,
        } = await loadPinnedProjectSnapshot(
          tx,
          projectId,
          request.boardId,
          expectedBoardRevision,
        );
        const latest = await tx.projectRelease.findFirst({
          where: { projectId },
          select: { version: true },
          orderBy: { version: "desc" },
        });
        const version = (latest?.version ?? 0) + 1;
        const manifest = projectReleaseManifestSchema.parse({
          protocol: projectReleaseProtocol,
          projectId,
          releaseVersion: version,
          board: { id: board.id, revision: board.revision, checksum: boardChecksum },
          artifacts: artifactPins,
        });
        const manifestSha256 = canonicalSha256(manifest);
        const releaseArtifactPins: Prisma.ReleaseArtifactVersionUncheckedCreateWithoutReleaseInput[] =
          artifactPins.map((pin) => ({
            position: pin.position,
            artifactId: pin.artifactId,
            artifactVersionId: pin.artifactVersionId,
            title: pin.title,
            kind: pin.kind,
          }));

        const release = await tx.projectRelease.create({
          data: {
            projectId,
            version,
            status: "building",
            createdById: principalId,
            idempotencyKey,
            requestHash,
            boardId: board.id,
            boardRevision: board.revision,
            boardSnapshot: boardSnapshot as Prisma.InputJsonValue,
            boardChecksum,
            manifest: manifest as Prisma.InputJsonValue,
            manifestSha256,
            artifactPins: {
              create: releaseArtifactPins,
            },
          },
        });
        const finishedAt = new Date();
        await tx.projectRelease.update({
          where: { id: release.id },
          data: { status: "ready", finishedAt },
        });
        return tx.projectRelease.findUniqueOrThrow({
          where: { id: release.id },
          include: { artifactPins: orderedReleaseArtifactPins },
        });
      }, { timeout: 30_000 });
      return mapProjectRelease(created as ReleaseRecord);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.findByReceipt(projectId, idempotencyKey);
        if (duplicate) return this.resolveIdempotent(duplicate, principalId, requestHash);
      }
      throw error;
    }
  }

  private findByReceipt(projectId: string, idempotencyKey: string) {
    return this.db.projectRelease.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      include: { artifactPins: orderedReleaseArtifactPins },
    }) as Promise<(ReleaseRecord & Receipt) | null>;
  }

  private resolveIdempotent(
    release: ReleaseRecord & Receipt,
    principalId: string,
    requestHash: string,
  ) {
    if (release.requestHash !== requestHash || release.createdById !== principalId) {
      throw idempotencyConflictProblem();
    }
    return mapProjectRelease(release);
  }
}

type Receipt = { requestHash: string };

export function encodeReleaseCursor(cursor: ReleaseCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeReleaseCursor(value: string): ReleaseCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ReleaseCursor>;
    if (!parsed.id || !Number.isSafeInteger(parsed.version) || parsed.version! < 1) throw new Error();
    return { id: parsed.id, version: parsed.version! };
  } catch {
    throw validationProblem("The Project release cursor is invalid");
  }
}

function clampLimit(value?: number) {
  return Math.min(Math.max(value ?? 30, 1), 100);
}
