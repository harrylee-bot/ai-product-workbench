import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  runEventSchema,
  type RunEvent,
} from "@workbench/workbench-contracts";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";

type EventType = RunEvent["type"];

@Injectable()
export class RunEventStore {
  constructor(private readonly db: WorkbenchDbService) {}

  async append(
    tx: Prisma.TransactionClient,
    runId: string,
    type: EventType,
    payload: unknown,
  ): Promise<RunEvent> {
    const run = await tx.run.update({
      where: { id: runId },
      data: { eventSequence: { increment: 1 } },
    });
    const event = await tx.runEvent.create({
      data: {
        runId,
        sequence: run.eventSequence,
        type,
        payload: payload as Prisma.InputJsonValue,
        traceId: run.traceId,
      },
    });
    return toRunEvent(run, event);
  }

  async listAfter(runId: string, afterSequence: number, limit = 100): Promise<RunEvent[]> {
    const events = await this.db.runEvent.findMany({
      where: { runId, sequence: { gt: afterSequence } },
      include: { run: true },
      orderBy: { sequence: "asc" },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return events.map((event) => toRunEvent(event.run, event));
  }
}

function toRunEvent(
  run: {
    id: string;
    requestId: string;
    projectId: string;
    threadId: string;
    traceId: string;
  },
  event: {
    id: string;
    sequence: number;
    type: string;
    payload: unknown;
    occurredAt: Date;
  },
): RunEvent {
  return runEventSchema.parse({
    protocol: "workbench.run.v1",
    id: event.id,
    projectId: run.projectId,
    threadId: run.threadId,
    runId: run.id,
    requestId: run.requestId,
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    traceId: run.traceId,
    payload: event.payload,
  });
}
