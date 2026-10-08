import { createHash } from "node:crypto";
import {
  canonicalJson,
  jsonValueSchema,
  type JsonValue,
  type RuntimeProgressEvent,
} from "@workbench/workbench-contracts";
import { z } from "zod";

export const runtimeExternalFinalizationEvent = "workbench.runtime.finalization.v2";
export const runtimeProviderTextReplayEventLimit = 10_000;
export const runtimeProviderStateProjectionVersion = 2;

export const runtimeProviderTextMaxLength = 16_000_000;
export const runtimeRedactionBufferMaxLength = 4_096;
const KNOWLEDGE_GRANT_PREFIX = "wbkg1.";
const CANVAS_GRANT_PREFIX = "wbct1.";
const CAPABILITY_TOKEN_CHARACTER = /^[A-Za-z0-9_.-]$/u;
const RUNTIME_RESULT_SUBMIT_TOOL = "workbench_runtime_result_submit";
const WORKBENCH_ARTIFACT_TOOLS = new Set([
  "workbench_artifact_draft_publish",
  "workbench_generation_stage_update",
  "workbench_prototype_patch_publish",
  RUNTIME_RESULT_SUBMIT_TOOL,
]);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const providerTextSnapshotSchema = z.object({
  rawAssistantText: z.string().max(runtimeProviderTextMaxLength),
  visibleAssistantText: z.string().max(runtimeProviderTextMaxLength),
  redactionBuffer: z.string().max(runtimeRedactionBufferMaxLength),
}).strict();

export const runtimeProviderTextCheckpointSchema = z.object({
  protocol: z.literal("workbench.runtime-provider-text-checkpoint.v1"),
  before: providerTextSnapshotSchema,
  terminal: providerTextSnapshotSchema,
}).strict();

export const runtimeFinalizationPayloadSchema = z.object({
  protocol: z.literal("workbench.runtime-finalization.v2"),
  messagesSha256: sha256Schema,
  outcomeSha256: sha256Schema,
  effects: z.array(jsonValueSchema),
  visibleFinalEffect: z.object({
    type: z.literal("text.final"),
    text: z.string().max(runtimeProviderTextMaxLength),
  }).strict(),
  effectsSha256: sha256Schema,
  providerTextCheckpoint: runtimeProviderTextCheckpointSchema,
  providerTextCheckpointSha256: sha256Schema,
}).strict();

export type RuntimeProviderTextSnapshot = z.infer<typeof providerTextSnapshotSchema>;
export type RuntimeProviderTextCheckpoint = z.infer<typeof runtimeProviderTextCheckpointSchema>;
export type RuntimeFinalizationPayload = z.infer<typeof runtimeFinalizationPayloadSchema>;

export type LegacyRuntimeProviderTextState = RuntimeProviderTextSnapshot & {
  protocol: "workbench.runtime-provider-text-state.v1";
  durableVisibleAssistantText: string;
  processedExternalEventIds: string[];
  committedFinalization: {
    externalEventId: string;
    payload: RuntimeFinalizationPayload;
  } | null;
};

export type RuntimeProviderTextState = RuntimeProviderTextSnapshot & {
  protocol: "workbench.runtime-provider-text-state.v2";
  durableVisibleAssistantText: string;
  committedFinalization: {
    externalEventId: string;
    payloadSha256: string;
  } | null;
};

export type RuntimeProviderTextEvent = {
  runtimeAttemptId: string;
  attempt: number;
  externalEventId: string;
  sequence: number;
  event: string;
  payload: JsonValue;
  payloadSha256: string;
};

export type RuntimeProviderProjection = RuntimeProviderTextSnapshot & {
  protocol: "workbench.runtime-provider-state.v2";
  runtimeAttemptId: string;
  runId: string;
  projectionVersion: typeof runtimeProviderStateProjectionVersion;
  lastAppliedSequence: number;
  lastExternalEventId: string | null;
  finalizationExternalEventId: string | null;
  finalizationPayloadSha256: string | null;
  stateSha256: string;
};

