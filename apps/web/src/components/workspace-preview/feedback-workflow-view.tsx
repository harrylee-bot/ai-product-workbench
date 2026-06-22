"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Clock3,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { evolutionCopy, toChineseText } from "./helpers";
import type {
  FeedbackWorkflowStep,
  Phase2DecisionView,
  WorkflowStepStatus,
} from "./types";

export function FeedbackWorkflowView({ decision }: { decision?: Phase2DecisionView | null }) {
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackItems, setFeedbackItems] = useState<Array<{ id: string; text: string; status: string }>>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const suggestionTimerRef = useRef<number | null>(null);
  const workflow = buildFeedbackWorkflow(decision, feedbackItems.length);

  useEffect(() => {
    return () => {
      if (suggestionTimerRef.current !== null) {
        window.clearTimeout(suggestionTimerRef.current);
      }
    };
  }, []);

  const addFeedback = () => {
    const text = feedbackText.trim();
    if (!text) return;
    setFeedbackItems((items) => [
      { id: `feedback-${Date.now()}`, text, status: "已记录" },
      ...items,
    ]);
    setFeedbackText("");
    setWorkflowError(null);
  };

  const generatePatchSuggestion = () => {
    if (!decision) {
      setWorkflowError("需要先完成一次生成结果，才能基于当前补丁上下文生成建议。");
      return;
    }

    setSuggesting(true);
    setWorkflowError(null);
    if (suggestionTimerRef.current !== null) {
      window.clearTimeout(suggestionTimerRef.current);
    }

    suggestionTimerRef.current = window.setTimeout(() => {
      const operationCount = decision.patchDraft.operations.length;
      setFeedbackItems((items) => [
        {
          id: `feedback-suggestion-${Date.now()}`,
          text: `建议先按当前 ${operationCount} 个补丁操作做小范围回归：确认选区影响、QA 风险和用户反馈是否一致，再决定是否应用到完整原型。`,
          status: "补丁建议",
        },
        ...items,
      ]);
      setSuggesting(false);
      suggestionTimerRef.current = null;
    }, 560);
  };

  return (
    <div className="workbench-scrollbar h-full overflow-y-auto p-2.5">
      <div className="space-y-3">
        <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
                <MessageSquare className="h-4 w-4 text-blue-600" />
                反馈闭环
              </div>
              <div className="mt-1 text-xs text-gray-500">从用户反馈到补丁回归的工作流面板</div>
            </div>
            <Badge tone={feedbackItems.length ? "accent" : "neutral"} className="bg-white">
              {feedbackItems.length} 条反馈
            </Badge>
          </div>
          <div className="mt-3 grid gap-2">
            {workflow.map((step, index) => (
              <div key={step.id} className="flex items-center gap-2 rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2">
                <span className={workflowStepClass(step.status)}>
                  {step.status === "done" ? <Check className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-gray-950">{step.title}</div>
                  <div className="mt-0.5 line-clamp-2 break-words text-[11px] leading-4 text-gray-500" title={step.detail}>{step.detail}</div>
                </div>
                {index < workflow.length - 1 ? <ArrowRight className="h-3.5 w-3.5 text-gray-300" /> : null}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-panel)] border border-blue-100 bg-blue-50 p-3">
          <div className="text-sm font-semibold text-blue-950">记录反馈</div>
          <textarea
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && feedbackText) {
                event.currentTarget.blur();
              }
            }}
            aria-label="反馈内容"
            rows={4}
            placeholder="输入用户反馈、验收意见或需要回归的问题"
            className="mt-2 block min-h-[104px] w-full resize-none rounded-[12px] border border-blue-100 bg-white px-3 py-2 text-sm leading-6 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-950 focus:ring-3 focus:ring-gray-950/10"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!decision || suggesting}
              onClick={generatePatchSuggestion}
              title={!decision ? "需要先完成一次生成结果" : suggesting ? "正在生成补丁建议" : "生成补丁建议"}
            >
              <Sparkles className={suggesting ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              {suggesting ? "生成中" : "生成补丁建议"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!feedbackText.trim()}
              onClick={addFeedback}
              title={feedbackText.trim() ? "记录反馈" : "请输入反馈内容"}
            >
              <MessageSquare className="h-4 w-4" />
              记录反馈
            </Button>
          </div>
          {suggesting ? <FeedbackSuggestionSkeleton /> : null}
          {workflowError ? (
            <div role="alert" className="mt-2 rounded-[12px] border border-red-100 bg-white px-3 py-2 text-xs leading-5 text-red-700">
              {workflowError}
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          {feedbackItems.length ? (
            feedbackItems.map((item) => (
              <div key={item.id} className="rounded-[var(--radius-panel)] border border-gray-200 bg-white p-3 shadow-[var(--shadow-control)]">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-gray-950">{item.status}</div>
                  <Badge tone="accent" className="bg-blue-50">待归因</Badge>
                </div>
                <div className="mt-2 break-words text-sm leading-6 text-gray-700">{item.text}</div>
              </div>
            ))
          ) : (
            <div className="rounded-[var(--radius-panel)] border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
              反馈记录会以闭环任务的方式沉淀在这里。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FeedbackSuggestionSkeleton() {
  return (
    <div className="mt-2 rounded-[12px] border border-blue-100 bg-white px-3 py-3" aria-live="polite" aria-label="补丁建议生成中">
      <div className="h-3 w-28 animate-pulse rounded-full bg-blue-100" />
      <div className="mt-3 space-y-2">
        <div className="h-3 animate-pulse rounded-full bg-gray-100" />
        <div className="h-3 w-9/12 animate-pulse rounded-full bg-gray-100" />
      </div>
    </div>
  );
}

function buildFeedbackWorkflow(decision?: Phase2DecisionView | null, feedbackCount = 0): FeedbackWorkflowStep[] {
  return [
    {
      id: "collect",
      title: "收集反馈",
      detail: feedbackCount ? `${feedbackCount} 条反馈已进入闭环` : "等待用户反馈",
      status: feedbackCount ? "done" : "active",
    },
    {
      id: "attribute",
      title: "语义归因",
      detail: decision?.knowledgeSearch?.summary ? toChineseText(decision.knowledgeSearch.summary) : "关联知识库与约束",
      status: decision?.knowledgeSearch ? "done" : feedbackCount ? "active" : "pending",
    },
    {
      id: "patch",
      title: "生成补丁",
      detail: decision ? `${decision.patchDraft.operations.length} 个补丁操作` : "等待决策结果",
      status: decision?.patchDraft.operations.length ? "done" : "pending",
    },
    {
      id: "regression",
      title: "QA 回归",
      detail: decision ? `QA ${decision.evolution.metrics.qaPassed ? "通过" : "待处理"}` : "等待补丁",
      status: decision?.evolution.metrics.qaPassed ? "done" : decision ? "active" : "pending",
    },
    {
      id: "learn",
      title: "沉淀进化",
      detail: decision ? evolutionCopy(decision.evolution.signal.signalType) : "等待闭环完成",
      status: decision ? "done" : "pending",
    },
  ];
}

function workflowStepClass(status: WorkflowStepStatus) {
  const base = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full";
  if (status === "done") return `${base} bg-emerald-100 text-emerald-700`;
  if (status === "active") return `${base} bg-blue-100 text-blue-700`;
  return `${base} bg-gray-100 text-gray-400`;
}
