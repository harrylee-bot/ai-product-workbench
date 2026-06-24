"use client";

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { create } from "zustand";
import {
  ChatPanel,
  type VibeRunDebugEvent,
  type VibeClarificationQuestion,
  type Phase1Message,
  type VibeRunStepStatus,
  type VibeRunTimelineItem,
  type VibeRunView,
} from "@/components/chat-panel";
import {
  PreviewPanel,
  type Phase1PrdPreview,
  type Phase1PrototypePreview,
  type Phase2DecisionView,
} from "@/components/preview-panel";
import { ProjectList, type Phase1Conversation, type Phase1Project } from "@/components/project-list";
import { ProtectedRoute } from "@/components/protected-route";
import { ErrorState } from "@/components/ui";
import { apiRequest, streamApiEvents } from "@/lib/api";

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

type VibeHandleMessageResponse = {
  projectId: string;
  conversationId: string;
  userMessage?: Phase1Message & {
    projectId?: string;
    conversationId?: string;
  };
  assistantMessage: null;
  runId: string;
  status: "running";
};

type UpdatePrdSectionResponse = {
  document: unknown;
};

type InlineEditResponse = {
  projectId: string;
  conversationId: string;
  userMessage?: Phase1Message;
  assistantMessage?: Phase1Message | null;
  runId: string;
  status: "candidate_created";
};

type PatchApplyResponse = {
  projectId: string;
  conversationId: string;
  userMessage?: Phase1Message & {
    projectId?: string;
    conversationId?: string;
  };
  assistantMessage?: Phase1Message | null;
  runId: string;
  status: "completed";
};

type ConfirmPrototypeResponse = {
  artifact?: unknown;
  productDesignState?: unknown;
};

type VibeStreamEvent = {
  protocol?: string;
  eventId?: string;
  type: string;
  eventType?: string;
  legacyEventType?: string;
  category?: string;
  phase?: string;
  step?: string;
  content?: string;
  payloadMeta?: VibeStreamPayloadMeta;
  payload?: unknown;
  data?: unknown;
  createdAt?: string;
};

