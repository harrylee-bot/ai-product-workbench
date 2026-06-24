"use client";

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { create } from "zustand";
import { ChatPanel, type Phase1Message, type VibeRunStepStatus, type VibeRunView } from "@/components/chat-panel";
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
    const controller = new AbortController();
    runStreamAbortRef.current = controller;
    setActiveRunId(runId);
    setRunState(createInitialRunState(runId));

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
      if (controller.signal.aborted) return;
      setActiveRunId(null);
      window.alert(error instanceof Error ? error.message : "运行流连接失败");
    });
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
            componentId: input.selectionId,
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
  { step: "requirement_analysis", title: "分析需求", agent: "Requirement Analyst", detail: "判断需求完整度、缺口、冲突和澄清问题" },
  { step: "product_planning", title: "规划方案", agent: "Product Planner", detail: "正式需求唯一 plan agent，生成 ProductBuildPlan 和下游 agent 顺序" },
  { step: "product_design", title: "生成产品状态", agent: "Product Designer", detail: "把计划落到 ProductDesignState 唯一事实源" },
  { step: "prd_generation", title: "生成 PRD", agent: "PRD Writer", detail: "只基于 ProductDesignState 输出结构化 PRD" },
  { step: "prototype_design", title: "设计原型结构", agent: "Prototype Designer", detail: "只基于 ProductDesignState 输出 PrototypeSpec" },
  { step: "prototype_code_generation", title: "生成 HTML", agent: "Prototype Code", detail: "只基于 PrototypeSpec 输出单文件 HTML 原型" },
  { step: "patch_planning", title: "规划局部修改", agent: "Patch Agent", detail: "输出只作用于 ProductDesignState 的 PatchPlan" },
  { step: "qa_check", title: "QA 闸门", agent: "QA Agent", detail: "检查一致性并决定确认、知识、发布和导出闸门" },
  { step: "knowledge_extraction", title: "抽取知识候选", agent: "Knowledge Extractor", detail: "从稳定产物中沉淀待审核知识候选" },
];

function createInitialRunState(runId: string): VibeRunView {
  return {
    runId,
    status: "running",
    currentLabel: "正在连接 Vibe Coding 主链路...",
    steps: VIBE_RUN_STEPS.map((step) => ({ ...step, status: "pending" })),
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

  return next;
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
