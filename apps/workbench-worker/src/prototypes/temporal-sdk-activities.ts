import { cancelled, cancellationSignal, heartbeat, activityInfo } from "@temporalio/activity";
import { PrototypeExportCancelledError } from "./prototype-export-state.js";
import type { PrototypeWorkflowActivities } from "./temporal-worker.types.js";
import type { PrototypeTemporalSdkActivities } from "./temporal-sdk-workflows.js";

/**
 * Adapts the existing DB/DeerFlow activities to Temporal's activity context.
 * The adapter is the only place where AbortSignal and heartbeat details cross
 * the SDK boundary, keeping the deterministic workflow module dependency-free.
 */
export function createTemporalSdkActivities(base: PrototypeWorkflowActivities): PrototypeTemporalSdkActivities {
  if (!base.preparePrototypeGeneration) throw new Error("TEMPORAL_PREPARE_ACTIVITY_NOT_CONFIGURED");
  return {
    preparePrototypeGenerationV3: (input) => base.preparePrototypeGeneration!(input),
    generatePrototypeV3: (input) => base.generatePrototype(input, cancellationSignal(), (details) => heartbeat(details), { retryCount: activityInfo().attempt - 1, retryLimit: 2 }),
    buildPrototypeV3: (input) => withHeartbeat("build:working", () => base.buildPrototype(input, (details) => heartbeat(details), cancellationSignal())),
    persistPrototypeRevisionV3: (input) => base.persistPrototypeRevision(input),
    persistPrototypeExportV3: (input) => withHeartbeat("export:working", async () => {
      try {
        return await base.persistPrototypeExport(input, (details) => heartbeat(details), cancellationSignal());
      } catch (error) {
        if (!(error instanceof PrototypeExportCancelledError)) throw error;
        // The API commits cancellation intent and its outbox atomically. It can
        // win before the start activity or before Temporal receives the command.
        // Keep the export cancelling until that durable cancellation arrives:
        // only workflow cleanup acknowledges cancelled. Throwing an
        // unsolicited CancelledFailure would still make the SDK fail the workflow.
        heartbeat("export:awaiting-cancellation");
        return await cancelled();
      }
    }),
    markPlanFailedV2: (input) => withHeartbeat("deerflow:cleanup", () => base.markPlanFailed(input)),
    markExportFailedV3: (input) => base.markExportFailed(input),
    markExportCancelledV3: async (input) => {
      if (!base.markExportCancelled) throw new Error("TEMPORAL_CANCEL_ACTIVITY_NOT_CONFIGURED");
      await base.markExportCancelled(input);
    },
    freezePrototypePreviewV2: (input) => withHeartbeat("storage:verify", () => base.freezePrototypePreview(input, cancellationSignal())),
    createPrototypeShareV2: (input) => base.createPrototypeShare(input),
    revokePrototypeShareV2: (input) => base.revokePrototypeShare(input),
  };
}

async function withHeartbeat<T>(details: string, operation: () => Promise<T>): Promise<T> {
  heartbeat(details);
  const timer = setInterval(() => heartbeat(details), 10_000);
  timer.unref();
  try { return await operation(); } finally { clearInterval(timer); }
}