type VibeStreamPayloadMeta = {
  schema?: string;
  kind?: string;
  primaryId?: string;
  secondaryId?: string;
  status?: string;
  title?: string;
  summary?: string;
  action?: string;
  counts?: Record<string, number>;
  refs?: Record<string, string>;
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
  const runStreamAbortRef = useRef<AbortController | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(WORKSPACE_PREVIEW_DEFAULT_WIDTH);
  const [resizingPreview, setResizingPreview] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runState, setRunState] = useState<VibeRunView | null>(null);
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

  useEffect(() => {
    return () => runStreamAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    runStreamAbortRef.current?.abort();
    setActiveRunId(null);
    setRunState(null);
  }, [selectedProjectId, selectedConversationId]);

  const watchVibeRun = (runId: string, projectId: string, conversationId: string) => {
    runStreamAbortRef.current?.abort();
    let terminalEventSeen = false;
    setActiveRunId(runId);
    setRunState(createInitialRunState(runId));

    const connectStream = (attempt: number) => {
      const controller = new AbortController();
      runStreamAbortRef.current = controller;

      void streamApiEvents<VibeStreamEvent>(
        `/ai/vibe/runs/${runId}/stream`,
        (event) => {
          const eventType = event.eventType ?? event.type;
          const payload = payloadRecord(event);
          setRunState((current) => reduceRunState(current ?? createInitialRunState(runId), event));

          if (eventType === "prd_updated" && payload) {
            setArtifactPreview({ prdPreview: normalizePrdPreview(payload) });
          }

          if (eventType === "prototype_updated" && payload) {
            const artifactPayload = asRecord(payload.prototypeArtifact) ?? payload;
            setArtifactPreview({ prototypePreview: normalizePrototypePreview(artifactPayload) });
          }

          if (eventType === "run_completed" || eventType === "run_failed") {
            terminalEventSeen = true;
            const result = payload;
            const prdPayload = asRecord(result?.prdDocument);
            const prototypePayload = asRecord(result?.prototypeArtifact);
            if (prdPayload || prototypePayload) {
              setArtifactPreview({
                prdPreview: prdPayload ? normalizePrdPreview(prdPayload) : undefined,
                prototypePreview: prototypePayload ? normalizePrototypePreview(prototypePayload) : undefined,
              });
            }
            setActiveRunId(null);
            controller.abort();
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: ["phase1-messages", conversationId] }),
              queryClient.invalidateQueries({ queryKey: ["phase1-project", projectId] }),
              queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
            ]);
          }
        },
        { signal: controller.signal },
      ).catch((error) => {
        if (controller.signal.aborted || runStreamAbortRef.current !== controller || terminalEventSeen) return;

        const nextAttempt = attempt + 1;
        if (nextAttempt <= 5) {
          setRunState((current) =>
            appendRunConnectionNotice(
              current ?? createInitialRunState(runId),
              runId,
              `执行流连接短暂中断，正在第 ${nextAttempt} 次自动重连...`,
              "warning",
            )
          );
          window.setTimeout(() => {
            if (!controller.signal.aborted && runStreamAbortRef.current === controller && !terminalEventSeen) {
              connectStream(nextAttempt);
            }
          }, streamReconnectDelayMs(nextAttempt));
          return;
        }

        setActiveRunId(null);
        setRunState((current) =>
          appendRunConnectionNotice(
            current ?? createInitialRunState(runId),
            runId,
            `执行流连接中断，后端任务可能仍在继续。请稍后刷新项目查看最新结果。${formatErrorMessage(error)}`,
            "failed",
          )
        );
      });
    };

    connectStream(0);
  };

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

      return apiRequest<VibeHandleMessageResponse>("/ai/vibe/handle-message", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          conversationId,
          message: content,
        }),
      });
    },
    onSuccess: async (response) => {
      const responseProjectId = response.projectId || response.userMessage?.projectId || selectedProjectId;
      const responseConversationId = response.conversationId || response.userMessage?.conversationId || selectedConversationId;

      setDecision(null);
      watchVibeRun(response.runId, responseProjectId, responseConversationId);
      await Promise.all([
        responseConversationId
          ? queryClient.invalidateQueries({ queryKey: ["phase1-messages", responseConversationId] })
          : Promise.resolve(),
        responseProjectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", responseProjectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
  });

  const confirmPatch = useMutation({
    mutationFn: (patchId: string) =>
      apiRequest<PatchApplyResponse>("/patch/preview/apply", {
        method: "POST",
        body: JSON.stringify({
          patchId,
          userConfirmation: "用户在工作台确认应用 Patch 候选",
        }),
      }),
    onSuccess: async (response) => {
      const responseProjectId = response.projectId || response.userMessage?.projectId || selectedProjectId;
      const responseConversationId = response.conversationId || response.userMessage?.conversationId || selectedConversationId;

      setDecision(null);
      watchVibeRun(response.runId, responseProjectId, responseConversationId);
      await Promise.all([
        responseConversationId
          ? queryClient.invalidateQueries({ queryKey: ["phase1-messages", responseConversationId] })
          : Promise.resolve(),
        responseProjectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", responseProjectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "Patch 应用失败");
    },
  });

  const confirmPrd = useMutation({
    mutationFn: () =>
      apiRequest<VibeHandleMessageResponse>("/ai/vibe/confirm-prd", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          conversationId: selectedConversationId,
        }),
      }),
    onSuccess: async (response) => {
      const responseProjectId = response.projectId || response.userMessage?.projectId || selectedProjectId;
      const responseConversationId = response.conversationId || response.userMessage?.conversationId || selectedConversationId;

      setDecision(null);
      watchVibeRun(response.runId, responseProjectId, responseConversationId);
      await Promise.all([
        responseConversationId
          ? queryClient.invalidateQueries({ queryKey: ["phase1-messages", responseConversationId] })
          : Promise.resolve(),
        responseProjectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", responseProjectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "确认 PRD 失败");
    },
  });

  const confirmPrototype = useMutation({
    mutationFn: (artifactId: string) =>
      apiRequest<ConfirmPrototypeResponse>(`/prototype-artifacts/${encodeURIComponent(artifactId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ reason: "用户确认原型，可创建分享链接" }),
      }),
    onSuccess: async (response) => {
      if (response.artifact) {
        setArtifactPreview({ prototypePreview: normalizePrototypePreview(response.artifact) });
      }
      setRunState((current) => current
        ? {
            ...current,
            status: "completed",
            summary: "原型已确认，可以创建只读分享链接。",
          }
        : current);
      await Promise.all([
        selectedProjectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", selectedProjectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "确认原型失败");
    },
  });

  const updatePrdSection = useMutation({
    mutationFn: (input: { documentId: string; sectionId: string; content: string }) =>
      apiRequest<UpdatePrdSectionResponse>(
        `/prd-documents/${encodeURIComponent(input.documentId)}/sections/${encodeURIComponent(input.sectionId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ content: input.content }),
        },
      ),
    onSuccess: async (response) => {
      setArtifactPreview({ prdPreview: normalizePrdPreview(response.document) });
      await Promise.all([
        selectedProjectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", selectedProjectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "PRD 段落保存失败");
    },
  });

  const aiEditPrdSection = useMutation({
    mutationFn: (input: {
      sectionId: string;
      blockId?: string;
      title: string;
      content: string;
      sourcePaths?: string[];
      instruction: string;
    }) => {
      if (!selectedProjectId || !selectedConversationId || !prdPreview?.id) {
        throw new Error("请先选择项目和对话，再进行 AI 局部编辑");
      }
      return apiRequest<InlineEditResponse>("/ai/inline-edit", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          conversationId: selectedConversationId,
          selectedRegion: {
            type: "document",
            targetId: prdPreview.id,
            documentId: prdPreview.id,
            sectionId: input.sectionId,
            blockId: input.blockId,
            label: input.title,
            sourcePaths: input.sourcePaths,
          },
          selectedText: input.content,
          instruction: input.instruction,
          action: "rewrite",
        }),
      });
    },
    onSuccess: async (response) => {
      watchVibeRun(response.runId, response.projectId || selectedProjectId, response.conversationId || selectedConversationId);
      await Promise.all([
        response.conversationId
          ? queryClient.invalidateQueries({ queryKey: ["phase1-messages", response.conversationId] })
          : Promise.resolve(),
        response.projectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", response.projectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "AI 局部编辑失败");
    },
  });

  const aiEditPrototypeSelection = useMutation({
    mutationFn: (input: {
      selectionId: string;
      componentId?: string;
      pageId?: string;
      action: string;
      instruction: string;
      bbox: { x: number; y: number; width: number; height: number };
      label: string;
    }) => {
      if (!selectedProjectId || !selectedConversationId || !prototypePreview?.id) {
        throw new Error("请先选择项目和对话，并生成原型后再进行局部编辑");
      }
      return apiRequest<InlineEditResponse>("/prototype/edit", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          conversationId: selectedConversationId,
          selectedRegion: {
            type: "prototype",
            targetId: prototypePreview.id,
            artifactId: prototypePreview.id,
            pageId: input.pageId,
            componentId: input.componentId,
            label: input.label,
            bbox: input.bbox,
          },
          selectedText: input.label,
          instruction: input.instruction,
          action: input.action,
        }),
      });
    },
    onSuccess: async (response) => {
      watchVibeRun(response.runId, response.projectId || selectedProjectId, response.conversationId || selectedConversationId);
      await Promise.all([
        response.conversationId
          ? queryClient.invalidateQueries({ queryKey: ["phase1-messages", response.conversationId] })
          : Promise.resolve(),
        response.projectId ? queryClient.invalidateQueries({ queryKey: ["phase1-project", response.projectId] }) : Promise.resolve(),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "原型局部编辑失败");
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
        runState={runState}
        disabled={projectsQuery.isLoading}
        sending={sendMessage.isPending || Boolean(activeRunId)}
        confirmingPatchId={confirmPatch.isPending ? confirmPatch.variables : undefined}
        onConfirmPatch={async (patchId) => {
          await confirmPatch.mutateAsync(patchId);
        }}
        confirmingPrd={confirmPrd.isPending}
        onConfirmPrd={async () => {
          await confirmPrd.mutateAsync();
        }}
        confirmingPrototypeId={confirmPrototype.isPending ? confirmPrototype.variables : undefined}
        onConfirmPrototype={async (artifactId) => {
          await confirmPrototype.mutateAsync(artifactId);
        }}
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
        projectId={selectedProjectId}
        prdPreview={prdPreview}
        prototypePreview={prototypePreview}
        decision={decision}
        savingPrdSectionId={updatePrdSection.isPending ? updatePrdSection.variables?.sectionId : undefined}
        aiEditingPrdSectionId={aiEditPrdSection.isPending ? aiEditPrdSection.variables?.sectionId : undefined}
        aiEditingPrototypeSelectionId={aiEditPrototypeSelection.isPending ? aiEditPrototypeSelection.variables?.selectionId : undefined}
        onSavePrdSection={async (input) => {
          if (!prdPreview?.id) return;
          await updatePrdSection.mutateAsync({
            documentId: prdPreview.id,
            sectionId: input.sectionId,
            content: input.content,
          });
        }}
        onAiEditPrdSection={async (input) => {
          await aiEditPrdSection.mutateAsync(input);
        }}
        onAiEditPrototypeSelection={async (input) => {
          await aiEditPrototypeSelection.mutateAsync(input);
        }}
      />
    </main>
  );
}

function normalizePrdPreview(value: unknown): Phase1PrdPreview | null {
  const record = asRecord(value);
  if (!record) return null;
  const sectionsValue = Array.isArray(record.sections) ? record.sections : [];
  const sections = sectionsValue.flatMap((item, index) => {
    const section = asRecord(item);
    if (!section) return [];
    const title = asText(section.title);
    const content = asText(section.content) || asText(section.body) || asText(section.description);
    const blocks = normalizePrdBlocks(section.blocks);
    const blockContent = blocks.map((block) => block.content).filter(Boolean).join("\n\n");
    const resolvedContent = content || blockContent;
    if (!title && !resolvedContent) return [];
    return [{
      id: asText(section.id) || `section-${index + 1}`,
      title: title || "未命名章节",
      content: resolvedContent || "暂无内容",
      type: asText(section.type) || undefined,
      level: normalizePrdLevel(section.level),
      order: normalizeNumber(section.order) ?? index + 1,
      sourcePaths: normalizeTextArray(section.sourcePaths),
      sourceStatePaths: normalizeTextArray(section.sourceStatePaths),
      tags: normalizeTextArray(section.tags),
      blocks,
    }];
  });
  if (!sections.length) return null;
  return {
    id: asText(record.id) || undefined,
    title: asText(record.title) || "需求文档",
    sections,
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
      tags: normalizeTextArray(block.tags),
    }];
  });
}

