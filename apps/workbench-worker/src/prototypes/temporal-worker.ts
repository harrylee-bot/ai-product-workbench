import { PrototypeArtifactStorage } from "./prototype-artifact-storage.js";
import { createTemporalWorkerHealthServer } from "./temporal-worker-health.js";
import type { PrototypeWorkflowActivities } from "./temporal-worker.types.js";

export type TemporalWorkerOptions = {
  healthPort?: number;
  activities: PrototypeWorkflowActivities;
  /**
   * Registers the versioned workflows and activities with a real Temporal SDK
   * worker. The HTTP control surface is only a gateway and must not report
   * ready until this callback has completed.
   */
  registerTemporalWorker?: () => Promise<void>;
  /** Tracks the SDK polling loop after registration, including failure and shutdown. */
  isTemporalWorkerRunning?: () => boolean;
  /** Stops the SDK worker and closes its Temporal connection. */
  stopTemporalWorker?: () => Promise<void>;
  onStart?: (payload: Record<string, unknown>) => Promise<void>;
  onCancel?: (payload: Record<string, unknown>) => Promise<void>;
  onExecute?: (payload: Record<string, unknown>) => Promise<unknown>;
};

export class PrototypeTemporalWorker {
  private ready = false;
  private healthServer: ReturnType<typeof createTemporalWorkerHealthServer> | undefined;
  constructor(private readonly options: TemporalWorkerOptions) {}
  async start(): Promise<void> {
    this.healthServer = createTemporalWorkerHealthServer(this.options.healthPort ?? Number(process.env.WORKBENCH_TEMPORAL_WORKER_HEALTH_PORT || 4310), () => this.isReady(), this.options.onStart, this.options.onCancel, this.options.onExecute);
    await new Promise<void>((resolve, reject) => {
      this.healthServer?.once("listening", () => resolve());
      this.healthServer?.once("error", reject);
    });
    if (!this.options.registerTemporalWorker) {
      await this.stop();
      throw new Error("TEMPORAL_SDK_NOT_CONFIGURED");
    }
    try {
      await this.options.registerTemporalWorker();
      this.ready = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.ready = false;
    await this.options.stopTemporalWorker?.().catch(() => undefined);
    await new Promise<void>((resolve) => this.healthServer?.close(() => resolve()) ?? resolve());
  }
  isReady(): boolean { return this.ready && (this.options.isTemporalWorkerRunning?.() ?? true); }
}

export { PrototypeArtifactStorage };
