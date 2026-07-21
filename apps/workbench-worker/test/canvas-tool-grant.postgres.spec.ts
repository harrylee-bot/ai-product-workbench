import { randomUUID } from "node:crypto";

import type { CanvasSnapshot } from "@workbench/workbench-contracts";
import { PrismaClient } from "@workbench/workbench-db";

import {
  canonicalCanvasSnapshotSha256,
  PrismaCanvasToolGrantIssuer,
  type CanvasToolGrantScope,
} from "../src/runtime/canvas-tool-grant.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Canvas tool grant PostgreSQL snapshot binding", () => {
  it("serializes concurrent exact replay and rejects a same-attempt snapshot mutation", async () => {
    const left = new PrismaClient({ datasourceUrl: databaseUrl! });
    const right = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedGrantFixture(left);
    const leftIssuer = issuer(left);
    const rightIssuer = issuer(right);

    try {
      const [first, replay] = await Promise.all([
        leftIssuer.issue(fixture.scope),
        rightIssuer.issue(fixture.scope),
      ]);

      expect(first).not.toBeNull();
      expect(replay).toEqual(first);
      const expectedDigest = canonicalCanvasSnapshotSha256(fixture.scope.snapshot!);
      await expect(left.canvasAgentSession.findUniqueOrThrow({
        where: { runtimeAttemptId: fixture.runtimeAttemptId },
        include: { grant: true },
      })).resolves.toMatchObject({
        snapshotSha256: expectedDigest,
        grant: { snapshotSha256: expectedDigest },
      });
      await expect(left.canvasAgentSession.count({
        where: { runtimeAttemptId: fixture.runtimeAttemptId },
      })).resolves.toBe(1);
      await expect(left.canvasToolGrant.count({
        where: { agentSession: { runtimeAttemptId: fixture.runtimeAttemptId } },
      })).resolves.toBe(1);

      const changedSnapshot: CanvasSnapshot = {
        ...fixture.scope.snapshot!,
        viewport: { ...fixture.scope.snapshot!.viewport, zoom: 1.5 },
      };
      await expect(leftIssuer.issue({ ...fixture.scope, snapshot: changedSnapshot }))
        .rejects.toThrow("CANVAS_AGENT_SESSION_SCOPE_CONFLICT");
      await expect(left.canvasAgentSession.findUniqueOrThrow({
        where: { runtimeAttemptId: fixture.runtimeAttemptId },
        include: { grant: true },
      })).resolves.toMatchObject({
        snapshotSha256: expectedDigest,
        viewport: fixture.scope.snapshot!.viewport,
        grant: { snapshotSha256: expectedDigest, revokedAt: null },
      });
    } finally {
      await cleanupGrantFixture(left, fixture);
      await Promise.all([left.$disconnect(), right.$disconnect()]);
    }
  }, 30_000);

  it("rejects persisted session and grant digest tampering at the database boundary", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedGrantFixture(db);

    try {
      const descriptor = await issuer(db).issue(fixture.scope);
      expect(descriptor).not.toBeNull();
      const session = await db.canvasAgentSession.findUniqueOrThrow({
        where: { runtimeAttemptId: fixture.runtimeAttemptId },
        include: { grant: true },
      });
      expect(session.grant).not.toBeNull();

      await expect(db.canvasAgentSession.update({
        where: { id: session.id },
        data: { snapshotSha256: "f".repeat(64) },
      })).rejects.toThrow(/CANVAS_AGENT_SESSION_SNAPSHOT_IMMUTABLE/u);
      await expect(db.canvasToolGrant.update({
        where: { id: session.grant!.id },
        data: { snapshotSha256: "e".repeat(64) },
      })).rejects.toThrow(/CANVAS_TOOL_GRANT_SNAPSHOT_IMMUTABLE/u);

      const expectedDigest = canonicalCanvasSnapshotSha256(fixture.scope.snapshot!);
      await expect(db.canvasAgentSession.findUniqueOrThrow({
        where: { id: session.id },
        include: { grant: true },
      })).resolves.toMatchObject({
        snapshotSha256: expectedDigest,
        grant: { snapshotSha256: expectedDigest },
      });
    } finally {
      await cleanupGrantFixture(db, fixture);
      await db.$disconnect();
    }
  }, 30_000);
});

function issuer(db: PrismaClient) {
  return new PrismaCanvasToolGrantIssuer(db, {
    endpoint: "https://workbench.example.test/api/v1/runtime/canvas/tools/execute",
    visualEndpoint: "https://workbench.example.test/api/v1/runtime/canvas/visuals",
    secret: Buffer.alloc(32, 31),
    maximumTtlSeconds: 300,
  });
}