function normalizePrdBlockType(value: unknown) {
  const text = asText(value);
  if (
    text === "paragraph" ||
    text === "bullet_list" ||
    text === "table" ||
    text === "quote" ||
    text === "warning" ||
    text === "info"
  ) {
    return text;
  }
  return "paragraph";
}

function normalizePrdLevel(value: unknown): 1 | 2 | 3 | undefined {
  const level = normalizeNumber(value);
  return level === 1 || level === 2 || level === 3 ? level : undefined;
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

const VIBE_RUN_STEPS = [
  { step: "intent_detection", title: "理解意图", agent: "Intent Agent", detail: "识别用户目标、选区和是否进入生成链路" },
  { step: "knowledge_retrieval", title: "检索知识", agent: "Knowledge Agent", detail: "加载知识库、附件和 Vibe Coding skills" },
  { step: "context_fetch", title: "抓取上下文", agent: "Context Fetch", detail: "读取项目状态、历史消息、选区、附件和既有产物" },
  { step: "requirement_analysis", title: "分析需求", agent: "Requirement Analyst", detail: "判断需求完整度、缺口、冲突和澄清问题" },
  { step: "requirement_packaging", title: "整理需求包", agent: "Requirement Merge", detail: "合并用户事实、知识事实、上下文、假设和溯源" },
  { step: "product_planning", title: "规划方案", agent: "Product Planner", detail: "消费同一份 RequirementPackage，生成 ProductBuildPlan 和下游 agent 顺序" },
  { step: "requirement_validation", title: "结构校验", agent: "Validator", detail: "生成前检查需求包、计划、选区和版本条件是否可执行" },
  { step: "safety_check", title: "安全检查", agent: "Safety Check", detail: "生成前检查提示注入、密钥泄漏、越权、隐私和真实外部动作风险" },
  { step: "product_design", title: "生成产品状态", agent: "Product Designer", detail: "把计划落到 ProductDesignState 唯一事实源" },
  { step: "prd_generation", title: "生成 PRD", agent: "PRD Writer", detail: "只基于 ProductDesignState 输出结构化 PRD" },
  { step: "prototype_design", title: "设计原型结构", agent: "Prototype Designer", detail: "只基于 ProductDesignState 输出 PrototypeSpec" },
  { step: "prototype_code_generation", title: "生成 HTML", agent: "Prototype Code", detail: "只基于 PrototypeSpec 输出单文件 HTML 原型" },
  { step: "patch_planning", title: "规划局部修改", agent: "Patch Agent", detail: "输出只作用于 ProductDesignState 的 PatchPlan" },
  { step: "qa_check", title: "QA 闸门", agent: "QA Agent", detail: "检查一致性并决定确认、知识、发布和导出闸门" },
  { step: "knowledge_extraction", title: "抽取知识候选", agent: "Knowledge Extractor", detail: "从稳定产物中沉淀待审核知识候选" },
];

function streamReconnectDelayMs(attempt: number) {
  return Math.min(800 + attempt * 700, 5_000);
}

function formatErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return "";
  if (/load failed|failed to fetch|networkerror/i.test(message)) {
    return " 原因：浏览器网络流连接中断。";
  }
  return ` 原因：${message}`;
}

function appendRunConnectionNotice(
  state: VibeRunView,
  runId: string,
  text: string,
  status: VibeRunTimelineItem["status"],
): VibeRunView {
  const id = `${runId}:stream-connection:${status}:${Date.now()}`;
  const next = {
    ...state,
    currentLabel: text,
    status: status === "failed" ? state.status : "running",
  };
  return appendDebugEvent(
    appendTimelineItem(next, {
      id,
      text,
      status,
    }),
    {
      id: `${id}:debug`,
      title: status === "failed" ? "执行流连接中断" : "执行流自动重连",
      body: status === "failed"
        ? "浏览器到后端的事件流连接多次中断。后端任务可能仍在继续，刷新项目后可读取已落库的最新事件和结果。"
        : "浏览器事件流连接短暂中断，前端正在自动重连。重连后后端会回放已落库事件，避免丢失执行进度。",
      status,
      type: "stream_reconnect",
    },
  );
}

function createInitialRunState(runId: string): VibeRunView {
  return {
    runId,
    status: "running",
    currentLabel: "正在连接 Vibe Coding 主链路...",
    steps: VIBE_RUN_STEPS.map((step) => ({ ...step, status: "pending" })),
    timeline: [
      {
        id: `${runId}:stream-connected`,
        text: "我已收到你的请求，接下来会按执行事件逐步播报判断过程。",
        status: "running",
      },
    ],
    debugEvents: [
      {
        id: `${runId}:stream-connected:debug`,
        title: "执行流连接",
        body: "前端已经拿到 runId，正在连接后端事件流。后续每个事件都会记录在这里。",
        status: "running",
        type: "stream_connected",
      },
    ],
  };
}

