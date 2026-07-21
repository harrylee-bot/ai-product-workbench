import {
  createRuntimeFinalizationPayload,
  createRuntimeProviderTextCheckpoint,
  projectIncompleteVisibleAssistantText,
  rebuildRuntimeProviderTextState,
  runtimeExternalFinalizationEvent,
  sha256Canonical,
} from "../src/runtime/runtime-assistant-text.js";

describe("durable Runtime provider text state", () => {
  it("rebuilds the raw cumulative baseline and redaction buffer from processed provider events", () => {
    const token = `wbkg1.${"a".repeat(80)}.${"b".repeat(43)}`;
    const payload = {
      messages: [{ type: "ai", content: `before ${token}` }],
    };

    expect(rebuildRuntimeProviderTextState({
      currentRuntimeAttemptId: "attempt-1",
      durableVisibleAssistantText: "before ",
      truncated: false,
      events: [{
        runtimeAttemptId: "attempt-1",
        attempt: 1,
        externalEventId: "provider-values-1",
        sequence: 1,
        event: "values",
        payload,
        payloadSha256: sha256Canonical(payload),
      }],
    })).toMatchObject({
      rawAssistantText: `before ${token}`,
      visibleAssistantText: "before ",
      durableVisibleAssistantText: "before ",
      redactionBuffer: token,
      processedExternalEventIds: ["provider-values-1"],
      committedFinalization: null,
    });
  });

  it("restores the exact pre-finalization state and verifies bound effects plus checkpoint hashes", () => {
    const token = `wbkg1.${"a".repeat(80)}.${"b".repeat(43)}`;
    const before = projectIncompleteVisibleAssistantText(`before ${token}`);
    const checkpoint = createRuntimeProviderTextCheckpoint(before, `before ${token}`);
    const payload = createRuntimeFinalizationPayload({
      messagesSha256: "a".repeat(64),
      outcomeSha256: "b".repeat(64),
      effects: [],
      visibleAssistantText: "before [knowledge capability redacted]",
      providerTextCheckpoint: checkpoint,
    });

    const state = rebuildRuntimeProviderTextState({
      currentRuntimeAttemptId: "attempt-1",
      durableVisibleAssistantText: "before [knowledge capability redacted]",
      truncated: false,
      events: [{
        runtimeAttemptId: "attempt-1",
        attempt: 1,
        externalEventId: "workbench-finalization-1",
        sequence: 2,
        event: runtimeExternalFinalizationEvent,
        payload,
        payloadSha256: sha256Canonical(payload),
      }],
    });

    expect(state).toMatchObject({
      ...before,
      durableVisibleAssistantText: "before [knowledge capability redacted]",
      processedExternalEventIds: ["workbench-finalization-1"],
      committedFinalization: { externalEventId: "workbench-finalization-1", payload },
    });
  });

  it("fails closed when a truncated replay window has no cumulative or finalization anchor", () => {
    const payload = { type: "ai", content: "delta" };
    expect(() => rebuildRuntimeProviderTextState({
      currentRuntimeAttemptId: "attempt-1",
      durableVisibleAssistantText: "delta",
      truncated: true,
      events: [{
        runtimeAttemptId: "attempt-1",
        attempt: 1,
        externalEventId: "provider-message-1",
        sequence: 9_999,
        event: "messages",
        payload,
        payloadSha256: sha256Canonical(payload),
      }],
    })).toThrow("RUNTIME_PROVIDER_TEXT_REPLAY_LIMIT_EXCEEDED");
  });
});
