// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPrototypeCanvasStyle,
} from "@/lib/workbench/features/prototype-style";
import { prototypeEditorDocumentFixture } from "@/lib/workbench/prototype-editor/test-fixtures";
import type { WorkbenchArtifactReference } from "./workbench-artifact-reference";
import type { WorkbenchNode } from "./workbench-board-nodes";
import {
  projectScreenArtifactSelection,
  useProjectScreenArtifactIntentController,
  useProjectScreenBoardIntentController,
  useProjectScreenComposerController,
  useProjectScreenPreviewController,
} from "./workbench-project-screen-controller";

afterEach(() => {
  vi.useRealTimers();
});

type ModelControllerProps = {
  allowEdit: boolean;
  status: "empty" | "error" | "loading" | "ready";
};

const generateModel = {
  description: "Generate",
  key: "model:quality",
  label: "Quality",
  modelId: "quality",
  workflow: "generate" as const,
};
const editModel = {
  description: "Edit",
  key: "workflow:edit:quality",
  label: "Edit",
  modelId: "quality",
  workflow: "edit" as const,
};
const fastEditModel = {
  description: "Fast edit",
  key: "workflow:edit:fast",
  label: "Fast edit",
  modelId: "fast",
  workflow: "edit" as const,
};

const prototypeReference: WorkbenchArtifactReference = {
  artifactId: "artifact-prototype",
  artifactVersionId: "version-prototype",
  projectId: "project-1",
  screenId: "screen-1",
};
const prdReference: WorkbenchArtifactReference = {
  artifactId: "artifact-prd",
  artifactVersionId: "version-prd",
  projectId: "project-1",
};