function reduceRunState(current: VibeRunView, event: VibeStreamEvent): VibeRunView {
  const eventType = event.eventType ?? event.type;
  const payload = payloadRecord(event);
  const payloadMeta = payloadMetaRecord(event);
  const metaSummary = asText(payloadMeta?.summary);
  let next: VibeRunView = {
    ...current,
    currentLabel: event.content ?? metaSummary ?? current.currentLabel,
    steps: current.steps.map((step) => ({ ...step })),
    timeline: current.timeline ? [...current.timeline] : [],
    debugEvents: current.debugEvents ? [...current.debugEvents] : [],
  };

  if (event.step) {
    if (eventType === "step_started") {
      next = updateStep(next, event.step, "running", event.content);
    }
    if (eventType === "step_completed") {
      next = updateStep(next, event.step, "done", event.content);
    }
    if (eventType === "step_failed") {
      next = updateStep(next, event.step, "failed", event.content);
      next.status = "failed";
      next.errorMessage = event.content ?? "Agent 执行失败";
    }
    if (eventType === "fallback_used") {
      next = updateStep(next, event.step, undefined, event.content);
    }
  }

  if (eventType === "message_delta" && event.content) {
    next.currentLabel = event.content;
  }

  if (eventType === "prd_updated") {
    next = updateStep(next, "prd_generation", "done", "PRD 已更新");
  }

  if (eventType === "prototype_updated") {
    next = updateStep(next, "prototype_code_generation", "done", "HTML 原型已更新");
  }

  if (eventType === "patch_started") {
    next = updateStep(next, "patch_planning", "running", event.content ?? "正在规划局部修改");
  }

  if (eventType === "patch_plan_created") {
    next = updateStep(next, "patch_planning", "done", "局部修改计划已生成，等待用户确认");
    const patchPreview = asRecord(payload?.patchPreview);
    next.patchId = asText(payload?.patchId) || asText(patchPreview?.patchId) || asText(payloadMeta?.primaryId) || next.patchId;
    next.patchPreviewMessage = asText(patchPreview?.message) || event.content || metaSummary || next.patchPreviewMessage;
    next.summary = "局部修改候选已生成，等待确认后再应用";
  }

  if (eventType === "patch_applying") {
    next.currentLabel = event.content ?? metaSummary ?? "正在应用已确认的局部修改";
  }

  if (eventType === "patch_completed") {
    next.currentLabel = event.content ?? metaSummary ?? "局部修改已完成并重新生成产物";
  }

  if (eventType === "patch_failed") {
    next = updateStep(next, "patch_planning", "failed", event.content ?? "局部修改失败");
    next.status = "failed";
    next.errorMessage = event.content ?? "局部修改失败";
  }

  if (eventType === "qa_completed" && payload) {
    const qaReport = asRecord(payload.qaReport) ?? payload;
    const qaGate = asRecord(payload.qaGate) ?? asRecord(qaReport.gate);
    next = updateStep(next, "qa_check", "done", "QA 校验完成");
    next.qaIssueCount = readArrayLength(qaReport.issues) || numberFromRecord(payloadMeta?.counts, "issues");
    const gateStatus = asQaGateStatus(qaGate?.status ?? payloadMeta?.status);
    if (gateStatus) {
      next.qaGateStatus = gateStatus;
      next.qaGateSummary = qaGateSummary(qaGate) ?? metaSummary;
    }
  }

  if (eventType === "export_ready") {
    next.exportFileName = asText(payload?.fileName) || asText(payloadMeta?.title);
    next.summary = event.content ?? metaSummary ?? (next.exportFileName ? `已准备导出文件：${next.exportFileName}` : "导出文件已准备好");
  }

  if (eventType === "knowledge_candidate_created") {
    next = updateStep(next, "knowledge_extraction", "done", event.content ?? "知识候选已生成");
  }

  if (eventType === "step_completed" && event.step === "knowledge_retrieval" && payload) {
    next.knowledgeHitCount = [
      readArrayLength(payload.strongRules),
      readArrayLength(payload.defaultRules),
      readArrayLength(payload.referenceCases),
      readArrayLength(payload.designPatterns),
      readArrayLength(payload.prdWritingRules),
      readArrayLength(payload.prototypeRules),
      readArrayLength(payload.businessConcepts),
    ].reduce((sum, value) => sum + value, 0);
  }

  if (eventType === "run_completed") {
    const nextAction = asRecord(payload?.nextAction);
    const patchRecord = asRecord(payload?.patchRecord);
    const patchPreview = asRecord(payload?.patchPreview);
    const nextActionType = asText(nextAction?.type);
    if (nextActionType === "confirm_patch") {
      next.status = "waiting_confirmation";
      next.patchId = asText(patchRecord?.id) || asText(patchPreview?.patchId) || asText(payloadMeta?.primaryId) || next.patchId;
      next.patchPreviewMessage = asText(patchPreview?.message) || metaSummary || next.patchPreviewMessage;
      next.summary = event.content ?? metaSummary ?? asText(payload?.message) ?? "Patch 候选已生成，等待确认后再应用";
    } else if (nextActionType === "review_prd") {
      // 确认门 A（FR-1.2）：PRD 已生成，停下等待用户确认
      next.status = "waiting_prd_confirm";
      next.wantsPrototype = nextAction?.wantsPrototype !== false;
      next.summary = asText(payload?.message) ?? event.content ?? metaSummary ?? "PRD 已生成，请确认无误";
    } else if (nextActionType === "review_prototype") {
      const prototypeArtifact = asRecord(payload?.prototypeArtifact);
      const refs = asRecord(payloadMeta?.refs);
      next.status = "waiting_prototype_confirm";
      next.prototypeArtifactId = asText(prototypeArtifact?.id) ?? asText(refs?.prototypeArtifactId) ?? next.prototypeArtifactId;
      next.summary = asText(payload?.message) ?? event.content ?? metaSummary ?? "原型已生成，请确认无误";
    } else if (nextActionType === "ask_clarification") {
      const questions = normalizeClarificationQuestions(nextAction?.questions);
      next.status = "waiting_clarification";
      next.clarificationQuestions = questions;
      next.summary = asText(payload?.message)
        || event.content
        || metaSummary
        || (questions.length ? `需要先确认 ${questions.length} 个问题` : "需要先补充关键信息");
    } else {
      next.status = "completed";
      next.summary = event.content ?? metaSummary ?? asText(payload?.message) ?? "Vibe Coding 主链路已完成";
    }
    next.steps = next.steps.map((step) => step.status === "running" ? { ...step, status: "done" } : step);
  }

  if (eventType === "run_failed") {
    next.status = "failed";
    next.errorMessage = event.content ?? metaSummary ?? asText(payload?.message) ?? "Vibe Coding 主链路执行失败";
    next.steps = next.steps.map((step) => step.status === "running" ? { ...step, status: "failed" } : step);
  }

  return appendDebugEvent(
    appendTimelineItem(next, buildTimelineItem(event, next)),
    buildDebugEvent(event, next),
  );
}

