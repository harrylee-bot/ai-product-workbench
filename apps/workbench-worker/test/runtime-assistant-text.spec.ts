import {
  createRuntimeFinalizationPayload,
  createRuntimeProviderProjection,
  createRuntimeProviderTextCheckpoint,
  extractAssistantTextFrame,
  projectIncompleteVisibleAssistantText,
  reduceRuntimeProviderProjection,
  rebuildRuntimeProviderTextState,
  runtimeExternalFinalizationEvent,
  runtimeProviderTextStateFromLegacy,
  runtimeProviderTextStateFromProjection,
  sha256Canonical,
  type RuntimeProviderTextEvent,
} from "../src/runtime/runtime-assistant-text.js";

describe("Runtime assistant text frame extraction", () => {
  it("hides tool-call narration and intermediate artifact text until the validated result", () => {
    const call = { id: "result-1", name: "workbench_runtime_result_submit", args: {} };
    const human = {
      type: "human",
      content: '/workbench\n<workbench_context>\n{"outputContract":"workbench.runtime.result.v1"}\n</workbench_context>',
    };
    const intermediate = { type: "ai", content: "draft reasoning" };
    const declaration = { type: "ai", content: "submit reasoning", tool_calls: [call] };
    expect(extractAssistantTextFrame("messages", declaration)).toBeNull();
    expect(extractAssistantTextFrame("values", { messages: [human, intermediate] })).toBeNull();
    const response = {
      type: "tool", name: call.name, tool_call_id: call.id, status: "success",
      artifact: { protocol: "workbench.runtime.validated-result.v1", ok: true },
    };
    const summary = { type: "ai", content: "Final summary" };
    expect(extractAssistantTextFrame("values", { messages: [human, intermediate, declaration, response, summary] }))
      .toEqual({ kind: "cumulative", text: "Final summary" });
    expect(extractAssistantTextFrame("values", { messages: [human, response, summary] })).toBeNull();
    expect(extractAssistantTextFrame("values", { messages: [
      human, declaration, { ...response, status: "error" }, summary,
    ] })).toBeNull();
  });

  it("handles serialized AI and Tool messages with nested function calls and hidden metadata", () => {
    const serialized = (type: string, kwargs: Record<string, unknown>) => ({
      id: ["langchain", "schema", "messages", type], kwargs,
    });
    const declaration = serialized("AIMessage", {
      content: "internal",
      additional_kwargs: { tool_calls: [{
        id: "serialized-result", function: { name: "workbench_runtime_result_submit", arguments: "{}" },
      }] },
    });
    expect(extractAssistantTextFrame("messages-tuple", [declaration, {}])).toBeNull();
    const messages = [
      serialized("HumanMessage", { content: "current" }), declaration,
      serialized("ToolMessage", {
        name: "workbench_runtime_result_submit", tool_call_id: "serialized-result",
        artifact: { protocol: "workbench.runtime.validated-result.v1", ok: true },
      }),
      serialized("AIMessage", { content: "Final" }),
      serialized("AIMessage", { content: "hidden", additional_kwargs: { hide_from_ui: true } }),
    ];
    expect(extractAssistantTextFrame("values", { messages })).toEqual({ kind: "cumulative", text: "Final" });
    expect(extractAssistantTextFrame("values", { messages: messages.slice(0, 2) })).toBeNull();
  });

  it("ignores a prior-turn assistant when the current turn has only a human message", () => {
    expect(extractAssistantTextFrame("values", {
      messages: [
        { type: "human", content: "previous turn" },
        { type: "ai", content: "previous answer" },
        { type: "human", content: "current turn" },
      ],
    })).toBeNull();
  });

  it("selects the latest assistant text from the current human turn", () => {
    expect(extractAssistantTextFrame("values", {
      values: {
        messages: [
          { role: "user", content: "previous turn" },
          { role: "assistant", content: "previous answer" },
          {
            id: ["langchain", "schema", "messages", "HumanMessage"],
            content: "current turn",
          },
          { type: "tool", content: "tool result" },
          { type: "AIMessage", content: "current answer" },
        ],
      },
    })).toEqual({ kind: "cumulative", text: "current answer" });
  });

  it("does not inherit prior-turn text into a fresh provider projection", () => {
    const initial = createRuntimeProviderProjection({
      runtimeAttemptId: "attempt-multi-turn",
      runId: "run-multi-turn",
    });
    const humanOnlyPayload = {
      messages: [
        { type: "human", content: "previous turn" },
        { type: "ai", content: "previous answer" },
        { type: "human", content: "current turn" },
      ],
    };
    const afterHumanOnly = reduceRuntimeProviderProjection(initial, {
      runtimeAttemptId: initial.runtimeAttemptId,
      runId: initial.runId,
      attempt: 1,
      externalEventId: "multi-turn-human-only",
      sequence: 1,
      event: "values",
      payload: humanOnlyPayload,
      payloadSha256: sha256Canonical(humanOnlyPayload),
    });

    expect(afterHumanOnly.providerTextEffect).toBeNull();
    expect(afterHumanOnly.state.rawAssistantText).toBe("");

    const currentAssistantPayload = {
      messages: [
        ...humanOnlyPayload.messages,
        { type: "ai", content: "current answer" },
      ],
    };
    const afterAssistant = reduceRuntimeProviderProjection(afterHumanOnly.state, {
      runtimeAttemptId: initial.runtimeAttemptId,
      runId: initial.runId,
      attempt: 1,
      externalEventId: "multi-turn-current-assistant",
      sequence: 2,
      event: "values",
      payload: currentAssistantPayload,
      payloadSha256: sha256Canonical(currentAssistantPayload),
    });

    expect(afterAssistant.providerTextEffect).toEqual({
      type: "text.delta",
      delta: "current answer",
    });
    expect(afterAssistant.state.rawAssistantText).toBe("current answer");
  });
});

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

