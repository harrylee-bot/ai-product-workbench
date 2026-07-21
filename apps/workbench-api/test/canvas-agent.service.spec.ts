import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  canvasAgentToolRequestSchema,
  canvasAgentToolInvocationSchema,
  canvasClientCommandAckSchema,
  canvasClientCommandSchema,
  canvasClientStateSyncRequestSchema,
  type CanvasAgentToolInvocation,
} from "@workbench/workbench-contracts";
import {
  createCanvasToolCapabilityGrant,
  canvasToolCapabilityGrantPayloadSha256,
  canvasToolPayloadSha256,
  type CanvasToolCapabilityGrantPayload,
} from "@workbench/workbench-canvas-tools";
import { describe, expect, it, vi } from "vitest";
import { CanvasAgentConfig } from "../src/modules/canvas-agent/canvas-agent.config.js";
import {
  CanvasAgentService,
  canonicalCanvasStateSha256,
  canvasToolEffectRequiresWriteAccess,
} from "../src/modules/canvas-agent/canvas-agent.service.js";

describe("CanvasAgentService", () => {
  it("allows read-profile UI commands while reserving write access for mutations and Runs", () => {
    expect(canvasToolEffectRequiresWriteAccess("read")).toBe(false);
    expect(canvasToolEffectRequiresWriteAccess("client_command")).toBe(false);
    expect(canvasToolEffectRequiresWriteAccess("mutation")).toBe(true);
    expect(canvasToolEffectRequiresWriteAccess("run")).toBe(true);
  });

  it("rejects the capability endpoint before touching the database when the wbct secret is absent", async () => {
    const db = {};
    const service = new CanvasAgentService(
      db as never,
      new CanvasAgentConfig(new ConfigService({})),
    );
    const request = invocation({ toolName: "get_selected_screens", input: {} });

    const failure = await service.execute(undefined, undefined, request).catch((error: unknown) => error) as {
      status: number;
      getResponse: () => { code?: string };
    };
    expect(failure.status).toBe(503);
    expect(failure.getResponse().code).toBe("CANVAS_TOOL_NOT_CONFIGURED");
  });

  it("rechecks the live session, grant, Run, membership, and owner before reading a visual", async () => {
    const grant = capabilityGrant();
    const secret = Buffer.alloc(32, 17);
    const token = createCanvasToolCapabilityGrant(grant, secret, {
      now: new Date(),
      maximumTtlSeconds: 300,
    });
    const bytes = Buffer.from("visual-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{
        storageKey: "canvas-visuals/visual_1.webp",
        mediaType: "image/webp",
        sha256,
        byteSize: BigInt(bytes.byteLength),
        expiresAt: new Date(Date.now() + 30_000),
        snapshotSha256: grant.snapshotSha256,
        boardRevision: grant.boardRevision,
        canvasStateRevision: grant.canvasStateRevision,
        viewport: { x: 0, y: 0, zoom: 1 },
        selectedNodeIds: [],
        visibleNodeIds: [],
        profile: grant.profile,
      }]),
    };
    const storage = {
      getObject: vi.fn().mockResolvedValue({
        body: Readable.from([bytes]),
        byteSize: bytes.byteLength,
        mediaType: "image/webp",
        contentRange: null,
      }),
      putObject: vi.fn(),
      deleteObject: vi.fn(),
    };
    const service = new CanvasAgentService(
      db as never,
      new CanvasAgentConfig(new ConfigService({ WORKBENCH_CANVAS_TOOL_SECRET: secret.toString("base64url") })),
      storage,
    );

    const result = await service.getVisual(`Bearer ${token}`, "visual_1");

    expect(result).toMatchObject({
      mediaType: "image/webp",
      byteSize: bytes.byteLength,
      sha256,
    });
    const query = db.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    const sql = query.strings?.join("?").replace(/\s+/gu, " ") ?? "";
    expect(sql).toContain('session."status" = \'active\'');
    expect(sql).toContain('tool_grant."revoked_at" IS NULL');
    expect(sql).toContain('run."status" = \'running\'');
    expect(sql).toContain('project."status" = \'active\'');
    expect(sql).toContain('principal."status" = \'active\'');
    expect(sql).toContain('visual."storage_deleted_at" IS NULL');
    expect(storage.getObject).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the signed token still lives but its live owner rows are no longer valid", async () => {
    const grant = capabilityGrant();
    const secret = Buffer.alloc(32, 18);
    const token = createCanvasToolCapabilityGrant(grant, secret, {
      now: new Date(),
      maximumTtlSeconds: 300,
    });
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const storage = {
      getObject: vi.fn(),
      putObject: vi.fn(),
      deleteObject: vi.fn(),
    };
    const service = new CanvasAgentService(
      db as never,
      new CanvasAgentConfig(new ConfigService({ WORKBENCH_CANVAS_TOOL_SECRET: secret.toString("base64url") })),
      storage,
    );

    await expect(service.getVisual(`Bearer ${token}`, "visual_1")).rejects.toMatchObject({
      status: 401,
      response: expect.objectContaining({ code: "CANVAS_TOOL_GRANT_UNAUTHORIZED" }),
    });
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("normalizes the Worker minimal envelope from the signed session scope", async () => {
    const secret = Buffer.alloc(32, 17).toString("base64url");
    const db = {
      canvasAgentSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session_1",
          runtimeAttemptId: "attempt_1",
          runId: "run_1",
          projectId: "project_1",
          threadId: "thread_1",
          principalId: "principal_1",
          boardId: "board_1",
          clientSessionId: "client_123",
          projectSessionGeneration: 4,
          boardRevision: 12,
          canvasStateRevision: 3,
          declarationHash: "a".repeat(64),
        }),
      },
    };
    const service = new CanvasAgentService(
      db as never,
      new CanvasAgentConfig(new ConfigService({ WORKBENCH_CANVAS_TOOL_SECRET: secret })),
    );
    const grant = {
      grantId: "grant_1",
      principalId: "principal_1",
      projectId: "project_1",
      threadId: "thread_1",
      runId: "run_1",
      runtimeAttemptId: "attempt_1",
      agentSessionId: "session_1",
      boardId: "board_1",
      declarationSha256: "a".repeat(64),
      issuedAt: new Date("2026-07-17T08:00:00.000Z"),
      notBefore: new Date("2026-07-17T08:00:00.000Z"),
      expiresAt: new Date("2026-07-17T08:05:00.000Z"),
    };
    const request = invocation({ toolName: "get_selected_screens", input: {} });
    const normalized = await (service as unknown as {
      normalizeInvocationRequest: (grant: typeof grant, request: CanvasAgentToolInvocation) => Promise<unknown>;
    }).normalizeInvocationRequest(grant, request);

    expect(normalized).toMatchObject({
      toolName: "get_selected_screens",
      context: {
        principalId: "principal_1",
        projectId: "project_1",
        agentSessionId: "session_1",
        boardRevision: 12,
        canvasStateRevision: 3,
        projectSessionGeneration: 4,
        clientSessionId: "client_123",
        declarationSha256: "a".repeat(64),
      },
    });
  });

  it("does not expose pending commands across principals or projects", async () => {
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([]),
      canvasClientCommand: { findMany: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await service.listCommands("principal_1", "project_1", "client_123", 1, undefined, 100)
      .catch((error: unknown) => error) as { status: number; getResponse: () => { code?: string } };
    expect(failure.status).toBe(404);
    expect(failure.getResponse().code).toBe("CANVAS_TOOL_SCOPE_INVALID");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(rawSqlText(tx.$queryRaw.mock.calls[0]?.[0])).toContain('FROM "projects" AS project');
    expect(rawSqlText(tx.$queryRaw.mock.calls[1]?.[0])).toContain('FROM "project_members"');
    expect(tx.canvasClientCommand.findMany).not.toHaveBeenCalled();
  });

  it("lists commands under one locked authorization snapshot", async () => {
    const command = navigateCommand();
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{ id: "session_1" }]),
      canvasClientCommand: {
        findMany: vi.fn().mockResolvedValue([{
          id: command.commandId,
          createdAt: new Date(),
          command,
        }]),
      },
    };
    const service = serviceWithTransaction(tx);

    await expect(service.listCommands(
      "principal_1",
      "project_1",
      "client_123",
      2,
      undefined,
      100,
    )).resolves.toEqual({ items: [command], nextCursor: null });
    expect(rawSqlText(tx.$queryRaw.mock.calls[2]?.[0])).toContain("FOR SHARE OF session, tool_grant");
    expect(tx.canvasClientCommand.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        agentSessionId: { in: ["session_1"] },
        status: "pending",
      }),
    }));
  });

  it("keeps canonical Canvas-state digests stable across capture timestamps", () => {
    const scope = authorizedScope();
    const digest = canonicalCanvasStateSha256(scope.snapshot as never);
    const recaptured = {
      ...scope.snapshot,
      capturedAt: new Date(Date.now() + 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    expect(canonicalCanvasStateSha256(recaptured as never)).toBe(digest);
    expect(canonicalCanvasStateSha256({
      ...recaptured,
      viewport: { x: 10, y: 0, zoom: 1 },
    } as never)).not.toBe(digest);
  });

  it("keeps the authoritative Canvas snapshot client-owned", async () => {
    const service = new CanvasAgentService(
      { artifactVersion: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      new CanvasAgentConfig(new ConfigService({})),
    );
    const expiresAt = new Date(Date.now() + 60_000);
    const projected = await (service as unknown as {
      projectSnapshot: (session: unknown, board: unknown) => Promise<{ snapshot: Record<string, unknown> }>;
    }).projectSnapshot({
      id: "session_1",
      runId: "run_1",
      projectId: "project_1",
      threadId: "thread_1",
      boardId: "board_1",
      clientSessionId: "client_123",
      projectSessionGeneration: 2,
      canvasStateRevision: 3,
      visibleNodeIds: [],
      selectedNodeIds: [],
      expiresAt,
    }, {
      id: "board_1",
      projectId: "project_1",
      revision: 4,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    });

    expect(projected.snapshot).toMatchObject({
      projectId: "project_1",
      threadId: "thread_1",
      runId: "run_1",
      boardId: "board_1",
    });
    expect(projected.snapshot).not.toHaveProperty("agentSessionId");
  });

  it("does not project an out-of-project ArtifactVersion into Canvas targets", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new CanvasAgentService(
      { artifactVersion: { findMany } } as never,
      new CanvasAgentConfig(new ConfigService({})),
    );
    const expiresAt = new Date(Date.now() + 60_000);
    const projected = await (service as unknown as {
      projectSnapshot: (session: unknown, board: unknown) => Promise<{
        snapshot: { screens: unknown[]; selectedScreens: unknown[] };
        screens: Map<string, unknown>;
      }>;
    }).projectSnapshot({
      id: "session_1",
      runId: "run_1",
      projectId: "project_1",
      threadId: "thread_1",
      boardId: "board_1",
      clientSessionId: "client_123",
      projectSessionGeneration: 2,
      canvasStateRevision: 3,
      visibleNodeIds: [],
      selectedNodeIds: ["outside_node"],
      viewport: { x: 0, y: 0, zoom: 1 },
      expiresAt,
    }, {
      id: "board_1",
      projectId: "project_1",
      revision: 4,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: "outside_node_id",
        boardId: "board_1",
        projectId: "project_1",
        nodeKey: "outside_node",
        parentNodeKey: null,
        sortOrder: 0,
        kind: "artifact",
        position: { x: 0, y: 0 },
        size: null,
        artifactId: "artifact_outside_project",
        artifactVersionId: "version_outside_project",
        data: {
          protocol: "workbench.board-node.v1",
          nodeType: "artifact",
          title: "Outside Project",
          artifactKind: "prototype",
          screenId: "screen_outside_project",
        },
      }],
      edges: [],
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: "project_1" }),
    }));
    expect(projected.screens.size).toBe(0);
    expect(projected.snapshot.screens).toEqual([]);
    expect(projected.snapshot.selectedScreens).toEqual([]);
  });

  it("records quick_edit against the active edit Run instead of starting a nested Run", async () => {
    const target = {
      boardNodeId: "node_1",
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: "screen_1",
    };
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          status: "active",
          activeMutationToolCallId: "call_1",
          expiresAt: new Date(Date.now() + 60_000),
          canvasStateRevision: 4,
          selectedNodeIds: ["node_1"],
          visibleNodeIds: [],
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run_1",
          status: "running",
          request: {
            prompt: "Edit this screen",
            modelId: "model_1",
            workflow: "edit",
            targetSurface: "app",
            designStyle: { kind: "automatic" },
            sourceIds: [],
            artifactTargets: [{
              artifactId: target.artifactId,
              artifactVersionId: target.artifactVersionId,
              screenIds: [target.screenId],
            }],
            requestedArtifactKinds: [],
          },
        }),
      },
      canvasToolInvocation: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      canvasAgentSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const db = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)) };
    const service = new CanvasAgentService(
      db as never,
      new CanvasAgentConfig(new ConfigService({})),
    );
    const scope = {
      grant: { runId: "run_1" },
      session: {
        id: "session_1",
        projectId: "project_1",
        canvasStateRevision: 4,
        selectedNodeIds: ["node_1"],
        visibleNodeIds: [],
      },
      board: { revision: 7 },
      snapshot: { selectedScreens: [target] },
      screens: new Map([[target.boardNodeId, { reference: target }]]),
    };
    const request = {
      context: { toolCallId: "call_1" },
      toolName: "quick_edit",
      input: { target, instruction: "Change the heading" },
    };
    const result = await (service as unknown as {
      executeRunIntent: (scope: unknown, invocation: unknown, request: unknown) => Promise<{ data: unknown }>;
    }).executeRunIntent(scope, { id: "invocation_1", leaseToken: "lease_1" }, request);

    expect(result.data).toEqual({ runId: "run_1", target, accepted: true });
    expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith({
      where: { id: "invocation_1", status: "in_flight", leaseToken: "lease_1" },
      data: expect.objectContaining({
        status: "succeeded",
        satisfiesRunTarget: true,
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
  });

  it.each([
    {
      status: "succeeded",
      workflow: "edit",
      runTargetArtifactId: "artifact_1",
      code: "CANVAS_EDIT_RUN_NOT_ACTIVE",
    },
    {
      status: "running",
      workflow: "generate",
      runTargetArtifactId: "artifact_1",
      code: "CANVAS_EDIT_WORKFLOW_REQUIRED",
    },
    {
      status: "running",
      workflow: "edit",
      runTargetArtifactId: "artifact_outside_run",
      code: "CANVAS_EDIT_TARGET_MISMATCH",
    },
  ])("rejects quick_edit outside the active Run's exact edit target", async ({
    status,
    workflow,
    runTargetArtifactId,
    code,
  }) => {
    const target = {
      boardNodeId: "node_1",
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: "screen_1",
    };
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          status: "active",
          activeMutationToolCallId: "call_1",
          expiresAt: new Date(Date.now() + 60_000),
          canvasStateRevision: 4,
          selectedNodeIds: ["node_1"],
          visibleNodeIds: [],
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run_1",
          status,
          request: {
            prompt: "Edit this screen",
            modelId: "model_1",
            workflow,
            targetSurface: "app",
            designStyle: { kind: "automatic" },
            sourceIds: [],
            artifactTargets: workflow === "edit" ? [{
              artifactId: runTargetArtifactId,
              artifactVersionId: target.artifactVersionId,
              screenIds: [target.screenId],
            }] : [],
            requestedArtifactKinds: [],
          },
        }),
      },
    };
    const service = new CanvasAgentService({
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as never, new CanvasAgentConfig(new ConfigService({})));
    const failure = await (service as unknown as {
      executeRunIntent: (scope: unknown, invocation: unknown, request: unknown) => Promise<unknown>;
    }).executeRunIntent({
      grant: { runId: "run_1" },
      session: {
        id: "session_1",
        projectId: "project_1",
        canvasStateRevision: 4,
        selectedNodeIds: ["node_1"],
        visibleNodeIds: [],
      },
      board: { revision: 7 },
      snapshot: { selectedScreens: [target] },
      screens: new Map([[target.boardNodeId, { reference: target }]]),
    }, { id: "invocation_1", leaseToken: "lease_1" }, {
      context: { toolCallId: "call_1" },
      toolName: "quick_edit",
      input: { target, instruction: "Change the heading" },
    }).catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe(code);
  });

  it("transfers an in-flight invocation lease when the identical response was lost", async () => {
    const scope = authorizedScope();
    const request = normalizedRequest("get_selected_screens", {});
    const existing = invocationRow({ leaseToken: "old_lease", executionAttempt: 1 });
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([lockedSession(scope.grant)])
        .mockResolvedValueOnce([{ revision: 7 }]),
      canvasToolInvocation: {
        findUnique: vi.fn().mockResolvedValue(existing),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      canvasAgentSession: { update: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const reservation = await (service as unknown as {
      reserveInvocation: (scope: unknown, request: unknown, requestHash: string, key?: string) => Promise<{
        kind: string;
        invocation: { leaseToken: string; executionAttempt: number };
      }>;
    }).reserveInvocation(scope, request, "b".repeat(64), undefined);

    expect(reservation.kind).toBe("new");
    expect(reservation.invocation.executionAttempt).toBe(2);
    expect(reservation.invocation.leaseToken).not.toBe("old_lease");
    expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith({
      where: { id: existing.id, status: "in_flight", leaseToken: "old_lease" },
      data: {
        executionAttempt: { increment: 1 },
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
      },
    });
    expect(tx.canvasAgentSession.update).not.toHaveBeenCalled();
    expect(rawSqlText(tx.$queryRaw.mock.calls[0]?.[0])).toContain('FROM "projects" AS project');
    expect(rawSqlText(tx.$queryRaw.mock.calls[1]?.[0])).toContain('FROM "project_members"');
    expect(rawSqlText(tx.$queryRaw.mock.calls[2]?.[0])).toContain('FROM "canvas_agent_sessions" AS session');
    expect(rawSqlText(tx.$queryRaw.mock.calls[3]?.[0])).toContain('FROM "boards"');
  });

  it("blocks a new tool call while a provisional client command is waiting for ACK", async () => {
    const scope = authorizedScope();
    const request = normalizedRequest("get_selected_screens", {});
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{
          ...lockedSession(scope.grant),
          waitingClientToolCallId: "pending_canvas_call",
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      canvasToolInvocation: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      canvasAgentSession: { update: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await reserveForTest(service, scope, request)
      .catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_INVOCATION_CONFLICT");
    expect(tx.canvasToolInvocation.create).not.toHaveBeenCalled();
    expect(tx.canvasAgentSession.update).not.toHaveBeenCalled();
  });

  it("rejects reservation when Canvas state changes after authorization", async () => {
    const scope = authorizedScope();
    const request = normalizedRequest("get_selected_screens", {});
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{
          ...lockedSession(scope.grant),
          canvasStateRevision: 5,
          selectedNodeIds: ["other_node"],
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      canvasToolInvocation: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    };
    const service = serviceWithTransaction(tx);

    const failure = await (service as unknown as {
      reserveInvocation: (scope: unknown, request: unknown, requestHash: string) => Promise<unknown>;
    }).reserveInvocation(scope, request, "b".repeat(64)).catch((error: unknown) => error) as {
      getResponse: () => { code?: string };
    };

    expect(failure.getResponse().code).toBe("CANVAS_REVISION_MISMATCH");
    expect(tx.canvasToolInvocation.findUnique).not.toHaveBeenCalled();
    expect(tx.canvasToolInvocation.create).not.toHaveBeenCalled();
  });

  it("rejects reservation when membership was removed after authorization", async () => {
    const scope = authorizedScope();
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([]),
      canvasToolInvocation: { findUnique: vi.fn(), create: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await reserveForTest(service, scope, normalizedRequest("get_selected_screens", {}))
      .catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_SCOPE_INVALID");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.canvasToolInvocation.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a write reservation when the member was downgraded to viewer", async () => {
    const scope = authorizedScope();
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership("viewer")]),
      canvasToolInvocation: { findUnique: vi.fn(), create: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await reserveForTest(service, scope, normalizedRequest("quick_edit", {
      target: screenTarget(),
      instruction: "Change the heading",
    })).catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_READONLY");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.canvasToolInvocation.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    { projectStatus: "archived", principalStatus: "active" },
    { projectStatus: "active", principalStatus: "disabled" },
  ])("rejects reservation when the locked identity scope is inactive", async (identity) => {
    const scope = authorizedScope();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValueOnce([activeReservationIdentity(identity)]),
      canvasToolInvocation: { findUnique: vi.fn(), create: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await reserveForTest(service, scope, normalizedRequest("get_selected_screens", {}))
      .catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_SCOPE_INVALID");
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.canvasToolInvocation.findUnique).not.toHaveBeenCalled();
  });

  it("serializes concurrent quick_edit reservations through the active mutation slot", async () => {
    const scope = authorizedScope();
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{
          ...lockedSession(scope.grant),
          activeMutationToolCallId: "other_call",
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      canvasToolInvocation: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      canvasAgentSession: { update: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await reserveForTest(service, scope, normalizedRequest("quick_edit", {
      target: screenTarget(),
      instruction: "Change the heading",
    })).catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_INVOCATION_CONFLICT");
    expect(tx.canvasAgentSession.update).not.toHaveBeenCalled();
    expect(tx.canvasToolInvocation.create).not.toHaveBeenCalled();
  });

  it("fences an old lease owner from settling after a transfer", async () => {
    const tx = {
      canvasToolInvocation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const service = serviceWithTransaction(tx);
    const scope = authorizedScope();
    const request = normalizedRequest("get_selected_screens", {});

    const failure = await (service as unknown as {
      succeedInvocation: (scope: unknown, invocation: unknown, request: unknown, data: unknown) => Promise<unknown>;
    }).succeedInvocation(
      scope,
      invocationRow({ leaseToken: "superseded_lease" }),
      request,
      { kind: "none", items: [], truncated: false },
    ).catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_INVOCATION_CONFLICT");
  });

  it("clears the lease when a read invocation succeeds", async () => {
    const tx = {
      canvasToolInvocation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = serviceWithTransaction(tx);
    const scope = authorizedScope();
    const request = normalizedRequest("get_selected_screens", {});

    await (service as unknown as {
      succeedInvocation: (scope: unknown, invocation: unknown, request: unknown, data: unknown) => Promise<unknown>;
    }).succeedInvocation(
      scope,
      invocationRow({ leaseToken: "active_lease" }),
      request,
      { kind: "none", items: [], truncated: false },
    );

    expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "in_flight", leaseToken: "active_lease" }),
      data: expect.objectContaining({
        status: "succeeded",
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    }));
  });

  it("does not dispatch a client command after its session is cancelled", async () => {
    const scope = authorizedScope();
    const request = normalizedRequest("navigate_canvas", {
      target: { kind: "selection" },
      behavior: "instant",
    });
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{ id: scope.session.id }]),
      canvasAgentSession: {
        findUnique: vi.fn().mockResolvedValue({
          ...scope.session,
          status: "cancelled",
        }),
      },
      canvasClientCommand: { create: vi.fn() },
      canvasToolInvocation: { updateMany: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await (service as unknown as {
      issueClientCommand: (scope: unknown, invocation: unknown, request: unknown) => Promise<unknown>;
    }).issueClientCommand(
      scope,
      invocationRow({ leaseToken: "active_lease", toolName: "navigate_canvas" }),
      request,
    ).catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_INVOCATION_CONFLICT");
    expect(rawSqlText(tx.$queryRaw.mock.calls[0]?.[0])).toContain('FROM "projects" AS project');
    expect(rawSqlText(tx.$queryRaw.mock.calls[1]?.[0])).toContain('FROM "project_members"');
    expect(rawSqlText(tx.$queryRaw.mock.calls[2]?.[0])).toContain('FOR UPDATE OF session, tool_grant');
    expect(tx.canvasClientCommand.create).not.toHaveBeenCalled();
    expect(tx.canvasToolInvocation.updateMany).not.toHaveBeenCalled();
  });

  it("does not dispatch a reserved command after Project membership is removed", async () => {
    const scope = authorizedScope();
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([]),
      canvasAgentSession: { findUnique: vi.fn() },
      canvasClientCommand: { create: vi.fn() },
      canvasToolInvocation: { updateMany: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await (service as unknown as {
      issueClientCommand: (scope: unknown, invocation: unknown, request: unknown) => Promise<unknown>;
    }).issueClientCommand(
      scope,
      invocationRow({ toolName: "navigate_canvas" }),
      normalizedRequest("navigate_canvas", { target: { kind: "selection" }, behavior: "instant" }),
    ).catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_SCOPE_INVALID");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.canvasAgentSession.findUnique).not.toHaveBeenCalled();
    expect(tx.canvasClientCommand.create).not.toHaveBeenCalled();
  });

  it("locks and rejects a grant revoked after invocation reservation", async () => {
    const scope = authorizedScope();
    const grant = capabilityGrant();
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{ id: scope.session.id }]),
      canvasAgentSession: {
        findUnique: vi.fn().mockResolvedValue({
          ...scope.session,
          grant: {
            id: grant.grantId,
            payloadSha256: canvasToolCapabilityGrantPayloadSha256(grant),
            declarationHash: grant.declarationSha256,
            snapshotSha256: scope.session.snapshotSha256,
            expiresAt: grant.expiresAt,
            revokedAt: new Date(),
          },
        }),
      },
      canvasClientCommand: { create: vi.fn() },
      canvasToolInvocation: { updateMany: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const failure = await (service as unknown as {
      issueClientCommand: (scope: unknown, invocation: unknown, request: unknown) => Promise<unknown>;
    }).issueClientCommand(
      { ...scope, grant },
      invocationRow({ toolName: "navigate_canvas" }),
      normalizedRequest("navigate_canvas", { target: { kind: "selection" }, behavior: "instant" }),
    ).catch((error: unknown) => error) as { getResponse: () => { code?: string } };

    expect(failure.getResponse().code).toBe("CANVAS_TOOL_GRANT_UNAUTHORIZED");
    expect(rawSqlText(tx.$queryRaw.mock.calls[2]?.[0])).toContain("FOR UPDATE OF session, tool_grant");
    expect(tx.canvasClientCommand.create).not.toHaveBeenCalled();
  });

  it("replays an identical persisted ACK after the Canvas session is terminal", async () => {
    const command = navigateCommand();
    const ack = navigateAck(command);
    const tx = acknowledgementTransaction(command, ack, {
      commandStatus: "acknowledged",
      sessionStatus: "completed",
    });
    const service = serviceWithTransaction(tx, { locateCommand: true });

    await expect(service.acknowledge("principal_1", "project_1", command.commandId, ack)).resolves.toEqual(ack);
    expect(tx.canvasClientCommand.updateMany).not.toHaveBeenCalled();
    expect(tx.canvasToolInvocation.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a different ACK after the first result is persisted", async () => {
    const command = navigateCommand();
    const first = navigateAck(command);
    const second = navigateAck(command, { x: 99, y: 30, zoom: 1.25 });
    const tx = acknowledgementTransaction(command, first, {
      commandStatus: "acknowledged",
      sessionStatus: "completed",
    });
    const service = serviceWithTransaction(tx, { locateCommand: true });

    const failure = await service.acknowledge("principal_1", "project_1", command.commandId, second)
      .catch((error: unknown) => error) as { getResponse: () => { code?: string } };
    expect(failure.getResponse().code).toBe("CANVAS_CLIENT_COMMAND_CONFLICT");
  });

  it("revokes the grant when a rejected ACK follows a provisional state advance", async () => {
    const command = navigateCommand();
    const ack = rejectedNavigateAck(command);
    const tx = acknowledgementTransaction(command, null, {
      commandStatus: "pending",
      sessionStatus: "active",
    });
    const service = serviceWithTransaction(tx, { locateCommand: true });

    await expect(service.acknowledge("principal_1", "project_1", command.commandId, ack)).resolves.toEqual(ack);
    expect(tx.canvasToolGrant.updateMany).toHaveBeenCalledWith({
      where: { id: "11111111-1111-4111-8111-111111111111", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("publishes a normalized Canvas visual once and verifies replay without another upload", async () => {
    const capture = visualCaptureFixture();
    const pending = pendingVisualCapability(capture.visualCapabilityId);
    const findUnique = vi.fn().mockResolvedValue(pending);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: capture.visualCapabilityId }]),
      canvasVisualCapability: { findUnique, updateMany },
    };
    const storage = {
      putObject: vi.fn().mockResolvedValue(undefined),
      getObject: vi.fn(),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CanvasAgentService(
      {} as never,
      new CanvasAgentConfig(new ConfigService({})),
      storage,
    );
    const publishVisualCapture = (service as unknown as {
      publishVisualCapture: (
        client: typeof tx,
        wireCapture: typeof capture,
        binding: ReturnType<typeof visualCaptureBinding>,
        allowPublication?: boolean,
      ) => Promise<{
        storageKey: string;
        mediaType: string;
        sha256: string;
        byteSize: number;
        width: number;
        height: number;
        createdByTransaction: boolean;
      }>;
    }).publishVisualCapture.bind(service);

    const published = await publishVisualCapture(tx, capture, visualCaptureBinding());
    expect(published.createdByTransaction).toBe(true);
    expect(published.storageKey).toMatch(new RegExp(
      `^canvas-visuals/${capture.visualCapabilityId}/${published.sha256}-[0-9a-f-]{36}\\.webp$`,
      "u",
    ));
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: capture.visualCapabilityId,
        commandId: "command_1",
        invocationId: "invocation_1",
        grantId: "11111111-1111-4111-8111-111111111111",
      }),
      data: expect.objectContaining({
        status: "ready",
        storageKey: published.storageKey,
        sha256: published.sha256,
      }),
    }));

    findUnique.mockResolvedValue({
      ...pending,
      status: "ready",
      storageKey: published.storageKey,
      mediaType: published.mediaType,
      sha256: published.sha256,
      byteSize: BigInt(published.byteSize),
      width: published.width,
      height: published.height,
      storageDeletedAt: null,
    });
    const replayed = await publishVisualCapture(tx, capture, visualCaptureBinding(), false);

    expect(replayed).toEqual({ ...published, createdByTransaction: false });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("never deletes a committed Canvas visual while cleaning a rolled-back object", async () => {
    const storage = {
      putObject: vi.fn(),
      getObject: vi.fn(),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const findUnique = vi.fn()
      .mockResolvedValueOnce({ status: "ready", storageKey: "canvas-visuals/committed.webp" })
      .mockResolvedValueOnce({ status: "ready", storageKey: "canvas-visuals/concurrent.webp" })
      .mockRejectedValueOnce(new Error("ambiguous commit"));
    const service = new CanvasAgentService(
      { canvasVisualCapability: { findUnique } } as never,
      new CanvasAgentConfig(new ConfigService({})),
      storage,
    );
    const cleanup = (service as unknown as {
      cleanupUncommittedVisualObject: (input: { capabilityId: string; storageKey: string }) => Promise<void>;
    }).cleanupUncommittedVisualObject.bind(service);

    await cleanup({ capabilityId: "visual_1", storageKey: "canvas-visuals/committed.webp" });
    await cleanup({ capabilityId: "visual_1", storageKey: "canvas-visuals/rolled-back.webp" });
    await cleanup({ capabilityId: "visual_1", storageKey: "canvas-visuals/ambiguous.webp" });

    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith("canvas-visuals/rolled-back.webp");
  });

  it("terminalizes an unacknowledged client command when its TTL elapses", async () => {
    const command = navigateCommand({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const invocation = invocationRow({
      status: "waiting_client",
      leaseToken: null,
      leaseExpiresAt: null,
      toolName: "navigate_canvas",
    });
    const tx = {
      canvasClientCommand: {
        findUnique: vi.fn().mockResolvedValue({
          id: command.commandId,
          invocationId: invocation.id,
          status: "pending",
          expiresAt: new Date(Date.now() - 1_000),
          command,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      canvasVisualCapability: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      canvasToolInvocation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      canvasAgentSession: {
        findUnique: vi.fn().mockResolvedValue({ canvasStateRevision: invocation.canvasStateRevisionBefore }),
      },
      canvasToolGrant: { updateMany: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    const result = await (service as unknown as {
      replayInvocation: (tx: unknown, invocation: unknown, request: unknown) => Promise<{ status: string }>;
    }).replayInvocation(tx, invocation, normalizedRequest("navigate_canvas", {
      target: { kind: "selection" },
      behavior: "instant",
    }));

    expect(result.status).toBe("failed");
    expect(tx.canvasClientCommand.updateMany).toHaveBeenCalledWith({
      where: { id: command.commandId, status: "pending" },
      data: { status: "expired" },
    });
    expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "invocation_1", status: "waiting_client" },
      data: expect.objectContaining({ status: "failed", failureCode: "COMMAND_EXPIRED" }),
    }));
    expect(tx.canvasToolGrant.updateMany).not.toHaveBeenCalled();
  });

  it("synchronizes a complete Canvas state caused by the pending client command", async () => {
    const command = navigateCommand();
    const state = clientState({
      canvasStateRevision: 4,
      viewport: { x: 20, y: 30, zoom: 1.25 },
      causedByCommandId: command.commandId,
    });
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{
          id: "session_1",
          boardRevision: 7,
          canvasStateRevision: 3,
          selectedNodeIds: [],
          visibleNodeIds: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      boardNode: { findMany: vi.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: vi.fn().mockResolvedValue([]) },
      canvasClientCommand: {
        findUnique: vi.fn().mockResolvedValue(causalCommandRow(command)),
      },
      canvasToolGrant: { updateMany: vi.fn() },
      canvasAgentSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = serviceWithTransaction(tx);

    await expect(service.synchronizeClientState("principal_1", "project_1", state)).resolves.toEqual({
      protocol: "workbench.canvas-client-state.v1",
      activeSession: true,
      canvasStateRevision: 4,
    });
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session_1", status: "active", canvasStateRevision: 3 },
      data: {
        canvasStateRevision: 4,
        selectedNodeIds: [],
        visibleNodeIds: [],
        viewport: { x: 20, y: 30, zoom: 1.25 },
      },
    });
    expect(tx.canvasToolGrant.updateMany).not.toHaveBeenCalled();
  });

  it("rejects two different browser states at the same revision without revoking the grant", async () => {
    const state = clientState({
      canvasStateRevision: 3,
      viewport: { x: 20, y: 30, zoom: 1.25 },
    });
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity()])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{
          id: "session_1",
          boardRevision: 7,
          canvasStateRevision: 3,
          selectedNodeIds: [],
          visibleNodeIds: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      boardNode: { findMany: vi.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: vi.fn().mockResolvedValue([]) },
      canvasToolGrant: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      canvasAgentSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = serviceWithTransaction(tx);

    const failure = await service.synchronizeClientState("principal_1", "project_1", state)
      .catch((error: unknown) => error) as { getResponse: () => { code?: string } };
    expect(failure.getResponse().code).toBe("CANVAS_REVISION_MISMATCH");
    expect(tx.canvasToolGrant.updateMany).not.toHaveBeenCalled();
    expect(tx.canvasAgentSession.updateMany).not.toHaveBeenCalled();
  });

  it("revokes only the grant for an uncaused forward Canvas state advance", async () => {
    const databaseNow = new Date("2026-07-20T09:00:00.000Z");
    const state = clientState({
      canvasStateRevision: 4,
      viewport: { x: 20, y: 30, zoom: 1.25 },
    });
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([activeReservationIdentity({ databaseNow })])
        .mockResolvedValueOnce([reservationMembership()])
        .mockResolvedValueOnce([{
          id: "session_1",
          boardRevision: 7,
          canvasStateRevision: 3,
          selectedNodeIds: [],
          visibleNodeIds: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        }])
        .mockResolvedValueOnce([{ revision: 7 }]),
      boardNode: { findMany: vi.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: vi.fn().mockResolvedValue([]) },
      canvasToolGrant: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      canvasAgentSession: { updateMany: vi.fn() },
    };
    const service = serviceWithTransaction(tx);

    await expect(service.synchronizeClientState("principal_1", "project_1", state)).resolves.toEqual({
      protocol: "workbench.canvas-client-state.v1",
      activeSession: false,
      canvasStateRevision: 4,
    });
    expect(tx.canvasToolGrant.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: "session_1", revokedAt: null },
      data: { revokedAt: databaseNow },
    });
    expect(tx.canvasAgentSession.updateMany).not.toHaveBeenCalled();
  });

  it("accepts only a persisted successful client-command digest as causal state lineage", async () => {
    const scope = authorizedScope();
    const viewport = { x: 20, y: 30, zoom: 1.25 };
    const session = {
      ...scope.session,
      canvasStateRevision: 4,
      viewport,
    };
    const snapshot = {
      ...scope.snapshot,
      canvasStateRevision: 4,
      viewport,
    };
    const findFirst = vi.fn().mockResolvedValue({ id: "acknowledged_invocation" });
    const service = new CanvasAgentService(
      { canvasToolInvocation: { findFirst } } as never,
      new CanvasAgentConfig(new ConfigService({})),
    );
    const verifyLineage = (service as unknown as {
      assertCurrentCanvasStateLineage: (
        grant: CanvasToolCapabilityGrantPayload,
        currentSession: unknown,
        currentSnapshot: unknown,
        toolCallId: string,
      ) => Promise<void>;
    }).assertCurrentCanvasStateLineage.bind(service);

    await expect(verifyLineage(scope.grant, session, snapshot, "next_call")).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        agentSessionId: "session_1",
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: "succeeded",
            canvasStateRevisionAfter: 4,
            canvasStateSha256After: canonicalCanvasStateSha256(snapshot as never),
          }),
          expect.objectContaining({ status: "waiting_client", toolCallId: "next_call" }),
        ]),
      }),
      select: { id: true },
    });

    findFirst.mockResolvedValueOnce(null);
    const failure = await verifyLineage(scope.grant, session, snapshot, "unrelated_call")
      .catch((error: unknown) => error) as { getResponse: () => { code?: string } };
    expect(failure.getResponse().code).toBe("CANVAS_REVISION_MISMATCH");
  });

  it("settles an ACK only after its full Canvas state revision was synchronized", async () => {
    const command = navigateCommand();
    const ack = navigateAck(command);
    const tx = acknowledgementTransaction(command, null, {
      commandStatus: "pending",
      sessionStatus: "active",
    });
    const service = serviceWithTransaction(tx, { locateCommand: true });

    await expect(service.acknowledge("principal_1", "project_1", command.commandId, ack)).resolves.toEqual(ack);
    expect(tx.canvasAgentSession.updateMany).not.toHaveBeenCalled();
    expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "invocation_1", status: "waiting_client" },
      data: expect.objectContaining({
        status: "succeeded",
        canvasStateRevisionAfter: 4,
        canvasStateSha256After: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    }));
    expect(tx.canvasClientCommand.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        acknowledgedCanvasStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    }));
  });

  it("rejects a navigate_canvas ACK whose viewport differs from synchronized state", async () => {
    const command = navigateCommand();
    const ack = navigateAck(command, { x: 99, y: 30, zoom: 1.25 });
    const tx = acknowledgementTransaction(command, null, {
      commandStatus: "pending",
      sessionStatus: "active",
      sessionViewport: { x: 20, y: 30, zoom: 1.25 },
    });
    const service = serviceWithTransaction(tx, { locateCommand: true });

    const failure = await service.acknowledge("principal_1", "project_1", command.commandId, ack)
      .catch((error: unknown) => error) as { getResponse: () => { code?: string } };
    expect(failure.getResponse().code).toBe("CANVAS_ACK_STATE_MISMATCH");
    expect(tx.canvasClientCommand.updateMany).not.toHaveBeenCalled();
    expect(tx.canvasToolInvocation.updateMany).not.toHaveBeenCalled();
  });

  it("requires select_screen ACK output to equal the synchronized selection projection", () => {
    const reference = screenTarget();
    const summary = {
      reference,
      name: "Home",
      route: "/home",
      phase: "complete" as const,
      viewport: { width: 1440, height: 900 },
    };
    const snapshot = {
      ...authorizedScope().snapshot,
      screens: [summary],
      selectedScreens: [reference],
    };
    const screens = new Map([[reference.boardNodeId, { summary }]]);
    const validate = (result: unknown) => (new CanvasAgentService(
      {} as never,
      new CanvasAgentConfig(new ConfigService({})),
    ) as unknown as {
      validateClientResult: (
        toolName: string,
        result: unknown,
        snapshot: unknown,
        screens: Map<string, unknown>,
      ) => void;
    }).validateClientResult("select_screen", result, snapshot, screens);

    expect(() => validate({
      selection: { kind: "single", items: [summary], truncated: false },
    })).not.toThrow();
    try {
      validate({ selection: { kind: "none", items: [], truncated: false } });
      throw new Error("expected select_screen mismatch");
    } catch (error) {
      expect((error as { getResponse: () => { code?: string } }).getResponse().code)
        .toBe("CANVAS_ACK_STATE_MISMATCH");
    }
  });
});