function updateStep(
  state: VibeRunView,
  stepName: string,
  status?: VibeRunStepStatus,
  message?: string,
): VibeRunView {
  let matched = false;
  const steps = state.steps.map((step) => {
    if (step.step !== stepName) return step;
    matched = true;
    return {
      ...step,
      status: status ?? step.status,
      message: message ?? step.message,
    };
  });

  if (!matched) {
    steps.push({
      step: stepName,
      title: stepName,
      agent: "Vibe Agent",
      detail: "后端返回的扩展步骤",
      status: status ?? "running",
      message,
    });
  }

  return {
    ...state,
    steps,
  };
}

function appendTimelineItem(state: VibeRunView, item: VibeRunTimelineItem | null): VibeRunView {
  if (!item) return state;
  const timeline = state.timeline ?? [];
  if (timeline.some((existing) => existing.id === item.id)) return state;
  return {
    ...state,
    timeline: [...timeline, item],
  };
}

function appendDebugEvent(state: VibeRunView, item: VibeRunDebugEvent | null): VibeRunView {
  if (!item) return state;
  const debugEvents = state.debugEvents ?? [];
  if (debugEvents.some((existing) => existing.id === item.id)) return state;
  return {
    ...state,
    debugEvents: [...debugEvents, item],
  };
}

function buildTimelineItem(event: VibeStreamEvent, state: VibeRunView): VibeRunTimelineItem | null {
  const eventType = event.eventType ?? event.type;
  const payload = payloadRecord(event);
  const payloadMeta = payloadMetaRecord(event);
  const id = event.eventId ?? `${eventType}:${event.step ?? "run"}:${event.createdAt ?? state.timeline?.length ?? 0}`;
  const step = event.step;
  const stepTitle = step ? stepLabel(step) : undefined;

  if (eventType === "step_started" && step) {
    return timelineItem(id, step, "running", stepStartedText(step, stepTitle));
  }

  if (eventType === "step_completed" && step) {
    const traceText = decisionTraceTimelineText(payload);
    if (traceText) return timelineItem(id, step, "done", traceText);
    return timelineItem(id, step, "done", stepCompletedText(step, stepTitle, payload));
  }

  if (eventType === "step_failed" && step) {
    return timelineItem(id, step, "failed", `${stepTitle ?? "这一步"}没有完成：${safeEventText(event, payloadMeta, "请稍后重试或查看调试信息。")}`);
  }

  if (eventType === "fallback_used") {
    const fallback = asRecord(payload);
    const userMessage = asText(fallback?.userMessage);
    return timelineItem(
      id,
      step,
      "warning",
      userMessage || `${stepTitle ?? "某个步骤"}没有拿到理想模型结果，已用规则兜底继续执行。`,
    );
  }

  if (eventType === "message_delta") {
    const text = safeEventText(event, payloadMeta, "");
    return text ? timelineItem(id, step, "info", text) : null;
  }

  if (eventType === "state_updated") {
    return timelineItem(id, step, "done", "产品状态已经更新，后续 PRD 和原型会继续从这份状态生成。");
  }

  if (eventType === "state_version_created") {
    return timelineItem(id, step, "done", "已保存一个新的产品状态版本，方便后续追踪和回滚。");
  }

  if (eventType === "prd_updated") {
    return timelineItem(id, "prd_generation", "done", "PRD 已生成并更新到右侧预览区。");
  }

  if (eventType === "prototype_updated") {
    return timelineItem(id, "prototype_code_generation", "done", "HTML 原型已生成并更新到右侧预览区。");
  }

  if (eventType === "patch_started") {
    return timelineItem(id, "patch_planning", "running", "开始理解你的局部修改要求，正在准备 Patch 候选。");
  }

  if (eventType === "patch_plan_created") {
    return timelineItem(id, "patch_planning", "done", "局部修改方案已准备好，等你确认后再真正应用。");
  }

  if (eventType === "patch_applying") {
    return timelineItem(id, "patch_planning", "running", "正在应用已确认的局部修改，并同步重算相关产物。");
  }

  if (eventType === "patch_completed") {
    return timelineItem(id, "patch_planning", "done", "局部修改已应用完成，PRD、原型和 QA 已同步刷新。");
  }

  if (eventType === "patch_failed") {
    return timelineItem(id, "patch_planning", "failed", `局部修改没有应用成功：${safeEventText(event, payloadMeta, "系统已保留原有版本。")}`);
  }

  if (eventType === "qa_completed") {
    const issueText = state.qaIssueCount === undefined
      ? ""
      : state.qaIssueCount > 0
        ? `，发现 ${state.qaIssueCount} 个需要关注的问题`
        : "，没有发现阻断问题";
    return timelineItem(id, "qa_check", state.qaGateStatus === "blocked" ? "warning" : "done", `QA 检查完成${issueText}。`);
  }

  if (eventType === "knowledge_candidate_created") {
    return timelineItem(id, "knowledge_extraction", "done", "已抽取可复用知识候选，后续可审核沉淀。");
  }

  if (eventType === "export_ready") {
    return timelineItem(id, step, "done", state.exportFileName ? `导出文件已准备好：${state.exportFileName}。` : "导出文件已准备好。");
  }

  if (eventType === "run_completed") {
    const nextActionType = asText(asRecord(payload?.nextAction)?.type);
    if (nextActionType === "confirm_patch") {
      return timelineItem(id, step, "done", "本轮已停在 Patch 确认门。确认后，我会继续应用修改。");
    }
    if (nextActionType === "review_prd") {
      return timelineItem(id, step, "done", "PRD 已生成，本轮先停在确认门。你确认后我再继续生成原型。");
    }
    if (nextActionType === "review_prototype") {
      return timelineItem(id, step, "done", "原型和检查已完成，请先确认原型是否符合预期。");
    }
    if (nextActionType === "download_export") {
      return timelineItem(id, step, "done", "导出任务已完成，可以下载文件。");
    }
    if (nextActionType === "ask_clarification") {
      const questionCount = readArrayLength(asRecord(payload?.nextAction)?.questions);
      return timelineItem(
        id,
        step,
        "warning",
        questionCount ? `我还需要你确认 ${questionCount} 个问题，才能继续生成。` : "我还需要你补充几个关键信息，才能继续生成。",
      );
    }
    return timelineItem(id, step, "done", state.summary ?? "本轮执行已完成。");
  }

  if (eventType === "run_failed") {
    return timelineItem(id, step, "failed", state.errorMessage ?? "本轮执行失败，请查看失败原因后重试。");
  }

  return null;
}

