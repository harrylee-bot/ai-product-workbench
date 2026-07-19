import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import {
  canvasAgentToolInvocationSchema,
  canvasAgentToolRequestSchema,
  canvasClientCommandAckSchema,
  canvasClientCommandSchema,
  canvasClientStateSyncRequestSchema,
  canvasSnapshotSchema,
  prototypeDocumentSchema,
  type CanvasAgentToolInvocation,
} from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import {
  canvasToolCapabilityGrantPayloadSha256,
  createCanvasToolCapabilityGrant,
  type CanvasToolCapabilityGrantPayload,
} from "@workbench/workbench-canvas-tools";
import { afterAll, describe, expect, it } from "vitest";
import { CanvasAgentConfig } from "../src/modules/canvas-agent/canvas-agent.config.js";
import { CanvasAgentExpiryReconciler } from "../src/modules/canvas-agent/canvas-agent-expiry-reconciler.js";
import {
  CanvasAgentService,
  canonicalCanvasStateSha256,
} from "../src/modules/canvas-agent/canvas-agent.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const secret = Buffer.alloc(32, 29);
const declarationSha256 = "a".repeat(64);
const initialViewport = { x: 0, y: 0, zoom: 1 };
const synchronizedViewport = { x: 24, y: 36, zoom: 1.25 };
const admin = databaseUrl
  ? new PrismaClient({ datasourceUrl: connectionUrl("canvas_concurrency_admin") })
  : null;

describeWithPostgres("Canvas Agent PostgreSQL linearization", () => {
  it("fences a stale authorization when revocation commits before invocation reservation", async () => {
    const fixture = await createFixture();
    const executorName = fixture.applicationName("execute");
    const executor = fixture.client(executorName);
    const revoker = fixture.client(fixture.applicationName("revoke"));
    const observer = fixture.client(fixture.applicationName("observer"));
    const held = await holdGrantRevocation(revoker, fixture.grantId);

    try {
      const execution = settle(fixture.service(executor).execute(
        `Bearer ${fixture.token}`,
        "execute-revoke-race",
        invocation("call_execute_revoke"),
      ));
      await waitForBlockedBy(observer, executorName, held.pid);

      held.release.resolve();
      await held.transaction;
      const result = await execution;

      expect(result.ok).toBe(false);
      expect(problemCode(result)).toBe("CANVAS_TOOL_SCOPE_INVALID");
      expect(await admin!.canvasToolInvocation.count({
        where: { agentSessionId: fixture.sessionId },
      })).toBe(0);
      expect(await admin!.canvasClientCommand.count({
        where: { agentSessionId: fixture.sessionId },
      })).toBe(0);
    } finally {
      held.release.resolve();
      await held.transaction.catch(() => undefined);
      await fixture.dispose();
    }
  }, 30_000);

  it("prevents command issuance after a reserved invocation loses its grant", async () => {
    const fixture = await createFixture();
    const issuerName = fixture.applicationName("issue");
    const issuer = fixture.client(issuerName);
    const revoker = fixture.client(fixture.applicationName("revoke"));
    const observer = fixture.client(fixture.applicationName("observer"));
    const service = fixture.service(issuer);
    const internals = service as unknown as CanvasServiceInternals;
    const wire = invocation("call_issue_revoke");
    const normalized = await internals.normalizeInvocationRequest(fixture.grant, wire);
    const scope = await internals.authorizeScope(fixture.grant, normalized);
    const requestHash = internals.invocationRequestHash(normalized);
    const reservation = await internals.reserveInvocation(
      scope,
      normalized,
      requestHash,
      "issue-revoke-race",
    );
    expect(reservation.kind).toBe("new");
    if (reservation.kind !== "new") throw new Error("CANVAS_TEST_RESERVATION_REPLAYED");
    const held = await holdGrantRevocation(revoker, fixture.grantId);

    try {
      const issuance = settle(internals.issueClientCommand(
        scope,
        reservation.invocation,
        normalized,
      ));
      await waitForBlockedBy(observer, issuerName, held.pid);

      held.release.resolve();
      await held.transaction;
      const result = await issuance;

      expect(result.ok).toBe(false);
      expect(await admin!.canvasClientCommand.count({
        where: { agentSessionId: fixture.sessionId },
      })).toBe(0);
      await expect(admin!.canvasToolInvocation.findFirstOrThrow({
        where: { agentSessionId: fixture.sessionId },
        select: { status: true },
      })).resolves.toEqual({ status: "in_flight" });
    } finally {
      held.release.resolve();
      await held.transaction.catch(() => undefined);
      await fixture.dispose();
    }
  }, 30_000);

  it("does not list a pending command after its grant revocation linearizes", async () => {
    const fixture = await createFixture();
    const issuer = fixture.client(fixture.applicationName("issuer"));
    const listName = fixture.applicationName("list");
    const listClient = fixture.client(listName);
    const revoker = fixture.client(fixture.applicationName("revoke"));
    const observer = fixture.client(fixture.applicationName("observer"));
    const issued = await fixture.issueCommand(issuer, "call_list_revoke");
    const held = await holdGrantRevocation(revoker, fixture.grantId);

    try {
      const listing = settle(fixture.service(listClient).listCommands(
        fixture.principalId,
        fixture.projectId,
        fixture.clientSessionId,
        fixture.projectSessionGeneration,
        undefined,
        100,
      ));
      await waitForBlockedBy(observer, listName, held.pid);

      held.release.resolve();
      await held.transaction;
      const result = await listing;

      expect(result).toEqual({ ok: true, value: { items: [], nextCursor: null } });
      await expect(admin!.canvasClientCommand.findUniqueOrThrow({
        where: { id: issued.command.commandId },
        select: { status: true },
      })).resolves.toEqual({ status: "pending" });
    } finally {
      held.release.resolve();
      await held.transaction.catch(() => undefined);
      await fixture.dispose();
    }
  }, 30_000);
});