export type RuntimeProviderProjectionEvent = RuntimeProviderTextEvent & {
  runId: string;
};

export class CapabilityRedactionFilter {
  private buffer: string;

  constructor(buffer = "") {
    if (buffer.length > runtimeRedactionBufferMaxLength) {
      throw new Error("RUNTIME_REDACTION_BUFFER_INVALID");
    }
    this.buffer = buffer;
  }

  push(chunk: string): string {
    this.buffer += chunk;
    let output = "";
    while (this.buffer) {
      const match = earliestCapabilityPrefix(this.buffer);
      const grantStart = match?.index ?? -1;
      if (grantStart >= 0) {
        output += this.buffer.slice(0, grantStart);
        this.buffer = this.buffer.slice(grantStart);
        const boundary = [...this.buffer].findIndex((character, index) => (
          index >= match!.prefix.length && !CAPABILITY_TOKEN_CHARACTER.test(character)
        ));
        if (boundary < 0) {
          if (this.buffer.length > runtimeRedactionBufferMaxLength) {
            output += `[${match!.kind} capability redacted]`;
            this.buffer = "";
          }
          return output;
        }
        output += `[${match!.kind} capability redacted]`;
        this.buffer = this.buffer.slice(boundary);
        continue;
      }
      const retained = retainedPrefixLength(this.buffer);
      output += this.buffer.slice(0, this.buffer.length - retained);
      this.buffer = this.buffer.slice(this.buffer.length - retained);
      return output;
    }
    return output;
  }

  flush(): string {
    const match = earliestCapabilityPrefix(this.buffer);
    const result = match?.index === 0 ? `[${match.kind} capability redacted]` : this.buffer;
    this.buffer = "";
    return result;
  }

  snapshot(): string {
    return this.buffer;
  }
}

export function assistantTextDelta(
  previous: string,
  incoming: string,
  kind: "delta" | "cumulative" = "cumulative",
) {
  if (!incoming) return "";
  if (kind === "delta") return incoming;
  if (incoming === previous || previous.startsWith(incoming)) return "";
  if (incoming.startsWith(previous)) return incoming.slice(previous.length);
  throw new Error("RUNTIME_ASSISTANT_CUMULATIVE_CONFLICT");
}

export function extractAssistantTextFrame(
  event: string,
  data: unknown,
): { kind: "delta" | "cumulative"; text: string } | null {
  if (event === "messages" || event === "messages-tuple") {
    const payload = Array.isArray(data) ? data[0] : data;
    const message = asRecord(payload);
    if (!message || !isAssistant(message) || messageToolCalls(message).length > 0) return null;
    const text = contentText(messageValue(message, "content"));
    return text ? { kind: "delta", text } : null;
  }
  if (event !== "values") return null;
  const messages = runtimeMessages(data);
  const currentTurnStart = currentTurnStartIndex(messages);
  const currentTurn = messages.slice(currentTurnStart + 1);
  const humanMessage = currentTurnStart >= 0 ? asRecord(messages[currentTurnStart]) : null;
  const hasArtifactToolFlow = isWorkbenchArtifactRequest(humanMessage)
    || currentTurn.some((candidate) => {
      const message = asRecord(candidate);
      if (!message) return false;
      return isTool(message)
        ? WORKBENCH_ARTIFACT_TOOLS.has(messageField(message, "name") ?? "")
        : messageToolCalls(message).some((call) => WORKBENCH_ARTIFACT_TOOLS.has(call.name));
    });
  const resultResponseIndex = hasArtifactToolFlow
    ? successfulRuntimeResultResponseIndex(currentTurn)
    : -1;
  if (hasArtifactToolFlow && resultResponseIndex < 0) return null;
  const candidates = hasArtifactToolFlow ? currentTurn.slice(resultResponseIndex + 1) : currentTurn;
  const message = candidates
    .reverse()
    .map(asRecord)
    .find((candidate) => candidate && isAssistant(candidate) && messageToolCalls(candidate).length === 0);
  if (!message) return null;
  const text = contentText(messageValue(message, "content"));
  return text ? { kind: "cumulative", text } : null;
}

