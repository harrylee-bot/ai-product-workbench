import { createHash, randomUUID } from "node:crypto";

import {
  canvasAgentToolDeclarationContextSchema,
  canvasAgentToolReferenceSchema,
  canvasSnapshotSchema,
  canonicalJson,
  declareCanvasAgentTools,
  prototypeDocumentSchema,
  type CanvasAgentToolDescriptor,
  type CanvasSnapshot,
  type StartRunRequest,
} from "@workbench/workbench-contracts";
import {
  canvasToolCapabilityGrantPayloadSha256,
  createCanvasToolCapabilityGrant,
  type CanvasToolCapabilityGrantPayload,
} from "@workbench/workbench-canvas-tools";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import type { WorkerConfig } from "../config.js";
import { lockRunStatus } from "../runs/run-state-lock.js";

const SESSION_TTL_SAFETY_MS = 1_000;

export type CanvasToolGrantScope = {
  readonly runId: string;
  readonly runtimeAttemptId: string;
  readonly attempt: number;
  readonly principalId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly modelId: string;
  readonly workflow: StartRunRequest["workflow"];
  readonly artifactTargets: StartRunRequest["artifactTargets"];
  readonly snapshot: CanvasSnapshot | null;
};

export interface CanvasToolGrantIssuer {
  issue(scope: CanvasToolGrantScope): Promise<CanvasAgentToolDescriptor | null>;
}

/**
 * Creates the short-lived grant only after the RuntimeAttempt and the client
 * snapshot have been checked against authoritative Board/Artifact rows.
 */
