import { blobGcQueue } from "@workbench/workbench-contracts";
import type { BlobGcStore } from "./blob-gc.store.js";

type QueueSender = {
  send(name: string, data: object, options: { singletonKey: string }): Promise<string | null>;
};

export class BlobGcReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: BlobGcStore,
    private readonly queue: QueueSender,
    private readonly graceMs: number,
    private readonly maximumAttempts: number,
    private readonly batchSize: number,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly clock: () => Date = () => new Date(),
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
      const now = this.clock();
      await this.store.reconcileEligibility(now, new Date(now.getTime() + this.graceMs), this.batchSize);
      const candidates = await this.store.findCandidates(now, this.maximumAttempts, this.batchSize);
      for (const candidate of candidates) {
        try {
          await this.queue.send(
            blobGcQueue,
            { blobId: candidate.blobId },
            { singletonKey: candidate.blobId },
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