export function projectIncompleteVisibleAssistantText(rawAssistantText: string) {
  const filter = new CapabilityRedactionFilter();
  const visibleAssistantText = filter.push(rawAssistantText);
  return {
    rawAssistantText,
    visibleAssistantText,
    redactionBuffer: filter.snapshot(),
  } satisfies RuntimeProviderTextSnapshot;
}

export function projectCompleteVisibleAssistantText(rawAssistantText: string) {
  const filter = new CapabilityRedactionFilter();
  return `${filter.push(rawAssistantText)}${filter.flush()}`;
}

export function createRuntimeProviderTextCheckpoint(
  before: RuntimeProviderTextSnapshot,
  terminalRawAssistantText: string,
): RuntimeProviderTextCheckpoint {
  assertProviderTextSnapshot(before, false);
  const terminal = {
    rawAssistantText: terminalRawAssistantText,
    visibleAssistantText: projectCompleteVisibleAssistantText(terminalRawAssistantText),
    redactionBuffer: "",
  } satisfies RuntimeProviderTextSnapshot;
  return runtimeProviderTextCheckpointSchema.parse({
    protocol: "workbench.runtime-provider-text-checkpoint.v1",
    before,
    terminal,
  });
}

export function createRuntimeFinalizationPayload(input: {
  messagesSha256: string;
  outcomeSha256: string;
  effects: RuntimeProgressEvent[];
  visibleAssistantText: string;
  providerTextCheckpoint: RuntimeProviderTextCheckpoint;
}): RuntimeFinalizationPayload {
  const effects = jsonValueSchema.parse(input.effects);
  const visibleFinalEffect = {
    type: "text.final" as const,
    text: input.visibleAssistantText,
  };
  const payload = runtimeFinalizationPayloadSchema.parse({
    protocol: "workbench.runtime-finalization.v2",
    messagesSha256: input.messagesSha256,
    outcomeSha256: input.outcomeSha256,
    effects,
    visibleFinalEffect,
    effectsSha256: sha256Canonical({ effects, visibleFinalEffect }),
    providerTextCheckpoint: input.providerTextCheckpoint,
    providerTextCheckpointSha256: sha256Canonical(input.providerTextCheckpoint),
  });
  assertRuntimeFinalizationPayload(payload);
  return payload;
}

export function parseRuntimeFinalizationPayload(value: unknown): RuntimeFinalizationPayload {
  const payload = runtimeFinalizationPayloadSchema.parse(value);
  assertRuntimeFinalizationPayload(payload);
  return payload;
}

