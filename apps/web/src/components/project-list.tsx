"use client";

import { Loader2, MessageCircle, MoreVertical, PanelLeftClose, PanelLeftOpen, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button, EmptyState, IconButton } from "@/components/ui";
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
  const projectMenuScopeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openProjectMenuId) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (projectMenuScopeRef.current?.contains(target)) return;
      setOpenProjectMenuId(null);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenProjectMenuId(null);
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openProjectMenuId]);

  if (collapsed) {
    return (
      <aside className="flex min-h-0 min-w-0 flex-col items-center border-r border-[var(--color-border)] bg-[var(--color-sidebar-bg)] py-3">
        <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white shadow-[var(--shadow-control)] ring-1 ring-gray-200">
          <Sparkles className="h-4 w-4 text-[var(--color-accent)]" />
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="mt-5 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
          aria-label="展开最近对话"
          title="展开最近对话"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={onCreateConversation}
            disabled={creatingConversation}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] bg-gray-100 text-gray-900 transition hover:bg-gray-200 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="新建对话"
            title={creatingConversation ? "正在创建对话" : "新建对话"}
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
            aria-label="查看最近对话"
            title="查看最近对话"
          >
            <MessageCircle className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-gray-700 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
            aria-label="搜索最近对话"
            title="搜索最近对话"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-auto">
          <UserMenu compact placement="top" />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-sidebar-bg)]">
      <div className="border-b border-[var(--color-border)] px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-gray-950">智能产品工作台</div>
            <div className="mt-0.5 truncate text-xs leading-5 text-gray-500">目标输入、决策、生成</div>
          </div>
          <IconButton label="收起最近对话" onClick={onToggleCollapsed} className="shrink-0">
            <PanelLeftClose className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="mt-5 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-950">最近对话</div>
            <div className="mt-0.5 truncate text-xs leading-5 text-gray-500">删除仅隐藏历史</div>
          </div>
        </div>
        <Button
          onClick={onCreateConversation}
          disabled={creatingConversation}
          size="sm"
          className="mt-3 w-full"
          title={creatingConversation ? "正在创建对话" : "新建对话"}
        >
          {creatingConversation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {creatingConversation ? "创建中..." : "新对话"}
        </Button>
      </div>
      <div className="workbench-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="px-2 pb-2 text-xs text-gray-400">
          {currentProject ? projectTitleLabel(currentProject.title) : "尚未选择项目"}
        </div>
        {loading ? (
          <SidebarLoadingSkeleton />
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

        <div className="mt-5 flex items-center justify-between px-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-950">项目</div>
            <div className="mt-0.5 truncate text-xs text-gray-500">自动创建与更新</div>
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
                menuScopeRef={openProjectMenuId === project.id ? projectMenuScopeRef : undefined}
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
      <div className="border-t border-[var(--color-border)] p-2.5">
        <UserMenu placement="top" />
      </div>
    </aside>
  );
}

function SidebarLoadingSkeleton() {
  return (
    <div className="mx-1 space-y-2" aria-label="加载对话中">
      {[0, 1, 2].map((item) => (
        <div key={item} className="rounded-[var(--radius-control)] border border-gray-200 bg-white px-3 py-2 shadow-[var(--shadow-control)]">
          <div className="h-3 w-8/12 animate-pulse rounded-full bg-gray-200" />
          <div className="mt-2 h-2.5 w-5/12 animate-pulse rounded-full bg-gray-100" />
        </div>
      ))}
    </div>
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
        "group mb-1 flex items-center gap-1 rounded-[var(--radius-control)] border transition",
        selected
          ? "border-gray-200 bg-white text-gray-950 shadow-[var(--shadow-control)]"
          : "border-transparent text-gray-800 hover:border-gray-200 hover:bg-white/80",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => onSelect(conversation)}
        title={conversationTitleLabel(conversation.title)}
        className="min-w-0 flex-1 rounded-[var(--radius-control)] px-3 py-2 text-left focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
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
        className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-red-600 focus:outline-none focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-red-500/10 disabled:cursor-not-allowed disabled:opacity-50 group-hover:opacity-100"
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
  menuScopeRef,
}: {
  project: Phase1Project;
  selected: boolean;
  deleting?: boolean;
  menuOpen?: boolean;
  menuScopeRef?: RefObject<HTMLDivElement | null>;
  onSelect: (project: Phase1Project) => void;
  onToggleMenu: (projectId: string) => void;
  onDelete: (project: Phase1Project) => void;
}) {
  return (
    <div
      ref={menuScopeRef}
      className={[
        "group relative mb-1 flex items-center gap-1 rounded-[var(--radius-control)] border transition",
        selected
          ? "border-gray-200 bg-white text-gray-950 shadow-[var(--shadow-control)]"
          : "border-transparent text-gray-800 hover:border-gray-200 hover:bg-white/80",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => onSelect(project)}
        title={projectTitleLabel(project.title)}
        className="min-w-0 flex-1 rounded-[var(--radius-control)] px-3 py-2 text-left focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
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
          "mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-500 transition hover:bg-gray-100 hover:text-gray-950 focus:outline-none focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-50",
          menuOpen || selected ? "bg-gray-100 opacity-100" : "opacity-0 group-hover:opacity-100",
        ].join(" ")}
        aria-label="打开项目操作"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        title="项目操作"
      >
        {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
      </button>
      {menuOpen ? (
        <div role="menu" aria-label="项目操作" className="absolute right-2 top-9 z-20 w-36 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-[var(--shadow-float)]">
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(project);
            }}
            disabled={deleting}
            title={deleting ? "正在删除项目" : "删除项目"}
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
