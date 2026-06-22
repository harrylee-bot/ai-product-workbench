"use client";

import { MessageCircle, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { UserMenu } from "@/components/user-menu";

export type Phase1Project = {
  id: string;
  title: string;
  status: string;
  currentConversationId?: string | null;
  defaultConversationId?: string | null;
};

export function ProjectList({
  projects,
  selectedProjectId,
  loading,
  collapsed,
  onToggleCollapsed,
  onSelectProject,
}: {
  projects: Phase1Project[];
  selectedProjectId?: string;
  loading?: boolean;
  collapsed?: boolean;
  onToggleCollapsed: () => void;
  onSelectProject: (project: Phase1Project) => void;
}) {
  if (collapsed) {
    return (
      <aside className="flex min-h-0 flex-col items-center border-r border-gray-200 bg-white py-4">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-gray-700 hover:bg-gray-100"
          aria-label="展开最近对话"
        >
          <PanelLeftOpen className="h-5 w-5" />
        </button>
        <div className="mt-8 flex flex-col gap-4">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-gray-700 hover:bg-gray-100"
            aria-label="查看最近对话"
          >
            <MessageCircle className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-gray-700 hover:bg-gray-100"
            aria-label="搜索最近对话"
          >
            <Search className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-auto">
          <UserMenu compact placement="top" />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-0 flex-col border-r border-gray-200 bg-white">
      <div className="px-5 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xl font-semibold tracking-[-0.01em] text-gray-950">智能产品工作台</div>
            <div className="mt-1 text-xs leading-5 text-gray-500">说出目标，系统自动决策与生成</div>
          </div>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            aria-label="收起最近对话"
          >
            <PanelLeftClose className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-8 text-sm font-semibold text-gray-950">最近对话</div>
        <div className="mt-1 text-xs leading-5 text-gray-500">历史对话会按最近更新自动排序</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="px-3 py-4 text-sm text-gray-500">加载项目中...</div>
        ) : projects.length ? (
          projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project)}
              className={[
                "mb-1 w-full rounded-xl px-3 py-2.5 text-left transition",
                selectedProjectId === project.id
                  ? "bg-gray-100 text-gray-950"
                  : "text-gray-700 hover:bg-gray-100",
              ].join(" ")}
            >
              <div className="truncate text-sm font-medium">{projectTitleLabel(project.title)}</div>
              <div className="mt-1 text-xs text-gray-400">
                {projectStatusLabel(project.status)}
              </div>
            </button>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-500">
            暂无项目。直接在中间输入需求，系统会自动创建工作空间。
          </div>
        )}
      </div>
      <div className="border-t border-gray-200 p-3">
        <UserMenu placement="top" />
      </div>
    </aside>
  );
}

function projectTitleLabel(title: string) {
  return title.replace(/Triple System/g, "三系统融合").replace(/AI Product Workbench/g, "智能产品工作台");
}

function projectStatusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    clarifying: "澄清中",
    designing: "设计中",
    generating: "生成中",
    waiting: "等待中",
    prd_ready: "需求文档已就绪",
    prototype_ready: "原型已就绪",
    qa_failed: "质检未通过",
    done: "已完成",
    completed: "已完成",
    archived: "已归档",
    deleted: "已删除",
  };
  return labels[status] ?? status;
}
