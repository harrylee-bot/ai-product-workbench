import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  runEventSchema,
  type RunEvent,
} from "@workbench/workbench-contracts";

type EventType = RunEvent["type"];

@Injectable()
export class RunEventStore {
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
    payload: publicRunEventPayload(event.type, event.payload),
  });
}

export function publicRunEventPayload(type: string, payload: unknown) {
  if (type !== "run.failed" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const code = (payload as Record<string, unknown>).code;
  return typeof code === "string"
    ? { ...payload, message: code }
    : payload;
}
