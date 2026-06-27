"use client";

import {
  Loader2,
  MessageCircle,
  PanelLeftClose,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { EmptyState, IconButton } from "@/components/ui";
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
  conversations,
  selectedConversationId,
  loading,
  collapsed,
  creatingConversation,
  deletingConversationId,
  onToggleCollapsed,
  onSelectConversation,
  onCreateConversation,
  onDeleteConversation,
}: {
  conversations: Phase1Conversation[];
  selectedConversationId?: string;
  loading?: boolean;
  collapsed?: boolean;
  creatingConversation?: boolean;
  deletingConversationId?: string;
  onToggleCollapsed: () => void;
  onSelectConversation: (conversation: Phase1Conversation) => void;
  onCreateConversation: () => void;
  onDeleteConversation: (conversation: Phase1Conversation) => void;
}) {
  if (collapsed) {
    return (
      <aside
        className="min-h-0 min-w-0 overflow-hidden bg-[var(--color-sidebar-bg)]"
        aria-hidden="true"
      />
    );
  }

  return (
    <aside className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-sidebar-bg)]">
      <div className="border-b border-[var(--color-border)] px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-white text-gray-900 shadow-[var(--shadow-control)] ring-1 ring-gray-200">
              <Sparkles className="h-4 w-4 text-[var(--color-accent)]" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-gray-950">智能产品工作台</div>
              <div className="truncate text-xs text-gray-500">Vibe Coding</div>
            </div>
          </div>
          <IconButton label="关闭侧边栏" onClick={onToggleCollapsed} className="shrink-0">
            <PanelLeftClose className="h-5 w-5" />
          </IconButton>
        </div>
        <button
          type="button"
          onClick={onCreateConversation}
          disabled={creatingConversation}
          className="mt-3 flex h-9 w-full items-center gap-2 rounded-[var(--radius-control)] bg-gray-950 px-3 text-sm font-semibold text-white shadow-[var(--shadow-control)] transition hover:bg-gray-800 focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10 disabled:cursor-not-allowed disabled:opacity-60"
          title={creatingConversation ? "正在创建对话" : "新对话"}
        >
          {creatingConversation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          <span className="truncate">{creatingConversation ? "创建中..." : "新对话"}</span>
        </button>
        <div className="mt-2 flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-gray-200 bg-white px-3 text-sm text-gray-400 shadow-[var(--shadow-control)]">
          <Search className="h-4 w-4 shrink-0" />
          <span className="truncate">搜索对话...</span>
        </div>
      </div>

      <div className="workbench-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <SidebarGroupHeader
          title="对话"
          meta={`${conversations.length}`}
        />
        {loading ? (
          <SidebarLoadingSkeleton />
        ) : conversations.length ? (
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
      </div>
      <div className="border-t border-[var(--color-border)] p-2.5">
        <UserMenu placement="top" />
      </div>
    </aside>
  );
}

function SidebarGroupHeader({
  title,
  meta,
  className,
}: {
  title: string;
  meta: string;
  className?: string;
}) {
  return (
    <div className={["flex items-center justify-between px-2 pb-2 text-xs font-semibold text-gray-400", className].filter(Boolean).join(" ")}>
      <span className="truncate">{title}</span>
      <span className="shrink-0">{meta}</span>
    </div>
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
          : "border-transparent text-gray-700 hover:border-gray-200 hover:bg-white/80",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => onSelect(conversation)}
        title={conversationTitleLabel(conversation.title)}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10"
      >
        <span className={["mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", selected ? "bg-gray-950" : "bg-gray-300"].join(" ")} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{conversationTitleLabel(conversation.title)}</div>
          <div className="mt-1 truncate text-xs text-gray-400">
            {conversation.messageCount ?? 0} 条消息 · {timeLabel(conversation.lastMessageAt ?? conversation.createdAt)}
          </div>
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

function conversationTitleLabel(title: string) {
  return title.replace(/默认会话/g, "默认对话");
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