export class PrismaCanvasToolGrantIssuer implements CanvasToolGrantIssuer {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: WorkerConfig["canvasTool"],
  ) {}

  async issue(scope: CanvasToolGrantScope): Promise<CanvasAgentToolDescriptor | null> {
    // A Canvas snapshot is captured once when the Run is created and is only
    // authoritative for that first attempt. Approval resumes start a new
    // attempt after an arbitrary delay, so reusing it would either fail on its
    // short TTL/revision fence or mint a capability over stale client state.
    if (!scope.snapshot || scope.attempt > 1) return null;
    if (!this.config) throw new Error("CANVAS_TOOL_NOT_CONFIGURED");
    const snapshot = canvasSnapshotSchema.parse(scope.snapshot);
    const snapshotSha256 = canonicalCanvasSnapshotSha256(snapshot);
    const now = floorToSecond(new Date());
    if (Date.parse(snapshot.expiresAt) <= now.getTime()) {
      throw new Error("CANVAS_SNAPSHOT_EXPIRED");
    }

    const issued = await this.db.$transaction(async (tx) => {
      if (await lockRunStatus(tx, scope.runId) !== "running") {
        throw new Error("CANVAS_TOOL_SCOPE_INVALID");
      }
      const [run, board, attempt] = await Promise.all([
        tx.run.findUnique({
          where: { id: scope.runId },
          select: { id: true, projectId: true, threadId: true, createdById: true, status: true },
        }),
        tx.board.findUnique({
          where: { projectId: scope.projectId },
          include: { nodes: true },
        }),
        tx.runtimeAttempt.findUnique({
          where: { id: scope.runtimeAttemptId },
          select: { id: true, runId: true, attempt: true, status: true },
        }),
      ]);
      if (
        !run
        || run.id !== scope.runId
        || run.projectId !== scope.projectId
        || run.threadId !== scope.threadId
        || run.createdById !== scope.principalId
        || run.status !== "running"
      ) throw new Error("CANVAS_TOOL_SCOPE_INVALID");
      if (
        !attempt
        || attempt.runId !== scope.runId
        || attempt.attempt !== scope.attempt
        || !["pending", "submitting", "running"].includes(attempt.status)
      ) throw new Error("CANVAS_TOOL_ATTEMPT_INVALID");
      if (!board || board.id !== snapshot.boardId || board.projectId !== scope.projectId) {
        throw new Error("CANVAS_TOOL_BOARD_INVALID");
      }
      if (
        snapshot.projectId !== scope.projectId
        || snapshot.threadId !== scope.threadId
        || (snapshot.runId !== null && snapshot.runId !== scope.runId)
        || snapshot.boardRevision !== board.revision
      ) {
        throw new Error("CANVAS_SNAPSHOT_STALE");
      }

      const authoritative = await authoritativeScreens(tx, scope.projectId, board.nodes);
      const byKey = new Map(authoritative.map((screen) => [screen.key, screen]));
      const snapshotKeys = snapshot.screens.map((screen) => screenKey(screen.reference));
      const selectedKeys = snapshot.selectedScreens.map(screenKey);
      const visibleKeys = snapshot.visibleScreens.map(screenKey);
      if (
        snapshotKeys.some((key) => !byKey.has(key))
        || selectedKeys.some((key) => !byKey.has(key))
        || visibleKeys.some((key) => !byKey.has(key))
      ) throw new Error("CANVAS_SNAPSHOT_REFERENCE_INVALID");

      const selected = selectedKeys.map((key) => byKey.get(key)!);
      const selectedEditable = selected.length === 1
        && selected[0]!.kind === "prototype"
        && selected[0]!.phase === "complete"
        && scope.workflow === "edit"
        && scope.artifactTargets.length === 1
        && scope.artifactTargets[0]!.artifactId === selected[0]!.artifactId
        && scope.artifactTargets[0]!.artifactVersionId === selected[0]!.artifactVersionId
        && scope.artifactTargets[0]!.screenIds.length === 1
        && scope.artifactTargets[0]!.screenIds[0] === selected[0]!.screenId;
      const activeMutation = await tx.canvasAgentSession.count({
        where: {
          projectId: scope.projectId,
          status: "active",
          activeMutationToolCallId: { not: null },
          runtimeAttemptId: { not: scope.runtimeAttemptId },
        },
      }) > 0;
      const capabilities = ["canvas:read", "canvas:interact"] as const;
      const declarationContext = canvasAgentToolDeclarationContextSchema.parse({
        capabilities: scope.workflow === "edit"
          ? [...capabilities, "artifact:edit", "run:create"]
          : [...capabilities],
        hasFreshSnapshot: true,
        screenCount: authoritative.length,
        selectedScreenCount: selected.length,
        selectedScreenEditable: selectedEditable,
        activeMutation,
        editModelAvailable: scope.workflow === "edit" && scope.modelId.length > 0,
      });
      const declarations = declareCanvasAgentTools(declarationContext);
      const declaredTools = declarations.map((tool) => tool.toolName);
      const declarationSha256 = sha256(canonicalJson(declaredTools));
      const profile = selected.length > 1
        ? "multi"
        : selectedEditable
          ? "edit"
          : authoritative.length === 0
            ? "zero"
            : "read";
      const selectedNodeIds = selected.map((screen) => screen.boardNodeId);
      const visibleNodeIds = visibleKeys.map((key) => byKey.get(key)!.boardNodeId);
      const capabilitySnapshot = {
        snapshotSha256,
        boardRevision: snapshot.boardRevision,
        canvasStateRevision: snapshot.canvasStateRevision,
        viewportSha256: sha256(canonicalJson(snapshot.viewport)),
        selectedNodeIdsSha256: sha256(canonicalJson(selectedNodeIds)),
        visibleNodeIdsSha256: sha256(canonicalJson(visibleNodeIds)),
        profile,
      } as const;
      const expiresAt = new Date(Math.min(
        Date.parse(snapshot.expiresAt) - SESSION_TTL_SAFETY_MS,
        now.getTime() + this.config!.maximumTtlSeconds * 1_000,
      ));
      if (expiresAt.getTime() <= now.getTime()) throw new Error("CANVAS_TOOL_GRANT_EXPIRY_INVALID");

      const existing = await tx.canvasAgentSession.findUnique({
        where: { runtimeAttemptId: scope.runtimeAttemptId },
        include: { grant: true },
      });
      if (existing) {
        assertExistingSession(existing, scope, snapshot, {
          declarationSha256,
          declaredTools,
          profile,
          selectedNodeIds,
          snapshotSha256,
          visibleNodeIds,
        });
        if (!existing.grant || existing.grant.expiresAt <= now || existing.grant.revokedAt) {
          throw new Error("CANVAS_TOOL_GRANT_EXPIRED");
        }
        if (existing.grant.snapshotSha256 !== snapshotSha256) {
          throw new Error("CANVAS_AGENT_SESSION_SCOPE_CONFLICT");
        }
        const replayPayload: CanvasToolCapabilityGrantPayload = {
          grantId: existing.grant.id,
          principalId: scope.principalId,
          projectId: scope.projectId,
          threadId: scope.threadId,
          runId: scope.runId,
          runtimeAttemptId: scope.runtimeAttemptId,
          agentSessionId: existing.id,
          boardId: existing.boardId,
          ...capabilitySnapshot,
          declarationSha256,
          issuedAt: existing.grant.issuedAt,
          notBefore: existing.grant.issuedAt,
          expiresAt: existing.grant.expiresAt,
        };
        if (existing.grant.payloadSha256 !== canvasToolCapabilityGrantPayloadSha256(replayPayload)) {
          throw new Error("CANVAS_TOOL_GRANT_PAYLOAD_CONFLICT");
        }
        return {
          session: existing,
          grant: existing.grant,
          capabilitySnapshot,
          declaredTools,
          declarationSha256,
          selectedNodeIds,
          visibleNodeIds,
          expiresAt: existing.expiresAt,
        };
      }

      const agentSessionId = randomUUID();
      const grantId = randomUUID();
      const payload: CanvasToolCapabilityGrantPayload = {
        grantId,
        principalId: scope.principalId,
        projectId: scope.projectId,
        threadId: scope.threadId,
        runId: scope.runId,
        runtimeAttemptId: scope.runtimeAttemptId,
        agentSessionId,
        boardId: board.id,
        ...capabilitySnapshot,
        declarationSha256,
        issuedAt: now,
        notBefore: now,
        expiresAt,
      };
      const payloadSha256 = canvasToolCapabilityGrantPayloadSha256(payload);
      const session = await tx.canvasAgentSession.create({
        data: {
          id: agentSessionId,
          runtimeAttemptId: scope.runtimeAttemptId,
          runId: scope.runId,
          projectId: scope.projectId,
          threadId: scope.threadId,
          principalId: scope.principalId,
          boardId: board.id,
          clientSessionId: snapshot.clientSessionId,
          projectSessionGeneration: snapshot.projectSessionGeneration,
          status: "active",
          profile,
          declaredTools: declaredTools as Prisma.InputJsonArray,
          declarationHash: declarationSha256,
          snapshotSha256,
          boardRevision: board.revision,
          canvasStateRevision: snapshot.canvasStateRevision,
          viewport: snapshot.viewport,
          selectedNodeIds: selectedNodeIds as Prisma.InputJsonArray,
          visibleNodeIds: visibleNodeIds as Prisma.InputJsonArray,
          expiresAt,
        },
      });
      const grant = await tx.canvasToolGrant.create({
        data: {
          id: grantId,
          agentSessionId: session.id,
          payloadSha256,
          declarationHash: declarationSha256,
          snapshotSha256,
          issuedAt: now,
          expiresAt,
        },
      });
      return {
        session,
        grant,
        capabilitySnapshot,
        declaredTools,
        declarationSha256,
        selectedNodeIds,
        visibleNodeIds,
        expiresAt,
      };
    });

    const token = createCanvasToolCapabilityGrant({
      grantId: issued.grant.id,
      principalId: scope.principalId,
      projectId: scope.projectId,
      threadId: scope.threadId,
      runId: scope.runId,
      runtimeAttemptId: scope.runtimeAttemptId,
      agentSessionId: issued.session.id,
      boardId: issued.session.boardId,
      ...issued.capabilitySnapshot,
      declarationSha256: issued.declarationSha256,
      issuedAt: issued.grant.issuedAt,
      notBefore: issued.grant.issuedAt,
      expiresAt: issued.grant.expiresAt,
    }, this.config.secret, {
      now,
      maximumTtlSeconds: this.config.maximumTtlSeconds,
    });
    return {
      protocol: "workbench.canvas-agent-tool-descriptor.v1",
      endpoint: this.config.endpoint,
      visualEndpoint: this.config.visualEndpoint,
      token,
      expiresAt: issued.grant.expiresAt.toISOString(),
      reference: canvasAgentToolReferenceSchema.parse({
        protocol: "workbench.canvas-agent-tool-reference.v1",
        declarationRevision: issued.session.canvasStateRevision,
        declarationSha256: issued.declarationSha256,
        declaredTools: issued.declaredTools,
      }),
    };
  }
}

