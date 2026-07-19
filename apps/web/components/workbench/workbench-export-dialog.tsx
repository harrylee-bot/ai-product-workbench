"use client";

import type {
  ExternalExportDelivery,
  ExportCapabilities,
  ExportJob,
  ExportSelection,
} from "@workbench/workbench-contracts";
import { AnimatePresence, motion } from "framer-motion";
import {
  BotIcon,
  CheckCircle2Icon,
  ClipboardIcon,
  CloudUploadIcon,
  Code2Icon,
  DownloadIcon,
  Grid3X3Icon,
  RefreshCwIcon,
  StarsIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ComponentType, type SVGProps } from "react";

import { cn } from "@/lib/utils";
import {
  exportSelectionsEqual,
  exportTargetAvailability,
  exportTargetDescriptor,
  exportTargetForExternalDelivery,
  exportTargetForFormat,
  type WorkbenchExportTarget,
} from "@/lib/workbench/features";
import { drawerTransition } from "./workbench-motion";

export function ExportDialog({
  activeExport,
  activeExportSelection,
  activeExternalDelivery,
  busy,
  capabilities,
  capabilitiesError,
  capabilitiesPending,
  error,
  hasSelection,
  onCancelExport,
  onCancelExternalDelivery,
  onConfirmExternalDelivery,
  onCopyCode,
  onDownload,
  onOpenChange,
  onPrepareExternalDelivery,
  onRetryCapabilities,
  onRetryExternalDelivery,
  onSelectAll,
  onStartExport,
  open,
  selection,
}: {
  activeExport: ExportJob | null;
  activeExportSelection: ExportSelection | null;
  activeExternalDelivery: ExternalExportDelivery | null;
  busy: boolean;
  capabilities: ExportCapabilities | null;
  capabilitiesError: unknown;
  capabilitiesPending: boolean;
  error: unknown;
  hasSelection: boolean;
  onCancelExport: () => Promise<unknown>;
  onCancelExternalDelivery: (target: WorkbenchExportTarget) => Promise<unknown>;
  onConfirmExternalDelivery: (target: WorkbenchExportTarget) => Promise<unknown>;
  onCopyCode: () => Promise<void>;
  onDownload: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onPrepareExternalDelivery: (target: WorkbenchExportTarget) => Promise<ExternalExportDelivery>;
  onRetryCapabilities: () => Promise<unknown>;
  onRetryExternalDelivery: (target: WorkbenchExportTarget) => Promise<unknown>;
  onSelectAll: () => void;
  onStartExport: (target: WorkbenchExportTarget, selection: ExportSelection) => Promise<ExportJob>;
  open: boolean;
  selection: ExportSelection;
}) {
  const [selectedTarget, setSelectedTarget] = useState<WorkbenchExportTarget>("Download .zip");
  const exportTargets: Array<{
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    label: WorkbenchExportTarget;
    meta: string;
  }> = [
    { icon: StarsIcon, label: "AI Studio", meta: "发布到 AI Studio" },
    { icon: Grid3X3Icon, label: "Figma", meta: "下载 Figma 导入包" },
    { icon: BotIcon, label: "MCP", meta: "下载 MCP 资源包" },
    { icon: CloudUploadIcon, label: "Netlify", meta: "部署到 Netlify" },
    { icon: CloudUploadIcon, label: "Lovable", meta: "发送到 Lovable" },
    { icon: CloudUploadIcon, label: "Bolt", meta: "发送到 Bolt" },
    { icon: DownloadIcon, label: "Download .zip", meta: "下载离线 HTML 包" },
    { icon: ClipboardIcon, label: "Copy code", meta: "复制单文件 HTML" },
    { icon: Code2Icon, label: "React", meta: "下载 React 工程" },
  ];

  useEffect(() => {
    if (!open) setSelectedTarget("Download .zip");
  }, [open]);

  const restoredTarget = open
    && activeExport
    && activeExportSelection
    && exportSelectionsEqual(activeExportSelection, selection)
    ? activeExternalDelivery?.exportJobId === activeExport.id
      ? exportTargetForExternalDelivery(activeExternalDelivery.target)
      : exportTargetForFormat(activeExport.format, activeExport.packaging)
    : null;

  useEffect(() => {
    if (restoredTarget) setSelectedTarget(restoredTarget);
  }, [restoredTarget]);

  const descriptor = exportTargetDescriptor(selectedTarget);
  const activeExportMatches = activeExport?.format === descriptor.format
    && activeExport.packaging === descriptor.packaging
    && exportSelectionsEqual(activeExportSelection, selection);
  const exportRunning = activeExportMatches
    && (activeExport.status === "queued" || activeExport.status === "running");
  const exportSucceeded = activeExportMatches && activeExport.status === "succeeded";
  const externalDeliveryMatches = descriptor.externalTarget !== null
    && activeExternalDelivery?.target === descriptor.externalTarget
    && activeExternalDelivery.exportJobId === activeExport?.id;
  const selectionTitle = selection.kind === "artifact"
    ? "当前产物版本"
    : selection.kind === "board_nodes" ? "当前选择" : "当前项目画布";
  const selectionMeta = selection.kind === "artifact"
    ? "已固定 1 个产物版本"
    : selection.kind === "board_nodes"
      ? `已固定 ${selection.nodeIds.length} 个画布节点`
      : "按当前画布选择范围导出";
  const exportButtonLabel = busy
    ? exportRunning ? `正在取消 ${selectedTarget}...` : "正在发布当前版本..."
    : externalDeliveryMatches && activeExternalDelivery?.status === "pending_confirmation"
      ? `确认发布至 ${selectedTarget}`
      : externalDeliveryMatches && activeExternalDelivery?.status === "cancelling"
        ? `正在取消 ${selectedTarget}...`
        : externalDeliveryMatches && (activeExternalDelivery?.status === "queued" || activeExternalDelivery?.status === "running")
          ? `取消发布 ${selectedTarget}`
          : externalDeliveryMatches && activeExternalDelivery?.status === "failed"
            ? `重试发布 ${selectedTarget}`
            : externalDeliveryMatches && activeExternalDelivery?.status === "succeeded"
              ? `已发布至 ${selectedTarget}`
              : exportRunning
                ? `取消导出 ${selectedTarget}`
                : exportSucceeded
                  ? descriptor.delivery === "clipboard"
                    ? "复制代码"
                    : descriptor.delivery === "external"
                      ? `准备发布至 ${selectedTarget}`
                      : `下载 ${selectedTarget}`
                  : error || (activeExportMatches && activeExport.status === "failed")
                    ? `重试导出 ${selectedTarget}`
                    : descriptor.delivery === "external"
                      ? `生成并准备 ${selectedTarget}`
                      : `导出 ${selectedTarget}`;

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          animate={{ opacity: 1, scale: 1, x: 0 }}
          aria-label="导出"
          className="workbench-dialog-panel fixed bottom-[80px] right-[72px] top-[80px] z-50 flex w-[280px] max-w-[calc(100vw-88px)] origin-top-right flex-col overflow-hidden rounded-[24px] border border-white/[0.12] bg-[#1c1d1f] text-[#e8eaed] shadow-[0_20px_58px_-32px_rgba(0,0,0,0.72)] max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:rounded-none"
          data-export-state={hasSelection ? "selected" : "empty"}
          data-workbench-global-panel
          data-workbench-export-panel
          exit={{ opacity: 0, scale: 0.994, x: 18 }}
          initial={{ opacity: 0, scale: 0.994, x: 18 }}
          transition={drawerTransition}
        >
          <div className="flex h-[56px] shrink-0 items-center justify-between px-[20px]">
            <h2 className="text-[14px] font-semibold leading-none">导出</h2>
            <button
              aria-label="Close"
              className="grid size-[28px] place-items-center rounded-full text-[#c7cad0] hover:bg-white/[0.06]"
              onClick={() => onOpenChange(false)}
              type="button"
            >
              <XIcon className="size-[17px]" />
            </button>
          </div>
          {hasSelection ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto px-[14px] pb-[12px] pt-[8px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="mb-[14px] rounded-[12px] border border-white/[0.10] bg-[#222327] p-[10px]">
                  <div className="mb-[8px] flex items-center gap-[9px]">
                    <span className="grid size-[28px] place-items-center rounded-[8px] bg-[#c9b3ff] text-[#241832]">
                      <Grid3X3Icon className="size-[15px]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-[#f1f3f4]">{selectionTitle}</span>
                      <span className="mt-[1px] block text-[10px] text-[#aeb3bb]">{selectionMeta}</span>
                    </span>
                  </div>
                  <div className="flex h-[60px] gap-[8px] rounded-[8px] bg-[#101114] p-[6px]">
                    <span className="flex-1 rounded-[6px] bg-[#111827]" />
                    <span className="flex-1 rounded-[6px] bg-[linear-gradient(135deg,#8274ef,#62d1df)]" />
                  </div>
                </div>
                <div className="mb-[8px] text-[11px] font-semibold text-[#aeb3bb]">导出至</div>
                {Boolean(capabilitiesError) && (
                  <button
                    className="mb-[8px] flex h-[30px] w-full items-center justify-center gap-[7px] rounded-[8px] border border-[#ef8c8c]/25 bg-[#ef8c8c]/10 text-[10px] font-semibold text-[#f2a7a7] hover:bg-[#ef8c8c]/15"
                    onClick={() => void onRetryCapabilities().catch(() => undefined)}
                    type="button"
                  >
                    <RefreshCwIcon className="size-[12px]" />
                    导出能力检查失败，重试
                  </button>
                )}
                <div className="space-y-[7px]">
                  {exportTargets.map((target) => {
                    const Icon = target.icon;
                    const active = selectedTarget === target.label;
                    const availability = capabilitiesError
                      ? { available: false, reason: "导出能力检查失败" }
                      : exportTargetAvailability(capabilities, target.label);
                    return (
                      <button
                        aria-pressed={active}
                        aria-disabled={!availability.available}
                        className={cn(
                          "flex h-[46px] w-full items-center gap-[9px] rounded-[10px] border px-[10px] text-left transition-colors",
                          active
                            ? "border-[#bfa7ff]/70 bg-[#3a2d4b]/82 text-[#f1f3f4]"
                            : "border-white/[0.08] bg-[#242528]/82 text-[#e8eaed] hover:bg-[#2b2d31]/90",
                          !availability.available && "cursor-not-allowed opacity-50",
                        )}
                        disabled={!availability.available || capabilitiesPending}
                        key={target.label}
                        onClick={() => setSelectedTarget(target.label)}
                        type="button"
                      >
                        <span className={cn(
                          "grid size-[28px] shrink-0 place-items-center rounded-full",
                          active ? "bg-[#c9b3ff] text-[#241832]" : "bg-[#34363a] text-[#d8dce2]",
                        )}>
                          <Icon className="size-[14px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-semibold">{target.label}</span>
                          <span className="mt-[1px] block truncate text-[10px] text-[#aeb3bb]">{availability.reason ?? target.meta}</span>
                        </span>
                        {active && <CheckCircle2Icon className="size-[14px] shrink-0 text-[#d8dce2]" />}
                      </button>
                    );
                  })}
                </div>
                {externalDeliveryMatches && activeExternalDelivery?.status === "pending_confirmation" && (
                  <div className="mt-[10px] border-t border-white/[0.10] pt-[10px]" data-external-delivery-confirmation>
                    <div className="text-[11px] font-semibold text-[#e8eaed]">即将传输</div>
                    <div className="mt-[6px] space-y-[3px] text-[10px] leading-[15px] text-[#aeb3bb]">
                      <div>{externalSelectionSummary(activeExternalDelivery.payload.selection)}</div>
                      <div>{activeExternalDelivery.payload.format} / {activeExternalDelivery.payload.packaging}</div>
                      <div>{activeExternalDelivery.payload.output.fileName}</div>
                      <div>{formatBytes(activeExternalDelivery.payload.output.byteSize)} · {activeExternalDelivery.payload.output.sha256.slice(0, 12)}</div>
                    </div>
                  </div>
                )}
              </div>
              <div className="border-t border-white/[0.12] p-[12px]">
                <button
                  className="h-[32px] w-full rounded-full bg-[#c9b3ff] text-[12px] font-semibold text-[#241832]"
                  disabled={busy || (externalDeliveryMatches && (
                    activeExternalDelivery?.status === "succeeded"
                    || activeExternalDelivery?.status === "cancelling"
                  ))}
                  onClick={() => {
                    let operation: Promise<unknown>;
                    if (externalDeliveryMatches && activeExternalDelivery?.status === "pending_confirmation") {
                      operation = onConfirmExternalDelivery(selectedTarget);
                    } else if (externalDeliveryMatches && (activeExternalDelivery?.status === "queued" || activeExternalDelivery?.status === "running")) {
                      operation = onCancelExternalDelivery(selectedTarget);
                    } else if (externalDeliveryMatches && activeExternalDelivery?.status === "failed") {
                      operation = onRetryExternalDelivery(selectedTarget);
                    } else if (exportRunning) {
                      operation = onCancelExport();
                    } else if (exportSucceeded && descriptor.delivery === "clipboard") {
                      operation = onCopyCode();
                    } else if (exportSucceeded && descriptor.delivery === "external") {
                      operation = onPrepareExternalDelivery(selectedTarget);
                    } else if (exportSucceeded) {
                      operation = onDownload();
                    } else {
                      operation = onStartExport(selectedTarget, selection);
                    }
                    void operation.catch(() => undefined);
                  }}
                  type="button"
                >
                  {exportButtonLabel}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex min-h-0 flex-1 -translate-y-[10px] flex-col items-center justify-center px-[28px] text-center">
                <div className="mb-[16px] grid size-[72px] place-items-center rounded-[18px] border border-white/[0.08] bg-[#202124]">
                  <span className="block size-[32px] rounded-[7px] border-2 border-dashed border-[#d8dce2]" />
                </div>
                <h3 className="mb-[10px] text-[16px] font-semibold text-[#f1f3f4]">未选择任何界面</h3>
                <p className="mb-[49px] whitespace-normal text-[12px] leading-[18px] text-[#9aa0a6]">
                  在画布上选择界面以查看导出选项。
                </p>
                <div className="text-[10px] text-[#8f949c]">
                  <div className="mb-[20px]">快捷提示</div>
                  <button
                    className="mb-[5px] text-[12px] font-semibold text-[#f1f3f4]"
                    onClick={onSelectAll}
                    type="button"
                  >
                    全选
                  </button>
                  <div>
                    按 <span className="rounded-[5px] border border-white/[0.12] bg-[#2b2c30] px-[6px] py-[2px] font-mono text-[11px] text-[#d8dce2]">⌘ + A</span>
                  </div>
                </div>
              </div>
              <div className="border-t border-white/[0.12] p-[12px]">
                <button
                  className="h-[32px] w-full rounded-full border border-[#313234] bg-[#242625] text-[12px] font-semibold text-[#969799]"
                  disabled
                  type="button"
                >
                  导出
                </button>
              </div>
            </>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function formatBytes(byteSize: number) {
  if (byteSize < 1_024) return `${byteSize} B`;
  if (byteSize < 1_024 * 1_024) return `${(byteSize / 1_024).toFixed(1)} KB`;
  return `${(byteSize / (1_024 * 1_024)).toFixed(1)} MB`;
}

function externalSelectionSummary(selection: ExportSelection) {
  if (selection.kind === "board_nodes") return `画布节点 ${selection.nodeIds.length} 个`;
  if (selection.kind === "artifact") return selection.screenId ? "产物界面 1 个" : "产物版本 1 个";
  if (selection.kind === "release") return "项目发布版本";
  return "项目画布";
}
