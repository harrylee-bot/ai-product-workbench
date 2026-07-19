import { runEventSchema, type Run, type RunEvent } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { createRunProjection, reduceRunEvent } from "./reducer";
import { RunProtocolError } from "./protocol-error";

const run: Run = {
  id: "run-1",
  requestId: "request-1",
  projectId: "project-1",
  threadId: "thread-1",
  retryOfRunId: null,
  status: "queued",
  modelId: "model-1",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "app",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: [],
  sources: [],
  knowledgeReleaseId: null,
  phase: null,
  phaseLabel: null,
  progress: null,
  attempt: 0,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: "2026-07-12T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};

describe("run reducer", () => {
  it("projects ordered message deltas and terminal state without mutation", () => {
    const initial = createRunProjection(run);
    const queued = reduceRunEvent(initial, event(1, "run.queued", { position: 2 }));
    const started = reduceRunEvent(queued, event(2, "run.started", { attempt: 1 }));
    const messageStarted = reduceRunEvent(started, event(3, "message.started", { entryId: "entry-1" }));
    const firstDelta = reduceRunEvent(messageStarted, event(4, "message.delta", {
      entryId: "entry-1",
      delta: "Hello ",
    }));
    const secondDelta = reduceRunEvent(firstDelta, event(5, "message.delta", {
      entryId: "entry-1",
      delta: "world",
    }));
    const completed = reduceRunEvent(secondDelta, event(6, "message.completed", { entryId: "entry-1" }));
    const terminal = reduceRunEvent(completed, event(7, "run.completed", { artifactCount: 0 }));

    expect(initial.lastSequence).toBe(0);
    expect(terminal).toMatchObject({
      status: "succeeded",
      lastSequence: 7,
      progress: 1,
      artifactCount: 0,
      messageOrder: ["entry-1"],
    });
    expect(terminal.messages["entry-1"]).toEqual({
      entryId: "entry-1",
      text: "Hello world",
      status: "completed",
    });
  });

  it("is idempotent for replayed events and rejects gaps", () => {
    const queuedEvent = event(1, "run.queued", { position: null });
    const queued = reduceRunEvent(createRunProjection(run), queuedEvent);

    expect(reduceRunEvent(queued, queuedEvent)).toBe(queued);
    expect(() => reduceRunEvent(queued, event(3, "run.started", { attempt: 1 })))
      .toThrowError(RunProtocolError);
  });

  it("projects generation stages only for the current Runtime attempt", () => {
    const started = reduceRunEvent(
      createRunProjection(run),
      event(1, "run.started", { attempt: 1 }),
    );
    const thinking = reduceRunEvent(started, event(2, "run.generation.stage.changed", {
      attempt: 1,
      stage: "thinking",
    }));
    const streaming = reduceRunEvent(thinking, event(3, "run.generation.stage.changed", {
      attempt: 1,
      stage: "screen-streaming",
    }));

    expect(streaming).toMatchObject({
      generationStage: "screen-streaming",
      generationStageAttempt: 1,
      status: "running",
    });

    const restarted = reduceRunEvent(streaming, event(4, "run.started", { attempt: 2 }));
    expect(restarted).toMatchObject({
      attempt: 2,
      generationStage: null,
      generationStageAttempt: null,
    });
    expect(() => reduceRunEvent(restarted, event(5, "run.generation.stage.changed", {
      attempt: 1,
      stage: "summarizing",
    }))).toThrowError(/attempt mismatch: expected 2, received 1/);
  });

  it("upserts ordered Artifact drafts and preserves them through publication", () => {
    const started = reduceRunEvent(
      createRunProjection(run),
      event(1, "run.started", { attempt: 1 }),
    );
    const firstDraft = reduceRunEvent(started, event(2, "artifact.draft.created", draftPayload({
      artifactIndex: 0,
      artifactVersionId: "version-draft-1",
    })));
    const revisedDraft = reduceRunEvent(firstDraft, event(3, "artifact.draft.created", draftPayload({
      artifactIndex: 0,
      artifactVersionId: "version-draft-2",
      checksum: "b".repeat(64),
    })));
    const secondDraft = reduceRunEvent(revisedDraft, event(4, "artifact.draft.created", draftPayload({
      artifactIndex: 2,
      artifactId: "artifact-draft-2",
      artifactVersionId: "version-draft-3",
      checksum: "c".repeat(64),
    })));
    const published = reduceRunEvent(secondDraft, event(5, "artifact.version.created", {
      artifactId: "artifact-draft-1",
      artifactVersionId: "version-draft-2",
      version: 1,
    }));
    const completed = reduceRunEvent(published, event(6, "run.completed", { artifactCount: 2 }));

    expect(firstDraft.draftArtifactOrder).toEqual([0]);
    expect(revisedDraft.draftArtifactOrder).toEqual([0]);
    expect(revisedDraft.draftArtifacts["0"]).toMatchObject({
      artifactVersionId: "version-draft-2",
      checksum: "b".repeat(64),
    });
    expect(completed).toMatchObject({
      status: "succeeded",
      draftArtifactOrder: [0, 2],
      draftArtifacts: {
        "0": { artifactVersionId: "version-draft-2" },
        "2": { artifactVersionId: "version-draft-3" },
      },
    });
  });

  it("accepts Artifact drafts only for the current attempt and resets them on restart", () => {
    const started = reduceRunEvent(
      createRunProjection(run),
      event(1, "run.started", { attempt: 1 }),
    );
    expect(() => reduceRunEvent(started, event(2, "artifact.draft.created", draftPayload({
      attempt: 2,
    })))).toThrowError(/attempt mismatch: expected 1, received 2/);

    const drafted = reduceRunEvent(started, event(2, "artifact.draft.created", draftPayload()));
    const restarted = reduceRunEvent(drafted, event(3, "run.started", { attempt: 2 }));
    expect(restarted.draftArtifacts).toEqual({});
    expect(restarted.draftArtifactOrder).toEqual([]);
  });

  it.each([
    {
      label: "cancelled",
      terminal: event(3, "run.cancelled", { reason: "Stopped" }),
    },
    {
      label: "failed",
      terminal: event(3, "run.failed", {
        code: "runtime_error",
        message: "Failed",
        retryable: true,
      }),
    },
  ])("clears Artifact drafts when a Run is $label", ({ terminal }) => {
    const started = reduceRunEvent(
      createRunProjection(run),
      event(1, "run.started", { attempt: 1 }),
    );
    const drafted = reduceRunEvent(
      started,
      event(2, "artifact.draft.created", draftPayload()),
    );

    const terminalProjection = reduceRunEvent(drafted, terminal);

    expect(terminalProjection.draftArtifacts).toEqual({});
    expect(terminalProjection.draftArtifactOrder).toEqual([]);
  });

  it("rejects events belonging to another run", () => {
    const foreign = {
      ...event(1, "run.queued", { position: null }),
      runId: "run-2",
    } as RunEvent;

    expect(() => reduceRunEvent(createRunProjection(run), foreign))
      .toThrowError(/does not belong/);
  });

  it("keeps parallel approvals ordered and removes only the submitted approval", () => {
    const queued = reduceRunEvent(createRunProjection(run), event(1, "run.queued", { position: null }));
    const started = reduceRunEvent(queued, event(2, "run.started", { attempt: 1 }));
    const firstRequired = reduceRunEvent(started, event(3, "run.input.required", {
      approvalId: "approval-1",
      kind: "design-choice",
      prompt: "Choose a direction",
      options: [
        { id: "a", label: "A", description: null, value: "a" },
        { id: "b", label: "B", description: null, value: "b" },
      ],
      attempt: 0,
    }));
    const bothRequired = reduceRunEvent(firstRequired, event(4, "run.input.required", {
      approvalId: "approval-2",
      kind: "content-choice",
      prompt: "Choose a headline",
      options: [
        { id: "c", label: "C", description: null, value: "c" },
      ],
      attempt: 0,
    }));
    const secondSubmitted = reduceRunEvent(bothRequired, event(5, "run.input.submitted", {
      approvalId: "approval-2",
      decision: "submit",
    }));

    expect(bothRequired).toMatchObject({
      status: "waiting_input",
      pendingInputOrder: ["approval-1", "approval-2"],
      pendingInputs: {
        "approval-1": { approvalId: "approval-1", attempt: 0 },
        "approval-2": { approvalId: "approval-2", attempt: 0 },
      },
    });
    expect(secondSubmitted).toMatchObject({
      status: "waiting_input",
      pendingInputOrder: ["approval-1"],
      pendingInputs: {
        "approval-1": { approvalId: "approval-1", attempt: 0 },
      },
      lastSequence: 5,
    });
    expect(secondSubmitted.pendingInputs["approval-2"]).toBeUndefined();

    const firstSubmitted = reduceRunEvent(secondSubmitted, event(6, "run.input.submitted", {
      approvalId: "approval-1",
      decision: "approve",
    }));
    expect(firstSubmitted).toMatchObject({
      status: "waiting_input",
      pendingInputs: {},
      pendingInputOrder: [],
      lastSequence: 6,
    });

    const requeued = reduceRunEvent(firstSubmitted, event(7, "run.queued", { position: 3 }));
    expect(requeued).toMatchObject({
      status: "queued",
      queuePosition: 3,
      lastSequence: 7,
    });
  });

  it("clears all parallel approvals when a run starts or reaches a terminal state", () => {
    const waiting = projectionWithTwoPendingInputs();

    const restarted = reduceRunEvent(waiting, event(5, "run.started", { attempt: 2 }));
    expect(restarted).toMatchObject({
      status: "running",
      pendingInputs: {},
      pendingInputOrder: [],
    });

    const terminalEvents = [
      event(5, "run.cancelled", { reason: "Stopped" }),
      event(5, "run.completed", { artifactCount: 2 }),
      event(5, "run.failed", { code: "runtime_error", message: "Failed", retryable: true }),
    ];
    for (const terminalEvent of terminalEvents) {
      const terminal = reduceRunEvent(waiting, terminalEvent);
      expect(terminal.pendingInputs).toEqual({});
      expect(terminal.pendingInputOrder).toEqual([]);
    }
  });
});

function projectionWithTwoPendingInputs() {
  const queued = reduceRunEvent(createRunProjection(run), event(1, "run.queued", { position: null }));
  const started = reduceRunEvent(queued, event(2, "run.started", { attempt: 1 }));
  const first = reduceRunEvent(started, event(3, "run.input.required", {
    approvalId: "approval-1",
    kind: "design-choice",
    prompt: "Choose a direction",
    options: [{ id: "a", label: "A", description: null, value: "a" }],
    attempt: 1,
  }));
  return reduceRunEvent(first, event(4, "run.input.required", {
    approvalId: "approval-2",
    kind: "content-choice",
    prompt: "Choose a headline",
    options: [{ id: "b", label: "B", description: null, value: "b" }],
    attempt: 1,
  }));
}

function draftPayload(overrides: Record<string, unknown> = {}) {
  return {
    attempt: 1,
    artifactIndex: 0,
    artifactId: "artifact-draft-1",
    artifactVersionId: "version-draft-1",
    kind: "prototype",
    checksum: "a".repeat(64),
    draftChecksum: "d".repeat(64),
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/home",
      checksum: "e".repeat(64),
      revision: 0,
      viewport: { width: 1440, height: 900 },
    }],
    ...overrides,
  };
}

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return runEventSchema.parse({
    protocol: "workbench.run.v1",
    id: `event-${sequence}`,
    projectId: run.projectId,
    threadId: run.threadId,
    runId: run.id,
    requestId: run.requestId,
    sequence,
    occurredAt: "2026-07-12T00:00:00.000Z",
    traceId: "trace-1",
    type,
    payload,
  });
}
