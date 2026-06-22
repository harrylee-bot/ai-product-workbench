"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  ClipboardList,
  Crop,
  FileText,
  GitBranch,
  Image,
  Link2,
  LoaderCircle,
  Paperclip,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import type { Phase2DecisionView } from "@/components/preview-panel";
import { Badge, Button, EmptyState, TextArea } from "@/components/ui";

export type Phase1Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

type ComposerMode = "global" | "selection";

type ComposerAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
};

export function ChatPanel({
  messages,
  decision,
  disabled,
  sending,
  onSend,
}: {
  messages: Phase1Message[];
  decision?: Phase2DecisionView | null;
  disabled?: boolean;
  sending?: boolean;
  onSend: (content: string) => Promise<void> | void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [runningStep, setRunningStep] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>("global");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [focused, setFocused] = useState(false);
  const canSend = Boolean(draft.trim() || attachments.length) && !disabled && !sending;

  async function submitDraft() {
    if (!canSend) return;
    await onSend(buildSubmitContent(draft, attachments, composerMode));
    setDraft("");
    setAttachments([]);
    setComposerMode("global");
    setMenuOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitDraft();
  }

  useEffect(() => {
    if (!sending) {
      setRunningStep(0);
      return;
    }
    setRunningStep(0);
    const timer = window.setInterval(() => {
      setRunningStep((value) => Math.min(value + 1, EXECUTION_STEPS.length - 1));
    }, 700);
    return () => window.clearInterval(timer);
  }, [sending]);

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const remainingSlots = Math.max(0, 6 - attachments.length);
    const selectedFiles = Array.from(files).slice(0, remainingSlots);
    if (!selectedFiles.length) return;
    setAttachments((items) => [
      ...items,
      ...selectedFiles.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID?.() ?? Date.now()}`,
        name: file.name,
        size: file.size,
        type: file.type || "file",
      })),
    ]);
    setMenuOpen(false);
  }

  function insertTemplate(kind: "requirement" | "reference" | "selection") {
    const snippets = {
      requirement: "请基于以下目标补充需求、关键页面、交互状态和验收标准：\n",
      reference: "参考链接/资料：\n\n请结合这些资料给出产品方案，并标明需要确认的信息。",
      selection: "请只针对右侧当前选中区域做局部优化，不要重写全量页面：\n",
    };
    setDraft((value) => `${value}${value.trim() ? "\n\n" : ""}${snippets[kind]}`);
    if (kind === "selection") setComposerMode("selection");
    setMenuOpen(false);
  }

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
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
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
                "w-fit max-w-[min(86%,_720px)] rounded-[12px] px-3 py-2 text-sm leading-6 shadow-[var(--shadow-control)]",
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
            description="系统会自动经过约束、决策、进化与统一编排，并生成需求结果、设计结果和执行路径。"
            icon={<Sparkles className="h-5 w-5" />}
          />
        )}
        {(sending || decision) ? (
          <ExecutionPathCard decision={decision} running={Boolean(sending)} runningStep={runningStep} />
        ) : null}
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-[var(--color-border)] bg-white px-3 py-2.5 shadow-[0_-10px_26px_rgba(15,23,42,0.04)]">
        <div
          className={[
            "rounded-[14px] border bg-white shadow-[var(--shadow-control)] transition",
            focused ? "border-gray-950 ring-3 ring-gray-950/10" : "border-gray-200",
            sending ? "bg-gray-50" : "",
          ].join(" ")}
        >
          <SelectionHint
            mode={composerMode}
            onSetSelection={() => {
              setComposerMode("selection");
              insertTemplate("selection");
            }}
            onClear={() => setComposerMode("global")}
          />
          {attachments.length ? (
            <div className="flex flex-wrap gap-2 border-t border-gray-100 px-2.5 py-2">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
                />
              ))}
            </div>
          ) : null}
          {sending ? (
            <div className="mx-2.5 mt-2 flex items-center gap-2 rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
              <span className="min-w-0 truncate">正在执行多智能体流程，当前消息处理完成后可继续输入。</span>
            </div>
          ) : null}
          <TextArea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={disabled || sending}
            placeholder={composerMode === "selection" ? "描述这个局部区域要怎么改..." : "输入你的目标、页面、流程或约束..."}
            rows={3}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitDraft();
              }
            }}
            className="max-h-[148px] min-h-[82px] resize-none border-0 bg-transparent px-3 py-2.5 shadow-none outline-none hover:border-0 focus:bg-transparent focus:ring-0 disabled:bg-transparent"
          />
          <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((value) => !value)}
                  disabled={disabled || sending}
                  aria-label="打开输入工具"
                  aria-expanded={menuOpen}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] border border-gray-200 bg-gray-50 text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className={["h-4 w-4 transition", menuOpen ? "rotate-45" : ""].join(" ")} />
                </button>
                {menuOpen ? (
                  <ComposerMenu
                    onAttach={() => fileInputRef.current?.click()}
                    onInsertRequirement={() => insertTemplate("requirement")}
                    onInsertReference={() => insertTemplate("reference")}
                    onInsertSelection={() => insertTemplate("selection")}
                  />
                ) : null}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <span className="truncate text-xs text-gray-400">
                {attachments.length ? `${attachments.length} 个附件已加入上下文` : "Enter 发送，Shift + Enter 换行"}
              </span>
            </div>
            <Button
              type="submit"
              size="icon"
              disabled={!canSend}
              aria-label={sending ? "生成中" : "发送"}
              className={[
                "h-9 w-9 rounded-full px-0",
                canSend ? "shadow-[var(--shadow-control)]" : "",
              ].join(" ")}
            >
              {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function SelectionHint({
  mode,
  onSetSelection,
  onClear,
}: {
  mode: ComposerMode;
  onSetSelection: () => void;
  onClear: () => void;
}) {
  if (mode === "selection") {
    return (
      <div className="flex items-center gap-2 rounded-t-[13px] border-b border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        <Crop className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          局部模式 · 只针对当前选区生成修改建议
        </span>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-blue-700 transition hover:bg-blue-100 focus:outline-none focus-visible:ring-3 focus-visible:ring-blue-500/15"
          aria-label="退出局部模式"
          title="退出局部模式"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-t-[13px] border-b border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-500">
      <Sparkles className="h-4 w-4 shrink-0 text-gray-400" />
      <span className="min-w-0 flex-1 truncate">全局需求 · 需要局部修改时可切到选区模式</span>
      <button
        type="button"
        onClick={onSetSelection}
        className="shrink-0 rounded-full border border-gray-200 bg-white px-2 py-1 font-semibold text-gray-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus-visible:ring-3 focus-visible:ring-blue-500/15"
      >
        选区
      </button>
    </div>
  );
}

function ComposerMenu({
  onAttach,
  onInsertRequirement,
  onInsertReference,
  onInsertSelection,
}: {
  onAttach: () => void;
  onInsertRequirement: () => void;
  onInsertReference: () => void;
  onInsertSelection: () => void;
}) {
  const items = [
    {
      label: "上传附件",
      description: "文件会作为本轮上下文摘要",
      icon: Paperclip,
      onClick: onAttach,
    },
    {
      label: "需求模板",
      description: "目标、页面、状态、验收标准",
      icon: ClipboardList,
      onClick: onInsertRequirement,
    },
    {
      label: "参考资料",
      description: "链接、竞品、业务背景",
      icon: Link2,
      onClick: onInsertReference,
    },
    {
      label: "局部修改",
      description: "只作用于当前选区",
      icon: Crop,
      onClick: onInsertSelection,
    },
  ];

  return (
    <div className="absolute bottom-11 left-0 z-30 w-72 overflow-hidden rounded-[14px] border border-gray-200 bg-white p-1.5 shadow-[var(--shadow-float)]">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            onClick={item.onClick}
            className="flex w-full items-start gap-2 rounded-[10px] px-2.5 py-2 text-left transition hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50"
          >
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-700">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-gray-950">{item.label}</span>
              <span className="mt-0.5 block truncate text-xs text-gray-500">{item.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const Icon = attachment.type.startsWith("image/") ? Image : FileText;

  return (
    <span className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 pl-2 pr-1 text-xs text-gray-700">
      <Icon className="h-3.5 w-3.5 shrink-0 text-gray-500" />
      <span className="min-w-0 max-w-[160px] truncate font-medium">{attachment.name}</span>
      <span className="shrink-0 text-gray-400">{formatFileSize(attachment.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-200 hover:text-gray-700 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
        aria-label={`移除 ${attachment.name}`}
        title={`移除 ${attachment.name}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

function buildSubmitContent(draft: string, attachments: ComposerAttachment[], mode: ComposerMode) {
  const content = draft.trim();
  const prefix = mode === "selection" ? "局部修改请求：\n" : "";
  if (!attachments.length) return `${prefix}${content}`.trim();
  const attachmentSummary = attachments
    .map((attachment) => `- ${attachment.name}（${formatFileSize(attachment.size)}）`)
    .join("\n");
  const body = content || "请参考附件继续分析。";
  return `${prefix}${body}\n\n附件上下文：\n${attachmentSummary}`;
}

function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

type ExecutionStep = {
  title: string;
  agent: string;
  detail: string;
};

const EXECUTION_STEPS: ExecutionStep[] = [
  { title: "理解意图", agent: "意图智能体", detail: "识别用户目标与需求类型" },
  { title: "应用约束", agent: "约束系统", detail: "检查必须遵守、优先、避免和提醒规则" },
  { title: "生成策略", agent: "决策引擎", detail: "生成多种策略并计算加权得分" },
  { title: "多方评审", agent: "评审委员会", detail: "产品、体验、技术、风险、增长智能体参与评分" },
  { title: "选择方案", agent: "策略选择器", detail: "选择综合得分最高且风险可控的策略" },
  { title: "生成预览", agent: "补丁预览", detail: "生成变更草案，保持确认前不直接应用" },
  { title: "记录进化", agent: "进化系统", detail: "写入决策轨迹并更新策略权重" },
  { title: "输出结果", agent: "编排器", detail: "生成需求文档与可交互网页原型" },
];

function ExecutionPathCard({
  decision,
  running,
  runningStep,
}: {
  decision?: Phase2DecisionView | null;
  running: boolean;
  runningStep: number;
}) {
  const [open, setOpen] = useState(false);
  const completed = Boolean(decision) && !running;
  const currentStep = running ? EXECUTION_STEPS[runningStep] : EXECUTION_STEPS.at(-1);
  const strategy = decision?.selectedStrategy ? strategyLabel(decision.selectedStrategy.name) : "等待策略结果";
  const knowledgeCount = decision?.knowledgeSearch?.results.length ?? 0;
  const knowledgeSummary = decision?.knowledgeSearch?.summary;
  const completedSubtitle = knowledgeCount
    ? `已完成：${strategy}，命中 ${knowledgeCount} 条知识`
    : `已完成：${strategy}`;
  const progress = completed ? 100 : running ? Math.round(((runningStep + 1) / EXECUTION_STEPS.length) * 100) : 0;

  return (
    <div className="mr-auto max-w-[96%] overflow-hidden rounded-[14px] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-gray-50 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
      >
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <GitBranch className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-950">执行路径</span>
          <span className="block truncate text-xs text-gray-500">
            {running ? `正在执行：${currentStep?.title ?? "智能编排"}` : completedSubtitle}
          </span>
        </span>
        <Badge tone={completed ? "success" : "warning"}>
          {completed ? "已完成" : `${runningStep + 1}/${EXECUTION_STEPS.length}`}
        </Badge>
        <ChevronDown className={["h-4 w-4 text-gray-400 transition", open ? "rotate-180" : ""].join(" ")} />
      </button>
      <div className="h-1 bg-gray-100">
        <div
          className={[
            "h-full rounded-r-full transition-all duration-500",
            completed ? "bg-emerald-500" : "bg-amber-500",
          ].join(" ")}
          style={{ width: `${progress}%` }}
        />
      </div>

      {open ? (
        <div className="border-t border-gray-200 bg-gray-50 px-3 py-2.5">
          <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-[var(--shadow-control)]">
            <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <Bot className="h-3.5 w-3.5" />
                已运行智能流程
              </span>
              <span>{completed ? "成功" : "处理中"}</span>
            </div>
            <div className="space-y-2">
              {EXECUTION_STEPS.map((step, index) => {
                const status = completed ? "done" : index < runningStep ? "done" : index === runningStep ? "running" : "pending";
                const detail = step.title === "应用约束" && knowledgeSummary ? knowledgeSummary : step.detail;
                return (
                  <div key={step.title} className="flex gap-2 rounded-lg bg-gray-50 px-2 py-2 text-xs">
                    <StepIcon status={status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-gray-900">{step.title}</span>
                        <span className="shrink-0 text-gray-500">{step.agent}</span>
                      </div>
                      <div className="mt-1 leading-5 text-gray-500">{detail}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {decision ? (
            <div className="mt-2 text-xs leading-5 text-gray-500">
              已选择「{strategy}」，共生成 {decision.decisionPlan.strategies.length} 个策略，评审智能体{" "}
              {decision.reviewBoard.reviews.length} 位。{knowledgeCount ? `本轮知识库命中 ${knowledgeCount} 条。` : "本轮未命中正式知识库。"}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StepIcon({ status }: { status: "done" | "running" | "pending" }) {
  if (status === "done") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "running") return <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-600" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />;
}

function strategyLabel(name: Phase2DecisionView["selectedStrategy"]["name"]) {
  const labels: Record<Phase2DecisionView["selectedStrategy"]["name"], string> = {
    conservative_fix: "保守修正",
    ux_improve: "体验优化",
    structure_rewrite: "结构重写",
    full_regenerate: "完整重建",
    conservative: "保守策略",
    balanced: "平衡策略",
    aggressive: "进取策略",
    full_rewrite: "完整重写",
  };
  return labels[name] ?? name;
}

function toChineseText(value: string) {
  return value
    .replace(/AI Product Workbench/g, "智能产品工作台")
    .replace(/AI Product OS/g, "智能产品操作系统")
    .replace(/AI Product Company/g, "智能产品公司")
    .replace(/Triple System Fusion/g, "三系统融合")
    .replace(/Triple System/g, "三系统融合")
    .replace(/Constraint System/g, "约束系统")
    .replace(/Decision System/g, "决策系统")
    .replace(/Evolution System/g, "进化系统")
    .replace(/Constraint/g, "约束系统")
    .replace(/Decision/g, "决策系统")
    .replace(/Evolution/g, "进化系统")
    .replace(/Patch Preview/g, "补丁预览")
    .replace(/PatchDraft/g, "补丁草稿")
    .replace(/Patch/g, "补丁")
    .replace(/Prototype/g, "原型")
    .replace(/PRD/g, "需求文档")
    .replace(/QA/g, "质检")
    .replace(/AI/g, "智能");
}
