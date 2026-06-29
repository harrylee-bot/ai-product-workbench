"use client";

import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type PointerEvent } from "react";
import { create } from "zustand";
import { CopilotPrdChatPanel } from "@/components/copilot-prd-chat-panel";
import { Modal } from "@/components/modal";
import { PrdDocumentPanel } from "@/components/prd-document-panel";
import { ProjectList, type Phase1Conversation, type Phase1Project } from "@/components/project-list";
import { ProtectedRoute } from "@/components/protected-route";
import { Button, ErrorState } from "@/components/ui";
import type { Phase1PrdPreview } from "@/components/workspace-preview/types";
import { apiRequest } from "@/lib/api";

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

type DeleteConversationResponse = {
  success: boolean;
  deletedConversationId: string;
  nextConversation?: Phase1Conversation | null;
};

type Phase1WorkspaceState = {
  selectedProjectId: string;
  selectedConversationId: string;
  prdPreview: Phase1PrdPreview | null;
  setSelectedProject: (projectId: string, conversationId: string) => void;
  setPrdPreview: (preview: Phase1PrdPreview | null) => void;
};

const WORKSPACE_SIDEBAR_WIDTH = 284;
const WORKSPACE_SIDEBAR_COLLAPSED_WIDTH = 0;
const WORKSPACE_RESIZER_WIDTH = 8;
const WORKSPACE_CHAT_MIN_WIDTH = 432;
const WORKSPACE_PREVIEW_MIN_WIDTH = 520;
const WORKSPACE_PREVIEW_DEFAULT_WIDTH = 720;
const WORKSPACE_PREVIEW_MAX_WIDTH = 980;