function invocation(
  value: Pick<CanvasAgentToolInvocation, "toolName" | "input">,
): CanvasAgentToolInvocation {
  return canvasAgentToolInvocationSchema.parse({
    protocol: "workbench.canvas-agent-tool.v1",
    toolCallId: "call_1",
    ...value,
  });
}

function authorizedScope() {
  const grant = capabilityGrant();
  const expiresAt = new Date(Date.now() + 60_000);
  return {
    grant,
    session: {
      id: "session_1",
      runtimeAttemptId: "attempt_1",
      runId: "run_1",
      projectId: "project_1",
      threadId: "thread_1",
      principalId: "principal_1",
      boardId: "board_1",
      clientSessionId: "client_123",
      projectSessionGeneration: 2,
      status: "active",
      profile: "edit",
      declaredTools: ["get_selected_screens", "navigate_canvas"],
      declarationHash: "a".repeat(64),
      snapshotSha256: "e".repeat(64),
      boardRevision: 7,
      canvasStateRevision: 3,
      invocationSequence: 1,
      selectedNodeIds: [],
      visibleNodeIds: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      activeMutationToolCallId: null,
      expiresAt,
      grant: null,
    },
    board: {
      id: "board_1",
      projectId: "project_1",
      revision: 7,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    },
    snapshot: {
      protocol: "workbench.canvas-snapshot.v1",
      projectId: "project_1",
      threadId: "thread_1",
      runId: "run_1",
      boardId: "board_1",
      clientSessionId: "client_123",
      projectSessionGeneration: 2,
      boardRevision: 7,
      canvasStateRevision: 3,
      capturedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      viewport: { x: 0, y: 0, zoom: 1 },
      screens: [],
      visibleScreens: [],
      selectedScreens: [],
    },
    screens: new Map(),
  };
}