export function rebuildRuntimeProviderTextState(input: {
  currentRuntimeAttemptId: string;
  durableVisibleAssistantText: string;
  events: RuntimeProviderTextEvent[];
  truncated: boolean;
}): LegacyRuntimeProviderTextState {
  const events = [...input.events].sort(compareProviderTextEvents);
  for (const event of events) {
    if (sha256Canonical(event.payload) !== event.payloadSha256) {
      throw new Error("RUNTIME_PROVIDER_TEXT_EVENT_INTEGRITY_ERROR");
    }
  }
  const currentFinalizations = events.filter((event) => (
    event.runtimeAttemptId === input.currentRuntimeAttemptId
    && event.event === runtimeExternalFinalizationEvent
  ));
  if (currentFinalizations.length > 1) {
    throw new Error("RUNTIME_PROVIDER_TEXT_FINALIZATION_MULTIPLE");
  }
  const processedExternalEventIds = events
    .filter((event) => event.runtimeAttemptId === input.currentRuntimeAttemptId)
    .map((event) => event.externalEventId);
  const currentFinalization = currentFinalizations[0];
  if (currentFinalization) {
    const laterProviderEvent = events.some((event) => (
      event.runtimeAttemptId === input.currentRuntimeAttemptId
      && event.sequence > currentFinalization.sequence
      && event.event !== runtimeExternalFinalizationEvent
    ));
    if (laterProviderEvent) throw new Error("RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION");
    const payload = parseRuntimeFinalizationPayload(currentFinalization.payload);
    return {
      protocol: "workbench.runtime-provider-text-state.v1",
      ...payload.providerTextCheckpoint.before,
      durableVisibleAssistantText: input.durableVisibleAssistantText,
      processedExternalEventIds,
      committedFinalization: {
        externalEventId: currentFinalization.externalEventId,
        payload,
      },
    };
  }

  const anchorIndex = latestProviderTextAnchorIndex(events);
  if (input.truncated && anchorIndex < 0) {
    throw new Error("RUNTIME_PROVIDER_TEXT_REPLAY_LIMIT_EXCEEDED");
  }
  let state = emptyProviderTextSnapshot();
  let startIndex = 0;
  if (anchorIndex >= 0) {
    const anchor = events[anchorIndex]!;
    if (anchor.event === runtimeExternalFinalizationEvent) {
      state = parseRuntimeFinalizationPayload(anchor.payload).providerTextCheckpoint.terminal;
    } else {
      const frame = extractAssistantTextFrame(anchor.event, anchor.payload);
      if (!frame || frame.kind !== "cumulative") {
        throw new Error("RUNTIME_PROVIDER_TEXT_ANCHOR_INVALID");
      }
      state = projectIncompleteVisibleAssistantText(frame.text);
    }
    startIndex = anchorIndex + 1;
  }
  for (const event of events.slice(startIndex)) {
    if (event.event === runtimeExternalFinalizationEvent) {
      state = parseRuntimeFinalizationPayload(event.payload).providerTextCheckpoint.terminal;
      continue;
    }
    state = applyProviderTextEvent(state, event.event, event.payload);
  }
  assertProviderTextSnapshot(state, false);
  if (state.visibleAssistantText !== input.durableVisibleAssistantText) {
    throw new Error("RUNTIME_PROVIDER_TEXT_DRAFT_CONFLICT");
  }
  return {
    protocol: "workbench.runtime-provider-text-state.v1",
    ...state,
    durableVisibleAssistantText: input.durableVisibleAssistantText,
    processedExternalEventIds,
    committedFinalization: null,
  };
}

export function runtimeProviderTextStateFromProjection(
  projection: RuntimeProviderProjection,
  durableVisibleAssistantText: string,
): RuntimeProviderTextState {
  assertRuntimeProviderProjection(projection);
  if (projection.visibleAssistantText !== durableVisibleAssistantText) {
    throw new Error("RUNTIME_PROVIDER_STATE_DRAFT_CONFLICT");
  }
  return {
    protocol: "workbench.runtime-provider-text-state.v2",
    rawAssistantText: projection.rawAssistantText,
    visibleAssistantText: projection.visibleAssistantText,
    redactionBuffer: projection.redactionBuffer,
    durableVisibleAssistantText,
    committedFinalization: projection.finalizationExternalEventId
      ? {
          externalEventId: projection.finalizationExternalEventId,
          payloadSha256: projection.finalizationPayloadSha256!,
        }
      : null,
  };
}