describe("ProjectScreen Composer controller", () => {
  it("owns visible model normalization and menu transitions", async () => {
    const rendered = renderHook(
      ({ allowEdit, status }: ModelControllerProps) => useProjectScreenComposerController({
        allowEdit,
        modelCatalogStatus: status,
        modelChoices: [generateModel, editModel],
        projectId: "project-1",
        targetSurface: "app",
      }),
      { initialProps: { allowEdit: false, status: "loading" } },
    );

    expect(rendered.result.current.model).toBe("");
    expect(rendered.result.current.projectModelChoices).toEqual([generateModel]);

    rendered.rerender({ allowEdit: false, status: "ready" });
    await waitFor(() => expect(rendered.result.current.model).toBe(generateModel.key));

    act(() => rendered.result.current.toggleModelMenu());
    expect(rendered.result.current.modelMenuOpen).toBe(true);

    rendered.rerender({ allowEdit: true, status: "ready" });
    act(() => rendered.result.current.selectModel(editModel.key));
    expect(rendered.result.current.model).toBe(editModel.key);
    expect(rendered.result.current.modelMenuOpen).toBe(false);

    rendered.rerender({ allowEdit: false, status: "ready" });
    await waitFor(() => expect(rendered.result.current.model).toBe(generateModel.key));
  });

  it("keeps a local target surface until the selected Project input changes", () => {
    const rendered = renderHook(
      ({ projectId, targetSurface }) => useProjectScreenComposerController({
        allowEdit: false,
        modelCatalogStatus: "ready",
        modelChoices: [generateModel],
        projectId,
        targetSurface,
      }),
      { initialProps: { projectId: "project-1", targetSurface: "app" as const } },
    );

    act(() => rendered.result.current.changeTargetSurface("web"));
    expect(rendered.result.current.selectedTargetSurface).toBe("web");

    rendered.rerender({ projectId: "project-1", targetSurface: "app" });
    expect(rendered.result.current.selectedTargetSurface).toBe("web");

    rendered.rerender({ projectId: "project-2", targetSurface: "app" });
    expect(rendered.result.current.selectedTargetSurface).toBe("app");
  });

  it("freezes a typed screen intent and advances an explicit composer focus request", () => {
    const rendered = renderHook(() => useProjectScreenComposerController({
      allowEdit: true,
      modelCatalogStatus: "ready",
      modelChoices: [generateModel, editModel],
      projectId: "project-1",
      targetSurface: "app",
    }));
    const intent = screenEditIntent();

    act(() => rendered.result.current.beginComposerIntent(intent));
    intent.targets[0]!.title = "Mutated outside";
    expect(rendered.result.current.composerIntent?.targets[0]?.title).toBe("Home");
    expect(rendered.result.current.composerIntent?.modelChoiceKey).toBe(editModel.key);
    expect(rendered.result.current.model).toBe(editModel.key);
    expect(rendered.result.current.focusRequest).toBe(1);
    expect(rendered.result.current.modelMenuOpen).toBe(false);

    act(() => rendered.result.current.clearComposerIntent());
    expect(rendered.result.current.composerIntent).toBeNull();
  });

  it("freezes Generate Prototype targets independently from later canvas selection changes", () => {
    const rendered = renderHook(() => useProjectScreenComposerController({
      allowEdit: true,
      modelCatalogStatus: "ready",
      modelChoices: [generateModel, editModel],
      projectId: "project-1",
      targetSurface: "app",
    }));
    const intent = screenGeneratePrototypeIntent();

    act(() => rendered.result.current.beginComposerIntent(intent));
    intent.artifactTargets[0]!.screenIds.push("screen-mutated");
    intent.targets[0]!.reference.screenId = "screen-mutated";

    expect(rendered.result.current.composerIntent).toMatchObject({
      artifactTargets: [{
        artifactId: prototypeReference.artifactId,
        artifactVersionId: prototypeReference.artifactVersionId,
        screenIds: ["screen-1"],
      }],
      kind: "generate-prototype",
      workflow: "generate",
    });
    expect(rendered.result.current.composerIntent?.targets[0]?.reference.screenId).toBe("screen-1");

    act(() => rendered.result.current.clearComposerIntent());
    expect(rendered.result.current.composerIntent).toBeNull();
  });

  it("keeps the frozen Edit workflow when the live canvas selection becomes ineligible", async () => {
    const rendered = renderHook(
      ({ allowEdit }) => useProjectScreenComposerController({
        allowEdit,
        modelCatalogStatus: "ready",
        modelChoices: [generateModel, editModel],
        projectId: "project-1",
        targetSurface: "app",
      }),
      { initialProps: { allowEdit: true } },
    );
    const intent = screenEditIntent();

    act(() => rendered.result.current.beginComposerIntent(intent));
    rendered.rerender({ allowEdit: false });

    await waitFor(() => expect(rendered.result.current.model).toBe(editModel.key));
    expect(rendered.result.current.composerIntent).toMatchObject({
      artifactTargets: intent.artifactTargets,
      modelChoiceKey: editModel.key,
      workflow: "edit",
    });
    expect(rendered.result.current.projectModelChoices).toContainEqual(editModel);
  });

  it("clears an intent explicitly when its frozen model disappears from the ready catalog", async () => {
    const rendered = renderHook(
      ({ choices }) => useProjectScreenComposerController({
        allowEdit: true,
        modelCatalogStatus: "ready",
        modelChoices: choices,
        projectId: "project-1",
        targetSurface: "app",
      }),
      { initialProps: { choices: [generateModel, editModel] } },
    );

    act(() => rendered.result.current.beginComposerIntent(screenEditIntent()));
    rendered.rerender({ choices: [generateModel] });

    await waitFor(() => expect(rendered.result.current.composerIntent).toBeNull());
    expect(rendered.result.current.model).toBe(generateModel.key);
  });

  it("updates an intent for an explicit same-workflow model choice and clears it across workflows", () => {
    const rendered = renderHook(() => useProjectScreenComposerController({
      allowEdit: true,
      modelCatalogStatus: "ready",
      modelChoices: [generateModel, editModel, fastEditModel],
      projectId: "project-1",
      targetSurface: "app",
    }));
    const intent = screenEditIntent();

    act(() => rendered.result.current.beginComposerIntent(intent));
    act(() => rendered.result.current.selectModel(fastEditModel.key));
    expect(rendered.result.current.composerIntent).toMatchObject({
      artifactTargets: intent.artifactTargets,
      modelChoiceKey: fastEditModel.key,
      workflow: "edit",
    });
    expect(rendered.result.current.model).toBe(fastEditModel.key);

    act(() => rendered.result.current.selectModel(generateModel.key));
    expect(rendered.result.current.composerIntent).toBeNull();
    expect(rendered.result.current.model).toBe(generateModel.key);
  });
});

