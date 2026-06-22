"use client";

import { BookOpen, CheckCircle2, ExternalLink, FolderOpen, RefreshCw, Server, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin-shell";
import { AdminPanel, AdminStatusBadge, EmptyRow, LoadingRows } from "@/components/admin-ui";
import { Button, InlineError } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import type { KnowledgeVaultEntry, KnowledgeVaultStatus, KnowledgeVaultSyncResult } from "@/lib/types";

const KNOWLEDGE_APP_URL =
  process.env.NEXT_PUBLIC_KNOWLEDGE_APP_URL ?? "http://8.130.160.177:3001";

export function AdminKnowledgeVaultClient() {
  const [status, setStatus] = useState<KnowledgeVaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<KnowledgeVaultSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<KnowledgeVaultStatus>("/admin/knowledge/vault");
      setStatus(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "知识库状态加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function initializeVault() {
    setInitializing(true);
    setError(null);
    setNotice(null);
    setSyncResult(null);
    try {
      const result = await apiRequest<KnowledgeVaultStatus>("/admin/knowledge/vault/init", {
        method: "POST",
      });
      setStatus(result);
      setNotice("Obsidian 兼容知识库已初始化");
    } catch (initError) {
      setError(initError instanceof Error ? initError.message : "知识库初始化失败");
    } finally {
      setInitializing(false);
    }
  }

  async function syncVault() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    setSyncResult(null);
    try {
      const result = await apiRequest<KnowledgeVaultSyncResult>("/admin/knowledge/vault/sync", {
        method: "POST",
      });
      setSyncResult(result);
      setNotice(`已同步 ${result.chunks} 个知识切片到系统知识库`);
      await loadStatus();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "知识库同步失败");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <AdminShell
      title="Obsidian 知识库"
      actions={
        <div className="flex items-center gap-2">
          <a
            href={KNOWLEDGE_APP_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 text-sm font-medium text-white transition hover:bg-gray-800"
          >
            <ExternalLink className="h-4 w-4" />
            进入知识库系统
          </a>
          <Button type="button" variant="secondary" onClick={() => void loadStatus()} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          <Button type="button" variant="secondary" onClick={() => void syncVault()} disabled={syncing || loading}>
            <RefreshCw className="h-4 w-4" />
            同步到系统知识库
          </Button>
          <Button type="button" onClick={() => void initializeVault()} disabled={initializing}>
            <Sparkles className="h-4 w-4" />
            初始化知识库
          </Button>
        </div>
      }
    >
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-gray-950">开源知识库前端</h2>
        <p className="mt-2 text-sm text-gray-500">SilverBullet 已挂载同一个 Markdown Vault，可直接进入系统维护和查看知识库。</p>
      </div>

      {notice ? <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div> : null}
      {error ? <div className="mb-4"><InlineError message={error} /></div> : null}

      {syncResult ? (
        <AdminPanel className="mb-4 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-950">系统知识库同步结果</div>
              <div className="mt-1 text-sm text-gray-500">Markdown 已切片并写入可检索知识项</div>
            </div>
            <AdminStatusBadge label="已同步" tone="green" />
          </div>
          <div className="grid gap-3 md:grid-cols-6">
            <SyncMetric label="文件" value={syncResult.markdownFiles} />
            <SyncMetric label="切片" value={syncResult.chunks} />
            <SyncMetric label="新增" value={syncResult.created} />
            <SyncMetric label="更新" value={syncResult.updated} />
            <SyncMetric label="未变" value={syncResult.unchanged} />
            <SyncMetric label="归档" value={syncResult.archived} />
          </div>
          <div className="mt-3 text-xs text-gray-500">分类：{syncResult.categories.join("、") || "-"}</div>
        </AdminPanel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-4">
        <MetricCard icon={CheckCircle2} label="初始化状态" value={status?.initialized ? "已初始化" : "未初始化"} tone={status?.initialized ? "green" : "amber"} />
        <MetricCard icon={FolderOpen} label="目录数量" value={loading ? "-" : String(status?.folderCount ?? 0)} tone="blue" />
        <MetricCard icon={BookOpen} label="Markdown 文件" value={loading ? "-" : String(status?.markdownCount ?? 0)} tone="blue" />
        <MetricCard icon={Server} label="存储状态" value={status?.rootExists ? "目录存在" : "待创建"} tone={status?.rootExists ? "green" : "amber"} />
      </div>

      <AdminPanel className="mt-4 p-4">
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-gray-200 pb-4">
          <div>
            <div className="text-sm font-medium text-gray-950">知识库前端地址</div>
            <div className="mt-1 break-all font-mono text-xs text-gray-500">{KNOWLEDGE_APP_URL}</div>
          </div>
          <AdminStatusBadge label="已部署" tone="green" />
        </div>
        <div className="text-sm font-medium text-gray-950">Vault 路径</div>
        <div className="mt-2 break-all rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700">
          {status?.vaultRoot ?? "-"}
        </div>
        <p className="mt-3 text-sm leading-6 text-gray-500">
          本地仓库也包含一份 <span className="font-mono">knowledge-vault</span> 模板，可以直接用 Obsidian 打开维护；线上 Vault 用于服务器运行环境。
        </p>
      </AdminPanel>

      <div className="mt-4 grid gap-4 xl:grid-cols-[360px_1fr]">
        <AdminPanel className="overflow-hidden">
          <SectionHeader title="知识目录" subtitle="系统预置的中文知识分类" />
          <div className="divide-y divide-gray-200">
            {loading ? <SkeletonList rows={6} /> : null}
            {!loading && !status?.folders.length ? <EmptyBlock label="暂无目录，请先初始化知识库" /> : null}
            {!loading ? status?.folders.map((folder) => (
              <EntryRow key={folder.path} entry={folder} />
            )) : null}
          </div>
        </AdminPanel>

        <AdminPanel className="overflow-hidden">
          <SectionHeader title="最近 Markdown 文件" subtitle="用于人工维护和后续系统融合" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-gray-50 text-xs font-medium text-gray-500">
                <tr>
                  <th className="px-4 py-3">文件</th>
                  <th className="px-4 py-3">路径</th>
                  <th className="px-4 py-3">大小</th>
                  <th className="px-4 py-3">更新时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 text-gray-700">
                {loading ? <LoadingRows columns={4} rows={5} /> : null}
                {!loading && !status?.recentFiles.length ? <EmptyRow columns={4} label="暂无 Markdown 文件" /> : null}
                {!loading ? status?.recentFiles.map((file) => (
                  <tr key={file.path} className="hover:bg-gray-50/70">
                    <td className="px-4 py-3 font-medium text-gray-950">{file.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{file.path}</td>
                    <td className="px-4 py-3 text-gray-500">{formatSize(file.size)}</td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(file.updatedAt)}</td>
                  </tr>
                )) : null}
              </tbody>
            </table>
          </div>
        </AdminPanel>
      </div>
    </AdminShell>
  );
}

function SyncMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-gray-950">{value}</div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
  tone: "green" | "amber" | "blue";
}) {
  return (
    <AdminPanel className="p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-500">{label}</div>
        <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-700">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold text-gray-950">{value}</div>
        <AdminStatusBadge label={tone === "green" ? "正常" : tone === "amber" ? "待处理" : "可维护"} tone={tone} />
      </div>
    </AdminPanel>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-gray-200 bg-white px-4 py-4">
      <div className="font-medium text-gray-950">{title}</div>
      <div className="mt-1 text-sm text-gray-500">{subtitle}</div>
    </div>
  );
}

function EntryRow({ entry }: { entry: KnowledgeVaultEntry }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate font-medium text-gray-950">{entry.name}</div>
        <div className="mt-1 truncate font-mono text-xs text-gray-500">{entry.path}</div>
      </div>
      <AdminStatusBadge label={entry.type === "directory" ? "目录" : "文件"} tone="gray" />
    </div>
  );
}

function SkeletonList({ rows }: { rows: number }) {
  return Array.from({ length: rows }).map((_, index) => (
    <div key={index} className="px-4 py-3">
      <div className="h-5 animate-pulse rounded bg-gray-100" />
      <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-gray-100" />
    </div>
  ));
}

function EmptyBlock({ label }: { label: string }) {
  return <div className="px-4 py-12 text-center text-sm text-gray-500">{label}</div>;
}

function formatSize(value?: number) {
  if (!value) return "-";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
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
