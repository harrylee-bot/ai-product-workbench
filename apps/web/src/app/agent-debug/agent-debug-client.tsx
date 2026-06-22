"use client";

import clsx from "clsx";
import {
  Activity,
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminStatusBadge, JsonViewer } from "@/components/admin-ui";
import { ProtectedRoute } from "@/components/protected-route";
import { Button, InlineError, Select, TextInput } from "@/components/ui";
import { apiRequest, toQueryString } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/types";

type AgentRunItem = {
  id: string;
  runId: string;
  projectId: string;
  projectTitle: string;
  conversationId: string;
  conversationTitle: string;
  userId: string;
  username: string;
  userDisplayName: string;
  intent?: string;
  status: string;
  currentStep?: string;
  currentStepStatus?: string;
  traceId: string;
  inputSummary: string;
  outputSummary?: string;
  errorMessage?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
};

type AgentStep = {
  id: string;
  agentName: string;
  status: string;
  inputSummary: string;
  outputSummary?: string;
  modelCallLogId?: string;
  modelProviderId?: string;
  modelName?: string;
  tokenUsage?: unknown;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  errorMessage?: string;
};

type StreamEvent = {
  id: string;
  eventType: string;
  payload?: unknown;
  createdAt: string;
};

type AgentRunDetail = AgentRunItem & {
  result?: unknown;
  steps: AgentStep[];
  events: StreamEvent[];
};

type Filters = {
  conversationId: string;
  traceId: string;
  status: string;
  agentName: string;
};

const defaultFilters: Filters = {
  conversationId: "",
  traceId: "",
  status: "",
  agentName: "",
};

const agentOptions = [
  "orchestrator",
  "intent_agent",
  "knowledge_agent",
  "requirement_analyst_agent",
  "product_designer_agent",
  "prd_writer_agent",
  "prototype_designer_agent",
  "prototype_code_agent",
  "patch_agent",
  "qa_agent",
  "knowledge_extractor_agent",
];

export function AgentDebugClient() {
  return (
    <ProtectedRoute requireAdmin>
      <AgentDebugContent />
    </ProtectedRoute>
  );
}

