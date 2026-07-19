import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import type {
  CreateThreadRequest,
  Thread,
  ThreadEntryList,
  ThreadList,
  UpdateThreadRequest,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  threadStateConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { mapThread, mapThreadEntry } from "./thread.mapper.js";

type ThreadCursor = { updatedAt: string; id: string };

@Injectable()
export class ThreadsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async list(
    principalId: string,
    projectId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<ThreadList> {
    await this.access.findProject(principalId, projectId, "read");
    const limit = clampLimit(requestedLimit, 30, 100);
    const decodedCursor = cursor ? decodeThreadCursor(cursor) : undefined;
    const items = await this.db.thread.findMany({
      where: {
        projectId,
        status: "active",
        ...(decodedCursor
          ? {
              OR: [
                { updatedAt: { lt: new Date(decodedCursor.updatedAt) } },
                { updatedAt: new Date(decodedCursor.updatedAt), id: { lt: decodedCursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasNextPage = items.length > limit;
    const page = hasNextPage ? items.slice(0, limit) : items;
    const last = page.at(-1);
    return {
      items: page.map(mapThread),
      nextCursor: hasNextPage && last
        ? encodeThreadCursor({ updatedAt: last.updatedAt.toISOString(), id: last.id })
        : null,
    };
  }

  async create(
    principalId: string,
    projectId: string,
    idempotencyKey: string,
    input: CreateThreadRequest,
  ): Promise<Thread> {
    validateIdempotencyKey(idempotencyKey);
    await this.access.findProject(principalId, projectId, "edit");
    const requestHash = hashRequest(input);
    const existing = await this.db.thread.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
    if (existing) return this.resolveIdempotentThread(existing, requestHash);

    try {
      const created = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "edit");
        const duplicate = await tx.thread.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        });
        if (duplicate) {
          if (duplicate.requestHash !== requestHash) throw idempotencyConflictProblem();
          return duplicate;
        }
        const thread = await tx.thread.create({
          data: {
            projectId,
            createdById: principalId,
            title: input.title,
            idempotencyKey,
            requestHash,
          },
        });
        await tx.project.update({
          where: { id: projectId },
          data: { revision: { increment: 1 } },
        });
        return thread;
      });
      return mapThread(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.db.thread.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        });
        if (duplicate) return this.resolveIdempotentThread(duplicate, requestHash);
      }
      throw error;
    }
  }

  async get(principalId: string, threadId: string): Promise<Thread> {
    return mapThread(await this.access.findThread(principalId, threadId, "read"));
  }

  async update(
    principalId: string,
    threadId: string,
    expectedRevision: number,
    input: UpdateThreadRequest,
  ): Promise<Thread> {
    const current = await this.access.findThread(principalId, threadId, "edit");
    const updated = await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, current.projectId, principalId, "edit");
      const result = await tx.thread.updateMany({
        where: { id: current.id, status: "active", revision: expectedRevision },
        data: { title: input.title, revision: { increment: 1 } },
      });
      if (result.count !== 1) throw revisionConflictProblem();
      return tx.thread.findUnique({ where: { id: threadId } });
    });
    if (!updated) throw notFoundProblem("Thread");
    return mapThread(updated);
  }

  async archive(principalId: string, threadId: string, expectedRevision: number): Promise<void> {
    const current = await this.access.findThread(principalId, threadId, "edit");
    const result = await this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, current.projectId, principalId, "edit");
      const lockedThreads = await tx.$queryRaw<Array<{ revision: number; status: string }>>(
        Prisma.sql`
          SELECT "revision", "status"::text AS "status"
          FROM "threads"
          WHERE "id" = ${threadId}
          FOR UPDATE
        `,
      );
      const locked = lockedThreads[0];
      if (!locked || locked.status !== "active") throw notFoundProblem("Thread");
      if (locked.revision !== expectedRevision) throw revisionConflictProblem();
      const activeRun = await tx.run.findFirst({
        where: {
          threadId,
          status: { in: ["queued", "running", "waiting_input", "cancelling"] },
        },
        select: { id: true },
      });
      if (activeRun) throw threadStateConflictProblem("Thread cannot be archived while it has an active Run");
      const updated = await tx.thread.updateMany({
        where: { id: current.id, status: "active", revision: expectedRevision },
        data: { status: "archived", revision: { increment: 1 } },
      });
      if (updated.count === 1) {
        await tx.project.update({
          where: { id: current.projectId },
          data: { revision: { increment: 1 } },
        });
      }
      return updated;
    });
    if (result.count !== 1) throw revisionConflictProblem();
  }

  async listEntries(
    principalId: string,
    threadId: string,
    afterSequence = 0,
    requestedLimit?: number,
  ): Promise<ThreadEntryList> {
    await this.access.findThread(principalId, threadId, "read");
    const limit = clampLimit(requestedLimit, 100, 500);
    const entries = await this.db.threadEntry.findMany({
      where: { threadId, sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      take: limit + 1,
    });
    const hasNextPage = entries.length > limit;
    const page = hasNextPage ? entries.slice(0, limit) : entries;
    return {
      items: page.map(mapThreadEntry),
      nextAfterSequence: hasNextPage ? page.at(-1)?.sequence ?? null : null,
    };
  }

  private resolveIdempotentThread(
    thread: Parameters<typeof mapThread>[0] & { requestHash: string | null },
    requestHash: string,
  ) {
    if (thread.requestHash !== requestHash) throw idempotencyConflictProblem();
    return mapThread(thread);
  }
}

export function encodeThreadCursor(cursor: ThreadCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeThreadCursor(value: string): ThreadCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ThreadCursor>;
    if (!parsed.id || !parsed.updatedAt || Number.isNaN(Date.parse(parsed.updatedAt))) throw new Error("invalid cursor");
    return { id: parsed.id, updatedAt: parsed.updatedAt };
  } catch {
    throw validationProblem("The thread cursor is invalid");
  }
}

function clampLimit(value: number | undefined, fallback: number, maximum: number) {
  return Math.min(Math.max(value ?? fallback, 1), maximum);
}
