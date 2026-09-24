import { randomUUID } from "node:crypto";
import { PrismaClient } from "@workbench/workbench-db";
import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("RunEvent PostgreSQL append-only contract", () => {
  it("rejects direct mutation and ambiguous source ids while preserving Run cascade deletion", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(db);
    const event = await db.runEvent.create({
      data: {
        id: `event_${fixture.suffix}`,
        runId: fixture.runId,
        sourceId: "deerflow:runtime-event-1",
        sequence: 1,
        type: "activity.changed",
        payload: { activityId: "activity-1" },
        traceId: `trace_${fixture.suffix}`,
      },
    });

    try {
      await expect(db.runEvent.update({
        where: { id: event.id },
        data: { payload: { activityId: "tampered" } },
      })).rejects.toThrow(/RUN_EVENT_APPEND_ONLY/u);

      await expect(db.runEvent.delete({ where: { id: event.id } }))
        .rejects.toThrow(/RUN_EVENT_APPEND_ONLY/u);

      await expect(db.$executeRaw`TRUNCATE TABLE "run_events" CASCADE`)
        .rejects.toThrow(/RUN_EVENT_APPEND_ONLY/u);
      await expect(db.runEvent.count({ where: { id: event.id } })).resolves.toBe(1);

      for (const sourceId of ["runtime event with spaces", "runtime/event", ""]) {
        await expect(db.runEvent.create({
          data: {
            id: `invalid_${fixture.suffix}_${sourceId.length}`,
            runId: fixture.runId,
            sourceId,
            sequence: 2 + sourceId.length,
            type: "activity.changed",
            payload: { activityId: sourceId },
            traceId: `trace_${fixture.suffix}`,
          },
        })).rejects.toThrow(/run_events_source_id_format_check/u);
      }

      await expect(db.run.delete({ where: { id: fixture.runId } })).resolves.toMatchObject({
        id: fixture.runId,
      });
      await expect(db.runEvent.count({ where: { id: event.id } })).resolves.toBe(0);
    } finally {
      await db.workspace.delete({ where: { id: fixture.workspaceId } }).catch(() => undefined);
      await db.$disconnect();
    }
  }, 120_000);
});

async function seedFixture(db: PrismaClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const principalId = `principal_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const projectId = `project_${suffix}`;
  const threadId = `thread_${suffix}`;
  const runId = `run_${suffix}`;

  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: { id: principalId, issuer: `run-event-${suffix}`, subject: principalId },
    });
    await tx.workspace.create({
      data: {
        id: workspaceId,
        slug: `run-event-${suffix}`,
        name: "RunEvent append-only contract",
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
        title: "RunEvent append-only contract",
      },
    });
    await tx.projectMember.create({
      data: { projectId, workspaceId, principalId, role: "owner" },
    });
    await tx.thread.create({
      data: { id: threadId, projectId, createdById: principalId, title: "RunEvent" },
    });
    await tx.run.create({
      data: {
        knowledgeReleaseId: await seedReadyKnowledge(tx),
        id: runId,
        projectId,
        threadId,
        createdById: principalId,
        idempotencyKey: `run-event-${suffix}`,
        requestHash: "a".repeat(64),
        requestId: `request_${suffix}`,
        request: {
          prompt: "RunEvent contract",
          modelId: "quality",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
          sourceIds: [],
          artifactTargets: [],
          requestedArtifactKinds: [],
        },
        modelId: "quality",
        traceId: `trace_${suffix}`,
      },
    });
  });

  return { suffix, workspaceId, runId };
}
