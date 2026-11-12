import type {
  Artifact,
  ProjectListItem,
  Run,
  RunGenerationStage,
  RuntimeModel,
  ThreadEntry,
} from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { createRunProjection, type RunProjectionState } from "../run/reducer";
import { resolveWorkbenchModelChoiceKey } from "./runtime-models";
import {
  parseWorkbenchThreadEntry,
  safeParseWorkbenchThreadEntry,
  WorkbenchPresenterInvariantError,
  toWorkbenchModelChoices,
  toWorkbenchProjectMode,
  toWorkbenchRunActivityItems,
  toWorkbenchRunMessageItems,
  toWorkbenchRunMotionKind,
  toWorkbenchRunPresentation,
  toWorkbenchThreadMessageItem,
  visibleWorkbenchModelChoices,
} from "./workbench-presenter";

const project: ProjectListItem = {
  id: "project-stable-1",
  workspaceId: "workspace-1",
  title: "打卡签到系统",
  summary: null,
  status: "active",
  revision: 0,
  createdAt: "2026-07-08T04:00:00.000Z",
  updatedAt: "2026-07-12T04:00:00.000Z",
  role: "owner",
  relationship: "owned",
};

const run: Run = {
  id: "run-1",
  requestId: "request-1",
  projectId: project.id,
  threadId: "thread-1",
  retryOfRunId: null,
  status: "queued",
  modelId: "model-1",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "app",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: ["prototype"],
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
  createdAt: "2026-07-12T04:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};

describe("Workbench runtime choices and project mode", () => {
  it("keeps runtime models real while expressing specialized actions as workflows", () => {
    const models: RuntimeModel[] = [{
      id: "deepseek-flash",
      displayName: "DeepSeek Flash",
      description: "Fast design model",
      supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
      supportsThinking: false,
      supportsReasoningEffort: false,
    }];

    expect(toWorkbenchModelChoices(models)).toEqual([
      expect.objectContaining({ key: "model:deepseek-flash", modelId: "deepseek-flash", workflow: "generate" }),
      expect.objectContaining({ label: "Redesign", modelId: "deepseek-flash", workflow: "redesign" }),
      expect.objectContaining({ label: "Ideate", modelId: "deepseek-flash", workflow: "ideate" }),
      expect.objectContaining({ label: "Edit", modelId: "deepseek-flash", workflow: "edit" }),
    ]);
    expect(toWorkbenchModelChoices([])).toEqual([]);
  });

  it("exposes Edit only in contexts with an eligible Artifact selection", () => {
    const choices = toWorkbenchModelChoices([{
      id: "quality",
      displayName: "Quality",
      description: null,
      supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
      supportsThinking: false,
      supportsReasoningEffort: false,
    }]);

    const withoutEdit = visibleWorkbenchModelChoices(choices, { allowEdit: false });
    expect(withoutEdit).not.toContainEqual(expect.objectContaining({ workflow: "edit" }));
    expect(visibleWorkbenchModelChoices(choices, { allowEdit: true }))
      .toContainEqual(expect.objectContaining({ workflow: "edit" }));
    const editKey = choices.find((choice) => choice.workflow === "edit")!.key;
    expect(resolveWorkbenchModelChoiceKey(editKey, choices)).toBe(editKey);
    expect(resolveWorkbenchModelChoiceKey(editKey, withoutEdit)).toBe("model:quality");
  });

  it("only presents model/workflow pairs declared by the runtime catalog", () => {
    const choices = toWorkbenchModelChoices([
      {
        id: "generate-only",
        displayName: "Generate",
        description: null,
        supportedWorkflows: ["generate"],
        supportsThinking: false,
        supportsReasoningEffort: false,
      },
      {
        id: "edit-only",
        displayName: "Edit",
        description: null,
        supportedWorkflows: ["edit"],
        supportsThinking: false,
        supportsReasoningEffort: false,
      },
    ]);

    expect(choices).toEqual([
      expect.objectContaining({ key: "model:generate-only", workflow: "generate" }),
      expect.objectContaining({ key: "workflow:edit:edit-only", modelId: "edit-only", workflow: "edit" }),
    ]);
  });

  it("derives the canvas mode from durable artifacts before requested output hints", () => {
    const prd = artifact("prd", true);
    const prototype = artifact("prototype", true);

    expect(toWorkbenchProjectMode([], null)).toBe("board");
    expect(toWorkbenchProjectMode([], { ...run, requestedArtifactKinds: ["prd"] })).toBe("document");
    expect(toWorkbenchProjectMode([prd], { ...run, requestedArtifactKinds: ["prototype"] })).toBe("document");
    expect(toWorkbenchProjectMode([prd, prototype], run)).toBe("generated");
  });

  it.each([
    [[], "neutral"],
    [["document"], "neutral"],
    [["prd"], "prd"],
    [["prototype"], "prototype"],
    [["code"], "prototype"],
    [["prd", "prototype"], "neutral"],
    [["prd", "code"], "neutral"],
  ] as const)("derives Run motion kind from requested artifacts %j", (requestedArtifactKinds, expected) => {
    expect(toWorkbenchRunMotionKind([...requestedArtifactKinds])).toBe(expected);
  });
});

describe("Workbench Run presenter", () => {
  it.each<{
    expectedPhase: "generating" | "refining";
    expectedProgress: 0 | 1 | 2 | 3;
    stage: RunGenerationStage;
  }>([
    { stage: "thinking", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "collecting-prd-context", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "structuring-prd", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "drafting-prd", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "validating-prd", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "design-system", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "mapping-components", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "creating-flows", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "generating-ui", expectedPhase: "generating", expectedProgress: 0 },
    { stage: "screen-streaming", expectedPhase: "refining", expectedProgress: 1 },
    { stage: "summarizing", expectedPhase: "refining", expectedProgress: 2 },
    { stage: "screen-stable", expectedPhase: "refining", expectedProgress: 3 },
  ])("maps $stage to its evidence-backed visual projection", ({
    expectedPhase,
    expectedProgress,
    stage,
  }) => {
    expect(toWorkbenchRunPresentation(projection({
      status: "running",
      generationStage: stage,
      generationStageAttempt: 1,
    }))).toMatchObject({
      phase: expectedPhase,
      generationProgress: expectedProgress,
      runStatus: "running",
    });
  });

  it("derives completion from Run status instead of a Runtime stage", () => {
    expect(toWorkbenchRunPresentation(projection({
      status: "succeeded",
      generationStage: null,
      progress: 0,
    }))).toEqual({
      phase: "complete",
      generationProgress: 3,
      runId: run.id,
      runStatus: "succeeded",
    });
  });

  it.each([
    ["failed", "screen-streaming"],
    ["cancelled", "summarizing"],
  ] as const)("ignores a stale generation stage after a Run is %s", (status, generationStage) => {
    expect(toWorkbenchRunPresentation(projection({
      status,
      generationStage,
      generationStageAttempt: 1,
    }))).toEqual({
      phase: "idle",
      generationProgress: 0,
      runId: run.id,
      runStatus: status,
    });
  });

  it("does not infer generated screens from legacy phase, progress, or published artifacts", () => {
    const prototype = artifact("prototype", true).currentVersion!;
    const legacySignalsOnly = projection({
      status: "running",
      generationStage: null,
      phase: "publishing",
      progress: 1,
      artifacts: [prototype],
    });

    expect(toWorkbenchRunPresentation(legacySignalsOnly)).toEqual({
      phase: "generating",
      generationProgress: 0,
      runId: run.id,
      runStatus: "running",
    });
  });

  it("retains the authoritative stage projection while waiting for input", () => {
    const waiting = projection({
      status: "waiting_input",
      generationStage: "summarizing",
      generationStageAttempt: 1,
      phase: null,
      progress: null,
    });

    expect(toWorkbenchRunPresentation(waiting)).toEqual({
      phase: "refining",
      generationProgress: 2,
      runId: run.id,
      runStatus: "waiting_input",
    });
  });

  it("returns an explicit idle view when no Run exists", () => {
    expect(toWorkbenchRunPresentation(null)).toEqual({
      phase: "idle",
      generationProgress: 0,
      runId: null,
      runStatus: "idle",
    });
  });
});

describe("Workbench ThreadEntry presenter", () => {
  it("accepts only the current versioned user and assistant message envelopes", () => {
    const userEntry = entry("user", {
      protocol: "workbench.entry.v1",
      type: "user.prompt",
      text: "Build a dashboard",
      sourceIds: ["source-1"],
    });
    const assistantEntry = entry("assistant", {
      protocol: "workbench.entry.v1",
      type: "assistant.message",
      text: "Done",
    });

    const userResult = safeParseWorkbenchThreadEntry(userEntry);
    expect(userResult.success).toBe(true);
    expect(toWorkbenchThreadMessageItem(parseWorkbenchThreadEntry(assistantEntry))).toMatchObject({
      role: "assistant",
      text: "Done",
      sequence: 1,
    });
  });

  it("strictly rejects unversioned, role-mismatched, and guessed content", () => {
    const unversioned = safeParseWorkbenchThreadEntry(entry("assistant", { text: "legacy" }));
    const wrongRole = safeParseWorkbenchThreadEntry(entry("user", {
      protocol: "workbench.entry.v1",
      type: "assistant.message",
      text: "not a user prompt",
    }));
    const extraFields = safeParseWorkbenchThreadEntry(entry("assistant", {
      protocol: "workbench.entry.v1",
      type: "assistant.message",
      text: "message",
      guessed: true,
    }));

    expect(unversioned.success).toBe(false);
    expect(wrongRole.success).toBe(false);
    expect(extraFields.success).toBe(false);
    expect(() => parseWorkbenchThreadEntry(entry("assistant", { text: "legacy" }))).toThrow();
  });
});

describe("Workbench activity and streaming message presenters", () => {
  it("preserves reducer order and exposes display flags", () => {
    const state = projection({
      messages: {
        "message-1": { entryId: "message-1", text: "Hello", status: "streaming" },
        "message-2": { entryId: "message-2", text: "Done", status: "completed" },
      },
      messageOrder: ["message-2", "message-1"],
      activities: {
        "activity-1": {
          activityId: "activity-1",
          label: "Planning",
          detail: null,
          status: "running",
        },
        "activity-2": {
          activityId: "activity-2",
          label: "Published",
          detail: "3 artifacts",
          status: "succeeded",
        },
      },
      activityOrder: ["activity-1", "activity-2"],
    });

    expect(toWorkbenchRunMessageItems(state)).toEqual([
      { id: "message-2", text: "Done", status: "completed", working: false },
      { id: "message-1", text: "Hello", status: "streaming", working: true },
    ]);
    expect(toWorkbenchRunActivityItems(state)).toEqual([
      {
        id: "activity-1",
        label: "Planning",
        detail: null,
        status: "running",
        terminal: false,
        working: true,
      },
      {
        id: "activity-2",
        label: "Published",
        detail: "3 artifacts",
        status: "succeeded",
        terminal: true,
        working: false,
      },
    ]);
  });

  it("surfaces corrupt reducer ordering instead of silently dropping data", () => {
    const state = projection({ messageOrder: ["missing"] });
    expect(() => toWorkbenchRunMessageItems(state)).toThrow(WorkbenchPresenterInvariantError);
  });
});

function projection(overrides: Partial<RunProjectionState>): RunProjectionState {
  return { ...createRunProjection(run), ...overrides };
}

function artifact(kind: Artifact["kind"], ready: boolean): Artifact {
  return {
    id: `artifact-${kind}`,
    projectId: project.id,
    kind,
    title: kind,
    revision: 0,
    currentVersion: ready ? {
      artifactId: `artifact-${kind}`,
      artifactVersionId: `version-${kind}`,
      version: 1,
      kind,
      schemaVersion: 1,
      status: "ready",
      checksum: "a".repeat(64),
      createdByRunId: run.id,
      createdAt: "2026-07-12T04:00:00.000Z",
    } : null,
    createdAt: "2026-07-12T04:00:00.000Z",
    updatedAt: "2026-07-12T04:00:00.000Z",
  };
}

function entry(role: ThreadEntry["role"], content: unknown): ThreadEntry {
  return {
    id: "entry-1",
    threadId: run.threadId,
    sequence: 1,
    role,
    kind: "message",
    content,
    producedByRunId: role === "assistant" ? run.id : null,
    createdAt: "2026-07-12T04:00:00.000Z",
  } as ThreadEntry;
}
