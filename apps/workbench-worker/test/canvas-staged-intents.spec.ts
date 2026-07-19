import {
  classifyCanvasPublicationIntents,
  planCanvasDirectIntentsOverRuntimeResult,
  type CanvasMutationInvocationRow,
} from "../src/runs/canvas-staged-intents.js";

const target = {
  boardNodeId: "board-node-home",
  artifactId: "artifact-prototype",
  artifactVersionId: "version-prototype-1",
  screenId: "screen-home",
};

const request = {
  prompt: "Edit the home screen",
  modelId: "quality",
  workflow: "edit" as const,
  targetSurface: "app" as const,
  designStyle: { kind: "automatic" as const },
  sourceIds: [],
  artifactTargets: [{
    artifactId: target.artifactId,
    artifactVersionId: target.artifactVersionId,
    screenIds: [target.screenId],
  }],
  requestedArtifactKinds: [],
};

describe("staged Canvas mutation intents", () => {
  it("uses the durable session sequence regardless of query order", () => {
    const intents = directIntents([
      invocation("rename_screen", 2, { target, title: "Renamed by Agent" }),
      invocation("duplicate_screen", 1, { target }),
    ]);
    expect(intents.map((intent) => intent.toolName)).toEqual(["duplicate_screen", "rename_screen"]);

    const plan = planCanvasDirectIntentsOverRuntimeResult(request, runtimeResult(), intents);
    expect(plan.document.screens.find((screen) => screen.id === "screen-home")?.name).toBe("Renamed by Agent");
    expect(plan.duplicateEffects[0]?.screen.name).toBe("AI Home copy");
    expect(plan.document.revision).toBe(4);
  });

  it("applies rename before duplicate when its sequence is lower", () => {
    const intents = directIntents([
      invocation("duplicate_screen", 9, { target }),
      invocation("rename_screen", 3, { target, title: "Renamed first" }),
    ]);
    const first = planCanvasDirectIntentsOverRuntimeResult(request, runtimeResult(), intents);
    const replay = planCanvasDirectIntentsOverRuntimeResult(request, runtimeResult(), intents);

    expect(first.duplicateEffects[0]?.screen.name).toBe("Renamed first copy");
    expect(first.duplicateEffects[0]?.nodeKey).toBe(replay.duplicateEffects[0]?.nodeKey);
    expect(first.document).toEqual(replay.document);
    expect(first.originalDraft.content.screens[0]?.name).toBe("AI Home");
  });

  it("rejects quick_edit mixed with direct intents", () => {
    expect(() => classifyCanvasPublicationIntents([
      invocation("quick_edit", 1, { target, instruction: "Make it concise" }),
      invocation("rename_screen", 2, { target, title: "Concise" }),
    ])).toThrow("CANVAS_QUICK_EDIT_DIRECT_INTENT_MIXED");
  });

  it("requires a final Runtime revise draft and unique session sequences", () => {
    const rows = [invocation("rename_screen", 1, { target, title: "Final" })];
    const intents = directIntents(rows);
    expect(() => planCanvasDirectIntentsOverRuntimeResult(request, {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [],
    }, intents)).toThrow("CANVAS_DIRECT_INTENT_RUNTIME_REVISION_INVALID");
    expect(() => classifyCanvasPublicationIntents([
      ...rows,
      invocation("duplicate_screen", 1, { target }),
    ])).toThrow("CANVAS_MUTATION_SEQUENCE_DUPLICATED");
  });
});

function directIntents(rows: CanvasMutationInvocationRow[]) {
  const classified = classifyCanvasPublicationIntents(rows);
  if (classified.mode !== "direct") throw new Error("expected direct intents");
  return classified.intents;
}

function invocation(
  toolName: "quick_edit" | "rename_screen" | "duplicate_screen",
  sequence: number,
  input: unknown,
): CanvasMutationInvocationRow {
  return {
    id: `invocation-${toolName}-${sequence}`,
    sequence,
    toolCallId: `tool-call-${toolName}-${sequence}`,
    toolName,
    requestHash: String(sequence).padStart(64, "0"),
    request: { input },
    satisfiesRunTarget: true,
    targetBoardNodeId: target.boardNodeId,
    targetArtifactId: target.artifactId,
    targetArtifactVersionId: target.artifactVersionId,
    targetScreenId: target.screenId,
  };
}

function runtimeResult() {
  return {
    protocol: "workbench.runtime.result.v1" as const,
    message: "AI edit complete",
    artifacts: [{
      kind: "prototype" as const,
      schemaVersion: 1 as const,
      title: "Prototype",
      citations: [],
      operation: {
        kind: "revise" as const,
        target: {
          artifactId: target.artifactId,
          artifactVersionId: target.artifactVersionId,
          screenIds: [target.screenId],
        },
      },
      content: prototypeDocument(),
    }],
  };
}

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const frame = (id: string, screenId: string) => ({
    id,
    screenId,
    parentId: null,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: { kind: "literal" as const, value: "#ffffff" },
      stroke: null,
      radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
    kind: "frame" as const,
    childIds: [],
    clipContent: true,
  });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "prototype-doc",
    title: "Prototype",
    revision: 2,
    screens: [{
      id: "screen-home",
      name: "AI Home",
      route: "/",
      rootNodeId: "frame-home",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [frame("frame-home", "screen-home")],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}
