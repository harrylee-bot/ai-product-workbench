import { describe, expect, it } from "vitest";

import {
  PROTOTYPE_PATCH_QUEUE_MAX_BYTES,
  PROTOTYPE_PATCH_QUEUE_MAX_EVENTS,
  createPrototypePatchQueue,
  discardPrototypePatchesThrough,
  offerPrototypePatch,
  peekPrototypePatch,
  removePrototypePatch,
  type PrototypePatchQueueEvent,
} from "./queue";

describe("Prototype patch revision queue", () => {
  it("queues out-of-order revisions and removes them without losing dedupe identity", () => {
    const initial = createPrototypePatchQueue<string>();
    const second = patch(2);
    const first = patch(1);
    const queuedSecond = offerPrototypePatch(initial, 1, second);
    expect(queuedSecond.kind).toBe("accepted");
    if (queuedSecond.kind !== "accepted") throw new Error("second patch was not queued");
    const queuedBoth = offerPrototypePatch(queuedSecond.queue, 1, first);
    expect(queuedBoth.kind).toBe("accepted");
    if (queuedBoth.kind !== "accepted") throw new Error("first patch was not queued");

    expect(peekPrototypePatch(queuedBoth.queue, 1)).toBe(first);
    expect(peekPrototypePatch(queuedBoth.queue, 2)).toBe(second);
    const removed = removePrototypePatch(queuedBoth.queue, 1);
    expect(peekPrototypePatch(removed, 1)).toBeNull();
    expect(removed.eventFingerprints.get(first.eventId)).toBe(first.fingerprint);
  });

  it("deduplicates exact event/source replay and rejects conflicting fingerprints", () => {
    const event = patch(1);
    const accepted = offerPrototypePatch(createPrototypePatchQueue(), 1, event);
    if (accepted.kind !== "accepted") throw new Error("patch was not queued");

    expect(offerPrototypePatch(accepted.queue, 1, event).kind).toBe("duplicate");
    expect(offerPrototypePatch(accepted.queue, 1, {
      ...event,
      fingerprint: "different",
    })).toMatchObject({ kind: "conflict", reason: "event_id_conflict" });
    expect(offerPrototypePatch(accepted.queue, 1, {
      ...event,
      eventId: "event-alias",
    }).kind).toBe("duplicate");
    expect(offerPrototypePatch(accepted.queue, 1, {
      ...event,
      eventId: "event-conflict",
      fingerprint: "different",
    })).toMatchObject({ kind: "conflict", reason: "source_event_id_conflict" });
  });

  it("fails closed for unrecognized stale and overlapping revisions", () => {
    expect(offerPrototypePatch(createPrototypePatchQueue(), 4, patch(2)))
      .toMatchObject({ kind: "conflict", reason: "stale_unrecognized_event" });
    expect(offerPrototypePatch(createPrototypePatchQueue(), 3, {
      ...patch(2),
      nextRevision: 4,
    })).toMatchObject({ kind: "conflict", reason: "revision_conflict" });
  });

  it("enforces the 64 event and 2 MiB buffer caps", () => {
    let queue = createPrototypePatchQueue<number>();
    for (let index = 0; index < PROTOTYPE_PATCH_QUEUE_MAX_EVENTS; index += 1) {
      const result = offerPrototypePatch(queue, 0, patch(index, 1, index));
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") throw new Error("patch was not queued");
      queue = result.queue;
    }
    expect(offerPrototypePatch(queue, 0, patch(100)).kind).toBe("overflow");

    const oversized = patch(1, PROTOTYPE_PATCH_QUEUE_MAX_BYTES + 1);
    expect(offerPrototypePatch(createPrototypePatchQueue(), 1, oversized).kind).toBe("overflow");
  });

  it("discards patches already covered by a recovered checkpoint", () => {
    const first = offerPrototypePatch(createPrototypePatchQueue(), 1, patch(1, 10));
    if (first.kind !== "accepted") throw new Error("patch was not queued");
    const second = offerPrototypePatch(first.queue, 1, patch(2, 20));
    if (second.kind !== "accepted") throw new Error("patch was not queued");

    const recovered = discardPrototypePatchesThrough(second.queue, 2);
    expect(peekPrototypePatch(recovered, 1)).toBeNull();
    expect(peekPrototypePatch(recovered, 2)).not.toBeNull();
    expect(recovered.totalBytes).toBe(20);
  });
});

function patch<TPayload = string>(
  baseRevision: number,
  byteSize = 10,
  payload = `patch-${baseRevision}` as TPayload,
): PrototypePatchQueueEvent<TPayload> {
  return {
    baseRevision,
    byteSize,
    eventId: `event-${baseRevision}`,
    fingerprint: `fingerprint-${baseRevision}`,
    nextRevision: baseRevision + 1,
    payload,
    sourceEventId: `source-${baseRevision}`,
  };
}
