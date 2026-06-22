"use client";

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { ChatPanel, type Phase1Message } from "@/components/chat-panel";
import {
  PreviewPanel,
  type Phase1PrdPreview,
  type Phase1PrototypePreview,
  type Phase2DecisionView,
} from "@/components/preview-panel";
import { ProjectList, type Phase1Project } from "@/components/project-list";
import { ProtectedRoute } from "@/components/protected-route";
import { apiRequest } from "@/lib/api";

type ProjectsResponse = {
  items: Phase1Project[];
};

type ProjectDetailResponse = {
  project: Phase1Project;
  conversations: Array<{ id: string; projectId: string; title: string }>;
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
  constraintContext?: Phase2DecisionView["constraintContext"];
  agentInput?: Phase2DecisionView["agentInput"];
  prdPreview?: Phase1PrdPreview;
  prototypePreview?: Phase1PrototypePreview;
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
    const conversationId = detail.project.currentConversationId ?? detail.conversations[0]?.id ?? "";
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

  return (
    <main
      className="grid h-screen min-h-0 overflow-hidden bg-[#F6F7F9]"
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? "72px minmax(420px, 1fr) minmax(560px, 48vw)"
          : "300px minmax(420px, 1fr) minmax(560px, 48vw)",
      }}
    >
      <ProjectList
        projects={projectsQuery.data?.items ?? []}
        selectedProjectId={selectedProjectId}
        loading={projectsQuery.isLoading}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        onSelectProject={(project) =>
          setSelectedProject(project.id, project.currentConversationId ?? project.defaultConversationId ?? "")
        }
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
      <PreviewPanel
        prdPreview={prdPreview}
        prototypePreview={prototypePreview}
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
