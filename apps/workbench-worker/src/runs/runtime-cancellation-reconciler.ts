import { runtimeCancelQueue } from "@workbench/workbench-contracts";
import type { PrismaClient } from "@workbench/workbench-db";
import { recordRuntimeLivenessMetric } from "@workbench/workbench-telemetry";

type RuntimeCancelQueueSender = {
  send(
    name: typeof runtimeCancelQueue,
    data: { runId: string },
    options: { singletonKey: string },
  ): Promise<string | null>;
};

export class RuntimeCancellationReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly queue: RuntimeCancelQueueSender,
    private readonly staleMs: number,
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
      const candidates = await this.db.run.findMany({
        where: {
          status: "cancelling",
          updatedAt: { lte: new Date(Date.now() - this.staleMs) },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: this.batchSize,
        select: { id: true },
      });
      for (const candidate of candidates) {
        const startedAt = performance.now();
        try {
          const jobId = await this.queue.send(
            runtimeCancelQueue,
            { runId: candidate.id },
            { singletonKey: candidate.id },
          );
          if (jobId !== null) {
            recordRuntimeLivenessMetric({
              operation: "reconcile",
              outcome: "recovered",
              durationMs: performance.now() - startedAt,
            });
          }
        } catch (error) {
          recordRuntimeLivenessMetric({
            operation: "reconcile",
            outcome: "error",
            durationMs: performance.now() - startedAt,
            errorCode: "RUNTIME_CANCELLATION_RECONCILE_FAILED",
          });
          this.onError(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
