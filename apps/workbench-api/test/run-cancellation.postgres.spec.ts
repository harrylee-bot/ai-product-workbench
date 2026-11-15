import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { hashRequest } from "../src/common/idempotency.js";
import { AccessService } from "../src/modules/access/access.service.js";
import { RunEventStore } from "../src/modules/runs/run-event.store.js";
import { RunsService } from "../src/modules/runs/runs.service.js";

import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Run cancellation PostgreSQL idempotency", () => {
  it("linearizes concurrent duplicates and enforces an immutable scoped receipt", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl! });
    const left = new PrismaClient({ datasourceUrl: databaseUrl! });
    const right = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedFixture(setup);
    const leftQueue = { sendInTransaction: vi.fn().mockResolvedValue("cancel-job-left") };
    const rightQueue = { sendInTransaction: vi.fn().mockResolvedValue("cancel-job-right") };
    const leftService = service(left, leftQueue);
    const rightService = service(right, rightQueue);
    const key = `run-cancel:${fixture.suffix}`;

    try {
      const [first, second] = await Promise.all([
        leftService.cancel(fixture.principalId, fixture.runId, key),
        rightService.cancel(fixture.principalId, fixture.runId, key),
      ]);

      expect(first).toEqual(second);
      expect(first).toMatchObject({ id: fixture.runId, status: "cancelling" });
      expect(leftQueue.sendInTransaction.mock.calls.length + rightQueue.sendInTransaction.mock.calls.length)
        .toBe(1);
      await expect(setup.runEvent.count({
        where: { runId: fixture.runId, type: "run.cancel.requested" },
      })).resolves.toBe(1);

      const receipt = await setup.runCancellationReceipt.findUniqueOrThrow({
        where: {
          principalId_idempotencyKey: {
            principalId: fixture.principalId,
            idempotencyKey: key,
          },
        },
      });
      expect(receipt).toMatchObject({
        runId: fixture.runId,
        requestHash: hashRequest({
          protocol: "workbench.run-cancellation.v1",
          runId: fixture.runId,
        }),
        response: first,
        responseHash: hashRequest(first),
      });

      await setup.run.update({
        where: { id: fixture.runId },
        data: {
          status: "cancelled",
          finishedAt: new Date(),
          cancellationReason: "Cancelled by user",
        },
      });
      await expect(service(setup, { sendInTransaction: vi.fn() }).cancel(
        fixture.principalId,
        fixture.runId,
        key,
      )).resolves.toEqual(first);

      await expect(service(setup, { sendInTransaction: vi.fn() }).cancel(
        fixture.principalId,
        fixture.otherRunId,
        key,
      )).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
      });

      await expect(setup.runCancellationReceipt.update({
        where: { id: receipt.id },
        data: { responseHash: "f".repeat(64) },
      })).rejects.toThrow(/RUN_CANCELLATION_RECEIPT_IMMUTABLE/u);

      await expect(setup.runCancellationReceipt.create({
        data: {
          runId: fixture.otherRunId,
          principalId: fixture.principalId,
          idempotencyKey: `run-cancel-invalid:${fixture.suffix}`,
          requestHash: "a".repeat(64),
          response: { id: fixture.otherRunId, status: "succeeded" },
          responseHash: "b".repeat(64),
        },
      })).rejects.toThrow(/run_cancellation_receipts_response_shape_check/u);
    } finally {
      await Promise.all([left.$disconnect(), right.$disconnect()]);
      await setup.workspace.deleteMany({ where: { id: fixture.workspaceId } });
      await setup.principal.deleteMany({ where: { id: fixture.principalId } });
      await setup.$disconnect();
    }
  }, 120_000);
});

function service(
  db: PrismaClient,
  queue: { sendInTransaction: ReturnType<typeof vi.fn> },
) {
  return new RunsService(
    db as never,
    new AccessService(db as never),
    new RunEventStore(),
    queue as never,
    {} as never,
    {} as never,
  );
}

async function seedFixture(db: PrismaClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const principalId = `principal_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const projectId = `project_${suffix}`;
  const threadId = `thread_${suffix}`;
  const otherThreadId = `thread_other_${suffix}`;
  const runId = `run_${suffix}`;
  const otherRunId = `run_other_${suffix}`;
  const request = {
    prompt: "Build it",
    modelId: "quality",
    workflow: "generate",
    generationIntent: null,
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: [],
    canvasSnapshot: null,
  } as const;

  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: { id: principalId, issuer: `run-cancel-${suffix}`, subject: principalId },
    });
    await tx.workspace.create({
      data: {
        id: workspaceId,
        slug: `run-cancel-${suffix}`,
        name: "Run cancellation idempotency",
        createdById: principalId,
      },
    });
    await tx.workspaceMember.create({
      data: { workspaceId, principalId, role: "owner" },
    });
    await tx.project.create({
      data: { id: projectId, workspaceId, createdById: principalId, title: "Cancel Run" },
    });
    await tx.projectMember.create({
      data: { projectId, workspaceId, principalId, role: "owner" },
    });
    for (const [position, id] of [threadId, otherThreadId].entries()) {
      await tx.thread.create({
        data: { id, projectId, createdById: principalId, title: `Cancel Run ${position + 1}` },
      });
    }
    const knowledgeReleaseId = await seedReadyKnowledge(tx);
    for (const [position, id] of [runId, otherRunId].entries()) {
      await tx.run.create({
        data: {
          knowledgeReleaseId,
          id,
          projectId,
          threadId: position === 0 ? threadId : otherThreadId,
          createdById: principalId,
          idempotencyKey: `run-create:${position}:${suffix}`,
          requestHash: hashRequest(request),
          request: request as Prisma.InputJsonValue,
          requestId: `request_${position}_${suffix}`,
          modelId: request.modelId,
          traceId: `trace_${position}_${suffix}`,
        },
      });
    }
  });

  return { suffix, principalId, workspaceId, runId, otherRunId };
}
