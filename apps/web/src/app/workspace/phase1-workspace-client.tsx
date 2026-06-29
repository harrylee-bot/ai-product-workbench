"use client";

import { CopilotChatConfigurationProvider, CopilotSidebar } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { PrdDocumentPanel, type Phase1PrdPreview } from "@/components/prd-document-panel";
import { ProtectedRoute } from "@/components/protected-route";
import { Button, ErrorState } from "@/components/ui";
import { apiRequest } from "@/lib/api";

type Phase1Conversation = {
  id: string;
  projectId: string;
};

type Phase1Project = {
  id: string;
};

type ConversationsResponse = {
  items: Phase1Conversation[];
};

type ConversationDetailResponse = {
  conversation: Phase1Conversation;
  project: Phase1Project;
  prd?: unknown;
};

type CreateConversationResponse = {
  conversation: Phase1Conversation;
};

const CHAT_LABELS = {
  chatInputPlaceholder: "描述你要生成的 PRD...",
  welcomeMessageText: "告诉我你要做什么产品或功能，我会先生成 PRD。",
  chatDisclaimerText: "",
  modalHeaderTitle: "智能产品工作台",
  chatInputToolbarAddButtonLabel: "添加附件",
  chatInputToolbarToolsButtonLabel: "工具",
  assistantMessageToolbarCopyMessageLabel: "复制",
  assistantMessageToolbarCopyMessageCopiedLabel: "已复制",
  userMessageToolbarCopyMessageLabel: "复制",
};

export function Phase1WorkspaceClient() {
  const [client] = useState(() => new QueryClient());

  return (
    <ProtectedRoute>
      <QueryClientProvider client={client}>
        <Phase1WorkspaceInner />
      </QueryClientProvider>
    </ProtectedRoute>
  );
}

function Phase1WorkspaceInner() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [prdPreview, setPrdPreview] = useState<Phase1PrdPreview | null>(null);

  const conversationsQuery = useQuery({
    queryKey: ["phase1-conversations"],
    queryFn: () => apiRequest<ConversationsResponse>("/conversations"),
  });

  const detailQuery = useQuery({
    queryKey: ["phase1-conversation", selectedConversationId],
    enabled: Boolean(selectedConversationId),
    queryFn: () => apiRequest<ConversationDetailResponse>(`/conversations/${selectedConversationId}`),
  });

  const createConversation = useMutation({
    mutationFn: () =>
      apiRequest<CreateConversationResponse>("/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "新对话" }),
    }),
    onSuccess: async (response) => {
      const conversation = response.conversation;
      setSelectedConversationId(conversation.id);
      setPrdPreview(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase1-conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-conversation", conversation.id] }),
      ]);
    },
    onError: (error) => showError(error, "新建对话失败"),
  });

  useEffect(() => {
    const first = conversationsQuery.data?.items[0];
    if (!selectedConversationId && first) {
      setSelectedConversationId(first.id);
      setPrdPreview(null);
    }
  }, [conversationsQuery.data?.items, selectedConversationId]);

  useEffect(() => {
    if (
      selectedConversationId ||
      conversationsQuery.isLoading ||
      conversationsQuery.error ||
      createConversation.isPending
    ) {
      return;
    }
    void createConversation.mutate();
  }, [
    conversationsQuery.error,
    conversationsQuery.isLoading,
    createConversation,
    selectedConversationId,
  ]);

  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail) return;
    if (detail.conversation.id !== selectedConversationId) {
      setSelectedConversationId(detail.conversation.id);
    }
    setPrdPreview(normalizePrdPreview(detail.prd));
  }, [detailQuery.data, selectedConversationId]);

  function showError(error: unknown, fallback: string) {
    setNotice({ title: "操作失败", message: error instanceof Error ? error.message : fallback });
  }

  const queryError =
    errorMessage(conversationsQuery.error)
    ?? errorMessage(detailQuery.error);

  return (
    <>
      <main className="relative h-screen min-h-0 overflow-hidden bg-white text-gray-950">
        {queryError ? (
          <div className="pointer-events-none fixed left-1/2 top-4 z-40 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2">
            <ErrorState title="工作台数据加载失败" description={queryError} className="pointer-events-auto shadow-[var(--shadow-float)]" />
          </div>
        ) : null}
        <CopilotChatConfigurationProvider
          agentId="workbench-prd"
          threadId={selectedConversationId || undefined}
          hasExplicitThreadId={Boolean(selectedConversationId)}
        >
          <PrdDocumentPanel
            dbPreview={prdPreview}
            onRunSettled={() => {
              void Promise.all([
                selectedConversationId
                  ? queryClient.invalidateQueries({ queryKey: ["phase1-conversation", selectedConversationId] })
                  : Promise.resolve(),
                queryClient.invalidateQueries({ queryKey: ["phase1-conversations"] }),
              ]);
            }}
          />
          <CopilotSidebar
            agentId="workbench-prd"
            threadId={selectedConversationId}
            labels={CHAT_LABELS}
            defaultOpen
            position="right"
            autoScroll="pin-to-send"
          />
        </CopilotChatConfigurationProvider>
      </main>
      <Modal
        open={Boolean(notice)}
        title={notice?.title ?? "操作失败"}
        onClose={() => setNotice(null)}
        footer={(
          <Button type="button" onClick={() => setNotice(null)}>
            知道了
          </Button>
        )}
      >
        <p className="text-sm leading-6 text-gray-600">{notice?.message}</p>
      </Modal>
    </>
  );
}