export function runtimeProviderTextStateFromLegacy(
  legacy: LegacyRuntimeProviderTextState,
): RuntimeProviderTextState {
  const snapshot = legacy.committedFinalization
    ? legacy.committedFinalization.payload.providerTextCheckpoint.terminal
    : {
        rawAssistantText: legacy.rawAssistantText,
        visibleAssistantText: legacy.visibleAssistantText,
        redactionBuffer: legacy.redactionBuffer,
      };
  return {
    protocol: "workbench.runtime-provider-text-state.v2",
    ...snapshot,
    durableVisibleAssistantText: legacy.durableVisibleAssistantText,
    committedFinalization: legacy.committedFinalization
      ? {
          externalEventId: legacy.committedFinalization.externalEventId,
          payloadSha256: sha256Canonical(legacy.committedFinalization.payload),
        }
      : null,
  };
}

export function createRuntimeProviderProjection(input: {
  runtimeAttemptId: string;
  runId: string;
  snapshot?: RuntimeProviderTextSnapshot;
}): RuntimeProviderProjection {
  const snapshot = input.snapshot ?? emptyProviderTextSnapshot();
  assertProjectionIdentity(input.runtimeAttemptId, input.runId);
  assertProviderTextSnapshotEither(snapshot);
  return withRuntimeProviderProjectionHash({
    protocol: "workbench.runtime-provider-state.v2",
    runtimeAttemptId: input.runtimeAttemptId,
    runId: input.runId,
    projectionVersion: runtimeProviderStateProjectionVersion,
    lastAppliedSequence: 0,
    lastExternalEventId: null,
    ...snapshot,
    finalizationExternalEventId: null,
    finalizationPayloadSha256: null,
  });
}

export function reduceRuntimeProviderProjection(
  current: RuntimeProviderProjection,
  event: RuntimeProviderProjectionEvent,
): {
  state: RuntimeProviderProjection;
  providerTextEffect:
    | { type: "text.delta"; delta: string }
    | { type: "text.final"; text: string }
    | null;
} {
  assertRuntimeProviderProjection(current);
  if (event.runtimeAttemptId !== current.runtimeAttemptId || event.runId !== current.runId) {
    throw new Error("RUNTIME_PROVIDER_STATE_EVENT_SCOPE_INVALID");
  }
  if (event.sequence !== current.lastAppliedSequence + 1) {
    throw new Error("RUNTIME_PROVIDER_STATE_SEQUENCE_GAP");
  }
  if (sha256Canonical(event.payload) !== event.payloadSha256) {
    throw new Error("RUNTIME_PROVIDER_TEXT_EVENT_INTEGRITY_ERROR");
  }
  if (current.finalizationExternalEventId) {
    throw new Error("RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION");
  }

  if (event.event === runtimeExternalFinalizationEvent) {
    const payload = parseRuntimeFinalizationPayload(event.payload);
    if (canonicalJson(payload.providerTextCheckpoint.before) !== canonicalJson(providerSnapshot(current))) {
      throw new Error("RUNTIME_PROVIDER_STATE_FINALIZATION_CHECKPOINT_CONFLICT");
    }
    const terminal = payload.providerTextCheckpoint.terminal;
    return {
      state: withRuntimeProviderProjectionHash({
        ...projectionWithoutHash(current),
        lastAppliedSequence: event.sequence,
        ...terminal,
        finalizationExternalEventId: event.externalEventId,
        finalizationPayloadSha256: event.payloadSha256,
      }),
      providerTextEffect: {
        type: "text.final",
        text: terminal.visibleAssistantText,
      },
    };
  }

  const nextSnapshot = applyProviderTextEvent(
    providerSnapshot(current),
    event.event,
    event.payload,
  );
  const visibleDelta = nextSnapshot.visibleAssistantText.slice(current.visibleAssistantText.length);
  return {
    state: withRuntimeProviderProjectionHash({
      ...projectionWithoutHash(current),
      lastAppliedSequence: event.sequence,
      lastExternalEventId: event.externalEventId,
      ...nextSnapshot,
    }),
    providerTextEffect: visibleDelta ? { type: "text.delta", delta: visibleDelta } : null,
  };
}