function AgentDebugContent() {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);
  const [runs, setRuns] = useState<AgentRunItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setFilters({
      conversationId: params.get("conversationId") ?? "",
      traceId: params.get("traceId") ?? "",
      status: params.get("status") ?? "",
      agentName: params.get("agentName") ?? "",
    });
    setSelectedRunId(params.get("runId"));
  }, []);

  const queryParams = useMemo(
    () =>
      toQueryString({
        page,
        pageSize,
        conversationId: filters.conversationId.trim(),
        traceId: filters.traceId.trim(),
        status: filters.status,
        agentName: filters.agentName,
      }),
    [filters, page, pageSize],
  );

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setError(null);
    try {
      const response = await apiRequest<PaginatedResponse<AgentRunItem>>(
        `/admin/logs/agent-runs${queryParams}`,
      );
      setRuns(response.items);
      setTotal(response.total);
      setSelectedRunId((current) =>
        current && response.items.some((item) => item.id === current)
          ? current
          : response.items[0]?.id ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载 Agent 运行列表失败");
    } finally {
      setLoadingRuns(false);
    }
  }, [queryParams]);

  const loadDetail = useCallback(async (runId: string) => {
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const response = await apiRequest<AgentRunDetail>(`/admin/logs/agent-runs/${runId}`);
      setDetail(response);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "加载 Agent 详情失败");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedRunId);
  }, [loadDetail, selectedRunId]);

  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <main className="flex min-h-screen flex-col bg-[#F6F7F9] text-gray-950">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-5">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Agent 调试台</h1>
          <p className="mt-0.5 text-xs text-gray-500">按对话查看 Agent 执行详情、步骤记录与事件流</p>
        </div>
        <Button type="button" variant="secondary" className="h-9 px-3" onClick={loadRuns} disabled={loadingRuns}>
          <RefreshCw className={clsx("h-4 w-4", loadingRuns && "animate-spin")} />
          刷新
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="min-h-0 border-r border-gray-200 bg-white">
          <div className="border-b border-gray-200 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Search className="h-4 w-4" />
              对话筛选
            </div>
            <div className="grid gap-2">
              <TextInput
                value={filters.conversationId}
                placeholder="conversationId"
                onChange={(event) => {
                  setPage(1);
                  setFilters((current) => ({ ...current, conversationId: event.target.value }));
                }}
              />
              <TextInput
                value={filters.traceId}
                placeholder="traceId"
                onChange={(event) => {
                  setPage(1);
                  setFilters((current) => ({ ...current, traceId: event.target.value }));
                }}
              />
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={filters.status}
                  onChange={(event) => {
                    setPage(1);
                    setFilters((current) => ({ ...current, status: event.target.value }));
                  }}
                >
                  <option value="">全部状态</option>
                  <option value="running">运行中</option>
                  <option value="succeeded">已成功</option>
                  <option value="failed">已失败</option>
                  <option value="cancelled">已取消</option>
                </Select>
                <Select
                  value={filters.agentName}
                  onChange={(event) => {
                    setPage(1);
                    setFilters((current) => ({ ...current, agentName: event.target.value }));
                  }}
                >
                  <option value="">全部 Agent</option>
                  {agentOptions.map((agentName) => (
                    <option key={agentName} value={agentName}>
                      {agentLabel(agentName)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto">
            {error ? (
              <div className="p-4">
                <InlineError message={error} />
              </div>
            ) : null}
            {loadingRuns ? (
              <RunListSkeleton />
            ) : runs.length ? (
              <div className="divide-y divide-gray-100">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelectedRunId(run.id)}
                    className={clsx(
                      "block w-full px-4 py-3 text-left transition hover:bg-gray-50",
                      selectedRunId === run.id && "bg-gray-950 text-white hover:bg-gray-950",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{run.conversationTitle}</div>
                        <div
                          className={clsx(
                            "mt-1 truncate text-xs",
                            selectedRunId === run.id ? "text-gray-300" : "text-gray-500",
                          )}
                        >
                          {run.inputSummary}
                        </div>
                      </div>
                      <StatusPill status={run.status} compact active={selectedRunId === run.id} />
                    </div>
                    <div
                      className={clsx(
                        "mt-3 flex flex-wrap items-center gap-2 text-xs",
                        selectedRunId === run.id ? "text-gray-300" : "text-gray-500",
                      )}
                    >
                      <span>{agentLabel(run.currentStep ?? "orchestrator")}</span>
                      <span>{formatDuration(run.durationMs)}</span>
                      <span>{formatDate(run.startedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-4 py-12 text-center text-sm text-gray-500">暂无 Agent 运行记录</div>
            )}
          </div>

          <div className="flex h-12 items-center justify-between border-t border-gray-200 px-4 text-xs text-gray-500">
            <span>
              共 {total} 条，第 {page} / {totalPages} 页
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md border border-gray-200 px-2 py-1 disabled:opacity-40"
                disabled={page <= 1 || loadingRuns}
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="rounded-md border border-gray-200 px-2 py-1 disabled:opacity-40"
                disabled={page >= totalPages || loadingRuns}
                onClick={() => setPage((current) => Math.min(current + 1, totalPages))}
              >
                下一页
              </button>
            </div>
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto">
          {loadingDetail ? (
            <DetailLoading />
          ) : detailError ? (
            <div className="p-5">
              <InlineError message={detailError} />
            </div>
          ) : detail ? (
            <AgentRunDetailView run={detail} />
          ) : (
            <EmptyDetail />
          )}
        </section>
      </div>
    </main>
  );
}

function AgentRunDetailView({ run }: { run: AgentRunDetail }) {
  const normalizedEvents = useMemo(() => run.events.map(normalizeEvent), [run.events]);

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-4 p-5">
      <section className="border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Bot className="h-4 w-4" />
                {run.conversationTitle}
              </div>
              <p className="mt-1 max-w-4xl text-sm leading-6 text-gray-600">{run.inputSummary}</p>
            </div>
            <StatusPill status={run.status} />
          </div>
        </div>
        <div className="grid gap-px bg-gray-200 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Run ID" value={run.id} mono />
          <Metric label="Conversation ID" value={run.conversationId} mono />
          <Metric label="Trace ID" value={run.traceId} mono />
          <Metric label="耗时" value={formatDuration(run.durationMs)} />
        </div>
      </section>

      <section className="border border-gray-200 bg-white">
        <SectionTitle
          icon={<Activity className="h-4 w-4" />}
          title="Agent 执行详情"
          subtitle="每个步骤展示已记录的输入摘要、思考摘要、输出摘要、模型与耗时"
        />
        <div className="divide-y divide-gray-200">
          {run.steps.length ? (
            run.steps.map((step, index) => (
              <AgentStepBlock key={step.id} index={index + 1} step={step} />
            ))
          ) : (
            <div className="px-5 py-10 text-sm text-gray-500">暂无 Agent 步骤记录</div>
          )}
        </div>
      </section>

      <section className="border border-gray-200 bg-white">
        <SectionTitle
          icon={<Sparkles className="h-4 w-4" />}
          title="事件流"
          subtitle="展示该对话运行中实时流式记录下来的 Agent 状态与输出片段"
        />
        <div className="divide-y divide-gray-100">
          {normalizedEvents.length ? (
            normalizedEvents.map((event) => <EventRow key={event.id} event={event} />)
          ) : (
            <div className="px-5 py-10 text-sm text-gray-500">暂无流式事件记录</div>
          )}
        </div>
      </section>

      {run.result !== undefined ? (
        <CollapsibleJson title="最终结果 JSON" value={run.result} defaultOpen={false} />
      ) : null}
    </div>
  );
}

function AgentStepBlock({
  index,
  step,
}: {
  index: number;
  step: AgentStep;
}) {
  const [open, setOpen] = useState(true);

  return (
    <article>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-gray-50"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-gray-50 text-xs font-semibold text-gray-600">
            {index}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-gray-950">{agentLabel(step.agentName)}</span>
              <StatusPill status={step.status} compact />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>{formatDuration(step.durationMs)}</span>
              <span>{step.modelName ?? "未记录模型"}</span>
              <span>{formatDate(step.startedAt)}</span>
            </div>
          </div>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
      </button>

      {open ? (
        <div className="grid gap-px bg-gray-200 lg:grid-cols-3">
          <StepTextBlock title="输入摘要" value={step.inputSummary} />
          <StepTextBlock title="思考摘要" value={step.outputSummary ?? "该步骤未写入输出摘要"} />
          <StepTextBlock
            title="执行记录"
            value={step.errorMessage ?? `状态：${statusLabel(step.status)}；模型：${step.modelName ?? "未记录"}；Token：${formatTokenUsage(step.tokenUsage)}`}
          />
          {step.tokenUsage !== undefined ? (
            <div className="bg-white p-4 lg:col-span-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-500">
                <Braces className="h-3.5 w-3.5" />
                Token Usage
              </div>
              <JsonViewer value={step.tokenUsage} />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function EventRow({ event }: { event: NormalizedEvent }) {
  const [open, setOpen] = useState(false);
  const hasData = event.data !== undefined || event.raw !== undefined;

  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-100 bg-sky-50 text-sky-700">
          <Activity className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-gray-950">{eventLabel(event.type)}</span>
            {event.step ? <span className="text-xs text-gray-500">{agentLabel(event.step)}</span> : null}
            <span className="text-xs text-gray-400">{formatDate(event.createdAt)}</span>
          </div>
          {event.content ? <p className="mt-1 text-sm leading-6 text-gray-700">{event.content}</p> : null}
          {hasData ? (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-950"
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              查看事件 JSON
            </button>
          ) : null}
          {open ? (
            <div className="mt-3">
              <JsonViewer value={event.data ?? event.raw} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CollapsibleJson({
  title,
  value,
  defaultOpen,
}: {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <section className="border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Braces className="h-4 w-4" />
          {title}
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
      </button>
      {open ? (
        <div className="border-t border-gray-200 p-5">
          <JsonViewer value={value} />
        </div>
      ) : null}
    </section>
  );
}

function StepTextBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="bg-white p-4">
      <div className="text-xs font-semibold text-gray-500">{title}</div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-800">{value}</p>
    </div>
  );
}

function SectionTitle({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="border-b border-gray-200 px-5 py-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
        {icon}
        {title}
      </div>
      <p className="mt-1 text-xs text-gray-500">{subtitle}</p>
    </div>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-white p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={clsx("mt-2 truncate text-sm font-semibold text-gray-950", mono && "font-mono text-xs")}>
        {value || "-"}
      </div>
    </div>
  );
}

function StatusPill({
  status,
  compact,
  active,
}: {
  status: string;
  compact?: boolean;
  active?: boolean;
}) {
  const meta = statusMeta(status);
  if (active) {
    return (
      <span className="inline-flex h-6 shrink-0 items-center rounded-full border border-white/15 bg-white/10 px-2 text-xs font-medium text-white">
        {compact ? meta.shortLabel : meta.label}
      </span>
    );
  }
  return <AdminStatusBadge label={compact ? meta.shortLabel : meta.label} tone={meta.tone} />;
}

function RunListSkeleton() {
  return (
    <div className="divide-y divide-gray-100">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="px-4 py-3">
          <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100" />
          <div className="mt-3 h-3 w-full animate-pulse rounded bg-gray-100" />
          <div className="mt-3 h-3 w-1/2 animate-pulse rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

function DetailLoading() {
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-4 p-5">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="border border-gray-200 bg-white p-5">
          <div className="h-5 w-44 animate-pulse rounded bg-gray-100" />
          <div className="mt-4 h-20 animate-pulse rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gray-200 bg-white">
          <Bot className="h-5 w-5 text-gray-500" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-gray-950">选择一条 Agent 运行记录</h2>
        <p className="mt-2 text-sm leading-6 text-gray-500">左侧按对话或 traceId 筛选后，可以查看该轮对话里每个 Agent 的执行详情。</p>
      </div>
    </div>
  );
}

type NormalizedEvent = {
  id: string;
  type: string;
  step?: string;
  content?: string;
  data?: unknown;
  raw?: unknown;
  createdAt: string;
};

function normalizeEvent(event: StreamEvent): NormalizedEvent {
  const outer = asRecord(event.payload);
  const payload = asRecord(outer?.payload) ?? outer;
  return {
    id: event.id,
    type: toText(payload?.eventType ?? payload?.type ?? outer?.eventType ?? event.eventType, event.eventType),
    step: toOptionalText(payload?.step),
    content: toOptionalText(payload?.content),
    data: payload?.payload ?? payload?.data,
    raw: event.payload,
    createdAt: toText(payload?.createdAt ?? event.createdAt, event.createdAt),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function toOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function statusMeta(status: string): {
  label: string;
  shortLabel: string;
  tone: "gray" | "green" | "red" | "amber" | "blue";
} {
  switch (status) {
    case "succeeded":
      return { label: "已成功", shortLabel: "成功", tone: "green" };
    case "failed":
      return { label: "已失败", shortLabel: "失败", tone: "red" };
    case "running":
      return { label: "运行中", shortLabel: "运行", tone: "blue" };
    case "pending":
      return { label: "等待中", shortLabel: "等待", tone: "amber" };
    case "skipped":
      return { label: "已跳过", shortLabel: "跳过", tone: "gray" };
    case "cancelled":
      return { label: "已取消", shortLabel: "取消", tone: "gray" };
    default:
      return { label: status, shortLabel: status, tone: "gray" };
  }
}

function statusLabel(status: string) {
  return statusMeta(status).label;
}

function agentLabel(agentName: string) {
  const map: Record<string, string> = {
    orchestrator: "编排器",
    intent_agent: "意图 Agent",
    knowledge_agent: "知识 Agent",
    requirement_analyst_agent: "需求分析 Agent",
    product_designer_agent: "产品设计 Agent",
    prd_writer_agent: "PRD Agent",
    prototype_designer_agent: "原型设计 Agent",
    prototype_code_agent: "原型代码 Agent",
    patch_agent: "Patch Agent",
    qa_agent: "QA Agent",
    knowledge_extractor_agent: "知识抽取 Agent",
  };
  return map[agentName] ?? agentName;
}

function eventLabel(type: string) {
  const map: Record<string, string> = {
    agent_step: "Agent 步骤",
    agent_started: "Agent 开始",
    agent_completed: "Agent 完成",
    run_started: "运行开始",
    run_completed: "运行完成",
    error: "错误",
  };
  return map[type] ?? type;
}

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(value?: number) {
  if (typeof value !== "number") return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatTokenUsage(value: unknown) {
  const record = asRecord(value);
  if (!record) return "未记录";
  const prompt = record.promptTokens ?? record.prompt_tokens ?? record.inputTokens;
  const completion = record.completionTokens ?? record.completion_tokens ?? record.outputTokens;
  if (prompt === undefined && completion === undefined) return "已记录";
  return `${prompt ?? 0}/${completion ?? 0}`;
}
