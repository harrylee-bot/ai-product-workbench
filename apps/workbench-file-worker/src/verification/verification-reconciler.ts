import { fileVerifyQueue } from "@workbench/workbench-contracts";
import type { VerificationStore } from "./verification.store.js";

type QueueSender = {
  send(
    name: string,
    data: object,
    options: { singletonKey: string },
  ): Promise<string | null>;
};

export class VerificationReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: VerificationStore,
    private readonly queue: QueueSender,
    private readonly maximumAttempts: number,
    private readonly staleMs: number,
    private readonly batchSize: number,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch(this.onError), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const before = new Date(Date.now() - this.staleMs);
      const candidates = await this.store.findReconciliationCandidates(before, this.batchSize);
      for (const candidate of candidates) {
        try {
          if (candidate.attemptCount >= this.maximumAttempts) {
            await this.store.exhaustUpload(candidate.uploadSessionId, "VERIFICATION_RECONCILER_EXHAUSTED");
            continue;
          }
          await this.queue.send(
            fileVerifyQueue,
            { uploadSessionId: candidate.uploadSessionId },
            { singletonKey: candidate.uploadSessionId },
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