function buildDebugEvent(event: VibeStreamEvent, state: VibeRunView): VibeRunDebugEvent {
  const eventType = event.eventType ?? event.type;
  const payload = payloadRecord(event);
  const payloadMeta = payloadMetaRecord(event);
  const step = event.step;
  const title = debugEventTitle(eventType, step);
  const body = debugEventBody(event, payload, payloadMeta, state);
  return {
    id: `${event.eventId ?? `${eventType}:${step ?? "run"}:${event.createdAt ?? state.debugEvents?.length ?? 0}`}:debug`,
    type: eventType,
    step,
    title,
    body,
    status: debugEventStatus(eventType),
    createdAt: event.createdAt,
    raw: serializeDebugEvent(event),
  };
}

function debugEventTitle(eventType: string, step?: string) {
  const stepTitle = step ? stepLabel(step) : undefined;
  const eventLabels: Record<string, string> = {
    step_started: "步骤开始",
    step_completed: "步骤完成",
    step_failed: "步骤失败",
    fallback_used: "规则兜底",
    message_delta: "过程消息",
    state_updated: "产品状态更新",
    state_version_created: "状态版本保存",
    prd_updated: "PRD 更新",
    prototype_updated: "原型更新",
    patch_started: "局部修改开始",
    patch_plan_created: "局部修改候选",
    patch_applying: "局部修改应用中",
    patch_completed: "局部修改完成",
    patch_failed: "局部修改失败",
    qa_completed: "QA 完成",
    knowledge_candidate_created: "知识候选生成",
    export_ready: "导出就绪",
    run_completed: "本轮结束",
    run_failed: "本轮失败",
  };
  return stepTitle ? `${eventLabels[eventType] ?? eventType}：${stepTitle}` : eventLabels[eventType] ?? eventType;
}

function debugEventStatus(eventType: string): VibeRunDebugEvent["status"] {
  if (eventType.endsWith("_failed") || eventType === "run_failed" || eventType === "step_failed") return "failed";
  if (eventType === "fallback_used") return "warning";
  if (eventType.endsWith("_started") || eventType === "patch_applying" || eventType === "step_started") return "running";
  if (eventType.endsWith("_completed") || eventType.endsWith("_updated") || eventType.endsWith("_created") || eventType === "run_completed" || eventType === "export_ready") return "done";
  return "info";
}

function debugEventBody(
  event: VibeStreamEvent,
  payload: Record<string, unknown> | null,
  payloadMeta: VibeStreamPayloadMeta | undefined,
  state: VibeRunView,
) {
  const eventType = event.eventType ?? event.type;
  const lines: string[] = [];
  const visibleText = event.content || payloadMeta?.summary;
  if (visibleText && !looksLikeStructuredData(visibleText)) {
    lines.push(`后端说明：${normalizeTimelineText(visibleText)}`);
  }

  if (event.step) {
    lines.push(`当前节点：${stepLabel(event.step)}。`);
  }

  const intakeGraph = findRequirementIntakeGraph(payload);
  if (intakeGraph) {
    lines.push(...formatRequirementIntakeGraph(intakeGraph));
  }

  if (eventType === "step_started" && event.step) {
    lines.push(`执行思路：${stepThinkingText(event.step)}`);
    lines.push(`下一步：等待该节点产出结果，再决定是否继续、澄清或阻断。`);
  }

  if (eventType === "step_completed" && event.step) {
    const decisionTrace = decisionTraceRecord(payload);
    if (decisionTrace) {
      lines.push(...formatDecisionTrace(decisionTrace));
    } else {
      lines.push(`结果摘要：${stepCompletedText(event.step, stepLabel(event.step), payload)}`);
      lines.push("下一步：把这个节点的结果交给后续节点继续处理。");
    }
  }

  if (eventType === "fallback_used") {
    const fallback = asRecord(payload);
    lines.push(`兜底原因：${asText(fallback?.reason) || asText(fallback?.errorMessage) || "模型结果不可用或超时。"}`);
    lines.push(`用户可见说明：${asText(fallback?.userMessage) || "系统已使用规则兜底继续执行。"}`);
  }

  if (eventType === "message_delta") {
    const requirementGate = asRecord(payload?.requirementGate);
    const gateTrace = asRecord(requirementGate?.decisionTrace);
    const gateAction = asText(requirementGate?.action);
    if (gateAction) lines.push(`生成前 Gate 动作：${gateAction}。`);
    if (gateTrace) lines.push(...formatDecisionTrace(gateTrace));
  }

  if (eventType === "run_completed") {
    const nextActionType = asText(asRecord(payload?.nextAction)?.type);
    lines.push(`终态动作：${nextActionLabel(nextActionType)}。`);
    lines.push(`当前摘要：${state.summary || "本轮执行已到达业务终态。"}`);
  }

  if (eventType === "run_failed") {
    lines.push(`失败原因：${state.errorMessage || "后端返回 run_failed。"}`);
  }

  const metaParts = [
    payloadMeta?.status ? `状态=${payloadMeta.status}` : "",
    payloadMeta?.action ? `动作=${payloadMeta.action}` : "",
    payloadMeta?.primaryId ? `主对象=${payloadMeta.primaryId}` : "",
    payloadMeta?.counts ? `计数=${JSON.stringify(payloadMeta.counts)}` : "",
  ].filter(Boolean);
  if (metaParts.length) lines.push(`事件元信息：${metaParts.join("；")}。`);

  if (payload) {
    const keys = Object.keys(payload).slice(0, 12);
    if (keys.length) lines.push(`原始 payload 字段：${keys.join("、")}。`);
  }

  return lines.length ? lines.join("\n") : "该事件没有附带额外说明，已记录原始事件供调试查看。";
}

function decisionTraceRecord(payload: Record<string, unknown> | null) {
  return asRecord(payload?.decisionTrace);
}

function decisionTraceTimelineText(payload: Record<string, unknown> | null) {
  const trace = decisionTraceRecord(payload);
  if (!trace) return "";
  const decision = asText(trace.decision);
  const nextStep = asText(trace.nextStep);
  const summary = asText(trace.summary);
  return [
    summary ? `判断完成：${summary}` : "",
    decision ? `决策：${decision}` : "",
    nextStep ? `下一步：${nextStep}` : "",
  ].filter(Boolean).join(" ");
}