function capabilityGrant(): CanvasToolCapabilityGrantPayload {
  const now = new Date();
  return {
    grantId: "11111111-1111-4111-8111-111111111111",
    principalId: "principal_1",
    projectId: "project_1",
    threadId: "thread_1",
    runId: "run_1",
    runtimeAttemptId: "attempt_1",
    agentSessionId: "session_1",
    boardId: "board_1",
    snapshotSha256: "e".repeat(64),
    boardRevision: 7,
    canvasStateRevision: 3,
    viewportSha256: canvasToolPayloadSha256({ x: 0, y: 0, zoom: 1 }),
    selectedNodeIdsSha256: canvasToolPayloadSha256([]),
    visibleNodeIdsSha256: canvasToolPayloadSha256([]),
    profile: "edit",
    declarationSha256: "a".repeat(64),
    issuedAt: now,
    notBefore: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };
}

function lockedSession(grant: CanvasToolCapabilityGrantPayload) {
  return {
    status: "active",
    activeMutationToolCallId: null,
    expiresAt: new Date(Date.now() + 60_000),
    boardRevision: 7,
    canvasStateRevision: 3,
    selectedNodeIds: [],
    visibleNodeIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    grantId: grant.grantId,
    grantPayloadSha256: canvasToolCapabilityGrantPayloadSha256(grant),
    grantRevokedAt: null,
    grantExpiresAt: grant.expiresAt,
  };
}

