"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FileTextIcon,
  GiftIcon,
  Grid3X3Icon,
  HelpCircleIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoreVerticalIcon,
  PaletteIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  Share2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  StarsIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { DesignSystemCatalogItem, ImportSource } from "@workbench/workbench-contracts";

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
import type { WorkbenchUser } from "@/lib/auth/workbench-auth";
import { cn } from "@/lib/utils";
import {
  visibleWorkbenchModelChoices,
  type WorkbenchModelChoice,
} from "@/lib/workbench/features/workbench-presenter";
import type {
  WorkbenchModelCatalogState,
} from "@/lib/workbench/features/runtime-models";
import type {
  WorkbenchRunSubmission,
} from "@/lib/workbench/features/workbench-controller";
import {
  useWorkbenchHomeScreenController,
} from "@/lib/workbench/features/workbench-home-screen-controller";
import {
  useWorkbenchComposerAttachments,
  workbenchScreenCaptureErrorMessage,
} from "@/lib/workbench/files/composer-attachments";
import {
  openWorkbenchKnowledgePage,
  openWorkbenchProductLink,
  workbenchProductLinks,
} from "@/lib/workbench/product-links";
import {
  HomeProjectList,
  type WorkbenchHomeProjectItem,
} from "@/lib/workbench/features/projects";
import { requestedArtifactKindsForPrompt } from "@/lib/workbench/run";
import type { ImportSourceDraft } from "@/lib/workbench/features/import-sources";

import { WorkbenchAccountMenu } from "./workbench-account-menu";
import {
  ComposerAttachmentMenu,
  ComposerCommandMenu,
  ModelChoiceMenu,
} from "./workbench-composer-menus";
import {
  automaticDesignStyleSelection,
  CustomDesignSystemDialog,
  designStyleSelectionFromCustom,
  HomeDesignSystemMenu,
  type WorkbenchDesignStyleSelection,
} from "./workbench-design-system-controls";
import { WorkbenchModelCatalogButton } from "./workbench-model-catalog-button";
import { WorkbenchImportSourcesDialog } from "./workbench-import-sources-dialog";
import {
  keepWorkbenchRouteMotionOnMainThread,
  panelTransition,
  popoverTransition,
  viewTransition,
  workbenchEase,
} from "./workbench-motion";
import {
  workbenchHomeTemplates,
  type WorkbenchHomeTemplate,
} from "./workbench-home-templates";
import {
  DottedBackdrop,
  useWorkbenchPointerVars,
} from "./workbench-surface-primitives";

type ModelName = string;
type HomeProjectItem = WorkbenchHomeProjectItem;
type WorkbenchRunSubmitHandler = (
  submission: WorkbenchRunSubmission,
) => Promise<string | null>;

const idleSuggestions = [
  "Profile page for Formula One driver Max Verstappen",
  "Mobile friendly home for a marketplace",
  "A mood-based movie picker app — you choose the vibe",
];

const activeSuggestions = [
  "Booking page with 30min time slots for a service",
  "A dashboard for a sourdough bread subscription",
  "Create a dashboard for Beehive Management",
];

