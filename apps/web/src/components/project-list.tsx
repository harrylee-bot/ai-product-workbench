"use client";

import { Loader2, MessageCircle, MoreVertical, PanelLeftClose, PanelLeftOpen, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, EmptyState, IconButton, LoadingState } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";

export type Phase1Project = {
  id: string;
  title: string;
  status: string;
  currentConversationId?: string | null;
  defaultConversationId?: string | null;
};

export type Phase1Conversation = {
  id: string;
  projectId: string;
  title: string;
  messageCount?: number;
  lastMessageAt?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
};

export function ProjectList({
  projects,
  conversations,
  selectedProjectId,
  selectedConversationId,
  loading,
  collapsed,
  creatingConversation,
  deletingConversationId,
  deletingProjectId,
  onToggleCollapsed,
  onSelectProject,
  onSelectConversation,
  onCreateConversation,
  onDeleteConversation,
  onDeleteProject,
}: {
  projects: Phase1Project[];
  conversations?: Phase1Conversation[];
  selectedProjectId?: string;
  selectedConversationId?: string;
  loading?: boolean;
  collapsed?: boolean;
  creatingConversation?: boolean;
  deletingConversationId?: string;
  deletingProjectId?: string;
  onToggleCollapsed: () => void;
  onSelectProject: (project: Phase1Project) => void;
  onSelectConversation: (conversation: Phase1Conversation) => void;
  onCreateConversation: () => void;
  onDeleteConversation: (conversation: Phase1Conversation) => void;
  onDeleteProject: (project: Phase1Project) => void;
}) {
  const currentProject = projects.find((project) => project.id === selectedProjectId);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);

  if (collapsed) {
    return (
      <aside className="flex min-h-0 flex-col items-center border-r border-[var(--color-border)] bg-[var(--color-sidebar-bg)] py-4">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white shadow-[var(--shadow-control)] ring-1 ring-gray-200">
          <Sparkles className="h-5 w-5 text-[var(--color-accent)]" />
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="mt-7 inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
          aria-label="展开最近对话"
        >
          <PanelLeftOpen className="h-5 w-5" />
        </button>
        <div className="mt-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={onCreateConversation}
            disabled={creatingConversation}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-gray-100 text-gray-900 transition hover:bg-gray-200 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="新建对话"
          >
            <Plus className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
            aria-label="查看最近对话"
          >
            <MessageCircle className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
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
    <aside className="flex min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-sidebar-bg)]">
      <div className="px-5 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-xl font-semibold text-gray-950">智能产品工作台</div>
            <div className="mt-1 truncate text-xs leading-5 text-gray-500">说出目标，系统自动决策与生成</div>
          </div>
          <IconButton label="收起最近对话" onClick={onToggleCollapsed} className="shrink-0">
            <PanelLeftClose className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="mt-8 text-sm font-semibold text-gray-950">最近对话</div>
        <div className="mt-1 text-xs leading-5 text-gray-500">删除仅隐藏历史，系统内容保留用于知识库</div>
        <Button
          onClick={onCreateConversation}
          disabled={creatingConversation}
          className="mt-4 w-full"
        >
          {creatingConversation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {creatingConversation ? "创建中..." : "新对话"}
        </Button>
      </div>
      <div className="workbench-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-3 pb-2 text-xs text-gray-400">
          {currentProject ? projectTitleLabel(currentProject.title) : "尚未选择项目"}
        </div>
        {loading ? (
          <LoadingState label="加载对话中..." className="mx-1" />
        ) : conversations?.length ? (
          conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              selected={selectedConversationId === conversation.id}
              deleting={deletingConversationId === conversation.id}
              onSelect={onSelectConversation}
              onDelete={onDeleteConversation}
            />
          ))
        ) : (
          <EmptyState title="暂无对话" description="点击“新对话”开始。" className="mx-1 bg-white/80 py-8" icon={<MessageCircle className="h-5 w-5" />} />
        )}

        <div className="mt-7 flex items-center justify-between px-3">
          <div>
            <div className="text-sm font-semibold text-gray-950">项目</div>
            <div className="mt-1 text-xs text-gray-500">系统根据输入自动创建与更新</div>
          </div>
        </div>
        <div className="mt-2">
          {loading ? null : projects.length ? (
            projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                selected={selectedProjectId === project.id}
                deleting={deletingProjectId === project.id}
                menuOpen={openProjectMenuId === project.id}
                onSelect={(item) => {
                  setOpenProjectMenuId(null);
                  onSelectProject(item);
                }}
                onToggleMenu={(projectId) => setOpenProjectMenuId((value) => value === projectId ? null : projectId)}
                onDelete={(item) => {
                  setOpenProjectMenuId(null);
                  onDeleteProject(item);
                }}
              />
            ))
          ) : (
            <EmptyState title="暂无项目" description="直接在中间输入需求，系统会自动创建工作空间。" className="mx-1 bg-white/80 py-8" icon={<Sparkles className="h-5 w-5" />} />
          )}
        </div>
      </div>
      <div className="border-t border-[var(--color-border)] p-3">
        <UserMenu placement="top" />
      </div>
    </aside>
  );
}

