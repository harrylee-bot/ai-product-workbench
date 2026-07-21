"use client";

import "./workbench-project.css";

import {
  applyNodeChanges,
  getViewportForBounds,
  type NodeChange,
  type OnSelectionChangeFunc,
  ReactFlowProvider,
  useReactFlow,
  type Viewport,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { toast } from "sonner";
import type {
  ArtifactVersionDetail,
  DesignPresetCatalogItem,
  CanvasScreenSummary,
  CanvasScreenReference,
  ExportSelection,
  PrdDocument,
  PrototypeDocument,
  Run,
  RunApproval,
  RunGenerationStage,
  RunTargetSurface,
} from "@workbench/workbench-contracts";
import { cn } from "@/lib/utils";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  CanvasAgentCommandPoller,
  captureCanvasVisual,
  createCanvasAgentClientStateSyncRequest,
  createCanvasAgentSnapshot,
  createWorkbenchCanvasAgentCommandApi,
  type CanvasAgentUiPort,
} from "@/lib/workbench/features/canvas-agent";
import {
  boardNodeActionAvailability,
  createBoardRecoveryDocument,
  serializeBoardRecoveryDocument,
  type CreateBoardArtifactInput,
  type BoardNodeArrangeOperation,
  type BoardNodeArrangeOutcome,
  type BoardDrawingSample,
  type BoardFlowNode,
  type BoardRect,
  type CreateBoardDrawingOptions,
} from "@/lib/workbench/features/board";
import { writeWorkbenchClipboard } from "@/lib/workbench/browser/clipboard";
import {
  isValidEditArtifactTargets,
  workbenchRunIsActive,
} from "@/lib/workbench/run";
import type { RunArtifactDraftProjection } from "@/lib/workbench/run/reducer";
import type { WorkbenchArtifactReference } from "./workbench-artifact-content";
import {
  ArtifactPreferenceToggleCoordinator,
  useWorkbenchProjectActionsController,
  useWorkbenchCanvasMediaController,
  useWorkbenchPublicationController,
  useWorkbenchRunActions,
  useCreateWorkbenchArtifactVersion,
  useWorkbenchArtifact,
  useWorkbenchArtifactVersion,
  useWorkbenchArtifactVersionBatch,
  useWorkbenchArtifactVersionPreference,
  useUpdateWorkbenchArtifactVersionPreference,
  prototypeDocumentEditIdempotencyKey,
  prdDocumentEditIdempotencyKey,
  workbenchCanvasPermissions,
  visibleWorkbenchNodeChanges,
  type WorkbenchModelChoice,
  type WorkbenchProjectMode,
  type WorkbenchProjectPhase,
  type WorkbenchProjectDesignSystemChoice,
  type WorkbenchRunActivityItem,
  type WorkbenchRunMessageItem,
  type WorkbenchRunSubmission,
  type WorkbenchProjectCapabilities,
  type WorkbenchProjectActionOperations,
  type PrototypePatchProjectorStore,
  createWorkbenchBoardNodeUrl,
  readWorkbenchBoardNodeId,
  readWorkbenchProjectId,
  writeWorkbenchBoardNodeUrl,
  pinWorkbenchArtifactVersion,
  analyzePrototypeScreenRuntime,
  deriveScreenContextState,
  type ScreenContextTarget,
  type WorkbenchModelCatalogState,
} from "@/lib/workbench/features";
import {
  applyPrototypeCanvasStyle,
} from "@/lib/workbench/features/prototype-style";
import type { WorkbenchCanvasDesignSystemDraft } from "./workbench-canvas-design-system-panel";
import {
  type WorkbenchArtifactPreferenceAction,
} from "./workbench-artifact-preference-actions";
import {
  ProjectScreenView,
  type ProjectScreenViewContract,
} from "./workbench-project-screen-view";
import type { WorkbenchScreenContextToolbarModel } from "./workbench-screen-context-toolbar";
import {
  projectScreenArtifactReferenceFromNode,
  projectScreenArtifactSelection,
  type ProjectScreenComposerIntent,
  useProjectScreenArtifactIntentController,
  useProjectScreenBoardIntentController,
  useProjectScreenComposerController,
  useProjectScreenPreviewController,
} from "./workbench-project-screen-controller";
import { WorkbenchShareDialog } from "./workbench-share-dialog";
import { ExportDialog } from "./workbench-export-dialog";
import {
  WorkbenchBoardConflictDialog,
  type WorkbenchBoardConflictAction,
} from "./workbench-board-conflict-dialog";
import { useWorkbenchPointerVars } from "./workbench-surface-primitives";
import {
  type BoardDrawingNode,
  type BoardFrameNode,
  type DocumentCanvasNode,
  type GeneratedScreenNode,
  type OverviewArtifactData,
  type OverviewArtifactNode,
  type WorkbenchNode,
} from "./workbench-board-nodes";
import type {
  CanvasInteractionMode,
  CanvasMainCommand,
  CanvasMoreCommand,
  CanvasSelectionTarget,
  CanvasToolEnvironment,
  CanvasPanel,
} from "@/lib/workbench/canvas-tools";
import {
  canvasDirectEditAvailability,
  canvasPanelAccess,
  normalizeCanvasToolsState,
  transitionCanvasTools,
} from "@/lib/workbench/canvas-tools";
import {
  reduceWorkbenchProjectNodeChanges,
} from "./workbench-project-react-flow-adapter";
import { useWorkbenchRuntime } from "./workbench-runtime-context";
import { useWorkbenchTransport } from "@/lib/workbench/transport/context";
import {
  useWorkbenchProjectRef,
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "@/lib/workbench/project-session";

type ProjectMode = WorkbenchProjectMode;
type Phase = WorkbenchProjectPhase;
type WorkbenchRunSubmitHandler = (
  submission: WorkbenchRunSubmission,
) => Promise<string | null>;
type WorkbenchCanvasSelection = {
  artifact: WorkbenchArtifactReference | null;
  hasSelection: boolean;
  nodeIds: string[];
};

type ProjectPrototypePreviewTarget = {
  nodeId: string;
  reference: WorkbenchArtifactReference;
  title: string;
};

export function projectReadyPrototypePreviewArtifacts(
  targets: readonly ProjectPrototypePreviewTarget[],
  versions: readonly ArtifactVersionDetail[],
) {
  const versionsByIdentity = new Map(versions.map((version) => [
    artifactVersionLookupKey(version.artifactId, version.artifactVersionId),
    version,
  ]));
  return targets.flatMap(({ reference, title }) => {
    if (!reference.screenId) return [];
    const version = versionsByIdentity.get(artifactVersionLookupKey(
      reference.artifactId,
      reference.artifactVersionId,
    )) ?? null;
    return analyzePrototypeScreenRuntime(version, reference.screenId).kind === "runnable"
      ? [{ reference, title }]
      : [];
  });
}


const boardZoomDisplayRatio = 63 / 34;
const generatedOverviewActualZoom = 0.155;

const selectedArtboardBounds = {
  height: 1880,
  width: 2380,
  x: 2740,
  y: 150,
};
const initialBoardDisplayZoom = 0.63;
const initialBoardZoom = initialBoardDisplayZoom / boardZoomDisplayRatio;

function workbenchNodeCanvasSize(node: WorkbenchNode): { height: number; width: number } {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : 0;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : 0;
  return {
    width: node.measured?.width ?? node.width ?? styleWidth,
    height: node.measured?.height ?? node.height ?? styleHeight,
  };
}

function canvasScreenSummaryFromBoardNode(node: BoardFlowNode): CanvasScreenSummary | null {
  if (
    node.workbench.kind !== "artifact"
    || node.data.nodeType !== "artifact"
    || node.data.artifactKind !== "prototype"
    || !node.data.screenId
    || !node.workbench.artifactId
    || !node.workbench.artifactVersionId
    || !node.workbench.size
  ) return null;
  return {
    reference: {
      boardNodeId: node.id,
      artifactId: node.workbench.artifactId,
      artifactVersionId: node.workbench.artifactVersionId,
      screenId: node.data.screenId,
    },
    name: node.data.title,
    route: node.data.route ?? `/canvas/${encodeURIComponent(node.data.screenId)}`,
    phase: "complete",
    viewport: {
      width: Math.max(1, Math.round(node.workbench.size.width)),
      height: Math.max(1, Math.round(node.workbench.size.height)),
    },
  };
}

function canvasScreenReferenceMatches(
  reference: CanvasScreenReference,
  node: BoardFlowNode,
): boolean {
  const summary = canvasScreenSummaryFromBoardNode(node);
  return summary !== null
    && summary.reference.boardNodeId === reference.boardNodeId
    && summary.reference.artifactId === reference.artifactId
    && summary.reference.artifactVersionId === reference.artifactVersionId
    && summary.reference.screenId === reference.screenId;
}

function artifactVersionLookupKey(artifactId: string, artifactVersionId: string): string {
  return `${artifactId}\u0000${artifactVersionId}`;
}

function selectedRootNodes(
  nodes: readonly WorkbenchNode[],
  selectedNodeIds: readonly string[],
): WorkbenchNode[] {
  const selected = new Set(selectedNodeIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    if (!selected.has(node.id)) return false;
    const visited = new Set<string>();
    let parentId = node.parentId;
    while (parentId) {
      if (visited.has(parentId)) return false;
      if (selected.has(parentId)) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  });
}

function getBoardViewport(containerWidth = 1440, containerHeight = 900): Viewport {
  const zoom = initialBoardZoom;
  const selectedRightAtOrigin =
    (selectedArtboardBounds.x + selectedArtboardBounds.width) * zoom;
  const rightInset = containerWidth < 920
    ? 24
    : containerWidth < 1500
      ? Math.max(220, containerWidth * 0.2)
      : Math.min(410, Math.max(300, containerWidth * 0.21));
  const preferredLeft =
    containerWidth < 920 ? 20 : Math.min(245, Math.max(150, containerWidth * 0.12));
  const minLeft = containerWidth < 920 ? -560 : containerWidth < 1500 ? -500 : -300;
  const targetLeft = Math.max(
    minLeft,
    Math.min(preferredLeft, containerWidth - rightInset - selectedRightAtOrigin),
  );
  const targetTop = containerHeight < 720 ? 92 : 94;

  return {
    x: Math.round(targetLeft),
    y: Math.round(targetTop - 150 * zoom),
    zoom,
  };
}

function getDocumentViewport(containerWidth = 1440, containerHeight = 900): Viewport {
  const responsiveScale = containerWidth < 1500 ? 0.88 : 1;
  const zoom = (0.93 / boardZoomDisplayRatio) * responsiveScale;
  const targetLeft = containerWidth < 1500
    ? Math.round(containerWidth * 0.315)
    : Math.round(containerWidth * 0.313);
  const top = containerHeight < 720 ? 86 : 92;

  return {
    x: targetLeft,
    y: top,
    zoom,
  };
}

function getGeneratedViewport(
  containerWidth = 1440,
  containerHeight = 900,
  phase: Phase = "generating",
): Viewport {
  const responsiveScale = containerWidth < 920
    ? 0.78
    : containerWidth < 1280 ? 0.94 : 1;
  const phaseScale = phase === "complete" ? 1 : 1.17;
  const zoom = (0.93 / boardZoomDisplayRatio) * responsiveScale * phaseScale;
  const completeLeftRatio = containerWidth > 1700
    ? 0.36
    : containerWidth < 1500 ? 0.30 : 0.275;
  const targetLeft = phase === "complete"
    ? Math.round(containerWidth * completeLeftRatio)
    : Math.round(containerWidth * 0.215);
  const top = containerHeight < 720
    ? 68
    : phase === "complete" ? (containerHeight < 760 ? 78 : 124) : 70;

  return {
    x: targetLeft,
    y: top,
    zoom,
  };
}

export function boardNodesForPhase(
  _phase: Phase,
  _projectMode: ProjectMode,
  _generationProgress = 0,
  _prompt = "",
): WorkbenchNode[] {
  return [];
}

function persistedBoardNodesToWorkbench(
  nodes: readonly BoardFlowNode[],
  projectId: string,
  suppressEntranceKeys: ReadonlySet<string> = new Set(),
): WorkbenchNode[] {
  return nodes.map((node, index) => {
    const title = node.data.title;
    const { draggable: _persistedDraggable, ...persistedNode } = node;
    const common = {
      ...persistedNode,
      position: { ...node.position },
      selected: false,
      style: node.style ? { ...node.style } : undefined,
    };

    if (node.data.nodeType === "frame") {
      return {
        ...common,
        data: node.data,
        type: "frame",
      } as BoardFrameNode;
    }
    if (node.data.nodeType === "drawing") {
      return {
        ...common,
        data: node.data,
        type: "drawing",
      } as BoardDrawingNode;
    }

    const artifactKind = node.data.artifactKind;
    const artifact = node.workbench.artifactId && node.workbench.artifactVersionId
      ? {
          artifactId: node.workbench.artifactId,
          artifactVersionId: node.workbench.artifactVersionId,
          projectId,
          ...(node.data.screenId ? { screenId: node.data.screenId } : {}),
        }
      : undefined;
    const suppressEntrance = artifact
      ? suppressEntranceKeys.has(artifactNodeKey(artifact))
      : false;

    if (artifactKind === "prd") {
      return {
        ...common,
        data: {
          artifact,
          phase: "complete",
          ...(suppressEntrance ? { suppressEntrance: true } : {}),
          title,
        },
        type: "documentCanvas",
      } as DocumentCanvasNode;
    }
    if (artifactKind === "prototype") {
      return {
        ...common,
        data: {
          artifact,
          index,
          phase: "complete",
          ...(suppressEntrance ? { suppressEntrance: true } : {}),
          title,
        },
        type: "generatedScreen",
      } as GeneratedScreenNode;
    }

    const overviewKind: OverviewArtifactData["kind"] = artifactKind === "image"
      ? "image"
      : artifactKind === "code"
        ? "code"
        : "doc";
    return {
      ...common,
      data: { artifact, kind: overviewKind, phase: "complete", title },
      type: "overviewArtifact",
    } as OverviewArtifactNode;
  });
}

export function runtimeDraftsToWorkbench(
  drafts: readonly RunArtifactDraftProjection[],
  projectId: string,
  startX = 0,
): WorkbenchNode[] {
  let screenIndex = 0;
  let nextX = startX;
  const nodes: WorkbenchNode[] = [];
  for (const draft of drafts) {
    const reference = {
      artifactId: draft.artifactId,
      artifactVersionId: draft.artifactVersionId,
      projectId,
    };
    if (draft.kind === "prototype") {
      for (const screen of draft.screens) {
        const index = screenIndex++;
        const { height, width } = screen.viewport;
        nodes.push({
          data: {
            artifact: { ...reference, screenId: screen.id },
            index,
            phase: "refining",
            title: screen.name,
          },
          draggable: false,
          height,
          id: `run-draft:${draft.artifactId}:${screen.id}`,
          position: { x: nextX, y: 0 },
          selectable: false,
          selected: false,
          style: { height, width },
          type: "generatedScreen",
          width,
        } satisfies GeneratedScreenNode);
        nextX += width + 80;
      }
      continue;
    }
    if (draft.kind === "prd") {
      const height = 1440;
      const width = 1120;
      nodes.push({
        data: { artifact: reference, phase: "refining", title: "需求文档" },
        draggable: false,
        height,
        id: `run-draft:${draft.artifactId}:document`,
        position: { x: nextX, y: 0 },
        selectable: false,
        selected: false,
        style: { height, width },
        type: "documentCanvas",
        width,
      } satisfies DocumentCanvasNode);
      nextX += width + 80;
      continue;
    }

    const height = 600;
    const width = 800;
    const kind: OverviewArtifactData["kind"] = draft.kind === "image"
      ? "image"
      : draft.kind === "code" ? "code" : "doc";
    nodes.push({
      data: {
        artifact: reference,
        kind,
        phase: "refining",
        title: runtimeDraftTitle(draft.kind),
      },
      draggable: false,
      height,
      id: `run-draft:${draft.artifactId}:artifact`,
      position: { x: nextX, y: 0 },
      selectable: false,
      selected: false,
      style: { height, width },
      type: "overviewArtifact",
      width,
    } satisfies OverviewArtifactNode);
    nextX += width + 80;
  }
  return nodes;
}

export function projectRunBoardNodes({
  drafts,
  persistedBoardNodes,
  projectId,
  runStatus,
}: {
  drafts: readonly RunArtifactDraftProjection[];
  persistedBoardNodes: readonly BoardFlowNode[];
  projectId: string;
  runStatus: Run["status"] | null;
}): WorkbenchNode[] {
  const persisted = persistedBoardNodesToWorkbench(persistedBoardNodes, projectId);
  if (drafts.length === 0) return persisted;

  const draftNodes = runtimeDraftsToWorkbench(
    drafts,
    projectId,
    nextAvailableDraftX(persisted),
  );
  if (workbenchRunIsActive(runStatus)) {
    return mergeDraftNodes(persisted, draftNodes, false);
  }
  if (runStatus !== "succeeded") return persisted;

  const finalDraftNodes = draftNodes.map((node) => draftNodeWithPhase(node, "complete"));
  if (!persistedContainsFinalDrafts(persisted, finalDraftNodes)) {
    return mergeDraftNodes(persisted, finalDraftNodes, true);
  }
  const suppressEntranceKeys = new Set(
    finalDraftNodes.flatMap((node) => {
      const key = artifactNodeKeyFromNode(node);
      return key ? [key] : [];
    }),
  );
  return persistedBoardNodesToWorkbench(persistedBoardNodes, projectId, suppressEntranceKeys);
}

export function mergeCanvasNodeSelection(
  projectedNodes: readonly WorkbenchNode[],
  currentNodes: readonly WorkbenchNode[],
  requestedNodeId: string,
): WorkbenchNode[] {
  const projectedIds = new Set(projectedNodes.map((node) => node.id));
  const currentSelectedIds = new Set(
    currentNodes.filter((node) => node.selected).map((node) => node.id),
  );
  const selectedIds = requestedNodeId && projectedIds.has(requestedNodeId)
    ? new Set([requestedNodeId])
    : new Set([...currentSelectedIds].filter((nodeId) => projectedIds.has(nodeId)));

  return projectedNodes.map((node) => {
    const selected = selectedIds.has(node.id);
    return node.selected === selected ? node : { ...node, selected };
  });
}

function mergeDraftNodes(
  persisted: readonly WorkbenchNode[],
  draftNodes: readonly WorkbenchNode[],
  terminal: boolean,
): WorkbenchNode[] {
  const targetedArtifactIds = new Set(draftNodes.flatMap((node) => {
    const reference = projectScreenArtifactReferenceFromNode(node);
    return reference ? [reference.artifactId] : [];
  }));
  const persistedByKey = new Map(persisted.flatMap((node) => {
    const key = artifactNodeKeyFromNode(node);
    return key ? [[key, node] as const] : [];
  }));
  const retained = persisted.filter((node) => {
    const reference = projectScreenArtifactReferenceFromNode(node);
    return !reference || !targetedArtifactIds.has(reference.artifactId);
  });
  const projectedDrafts = draftNodes.map((draftNode) => {
    const key = artifactNodeKeyFromNode(draftNode);
    const existing = key ? persistedByKey.get(key) : undefined;
    if (!existing) return draftNode;
    return {
      ...existing,
      ...draftNode,
      draggable: terminal ? existing.draggable : false,
      id: existing.id,
      position: { ...existing.position },
      selectable: terminal ? existing.selectable : false,
      selected: terminal ? existing.selected : false,
      style: draftNode.style ? { ...draftNode.style } : undefined,
    } as WorkbenchNode;
  });
  return [...retained, ...projectedDrafts];
}

function persistedContainsFinalDrafts(
  persisted: readonly WorkbenchNode[],
  finalDraftNodes: readonly WorkbenchNode[],
): boolean {
  const persistedByKey = new Map(persisted.flatMap((node) => {
    const key = artifactNodeKeyFromNode(node);
    return key ? [[key, projectScreenArtifactReferenceFromNode(node)] as const] : [];
  }));
  return finalDraftNodes.every((node) => {
    const reference = projectScreenArtifactReferenceFromNode(node);
    const persistedReference = reference
      ? persistedByKey.get(artifactNodeKey(reference))
      : null;
    return Boolean(
      reference
      && persistedReference
      && persistedReference.artifactVersionId === reference.artifactVersionId,
    );
  });
}

function draftNodeWithPhase(node: WorkbenchNode, phase: Phase): WorkbenchNode {
  if (
    node.type === "generatedScreen"
    || node.type === "documentCanvas"
    || node.type === "overviewArtifact"
  ) {
    return { ...node, data: { ...node.data, phase } } as WorkbenchNode;
  }
  return node;
}

function artifactNodeKeyFromNode(node: WorkbenchNode): string | null {
  const reference = projectScreenArtifactReferenceFromNode(node);
  return reference ? artifactNodeKey(reference) : null;
}

function artifactNodeKey(reference: WorkbenchArtifactReference): string {
  return `${reference.artifactId}:${reference.screenId ?? "root"}`;
}

function nextAvailableDraftX(nodes: readonly WorkbenchNode[]): number {
  return nodes.reduce((right, node) => {
    const width = typeof node.style?.width === "number"
      ? node.style.width
      : node.width ?? 0;
    return Math.max(right, node.position.x + width + 80);
  }, 0);
}

function runtimeDraftTitle(kind: RunArtifactDraftProjection["kind"]): string {
  switch (kind) {
    case "image": return "图像草稿";
    case "code": return "代码草稿";
    case "document": return "文档草稿";
    case "data": return "数据草稿";
    case "prd": return "需求文档";
    case "prototype": return "界面草稿";
  }
}

function downloadTextFile(fileName: string, content: string, mediaType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = url;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

function newClientSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

const EMPTY_BOARD_NODES: BoardFlowNode[] = [];

export function WorkbenchProjectRoute() {
  return (
    <ReactFlowProvider>
      <WorkbenchProjectRouteInner />
    </ReactFlowProvider>
  );
}

function WorkbenchProjectRouteInner() {
  const { user } = useWorkbenchAuth();
  const principalCacheNamespace = user?.id ?? "";
  const {
    activePanel,
    activeTool,
    closeProject,
    openProject,
    persistedPrompt,
    projectDraft,
    routeView,
    setActivePanel,
    setActiveTool,
    setPersistedPrompt,
    setProjectDraft,
    workbench,
  } = useWorkbenchRuntime();
  const projectSession = useWorkbenchProjectSession(workbench.selectedProjectId);
  const publication = useWorkbenchPublicationController({
    boardController: workbench.boardController,
    canExport: workbench.capabilities.canExport,
    canPreview: workbench.capabilities.canPreview,
    canShare: workbench.capabilities.canShare,
    projectId: workbench.selectedProjectId,
  });
  const runActions = useWorkbenchRunActions(workbench.currentRun, workbench.adoptRun);
  const [shareOpen, setShareOpen] = useWorkbenchProjectState(projectSession, () => false);
  const [exportOpen, setExportOpen] = useWorkbenchProjectState(projectSession, () => false);
  const [boardConflictOpen, setBoardConflictOpen] = useWorkbenchProjectState(
    projectSession,
    () => false,
  );
  const [boardConflictAction, setBoardConflictAction] = useWorkbenchProjectState<WorkbenchBoardConflictAction>(
    projectSession,
    () => null,
  );
  const [boardConflictError, setBoardConflictError] = useWorkbenchProjectState<string | null>(
    projectSession,
    () => null,
  );
  const [canvasSelection, setCanvasSelection] = useWorkbenchProjectState<WorkbenchCanvasSelection>(
    projectSession,
    () => ({
      artifact: null,
      hasSelection: false,
      nodeIds: [],
    }),
  );
  const [selectAllRequest, setSelectAllRequest] = useWorkbenchProjectState(
    projectSession,
    () => 0,
  );
  const hydratedPromptProjectRef = useWorkbenchProjectRef(projectSession, () => "");

  useEffect(() => {
    if (routeView === "project") return;
    setShareOpen(false);
    setExportOpen(false);
    setBoardConflictOpen(false);
  }, [routeView, setBoardConflictOpen, setExportOpen, setShareOpen]);

  useEffect(() => {
    const closeGlobalPanels = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShareOpen(false);
      setExportOpen(false);
    };

    window.addEventListener("keydown", closeGlobalPanels);
    return () => window.removeEventListener("keydown", closeGlobalPanels);
  }, [setExportOpen, setShareOpen]);

  useEffect(() => {
    const closeGlobalPanelsOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest("[data-workbench-global-panel]")
        || target.closest("[data-global-panel-trigger]")
      ) {
        return;
      }

      setShareOpen(false);
    };

    window.addEventListener("mousedown", closeGlobalPanelsOnOutsidePointer, true);
    return () => window.removeEventListener("mousedown", closeGlobalPanelsOnOutsidePointer, true);
  }, [setShareOpen]);

  useEffect(() => {
    if (!workbench.bootstrap || workbench.bootstrap.project.id !== workbench.selectedProjectId) return;
    if (hydratedPromptProjectRef.current === workbench.selectedProjectId) return;
    hydratedPromptProjectRef.current = workbench.selectedProjectId;
    setPersistedPrompt(workbench.latestPrompt);
  }, [
    hydratedPromptProjectRef,
    setPersistedPrompt,
    workbench.bootstrap,
    workbench.latestPrompt,
    workbench.selectedProjectId,
  ]);

  const boardSaveStatus = workbench.boardController.state?.saveStatus;
  const boardSaveError = workbench.boardController.state?.lastSaveError;
  useEffect(() => {
    const toastId = workbench.selectedProjectId
      ? `workbench-board-save:${workbench.selectedProjectId}`
      : "workbench-board-save";
    if (boardSaveStatus === "error") {
      toast.error("项目画布保存失败，本次修改仍保留在本地", {
        id: toastId,
        action: {
          label: "重试保存",
          onClick: () => {
            void workbench.retryBoardSave().catch(() => {
              if (projectSession.isCurrent()) {
                toast.error("项目画布仍未保存，请检查网络后重试", { id: toastId });
              }
            });
          },
        },
      });
      return () => {
        toast.dismiss(toastId);
      };
    }
    if (boardSaveStatus === "conflict") {
      setBoardConflictOpen(true);
      toast.error("项目画布已在其他位置更新，本地修改尚未保存", {
        id: toastId,
        action: {
          label: "处理冲突",
          onClick: () => setBoardConflictOpen(true),
        },
      });
      return () => {
        toast.dismiss(toastId);
      };
    }
    if (boardSaveStatus === "clean") {
      setBoardConflictOpen(false);
      setBoardConflictAction(null);
      setBoardConflictError(null);
      toast.dismiss(toastId);
    }
  }, [
    boardSaveError,
    boardSaveStatus,
    projectSession,
    setBoardConflictAction,
    setBoardConflictError,
    setBoardConflictOpen,
    workbench.retryBoardSave,
    workbench.selectedProjectId,
  ]);

  const exportLocalBoardRecovery = useCallback(() => {
    const state = workbench.boardController.store?.getState();
    if (!state) {
      toast.error("项目画布尚未就绪，无法导出本地副本");
      return;
    }
    const recovery = createBoardRecoveryDocument(state);
    downloadTextFile(
      `产品工作台-画布恢复-${recovery.projectId}-${recovery.exportedAt.slice(0, 10)}.json`,
      serializeBoardRecoveryDocument(recovery),
      "application/json",
    );
    toast.success("本地画布副本已导出");
  }, [workbench.boardController.store]);

  const resolveBoardConflict = useCallback(async (action: Exclude<WorkbenchBoardConflictAction, null>) => {
    setBoardConflictAction(action);
    setBoardConflictError(null);
    try {
      if (action === "discard") {
        await workbench.boardController.discardLocalConflict();
        if (projectSession.isCurrent()) toast.success("已采用服务器画布版本");
      } else {
        await workbench.boardController.replayLocalConflict();
        if (projectSession.isCurrent()) toast.success("本地画布版本已保存");
      }
      if (projectSession.isCurrent()) setBoardConflictOpen(false);
    } catch (error) {
      if (projectSession.isCurrent()) {
        setBoardConflictError(errorMessage(error, "画布冲突仍未解决，请重新确认"));
      }
    } finally {
      setBoardConflictAction(null);
    }
  }, [
    projectSession,
    setBoardConflictAction,
    setBoardConflictError,
    setBoardConflictOpen,
    workbench.boardController.discardLocalConflict,
    workbench.boardController.replayLocalConflict,
  ]);

  useEffect(() => {
    if (!workbench.runController.error || !workbench.currentRun) return;
    const toastId = `workbench-run-stream:${workbench.currentRun.id}`;
    toast.error("运行状态连接已中断，请重新连接", {
      id: toastId,
      action: {
        label: "重新连接",
        onClick: workbench.runController.reconnect,
      },
    });
    return () => {
      toast.dismiss(toastId);
    };
  }, [
    workbench.currentRun,
    workbench.runController.error,
    workbench.runController.reconnect,
  ]);

  useEffect(() => {
    if (!runActions.approvalsError || workbench.currentRun?.status !== "waiting_input") return;
    const toastId = `workbench-run-approvals:${workbench.currentRun.id}`;
    toast.error("确认项加载失败，运行仍在等待您的处理", {
      id: toastId,
      action: {
        label: "重新加载",
        onClick: () => {
          void runActions.retryApprovals().catch(() => undefined);
        },
      },
    });
    return () => {
      toast.dismiss(toastId);
    };
  }, [runActions.approvalsError, runActions.retryApprovals, workbench.currentRun]);

  useEffect(() => {
    if (!runActions.error || runActions.pendingApproval) return;
    toast.error(errorMessage(runActions.error, "运行操作失败，请重试"), {
      id: workbench.currentRun
        ? `workbench-run-action:${workbench.currentRun.id}`
        : "workbench-run-action",
    });
  }, [runActions.error, runActions.pendingApproval, workbench.currentRun]);

  const submitPrompt = useCallback(async (submission: WorkbenchRunSubmission) => {
    const text = submission.prompt.trim();
    if (!text) return null;
    setShareOpen(false);
    setExportOpen(false);
    const runId = await workbench.startProjectRun(submission);
    if (!runId || !projectSession.isCurrent()) return null;
    setPersistedPrompt(text);
    setProjectDraft("");
    return runId;
  }, [
    projectSession,
    setExportOpen,
    setPersistedPrompt,
    setProjectDraft,
    setShareOpen,
    workbench.startProjectRun,
  ]);
  const projectStatus = workbench.bootstrapQuery.isError || workbench.boardController.query.isError
    ? "error"
    : !workbench.bootstrap || !workbench.boardController.store
      ? "loading"
      : "ready";
  const projectError = workbench.bootstrapQuery.error ?? workbench.boardController.query.error;
  const designPresetStatus = workbench.designPresetsQuery.isError
    ? "error"
    : workbench.designPresetsQuery.isPending
      ? "loading"
      : "ready";
  const canvasExportSelection: ExportSelection = canvasSelection.artifact
    ? {
        kind: "artifact",
        artifactId: canvasSelection.artifact.artifactId,
        artifactVersionId: canvasSelection.artifact.artifactVersionId,
        ...(canvasSelection.artifact.screenId
          ? { screenId: canvasSelection.artifact.screenId }
          : {}),
      }
    : canvasSelection.nodeIds.length > 0
      ? { kind: "board_nodes", nodeIds: canvasSelection.nodeIds }
      : { kind: "board" };
  const exportSelection = canvasSelection.hasSelection
    ? canvasExportSelection
    : publication.activeExportSelection ?? canvasExportSelection;
  const exportHasSelection = canvasSelection.hasSelection
    || publication.activeExportSelection !== null;

  return (
    <>
      <ProjectScreen
          principalCacheNamespace={principalCacheNamespace}
          board={{
              activePanel,
              activeTool,
              boardCanRedo: workbench.boardController.state?.canRedo ?? false,
              boardCanUndo: workbench.boardController.state?.canUndo ?? false,
              getCurrentBoardSnapshot: () => {
                const state = workbench.boardController.store?.getState();
                return state ? {
                  boardId: state.boardId,
                  nodes: state.nodes,
                  revision: state.serverRevision,
                  viewport: state.viewport,
                } : null;
              },
              onAddBoardArtifact: (input) => (
                workbench.boardController.store?.getState().addArtifact(input) ?? ""
              ),
              onAddBoardDrawing: (samples, options) => (
                workbench.boardController.store?.getState().addDrawing(samples, options) ?? ""
              ),
              onAddBoardFrame: (bounds) => (
                workbench.boardController.store?.getState().addFrame(bounds) ?? ""
              ),
              onBoardNodesChange: (changes) => {
                workbench.boardController.store?.getState().applyNodeChanges(
                  changes,
                  reduceWorkbenchProjectNodeChanges,
                );
              },
              onBoardViewportChange: (viewport) => {
                workbench.boardController.store?.getState().setViewport(viewport);
              },
              onArrangeBoardNodes: (nodeIds, operation) => (
                workbench.boardController.store?.getState().arrangeNodes(nodeIds, operation) ?? {
                  changed: false,
                  movedNodeIds: [],
                  reason: "insufficient-selection",
                }
              ),
              onDuplicateBoardNodes: (nodeIds) => (
                workbench.boardController.store?.getState().duplicateNodes(nodeIds) ?? []
              ),
              onPinArtifactVersion: (artifactId, pinnedVersionId, targetVersionId) => (
                pinWorkbenchArtifactVersion(
                  workbench.boardController,
                  artifactId,
                  pinnedVersionId,
                  targetVersionId,
                )
              ),
              onRedoBoard: () => workbench.boardController.store?.getState().redo(),
              onReloadBoard: async () => {
                const result = await workbench.boardController.reload();
                return result.data?.value.revision
                  ?? workbench.boardController.store?.getState().serverRevision
                  ?? null;
              },
              onRemoveBoardNodes: (nodeIds) => (
                workbench.boardController.store?.getState().removeNodes(nodeIds) ?? []
              ),
              onNudgeBoardNodes: (nodeIds, delta) => (
                workbench.boardController.store?.getState().nudgeNodes(nodeIds, delta) ?? []
              ),
              onRenameBoardNode: (nodeId, title) => (
                workbench.boardController.store?.getState().renameNode(nodeId, title) ?? false
              ),
              onReplaceArtifactVersionPins: (artifactId, baseVersionId, resultVersionId) => (
                workbench.boardController.store?.getState().replaceArtifactVersionPins(
                  artifactId,
                  baseVersionId,
                  resultVersionId,
                ) ?? []
              ),
              setActivePanel,
              setActiveTool,
              onUndoBoard: () => workbench.boardController.store?.getState().undo(),
              persistedBoardNodes: workbench.boardController.state?.nodes ?? EMPTY_BOARD_NODES,
              persistedBoardViewport: workbench.boardController.state?.viewport ?? null,
              selectAllRequest,
            }}
            catalog={{
              designPresetItems: workbench.designPresetItems,
              designPresetStatus,
              modelCatalog: workbench.runtimeModelCatalog,
              modelChoices: workbench.modelChoices,
              onRetryDesignPresets: () => {
                void workbench.designPresetsQuery.refetch();
              },
              onRetryModels: () => {
                void workbench.runtimeModelsQuery.refetch();
              },
              projectDesignSystemChoices: workbench.projectDesignSystemChoices,
            }}
            key="project"
            project={{
              capabilities: workbench.capabilities,
              loadError: projectError,
              loadStatus: projectStatus,
              onBack: () => {
                void closeProject();
              },
              onRetryProjectLoad: () => {
                void Promise.all([
                  workbench.bootstrapQuery.refetch(),
                  workbench.boardController.reload(),
                ]);
              },
              phase: workbench.phase,
              projectDraft,
              projectId: workbench.selectedProjectId,
              threadId: workbench.bootstrap?.selectedThreadId ?? "",
              projectMode: workbench.projectMode,
              projectOperations: {
                onArchiveProject: workbench.archiveProject,
                onDuplicateProject: async () => {
                  const project = await workbench.duplicateProject();
                  if (!projectSession.isCurrent()) return;
                  await openProject(project.id);
                },
                onRenameProject: workbench.renameProject,
              },
              projectTitle: workbench.activeProject?.title
                ?? (projectStatus === "error" ? "项目无法打开" : "正在加载项目"),
              setProjectDraft,
              workspaceId: workbench.activeProject?.workspaceId ?? "",
            }}
            publication={{
              exportOpen,
              onCreatePreview: publication.createPreview,
              onExport: (selection) => {
                if (!workbench.capabilities.canExport) return;
                setShareOpen(false);
                if (selection) {
                  setCanvasSelection({
                    ...selection,
                    nodeIds: [...new Set(selection.nodeIds)].sort(),
                  });
                  setExportOpen(true);
                  return;
                }
                setExportOpen((isOpen) => {
                  if (!isOpen) {
                    setCanvasSelection({ artifact: null, hasSelection: false, nodeIds: [] });
                  }
                  return !isOpen;
                });
              },
              onSelectionChange: setCanvasSelection,
              onShare: () => {
                if (!workbench.capabilities.canShare) return;
                setExportOpen(false);
                setShareOpen(true);
              },
              shareOpen,
            }}
            run={{
              draftArtifacts: workbench.runDraftArtifacts,
              generationProgress: workbench.generationProgress,
              generationStage: workbench.generationStage,
              onCancelRun: runActions.cancel,
              onRetryRun: runActions.retry,
              onSubmitPrompt: submitPrompt,
              onSubmitRunApproval: runActions.submitApproval,
              prompt: persistedPrompt,
              prototypePatchProjector: workbench.runController.prototypePatchProjector,
              runActionBusy: runActions.busy,
              runActionError: runActions.error,
              runActivities: workbench.runActivities,
              runCanCancel: runActions.canCancel,
              runCanRetry: runActions.canRetry,
              runCancellationReason: workbench.currentRun?.cancellationReason ?? null,
              runFailure: workbench.currentRun?.failure ?? null,
              runMessages: workbench.runMessages,
              runPendingApproval: runActions.pendingApproval,
              runPhaseLabel: workbench.runPhaseLabel,
              runId: workbench.currentRun?.id ?? null,
              runStatus: workbench.runStatus,
              submissionError: workbench.submissionError,
              submitting: workbench.submitting,
              targetSurface: workbench.currentRun?.targetSurface ?? "app",
            }}
      />
      <WorkbenchBoardConflictDialog
        action={boardConflictAction}
        error={boardConflictError}
        onDiscard={() => resolveBoardConflict("discard")}
        onExport={exportLocalBoardRecovery}
        onOpenChange={setBoardConflictOpen}
        onReplay={() => resolveBoardConflict("replay")}
        open={routeView === "project" && boardConflictOpen && boardSaveStatus === "conflict"}
      />
      <WorkbenchShareDialog
        busy={publication.busy}
        error={publication.shareError}
        onEnsureLink={publication.ensureShareLink}
        onOpenChange={setShareOpen}
        onRetryState={() => publication.retryShareState({ throwOnError: true })}
        onToggle={publication.toggleShare}
        open={routeView === "project" && shareOpen && workbench.capabilities.canShare}
        shareEnabled={publication.shareEnabled}
        stateError={publication.shareStateError}
        statePending={publication.shareStatePending}
        shareUrl={publication.shareUrl}
      />
      <ExportDialog
        activeExport={publication.activeExport}
        activeExportSelection={publication.activeExportSelection}
        activeExternalDelivery={publication.activeExternalDelivery}
        busy={publication.busy}
        capabilities={publication.exportCapabilities}
        capabilitiesError={publication.exportCapabilitiesError}
        capabilitiesPending={publication.exportCapabilitiesPending}
        error={publication.exportError}
        hasSelection={exportHasSelection}
        onDownload={publication.downloadExport}
        onCancelExport={publication.cancelExport}
        onCancelExternalDelivery={publication.cancelExternalDelivery}
        onConfirmExternalDelivery={publication.confirmExternalDelivery}
        onCopyCode={publication.copyExportCode}
        open={routeView === "project" && exportOpen && workbench.capabilities.canExport}
        onOpenChange={setExportOpen}
        onPrepareExternalDelivery={publication.prepareExternalDelivery}
        onRetryCapabilities={() => publication.retryExportCapabilities({ throwOnError: true })}
        onRetryExternalDelivery={publication.retryExternalDelivery}
        onSelectAll={() => setSelectAllRequest((request) => request + 1)}
        onStartExport={publication.startExport}
        selection={exportSelection}
      />
    </>
  );
}