export function assertRuntimeProviderProjection(
  state: RuntimeProviderProjection,
): RuntimeProviderProjection {
  assertProjectionIdentity(state.runtimeAttemptId, state.runId);
  if (
    state.protocol !== "workbench.runtime-provider-state.v2"
    || state.projectionVersion !== runtimeProviderStateProjectionVersion
  ) {
    throw new Error("RUNTIME_PROVIDER_STATE_VERSION_INVALID");
  }
  if (!Number.isSafeInteger(state.lastAppliedSequence) || state.lastAppliedSequence < 0) {
    throw new Error("RUNTIME_PROVIDER_STATE_SEQUENCE_INVALID");
  }
  if (
    state.lastAppliedSequence === 0
    && (
      state.lastExternalEventId !== null
      || state.finalizationExternalEventId !== null
      || state.finalizationPayloadSha256 !== null
    )
  ) {
    throw new Error("RUNTIME_PROVIDER_STATE_INITIAL_SHAPE_INVALID");
  }
  if (
    (state.finalizationExternalEventId === null)
      !== (state.finalizationPayloadSha256 === null)
    || (state.finalizationPayloadSha256 !== null && !sha256Schema.safeParse(state.finalizationPayloadSha256).success)
  ) {
    throw new Error("RUNTIME_PROVIDER_STATE_FINALIZATION_SHAPE_INVALID");
  }
  if (state.finalizationExternalEventId !== null) {
    assertProviderTextSnapshot(providerSnapshot(state), true);
  } else {
    assertProviderTextSnapshotEither(providerSnapshot(state));
  }
  if (!sha256Schema.safeParse(state.stateSha256).success) {
    throw new Error("RUNTIME_PROVIDER_STATE_HASH_INVALID");
  }
  const expected = sha256Canonical(projectionWithoutHash(state));
  if (state.stateSha256 !== expected) {
    throw new Error("RUNTIME_PROVIDER_STATE_HASH_MISMATCH");
  }
  return state;
}

export function withRuntimeProviderProjectionHash(
  state: Omit<RuntimeProviderProjection, "stateSha256">,
): RuntimeProviderProjection {
  const projected = {
    ...state,
    stateSha256: sha256Canonical(state),
  };
  return assertRuntimeProviderProjection(projected);
}

export function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function applyProviderTextEvent(
  state: RuntimeProviderTextSnapshot,
  event: string,
  payload: JsonValue,
): RuntimeProviderTextSnapshot {
  const frame = extractAssistantTextFrame(event, payload);
  if (!frame) return state;
  const delta = assistantTextDelta(state.rawAssistantText, frame.text, frame.kind);
  const filter = new CapabilityRedactionFilter(state.redactionBuffer);
  const visibleDelta = filter.push(delta);
  const next = {
    rawAssistantText: `${state.rawAssistantText}${delta}`,
    visibleAssistantText: `${state.visibleAssistantText}${visibleDelta}`,
    redactionBuffer: filter.snapshot(),
  };
  assertProviderTextSnapshot(next, false);
  return next;
}

function latestProviderTextAnchorIndex(events: RuntimeProviderTextEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.event === runtimeExternalFinalizationEvent) return index;
    if (extractAssistantTextFrame(event.event, event.payload)?.kind === "cumulative") return index;
  }
  return -1;
}

function assertRuntimeFinalizationPayload(payload: RuntimeFinalizationPayload) {
  if (sha256Canonical({
    effects: payload.effects,
    visibleFinalEffect: payload.visibleFinalEffect,
  }) !== payload.effectsSha256) {
    throw new Error("RUNTIME_FINALIZATION_EFFECTS_INTEGRITY_ERROR");
  }
  if (sha256Canonical(payload.providerTextCheckpoint) !== payload.providerTextCheckpointSha256) {
    throw new Error("RUNTIME_FINALIZATION_CHECKPOINT_INTEGRITY_ERROR");
  }
  assertProviderTextSnapshot(payload.providerTextCheckpoint.before, false);
  assertProviderTextSnapshot(payload.providerTextCheckpoint.terminal, true);
  if (payload.visibleFinalEffect.text !== payload.providerTextCheckpoint.terminal.visibleAssistantText) {
    throw new Error("RUNTIME_FINALIZATION_VISIBLE_EFFECT_CONFLICT");
  }
}

