import { createHash, randomUUID } from "node:crypto";
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

describeWithPostgres("Import Source PostgreSQL lifecycle and queue atomicity", () => {
  it.each(["file", "design_md"] as const)(
    "publishes a ready %s source without violating pending checksum or manifest constraints",
    async (kind) => {
      const db = new PrismaClient({ datasourceUrl: databaseUrl });
      const suffix = randomUUID().replaceAll("-", "");
      const principalId = `principal_import_${suffix}`;
      const workspaceId = `workspace_import_${suffix}`;
      const projectId = `project_import_${suffix}`;
      const blobId = `blob_import_${suffix}`;
      const fileId = `file_import_${suffix}`;
      const bytes = Buffer.from(`# Local source ${suffix}\n`, "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const verifiedAt = new Date();
      const request = { kind, fileAssetId: fileId };
      const queue = { sendInTransaction: vi.fn() };
      const rollbackFixture = new Error("ROLLBACK_LOCAL_SOURCE_REGRESSION_FIXTURE");

      try {
        await expect(db.$transaction(async (tx) => {
          await tx.principal.create({
            data: { id: principalId, issuer: `import-${suffix}`, subject: principalId },
          });
          await tx.workspace.create({
            data: {
              id: workspaceId,
              slug: `import-${suffix}`,
              name: "Local source lifecycle",
              createdById: principalId,
            },
          });
          await tx.workspaceMember.create({
            data: { workspaceId, principalId, role: "owner" },
          });
          await tx.project.create({
            data: { id: projectId, workspaceId, createdById: principalId, title: "Local source" },
          });
          await tx.projectMember.create({
            data: { projectId, workspaceId, principalId, role: "owner" },
          });
          await tx.blob.create({
            data: {
              id: blobId,
              sha256,
              generation: 1,
              storageKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g1`,
              mediaType: "text/markdown",
              byteSize: BigInt(bytes.byteLength),
              status: "ready",
              verifiedAt,
            },
          });
          await tx.blobScan.create({
            data: {
              blobId,
              attempt: 1,
              status: "clean",
              scanner: "test-scanner",
              scannerVersion: "1",
              signatureVersion: "test-signatures",
              evidence: { result: "clean" },
              startedAt: verifiedAt,
              finishedAt: verifiedAt,
            },
          });
          await tx.fileAsset.create({
            data: {
              id: fileId,
              projectId,
              blobId,
              uploadedById: principalId,
              originalName: kind === "design_md" ? "DESIGN.md" : "reference.md",
              declaredMediaType: "text/markdown",
              detectedMediaType: "text/markdown",
              byteSize: BigInt(bytes.byteLength),
              status: "ready",
              verifiedAt,
            },
          });
          // Keep the actual database guard: weakening/removing it must not make
          // this regression pass. Recover from the intentional constraint error
          // with a savepoint so the fixture remains in a single rolled-back tx.
          await tx.$executeRawUnsafe("SAVEPOINT invalid_pending_checksum");
          await expect(tx.importSource.create({
            data: {
              id: `source_invalid_${suffix}`,
              projectId,
              createdById: principalId,
              kind,
              status: "pending",
              label: "Invalid pending checksum",
              request,
              requestHash: "a".repeat(64),
              idempotencyKey: `invalid-pending:${suffix}`,
              checksum: sha256,
            },
          })).rejects.toThrow("import_sources_lifecycle_check");
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT invalid_pending_checksum");
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT invalid_pending_checksum");

          const scopedDb = {
            importSource: tx.importSource,
            $transaction: (callback: (client: Prisma.TransactionClient) => unknown) => callback(tx),
          };
          const service = new ImportSourcesService(
            scopedDb as never,
            new AccessService(tx as never),
            queue as never,
          );
          const idempotencyKey = `local-source:${suffix}`;
          const source = await service.create(principalId, projectId, idempotencyKey, request);
          expect(source).toMatchObject({
            projectId,
            createdById: principalId,
            kind,
            status: "ready",
            checksum: sha256,
            revision: 1,
            descriptor: { kind, fileAssetId: fileId },
          });
          await expect(tx.importSourceBlob.findMany({
            where: { importSourceId: source.id },
          })).resolves.toEqual([
            expect.objectContaining({
              projectId, blobId, fileAssetId: fileId, position: 0, role: "primary", sha256,
            }),
          ]);
          await expect(service.create(principalId, projectId, idempotencyKey, request))
            .resolves.toEqual(source);
          await expect(tx.importSource.count({ where: { projectId } })).resolves.toBe(1);
          expect(queue.sendInTransaction).not.toHaveBeenCalled();
          // Exercise the same deferred source/manifest guards as a real commit
          // before rolling back the isolated fixture without disabling triggers.
          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
          throw rollbackFixture;
        })).rejects.toBe(rollbackFixture);
      } finally {
        await db.$disconnect();
      }
    },
  );

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
