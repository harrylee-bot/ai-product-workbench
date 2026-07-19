import {
  asRetryableVerificationError,
  RetryableVerificationError,
} from "../errors.js";
import type { VerificationDelivery, VerificationOutcome, VerificationStore } from "./verification.store.js";
import type { FileVerificationProcessor } from "./file-verification.processor.js";

export class VerificationDeliveryRunner {
  constructor(
    private readonly store: VerificationStore,
    private readonly processor: FileVerificationProcessor,
    private readonly maximumAttempts: number,
    private readonly heartbeatMs: number,
  ) {}

  async run(
    uploadSessionId: string,
    delivery: VerificationDelivery,
    signal?: AbortSignal,
  ): Promise<VerificationOutcome> {
    const start = await this.store.beginAttempt(uploadSessionId, delivery, this.maximumAttempts);
    if (start.kind === "terminal") {
      if (start.outcome === "missing") return start.outcome;
      return this.processor.verify(uploadSessionId, signal);
    }
    if (start.kind === "retryable_replay") {
      const error = new RetryableVerificationError(start.code, start.detail);
      if (delivery.retryCount >= delivery.retryLimit) {
        return this.store.exhaustUpload(uploadSessionId, error.code);
      }
      throw error;
    }

    const heartbeat = setInterval(() => {
      void this.store.touchAttempt(start.attemptId).catch(() => undefined);
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      const outcome = await this.processor.verify(uploadSessionId, signal);
      await this.store.completeAttempt(start.attemptId, outcome);
      return outcome;
    } catch (cause) {
      const error = asRetryableVerificationError(cause);
      const exhausted = delivery.retryCount >= delivery.retryLimit;
      const committed = await this.store.recordRetryableFailure(start.attemptId, error, exhausted);
      if (committed) return committed;
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
