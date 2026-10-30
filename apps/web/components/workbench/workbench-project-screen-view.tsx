"use client";

import {
  Background,
  BackgroundVariant,
  type NodeChange,
  type OnSelectionChangeFunc,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  type Viewport,
} from "@xyflow/react";
import type {
  Run,
  RunApproval,
  RunGenerationStage,
  RunTargetSurface,
} from "@workbench/workbench-contracts";
import { AnimatePresence, motion } from "framer-motion";
import dynamic from "next/dynamic";
import { XIcon } from "lucide-react";
import type { ComponentProps, RefObject } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { BoardNodeActionAvailability } from "@/lib/workbench/features/board";
import type {
  WorkbenchCanvasPermissions,
  WorkbenchProjectCapabilities,
  WorkbenchProjectMode,
  WorkbenchProjectPhase,
  WorkbenchRunActivityItem,
  WorkbenchRunMessageItem,
  WorkbenchRunMotionKind,
} from "@/lib/workbench/features";
import { ProjectLoadStatus } from "@/lib/workbench/features/projects";
import {
  PrototypePatchProjectionProvider,
  type PrototypePatchProjectorStore,
} from "@/lib/workbench/features/prototype-patches";
import type { WorkbenchArtifactReference } from "./workbench-artifact-content";
import {
  WorkbenchArtifactPreferenceProvider,
  type WorkbenchArtifactPreferenceController,
} from "./workbench-artifact-preference-actions";
import { WorkbenchArtifactVersionDialog } from "./workbench-artifact-version-dialog";
import {
  artboardNodeTypes,
  WorkbenchBoardNodeProvider,
  type WorkbenchNode,
} from "./workbench-board-nodes";
import { WorkbenchCanvasMediaPanel } from "./workbench-canvas-media-panel";
import { WorkbenchCanvasFavouritesPanel } from "./workbench-canvas-favourites-panel";
import {
  WorkbenchCanvasDesignSystemPanel,
  type WorkbenchCanvasDesignSystemDraft,
} from "./workbench-canvas-design-system-panel";
import {
  BoardToolGestureLayer,
  RightToolRail,
  UtilityPill,
} from "./workbench-canvas-tools";
import type {
  CanvasInteractionMode,
  CanvasMainCommand,
  CanvasMoreCommand,
  CanvasPanel,
} from "@/lib/workbench/canvas-tools";
import {
  ProjectChromeVignette,
  ProjectStageMotionFX,
  ProjectSuggestionPills,
  ProjectTopBar,
  SelectedActionPill,
} from "./workbench-project-chrome";
import { ProjectComposer, type WorkbenchProjectComposerProps } from "./workbench-project-composer";
import { WorkbenchProjectMembersDialog } from "./workbench-project-members-dialog";
import { ProjectPreviewOverlay } from "./workbench-project-preview-overlay";
const WorkbenchGenerationPreview = dynamic(
  () => import("./workbench-generation-preview").then((module) => module.WorkbenchGenerationPreview),
  { ssr: false },
);
import {
  LeftInspector,
  MobileRunStatus,
  ProjectTranscriptPanel,
} from "./workbench-project-run-panels";
import { RenameProjectDialog } from "./workbench-rename-dialog";
import { useWorkbenchRouteEnterAnimation } from "./workbench-route-motion";
import {
  keepWorkbenchRouteMotionOnMainThread,
  viewTransition,
  workbenchEase,
} from "./workbench-motion";
import { WorkbenchRunApprovalDialog } from "./workbench-run-approval-dialog";
import { WorkbenchRunPreviewProvider } from "./workbench-run-preview";
import {
  WorkbenchScreenContextToolbar,
  type WorkbenchScreenContextToolbarProps,
} from "./workbench-screen-context-toolbar";

type ProjectMode = WorkbenchProjectMode;
type Phase = WorkbenchProjectPhase;
type ProjectComposerViewModel = Omit<WorkbenchProjectComposerProps, "setPrompt"> & {
  onPromptChange: WorkbenchProjectComposerProps["setPrompt"];
};

