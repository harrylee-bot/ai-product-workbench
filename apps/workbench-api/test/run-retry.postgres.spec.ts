import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  startRunRequestSchema,
} from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { seedReadyKnowledge } from "../../../scripts/test-support/knowledge-fixture.mjs";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Run retry PostgreSQL request invariant", () => {
  it("accepts an exact non-null Canvas snapshot replay and rejects request mutation", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedRetryFixture(db);

    try {
      await expect(db.run.create({
        data: retryData(fixture, "mutated", {
          ...fixture.request,
          canvasSnapshot: null,
        }),
      })).rejects.toThrow(/RUN_RETRY_SOURCE_INVALID/);

      await expect(db.run.create({
        data: retryData(fixture, "exact", fixture.request),
      })).resolves.toMatchObject({
        retryOfRunId: fixture.sourceRunId,
        request: fixture.request,
      });
    } finally {
      await db.run.deleteMany({ where: { retryOfRunId: fixture.sourceRunId } });
      await db.run.deleteMany({ where: { id: fixture.sourceRunId } });
      await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
      await db.principal.deleteMany({ where: { id: fixture.principalId } });
      await db.$disconnect();
    }
  }, 120_000);
});

type RetryFixture = Awaited<ReturnType<typeof seedRetryFixture>>;

async function seedRetryFixture(db: PrismaClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const principalId = `principal_${suffix}`;
  const workspaceId = `workspace_${suffix}`;
  const projectId = `project_${suffix}`;
  const threadId = `thread_${suffix}`;
  const sourceRunId = `run_source_${suffix}`;
  const capturedAt = new Date();
  const reference = {
    boardNodeId: `board_node_${suffix}`,
    artifactId: `artifact_${suffix}`,
    artifactVersionId: `artifact_version_${suffix}`,
    screenId: "screen-home",
  };
  const request = startRunRequestSchema.parse({
    prompt: "Retry the exact Canvas request",
    modelId: "quality",
    workflow: "generate",
    generationIntent: null,
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: ["prototype"],
    canvasSnapshot: {
      protocol: "workbench.canvas-snapshot.v1",
      projectId,
      threadId,
      runId: null,
      boardId: `board_${suffix}`,
      clientSessionId: `canvas-session-${suffix}`,
      projectSessionGeneration: 1,
      boardRevision: 7,
      canvasStateRevision: 3,
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + 60_000).toISOString(),
      viewport: { x: 0, y: 0, zoom: 1 },
      screens: [{
        reference,
        name: "Home",
        route: "/",
        phase: "complete",
        viewport: { width: 390, height: 844 },
      }],
      visibleScreens: [reference],
      selectedScreens: [reference],
    },
  });

  const knowledgeReleaseId = await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: { id: principalId, issuer: `run-retry-${suffix}`, subject: principalId },
    });
    await tx.workspace.create({
      data: {
        id: workspaceId,
        slug: `run-retry-${suffix}`,
        name: "Run retry invariant",
        createdById: principalId,
      },
    });
    await tx.workspaceMember.create({
      data: { workspaceId, principalId, role: "owner" },
    });
    await tx.project.create({
      data: { id: projectId, workspaceId, createdById: principalId, title: "Run retry invariant" },
    });
    await tx.projectMember.create({
      data: { projectId, workspaceId, principalId, role: "owner" },
    });
    await tx.thread.create({
      data: { id: threadId, projectId, createdById: principalId, title: "Run retry invariant" },
    });
    const knowledgeReleaseId = await seedReadyKnowledge(tx);
    await tx.run.create({
      data: {
        knowledgeReleaseId,
        id: sourceRunId,
        projectId,
        threadId,
        createdById: principalId,
        idempotencyKey: `source:${suffix}`,
        requestHash: sha256(request),
        requestId: `request_source_${suffix}`,
        request: request as Prisma.InputJsonValue,
        modelId: request.modelId,
        traceId: `trace_source_${suffix}`,
      },
    });
    const finishedAt = new Date();
    await tx.run.update({
      where: { id: sourceRunId },
      data: {
        status: "failed",
        startedAt: finishedAt,
        finishedAt,
        errorCode: "RUNTIME_UNAVAILABLE",
        errorDetail: "Provider unavailable",
        errorRetryable: true,
      },
    });
    return knowledgeReleaseId;
  });

  return { principalId, workspaceId, projectId, threadId, sourceRunId, request, suffix, knowledgeReleaseId };
}

function retryData(
  fixture: RetryFixture,
  label: string,
  request: RetryFixture["request"],
) {
  return {
    knowledgeReleaseId: fixture.knowledgeReleaseId,
    id: `run_retry_${label}_${fixture.suffix}`,
    projectId: fixture.projectId,
    threadId: fixture.threadId,
    retryOfRunId: fixture.sourceRunId,
    createdById: fixture.principalId,
    idempotencyKey: `retry:${label}:${fixture.suffix}`,
    requestHash: sha256(request),
    requestId: `request_retry_${label}_${fixture.suffix}`,
    request: request as Prisma.InputJsonValue,
    modelId: request.modelId,
    traceId: `trace_retry_${label}_${fixture.suffix}`,
  };
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
