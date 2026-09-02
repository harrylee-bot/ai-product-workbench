"use client";

import type {
  DesignPresetCatalogItem,
  Run,
  RunArtifactTarget,
  RunTargetSurface,
} from "@workbench/workbench-contracts";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpIcon,
  FileTextIcon,
  Link2Icon,
  PanelsTopLeftIcon,
  PaletteIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import {
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "@/lib/workbench/project-session";

import { cn } from "@/lib/utils";
import {
  useWorkbenchComposerAttachments,
  workbenchScreenCaptureErrorMessage,
} from "@/lib/workbench/files/composer-attachments";
import {
  importSourceLabel,
  isReadyImportSource,
  useWorkbenchImportSources,
} from "@/lib/workbench/features/import-sources";
import {
  isValidEditArtifactTargets,
  requestedArtifactKindsForPrompt,
  workbenchRunIsActive,
} from "@/lib/workbench/run";
import type {
  WorkbenchModelCatalogState,
  WorkbenchModelChoice,
  WorkbenchProjectDesignSystemChoice,
  WorkbenchProjectMode,
  WorkbenchRunSubmission,
} from "@/lib/workbench/features";
import {
  automaticDesignStyleSelection,
  CustomDesignSystemDialog,
  designStyleSelectionFromCustom,
  ProjectDesignSystemMenu,
  type WorkbenchDesignStyleSelection,
} from "./workbench-design-system-controls";
import {
  ComposerAttachmentMenu,
  ComposerArtifactOutputMenu,
  ComposerCommandMenu,
} from "./workbench-composer-menus";
import type { WorkbenchArtifactOutputKind } from "./workbench-composer-menus";
import { viewTransition } from "./workbench-motion";
import { WorkbenchImportSourcesDialog } from "./workbench-import-sources-dialog";

type WorkbenchRunSubmitHandler = (
  submission: WorkbenchRunSubmission,
) => Promise<string | null>;

export type WorkbenchProjectComposerContext = {
  artifactTargets: RunArtifactTarget[];
  id: string;
  kind: "agent-edit" | "generate-followup" | "generate-prototype" | "generate-variants";
  label: string;
};

export type WorkbenchProjectComposerProps = {
  busy: boolean;
  canRefresh: boolean;
  context?: WorkbenchProjectComposerContext | null;
  disabled: boolean;
  editArtifactTargets: RunArtifactTarget[];
  focusRequest?: number;
  model: string;
  modelCatalog: WorkbenchModelCatalogState;
  modelChoices: WorkbenchModelChoice[];
  modelMenuOpen: boolean;
  onSelectModel: (model: string) => void;
  onCloseModel?: () => void;
  onRefresh: () => Promise<unknown>;
  onClearContext?: () => void;
  onRetryDesignPresets: () => void;
  onRetryModels: () => void;
  onTargetSurfaceChange: (surface: RunTargetSurface) => void;
  onToggleModel: () => void;
  onSubmitPrompt: WorkbenchRunSubmitHandler;
  projectMode: WorkbenchProjectMode;
  designPresetItems: DesignPresetCatalogItem[];
  designPresetStatus: "error" | "loading" | "ready";
  projectDesignSystemChoices: WorkbenchProjectDesignSystemChoice[];
  projectId: string;
  prompt: string;
  runStatus: Run["status"] | null;
  setPrompt: (prompt: string) => void;
  targetSurface: RunTargetSurface;
};

export function ProjectComposer({
  busy,
  canRefresh,
  context = null,
  disabled,
  editArtifactTargets,
  focusRequest = 0,
  model,
  modelCatalog,
  modelChoices,
  modelMenuOpen,
  onSelectModel,
  onCloseModel,
  onRefresh,
  onClearContext,
  onRetryDesignPresets,
  onRetryModels: _onRetryModels,
  onToggleModel,
  onSubmitPrompt,
  designPresetItems,
  designPresetStatus,
  projectMode,
  projectDesignSystemChoices,
  projectId,
  prompt,
  runStatus,
  setPrompt,
  targetSurface,
}: WorkbenchProjectComposerProps) {
  const session = useWorkbenchProjectSession(projectId);
  const [documentContextEnabled, setDocumentContextEnabled] = useWorkbenchProjectState(
    session,
    () => projectMode === "document",
  );
  const hasDocumentChip = projectMode === "document" && documentContextEnabled;
  const displayedPrompt = prompt;
  const [composerFocused, setComposerFocused] = useWorkbenchProjectState(session, () => false);
  const [composerPanel, setComposerPanel] = useWorkbenchProjectState<"commands" | "attachments" | "style" | null>(
    session,
    () => null,
  );
  const [selectedStyle, setSelectedStyle] = useWorkbenchProjectState<WorkbenchDesignStyleSelection>(
    session,
    () => automaticDesignStyleSelection,
  );
  const [outputKind, setOutputKind] = useWorkbenchProjectState<WorkbenchArtifactOutputKind | null>(session, () => null);
  const [customDesignOpen, setCustomDesignOpen] = useWorkbenchProjectState(session, () => false);
  const [importSourcesOpen, setImportSourcesOpen] = useWorkbenchProjectState(session, () => false);
  const [selectedSourceIds, setSelectedSourceIds] = useWorkbenchProjectState<string[]>(session, () => []);
  const promptInputRef = useRef<HTMLInputElement | null>(null);
  const attachments = useWorkbenchComposerAttachments(projectId);
  const importSourcesQuery = useWorkbenchImportSources(projectId);
  const selectedFiles = attachments.selectedFiles;
  const selectedSourcesReady = selectedSourceIds.length === 0 || (
    importSourcesQuery.isSuccess
    && selectedSourceIds.every((sourceId) => (
      importSourcesQuery.data.items.some((source) => (
        source.id === sourceId && isReadyImportSource(source)
      ))
    ))
  );
  const selectedModel = modelChoices.find((choice) => choice.key === model);
  const targetedGenerate = context?.kind === "generate-followup"
    || context?.kind === "generate-prototype";
  const targetedGenerateArtifactTargets = targetedGenerate
    ? context?.artifactTargets ?? []
    : [];
  const targetedGenerateTargetsValid = !targetedGenerate || (
    selectedModel?.workflow === "generate"
    && isValidEditArtifactTargets(targetedGenerateArtifactTargets)
    && targetedGenerateArtifactTargets.every((target) => target.screenIds.length > 0)
  );
  const runIsActive = workbenchRunIsActive(runStatus);
  const isBusy = busy || attachments.screenCaptureBusy || runIsActive;
  const composerActive = isBusy
    || composerFocused
    || modelMenuOpen
    || composerPanel !== null
    || displayedPrompt.trim().length > 0
    || context !== null;
  const canSubmit = !disabled
    && !isBusy
    && modelCatalog.status === "ready"
    && Boolean(selectedModel)
    && (displayedPrompt.trim().length > 0 || hasDocumentChip)
    && selectedSourcesReady
    && (selectedModel?.workflow !== "redesign" || selectedFiles.length > 0 || selectedSourceIds.length > 0)
    && (selectedModel?.workflow !== "edit" || isValidEditArtifactTargets(editArtifactTargets))
    && targetedGenerateTargetsValid;
  const submitComposer = async () => {
    if (!canSubmit || !selectedModel || modelCatalog.status !== "ready") return;
    const nextPrompt = displayedPrompt.trim() || "基于此 PRD 生成 UI 界面设计";
    const accepted = await onSubmitPrompt({
      prompt: nextPrompt,
      modelChoiceKey: selectedModel.key,
      targetSurface,
      designStyle: selectedStyle.designStyle,
      designSystemProvision: selectedStyle.provision,
      files: selectedFiles,
      generationIntent: context?.kind === "generate-followup"
        ? "followup-design"
        : context?.kind === "generate-prototype"
          ? "interactive-prototype"
          : null,
      artifactTargets: selectedModel.workflow === "edit"
        ? editArtifactTargets
        : targetedGenerateArtifactTargets,
      requestedArtifactKinds: targetedGenerate
        ? ["prototype"]
        : outputKind ? [outputKind] : requestedArtifactKindsForPrompt(nextPrompt, {
            prdContext: hasDocumentChip,
          }),
      sourceIds: selectedSourceIds,
    });
    if (!accepted || !session.isCurrent()) return;
    attachments.clearFiles();
    setSelectedSourceIds([]);
    setImportSourcesOpen(false);
    onClearContext?.();
    setPrompt("");
  };

  useEffect(() => {
    if (modelMenuOpen) setComposerPanel(null);
  }, [modelMenuOpen, setComposerPanel]);

  useEffect(() => {
    if (focusRequest <= 0 || disabled) return;
    promptInputRef.current?.focus({ preventScroll: true });
  }, [disabled, focusRequest]);

  useEffect(() => {
    if (disabled) setComposerPanel(null);
  }, [disabled, setComposerPanel]);

  useEffect(() => {
    setSelectedStyle(automaticDesignStyleSelection);
    setCustomDesignOpen(false);
  }, [projectId, setCustomDesignOpen, setSelectedStyle]);

  useEffect(() => {
    if (designPresetStatus !== "ready" || selectedStyle.designStyle.kind !== "preset") return;
    const selectedPreset = selectedStyle.designStyle;
    const stillAvailable = designPresetItems.some((item) => (
      item.presetId === selectedPreset.presetId
      && item.version === selectedPreset.version
      && item.checksum === selectedPreset.checksum
    ));
    if (!stillAvailable) setSelectedStyle(automaticDesignStyleSelection);
  }, [designPresetItems, designPresetStatus, selectedStyle.designStyle, setSelectedStyle]);

  useEffect(() => {
    setDocumentContextEnabled(projectMode === "document");
  }, [projectId, projectMode, setDocumentContextEnabled]);

  useEffect(() => {
    const closeComposerPanels = (event: KeyboardEvent) => {
      if (event.key === "Escape") setComposerPanel(null);
    };
    window.addEventListener("keydown", closeComposerPanels);
    return () => window.removeEventListener("keydown", closeComposerPanels);
  }, [setComposerPanel]);

  useEffect(() => {
    const closeComposerPanelsOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element
        && (target.closest('[role="menu"]') || target.closest('[aria-haspopup="menu"]'))
      ) {
        return;
      }
      setComposerPanel(null);
      if (modelMenuOpen) onCloseModel?.();
    };
    window.addEventListener("mousedown", closeComposerPanelsOnOutsidePointer, true);
    return () => window.removeEventListener("mousedown", closeComposerPanelsOnOutsidePointer, true);
  }, [modelMenuOpen, onCloseModel, setComposerPanel]);

  const toggleComposerPanel = (panel: "commands" | "attachments" | "style") => {
    setComposerPanel((currentPanel) => currentPanel === panel ? null : panel);
  };

  return (
    <motion.div
      animate={{
        opacity: 1,
        x: "-50%",
        y: 0,
      }}
      className={cn(
        "absolute bottom-[16px] left-1/2 z-40 transition-[width]",
        "w-[580px] max-w-[calc(100vw-32px)]",
      )}
      data-project-composer
      initial={{ opacity: 0, x: "-50%", y: 14 }}
      transition={{ ...viewTransition, delay: 0.18 }}
    >
      <div
        className={cn(
          "workbench-composer-shell workbench-composer-shell--project rounded-[18px] border bg-[#18191b]/84 px-[18px] py-[10px] shadow-[0_22px_84px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl transition-colors",
          composerActive ? "border-white/[0.15] bg-[#1b1c1f]/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_28px_94px_-42px_rgba(0,0,0,0.98)]" : "border-white/[0.10]",
        )}
        data-active={composerActive ? "true" : undefined}
        data-busy={isBusy ? "true" : undefined}
        data-typing={displayedPrompt.trim().length > 0 ? "true" : undefined}
      >
        {(context || hasDocumentChip || selectedFiles[0] || selectedSourceIds.length > 0) && (
          <div className="mb-[14px] flex max-w-full flex-wrap gap-[8px]">
            {context && (
              <button
                aria-label={`移除选择上下文 ${context.label}`}
                className="flex h-[32px] max-w-[280px] items-center gap-[8px] rounded-full border border-[#7467f6]/35 bg-[#29263a]/92 px-[11px] text-[12px] font-medium text-[#e3e0ff]"
                data-composer-context={context.kind}
                disabled={disabled}
                onClick={onClearContext}
                type="button"
              >
                <PanelsTopLeftIcon className="size-[14px] shrink-0" />
                <span className="min-w-0 flex-1 truncate">{context.label}</span>
                <XIcon className="size-[13px] shrink-0 text-[#bbb5e8]" />
              </button>
            )}
            {(hasDocumentChip || selectedFiles[0]) && (
              <button
                aria-label={selectedFiles[0]
                  ? `移除附件 ${selectedFiles[0].name}`
                  : "移除当前需求文档上下文"}
                className="flex h-[32px] max-w-[230px] items-center gap-[8px] rounded-full border border-white/[0.12] bg-[#2b2d31]/92 px-[11px] text-[12px] font-medium text-[#d8dce2]"
                disabled={disabled}
                onClick={() => {
                  if (selectedFiles.length > 0) {
                    attachments.removeFirstFile();
                  } else {
                    setDocumentContextEnabled(false);
                  }
                }}
                type="button"
              >
                {selectedFiles[0] ? <PaperclipIcon className="size-[14px] shrink-0" /> : <FileTextIcon className="size-[14px] shrink-0" />}
                <span className="min-w-0 flex-1 truncate">
                  {selectedFiles[0]?.name ?? "当前需求文档"}
                </span>
                <XIcon className="size-[14px] shrink-0 text-[#b8bcc4]" />
              </button>
            )}
            {selectedSourceIds.map((sourceId) => {
              const source = importSourcesQuery.data?.items.find((item) => item.id === sourceId);
              if (!source) return null;
              return (
                <button
                  aria-label={`移除来源 ${importSourceLabel(source)}`}
                  className="flex h-[32px] max-w-[250px] items-center gap-[8px] rounded-full border border-[#8e86ff]/30 bg-[#29263a]/92 px-[11px] text-[12px] font-medium text-[#e3e0ff]"
                  disabled={disabled}
                  key={source.id}
                  onClick={() => setSelectedSourceIds((current) => current.filter((id) => id !== source.id))}
                  type="button"
                >
                  <Link2Icon className="size-[14px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{importSourceLabel(source)}</span>
                  <span className="text-[10px] text-[#b8b1ea]">{isReadyImportSource(source) ? "可用" : "处理中"}</span>
                  <XIcon className="size-[13px] shrink-0 text-[#bbb5e8]" />
                </button>
              );
            })}
          </div>
        )}
        <input
          className="workbench-composer-field mb-[14px] h-[24px] w-full border-none bg-transparent text-[15px] outline-none placeholder:text-[#8d9299]"
          disabled={disabled}
          onBlur={() => setComposerFocused(false)}
          onChange={(event) => setPrompt(event.target.value)}
          onFocus={() => setComposerFocused(true)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submitComposer();
          }}
          placeholder="您想更改或创建什么内容?"
          ref={promptInputRef}
          value={displayedPrompt}
        />
        <input
          className="hidden"
          disabled={disabled}
          multiple
          onChange={(event) => {
            attachments.selectFiles(event.target.files);
            event.target.value = "";
          }}
          ref={attachments.fileInputRef}
          type="file"
        />
        <div
          className="flex h-[36px] items-center gap-[14px] text-[#d7d9de] max-sm:gap-[4px]"
          data-project-composer-toolbar
        >
          <button
            className="workbench-composer-tool grid size-[32px] place-items-center rounded-full hover:bg-white/[0.06]"
            disabled={disabled}
            onClick={() => void attachments.openAttachment("file")}
            type="button"
          >
            <PlusIcon className="size-[19px]" />
          </button>
          <button
            aria-expanded={composerPanel === "commands"}
            aria-haspopup="menu"
            aria-label="命令"
            className={cn(
              "workbench-composer-tool grid size-[32px] place-items-center rounded-full text-[22px] hover:bg-white/[0.06]",
              composerPanel === "commands" && "bg-white/[0.08] text-[#f1f3f4]",
            )}
            disabled={disabled}
            onClick={() => toggleComposerPanel("commands")}
            type="button"
          >
            /
          </button>
          <div className="flex-1" />
          <button
            aria-expanded={composerPanel === "attachments"}
            aria-haspopup="menu"
            aria-label="添加附件"
            className={cn(
              "workbench-composer-tool grid size-[32px] place-items-center rounded-full hover:bg-white/[0.06]",
              composerPanel === "attachments" && "bg-white/[0.08] text-[#f1f3f4]",
            )}
            disabled={disabled}
            onClick={() => toggleComposerPanel("attachments")}
            type="button"
          >
            <PaperclipIcon className="size-[17px]" />
          </button>
          <button
            aria-expanded={composerPanel === "style"}
            aria-haspopup="menu"
            aria-label="样式"
            className={cn(
              "workbench-composer-tool grid size-[32px] place-items-center rounded-full hover:bg-white/[0.06]",
              composerPanel === "style" && "bg-white/[0.08] text-[#f1f3f4]",
            )}
            disabled={disabled}
            onClick={() => toggleComposerPanel("style")}
            type="button"
          >
            <PaletteIcon className="size-[17px]" />
          </button>
          <button
            aria-expanded={modelMenuOpen}
            aria-haspopup="menu"
            aria-label="选择生成类型"
            className="workbench-composer-model flex h-[34px] shrink-0 items-center gap-[7px] rounded-full bg-[#2b2c30]/95 px-[14px] text-[13px] font-semibold text-[#f1f3f4] max-sm:px-[10px]"
            disabled={disabled || modelCatalog.status !== "ready"}
            onClick={() => {
              setComposerPanel(null);
              onToggleModel();
            }}
            type="button"
          >
            <FileTextIcon className="size-[15px]" />
            {outputKind === "prd" ? "生成文档" : outputKind === "prototype" ? "生成原型" : "生成类型"}
          </button>
          <AnimatePresence>
            {modelCatalog.status === "ready" && modelMenuOpen && (
              <ComposerArtifactOutputMenu
                kind={outputKind}
                onSelect={(kind) => {
                  const generateChoice = modelChoices.find((choice) => (
                    choice.workflow === "generate" && choice.modelId === selectedModel?.modelId
                  )) ?? modelChoices.find((choice) => choice.workflow === "generate");
                  if (generateChoice && generateChoice.key !== model) {
                    onSelectModel(generateChoice.key);
                  }
                  setOutputKind(kind);
                  (onCloseModel ?? onToggleModel)();
                }}
              />
            )}
          </AnimatePresence>
          <button
            aria-label="重试上一次生成"
            className="workbench-composer-tool grid size-[32px] place-items-center rounded-full hover:bg-white/[0.06]"
            disabled={disabled || isBusy || !canRefresh}
            onClick={() => void onRefresh().catch(() => undefined)}
            title={canRefresh ? "重试上一次生成" : "当前没有可重试的生成"}
            type="button"
          >
            <RefreshCwIcon className="size-[17px]" />
          </button>
          <button
            aria-label="提交项目请求"
            className={cn(
              "workbench-composer-send grid size-[34px] place-items-center rounded-full text-[#6f747c] hover:bg-white/[0.06]",
              canSubmit && "is-ready",
              isBusy && "is-busy",
            )}
            disabled={!canSubmit}
            onClick={submitComposer}
            type="button"
          >
            {isBusy ? <span className="size-[15px] animate-spin rounded-full border-2 border-white border-t-transparent" /> : <ArrowUpIcon className="size-[18px]" />}
          </button>
        </div>
      </div>
      <AnimatePresence>
        {composerPanel === "commands" && (
          <ComposerCommandMenu
            onSelect={(value) => {
              setPrompt(value);
              setComposerPanel(null);
            }}
          />
        )}
            {composerPanel === "attachments" && (
          <ComposerAttachmentMenu
            onSelect={(kind) => {
              setComposerPanel(null);
              if (kind === "source") {
                setImportSourcesOpen(true);
                return;
              }
              void attachments.openAttachment(kind).catch((error) => {
                toast.error(workbenchScreenCaptureErrorMessage(error));
              });
            }}
          />
        )}
        {composerPanel === "style" && (
          <ProjectDesignSystemMenu
            onCreateCustom={() => {
              setComposerPanel(null);
              setCustomDesignOpen(true);
            }}
            onRetryPresets={onRetryDesignPresets}
            onSelect={(selection) => {
              setSelectedStyle(selection);
              setComposerPanel(null);
            }}
            presetItems={designPresetItems}
            presetStatus={designPresetStatus}
            projectChoices={projectDesignSystemChoices}
            selected={selectedStyle}
          />
        )}
      </AnimatePresence>
      <CustomDesignSystemDialog
        busy={busy}
        onOpenChange={setCustomDesignOpen}
        onSubmit={(request) => setSelectedStyle(designStyleSelectionFromCustom(request))}
        open={customDesignOpen}
      />
      <WorkbenchImportSourcesDialog
        disabled={disabled}
        onOpenChange={setImportSourcesOpen}
        onSelectFiles={() => {
          setImportSourcesOpen(false);
          void attachments.openAttachment("file").catch((error) => {
            toast.error(workbenchScreenCaptureErrorMessage(error));
          });
        }}
        onSelectedSourceIdsChange={setSelectedSourceIds}
        open={importSourcesOpen}
        projectId={projectId}
        selectedSourceIds={selectedSourceIds}
      />
    </motion.div>
  );
}
