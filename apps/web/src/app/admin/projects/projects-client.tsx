"use client";

import { RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
  LoadingRows,
} from "@/components/admin-ui";
import { Button, InlineError, Select, TextInput } from "@/components/ui";
import { apiRequest, toQueryString } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/types";

type AdminProject = {
  id: string;
  title: string;
  description?: string;
  status: string;
  ownerId: string;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerEmail?: string;
  conversationCount: number;
  agentRunCount: number;
  patchCount: number;
  fileCount: number;
  lastActivityAt: string;
  createdAt: string;
};

type ProjectDetail = {
  project: AdminProject & {
    counts: Record<string, number>;
    currentConversationId?: string;
    currentProductDesignStateId?: string;
    currentPrdDocumentId?: string;
    currentPrototypeArtifactId?: string;
    latestQaReportId?: string;
  };
  conversations: { id: string; title: string; status: string; messageCount: number; lastMessageAt?: string }[];
  productDesignState?: { id: string; version: number; title: string; summary?: string; status: string; businessGoal: string; updatedAt: string };
  prd?: { id: string; title: string; status: string; productDesignStateVersion: number; updatedAt: string };
  prototype?: { id: string; title: string; status: string; targetDevice: string; pageCount: number; previewUrl?: string; updatedAt: string };
};

const projectStatuses = ["draft", "clarifying", "designing", "prd_ready", "prototype_ready", "qa_failed", "completed", "archived", "deleted"];

export function AdminProjectsClient() {
  const [keyword, setKeyword] = useState("");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [items, setItems] = useState<AdminProject[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = toQueryString({
        keyword: keyword.trim() || undefined,
        owner: owner.trim() || undefined,
        status: status || undefined,
        page,
        pageSize,
      });
      const result = await apiRequest<PaginatedResponse<AdminProject>>(`/admin/projects${query}`);
      setItems(result.items);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "项目列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [keyword, owner, page, pageSize, status]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  async function openDetail(projectId: string) {
    setDetailError(null);
    try {
      setDetail(await apiRequest<ProjectDetail>(`/admin/projects/${projectId}`));
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : "项目详情加载失败");
    }
  }

  return (
    <AdminShell title="项目管理">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-gray-950">项目管理</h2>
        <p className="mt-2 text-sm text-gray-500">只读查看用户项目、运行状态与当前产物</p>
      </div>
      <AdminFilterBar>
        <div className="relative w-[260px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <TextInput
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value);
              setPage(1);
            }}
            placeholder="搜索项目标题"
            className="h-10 pl-9"
          />
        </div>
        <TextInput
          value={owner}
          onChange={(event) => {
            setOwner(event.target.value);
            setPage(1);
          }}
          placeholder="搜索 Owner"
          className="h-10 w-[220px]"
        />
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          {projectStatuses.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </Select>
        <Button type="button" variant="ghost" onClick={() => void loadProjects()}>
          <RotateCcw className="h-4 w-4" />
          刷新
        </Button>
      </AdminFilterBar>
      {error ? <div className="mt-4"><InlineError message={error} /></div> : null}
      <div className="mt-4">
        <AdminTable columns={["项目名称", "Owner", "状态", "会话数", "最后活动", "创建时间", "操作"]}>
          {loading ? <LoadingRows columns={7} /> : null}
          {!loading && items.length === 0 ? <EmptyRow columns={7} label="暂无项目" /> : null}
          {!loading
            ? items.map((project) => (
                <tr key={project.id} className="hover:bg-gray-50/70">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-950">{project.title}</div>
                    <div className="mt-1 max-w-[320px] truncate text-xs text-gray-500">{project.description ?? "-"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{project.ownerDisplayName}</div>
                    <div className="text-xs text-gray-500">{project.ownerUsername}</div>
                  </td>
                  <td className="px-4 py-3"><ProjectStatusBadge status={project.status} /></td>
                  <td className="px-4 py-3 tabular-nums">{project.conversationCount}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(project.lastActivityAt)}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(project.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button type="button" variant="ghost" onClick={() => void openDetail(project.id)}>详情</Button>
                  </td>
                </tr>
              ))
            : null}
        </AdminTable>
      </div>
      <AdminPagination page={page} pageSize={pageSize} total={total} loading={loading} onPageChange={setPage} />
      {detailError ? <div className="mt-4"><InlineError message={detailError} /></div> : null}
      <ProjectDetailDrawer detail={detail} onClose={() => setDetail(null)} />
    </AdminShell>
  );
}

function ProjectDetailDrawer({ detail, onClose }: { detail: ProjectDetail | null; onClose: () => void }) {
  return (
    <AdminDrawer open={Boolean(detail)} title={detail?.project.title ?? "项目详情"} onClose={onClose}>
      {detail ? (
        <div className="space-y-5">
          <DetailGrid>
            <DetailItem label="Owner" value={`${detail.project.ownerDisplayName} / ${detail.project.ownerUsername}`} />
            <DetailItem label="状态" value={<ProjectStatusBadge status={detail.project.status} />} />
            <DetailItem label="会话数" value={detail.project.counts.conversations} />
            <DetailItem label="消息数" value={detail.project.counts.messages} />
            <DetailItem label="Runtime Run" value={detail.project.counts.agentRuns} />
            <DetailItem label="Patch" value={detail.project.counts.patchRecords} />
          </DetailGrid>
          <Section title="ProductDesignState">
            {detail.productDesignState ? (
              <DetailGrid>
                <DetailItem label="State ID" value={detail.productDesignState.id} />
                <DetailItem label="版本" value={detail.productDesignState.version} />
                <DetailItem label="状态" value={detail.productDesignState.status} />
                <DetailItem label="更新时间" value={formatDate(detail.productDesignState.updatedAt)} />
                <DetailItem label="标题" value={detail.productDesignState.title} />
                <DetailItem label="目标" value={detail.productDesignState.businessGoal} />
              </DetailGrid>
            ) : <div className="text-sm text-gray-500">暂无 State</div>}
          </Section>
          <Section title="当前 PRD / 原型">
            <DetailGrid>
              <DetailItem label="PRD" value={detail.prd ? `${detail.prd.title} / ${detail.prd.status}` : "-"} />
              <DetailItem label="原型" value={detail.prototype ? `${detail.prototype.title} / ${detail.prototype.status}` : "-"} />
              <DetailItem label="原型页数" value={detail.prototype?.pageCount ?? "-"} />
              <DetailItem label="QA ID" value={detail.project.latestQaReportId ?? "-"} />
            </DetailGrid>
          </Section>
          <Section title="最近会话">
            <div className="divide-y divide-gray-200 rounded-lg border border-gray-200">
              {detail.conversations.length ? detail.conversations.map((conversation) => (
                <div key={conversation.id} className="px-3 py-2 text-sm">
                  <div className="font-medium text-gray-950">{conversation.title}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    {conversation.status} / {conversation.messageCount} 条消息 / {formatDate(conversation.lastMessageAt)}
                  </div>
                </div>
              )) : <div className="px-3 py-8 text-center text-sm text-gray-500">暂无会话</div>}
            </div>
          </Section>
        </div>
      ) : null}
    </AdminDrawer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-gray-950">{title}</h3>
      {children}
    </section>
  );
}

function ProjectStatusBadge({ status }: { status: string }) {
  const tone = status === "qa_failed" || status === "deleted" ? "red" : status === "completed" || status === "prototype_ready" ? "green" : status === "archived" ? "gray" : "blue";
  return <AdminStatusBadge label={status} tone={tone} />;
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