function activeReservationIdentity(overrides: Partial<{
  databaseNow: Date;
  projectStatus: string;
  principalStatus: string;
}> = {}) {
  return {
    databaseNow: new Date(),
    projectStatus: "active",
    principalStatus: "active",
    ...overrides,
  };
}

function reservationMembership(role: "owner" | "editor" | "viewer" = "editor") {
  return { role };
}

function screenTarget() {
  return {
    boardNodeId: "node_1",
    artifactId: "artifact_1",
    artifactVersionId: "version_1",
    screenId: "screen_1",
  };
}

function reserveForTest(
  service: CanvasAgentService,
  scope: unknown,
  request: unknown,
): Promise<unknown> {
  return (service as unknown as {
    reserveInvocation: (scope: unknown, request: unknown, requestHash: string) => Promise<unknown>;
  }).reserveInvocation(scope, request, "b".repeat(64));
}

function rawSqlText(value: unknown): string {
  if (!value || typeof value !== "object" || !("strings" in value)) return "";
  const strings = (value as { strings?: unknown }).strings;
  return Array.isArray(strings) ? strings.join("?") : "";
}

function normalizedRequest(
  toolName: "get_selected_screens" | "navigate_canvas" | "quick_edit",
  input: unknown,
) {
  return canvasAgentToolRequestSchema.parse({
    protocol: "workbench.canvas-agent-tool.v1",
    context: {
      protocol: "workbench.canvas-agent-tool.v1",
      principalId: "principal_1",
      projectId: "project_1",
      threadId: "thread_1",
      runId: "run_1",
      runtimeAttemptId: "attempt_1",
      agentSessionId: "session_1",
      toolCallId: "call_1",
      requestId: "request_1",
      traceId: "trace_1",
      clientSessionId: "client_123",
      projectSessionGeneration: 2,
      boardId: "board_1",
      boardRevision: 7,
      canvasStateRevision: 3,
      declarationSha256: "a".repeat(64),
      capabilities: ["canvas:read", "canvas:interact", "artifact:edit", "run:create"],
    },
    toolName,
    input,
  });
}

function invocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "invocation_1",
    agentSessionId: "session_1",
    grantId: "11111111-1111-4111-8111-111111111111",
    runId: "run_1",
    projectId: "project_1",
    principalId: "principal_1",
    toolCallId: "call_1",
    toolName: "get_selected_screens",
    sequence: 1,
    requestHash: "b".repeat(64),
    request: {},
    status: "in_flight",
    executionAttempt: 1,
    leaseToken: "active_lease",
    leaseExpiresAt: new Date(Date.now() + 30_000),
    boardRevisionBefore: 7,
    boardRevisionAfter: null,
    canvasStateRevisionBefore: 3,
    canvasStateRevisionAfter: null,
    canvasStateSha256Before: canonicalCanvasStateSha256(authorizedScope().snapshot as never),
    canvasStateSha256After: null,
    response: null,
    failureCode: null,
    targetBoardNodeId: null,
    targetArtifactId: null,
    targetArtifactVersionId: null,
    targetScreenId: null,
    resultArtifactVersionId: null,
    ...overrides,
  };
}

function visualCaptureFixture() {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  return {
    protocol: "workbench.canvas-visual-capture.v1" as const,
    visualCapabilityId: "22222222-2222-4222-8222-222222222222",
    mediaType: "image/png" as const,
    byteSize: bytes.byteLength,
    width: 1,
    height: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    dataBase64: bytes.toString("base64"),
  };
}