function formatDecisionTrace(trace: Record<string, unknown>) {
  const lines: string[] = [];
  const summary = asText(trace.summary);
  const decision = asText(trace.decision);
  const nextStep = asText(trace.nextStep);
  const generatedBy = trace.generatedBy === "model" ? "模型公开 trace" : "系统兜底 trace";

  lines.push(`判断轨迹来源：${generatedBy}。`);
  if (summary) lines.push(`判断摘要：${normalizeTimelineText(summary)}`);
  appendTraceList(lines, "输入信号", trace.inputSignals);
  appendTraceList(lines, "约束依据", trace.constraints);
  appendTraceList(lines, "待确认假设", trace.assumptions);
  appendTraceList(lines, "考虑过的路线", trace.alternativesConsidered);
  if (decision) lines.push(`最终决策：${normalizeTimelineText(decision)}`);
  appendTraceList(lines, "风险", trace.risks);
  if (nextStep) lines.push(`下一步：${normalizeTimelineText(nextStep)}`);
  return lines;
}

function findRequirementIntakeGraph(payload: Record<string, unknown> | null) {
  const direct = asRecord(payload?.requirementIntakeGraph);
  if (direct) return direct;
  const gate = asRecord(payload?.requirementGate);
  return asRecord(gate?.intakeGraph);
}

function formatRequirementIntakeGraph(graph: Record<string, unknown>) {
  const lines: string[] = [];
  const summary = asText(graph.summary);
  const gateAction = asText(graph.gateAction);
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.map((item) => asRecord(item)).filter(Boolean) : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.map((item) => asRecord(item)).filter(Boolean) : [];

  lines.push("执行链路：Intent -> Knowledge / Context Fetch -> Requirement -> Planner / Validator / Safety Check。");
  if (summary) lines.push(`链路摘要：${normalizeTimelineText(summary)}`);
  if (gateAction) lines.push(`最终 Gate：${gateAction}。`);

  if (nodes.length) {
    lines.push("节点结果：");
    for (const node of nodes.slice(0, 8)) {
      const title = asText(node?.title) || asText(node?.name) || "节点";
      const status = asText(node?.status) || "unknown";
      const nodeSummary = asText(node?.summary);
      lines.push(`- ${title}：${status}${nodeSummary ? `，${normalizeTimelineText(nodeSummary)}` : ""}`);
    }
  }

  const sharedEdges = edges
    .filter((edge) => edge?.mode === "shared_input")
    .map((edge) => asText(edge?.summary))
    .filter(Boolean);
  if (sharedEdges.length) {
    lines.push("共享输入关系：");
    lines.push(...sharedEdges.slice(0, 4).map((item) => `- ${normalizeTimelineText(item)}`));
  }

  return lines;
}

function appendTraceList(lines: string[], label: string, value: unknown) {
  const items = Array.isArray(value)
    ? value.map((item) => normalizeTimelineText(String(item ?? ""))).filter(Boolean).slice(0, 6)
    : [];
  if (!items.length) return;
  lines.push(`${label}：`);
  lines.push(...items.map((item) => `- ${item}`));
}

function serializeDebugEvent(event: VibeStreamEvent) {
  const json = JSON.stringify(event, (_key, value) => {
    if (typeof value === "string" && value.length > 4000) {
      return `${value.slice(0, 4000)}...（已截断，完整内容请查后端事件日志）`;
    }
    return value;
  }, 2);
  return json.length > 12000 ? `${json.slice(0, 12000)}\n...（已截断，完整内容请查后端事件日志）` : json;
}

function nextActionLabel(value: string) {
  const labels: Record<string, string> = {
    confirm_patch: "等待你确认局部修改",
    review_prd: "等待你确认 PRD",
    review_prototype: "等待你确认原型",
    review_qa: "等待你查看 QA",
    ask_clarification: "等待你补充信息",
    download_export: "导出文件可下载",
    answer: "普通问答已回复",
  };
  return labels[value] ?? (value || "完成");
}

function timelineItem(
  id: string,
  step: string | undefined,
  status: VibeRunTimelineItem["status"],
  text: string,
): VibeRunTimelineItem {
  return {
    id,
    step,
    status,
    text: normalizeTimelineText(text),
  };
}

function safeEventText(
  event: VibeStreamEvent,
  payloadMeta: VibeStreamPayloadMeta | undefined,
  fallback: string,
) {
  const text = event.content || payloadMeta?.summary || fallback;
  if (!text) return fallback;
  return looksLikeStructuredData(text) ? fallback : normalizeTimelineText(text);
}

function looksLikeStructuredData(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("<")) return true;
  return /"[^"]+"\s*:/.test(trimmed) || /```(?:json|ts|tsx|js|jsx)?/i.test(trimmed);
}

function normalizeTimelineText(text: string) {
  return toChineseProcessText(text).replace(/\s+/g, " ").trim();
}

function toChineseProcessText(text: string) {
  return text
    .replace(/ProductDesignState/g, "产品状态")
    .replace(/ProductBuildPlan/g, "产品方案")
    .replace(/PrototypeSpec/g, "原型结构")
    .replace(/PatchPlan/g, "局部修改方案")
    .replace(/Patch/g, "局部修改")
    .replace(/PRD/g, "PRD")
    .replace(/HTML/g, "HTML")
    .replace(/QA/g, "QA")
    .replace(/fallback/gi, "规则兜底")
    .replace(/run/gi, "任务")
    .replace(/agent/gi, "智能体");
}

