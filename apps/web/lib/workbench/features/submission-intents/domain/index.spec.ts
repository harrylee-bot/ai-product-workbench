import type { CurrentSubmissionIntent } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import {
  canReplaySubmissionIntentSubmit,
  DEFAULT_SUBMISSION_INTENT_POLL_INTERVAL_MS,
  needsSubmissionIntentPolling,
  selectSubmissionIntentReselectionSlots,
  submissionIntentRecoveryState,
} from "./index";

describe("SubmissionIntent polling", () => {
  it("polls only while a bound attachment is uploading or verifying", () => {
    expect(DEFAULT_SUBMISSION_INTENT_POLL_INTERVAL_MS).toBe(1_000);
    expect(needsSubmissionIntentPolling(current("uploading"))).toBe(true);
    expect(needsSubmissionIntentPolling(current("verifying"))).toBe(true);
    expect(needsSubmissionIntentPolling(current("ready"))).toBe(false);
    expect(needsSubmissionIntentPolling({ item: null })).toBe(false);
    expect(needsSubmissionIntentPolling()).toBe(false);
  });

  it("projects durable recovery state without owning recovery orchestration", () => {
    expect(submissionIntentRecoveryState()).toBe("idle");
    expect(submissionIntentRecoveryState(current("ready").item)).toBe("ready_to_submit");
    expect(submissionIntentRecoveryState(current("verifying").item)).toBe("processing");
    expect(submissionIntentRecoveryState(current("uploading").item)).toBe("waiting_files");
    expect(submissionIntentRecoveryState({
      ...current("ready").item!,
      status: "submitting",
    })).toBe("processing");
    expect(canReplaySubmissionIntentSubmit({
      ...current("ready").item!,
      status: "submitting",
    })).toBe(true);
    expect(submissionIntentRecoveryState({
      ...current("ready").item!,
      attachments: [{ ...current("ready").item!.attachments[0], fileStatus: "failed" }],
    })).toBe("failed");
  });

  it("selects only unbound or interrupted upload slots for file re-selection", () => {
    const uploading = current("uploading").item!;
    const unbound = {
      ...uploadSlot("uploading"),
      fileAssetId: null,
      fileStatus: null,
    };
    const intent = {
      ...uploading,
      attachments: [
        unbound,
        { ...uploadSlot("uploading"), position: 1 },
        { ...uploadSlot("ready"), position: 2 },
      ],
    };

    expect(selectSubmissionIntentReselectionSlots(intent).map((slot) => slot.position))
      .toEqual([0, 1]);
  });
});

function current(fileStatus: "uploading" | "verifying" | "ready"): CurrentSubmissionIntent {
  const timestamp = "2026-07-15T00:00:00.000Z";
  return {
    item: {
      id: "intent-1",
      projectId: "project-1",
      threadId: "thread-1",
      status: "pending",
      request: {
        prompt: "Build a dashboard",
        modelId: "quality",
        workflow: "generate",
        generationIntent: null,
        targetSurface: "web",
        designStyle: { kind: "automatic" },
        artifactTargets: [],
        requestedArtifactKinds: [],
        sourceIds: [],
        canvasSnapshot: null,
      },
      attachments: [{
        ...uploadSlot(fileStatus),
      }],
      runId: null,
      lastFailure: null,
      revision: 1,
      submittedAt: null,
      cancelledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function uploadSlot(fileStatus: "uploading" | "verifying" | "ready") {
  return {
    position: 0,
    kind: "upload" as const,
    fileAssetId: "file-1",
    clientFingerprint: "submission-file:fixture-1",
    fileName: "brief.pdf",
    declaredMediaType: "application/pdf",
    byteSize: 42,
    lastModified: 1_786_771_200_000,
    fileStatus,
  };
}
