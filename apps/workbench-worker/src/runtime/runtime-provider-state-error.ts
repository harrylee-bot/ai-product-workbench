export const runtimeProviderStateErrorCodes = [
  "RUNTIME_PROVIDER_STATE_BACKFILL_REQUIRED",
  "RUNTIME_PROVIDER_STATE_CAS_CONFLICT",
  "RUNTIME_PROVIDER_STATE_CURSOR_INVALID",
  "RUNTIME_PROVIDER_STATE_DRAFT_CONFLICT",
  "RUNTIME_PROVIDER_STATE_EVENT_SCOPE_INVALID",
  "RUNTIME_PROVIDER_STATE_FINALIZATION_CHECKPOINT_CONFLICT",
  "RUNTIME_PROVIDER_STATE_FINALIZATION_INVALID",
  "RUNTIME_PROVIDER_STATE_FINALIZATION_SHAPE_INVALID",
  "RUNTIME_PROVIDER_STATE_HASH_INVALID",
  "RUNTIME_PROVIDER_STATE_HASH_MISMATCH",
  "RUNTIME_PROVIDER_STATE_IDENTITY_IMMUTABLE",
  "RUNTIME_PROVIDER_STATE_IDENTITY_INVALID",
  "RUNTIME_PROVIDER_STATE_INITIAL_SHAPE_INVALID",
  "RUNTIME_PROVIDER_STATE_MISSING",
  "RUNTIME_PROVIDER_STATE_MONOTONICITY_INVALID",
  "RUNTIME_PROVIDER_STATE_SCOPE_INVALID",
  "RUNTIME_PROVIDER_STATE_SEQUENCE_GAP",
  "RUNTIME_PROVIDER_STATE_SEQUENCE_INVALID",
  "RUNTIME_PROVIDER_STATE_SHADOW_MISMATCH",
  "RUNTIME_PROVIDER_STATE_SHADOW_REPORTER_REQUIRED",
  "RUNTIME_PROVIDER_STATE_SHADOW_VERIFY_FAILED",
  "RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT",
  "RUNTIME_PROVIDER_STATE_VERSION_INVALID",
  "RUNTIME_PROVIDER_TEXT_ANCHOR_INVALID",
  "RUNTIME_PROVIDER_TEXT_CHECKPOINT_INVALID",
  "RUNTIME_PROVIDER_TEXT_DRAFT_CONFLICT",
  "RUNTIME_PROVIDER_TEXT_DRAFT_INVALID",
  "RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION",
  "RUNTIME_PROVIDER_TEXT_EVENT_INTEGRITY_ERROR",
  "RUNTIME_PROVIDER_TEXT_FINALIZATION_MULTIPLE",
  "RUNTIME_PROVIDER_TEXT_REPLAY_LIMIT_EXCEEDED",
  "RUNTIME_PROVIDER_TEXT_TERMINAL_PROJECTION_CONFLICT",
  "RUNTIME_PROVIDER_TEXT_VISIBLE_PROJECTION_CONFLICT",
] as const;

export type RuntimeProviderStateErrorCode = typeof runtimeProviderStateErrorCodes[number];

const runtimeProviderStateErrorCodeSet = new Set<string>(runtimeProviderStateErrorCodes);
const runtimeProviderStateErrorCodePattern = /\bRUNTIME_PROVIDER_(?:STATE|TEXT)_[A-Z0-9_]+\b/gu;
const maximumTraversalDepth = 8;
const maximumTraversalNodes = 64;

export function knownRuntimeProviderStateErrorCode(
  input: unknown,
): RuntimeProviderStateErrorCode | null {
  const pending: Array<{ deep: boolean; depth: number; value: unknown }> = [
    { deep: false, depth: 0, value: input },
  ];
  const visited = new Set<object>();
  let traversed = 0;

  while (pending.length > 0 && traversed < maximumTraversalNodes) {
    const current = pending.shift()!;
    traversed += 1;
    if (current.depth > maximumTraversalDepth) continue;

    if (typeof current.value === "string") {
      const code = knownCodeInMessage(current.value);
      if (code) return code;
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);

    const record = current.value as Record<string, unknown>;
    if (current.deep) {
      for (const value of ownDataValues(record)) {
        pending.push({ deep: true, depth: current.depth + 1, value });
      }
      continue;
    }
    for (const key of ["message", "cause", "meta"] as const) {
      const value = ownDataValue(record, key);
      if (value !== undefined) {
        pending.push({
          deep: key !== "message",
          depth: current.depth + 1,
          value,
        });
      }
    }
  }
  return null;
}

function knownCodeInMessage(message: string): RuntimeProviderStateErrorCode | null {
  for (const match of message.slice(0, 16_384).matchAll(runtimeProviderStateErrorCodePattern)) {
    const code = match[0];
    if (runtimeProviderStateErrorCodeSet.has(code)) {
      return code as RuntimeProviderStateErrorCode;
    }
  }
  return null;
}

function ownDataValue(record: Record<string, unknown>, key: string) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownDataValues(record: Record<string, unknown>) {
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(record);
  } catch {
    return [];
  }
  return keys.flatMap((key) => {
    const value = ownDataValue(record, key);
    return value === undefined ? [] : [value];
  });
}