function stepStartedText(step: string, title?: string) {
  const labels: Record<string, string> = {
    intent_detection: "执行思路：先判断这是新需求、继续生成、导出、问答还是局部修改；如果带选区，会优先识别选区意图。",
    knowledge_retrieval: "执行思路：按意图检索强规则、默认规则、案例和可用 skills，后续生成必须参考这些依据。",
    context_fetch: "执行思路：只读取项目状态、历史消息、PRD、原型、选区和附件，不做业务判断。",
    requirement_analysis: "执行思路：把用户明确事实、知识库事实和 AI 假设分开，检查是否缺少必须澄清的信息。",
    requirement_packaging: "执行思路：把用户事实、知识事实、上下文事实、AI 假设、冲突和 trace refs 合成同一份需求包。",
    product_planning: "执行思路：消费同一份需求包，把它拆成页面、功能、状态、范围和风险，决定本轮要生成或修改什么。",
    requirement_validation: "执行思路：检查需求包、计划、选区和版本条件是否完整一致，决定能否进入生成。",
    safety_check: "执行思路：检查提示注入、密钥泄漏、隐私、越权、真实外部动作和强规则冲突。",
    product_design: "执行思路：把方案写入产品状态，后续 PRD 和原型都从这个唯一事实源派生。",
    prd_generation: "执行思路：只根据产品状态渲染 PRD，不临时编造状态里没有的业务规则。",
    prototype_design: "执行思路：把产品状态转成页面、组件、导航和交互结构，还不生成 HTML。",
    prototype_code_generation: "执行思路：根据原型结构生成可预览 HTML，保持单文件、无真实接口调用。",
    patch_planning: "执行思路：先判断局部修改会影响哪些状态路径，再生成需要你确认的修改候选。",
    qa_check: "执行思路：检查产品状态、PRD、原型和规则是否一致，只报告问题，不直接改产物。",
    knowledge_extraction: "执行思路：只从稳定产物中抽取可复用知识候选，不直接写入正式知识库。",
  };
  return labels[step] ?? `开始执行：${title ?? step}。`;
}

function stepThinkingText(step: string) {
  const labels: Record<string, string> = {
    intent_detection: "识别用户动作、目标产物、是否依赖选区，以及是否应该进入生成链路。",
    knowledge_retrieval: "查找会约束本轮输出的知识、规则、案例和技能路由。",
    context_fetch: "读取产品状态、最近对话、附件摘要、选区和已有 PRD/原型，不在这里做业务判断。",
    requirement_analysis: "区分已确认事实、系统上下文、假设、冲突和缺失项。",
    requirement_packaging: "生成 Planner、Validator、Safety Check 共同消费的 RequirementPackage。",
    product_planning: "基于 RequirementPackage 规划范围、页面、状态覆盖、下游执行顺序、QA 关注点和风险。",
    requirement_validation: "校验需求包和计划是否具备进入状态写入、PRD、原型或局部修改的条件。",
    safety_check: "识别不能进入生成的安全风险，并给出可继续的安全替代方向。",
    product_design: "把计划落到产品状态，保留 assumptions、knowledgeRefs、pendingQuestions 和 sourcePaths。",
    prd_generation: "从产品状态渲染结构化 PRD，避免写接口、SQL、数据库或实现细节。",
    prototype_design: "从产品状态设计原型结构，定义页面、组件、状态和交互。",
    prototype_code_generation: "从原型结构生成 HTML，避免远程脚本、真实接口和生产承诺。",
    patch_planning: "把选区修改转成作用于产品状态的 patch plan，并标出影响范围。",
    qa_check: "检查 state/prd/prototype/html/knowledge 的一致性和阻断风险。",
    knowledge_extraction: "从确认后的稳定内容里提炼候选知识，等待审核。",
  };
  return labels[step] ?? "记录该节点的输入、输出和下一步分支。";
}

function stepCompletedText(step: string, title: string | undefined, payload: Record<string, unknown> | null) {
  if (step === "knowledge_retrieval") {
    const count = [
      readArrayLength(payload?.strongRules),
      readArrayLength(payload?.defaultRules),
      readArrayLength(payload?.referenceCases),
      readArrayLength(payload?.designPatterns),
      readArrayLength(payload?.prdWritingRules),
      readArrayLength(payload?.prototypeRules),
      readArrayLength(payload?.businessConcepts),
    ].reduce((sum, value) => sum + value, 0);
    return count ? `知识检索完成，命中 ${count} 条可参考规则和案例。` : "知识检索完成，没有发现必须引用的规则。";
  }
  const labels: Record<string, string> = {
    intent_detection: "意图识别完成，已确定本轮执行方向。",
    context_fetch: "项目上下文读取完成，后续节点会复用同一份上下文。",
    requirement_analysis: "需求分析完成，已整理出可继续处理的需求包。",
    requirement_packaging: "需求包整理完成，Planner、Validator 和 Safety Check 会消费同一份输入。",
    product_planning: "方案规划完成，已确定本轮要生成或修改的范围。",
    requirement_validation: "生成前结构校验完成。",
    safety_check: "生成前安全检查完成。",
    product_design: "产品状态已生成，后续文档和原型会从这里派生。",
    prd_generation: "PRD 生成完成。",
    prototype_design: "原型结构设计完成。",
    prototype_code_generation: "HTML 原型生成完成。",
    patch_planning: "局部修改方案生成完成。",
    qa_check: "QA 检查完成。",
    knowledge_extraction: "知识候选抽取完成。",
  };
  return labels[step] ?? `${title ?? "这一步"}完成。`;
}

function stepLabel(step: string) {
  return VIBE_RUN_STEPS.find((item) => item.step === step)?.title ?? step;
}

function readArrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function asQaGateStatus(value: unknown): "open" | "warning" | "blocked" | undefined {
  return value === "open" || value === "warning" || value === "blocked" ? value : undefined;
}

function qaGateSummary(gate: Record<string, unknown> | null | undefined) {
  if (!gate) return undefined;
  const status = asQaGateStatus(gate.status);
  const parts = [
    status === "blocked" ? "阻止确认/导出，需回到 Patch" : status === "warning" ? "可确认，需复核风险" : "通过",
    gate.allowPersistKnowledge === false ? "暂不沉淀知识" : "可沉淀知识",
    gate.allowExportOrPublish === false ? "禁止导出/发布" : "可导出/发布",
  ];
  return parts.join("；");
}

function normalizeClarificationQuestions(value: unknown): VibeClarificationQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item) ?? {};
      const title = asText(record.title) || asText(record.question) || `请确认问题 ${index + 1}`;
      const question = asText(record.question) || title;
      const options = Array.isArray(record.options)
        ? record.options.map((option) => String(option ?? "").trim()).filter(Boolean)
        : [];
      const status: VibeClarificationQuestion["status"] =
        record.status === "answered" || record.status === "skipped" ? record.status : "pending";
      return {
        id: asText(record.id) || `clarify_${index + 1}`,
        title,
        question,
        reason: asText(record.reason) || "该问题会影响 PRD 和原型范围。",
        options,
        recommendedOption: asText(record.recommendedOption),
        recommendation: asText(record.recommendation),
        required: Boolean(record.required),
        status,
      };
    })
    .filter((item) => item.title);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function payloadRecord(event: VibeStreamEvent) {
  return asRecord(event.payload) ?? asRecord(event.data);
}

function payloadMetaRecord(event: VibeStreamEvent) {
  return event.payloadMeta?.schema === "vibe.stream.payload.v1" ? event.payloadMeta : undefined;
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberFromRecord(record: Record<string, number> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