function visualCaptureBinding() {
  return {
    commandId: "command_1",
    invocationId: "invocation_1",
    agentSessionId: "session_1",
    grantId: "11111111-1111-4111-8111-111111111111",
    projectId: "project_1",
    runId: "run_1",
    principalId: "principal_1",
    target: {
      boardNodeId: "node_1",
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: "screen_1",
    },
    databaseNow: new Date("2026-07-19T00:00:00.000Z"),
  };
}

function pendingVisualCapability(id: string) {
  const binding = visualCaptureBinding();
  return {
    id,
    commandId: binding.commandId,
    invocationId: binding.invocationId,
    agentSessionId: binding.agentSessionId,
    grantId: binding.grantId,
    projectId: binding.projectId,
    runId: binding.runId,
    principalId: binding.principalId,
    targetBoardNodeId: binding.target.boardNodeId,
    targetArtifactId: binding.target.artifactId,
    targetVersionId: binding.target.artifactVersionId,
    targetScreenId: binding.target.screenId,
    status: "pending",
    storageKey: null,
    mediaType: null,
    sha256: null,
    byteSize: null,
    width: null,
    height: null,
    expiresAt: new Date("2026-07-19T00:05:00.000Z"),
    storageDeletedAt: null,
  };
}

function serviceWithTransaction<T extends object>(
  tx: T,
  options: { locateCommand?: boolean } = {},
) {
  const db = {
    $transaction: vi.fn(async (callback: (transaction: T) => unknown) => callback(tx)),
    ...(options.locateCommand ? {
      canvasClientCommand: {
        findUnique: vi.fn().mockResolvedValue({ agentSessionId: "session_1" }),
      },
    } : {}),
  };
  return new CanvasAgentService(
    db as never,
    new CanvasAgentConfig(new ConfigService({})),
  );
}

