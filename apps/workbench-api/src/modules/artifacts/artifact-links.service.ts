import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@workbench/workbench-db";
import {
  artifactLinkSchema,
  artifactLinkListSchema,
  artifactLinksQuerySchema,
  createArtifactLinkRequestSchema,
  type CreateArtifactLinkRequest,
} from "@workbench/workbench-contracts";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import {
  hashRequest,
  validateIdempotencyKey,
} from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { lockActiveProject } from "../projects/project-lock.js";

const endpointSelect = {
  id: true,
  artifactId: true,
  projectId: true,
  version: true,
  status: true,
  artifact: { select: { title: true, kind: true } },
} as const;
const linkInclude = {
  source: { select: endpointSelect },
  target: { select: endpointSelect },
} as const;
type LinkRow = Prisma.ArtifactLinkGetPayload<{ include: typeof linkInclude }>;
const cursorSchema = z
  .object({
    projectId: z.string(),
    artifactVersionId: z.string().nullable(),
    includeRemoved: z.enum(["true", "false"]),
    createdAt: z.string().datetime(),
    id: z.string().min(1),
  })
  .strict();
function mapLink(row: LinkRow) {
  const endpoint = (version: LinkRow["source"]) => ({
    artifactId: version.artifactId,
    artifactVersionId: version.id,
    version: version.version,
    title: version.artifact.title,
    kind: version.artifact.kind,
    status: version.status,
  });
  return artifactLinkSchema.parse({
    id: row.id,
    projectId: row.projectId,
    source: endpoint(row.source),
    target: endpoint(row.target),
    kind: row.kind,
    label: row.label,
    origin: row.legacyBoardEdgeId ? "imported" : "manual",
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    removedAt: row.removedAt?.toISOString() ?? null,
  });
}
/** Shared transaction boundary also used by image save-as, so image and lineage commit together. */
export async function createArtifactLinkInTransaction(
  tx: Prisma.TransactionClient,
  principalId: string,
  projectId: string,
  key: string,
  input: CreateArtifactLinkRequest,
) {
  validateIdempotencyKey(key);
  const request = createArtifactLinkRequestSchema.parse(input),
    requestHash = hashRequest(request);
  await lockActiveProject(tx, projectId, principalId, "edit");
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-link:${projectId}:${key}`},0))`,
  );
  const existing = await tx.artifactLink.findUnique({
    where: { projectId_idempotencyKey: { projectId, idempotencyKey: key } },
    include: linkInclude,
  });
  if (existing) {
    if (
      existing.createdById !== principalId ||
      existing.requestHash !== requestHash
    )
      throw idempotencyConflictProblem();
    return mapLink(existing);
  }
  const endpoints = await tx.artifactVersion.findMany({
    where: {
      projectId,
      status: "ready",
      OR: [
        {
          id: request.source.artifactVersionId,
          artifactId: request.source.artifactId,
        },
        {
          id: request.target.artifactVersionId,
          artifactId: request.target.artifactId,
        },
      ],
    },
    select: { id: true, artifactId: true },
  });
  if (
    ![request.source, request.target].every((item) =>
      endpoints.some(
        (row) =>
          row.id === item.artifactVersionId &&
          row.artifactId === item.artifactId,
      ),
    )
  )
    throw notFoundProblem("Ready artifact versions");
  const row = await tx.artifactLink.create({
    data: {
      projectId,
      sourceVersionId: request.source.artifactVersionId,
      targetVersionId: request.target.artifactVersionId,
      kind: request.kind,
      label: request.label,
      createdById: principalId,
      idempotencyKey: key,
      requestHash,
    },
    include: linkInclude,
  });
  return mapLink(row);
}
@Injectable()
export class ArtifactLinksService {
  constructor(private readonly db: WorkbenchDbService) {}
  async create(
    principalId: string,
    projectId: string,
    key: string,
    request: CreateArtifactLinkRequest,
  ) {
    return this.db.$transaction((tx) =>
      createArtifactLinkInTransaction(tx, principalId, projectId, key, request),
    );
  }
  async list(principalId: string, projectId: string, input: unknown = {}) {
    const query = artifactLinksQuerySchema.parse(input);
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
        );
        if (
          cursor.projectId !== projectId ||
          cursor.artifactVersionId !== (query.artifactVersionId ?? null) ||
          cursor.includeRemoved !== query.includeRemoved
        )
          throw Error("scope");
      } catch {
        throw validationProblem(
          "Artifact link cursor does not match this project and filter",
        );
      }
    }
    return this.db.$transaction(
      async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "read");
        if (
          query.artifactVersionId &&
          !(await tx.artifactVersion.findFirst({
            where: { id: query.artifactVersionId, projectId },
            select: { id: true },
          }))
        )
          throw notFoundProblem("Artifact version");
        const rows = await tx.artifactLink.findMany({
          where: {
            projectId,
            ...(query.includeRemoved === "false" ? { removedAt: null } : {}),
            AND: [
              ...(query.artifactVersionId
                ? [
                    {
                      OR: [
                        { sourceVersionId: query.artifactVersionId },
                        { targetVersionId: query.artifactVersionId },
                      ],
                    },
                  ]
                : []),
              ...(cursor
                ? [
                    {
                      OR: [
                        { createdAt: { lt: new Date(cursor.createdAt) } },
                        {
                          createdAt: new Date(cursor.createdAt),
                          id: { lt: cursor.id },
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: query.limit + 1,
          include: linkInclude,
        });
        const page = rows.slice(0, query.limit),
          last = page.at(-1);
        return artifactLinkListSchema.parse({
          items: page.map(mapLink),
          nextCursor:
            rows.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    projectId,
                    artifactVersionId: query.artifactVersionId ?? null,
                    includeRemoved: query.includeRemoved,
                    createdAt: last.createdAt.toISOString(),
                    id: last.id,
                  }),
                ).toString("base64url")
              : null,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async remove(
    principalId: string,
    projectId: string,
    id: string,
    expectedRevision: number,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, projectId, principalId, "edit");
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM artifact_links WHERE id=${id} AND project_id=${projectId} FOR UPDATE`,
      );
      if (!locked.length) throw notFoundProblem("Artifact link");
      const row = await tx.artifactLink.findUniqueOrThrow({
        where: { id },
        include: linkInclude,
      });
      // A repeated remove confirms the already removed relation; it never restores it.
      if (row.removedAt) return mapLink(row);
      if (row.revision !== expectedRevision) throw revisionConflictProblem();
      return mapLink(
        await tx.artifactLink.update({
          where: { id },
          data: { removedAt: new Date(), revision: { increment: 1 } },
          include: linkInclude,
        }),
      );
    });
  }
}