function assertProviderTextSnapshot(snapshot: RuntimeProviderTextSnapshot, terminal: boolean) {
  const projected = terminal
    ? {
        visibleAssistantText: projectCompleteVisibleAssistantText(snapshot.rawAssistantText),
        redactionBuffer: "",
      }
    : projectIncompleteVisibleAssistantText(snapshot.rawAssistantText);
  if (
    projected.visibleAssistantText !== snapshot.visibleAssistantText
    || projected.redactionBuffer !== snapshot.redactionBuffer
  ) {
    throw new Error("RUNTIME_PROVIDER_TEXT_CHECKPOINT_INVALID");
  }
}

function assertProviderTextSnapshotEither(snapshot: RuntimeProviderTextSnapshot) {
  try {
    assertProviderTextSnapshot(snapshot, false);
  } catch (incompleteError) {
    try {
      assertProviderTextSnapshot(snapshot, true);
    } catch {
      throw incompleteError;
    }
  }
}

function emptyProviderTextSnapshot(): RuntimeProviderTextSnapshot {
  return { rawAssistantText: "", visibleAssistantText: "", redactionBuffer: "" };
}

function providerSnapshot(state: RuntimeProviderTextSnapshot): RuntimeProviderTextSnapshot {
  return {
    rawAssistantText: state.rawAssistantText,
    visibleAssistantText: state.visibleAssistantText,
    redactionBuffer: state.redactionBuffer,
  };
}

function projectionWithoutHash(
  state: Omit<RuntimeProviderProjection, "stateSha256"> | RuntimeProviderProjection,
): Omit<RuntimeProviderProjection, "stateSha256"> {
  return {
    protocol: state.protocol,
    runtimeAttemptId: state.runtimeAttemptId,
    runId: state.runId,
    projectionVersion: state.projectionVersion,
    lastAppliedSequence: state.lastAppliedSequence,
    lastExternalEventId: state.lastExternalEventId,
    rawAssistantText: state.rawAssistantText,
    visibleAssistantText: state.visibleAssistantText,
    redactionBuffer: state.redactionBuffer,
    finalizationExternalEventId: state.finalizationExternalEventId,
    finalizationPayloadSha256: state.finalizationPayloadSha256,
  };
}

function assertProjectionIdentity(runtimeAttemptId: string, runId: string) {
  if (!runtimeAttemptId || runtimeAttemptId.length > 1_024 || !runId || runId.length > 1_024) {
    throw new Error("RUNTIME_PROVIDER_STATE_IDENTITY_INVALID");
  }
}

function compareProviderTextEvents(left: RuntimeProviderTextEvent, right: RuntimeProviderTextEvent) {
  return left.attempt - right.attempt || left.sequence - right.sequence;
}

function retainedPrefixLength(value: string): number {
  const prefixes = [KNOWLEDGE_GRANT_PREFIX, CANVAS_GRANT_PREFIX];
  const maximum = Math.min(value.length, Math.max(...prefixes.map((prefix) => prefix.length)) - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (prefixes.some((prefix) => prefix.startsWith(value.slice(-length)))) return length;
  }
  return 0;
}

function earliestCapabilityPrefix(value: string) {
  const matches = [
    { kind: "knowledge", prefix: KNOWLEDGE_GRANT_PREFIX, index: value.indexOf(KNOWLEDGE_GRANT_PREFIX) },
    { kind: "canvas", prefix: CANVAS_GRANT_PREFIX, index: value.indexOf(CANVAS_GRANT_PREFIX) },
  ].filter((match) => match.index >= 0);
  return matches.sort((left, right) => left.index - right.index)[0];
}