describe("Runtime provider-state v2 reducer", () => {
  it("matches legacy replay across 7,686 representative events and the durable draft", () => {
    const eventCount = 7_686;
    const events: RuntimeProviderTextEvent[] = [];
    let projection = createRuntimeProviderProjection({
      runtimeAttemptId: "attempt-representative",
      runId: "run-representative",
    });
    const append = (sequence: number, event: string, payload: RuntimeProviderTextEvent["payload"]) => {
      const input = {
        runtimeAttemptId: projection.runtimeAttemptId,
        runId: projection.runId,
        attempt: 1,
        externalEventId: `synthetic-${sequence}`,
        sequence,
        event,
        payload,
        payloadSha256: sha256Canonical(payload),
      };
      projection = reduceRuntimeProviderProjection(projection, input).state;
      events.push(input);
    };

    append(1, "messages", { type: "ai", content: "alpha " });
    append(2, "updates", { phase: "synthetic-no-text" });
    append(3, "values", {
      messages: [{ type: "ai", content: "alpha beta" }],
    });
    append(4, "messages-tuple", [{ type: "ai", content: " gamma" }, { synthetic: true }]);
    for (let sequence = 5; sequence < eventCount; sequence += 1) {
      append(sequence, "updates", { sequence, synthetic: true });
    }

    const before = {
      rawAssistantText: projection.rawAssistantText,
      visibleAssistantText: projection.visibleAssistantText,
      redactionBuffer: projection.redactionBuffer,
    };
    const finalization = createRuntimeFinalizationPayload({
      messagesSha256: "a".repeat(64),
      outcomeSha256: "b".repeat(64),
      effects: [{
        type: "phase",
        phase: "validating",
        label: "Synthetic validation",
        progress: 1,
      }],
      visibleAssistantText: "alpha beta gamma",
      providerTextCheckpoint: createRuntimeProviderTextCheckpoint(
        before,
        "alpha beta gamma",
      ),
    });
    append(eventCount, runtimeExternalFinalizationEvent, finalization);

    const durableDraftText = "alpha beta gamma";
    const replayed = rebuildRuntimeProviderTextState({
      currentRuntimeAttemptId: projection.runtimeAttemptId,
      durableVisibleAssistantText: durableDraftText,
      events,
      truncated: false,
    });

    expect(events).toHaveLength(eventCount);
    expect(finalization.effects).toEqual([{
      type: "phase",
      phase: "validating",
      label: "Synthetic validation",
      progress: 1,
    }]);
    expect(runtimeProviderTextStateFromLegacy(replayed)).toEqual(
      runtimeProviderTextStateFromProjection(projection, durableDraftText),
    );
    expect(projection).toMatchObject({
      lastAppliedSequence: eventCount,
      rawAssistantText: "alpha beta gamma",
      visibleAssistantText: durableDraftText,
      redactionBuffer: "",
      finalizationExternalEventId: `synthetic-${eventCount}`,
      finalizationPayloadSha256: sha256Canonical(finalization),
    });
  }, 30_000);

  it("applies one verified event and advances a canonical hash", () => {
    const initial = createRuntimeProviderProjection({
      runtimeAttemptId: "attempt-1",
      runId: "run-1",
    });
    const payload = { type: "ai", content: "synthetic delta" };

    const reduced = reduceRuntimeProviderProjection(initial, {
      runtimeAttemptId: "attempt-1",
      runId: "run-1",
      attempt: 1,
      externalEventId: "event-1",
      sequence: 1,
      event: "messages",
      payload,
      payloadSha256: sha256Canonical(payload),
    });

    expect(reduced.providerTextEffect).toEqual({
      type: "text.delta",
      delta: "synthetic delta",
    });
    expect(reduced.state).toMatchObject({
      lastAppliedSequence: 1,
      lastExternalEventId: "event-1",
      rawAssistantText: "synthetic delta",
      visibleAssistantText: "synthetic delta",
      finalizationExternalEventId: null,
    });
    expect(reduced.state.stateSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(reduced.state.stateSha256).not.toBe(initial.stateSha256);
  });

  it("reuses redaction and commits only a bound terminal checkpoint", () => {
    const token = `wbkg1.${"a".repeat(80)}.${"b".repeat(43)}`;
    const before = projectIncompleteVisibleAssistantText(`before ${token}`);
    const initial = createRuntimeProviderProjection({
      runtimeAttemptId: "attempt-1",
      runId: "run-1",
      snapshot: before,
    });
    const checkpoint = createRuntimeProviderTextCheckpoint(before, `before ${token}`);
    const payload = createRuntimeFinalizationPayload({
      messagesSha256: "a".repeat(64),
      outcomeSha256: "b".repeat(64),
      effects: [],
      visibleAssistantText: "before [knowledge capability redacted]",
      providerTextCheckpoint: checkpoint,
    });
    const reduced = reduceRuntimeProviderProjection(initial, {
      runtimeAttemptId: "attempt-1",
      runId: "run-1",
      attempt: 1,
      externalEventId: "finalization-1",
      sequence: 1,
      event: runtimeExternalFinalizationEvent,
      payload,
      payloadSha256: sha256Canonical(payload),
    });

    expect(reduced.state).toMatchObject({
      lastAppliedSequence: 1,
      lastExternalEventId: null,
      rawAssistantText: `before ${token}`,
      visibleAssistantText: "before [knowledge capability redacted]",
      redactionBuffer: "",
      finalizationExternalEventId: "finalization-1",
      finalizationPayloadSha256: sha256Canonical(payload),
    });
    expect(reduced.providerTextEffect).toEqual({
      type: "text.final",
      text: "before [knowledge capability redacted]",
    });
  });

  it("fails closed on a corrupted state, sequence gap, or event after finalization", () => {
    const initial = createRuntimeProviderProjection({
      runtimeAttemptId: "attempt-1",
      runId: "run-1",
    });
    const payload = { synthetic: true };
    const event = {
      runtimeAttemptId: "attempt-1",
      runId: "run-1",
      attempt: 1,
      externalEventId: "event-1",
      sequence: 1,
      event: "synthetic.noop",
      payload,
      payloadSha256: sha256Canonical(payload),
    };

    expect(() => reduceRuntimeProviderProjection(
      { ...initial, stateSha256: "f".repeat(64) },
      event,
    )).toThrow("RUNTIME_PROVIDER_STATE_HASH_MISMATCH");
    expect(() => reduceRuntimeProviderProjection(initial, {
      ...event,
      sequence: 2,
    })).toThrow("RUNTIME_PROVIDER_STATE_SEQUENCE_GAP");

    const before = projectIncompleteVisibleAssistantText("");
    const checkpoint = createRuntimeProviderTextCheckpoint(before, "");
    const finalization = createRuntimeFinalizationPayload({
      messagesSha256: "a".repeat(64),
      outcomeSha256: "b".repeat(64),
      effects: [],
      visibleAssistantText: "",
      providerTextCheckpoint: checkpoint,
    });
    const finalized = reduceRuntimeProviderProjection(initial, {
      ...event,
      externalEventId: "finalization-1",
      event: runtimeExternalFinalizationEvent,
      payload: finalization,
      payloadSha256: sha256Canonical(finalization),
    }).state;
    expect(() => reduceRuntimeProviderProjection(finalized, {
      ...event,
      sequence: 2,
    })).toThrow("RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION");
  });
});