describeWithPostgres("Canvas ACK PostgreSQL state binding", () => {
  it("rejects divergent same-revision state and persists the latest canonical digest on ACK", async () => {
    const fixture = await createFixture();
    const client = fixture.client(fixture.applicationName("ack_digest"));
    const service = fixture.service(client);

    try {
      const issued = await fixture.issueCommand(client, "call_ack_digest");
      await expect(service.synchronizeClientState(
        fixture.principalId,
        fixture.projectId,
        fixture.state(1, synchronizedViewport),
      )).rejects.toMatchObject({ status: 412 });
      await expect(admin!.canvasAgentSession.findUniqueOrThrow({
        where: { id: fixture.sessionId },
        select: { canvasStateRevision: true, viewport: true },
      })).resolves.toEqual({ canvasStateRevision: 1, viewport: initialViewport });

      await expect(service.synchronizeClientState(
        fixture.principalId,
        fixture.projectId,
        fixture.state(2, synchronizedViewport),
      )).resolves.toMatchObject({ activeSession: true, canvasStateRevision: 2 });
      const ack = fixture.ack(issued.command, 2, synchronizedViewport);
      await expect(service.acknowledge(
        fixture.principalId,
        fixture.projectId,
        issued.command.commandId,
        ack,
      )).resolves.toEqual(ack);

      const expectedDigest = canonicalCanvasStateSha256(
        fixture.snapshot(2, synchronizedViewport),
      );
      const command = await admin!.canvasClientCommand.findUniqueOrThrow({
        where: { id: issued.command.commandId },
        select: {
          status: true,
          expectedCanvasStateSha256: true,
          acknowledgedCanvasStateSha256: true,
          invocation: {
            select: {
              status: true,
              canvasStateSha256After: true,
              canvasStateRevisionAfter: true,
            },
          },
        },
      });
      expect(command).toMatchObject({
        status: "acknowledged",
        acknowledgedCanvasStateSha256: expectedDigest,
        invocation: {
          status: "succeeded",
          canvasStateSha256After: expectedDigest,
          canvasStateRevisionAfter: 2,
        },
      });
      expect(command.expectedCanvasStateSha256).not.toBe(expectedDigest);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("orders state synchronization before a stale ACK under real row-lock contention", async () => {
    const fixture = await createFixture();
    const issuer = fixture.client(fixture.applicationName("issuer"));
    const syncName = fixture.applicationName("sync");
    const ackName = fixture.applicationName("ack");
    const syncClient = fixture.client(syncName);
    const ackClient = fixture.client(ackName);
    const boardLocker = fixture.client(fixture.applicationName("board_lock"));
    const observer = fixture.client(fixture.applicationName("observer"));
    const issued = await fixture.issueCommand(issuer, "call_state_ack_race");
    const heldBoard = await holdBoardLock(boardLocker, fixture.boardId);

    try {
      const synchronization = settle(fixture.service(syncClient).synchronizeClientState(
        fixture.principalId,
        fixture.projectId,
        fixture.state(2, synchronizedViewport),
      ));
      const syncPid = await waitForBlockedBy(observer, syncName, heldBoard.pid);

      const staleAck = fixture.ack(issued.command, 1, initialViewport);
      const acknowledgement = settle(fixture.service(ackClient).acknowledge(
        fixture.principalId,
        fixture.projectId,
        issued.command.commandId,
        staleAck,
      ));
      await waitForBlockedBy(observer, ackName, syncPid);

      heldBoard.release.resolve();
      expect(await synchronization).toMatchObject({ ok: true });
      const ackResult = await acknowledgement;
      expect(ackResult.ok).toBe(false);
      expect(problemCode(ackResult)).toBe("CANVAS_CLIENT_COMMAND_CONFLICT");
      await expect(admin!.canvasClientCommand.findUniqueOrThrow({
        where: { id: issued.command.commandId },
        select: {
          status: true,
          acknowledgedCanvasStateSha256: true,
          invocation: { select: { status: true, canvasStateSha256After: true } },
        },
      })).resolves.toEqual({
        status: "pending",
        acknowledgedCanvasStateSha256: null,
        invocation: { status: "waiting_client", canvasStateSha256After: null },
      });
    } finally {
      heldBoard.release.resolve();
      await heldBoard.transaction.catch(() => undefined);
      await fixture.dispose();
    }
  }, 30_000);
});

describeWithPostgres("Canvas expiry PostgreSQL reconciliation", () => {
  it("lets two independent reconcilers claim distinct expired command families", async () => {
    const left = await createFixture();
    const right = await createFixture();

    try {
      const leftCommand = await left.seedPendingCommand({ expired: true });
      const rightCommand = await right.seedPendingCommand({ expired: true });
      const leftReconciler = new CanvasAgentExpiryReconciler(
        left.client(left.applicationName("reconciler")) as never,
        reconcilerConfig(1) as never,
      );
      const rightReconciler = new CanvasAgentExpiryReconciler(
        right.client(right.applicationName("reconciler")) as never,
        reconcilerConfig(1) as never,
      );

      const results = await Promise.all([
        leftReconciler.runOnce(),
        rightReconciler.runOnce(),
      ]);
      expect(results.reduce((sum, result) => sum + result.expiredCommands, 0)).toBe(2);
      expect(results.reduce((sum, result) => sum + result.expiredSessions, 0)).toBe(0);
      const commands = await admin!.canvasClientCommand.findMany({
        where: { id: { in: [leftCommand.commandId, rightCommand.commandId] } },
        orderBy: { id: "asc" },
        select: {
          status: true,
          invocation: {
            select: { status: true, failureCode: true, canvasStateSha256After: true },
          },
        },
      });
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command).toMatchObject({
          status: "expired",
          invocation: {
            status: "failed",
            failureCode: "COMMAND_EXPIRED",
          },
        });
        expect(command.invocation.canvasStateSha256After).toMatch(/^[0-9a-f]{64}$/u);
      }
    } finally {
      await Promise.all([left.dispose(), right.dispose()]);
    }
  }, 30_000);

  it("rejects a late ACK after the reconciler expires its session family", async () => {
    const fixture = await createFixture({ expiredSession: true });

    try {
      const seeded = await fixture.seedPendingCommand({
        expired: true,
        expiresAt: fixture.expiresAt,
      });
      const reconciler = new CanvasAgentExpiryReconciler(
        fixture.client(fixture.applicationName("reconciler")) as never,
        reconcilerConfig(10) as never,
      );
      await expect(reconciler.runOnce()).resolves.toEqual({
        expiredSessions: 1,
        expiredCommands: 0,
        expiredInvocationLeases: 0,
      });
      const ack = fixture.ack(seeded.command, 1, initialViewport);
      await expect(fixture.service(
        fixture.client(fixture.applicationName("late_ack")),
      ).acknowledge(
        fixture.principalId,
        fixture.projectId,
        seeded.commandId,
        ack,
      )).rejects.toMatchObject({ status: 409 });
      await expect(admin!.canvasClientCommand.findUniqueOrThrow({
        where: { id: seeded.commandId },
        select: {
          status: true,
          invocation: { select: { status: true, failureCode: true } },
          agentSession: { select: { status: true } },
        },
      })).resolves.toEqual({
        status: "cancelled",
        invocation: { status: "failed", failureCode: "SESSION_EXPIRED" },
        agentSession: { status: "expired" },
      });
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});

describeWithPostgres("Canvas revoke and ACK PostgreSQL races", () => {
  it("rejects ACK when revocation owns the grant lock first", async () => {
    const fixture = await createFixture();
    const issuer = fixture.client(fixture.applicationName("issuer"));
    const ackName = fixture.applicationName("ack");
    const ackClient = fixture.client(ackName);
    const revoker = fixture.client(fixture.applicationName("revoke"));
    const observer = fixture.client(fixture.applicationName("observer"));
    const issued = await fixture.issueCommand(issuer, "call_revoke_first");
    await fixture.service(issuer).synchronizeClientState(
      fixture.principalId,
      fixture.projectId,
      fixture.state(2, synchronizedViewport),
    );
    const held = await holdGrantRevocation(revoker, fixture.grantId);

    try {
      const acknowledgement = settle(fixture.service(ackClient).acknowledge(
        fixture.principalId,
        fixture.projectId,
        issued.command.commandId,
        fixture.ack(issued.command, 2, synchronizedViewport),
      ));
      await waitForBlockedBy(observer, ackName, held.pid);

      held.release.resolve();
      await held.transaction;
      const result = await acknowledgement;
      expect(result.ok).toBe(false);
      expect(problemCode(result)).toBe("CANVAS_CLIENT_COMMAND_CONFLICT");
      await expect(admin!.canvasClientCommand.findUniqueOrThrow({
        where: { id: issued.command.commandId },
        select: { status: true, invocation: { select: { status: true } } },
      })).resolves.toEqual({ status: "pending", invocation: { status: "waiting_client" } });
    } finally {
      held.release.resolve();
      await held.transaction.catch(() => undefined);
      await fixture.dispose();
    }
  }, 30_000);

  it("commits ACK before a revocation that waits behind its grant lock", async () => {
    const fixture = await createFixture();
    const issuer = fixture.client(fixture.applicationName("issuer"));
    const ackName = fixture.applicationName("ack");
    const revokeName = fixture.applicationName("revoke");
    const ackClient = fixture.client(ackName);
    const revoker = fixture.client(revokeName);
    const boardLocker = fixture.client(fixture.applicationName("board_lock"));
    const observer = fixture.client(fixture.applicationName("observer"));
    const issued = await fixture.issueCommand(issuer, "call_ack_first");
    await fixture.service(issuer).synchronizeClientState(
      fixture.principalId,
      fixture.projectId,
      fixture.state(2, synchronizedViewport),
    );
    const heldBoard = await holdBoardLock(boardLocker, fixture.boardId);
    let revocation: Promise<void> | null = null;

    try {
      const acknowledgement = settle(fixture.service(ackClient).acknowledge(
        fixture.principalId,
        fixture.projectId,
        issued.command.commandId,
        fixture.ack(issued.command, 2, synchronizedViewport),
      ));
      const ackPid = await waitForBlockedBy(observer, ackName, heldBoard.pid);
      const revokeStarted = deferred<number>();
      revocation = revoker.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
          SELECT pg_backend_pid() AS "pid"
        `);
        revokeStarted.resolve(pid);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "canvas_tool_grants"
          SET "revoked_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${fixture.grantId}::uuid
        `);
      });
      const revokePid = await revokeStarted.promise;
      await waitForBlockedBy(observer, revokeName, ackPid, revokePid);

      heldBoard.release.resolve();
      const ackResult = await acknowledgement;
      expect(ackResult).toMatchObject({ ok: true });
      await revocation;
      await expect(admin!.canvasClientCommand.findUniqueOrThrow({
        where: { id: issued.command.commandId },
        select: {
          status: true,
          acknowledgedCanvasStateSha256: true,
          invocation: { select: { status: true, canvasStateSha256After: true } },
          agentSession: { select: { grant: { select: { revokedAt: true } } } },
        },
      })).resolves.toMatchObject({
        status: "acknowledged",
        acknowledgedCanvasStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        invocation: {
          status: "succeeded",
          canvasStateSha256After: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
        agentSession: { grant: { revokedAt: expect.any(Date) } },
      });
    } finally {
      heldBoard.release.resolve();
      await heldBoard.transaction.catch(() => undefined);
      await revocation?.catch(() => undefined);
      await fixture.dispose();
    }
  }, 30_000);
});

afterAll(async () => {
  await admin?.$disconnect();
});

type CanvasServiceInternals = {
  normalizeInvocationRequest: (
    grant: CanvasToolCapabilityGrantPayload,
    request: CanvasAgentToolInvocation,
  ) => Promise<any>;
  authorizeScope: (grant: CanvasToolCapabilityGrantPayload, request: any) => Promise<any>;
  invocationRequestHash: (request: any) => string;
  reserveInvocation: (
    scope: any,
    request: any,
    requestHash: string,
    idempotencyKey: string | undefined,
  ) => Promise<{ kind: "new"; invocation: any } | { kind: "replay"; result: any }>;
  issueClientCommand: (scope: any, invocation: any, request: any) => Promise<any>;
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Viewport = { x: number; y: number; zoom: number };

async function createFixture(options: { expiredSession?: boolean } = {}) {
  if (!admin) throw new Error("WORKBENCH_TEST_DATABASE_URL is required");
  const tag = `c${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const clients: PrismaClient[] = [];
  const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const issuedAt = new Date(now.getTime() - (options.expiredSession ? 30_000 : 1_000));
  const expiresAt = new Date(now.getTime() + (options.expiredSession ? -10_000 : 240_000));
  const principal = await admin.principal.create({
    data: { issuer: `canvas-concurrency-${tag}`, subject: `principal-${tag}` },
  });
  const workspace = await admin.workspace.create({
    data: {
      slug: `canvas-concurrency-${tag}`,
      name: "Canvas concurrency",
      createdById: principal.id,
    },
  });
  await admin.workspaceMember.create({
    data: { workspaceId: workspace.id, principalId: principal.id, role: "owner" },
  });
  const project = await admin.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        workspaceId: workspace.id,
        createdById: principal.id,
        title: "Canvas concurrency",
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
  const thread = await admin.thread.create({
    data: { projectId: project.id, createdById: principal.id, title: "Canvas concurrency" },
  });
  const run = await admin.run.create({
    data: {
      projectId: project.id,
      threadId: thread.id,
      createdById: principal.id,
      idempotencyKey: `run-${tag}`,
      requestHash: "b".repeat(64),
      requestId: `request-${tag}`,
      request: {
        prompt: "Canvas concurrency",
        modelId: "test-model",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: [],
      },
      status: "running",
      phase: "generating",
      modelId: "test-model",
      traceId: `trace-${tag}`,
    },
  });
  const binding = await admin.runtimeBinding.create({
    data: {
      threadId: thread.id,
      adapter: "deerflow",
      externalThreadId: `external-thread-${tag}`,
      metadata: {},
    },
  });
  const attempt = await admin.runtimeAttempt.create({
    data: {
      runId: run.id,
      runtimeBindingId: binding.id,
      attempt: 1,
      adapter: "deerflow",
      externalThreadId: binding.externalThreadId,
    },
  });
  await admin.runtimeAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "submitting",
      startedAt: new Date(),
      providerIdempotencyKey: `wbrt:${createHash("sha256").update(attempt.id).digest("hex")}`,
    },
  });
  await admin.runtimeAttempt.update({
    where: { id: attempt.id },
    data: {
      externalRunId: `external-run-${tag}`,
      status: "running",
    },
  });
  let board = await admin.board.create({
    data: { projectId: project.id, viewport: initialViewport },
  });
  const artifact = await admin.artifact.create({
    data: { projectId: project.id, kind: "prototype", title: "Canvas screen" },
  });
  const screenId = `screen-${tag}`;
  const artifactVersion = await admin.artifactVersion.create({
    data: {
      artifactId: artifact.id,
      projectId: project.id,
      version: 1,
      schemaVersion: 1,
      status: "ready",
      content: prototypeDocument(artifact.id, screenId) as unknown as Prisma.InputJsonValue,
      checksum: "c".repeat(64),
      citations: [],
    },
  });
  await admin.artifact.update({
    where: { id: artifact.id },
    data: { currentVersionId: artifactVersion.id },
  });
  const boardNodeId = `node-${tag}`;
  await admin.boardNode.create({
    data: {
      boardId: board.id,
      projectId: project.id,
      nodeKey: boardNodeId,
      parentNodeKey: null,
      sortOrder: 0,
      kind: "artifact",
      position: { x: 0, y: 0 },
      size: { width: 390, height: 844 },
      artifactId: artifact.id,
      artifactVersionId: artifactVersion.id,
      data: {
        protocol: "workbench.board-node.v1",
        nodeType: "artifact",
        title: "Home",
        artifactKind: "prototype",
        screenId,
        route: "/",
      },
    },
  });
  board = await admin.board.findUniqueOrThrow({ where: { id: board.id } });
  const reference = {
    boardNodeId,
    artifactId: artifact.id,
    artifactVersionId: artifactVersion.id,
    screenId,
  };
  const snapshot = (canvasStateRevision: number, viewport: Viewport) => canvasSnapshotSchema.parse({
    protocol: "workbench.canvas-snapshot.v1",
    projectId: project.id,
    threadId: thread.id,
    runId: run.id,
    boardId: board.id,
    clientSessionId: `client_${tag}`,
    projectSessionGeneration: 1,
    boardRevision: board.revision,
    canvasStateRevision,
    capturedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    viewport,
    screens: [{
      reference,
      name: "Home",
      route: "/",
      phase: "complete",
      viewport: { width: 390, height: 844 },
    }],
    visibleScreens: [reference],
    selectedScreens: [reference],
  });
  const snapshotSha256 = canonicalCanvasStateSha256(snapshot(1, initialViewport));
  const session = await admin.canvasAgentSession.create({
    data: {
      id: `session_${tag}`,
      runtimeAttemptId: attempt.id,
      runId: run.id,
      projectId: project.id,
      threadId: thread.id,
      principalId: principal.id,
      boardId: board.id,
      clientSessionId: `client_${tag}`,
      projectSessionGeneration: 1,
      profile: "edit",
      declaredTools: ["navigate_canvas"],
      declarationHash: declarationSha256,
      snapshotSha256,
      boardRevision: board.revision,
      canvasStateRevision: 1,
      selectedNodeIds: [boardNodeId],
      visibleNodeIds: [boardNodeId],
      viewport: initialViewport,
      expiresAt,
      createdAt: issuedAt,
    },
  });
  const grant: CanvasToolCapabilityGrantPayload = {
    grantId: randomUUID(),
    principalId: principal.id,
    projectId: project.id,
    threadId: thread.id,
    runId: run.id,
    runtimeAttemptId: attempt.id,
    agentSessionId: session.id,
    boardId: board.id,
    declarationSha256,
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
  };
  await admin.canvasToolGrant.create({
    data: {
      id: grant.grantId,
      agentSessionId: session.id,
      payloadSha256: canvasToolCapabilityGrantPayloadSha256(grant),
      declarationHash: declarationSha256,
      snapshotSha256,
      issuedAt,
      expiresAt,
    },
  });
  const token = createCanvasToolCapabilityGrant(grant, secret, {
    now: issuedAt,
    maximumTtlSeconds: 300,
  });
  const applicationName = (role: string) => `canvas_${role}_${tag}`.slice(0, 63);
  const client = (name: string) => {
    const value = new PrismaClient({ datasourceUrl: connectionUrl(name) });
    clients.push(value);
    return value;
  };
  const service = (db: PrismaClient) => new CanvasAgentService(
    db as never,
    canvasConfig(),
    rejectingVisualStorage() as never,
  );
  const state = (canvasStateRevision: number, viewport: Viewport) => (
    canvasClientStateSyncRequestSchema.parse({
      protocol: "workbench.canvas-client-state.v1",
      clientSessionId: session.clientSessionId,
      projectSessionGeneration: session.projectSessionGeneration,
      boardId: board.id,
      boardRevision: board.revision,
      canvasStateRevision,
      viewport,
      visibleScreens: [reference],
      selectedScreens: [reference],
    })
  );
  const ack = (
    command: ReturnType<typeof canvasClientCommandSchema.parse>,
    canvasStateRevision: number,
    viewport: Viewport,
  ) => canvasClientCommandAckSchema.parse({
    protocol: "workbench.canvas-client-command-ack.v1",
    commandId: command.commandId,
    agentSessionId: command.agentSessionId,
    toolCallId: command.toolCallId,
    requestId: command.requestId,
    toolName: command.toolName,
    projectId: command.projectId,
    threadId: command.threadId,
    runId: command.runId,
    boardId: command.boardId,
    clientSessionId: command.clientSessionId,
    projectSessionGeneration: command.projectSessionGeneration,
    boardRevision: command.boardRevision,
    canvasStateRevision,
    acknowledgedAt: new Date().toISOString(),
    status: "applied",
    result: { viewport },
    failure: null,
  });
  const issueCommand = async (db: PrismaClient, toolCallId: string) => {
    const result = await service(db).execute(
      `Bearer ${token}`,
      `idem-${toolCallId}`,
      invocation(toolCallId),
    );
    if (result.status !== "waiting_client" || !result.clientCommandId) {
      throw new Error(`CANVAS_TEST_COMMAND_NOT_ISSUED:${result.status}`);
    }
    const row = await admin.canvasClientCommand.findUniqueOrThrow({
      where: { id: result.clientCommandId },
      select: { command: true },
    });
    return {
      result,
      command: canvasClientCommandSchema.parse(row.command),
    };
  };
  const seedPendingCommand = async ({
    expired,
    expiresAt: requestedExpiresAt,
  }: {
    expired: boolean;
    expiresAt?: Date;
  }) => {
    const issued = new Date(now.getTime() - 30_000);
    const commandExpiresAt = requestedExpiresAt
      ?? new Date(now.getTime() + (expired ? -10_000 : 60_000));
    const toolCallId = `call_seed_${tag}`;
    const request = normalizedRequest({
      tag,
      toolCallId,
      principalId: principal.id,
      projectId: project.id,
      threadId: thread.id,
      runId: run.id,
      runtimeAttemptId: attempt.id,
      sessionId: session.id,
      boardId: board.id,
      clientSessionId: session.clientSessionId,
      projectSessionGeneration: session.projectSessionGeneration,
      boardRevision: board.revision,
      canvasStateRevision: 1,
    });
    const sequenced = await admin.canvasAgentSession.update({
      where: { id: session.id },
      data: { invocationSequence: { increment: 1 } },
      select: { invocationSequence: true },
    });
    const invocationId = `invocation_${tag}_${sequenced.invocationSequence}`;
    await admin.canvasToolInvocation.create({
      data: {
        id: invocationId,
        agentSessionId: session.id,
        grantId: grant.grantId,
        runId: run.id,
        projectId: project.id,
        principalId: principal.id,
        toolCallId,
        toolName: "navigate_canvas",
        sequence: sequenced.invocationSequence,
        requestHash: "d".repeat(64),
        request: request as unknown as Prisma.InputJsonValue,
        status: "waiting_client",
        leaseToken: null,
        leaseExpiresAt: null,
        boardRevisionBefore: board.revision,
        canvasStateRevisionBefore: 1,
        canvasStateSha256Before: snapshotSha256,
        startedAt: issued,
        createdAt: issued,
      },
    });
    const commandId = randomUUID();
    const command = canvasClientCommandSchema.parse({
      protocol: "workbench.canvas-client-command.v1",
      commandId,
      agentSessionId: session.id,
      toolCallId,
      requestId: request.context.requestId,
      projectId: project.id,
      threadId: thread.id,
      runId: run.id,
      boardId: board.id,
      clientSessionId: session.clientSessionId,
      projectSessionGeneration: session.projectSessionGeneration,
      boardRevision: board.revision,
      expectedCanvasStateRevision: 1,
      issuedAt: issued.toISOString(),
      expiresAt: commandExpiresAt.toISOString(),
      kind: "viewport.navigate",
      toolName: "navigate_canvas",
      target: { kind: "all" },
      behavior: "instant",
    });
    await admin.canvasClientCommand.create({
      data: {
        id: commandId,
        agentSessionId: session.id,
        invocationId,
        projectId: project.id,
        threadId: thread.id,
        runId: run.id,
        clientSessionId: session.clientSessionId,
        projectSessionGeneration: session.projectSessionGeneration,
        toolCallId,
        boardRevision: board.revision,
        canvasStateRevision: 1,
        expectedCanvasStateSha256: snapshotSha256,
        command: command as unknown as Prisma.InputJsonValue,
        expiresAt: commandExpiresAt,
        createdAt: issued,
      },
    });
    return { commandId, invocationId, command };
  };

  return {
    principalId: principal.id,
    workspaceId: workspace.id,
    projectId: project.id,
    threadId: thread.id,
    runId: run.id,
    boardId: board.id,
    sessionId: session.id,
    grantId: grant.grantId,
    clientSessionId: session.clientSessionId,
    projectSessionGeneration: session.projectSessionGeneration,
    expiresAt,
    grant,
    token,
    reference,
    snapshot,
    state,
    ack,
    applicationName,
    client,
    service,
    issueCommand,
    seedPendingCommand,
    async dispose() {
      await Promise.allSettled(clients.map((value) => value.$disconnect()));
      await admin.project.delete({ where: { id: project.id } }).catch(() => undefined);
      await admin.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
      await admin.principal.delete({ where: { id: principal.id } }).catch(() => undefined);
    },
  };
}

function invocation(toolCallId: string) {
  return canvasAgentToolInvocationSchema.parse({
    protocol: "workbench.canvas-agent-tool.v1",
    toolName: "navigate_canvas",
    toolCallId,
    input: { target: { kind: "all" }, behavior: "instant" },
  });
}

function normalizedRequest(input: {
  tag: string;
  toolCallId: string;
  principalId: string;
  projectId: string;
  threadId: string;
  runId: string;
  runtimeAttemptId: string;
  sessionId: string;
  boardId: string;
  clientSessionId: string;
  projectSessionGeneration: number;
  boardRevision: number;
  canvasStateRevision: number;
}) {
  return canvasAgentToolRequestSchema.parse({
    protocol: "workbench.canvas-agent-tool.v1",
    context: {
      protocol: "workbench.canvas-agent-tool.v1",
      principalId: input.principalId,
      projectId: input.projectId,
      threadId: input.threadId,
      runId: input.runId,
      runtimeAttemptId: input.runtimeAttemptId,
      agentSessionId: input.sessionId,
      toolCallId: input.toolCallId,
      requestId: `request-${input.tag}`,
      traceId: `trace-${input.tag}`,
      clientSessionId: input.clientSessionId,
      projectSessionGeneration: input.projectSessionGeneration,
      boardId: input.boardId,
      boardRevision: input.boardRevision,
      canvasStateRevision: input.canvasStateRevision,
      declarationSha256,
      capabilities: ["canvas:read", "canvas:interact"],
    },
    toolName: "navigate_canvas",
    input: { target: { kind: "all" }, behavior: "instant" },
  });
}

function prototypeDocument(documentId: string, screenId: string) {
  return prototypeDocumentSchema.parse({
    protocol: "workbench.prototype.v1",
    documentId,
    title: "Canvas concurrency",
    revision: 1,
    screens: [{
      id: screenId,
      name: "Home",
      route: "/",
      rootNodeId: `root-${screenId}`,
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: `root-${screenId}`,
      screenId,
      parentId: null,
      name: "Root",
      visible: true,
      layout: {
        mode: "absolute",
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "block",
        direction: "column",
        gap: literal(0),
        padding: {
          top: literal(0),
          right: literal(0),
          bottom: literal(0),
          left: literal(0),
        },
        align: "start",
        justify: "start",
        gridColumns: null,
        overflow: "hidden",
      },
      style: {
        opacity: 1,
        rotation: 0,
        transformOrigin: { x: 0.5, y: 0.5 },
        fill: { kind: "literal", value: "#ffffff" },
        stroke: null,
        radii: {
          topLeft: literal(0),
          topRight: literal(0),
          bottomRight: literal(0),
          bottomLeft: literal(0),
        },
        shadowTokenIds: [],
        typography: null,
      },
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "frame",
      childIds: [],
      clipContent: true,
    }],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  });
}

function literal(value: number) {
  return { kind: "literal" as const, value };
}

function canvasConfig() {
  return new CanvasAgentConfig(new ConfigService({
    WORKBENCH_CANVAS_TOOL_SECRET: secret.toString("base64url"),
    WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS: "300",
    WORKBENCH_CANVAS_COMMAND_TTL_SECONDS: "30",
    WORKBENCH_CANVAS_INVOCATION_LEASE_SECONDS: "30",
  }));
}

function reconcilerConfig(batchSize: number) {
  return {
    expiryReconciliationBatchSize: batchSize,
    expiryReconciliationIntervalMs: 60_000,
  };
}

function rejectingVisualStorage() {
  return {
    putObject: async () => { throw new Error("VISUAL_STORAGE_NOT_EXPECTED"); },
    readObject: async () => { throw new Error("VISUAL_STORAGE_NOT_EXPECTED"); },
    deleteObject: async () => undefined,
  };
}

async function holdGrantRevocation(client: PrismaClient, grantId: string) {
  const release = deferred<void>();
  const started = deferred<number>();
  const transaction = client.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
      SELECT pg_backend_pid() AS "pid"
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "canvas_tool_grants"
      SET "revoked_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${grantId}::uuid
    `);
    started.resolve(pid);
    await release.promise;
  });
  return { pid: await started.promise, release, transaction };
}

