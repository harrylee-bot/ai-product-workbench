import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import { runtimeExecuteQueue } from "@workbench/workbench-contracts";

type RuntimeExecuteQueueSender = {
  send(
    name: typeof runtimeExecuteQueue,
    data: { runId: string },
    options: { singletonKey: string },
  ): Promise<string | null>;
};

export class RuntimeExecutionReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly queue: RuntimeExecuteQueueSender,
    private readonly batchSize: number,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch(this.onError), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT run."id"
        FROM "runs" AS run
        WHERE run."status" = 'running'
          AND (
            run."execution_owner_id" IS NULL
            OR run."execution_lease_expires_at" <= CURRENT_TIMESTAMP
          )
        ORDER BY run."execution_lease_expires_at" ASC NULLS FIRST, run."id" ASC
        LIMIT ${this.batchSize}
      `);
      for (const candidate of candidates) {
        try {
          await this.queue.send(
            runtimeExecuteQueue,
            { runId: candidate.id },
            { singletonKey: candidate.id },
          );
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
