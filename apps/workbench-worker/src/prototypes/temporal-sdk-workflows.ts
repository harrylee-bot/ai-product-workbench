import { ActivityCancellationType, CancellationScope, isCancellation, proxyActivities } from "@temporalio/workflow";
import type {
  PrototypeExportExecution,
  PrototypeExportInput,
  PrototypeExportResult,
  PrototypeGenerationInput,
  PrototypeDraftReference,
  PrototypeBuiltDraftReference,
  PrototypeGenerationStartInput,
  PrototypePreviewFreezeInput,
  PrototypePreviewFreezeResult,
  PrototypeShareCreateInput,
  PrototypeShareCreateResult,
  PrototypeShareRevokeInput,
  PrototypeShareRevokeResult,
} from "./temporal-worker.types.js";

/**
 * Workflow/activity protocol version. Workflow type names include this value
 * so histories from an older contract never get replayed by accident.
 */
export const PROTOTYPE_TEMPORAL_WORKFLOW_VERSION = "v2" as const;
export const PROTOTYPE_GENERATION_WORKFLOW_VERSION = "v3" as const;
export const PROTOTYPE_EXPORT_WORKFLOW_VERSION = "v3" as const;

export type PrototypeTemporalSdkActivities = {
  /** Activity names are versioned with the workflow contract. */
  preparePrototypeGenerationV3(input: PrototypeGenerationStartInput): Promise<PrototypeGenerationInput>;
  generatePrototypeV3(input: PrototypeGenerationInput): Promise<PrototypeDraftReference>;
  buildPrototypeV3(input: PrototypeDraftReference): Promise<PrototypeBuiltDraftReference>;
  persistPrototypeRevisionV3(input: PrototypeBuiltDraftReference): Promise<void>;
  persistPrototypeExportV3(input: PrototypeExportInput): Promise<PrototypeExportResult>;
  markPlanFailedV2(input: { planId: string; code: string; detail: string }): Promise<void>;
  markExportFailedV3(input: PrototypeExportExecution & { code: string; detail: string }): Promise<void>;
  markExportCancelledV3(input: PrototypeExportExecution & { detail: string }): Promise<void>;
  freezePrototypePreviewV2(input: PrototypePreviewFreezeInput): Promise<PrototypePreviewFreezeResult>;
  createPrototypeShareV2(input: PrototypeShareCreateInput): Promise<PrototypeShareCreateResult>;
  revokePrototypeShareV2(input: PrototypeShareRevokeInput): Promise<PrototypeShareRevokeResult>;
};

const activities = proxyActivities<PrototypeTemporalSdkActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "30 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3 },
});

// Provider cancellation is a durable obligation. Retry compensation until the
// provider acknowledges it; a transient outage must not abandon a live run or
// fabricate a cancelled plan after an arbitrary three attempts.
const compensation = proxyActivities<Pick<PrototypeTemporalSdkActivities, "markPlanFailedV2" | "markExportCancelledV3">>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 0, maximumInterval: "1 minute" },
});

export async function visualPrototypeGenerationV3(input: PrototypeGenerationStartInput): Promise<void> {
  let prepared: PrototypeGenerationInput | undefined;
  try {
    prepared = await activities.preparePrototypeGenerationV3(input);
    const generated = await activities.generatePrototypeV3(prepared);
    const built = await activities.buildPrototypeV3(generated);
    await activities.persistPrototypeRevisionV3(built);
  } catch (error) {
    await CancellationScope.nonCancellable(async () => {
      await compensation.markPlanFailedV2({
        planId: input.planId,
        code: isCancellation(error) ? "PROTOTYPE_WORKFLOW_CANCELLED" : "PROTOTYPE_GENERATION_FAILED",
        detail: isCancellation(error) ? "Prototype generation was cancelled" : error instanceof Error ? error.message : "Prototype generation failed",
      });
    });
    throw error;
  }
}

export async function visualPrototypeExportV3(input: PrototypeExportInput): Promise<PrototypeExportResult> {
  try {
    return await activities.persistPrototypeExportV3(input);
  } catch (error) {
    await CancellationScope.nonCancellable(async () => {
      if (isCancellation(error)) {
        await compensation.markExportCancelledV3({ projectId: input.projectId, exportId: input.exportId, commandId: input.commandId, detail: "Prototype export was cancelled" });
      } else {
        await activities.markExportFailedV3({ projectId: input.projectId, exportId: input.exportId, commandId: input.commandId, code: "PROTOTYPE_EXPORT_FAILED", detail: error instanceof Error ? error.message : "Prototype export failed" });
      }
    });
    throw error;
  }
}

export type PrototypeShareWorkflowInput =
  | { action: "freeze"; preview: PrototypePreviewFreezeInput }
  | { action: "create"; input: PrototypeShareCreateInput; preview: PrototypePreviewFreezeInput }
  | { action: "revoke"; input: PrototypeShareRevokeInput };
export type PrototypeShareWorkflowResult = PrototypeShareCreateResult | PrototypeShareRevokeResult | PrototypePreviewFreezeResult;

/**
 * Versioned lifecycle workflow for the synchronous share/preview API projections.
 * The API waits for this workflow result, so the authoritative DB mutation is
 * performed by an activity while the HTTP response still preserves CAS semantics.
 */
export async function visualPrototypeShareV2(input: PrototypeShareWorkflowInput): Promise<PrototypeShareWorkflowResult> {
  if (input.action === "freeze") return activities.freezePrototypePreviewV2(input.preview);
  if (input.action === "create") {
    const frozen = await activities.freezePrototypePreviewV2(input.preview);
    if (!frozen.ok) return frozen;
    return activities.createPrototypeShareV2(input.input);
  }
  return activities.revokePrototypeShareV2(input.input);
}