type ProjectScreenProps = {
  principalCacheNamespace: string;
  board: {
    activePanel: CanvasPanel;
    activeTool: CanvasInteractionMode;
    boardCanRedo: boolean;
    boardCanUndo: boolean;
    getCurrentBoardSnapshot: () => {
      boardId: string;
      nodes: BoardFlowNode[];
      revision: number;
      viewport: Viewport;
    } | null;
    onAddBoardArtifact: (input: CreateBoardArtifactInput) => string;
    onAddBoardDrawing: (
      samples: readonly BoardDrawingSample[],
      options?: CreateBoardDrawingOptions,
    ) => string;
    onAddBoardFrame: (bounds: BoardRect) => string;
    onBoardNodesChange: (changes: NodeChange<BoardFlowNode>[]) => void;
    onBoardViewportChange: (viewport: Viewport) => void;
    onArrangeBoardNodes: (
      nodeIds: readonly string[],
      operation: BoardNodeArrangeOperation,
    ) => BoardNodeArrangeOutcome;
    onDuplicateBoardNodes: (nodeIds: readonly string[]) => string[];
    onPinArtifactVersion: (
      artifactId: string,
      pinnedArtifactVersionId: string,
      targetArtifactVersionId: string,
    ) => Promise<string[]>;
    onRedoBoard: () => void;
    onReloadBoard: () => Promise<number | null>;
    onRemoveBoardNodes: (nodeIds: readonly string[]) => string[];
    onNudgeBoardNodes: (nodeIds: readonly string[], delta: { x: number; y: number }) => string[];
    onRenameBoardNode: (nodeId: string, title: string) => boolean;
    onReplaceArtifactVersionPins: (
      artifactId: string,
      baseArtifactVersionId: string,
      resultArtifactVersionId: string,
    ) => string[];
    setActivePanel: (panel: CanvasPanel) => void;
    setActiveTool: (tool: CanvasInteractionMode) => void;
    onUndoBoard: () => void;
    persistedBoardNodes: BoardFlowNode[];
    persistedBoardViewport: Viewport | null;
    selectAllRequest: number;
  };
  catalog: {
    designPresetItems: DesignPresetCatalogItem[];
    designPresetStatus: "error" | "loading" | "ready";
    modelCatalog: WorkbenchModelCatalogState;
    modelChoices: WorkbenchModelChoice[];
    onRetryDesignPresets: () => void;
    onRetryModels: () => void;
    projectDesignSystemChoices: WorkbenchProjectDesignSystemChoice[];
  };
  project: {
    capabilities: WorkbenchProjectCapabilities;
    loadError: unknown;
    loadStatus: "error" | "loading" | "ready";
    onBack: () => void;
    onRetryProjectLoad: () => void;
    phase: Phase;
    projectDraft: string;
    projectId: string;
    projectMode: ProjectMode;
    projectOperations: WorkbenchProjectActionOperations;
    projectTitle: string;
    threadId: string;
    setProjectDraft: (prompt: string) => void;
    workspaceId: string;
  };
  publication: {
    exportOpen: boolean;
    onCreatePreview: ReturnType<typeof useWorkbenchPublicationController>["createPreview"];
    onExport: (selection?: WorkbenchCanvasSelection) => void;
    onSelectionChange: (selection: WorkbenchCanvasSelection) => void;
    onShare: () => void;
    shareOpen: boolean;
  };
  run: {
    draftArtifacts: RunArtifactDraftProjection[];
    generationProgress: number;
    generationStage: RunGenerationStage | null;
    onCancelRun: () => Promise<unknown>;
    onRetryRun: () => Promise<unknown>;
    onSubmitPrompt: WorkbenchRunSubmitHandler;
    onSubmitRunApproval: ReturnType<typeof useWorkbenchRunActions>["submitApproval"];
    prompt: string;
    prototypePatchProjector: PrototypePatchProjectorStore;
    runActionBusy: boolean;
    runActionError: unknown;
    runActivities: WorkbenchRunActivityItem[];
    runCanCancel: boolean;
    runCanRetry: boolean;
    runCancellationReason: string | null;
    runFailure: Run["failure"];
    runMessages: WorkbenchRunMessageItem[];
    runPendingApproval: RunApproval | null;
    runPhaseLabel: string | null;
    runId: string | null;
    runStatus: Run["status"] | null;
    submissionError: unknown;
    submitting: boolean;
    targetSurface: RunTargetSurface;
  };
};

