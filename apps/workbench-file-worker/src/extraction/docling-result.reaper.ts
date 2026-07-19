type ResultCleaner = {
  clearResultsOlderThan(retentionSeconds: number, signal?: AbortSignal): Promise<void>;
};

export class DoclingResultReaper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly cleaner: ResultCleaner,
    private readonly retentionSeconds: number,
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
      await this.cleaner.clearResultsOlderThan(this.retentionSeconds);
    } finally {
      this.running = false;
    }
  }
}
