import { runtimeCancelQueue } from "@workbench/workbench-contracts";
import type { PrismaClient } from "@workbench/workbench-db";
import { recordRuntimeLivenessMetric } from "@workbench/workbench-telemetry";
import { runtimeProviderCancellationUnconfirmedCode } from "./runtime-cancellation-state.js";

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
  private activeRun: Promise<void> | null = null;

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

  stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.activeRun ?? Promise.resolve();
  }

  async runOnce(): Promise<void> {
    if (this.activeRun) return;
    const run = this.reconcile();
    this.activeRun = run;
    try {
      await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  private async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.db.run.findMany({
        where: {
          updatedAt: { lte: new Date(Date.now() - this.staleMs) },
          OR: [
            { status: "cancelling" },
            {
              status: "failed",
              errorCode: runtimeProviderCancellationUnconfirmedCode,
              runtimeAttempts: {
                some: {
                  status: "failed",
                  errorCode: runtimeProviderCancellationUnconfirmedCode,
                  providerCancellationResolution: { is: null },
                },
              },
            },
          ],
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
          // Rotate queued or duplicate candidates behind untouched cleanup work.
          await this.db.run.updateMany({
            where: {
              id: candidate.id,
              OR: [
                { status: "cancelling" },
                {
                  status: "failed",
                  errorCode: runtimeProviderCancellationUnconfirmedCode,
                  runtimeAttempts: {
                    some: {
                      status: "failed",
                      errorCode: runtimeProviderCancellationUnconfirmedCode,
                      providerCancellationResolution: { is: null },
                    },
                  },
                },
              ],
            },
            data: { updatedAt: new Date() },
          });
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