export type ProjectScreenViewContract = {
  root: {
    capabilities: WorkbenchProjectCapabilities;
    isGeneratedOverview: boolean;
    loadError: unknown;
    loadStatus: "error" | "loading" | "ready";
    onRetryProjectLoad: () => void;
    phase: Phase;
    projectId: string;
    projectMode: ProjectMode;
    projectStageClass: string;
    projectTitle: string;
    stageRef: RefObject<HTMLElement | null>;
    workspaceId: string;
  };
  canvas: {
    activeTool: CanvasInteractionMode;
    activePanel: CanvasPanel;
    activeRun: boolean;
    boardCanRedo: boolean;
    boardCanUndo: boolean;
    boardNodeBeingRenamed: WorkbenchNode | undefined;
    boardViewport: Viewport;
    directEditAvailable: boolean;
    canvasMedia: {
      busy: boolean;
      error: string | null;
      onClose: () => void;
      onInsert: ComponentProps<typeof WorkbenchCanvasMediaPanel>["onInsert"];
      progress: number | null;
    };
    canvasPermissions: WorkbenchCanvasPermissions;
    nodes: WorkbenchNode[];
    onCommitDrawing: ComponentProps<typeof BoardToolGestureLayer>["onCommitDrawing"];
    onCommitFrame: ComponentProps<typeof BoardToolGestureLayer>["onCommitFrame"];
    onConfirmDelete: () => void;
    onCopySelectedNodeLink: () => void;
    onDeleteDialogOpenChange: (open: boolean) => void;
    onDuplicateSelectedNodes: () => void;
    onMoveEnd: (event: MouseEvent | TouchEvent | null, viewport: Viewport) => void;
    onNodeClick: (event: React.MouseEvent, node: WorkbenchNode) => void;
    onNodeDoubleClick: (event: React.MouseEvent, node: WorkbenchNode) => void;
    onNodesChange: (changes: NodeChange<WorkbenchNode>[]) => void;
    onOpenVersions: () => void;
    onPaneClick: (event: React.MouseEvent) => void;
    onRedo: () => void;
    onFitSelection: () => void;
    onRenameNode: ComponentProps<typeof RenameProjectDialog>["onRename"];
    onRenameNodeClose: () => void;
    onRequestDeleteSelectedNodes: () => void;
    onRequestRenameSelectedNode: () => void;
    onResetView: () => void;
    onSelectTool: (tool: CanvasMainCommand) => void;
    onSelectMoreTool: (tool: CanvasMoreCommand) => void;
    onSelectFavourite: ComponentProps<typeof WorkbenchCanvasFavouritesPanel>["onSelect"];
    onSelectionChange: OnSelectionChangeFunc<WorkbenchNode>;
    onToggleSelectedActionMenu: () => void;
    onToggleZoomMenu: () => void;
    onUndo: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onZoomTo: (zoom: number) => void;
    pendingDeleteNodeCount: number;
    prototypeEditMode: boolean;
    prototypePatchProjector: PrototypePatchProjectorStore;
    selectedActionAvailability: BoardNodeActionAvailability;
    selectedActionOpen: boolean;
    selectedArtifactReference: WorkbenchArtifactReference | null;
    selectedBoardNodeCount: number;
    selectedGeneratedScreen: boolean;
    screenContextToolbar: WorkbenchScreenContextToolbarProps;
    zoomKeyActive: boolean;
    zoomLabel: string;
    zoomMenuOpen: boolean;
  };
  artifactEditing: {
    artifactPreferenceController: WorkbenchArtifactPreferenceController | null;
    onCloseDesignSystemPanel: () => void;
    onOpenVersionHistory: (reference: WorkbenchArtifactReference) => void;
    onPinArtifactVersion: ComponentProps<typeof WorkbenchArtifactVersionDialog>["onPinVersion"];
    onVersionHistoryOpenChange: (open: boolean) => void;
    prdEditor: ComponentProps<typeof WorkbenchBoardNodeProvider>["prdEditor"];
    prototypeEditor: ComponentProps<typeof WorkbenchBoardNodeProvider>["prototypeEditor"];
    designSystemDraft: WorkbenchCanvasDesignSystemDraft;
    designSystemPanelBusy: boolean;
    designSystemPanelError: string | null;
    designSystemPanelReadOnly: boolean;
    onDesignSystemChange: (draft: WorkbenchCanvasDesignSystemDraft) => void;
    versionHistoryReference: WorkbenchArtifactReference | null;
  };
  chrome: {
    archiveConfirmationOpen: boolean;
    archiveFailed: boolean;
    exportOpen: boolean;
    onArchiveConfirmationOpenChange: (open: boolean) => void;
    onBack: () => void;
    onClosePreview: () => void;
    onCloseReadyToast: () => void;
    onCloseRenameProject: () => void;
    onConfirmArchive: () => void;
    onDuplicateProject: () => void;
    onExport: () => void;
    onMembers: () => void;
    onMembersOpenChange: (open: boolean) => void;
    onOpenPreview: () => void;
    onRenameProject: ComponentProps<typeof RenameProjectDialog>["onRename"];
    onRequestArchive: () => void;
    onRequestRename: () => void;
    onShare: () => void;
    onToggleProjectMenu: () => void;
    previewArtifacts: ComponentProps<typeof ProjectPreviewOverlay>["artifacts"];
    previewCreate: ComponentProps<typeof ProjectPreviewOverlay>["createPreview"];
    previewInitialReference: WorkbenchArtifactReference | undefined;
    previewOpen: boolean;
    projectActionBusy: boolean;
    projectMembersOpen: boolean;
    projectMenuOpen: boolean;
    readyToastOpen: boolean;
    renameProjectOpen: boolean;
    shareOpen: boolean;
  };
  composer: {
    onSelectSuggestion: (text: string) => void;
    projectComposer: ProjectComposerViewModel;
    suggestionDisabled: boolean;
    targetSurface: RunTargetSurface;
    onTargetSurfaceChange: (surface: RunTargetSurface) => void;
  };
  runPanels: {
    finalArtifactReferences: WorkbenchArtifactReference[];
    generationPreviews?: import("@workbench/workbench-contracts").GenerationPreview[];
    actionBusy: boolean;
    actionError: unknown;
    activities: WorkbenchRunActivityItem[];
    canCancel: boolean;
    canRetry: boolean;
    cancellationReason: string | null;
    failure: Run["failure"];
    generationProgress: number;
    generationStage: RunGenerationStage | null;
    isPrdRun: boolean;
    messages: WorkbenchRunMessageItem[];
    motionKind: WorkbenchRunMotionKind;
    onCancel: () => void;
    onRetry: () => void;
    onSelectTask: (task: string) => void;
    onSubmitApproval: ComponentProps<typeof WorkbenchRunApprovalDialog>["onSubmit"];
    pendingApproval: RunApproval | null;
    prompt: string;
    runPhaseLabel: string | null;
    runId: string | null;
    runStatus: Run["status"] | null;
    selectedTask: string | null;
    submissionError: unknown;
  };
};

