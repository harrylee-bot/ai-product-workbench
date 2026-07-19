import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import type {
  CreateProjectRequest,
  Project,
  ProjectBootstrap,
  ProjectList,
  ProjectRelationship,
  UpdateProjectRequest,
} from "@workbench/workbench-contracts";
import { projectListSchema } from "@workbench/workbench-contracts";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import {
  notFoundProblem,
  projectStateConflictProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { AccessService } from "../access/access.service.js";
import { mapBoard } from "../boards/board.mapper.js";
import { mapRun, orderedRunSourceSnapshots } from "../runs/run.mapper.js";
import { mapThread, mapThreadEntry } from "../threads/thread.mapper.js";
import { mapProject } from "./project.mapper.js";
import { assertProjectCapability } from "./project-lock.js";

type ProjectCursor = {
  updatedAt: string;
  id: string;
  q: string | null;
  relationship: ProjectRelationship | null;
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async list(
    principalId: string,
    query?: string,
    relationship?: ProjectRelationship,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ProjectList> {
    const normalizedQuery = normalizeProjectQuery(query);
    const containsPattern = normalizedQuery === undefined
      ? undefined
      : escapeProjectContainsPattern(normalizedQuery);
    const limit = Math.min(Math.max(requestedLimit ?? 30, 1), 100);
    const decodedCursor = cursor ? decodeCursor(cursor) : undefined;
    if (
      decodedCursor
      && (
        decodedCursor.q !== (normalizedQuery ?? null)
        || decodedCursor.relationship !== (relationship ?? null)
      )
    ) {
      throw validationProblem("The project cursor does not belong to these list filters");
    }
    const items = await this.db.project.findMany({
      where: {
        status: "active",
        members: {
          some: {
            principalId,
            ...(relationship === "owned"
              ? { role: "owner" as const }
              : relationship === "shared"
                ? { role: { in: ["editor", "viewer"] } }
                : {}),
          },
        },
        AND: [
          ...(containsPattern ? [{
            OR: [
              { title: { contains: containsPattern, mode: "insensitive" as const } },
              { summary: { contains: containsPattern, mode: "insensitive" as const } },
            ],
          }] : []),
          ...(decodedCursor ? [{
              OR: [
                { updatedAt: { lt: new Date(decodedCursor.updatedAt) } },
                { updatedAt: new Date(decodedCursor.updatedAt), id: { lt: decodedCursor.id } },
              ],
          }] : []),
        ],
      },
      include: {
        members: {
          where: { principalId },
          select: { role: true },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasNextPage = items.length > limit;
    const page = hasNextPage ? items.slice(0, limit) : items;
    const last = page.at(-1);
    return projectListSchema.parse({
      items: page.map((project) => {
        const role = project.members[0]?.role;
        if (!role) throw new Error("Project membership projection is missing");
        return {
          ...mapProject(project),
          role,
          relationship: role === "owner" ? "owned" : "shared",
        };
      }),
      nextCursor: hasNextPage && last
        ? encodeCursor({
            updatedAt: last.updatedAt.toISOString(),
            id: last.id,
            q: normalizedQuery ?? null,
            relationship: relationship ?? null,
          })
        : null,
    });
  }

  async create(
    principalId: string,
    workspaceId: string,
    input: CreateProjectRequest,
  ): Promise<Project> {
    await this.access.assertWorkspaceMember(principalId, workspaceId);
    const project = await this.db.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          workspaceId,
          createdById: principalId,
          title: input.title,
          summary: input.summary || null,
        },
      });
      await tx.projectMember.create({
        data: {
          projectId: created.id,
          workspaceId,
          principalId,
          role: "owner",
        },
      });
      await tx.thread.create({
        data: {
          projectId: created.id,
          createdById: principalId,
          title: "Main",
        },
      });
      await tx.board.create({
        data: {
          projectId: created.id,
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      });
      return created;
    });
    return mapProject(project);
  }

  async update(
    principalId: string,
    projectId: string,
    expectedRevision: number,
    input: UpdateProjectRequest,
  ): Promise<Project> {
    const updated = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; revision: number }>>(Prisma.sql`
        SELECT "id", "revision"
        FROM "projects"
        WHERE "id" = ${projectId} AND "status" = 'active'
        FOR UPDATE
      `);
      const project = locked[0];
      if (!project) throw notFoundProblem("Project");
      await assertProjectCapability(tx, projectId, principalId, "edit");
      if (project.revision !== expectedRevision) throw revisionConflictProblem();
      return tx.project.update({
        where: { id: projectId },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.summary === undefined ? {} : { summary: input.summary || null }),
          revision: { increment: 1 },
        },
      });
    });
    return mapProject(updated);
  }

  async archive(
    principalId: string,
    projectId: string,
    expectedRevision: number,
  ): Promise<Project> {
    const authorized = await this.access.findProject(principalId, projectId, "owner");
    if (authorized.revision !== expectedRevision) throw revisionConflictProblem();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const archived = await this.db.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string; revision: number }>>(Prisma.sql`
            SELECT "id", "revision"
            FROM "projects"
            WHERE "id" = ${projectId} AND "status" = 'active'
            FOR UPDATE
          `);
          const project = locked[0];
          if (!project) throw revisionConflictProblem();
          if (project.revision !== expectedRevision) throw revisionConflictProblem();
          const owner = await tx.projectMember.findUnique({
            where: { projectId_principalId: { projectId, principalId } },
            select: { role: true },
          });
          if (owner?.role !== "owner") throw notFoundProblem("Project");

          const [
            activeRuns,
            activeExports,
            activeFileAssets,
            activeUploads,
            activeExtractions,
          ] = await Promise.all([
            tx.run.count({
              where: {
                projectId,
                status: { in: ["queued", "running", "waiting_input", "cancelling"] },
              },
            }),
            tx.exportJob.count({
              where: {
                status: { in: ["queued", "running"] },
                release: { is: { projectId } },
              },
            }),
            tx.fileAsset.count({
              where: {
                projectId,
                status: { in: ["uploading", "verifying"] },
              },
            }),
            tx.fileUploadSession.count({
              where: {
                projectId,
                status: { in: ["initiating", "initiated", "completing", "aborting"] },
              },
            }),
            tx.fileExtraction.count({
              where: {
                status: { in: ["queued", "running"] },
                file: { is: { projectId } },
              },
            }),
          ]);
          if (activeRuns > 0) {
            throw projectStateConflictProblem("Project cannot be archived while a Run is active");
          }
          if (activeExports > 0) {
            throw projectStateConflictProblem("Project cannot be archived while an Export is active");
          }
          if (activeFileAssets > 0 || activeUploads > 0 || activeExtractions > 0) {
            throw projectStateConflictProblem(
              "Project cannot be archived while a File upload, verification, or extraction is active",
            );
          }

          const now = new Date();
          await tx.shareGrant.updateMany({
            where: {
              status: "active",
              release: { is: { projectId } },
            },
            data: {
              status: "revoked",
              revokedAt: now,
              revision: { increment: 1 },
            },
          });
          return tx.project.update({
            where: { id: projectId },
            data: { status: "archived", revision: { increment: 1 } },
          });
        }, {
          // Producer commands hold a Project SHARE lock. READ COMMITTED makes
          // checks after this UPDATE lock see producers that committed while it waited.
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        });
        return mapProject(archived);
      } catch (error) {
        const serializationFailure = error instanceof Prisma.PrismaClientKnownRequestError
          && error.code === "P2034";
        if (!serializationFailure) throw error;
        if (attempt === 2) {
          throw projectStateConflictProblem(
            "Project archive conflicted with another write; reload the Project and retry",
          );
        }
      }
    }
    throw new Error("PROJECT_ARCHIVE_RETRY_EXHAUSTED");
  }

  async bootstrap(
    principalId: string,
    projectId: string,
    requestedThreadId?: string,
  ): Promise<ProjectBootstrap> {
    const project = await this.access.findProject(principalId, projectId, "read");
    const role = project.members[0]?.role;
    if (!role) throw notFoundProblem("Project");
    const [threads, board, artifacts] = await Promise.all([
      this.db.thread.findMany({
        where: { projectId, status: "active" },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      }),
      this.db.board.findUnique({
        where: { projectId },
        include: { nodes: true, edges: true },
      }),
      this.db.artifact.findMany({
        where: {
          projectId,
          currentVersionId: { not: null },
          currentVersion: { is: { status: "ready" } },
        },
        include: { currentVersion: true },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    if (!board) throw notFoundProblem("Project board");

    const selectedThread = requestedThreadId
      ? threads.find((thread) => thread.id === requestedThreadId)
      : threads.at(0);
    if (requestedThreadId && !selectedThread) throw notFoundProblem("Thread");
    const [entries, latestRun] = selectedThread
      ? await Promise.all([
          this.db.threadEntry.findMany({
            where: { threadId: selectedThread.id },
            orderBy: { sequence: "desc" },
            take: 500,
          }),
          this.db.run.findFirst({
            where: { threadId: selectedThread.id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            include: { sourceSnapshots: orderedRunSourceSnapshots },
          }),
        ])
      : [[], null] as const;

    return {
      project: mapProject(project),
      access: { role },
      threads: threads.map(mapThread),
      selectedThreadId: selectedThread?.id ?? null,
      entries: [...entries].reverse().map(mapThreadEntry),
      board: mapBoard(board),
      artifacts: artifacts.map((artifact) => ({
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
      })),
      latestRun: latestRun ? mapRun(latestRun) : null,
    };
  }

}

export function encodeCursor(cursor: ProjectCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(value: string): ProjectCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ProjectCursor>;
    if (
      typeof parsed.id !== "string"
      || parsed.id.length === 0
      || typeof parsed.updatedAt !== "string"
      || !isCanonicalIsoDateTime(parsed.updatedAt)
      || !(
        parsed.q === null
        || (
          typeof parsed.q === "string"
          && parsed.q.length <= 160
          && normalizeProjectQuery(parsed.q) === parsed.q
        )
      )
      || !(
        parsed.relationship === null
        || parsed.relationship === "owned"
        || parsed.relationship === "shared"
      )
    ) throw new Error("invalid cursor");
    return {
      id: parsed.id,
      updatedAt: parsed.updatedAt,
      q: parsed.q,
      relationship: parsed.relationship,
    };
  } catch {
    throw validationProblem("The project cursor is invalid");
  }
}

function isCanonicalIsoDateTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function normalizeProjectQuery(value?: string) {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw validationProblem("q must not be blank");
  if (normalized.length > 160) throw validationProblem("q must not exceed 160 characters");
  return normalized;
}

export function escapeProjectContainsPattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