function screenEditIntent(modelChoiceKey = editModel.key) {
  return {
    artifactTargets: [{
      artifactId: prototypeReference.artifactId,
      artifactVersionId: prototypeReference.artifactVersionId,
      screenIds: [prototypeReference.screenId!],
    }],
    id: "intent-1",
    kind: "agent-edit" as const,
    label: "修改：Home",
    modelChoiceKey,
    targets: [{ nodeId: "node-1", reference: prototypeReference, title: "Home" }],
    workflow: "edit" as const,
  };
}

function screenGeneratePrototypeIntent() {
  return {
    artifactTargets: [{
      artifactId: prototypeReference.artifactId,
      artifactVersionId: prototypeReference.artifactVersionId,
      screenIds: [prototypeReference.screenId!],
    }],
    id: "prototype-intent-1",
    kind: "generate-prototype" as const,
    label: "生成原型：Home",
    modelChoiceKey: generateModel.key,
    targets: [{
      nodeId: "node-1",
      reference: { ...prototypeReference },
      title: "Home",
    }],
    workflow: "generate" as const,
  };
}

describe("ProjectScreen Artifact intent controller", () => {
  it("derives version, style, preference, and Run targets from one persisted selection", () => {
    const selectedPrototype = artifactNode("prototype-node", "generatedScreen", prototypeReference);
    const selection = projectScreenArtifactSelection({
      nodes: [selectedPrototype],
      persistedBoardNodeIds: new Set([selectedPrototype.id]),
    });

    expect(selection).toMatchObject({
      preferenceTargetReference: prototypeReference,
      preferenceTargetScreenId: "screen-1",
      selectedArtifactReference: prototypeReference,
      selectedBoardNodeIds: ["prototype-node"],
      styleTargetReference: prototypeReference,
      prdTargetReference: null,
    });
    expect(selection.editArtifactTargets).toEqual([{
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype",
      screenIds: ["screen-1"],
    }]);

    const selectedPrd = artifactNode("prd-node", "documentCanvas", prdReference);
    const prdSelection = projectScreenArtifactSelection({
      nodes: [selectedPrd],
      persistedBoardNodeIds: new Set([selectedPrd.id]),
    });
    expect(prdSelection.prdTargetReference).toEqual(prdReference);
    expect(prdSelection.styleTargetReference).toBeNull();
  });

  it("retains every selected screen title while grouping Run targets by immutable version", () => {
    const first = artifactNode("node-home", "generatedScreen", prototypeReference);
    const secondReference = { ...prototypeReference, screenId: "screen-settings" };
    const second = artifactNode("node-settings", "generatedScreen", secondReference);
    const selection = projectScreenArtifactSelection({
      nodes: [first, second],
      persistedBoardNodeIds: new Set([first.id, second.id]),
    });

    expect(selection.selectedPrototypeTargets).toEqual([
      { nodeId: "node-home", reference: prototypeReference, title: "node-home" },
      { nodeId: "node-settings", reference: secondReference, title: "node-settings" },
    ]);
    expect(selection.selectedPrototypeRunTargets).toEqual([{
      artifactId: prototypeReference.artifactId,
      artifactVersionId: prototypeReference.artifactVersionId,
      screenIds: ["screen-1", "screen-settings"],
    }]);
  });

  it("owns version-history and optimistic style-draft transitions without saving", async () => {
    const node = artifactNode("prototype-node", "generatedScreen", prototypeReference);
    const selection = projectScreenArtifactSelection({
      nodes: [node],
      persistedBoardNodeIds: new Set([node.id]),
    });
    const editableStyleDocument = applyPrototypeCanvasStyle(prototypeEditorDocumentFixture(), {
      theme: "light",
      radius: 12,
      motionEnabled: false,
      color: "#f1f3f4",
    });
    const rendered = renderHook(() => useProjectScreenArtifactIntentController({
      editableStyleDocument,
      projectId: "project-1",
      selection,
    }));

    await waitFor(() => expect(rendered.result.current.styleDraft).toEqual({
      theme: "light",
      radius: 12,
      motionEnabled: false,
      color: "#f1f3f4",
    }));
    act(() => rendered.result.current.openVersionHistory(prototypeReference));
    expect(rendered.result.current.versionHistoryReference).toEqual(prototypeReference);

    let previousDraft = rendered.result.current.styleDraft;
    act(() => {
      previousDraft = rendered.result.current.beginStyleDraftChange({
        ...rendered.result.current.styleDraft,
        theme: "dark",
      }).previousDraft;
    });
    expect(rendered.result.current.styleDraft).toMatchObject({
      theme: "dark",
      color: "#121315",
    });
    act(() => rendered.result.current.rejectStyleDraftChange(previousDraft, "保存失败"));
    expect(rendered.result.current.styleDraft).toEqual(previousDraft);
    expect(rendered.result.current.styleSaveError).toBe("保存失败");

    act(() => rendered.result.current.closeVersionHistory());
    expect(rendered.result.current.versionHistoryReference).toBeNull();
  });

  it("clears a previous Project's version history and style error in the switch render", async () => {
    const node = artifactNode("prototype-node", "generatedScreen", prototypeReference);
    const selection = projectScreenArtifactSelection({
      nodes: [node],
      persistedBoardNodeIds: new Set([node.id]),
    });
    const rendered = renderHook(
      ({ projectId }) => useProjectScreenArtifactIntentController({
        editableStyleDocument: null,
        projectId,
        selection,
      }),
      { initialProps: { projectId: "project-1" } },
    );

    act(() => rendered.result.current.openVersionHistory(prototypeReference));
    act(() => rendered.result.current.rejectStyleDraftChange(
      rendered.result.current.styleDraft,
      "project-1 failure",
    ));
    expect(rendered.result.current.versionHistoryReference).toEqual(prototypeReference);
    expect(rendered.result.current.styleSaveError).toBe("project-1 failure");

    rendered.rerender({ projectId: "project-2" });

    expect(rendered.result.current.versionHistoryReference).toBeNull();
    expect(rendered.result.current.styleSaveError).toBeNull();
  });
});

