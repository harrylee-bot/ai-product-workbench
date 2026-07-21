import {
  canonicalJson,
  runEventSchema,
  runEventSourceIdSchema,
  type RunEvent,
} from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";

export class RunEventStore {
  constructor(private readonly db: PrismaClient) {}

  async append(
    tx: Prisma.TransactionClient,
    runId: string,
    type: RunEvent["type"],
    payload: unknown,
  ) {
    return this.appendNew(tx, runId, type, payload, null);
  }

  async appendOnce(
    tx: Prisma.TransactionClient,
    runId: string,
    type: RunEvent["type"],
    payload: unknown,
    sourceId: string,
  ) {
    const parsedSourceId = runEventSourceIdSchema.safeParse(sourceId);
    if (!parsedSourceId.success) throw new Error("RUN_EVENT_SOURCE_ID_INVALID");
    sourceId = parsedSourceId.data;
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "runs" WHERE "id" = ${runId} FOR UPDATE
    `);
    if (locked.length !== 1) throw new Error(`RUN_NOT_FOUND:${runId}`);
    const existing = await tx.runEvent.findFirst({
      where: { runId, sourceId },
      include: { run: true },
    });
    if (existing) {
      if (existing.type !== type || canonicalJson(existing.payload) !== canonicalJson(payload)) {
        throw new Error("RUN_EVENT_SOURCE_CONFLICT");
      }
      return { created: false, event: parseRunEvent(existing.run, existing) };
    }
    return {
      created: true,
      event: await this.appendNew(tx, runId, type, payload, sourceId),
    };
  }

  private async appendNew(
    tx: Prisma.TransactionClient,
    runId: string,
    type: RunEvent["type"],
    payload: unknown,
    sourceId: string | null,
  ) {
    const run = await tx.run.update({
      where: { id: runId },
      data: { eventSequence: { increment: 1 } },
    });
    const event = await tx.runEvent.create({
      data: {
        runId,
        sourceId,
        sequence: run.eventSequence,
        type,
        payload: payload as Prisma.InputJsonValue,
        traceId: run.traceId,
      },
    });
    return parseRunEvent(run, event);
  }
}

function parseRunEvent(
  run: {
    id: string;
    projectId: string;
    threadId: string;
    requestId: string;
    traceId: string;
  },
  event: {
    id: string;
    sequence: number;
    type: string;
    occurredAt: Date;
    payload: Prisma.JsonValue;
  },
) {
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
