import { asKnowledgeBuildError, RetryableKnowledgeBuildError, TerminalKnowledgeBuildError } from "./knowledge.errors.js";
import type { KnowledgeBuildDelivery, KnowledgeBuildOutcome, KnowledgeBuildStore } from "./knowledge-build.store.js";
import type { KnowledgeReleaseProcessor } from "./knowledge-release.processor.js";

export class KnowledgeDeliveryRunner {
  private readonly heartbeatMs: number;

  constructor(
    private readonly store: KnowledgeBuildStore,
    private readonly processor: KnowledgeReleaseProcessor,
    private readonly maximumAttempts: number,
    private readonly leaseMs: number,
    heartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3)),
  ) {
    this.heartbeatMs = heartbeatMs;
  }

  async run(
    releaseId: string,
    delivery: KnowledgeBuildDelivery,
    signal?: AbortSignal,
  ): Promise<KnowledgeBuildOutcome> {
    let start;
    try {
      start = await this.store.beginDelivery(
        releaseId,
        delivery,
        this.maximumAttempts,
        this.leaseMs,
      );
    } catch (cause) {
      throw asKnowledgeBuildError(cause);
    }
    if (start.kind === "terminal") return start.outcome;
    if (start.kind === "busy") return "busy";

    const heartbeat = setInterval(() => {
      void this.store.touchLease(start.command, this.leaseMs).catch(() => undefined);
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      return await this.processor.build(start.command, signal);
    } catch (cause) {
      const error = asKnowledgeBuildError(cause);
      if (error instanceof TerminalKnowledgeBuildError) {
        return this.store.fail(start.command, error);
      }
      const exhausted = delivery.retryCount >= delivery.retryLimit;
      const committed = await this.store.recordRetryableFailure(
        start.command,
        error,
        exhausted,
      );
      if (committed !== null) return committed;
      throw new RetryableKnowledgeBuildError(error.code, error.safeDetail, { cause });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