const usePhase1Workspace = create<Phase1WorkspaceState>((set) => ({
  selectedProjectId: "",
  selectedConversationId: "",
  prdPreview: null,
  setSelectedProject: (projectId, conversationId) =>
    set({
      selectedProjectId: projectId,
      selectedConversationId: conversationId,
      prdPreview: null,
    }),
  setPrdPreview: (prdPreview) => set({ prdPreview }),
}));

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(WORKSPACE_PREVIEW_DEFAULT_WIDTH);
  const [resizingPreview, setResizingPreview] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const {
    selectedProjectId,
    selectedConversationId,
    prdPreview,
    setSelectedProject,
    setPrdPreview,
  } = usePhase1Workspace();

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
      setSelectedProject(conversation.projectId, conversation.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase1-conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-conversation", conversation.id] }),
      ]);
    },
    onError: (error) => showError(error, "新建对话失败"),
  });

  const deleteConversation = useMutation({
    mutationFn: async (conversation: Phase1Conversation) => {
      const response = await apiRequest<DeleteConversationResponse>(`/conversations/${conversation.id}`, {
        method: "DELETE",
      });
      return { deleted: conversation, response };
    },
    onSuccess: async ({ deleted, response }) => {
      if (deleted.id === selectedConversationId) {
        if (response.nextConversation) {
          setSelectedProject(response.nextConversation.projectId, response.nextConversation.id);
        } else {
          setSelectedProject("", "");
          setPrdPreview(null);
        }
      }
      queryClient.removeQueries({ queryKey: ["phase1-conversation", response.deletedConversationId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase1-conversations"] }),
        response.nextConversation
          ? queryClient.invalidateQueries({ queryKey: ["phase1-conversation", response.nextConversation.id] })
          : Promise.resolve(),
      ]);
    },
    onError: (error) => showError(error, "删除对话失败"),
  });

  useEffect(() => {
    const first = conversationsQuery.data?.items[0];
    if (!selectedConversationId && first) {
      setSelectedProject(first.projectId, first.id);
    }
  }, [conversationsQuery.data?.items, selectedConversationId, setSelectedProject]);

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
    const projectId = detail.conversation.projectId || detail.project.id;
    if (projectId !== selectedProjectId || detail.conversation.id !== selectedConversationId) {
      setSelectedProject(projectId, detail.conversation.id);
    }
    setPrdPreview(normalizePrdPreview(detail.prd));
  }, [detailQuery.data, selectedConversationId, selectedProjectId, setPrdPreview, setSelectedProject]);

  useEffect(() => {
    const handleResize = () => {
      setPreviewWidth((width) => clampPreviewWidth(width, sidebarCollapsed));
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [sidebarCollapsed]);

  function showError(error: unknown, fallback: string) {
    setNotice({ title: "操作失败", message: error instanceof Error ? error.message : fallback });
  }

  function startPreviewResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingPreview(true);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = window.innerWidth - moveEvent.clientX;
      setPreviewWidth(clampPreviewWidth(nextWidth, sidebarCollapsed));
    };
    const stopResize = () => {
      setResizingPreview(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  const sidebarWidth = sidebarCollapsed ? WORKSPACE_SIDEBAR_COLLAPSED_WIDTH : WORKSPACE_SIDEBAR_WIDTH;
  const shellMinWidth = sidebarWidth + WORKSPACE_CHAT_MIN_WIDTH + WORKSPACE_RESIZER_WIDTH + WORKSPACE_PREVIEW_MIN_WIDTH;
  const queryError =
    errorMessage(conversationsQuery.error)
    ?? errorMessage(detailQuery.error);

  return (
    <>
      <main
        className={[
          "workbench-scrollbar relative grid h-screen min-h-0 overflow-x-auto overflow-y-hidden bg-[var(--color-app-bg)] text-gray-950",
          resizingPreview ? "cursor-col-resize select-none" : "",
        ].join(" ")}
        style={{
          gridTemplateColumns: `${sidebarWidth}px minmax(${WORKSPACE_CHAT_MIN_WIDTH}px, 1fr) ${WORKSPACE_RESIZER_WIDTH}px minmax(${WORKSPACE_PREVIEW_MIN_WIDTH}px, ${previewWidth}px)`,
          minWidth: `${shellMinWidth}px`,
        }}
      >
        {resizingPreview ? <div className="fixed inset-0 z-50 cursor-col-resize bg-transparent" /> : null}
        {queryError ? (
          <div className="pointer-events-none fixed left-1/2 top-4 z-40 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2">
            <ErrorState title="工作台数据加载失败" description={queryError} className="pointer-events-auto shadow-[var(--shadow-float)]" />
          </div>
        ) : null}
        <ProjectList
          conversations={conversationsQuery.data?.items ?? []}
          selectedConversationId={selectedConversationId}
          loading={conversationsQuery.isLoading}
          collapsed={sidebarCollapsed}
          creatingConversation={createConversation.isPending}
          deletingConversationId={deleteConversation.variables?.id}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onSelectConversation={(conversation) => setSelectedProject(conversation.projectId, conversation.id)}
          onCreateConversation={() => void createConversation.mutate()}
          onDeleteConversation={(conversation) => {
            setConfirmDialog({
              title: "删除对话",
              message: "确认删除这条对话吗？删除后会从工作台历史中移除。",
              confirmLabel: "删除对话",
              onConfirm: () => deleteConversation.mutate(conversation),
            });
          }}
        />
        <CopilotChatConfigurationProvider
          agentId="workbench-prd"
          threadId={selectedConversationId || undefined}
          hasExplicitThreadId={Boolean(selectedConversationId)}
        >
          <CopilotPrdChatPanel
            threadId={selectedConversationId}
            sidebarCollapsed={sidebarCollapsed}
            disabled={conversationsQuery.isLoading}
            creatingConversation={createConversation.isPending}
            onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
            onCreateConversation={() => void createConversation.mutate()}
          />
          <div
            role="separator"
            aria-label="拖动调整预览宽度"
            aria-orientation="vertical"
            onPointerDown={startPreviewResize}
            className="group relative flex min-w-0 cursor-col-resize items-center justify-center border-l border-r border-[var(--color-border)] bg-[var(--color-app-bg)] transition hover:bg-[var(--color-accent-soft)]"
            title="拖动调整预览宽度"
          >
            <span className="h-12 w-1 rounded-full bg-gray-300 transition group-hover:bg-[var(--color-accent)]" />
          </div>
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
      <Modal
        open={Boolean(confirmDialog)}
        title={confirmDialog?.title ?? "确认操作"}
        onClose={() => setConfirmDialog(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirmDialog(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                const action = confirmDialog?.onConfirm;
                setConfirmDialog(null);
                action?.();
              }}
            >
              {confirmDialog?.confirmLabel ?? "确认"}
            </Button>
          </>
        )}
      >
        <p className="text-sm leading-6 text-gray-600">{confirmDialog?.message}</p>
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

function clampPreviewWidth(width: number, sidebarCollapsed: boolean) {
  if (typeof window === "undefined") return width;
  const sidebarWidth = sidebarCollapsed ? WORKSPACE_SIDEBAR_COLLAPSED_WIDTH : WORKSPACE_SIDEBAR_WIDTH;
  const maxPreviewWidth = Math.max(
    WORKSPACE_PREVIEW_MIN_WIDTH,
    Math.min(
      WORKSPACE_PREVIEW_MAX_WIDTH,
      window.innerWidth - sidebarWidth - WORKSPACE_CHAT_MIN_WIDTH - WORKSPACE_RESIZER_WIDTH,
    ),
  );
  return Math.min(Math.max(width, WORKSPACE_PREVIEW_MIN_WIDTH), maxPreviewWidth);
}
