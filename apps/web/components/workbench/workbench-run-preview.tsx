"use client";

import {
  ArrowUpIcon,
  CheckCircle2Icon,
  PaletteIcon,
  PaperclipIcon,
  PlusIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { Run } from "@workbench/workbench-contracts";
import { cn } from "@/lib/utils";
import type {
  WorkbenchProjectPhase,
  WorkbenchRunActivityItem,
  WorkbenchRunMessageItem,
} from "@/lib/workbench/features";
import { popoverTransition } from "./workbench-motion";

type Phase = WorkbenchProjectPhase;

export type WorkbenchRunPreviewContextValue = {
  phase: Phase;
  projectTitle: string;
  prompt: string;
  runActivities: readonly WorkbenchRunActivityItem[];
  runMessages: readonly WorkbenchRunMessageItem[];
  runPhaseLabel: string | null;
  runStatus: Run["status"] | null;
};

const WorkbenchRunPreviewContext = createContext<WorkbenchRunPreviewContextValue | null>(null);

export function useWorkbenchRunPreview(): WorkbenchRunPreviewContextValue | null {
  return useContext(WorkbenchRunPreviewContext);
}

export function WorkbenchRunPreviewProvider({
  children,
  phase,
  projectTitle,
  prompt,
  runActivities,
  runMessages,
  runPhaseLabel,
  runStatus,
}: WorkbenchRunPreviewContextValue & { children: ReactNode }) {
  const value = useMemo<WorkbenchRunPreviewContextValue>(() => ({
    phase,
    projectTitle,
    prompt,
    runActivities,
    runMessages,
    runPhaseLabel,
    runStatus,
  }), [
    phase,
    projectTitle,
    prompt,
    runActivities,
    runMessages,
    runPhaseLabel,
    runStatus,
  ]);

  return (
    <WorkbenchRunPreviewContext.Provider value={value}>
      {children}
    </WorkbenchRunPreviewContext.Provider>
  );
}

type MiniWorkbenchRunLogItem = {
  active: boolean;
  id: string;
  label: string;
  meta: string;
};

export function MiniWorkbenchPreview({ phase }: { phase: Phase }) {
  const runPreview = useWorkbenchRunPreview();
  const previewPhase = runPreview?.phase ?? phase;
  const projectTitle = runPreview?.projectTitle.trim() || "未命名项目";
  const prompt = runPreview?.prompt.trim() ?? "";
  const activities = runPreview?.runActivities ?? [];
  const messages = runPreview?.runMessages ?? [];
  const latestActivity = activities.at(-1);
  const latestMessage = messages.at(-1);
  const assistantStatus = runPreview?.runPhaseLabel
    ?? latestActivity?.label
    ?? miniWorkbenchRunStatusCopy(runPreview?.runStatus ?? null, previewPhase);
  const logItems = miniWorkbenchRunLogItems(activities, latestMessage);
  const recordCount = activities.length + messages.length;
  const frameLabel = prompt
    ? `当前请求：${compactWorkbenchRunCopy(prompt)}`
    : latestMessage?.text.trim()
      ? compactWorkbenchRunCopy(latestMessage.text)
      : "等待运行内容";
  const suggestionLabels = [
    previewPhase === "complete" ? "继续优化当前项目" : "继续当前运行",
    latestActivity?.label
      ? compactWorkbenchRunCopy(latestActivity.label)
      : "等待运行活动",
    latestMessage?.text.trim()
      ? compactWorkbenchRunCopy(latestMessage.text)
      : "等待智能体消息",
  ];
  const status =
    previewPhase === "complete"
      ? { icon: "check" as const, label: "界面已生成" }
      : previewPhase === "refining"
        ? { icon: "spin" as const, label: "正在优化界面..." }
        : { icon: "spin" as const, label: "正在生成界面..." };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[10px] bg-[#111214] text-[#e8eaed] shadow-[0_24px_90px_-38px_rgba(0,0,0,0.95)]">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(10,11,12,0.98)_0%,rgba(18,19,21,0.96)_35%,rgba(37,40,43,0.9)_72%,rgba(45,49,50,0.82)_100%)]" />
      <div className="absolute inset-y-0 left-[47%] w-[135px] bg-[linear-gradient(90deg,transparent,rgba(184,203,195,0.13),transparent)] blur-[14px]" />

      <div className="absolute left-[18px] top-[16px] z-20 text-[27px] font-semibold text-[#f1f3f4]">
        {projectTitle}
      </div>

      <aside className="absolute bottom-[95px] left-[34px] top-[88px] z-20 w-[520px] rounded-[18px] border border-white/[0.08] bg-[#141516]/94 p-[28px] shadow-[0_24px_74px_-40px_rgba(0,0,0,0.95)]">
        <div className="mb-[24px] flex items-center gap-[12px] text-[18px] font-semibold uppercase tracking-[0.04em] text-[#68d6d0]">
          <span className="size-[17px] rounded-full bg-[#68d6d0]/80" />
          {assistantStatus}
        </div>
        <div className="mb-[28px] rounded-[18px] border border-white/[0.08] bg-[#202124]/88 p-[20px]">
          <div className="mb-[16px] flex items-center gap-[12px]">
            <span className="grid size-[34px] place-items-center rounded-full bg-[#536a74] text-[13px]">L</span>
            <span className="h-[10px] w-[210px] rounded-full bg-white/70" />
          </div>
          <div className="space-y-[10px]">
            <span className="block h-[7px] w-[410px] rounded-full bg-white/22" />
            <span className="block h-[7px] w-[350px] rounded-full bg-white/16" />
            <span className="block h-[7px] w-[300px] rounded-full bg-white/16" />
          </div>
          <div className="mt-[24px] h-[6px] rounded-full bg-[linear-gradient(90deg,#6fd8d0,#aeb3bb,#f1f3f4)]" />
        </div>
        <div className="mb-[18px] flex items-center justify-between text-[16px] font-semibold uppercase tracking-[0.04em] text-[#d8dce2]">
          <span>智能体日志 (Agent Log)</span>
          <span className="text-[#9aa0a6]">{recordCount > 0 ? `${recordCount} 条` : "等待记录"}</span>
        </div>
        <div className="space-y-[12px]">
          {logItems.map((item) => (
            <motion.div
              animate={{ opacity: item.active ? 1 : 0.55, x: item.active ? 0 : -3 }}
              className={cn("flex h-[48px] items-center gap-[12px] rounded-[12px] px-[14px]", item.active ? "bg-[#232428]" : "bg-transparent")}
              key={item.id}
              transition={popoverTransition}
            >
              <span className={cn("size-[14px] rounded-full border", item.active ? "border-[#63e6f2] bg-[#63e6f2]/20" : "border-white/28")} />
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[#d8dce2]">{item.label}</span>
              <span className="text-[12px] text-[#9aa0a6]">{item.meta}</span>
            </motion.div>
          ))}
        </div>
      </aside>

      <div className="workbench-selection-glow absolute bottom-[95px] left-[595px] right-[70px] top-[88px] z-20 border border-[#7467f6] bg-[#161719]/36 shadow-[0_18px_76px_-36px_rgba(0,0,0,0.95)]">
        <div className="absolute left-[-2px] top-[-24px] rounded-[3px] bg-[#7467f6] px-[10px] py-[3px] text-[12px] font-semibold leading-none text-white">
          {frameLabel}
        </div>
        <div className="absolute inset-y-0 left-[30%] w-[220px] bg-[linear-gradient(90deg,transparent,rgba(184,203,195,0.12),transparent)] blur-[16px]" />
        <AnimatePresence mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="absolute left-1/2 top-1/2 z-30 flex h-[58px] -translate-x-1/2 -translate-y-1/2 items-center gap-[13px] rounded-full bg-[#25262a]/92 px-[28px] text-[20px] font-semibold text-[#f1f3f4] shadow-[0_18px_60px_-30px_rgba(0,0,0,0.95)]"
            exit={{ opacity: 0, y: -3 }}
            initial={{ opacity: 0, y: 3 }}
            key={status.label}
            transition={popoverTransition}
          >
            {status.icon === "spin" ? (
              <span className="size-[19px] animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
            ) : (
              <CheckCircle2Icon className="size-[20px] text-[#b9ffef]" />
            )}
            {status.label}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="absolute bottom-[24px] left-[520px] right-[205px] z-30 h-[145px] rounded-[24px] border border-white/[0.07] bg-[#18191b]/86 px-[22px] py-[18px] shadow-[0_24px_80px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl">
        <div className="mb-[16px] flex gap-[10px]">
          {suggestionLabels.map((label, index) => (
            <span className="h-[34px] max-w-[210px] truncate rounded-full bg-[#25262a] px-[14px] py-[8px] text-[14px] text-[#cfd3da]" key={`${index}:${label}`}>
              {label}
            </span>
          ))}
        </div>
        <div className="flex h-[56px] items-center gap-[20px] text-[#cfd3da]">
          <PlusIcon className="size-[24px]" />
          <span className="text-[28px]">/</span>
          <span className="flex-1 text-[18px] text-[#8d9299]">您想更改或创建什么内容?</span>
          <PaperclipIcon className="size-[21px]" />
          <PaletteIcon className="size-[21px]" />
          <ArrowUpIcon className="size-[24px] text-[#7467f6]" />
        </div>
      </div>
    </div>
  );
}

function miniWorkbenchRunLogItems(
  activities: readonly WorkbenchRunActivityItem[],
  latestMessage: WorkbenchRunMessageItem | undefined,
): MiniWorkbenchRunLogItem[] {
  const activityLimit = latestMessage ? 3 : 4;
  const items = activities.slice(-activityLimit).map((activity) => ({
    active: activity.status !== "pending",
    id: `activity:${activity.id}`,
    label: activity.label,
    meta: miniWorkbenchActivityStatusCopy(activity.status),
  }));

  if (latestMessage) {
    items.push({
      active: true,
      id: `message:${latestMessage.id}`,
      label: latestMessage.text.trim() || "等待智能体消息",
      meta: latestMessage.working ? "生成中" : "已完成",
    });
  }

  const waitingSlots = Array.from({ length: 4 - items.length }, (_, index) => ({
    active: false,
    id: `waiting:${index}`,
    label: items.length === 0 && index === 0 ? "等待运行活动" : "等待更多运行记录",
    meta: "等待",
  }));
  return [...items, ...waitingSlots];
}

function miniWorkbenchActivityStatusCopy(status: WorkbenchRunActivityItem["status"]): string {
  switch (status) {
    case "pending":
      return "等待";
    case "running":
      return "进行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function miniWorkbenchRunStatusCopy(status: Run["status"] | null, phase: Phase): string {
  switch (status) {
    case "queued":
      return "等待执行";
    case "waiting_input":
      return "等待确认";
    case "cancelling":
      return "正在取消";
    case "succeeded":
      return "运行已完成";
    case "failed":
      return "运行失败";
    case "cancelled":
      return "运行已取消";
    case "running":
    default:
      return phase === "complete"
        ? "运行已完成"
        : phase === "refining"
          ? "正在优化界面"
          : phase === "generating"
            ? "正在生成界面"
            : "等待运行";
  }
}

export function compactWorkbenchRunCopy(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
}