function navigateCommand(overrides: { expiresAt?: string } = {}) {
  const issuedAt = new Date(Date.now() - 60_000);
  return canvasClientCommandSchema.parse({
    protocol: "workbench.canvas-client-command.v1",
    commandId: "command_1",
    agentSessionId: "session_1",
    toolCallId: "call_1",
    requestId: "request_1",
    projectId: "project_1",
    threadId: "thread_1",
    runId: "run_1",
    boardId: "board_1",
    clientSessionId: "client_123",
    projectSessionGeneration: 2,
    boardRevision: 7,
    expectedCanvasStateRevision: 3,
    issuedAt: issuedAt.toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    kind: "viewport.navigate",
    toolName: "navigate_canvas",
    target: { kind: "selection" },
    behavior: "instant",
  });
}

function navigateAck(
  command: ReturnType<typeof navigateCommand>,
  viewport = { x: 20, y: 30, zoom: 1.25 },
) {
  return canvasClientCommandAckSchema.parse({
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
    canvasStateRevision: 4,
    acknowledgedAt: new Date().toISOString(),
    status: "applied",
    result: { viewport },
    failure: null,
  });
}

function rejectedNavigateAck(command: ReturnType<typeof navigateCommand>) {
  return canvasClientCommandAckSchema.parse({
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
    canvasStateRevision: 4,
    acknowledgedAt: new Date().toISOString(),
    status: "rejected",
    result: null,
    failure: {
      code: "CLIENT_COMMAND_FAILED",
      message: "The Canvas client command failed",
      retryable: false,
    },
  });
}