function ProjectScreen({
  principalCacheNamespace,
  board: {
    activePanel,
    activeTool,
    boardCanRedo,
    boardCanUndo,
    getCurrentBoardSnapshot,
    onAddBoardArtifact,
    onAddBoardDrawing,
    onAddBoardFrame,
    onBoardNodesChange,
    onBoardViewportChange,
    onArrangeBoardNodes,
    onDuplicateBoardNodes,
    onPinArtifactVersion,
    onRedoBoard,
    onReloadBoard,
    onRemoveBoardNodes,
    onNudgeBoardNodes,
    onRenameBoardNode,
    onReplaceArtifactVersionPins,
    setActivePanel,
    setActiveTool,
    onUndoBoard,
    persistedBoardNodes,
    persistedBoardViewport,
    selectAllRequest,
  },
  catalog: {
    designPresetItems,
    designPresetStatus,
    modelCatalog,
    modelChoices,
    onRetryDesignPresets,
    onRetryModels,
    projectDesignSystemChoices,
  },
  project: {
    capabilities,
    loadError,
    loadStatus,
    onBack,
    onRetryProjectLoad,
    phase,
    projectDraft,
    projectId,
    projectMode,
    projectOperations,
    projectTitle,
    threadId,
    setProjectDraft,
    workspaceId,
  },
  publication: {
    exportOpen,
    onCreatePreview,
    onExport,
    onSelectionChange,
    onShare,
    shareOpen,
  },
  run: {
    draftArtifacts,
    generationProgress,
    generationStage,
    onCancelRun,
    onRetryRun,
    onSubmitPrompt,
    onSubmitRunApproval,
    prompt,
    prototypePatchProjector,
    runActionBusy,
    runActionError,
    runActivities,
    runCanCancel,
    runCanRetry,
    runCancellationReason,
    runFailure,
    runMessages,
    runPendingApproval,
    runPhaseLabel,
    runId,
    runStatus,
    submissionError,
    submitting,
    targetSurface,
  },
}: ProjectScreenProps) {
  const projectSession = useWorkbenchProjectSession(projectId);
  const { baseUrl } = useWorkbenchTransport();
  const canvasAgentTransport = useMemo(
    () => createWorkbenchCanvasAgentCommandApi({ baseUrl }),
    [baseUrl],
  );
  const projectActions = useWorkbenchProjectActionsController({
    ...projectOperations,
    canArchive: capabilities.canArchive,
    canDuplicate: capabilities.canDuplicate,
    canRename: capabilities.canEdit,
    onArchived: onBack,
    projectId,
  });
  const stageRef = useRef<HTMLElement | null>(null);
  const [nodes, setNodes] = useWorkbenchProjectState<WorkbenchNode[]>(projectSession, () => []);
  const onNodesChange = useCallback((changes: NodeChange<WorkbenchNode>[]) => {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  }, [setNodes]);
  const [projectMenuOpen, setProjectMenuOpen] = useWorkbenchProjectState(
    projectSession,
    () => false,
  );
  const [projectMembersOpen, setProjectMembersOpen] = useWorkbenchProjectState(
    projectSession,
    () => false,
  );
  const [zoomMenuOpen, setZoomMenuOpen] = useWorkbenchProjectState(
    projectSession,
    () => false,
  );
  const [selectedActionOpen, setSelectedActionOpen] = useWorkbenchProjectState(
    projectSession,
    () => false,
  );
  const [zoomKeyActive, setZoomKeyActive] = useWorkbenchProjectState(
    projectSession,
    () => false,
  );
  const [zoomLabel, setZoomLabel] = useWorkbenchProjectState(projectSession, () => "63%");
  const {
    closeDeleteIntent,
    closeRenameIntent,
    openDeleteIntent,
    openRenameIntent,
    pendingDeleteNodeIds,
    renameTargetNodeId,
  } = useProjectScreenBoardIntentController({ projectId });
  const [selectedAgentTask, setSelectedAgentTask] = useWorkbenchProjectState<string | null>(
    projectSession,
    () => null,
  );
  const [boardViewport, setBoardViewport] = useWorkbenchProjectState<Viewport>(
    projectSession,
    () => getBoardViewport(),
  );
  const nodesRef = useWorkbenchProjectRef<WorkbenchNode[]>(projectSession, () => []);
  const pendingNodeSelectionRef = useWorkbenchProjectRef<string[]>(projectSession, () => []);
  const lastProjectModeRef = useWorkbenchProjectRef<ProjectMode>(
    projectSession,
    () => projectMode,
  );
  const manualZoomRef = useWorkbenchProjectRef(projectSession, () => false);
  const lastSelectAllRequestRef = useWorkbenchProjectRef(
    projectSession,
    () => selectAllRequest,
  );
  const viewportInitializedRef = useWorkbenchProjectRef(projectSession, () => false);
  const viewportTransitionKeyRef = useWorkbenchProjectRef(projectSession, () => "");
  const {
    getNodesBounds,
    getViewport,
    screenToFlowPosition,
    setViewport,
    zoomIn,
    zoomOut,
  } = useReactFlow();
  const activeRun = workbenchRunIsActive(runStatus);
  const activeRunRef = useWorkbenchProjectRef(projectSession, () => activeRun);
  useEffect(() => {
    activeRunRef.current = activeRun;
  }, [activeRun, activeRunRef]);
  const canvasPermissions = workbenchCanvasPermissions(capabilities.canEdit, activeRun);
  const persistedBoardNodeIds = useMemo(
    () => new Set(persistedBoardNodes.map((node) => node.id)),
    [persistedBoardNodes],
  );
  const selectedNodeIds = useMemo(
    () => nodes
      .filter((node) => node.selected && persistedBoardNodeIds.has(node.id))
      .map((node) => node.id),
    [nodes, persistedBoardNodeIds],
  );
  const selectedNodeId = selectedNodeIds[0] ?? "";
  const canvasClientSessionIdRef = useWorkbenchProjectRef(
    projectSession,
    () => `canvas-client-${newClientSessionId()}`,
  );
  const canvasStateTrackerRef = useWorkbenchProjectRef(
    projectSession,
    () => ({ revision: 0, signature: "", visibleScreenSignature: "[]" }),
  );
  const canvasAgentPollerRef = useWorkbenchProjectRef<CanvasAgentCommandPoller | null>(
    projectSession,
    () => null,
  );
  const currentBoardSnapshotRef = useWorkbenchProjectRef(
    projectSession,
    () => getCurrentBoardSnapshot,
  );
  const reloadBoardRef = useWorkbenchProjectRef(projectSession, () => onReloadBoard);
  useEffect(() => {
    currentBoardSnapshotRef.current = getCurrentBoardSnapshot;
    reloadBoardRef.current = onReloadBoard;
  }, [currentBoardSnapshotRef, getCurrentBoardSnapshot, onReloadBoard, reloadBoardRef]);
  const recordCanvasState = useCallback((
    selection: readonly string[],
    viewport: Viewport,
    visibleScreens?: readonly CanvasScreenReference[],
  ) => {
    const visibleScreenSignature = visibleScreens
      ? JSON.stringify(visibleScreens.map((reference) => [
          reference.boardNodeId,
          reference.artifactId,
          reference.artifactVersionId,
          reference.screenId,
        ]))
      : canvasStateTrackerRef.current.visibleScreenSignature;
    const signature = JSON.stringify({
      selected: [...selection].sort(),
      viewport: [viewport.x, viewport.y, viewport.zoom],
      visibleScreens: visibleScreenSignature,
    });
    if (canvasStateTrackerRef.current.signature !== signature) {
      canvasStateTrackerRef.current = {
        revision: canvasStateTrackerRef.current.revision + 1,
        signature,
        visibleScreenSignature,
      };
    }
    return canvasStateTrackerRef.current.revision;
  }, [canvasStateTrackerRef]);
  useEffect(() => {
    recordCanvasState(selectedNodeIds, getViewport());
  }, [getViewport, recordCanvasState, selectedNodeIds]);
  const captureCanvasSnapshot = useCallback(() => {
    const currentBoard = currentBoardSnapshotRef.current();
    const stage = stageRef.current?.getBoundingClientRect();
    if (!currentBoard || !threadId || !stage || stage.width <= 0 || stage.height <= 0) return null;
    const currentSelectedNodeIds = nodesRef.current
      .filter((node) => node.selected)
      .map((node) => node.id);
    const selected = new Set(currentSelectedNodeIds);
    const viewport = getViewport();
    recordCanvasState(currentSelectedNodeIds, viewport);
    const screens = currentBoard.nodes.flatMap<CanvasScreenSummary>((node) => {
      const summary = canvasScreenSummaryFromBoardNode(node);
      return summary ? [summary] : [];
    });
    const capturedAt = new Date();
    const snapshot = createCanvasAgentSnapshot({
      projectId,
      threadId,
      runId: null,
      boardId: currentBoard.boardId,
      clientSessionId: canvasClientSessionIdRef.current,
      projectSessionGeneration: projectSession.generation,
      boardRevision: currentBoard.revision,
      canvasStateRevision: canvasStateTrackerRef.current.revision,
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + 60_000).toISOString(),
      nodes: currentBoard.nodes.map((node) => ({ ...node, selected: selected.has(node.id) })),
      screens,
      stage: { width: stage.width, height: stage.height },
      viewport,
    });
    const canvasStateRevision = recordCanvasState(
      currentSelectedNodeIds,
      viewport,
      snapshot.visibleScreens,
    );
    return canvasStateRevision === snapshot.canvasStateRevision
      ? snapshot
      : { ...snapshot, canvasStateRevision };
  }, [
    canvasClientSessionIdRef,
    canvasStateTrackerRef,
    currentBoardSnapshotRef,
    getViewport,
    nodesRef,
    projectId,
    projectSession.generation,
    recordCanvasState,
    stageRef,
    threadId,
  ]);
  const captureCanvasClientState = useCallback(() => {
    const snapshot = captureCanvasSnapshot();
    return snapshot ? createCanvasAgentClientStateSyncRequest(snapshot) : null;
  }, [captureCanvasSnapshot]);
  const submitPromptWithCanvasSnapshot = useCallback<WorkbenchRunSubmitHandler>(
    (submission) => onSubmitPrompt({ ...submission, captureCanvasSnapshot }),
    [captureCanvasSnapshot, onSubmitPrompt],
  );
  const setNodeSelection = useCallback((nodeId: string) => {
    setNodes((currentNodes) => currentNodes.map((node) => ({
      ...node,
      selected: Boolean(nodeId) && node.id === nodeId,
    })));
  }, [setNodes]);
  const artifactSelection = useMemo(() => projectScreenArtifactSelection({
    nodes,
    persistedBoardNodeIds,
  }), [nodes, persistedBoardNodeIds]);
  const editArtifactTargetsValid = isValidEditArtifactTargets(artifactSelection.editArtifactTargets);
  const generatePrototypeTargetsValid = isValidEditArtifactTargets(
    artifactSelection.selectedPrototypeRunTargets,
  ) && artifactSelection.selectedPrototypeRunTargets.every((target) => target.screenIds.length > 0);
  const editWorkflowAvailable = capabilities.canEdit
    && capabilities.canRun
    && editArtifactTargetsValid;
  const {
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
  } = useProjectScreenComposerController({
    allowEdit: editWorkflowAvailable,
    modelCatalogStatus: modelCatalog.status,
    modelChoices,
    projectId,
    targetSurface,
  });
  const selectedArtifactQuery = useWorkbenchArtifact(projectId, artifactSelection.styleTargetArtifactId);
  const styleVersionQuery = useWorkbenchArtifactVersion(
    projectId,
    artifactSelection.styleTargetArtifactId,
    artifactSelection.styleTargetVersionId,
    Boolean(artifactSelection.styleTargetReference),
  );
  const selectedPrototypeVersionReferences = useMemo(() => {
    if (
      artifactSelection.selectedPrototypeTargets.length !== 1
      && !generatePrototypeTargetsValid
    ) {
      return [];
    }
    const seen = new Set<string>();
    return artifactSelection.selectedPrototypeTargets.flatMap(({ reference }) => {
      const key = artifactVersionLookupKey(reference.artifactId, reference.artifactVersionId);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        artifactId: reference.artifactId,
        artifactVersionId: reference.artifactVersionId,
      }];
    });
  }, [artifactSelection.selectedPrototypeTargets, generatePrototypeTargetsValid]);
  const selectedPrototypeVersionQueries = useWorkbenchArtifactVersionBatch(
    projectId,
    selectedPrototypeVersionReferences,
    selectedPrototypeVersionReferences.length > 0,
  );
  const previewPrototypeTargets = useMemo(() => nodes.flatMap((node) => {
    if (
      node.type !== "generatedScreen"
      || node.data.phase !== "complete"
      || !persistedBoardNodeIds.has(node.id)
    ) return [];
    const reference = projectScreenArtifactReferenceFromNode(node);
    return reference?.screenId
      ? [{ nodeId: node.id, reference, title: node.data.title }]
      : [];
  }), [nodes, persistedBoardNodeIds]);
  const previewPrototypeVersionReferences = useMemo(() => {
    const seen = new Set<string>();
    return previewPrototypeTargets.flatMap(({ reference }) => {
      const key = artifactVersionLookupKey(reference.artifactId, reference.artifactVersionId);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        artifactId: reference.artifactId,
        artifactVersionId: reference.artifactVersionId,
      }];
    });
  }, [previewPrototypeTargets]);
  const previewPrototypeVersionQueries = useWorkbenchArtifactVersionBatch(
    projectId,
    previewPrototypeVersionReferences,
    capabilities.canPreview && previewPrototypeVersionReferences.length > 0,
  );
  const createPrototypeVersion = useCreateWorkbenchArtifactVersion(
    projectId,
    artifactSelection.styleTargetArtifactId,
  );
  const prdArtifactQuery = useWorkbenchArtifact(
    projectId,
    artifactSelection.prdTargetReference?.artifactId ?? "",
  );
  const createPrdVersion = useCreateWorkbenchArtifactVersion(
    projectId,
    artifactSelection.prdTargetReference?.artifactId ?? "",
  );
  const artifactPreferenceQuery = useWorkbenchArtifactVersionPreference(
    principalCacheNamespace,
    projectId,
    artifactSelection.preferenceTargetReference?.artifactId ?? "",
    artifactSelection.preferenceTargetReference?.artifactVersionId ?? "",
    artifactSelection.preferenceTargetScreenId,
    Boolean(artifactSelection.preferenceTargetReference),
  );
  const updateArtifactPreference = useUpdateWorkbenchArtifactVersionPreference(
    principalCacheNamespace,
    projectId,
    artifactSelection.preferenceTargetReference?.artifactId ?? "",
    artifactSelection.preferenceTargetReference?.artifactVersionId ?? "",
    artifactSelection.preferenceTargetScreenId,
  );
  const preferenceToggleCoordinatorRef = useRef(new ArtifactPreferenceToggleCoordinator());
  const preferenceTargetKey = artifactSelection.preferenceTargetReference
    ? artifactPreferenceTargetKey(
        principalCacheNamespace,
        artifactSelection.preferenceTargetReference,
        artifactSelection.preferenceTargetScreenId,
      )
    : null;
  useEffect(() => {
    const preference = artifactPreferenceQuery.data?.value;
    if (!preferenceTargetKey || !preference) return;
    preferenceToggleCoordinatorRef.current.hydrate(preferenceTargetKey, preference);
  }, [artifactPreferenceQuery.data?.value, preferenceTargetKey]);
  const styleVersion = styleVersionQuery.data?.value;
  const selectedScreenContextTargets = artifactSelection.selectedPrototypeTargets.flatMap<ScreenContextTarget>((target) => {
    const node = nodes.find((candidate) => candidate.id === target.nodeId);
    if (!node || node.type !== "generatedScreen" || !target.reference.screenId) return [];
    const versionIndex = selectedPrototypeVersionReferences.findIndex((reference) => (
      reference.artifactId === target.reference.artifactId
      && reference.artifactVersionId === target.reference.artifactVersionId
    ));
    const loadedVersion = selectedPrototypeVersionQueries[versionIndex]?.data?.value ?? null;
    const version = loadedVersion
      && loadedVersion.artifactId === target.reference.artifactId
      && loadedVersion.artifactVersionId === target.reference.artifactVersionId
      ? loadedVersion
      : null;
    const screen = version?.kind === "prototype" && version.contentMode === "inline"
      ? version.content.screens.find((candidate) => candidate.id === target.reference.screenId)
      : undefined;
    return [{
      id: node.id,
      persisted: persistedBoardNodeIds.has(node.id),
      phase: node.data.phase,
      reference: {
        artifactId: target.reference.artifactId,
        artifactVersionId: target.reference.artifactVersionId,
        projectId: target.reference.projectId,
        screenId: target.reference.screenId,
      },
      size: screen ? { ...screen.viewport } : workbenchNodeCanvasSize(node),
      title: node.data.title,
      version,
    }];
  });
  const canvasEnvironment = useMemo<CanvasToolEnvironment>(() => ({
    activeRun: workbenchRunIsActive(runStatus),
    canEdit: capabilities.canEdit,
    projectId,
    selection: nodes
      .filter((node) => node.selected)
      .map<CanvasSelectionTarget>((node) => {
        const reference = projectScreenArtifactReferenceFromNode(node);
        const isSelectedVersion = Boolean(
          reference
          && styleVersion
          && reference.artifactId === styleVersion.artifactId
          && reference.artifactVersionId === styleVersion.artifactVersionId,
        );
        return {
          nodeId: node.id,
          persisted: persistedBoardNodeIds.has(node.id),
          phase: (("phase" in node.data ? node.data.phase : undefined) ?? "idle") as CanvasSelectionTarget["phase"],
          screenId: reference?.screenId ?? null,
          artifactId: reference?.artifactId ?? null,
          artifactVersionId: reference?.artifactVersionId ?? null,
          artifactVersion: isSelectedVersion ? styleVersion ?? null : null,
        };
      }),
  }), [
    capabilities.canEdit,
    nodes,
    persistedBoardNodeIds,
    projectId,
    runStatus,
    styleVersion,
  ]);
  const directEditAvailability = canvasDirectEditAvailability(canvasEnvironment);
  const editModelChoice = projectModelChoices.find((choice) => choice.workflow === "edit");
  const generateModelChoice = projectModelChoices.find((choice) => choice.workflow === "generate");
  const runtimeModelsReady = modelCatalog.status === "ready" && !submitting;
  const screenContextState = deriveScreenContextState(selectedScreenContextTargets, {
    activeRun,
    capabilities: {
      canEdit: capabilities.canEdit,
      canExport: capabilities.canExport,
      canPreview: capabilities.canPreview,
      canRun: capabilities.canRun,
    },
    directEditAvailable: directEditAvailability.enabled,
    editArtifactTargetsValid,
    editModelAvailable: Boolean(editModelChoice) && runtimeModelsReady,
    generatePrototypeTargetsValid,
  });
  const designSystemPanelReadOnly = canvasPanelAccess(
    "design-system",
    canvasEnvironment,
  ).mode !== "interactive";
  const normalizedCanvasState = normalizeCanvasToolsState({
    interactionMode: activeTool,
    panel: activePanel,
    projectId,
  }, canvasEnvironment);
  const prototypeEditMode = normalizedCanvasState.interactionMode === "direct-edit"
    && directEditAvailability.enabled;
  useEffect(() => {
    if (activeTool !== normalizedCanvasState.interactionMode) {
      setActiveTool(normalizedCanvasState.interactionMode);
    }
    if (activePanel !== normalizedCanvasState.panel) {
      setActivePanel(normalizedCanvasState.panel);
    }
  }, [
    activePanel,
    activeTool,
    normalizedCanvasState.interactionMode,
    normalizedCanvasState.panel,
    setActivePanel,
    setActiveTool,
  ]);
  const editablePrototypeDocument = styleVersion?.kind === "prototype" && styleVersion.contentMode === "inline"
    ? styleVersion.content
    : null;
  const boardNodeBeingRenamed = renameTargetNodeId
    ? nodes.find((node) => node.id === renameTargetNodeId)
    : undefined;
  const selectedActionAvailability = boardNodeActionAvailability(
    capabilities.canEdit && !activeRun,
    artifactSelection.selectedBoardNodeIds.length,
  );
  const isGeneratedOverview = projectMode === "generated" && zoomLabel === "10%";
  const projectStageClass = cn(
    "absolute inset-0 bg-[var(--workbench-bg)] text-[#e5e2e3]",
    projectMode === "generated" && "workbench-project--generated",
    projectMode === "generated" && phase === "generating" && "workbench-project--generating",
    projectMode === "generated" && phase === "refining" && "workbench-project--refining",
    projectMode === "generated" && phase === "complete" && "workbench-project--complete",
    isGeneratedOverview && "workbench-project--overview",
  );
  const toggleArtifactPreference = useCallback((action: WorkbenchArtifactPreferenceAction) => {
    if (!capabilities.canEdit || workbenchRunIsActive(runStatus)) return;
    const target = artifactSelection.preferenceTargetReference;
    if (!target || !preferenceTargetKey) return;
    const capturedPreference = artifactPreferenceQuery.data?.value ?? null;
    const task = preferenceToggleCoordinatorRef.current.enqueue(
      preferenceTargetKey,
      action,
      capturedPreference,
      async (request) => {
        const result = await updateArtifactPreference.mutateAsync({
          request,
        });
        return result.value;
      },
      async () => {
        const result = await artifactPreferenceQuery.refetch({ throwOnError: true });
        return result.data?.value ?? null;
      },
    );
    void task.catch(() => {
      if (projectSession.isCurrent()) toast.error("界面偏好保存失败，请重试");
    });
  }, [
    artifactPreferenceQuery.data?.value,
    artifactPreferenceQuery.refetch,
    artifactSelection.preferenceTargetReference,
    capabilities.canEdit,
    preferenceTargetKey,
    projectSession,
    runStatus,
    updateArtifactPreference,
  ]);
  const artifactPreferenceController = artifactSelection.preferenceTargetReference
    && artifactSelection.preferenceTargetScreenId
    ? {
        artifactVersionId: artifactSelection.preferenceTargetReference.artifactVersionId,
        screenId: artifactSelection.preferenceTargetScreenId,
        busy: artifactPreferenceQuery.isPending
          || artifactPreferenceQuery.isFetching
          || updateArtifactPreference.isPending,
        preference: artifactPreferenceQuery.data?.value ?? null,
        onToggle: toggleArtifactPreference,
      }
    : null;

  useEffect(() => {
    if (!activeRun) return;
    closeDeleteIntent();
    closeRenameIntent();
    setSelectedActionOpen(false);
  }, [
    activeRun,
    closeDeleteIntent,
    closeRenameIntent,
    setSelectedActionOpen,
  ]);
  const selectedContextRootNodes = selectedRootNodes(nodes, artifactSelection.selectedBoardNodeIds);
  const selectedRootsHaveSize = selectedContextRootNodes.every((node) => {
    const size = workbenchNodeCanvasSize(node);
    return size.width > 0 && size.height > 0;
  });
  let screenContextToolbarModel: WorkbenchScreenContextToolbarModel | null = null;
  if (
    !activeRun
    && artifactSelection.selectedBoardNodeIds.length === 1
    && screenContextState.kind === "single"
    && screenContextState.target.id === artifactSelection.selectedBoardNodeIds[0]
  ) {
    const previewNeedsGeneration = screenContextState.previewDisposition.kind === "generate-required";
    screenContextToolbarModel = {
      kind: "single",
      availability: {
        canAlign: false,
        canCopyLink: selectedActionAvailability.canCopyLink,
        canDelete: screenContextState.availability.delete.enabled,
        canDistribute: false,
        canDuplicate: screenContextState.availability.duplicate.enabled,
        canExport: screenContextState.availability.export.enabled,
        canGenerate: screenContextState.availability.generate.enabled
          && Boolean(generateModelChoice)
          && runtimeModelsReady,
        canGenerateVariants: false,
        canModify: screenContextState.availability.modify.enabled,
        canOpenVersions: screenContextState.availability.versionHistory.enabled,
        canPreview: screenContextState.availability.preview.enabled
          && (!previewNeedsGeneration || (Boolean(generateModelChoice) && runtimeModelsReady)),
        canRename: screenContextState.availability.rename.enabled,
        canToggleFavourite: screenContextState.availability.favourite.enabled
          && Boolean(artifactPreferenceController?.preference),
        canToggleReaction: screenContextState.availability.favourite.enabled
          && Boolean(artifactPreferenceController?.preference),
      },
      favourite: artifactPreferenceController?.preference?.favorite ?? false,
      favouriteBusy: artifactPreferenceController?.busy ?? false,
      height: screenContextState.target.size.height,
      nodeIds: [screenContextState.target.id],
      previewAction: previewNeedsGeneration ? "generate" : "preview",
      reaction: artifactPreferenceController?.preference?.reaction ?? null,
      title: screenContextState.target.title,
      width: screenContextState.target.size.width,
    };
  } else if (!activeRun && artifactSelection.selectedBoardNodeIds.length > 1) {
    const everySelectionIsScreen = selectedScreenContextTargets.length
      === artifactSelection.selectedBoardNodeIds.length;
    const screenAvailability = everySelectionIsScreen && screenContextState.kind === "multiple"
      ? screenContextState.availability
      : null;
    const previewDisposition = everySelectionIsScreen && screenContextState.kind === "multiple"
      ? screenContextState.previewDisposition
      : null;
    const previewNeedsGeneration = previewDisposition?.kind === "generate-required";
    const canWriteSelection = capabilities.canEdit && selectedContextRootNodes.length >= 1;
    screenContextToolbarModel = {
      kind: "multiple",
      availability: {
        canAlign: canWriteSelection && selectedContextRootNodes.length >= 2 && selectedRootsHaveSize,
        canCopyLink: false,
        canDelete: screenAvailability?.delete.enabled ?? canWriteSelection,
        canDistribute: canWriteSelection && selectedContextRootNodes.length >= 3 && selectedRootsHaveSize,
        canDuplicate: screenAvailability?.duplicate.enabled ?? canWriteSelection,
        canExport: screenAvailability?.export.enabled ?? capabilities.canExport,
        canGenerate: false,
        canGenerateVariants: Boolean(
          screenAvailability?.generateVariants.enabled && editModelChoice && runtimeModelsReady,
        ),
        canModify: false,
        canOpenVersions: false,
        canPreview: Boolean(
          screenAvailability?.preview.enabled
          && (!previewNeedsGeneration || (generateModelChoice && runtimeModelsReady)),
        ),
        canRename: false,
        canToggleFavourite: false,
        canToggleReaction: false,
      },
      count: artifactSelection.selectedBoardNodeIds.length,
      nodeIds: [...artifactSelection.selectedBoardNodeIds],
      previewAction: previewNeedsGeneration ? "generate" : "preview",
    };
  }

  useWorkbenchPointerVars(stageRef);

  const artifactIntent = useProjectScreenArtifactIntentController({
    editableStyleDocument: editablePrototypeDocument,
    projectId,
    selection: artifactSelection,
  });

  useEffect(() => {
    if (
      !composerIntent
      || (capabilities.canEdit && capabilities.canRun && !activeRun)
    ) {
      return;
    }
    clearComposerIntent();
  }, [
    activeRun,
    capabilities.canEdit,
    capabilities.canRun,
    clearComposerIntent,
    composerIntent,
  ]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes, nodesRef]);

  useEffect(() => {
    setSelectedAgentTask(null);
  }, [projectMode, prompt, setSelectedAgentTask]);

  const writeSelectedNodeUrl = useCallback((nodeIds: readonly string[]) => {
    writeWorkbenchBoardNodeUrl(projectId, nodeIds.length === 1 ? nodeIds[0]! : "");
  }, [projectId]);

  const handleFlowSelectionChange = useCallback<OnSelectionChangeFunc<WorkbenchNode>>(({ nodes: selectedNodes }) => {
    if (activeTool === "pan") return;
    const selectedIds = selectedNodes
      .filter((node) => persistedBoardNodeIds.has(node.id))
      .map((node) => node.id);
    setSelectedActionOpen(false);
    // React Flow emits an empty selection while remounting; pane/delete handlers own durable deselection.
    if (selectedIds.length > 0) writeSelectedNodeUrl(selectedIds);
    if (exportOpen) {
      onSelectionChange(workbenchCanvasSelection(
        selectedNodes.filter((node) => persistedBoardNodeIds.has(node.id)),
      ));
    }
  }, [
    activeTool,
    exportOpen,
    onSelectionChange,
    persistedBoardNodeIds,
    setSelectedActionOpen,
    setNodeSelection,
    writeSelectedNodeUrl,
  ]);

  const canvasMedia = useWorkbenchCanvasMediaController({
    canEdit: capabilities.canEdit,
    exportOpen,
    projectId,
    port: {
      addBoardArtifact: onAddBoardArtifact,
      getStageRect: () => {
        const stage = stageRef.current?.getBoundingClientRect();
        return stage
          ? { x: stage.left, y: stage.top, width: stage.width, height: stage.height }
          : null;
      },
      screenToFlowPosition,
      selectNode: setNodeSelection,
      selectTool: (tool) => {
        setActiveTool(tool);
        setActivePanel(null);
      },
      updateExportSelection: (selection) => onSelectionChange(selection),
      writeSelectedNodeUrl,
    },
  });

  const selectNode = useCallback((nodeId: string) => {
    if (activeTool === "pan") return;
    setNodeSelection(nodeId);
    setSelectedActionOpen(false);
    setNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: node.id === nodeId })));
    writeSelectedNodeUrl(
      persistedBoardNodes.some((node) => node.id === nodeId) ? [nodeId] : [],
    );
    if (exportOpen) {
      onSelectionChange(workbenchCanvasSelection(
        nodesRef.current.filter((node) => (
          node.id === nodeId && persistedBoardNodes.some((persisted) => persisted.id === node.id)
        )),
      ));
    }
  }, [
    activeTool,
    exportOpen,
    nodesRef,
    onSelectionChange,
    persistedBoardNodes,
    setNodes,
    setSelectedActionOpen,
    setNodeSelection,
    writeSelectedNodeUrl,
  ]);

  const closeTransientPanels = useCallback(() => {
    setProjectMenuOpen(false);
    closeModelMenu();
    setZoomMenuOpen(false);
    setSelectedActionOpen(false);
  }, [closeModelMenu, setProjectMenuOpen, setSelectedActionOpen, setZoomMenuOpen]);
  const {
    closePreview,
    hideReadyToast,
    openPreview,
    previewOpen,
    previewReferences,
    readyToastOpen,
    scheduleReadyToast,
  } = useProjectScreenPreviewController({
    canPreview: capabilities.canPreview,
    onBeforeOpen: closeTransientPanels,
    projectId,
  });

  const previewArtifacts = capabilities.canPreview
    ? projectReadyPrototypePreviewArtifacts(
        previewPrototypeTargets,
        previewPrototypeVersionQueries.flatMap((query) => query.data?.value ? [query.data.value] : []),
      )
    : [];

  useEffect(() => {
    artifactIntent.closeVersionHistory();
    setProjectMembersOpen(false);
  }, [artifactIntent.closeVersionHistory, projectId, setProjectMembersOpen]);

  useEffect(() => {
    const didProjectModeChange = lastProjectModeRef.current !== projectMode;
    if (didProjectModeChange) manualZoomRef.current = false;
    lastProjectModeRef.current = projectMode;

    const nextNodes = projectRunBoardNodes({
      drafts: draftArtifacts,
      persistedBoardNodes,
      projectId,
      runStatus,
    });
    const matchesCurrentProject = readWorkbenchProjectId() === projectId;
    const requestedNodeId = matchesCurrentProject ? readWorkbenchBoardNodeId() : "";
    const requestedNodeExists = requestedNodeId
      ? nextNodes.some((node) => (
          node.id === requestedNodeId
          && node.selectable !== false
          && persistedBoardNodes.some((persisted) => persisted.id === node.id)
        ))
      : false;
    const pendingNodeIds = pendingNodeSelectionRef.current.filter((nodeId) => (
      nextNodes.some((node) => node.id === nodeId)
    ));
    const normalizedNodes = pendingNodeIds.length > 0
      ? nextNodes.map((node) => ({ ...node, selected: pendingNodeIds.includes(node.id) }))
      : mergeCanvasNodeSelection(
          nextNodes,
          matchesCurrentProject ? nodesRef.current : [],
          requestedNodeExists ? requestedNodeId : "",
        );
    if (
      pendingNodeSelectionRef.current.length > 0
      && pendingNodeIds.length === pendingNodeSelectionRef.current.length
    ) {
      pendingNodeSelectionRef.current = [];
    }
    const selectedIds = normalizedNodes
      .filter((node) => node.selected && persistedBoardNodes.some((persisted) => persisted.id === node.id))
      .map((node) => node.id);
    setNodes(normalizedNodes);
    if (matchesCurrentProject) {
      const selectedUrlNodeId = selectedIds.length === 1 ? selectedIds[0]! : "";
      const waitForRequestedNode = requestedNodeId
        && !requestedNodeExists
        && loadStatus !== "ready";
      if (!waitForRequestedNode && selectedUrlNodeId !== requestedNodeId) {
        writeSelectedNodeUrl(selectedIds);
      }
    }
    setProjectMenuOpen(false);
    closeModelMenu();
    setZoomMenuOpen(false);
    setSelectedActionOpen(false);
    if (!manualZoomRef.current) {
      setZoomLabel(projectMode === "board" || (projectMode === "generated" && phase === "complete") ? "63%" : "93%");
    }
    scheduleReadyToast(projectMode === "generated" && phase === "complete");
  }, [
    closeModelMenu,
    draftArtifacts,
    loadStatus,
    persistedBoardNodes,
    phase,
    projectId,
    projectMode,
    runStatus,
    scheduleReadyToast,
    lastProjectModeRef,
    manualZoomRef,
    pendingNodeSelectionRef,
    setNodes,
    setProjectMenuOpen,
    setSelectedActionOpen,
    setNodeSelection,
    setZoomLabel,
    setZoomMenuOpen,
    writeSelectedNodeUrl,
  ]);

  useEffect(() => {
    const restoreBoardNodeSelection = () => {
      if (readWorkbenchProjectId() !== projectId) return;
      const requestedNodeId = readWorkbenchBoardNodeId();
      const persistedIds = new Set(persistedBoardNodes.map((node) => node.id));
      const requestedNodeExists = requestedNodeId
        ? nodesRef.current.some((node) => node.id === requestedNodeId && persistedIds.has(node.id))
        : false;
      if (requestedNodeId && !requestedNodeExists && loadStatus !== "ready") return;
      const nextSelectedId = requestedNodeExists ? requestedNodeId : "";
      setNodeSelection(nextSelectedId);
      setSelectedActionOpen(false);
      setNodes((currentNodes) => currentNodes.map((node) => ({
        ...node,
        selected: Boolean(nextSelectedId) && node.id === nextSelectedId,
      })));
      if (requestedNodeId && !requestedNodeExists) writeSelectedNodeUrl([]);
    };

    window.addEventListener("popstate", restoreBoardNodeSelection);
    return () => window.removeEventListener("popstate", restoreBoardNodeSelection);
  }, [
    loadStatus,
    nodesRef,
    persistedBoardNodes,
    projectId,
    setNodes,
    setSelectedActionOpen,
    setNodeSelection,
    writeSelectedNodeUrl,
  ]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let frame = 0;
    const viewportTransitionKey = `${projectMode}:${phase}`;
    const syncViewport = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = stage.getBoundingClientRect();
        const nextViewport = persistedBoardNodes.length > 0 && persistedBoardViewport
          ? persistedBoardViewport
          : projectMode === "document"
          ? getDocumentViewport(rect.width, rect.height)
          : projectMode === "generated"
            ? getGeneratedViewport(rect.width, rect.height, phase)
            : getBoardViewport(rect.width, rect.height);
        setBoardViewport(nextViewport);
        const isFirstViewport = !viewportInitializedRef.current;
        const previousMode = viewportTransitionKeyRef.current.split(":")[0] as ProjectMode | "";
        const didStageChange = viewportTransitionKeyRef.current !== viewportTransitionKey;
        const didProjectModeChange = previousMode !== projectMode;
        viewportInitializedRef.current = true;
        viewportTransitionKeyRef.current = viewportTransitionKey;
        if (!manualZoomRef.current) {
          setZoomLabel(projectMode === "board" || (projectMode === "generated" && phase === "complete") ? "63%" : "93%");
        }
        if (manualZoomRef.current && !didProjectModeChange && !isFirstViewport) {
          return;
        }
        void setViewport(nextViewport, {
          duration: isFirstViewport ? 0 : didStageChange ? 680 : 0,
        });
      });
    };

    syncViewport();
    const resizeObserver = new ResizeObserver(syncViewport);
    resizeObserver.observe(stage);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [
    manualZoomRef,
    persistedBoardNodes.length,
    persistedBoardViewport,
    phase,
    projectId,
    projectMode,
    setBoardViewport,
    setViewport,
    setZoomLabel,
    viewportInitializedRef,
    viewportTransitionKeyRef,
  ]);

  const updateZoomLabel = useCallback(() => {
    const current = getViewport();

    if (
      (projectMode === "document" || projectMode === "generated")
      && Math.abs(current.zoom - boardViewport.zoom) < 0.001
    ) {
      setZoomLabel(projectMode === "generated" && phase === "complete" ? "63%" : "93%");
      return;
    }

    if (
      projectMode === "generated"
      && (
        current.zoom <= 0.105
        || Math.abs(current.zoom - generatedOverviewActualZoom) < 0.012
      )
    ) {
      setZoomLabel("10%");
      return;
    }

    if (projectMode === "generated" && current.zoom <= 0.285) {
      setZoomLabel("28%");
      return;
    }

    const displayZoom = current.zoom * boardZoomDisplayRatio;
    setZoomLabel(`${Math.round(displayZoom * 100)}%`);
  }, [boardViewport.zoom, getViewport, phase, projectMode, setZoomLabel]);

  const exportSelectionStateRef = useWorkbenchProjectRef(
    projectSession,
    () => ({ open: exportOpen, onSelectionChange }),
  );
  useEffect(() => {
    exportSelectionStateRef.current = { open: exportOpen, onSelectionChange };
  }, [exportOpen, exportSelectionStateRef, onSelectionChange]);
  const resolveCanvasAgentScreen = useCallback((reference: CanvasScreenReference) => {
    const board = currentBoardSnapshotRef.current();
    const node = board?.nodes.find((candidate) => canvasScreenReferenceMatches(reference, candidate));
    const summary = node ? canvasScreenSummaryFromBoardNode(node) : null;
    return board && node && summary ? { board, node, summary } : null;
  }, [currentBoardSnapshotRef]);
  const canvasAgentUiPort = useMemo<CanvasAgentUiPort>(() => ({
    getBoardRevision: () => currentBoardSnapshotRef.current()?.revision ?? 0,
    getCanvasStateRevision: () => canvasStateTrackerRef.current.revision,
    hasScreenReference: (reference) => resolveCanvasAgentScreen(reference) !== null,
    waitForBoardRevision: async (revision, signal) => {
      const current = currentBoardSnapshotRef.current()?.revision ?? 0;
      if (current >= revision) return current;
      await reloadBoardRef.current();
      if (signal.aborted || !projectSession.isCurrent()) {
        throw new DOMException("Project session changed", "AbortError");
      }
      const hydrationDeadline = Date.now() + 1_000;
      while (Date.now() < hydrationDeadline) {
        const hydrated = currentBoardSnapshotRef.current()?.revision ?? 0;
        if (hydrated >= revision) return hydrated;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
        if (signal.aborted || !projectSession.isCurrent()) {
          throw new DOMException("Project session changed", "AbortError");
        }
      }
      return currentBoardSnapshotRef.current()?.revision ?? 0;
    },
    selectScreen: (targets, mode, context) => {
      if (context.signal.aborted || !projectSession.isCurrent()) {
        throw new DOMException("Project session changed", "AbortError");
      }
      const board = currentBoardSnapshotRef.current();
      if (!board) throw new Error("Board is unavailable");
      const targetIds = new Set(targets.map((target) => {
        const resolved = resolveCanvasAgentScreen(target);
        if (!resolved) throw new Error("Screen is unavailable");
        return resolved.node.id;
      }));
      const selected = new Set(
        nodesRef.current.filter((node) => node.selected).map((node) => node.id),
      );
      if (mode === "replace") {
        selected.clear();
        targetIds.forEach((nodeId) => selected.add(nodeId));
      } else if (mode === "add") {
        targetIds.forEach((nodeId) => selected.add(nodeId));
      } else if (mode === "remove") {
        targetIds.forEach((nodeId) => selected.delete(nodeId));
      } else {
        targetIds.forEach((nodeId) => {
          if (selected.has(nodeId)) selected.delete(nodeId);
          else selected.add(nodeId);
        });
      }
      const nextNodes = nodesRef.current.map((node) => ({
        ...node,
        selected: selected.has(node.id),
      })) as WorkbenchNode[];
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      setSelectedActionOpen(false);
      const persistedSelectedIds = [...selected].filter((nodeId) => (
        board.nodes.some((node) => node.id === nodeId)
      ));
      writeSelectedNodeUrl(persistedSelectedIds);
      if (exportSelectionStateRef.current.open) {
        exportSelectionStateRef.current.onSelectionChange(workbenchCanvasSelection(
          nextNodes.filter((node) => persistedSelectedIds.includes(node.id)),
        ));
      }
      recordCanvasState(persistedSelectedIds, getViewport());
      const items = board.nodes.flatMap((node) => {
        if (!selected.has(node.id)) return [];
        const summary = canvasScreenSummaryFromBoardNode(node);
        return summary ? [summary] : [];
      });
      return {
        selection: {
          kind: items.length === 0 ? "none" : items.length === 1 ? "single" : "multiple",
          items,
          truncated: false,
        },
      };
    },
    openPreview: async (target, visualCapabilityId, context) => {
      if (context.signal.aborted || !projectSession.isCurrent()) {
        throw new DOMException("Project session changed", "AbortError");
      }
      const resolved = resolveCanvasAgentScreen(target);
      const previewNode = nodesRef.current.find((node) => node.id === target.boardNodeId);
      const previewArtifact = projectScreenArtifactReferenceFromNode(previewNode);
      if (
        !resolved
        || !previewArtifact
        || previewArtifact.artifactId !== target.artifactId
        || previewArtifact.artifactVersionId !== target.artifactVersionId
        || previewArtifact.screenId !== target.screenId
      ) {
        throw new Error("Screen preview is unavailable");
      }
      const visualCapture = await captureCanvasVisual(target, visualCapabilityId, {
        signal: context.signal,
      });
      if (
        context.signal.aborted
        || !projectSession.isCurrent()
        || !openPreview({
          artifactId: target.artifactId,
          artifactVersionId: target.artifactVersionId,
          projectId,
          screenId: target.screenId,
        })
      ) {
        throw new Error("Screen preview is unavailable");
      }
      return visualCapture;
    },
    navigateCanvas: async (command, context) => {
      if (context.signal.aborted || !projectSession.isCurrent()) {
        throw new DOMException("Project session changed", "AbortError");
      }
      const board = currentBoardSnapshotRef.current();
      const stage = stageRef.current?.getBoundingClientRect();
      if (!board || !stage || stage.width <= 0 || stage.height <= 0) {
        throw new Error("Canvas viewport is unavailable");
      }
      const screenNodeIds = board.nodes.flatMap((node) => (
        canvasScreenSummaryFromBoardNode(node) ? [node.id] : []
      ));
      const targetNodeIds = command.target.kind === "screen"
        ? [command.target.screen.boardNodeId]
        : command.target.kind === "selection"
          ? nodesRef.current
              .filter((node) => node.selected && screenNodeIds.includes(node.id))
              .map((node) => node.id)
          : screenNodeIds;
      const targetNodes = nodesRef.current.filter((node) => targetNodeIds.includes(node.id));
      if (targetNodes.length === 0) throw new Error("Canvas navigation target is unavailable");
      const bounds = getNodesBounds(targetNodes);
      const nextViewport = getViewportForBounds(
        bounds,
        stage.width,
        stage.height,
        0.04,
        1.25,
        0.12,
      );
      context.armProgrammaticViewport(nextViewport);
      manualZoomRef.current = true;
      setBoardViewport(nextViewport);
      recordCanvasState(
        nodesRef.current.filter((node) => node.selected).map((node) => node.id),
        nextViewport,
      );
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      await setViewport(nextViewport, {
        duration: command.behavior === "smooth" && !reduceMotion ? 180 : 0,
      });
      if (context.signal.aborted || !projectSession.isCurrent()) {
        throw new DOMException("Project session changed", "AbortError");
      }
      return { viewport: nextViewport };
    },
  }), [
    canvasStateTrackerRef,
    currentBoardSnapshotRef,
    exportSelectionStateRef,
    getNodesBounds,
    getViewport,
    manualZoomRef,
    nodesRef,
    openPreview,
    projectId,
    projectSession,
    recordCanvasState,
    reloadBoardRef,
    resolveCanvasAgentScreen,
    setBoardViewport,
    setNodes,
    setSelectedActionOpen,
    setViewport,
    stageRef,
    writeSelectedNodeUrl,
  ]);
  const canvasAgentBoardId = currentBoardSnapshotRef.current()?.boardId ?? "";
  useEffect(() => {
    if (
      loadStatus !== "ready"
      || !activeRun
      || !projectId
      || !threadId
      || !runId
      || !canvasAgentBoardId
      || !projectSession.isCurrent()
    ) return;
    const abortController = new AbortController();
    const poller = new CanvasAgentCommandPoller({
      captureState: captureCanvasClientState,
      scope: {
        projectId,
        threadId,
        runId,
        boardId: canvasAgentBoardId,
        clientSessionId: canvasClientSessionIdRef.current,
        projectSessionGeneration: projectSession.generation,
      },
      transport: canvasAgentTransport,
      ui: canvasAgentUiPort,
    });
    canvasAgentPollerRef.current = poller;
    void poller.run(abortController.signal);
    return () => {
      abortController.abort();
      poller.stop();
      if (canvasAgentPollerRef.current === poller) canvasAgentPollerRef.current = null;
    };
  }, [
    activeRun,
    canvasAgentBoardId,
    canvasAgentPollerRef,
    canvasAgentTransport,
    canvasAgentUiPort,
    canvasClientSessionIdRef,
    captureCanvasClientState,
    loadStatus,
    projectId,
    projectSession,
    runId,
    threadId,
  ]);

  const handleToolAction = useCallback((command: CanvasMainCommand) => {
    const transition = transitionCanvasTools(
      { interactionMode: activeTool, panel: activePanel, projectId },
      { type: "main-command", command },
      canvasEnvironment,
    );
    if (transition.blockedReason) {
      toast.error(command === "direct-edit" ? "当前选择不满足直接编辑条件" : "该画布操作当前不可用");
      return;
    }
    setActiveTool(transition.state.interactionMode);
    setActivePanel(transition.state.panel);
    closeTransientPanels();
  }, [
    activePanel,
    activeTool,
    canvasEnvironment,
    closeTransientPanels,
    projectId,
    setActivePanel,
    setActiveTool,
  ]);

  const handleMoreToolAction = useCallback((command: CanvasMoreCommand) => {
    const transition = transitionCanvasTools(
      { interactionMode: activeTool, panel: activePanel, projectId },
      { type: "more-command", command },
      canvasEnvironment,
    );
    if (transition.blockedReason) {
      toast.error("该画布操作当前不可用");
      return;
    }
    setActiveTool(transition.state.interactionMode);
    setActivePanel(null);
    closeTransientPanels();
  }, [
    activePanel,
    activeTool,
    canvasEnvironment,
    closeTransientPanels,
    projectId,
    setActivePanel,
    setActiveTool,
  ]);

  const beginSelectedScreenComposerIntent = useCallback((
    kind: ProjectScreenComposerIntent["kind"],
    label: string,
    choiceKey: string,
    promptDraft?: string,
  ) => {
    if (!choiceKey || artifactSelection.selectedPrototypeTargets.length === 0) return;
    const commonIntent = {
      id: `${kind}:${artifactSelection.selectedPrototypeTargets.map((target) => (
        `${target.nodeId}:${target.reference.artifactVersionId}:${target.reference.screenId}`
      )).join(",")}`,
      label,
      modelChoiceKey: choiceKey,
      targets: artifactSelection.selectedPrototypeTargets.map((target) => ({
        nodeId: target.nodeId,
        reference: { ...target.reference },
        title: target.title,
      })),
    };
    if (kind === "agent-edit" || kind === "generate-variants") {
      beginComposerIntent({
        ...commonIntent,
        artifactTargets: structuredClone(artifactSelection.editArtifactTargets),
        kind,
        workflow: "edit",
      });
    } else {
      beginComposerIntent({
        ...commonIntent,
        artifactTargets: structuredClone(artifactSelection.selectedPrototypeRunTargets),
        kind,
        workflow: "generate",
      });
    }
    if (promptDraft !== undefined) setProjectDraft(promptDraft);
    closeTransientPanels();
  }, [
    artifactSelection.editArtifactTargets,
    artifactSelection.selectedPrototypeRunTargets,
    artifactSelection.selectedPrototypeTargets,
    beginComposerIntent,
    closeTransientPanels,
    setProjectDraft,
  ]);

  const generateFromSelectedScreen = useCallback(() => {
    if (
      screenContextState.kind !== "single"
      || !screenContextState.availability.generate.enabled
      || !generateModelChoice
      || !runtimeModelsReady
    ) return;
    beginSelectedScreenComposerIntent(
      "generate-followup",
      `后续设计：${screenContextState.target.title}`,
      generateModelChoice.key,
    );
  }, [
    beginSelectedScreenComposerIntent,
    generateModelChoice,
    runtimeModelsReady,
    screenContextState,
  ]);

  const modifySelectedScreen = useCallback(() => {
    if (screenContextState.kind !== "single") return;
    if (screenContextState.modifyDisposition.kind === "direct-edit") {
      clearComposerIntent();
      handleToolAction("direct-edit");
      return;
    }
    if (screenContextState.modifyDisposition.kind !== "agent-edit" || !editModelChoice) return;
    beginSelectedScreenComposerIntent(
      "agent-edit",
      `修改：${screenContextState.target.title}`,
      editModelChoice.key,
    );
  }, [
    beginSelectedScreenComposerIntent,
    clearComposerIntent,
    editModelChoice,
    handleToolAction,
    screenContextState,
  ]);

  const previewSelectedScreen = useCallback(() => {
    if (screenContextState.kind !== "single") return;
    if (screenContextState.previewDisposition.kind === "open-existing") {
      clearComposerIntent();
      openPreview(screenContextState.previewDisposition.reference);
      return;
    }
    if (
      screenContextState.previewDisposition.kind !== "generate-required"
      || !generateModelChoice
      || !runtimeModelsReady
    ) return;
    beginSelectedScreenComposerIntent(
      "generate-prototype",
      `生成原型：${screenContextState.target.title}`,
      generateModelChoice.key,
      `为“${screenContextState.target.title}”生成可交互原型`,
    );
  }, [
    beginSelectedScreenComposerIntent,
    clearComposerIntent,
    generateModelChoice,
    openPreview,
    runtimeModelsReady,
    screenContextState,
  ]);

  const previewSelectedScreens = useCallback(() => {
    if (screenContextState.kind !== "multiple") return;
    if (screenContextState.previewDisposition.kind === "open-existing") {
      clearComposerIntent();
      openPreview(screenContextState.previewDisposition.references);
      return;
    }
    if (
      screenContextState.previewDisposition.kind !== "generate-required"
      || !generateModelChoice
      || !runtimeModelsReady
    ) return;
    const count = screenContextState.targets.length;
    beginSelectedScreenComposerIntent(
      "generate-prototype",
      `生成原型：已选择 ${count} 个界面`,
      generateModelChoice.key,
      `为所选 ${count} 个界面生成可交互原型`,
    );
  }, [
    beginSelectedScreenComposerIntent,
    clearComposerIntent,
    generateModelChoice,
    openPreview,
    runtimeModelsReady,
    screenContextState,
  ]);

  const generateSelectedVariants = useCallback(() => {
    if (
      screenContextState.kind !== "multiple"
      || !screenContextState.availability.generateVariants.enabled
      || !editModelChoice
    ) return;
    beginSelectedScreenComposerIntent(
      "generate-variants",
      `${screenContextState.targets.length} 个界面`,
      editModelChoice.key,
      "为所选界面生成变体",
    );
  }, [beginSelectedScreenComposerIntent, editModelChoice, screenContextState]);

  const persistPrototypeDocument = useCallback(async (
    reference: WorkbenchArtifactReference,
    document: PrototypeDocument,
  ) => {
    if (
      activeRunRef.current
      || !capabilities.canEdit
      || !artifactSelection.styleTargetReference
      || reference.artifactId !== artifactSelection.styleTargetReference.artifactId
      || reference.artifactVersionId !== artifactSelection.styleTargetReference.artifactVersionId
      || !selectedArtifactQuery.data?.etag
      || createPrototypeVersion.isPending
    ) {
      throw new Error("The selected Prototype version changed before the edit could be saved");
    }
    const baseArtifactVersionId = reference.artifactVersionId;
    const result = await createPrototypeVersion.mutateAsync({
      ifMatch: selectedArtifactQuery.data.etag,
      idempotencyKey: prototypeDocumentEditIdempotencyKey(baseArtifactVersionId, document),
      request: {
        kind: "prototype",
        baseArtifactVersionId,
        document,
      },
    });
    if (!projectSession.isCurrent() || activeRunRef.current) return false;
    const updatedNodeIds = onReplaceArtifactVersionPins(
      reference.artifactId,
      baseArtifactVersionId,
      result.value.artifactVersionId,
    );
    if (updatedNodeIds.length === 0) {
      throw new Error("The edited Artifact is no longer pinned on the active Board");
    }
    return true;
  }, [
    activeRunRef,
    capabilities.canEdit,
    createPrototypeVersion,
    onReplaceArtifactVersionPins,
    projectSession,
    selectedArtifactQuery.data?.etag,
    artifactSelection.styleTargetReference,
  ]);

  const commitCanvasStyle = useCallback((nextDraft: WorkbenchCanvasDesignSystemDraft) => {
    if (
      designSystemPanelReadOnly
      || !artifactSelection.styleTargetReference
      || !editablePrototypeDocument
      || createPrototypeVersion.isPending
    ) {
      return;
    }
    const { normalizedDraft, previousDraft } = artifactIntent.beginStyleDraftChange(nextDraft);

    const document = applyPrototypeCanvasStyle(editablePrototypeDocument, normalizedDraft);
    void persistPrototypeDocument(artifactSelection.styleTargetReference, document).then((saved) => {
      if (saved && projectSession.isCurrent()) toast.success("样式已保存");
    }).catch((error) => {
      if (!projectSession.isCurrent()) return;
      artifactIntent.rejectStyleDraftChange(
        previousDraft,
        errorMessage(error, "样式保存失败，请重试"),
      );
    });
  }, [
    artifactIntent.beginStyleDraftChange,
    artifactIntent.rejectStyleDraftChange,
    artifactSelection.styleTargetReference,
    editablePrototypeDocument,
    designSystemPanelReadOnly,
    persistPrototypeDocument,
    projectSession,
  ]);

  const commitPrototypeTransform = useCallback(async (
    reference: WorkbenchArtifactReference,
    document: PrototypeDocument,
  ) => {
    try {
      const saved = await persistPrototypeDocument(reference, document);
      if (saved && projectSession.isCurrent()) toast.success("界面修改已保存");
    } catch (error) {
      if (!projectSession.isCurrent()) return;
      toast.error(errorMessage(error, "界面修改保存失败，请重试"));
      throw error;
    }
  }, [persistPrototypeDocument, projectSession]);

  const commitPrdDocument = useCallback(async (
    reference: WorkbenchArtifactReference,
    document: PrdDocument,
  ) => {
    if (
      activeRunRef.current
      || !capabilities.canEdit
      || !artifactSelection.prdTargetReference
      || reference.artifactId !== artifactSelection.prdTargetReference.artifactId
      || reference.artifactVersionId !== artifactSelection.prdTargetReference.artifactVersionId
      || !prdArtifactQuery.data?.etag
      || createPrdVersion.isPending
    ) {
      throw new Error("The selected PRD version changed before the edit could be saved");
    }
    const result = await createPrdVersion.mutateAsync({
      ifMatch: prdArtifactQuery.data.etag,
      idempotencyKey: prdDocumentEditIdempotencyKey(reference.artifactVersionId, document),
      request: {
        kind: "prd",
        baseArtifactVersionId: reference.artifactVersionId,
        document,
      },
    });
    if (!projectSession.isCurrent() || activeRunRef.current) return;
    const updatedNodeIds = onReplaceArtifactVersionPins(
      reference.artifactId,
      reference.artifactVersionId,
      result.value.artifactVersionId,
    );
    if (updatedNodeIds.length === 0) {
      throw new Error("The edited PRD is no longer pinned on the active Board");
    }
    if (projectSession.isCurrent()) toast.success("PRD 已保存");
  }, [
    activeRunRef,
    capabilities.canEdit,
    createPrdVersion,
    onReplaceArtifactVersionPins,
    projectSession,
    prdArtifactQuery.data?.etag,
    artifactSelection.prdTargetReference,
  ]);

  const commitBoardFrame = useCallback((bounds: BoardRect) => {
    if (activeRunRef.current || !capabilities.canEdit) return;
    const nodeId = onAddBoardFrame(bounds);
    if (!nodeId) return;
    setNodeSelection(nodeId);
    writeSelectedNodeUrl([nodeId]);
    if (exportOpen) onSelectionChange({ artifact: null, hasSelection: true, nodeIds: [nodeId] });
    handleToolAction("select");
  }, [
    activeRunRef,
    capabilities.canEdit,
    exportOpen,
    onAddBoardFrame,
    handleToolAction,
    onSelectionChange,
    setNodeSelection,
    writeSelectedNodeUrl,
  ]);

  const commitBoardDrawing = useCallback((
    samples: readonly BoardDrawingSample[],
    options: CreateBoardDrawingOptions,
  ) => {
    if (activeRunRef.current || !capabilities.canEdit) return;
    const nodeId = onAddBoardDrawing(samples, options);
    if (!nodeId) return;
    setNodeSelection(nodeId);
    writeSelectedNodeUrl([nodeId]);
    if (exportOpen) onSelectionChange({ artifact: null, hasSelection: true, nodeIds: [nodeId] });
  }, [
    activeRunRef,
    capabilities.canEdit,
    exportOpen,
    onAddBoardDrawing,
    onSelectionChange,
    setNodeSelection,
    writeSelectedNodeUrl,
  ]);

  const selectAllNodes = useCallback(() => {
    setNodeSelection(nodesRef.current[0]?.id ?? "");
    setSelectedActionOpen(false);
    setNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: true })));
    writeSelectedNodeUrl([]);
    if (exportOpen) {
      onSelectionChange(workbenchCanvasSelection(
        nodesRef.current.filter((node) => persistedBoardNodeIds.has(node.id)),
      ));
    }
  }, [
    exportOpen,
    nodesRef,
    onSelectionChange,
    persistedBoardNodeIds,
    setNodes,
    setSelectedActionOpen,
    setNodeSelection,
    writeSelectedNodeUrl,
  ]);

  useEffect(() => {
    if (selectAllRequest <= lastSelectAllRequestRef.current) return;
    lastSelectAllRequestRef.current = selectAllRequest;
    selectAllNodes();
  }, [lastSelectAllRequestRef, selectAllNodes, selectAllRequest]);

  const arrangeSelectedBoardNodes = useCallback((operation: BoardNodeArrangeOperation) => {
    if (!capabilities.canEdit || activeRunRef.current) return;
    const outcome = onArrangeBoardNodes(
      artifactSelection.selectedBoardNodeIds,
      operation,
    );
    if (!outcome.changed && outcome.reason === "missing-size") {
      toast.error("所选内容缺少可用尺寸，无法排列");
    }
  }, [
    activeRunRef,
    artifactSelection.selectedBoardNodeIds,
    capabilities.canEdit,
    onArrangeBoardNodes,
  ]);

  const duplicateSelectedBoardNodes = useCallback(() => {
    if (activeRunRef.current || !selectedActionAvailability.canDuplicate) return;
    const createdNodeIds = onDuplicateBoardNodes(artifactSelection.selectedBoardNodeIds);
    setSelectedActionOpen(false);
    if (createdNodeIds.length === 0) {
      toast.error("所选内容无法复制");
      return;
    }
    pendingNodeSelectionRef.current = [...createdNodeIds];
    const createdNodeIdSet = new Set(createdNodeIds);
    setNodes((currentNodes) => currentNodes.map((node) => ({
      ...node,
      selected: createdNodeIdSet.has(node.id),
    })));
    writeSelectedNodeUrl(createdNodeIds);
  }, [
    activeRunRef,
    onDuplicateBoardNodes,
    pendingNodeSelectionRef,
    selectedActionAvailability.canDuplicate,
    artifactSelection.selectedBoardNodeIds,
    setSelectedActionOpen,
    setNodes,
    writeSelectedNodeUrl,
  ]);

  const exportSelectedBoardNodes = useCallback(() => {
    if (!capabilities.canExport) return;
    const selectedIds = new Set(artifactSelection.selectedBoardNodeIds);
    const selectedNodes = nodesRef.current.filter((node) => (
      selectedIds.has(node.id) && persistedBoardNodeIds.has(node.id)
    ));
    if (selectedNodes.length === 0) return;
    closeTransientPanels();
    onExport(workbenchCanvasSelection(selectedNodes));
  }, [
    artifactSelection.selectedBoardNodeIds,
    capabilities.canExport,
    closeTransientPanels,
    nodesRef,
    onExport,
    persistedBoardNodeIds,
  ]);

  const copySelectedBoardNodeLink = useCallback(() => {
    if (!selectedActionAvailability.canCopyLink || !artifactSelection.selectedBoardNode) return;
    const url = createWorkbenchBoardNodeUrl(projectId, artifactSelection.selectedBoardNode.id);
    writeSelectedNodeUrl([artifactSelection.selectedBoardNode.id]);
    setSelectedActionOpen(false);
    void writeWorkbenchClipboard(url)
      .then(() => {
        if (projectSession.isCurrent()) toast.success("链接已复制");
      })
      .catch(() => {
        if (projectSession.isCurrent()) toast.error("复制链接失败，请重试");
      });
  }, [
    projectId,
    selectedActionAvailability.canCopyLink,
    artifactSelection.selectedBoardNode,
    projectSession,
    setSelectedActionOpen,
    writeSelectedNodeUrl,
  ]);

  const requestRenameSelectedBoardNode = useCallback(() => {
    if (
      activeRunRef.current
      || !selectedActionAvailability.canRename
      || !artifactSelection.selectedBoardNode
    ) return;
    setSelectedActionOpen(false);
    openRenameIntent(artifactSelection.selectedBoardNode.id);
  }, [
    activeRunRef,
    artifactSelection.selectedBoardNode,
    openRenameIntent,
    selectedActionAvailability.canRename,
    setSelectedActionOpen,
  ]);

  const requestDeleteSelectedBoardNodes = useCallback(() => {
    if (activeRunRef.current || !selectedActionAvailability.canDelete) return;
    setSelectedActionOpen(false);
    openDeleteIntent(artifactSelection.selectedBoardNodeIds);
  }, [
    activeRunRef,
    artifactSelection.selectedBoardNodeIds,
    openDeleteIntent,
    selectedActionAvailability.canDelete,
    setSelectedActionOpen,
  ]);

  const setZoom = useCallback((displayZoom: number) => {
    const current = getViewport();
    const actualZoom = projectMode === "generated" && displayZoom === 0.1
      ? generatedOverviewActualZoom
      : projectMode === "generated" && displayZoom <= 0.28
      ? displayZoom
      : displayZoom / boardZoomDisplayRatio;
    const rect = stageRef.current?.getBoundingClientRect();
    const nextViewport = rect && projectMode === "generated" && displayZoom === 0.1
      ? {
          x: Math.round(rect.width * 0.24 - 60 * actualZoom),
          y: Math.round(76 - (-720 * actualZoom)),
          zoom: actualZoom,
        }
      : rect && projectMode === "generated" && phase === "complete" && displayZoom === 0.63
      ? getGeneratedViewport(rect.width, rect.height, phase)
      : rect && projectMode === "generated" && displayZoom === 0.28
      ? (() => {
          const generatedBounds = phase === "complete"
            ? { centerX: 2000, centerY: 980 }
            : { centerX: 2190, centerY: 980 };
          return {
            x: Math.round(rect.width * 0.52 - generatedBounds.centerX * actualZoom),
            y: Math.round(rect.height * 0.515 - generatedBounds.centerY * actualZoom),
            zoom: actualZoom,
          };
        })()
      : rect
      ? {
          x: (rect.width / 2) - (((rect.width / 2) - current.x) / current.zoom) * actualZoom,
          y: (rect.height / 2) - (((rect.height / 2) - current.y) / current.zoom) * actualZoom,
          zoom: actualZoom,
        }
      : { ...current, zoom: actualZoom };

    void setViewport(nextViewport, { duration: 180 });
    manualZoomRef.current = true;
    if (projectMode === "generated" && displayZoom === 0.1) {
      handleToolAction("select");
    } else if (projectMode === "generated" && phase === "complete" && displayZoom >= 0.63) {
      handleToolAction("pan");
    }
    setZoomLabel(`${Math.round(displayZoom * 100)}%`);
    setZoomMenuOpen(false);
  }, [
    getViewport,
    manualZoomRef,
    handleToolAction,
    phase,
    projectMode,
    setViewport,
    setZoomLabel,
    setZoomMenuOpen,
  ]);

  const resetViewport = useCallback(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    const fitNodes = nodesRef.current.filter((node) => persistedBoardNodeIds.has(node.id));
    const nextViewport = stage && stage.width > 0 && stage.height > 0 && fitNodes.length > 0
      ? getViewportForBounds(
          getNodesBounds(fitNodes),
          stage.width,
          stage.height,
          0.04,
          1.25,
          0.12,
        )
      : boardViewport;
    manualZoomRef.current = true;
    setBoardViewport(nextViewport);
    void setViewport(nextViewport, { duration: 220 });
    window.setTimeout(() => {
      if (projectSession.isCurrent()) updateZoomLabel();
    }, 240);
    setZoomMenuOpen(false);
  }, [
    boardViewport,
    getNodesBounds,
    manualZoomRef,
    nodesRef,
    persistedBoardNodeIds,
    projectSession,
    setBoardViewport,
    setViewport,
    setZoomMenuOpen,
    updateZoomLabel,
  ]);

  const fitSelection = useCallback(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    const selected = nodesRef.current.filter((node) => node.selected && persistedBoardNodeIds.has(node.id));
    if (!stage || stage.width <= 0 || stage.height <= 0 || selected.length === 0) return;
    const nextViewport = getViewportForBounds(
      getNodesBounds(selected),
      stage.width,
      stage.height,
      0.04,
      1.25,
      0.12,
    );
    manualZoomRef.current = true;
    setBoardViewport(nextViewport);
    void setViewport(nextViewport, { duration: 220 });
    window.setTimeout(() => {
      if (projectSession.isCurrent()) updateZoomLabel();
    }, 240);
    setZoomMenuOpen(false);
  }, [
    getNodesBounds,
    manualZoomRef,
    nodesRef,
    persistedBoardNodeIds,
    projectSession,
    setBoardViewport,
    setViewport,
    setZoomMenuOpen,
    updateZoomLabel,
  ]);

  const nudgeSelectedBoardNodes = useCallback((delta: { x: number; y: number }) => {
    if (
      !capabilities.canEdit
      || activeRunRef.current
      || prototypeEditMode
      || activeTool !== "select"
    ) return;
    const selectedIds = artifactSelection.selectedBoardNodeIds;
    if (selectedIds.length === 0) return;
    onNudgeBoardNodes(selectedIds, delta);
  }, [
    activeRunRef,
    activeTool,
    artifactSelection.selectedBoardNodeIds,
    capabilities.canEdit,
    onNudgeBoardNodes,
    prototypeEditMode,
  ]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable)
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (artifactIntent.versionHistoryReference) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "z" && !isTypingTarget(event.target)) {
        setZoomKeyActive(true);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !isTypingTarget(event.target)) {
        const key = event.key.toLowerCase();
        if (key === "z" && event.shiftKey && boardCanRedo && !activeRunRef.current) {
          event.preventDefault();
          onRedoBoard();
          return;
        }
        if (key === "z" && !event.shiftKey && boardCanUndo && !activeRunRef.current) {
          event.preventDefault();
          onUndoBoard();
          return;
        }
        if (key === "y" && !event.shiftKey && boardCanRedo && !activeRunRef.current) {
          event.preventDefault();
          onRedoBoard();
          return;
        }
        if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
          event.preventDefault();
          manualZoomRef.current = true;
          void zoomIn({ duration: 180 });
          window.setTimeout(() => {
            if (projectSession.isCurrent()) updateZoomLabel();
          }, 200);
          return;
        }
        if ((event.key === "-" || event.code === "NumpadSubtract") && !event.shiftKey) {
          event.preventDefault();
          manualZoomRef.current = true;
          void zoomOut({ duration: 180 });
          window.setTimeout(() => {
            if (projectSession.isCurrent()) updateZoomLabel();
          }, 200);
          return;
        }
      }

      if (
        event.shiftKey
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !isTypingTarget(event.target)
      ) {
        if (event.code === "Digit0") {
          event.preventDefault();
          setZoom(1);
          return;
        }
        if (event.code === "Digit1") {
          event.preventDefault();
          resetViewport();
          return;
        }
        if (event.code === "Digit2") {
          event.preventDefault();
          fitSelection();
          return;
        }
      }

      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        nudgeSelectedBoardNodes({
          x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
          y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
        });
        return;
      }

      if (
        event.shiftKey
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && event.key.toLowerCase() === "f"
        && !isTypingTarget(event.target)
        && artifactSelection.preferenceTargetReference
      ) {
        event.preventDefault();
        toggleArtifactPreference("favorite");
        return;
      }

      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "e" && !isTypingTarget(event.target)) {
        event.preventDefault();
        closeTransientPanels();
        onExport();
        return;
      }

      if (event.key === "Escape") {
        if (document.querySelector("[data-screen-context-menu]")) return;
        if (previewOpen) {
          closePreview();
          return;
        }
        setProjectMenuOpen(false);
        closeModelMenu();
        setZoomMenuOpen(false);
        setZoomKeyActive(false);
        setSelectedActionOpen(false);
        setNodeSelection("");
        setNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: false })));
        writeSelectedNodeUrl([]);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !isTypingTarget(event.target)) {
        if (prototypeEditMode) return;
        event.preventDefault();
        selectAllNodes();
        return;
      }

      if (
        (event.key === "Backspace" || event.key === "Delete")
        && !isTypingTarget(event.target)
        && !prototypeEditMode
        && selectedActionAvailability.canDelete
      ) {
        event.preventDefault();
        requestDeleteSelectedBoardNodes();
        return;
      }

    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "z") setZoomKeyActive(false);
    };

    const handleBlur = () => setZoomKeyActive(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [
    activeRunRef,
    fitSelection,
    boardCanRedo,
    boardCanUndo,
    closePreview,
    closeModelMenu,
    closeTransientPanels,
    artifactSelection.preferenceTargetReference,
    toggleArtifactPreference,
    onExport,
    onRedoBoard,
    onUndoBoard,
    previewOpen,
    nudgeSelectedBoardNodes,
    prototypeEditMode,
    requestDeleteSelectedBoardNodes,
    selectedActionAvailability.canDelete,
    selectAllNodes,
    setNodes,
    setZoom,
    resetViewport,
    manualZoomRef,
    projectSession,
    updateZoomLabel,
    zoomIn,
    zoomOut,
    artifactIntent.versionHistoryReference,
    writeSelectedNodeUrl,
  ]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-project-composer]")) {
        setProjectMenuOpen(false);
        setSelectedActionOpen(false);
        setZoomMenuOpen(false);
        return;
      }

      if (target.closest("[data-utility-pill]")) {
        setProjectMenuOpen(false);
        closeModelMenu();
        setSelectedActionOpen(false);
        return;
      }

      if (
        target.closest("[data-project-menu]")
        || target.closest("[data-selected-action]")
      ) {
        return;
      }

      closeTransientPanels();
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    return () => window.removeEventListener("mousedown", handlePointerDown, true);
  }, [closeModelMenu, closeTransientPanels]);

  const designSystemPanelError = artifactIntent.styleSaveError
    ?? (activePanel !== "design-system"
      ? null
      : !artifactSelection.styleTargetReference
        ? "请先选择一个原型界面"
        : selectedArtifactQuery.isError || styleVersionQuery.isError
          ? errorMessage(
              selectedArtifactQuery.error ?? styleVersionQuery.error,
              "无法读取当前原型样式",
            )
          : styleVersion && !editablePrototypeDocument
            ? "当前产物不是可编辑的原型版本"
            : null);
  const designSystemPanelBusy = createPrototypeVersion.isPending
    || Boolean(artifactSelection.styleTargetReference && (
      selectedArtifactQuery.isPending
      || styleVersionQuery.isPending
    ));
  const selectFavourite = useCallback((item: import("@workbench/workbench-contracts").ArtifactVersionFavoriteListItem) => {
    const target = nodes.find((node) => {
      const reference = projectScreenArtifactReferenceFromNode(node);
      return reference?.artifactVersionId === item.artifactVersionId
        && (item.screenId === null || reference.screenId === item.screenId);
    });
    if (!target) {
      toast.error("收藏的界面当前未固定在画布上");
      return;
    }
    selectNode(target.id);
    handleToolAction("select");
  }, [handleToolAction, nodes, selectNode]);

  const viewController: ProjectScreenViewContract = {
    root: {
      capabilities,
      isGeneratedOverview,
      loadError,
      loadStatus,
      onRetryProjectLoad,
      phase,
      projectId,
      projectMode,
      projectStageClass,
      projectTitle,
      stageRef,
      workspaceId,
    },
    canvas: {
      activePanel,
      activeTool,
      activeRun,
      boardCanRedo: boardCanRedo && !activeRun,
      boardCanUndo: boardCanUndo && !activeRun,
      boardNodeBeingRenamed,
      boardViewport,
      directEditAvailable: directEditAvailability.enabled,
      canvasMedia: {
        busy: canvasMedia.busy,
        error: canvasMedia.error,
        onClose: canvasMedia.close,
        onInsert: canvasMedia.insertMedia,
        progress: canvasMedia.progress,
      },
      canvasPermissions,
      nodes,
      onCommitDrawing: commitBoardDrawing,
      onCommitFrame: commitBoardFrame,
      onConfirmDelete: () => {
        if (!capabilities.canEdit || activeRunRef.current) {
          closeDeleteIntent();
          return;
        }
        const removedNodeIds = onRemoveBoardNodes(pendingDeleteNodeIds);
        closeDeleteIntent();
        if (removedNodeIds.length === 0) {
          toast.error("所选内容无法删除");
          return;
        }
        setNodeSelection("");
        setSelectedActionOpen(false);
        closeRenameIntent();
        writeSelectedNodeUrl([]);
        if (exportOpen) onSelectionChange({ artifact: null, hasSelection: false, nodeIds: [] });
      },
      onCopySelectedNodeLink: copySelectedBoardNodeLink,
      onDeleteDialogOpenChange: (open) => {
        if (!open) closeDeleteIntent();
      },
      onDuplicateSelectedNodes: duplicateSelectedBoardNodes,
      onFitSelection: fitSelection,
      onMoveEnd: (event, viewport) => {
        const poller = canvasAgentPollerRef.current;
        if (event) poller?.cancelViewportMoveForUserGesture();
        const suppressPersistence = event === null
          && (poller?.consumeViewportMoveEnd(viewport) ?? false);
        updateZoomLabel();
        recordCanvasState(
          nodesRef.current.filter((node) => node.selected).map((node) => node.id),
          viewport,
        );
        if (!suppressPersistence && canvasPermissions.canWriteBoard) {
          onBoardViewportChange(viewport);
        }
      },
      onNodeClick: (event, node) => {
        if (activeTool === "pan") return;
        if (event.shiftKey) {
          setNodes((currentNodes) => currentNodes.map((candidate) => (
            candidate.id === node.id ? { ...candidate, selected: true } : candidate
          )));
          setSelectedActionOpen(false);
          writeSelectedNodeUrl([]);
          return;
        }
        selectNode(node.id);
      },
      onNodeDoubleClick: (_event, node) => {
        if (activeTool === "pan") return;
        const reference = projectScreenArtifactReferenceFromNode(node);
        const preview = reference
          ? previewArtifacts.find((candidate) => (
              candidate.reference.artifactId === reference.artifactId
              && candidate.reference.artifactVersionId === reference.artifactVersionId
              && candidate.reference.screenId === reference.screenId
            ))
          : undefined;
        if (preview) openPreview(preview.reference);
      },
      onNodesChange: (changes) => {
        const effectiveChanges = activeTool === "pan"
          ? changes.filter((change) => change.type !== "select")
          : changes;
        onNodesChange(visibleWorkbenchNodeChanges(canvasPermissions.canWriteBoard, effectiveChanges));
        if (canvasPermissions.canWriteBoard) {
          const persistentChanges = effectiveChanges.filter((change) => change.type !== "select");
          if (persistentChanges.length > 0) {
            onBoardNodesChange(persistentChanges as NodeChange<BoardFlowNode>[]);
          }
        }
      },
      onOpenVersions: () => {
        if (!artifactSelection.selectedArtifactReference) return;
        setSelectedActionOpen(false);
        artifactIntent.openVersionHistory(artifactSelection.selectedArtifactReference);
      },
      onPaneClick: (event) => {
        if (activeTool === "pan") return;
        if (event.target instanceof Element && event.target.closest(".react-flow__node")) return;
        setNodeSelection("");
        setSelectedActionOpen(false);
        setNodes((currentNodes) => currentNodes.map((node) => ({ ...node, selected: false })));
        writeSelectedNodeUrl([]);
        if (exportOpen) onSelectionChange({ artifact: null, hasSelection: false, nodeIds: [] });
        setProjectMenuOpen(false);
        closeModelMenu();
        setZoomMenuOpen(false);
      },
      onRedo: () => {
        if (!activeRunRef.current) onRedoBoard();
      },
      onRenameNode: async (title) => {
        if (!boardNodeBeingRenamed) throw new Error("Board node rename target is unavailable");
        if (
          !capabilities.canEdit
          || activeRunRef.current
          || !onRenameBoardNode(boardNodeBeingRenamed.id, title)
        ) {
          throw new Error("Board node rename was not applied");
        }
      },
      onRenameNodeClose: closeRenameIntent,
      onRequestDeleteSelectedNodes: requestDeleteSelectedBoardNodes,
      onRequestRenameSelectedNode: requestRenameSelectedBoardNode,
      onResetView: resetViewport,
      onSelectTool: handleToolAction,
      onSelectMoreTool: handleMoreToolAction,
      onSelectFavourite: selectFavourite,
      onSelectionChange: handleFlowSelectionChange,
      onToggleSelectedActionMenu: () => {
        setSelectedActionOpen((open) => !open);
        setProjectMenuOpen(false);
        closeModelMenu();
        setZoomMenuOpen(false);
      },
      onToggleZoomMenu: () => {
        setZoomMenuOpen((open) => !open);
        setProjectMenuOpen(false);
        closeModelMenu();
        hideReadyToast();
      },
      onUndo: () => {
        if (!activeRunRef.current) onUndoBoard();
      },
      onZoomIn: () => {
        manualZoomRef.current = true;
        void zoomIn({ duration: 180 });
        window.setTimeout(() => {
          if (projectSession.isCurrent()) updateZoomLabel();
        }, 200);
      },
      onZoomOut: () => {
        manualZoomRef.current = true;
        void zoomOut({ duration: 180 });
        window.setTimeout(() => {
          if (projectSession.isCurrent()) updateZoomLabel();
        }, 200);
      },
      onZoomTo: setZoom,
      pendingDeleteNodeCount: pendingDeleteNodeIds.length,
      prototypeEditMode,
      prototypePatchProjector,
      selectedActionAvailability,
      selectedActionOpen,
      selectedArtifactReference: artifactSelection.selectedArtifactReference,
      selectedBoardNodeCount: artifactSelection.selectedBoardNodeIds.length,
      selectedGeneratedScreen: artifactSelection.selectedBoardNode?.type === "generatedScreen",
      screenContextToolbar: {
        model: screenContextToolbarModel,
        onAlign: arrangeSelectedBoardNodes,
        onCopyLink: copySelectedBoardNodeLink,
        onDelete: requestDeleteSelectedBoardNodes,
        onDistribute: arrangeSelectedBoardNodes,
        onDuplicate: duplicateSelectedBoardNodes,
        onExport: exportSelectedBoardNodes,
        onGenerate: generateFromSelectedScreen,
        onGenerateVariants: generateSelectedVariants,
        onModify: modifySelectedScreen,
        onOpenVersions: () => {
          if (!artifactSelection.selectedArtifactReference) return;
          artifactIntent.openVersionHistory(artifactSelection.selectedArtifactReference);
        },
        onPreview: screenContextState.kind === "multiple"
          ? previewSelectedScreens
          : previewSelectedScreen,
        onRename: requestRenameSelectedBoardNode,
        onToggleFavourite: () => toggleArtifactPreference("favorite"),
        onToggleDislike: () => toggleArtifactPreference("dislike"),
        onToggleLike: () => toggleArtifactPreference("like"),
      },
      zoomKeyActive,
      zoomLabel,
      zoomMenuOpen,
    },
    artifactEditing: {
      artifactPreferenceController,
      onCloseDesignSystemPanel: () => {
        createPrototypeVersion.reset();
        artifactIntent.clearStyleSaveError();
        handleToolAction("design-system");
      },
      onOpenVersionHistory: artifactIntent.openVersionHistory,
      onPinArtifactVersion: async (artifactId, pinnedVersionId, targetVersionId) => {
        if (!capabilities.canEdit || activeRunRef.current) return [];
        return onPinArtifactVersion(artifactId, pinnedVersionId, targetVersionId);
      },
      onVersionHistoryOpenChange: (open) => {
        if (!open) artifactIntent.closeVersionHistory();
      },
      prdEditor: {
        busy: createPrdVersion.isPending,
        enabled: Boolean(
          capabilities.canEdit
          && artifactSelection.selectedBoardNode?.type === "documentCanvas"
          && artifactSelection.prdTargetReference
          && prdArtifactQuery.data?.value,
        ),
        onDocumentCommit: commitPrdDocument,
      },
      prototypeEditor: {
        busy: createPrototypeVersion.isPending,
        enabled: prototypeEditMode,
        onDocumentCommit: commitPrototypeTransform,
      },
      designSystemDraft: artifactIntent.styleDraft,
      designSystemPanelBusy,
      designSystemPanelError,
      designSystemPanelReadOnly,
      onDesignSystemChange: commitCanvasStyle,
      versionHistoryReference: artifactIntent.versionHistoryReference,
    },
    chrome: {
      archiveConfirmationOpen: projectActions.archiveConfirmationOpen,
      archiveFailed: projectActions.archiveFailed,
      exportOpen,
      onArchiveConfirmationOpenChange: (open) => projectActions.setArchiveConfirmationOpen(open),
      onBack,
      onClosePreview: closePreview,
      onCloseReadyToast: hideReadyToast,
      onCloseRenameProject: projectActions.closeRenameProject,
      onConfirmArchive: () => {
        projectActions.confirmArchiveProject();
      },
      onDuplicateProject: () => {
        if (projectActions.duplicateProject()) setProjectMenuOpen(false);
      },
      onExport: () => {
        setProjectMenuOpen(false);
        onExport();
      },
      onMembers: () => {
        setProjectMenuOpen(false);
        setProjectMembersOpen(true);
      },
      onMembersOpenChange: (open) => setProjectMembersOpen(open),
      onOpenPreview: openPreview,
      onRenameProject: projectActions.renameProject,
      onRequestArchive: () => {
        setProjectMenuOpen(false);
        projectActions.requestArchiveProject();
      },
      onRequestRename: () => {
        if (projectActions.requestRenameProject()) setProjectMenuOpen(false);
      },
      onShare: () => {
        if (!capabilities.canShare) return;
        setProjectMenuOpen(false);
        onShare();
      },
      onToggleProjectMenu: () => {
        setProjectMenuOpen((open) => !open);
        closeModelMenu();
        setZoomMenuOpen(false);
        setSelectedActionOpen(false);
      },
      previewArtifacts: previewReferences.length === 0
        ? previewArtifacts
        : previewReferences.flatMap((reference) => {
            const artifact = previewArtifacts.find((candidate) => (
              candidate.reference.artifactId === reference.artifactId
              && candidate.reference.artifactVersionId === reference.artifactVersionId
              && candidate.reference.screenId === reference.screenId
            ));
            return artifact ? [artifact] : [];
          }),
      previewCreate: onCreatePreview,
      previewInitialReference: previewReferences[0] ?? projectScreenArtifactReferenceFromNode(
        nodes.find((node) => node.id === selectedNodeId),
      ) ?? undefined,
      previewOpen,
      projectActionBusy: projectActions.projectActionBusy,
      projectMembersOpen,
      projectMenuOpen,
      readyToastOpen,
      renameProjectOpen: projectActions.renameOpen,
      shareOpen,
    },
    composer: {
      onSelectSuggestion: (text) => {
        if (projectMode === "document" && /UI|界面/i.test(text)) {
          void submitPromptWithCanvasSnapshot({
            prompt: text,
            modelChoiceKey: model,
            targetSurface: selectedTargetSurface,
            artifactTargets: projectModelChoices.find((choice) => choice.key === model)?.workflow === "edit"
              ? artifactSelection.editArtifactTargets
              : [],
            requestedArtifactKinds: ["prototype"],
          });
          return;
        }

        setProjectDraft(text);
      },
      projectComposer: {
        busy: submitting,
        canRefresh: runCanRetry,
        context: composerIntent ? {
          artifactTargets: composerIntent.artifactTargets,
          id: composerIntent.id,
          kind: composerIntent.kind,
          label: composerIntent.label,
        } : null,
        designPresetItems,
        designPresetStatus,
        disabled: !capabilities.canRun || submitting,
        focusRequest,
        model,
        modelCatalog,
        modelChoices: projectModelChoices,
        modelMenuOpen,
        editArtifactTargets: composerIntent?.workflow === "edit"
          ? composerIntent.artifactTargets
          : artifactSelection.editArtifactTargets,
        onClearContext: clearComposerIntent,
        onSelectModel: (choiceKey) => {
          selectModel(choiceKey);
        },
        onToggleModel: () => {
          toggleModelMenu();
          setProjectMenuOpen(false);
          setZoomMenuOpen(false);
        },
        onRefresh: onRetryRun,
        onRetryDesignPresets,
        onRetryModels,
        onSubmitPrompt: submitPromptWithCanvasSnapshot,
        onTargetSurfaceChange: changeTargetSurface,
        projectMode,
        projectDesignSystemChoices,
        projectId,
        prompt: projectDraft,
        runStatus,
        onPromptChange: (nextPrompt) => setProjectDraft(nextPrompt),
        targetSurface: selectedTargetSurface,
      },
      suggestionDisabled: !capabilities.canRun
        || modelCatalog.status !== "ready"
        || !projectModelChoices.some((choice) => choice.key === model),
      targetSurface: selectedTargetSurface,
      onTargetSurfaceChange: changeTargetSurface,
    },
    runPanels: {
      actionBusy: runActionBusy,
      actionError: runActionError,
      activities: runActivities,
      canCancel: capabilities.canRun && runCanCancel,
      canRetry: capabilities.canRun && runCanRetry,
      cancellationReason: runCancellationReason,
      failure: runFailure,
      generationProgress,
      generationStage,
      messages: runMessages,
      onCancel: () => {
        if (capabilities.canRun) void onCancelRun().catch(() => undefined);
      },
      onRetry: () => {
        if (capabilities.canRun) void onRetryRun().catch(() => undefined);
      },
      onSelectTask: (task) => setSelectedAgentTask((current) => current === task ? null : task),
      onSubmitApproval: onSubmitRunApproval,
      pendingApproval: runPendingApproval,
      prompt,
      runPhaseLabel,
      runStatus,
      selectedTask: selectedAgentTask,
      submissionError,
    },
  };

  return <ProjectScreenView controller={viewController} />;
}

function workbenchCanvasSelection(nodes: readonly WorkbenchNode[]): WorkbenchCanvasSelection {
  const references = nodes
    .map((node) => projectScreenArtifactReferenceFromNode(node))
    .filter((reference): reference is WorkbenchArtifactReference => reference !== null);
  return {
    artifact: nodes.length === 1 ? references[0] ?? null : null,
    hasSelection: nodes.length > 0,
    nodeIds: [...new Set(nodes.map((node) => node.id))].sort(compareIds),
  };
}

function artifactPreferenceTargetKey(
  principalCacheNamespace: string,
  reference: WorkbenchArtifactReference,
  screenId: string | null,
): string {
  return JSON.stringify([
    principalCacheNamespace,
    reference.projectId,
    reference.artifactId,
    reference.artifactVersionId,
    screenId,
  ]);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