type GrantFixture = {
  principalId: string;
  workspaceId: string;
  projectId: string;
  boardId: string;
  threadId: string;
  runId: string;
  runtimeAttemptId: string;
  scope: CanvasToolGrantScope;
};

async function seedGrantFixture(db: PrismaClient): Promise<GrantFixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = {
    principalId: `canvas_grant_principal_${suffix}`,
    workspaceId: `canvas_grant_workspace_${suffix}`,
    projectId: `canvas_grant_project_${suffix}`,
    boardId: `canvas_grant_board_${suffix}`,
    threadId: `canvas_grant_thread_${suffix}`,
    runId: `canvas_grant_run_${suffix}`,
    runtimeAttemptId: `canvas_grant_attempt_${suffix}`,
  };
  const bindingId = `canvas_grant_binding_${suffix}`;
  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: {
        id: fixture.principalId,
        issuer: `canvas-grant-${suffix}`,
        subject: fixture.principalId,
      },
    });
    await tx.workspace.create({
      data: {
        id: fixture.workspaceId,
        slug: `canvas-grant-${suffix}`,
        name: "Canvas grant PostgreSQL fixture",
        createdById: fixture.principalId,
      },
    });
    await tx.workspaceMember.create({
      data: {
        workspaceId: fixture.workspaceId,
        principalId: fixture.principalId,
        role: "owner",
      },
    });
    await tx.project.create({
      data: {
        id: fixture.projectId,
        workspaceId: fixture.workspaceId,
        createdById: fixture.principalId,
        title: "Canvas grant PostgreSQL fixture",
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
    await tx.board.create({
      data: {
        id: fixture.boardId,
        projectId: fixture.projectId,
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    await tx.thread.create({
      data: {
        id: fixture.threadId,
        projectId: fixture.projectId,
        createdById: fixture.principalId,
        title: "Canvas grant PostgreSQL fixture",
      },
    });
    await tx.runtimeBinding.create({
      data: {
        id: bindingId,
        threadId: fixture.threadId,
        adapter: "deerflow",
        externalThreadId: `canvas_grant_external_thread_${suffix}`,
        metadata: { workbenchThreadId: fixture.threadId },
      },
    });
    await tx.run.create({
      data: {
        id: fixture.runId,
        projectId: fixture.projectId,
        threadId: fixture.threadId,
        createdById: fixture.principalId,
        idempotencyKey: `canvas-grant-${suffix}`,
        requestHash: "a".repeat(64),
        requestId: `canvas_grant_request_${suffix}`,
        request: {
          prompt: "Inspect the Canvas",
          modelId: "quality",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
          sourceIds: [],
          artifactTargets: [],
          requestedArtifactKinds: [],
        },
        modelId: "quality",
        traceId: `canvas_grant_trace_${suffix}`,
        status: "running",
        attempt: 1,
        startedAt: new Date(),
      },
    });
    await tx.runtimeAttempt.create({
      data: {
        id: fixture.runtimeAttemptId,
        runId: fixture.runId,
        runtimeBindingId: bindingId,
        attempt: 1,
        adapter: "deerflow",
        externalThreadId: `canvas_grant_external_thread_${suffix}`,
      },
    });
  });

  const now = Date.now();
  const snapshot: CanvasSnapshot = {
    protocol: "workbench.canvas-snapshot.v1",
    projectId: fixture.projectId,
    threadId: fixture.threadId,
    runId: fixture.runId,
    boardId: fixture.boardId,
    clientSessionId: `canvas-client-${suffix}`.slice(0, 128),
    projectSessionGeneration: 1,
    boardRevision: 0,
    canvasStateRevision: 1,
    capturedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    screens: [],
    visibleScreens: [],
    selectedScreens: [],
  };
  return {
    ...fixture,
    scope: {
      runId: fixture.runId,
      runtimeAttemptId: fixture.runtimeAttemptId,
      attempt: 1,
      principalId: fixture.principalId,
      projectId: fixture.projectId,
      threadId: fixture.threadId,
      modelId: "quality",
      workflow: "generate",
      artifactTargets: [],
      snapshot,
    },
  };
}

async function cleanupGrantFixture(db: PrismaClient, fixture: GrantFixture) {
  await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await db.principal.deleteMany({ where: { id: fixture.principalId } });
}
