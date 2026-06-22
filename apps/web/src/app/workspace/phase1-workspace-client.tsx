"use client";

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type PointerEvent } from "react";
import { create } from "zustand";
import { ChatPanel, type Phase1Message } from "@/components/chat-panel";
import {
  PreviewPanel,
  type Phase1PrdPreview,
  type Phase1PrototypePreview,
  type Phase2DecisionView,
} from "@/components/preview-panel";
import { ProjectList, type Phase1Conversation, type Phase1Project } from "@/components/project-list";
import { ProtectedRoute } from "@/components/protected-route";
import { ErrorState } from "@/components/ui";
import { apiRequest } from "@/lib/api";

type ProjectsResponse = {
  items: Phase1Project[];
};

type ProjectDetailResponse = {
  project: Phase1Project;
  conversations: Phase1Conversation[];
  prd?: unknown;
  prototype?: unknown;
};

type MessagesResponse = {
  items: Phase1Message[];
};

type MessageResponse = {
  userMessage?: Phase1Message & {
    projectId?: string;
    conversationId?: string;
  };
  assistantMessage: Phase1Message;
  decisionPlan: Phase2DecisionView["decisionPlan"];
  reviewBoard: Phase2DecisionView["reviewBoard"];
  selection: Phase2DecisionView["selection"];
  selectedStrategy: Phase2DecisionView["selectedStrategy"];
  patchDraft: Phase2DecisionView["patchDraft"];
  previewSession: Phase2DecisionView["previewSession"];
  evolution: Phase2DecisionView["evolution"];
  selfGeneration?: Phase2DecisionView["selfGeneration"];
  executionPlan?: Phase2DecisionView["executionPlan"];
  companyRuntime?: Phase2DecisionView["companyRuntime"];
  knowledgeSearch?: Phase2DecisionView["knowledgeSearch"];
  constraintContext?: Phase2DecisionView["constraintContext"];
  agentInput?: Phase2DecisionView["agentInput"];
  prdPreview?: Phase1PrdPreview;
  prototypePreview?: Phase1PrototypePreview;
};

type CreateConversationResponse = {
  conversation: Phase1Conversation;
};

type DeleteConversationResponse = {
  success: boolean;
  deletedConversationId: string;
  nextConversation: Phase1Conversation;
};

type DeleteProjectResponse = {
  success: boolean;
  deletedProjectId: string;
};

type Phase1WorkspaceState = {
  selectedProjectId: string;
  selectedConversationId: string;
  decision: Phase2DecisionView | null;
  prdPreview: Phase1PrdPreview | null;
  prototypePreview: Phase1PrototypePreview | null;
  setSelectedProject: (projectId: string, conversationId: string) => void;
  setDecision: (decision: Phase2DecisionView | null) => void;
  setArtifactPreview: (preview: {
    prdPreview?: Phase1PrdPreview | null;
    prototypePreview?: Phase1PrototypePreview | null;
  }) => void;
};

const WORKSPACE_SIDEBAR_WIDTH = 284;
const WORKSPACE_SIDEBAR_COLLAPSED_WIDTH = 64;
const WORKSPACE_RESIZER_WIDTH = 8;
const WORKSPACE_CHAT_MIN_WIDTH = 432;
const WORKSPACE_PREVIEW_MIN_WIDTH = 520;
const WORKSPACE_PREVIEW_DEFAULT_WIDTH = 720;
const WORKSPACE_PREVIEW_MAX_WIDTH = 980;

