import { randomUUID } from "node:crypto";
import {
  runtimeExecuteQueue,
  runtimeExecuteQueueOptions,
} from "@workbench/workbench-contracts";
import { PrismaClient } from "@workbench/workbench-db";
import { PgBoss } from "pg-boss";
import { RuntimeExecutionReconciler } from "../src/runs/runtime-execution-reconciler.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("RuntimeExecutionReconciler PostgreSQL admission", () => {
  it("admits one recovery job per Run and does not let retained failures block other Runs", async () => {
    const dbA = new PrismaClient({ datasourceUrl: databaseUrl! });
    const dbB = new PrismaClient({ datasourceUrl: databaseUrl! });
    const bossA = runtimeBoss(databaseUrl!, "runtime-reconciler-test-a");
    const bossB = runtimeBoss(databaseUrl!, "runtime-reconciler-test-b");
    const fixture = await seedFixture(dbA);

    try {
      await Promise.all([bossA.start(), bossB.start()]);
      expect(await bossA.getQueue(runtimeExecuteQueue)).toMatchObject({
        policy: runtimeExecuteQueueOptions.policy,
      });

      const reconcilerA = new RuntimeExecutionReconciler(dbA, bossA, 10, 60_000);
      const reconcilerB = new RuntimeExecutionReconciler(dbB, bossB, 10, 60_000);
      await reconcileConcurrently(reconcilerA, reconcilerB, fixture.firstRunId);
      await reconcilerA.reconcileRun(fixture.firstRunId);

      let firstJobs = await bossA.findJobs(runtimeExecuteQueue, { key: fixture.firstRunId });
      expect(firstJobs.map((job) => job.state)).toEqual(["created"]);

      await setQueueJobState(dbA, firstJobs[0]!.id, "active");
      await reconcileConcurrently(reconcilerA, reconcilerB, fixture.firstRunId);
      firstJobs = await bossA.findJobs(runtimeExecuteQueue, { key: fixture.firstRunId });
      expect(firstJobs.map((job) => job.state)).toEqual(["active"]);

      await setQueueJobState(dbA, firstJobs[0]!.id, "failed");
      await reconcileConcurrently(reconcilerA, reconcilerB, fixture.firstRunId);
      await reconcileConcurrently(reconcilerA, reconcilerB, fixture.firstRunId);
      firstJobs = await bossA.findJobs(runtimeExecuteQueue, { key: fixture.firstRunId });
      expect(firstJobs.map((job) => job.state).sort()).toEqual(["created", "failed"]);

      await createSecondRun(dbA, fixture);
      await reconcileConcurrently(reconcilerA, reconcilerB, fixture.secondRunId);
      await prioritizeRecoveryJobs(dbA, [fixture.firstRunId, fixture.secondRunId]);
      const fetched = await bossA.fetch<{ runId: string }>(runtimeExecuteQueue, {
        batchSize: 2,
        includeMetadata: true,
      });
      expect(fetched.map((job) => job.data.runId).sort()).toEqual([
        fixture.firstRunId,
        fixture.secondRunId,
      ].sort());
    } finally {
      await deleteQueueJobs(bossA, [fixture.firstRunId, fixture.secondRunId]);
      await dbA.workspace.delete({ where: { id: fixture.workspaceId } }).catch(() => undefined);
      await Promise.all([
        bossA.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined),
        bossB.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined),
      ]);
      await Promise.all([dbA.$disconnect(), dbB.$disconnect()]);
    }
  }, 120_000);
});

function runtimeBoss(connectionString: string, applicationName: string) {
  const url = new URL(connectionString);
  url.searchParams.delete("schema");
  return new PgBoss({
    connectionString: url.toString(),
    schema: "workbench_jobs",
    application_name: applicationName,
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
    useListenNotify: false,
  });
}

async function reconcileConcurrently(
  first: RuntimeExecutionReconciler,
  second: RuntimeExecutionReconciler,
  runId: string,
) {
  await Promise.all(Array.from({ length: 12 }, (_, index) => (
    index % 2 === 0 ? first : second
  ).reconcileRun(runId)));
}

