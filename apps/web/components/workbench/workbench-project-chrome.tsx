"use client";

import type { RunGenerationStage } from "@workbench/workbench-contracts";
import { AnimatePresence, motion } from "framer-motion";
import {
  CopyIcon,
  FileTextIcon,
  Grid3X3Icon,
  HistoryIcon,
  HomeIcon,
  MenuIcon,
  MonitorIcon,
  PencilIcon,
  PlayIcon,
  SendIcon,
  Share2Icon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";
import type { BoardNodeActionAvailability } from "@/lib/workbench/features/board";
import type {
  WorkbenchProjectCapabilities,
  WorkbenchProjectMode,
  WorkbenchProjectPhase,
  WorkbenchRunMotionKind,
} from "@/lib/workbench/features";
import {
  openWorkbenchKnowledgePage,
  openWorkbenchProductLink,
  workbenchProductLinks,
} from "@/lib/workbench/product-links";
import {
  popoverTransition,
  viewTransition,
  workbenchEase,
} from "./workbench-motion";
import { WorkbenchArtifactFallback } from "./workbench-artifact-fallback";

type Phase = WorkbenchProjectPhase;
type ProjectMode = WorkbenchProjectMode;

const PROTOTYPE_GENERATION_STAGES: readonly RunGenerationStage[] = [
  "design-system",
  "mapping-components",
  "creating-flows",
  "generating-ui",
  "screen-streaming",
  "summarizing",
  "screen-stable",
];

const PRD_GENERATION_STAGES: readonly RunGenerationStage[] = [
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
];

type ActiveProjectStageMotionKind = Exclude<WorkbenchRunMotionKind, "neutral">;

function getProjectStageMotionKind({
  generationStage,
  isOverview,
  motionKind,
  phase,
}: {
  generationStage: RunGenerationStage | null;
  isOverview: boolean;
  motionKind: WorkbenchRunMotionKind;
  phase: Phase;
}): ActiveProjectStageMotionKind | null {
  if (phase !== "generating" && phase !== "refining") {
    return null;
  }

  const isPrototypeGenerationStage = generationStage !== null
    && PROTOTYPE_GENERATION_STAGES.includes(generationStage);
  const isPrdGenerationStage = generationStage !== null
    && PRD_GENERATION_STAGES.includes(generationStage);
  const stageMotionKind: ActiveProjectStageMotionKind | null = isPrototypeGenerationStage
    ? "prototype"
    : isPrdGenerationStage
      ? "prd"
      : null;

  if (motionKind === "neutral") {
    return stageMotionKind === "prototype" && isOverview ? null : stageMotionKind;
  }

  if (stageMotionKind !== null && stageMotionKind !== motionKind) return null;
  if (motionKind === "prototype" && isOverview) return null;
  return motionKind;
}

export function ProjectChromeVignette({ isOverview }: { isOverview: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5]">
      <div className={cn(
        "absolute inset-x-0 top-0 h-[118px]",
        isOverview
          ? "bg-[linear-gradient(180deg,rgba(15,15,16,0.62),rgba(15,15,16,0.24)_48%,transparent)]"
          : "bg-[linear-gradient(180deg,rgba(15,15,16,0.86),rgba(15,15,16,0.46)_48%,transparent)]",
      )} />
      <div className={cn(
        "absolute inset-x-0 bottom-0 h-[150px]",
        isOverview
          ? "bg-[linear-gradient(0deg,rgba(15,15,16,0.54),rgba(15,15,16,0.20)_54%,transparent)]"
          : "bg-[linear-gradient(0deg,rgba(15,15,16,0.78),rgba(15,15,16,0.34)_54%,transparent)]",
      )} />
      <div className={cn(
        "absolute bottom-0 left-0 top-0 w-[340px]",
        isOverview
          ? "bg-[linear-gradient(90deg,rgba(15,15,16,0.36),transparent)]"
          : "bg-[linear-gradient(90deg,rgba(15,15,16,0.58),transparent)]",
      )} />
      <div className={cn(
        "absolute bottom-0 right-0 top-0 w-[170px]",
        isOverview
          ? "bg-[linear-gradient(270deg,rgba(15,15,16,0.24),transparent)]"
          : "bg-[linear-gradient(270deg,rgba(15,15,16,0.38),transparent)]",
      )} />
    </div>
  );
}

