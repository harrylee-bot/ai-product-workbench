"use client";

import { Activity, AlertTriangle, DatabaseZap, FileWarning, FolderKanban, Users, Workflow } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin-shell";
import { AdminPanel } from "@/components/admin-ui";
import { InlineError } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import type { AdminDashboardStats } from "@/lib/types";

const statItems = [
  { key: "userCount", label: "用户数", icon: Users, href: "/admin/users" },
  { key: "projectCount", label: "项目数", icon: FolderKanban, href: "/admin/projects" },
  { key: "todayRuntimeRunCount", label: "今日 Runtime Run", icon: Workflow, href: "/admin/logs/runtime-runs" },
  { key: "todayModelCallCount", label: "今日模型调用", icon: Activity, href: "/admin/logs/model-calls" },
  { key: "todayFailedModelCallCount", label: "今日失败调用", icon: AlertTriangle, href: "/admin/logs/model-calls" },
  { key: "pendingKnowledgeCandidateCount", label: "待审核知识候选", icon: DatabaseZap, href: "/admin/knowledge/candidates" },
  { key: "failedFileParseCount", label: "解析失败文件", icon: FileWarning, href: "/admin/logs/file-parses" },
  { key: "qaFailedProjectCount", label: "QA 未通过项目", icon: AlertTriangle, href: "/admin/logs/qa-reports" },
] as const;

export function AdminDashboardClient() {
  const [stats, setStats] = useState<AdminDashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<AdminDashboardStats>("/admin/dashboard/stats")
      .then(setStats)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "概览加载失败"));
  }, []);

  return (
    <AdminShell title="概览">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-gray-950">系统运行概览</h2>
        <p className="mt-2 text-sm text-gray-500">内测后台核心状态与排查入口</p>
      </div>
      {error ? <InlineError message={error} /> : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statItems.map((item) => {
          const Icon = item.icon;
          const value = stats?.[item.key] ?? 0;
          return (
            <Link key={item.key} href={item.href}>
              <AdminPanel className="h-[112px] p-4 transition hover:border-gray-300 hover:shadow-md">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-500">{item.label}</div>
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-700">
                    <Icon className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-4 text-3xl font-semibold tabular-nums text-gray-950">
                  {stats ? value : "-"}
                </div>
              </AdminPanel>
            </Link>
          );
        })}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {[
          { title: "模型管理", href: "/admin/model-providers", text: "供应商、模型配置、任务映射" },
          { title: "知识库", href: "/admin/knowledge/vault", text: "Obsidian Vault、知识条目、候选审核" },
          { title: "日志中心", href: "/admin/logs/runtime-runs", text: "Runtime、模型、文件、QA" },
        ].map((item) => (
          <Link key={item.href} href={item.href}>
            <AdminPanel className="p-4 transition hover:border-gray-300 hover:shadow-md">
              <div className="font-medium text-gray-950">{item.title}</div>
              <div className="mt-2 text-sm text-gray-500">{item.text}</div>
            </AdminPanel>
          </Link>
        ))}
      </div>
    </AdminShell>
  );
}
