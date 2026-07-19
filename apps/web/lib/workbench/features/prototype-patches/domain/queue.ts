export const PROTOTYPE_PATCH_QUEUE_MAX_EVENTS = 64;
export const PROTOTYPE_PATCH_QUEUE_MAX_BYTES = 2 * 1024 * 1024;

const PROTOTYPE_PATCH_DEDUPE_MAX_ENTRIES = 512;

export type PrototypePatchQueueEvent<TPayload> = {
  baseRevision: number;
  byteSize: number;
  eventId: string;
  fingerprint: string;
  nextRevision: number;
  payload: TPayload;
  sourceEventId: string;
};

export type PrototypePatchQueue<TPayload> = {
  byBaseRevision: ReadonlyMap<number, PrototypePatchQueueEvent<TPayload>>;
  eventFingerprints: ReadonlyMap<string, string>;
  sourceFingerprints: ReadonlyMap<string, string>;
  totalBytes: number;
};

export type PrototypePatchQueueConflictReason =
  | "event_id_conflict"
  | "source_event_id_conflict"
  | "revision_conflict"
  | "stale_unrecognized_event";

export type PrototypePatchQueueOfferResult<TPayload> =
  | { kind: "accepted"; queue: PrototypePatchQueue<TPayload> }
  | { kind: "duplicate"; queue: PrototypePatchQueue<TPayload> }
  | {
      kind: "conflict";
      queue: PrototypePatchQueue<TPayload>;
      reason: PrototypePatchQueueConflictReason;
    }
  | { kind: "overflow"; queue: PrototypePatchQueue<TPayload> };

export function createPrototypePatchQueue<TPayload>(): PrototypePatchQueue<TPayload> {
  return {
    byBaseRevision: new Map(),
    eventFingerprints: new Map(),
    sourceFingerprints: new Map(),
    totalBytes: 0,
  };
}

export function offerPrototypePatch<TPayload>(
  queue: PrototypePatchQueue<TPayload>,
  currentRevision: number,
  event: PrototypePatchQueueEvent<TPayload>,
): PrototypePatchQueueOfferResult<TPayload> {
  assertQueueEvent(event);

  const eventFingerprint = queue.eventFingerprints.get(event.eventId);
  if (eventFingerprint !== undefined) {
    return eventFingerprint === event.fingerprint
      ? { kind: "duplicate", queue }
      : { kind: "conflict", queue, reason: "event_id_conflict" };
  }

  const sourceFingerprint = queue.sourceFingerprints.get(event.sourceEventId);
  if (sourceFingerprint !== undefined) {
    return sourceFingerprint === event.fingerprint
      ? { kind: "duplicate", queue: rememberEventFingerprint(queue, event) }
      : { kind: "conflict", queue, reason: "source_event_id_conflict" };
  }

  if (event.nextRevision <= currentRevision) {
    return {
      kind: "conflict",
      queue: rememberFingerprints(queue, event),
      reason: "stale_unrecognized_event",
    };
  }
  if (event.baseRevision < currentRevision || event.nextRevision !== event.baseRevision + 1) {
    return {
      kind: "conflict",
      queue: rememberFingerprints(queue, event),
      reason: "revision_conflict",
    };
  }

  const current = queue.byBaseRevision.get(event.baseRevision);
  if (current) {
    if (
      current.eventId === event.eventId
      && current.sourceEventId === event.sourceEventId
      && current.fingerprint === event.fingerprint
    ) {
      return { kind: "duplicate", queue };
    }
    return {
      kind: "conflict",
      queue: rememberFingerprints(queue, event),
      reason: "revision_conflict",
    };
  }

  if (
    queue.byBaseRevision.size >= PROTOTYPE_PATCH_QUEUE_MAX_EVENTS
    || queue.totalBytes + event.byteSize > PROTOTYPE_PATCH_QUEUE_MAX_BYTES
  ) {
    return { kind: "overflow", queue: rememberFingerprints(queue, event) };
  }

  const byBaseRevision = new Map(queue.byBaseRevision);
  byBaseRevision.set(event.baseRevision, event);
  const remembered = rememberFingerprints(queue, event);
  return {
    kind: "accepted",
    queue: {
      ...remembered,
      byBaseRevision,
      totalBytes: queue.totalBytes + event.byteSize,
    },
  };
}

export function peekPrototypePatch<TPayload>(
  queue: PrototypePatchQueue<TPayload>,
  baseRevision: number,
): PrototypePatchQueueEvent<TPayload> | null {
  return queue.byBaseRevision.get(baseRevision) ?? null;
}

export function removePrototypePatch<TPayload>(
  queue: PrototypePatchQueue<TPayload>,
  baseRevision: number,
): PrototypePatchQueue<TPayload> {
  const event = queue.byBaseRevision.get(baseRevision);
  if (!event) return queue;
  const byBaseRevision = new Map(queue.byBaseRevision);
  byBaseRevision.delete(baseRevision);
  return {
    ...queue,
    byBaseRevision,
    totalBytes: Math.max(0, queue.totalBytes - event.byteSize),
  };
}

export function discardPrototypePatchesThrough<TPayload>(
  queue: PrototypePatchQueue<TPayload>,
  revision: number,
): PrototypePatchQueue<TPayload> {
  let next = queue;
  for (const [baseRevision, event] of queue.byBaseRevision) {
    if (event.nextRevision <= revision) next = removePrototypePatch(next, baseRevision);
  }
  return next;
}

function rememberFingerprints<TPayload>(
  queue: PrototypePatchQueue<TPayload>,
  event: PrototypePatchQueueEvent<TPayload>,
): PrototypePatchQueue<TPayload> {
  const withEvent = rememberEventFingerprint(queue, event);
  return {
    ...withEvent,
    sourceFingerprints: rememberBounded(
      withEvent.sourceFingerprints,
      event.sourceEventId,
      event.fingerprint,
    ),
  };
}

function rememberEventFingerprint<TPayload>(
  queue: PrototypePatchQueue<TPayload>,
  event: PrototypePatchQueueEvent<TPayload>,
): PrototypePatchQueue<TPayload> {
  return {
    ...queue,
    eventFingerprints: rememberBounded(
      queue.eventFingerprints,
      event.eventId,
      event.fingerprint,
    ),
  };
}

function rememberBounded(
  values: ReadonlyMap<string, string>,
  key: string,
  value: string,
): ReadonlyMap<string, string> {
  if (values.get(key) === value) return values;
  const next = new Map(values);
  next.delete(key);
  next.set(key, value);
  while (next.size > PROTOTYPE_PATCH_DEDUPE_MAX_ENTRIES) {
    const oldest = next.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function assertQueueEvent<TPayload>(event: PrototypePatchQueueEvent<TPayload>): void {
  if (
    !Number.isSafeInteger(event.baseRevision)
    || event.baseRevision < 0
    || !Number.isSafeInteger(event.nextRevision)
    || event.nextRevision <= 0
    || !Number.isSafeInteger(event.byteSize)
    || event.byteSize < 0
    || event.eventId.length === 0
    || event.sourceEventId.length === 0
    || event.fingerprint.length === 0
  ) {
    throw new TypeError("Prototype patch queue event is invalid");
  }
}
