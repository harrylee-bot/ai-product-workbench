export type PrototypeCheckpointRecoveryResult<TCheckpoint> =
  | { kind: "loaded"; checkpoint: TCheckpoint }
  | { kind: "failed"; error: unknown }
  | { kind: "aborted" }
  | { kind: "stale" };

type ActiveRecovery<TCheckpoint> = {
  controller: AbortController;
  generation: number;
  promise: Promise<PrototypeCheckpointRecoveryResult<TCheckpoint>>;
};

export type PrototypeCheckpointRecoveryOptions = {
  initialDelayMs?: number;
  maxAttempts?: number;
  maxDelayMs?: number;
  multiplier?: number;
};

type RequiredRecoveryOptions = Required<PrototypeCheckpointRecoveryOptions>;

const DEFAULT_RECOVERY_OPTIONS: RequiredRecoveryOptions = {
  initialDelayMs: 250,
  maxAttempts: 3,
  maxDelayMs: 2_000,
  multiplier: 2,
};

export class PrototypeCheckpointRecoveryCoordinator<TCheckpoint> {
  readonly #active = new Map<string, ActiveRecovery<TCheckpoint>>();
  readonly #options: RequiredRecoveryOptions;
  #generation = 0;
  #scope = "";

  constructor(options: PrototypeCheckpointRecoveryOptions = {}) {
    const initialDelayMs = nonNegative(options.initialDelayMs, DEFAULT_RECOVERY_OPTIONS.initialDelayMs);
    this.#options = {
      initialDelayMs,
      maxAttempts: positiveInteger(options.maxAttempts, DEFAULT_RECOVERY_OPTIONS.maxAttempts),
      maxDelayMs: Math.max(
        initialDelayMs,
        nonNegative(options.maxDelayMs, DEFAULT_RECOVERY_OPTIONS.maxDelayMs),
      ),
      multiplier: Math.max(1, finite(options.multiplier, DEFAULT_RECOVERY_OPTIONS.multiplier)),
    };
  }

  setScope(scope: string): void {
    if (scope === this.#scope) return;
    this.#scope = scope;
    this.#generation += 1;
    this.abortAll();
  }

  recover(
    key: string,
    load: (signal: AbortSignal) => Promise<TCheckpoint>,
  ): Promise<PrototypeCheckpointRecoveryResult<TCheckpoint>> {
    const current = this.#active.get(key);
    if (current) return current.promise;

    const controller = new AbortController();
    const generation = this.#generation;
    const promise = this.#recoverWithRetry(controller, generation, load).finally(() => {
      const active = this.#active.get(key);
      if (active?.promise === promise) this.#active.delete(key);
    });
    this.#active.set(key, { controller, generation, promise });
    return promise;
  }

  abort(key: string): void {
    const current = this.#active.get(key);
    if (!current) return;
    this.#active.delete(key);
    current.controller.abort();
  }

  abortAll(): void {
    const active = [...this.#active.values()];
    this.#active.clear();
    for (const recovery of active) recovery.controller.abort();
  }

  dispose(): void {
    this.#generation += 1;
    this.abortAll();
  }

  isRecovering(key: string): boolean {
    return this.#active.has(key);
  }

  async #recoverWithRetry(
    controller: AbortController,
    generation: number,
    load: (signal: AbortSignal) => Promise<TCheckpoint>,
  ): Promise<PrototypeCheckpointRecoveryResult<TCheckpoint>> {
    let delayMs = this.#options.initialDelayMs;
    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt += 1) {
      const result = await runAbortableLoad(controller.signal, load);
      if (result.kind === "aborted") return result;
      if (generation !== this.#generation) return { kind: "stale" };
      if (result.kind === "loaded") return result;
      if (attempt === this.#options.maxAttempts) return result;
      if (!await waitForRetry(delayMs, controller.signal)) return { kind: "aborted" };
      if (generation !== this.#generation) return { kind: "stale" };
      delayMs = Math.min(this.#options.maxDelayMs, delayMs * this.#options.multiplier);
    }
    throw new Error("Prototype checkpoint recovery attempt bound was not enforced");
  }
}

function runAbortableLoad<TCheckpoint>(
  signal: AbortSignal,
  load: (signal: AbortSignal) => Promise<TCheckpoint>,
): Promise<PrototypeCheckpointRecoveryResult<TCheckpoint>> {
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: PrototypeCheckpointRecoveryResult<TCheckpoint>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => settle({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    let loading: Promise<TCheckpoint>;
    try {
      loading = load(signal);
    } catch (error) {
      settle({ kind: "failed", error });
      return;
    }
    void loading.then(
      (checkpoint) => settle({ kind: "loaded", checkpoint }),
      (error: unknown) => settle({ kind: "failed", error }),
    );
  });
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(true), delayMs);
    const settle = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => settle(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Math.max(0, finite(value, fallback));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(finite(value, fallback)));
}