export function ProjectScreenView({
  controller: {
    root,
    canvas,
    artifactEditing,
    chrome,
    composer,
    runPanels,
  },
}: {
  controller: ProjectScreenViewContract;
}) {
  const routeAnimation = useWorkbenchRouteEnterAnimation("project");
  return (
    <motion.section
      animate={routeAnimation}
      className={root.projectStageClass}
      data-generation-stage={runPanels.generationStage ?? undefined}
      data-project-phase={root.phase}
      data-project-mode={root.projectMode}
      data-workbench-project
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      onUpdate={keepWorkbenchRouteMotionOnMainThread}
      ref={root.stageRef}
      transition={viewTransition}
    >
      <ProjectStageMotionFX
        generationStage={runPanels.generationStage}
        isOverview={root.isGeneratedOverview}
        motionKind={runPanels.motionKind}
        phase={root.phase}
      />
      <ProjectChromeVignette isOverview={root.isGeneratedOverview} />
      {(canvas.activeRun || (runPanels.runStatus === "succeeded" && runPanels.finalArtifactReferences.length > 0)) && (
        <WorkbenchGenerationPreview
          activities={runPanels.activities}
          canCancel={runPanels.canCancel}
          finalArtifactReferences={runPanels.finalArtifactReferences}
          generationStage={runPanels.generationStage}
          motionKind={runPanels.motionKind}
          onCancel={runPanels.onCancel}
          previews={runPanels.generationPreviews ?? []}
          previewTitle={root.projectTitle}
          runId={runPanels.runId}
          runStatus={runPanels.runStatus}
        />
      )}
      <ProjectTopBar
        capabilities={root.capabilities}
        exportOpen={chrome.exportOpen}
        onArchive={chrome.onRequestArchive}
        onBack={chrome.onBack}
        onDuplicate={chrome.onDuplicateProject}
        onMembers={chrome.onMembers}
        onExport={chrome.onExport}
        onPreview={chrome.onOpenPreview}
        onRename={chrome.onRequestRename}
        onShare={chrome.onShare}
        onToggleMenu={chrome.onToggleProjectMenu}
        projectTitle={root.projectTitle}
        projectMenuOpen={chrome.projectMenuOpen}
        shareOpen={chrome.shareOpen}
      />
      <LeftInspector
        actionBusy={runPanels.actionBusy}
        activities={runPanels.activities}
        canCancel={runPanels.canCancel}
        generationProgress={runPanels.generationProgress}
        generationStage={runPanels.generationStage}
        isPrdRun={runPanels.isPrdRun}
        isOverview={root.isGeneratedOverview}
        onCancel={runPanels.onCancel}
        onSelectTask={runPanels.onSelectTask}
        phase={root.phase}
        projectMode={root.projectMode}
        prompt={runPanels.prompt}
        runPhaseLabel={runPanels.runPhaseLabel}
        runStatus={runPanels.runStatus}
        selectedTask={runPanels.selectedTask}
        zoomLabel={canvas.zoomLabel}
      />
      <ProjectTranscriptPanel
        actionBusy={runPanels.actionBusy}
        activities={runPanels.activities}
        cancellationReason={runPanels.cancellationReason}
        failure={runPanels.failure}
        generationProgress={runPanels.generationProgress}
        generationStage={runPanels.generationStage}
        isPrdRun={runPanels.isPrdRun}
        isOverview={root.isGeneratedOverview}
        messages={runPanels.messages}
        phase={root.phase}
        projectMode={root.projectMode}
        canRetry={runPanels.canRetry}
        onRetry={runPanels.onRetry}
        prompt={runPanels.prompt}
        runPhaseLabel={runPanels.runPhaseLabel}
        runStatus={runPanels.runStatus}
        selectedTask={runPanels.selectedTask}
        submissionError={runPanels.submissionError}
      />
      <MobileRunStatus
        busy={runPanels.actionBusy}
        canCancel={runPanels.canCancel}
        canRetry={runPanels.canRetry}
        failure={runPanels.failure}
        generationStage={runPanels.generationStage}
        isPrdRun={runPanels.isPrdRun}
        onCancel={runPanels.onCancel}
        onRetry={runPanels.onRetry}
        prompt={runPanels.prompt}
        runPhaseLabel={runPanels.runPhaseLabel}
        runStatus={runPanels.runStatus}
      />
      <SelectedActionPill
        activeRun={canvas.activeRun}
        availability={canvas.selectedActionAvailability}
        canOpenVersions={Boolean(canvas.selectedArtifactReference)}
        menuOpen={canvas.selectedActionOpen}
        onCopyLink={canvas.onCopySelectedNodeLink}
        onDelete={canvas.onRequestDeleteSelectedNodes}
        onDuplicate={canvas.onDuplicateSelectedNodes}
        onRename={canvas.onRequestRenameSelectedNode}
        onOpenVersions={canvas.onOpenVersions}
        open={canvas.selectedBoardNodeCount === 1
          && !canvas.selectedGeneratedScreen
          && root.projectMode !== "generated"}
        onToggleMenu={canvas.onToggleSelectedActionMenu}
      />
      <RightToolRail
        activeTool={canvas.activeTool}
        activePanel={canvas.activePanel}
        activeRun={canvas.activeRun}
        directEditAvailable={canvas.directEditAvailable}
        editable={root.capabilities.canEdit}
        onSelectTool={canvas.onSelectTool}
        onSelectMoreTool={canvas.onSelectMoreTool}
      />
      <AnimatePresence>
        {canvas.activePanel === "media" && (
          <WorkbenchCanvasMediaPanel
            busy={canvas.canvasMedia.busy}
            error={canvas.canvasMedia.error}
            onClose={canvas.canvasMedia.onClose}
            onInsert={canvas.canvasMedia.onInsert}
            progress={canvas.canvasMedia.progress}
            projectId={root.projectId}
          />
        )}
        {canvas.activePanel === "design-system" && (
          <WorkbenchCanvasDesignSystemPanel
            busy={artifactEditing.designSystemPanelBusy}
            draft={artifactEditing.designSystemDraft}
            error={artifactEditing.designSystemPanelError}
            onChange={artifactEditing.onDesignSystemChange}
            onClose={artifactEditing.onCloseDesignSystemPanel}
            readOnly={artifactEditing.designSystemPanelReadOnly}
          />
        )}
        {canvas.activePanel === "favourites" && (
          <WorkbenchCanvasFavouritesPanel
            onClose={() => canvas.onSelectTool("favourites")}
            onSelect={canvas.onSelectFavourite}
            projectId={root.projectId}
          />
        )}
      </AnimatePresence>
      <div className="workbench-canvas-layer absolute inset-0">
        <PrototypePatchProjectionProvider projector={canvas.prototypePatchProjector}>
        <WorkbenchBoardNodeProvider
          artifactVersions={{ onOpen: artifactEditing.onOpenVersionHistory }}
          canResizeNodes={canvas.canvasPermissions.canResizeNodes && !canvas.prototypeEditMode}
          overlay={(
            <BoardToolGestureLayer
              activeTool={canvas.activeTool}
              enabled={root.capabilities.canEdit && root.loadStatus === "ready"}
              onCommitDrawing={canvas.onCommitDrawing}
              onCommitFrame={canvas.onCommitFrame}
            />
          )}
          prdEditor={artifactEditing.prdEditor}
          prototypeEditor={artifactEditing.prototypeEditor}
          screenContextToolbarReplacesTitle={canvas.screenContextToolbar.model?.kind === "single"}
        >
        <WorkbenchArtifactPreferenceProvider controller={artifactEditing.artifactPreferenceController}>
        <WorkbenchRunPreviewProvider
          phase={root.phase}
          projectTitle={root.projectTitle}
          prompt={runPanels.prompt}
          runActivities={runPanels.activities}
          runMessages={runPanels.messages}
          runPhaseLabel={runPanels.runPhaseLabel}
          runStatus={runPanels.runStatus}
        >
        <ReactFlow
          aria-label="画布：拖拽节点移动，空白处拖拽框选；空格、中键或右键拖拽平移；按住 Command 或 Control 滚轮缩放"
          className={cn(
            "workbench-flow h-full w-full",
            canvas.activeTool === "pan" && "cursor-grab active:cursor-grabbing",
            canvas.activeTool === "select" && "cursor-default",
            (canvas.activeTool === "freehand" || canvas.activeTool === "frame-create") && "cursor-crosshair",
            canvas.activePanel !== null && "cursor-cell",
            canvas.zoomKeyActive && "!cursor-zoom-in",
          )}
          colorMode="dark"
          defaultViewport={canvas.boardViewport}
          deleteKeyCode={null}
          elementsSelectable={canvas.canvasPermissions.canSelectNodes && canvas.activeTool !== "pan"}
          fitView={false}
          key={root.projectMode}
          maxZoom={1.25}
          minZoom={0.04}
          nodeTypes={artboardNodeTypes}
          nodes={canvas.nodes}
          nodesDraggable={canvas.canvasPermissions.canDragNodes && canvas.activeTool === "select" && !canvas.prototypeEditMode}
          onMoveEnd={canvas.onMoveEnd}
          onNodeClick={canvas.onNodeClick}
          onNodeDoubleClick={canvas.onNodeDoubleClick}
          onNodesChange={canvas.onNodesChange}
          onSelectionChange={canvas.onSelectionChange}
          onPaneClick={canvas.onPaneClick}
          onPaneContextMenu={(event) => event.preventDefault()}
          panOnDrag={canvas.activeTool === "pan" ? [0, 1, 2] : [1, 2]}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          panOnScrollSpeed={0.8}
          panActivationKeyCode="Space"
          selectionKeyCode={null}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          selectionOnDrag={!canvas.prototypeEditMode
            && (canvas.activeTool === "select" || canvas.activeTool === "marquee")}
          zoomActivationKeyCode={["Meta", "Control", "z"]}
          zoomOnPinch
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
        >
          <Background
            bgColor="var(--workbench-bg)"
            id="workbench-grid-base"
            color={root.projectMode === "generated"
              ? canvas.zoomLabel === "10%" ? "#4b4e54" : "#44474d"
              : "#303238"}
            gap={root.projectMode === "generated" && canvas.zoomLabel === "10%" ? 13 : 14}
            size={root.projectMode === "generated" && canvas.zoomLabel === "10%" ? 1.22 : root.projectMode === "generated" ? 1.08 : 1}
            variant={BackgroundVariant.Dots}
          />
          <Background
            bgColor="var(--workbench-bg)"
            className="workbench-pointer-background"
            color="#d7dce2"
            gap={root.projectMode === "generated" && canvas.zoomLabel === "10%" ? 13 : 14}
            id="workbench-grid-pointer"
            size={root.projectMode === "generated" && canvas.zoomLabel === "10%" ? 1.46 : root.projectMode === "generated" ? 1.34 : 1.28}
            variant={BackgroundVariant.Dots}
          />
          <WorkbenchScreenContextToolbar {...canvas.screenContextToolbar} />
        </ReactFlow>
        </WorkbenchRunPreviewProvider>
        </WorkbenchArtifactPreferenceProvider>
        </WorkbenchBoardNodeProvider>
        </PrototypePatchProjectionProvider>
      </div>
      <ProjectLoadStatus
        error={root.loadError}
        onRetry={root.onRetryProjectLoad}
        status={root.loadStatus}
      />
      <WorkbenchArtifactVersionDialog
        canFinalize={root.capabilities.canManageMembers && !canvas.activeRun}
        canPin={root.capabilities.canEdit && !canvas.activeRun}
        onOpenChange={artifactEditing.onVersionHistoryOpenChange}
        onPinVersion={artifactEditing.onPinArtifactVersion}
        open={Boolean(artifactEditing.versionHistoryReference)}
        reference={artifactEditing.versionHistoryReference}
      />
      <ProjectSuggestionPills
        disabled={composer.suggestionDisabled}
        phase={root.phase}
        projectMode={root.projectMode}
        onSelect={composer.onSelectSuggestion}
        zoomKeyActive={canvas.zoomKeyActive}
        zoomLabel={canvas.zoomLabel}
      />
      <ProjectComposer
        busy={composer.projectComposer.busy}
        canRefresh={composer.projectComposer.canRefresh}
        context={composer.projectComposer.context}
        designPresetItems={composer.projectComposer.designPresetItems}
        designPresetStatus={composer.projectComposer.designPresetStatus}
        disabled={composer.projectComposer.disabled}
        model={composer.projectComposer.model}
        modelCatalog={composer.projectComposer.modelCatalog}
        modelChoices={composer.projectComposer.modelChoices}
        modelMenuOpen={composer.projectComposer.modelMenuOpen}
        editArtifactTargets={composer.projectComposer.editArtifactTargets}
        focusRequest={composer.projectComposer.focusRequest}
        onClearContext={composer.projectComposer.onClearContext}
        onCloseModel={composer.projectComposer.onCloseModel}
        onSelectModel={composer.projectComposer.onSelectModel}
        onToggleModel={composer.projectComposer.onToggleModel}
        onRefresh={composer.projectComposer.onRefresh}
        onRetryDesignPresets={composer.projectComposer.onRetryDesignPresets}
        onRetryModels={composer.projectComposer.onRetryModels}
        onSubmitPrompt={composer.projectComposer.onSubmitPrompt}
        onTargetSurfaceChange={composer.projectComposer.onTargetSurfaceChange}
        projectMode={composer.projectComposer.projectMode}
        projectDesignSystemChoices={composer.projectComposer.projectDesignSystemChoices}
        projectId={composer.projectComposer.projectId}
        prompt={composer.projectComposer.prompt}
        runStatus={composer.projectComposer.runStatus}
        setPrompt={composer.projectComposer.onPromptChange}
        targetSurface={composer.projectComposer.targetSurface}
      />
      <UtilityPill
        canRedo={canvas.boardCanRedo}
        canUndo={canvas.boardCanUndo}
        onFitSelection={canvas.onFitSelection}
        onRedo={canvas.onRedo}
        onResetView={canvas.onResetView}
        onToggleZoomMenu={canvas.onToggleZoomMenu}
        onUndo={canvas.onUndo}
        onZoomIn={canvas.onZoomIn}
        onZoomOut={canvas.onZoomOut}
        onZoomTo={canvas.onZoomTo}
        zoomMenuOpen={canvas.zoomMenuOpen}
        zoomLabel={canvas.zoomLabel}
      />
      <AnimatePresence>
        {root.projectMode === "generated" && root.phase === "complete" && canvas.zoomLabel !== "10%" && chrome.readyToastOpen && (
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="absolute bottom-[76px] right-[76px] z-40 flex h-[46px] w-[238px] max-w-[calc(100vw-32px)] items-center gap-[7px] rounded-[14px] border border-white/[0.08] bg-[#242528]/92 px-[13px] text-[13px] font-medium text-[#f1f3f4] shadow-[0_20px_70px_-34px_rgba(0,0,0,0.95)] backdrop-blur-xl max-md:bottom-[128px] max-md:right-[16px]"
            exit={{ opacity: 0, y: 8 }}
            initial={{ opacity: 0, scale: 0.94, y: 14 }}
            transition={{ duration: 0.42, ease: workbenchEase }}
          >
            <motion.span
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              className="grid size-[20px] place-items-center rounded-full bg-[#d8dce2] text-[13px] font-semibold text-[#202124]"
              initial={{ opacity: 0, rotate: -18, scale: 0.5 }}
              transition={{ duration: 0.34, delay: 0.16, ease: workbenchEase }}
            >
              i
            </motion.span>
            <span className="min-w-0 flex-1 truncate">New screens are ready</span>
            <button
              aria-label="关闭通知"
              className="grid size-[20px] place-items-center rounded-full text-[#c7cad0] hover:bg-white/[0.06] hover:text-[#f1f3f4]"
              onClick={chrome.onCloseReadyToast}
              type="button"
            >
              <XIcon className="size-[15px]" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {root.capabilities.canRun && runPanels.pendingApproval && (
          <WorkbenchRunApprovalDialog
            approval={runPanels.pendingApproval}
            busy={runPanels.actionBusy}
            error={runPanels.actionError}
            onSubmit={runPanels.onSubmitApproval}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {chrome.renameProjectOpen && (
          <RenameProjectDialog
            currentTitle={root.projectTitle}
            onClose={chrome.onCloseRenameProject}
            onRename={chrome.onRenameProject}
          />
        )}
      </AnimatePresence>
      {chrome.projectMembersOpen && (
        <WorkbenchProjectMembersDialog
          canManageMembers={root.capabilities.canManageMembers}
          onOpenChange={chrome.onMembersOpenChange}
          open
          projectId={root.projectId}
          projectTitle={root.projectTitle}
          workspaceId={root.workspaceId}
        />
      )}
      <AnimatePresence>
        {canvas.boardNodeBeingRenamed && (
          <RenameProjectDialog
            currentTitle={typeof canvas.boardNodeBeingRenamed.data.title === "string"
              ? canvas.boardNodeBeingRenamed.data.title
              : "Untitled artifact"}
            dialogLabel="重命名所选内容"
            failureMessage="重命名失败，请重试"
            heading="重命名所选内容"
            onClose={canvas.onRenameNodeClose}
            onRename={canvas.onRenameNode}
          />
        )}
      </AnimatePresence>
      <AlertDialog
        onOpenChange={canvas.onDeleteDialogOpenChange}
        open={canvas.pendingDeleteNodeCount > 0}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除所选内容？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除 {canvas.pendingDeleteNodeCount} 个画布节点及其全部连接。此操作可通过撤销恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!root.capabilities.canEdit || canvas.activeRun}
              onClick={(event) => {
                event.preventDefault();
                canvas.onConfirmDelete();
              }}
              variant="destructive"
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        onOpenChange={chrome.onArchiveConfirmationOpenChange}
        open={chrome.archiveConfirmationOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个项目？</AlertDialogTitle>
            <AlertDialogDescription>
              项目将被归档，现有共享链接会立即失效。{chrome.archiveFailed ? " 删除失败，请重试。" : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={chrome.projectActionBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!root.capabilities.canArchive || chrome.projectActionBusy}
              onClick={(event) => {
                event.preventDefault();
                chrome.onConfirmArchive();
              }}
              variant="destructive"
            >
              {chrome.projectActionBusy ? "删除中..." : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AnimatePresence>
        {chrome.previewOpen && (
          <ProjectPreviewOverlay
            artifacts={chrome.previewArtifacts}
            createPreview={chrome.previewCreate}
            initialReference={chrome.previewInitialReference}
            key={chrome.previewInitialReference
              ? `${chrome.previewInitialReference.artifactId}:${chrome.previewInitialReference.artifactVersionId}:${chrome.previewInitialReference.screenId ?? ""}`
              : "project-preview"}
            onClose={chrome.onClosePreview}
            projectId={root.projectId}
            projectTitle={root.projectTitle}
          />
        )}
      </AnimatePresence>
    </motion.section>
  );
}