describe("ProjectScreen Preview controller", () => {
  it("owns ready notification timing and the preview-open lifecycle", () => {
    vi.useFakeTimers();
    const onBeforeOpen = vi.fn();
    const rendered = renderHook(() => useProjectScreenPreviewController({
      canPreview: true,
      onBeforeOpen,
      projectId: "project-1",
    }));

    act(() => rendered.result.current.scheduleReadyToast(true));
    act(() => vi.advanceTimersByTime(300));
    expect(rendered.result.current.readyToastOpen).toBe(false);

    act(() => rendered.result.current.scheduleReadyToast(true));
    act(() => vi.advanceTimersByTime(459));
    expect(rendered.result.current.readyToastOpen).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(rendered.result.current.readyToastOpen).toBe(true);

    act(() => rendered.result.current.openPreview());
    expect(onBeforeOpen).toHaveBeenCalledOnce();
    expect(rendered.result.current.readyToastOpen).toBe(false);
    expect(rendered.result.current.previewOpen).toBe(true);

    const target = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      projectId: "project-1",
      screenId: "screen-1",
    };
    act(() => rendered.result.current.openPreview(target));
    expect(rendered.result.current.previewReferences).toEqual([target]);
    const secondTarget = {
      artifactId: "artifact-2",
      artifactVersionId: "version-2",
      projectId: "project-1",
      screenId: "screen-2",
    };
    act(() => rendered.result.current.openPreview([target, secondTarget]));
    expect(rendered.result.current.previewReferences).toEqual([target, secondTarget]);
    act(() => rendered.result.current.openPreview());
    expect(rendered.result.current.previewReferences).toEqual([]);

    act(() => rendered.result.current.closePreview());
    expect(rendered.result.current.previewOpen).toBe(false);
  });

  it("rejects unauthorized preview opens and clears its timer on unmount", () => {
    vi.useFakeTimers();
    const onBeforeOpen = vi.fn();
    const rendered = renderHook(() => useProjectScreenPreviewController({
      canPreview: false,
      onBeforeOpen,
      projectId: "project-1",
    }));

    act(() => rendered.result.current.openPreview());
    expect(onBeforeOpen).not.toHaveBeenCalled();
    expect(rendered.result.current.previewOpen).toBe(false);

    act(() => rendered.result.current.scheduleReadyToast(true));
    expect(vi.getTimerCount()).toBe(1);
    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes preview state synchronously and drops the previous Project's timer", () => {
    vi.useFakeTimers();
    const rendered = renderHook(
      ({ projectId }) => useProjectScreenPreviewController({
        canPreview: true,
        onBeforeOpen: vi.fn(),
        projectId,
      }),
      { initialProps: { projectId: "project-1" } },
    );

    act(() => rendered.result.current.openPreview());
    act(() => rendered.result.current.scheduleReadyToast(true));
    expect(rendered.result.current.previewOpen).toBe(true);

    rendered.rerender({ projectId: "project-2" });
    expect(rendered.result.current.previewOpen).toBe(false);
    expect(rendered.result.current.readyToastOpen).toBe(false);

    act(() => vi.advanceTimersByTime(1_000));
    expect(rendered.result.current.readyToastOpen).toBe(false);
  });
});