async function seedFixture(db: PrismaClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const principalId = `principal_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const projectId = `project_${suffix}`;
  const firstThreadId = `thread_a_${suffix}`;
  const secondThreadId = `thread_b_${suffix}`;
  const firstRunId = `run_a_${suffix}`;
  const secondRunId = `run_b_${suffix}`;

  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: { id: principalId, issuer: `runtime-reconciler-${suffix}`, subject: principalId },
    });
    await tx.workspace.create({
      data: {
        id: workspaceId,
        slug: `runtime-reconciler-${suffix}`,
        name: "Runtime reconciler PostgreSQL contract",
        createdById: principalId,
      },
    });
    await tx.workspaceMember.create({
      data: { workspaceId, principalId, role: "owner" },
    });
    await tx.project.create({
      data: {
        id: projectId,
        workspaceId,
        createdById: principalId,
        title: "Runtime reconciler PostgreSQL contract",
      },
    });
    await tx.projectMember.create({
      data: { projectId, workspaceId, principalId, role: "owner" },
    });
    await tx.thread.createMany({
      data: [firstThreadId, secondThreadId].map((id) => ({
        id,
        projectId,
        createdById: principalId,
        title: id === firstThreadId ? "First recovery" : "Second recovery",
      })),
    });
    await tx.run.create({
      data: runtimeRun({
        id: firstRunId,
        projectId,
        threadId: firstThreadId,
        principalId,
        suffix,
      }),
    });
  });

  return {
    suffix,
    principalId,
    workspaceId,
    projectId,
    firstThreadId,
    secondThreadId,
    firstRunId,
    secondRunId,
  };
}

async function createSecondRun(db: PrismaClient, fixture: Awaited<ReturnType<typeof seedFixture>>) {
  await db.run.create({
    data: runtimeRun({
      id: fixture.secondRunId,
      projectId: fixture.projectId,
      threadId: fixture.secondThreadId,
      principalId: fixture.principalId,
      suffix: `${fixture.suffix}_second`,
    }),
  });
}

function runtimeRun(input: {
  id: string;
  projectId: string;
  threadId: string;
  principalId: string;
  suffix: string;
}) {
  return {
    id: input.id,
    projectId: input.projectId,
    threadId: input.threadId,
    createdById: input.principalId,
    idempotencyKey: `runtime-reconciler-${input.suffix}`,
    requestHash: "a".repeat(64),
    requestId: `request_${input.suffix}`,
    request: {
      prompt: "Recover this Run",
      modelId: "quality",
      workflow: "generate",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      artifactTargets: [],
      requestedArtifactKinds: [],
    },
    status: "running" as const,
    modelId: "quality",
    traceId: `trace_${input.suffix}`,
    attempt: 1,
    startedAt: new Date(),
  };
}

async function setQueueJobState(db: PrismaClient, jobId: string, state: "active" | "failed") {
  if (state === "active") {
    await db.$executeRaw`
      UPDATE "workbench_jobs"."job_common"
      SET "state" = 'active', "started_on" = clock_timestamp(), "heartbeat_on" = clock_timestamp()
      WHERE "name" = ${runtimeExecuteQueue} AND "id" = ${jobId}::uuid
    `;
    return;
  }
  await db.$executeRaw`
    UPDATE "workbench_jobs"."job_common"
    SET "state" = 'failed', "retry_limit" = 0,
        "completed_on" = clock_timestamp(), "heartbeat_on" = NULL
    WHERE "name" = ${runtimeExecuteQueue} AND "id" = ${jobId}::uuid
  `;
}

async function prioritizeRecoveryJobs(db: PrismaClient, runIds: string[]) {
  await db.$executeRaw`
    UPDATE "workbench_jobs"."job_common"
    SET "priority" = 1000
    WHERE "name" = ${runtimeExecuteQueue}
      AND "singleton_key" = ANY(${runIds}::text[])
      AND "state" = 'created'
  `;
}

async function deleteQueueJobs(boss: PgBoss, runIds: string[]) {
  const jobs = (await Promise.all(
    runIds.map((runId) => boss.findJobs(runtimeExecuteQueue, { key: runId }).catch(() => [])),
  )).flat();
  if (jobs.length > 0) {
    await boss.deleteJob(runtimeExecuteQueue, jobs.map((job) => job.id)).catch(() => undefined);
  }
}
