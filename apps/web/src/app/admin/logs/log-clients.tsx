"use client";

import { RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/admin-shell";
import {
  AdminDrawer,
  AdminFilterBar,
  AdminPagination,
  AdminStatusBadge,
  AdminTable,
  DetailGrid,
  DetailItem,
  EmptyRow,
  JsonViewer,
  LoadingRows,
} from "@/components/admin-ui";
import { Button, InlineError, Select, TextInput } from "@/components/ui";
import { apiRequest, toQueryString } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/types";

type Column<T> = {
  label: string;
  render: (item: T) => React.ReactNode;
};

type Filter = {
  key: string;
  placeholder: string;
  type?: "text" | "select";
  options?: string[];
};

type LogPageConfig<T extends { id: string }> = {
  title: string;
  subtitle: string;
  path: string;
  detailPath: (id: string) => string;
  columns: Column<T>[];
  filters: Filter[];
  minWidth?: number;
};

type RuntimeRunItem = {
  id: string;
  projectTitle: string;
  userDisplayName: string;
  conversationTitle: string;
  status: string;
  currentStep?: string;
  traceId: string;
  errorMessage?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
};

type ModelCallItem = {
  id: string;
  taskType: string;
  runtimeName?: string;
  modelName: string;
  providerName: string;
  status: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  errorMessage?: string;
  createdAt: string;
};

type FileParseItem = {
  id: string;
  originalName: string;
  projectTitle: string;
  uploaderDisplayName: string;
  extension: string;
  size: number;
  status: string;
  parserType?: string;
  parseError?: string;
  createdAt: string;
};

type PatchItem = {
  id: string;
  projectTitle: string;
  createdBy: string;
  targetSummary: string;
  instructionSummary: string;
  status: string;
  beforeProductDesignStateVersion: number;
  afterProductDesignStateVersion?: number;
  errorMessage?: string;
  createdAt: string;
};

type QaReportItem = {
  id: string;
  projectTitle: string;
  status: string;
  trigger: string;
  productDesignStateVersion: number;
  issueCount: number;
  criticalIssueCount: number;
  summary?: string;
  runId: string;
  createdAt: string;
};

const runtimeRunConfig: LogPageConfig<RuntimeRunItem> = {
  title: "Runtime Run 日志",
  subtitle: "Runtime 运行、步骤、traceId 与错误摘要",
  path: "/admin/logs/runtime-runs",
  detailPath: (id) => `/admin/logs/runtime-runs/${id}`,
  minWidth: 1180,
  filters: [
    { key: "projectId", placeholder: "projectId" },
    { key: "userId", placeholder: "userId" },
    { key: "traceId", placeholder: "traceId" },
    { key: "status", placeholder: "状态", type: "select", options: ["running", "succeeded", "failed", "cancelled"] },
  ],
  columns: [
    { label: "runId", render: (item) => <Mono>{item.id}</Mono> },
    { label: "项目", render: (item) => item.projectTitle },
    { label: "用户", render: (item) => item.userDisplayName },
    { label: "状态", render: (item) => <StatusBadge status={item.status} /> },
    { label: "当前步骤", render: (item) => item.currentStep ?? "-" },
    { label: "开始时间", render: (item) => formatDate(item.startedAt) },
    { label: "耗时", render: (item) => formatDuration(item.durationMs) },
  ],
};

const modelCallConfig: LogPageConfig<ModelCallItem> = {
  title: "模型调用日志",
  subtitle: "任务类型、模型、token、耗时与错误信息",
  path: "/admin/logs/model-calls",
  detailPath: (id) => `/admin/logs/model-calls/${id}`,
  minWidth: 1200,
  filters: [
    { key: "runId", placeholder: "runId" },
    { key: "traceId", placeholder: "traceId" },
    { key: "runtimeName", placeholder: "runtimeName" },
    { key: "modelName", placeholder: "modelName" },
    { key: "status", placeholder: "状态", type: "select", options: ["running", "succeeded", "failed"] },
  ],
  columns: [
    { label: "调用时间", render: (item) => formatDate(item.createdAt) },
    { label: "任务类型", render: (item) => item.taskType },
    { label: "调用方", render: (item) => item.runtimeName ?? "-" },
    { label: "模型", render: (item) => item.modelName },
    { label: "供应商", render: (item) => item.providerName },
    { label: "状态", render: (item) => <StatusBadge status={item.status} /> },
    { label: "Token", render: (item) => `${item.promptTokens ?? 0}/${item.completionTokens ?? 0}` },
    { label: "耗时", render: (item) => formatDuration(item.durationMs) },
  ],
};

const fileParseConfig: LogPageConfig<FileParseItem> = {
  title: "文件解析日志",
  subtitle: "上传文件、解析器、解析状态与失败原因",
  path: "/admin/logs/file-parses",
  detailPath: (id) => `/admin/logs/file-parses/${id}`,
  minWidth: 1180,
  filters: [
    { key: "projectId", placeholder: "projectId" },
    { key: "uploadedBy", placeholder: "uploadedBy" },
    { key: "extension", placeholder: "扩展名" },
    { key: "status", placeholder: "状态", type: "select", options: ["uploaded", "parsing", "parsed", "parse_failed", "unsupported"] },
  ],
  columns: [
    { label: "文件名", render: (item) => item.originalName },
    { label: "项目", render: (item) => item.projectTitle },
    { label: "上传人", render: (item) => item.uploaderDisplayName },
    { label: "类型", render: (item) => item.extension },
    { label: "大小", render: (item) => formatBytes(item.size) },
    { label: "状态", render: (item) => <StatusBadge status={item.status} /> },
    { label: "解析器", render: (item) => item.parserType ?? "-" },
    { label: "上传时间", render: (item) => formatDate(item.createdAt) },
  ],
};

const patchConfig: LogPageConfig<PatchItem> = {
  title: "Patch 日志",
  subtitle: "局部修改计划、操作、状态与影响范围",
  path: "/admin/logs/patches",
  detailPath: (id) => `/admin/logs/patches/${id}`,
  minWidth: 1180,
  filters: [
    { key: "projectId", placeholder: "projectId" },
    { key: "createdBy", placeholder: "createdBy" },
    { key: "status", placeholder: "状态", type: "select", options: ["planned", "applying", "applied", "failed", "cancelled", "needs_confirmation"] },
  ],
  columns: [
    { label: "Patch ID", render: (item) => <Mono>{item.id}</Mono> },
    { label: "项目", render: (item) => item.projectTitle },
    { label: "用户", render: (item) => item.createdBy },
    { label: "修改目标", render: (item) => item.targetSummary },
    { label: "状态", render: (item) => <StatusBadge status={item.status} /> },
    { label: "版本", render: (item) => `${item.beforeProductDesignStateVersion} -> ${item.afterProductDesignStateVersion ?? "-"}` },
    { label: "创建时间", render: (item) => formatDate(item.createdAt) },
  ],
};

const qaConfig: LogPageConfig<QaReportItem> = {
  title: "QA 报告",
  subtitle: "QA 校验结果、问题数量与关联 runId",
  path: "/admin/logs/qa-reports",
  detailPath: (id) => `/admin/logs/qa-reports/${id}`,
  minWidth: 1160,
  filters: [
    { key: "projectId", placeholder: "projectId" },
    { key: "status", placeholder: "状态", type: "select", options: ["running", "passed", "failed", "warning"] },
    { key: "trigger", placeholder: "触发方式", type: "select", options: ["initial_generation", "patch", "manual", "rollback", "pre_confirm"] },
  ],
  columns: [
    { label: "QA ID", render: (item) => <Mono>{item.id}</Mono> },
    { label: "项目", render: (item) => item.projectTitle },
    { label: "状态", render: (item) => <StatusBadge status={item.status} /> },
    { label: "触发", render: (item) => item.trigger },
    { label: "State", render: (item) => `v${item.productDesignStateVersion}` },
    { label: "问题数", render: (item) => item.issueCount },
    { label: "严重问题", render: (item) => item.criticalIssueCount },
    { label: "runId", render: (item) => <Mono>{item.runId}</Mono> },
    { label: "生成时间", render: (item) => formatDate(item.createdAt) },
  ],
};

export function RuntimeRunsLogClient() {
  return <LogPage config={runtimeRunConfig} />;
}

export function ModelCallsLogClient() {
  return <LogPage config={modelCallConfig} />;
}

export function FileParsesLogClient() {
  return <LogPage config={fileParseConfig} />;
}

export function PatchesLogClient() {
  return <LogPage config={patchConfig} />;
}

export function QaReportsLogClient() {
  return <LogPage config={qaConfig} />;
}

function LogPage<T extends { id: string }>({ config }: { config: LogPageConfig<T> }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [detailTitle, setDetailTitle] = useState("详情");

  const queryParams = useMemo(() => {
    const params: Record<string, string | number | undefined> = { page, pageSize };
    config.filters.forEach((filter) => {
      params[filter.key] = filters[filter.key] || undefined;
    });
    return params;
  }, [config.filters, filters, page, pageSize]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<PaginatedResponse<T>>(`${config.path}${toQueryString(queryParams)}`);
      setItems(result.items);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [config.path, queryParams]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function openDetail(item: T) {
    setDetailTitle(item.id);
    try {
      setDetail(await apiRequest(config.detailPath(item.id)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "详情加载失败");
    }
  }

  return (
    <AdminShell title={config.title}>
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-gray-950">{config.title}</h2>
        <p className="mt-2 text-sm text-gray-500">{config.subtitle}</p>
      </div>
      <AdminFilterBar>
        {config.filters.map((filter) => filter.type === "select" ? (
          <Select key={filter.key} value={filters[filter.key] ?? ""} onChange={(event) => { setFilters({ ...filters, [filter.key]: event.target.value }); setPage(1); }}>
            <option value="">{filter.placeholder}</option>
            {filter.options?.map((option) => <option key={option} value={option}>{option}</option>)}
          </Select>
        ) : (
          <div key={filter.key} className="relative w-[220px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <TextInput value={filters[filter.key] ?? ""} onChange={(event) => { setFilters({ ...filters, [filter.key]: event.target.value }); setPage(1); }} placeholder={filter.placeholder} className="h-10 pl-9" />
          </div>
        ))}
        <Button type="button" variant="ghost" onClick={() => void loadItems()}><RotateCcw className="h-4 w-4" />刷新</Button>
      </AdminFilterBar>
      {error ? <div className="mt-4"><InlineError message={error} /></div> : null}
      <div className="mt-4">
        <AdminTable columns={[...config.columns.map((column) => column.label), "操作"]} minWidth={config.minWidth ?? 1080}>
          {loading ? <LoadingRows columns={config.columns.length + 1} /> : null}
          {!loading && items.length === 0 ? <EmptyRow columns={config.columns.length + 1} label="暂无日志" /> : null}
          {!loading ? items.map((item) => (
            <tr key={item.id} className="hover:bg-gray-50/70">
              {config.columns.map((column) => <td key={column.label} className="px-4 py-3">{column.render(item)}</td>)}
              <td className="px-4 py-3 text-right"><Button type="button" variant="ghost" onClick={() => void openDetail(item)}>详情</Button></td>
            </tr>
          )) : null}
        </AdminTable>
      </div>
      <AdminPagination page={page} pageSize={pageSize} total={total} loading={loading} onPageChange={setPage} />
      <AdminDrawer open={detail !== null} title={detailTitle} onClose={() => setDetail(null)}>
        <LogDetail value={detail} />
      </AdminDrawer>
    </AdminShell>
  );
}

function LogDetail({ value }: { value: unknown }) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return (
    <div className="space-y-5">
      <DetailGrid>
        {["id", "runId", "traceId", "projectId", "projectTitle", "status", "createdAt", "startedAt", "durationMs"].map((key) => (
          key in record ? <DetailItem key={key} label={key} value={formatValue(record[key])} /> : null
        ))}
      </DetailGrid>
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gray-950">详情 JSON</h3>
        <JsonViewer value={value} />
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status.includes("failed") || status === "parse_failed" ? "red" : status === "succeeded" || status === "passed" || status === "applied" || status === "parsed" ? "green" : status === "running" || status === "parsing" ? "blue" : "gray";
  return <AdminStatusBadge label={status} tone={tone} />;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-gray-600">{children}</span>;
}

function formatValue(value: unknown) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDate(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(value?: number) {
  if (!value) return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}