type AuthoritativeScreen = {
  key: string;
  boardNodeId: string;
  artifactId: string;
  artifactVersionId: string;
  screenId: string;
  kind: "prototype" | "other";
  phase: "generating" | "complete";
};

async function authoritativeScreens(
  tx: Prisma.TransactionClient,
  projectId: string,
  nodes: Array<{
    id: string;
    nodeKey: string;
    artifactId: string | null;
    artifactVersionId: string | null;
    data: Prisma.JsonValue;
    kind: string;
  }>,
): Promise<AuthoritativeScreen[]> {
  const references = nodes.flatMap((node) => {
    const data = asRecord(node.data);
    const screenId = typeof data?.screenId === "string" ? data.screenId : null;
    if (!screenId || !node.artifactId || !node.artifactVersionId || node.kind !== "artifact") return [];
    return [{ node, screenId }];
  });
  if (references.length === 0) return [];
  const versions = await tx.artifactVersion.findMany({
    where: {
      projectId,
      id: { in: [...new Set(references.map(({ node }) => node.artifactVersionId!))] },
      status: { in: ["ready", "staging"] },
    },
    include: { artifact: { select: { kind: true } } },
  });
  const byVersion = new Map(versions.map((version) => [version.id, version]));
  const output: AuthoritativeScreen[] = [];
  for (const { node, screenId } of references) {
    const version = byVersion.get(node.artifactVersionId!);
    if (!version || version.artifactId !== node.artifactId || version.contentBlobId !== null) continue;
    if (version.artifact.kind !== "prototype") {
      output.push({
        key: screenKey({ boardNodeId: node.nodeKey, artifactId: node.artifactId!, artifactVersionId: node.artifactVersionId!, screenId }),
        boardNodeId: node.nodeKey,
        artifactId: node.artifactId!,
        artifactVersionId: node.artifactVersionId!,
        screenId,
        kind: "other",
        phase: version.status === "ready" ? "complete" : "generating",
      });
      continue;
    }
    const document = prototypeDocumentSchema.safeParse(version.content);
    const screen = document.success ? document.data.screens.find((candidate) => candidate.id === screenId) : undefined;
    if (!screen) continue;
    output.push({
      key: screenKey({ boardNodeId: node.nodeKey, artifactId: node.artifactId!, artifactVersionId: node.artifactVersionId!, screenId }),
      boardNodeId: node.nodeKey,
      artifactId: node.artifactId!,
      artifactVersionId: node.artifactVersionId!,
      screenId,
      kind: "prototype",
      phase: version.status === "ready" ? "complete" : "generating",
    });
  }
  return output;
}

