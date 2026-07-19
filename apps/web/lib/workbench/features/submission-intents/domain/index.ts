import type {
  CurrentSubmissionIntent,
  SubmissionIntent,
  SubmissionIntentAttachment,
} from "@workbench/workbench-contracts";

export const DEFAULT_SUBMISSION_INTENT_POLL_INTERVAL_MS = 1_000;

export type SubmissionIntentRecoveryState =
  | "idle"
  | "waiting_files"
  | "processing"
  | "ready_to_submit"
  | "failed";

export type SubmissionIntentUploadSlot = Extract<
  SubmissionIntentAttachment,
  { kind: "upload" }
>;

export function needsSubmissionIntentPolling(
  current?: CurrentSubmissionIntent,
): boolean {
  return current?.item?.attachments.some((attachment) => (
    attachment.fileStatus === "uploading" || attachment.fileStatus === "verifying"
  )) ?? false;
}

export function submissionIntentRecoveryState(
  intent?: SubmissionIntent | null,
): SubmissionIntentRecoveryState {
  if (!intent || intent.status === "submitted" || intent.status === "cancelled") return "idle";
  if (intent.lastFailure || intent.attachments.some((attachment) => (
    attachment.fileStatus === "failed"
      || attachment.fileStatus === "quarantined"
      || attachment.fileStatus === "deleted"
  ))) return "failed";
  if (intent.status === "submitting") return "processing";
  if (selectSubmissionIntentReselectionSlots(intent).length > 0) return "waiting_files";
  if (intent.attachments.some((attachment) => attachment.fileStatus === "verifying")) {
    return "processing";
  }
  return intent.attachments.every((attachment) => attachment.fileStatus === "ready")
    ? "ready_to_submit"
    : "processing";
}

export function canReplaySubmissionIntentSubmit(intent?: SubmissionIntent | null): boolean {
  return intent?.status === "submitting";
}

export function selectSubmissionIntentReselectionSlots(
  intent?: SubmissionIntent | null,
): SubmissionIntentUploadSlot[] {
  if (!intent || intent.status === "submitted" || intent.status === "cancelled") return [];
  return intent.attachments.filter((attachment): attachment is SubmissionIntentUploadSlot => (
    attachment.kind === "upload"
      && (attachment.fileAssetId === null || attachment.fileStatus === "uploading")
  ));
}