function normalizePrdPreview(value: unknown): Phase1PrdPreview | null {
  const record = asRecord(value);
  if (!record) return null;
  const sectionsValue = Array.isArray(record.sections) ? record.sections : [];
  const sections = sectionsValue
    .map((item, index) => normalizePrdSection(item, index))
    .filter((section): section is Phase1PrdPreview["sections"][number] => Boolean(section));
  if (!sections.length) return null;
  return {
    id: asText(record.id) || undefined,
    title: asText(record.title) || "需求文档",
    sections,
  };
}

function normalizePrdSection(
  value: unknown,
  index: number,
): Phase1PrdPreview["sections"][number] | null {
  const section = asRecord(value);
  if (!section) return null;
  const title = asText(section.title);
  const content = asText(section.content) || asText(section.body) || asText(section.description);
  const blocks = normalizePrdBlocks(section.blocks);
  const blockContent = blocks.map((block) => block.content).filter(Boolean).join("\n\n");
  const resolvedContent = content || blockContent;
  if (!title && !resolvedContent) return null;
  const orderValue = typeof section.order === "number" ? section.order : undefined;
  return {
    id: asText(section.id) || `section-${index + 1}`,
    title: title || "未命名章节",
    content: resolvedContent || "暂无内容",
    type: asText(section.type) || undefined,
    order: orderValue,
    sourcePaths: normalizeTextArray(section.sourcePaths),
    sourceStatePaths: normalizeTextArray(section.sourceStatePaths),
    blocks,
  };
}

function normalizePrdBlocks(value: unknown): NonNullable<Phase1PrdPreview["sections"][number]["blocks"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const block = asRecord(item);
    if (!block) return [];
    const content = asText(block.content);
    if (!content) return [];
    return [{
      id: asText(block.id) || `block-${index + 1}`,
      type: normalizePrdBlockType(block.type),
      content,
      sourcePaths: normalizeTextArray(block.sourcePaths),
    }];
  });
}

function normalizePrdBlockType(value: unknown) {
  const text = asText(value);
  if (
    text === "paragraph" ||
    text === "quote" ||
    text === "warning" ||
    text === "info"
  ) {
    return text;
  }
  return "paragraph";
}

function normalizeTextArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = asText(item);
        return text ? [text] : [];
      })
    : undefined;
}

function errorMessage(error: unknown) {
  if (!error) return null;
  return error instanceof Error ? error.message : "请稍后重试";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}