export function HomeScreen({
  accountUser,
  busy,
  designSystemCatalogFetchingNextPage,
  designSystemCatalogHasNextPage,
  designSystemCatalogItems,
  designSystemCatalogStatus,
  hasNextProjectPage,
  homeProjectTab,
  loadError,
  loadStatus,
  modelCatalog,
  modelChoices,
  onLogout,
  onArchiveProject,
  onDuplicateProject,
  onOpenProject,
  onLoadMoreProjects,
  onLoadMoreDesignSystems,
  onRetryDesignSystems,
  onRetryModels,
  onRetryProjects,
  onSubmitPrompt,
  onCreateExternalSource = async () => null,
  projectSearch,
  projectPageLoading,
  projects,
  prompt,
  setHomeProjectTab,
  setProjectSearch,
  setPrompt,
}: {
  accountUser: WorkbenchUser | null;
  busy: boolean;
  designSystemCatalogFetchingNextPage: boolean;
  designSystemCatalogHasNextPage: boolean;
  designSystemCatalogItems: DesignSystemCatalogItem[];
  designSystemCatalogStatus: "error" | "loading" | "ready";
  hasNextProjectPage: boolean;
  homeProjectTab: "mine" | "shared";
  loadError: unknown;
  loadStatus: "error" | "loading" | "ready";
  modelCatalog: WorkbenchModelCatalogState;
  modelChoices: WorkbenchModelChoice[];
  onLogout: () => Promise<void>;
  onArchiveProject: (projectId: string) => Promise<unknown>;
  onDuplicateProject: (projectId: string) => Promise<unknown>;
  onOpenProject: (projectId: string) => void;
  onLoadMoreProjects: () => void;
  onLoadMoreDesignSystems: () => void;
  onRetryDesignSystems: () => void;
  onRetryModels: () => void;
  onRetryProjects: () => void;
  onSubmitPrompt: WorkbenchRunSubmitHandler;
  onCreateExternalSource?: (request: ImportSourceDraft) => Promise<ImportSource | null>;
  projectSearch: string;
  projectPageLoading: boolean;
  projects: HomeProjectItem[];
  prompt: string;
  setHomeProjectTab: (tab: "mine" | "shared") => void;
  setProjectSearch: (query: string) => void;
  setPrompt: (prompt: string) => void;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const [inspirationRotationRequest, setInspirationRotationRequest] = useState(0);
  const [importSourcesOpen, setImportSourcesOpen] = useState(false);
  const homeModelChoices = useMemo(
    () => visibleWorkbenchModelChoices(modelChoices, { allowEdit: false }),
    [modelChoices],
  );
  const homeScreen = useWorkbenchHomeScreenController({
    modelCatalogStatus: modelCatalog.status,
    modelChoices: homeModelChoices,
    onArchiveProject,
    onDuplicateProject,
  });
  const {
    announcementOpen,
    archiveFailed,
    archiveProjectTarget,
    closeHomeMenus,
    closeNewsletter,
    communicationPreferences,
    communicationPreferencesBusy,
    confirmArchiveProject,
    dismissAnnouncement,
    duplicateProject,
    homeModel,
    homeModelMenuOpen,
    homeMoreMenuOpen,
    homeStyleMenuOpen,
    mobileProjectsOpen,
    newsletterOpen,
    onArchiveDialogOpenChange,
    openNewsletter,
    projectActionBusy,
    requestArchiveProject,
    saveCommunicationPreferences,
    selectHomeModel,
    setTargetSurface,
    targetSurface,
    toggleHomeModelMenu,
    toggleHomeMoreMenu,
    toggleHomeStyleMenu,
    toggleMobileProjects,
  } = homeScreen;

  useWorkbenchPointerVars(stageRef);

  return (
    <motion.section
      animate={{ opacity: 1, y: 0 }}
      className="absolute inset-0 bg-[var(--workbench-bg)] text-[#e5e2e3]"
      exit={{ opacity: 0, y: -6 }}
      initial={{ opacity: 0, y: 6 }}
      onMouseDown={closeHomeMenus}
      onUpdate={keepWorkbenchRouteMotionOnMainThread}
      ref={stageRef}
      transition={panelTransition}
    >
      <DottedBackdrop interactive />
      <motion.header
        animate={{ opacity: 1, y: 0 }}
        className="absolute left-0 right-0 top-0 z-[80] flex h-[56px] items-center justify-between pl-[24px] pr-[14px]"
        initial={{ opacity: 0, y: -8 }}
        transition={{ ...viewTransition, delay: 0.04 }}
      >
        <div className="flex items-center gap-[10px]">
          <div className="text-[29px] font-semibold leading-none tracking-normal">产品工作台</div>
          <span className="rounded-full border border-white/80 px-[9px] py-[4px] text-[11px] font-semibold uppercase leading-none">
            Beta
          </span>
        </div>
        <button
          aria-expanded={mobileProjectsOpen}
          aria-label="项目列表"
          className="grid size-[36px] place-items-center rounded-full border border-white/[0.10] bg-[#1c1d20]/86 text-[#f1f3f4] md:hidden"
          onClick={(event) => {
            event.stopPropagation();
            toggleMobileProjects();
          }}
          type="button"
        >
          {mobileProjectsOpen ? <XIcon className="size-[18px]" /> : <Grid3X3Icon className="size-[18px]" />}
        </button>
        <div className="hidden items-center gap-[12px] text-[#e8eaed] md:flex" data-home-more-menu onMouseDown={(event) => event.stopPropagation()}>
          <button
            className="flex h-[34px] items-center gap-[7px] rounded-full px-[4px] text-[14px] font-semibold hover:bg-white/[0.05]"
            onClick={() => openWorkbenchKnowledgePage()}
            type="button"
          >
            <FileTextIcon className="size-[17px]" />
            Docs
          </button>
          <button
            aria-label="换一组灵感"
            className="grid size-[32px] place-items-center rounded-full hover:bg-white/[0.06]"
            onClick={() => setInspirationRotationRequest((request) => request + 1)}
            title="换一组灵感"
            type="button"
          >
            <StarsIcon className="size-[18px]" />
          </button>
          <button
            aria-label="关闭公告"
            className="grid size-[32px] place-items-center rounded-full hover:bg-white/[0.06]"
            onClick={dismissAnnouncement}
            type="button"
          >
            <XIcon className="size-[18px]" />
          </button>
          <button
            aria-label="消息订阅"
            className="relative grid size-[32px] place-items-center rounded-full hover:bg-white/[0.06]"
            onClick={openNewsletter}
            type="button"
          >
            <GiftIcon className="size-[18px]" />
            <span className="absolute right-[2px] top-[2px] size-[7px] rounded-full bg-[#7467f6]" />
          </button>
          <div className="relative">
            <button
              aria-expanded={homeMoreMenuOpen}
              aria-haspopup="menu"
              aria-label="更多"
              className={cn(
                "grid size-[34px] place-items-center rounded-full transition",
                homeMoreMenuOpen ? "bg-[#4a4d52]/86 text-[#f1f3f4]" : "hover:bg-white/[0.06]",
              )}
              onClick={toggleHomeMoreMenu}
              type="button"
            >
              <MoreVerticalIcon className="size-[21px]" />
            </button>
            <HomeMoreMenu open={homeMoreMenuOpen} />
          </div>
          <WorkbenchAccountMenu onLogout={onLogout} user={accountUser} />
        </div>
      </motion.header>

      <motion.aside
        animate={{ opacity: 1 }}
        className={cn(
          "workbench-mobile-project-drawer fixed inset-x-0 bottom-0 top-auto z-[70] h-[calc(100vh-80px)] overflow-hidden rounded-t-[16px] border border-white/[0.08] bg-[#18191b]/96 p-[17px] shadow-[0_24px_74px_-46px_rgba(0,0,0,0.95)] backdrop-blur-2xl transition-transform duration-300 ease-[var(--ease-smooth)] md:absolute md:bottom-[12px] md:left-[12px] md:right-auto md:top-[68px] md:z-20 md:h-auto md:w-[375px] md:rounded-[16px] md:bg-[#18191b]/72 md:transition-none md:translate-y-0",
          !mobileProjectsOpen && "pointer-events-none translate-y-full md:pointer-events-auto md:translate-y-0",
        )}
        initial={{ opacity: 0 }}
        transition={{ ...panelTransition, delay: 0.08 }}
        data-home-project-drawer-open={mobileProjectsOpen ? "true" : "false"}
      >
        <div className="mb-[14px] grid h-[36px] grid-cols-2 rounded-full bg-[#151618]/70 p-[2px]">
          <button
            className={cn(
              "rounded-full text-[14px] font-semibold",
              homeProjectTab === "mine" ? "bg-[#3f4247]/88 text-[#f1f3f4]" : "text-[#d4d7dc]",
            )}
            onClick={() => setHomeProjectTab("mine")}
            type="button"
          >
            <Grid3X3Icon className="mr-[7px] inline size-[14px]" />
            我的项目
          </button>
          <button
            className={cn(
              "rounded-full text-[14px] font-semibold",
              homeProjectTab === "shared" ? "bg-[#3f4247]/88 text-[#f1f3f4]" : "text-[#d4d7dc]",
            )}
            onClick={() => setHomeProjectTab("shared")}
            type="button"
          >
            <Share2Icon className="mr-[7px] inline size-[14px]" />
            与我共享
          </button>
        </div>
        <label className="flex h-[41px] items-center gap-[10px] rounded-full bg-[#242629]/82 px-[14px] text-[#aeb3bb]">
          <SearchIcon className="size-[17px]" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none placeholder:text-[#8d9299]"
            maxLength={160}
            onChange={(event) => setProjectSearch(event.target.value)}
            placeholder="搜索项目"
            value={projectSearch}
          />
        </label>
        <HomeProjectList
          actionBusy={projectActionBusy}
          error={loadError}
          hasNextPage={hasNextProjectPage}
          isFetchingNextPage={projectPageLoading}
          loadStatus={loadStatus}
          onArchiveProject={requestArchiveProject}
          onDuplicateProject={duplicateProject}
          onLoadMore={onLoadMoreProjects}
          onOpenProject={onOpenProject}
          onRetry={onRetryProjects}
          projects={projects}
        />
      </motion.aside>

      <motion.button
        animate={{ opacity: 1, y: 0 }}
        className="absolute right-[clamp(24px,calc(100vw-1442px),59px)] top-[260px] z-20 hidden h-[33px] items-center gap-[8px] rounded-full border border-white/[0.10] bg-[#242629]/82 px-[10px] text-[13px] font-semibold text-[#f1f3f4] backdrop-blur-2xl md:flex"
        initial={{ opacity: 0, y: 6 }}
        disabled={busy}
        onClick={toggleHomeStyleMenu}
        transition={{ ...viewTransition, delay: 0.16 }}
        type="button"
      >
        <PlusIcon className="size-[15px]" />
        以您的设计为基础
      </motion.button>

      <AnimatePresence>
        {announcementOpen && (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="absolute left-[20px] right-[20px] top-[166px] z-20 hidden md:left-[clamp(383px,calc(100vw-1092px),409px)] md:right-[24px] md:block"
          exit={{ opacity: 0, y: -4 }}
          initial={{ opacity: 0, y: -4 }}
          transition={{ ...popoverTransition, delay: 0.1 }}
        >
          <div className="mx-auto flex max-w-[1000px] justify-center">
            <button
              className="flex h-[42px] items-center gap-[8px] rounded-[5px] border border-white/[0.10] bg-[#18191b]/86 px-[32px] text-[14px] font-semibold text-[#f1f3f4] shadow-[0_18px_60px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
              onClick={dismissAnnouncement}
              type="button"
            >
              产品工作台：<span className="text-[#8b80ff]">新版功能已更新</span>
              <XIcon
                className="ml-[4px] size-[15px] text-[#c7cad0]"
              />
            </button>
          </div>
        </motion.div>
        )}
      </AnimatePresence>

      <motion.section
        animate={{ opacity: 1, y: 0 }}
        className="absolute left-[20px] right-[20px] top-[247px] z-10 md:left-[clamp(383px,calc(100vw-1092px),409px)] md:right-[24px] md:top-[247px]"
        initial={{ opacity: 0, y: 12 }}
        transition={{ ...viewTransition, delay: 0.12 }}
      >
        <div className="mx-auto max-w-[1000px]">
          <h1 className="text-[34px] font-normal leading-none tracking-normal text-[#f1f3f4] sm:text-[46px] md:text-[56px]">
            欢迎使用产品工作台...
          </h1>
        </div>
      </motion.section>

      <HomeComposer
        busy={busy}
        designSystemCatalogFetchingNextPage={designSystemCatalogFetchingNextPage}
        designSystemCatalogHasNextPage={designSystemCatalogHasNextPage}
        designSystemCatalogItems={designSystemCatalogItems}
        designSystemCatalogStatus={designSystemCatalogStatus}
        model={homeModel}
        modelCatalog={modelCatalog}
        modelChoices={homeModelChoices}
        modelMenuOpen={homeModelMenuOpen}
        onSelectModel={selectHomeModel}
        onToggleModel={toggleHomeModelMenu}
        onToggleStyle={toggleHomeStyleMenu}
        onSubmitPrompt={onSubmitPrompt}
        onCreateExternalSource={onCreateExternalSource}
        importSourcesOpen={importSourcesOpen}
        onImportSourcesOpenChange={setImportSourcesOpen}
        onLoadMoreDesignSystems={onLoadMoreDesignSystems}
        onRetryDesignSystems={onRetryDesignSystems}
        onRetryModels={onRetryModels}
        prompt={prompt}
        setSurface={setTargetSurface}
        setPrompt={setPrompt}
        styleMenuOpen={homeStyleMenuOpen}
        surface={targetSurface}
      />
      <InspirationStrip
        onSelectTemplate={(template) => {
          setPrompt(template.prompt);
          setTargetSurface(template.targetSurface);
        }}
        rotationRequest={inspirationRotationRequest}
      />
      <AnimatePresence>
        {newsletterOpen && (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="absolute bottom-[10px] left-[20px] right-[20px] z-50 max-w-[852px] rounded-[18px] border border-white/[0.14] bg-[#6b6d70]/92 px-[28px] py-[20px] shadow-[0_22px_80px_-30px_rgba(0,0,0,0.95)] backdrop-blur-xl md:left-[383px] md:right-[24px] md:mx-auto"
          exit={{ opacity: 0, y: 10 }}
          initial={{ opacity: 0, y: 10 }}
          transition={{ ...viewTransition, delay: 0.2 }}
        >
          <button
            className="absolute right-[18px] top-[18px] grid size-[28px] place-items-center rounded-full text-white/90 hover:bg-white/[0.10]"
            onClick={closeNewsletter}
            type="button"
          >
            <XIcon className="size-[18px]" />
          </button>
          <label className="mb-[10px] flex items-center gap-[12px] text-[15px] font-medium text-white">
            <input
              checked={communicationPreferences?.productUpdatesEmail ?? false}
              className="size-[18px] accent-[#d8dbdf]"
              disabled={communicationPreferencesBusy || !communicationPreferences}
              onChange={(event) => saveCommunicationPreferences({
                productUpdatesEmail: event.target.checked,
              })}
              type="checkbox"
            />
            订阅产品工作台邮件，获取模型更新、专属优惠、实用技巧和最新资讯。
          </label>
          <label className="flex items-center gap-[12px] text-[15px] font-medium text-white">
            <input
              checked={communicationPreferences?.researchInvitations ?? false}
              className="size-[18px] accent-[#d8dbdf]"
              disabled={communicationPreferencesBusy || !communicationPreferences}
              onChange={(event) => saveCommunicationPreferences({
                researchInvitations: event.target.checked,
              })}
              type="checkbox"
            />
            接收邀请，参与产品工作台的未来调研项目
          </label>
          <p className="mt-[14px] max-w-[820px] whitespace-normal text-[12px] leading-[18px] text-white/86">
            须遵守产品工作台服务条款和使用政策。您可以随时在产品工作台账户中管理这些偏好。
          </p>
        </motion.div>
        )}
      </AnimatePresence>
      <AlertDialog
        onOpenChange={onArchiveDialogOpenChange}
        open={archiveProjectTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个项目？</AlertDialogTitle>
            <AlertDialogDescription>
              项目将被归档，现有共享链接会立即失效。{archiveFailed ? " 删除失败，请重试。" : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={projectActionBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={projectActionBusy || archiveProjectTarget?.role !== "owner"}
              onClick={(event) => {
                event.preventDefault();
                confirmArchiveProject();
              }}
              variant="destructive"
            >
              {projectActionBusy ? "删除中..." : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.section>
  );
}

function HomeMoreMenu({ open }: { open: boolean }) {
  const items = [
    { icon: HelpCircleIcon, label: "常见问题解答", onClick: () => openWorkbenchKnowledgePage() },
    {
      icon: MessageSquareIcon,
      label: "论坛",
      disabled: !workbenchProductLinks.forum,
      onClick: workbenchProductLinks.forum
        ? () => openWorkbenchProductLink(workbenchProductLinks.forum!)
        : undefined,
      unavailableTitle: "未配置论坛地址",
    },
    {
      icon: FileTextIcon,
      label: "提示指南",
      onClick: () => openWorkbenchKnowledgePage("00-知识库使用规范/Agent任务分类与补全规则"),
    },
    {
      icon: SendIcon,
      label: "发送反馈",
      disabled: !workbenchProductLinks.feedback,
      onClick: workbenchProductLinks.feedback
        ? () => openWorkbenchProductLink(workbenchProductLinks.feedback!)
        : undefined,
      unavailableTitle: "未配置反馈地址",
    },
    {
      icon: ShieldCheckIcon,
      label: "隐私权声明",
      disabled: !workbenchProductLinks.privacy,
      onClick: workbenchProductLinks.privacy
        ? () => openWorkbenchProductLink(workbenchProductLinks.privacy!)
        : undefined,
      unavailableTitle: "未配置隐私权声明地址",
    },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="fixed right-[72px] top-[62px] z-[90] max-h-[calc(100vh-82px)] w-[204px] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#18191b]/94 px-[12px] py-[10px] text-[#f1f3f4] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
          exit={{ opacity: 0, y: -3 }}
          initial={{ opacity: 0, y: -3 }}
          role="menu"
          transition={popoverTransition}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className="flex h-[56px] w-full items-center gap-[15px] rounded-[8px] px-[8px] text-left text-[15px] font-semibold hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={item.disabled}
                key={item.label}
                onClick={item.onClick}
                role="menuitem"
                title={item.disabled ? item.unavailableTitle ?? "尚未配置" : undefined}
                type="button"
              >
                <Icon className="size-[22px] shrink-0 text-[#e8eaed]" />
                {item.label}
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function HomeComposer({
  busy,
  designSystemCatalogFetchingNextPage,
  designSystemCatalogHasNextPage,
  designSystemCatalogItems,
  designSystemCatalogStatus,
  model,
  modelCatalog,
  modelChoices,
  modelMenuOpen,
  onSelectModel,
  onToggleModel,
  onToggleStyle,
  onSubmitPrompt,
  onCreateExternalSource,
  importSourcesOpen,
  onImportSourcesOpenChange,
  onLoadMoreDesignSystems,
  onRetryDesignSystems,
  onRetryModels,
  prompt,
  setSurface,
  setPrompt,
  styleMenuOpen,
  surface,
}: {
  busy: boolean;
  designSystemCatalogFetchingNextPage: boolean;
  designSystemCatalogHasNextPage: boolean;
  designSystemCatalogItems: DesignSystemCatalogItem[];
  designSystemCatalogStatus: "error" | "loading" | "ready";
  model: ModelName;
  modelCatalog: WorkbenchModelCatalogState;
  modelChoices: WorkbenchModelChoice[];
  modelMenuOpen: boolean;
  onSelectModel: (model: ModelName) => void;
  onToggleModel: () => void;
  onToggleStyle: () => void;
  onSubmitPrompt: WorkbenchRunSubmitHandler;
  onCreateExternalSource: (request: ImportSourceDraft) => Promise<ImportSource | null>;
  importSourcesOpen: boolean;
  onImportSourcesOpenChange: (open: boolean) => void;
  onLoadMoreDesignSystems: () => void;
  onRetryDesignSystems: () => void;
  onRetryModels: () => void;
  prompt: string;
  setSurface: (surface: "app" | "web") => void;
  setPrompt: (prompt: string) => void;
  styleMenuOpen: boolean;
  surface: "app" | "web";
}) {
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerPanel, setComposerPanel] = useState<"attachments" | "commands" | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<WorkbenchDesignStyleSelection>(automaticDesignStyleSelection);
  const [customDesignOpen, setCustomDesignOpen] = useState(false);
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const attachments = useWorkbenchComposerAttachments();
  const selectedFiles = attachments.selectedFiles;
  const composerBusy = busy || attachments.screenCaptureBusy;
  const composerActive = composerBusy || composerFocused || modelMenuOpen || styleMenuOpen || composerPanel !== null || prompt.trim().length > 0;
  const selectedModel = modelChoices.find((choice) => choice.key === model);
  const canSubmit = !composerBusy
    && modelCatalog.status === "ready"
    && Boolean(selectedModel)
    && selectedModel?.workflow !== "edit"
    && prompt.trim().length > 0
    && (selectedModel?.workflow !== "redesign" || selectedFiles.length > 0);
  const suggestionSource = composerActive ? activeSuggestions : idleSuggestions;
  const visibleSuggestions = [
    ...suggestionSource.slice(suggestionOffset % suggestionSource.length),
    ...suggestionSource.slice(0, suggestionOffset % suggestionSource.length),
  ];
  const submit = (nextPrompt: string) => {
    const text = nextPrompt.trim();
    if (
      !text
      || !selectedModel
      || selectedModel.workflow === "edit"
      || composerBusy
      || modelCatalog.status !== "ready"
    ) return;
    void onSubmitPrompt({
      prompt: text,
      modelChoiceKey: selectedModel.key,
      targetSurface: surface,
      designStyle: selectedStyle.designStyle,
      designSystemProvision: selectedStyle.provision,
      files: selectedFiles,
      sourceIds: [],
      requestedArtifactKinds: requestedArtifactKindsForPrompt(text),
    });
  };

  useEffect(() => {
    if (modelMenuOpen || styleMenuOpen) setComposerPanel(null);
  }, [modelMenuOpen, styleMenuOpen]);

  useEffect(() => {
    const closeComposerPanel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setComposerPanel(null);
    };
    window.addEventListener("keydown", closeComposerPanel);
    return () => window.removeEventListener("keydown", closeComposerPanel);
  }, []);

  const toggleComposerPanel = (panel: "attachments" | "commands") => {
    if (modelMenuOpen) onToggleModel();
    if (styleMenuOpen) onToggleStyle();
    setComposerPanel((currentPanel) => currentPanel === panel ? null : panel);
  };

  const refreshSuggestion = () => {
    if (busy) return;
    const nextOffset = (suggestionOffset + 1) % suggestionSource.length;
    setSuggestionOffset(nextOffset);
    setPrompt(suggestionSource[nextOffset]);
  };

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "absolute left-[20px] right-[20px] top-[331px] md:left-[clamp(383px,calc(100vw-1092px),409px)] md:right-[24px] md:top-[329px]",
        modelMenuOpen ? "z-[60]" : "z-30",
      )}
      data-home-composer
      initial={{ opacity: 0, y: 18 }}
      transition={{ ...viewTransition, delay: 0.16 }}
    >
      <div className="relative mx-auto max-w-[1000px]">
        <div
          className={cn(
            "workbench-composer-shell workbench-composer-shell--home relative overflow-hidden rounded-[21px] border bg-[#18191b]/76 px-[16px] pb-[17px] pt-[14px] shadow-[0_20px_70px_-44px_rgba(0,0,0,0.95)] backdrop-blur-2xl transition-[border-color,background-color,box-shadow] duration-200",
            composerActive
              ? "border-white/[0.14] bg-[#18191b]/88 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_22px_76px_-44px_rgba(0,0,0,0.98)]"
              : "border-white/[0.10]",
          )}
          data-active={composerActive ? "true" : undefined}
          data-busy={busy ? "true" : undefined}
          data-typing={canSubmit ? "true" : undefined}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {selectedFiles[0] && (
            <button
              aria-label={`移除附件 ${selectedFiles[0].name}`}
              className="absolute left-[16px] top-[14px] z-20 flex h-[32px] max-w-[260px] items-center gap-[8px] rounded-full border border-white/[0.10] bg-[#2b2d31]/92 px-[11px] text-[12px] font-medium text-[#d8dce2]"
              onClick={attachments.removeFirstFile}
              type="button"
            >
              <PaperclipIcon className="size-[13px] shrink-0" />
              <span className="truncate">
                {selectedFiles[0].name}{selectedFiles.length > 1 ? ` +${selectedFiles.length - 1}` : ""}
              </span>
              <XIcon className="size-[13px] shrink-0" />
            </button>
          )}
          <textarea
            aria-label="提示词"
            className={cn(
              "workbench-composer-field relative z-10 h-[128px] w-full resize-none bg-transparent text-[18px] leading-[28px] outline-none placeholder:text-[#a5a9b0]",
              selectedFiles.length > 0 && "pt-[42px]",
            )}
            onBlur={() => setComposerFocused(false)}
            onChange={(event) => setPrompt(event.target.value)}
            onFocus={() => setComposerFocused(true)}
            onKeyDown={(event) => {
              if (!busy && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(prompt);
              }
            }}
            placeholder="我们要设计什么样的原生移动应用?"
            value={prompt}
          />
          <input
            className="hidden"
            multiple
            onChange={(event) => {
              attachments.selectFiles(event.target.files);
              event.target.value = "";
            }}
            ref={attachments.fileInputRef}
            type="file"
          />
          <div className="relative z-10 mt-[18px] flex h-[36px] items-center gap-[12px] text-[#d7d9de]">
            <button
              aria-expanded={composerPanel === "attachments"}
              aria-haspopup="menu"
              aria-label="添加附件"
              className={cn(
                "workbench-composer-tool grid size-[36px] place-items-center rounded-full hover:bg-white/[0.10]",
                composerPanel === "attachments" && "bg-white/[0.10] text-[#f1f3f4]",
              )}
              onClick={() => toggleComposerPanel("attachments")}
              type="button"
            >
              <PlusIcon className="size-[18px]" />
            </button>
            <button
              aria-expanded={composerPanel === "commands"}
              aria-haspopup="menu"
              aria-label="命令"
              className={cn(
                "workbench-composer-tool grid h-[30px] w-[24px] place-items-center rounded-full text-[25px] leading-none hover:bg-white/[0.08]",
                composerPanel === "commands" && "bg-white/[0.08] text-[#f1f3f4]",
              )}
              onClick={() => toggleComposerPanel("commands")}
              type="button"
            >
              /
            </button>
            <div className="flex h-[34px] items-center gap-[3px] rounded-full bg-[#121315]/80 p-[2px]">
              <button
                aria-pressed={surface === "app"}
                className={cn(
                  "workbench-composer-segment flex h-[30px] items-center gap-[6px] rounded-full px-[11px] text-[13px] font-semibold",
                  surface === "app" ? "bg-[#3f4247]/90 text-[#f1f3f4]" : "text-[#bfc4ca]",
                )}
                onClick={() => setSurface("app")}
                type="button"
              >
                <MonitorIcon className="size-[15px]" />
                应用
              </button>
              <button
                aria-pressed={surface === "web"}
                className={cn(
                  "workbench-composer-segment flex h-[30px] items-center gap-[6px] rounded-full px-[11px] text-[13px] font-semibold",
                  surface === "web" ? "bg-[#3f4247]/90 text-[#f1f3f4]" : "text-[#bfc4ca]",
                )}
                onClick={() => setSurface("web")}
                type="button"
              >
                <MonitorIcon className="size-[15px]" />
                Web
              </button>
            </div>
            <div className="flex-1" />
            <button
              aria-expanded={styleMenuOpen}
              aria-haspopup="menu"
              aria-label={`样式: ${selectedStyle.label}`}
              className={cn(
                "workbench-composer-tool grid size-[36px] place-items-center rounded-full text-[#d7d9de] hover:bg-white/[0.06]",
                styleMenuOpen && "bg-[#707378] text-[#202124]",
              )}
              onClick={() => {
                setComposerPanel(null);
                onToggleStyle();
              }}
              title={`当前样式: ${selectedStyle.label}`}
              type="button"
            >
              <PaletteIcon className="size-[17px]" />
            </button>
            <WorkbenchModelCatalogButton
              catalog={modelCatalog}
              className="workbench-composer-model flex h-[36px] items-center gap-[7px] rounded-full bg-[#2b2d31]/86 px-[14px] text-[14px] font-semibold text-[#f1f3f4]"
              leadingIcon={<SparklesIcon className="size-[15px]" />}
              menuOpen={modelMenuOpen}
              onRetry={onRetryModels}
              onToggle={() => {
                setComposerPanel(null);
                onToggleModel();
              }}
              selectedLabel={selectedModel?.label}
            />
            <button
              aria-label="换一个示例提示"
              className="workbench-composer-tool grid size-[36px] place-items-center rounded-full text-[#d7d9de] hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={composerBusy}
              onClick={refreshSuggestion}
              type="button"
            >
              <motion.span animate={{ rotate: suggestionOffset * 360 }} transition={{ duration: 0.28, ease: workbenchEase }}>
                <RefreshCwIcon className="size-[17px]" />
              </motion.span>
            </button>
            <button
              aria-label="提交提示"
              className={cn(
                "workbench-composer-send grid size-[36px] place-items-center rounded-full text-[#6f747c]",
                canSubmit && "is-ready",
                composerBusy && "is-busy",
              )}
              disabled={!canSubmit}
              onClick={() => submit(prompt)}
              type="button"
            >
              {composerBusy
                ? <span className="workbench-home-submit-spinner size-[18px] animate-spin rounded-full border-2 border-[#8f949c]/35 border-r-[#aeb3bb] border-t-[#aeb3bb]" />
                : <ArrowUpIcon className="size-[17px]" />}
            </button>
          </div>
        </div>
        <AnimatePresence>
          {composerPanel === "attachments" && (
            <ComposerAttachmentMenu
              onSelect={(kind) => {
                setComposerPanel(null);
                if (kind === "source") {
                  onImportSourcesOpenChange(true);
                  return;
                }
                void attachments.openAttachment(kind).catch((error) => {
                  toast.error(workbenchScreenCaptureErrorMessage(error));
                });
              }}
              placement="home"
            />
          )}
          {composerPanel === "commands" && (
            <ComposerCommandMenu
              onSelect={(value) => {
                setPrompt(value);
                setComposerPanel(null);
              }}
              placement="home"
            />
          )}
          {styleMenuOpen && (
            <HomeDesignSystemMenu
              catalogItems={designSystemCatalogItems}
              fetchingNextPage={designSystemCatalogFetchingNextPage}
              hasNextPage={designSystemCatalogHasNextPage}
              onCreateCustom={() => {
                onToggleStyle();
                setCustomDesignOpen(true);
              }}
              onLoadMore={onLoadMoreDesignSystems}
              onRetry={onRetryDesignSystems}
              onSelect={(selection) => {
                setSelectedStyle(selection);
                onToggleStyle();
              }}
              selected={selectedStyle}
              status={designSystemCatalogStatus}
            />
          )}
          {modelCatalog.status === "ready" && modelMenuOpen && (
            <HomeModelMenu
              model={model}
              modelChoices={modelChoices}
              onSelectModel={onSelectModel}
            />
          )}
        </AnimatePresence>
        <div className="mt-[28px] flex gap-[9px] overflow-hidden">
          {visibleSuggestions.map((suggestion) => (
            <button
              className="h-[32px] max-w-[282px] shrink-0 truncate rounded-full border border-white/[0.12] bg-[#28292c]/90 px-[13px] text-[13px] font-semibold text-[#f0f1f3] transition-colors hover:bg-white/[0.08]"
              disabled={composerBusy
                || modelCatalog.status !== "ready"
                || !selectedModel
                || (selectedModel.workflow === "redesign" && selectedFiles.length === 0)}
              key={suggestion}
              onClick={() => submit(suggestion)}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
      <CustomDesignSystemDialog
        busy={busy}
        onOpenChange={setCustomDesignOpen}
        onSubmit={(request) => setSelectedStyle(designStyleSelectionFromCustom(request))}
        open={customDesignOpen}
      />
      <WorkbenchImportSourcesDialog
        disabled={composerBusy}
        onCreateExternalSource={onCreateExternalSource}
        onOpenChange={onImportSourcesOpenChange}
        onSelectFiles={() => {
          onImportSourcesOpenChange(false);
          void attachments.openAttachment("file").catch((error) => {
            toast.error(workbenchScreenCaptureErrorMessage(error));
          });
        }}
        onSelectedSourceIdsChange={() => undefined}
        open={importSourcesOpen}
        selectedSourceIds={[]}
      />
    </motion.div>
  );
}

function HomeModelMenu({
  model,
  modelChoices,
  onSelectModel,
}: {
  model: ModelName;
  modelChoices: WorkbenchModelChoice[];
  onSelectModel: (model: ModelName) => void;
}) {
  return (
    <ModelChoiceMenu
      className="absolute right-[74px] top-[154px] w-[330px]"
      model={model}
      modelChoices={modelChoices}
      onSelectModel={onSelectModel}
    />
  );
}

export function InspirationStrip({
  onSelectTemplate,
  rotationRequest,
}: {
  onSelectTemplate: (template: WorkbenchHomeTemplate) => void;
  rotationRequest: number;
}) {
  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const handledRotationRequestRef = useRef(rotationRequest);
  const orderedCards = [
    ...workbenchHomeTemplates.slice(activeCardIndex),
    ...workbenchHomeTemplates.slice(0, activeCardIndex),
  ];
  const rotateCards = (direction: -1 | 1) => {
    setActiveCardIndex((index) => (
      (index + direction + workbenchHomeTemplates.length) % workbenchHomeTemplates.length
    ));
  };

  useEffect(() => {
    if (rotationRequest === handledRotationRequestRef.current) return;
    handledRotationRequestRef.current = rotationRequest;
    setActiveCardIndex((index) => (index + 1) % workbenchHomeTemplates.length);
  }, [rotationRequest]);

  return (
    <motion.section
      animate={{ opacity: 1, y: 0 }}
      className="absolute left-[20px] right-[20px] top-[674px] z-20 [@media(max-height:820px)]:hidden md:left-[423px] md:right-[24px] md:top-[676px]"
      initial={{ opacity: 0, y: 18 }}
      transition={{ ...viewTransition, delay: 0.22 }}
    >
      <div className="mb-[18px] flex items-center justify-between">
        <h2 className="text-[27px] font-semibold leading-none text-[#f1f3f4]">需要灵感?</h2>
        <div className="flex items-center gap-[22px] pr-[18px] text-[#d7d9de]">
          <button
            aria-label="上一组灵感"
            className="grid size-[30px] place-items-center rounded-full hover:bg-white/[0.06]"
            onClick={() => rotateCards(-1)}
            type="button"
          >
            <ChevronDownIcon className="size-[16px] rotate-90" />
          </button>
          <button
            aria-label="下一组灵感"
            className="grid size-[30px] place-items-center rounded-full hover:bg-white/[0.06]"
            onClick={() => rotateCards(1)}
            type="button"
          >
            <ChevronDownIcon className="size-[16px] -rotate-90" />
          </button>
        </div>
      </div>
      <div className="flex gap-[12px] overflow-hidden">
        <AnimatePresence mode="popLayout">
          {orderedCards.map((card, index) => (
          <motion.article
            animate={{ opacity: 1, x: 0 }}
            className="h-[250px] w-[308px] shrink-0 overflow-hidden rounded-[14px] border border-white/[0.10] bg-[#191a1d] shadow-[0_18px_70px_-38px_rgba(0,0,0,0.95)]"
            exit={{ opacity: 0, x: -18 }}
            initial={{ opacity: 0, x: 18 }}
            key={`${card.id}-${index}`}
            layout
            style={{ position: "relative" }}
            transition={{ ...popoverTransition, delay: index * 0.015 }}
          >
            <InspirationPreview accent={card.accent} kind={card.kind} />
            <div className="px-[20px] py-[14px]">
              <h3 className="truncate text-[17px] font-semibold text-[#e8eaed]">{card.title}</h3>
              <p className="mt-[5px] truncate text-[13px] text-[#9aa0a6]">{card.subtitle}</p>
            </div>
            <button
              aria-label={`使用模板：${card.title}`}
              className="absolute inset-0 z-10 rounded-[14px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[#8b80ff]"
              onClick={() => onSelectTemplate(card)}
              type="button"
            />
          </motion.article>
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

function InspirationPreview({
  accent,
  kind,
}: {
  accent: string;
  kind: "marketplace" | "packing" | "profile";
}) {
  if (kind === "packing") {
    return (
      <div className="relative h-[178px] w-full overflow-hidden bg-[#07080d] p-[18px] text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(99,102,241,0.34),transparent_32%),radial-gradient(circle_at_82%_12%,rgba(14,165,233,0.24),transparent_30%)]" />
        <div className="relative h-full rounded-[20px] border border-white/[0.10] bg-black/55 p-[16px]">
          <div className="mb-[18px] flex items-center justify-between">
            <span className="h-[8px] w-[118px] rounded-full bg-white/78" />
            <span className="h-[18px] w-[58px] rounded-full bg-white/12" />
          </div>
          <div className="grid h-[92px] grid-cols-[0.92fr_1fr] gap-[14px]">
            <div className="rounded-[18px] bg-[linear-gradient(135deg,#111827,#374151)] p-[14px]">
              <span className="mb-[24px] block h-[8px] w-[86px] rounded-full bg-white/70" />
              <span className="block h-[28px] rounded-full bg-[#f8fafc]" />
            </div>
            <div className="grid grid-cols-2 gap-[10px]">
              {["#6b7280", "#1f2937", "#e5e7eb", "#374151"].map((color) => (
                <span className="rounded-[16px]" key={color} style={{ backgroundColor: color }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (kind === "profile") {
    return (
      <div className="relative h-[178px] w-full overflow-hidden bg-[#d8d2c5] p-[18px] text-[#171717]">
        <div className="absolute inset-x-[34px] bottom-[-26px] h-[120px] rounded-t-[18px] bg-white shadow-[0_24px_70px_-28px_rgba(0,0,0,0.5)]" />
        <div className="relative mx-auto mt-[28px] h-[112px] w-[318px] rounded-[10px] bg-[#f7f6f2] p-[14px] shadow-[0_20px_60px_-30px_rgba(0,0,0,0.55)]">
          <div className="mb-[12px] flex items-center justify-between">
            <span className="h-[8px] w-[120px] rounded-full bg-[#1f2937]" />
            <span className="h-[8px] w-[48px] rounded-full bg-[#c2bbad]" />
          </div>
          <div className="grid grid-cols-[0.74fr_1fr] gap-[12px]">
            <div className="h-[64px] rounded-[14px] bg-[#111827]" />
            <div className="space-y-[9px]">
              <span className="block h-[8px] w-[128px] rounded-full bg-[#111827]/80" />
              <span className="block h-[8px] w-[98px] rounded-full bg-[#9ca3af]" />
              <span className="block h-[28px] w-[148px] rounded-full bg-[#111827]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[178px] w-full overflow-hidden p-[18px] text-[#111827]" style={{ backgroundColor: accent }}>
      <div className="absolute inset-x-[46px] bottom-[-30px] h-[122px] rounded-t-[18px] bg-white shadow-[0_24px_70px_-28px_rgba(0,0,0,0.45)]" />
      <div className="relative mx-auto mt-[22px] h-[116px] w-[318px] rounded-[10px] bg-white p-[14px] shadow-[0_20px_60px_-30px_rgba(0,0,0,0.5)]">
        <div className="mb-[14px] flex items-center justify-between">
          <span className="h-[7px] w-[44px] rounded-full bg-[#eab308]" />
          <span className="h-[7px] w-[46px] rounded-full bg-[#111827]" />
        </div>
        <div className="mb-[12px] h-[9px] w-[154px] rounded-full bg-[#111827]" />
        <div className="mb-[10px] h-[7px] w-[118px] rounded-full bg-[#64748b]" />
        <div className="grid grid-cols-[0.9fr_1fr] gap-[12px]">
          <div className="h-[46px] rounded-[12px] bg-[#eef2f7]" />
          <div className="space-y-[7px]">
            <span className="block h-[6px] w-[124px] rounded-full bg-[#94a3b8]" />
            <span className="block h-[6px] w-[94px] rounded-full bg-[#cbd5e1]" />
            <span className="block h-[16px] w-[106px] rounded-full bg-[#111827]" />
          </div>
        </div>
      </div>
    </div>
  );
}
