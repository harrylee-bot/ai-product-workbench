import { asExtractionError, RetryableExtractionError, TerminalExtractionError } from "./extraction.errors.js";
import type { ExtractionDelivery, ExtractionOutcome, ExtractionStore } from "./extraction.store.js";
import type { FileExtractionProcessor } from "./file-extraction.processor.js";

export class ExtractionDeliveryRunner {
  constructor(
    private readonly store: ExtractionStore,
    private readonly processor: FileExtractionProcessor,
    private readonly maximumAttempts: number,
    private readonly leaseMs: number,
  ) {}

  async run(
    extractionId: string,
    delivery: ExtractionDelivery,
    signal?: AbortSignal,
  ): Promise<ExtractionOutcome> {
    const start = await this.store.beginDelivery(extractionId, delivery, this.maximumAttempts, this.leaseMs);
    if (start.kind === "terminal") return start.outcome;
    if (start.kind === "busy") return "busy";
    try {
      return await this.processor.extract(start, signal);
    } catch (cause) {
      const error = asExtractionError(cause);
      if (error instanceof TerminalExtractionError) {
        return this.store.fail(extractionId, start.leaseToken, error);
      }
      const exhausted = delivery.retryCount >= delivery.retryLimit;
      const committed = await this.store.recordRetryableFailure(
        extractionId,
        start.leaseToken,
        error,
        exhausted,
      );
      if (committed !== null) return committed;
      throw new RetryableExtractionError(error.code, error.safeDetail, { cause });
    }
  }
}
