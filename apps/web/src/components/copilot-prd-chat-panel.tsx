"use client";

import { CopilotChat } from "@copilotkit/react-core/v2";
import { PanelLeftOpen, Plus } from "lucide-react";
import { Button, IconButton } from "@/components/ui";

const CHAT_LABELS = {
  chatInputPlaceholder: "描述你要生成的 PRD...",
  welcomeMessageText: "告诉我你要做什么产品或功能，我会先生成 PRD。",
  chatDisclaimerText: "",
  modalHeaderTitle: "PRD 工作台",
  chatInputToolbarAddButtonLabel: "添加附件",
  chatInputToolbarToolsButtonLabel: "工具",
  assistantMessageToolbarCopyMessageLabel: "复制",
  assistantMessageToolbarCopyMessageCopiedLabel: "已复制",
  userMessageToolbarCopyMessageLabel: "复制",
};

export function CopilotPrdChatPanel({
  threadId,
  sidebarCollapsed,
  creatingConversation,
  disabled,
  onToggleSidebar,
  onCreateConversation,
}: {
  threadId: string;
  sidebarCollapsed?: boolean;
  creatingConversation?: boolean;
  disabled?: boolean;
  onToggleSidebar: () => void;
  onCreateConversation: () => void;
}) {
  if (!threadId) {
    return (
      <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-white">
        <ChatHeader
          sidebarCollapsed={sidebarCollapsed}
          creatingConversation={creatingConversation}
          onToggleSidebar={onToggleSidebar}
          onCreateConversation={onCreateConversation}
        />
        <div className="flex flex-1 items-center justify-center px-8 text-center text-sm leading-6 text-gray-500">
          {disabled || creatingConversation ? "正在准备对话..." : "新建对话后即可开始生成 PRD。"}
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] bg-white">
      <ChatHeader
        sidebarCollapsed={sidebarCollapsed}
        creatingConversation={creatingConversation}
        onToggleSidebar={onToggleSidebar}
        onCreateConversation={onCreateConversation}
      />
      <div className="min-h-0 flex-1 [&_.cpk-copilot-chat]:h-full [&_.cpk-copilot-chat]:border-0 [&_.cpk-copilot-chat]:shadow-none">
        <CopilotChat
          agentId="workbench-prd"
          threadId={threadId}
          labels={CHAT_LABELS}
          className="h-full"
          autoScroll="pin-to-send"
        />
      </div>
    </section>
  );
}

function ChatHeader({
  sidebarCollapsed,
  creatingConversation,
  onToggleSidebar,
  onCreateConversation,
}: {
  sidebarCollapsed?: boolean;
  creatingConversation?: boolean;
  onToggleSidebar: () => void;
  onCreateConversation: () => void;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border)] px-3">
      <div className="flex min-w-0 items-center gap-2">
        {sidebarCollapsed ? (
          <IconButton label="展开对话列表" variant="ghost" onClick={onToggleSidebar}>
            <PanelLeftOpen className="h-4 w-4" />
          </IconButton>
        ) : null}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-950">PRD 生成</div>
          <div className="truncate text-xs text-gray-500">单流程：对话输入 → PRD 文档</div>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={creatingConversation}
        onClick={onCreateConversation}
      >
        <Plus className="h-4 w-4" />
        新对话
      </Button>
    </div>
  );
}