function clientState(overrides: {
  canvasStateRevision?: number;
  viewport?: { x: number; y: number; zoom: number };
  causedByCommandId?: string;
} = {}) {
  return canvasClientStateSyncRequestSchema.parse({
    protocol: "workbench.canvas-client-state.v1",
    clientSessionId: "client_123",
    projectSessionGeneration: 2,
    boardId: "board_1",
    boardRevision: 7,
    canvasStateRevision: overrides.canvasStateRevision ?? 3,
    viewport: overrides.viewport ?? { x: 0, y: 0, zoom: 1 },
    visibleScreens: [],
    selectedScreens: [],
    ...(overrides.causedByCommandId ? { causedByCommandId: overrides.causedByCommandId } : {}),
  });
}

function causalCommandRow(command: ReturnType<typeof navigateCommand>) {
  return {
    id: command.commandId,
    agentSessionId: command.agentSessionId,
    projectId: command.projectId,
    clientSessionId: command.clientSessionId,
    projectSessionGeneration: command.projectSessionGeneration,
    boardRevision: command.boardRevision,
    canvasStateRevision: command.expectedCanvasStateRevision,
    status: "pending",
    expiresAt: new Date(command.expiresAt),
    command,
    invocation: {
      status: "waiting_client",
      agentSessionId: command.agentSessionId,
      canvasStateRevisionBefore: command.expectedCanvasStateRevision,
    },
  };
}

function acknowledgementTransaction(
  command: ReturnType<typeof navigateCommand>,
  persistedAck: ReturnType<typeof navigateAck> | null,
  options: {
    commandStatus: "pending" | "acknowledged" | "cancelled";
    sessionStatus: "active" | "completed" | "cancelled";
    commandExpiresAt?: Date;
    sessionViewport?: { x: number; y: number; zoom: number };
  },
) {
  const invocation = invocationRow({
    status: "waiting_client",
    leaseToken: null,
    leaseExpiresAt: null,
    toolName: "navigate_canvas",
  });
  const current = {
    id: command.commandId,
    agentSessionId: command.agentSessionId,
    invocationId: invocation.id,
    projectId: command.projectId,
    threadId: command.threadId,
    runId: command.runId,
    clientSessionId: command.clientSessionId,
    projectSessionGeneration: command.projectSessionGeneration,
    toolCallId: command.toolCallId,
    status: options.commandStatus,
    boardRevision: command.boardRevision,
    canvasStateRevision: command.expectedCanvasStateRevision,
    expectedCanvasStateSha256: invocation.canvasStateSha256Before,
    acknowledgedCanvasStateSha256: options.commandStatus === "acknowledged"
      ? invocation.canvasStateSha256Before
      : null,
    command,
    acknowledgement: persistedAck,
    expiresAt: options.commandExpiresAt ?? new Date(command.expiresAt),
    invocation,
    agentSession: {
      id: command.agentSessionId,
      runtimeAttemptId: "attempt_1",
      runId: command.runId,
      projectId: command.projectId,
      threadId: command.threadId,
      principalId: "principal_1",
      boardId: command.boardId,
      clientSessionId: command.clientSessionId,
      projectSessionGeneration: command.projectSessionGeneration,
      status: options.sessionStatus,
      profile: "edit",
      declaredTools: ["navigate_canvas"],
      declarationHash: "a".repeat(64),
      snapshotSha256: "e".repeat(64),
      boardRevision: command.boardRevision,
      canvasStateRevision: 4,
      invocationSequence: 1,
      selectedNodeIds: [],
      visibleNodeIds: [],
      viewport: options.sessionViewport ?? { x: 20, y: 30, zoom: 1.25 },
      activeMutationToolCallId: null,
      expiresAt: new Date(Date.now() + 60_000),
      grant: {
        id: "11111111-1111-4111-8111-111111111111",
        payloadSha256: "f".repeat(64),
        declarationHash: "a".repeat(64),
        snapshotSha256: "e".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    },
  };
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([activeReservationIdentity()])
      .mockResolvedValueOnce([reservationMembership()])
      .mockResolvedValueOnce([{ id: command.agentSessionId }])
      .mockResolvedValueOnce([{ id: command.commandId }])
      .mockResolvedValueOnce([{ id: command.boardId }]),
    canvasClientCommand: {
      findUnique: vi.fn().mockResolvedValue(current),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    board: {
      findUnique: vi.fn().mockResolvedValue({
        id: command.boardId,
        projectId: command.projectId,
        revision: command.boardRevision,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
      }),
    },
    artifactVersion: { findMany: vi.fn().mockResolvedValue([]) },
    canvasAgentSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    canvasToolInvocation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    canvasToolGrant: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}