function runtimeMessages(finalState: unknown) {
  const state = asRecord(finalState);
  const nested = asRecord(state?.values);
  if (Array.isArray(state?.messages)) return state.messages;
  return Array.isArray(nested?.messages) ? nested.messages : [];
}

function currentTurnStartIndex(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message && isHuman(message)) return index;
  }
  return -1;
}

function isAssistant(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  if (asRecord(messageValue(message, "additional_kwargs"))?.hide_from_ui === true) return false;
  return role === "assistant" || role === "ai"
    || ["ai", "assistant", "aimessage", "aimessagechunk"].includes(type ?? "")
    || ["aimessage", "aimessagechunk"].includes(messageConstructor(message) ?? "");
}

function isHuman(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  const constructor = messageConstructor(message);
  return role === "user"
    || role === "human"
    || ["human", "user", "humanmessage", "usermessage"].includes(type ?? "")
    || constructor === "humanmessage";
}

function isTool(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  return role === "tool" || type === "tool" || type === "toolmessage"
    || messageConstructor(message) === "toolmessage";
}

function messageConstructor(message: Record<string, unknown>) {
  return Array.isArray(message.id)
    ? message.id.filter((item): item is string => typeof item === "string").at(-1)?.toLowerCase()
    : undefined;
}

function successfulRuntimeResultResponseIndex(messages: unknown[]) {
  const declarations = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (isAssistant(message)) {
      for (const call of messageToolCalls(message)) {
        if (call.name === RUNTIME_RESULT_SUBMIT_TOOL) declarations.add(call.id);
      }
      continue;
    }
    if (!isTool(message) || messageField(message, "name") !== RUNTIME_RESULT_SUBMIT_TOOL) continue;
    const toolCallId = messageField(message, "tool_call_id");
    const artifact = asRecord(messageValue(message, "artifact"));
    const status = messageField(message, "status")?.toLowerCase();
    if (toolCallId && declarations.has(toolCallId) && (!status || status === "success")
      && artifact?.protocol === "workbench.runtime.validated-result.v1" && artifact.ok === true) return index;
  }
  return -1;
}

function isWorkbenchArtifactRequest(message: Record<string, unknown> | null) {
  if (!message || !isHuman(message)) return false;
  const content = contentText(messageValue(message, "content"));
  if (!content.startsWith("/workbench\n")) return false;
  const match = content.match(/<workbench_context>\n([\s\S]*?)\n<\/workbench_context>/u);
  if (!match) return false;
  try {
    return asRecord(JSON.parse(match[1]!))?.outputContract === "workbench.runtime.result.v1";
  } catch {
    return false;
  }
}

function messageToolCalls(message: Record<string, unknown>) {
  const additionalKwargs = asRecord(messageValue(message, "additional_kwargs"));
  const rawCalls = messageValue(message, "tool_calls") ?? additionalKwargs?.tool_calls;
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.flatMap((rawCall) => {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    const id = stringValue(call?.id);
    const name = stringValue(call?.name) ?? stringValue(fn?.name);
    return id && name ? [{ id, name }] : [];
  });
}

function messageField(message: Record<string, unknown>, field: string) {
  return stringValue(messageValue(message, field));
}

function messageValue(message: Record<string, unknown>, field: string) {
  for (const container of [message, asRecord(message.kwargs), asRecord(message.lc_kwargs)]) {
    if (container && container[field] !== undefined) return container[field];
  }
  return undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.replace(/<think>[\s\S]*?<\/think>/giu, "");
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    const record = asRecord(part);
    const type = stringValue(record?.type)?.toLowerCase();
    if (type === "thinking" || type === "reasoning") return [];
    const text = stringValue(record?.text) ?? stringValue(record?.content);
    return text ? [text] : [];
  }).join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
