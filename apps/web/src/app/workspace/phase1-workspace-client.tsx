"use client";

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
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
import { UserMenu } from "@/components/user-menu";
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

type ApplySystemMutationResponse = {
  status: string;
  proposalId: string;
  graph?: NonNullable<Phase2DecisionView["executionPlan"]>;
  mutations?: NonNullable<Phase2DecisionView["selfGeneration"]>["proposal"]["mutations"];
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
  const [newProjectTitle, setNewProjectTitle] = useState("");
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

  const selectedProject = useMemo(
    () => projectsQuery.data?.items.find((project) => project.id === selectedProjectId) ?? null,
    [projectsQuery.data?.items, selectedProjectId],
  );

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

  const createProject = useMutation({
    mutationFn: (title: string) =>
      apiRequest<{ project: Phase1Project; defaultConversation: { id: string } }>("/projects", {
        method: "POST",
        body: JSON.stringify({ title }),
      }),
    onSuccess: async (response) => {
      setNewProjectTitle("");
      setSelectedProject(response.project.id, response.defaultConversation.id);
      await queryClient.invalidateQueries({ queryKey: ["phase1-projects"] });
    },
  });

  const sendMessage = useMutation({
    mutationFn: (content: string) =>
      apiRequest<MessageResponse>("/messages", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          conversationId: selectedConversationId,
          content,
        }),
    }),
    onSuccess: async (response) => {
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
        queryClient.invalidateQueries({ queryKey: ["phase1-messages", selectedConversationId] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-project", selectedProjectId] }),
        queryClient.invalidateQueries({ queryKey: ["phase1-projects"] }),
      ]);
    },
  });

  const applySystemMutation = useMutation({
    mutationFn: (proposalId: string) =>
      apiRequest<ApplySystemMutationResponse>("/system/mutation/apply", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          proposalId,
          confirm: true,
        }),
      }),
    onSuccess: async (response) => {
      const current = usePhase1Workspace.getState().decision;
      if (current?.selfGeneration && response.graph) {
        setDecision({
          ...current,
          selfGeneration: {
            ...current.selfGeneration,
            applied: {
              status: response.status,
              graph: response.graph,
              mutations: response.mutations,
            },
            proposal: {
              ...current.selfGeneration.proposal,
              status: response.status === "applied" ? "applied" : current.selfGeneration.proposal.status,
            },
            executionPlan: response.graph,
          },
          executionPlan: response.graph,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["phase1-project", selectedProjectId] });
    },
  });

  return (
    <main className="flex h-screen min-h-0 flex-col bg-[#F6F7F9]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        <div>
          <div className="text-sm font-semibold text-gray-950">智能产品工作台</div>
          <div className="text-xs text-gray-500">三系统融合智能产品操作系统</div>
        </div>
        <UserMenu />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_440px] overflow-hidden">
        <ProjectList
          projects={projectsQuery.data?.items ?? []}
          selectedProjectId={selectedProjectId}
          newProjectTitle={newProjectTitle}
          loading={projectsQuery.isLoading}
          creating={createProject.isPending}
          onNewProjectTitleChange={setNewProjectTitle}
          onCreateProject={() => createProject.mutate(newProjectTitle.trim() || "未命名三系统项目")}
          onSelectProject={(project) =>
            setSelectedProject(project.id, project.currentConversationId ?? project.defaultConversationId ?? "")
          }
        />
        <ChatPanel
          messages={messagesQuery.data?.items ?? []}
          disabled={!selectedProject || !selectedConversationId}
          sending={sendMessage.isPending}
          onSend={async (content) => {
            await sendMessage.mutateAsync(content);
          }}
        />
        <PreviewPanel
          decision={decision}
          prdPreview={prdPreview}
          prototypePreview={prototypePreview}
          applyingProposal={applySystemMutation.isPending}
          onApplyProposal={(proposalId) => applySystemMutation.mutate(proposalId)}
        />
      </div>
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