describe("ProjectScreen Board intent controller", () => {
  it("owns independent rename and delete intent transitions", () => {
    const rendered = renderHook(() => useProjectScreenBoardIntentController({
      projectId: "project-1",
    }));
    const requestedNodeIds = ["node-2", "node-1"];

    act(() => rendered.result.current.openRenameIntent("node-1"));
    act(() => rendered.result.current.openDeleteIntent(requestedNodeIds));
    requestedNodeIds.length = 0;

    expect(rendered.result.current.renameTargetNodeId).toBe("node-1");
    expect(rendered.result.current.pendingDeleteNodeIds).toEqual(["node-2", "node-1"]);

    act(() => rendered.result.current.closeDeleteIntent());
    expect(rendered.result.current.pendingDeleteNodeIds).toEqual([]);
    expect(rendered.result.current.renameTargetNodeId).toBe("node-1");

    act(() => rendered.result.current.closeRenameIntent());
    expect(rendered.result.current.renameTargetNodeId).toBe("");
  });

  it("preserves intents within a Project and resets them after a Project switch", () => {
    const rendered = renderHook(
      ({ projectId }) => useProjectScreenBoardIntentController({ projectId }),
      { initialProps: { projectId: "project-1" } },
    );

    act(() => rendered.result.current.openRenameIntent("node-1"));
    act(() => rendered.result.current.openDeleteIntent(["node-1", "node-2"]));
    rendered.rerender({ projectId: "project-1" });
    expect(rendered.result.current.renameTargetNodeId).toBe("node-1");
    expect(rendered.result.current.pendingDeleteNodeIds).toEqual(["node-1", "node-2"]);

    rendered.rerender({ projectId: "project-2" });
    expect(rendered.result.current.renameTargetNodeId).toBe("");
    expect(rendered.result.current.pendingDeleteNodeIds).toEqual([]);
  });
});

function artifactNode(
  id: string,
  type: "documentCanvas" | "generatedScreen",
  artifact: WorkbenchArtifactReference,
): WorkbenchNode {
  return {
    data: type === "generatedScreen"
      ? { artifact, index: 1, phase: "complete", progress: 100, title: id }
      : { artifact, phase: "complete", title: id },
    id,
    position: { x: 0, y: 0 },
    selected: true,
    type,
  } as WorkbenchNode;
}
