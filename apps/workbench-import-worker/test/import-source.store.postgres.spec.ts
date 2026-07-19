import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { describe, expect, it } from "vitest";
import { RetryableImportError } from "../src/errors.js";
import { PrismaImportSourceStore } from "../src/import/import-source.store.js";

const databaseUrl = process.env.WORKBENCH_IMPORT_STORE_TEST_DATABASE_URL ?? process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const rollback = new Error("ROLLBACK_IMPORT_SOURCE_STORE_TEST");

describeWithPostgres("PrismaImportSourceStore PostgreSQL boundaries", () => {
  it("claims one owner, reaps its expired lease, and atomically schedules the next attempt", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    try {
      await expect(db.$transaction(async (tx) => {
        const fixture = await seed(tx);
        const store = new PrismaImportSourceStore(boundDatabase(tx) as never, {
          pending: "pending/imports",
          canonical: "blobs",
        });

        await expect(store.beginAttempt(fixture.sourceId, { queueJobId: "job-1", leaseMs: 1 }))
          .resolves.toMatchObject({ kind: "run", attemptNumber: 1 });
        await expect(store.beginAttempt(fixture.sourceId, { queueJobId: "job-1", leaseMs: 1 }))
          .resolves.toEqual({ kind: "busy" });

        await new Promise((resolve) => setTimeout(resolve, 5));
        await expect(store.expireStaleAttempts(new Date(Date.now() + 1_000), 3, 50)).resolves.toEqual({
          expired: 1,
          retryable: 1,
          exhausted: 0,
        });

        const candidates = await store.reconciliationCandidates(new Date(0), 3, 50);
        expect(candidates).toEqual([{
          sourceId: fixture.sourceId,
          projectId: fixture.projectId,
          requestHash: fixture.requestHash,
          nextAttempt: 2,
        }]);
        await expect(store.scheduleRetry(candidates[0]!, async () => "job-2")).resolves.toBe(true);
        await expect(tx.importSourceAttempt.findMany({
          where: { importSourceId: fixture.sourceId },
          orderBy: { attempt: "asc" },
          select: { attempt: true, status: true, queueJobId: true },
        })).resolves.toEqual([
          { attempt: 1, status: "retryable_failed", queueJobId: "job-1" },
          { attempt: 2, status: "queued", queueJobId: "job-2" },
        ]);

        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
        throw rollback;
      }, { timeout: 30_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("commits a terminal receipt and failed Source on the final transient attempt", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    try {
      await expect(db.$transaction(async (tx) => {
        const fixture = await seed(tx);
        const store = new PrismaImportSourceStore(boundDatabase(tx) as never, {
          pending: "pending/imports",
          canonical: "blobs",
        });
        const failure = new RetryableImportError("IMPORT_REMOTE_TIMEOUT", "Remote timeout");

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const queueJobId = `job-${attempt}`;
          const start = await store.beginAttempt(fixture.sourceId, { queueJobId, leaseMs: 60_000 });
          expect(start).toMatchObject({ kind: "run", attemptNumber: attempt });
          if (start.kind !== "run") throw new Error("IMPORT_TEST_ATTEMPT_NOT_CLAIMED");
          await store.recordFailure(
            start.attemptId,
            start.leaseToken,
            failure,
            attempt === 3 ? "exhausted" : "retryable",
          );
          if (attempt < 3) {
            const [candidate] = await store.reconciliationCandidates(new Date(Date.now() + 60_000), 3, 50);
            expect(candidate?.nextAttempt).toBe(attempt + 1);
            await expect(store.scheduleRetry(candidate!, async () => `job-${attempt + 1}`)).resolves.toBe(true);
          }
        }

        await expect(tx.importSource.findUniqueOrThrow({
          where: { id: fixture.sourceId },
          select: { status: true, failureCode: true, revision: true },
        })).resolves.toEqual({
          status: "failed",
          failureCode: "IMPORT_ATTEMPTS_EXHAUSTED",
          revision: 1,
        });
        await expect(tx.importSourceAttempt.findFirstOrThrow({
          where: { importSourceId: fixture.sourceId },
          orderBy: { attempt: "desc" },
          select: { attempt: true, status: true, failureCode: true },
        })).resolves.toEqual({
          attempt: 3,
          status: "terminal_failed",
          failureCode: "IMPORT_REMOTE_TIMEOUT",
        });

        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
        throw rollback;
      }, { timeout: 30_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  }, 60_000);
});

async function seed(tx: Prisma.TransactionClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = {
    principalId: `principal_import_${suffix}`,
    workspaceId: `workspace_import_${suffix}`,
    projectId: `project_import_${suffix}`,
    sourceId: `source_import_${suffix}`,
    requestHash: "a".repeat(64),
  };
  await tx.principal.create({
    data: { id: fixture.principalId, issuer: `import-test-${suffix}`, subject: fixture.principalId },
  });
  await tx.workspace.create({
    data: {
      id: fixture.workspaceId,
      slug: `import-test-${suffix}`,
      name: "Import Worker integration",
      createdById: fixture.principalId,
    },
  });
  await tx.workspaceMember.create({
    data: { workspaceId: fixture.workspaceId, principalId: fixture.principalId, role: "owner" },
  });
  await tx.project.create({
    data: {
      id: fixture.projectId,
      workspaceId: fixture.workspaceId,
      createdById: fixture.principalId,
      title: "Import Worker integration",
    },
  });
  await tx.projectMember.create({
    data: {
      projectId: fixture.projectId,
      workspaceId: fixture.workspaceId,
      principalId: fixture.principalId,
      role: "owner",
    },
  });
  await tx.importSource.create({
    data: {
      id: fixture.sourceId,
      projectId: fixture.projectId,
      createdById: fixture.principalId,
      kind: "url_snapshot",
      status: "pending",
      label: "Website",
      request: { kind: "url_snapshot", sourceUrl: "https://example.test" },
      requestHash: fixture.requestHash,
      idempotencyKey: `import-test-${suffix}`,
    },
  });
  await tx.importSourceAttempt.create({
    data: {
      id: `attempt_import_${suffix}_1`,
      importSourceId: fixture.sourceId,
      projectId: fixture.projectId,
      attempt: 1,
      queueJobId: "job-1",
      status: "queued",
    },
  });
  return fixture;
}

function boundDatabase(tx: Prisma.TransactionClient) {
  return {
    $transaction: async <T>(operation: (client: Prisma.TransactionClient) => Promise<T>) => operation(tx),
    $queryRaw: tx.$queryRaw.bind(tx),
    importSource: tx.importSource,
    importSourceAttempt: tx.importSourceAttempt,
    importSourceBlob: tx.importSourceBlob,
    blob: tx.blob,
    blobScan: tx.blobScan,
  };
}