function ConversationRow({
  conversation,
  selected,
  deleting,
  onSelect,
  onDelete,
}: {
  conversation: Phase1Conversation;
  selected: boolean;
  deleting?: boolean;
  onSelect: (conversation: Phase1Conversation) => void;
  onDelete: (conversation: Phase1Conversation) => void;
}) {
  return (
    <div
      className={[
        "group mb-1 flex items-center gap-1 rounded-xl border transition",
        selected
          ? "border-gray-200 bg-white text-gray-950 shadow-[var(--shadow-control)]"
          : "border-transparent text-gray-800 hover:border-gray-200 hover:bg-white/80",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => onSelect(conversation)}
        className="min-w-0 flex-1 rounded-xl px-3 py-2.5 text-left focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
      >
        <div className="truncate text-sm font-medium">{conversationTitleLabel(conversation.title)}</div>
        <div className="mt-1 truncate text-xs text-gray-400">
          {conversation.messageCount ?? 0} 条消息 · {timeLabel(conversation.lastMessageAt ?? conversation.createdAt)}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onDelete(conversation)}
        disabled={deleting}
        className="mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-red-600 focus:outline-none focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-red-500/10 disabled:cursor-not-allowed disabled:opacity-50 group-hover:opacity-100"
        aria-label="删除历史对话"
        title="删除历史对话"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function ProjectRow({
  project,
  selected,
  deleting,
  menuOpen,
  onSelect,
  onToggleMenu,
  onDelete,
}: {
  project: Phase1Project;
  selected: boolean;
  deleting?: boolean;
  menuOpen?: boolean;
  onSelect: (project: Phase1Project) => void;
  onToggleMenu: (projectId: string) => void;
  onDelete: (project: Phase1Project) => void;
}) {
  return (
    <div
      className={[
        "group relative mb-1 flex items-center gap-1 rounded-xl border transition",
        selected
          ? "border-gray-200 bg-white text-gray-950 shadow-[var(--shadow-control)]"
          : "border-transparent text-gray-800 hover:border-gray-200 hover:bg-white/80",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => onSelect(project)}
        className="min-w-0 flex-1 rounded-xl px-3 py-2.5 text-left focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
      >
        <div className="truncate text-sm font-medium">{projectTitleLabel(project.title)}</div>
        <div className="mt-1 truncate text-xs text-gray-400">{projectStatusLabel(project.status)}</div>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleMenu(project.id);
        }}
        disabled={deleting}
        className={[
          "mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-50",
          menuOpen || selected ? "bg-gray-100 opacity-100" : "opacity-0 group-hover:opacity-100",
        ].join(" ")}
        aria-label="打开项目操作"
        title="项目操作"
      >
        {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
      </button>
      {menuOpen ? (
        <div className="absolute right-2 top-10 z-20 w-36 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-[var(--shadow-float)]">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(project);
            }}
            disabled={deleting}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition hover:bg-red-50 focus:outline-none focus-visible:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            删除项目
          </button>
        </div>
      ) : null}
    </div>
  );
}

function projectTitleLabel(title: string) {
  return title.replace(/Triple System/g, "三系统融合").replace(/AI Product Workbench/g, "智能产品工作台");
}

function conversationTitleLabel(title: string) {
  return title.replace(/默认会话/g, "默认对话");
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

function timeLabel(value?: string) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