export function ProjectStageMotionFX({
  generationStage,
  isOverview,
  motionKind,
  phase,
  showPendingArtifact = false,
}: {
  generationStage: RunGenerationStage | null;
  isOverview: boolean;
  motionKind: WorkbenchRunMotionKind;
  phase: Phase;
  showPendingArtifact?: boolean;
}) {
  const generationMotionKind = getProjectStageMotionKind({
    generationStage,
    isOverview,
    motionKind,
    phase,
  });
  const showPrdGenerationWash = generationMotionKind === "prd";

  return (
    <div className="pointer-events-none absolute inset-0 z-[6] overflow-hidden">
      <AnimatePresence>
        {generationMotionKind !== null && (
          <motion.div
            animate={{ opacity: showPrdGenerationWash ? 0.64 : phase === "refining" ? 0.62 : 0.48 }}
            aria-hidden="true"
            className={cn(
              "workbench-stage-phase-wash absolute inset-0",
              showPrdGenerationWash && "workbench-stage-phase-wash--prd",
              phase === "refining" && "workbench-stage-phase-wash--refining",
            )}
            data-canvas-generation-motion={generationMotionKind}
            data-generation-stage={generationStage ?? undefined}
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.34, ease: workbenchEase }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showPendingArtifact && generationMotionKind !== null && (
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="workbench-transient-artifact-slot absolute"
            data-generation-stage={generationStage ?? undefined}
            data-workbench-transient-artifact={generationMotionKind}
            exit={{ opacity: 0, scale: 0.985, y: 5 }}
            initial={{ opacity: 0, scale: 0.985, y: 5 }}
            transition={{ duration: 0.28, ease: workbenchEase }}
          >
            <div
              className={cn(
                "workbench-transient-artifact-surface overflow-hidden border border-[#7467f6] shadow-[0_24px_90px_-44px_rgba(0,0,0,0.95)]",
                generationMotionKind === "prototype" && "workbench-transient-artifact-surface--prototype",
              )}
            >
              <WorkbenchArtifactFallback
                phase={phase === "refining" ? "refining" : "generating"}
                title={generationMotionKind === "prd" ? "需求文档" : "原型界面"}
                variant={generationMotionKind === "prd" ? "document" : "prototype"}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isOverview && (
          <motion.div
            animate={{ opacity: 1 }}
            className="workbench-overview-field absolute inset-0"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: workbenchEase }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export function ProjectSuggestionPills({
  disabled,
  onSelect,
  phase,
  projectMode,
  zoomKeyActive,
  zoomLabel,
}: {
  disabled: boolean;
  onSelect: (text: string) => void;
  phase: Phase;
  projectMode: ProjectMode;
  zoomKeyActive: boolean;
  zoomLabel: string;
}) {
  const items = projectMode === "document" ? [
    "基于此 PRD 生成 UI 界面设计",
    "细化补签和奖励规则",
    "增加积分商城功能说明",
  ] : [
    "Change the generation status to 'Complete'",
    "Add a 'Style' configuration panel on the left",
  ];
  if (projectMode === "generated") {
    const tip = zoomKeyActive
      ? "贴士： Release Z to return to the canvas tool"
      : zoomLabel === "10%"
        ? "贴士： Use the Align menu to snap multiple screens to Left, Right, Top, Bottom, or Center"
        : zoomLabel === "28%" && phase !== "complete"
          ? "贴士： Hold down the Z key to quickly zoom in and out"
        : phase === "complete"
      ? "贴士：让产品工作台优化设计中的特定部分"
      : "贴士： Working on dark screens? Consider switching to light mode so you can see more contrast!";

    return (
      <>
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="absolute bottom-[118px] left-1/2 z-40 w-[740px] max-w-[calc(100vw-32px)] -translate-x-1/2 text-center text-[12px] font-medium text-[#8f949c] max-md:hidden"
          initial={{ opacity: 0, y: 8 }}
          transition={{ ...viewTransition, delay: 0.18 }}
        >
          {tip}
        </motion.div>
      </>
    );
  }

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "workbench-project-suggestions absolute left-1/2 z-40 flex w-[580px] max-w-[calc(100vw-32px)] -translate-x-1/2 gap-[8px]",
        projectMode === "document"
          ? "workbench-project-suggestions--document"
          : "workbench-project-suggestions--prototype",
      )}
      data-project-suggestions
      initial={{ opacity: 0, y: 10 }}
      transition={{ ...viewTransition, delay: 0.22 }}
    >
      {items.map((item, index) => (
        <button
          className="flex h-[32px] min-w-0 flex-1 items-center justify-between rounded-full border border-[#4a5563]/80 bg-[#202327]/88 px-[14px] text-left text-[13px] font-medium text-[#e8eaed] shadow-[0_18px_60px_-38px_rgba(0,0,0,0.95)] backdrop-blur-xl hover:bg-[#2a2d32]/92"
          disabled={disabled}
          key={item}
          onClick={() => onSelect(item)}
          type="button"
        >
          <span className="truncate">{item}</span>
          <span className="ml-[12px] shrink-0 text-[12px] text-[#c4c7ce]">{index + 1}</span>
        </button>
      ))}
    </motion.div>
  );
}

export function SelectedActionPill({
  activeRun,
  availability,
  canOpenVersions,
  menuOpen,
  onCopyLink,
  onDelete,
  onDuplicate,
  onRename,
  onOpenVersions,
  onToggleMenu,
  open,
}: {
  activeRun: boolean;
  availability: BoardNodeActionAvailability;
  canOpenVersions: boolean;
  menuOpen: boolean;
  onCopyLink: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onOpenVersions: () => void;
  onToggleMenu: () => void;
  open: boolean;
}) {
  if (activeRun) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="absolute left-1/2 top-[14px] z-[55] -translate-x-1/2 text-[#f1f3f4] max-sm:top-[64px]"
          data-selected-action
          exit={{ opacity: 0, y: -5 }}
          initial={{ opacity: 0, y: -5 }}
          transition={popoverTransition}
        >
          <div className="flex h-[42px] items-center overflow-hidden rounded-full border border-white/[0.10] bg-[#161719]/96 shadow-[0_20px_70px_-34px_rgba(0,0,0,0.95)] backdrop-blur-xl">
            <button
              aria-label="复制所选内容"
              className="grid h-full w-[48px] place-items-center text-[#d8dce2] hover:bg-white/[0.06]"
              disabled={!availability.canDuplicate}
              onClick={onDuplicate}
              type="button"
            >
              <CopyIcon className="size-[17px]" />
            </button>
            <div className="h-[22px] w-px bg-white/[0.10]" />
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-pressed={menuOpen}
              className={cn(
                "flex h-full items-center gap-[10px] px-[18px] text-[14px] font-semibold hover:bg-white/[0.06]",
                menuOpen && "bg-white/[0.06]",
              )}
              onClick={onToggleMenu}
              type="button"
            >
              More
              <span className="size-[6px] rounded-full bg-[#7467f6]" />
            </button>
          </div>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="absolute left-1/2 top-[50px] w-[218px] -translate-x-1/2 overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#18191b]/92 p-[8px] text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
                exit={{ opacity: 0, y: -3 }}
                initial={{ opacity: 0, y: -3 }}
                role="menu"
                transition={popoverTransition}
              >
                {[
                  { disabled: !availability.canDuplicate, icon: CopyIcon, label: "复制", onSelect: onDuplicate },
                  { disabled: !availability.canRename, icon: PencilIcon, label: "重命名", onSelect: onRename },
                  { disabled: !availability.canCopyLink, icon: Share2Icon, label: "复制链接", onSelect: onCopyLink },
                  { disabled: !canOpenVersions, icon: HistoryIcon, label: "版本记录", onSelect: onOpenVersions },
                  { disabled: !availability.canDelete, icon: Trash2Icon, label: "删除", onSelect: onDelete, tone: "danger" },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      className={cn(
                        "flex h-[38px] w-full items-center gap-[11px] rounded-[10px] px-[11px] text-left text-[13px] font-semibold hover:bg-white/[0.06]",
                        item.tone === "danger" ? "text-[#f2a7a7]" : "text-[#f1f3f4]",
                      )}
                      disabled={item.disabled}
                      key={item.label}
                      onClick={item.onSelect}
                      role="menuitem"
                      type="button"
                    >
                      <Icon className="size-[15px] shrink-0" />
                      {item.label}
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ProjectTopBar({
  capabilities,
  exportOpen,
  onArchive,
  onBack,
  onDuplicate,
  onMembers,
  onExport,
  onPreview,
  onRename,
  onShare,
  onToggleMenu,
  projectTitle,
  projectMenuOpen,
  shareOpen,
}: {
  capabilities: WorkbenchProjectCapabilities;
  exportOpen: boolean;
  onArchive: () => void;
  onBack: () => void;
  onDuplicate: () => void;
  onMembers: () => void;
  onExport: () => void;
  onPreview: () => void;
  onRename: () => void;
  onShare: () => void;
  onToggleMenu: () => void;
  projectTitle: string;
  projectMenuOpen: boolean;
  shareOpen: boolean;
}) {
  return (
    <motion.header
      animate={{ opacity: 1, y: 0 }}
      className="absolute left-0 right-0 top-0 z-50 flex h-[56px] items-center justify-between bg-transparent px-[16px] text-[13px] sm:px-[28px]"
      data-project-menu
      initial={{ opacity: 0, y: -8 }}
      transition={{ ...viewTransition, delay: 0.04 }}
    >
      <div className="flex min-w-0 items-center gap-[8px] sm:gap-[14px]">
        <button
          aria-expanded={projectMenuOpen}
          aria-haspopup="menu"
          aria-label="项目菜单"
          className="workbench-chrome-button grid h-[32px] w-[48px] place-items-center rounded-full border border-white/[0.11] bg-[#1c1d20]/86 text-[#e8eaed] transition-colors hover:bg-[#2b2c30]/90"
          onClick={onToggleMenu}
          type="button"
        >
          <MenuIcon className="size-[20px]" />
        </button>
        <AnimatePresence>
          {projectMenuOpen && (
            <ProjectMenu
              capabilities={capabilities}
              onArchive={onArchive}
              onBack={onBack}
              onDuplicate={onDuplicate}
              onMembers={onMembers}
              onExport={onExport}
              onRename={onRename}
              onShare={onShare}
              projectTitle={projectTitle}
            />
          )}
        </AnimatePresence>
        <div
          className="hidden h-[32px] max-w-[290px] items-center gap-[8px] rounded-[18px] px-[2px] text-left transition-colors hover:bg-[#353436]/30 sm:flex"
          title={projectTitle}
        >
          <span className="max-w-[280px] truncate text-[14px] font-semibold leading-[20px] text-[#f1f3f4]">
            {projectTitle}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-[4px] sm:gap-[8px]">
        <button
          aria-label="预览项目"
          className="workbench-chrome-button group grid size-[34px] place-items-center rounded-full border border-white/[0.10] bg-[#1c1d20]/86 text-[#f1f3f4] transition hover:border-white/[0.18] hover:bg-[#34353a]/94 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
          data-project-action="preview"
          onClick={() => onPreview()}
          disabled={!capabilities.canPreview}
          title={capabilities.canPreview ? "预览" : "当前角色无法创建预览"}
          type="button"
        >
          <PlayIcon className="size-[17px]" />
        </button>
        <button
          aria-label="导出"
          aria-pressed={exportOpen}
          className={cn(
            "workbench-chrome-pill flex h-[34px] items-center gap-[8px] rounded-full border px-[9px] text-[14px] font-semibold transition-colors sm:px-[14px]",
            exportOpen
              ? "border-white/[0.18] bg-[#54565c]/92 text-[#f1f3f4] shadow-[0_12px_36px_-24px_rgba(255,255,255,0.42)]"
              : "border-white/[0.10] bg-[#1c1d20]/86 text-[#f1f3f4] hover:bg-[#2b2c30]/90",
          )}
          data-global-panel-trigger
          data-project-action="export"
          disabled={!capabilities.canExport}
          onClick={onExport}
          type="button"
        >
          <MonitorIcon className="size-[17px]" />
          <span className="hidden sm:inline">导出</span>
        </button>
        <button
          aria-label="共享"
          aria-pressed={shareOpen}
          className={cn(
            "workbench-chrome-pill flex h-[34px] items-center gap-[8px] rounded-full border px-[9px] text-[14px] font-semibold transition-colors sm:px-[14px]",
            shareOpen
              ? "border-white/[0.18] bg-[#54565c]/92 text-[#f1f3f4] shadow-[0_12px_36px_-24px_rgba(255,255,255,0.42)]"
              : "border-white/[0.10] bg-[#1c1d20]/86 text-[#f1f3f4] hover:bg-[#2b2c30]/90",
          )}
          data-global-panel-trigger
          data-project-action="share"
          disabled={!capabilities.canShare}
          onClick={onShare}
          type="button"
        >
          <Share2Icon className="size-[17px]" />
          <span className="hidden sm:inline">共享</span>
        </button>
        <div className="ml-[2px] grid size-[32px] place-items-center rounded-full bg-[#536a74] text-[15px] font-semibold text-[#f1f3f4] sm:ml-[4px] sm:size-[34px]">
          L
        </div>
      </div>
    </motion.header>
  );
}

function ProjectMenu({
  capabilities,
  onArchive,
  onBack,
  onDuplicate,
  onMembers,
  onExport,
  onRename,
  onShare,
  projectTitle,
}: {
  capabilities: WorkbenchProjectCapabilities;
  onArchive: () => void;
  onBack: () => void;
  onDuplicate: () => void;
  onMembers: () => void;
  onExport: () => void;
  onRename: () => void;
  onShare: () => void;
  projectTitle: string;
}) {
  const primaryItems: Array<{
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    label: string;
    disabled?: boolean;
    onClick?: () => void;
  }> = [
    { icon: HomeIcon, label: "项目首页", onClick: onBack },
    { icon: PencilIcon, label: "重命名项目", disabled: !capabilities.canEdit, onClick: onRename },
    { icon: CopyIcon, label: "复制项目", disabled: !capabilities.canDuplicate, onClick: onDuplicate },
    { icon: UsersIcon, label: "成员与权限", onClick: onMembers },
  ];
  const secondaryItems: Array<{
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    label: string;
    disabled?: boolean;
    onClick?: () => void;
  }> = [
    { icon: FileTextIcon, label: "Docs", onClick: () => openWorkbenchKnowledgePage() },
    { icon: Share2Icon, label: "共享", disabled: !capabilities.canShare, onClick: onShare },
    { icon: MonitorIcon, label: "导出", disabled: !capabilities.canExport, onClick: onExport },
    {
      icon: SendIcon,
      label: "发送反馈",
      disabled: !workbenchProductLinks.feedback,
      onClick: workbenchProductLinks.feedback
        ? () => openWorkbenchProductLink(workbenchProductLinks.feedback!)
        : undefined,
    },
  ];

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="absolute left-[28px] top-[58px] w-[292px] overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#18191b]/92 p-[8px] text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
      data-project-menu
      exit={{ opacity: 0, y: -3 }}
      initial={{ opacity: 0, y: -3 }}
      role="menu"
      transition={popoverTransition}
    >
      <div className="mb-[6px] flex items-center gap-[10px] rounded-[12px] px-[10px] py-[9px]">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[8px] bg-[#2b2d31] text-[#cfd3da]">
          <Grid3X3Icon className="size-[17px]" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold leading-[18px] text-[#f1f3f4]">{projectTitle}</span>
          <span className="mt-[2px] block text-[11px] font-medium leading-[14px] text-[#9aa0a6]">产品工作台项目</span>
        </span>
      </div>
      {[primaryItems, secondaryItems].map((group, groupIndex) => (
        <div
          className={cn(groupIndex > 0 && "mt-[6px] border-t border-white/[0.08] pt-[6px]")}
          key={groupIndex}
        >
          {group.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className="flex h-[42px] w-full items-center gap-[12px] rounded-[10px] px-[12px] text-left text-[14px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]"
                disabled={item.disabled}
                key={item.label}
                onClick={item.onClick}
                role="menuitem"
                type="button"
              >
                <Icon className="size-[17px] shrink-0 text-[#d8dce2]" />
                {item.label}
              </button>
            );
          })}
        </div>
      ))}
      <div className="mt-[6px] border-t border-white/[0.08] pt-[6px]">
        <button
          className="flex h-[42px] w-full items-center gap-[12px] rounded-[10px] px-[12px] text-left text-[14px] font-semibold text-[#f2a7a7] hover:bg-white/[0.06]"
          disabled={!capabilities.canArchive}
          onClick={onArchive}
          role="menuitem"
          type="button"
        >
          <Trash2Icon className="size-[17px] shrink-0" />
          删除项目
        </button>
      </div>
    </motion.div>
  );
}
