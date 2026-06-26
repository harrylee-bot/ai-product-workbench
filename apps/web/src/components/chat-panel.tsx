"use client";

import {
  Circle,
  Sparkles,
} from "lucide-react";
import { Badge, EmptyState } from "@/components/ui";
import { toChineseText } from "@/components/workspace-preview/helpers";
import { ChatComposer } from "./workspace-chat/chat-composer";

export type Phase1Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type VibeRunStepStatus = "pending" | "running" | "done" | "failed";

export type VibeRunStepView = {
  step: string;
  title: string;
  executor: string;
  detail: string;
  status: VibeRunStepStatus;
  message?: string;
};

export type VibeRunTimelineItem = {
  id: string;
  text: string;
  status: "info" | "running" | "done" | "failed" | "warning";
  step?: string;
  createdAt?: string;
};

export type VibeRunDebugEvent = {
  id: string;
  title: string;
  body: string;
  raw?: string;
  status: "info" | "running" | "done" | "failed" | "warning";
  type: string;
  step?: string;
  createdAt?: string;
};

export type VibeClarificationQuestion = {
  id: string;
  title: string;
  question?: string;
  reason: string;
  options: string[];
  recommendedOption?: string;
  recommendation?: string;
  required?: boolean;
  status?: "pending" | "answered" | "skipped";
};

export type VibeRunView = {
  runId?: string;
  status:
    | "idle"
    | "running"
    | "waiting_clarification"
    | "waiting_confirmation"
    | "waiting_prd_confirm"
    | "waiting_prototype_confirm"
    | "completed"
    | "failed";
  currentLabel?: string;
  summary?: string;
  steps: VibeRunStepView[];
  timeline?: VibeRunTimelineItem[];
  debugEvents?: VibeRunDebugEvent[];
  clarificationQuestions?: VibeClarificationQuestion[];
  knowledgeHitCount?: number;
  qaIssueCount?: number;
  qaGateStatus?: "open" | "warning" | "blocked";
  qaGateSummary?: string;
  exportFileName?: string;
  prototypeArtifactId?: string;
  /** 确认门 A：用户确认 PRD 后是否应继续生成原型（FR-1.3） */
  wantsPrototype?: boolean;
  errorMessage?: string;
};

export function ChatPanel({
  messages,
  disabled,
  sending,
  onSend,
}: {
  messages: Phase1Message[];
  runState?: VibeRunView | null;
  disabled?: boolean;
  sending?: boolean;
  confirmingPrd?: boolean;
  onConfirmPrd?: (wantsPrototype: boolean) => Promise<void> | void;
  confirmingPrototypeId?: string;
  onConfirmPrototype?: (artifactId: string) => Promise<void> | void;
  onSend: (content: string) => Promise<void> | void;
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel-bg)]">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">智能输入</div>
          <div className="truncate text-xs text-gray-500">说出目标，系统自动决策与生成</div>
        </div>
        <Badge tone={sending ? "warning" : "neutral"} className="bg-white">
          {sending ? (
            <span className="inline-flex items-center gap-1">
              <Circle className="h-3.5 w-3.5 fill-amber-100 text-amber-600" />
              运行中
            </span>
          ) : "可输入"}
        </Badge>
      </div>
      <div className="workbench-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length ? (
          messages.map((message) => (
            <div
              key={message.id}
              className={[
                "w-fit max-w-[min(86%,_720px)] whitespace-pre-wrap rounded-[12px] px-3 py-2 text-sm leading-6 shadow-[var(--shadow-control)]",
                message.role === "user"
                  ? "ml-auto bg-[var(--color-primary)] text-white"
                  : "mr-auto border border-gray-200 bg-white text-gray-700",
              ].join(" ")}
            >
              {toChineseText(message.content)}
            </div>
          ))
        ) : (
          <EmptyState
            title="从一句目标开始"
            description="系统会整理需求、生成产品状态、PRD、原型和 QA 路径。"
            icon={<Sparkles className="h-5 w-5" />}
          />
        )}
      </div>
      <ChatComposer disabled={disabled} sending={sending} onSend={onSend} />
    </section>
  );
}