function assertExistingSession(
  session: {
    runId: string;
    projectId: string;
    threadId: string;
    principalId: string;
    boardId: string;
    clientSessionId: string;
    projectSessionGeneration: number;
    profile: string;
    declarationHash: string;
    declaredTools: Prisma.JsonValue;
    snapshotSha256: string;
    boardRevision: number;
    canvasStateRevision: number;
    selectedNodeIds: Prisma.JsonValue;
    visibleNodeIds: Prisma.JsonValue;
    viewport: Prisma.JsonValue;
    expiresAt: Date;
  },
  scope: CanvasToolGrantScope,
  snapshot: CanvasSnapshot,
  expected: {
    declarationSha256: string;
    declaredTools: readonly string[];
    profile: string;
    selectedNodeIds: readonly string[];
    snapshotSha256: string;
    visibleNodeIds: readonly string[];
  },
) {
  if (
    session.runId !== scope.runId
    || session.projectId !== scope.projectId
    || session.threadId !== scope.threadId
    || session.principalId !== scope.principalId
    || session.boardId !== snapshot.boardId
    || session.clientSessionId !== snapshot.clientSessionId
    || session.projectSessionGeneration !== snapshot.projectSessionGeneration
    || session.snapshotSha256 !== expected.snapshotSha256
    || session.boardRevision !== snapshot.boardRevision
    || session.canvasStateRevision !== snapshot.canvasStateRevision
    || canonicalJson(session.viewport) !== canonicalJson(snapshot.viewport)
    || canonicalJson(session.selectedNodeIds) !== canonicalJson(expected.selectedNodeIds)
    || canonicalJson(session.visibleNodeIds) !== canonicalJson(expected.visibleNodeIds)
    || session.profile !== expected.profile
    || session.declarationHash !== expected.declarationSha256
    || canonicalJson(session.declaredTools) !== canonicalJson(expected.declaredTools)
  ) throw new Error("CANVAS_AGENT_SESSION_SCOPE_CONFLICT");
}

export function canonicalCanvasSnapshotSha256(snapshot: CanvasSnapshot): string {
  return sha256(canonicalJson(canvasSnapshotSchema.parse(snapshot)));
}

function screenKey(reference: { boardNodeId: string; artifactId: string; artifactVersionId: string; screenId: string }): string {
  return [reference.boardNodeId, reference.artifactId, reference.artifactVersionId, reference.screenId].join("\u0000");
}

function asRecord(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function floorToSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}
