export type RuntimeLivenessCode =
  | "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT"
  | "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT"
  | "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED";

export class RuntimeLivenessError extends Error {
  constructor(
    readonly code: RuntimeLivenessCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "RuntimeLivenessError";
  }
}

export class RuntimeProviderLivenessBudget {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private phase: "submission" | "stream" = "submission";

  constructor(
    private readonly submissionTimeoutMs: number,
    private readonly streamIdleTimeoutMs: number,
    parentSignal?: AbortSignal,
  ) {
    assertDuration(submissionTimeoutMs);
    assertDuration(streamIdleTimeoutMs);
    this.signal = parentSignal
      ? AbortSignal.any([parentSignal, this.controller.signal])
      : this.controller.signal;
    this.arm();
  }

  readonly signal: AbortSignal;

  providerActivity(): void {
    if (this.signal.aborted) return;
    this.phase = "stream";
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.stop();
    const timeoutMs = this.phase === "submission"
      ? this.submissionTimeoutMs
      : this.streamIdleTimeoutMs;
    this.timer = setTimeout(() => {
      this.controller.abort(new RuntimeLivenessError(
        this.phase === "submission"
          ? "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT"
          : "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
        true,
      ));
    }, timeoutMs);
    this.timer.unref?.();
  }
}

export class RuntimeWallClockBudget {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly maximumWallClockMs: number,
    startedAtMs: number,
  ) {
    assertDuration(maximumWallClockMs);
    this.rebase(startedAtMs);
  }

  readonly signal = this.controller.signal;

  rebase(startedAtMs: number): void {
    if (!Number.isFinite(startedAtMs)) throw new Error("RUNTIME_EXECUTION_STARTED_AT_INVALID");
    this.stop();
    const remainingMs = this.maximumWallClockMs - Math.max(0, Date.now() - startedAtMs);
    if (remainingMs <= 0) {
      this.controller.abort(new RuntimeLivenessError(
        "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
        false,
      ));
      return;
    }
    this.timer = setTimeout(() => {
      this.controller.abort(new RuntimeLivenessError(
        "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
        false,
      ));
    }, remainingMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("RUNTIME_ABORTED");
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("RUNTIME_LIVENESS_DURATION_INVALID");
  }
}
