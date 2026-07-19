"use client";

import type {
  PrototypeDocument,
  RunArtifactTarget,
  RunTargetSurface,
} from "@workbench/workbench-contracts";
import { useCallback, useEffect, useMemo } from "react";

import {
  resolveWorkbenchModelChoiceKey,
  visibleWorkbenchModelChoices,
  type WorkbenchModelCatalogState,
  type WorkbenchModelChoice,
} from "@/lib/workbench/features";
import {
  normalizePrototypeCanvasStyleDraft,
  prototypeCanvasStyleDraft,
} from "@/lib/workbench/features/prototype-style";
import {
  toRunArtifactTargets,
} from "@/lib/workbench/run";
import {
  useWorkbenchProjectRef,
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "@/lib/workbench/project-session";
import type { WorkbenchArtifactReference } from "./workbench-artifact-reference";
import type { WorkbenchNode } from "./workbench-board-nodes";
import type { WorkbenchCanvasDesignSystemDraft } from "./workbench-canvas-design-system-panel";

const defaultCanvasStyleDraft: WorkbenchCanvasDesignSystemDraft = {
  theme: "dark",
  radius: 8,
  motionEnabled: true,
  color: "#121315",
};

export type ProjectScreenComposerControllerOptions = {
  allowEdit: boolean;
  modelCatalogStatus: WorkbenchModelCatalogState["status"];
  modelChoices: readonly WorkbenchModelChoice[];
  projectId: string;
  targetSurface: RunTargetSurface;
};

type ProjectScreenComposerIntentBase = {
  artifactTargets: RunArtifactTarget[];
  id: string;
  label: string;
  modelChoiceKey: string;
  targets: Array<{
    nodeId: string;
    reference: WorkbenchArtifactReference;
    title: string;
  }>;
};

export type ProjectScreenComposerIntent =
  | ProjectScreenComposerIntentBase & {
      kind: "agent-edit" | "generate-variants";
      workflow: "edit";
    }
  | ProjectScreenComposerIntentBase & {
      kind: "generate-followup" | "generate-prototype";
      workflow: "generate";
    };

export function useProjectScreenComposerController({
  allowEdit,
  modelCatalogStatus,
  modelChoices,
  projectId,
  targetSurface,
}: ProjectScreenComposerControllerOptions) {
  const session = useWorkbenchProjectSession(projectId);
  const [model, setModel] = useWorkbenchProjectState(session, () => "");
  const [modelMenuOpen, setModelMenuOpen] = useWorkbenchProjectState(session, () => false);
  const [composerIntent, setComposerIntent] = useWorkbenchProjectState<ProjectScreenComposerIntent | null>(
    session,
    () => null,
  );
  const [focusRequest, setFocusRequest] = useWorkbenchProjectState(session, () => 0);
  const [selectedTargetSurface, setSelectedTargetSurface] = useWorkbenchProjectState<RunTargetSurface>(
    session,
    () => targetSurface,
  );
  const defaultModelChoices = useMemo(
    () => visibleWorkbenchModelChoices(modelChoices, { allowEdit }),
    [allowEdit, modelChoices],
  );
  const projectModelChoices = useMemo(
    () => composerIntent?.workflow === "edit"
      ? visibleWorkbenchModelChoices(modelChoices, { allowEdit: true })
      : defaultModelChoices,
    [composerIntent?.workflow, defaultModelChoices, modelChoices],
  );

  useEffect(() => {
    if (modelCatalogStatus === "loading" || modelCatalogStatus === "error") return;
    if (composerIntent) {
      const intentModel = modelChoices.find((choice) => (
        choice.key === composerIntent.modelChoiceKey
      ));
      if (!intentModel || intentModel.workflow !== composerIntent.workflow) {
        setComposerIntent(null);
        const nextModel = resolveWorkbenchModelChoiceKey(model, defaultModelChoices);
        if (nextModel !== model) setModel(nextModel);
        setModelMenuOpen(false);
        return;
      }
      if (model !== composerIntent.modelChoiceKey) {
        setModel(composerIntent.modelChoiceKey);
        setModelMenuOpen(false);
      }
      return;
    }
    const nextModel = resolveWorkbenchModelChoiceKey(model, projectModelChoices);
    if (nextModel !== model) {
      setModel(nextModel);
      setModelMenuOpen(false);
    }
  }, [
    composerIntent,
    defaultModelChoices,
    model,
    modelCatalogStatus,
    modelChoices,
    projectModelChoices,
    setComposerIntent,
    setModel,
    setModelMenuOpen,
  ]);

  useEffect(() => {
    if (modelCatalogStatus !== "ready") setModelMenuOpen(false);
  }, [modelCatalogStatus, setModelMenuOpen]);

  useEffect(() => {
    setSelectedTargetSurface(targetSurface);
  }, [projectId, setSelectedTargetSurface, targetSurface]);

  const changeTargetSurface = useCallback((surface: RunTargetSurface) => {
    setSelectedTargetSurface(surface);
  }, [setSelectedTargetSurface]);
  const beginComposerIntent = useCallback((intent: ProjectScreenComposerIntent) => {
    setComposerIntent(structuredClone(intent));
    setModel(intent.modelChoiceKey);
    setFocusRequest((request) => request + 1);
    setModelMenuOpen(false);
  }, [setComposerIntent, setFocusRequest, setModel, setModelMenuOpen]);
  const clearComposerIntent = useCallback(() => setComposerIntent(null), [setComposerIntent]);
  const closeModelMenu = useCallback(() => setModelMenuOpen(false), [setModelMenuOpen]);
  const selectModel = useCallback((nextModel: string) => {
    const choice = modelChoices.find((candidate) => candidate.key === nextModel);
    if (composerIntent) {
      if (!choice || choice.workflow !== composerIntent.workflow) {
        setComposerIntent(null);
      } else if (nextModel !== composerIntent.modelChoiceKey) {
        setComposerIntent({ ...composerIntent, modelChoiceKey: nextModel });
      }
    }
    setModel(nextModel);
    setModelMenuOpen(false);
  }, [composerIntent, modelChoices, setComposerIntent, setModel, setModelMenuOpen]);
  const toggleModelMenu = useCallback(() => {
    setModelMenuOpen((open) => !open);
  }, [setModelMenuOpen]);

  return {
    beginComposerIntent,
    changeTargetSurface,
    clearComposerIntent,
    closeModelMenu,
    composerIntent,
    focusRequest,
    model,
    modelMenuOpen,
    projectModelChoices,
    selectModel,
    selectedTargetSurface,
    toggleModelMenu,
  };
}

export type ProjectScreenComposerController = ReturnType<
  typeof useProjectScreenComposerController
>;

export type ProjectScreenArtifactSelectionOptions = {
  nodes: readonly WorkbenchNode[];
  persistedBoardNodeIds: ReadonlySet<string>;
};

export function projectScreenArtifactSelection({
  nodes,
  persistedBoardNodeIds,
}: ProjectScreenArtifactSelectionOptions) {
  const selectedBoardNodeIds = nodes
    .filter((node) => node.selected && persistedBoardNodeIds.has(node.id))
    .map((node) => node.id);
  const selectedBoardNode = selectedBoardNodeIds.length === 1
    ? nodes.find((node) => node.id === selectedBoardNodeIds[0])
    : undefined;
  const selectedArtifactReference = projectScreenArtifactReferenceFromNode(selectedBoardNode);
  const editArtifactTargets = toRunArtifactTargets(
    nodes.flatMap((node) => {
      if (!node.selected || !persistedBoardNodeIds.has(node.id)) return [];
      const reference = projectScreenArtifactReferenceFromNode(node);
      return reference ? [reference] : [];
    }),
  );
  const preferenceTargetScreenId = selectedArtifactReference?.screenId ?? null;
  const preferenceTargetReference = selectedBoardNode?.type === "generatedScreen"
    && preferenceTargetScreenId
    ? selectedArtifactReference
    : null;
  const selectedPrototypeTargets = nodes.flatMap((node) => {
    if (!node.selected || !persistedBoardNodeIds.has(node.id) || node.type !== "generatedScreen") return [];
    const reference = projectScreenArtifactReferenceFromNode(node);
    return reference?.screenId ? [{ nodeId: node.id, reference, title: node.data.title }] : [];
  });
  const styleTargetReference = selectedBoardNode?.type === "generatedScreen"
    ? selectedArtifactReference
    : null;
  const prdTargetReference = selectedBoardNode?.type === "documentCanvas"
    ? selectedArtifactReference
    : null;

  return {
    editArtifactTargets,
    prdTargetReference,
    preferenceTargetReference,
    preferenceTargetScreenId,
    selectedArtifactReference,
    selectedBoardNode,
    selectedBoardNodeIds,
    selectedPrototypeRunTargets: toRunArtifactTargets(
      selectedPrototypeTargets.map((target) => target.reference),
    ),
    selectedPrototypeTargets,
    styleTargetArtifactId: styleTargetReference?.artifactId ?? "",
    styleTargetReference,
    styleTargetVersionId: styleTargetReference?.artifactVersionId ?? "",
  };
}

export type ProjectScreenArtifactSelection = ReturnType<
  typeof projectScreenArtifactSelection
>;

export type ProjectScreenArtifactIntentControllerOptions = {
  editableStyleDocument: PrototypeDocument | null;
  projectId: string;
  selection: ProjectScreenArtifactSelection;
};

export function useProjectScreenArtifactIntentController({
  editableStyleDocument,
  projectId,
  selection,
}: ProjectScreenArtifactIntentControllerOptions) {
  const session = useWorkbenchProjectSession(projectId);
  const [versionHistoryReference, setVersionHistoryReference] = useWorkbenchProjectState<WorkbenchArtifactReference | null>(
    session,
    () => null,
  );
  const [styleDraft, setStyleDraft] = useWorkbenchProjectState<WorkbenchCanvasDesignSystemDraft>(
    session,
    () => defaultCanvasStyleDraft,
  );
  const [styleSaveError, setStyleSaveError] = useWorkbenchProjectState<string | null>(
    session,
    () => null,
  );
  const { styleTargetArtifactId, styleTargetVersionId } = selection;

  useEffect(() => {
    setStyleSaveError(null);
    if (editableStyleDocument) setStyleDraft(prototypeCanvasStyleDraft(editableStyleDocument));
    else setStyleDraft(defaultCanvasStyleDraft);
  }, [
    editableStyleDocument,
    setStyleDraft,
    setStyleSaveError,
    styleTargetArtifactId,
    styleTargetVersionId,
  ]);

  const beginStyleDraftChange = useCallback((nextDraft: WorkbenchCanvasDesignSystemDraft) => {
    const previousDraft = styleDraft;
    const normalizedDraft = normalizePrototypeCanvasStyleDraft(previousDraft, nextDraft);
    setStyleDraft(normalizedDraft);
    setStyleSaveError(null);
    return { normalizedDraft, previousDraft };
  }, [setStyleDraft, setStyleSaveError, styleDraft]);
  const clearStyleSaveError = useCallback(() => setStyleSaveError(null), [setStyleSaveError]);
  const closeVersionHistory = useCallback(
    () => setVersionHistoryReference(null),
    [setVersionHistoryReference],
  );
  const openVersionHistory = useCallback((reference: WorkbenchArtifactReference) => {
    setVersionHistoryReference(reference);
  }, [setVersionHistoryReference]);
  const rejectStyleDraftChange = useCallback((
    previousDraft: WorkbenchCanvasDesignSystemDraft,
    message: string,
  ) => {
    setStyleDraft(previousDraft);
    setStyleSaveError(message);
  }, [setStyleDraft, setStyleSaveError]);

  return {
    beginStyleDraftChange,
    clearStyleSaveError,
    closeVersionHistory,
    openVersionHistory,
    rejectStyleDraftChange,
    styleDraft,
    styleSaveError,
    versionHistoryReference,
  };
}

export type ProjectScreenArtifactIntentController = ReturnType<
  typeof useProjectScreenArtifactIntentController
>;

export function projectScreenArtifactReferenceFromNode(
  node: WorkbenchNode | undefined,
): WorkbenchArtifactReference | null {
  if (!node || !("artifact" in node.data)) return null;
  return node.data.artifact ?? null;
}

export type ProjectScreenPreviewControllerOptions = {
  canPreview: boolean;
  onBeforeOpen: () => void;
  projectId: string;
};

export function useProjectScreenPreviewController({
  canPreview,
  onBeforeOpen,
  projectId,
}: ProjectScreenPreviewControllerOptions) {
  const session = useWorkbenchProjectSession(projectId);
  const [previewOpen, setPreviewOpen] = useWorkbenchProjectState(session, () => false);
  const [previewReferences, setPreviewReferences] = useWorkbenchProjectState<WorkbenchArtifactReference[]>(
    session,
    () => [],
  );
  const [readyToastOpen, setReadyToastOpen] = useWorkbenchProjectState(session, () => false);
  const readyToastTimerRef = useWorkbenchProjectRef<number | null>(session, () => null);

  const cancelReadyToastTimer = useCallback(() => {
    if (readyToastTimerRef.current === null) return;
    window.clearTimeout(readyToastTimerRef.current);
    readyToastTimerRef.current = null;
  }, [readyToastTimerRef]);
  const closePreview = useCallback(() => setPreviewOpen(false), [setPreviewOpen]);
  const hideReadyToast = useCallback(() => setReadyToastOpen(false), [setReadyToastOpen]);
  const openPreview = useCallback((
    references?: WorkbenchArtifactReference | readonly WorkbenchArtifactReference[],
  ) => {
    const selected = references
      ? Array.isArray(references) ? references : [references]
      : [];
    if (
      !canPreview
      || selected.some((reference) => reference.projectId !== projectId)
    ) return false;
    onBeforeOpen();
    setPreviewReferences(selected.map((reference) => ({ ...reference })));
    setReadyToastOpen(false);
    setPreviewOpen(true);
    return true;
  }, [canPreview, onBeforeOpen, projectId, setPreviewOpen, setPreviewReferences, setReadyToastOpen]);
  const scheduleReadyToast = useCallback((showAfterDelay: boolean) => {
    cancelReadyToastTimer();
    setReadyToastOpen(false);
    if (!showAfterDelay) return;
    readyToastTimerRef.current = window.setTimeout(() => {
      if (!session.isCurrent()) return;
      setReadyToastOpen(true);
      readyToastTimerRef.current = null;
    }, 460);
  }, [cancelReadyToastTimer, readyToastTimerRef, session, setReadyToastOpen]);

  useEffect(() => cancelReadyToastTimer, [cancelReadyToastTimer]);

  return {
    closePreview,
    hideReadyToast,
    openPreview,
    previewOpen,
    previewReferences,
    readyToastOpen,
    scheduleReadyToast,
  };
}

export type ProjectScreenPreviewController = ReturnType<
  typeof useProjectScreenPreviewController
>;

export type ProjectScreenBoardIntentControllerOptions = {
  projectId: string;
};

export function useProjectScreenBoardIntentController({
  projectId,
}: ProjectScreenBoardIntentControllerOptions) {
  const session = useWorkbenchProjectSession(projectId);
  const [renameTargetNodeId, setRenameTargetNodeId] = useWorkbenchProjectState(session, () => "");
  const [pendingDeleteNodeIds, setPendingDeleteNodeIds] = useWorkbenchProjectState<string[]>(
    session,
    () => [],
  );

  const closeDeleteIntent = useCallback(
    () => setPendingDeleteNodeIds([]),
    [setPendingDeleteNodeIds],
  );
  const closeRenameIntent = useCallback(
    () => setRenameTargetNodeId(""),
    [setRenameTargetNodeId],
  );
  const openDeleteIntent = useCallback((nodeIds: readonly string[]) => {
    setPendingDeleteNodeIds([...nodeIds]);
  }, [setPendingDeleteNodeIds]);
  const openRenameIntent = useCallback((nodeId: string) => {
    setRenameTargetNodeId(nodeId);
  }, [setRenameTargetNodeId]);

  return {
    closeDeleteIntent,
    closeRenameIntent,
    openDeleteIntent,
    openRenameIntent,
    pendingDeleteNodeIds,
    renameTargetNodeId,
  };
}

export type ProjectScreenBoardIntentController = ReturnType<
  typeof useProjectScreenBoardIntentController
>;
