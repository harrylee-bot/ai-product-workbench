export type WorkerShutdownDependencies = {
  stopReconcilers: () => Promise<void>;
  stopQueue: () => Promise<void>;
  disconnectDatabase: () => Promise<void>;
  shutdownTelemetry: () => Promise<void>;
  log: (message: string) => void;
  logError: (message: string, error: unknown) => void;
};

export async function shutdownWorker(
  signal: string,
  dependencies: WorkerShutdownDependencies,
): Promise<void> {
  dependencies.log(`[worker] received ${signal}`);
  await dependencies.stopReconcilers();
  dependencies.log("[worker] shutdown phase=reconcilers-stopped");
  await dependencies.stopQueue();
  dependencies.log("[worker] shutdown phase=queue-stopped");
  await dependencies.disconnectDatabase();
  dependencies.log("[worker] shutdown phase=database-disconnected");
  await dependencies.shutdownTelemetry();
  dependencies.log("[worker] shutdown phase=telemetry-stopped");
  dependencies.log(`[worker] shutdown complete ${signal}`);
}

export async function shutdownWorkerWithExitCode(
  signal: string,
  dependencies: WorkerShutdownDependencies,
): Promise<number> {
  try {
    await shutdownWorker(signal, dependencies);
    return 0;
  } catch (error) {
    dependencies.logError(`[worker] shutdown failed ${signal}`, error);
    return 1;
  }
}