const usePhase1Workspace = create<Phase1WorkspaceState>((set) => ({
  selectedProjectId: "",
  selectedConversationId: "",
  decision: null,
  prdPreview: null,
  prototypePreview: null,
  setSelectedProject: (projectId, conversationId) =>
    set({
      selectedProjectId: projectId,
      selectedConversationId: conversationId,
      decision: null,
      prdPreview: null,
      prototypePreview: null,
    }),
  setDecision: (decision) => set({ decision }),
  setArtifactPreview: (preview) =>
    set((state) => ({
      prdPreview: preview.prdPreview === undefined ? state.prdPreview : preview.prdPreview,
      prototypePreview: preview.prototypePreview === undefined ? state.prototypePreview : preview.prototypePreview,
    })),
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
  const {
    selectedProjectId,
    selectedConversationId,
    decision,
    prdPreview,
    prototypePreview,
    setSelectedProject,
    setDecision,
    setArtifactPreview,
  } = usePhase1Workspace();

  const projectsQuery = useQuery({
    queryKey: ["phase1-projects"],
    queryFn: () => apiRequest<ProjectsResponse>("/projects"),
  });

  useEffect(() => {
    const first = projectsQuery.data?.items[0];
    if (!selectedProjectId && first) {
      setSelectedProject(first.id, first.currentConversationId ?? first.defaultConversationId ?? "");
    }
  }, [projectsQuery.data?.items, selectedProjectId, setSelectedProject]);

  const detailQuery = useQuery({
    queryKey: ["phase1-project", selectedProjectId],
    enabled: Boolean(selectedProjectId),
    queryFn: () => apiRequest<ProjectDetailResponse>(`/projects/${selectedProjectId}`),
  });

  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail) return;
    const activeConversationIds = new Set(detail.conversations.map((conversation) => conversation.id));
    const currentConversationId = activeConversationIds.has(detail.project.currentConversationId ?? "")
      ? detail.project.currentConversationId
      : undefined;
    const conversationId = activeConversationIds.has(selectedConversationId)
      ? selectedConversationId
      : currentConversationId ?? detail.conversations[0]?.id ?? "";
    if (conversationId && conversationId !== selectedConversationId) {
      setSelectedProject(detail.project.id, conversationId);
    }
    setArtifactPreview({
      prdPreview: normalizePrdPreview(detail.prd),
      prototypePreview: normalizePrototypePreview(detail.prototype),
    });
  }, [detailQuery.data, selectedConversationId, setArtifactPreview, setSelectedProject]);

  const messagesQuery = useQuery({
    queryKey: ["phase1-messages", selectedConversationId],
    enabled: Boolean(selectedConversationId),
    queryFn: () => apiRequest<MessagesResponse>(`/conversations/${selectedConversationId}/messages`),
  });

  const sendMessage = useMutation({
    mutationFn: async (content: string) => {
      let projectId = selectedProjectId;
      let conversationId = selectedConversationId;

      if (!projectId || !conversationId) {
        const response = await apiRequest<{ project: Phase1Project; defaultConversation: { id: string } }>("/projects", {
          method: "POST",
          body: JSON.stringify({ title: deriveProjectTitle(content) }),
        });
        projectId = response.project.id;
        conversationId = response.defaultConversation.id;
        setSelectedProject(projectId, conversationId);
      }

      return apiRequest<MessageResponse>("/messages", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          conversationId,
          content,
        }),
      });
    },
    onSuccess: async (response) => {
      const responseProjectId = response.userMessage?.projectId ?? selectedProjectId;
      const responseConversationId = response.userMessage?.conversationId ?? selectedConversationId;

      setDecision({
        decisionPlan: response.decisionPlan,
        reviewBoard: response.reviewBoard,
        selection: response.selection,
        selectedStrategy: response.selectedStrategy,
        patchDraft: response.patchDraft,
        previewSession: response.previewSession,
        evolution: response.evolution,
        selfGeneration: response.selfGeneration,
        executionPlan: response.executionPlan,
        companyRuntime: response.companyRuntime,
        knowledgeSearch: response.knowledgeSearch,
        constraintContext: response.constraintContext,
        agentInput: response.agentInput,
      });
      setArtifactPreview({
        prdPreview: response.prdPreview ?? null,
        prototypePreview: response.prototypePreview ?? null,
      });
      await Promise.all([
        responseConversationId
          ? queryClient.invalidateQueries({ queryKey: ["phase1-messages", responseConversationId] })
          : Promise.resolve(),
        responseProjectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", responseProjectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
  });

  const createConversation = useMutation({
    mutationFn: async () => {
      if (!selectedProjectId) {
        const response = await apiRequest<{ project: Phase1Project; defaultConversation: Phase1Conversation }>("/projects", {
          method: "POST",
          body: JSON.stringify({ title: "智能产品项目" }),
        });
        return { conversation: response.defaultConversation };
      }

      return apiRequest<CreateConversationResponse>("/conversations", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          title: "新对话",
        }),
      });
    },
    onSuccess: async (response) => {
      const conversation = response.conversation;
      setSelectedProject(conversation.projectId, conversation.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-project", conversation.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-messages", conversation.id] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "新建对话失败");
    },
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
        setSelectedProject(response.nextConversation.projectId, response.nextConversation.id);
      }
      queryClient.removeQueries({ queryKey: ["phase1-messages", response.deletedConversationId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-project", response.nextConversation.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-messages", response.nextConversation.id] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "删除对话失败");
    },
  });

  const deleteProject = useMutation({
    mutationFn: async (project: Phase1Project) => {
      const response = await apiRequest<DeleteProjectResponse>(`/projects/${project.id}`, {
        method: "DELETE",
      });
      return { deleted: project, response };
    },
    onSuccess: async ({ deleted, response }) => {
      const projects = queryClient.getQueryData<ProjectsResponse>(["phase1-projects"])?.items ?? [];
      const nextProject = projects.find((project) => project.id !== response.deletedProjectId);

      if (deleted.id === selectedProjectId) {
        setSelectedProject(nextProject?.id ?? "", nextProject?.currentConversationId ?? nextProject?.defaultConversationId ?? "");
        setDecision(null);
        setArtifactPreview({ prdPreview: null, prototypePreview: null });
      }

      queryClient.removeQueries({ queryKey: ["phase1-project", response.deletedProjectId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
        nextProject ? queryClient.invalidateQueries({ queryKey: ["phase1-project", nextProject.id] }) : Promise.resolve(),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "删除项目失败");
    },
  });

  useEffect(() => {
    const handleResize = () => {
      setPreviewWidth((width) => clampPreviewWidth(width, sidebarCollapsed));
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [sidebarCollapsed]);

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
    errorMessage(projectsQuery.error)
    ?? errorMessage(detailQuery.error)
    ?? errorMessage(messagesQuery.error);

  return (
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
        projects={projectsQuery.data?.items ?? []}
        conversations={detailQuery.data?.conversations ?? []}
        selectedProjectId={selectedProjectId}
        selectedConversationId={selectedConversationId}
        loading={projectsQuery.isLoading}
        collapsed={sidebarCollapsed}
        creatingConversation={createConversation.isPending}
        deletingConversationId={deleteConversation.variables?.id}
        deletingProjectId={deleteProject.variables?.id}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        onSelectProject={(project) =>
          setSelectedProject(project.id, project.currentConversationId ?? project.defaultConversationId ?? "")
        }
        onSelectConversation={(conversation) => setSelectedProject(conversation.projectId, conversation.id)}
        onCreateConversation={() => void createConversation.mutate()}
        onDeleteConversation={(conversation) => {
          const confirmed = window.confirm("删除后仅从历史对话中隐藏，消息和系统内容会保留用于后续知识库。确认删除吗？");
          if (confirmed) deleteConversation.mutate(conversation);
        }}
        onDeleteProject={(project) => {
          const confirmed = window.confirm(`确认删除“${project.title}”？项目会从列表隐藏，消息、需求文档和原型会保留用于后续知识库。`);
          if (confirmed) deleteProject.mutate(project);
        }}
      />
      <ChatPanel
        messages={messagesQuery.data?.items ?? []}
        decision={decision}
        disabled={projectsQuery.isLoading}
        sending={sendMessage.isPending}
        onSend={async (content) => {
          await sendMessage.mutateAsync(content);
        }}
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
      <PreviewPanel
        prdPreview={prdPreview}
        prototypePreview={prototypePreview}
        decision={decision}
      />
    </main>
  );
}

function normalizePrdPreview(value: unknown): Phase1PrdPreview | null {
  const record = asRecord(value);
  if (!record) return null;
  const sectionsValue = Array.isArray(record.sections) ? record.sections : [];
  const sections = sectionsValue.flatMap((item) => {
    const section = asRecord(item);
    if (!section) return [];
    const title = asText(section.title);
    const content = asText(section.content) || asText(section.body) || asText(section.description);
    if (!title && !content) return [];
    return [{
      title: title || "未命名章节",
      content: content || "暂无内容",
    }];
  });
  if (!sections.length) return null;
  return {
    id: asText(record.id) || undefined,
    title: asText(record.title) || "需求文档",
    sections,
  };
}

function errorMessage(error: unknown) {
  if (!error) return null;
  return error instanceof Error ? error.message : "请稍后重试";
}

function deriveProjectTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").replace(/[，。！？,.!?]/g, "").trim();
  if (!normalized) return "智能产品项目";
  return normalized.length > 18 ? `${normalized.slice(0, 18)}项目` : `${normalized}项目`;
}

function normalizePrototypePreview(value: unknown): Phase1PrototypePreview | null {
  const record = asRecord(value);
  if (!record) return null;
  const html = asText(record.html) || asText(record.htmlContent);
  if (!html) return null;
  return {
    id: asText(record.id) || undefined,
    title: asText(record.title) || "原型预览",
    html,
    entryFilePath: asText(record.entryFilePath) || "index.html",
  };
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
