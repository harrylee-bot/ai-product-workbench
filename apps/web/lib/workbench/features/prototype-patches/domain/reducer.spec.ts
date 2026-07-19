import { describe, expect, it } from "vitest";

import {
  createPrototypePatchProjection,
  reducePrototypePatchProjection,
} from "./reducer";

describe("Prototype patch projection reducer", () => {
  it("keeps last-good content while recovering from a revision gap", () => {
    const loading = reducePrototypePatchProjection(initial(), { type: "checkpoint_requested" });
    const live = reducePrototypePatchProjection(loading, {
      type: "checkpoint_accepted",
      checksum: "checkpoint",
      document: "document-v1",
      revision: 1,
    });
    const recovering = reducePrototypePatchProjection(live, {
      type: "patch_offered",
      event: event(3),
    });

    expect(recovering).toMatchObject({
      checksum: "checkpoint",
      document: "document-v1",
      issue: "revision_gap",
      phase: "recovering",
      revision: 1,
    });
  });

  it("atomically advances only a matching queued revision", () => {
    const live = checkpoint(1);
    const offered = reducePrototypePatchProjection(live, {
      type: "patch_offered",
      event: event(1),
    });
    const ignored = reducePrototypePatchProjection(offered, {
      type: "patch_applied",
      baseRevision: 2,
      checksum: "wrong",
      document: "wrong",
      nextRevision: 3,
    });
    expect(ignored).toBe(offered);

    const applied = reducePrototypePatchProjection(offered, {
      type: "patch_applied",
      baseRevision: 1,
      checksum: "v2",
      document: "document-v2",
      nextRevision: 2,
    });
    expect(applied).toMatchObject({
      checksum: "v2",
      document: "document-v2",
      issue: null,
      phase: "live",
      revision: 2,
    });
    expect(applied.queue.byBaseRevision.size).toBe(0);
  });

  it("preserves last-good content through finalization and clears buffered patches on ready", () => {
    const offered = reducePrototypePatchProjection(checkpoint(1), {
      type: "patch_offered",
      event: event(1),
    });
    const finalizing = reducePrototypePatchProjection(offered, { type: "finalization_started" });
    expect(finalizing).toMatchObject({
      document: "document-v1",
      phase: "finalizing",
    });
    const finalized = reducePrototypePatchProjection(finalizing, {
      type: "finalization_accepted",
      checksum: "ready",
      document: "ready-document",
      revision: 3,
    });
    expect(finalized).toMatchObject({
      checksum: "ready",
      document: "ready-document",
      phase: "finalized",
      revision: 3,
    });
    expect(finalized.queue.byBaseRevision.size).toBe(0);
  });

  it("surfaces a finalization failure without dropping the last-good document", () => {
    const finalizing = reducePrototypePatchProjection(
      checkpoint(2),
      { type: "finalization_started" },
    );
    const failed = reducePrototypePatchProjection(finalizing, { type: "finalization_failed" });

    expect(failed).toMatchObject({
      document: "document-v2",
      issue: "finalization_failed",
      phase: "finalizing",
      revision: 2,
    });
  });

  it("drops a poisoned patch while retaining the last-good document for recovery", () => {
    const offered = reducePrototypePatchProjection(checkpoint(1), {
      type: "patch_offered",
      event: event(1),
    });
    const failed = reducePrototypePatchProjection(offered, {
      type: "patch_failed",
      baseRevision: 1,
      issue: "checksum_mismatch",
    });

    expect(failed).toMatchObject({
      document: "document-v1",
      issue: "checksum_mismatch",
      phase: "recovering",
      revision: 1,
    });
    expect(failed.queue.byBaseRevision.size).toBe(0);
  });

  it("clears staging content on discard and rejects post-terminal patches", () => {
    const discarded = reducePrototypePatchProjection(checkpoint(1), { type: "discarded" });
    expect(discarded).toMatchObject({
      checksum: null,
      document: null,
      phase: "discarded",
      revision: null,
    });
    const conflict = reducePrototypePatchProjection(discarded, {
      type: "patch_offered",
      event: event(1),
    });
    expect(conflict).toMatchObject({ phase: "discarded", issue: "terminal_event_conflict" });
  });
});

function initial() {
  return createPrototypePatchProjection<string, string>("version-1", "screen-1");
}

function checkpoint(revision: number) {
  return reducePrototypePatchProjection(initial(), {
    type: "checkpoint_accepted" as const,
    checksum: `v${revision}`,
    document: `document-v${revision}`,
    revision,
  });
}

function event(baseRevision: number) {
  return {
    baseRevision,
    byteSize: 10,
    eventId: `event-${baseRevision}`,
    fingerprint: `fingerprint-${baseRevision}`,
    nextRevision: baseRevision + 1,
    payload: `patch-${baseRevision}`,
    sourceEventId: `source-${baseRevision}`,
  };
}
