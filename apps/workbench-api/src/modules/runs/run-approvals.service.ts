import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import type {
  RunApproval,
  RunApprovalList,
  SubmitApprovalRequest,
  SubmitApprovalResponse,
} from "@workbench/workbench-contracts";
import { runtimeExecuteQueue } from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  approvalStateConflictProblem,
  idempotencyConflictProblem,
  notFoundProblem,
  runStateConflictProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { WorkbenchQueueService } from "../../platform/queue/workbench-queue.service.js";
import { AccessService } from "../access/access.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { mapRunApproval } from "./run-approval.mapper.js";
import { RunEventStore } from "./run-event.store.js";
import { mapRun, orderedRunSourceSnapshots } from "./run.mapper.js";

@Injectable()
export class RunApprovalsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
    private readonly events: RunEventStore,
    private readonly queue: WorkbenchQueueService,
  ) {}

  async list(principalId: string, runId: string): Promise<RunApprovalList> {
    await this.access.findRun(principalId, runId, "read");
    const approvals = await this.db.runApproval.findMany({
      where: { runId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return { items: approvals.map(mapRunApproval) };
  }

  async get(principalId: string, runId: string, approvalId: string): Promise<RunApproval> {
    await this.access.findRun(principalId, runId, "read");
    const approval = await this.db.runApproval.findFirst({
      where: { id: approvalId, runId },
    });
    if (!approval) throw notFoundProblem("Run approval");
    return mapRunApproval(approval);
  }

  async submit(
    principalId: string,
    runId: string,
    approvalId: string,
    idempotencyKey: string,
    request: SubmitApprovalRequest,
  ): Promise<SubmitApprovalResponse> {
    validateIdempotencyKey(idempotencyKey);
    const authorized = await this.access.findRun(principalId, runId, "edit");
    const requestHash = hashRequest(request);

    const existing = await this.db.runApproval.findFirst({
      where: { id: approvalId, runId },
      include: { run: { include: { sourceSnapshots: orderedRunSourceSnapshots } } },
    });
    if (!existing) throw notFoundProblem("Run approval");
    if (existing.status !== "pending") {
      return this.resolveExistingDecision(existing, idempotencyKey, requestHash);
    }

    return this.db.$transaction(async (tx) => {
      await lockActiveProject(tx, authorized.projectId, principalId, "edit");
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "runs" WHERE "id" = ${runId} FOR UPDATE`);
      const current = await tx.runApproval.findFirst({
        where: { id: approvalId, runId },
        include: { run: { include: { sourceSnapshots: orderedRunSourceSnapshots } } },
      });
      if (!current) throw notFoundProblem("Run approval");
      if (current.status !== "pending") {
        return this.resolveExistingDecision(current, idempotencyKey, requestHash);
      }
      if (current.run.status !== "waiting_input") throw runStateConflictProblem(current.run.status);

      const updated = await tx.runApproval.updateMany({
        where: { id: approvalId, runId, status: "pending" },
        data: {
          status: approvalStatusForDecision(request.decision),
          response: approvalResponse(request),
          decidedById: principalId,
          decidedAt: new Date(),
          decisionIdempotencyKey: idempotencyKey,
          decisionRequestHash: requestHash,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        const raced = await tx.runApproval.findFirst({
          where: { id: approvalId, runId },
          include: { run: { include: { sourceSnapshots: orderedRunSourceSnapshots } } },
        });
        if (!raced) throw notFoundProblem("Run approval");
        return this.resolveExistingDecision(raced, idempotencyKey, requestHash);
      }

      await this.events.append(tx, runId, "run.input.submitted", {
        approvalId,
        decision: request.decision,
      });

      const cycleApprovals = await tx.runApproval.findMany({
        where: { runId, attempt: current.run.attempt },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (cycleApprovals.some((approval) => approval.status === "expired")) {
        throw approvalStateConflictProblem("expired");
      }
      if (cycleApprovals.every((approval) => approval.status !== "pending")) {
        const queued = await tx.run.updateMany({
          where: { id: runId, status: "waiting_input" },
          data: { status: "queued" },
        });
        if (queued.count !== 1) {
          const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
          throw runStateConflictProblem(run.status);
        }
        await this.events.append(tx, runId, "run.queued", { position: null });
        await this.queue.sendInTransaction(tx, runtimeExecuteQueue, {
          runId,
          approvalIds: cycleApprovals.map((approval) => approval.id),
        }, {
          singletonKey: `${runId}:resume:${current.run.attempt}`,
          group: { id: current.run.threadId },
        });
      }
      const [approval, run] = await Promise.all([
        tx.runApproval.findUniqueOrThrow({ where: { id: approvalId } }),
        tx.run.findUniqueOrThrow({
          where: { id: runId },
          include: { sourceSnapshots: orderedRunSourceSnapshots },
        }),
      ]);
      return { approval: mapRunApproval(approval), run: mapRun(run) };
    });
  }

  private resolveExistingDecision(
    approval: Parameters<typeof mapRunApproval>[0] & {
      decisionIdempotencyKey: string | null;
      decisionRequestHash: string | null;
      run: Parameters<typeof mapRun>[0];
    },
    idempotencyKey: string,
    requestHash: string,
  ): SubmitApprovalResponse {
    if (approval.decisionIdempotencyKey === idempotencyKey) {
      if (approval.decisionRequestHash !== requestHash) throw idempotencyConflictProblem();
      return { approval: mapRunApproval(approval), run: mapRun(approval.run) };
    }
    throw approvalStateConflictProblem(approval.status);
  }
}

function approvalStatusForDecision(decision: SubmitApprovalRequest["decision"]) {
  if (decision === "approve") return "approved" as const;
  if (decision === "reject") return "rejected" as const;
  return "submitted" as const;
}

export function approvalResponse(request: SubmitApprovalRequest): Prisma.InputJsonObject {
  return {
    decision: request.decision,
    ...(request.value === undefined ? {} : { value: request.value }),
  };
}
