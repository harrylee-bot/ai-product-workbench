import { fileExtractQueue } from "@workbench/workbench-contracts";
import type { ExtractionStore } from "./extraction.store.js";

type QueueSender = {
  send(name: string, data: object, options: { singletonKey: string }): Promise<string | null>;
};

export class ExtractionReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: ExtractionStore,
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
          if (candidate.processingAttempts >= this.maximumAttempts) {
            await this.store.exhaust(candidate.extractionId, "FILE_EXTRACTION_RECONCILER_EXHAUSTED");
            continue;
          }
          await this.queue.send(
            fileExtractQueue,
            { extractionId: candidate.extractionId },
            { singletonKey: candidate.extractionId },
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