async function holdBoardLock(client: PrismaClient, boardId: string) {
  const release = deferred<void>();
  const started = deferred<number>();
  const transaction = client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
      SELECT pg_backend_pid() AS "pid"
      FROM "boards"
      WHERE "id" = ${boardId}
      FOR UPDATE
    `);
    if (!rows[0]) throw new Error("CANVAS_TEST_BOARD_NOT_FOUND");
    started.resolve(rows[0].pid);
    await release.promise;
  });
  return { pid: await started.promise, release, transaction };
}

async function waitForBlockedBy(
  observer: PrismaClient,
  applicationName: string,
  blockerPid: number,
  expectedPid?: number,
) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<Array<{
      pid: number;
      blockingPids: number[];
      waitEventType: string | null;
    }>>(Prisma.sql`
      SELECT
        "pid",
        pg_blocking_pids("pid") AS "blockingPids",
        "wait_event_type" AS "waitEventType"
      FROM pg_stat_activity
      WHERE "application_name" = ${applicationName}
        AND "state" = 'active'
      ORDER BY "query_start" DESC
    `);
    const blocked = rows.find((row) => (
      (expectedPid === undefined || row.pid === expectedPid)
      && row.blockingPids.includes(blockerPid)
      && row.waitEventType === "Lock"
    ));
    if (blocked) return blocked.pid;
    await delay(25);
  }
  const diagnostics = await observer.$queryRaw<Array<{
    pid: number;
    applicationName: string;
    state: string;
    waitEventType: string | null;
    blockingPids: number[];
  }>>(Prisma.sql`
    SELECT
      "pid",
      "application_name" AS "applicationName",
      "state",
      "wait_event_type" AS "waitEventType",
      pg_blocking_pids("pid") AS "blockingPids"
    FROM pg_stat_activity
    WHERE "application_name" LIKE 'canvas_%'
    ORDER BY "application_name", "pid"
  `);
  throw new Error(
    `CANVAS_TEST_EXPECTED_LOCK_NOT_OBSERVED:${applicationName}:${blockerPid}:${JSON.stringify(diagnostics)}`,
  );
}

function connectionUrl(applicationName: string) {
  const url = new URL(databaseUrl!);
  url.searchParams.set("application_name", applicationName);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function problemCode(result: { ok: boolean; error?: unknown }) {
  if (result.ok || !result.error || typeof result.error !== "object") return undefined;
  const getResponse = (result.error as { getResponse?: () => unknown }).getResponse;
  const response = typeof getResponse === "function" ? getResponse.call(result.error) : null;
  return response && typeof response === "object" && "code" in response
    ? (response as { code?: unknown }).code
    : undefined;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
