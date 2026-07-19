"use client";

import type { Run, RunGenerationStage } from "@workbench/workbench-contracts";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CopyIcon,
  RefreshCwIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { writeWorkbenchClipboard } from "@/lib/workbench/browser/clipboard";
import type {
  WorkbenchProjectMode,
  WorkbenchProjectPhase,
  WorkbenchRunActivityItem,
  WorkbenchRunMessageItem,
} from "@/lib/workbench/features";
import {
  panelTransition,
  popoverTransition,
  workbenchEase,
} from "./workbench-motion";

export function LeftInspector({
  actionBusy,
  activities,
  canCancel,
  generationProgress,
  generationStage,
  isOverview,
  onCancel,
  onSelectTask,
  phase,
  projectMode,
  prompt,
  runPhaseLabel,
  runStatus,
  selectedTask,
}: {
  actionBusy: boolean;
  activities: WorkbenchRunActivityItem[];
  canCancel: boolean;
  generationProgress: number;
  generationStage: RunGenerationStage | null;
  isOverview: boolean;
  onCancel: () => void;
  onSelectTask: (task: string) => void;
  phase: WorkbenchProjectPhase;
  projectMode: WorkbenchProjectMode;
  prompt: string;
  runPhaseLabel: string | null;
  runStatus: Run["status"] | null;
  selectedTask: string | null;
  zoomLabel: string;
}) {
  const [stackOpen, setStackOpen] = useState(true);
  const [activeTaskVisible, setActiveTaskVisible] = useState(true);
  const currentActivity = [...activities].reverse().find((activity) => activity.working);
  const currentTaskCopy = (runPhaseLabel ?? currentActivity?.label ?? prompt) || "等待任务";
  const historyItems = activities.filter((activity) => activity.terminal);
  const isWorking = runStatus === "queued"
    || runStatus === "running"
    || runStatus === "waiting_input"
    || runStatus === "cancelling";
  const currentTaskWorking = activeTaskVisible && isWorking;
  const effectiveStackOpen = stackOpen && !isOverview;
  const currentTaskHeight = activeTaskVisible ? 38 : 0;
  const historyHeight = historyItems.length > 0 ? historyItems.length * 32 + (historyItems.length - 1) * 4 : 0;
  const taskGap = activeTaskVisible && historyItems.length > 0 ? 8 : 0;
  const expandedHeight = 66 + currentTaskHeight + taskGap + historyHeight;
  const panelHeight = effectiveStackOpen ? expandedHeight : 52;

  useEffect(() => {
    setActiveTaskVisible(true);
  }, [projectMode, prompt]);

  return (
    <motion.aside
      animate={{ opacity: 1, x: 0, y: 0 }}
            className="pointer-events-none absolute bottom-[16px] left-[16px] z-40 w-[280px] select-none max-md:hidden"
      data-generation-progress={generationProgress}
      data-generation-stage={generationStage ?? undefined}
      data-left-task-stack
      data-panel-motion="task-stack"
      data-phase={phase}
      data-stack-expanded={effectiveStackOpen ? "true" : "false"}
      data-working={isWorking ? "true" : undefined}
      initial={{ opacity: 0, x: -10, y: 4 }}
      transition={{ ...panelTransition, delay: 0.12 }}
    >
      <section
        className="workbench-task-card pointer-events-auto relative overflow-hidden rounded-[16px] bg-[#18191b]/86 shadow-[0_22px_84px_-40px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
        data-active={currentTaskWorking ? "true" : undefined}
        style={{ height: panelHeight, transition: "height 300ms cubic-bezier(0.16, 1, 0.3, 1)" }}
      >
          <motion.div
            animate={{ opacity: effectiveStackOpen ? 1 : 0, y: effectiveStackOpen ? 0 : 4 }}
            aria-hidden={!effectiveStackOpen}
            className={cn("absolute inset-x-[12px] top-[10px]", !effectiveStackOpen && "pointer-events-none")}
            inert={!effectiveStackOpen}
            transition={{ duration: effectiveStackOpen ? 0.2 : 0.12, delay: effectiveStackOpen ? 0.06 : 0, ease: workbenchEase }}
          >
            <div className="border-b border-white/[0.08] pb-[8px]">
              {activeTaskVisible && (
                <div className="workbench-task-pill flex h-[38px] w-full items-center gap-[8px] rounded-full border border-white/[0.12] bg-[#34363a]/92 px-[10px] text-left text-[13px] font-semibold text-[#f1f3f4]">
                  {currentTaskWorking ? (
                    <span className="workbench-status-spinner size-[15px] shrink-0 animate-spin rounded-full border-2 border-[#d8dce2]/70 border-t-transparent" />
                  ) : runStatus === "failed" || runStatus === "cancelled" ? (
                    <XIcon className="size-[15px] shrink-0 text-[#f2a7a7]" />
                  ) : (
                    <CheckCircle2Icon className="size-[15px] shrink-0 text-[#e8eaed]" />
                  )}
                  <span className="min-w-0 truncate">{currentTaskCopy}</span>
                  {currentTaskWorking && canCancel && (
                    <button
                      aria-label="取消当前任务"
                      className="-mr-[3px] ml-auto grid size-[22px] shrink-0 place-items-center rounded-full border border-white/[0.12] bg-white/[0.035] text-[#c7cad0] hover:bg-white/[0.10] hover:text-white"
                      disabled={actionBusy}
                      onClick={onCancel}
                      title="取消当前任务"
                      type="button"
                    >
                      <XIcon className="size-[14px]" />
                    </button>
                  )}
                </div>
              )}
              {historyItems.length > 0 && (
                <div className={cn("space-y-[4px]", activeTaskVisible && "mt-[8px]")}>
                  {historyItems.map((item, index) => (
                    <motion.button
                      animate={{ opacity: 1, x: 0 }}
                      aria-pressed={selectedTask === item.label}
                      className={cn(
                        "flex h-[32px] w-full items-center gap-[9px] rounded-[9px] px-[2px] text-left text-[13px] font-medium text-[#d8dce2] transition-colors hover:bg-white/[0.055]",
                        selectedTask === item.label && "bg-white/[0.075] text-[#f1f3f4]",
                      )}
                      initial={{ opacity: 0, x: -4 }}
                      key={item.id}
                      onClick={() => onSelectTask(item.label)}
                      transition={{ delay: 0.06 + index * 0.025, duration: 0.18, ease: workbenchEase }}
                      type="button"
                    >
                      {item.status === "failed" || item.status === "cancelled" ? (
                        <XIcon className="size-[16px] shrink-0 text-[#f2a7a7]" />
                      ) : (
                        <CheckCircle2Icon className="size-[16px] shrink-0 text-[#d7dbe1]" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </motion.button>
                  ))}
                </div>
              )}
            </div>
            <button
              aria-expanded="true"
              aria-label="收起智能体日志"
              className="workbench-log-toggle mt-[6px] flex h-[32px] w-full items-center justify-between rounded-[10px] px-[8px] text-[#f1f3f4] hover:bg-white/[0.05]"
              onClick={() => setStackOpen(false)}
              type="button"
            >
              <span className="flex items-center gap-[12px]">
                <SendIcon className="size-[15px]" />
                <span className="text-[15px] font-semibold">智能体日志</span>
              </span>
              <ChevronDownIcon className="size-[15px] rotate-180 text-[#c7cad0] transition-transform duration-200" />
            </button>
          </motion.div>
          <motion.button
            animate={{ opacity: effectiveStackOpen ? 0 : 1, y: effectiveStackOpen ? -3 : 0 }}
            aria-hidden={effectiveStackOpen}
            aria-expanded="false"
            aria-label={currentTaskWorking ? "展开当前任务和智能体日志" : "展开智能体日志"}
            className={cn(
              "absolute inset-x-[12px] top-[10px] flex h-[32px] items-center gap-[8px] rounded-[10px] px-[10px] text-left text-[13px] font-semibold text-[#f1f3f4]",
              currentTaskWorking ? "workbench-task-pill rounded-full border border-white/[0.12] bg-[#34363a]/92" : "workbench-log-toggle bg-[#242528]/90 hover:bg-[#2b2c30]",
              effectiveStackOpen && "pointer-events-none",
            )}
            onClick={() => setStackOpen(true)}
            tabIndex={effectiveStackOpen ? -1 : 0}
            transition={{ duration: effectiveStackOpen ? 0.1 : 0.18, delay: effectiveStackOpen ? 0 : 0.08, ease: workbenchEase }}
            type="button"
          >
            {currentTaskWorking ? (
              <>
                <span className="workbench-status-spinner size-[15px] shrink-0 animate-spin rounded-full border-2 border-[#d8dce2]/70 border-t-transparent" />
                <span className="min-w-0 flex-1 truncate">{currentTaskCopy}</span>
              </>
            ) : (
              <>
                <SendIcon className="size-[15px] shrink-0" />
                <span className="min-w-0 flex-1 text-[15px]">智能体日志</span>
              </>
            )}
            <ChevronDownIcon className="size-[15px] shrink-0 text-[#c7cad0] transition-transform duration-200" />
          </motion.button>
      </section>
    </motion.aside>
  );
}

export function ProjectTranscriptPanel({
  actionBusy,
  activities,
  canRetry,
  cancellationReason,
  failure,
  generationProgress,
  generationStage,
  isOverview,
  messages,
  onRetry,
  phase,
  projectMode,
  prompt,
  runPhaseLabel,
  runStatus,
  selectedTask,
  submissionError,
}: {
  actionBusy: boolean;
  activities: WorkbenchRunActivityItem[];
  canRetry: boolean;
  cancellationReason: string | null;
  failure: Run["failure"];
  generationProgress: number;
  generationStage: RunGenerationStage | null;
  isOverview: boolean;
  messages: WorkbenchRunMessageItem[];
  onRetry: () => void;
  phase: WorkbenchProjectPhase;
  projectMode: WorkbenchProjectMode;
  prompt: string;
  runPhaseLabel: string | null;
  runStatus: Run["status"] | null;
  selectedTask: string | null;
  submissionError: unknown;
}) {
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [promptCopied, setPromptCopied] = useState(false);
  const promptCopyTimerRef = useRef<number | null>(null);
  const isGenerated = projectMode === "generated";
  const promptCopy = prompt || "当前运行";
  const displayedPromptCopy = selectedTask || promptCopy;
  const isDocument = projectMode === "document";
  const showPromptChip = Boolean(prompt || selectedTask);
  const selectedActivity = selectedTask
    ? [...activities].reverse().find((activity) => activity.label === selectedTask)
    : null;
  const currentActivity = [...activities].reverse().find((activity) => activity.working)
    ?? activities.at(-1);
  const latestMessage = messages.at(-1);
  const isWorking = runStatus === "queued"
    || runStatus === "running"
    || runStatus === "waiting_input"
    || runStatus === "cancelling";
  const statusCopy = submissionError
    ? "提交失败"
    : runStatus === "failed"
      ? "运行失败"
      : runStatus === "cancelled"
        ? "运行已取消"
        : runStatus === "waiting_input"
          ? "等待您的确认"
          : runStatus === "succeeded"
            ? "运行已完成"
            : runPhaseLabel ?? currentActivity?.label ?? (isOverview ? "正在处理" : "准备就绪");
  const bodyCopy = selectedActivity?.detail
    ?? latestMessage?.text
    ?? currentActivity?.detail
    ?? failure?.message
    ?? cancellationReason
    ?? (submissionError instanceof Error ? submissionError.message : null)
    ?? (runStatus === "waiting_input" ? "请在确认弹层中选择后继续。" : null)
    ?? (runStatus === "succeeded" ? "产物已发布到当前项目画布。" : null)
    ?? "暂无新的运行消息。";
  const isAgentWorking = isWorking;
  const expandedPanelHeight = selectedTask
    ? "326px"
    : isDocument
    ? "calc(100vh - 260px)"
    : `${isGenerated ? (isOverview ? 188 : phase === "complete" ? 126 : 326) : 126}px`;

  useEffect(() => {
    if (phase === "generating" || phase === "refining") {
      setTranscriptOpen(true);
    }
  }, [phase, projectMode]);

  useEffect(() => () => {
    if (promptCopyTimerRef.current !== null) window.clearTimeout(promptCopyTimerRef.current);
  }, []);

  const copyPrompt = async () => {
    try {
      await writeWorkbenchClipboard(displayedPromptCopy);
      setPromptCopied(true);
      if (promptCopyTimerRef.current !== null) window.clearTimeout(promptCopyTimerRef.current);
      promptCopyTimerRef.current = window.setTimeout(() => setPromptCopied(false), 1200);
    } catch {
      setPromptCopied(false);
      toast.error("复制提示词失败，请检查浏览器剪贴板权限");
    }
  };

  return (
    <motion.aside
      animate={{ opacity: 1, x: 0 }}
      className={cn(
        "workbench-agent-card absolute left-[16px] top-[80px] z-30 overflow-hidden rounded-[16px] bg-[#171819]/78 shadow-[0_24px_88px_-46px_rgba(0,0,0,0.95)] backdrop-blur-2xl max-md:hidden",
        (isGenerated || isWorking) && "workbench-agent-card--active",
        isAgentWorking && "workbench-agent-card--generating",
      )}
      data-expanded={transcriptOpen ? "true" : "false"}
      data-generation-progress={generationProgress}
      data-generation-stage={generationStage ?? undefined}
      data-panel-motion="agent-card"
      data-phase={phase}
      initial={{ opacity: 0, x: -10 }}
      style={{ height: transcriptOpen ? expandedPanelHeight : "52px", width: transcriptOpen ? "280px" : "64px" }}
      transition={{ ...panelTransition, delay: 0.10 }}
    >
      <div className="workbench-agent-card-base-bg absolute inset-0" />
      <div className="workbench-agent-card-shade absolute inset-0" />
      <button
        aria-expanded={transcriptOpen}
        aria-label={transcriptOpen ? "收起 Agent 状态" : "展开 Agent 状态"}
        className={cn(
          "workbench-agent-bubble absolute z-30 h-[26px] w-[44px] text-[#202124] transition-[left,top] duration-300 ease-out",
          transcriptOpen ? "left-[12px] top-[16px]" : "left-[9px] top-[9px]",
        )}
        onClick={() => setTranscriptOpen((open) => !open)}
        title={transcriptOpen ? "收起 Agent 状态" : "展开 Agent 状态"}
        type="button"
      >
        <span className="absolute left-0 top-[4px] z-10 flex h-[22px] w-[44px] items-center justify-center gap-[8px] rounded-full bg-[#f1f3f4] shadow-[0_12px_34px_-20px_rgba(0,0,0,0.9)]">
          <span className="size-[4px] rounded-full bg-[#202124]" />
          <span className="size-[4px] rounded-full bg-[#202124]" />
        </span>
      </button>
      <AnimatePresence initial={false}>
      {transcriptOpen && (
      <motion.div
        animate={{ opacity: 1 }}
        className="relative z-20 flex h-full flex-col px-[16px] pb-[18px] pt-[70px] text-[#f1f3f4]"
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        transition={{ duration: 0.16, ease: workbenchEase }}
      >
        {showPromptChip && (selectedTask || isOverview || !(phase === "complete" && isGenerated)) && (
        <div
          className="mb-[18px] flex h-[46px] w-full items-center gap-[9px] rounded-[14px] border border-white/[0.10] bg-[#2b2d31]/84 px-[12px] text-left text-[13px] font-medium text-[#d8dce2]"
        >
          <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-[#526872] text-[11px] font-semibold">L</span>
          <span className="min-w-0 flex-1 truncate">{displayedPromptCopy}</span>
          <button
            aria-label="复制提示词"
            className="grid size-[24px] shrink-0 place-items-center rounded-[7px] text-[#b8bcc4] hover:bg-white/[0.08] hover:text-white"
            onClick={() => void copyPrompt()}
            title={promptCopied ? "已复制" : "复制提示词"}
            type="button"
          >
            {promptCopied ? <CheckCircle2Icon className="size-[14px]" /> : <CopyIcon className="size-[14px]" />}
          </button>
        </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden text-[15px] leading-[24px] text-[#f4f6fa]">
          <AnimatePresence initial={false} mode="sync">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className={cn("absolute inset-0", (isGenerated || selectedTask) && "flex flex-col")}
            exit={{ opacity: 0, y: -4 }}
            initial={{ opacity: 0, y: 4 }}
            key={selectedTask || `${projectMode}-${phase}`}
            transition={{ duration: 0.22, ease: workbenchEase }}
          >
          <>
            <p className="max-h-[166px] overflow-hidden whitespace-normal text-[14px] leading-[23px]">
              {bodyCopy}
            </p>
            <div className="mt-[18px] flex items-center gap-[9px] text-[15px] italic leading-[21px] text-[#d8dce2]">
              {isAgentWorking ? (
                <span className="workbench-status-spinner size-[14px] animate-spin rounded-full border-2 border-[#d8dce2]/70 border-t-transparent" />
              ) : runStatus === "failed" || runStatus === "cancelled" || submissionError ? (
                <XIcon className="size-[14px] text-[#f2a7a7]" />
              ) : (
                <CheckCircle2Icon className="size-[14px]" />
              )}
              <AnimatePresence initial={false} mode="wait">
                <motion.span
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  initial={{ opacity: 0, y: 3 }}
                  key={statusCopy}
                  transition={{ duration: 0.22, ease: workbenchEase }}
                >
                  {statusCopy}
                  {generationStage === "generating-ui" && (
                    <span aria-hidden="true" className="workbench-stage-ellipsis">...</span>
                  )}
                </motion.span>
              </AnimatePresence>
              {canRetry && (
                <button
                  aria-label="重试当前运行"
                  className="ml-auto grid size-[24px] shrink-0 place-items-center rounded-full border border-white/[0.12] bg-white/[0.035] text-[#c7cad0] hover:bg-white/[0.10] hover:text-white"
                  disabled={actionBusy}
                  onClick={onRetry}
                  title="重试当前运行"
                  type="button"
                >
                  <RefreshCwIcon className="size-[13px]" />
                </button>
              )}
            </div>
          </>
          </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
      )}
      </AnimatePresence>
    </motion.aside>
  );
}

export function MobileRunStatus({
  busy,
  canCancel,
  canRetry,
  failure,
  generationStage,
  onCancel,
  onRetry,
  runPhaseLabel,
  runStatus,
}: {
  busy: boolean;
  canCancel: boolean;
  canRetry: boolean;
  failure: Run["failure"];
  generationStage: RunGenerationStage | null;
  onCancel: () => void;
  onRetry: () => void;
  runPhaseLabel: string | null;
  runStatus: Run["status"] | null;
}) {
  if (!runStatus) return null;
  const working = runStatus === "queued"
    || runStatus === "running"
    || runStatus === "waiting_input"
    || runStatus === "cancelling";
  const label = runStatus === "failed"
    ? failure?.message ?? "运行失败"
    : runStatus === "cancelled"
      ? "运行已取消"
      : runStatus === "succeeded"
        ? "运行已完成"
        : runStatus === "waiting_input"
          ? "等待确认"
          : runPhaseLabel ?? "正在运行";

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      aria-live="polite"
      className="absolute left-[16px] right-[70px] top-[76px] z-40 flex h-[42px] items-center gap-[9px] rounded-[13px] border border-white/[0.10] bg-[#1c1d20]/94 px-[11px] text-[12px] font-semibold text-[#f1f3f4] shadow-[0_18px_56px_-34px_rgba(0,0,0,0.95)] backdrop-blur-xl md:hidden"
      initial={{ opacity: 0, y: -5 }}
      transition={popoverTransition}
    >
      {working ? (
        <span className="workbench-status-spinner size-[14px] shrink-0 animate-spin rounded-full border-2 border-[#d8dce2]/70 border-t-transparent" />
      ) : runStatus === "failed" || runStatus === "cancelled" ? (
        <XIcon className="size-[15px] shrink-0 text-[#f2a7a7]" />
      ) : (
        <CheckCircle2Icon className="size-[15px] shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {label}
        {generationStage === "generating-ui" && (
          <span aria-hidden="true" className="workbench-stage-ellipsis">...</span>
        )}
      </span>
      {working && canCancel && (
        <button
          aria-label="取消当前运行"
          className="grid size-[26px] shrink-0 place-items-center rounded-full border border-white/[0.10] text-[#d8dce2]"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          <XIcon className="size-[14px]" />
        </button>
      )}
      {!working && canRetry && (
        <button
          aria-label="重试当前运行"
          className="grid size-[26px] shrink-0 place-items-center rounded-full border border-white/[0.10] text-[#d8dce2]"
          disabled={busy}
          onClick={onRetry}
          type="button"
        >
          <RefreshCwIcon className="size-[14px]" />
        </button>
      )}
    </motion.div>
  );
}
