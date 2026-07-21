import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import {
  importSourceProcessJobOptions,
  importSourceProcessQueue,
} from "@workbench/workbench-contracts";
import { PgBoss } from "pg-boss";
import { AccessService } from "../src/modules/access/access.service.js";
import { ImportSourcesService } from "../src/modules/import-sources/import-sources.service.js";
import {
  WorkbenchQueueService,
  pgConnectionString,
} from "../src/platform/queue/workbench-queue.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Import Source PostgreSQL queue atomicity", () => {
  it("commits external Source, pg-boss job, and queued attempt together and rolls jobs back with Prisma", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const queue = new WorkbenchQueueService(new ConfigService({
      WORKBENCH_DATABASE_URL: databaseUrl,
    }));
    const suffix = `${Date.now()}_${randomUUID()}`;
    let principalId: string | undefined;
    let workspaceId: string | undefined;
    const queueJobIds: string[] = [];

    try {
      await installQueueSchema(databaseUrl!);
      await queue.onModuleInit();
      const principal = await db.principal.create({
        data: { issuer: `import-source-${suffix}`, subject: `owner-${suffix}` },
      });
      principalId = principal.id;
      const workspace = await db.workspace.create({
        data: {
          slug: `import-source-${suffix}`,
          name: "Import Source queue atomicity",
          createdById: principal.id,
        },
      });
      workspaceId = workspace.id;
      await db.workspaceMember.create({
        data: { workspaceId: workspace.id, principalId: principal.id, role: "owner" },
      });
      const project = await db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: principal.id,
            title: "External source",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: principal.id,
            role: "owner",
          },
        });
        return created;
      });

      const sources = new ImportSourcesService(
        db as never,
        new AccessService(db as never),
        queue,
      );
      const source = await sources.create(
        principal.id,
        project.id,
        `import:postgres:${suffix}`,
        { kind: "url_snapshot", sourceUrl: "https://example.com/design-reference" },
      );
      const attempt = await db.importSourceAttempt.findUniqueOrThrow({
        where: { importSourceId_attempt: { importSourceId: source.id, attempt: 1 } },
      });
      queueJobIds.push(attempt.queueJobId);
      const committedJobs = await jobRows(db, attempt.queueJobId);

      expect(source).toMatchObject({ status: "pending", revision: 0 });
      expect(attempt).toMatchObject({
        importSourceId: source.id,
        projectId: project.id,
        attempt: 1,
        status: "queued",
      });
      expect(committedJobs).toEqual([{ id: attempt.queueJobId, name: importSourceProcessQueue }]);

      let rolledBackJobId: string | undefined;
      await expect(db.$transaction(async (tx) => {
        rolledBackJobId = await queue.sendInTransaction(
          tx,
          importSourceProcessQueue,
          {
            sourceId: `source_${randomUUID()}`,
            projectId: project.id,
            requestHash: "a".repeat(64),
          },
          importSourceProcessJobOptions({ sourceId: `rollback_${suffix}` }),
        );
        throw new Error("EXPECTED_IMPORT_QUEUE_ROLLBACK");
      })).rejects.toThrow("EXPECTED_IMPORT_QUEUE_ROLLBACK");

      expect(rolledBackJobId).toBeDefined();
      expect(await jobRows(db, rolledBackJobId!)).toEqual([]);
    } finally {
      await queue.onModuleDestroy().catch(() => undefined);
      for (const jobId of queueJobIds) {
        await db.$executeRaw(Prisma.sql`
          DELETE FROM "workbench_jobs"."job"
          WHERE "id" = CAST(${jobId} AS uuid)
        `).catch(() => undefined);
      }
      if (workspaceId) {
        await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      }
      if (principalId) {
        await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
      }
      await db.$disconnect();
    }
  });
});

async function installQueueSchema(connectionString: string) {
  const installer = new PgBoss({
    connectionString: pgConnectionString(connectionString),
    schema: "workbench_jobs",
    application_name: "workbench-api-postgres-test-migrator",
    schedule: false,
    supervise: false,
    migrate: true,
    createSchema: true,
    useListenNotify: false,
  });
  let started = false;
  try {
    await installer.start();
    started = true;
  } finally {
    if (started) await installer.stop({ graceful: true, timeout: 30_000 });
  }
}

function jobRows(db: PrismaClient, jobId: string) {
  return db.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
    SELECT "id"::text AS "id", "name"
    FROM "workbench_jobs"."job"
    WHERE "id" = CAST(${jobId} AS uuid)
  `);
}
