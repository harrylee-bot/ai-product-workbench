"use client";

import type {
  ExportPreviewTokenResponse,
} from "@workbench/workbench-contracts";
import { motion } from "framer-motion";
import {
  ExpandIcon,
  ExternalLinkIcon,
  MonitorIcon,
  QrCodeIcon,
  RectangleHorizontalIcon,
  RefreshCwIcon,
  Settings2Icon,
  SmartphoneIcon,
  TabletIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  normalizePreviewCustomViewport,
  resolvePreviewViewport,
  type PreviewCustomViewport,
  type PreviewDeviceMode,
} from "@/lib/workbench/features/preview-device";
import {
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "@/lib/workbench/project-session";
import type { WorkbenchArtifactReference } from "./workbench-artifact-content";
import {
  WorkbenchIsolatedPreview,
  type WorkbenchPreviewRequest,
} from "./workbench-isolated-preview";
import { popoverTransition, workbenchEase } from "./workbench-motion";

type WorkbenchPreviewCreator = (
  request: WorkbenchPreviewRequest,
  signal?: AbortSignal,
) => Promise<ExportPreviewTokenResponse>;

const previewDeviceOptions: ReadonlyArray<{
  mode: PreviewDeviceMode;
  label: string;
  icon: LucideIcon;
}> = [
  { mode: "mobile", label: "手机", icon: SmartphoneIcon },
  { mode: "phone-landscape", label: "横屏", icon: RectangleHorizontalIcon },
  { mode: "tablet", label: "平板", icon: TabletIcon },
  { mode: "desktop", label: "桌面", icon: MonitorIcon },
  { mode: "responsive", label: "响应式", icon: ExpandIcon },
  { mode: "custom", label: "自定义", icon: Settings2Icon },
];

export function ProjectPreviewOverlay({
  artifacts,
  createPreview,
  initialReference,
  onClose,
  projectId,
  projectTitle,
}: {
  artifacts: Array<{ reference: WorkbenchArtifactReference; title: string }>;
  createPreview: WorkbenchPreviewCreator;
  initialReference?: WorkbenchArtifactReference;
  onClose: () => void;
  projectId: string;
  projectTitle: string;
}) {
  const initialIndex = Math.max(
    0,
    artifacts.findIndex((artifact) => (
      artifact.reference.artifactId === initialReference?.artifactId
      && artifact.reference.artifactVersionId === initialReference.artifactVersionId
      && artifact.reference.screenId === initialReference.screenId
    )),
  );
  const session = useWorkbenchProjectSession(projectId);
  const [screenIndex, setScreenIndex] = useWorkbenchProjectState(session, () => initialIndex);
  const [refreshKey, setRefreshKey] = useWorkbenchProjectState(session, () => 0);
  const [deviceMode, setDeviceMode] = useWorkbenchProjectState<PreviewDeviceMode>(
    session,
    () => "mobile",
  );
  const [customViewport, setCustomViewport] = useWorkbenchProjectState<PreviewCustomViewport>(
    session,
    () => ({ width: 1_024, height: 768 }),
  );
  const [previewCapability, setPreviewCapability] = useWorkbenchProjectState<ExportPreviewTokenResponse | null>(
    session,
    () => null,
  );
  const screenTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedArtifact = artifacts[screenIndex] ?? artifacts[0];

  const selectScreenFromKeyboard = (index: number) => {
    if (artifacts.length === 0) return;
    const nextIndex = (index + artifacts.length) % artifacts.length;
    setScreenIndex(nextIndex);
    const tab = screenTabRefs.current[nextIndex];
    tab?.focus();
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  useEffect(() => {
    setScreenIndex((current) => Math.min(current, Math.max(artifacts.length - 1, 0)));
  }, [artifacts.length, setScreenIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <motion.div
      animate={{ opacity: 1 }}
      aria-label="项目预览"
      aria-modal="true"
      className="absolute inset-0 z-[120] bg-[#111214] text-[#f1f3f4]"
      data-project-preview
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      role="dialog"
      transition={{ duration: 0.18, ease: workbenchEase }}
    >
      <motion.header
        animate={{ opacity: 1, y: 0 }}
        className="absolute inset-x-0 top-0 z-20 grid h-[58px] grid-cols-[minmax(0,1fr)_minmax(240px,42vw)_minmax(0,1fr)] items-center gap-x-[16px] border-b border-white/[0.08] bg-[#18191b]/96 px-[18px] shadow-[0_10px_34px_-28px_rgba(0,0,0,0.95)] backdrop-blur-xl max-lg:h-[104px] max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:grid-rows-[46px_46px] max-lg:gap-x-[12px] max-lg:px-[12px] max-lg:py-[6px]"
        data-preview-header
        initial={{ opacity: 0, y: -8 }}
        transition={{ ...popoverTransition, delay: 0.05 }}
      >
        <div
          className="flex min-w-0 items-center gap-[12px] max-lg:col-start-1 max-lg:row-start-1"
          data-preview-project
        >
          <button
            aria-label="退出预览"
            className="grid size-[34px] shrink-0 place-items-center rounded-full text-[#d8dce2] transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8] active:scale-95"
            onClick={onClose}
            title="退出预览"
            type="button"
          >
            <XIcon className="size-[19px]" />
          </button>
          <div className="h-[22px] w-px bg-white/[0.10]" />
          <div className="min-w-0">
            <div className="max-w-[240px] truncate text-[14px] font-semibold max-md:max-w-[140px]">
              {projectTitle}
            </div>
            <div className="mt-[1px] text-[11px] text-[#989da5]">交互预览</div>
          </div>
        </div>

        <nav
          aria-label="预览页面"
          className="min-w-0 max-w-full overflow-x-auto rounded-[6px] border border-white/[0.09] bg-[#222326] [scrollbar-width:thin] max-lg:col-span-2 max-lg:col-start-1 max-lg:row-start-2 max-lg:w-full"
          data-preview-screen-navigation
        >
          <div
            aria-label="预览页面"
            aria-orientation="horizontal"
            className="mx-auto flex w-max min-w-full items-center justify-center gap-[3px] p-[3px]"
            data-preview-screen-tabs
            role="tablist"
          >
            {artifacts.map((artifact, index) => (
              <button
                aria-selected={screenIndex === index}
                className={cn(
                  "h-[30px] max-w-[220px] shrink-0 rounded-[4px] px-[12px] text-[12px] font-semibold transition-colors focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8ab4f8]",
                  screenIndex === index
                    ? "bg-[#4b4d52] text-white"
                    : "text-[#aeb3bb] hover:bg-white/[0.05] hover:text-[#e8eaed]",
                )}
                key={`${artifact.reference.artifactId}:${artifact.reference.artifactVersionId}:${artifact.reference.screenId ?? index}`}
                onClick={() => setScreenIndex(index)}
                onKeyDown={(event) => {
                  let targetIndex: number | null = null;
                  if (event.key === "ArrowRight") targetIndex = index + 1;
                  if (event.key === "ArrowLeft") targetIndex = index - 1;
                  if (event.key === "Home") targetIndex = 0;
                  if (event.key === "End") targetIndex = artifacts.length - 1;
                  if (targetIndex === null) return;
                  event.preventDefault();
                  selectScreenFromKeyboard(targetIndex);
                }}
                ref={(element) => {
                  screenTabRefs.current[index] = element;
                }}
                role="tab"
                tabIndex={screenIndex === index ? 0 : -1}
                title={artifact.title}
                type="button"
              >
                <span className="block truncate">{artifact.title}</span>
              </button>
            ))}
          </div>
        </nav>

        <div
          aria-label="预览操作"
          className="flex items-center justify-self-end gap-[8px] max-lg:col-start-2 max-lg:row-start-1"
          data-preview-actions
          role="group"
        >
          <PreviewQrPopover capability={previewCapability} />
          <button
            aria-label="刷新预览"
            className="grid size-[34px] place-items-center rounded-[6px] border border-white/[0.09] bg-[#222326] text-[#d8dce2] transition hover:bg-[#303136] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8] active:scale-95"
            onClick={() => setRefreshKey((key) => key + 1)}
            title="刷新预览"
            type="button"
          >
            <motion.span animate={{ rotate: refreshKey * 360 }} transition={{ duration: 0.45, ease: workbenchEase }}>
              <RefreshCwIcon className="size-[16px]" />
            </motion.span>
          </button>
          <button
            className="h-[34px] rounded-[6px] bg-[#e8eaed] px-[15px] text-[13px] font-semibold text-[#202124] transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8] active:scale-[0.98] max-md:hidden"
            onClick={onClose}
            type="button"
          >
            返回编辑
          </button>
        </div>
      </motion.header>

      <div
        className="absolute inset-x-0 bottom-0 top-[58px] overflow-hidden bg-[#202124] max-lg:top-[104px]"
        data-preview-body
      >
        <div className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle,#4a4d52_1px,transparent_1px)] [background-size:14px_14px]" />
        <PreviewDeviceControls
          customViewport={customViewport}
          mode={deviceMode}
          onCustomViewportChange={setCustomViewport}
          onModeChange={setDeviceMode}
        />
        <PreviewViewport
          createPreview={createPreview}
          customViewport={customViewport}
          mode={deviceMode}
          onCapabilityChange={setPreviewCapability}
          projectId={projectId}
          refreshKey={refreshKey}
          selectedArtifact={selectedArtifact}
        />
      </div>
    </motion.div>
  );
}

function PreviewDeviceControls({
  customViewport,
  mode,
  onCustomViewportChange,
  onModeChange,
}: {
  customViewport: PreviewCustomViewport;
  mode: PreviewDeviceMode;
  onCustomViewportChange: (value: PreviewCustomViewport) => void;
  onModeChange: (mode: PreviewDeviceMode) => void;
}) {
  return (
    <div
      className="absolute inset-x-[12px] top-[12px] z-10 min-h-[40px] overflow-x-auto [scrollbar-width:thin]"
      data-preview-device-controls
    >
      <div className="mx-auto flex w-max min-w-full items-center justify-center gap-[10px]">
        <div
          aria-label="预览设备"
          aria-orientation="horizontal"
          className="flex shrink-0 items-center gap-[2px] rounded-[6px] border border-white/[0.10] bg-[#18191b]/95 p-[3px] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.95)] backdrop-blur-xl"
          role="toolbar"
        >
          {previewDeviceOptions.map((option) => {
            const Icon = option.icon;
            return (
              <button
                aria-label={option.label}
                aria-pressed={mode === option.mode}
                className={cn(
                  "flex h-[32px] shrink-0 items-center gap-[6px] rounded-[4px] px-[9px] text-[11px] font-medium transition-colors focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#8ab4f8]",
                  mode === option.mode
                    ? "bg-[#4b4d52] text-white"
                    : "text-[#aeb3bb] hover:bg-white/[0.06] hover:text-white",
                )}
                key={option.mode}
                onClick={() => onModeChange(option.mode)}
                title={option.label}
                type="button"
              >
                <Icon className="size-[15px]" />
                <span className="max-md:hidden">{option.label}</span>
              </button>
            );
          })}
        </div>
        {mode === "custom" && (
          <div className="flex shrink-0 items-center gap-[6px] rounded-[6px] border border-white/[0.10] bg-[#18191b]/95 px-[8px] py-[4px]">
            <PreviewDimensionInput
              ariaLabel="自定义预览宽度"
              onChange={(width) => onCustomViewportChange(normalizePreviewCustomViewport({
                ...customViewport,
                width,
              }))}
              value={customViewport.width}
            />
            <span className="text-[11px] text-[#747982]">x</span>
            <PreviewDimensionInput
              ariaLabel="自定义预览高度"
              onChange={(height) => onCustomViewportChange(normalizePreviewCustomViewport({
                ...customViewport,
                height,
              }))}
              value={customViewport.height}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewDimensionInput({
  ariaLabel,
  onChange,
  value,
}: {
  ariaLabel: string;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <input
      aria-label={ariaLabel}
      className="h-[28px] w-[64px] rounded-[4px] border border-white/[0.09] bg-[#24262a] px-[7px] text-right text-[11px] text-white outline-none focus:border-[#8ab4f8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#8ab4f8]"
      inputMode="numeric"
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      type="number"
      value={value}
    />
  );
}

function PreviewViewport({
  createPreview,
  customViewport,
  mode,
  onCapabilityChange,
  projectId,
  refreshKey,
  selectedArtifact,
}: {
  createPreview: WorkbenchPreviewCreator;
  customViewport: PreviewCustomViewport;
  mode: PreviewDeviceMode;
  onCapabilityChange: (capability: ExportPreviewTokenResponse | null) => void;
  projectId: string;
  refreshKey: number;
  selectedArtifact?: { reference: WorkbenchArtifactReference; title: string };
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 1_180, height: 780 });

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      setAvailable({
        width: Math.max(1, bounds.width - 24),
        height: Math.max(1, bounds.height - 24),
      });
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewport = resolvePreviewViewport(mode, customViewport, available);
  return (
    <div
      className="absolute inset-x-[12px] bottom-[12px] top-[64px] grid place-items-center overflow-hidden"
      data-preview-stage
      ref={stageRef}
    >
      <motion.div
        animate={{ opacity: 1, scale: 1 }}
        className="relative overflow-hidden rounded-[6px] border border-white/[0.12] bg-[#111827] shadow-[0_30px_100px_-38px_rgba(0,0,0,0.98)]"
        data-preview-device={mode}
        data-preview-height={viewport.height}
        data-preview-scale={viewport.scale}
        data-preview-width={viewport.width}
        initial={{ opacity: 0, scale: 0.985 }}
        style={{
          width: viewport.renderedWidth,
          height: viewport.renderedHeight,
        }}
        transition={{ duration: 0.24, ease: workbenchEase }}
      >
        <div
          className="absolute left-0 top-0 overflow-hidden bg-[#111827]"
          style={{
            width: viewport.width,
            height: viewport.height,
            transform: `scale(${String(viewport.scale)})`,
            transformOrigin: "top left",
          }}
        >
          {selectedArtifact ? (
            <WorkbenchIsolatedPreview
              createPreview={createPreview}
              onCapabilityChange={onCapabilityChange}
              refreshKey={refreshKey}
              request={{
                initialScreenId: selectedArtifact.reference.screenId ?? null,
                selection: {
                  kind: "artifact",
                  artifactId: selectedArtifact.reference.artifactId,
                  artifactVersionId: selectedArtifact.reference.artifactVersionId,
                },
              }}
              sessionKey={projectId}
              title={`${selectedArtifact.title} 预览`}
            />
          ) : (
            <div className="grid h-full w-full place-items-center px-[24px] text-center text-[14px] text-[#aeb3bb]">
              暂无可预览内容
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function PreviewQrPopover({
  capability,
}: {
  capability: ExportPreviewTokenResponse | null;
}) {
  const available = Boolean(capability && Date.parse(capability.expiresAt) > Date.now());
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          aria-label="二维码预览"
          className="grid size-[34px] place-items-center rounded-[6px] border border-white/[0.09] bg-[#222326] text-[#d8dce2] transition enabled:hover:bg-[#303136] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8ab4f8] enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!available}
          title={available ? "二维码预览" : "预览准备完成后可用"}
          type="button"
        >
          <QrCodeIcon className="size-[16px]" />
        </button>
      </Popover.Trigger>
      {available && capability && (
        <Popover.Portal>
          <Popover.Content
            align="end"
            className="z-[180] w-[232px] rounded-[6px] border border-black/10 bg-white p-[12px] text-[#202124] shadow-[0_24px_80px_-28px_rgba(0,0,0,0.7)]"
            sideOffset={8}
          >
            <div className="rounded-[4px] bg-white p-[8px]" data-preview-qr>
              <QRCodeSVG
                bgColor="#ffffff"
                fgColor="#111214"
                level="M"
                size={184}
                title="短期预览二维码"
                value={capability.url}
              />
            </div>
            <div className="mt-[8px] flex items-center justify-between gap-[8px] text-[11px] text-[#6f747c]">
              <span>{formatCapabilityExpiry(capability.expiresAt)}</span>
              <a
                aria-label="在新窗口打开预览"
                className="grid size-[26px] place-items-center rounded-[4px] text-[#4b4f56] hover:bg-black/[0.06] hover:text-black"
                href={capability.url}
                rel="noreferrer"
                target="_blank"
                title="在新窗口打开预览"
              >
                <ExternalLinkIcon className="size-[14px]" />
              </a>
            </div>
            <Popover.Arrow className="fill-white" />
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );
}

function formatCapabilityExpiry(expiresAt: string) {
  const value = new Date(expiresAt);
  if (Number.isNaN(value.getTime())) return "短期有效";
  return `有效至 ${value.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}
