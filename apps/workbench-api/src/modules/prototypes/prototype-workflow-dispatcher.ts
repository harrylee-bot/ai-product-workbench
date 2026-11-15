import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import type { PrototypeWorkflowClientPort } from "./prototype-v2.service.js";

/** Delivery is at least once. Workflow ids are bound to command ids at the gateway. */
export class PrototypeWorkflowDispatcher {
  constructor(private readonly db: Pick<PrismaClient, "prototypeWorkflowCommand" | "$transaction">, private readonly workflows: PrototypeWorkflowClientPort) {}

  async deliver(projectId?: string): Promise<void> {
    if (!this.workflows.configured) return;
    const candidates = await this.db.prototypeWorkflowCommand.findMany({
      where: { ...(projectId ? { projectId } : {}), deliveredAt: null, availableAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
      orderBy: { sequence: "asc" }, take: 20,
    });
    for (const row of candidates) {
      const leaseUntil = new Date(Date.now() + 60_000);
      const claimed = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prototype-command:${row.targetId}`}, 0))`);
        const earlier = await tx.prototypeWorkflowCommand.findFirst({ where: { targetId: row.targetId, deliveredAt: null, sequence: { lt: row.sequence } } });
        if (earlier) return false;
        const result = await tx.prototypeWorkflowCommand.updateMany({ where: { id: row.id, deliveredAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil, attempts: { increment: 1 } } });
        return result.count === 1;
      });
      if (!claimed) continue;
      const payload = row.payload as unknown as Record<string, string>;
      try {
        let result: unknown;
        if (row.kind === "plan_start") await this.workflows.startPlan({ projectId: row.projectId, planId: row.targetId, principalId: payload.principalId });
        else if (row.kind === "plan_cancel") await this.workflows.cancelPlan({ projectId: row.projectId, planId: row.targetId });
        else if (row.kind === "export_start") await this.workflows.startExport({ projectId: row.projectId, exportId: row.targetId, revisionId: payload.revisionId, format: payload.format as "html" | "react", commandId: row.id });
        else if (row.kind === "export_cancel") await this.workflows.cancelExport({ projectId: row.projectId, exportId: row.targetId, commandId: payload.commandId });
        else if (row.kind === "share_create") {
          if (!this.workflows.executeShareCreate) throw new Error("TEMPORAL_SHARE_UNAVAILABLE");
          result = await this.workflows.executeShareCreate({ projectId: row.projectId, revisionId: payload.revisionId, createdById: payload.principalId, tokenHash: payload.tokenHash, idempotencyKey: payload.idempotencyKey, requestHash: payload.requestHash, expiresAt: payload.expiresAt || null });
        } else if (row.kind === "share_revoke") {
          if (!this.workflows.executeShareRevoke) throw new Error("TEMPORAL_SHARE_UNAVAILABLE");
          result = await this.workflows.executeShareRevoke({ projectId: row.projectId, shareId: row.targetId, expectedRevision: Number(payload.expectedRevision), idempotencyKey: payload.idempotencyKey, commandId: row.id, createdById: payload.principalId });
        } else throw new Error("PROTOTYPE_COMMAND_UNKNOWN");
        await this.db.prototypeWorkflowCommand.updateMany({ where: { id: row.id, leaseUntil }, data: { deliveredAt: new Date(), leaseUntil: null, lastErrorCode: null, ...(result === undefined ? {} : { result: result as Prisma.InputJsonValue }) } });
      } catch {
        // A lost acknowledgement is ambiguous: never set the business object to
        // failed. Replay the same durable command after restart / transient failure.
        await this.db.prototypeWorkflowCommand.updateMany({ where: { id: row.id, leaseUntil }, data: { leaseUntil: null, availableAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 6))), lastErrorCode: "TEMPORAL_DELIVERY_PENDING" } });
      }
    }
  }
}

export async function enqueuePrototypeCommand(tx: Prisma.TransactionClient, projectId: string, targetId: string, kind: "plan_start" | "plan_cancel" | "export_start" | "export_cancel", payload: Record<string, string>): Promise<string> {
  const id = `prototype_command_${randomUUID().replaceAll("-", "")}`;
  await tx.prototypeWorkflowCommand.create({ data: { id, projectId, targetId, kind, payload } });
  return id;
}
