"use client";

import clsx from "clsx";
import {
  AlertCircle,
  Archive,
  Camera,
  Check,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  ClipboardCheck,
  Code2,
  Crosshair,
  Edit3,
  FileUp,
  FileText,
  ImagePlus,
  Loader2,
  MessageSquare,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Send,
  ScreenShare,
  Smartphone,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/modal";
import { ProtectedRoute } from "@/components/protected-route";
import { Button, FieldLabel, TextInput } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";
import { apiRequest, toQueryString } from "@/lib/api";

type ProjectStatus =
  | "draft"
  | "clarifying"
  | "designing"
  | "generating"
  | "waiting"
  | "prd_ready"
  | "prototype_ready"
  | "qa_failed"
  | "done"
  | "completed"
  | "archived"
  | "deleted";

type MessageRole = "user" | "assistant";
type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";
type PreviewTab = "prd" | "prototype" | "qa";
type PreviewState = "empty" | "generating" | "ready" | "error";
type QaStatus = "unchecked" | "checking" | "passed" | "issues" | "failed";
type DeviceMode = "desktop" | "mobile";

type SelectedRegion =
  | {
      type: "document";
      sectionId: string;
      targetId: string;
      label: string;
    }
  | {
      type: "prototype";
      pageId: string;
      componentId?: string;
      domSelector?: string;
      label?: string;
    };

type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  time: string;
  selectedRegion?: SelectedRegion | null;
};

type ClarificationQuestion = {
  id: string;
  title: string;
  options: string[];
};

type AgentStep = {
  key: string;
  name: string;
  description: string;
  status: StepStatus;
};

type PrdSection = {
  id: string;
  title: string;
  paragraphs: string[];
};

type QaIssue = {
  id: string;
  level: "error" | "warning" | "info";
  type: string;
  description: string;
  suggestion: string;
};

type WorkspaceProject = {
  id: string;
  conversationId?: string;
  title: string;
  summary: string;
  updatedAt: string;
  status: ProjectStatus;
  messages: ChatMessage[];
  clarificationQuestions?: ClarificationQuestion[];
  prdState: PreviewState;
  prdSections: PrdSection[];
  prototypeState: PreviewState;
  prototypeHtml: string;
  qaStatus: QaStatus;
  qaIssues: QaIssue[];
};

type ApiProject = {
  id: string;
  title: string;
  description?: string;
  status: ProjectStatus;
  currentConversationId?: string;
  lastActivityAt: string;
  latestMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
};

type ApiConversation = {
  id: string;
  projectId: string;
  title: string;
  summary?: string;
  messageCount: number;
  lastMessageAt?: string;
  status: "active" | "archived" | "deleted";
  createdAt: string;
  updatedAt: string;
};

type ApiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  type: string;
  content: string;
  metadata?: unknown;
  createdAt: string;
};

type ListProjectsResponse = {
  items: ApiProject[];
  total: number;
  page: number;
  pageSize: number;
};

type CreateProjectResponse = {
  project: ApiProject;
  defaultConversation: ApiConversation;
};

type GetProjectResponse = {
  project: ApiProject;
  conversations: ApiConversation[];
};

type ListMessagesResponse = {
  items: ApiMessage[];
  hasMore: boolean;
};

type HandleMessageResponse = {
  projectId: string;
  conversationId: string;
  userMessage: ApiMessage;
  assistantMessage: ApiMessage;
  runId: string | null;
};

const STATUS_META: Record<ProjectStatus, { label: string; className: string }> = {
  draft: {
    label: "草稿",
    className: "border-gray-200 bg-white text-gray-600",
  },
  clarifying: {
    label: "等待确认",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  designing: {
    label: "生成中",
    className: "border-sky-200 bg-sky-50 text-sky-700",
  },
  generating: {
    label: "生成中",
    className: "border-sky-200 bg-sky-50 text-sky-700",
  },
  waiting: {
    label: "等待确认",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  prd_ready: {
    label: "PRD 已生成",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  prototype_ready: {
    label: "原型已生成",
    className: "border-cyan-200 bg-cyan-50 text-cyan-700",
  },
  qa_failed: {
    label: "QA 未通过",
    className: "border-rose-200 bg-rose-50 text-rose-700",
  },
  done: {
    label: "已完成",
    className: "border-green-200 bg-green-50 text-green-700",
  },
  completed: {
    label: "已完成",
    className: "border-green-200 bg-green-50 text-green-700",
  },
  archived: {
    label: "已归档",
    className: "border-gray-200 bg-gray-100 text-gray-600",
  },
  deleted: {
    label: "已删除",
    className: "border-rose-200 bg-rose-50 text-rose-700",
  },
};

const AGENT_TEMPLATE: AgentStep[] = [
  { key: "intent", name: "Intent Agent", description: "正在理解你的需求", status: "pending" },
  { key: "knowledge", name: "Knowledge Agent", description: "正在检索知识库", status: "pending" },
  {
    key: "analyst",
    name: "Requirement Analyst Agent",
    description: "正在分析需求完整度",
    status: "pending",
  },
  {
    key: "designer",
    name: "Product Designer Agent",
    description: "正在生成产品设计方案",
    status: "pending",
  },
  { key: "prd", name: "PRD Writer Agent", description: "正在生成 PRD", status: "pending" },
  {
    key: "prototypeDesigner",
    name: "Prototype Designer Agent",
    description: "正在生成原型规格",
    status: "pending",
  },
  {
    key: "prototypeCode",
    name: "Prototype Code Agent",
    description: "正在生成 HTML 原型",
    status: "pending",
  },
  { key: "qa", name: "QA Agent", description: "正在校验一致性", status: "pending" },
  { key: "patch", name: "Patch Agent", description: "正在分析局部修改", status: "skipped" },
  {
    key: "knowledgeExtractor",
    name: "Knowledge Extractor Agent",
    description: "正在抽取知识候选",
    status: "skipped",
  },
];

const PROMPTS = [
  "帮我做一个签到活动需求和原型",
  "设计一个会员积分商城后台配置页",
  "把上传的初版需求文档补全成 PRD",
  "根据这个活动页面截图生成可演示原型",
];

const DEFAULT_PRD_SECTIONS: PrdSection[] = [
  {
    id: "background",
    title: "1. 背景与目标",
    paragraphs: [
      "为提升新用户首周活跃和老用户连续访问频次，设计一个签到活动能力，支持运营配置奖励、周期和补签规则。",
      "一期目标是在用户端提供清晰的签到入口、连续签到进度和奖励反馈，并在后台沉淀可复用的活动配置结构。",
    ],
  },
  {
    id: "users",
    title: "2. 用户与场景",
    paragraphs: [
      "目标用户包含普通用户、活动运营和客服支持。普通用户关注签到路径短、奖励可理解；运营关注配置效率和活动效果；客服关注异常补偿与记录追踪。",
    ],
  },
  {
    id: "scope",
    title: "3. 一期范围",
    paragraphs: [
      "包含活动入口、签到日历、奖励领取、连续签到提示、基础异常态、活动规则展示、运营端查看基础数据。",
      "暂不包含复杂人群分层、多活动并行、自动化补偿和高级风控策略。",
    ],
  },
  {
    id: "flow",
    title: "4. 核心流程",
    paragraphs: [
      "用户进入活动页后读取当日签到状态，点击签到后完成奖励发放，页面刷新连续天数和下一档奖励。",
      "当用户已签到、活动未开始、活动已结束或接口异常时，页面展示对应状态和可操作建议。",
    ],
  },
  {
    id: "acceptance",
    title: "5. 验收标准",
    paragraphs: [
      "签到按钮在未签到状态下可点击，成功后 1 秒内反馈结果；已签到状态不可重复提交。",
      "PRD、原型和 QA 报告中的规则文案保持一致，奖励名称、天数和异常态不得相互冲突。",
    ],
  },
];

const DEFAULT_QA_ISSUES: QaIssue[] = [
  {
    id: "qa-1",
    level: "warning",
    type: "PRD 与原型不一致",
    description: "PRD 提到活动规则展示，当前原型只展示了奖励说明，没有完整规则入口。",
    suggestion: "在原型底部补充“活动规则”入口，并与 PRD 第 4 节规则描述保持一致。",
  },
  {
    id: "qa-2",
    level: "info",
    type: "边界状态缺失",
    description: "原型未覆盖活动已结束状态。",
    suggestion: "补充已结束时的按钮禁用态和结果说明，便于研发理解兜底状态。",
  },
];

const SAMPLE_PROTOTYPE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #f4f7f6;
      color: #18201d;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0;
    }
    .page { max-width: 420px; margin: 0 auto; padding: 20px 18px 28px; }
    .hero {
      border-radius: 20px;
      background: linear-gradient(135deg, #12352e, #1e6d5f);
      color: white;
      padding: 24px;
      box-shadow: 0 18px 45px rgba(18, 53, 46, .20);
    }
    .hero small { display: block; opacity: .72; font-size: 13px; }
    h1 { margin: 8px 0 0; font-size: 28px; line-height: 1.18; letter-spacing: 0; }
    .reward {
      margin-top: 18px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .reward div {
      border-radius: 14px;
      background: rgba(255,255,255,.14);
      padding: 12px 10px;
      text-align: center;
      font-size: 12px;
    }
    .reward strong { display: block; font-size: 18px; margin-bottom: 3px; }
    .panel {
      margin-top: 16px;
      border: 1px solid #dfe8e4;
      border-radius: 18px;
      background: white;
      padding: 18px;
    }
    .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-top: 14px; }
    .day {
      aspect-ratio: 1;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: #eef3f1;
      color: #61716b;
      font-size: 13px;
      font-weight: 700;
    }
    .day.done { background: #e4f7ee; color: #148457; }
    .day.today { background: #17221f; color: white; }
    button {
      width: 100%;
      height: 48px;
      border: 0;
      border-radius: 14px;
      background: #17221f;
      color: white;
      font-size: 16px;
      font-weight: 700;
      margin-top: 16px;
      cursor: pointer;
    }
    .rule { color: #5f6f69; font-size: 13px; line-height: 1.65; margin: 12px 0 0; }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <small>连续签到赢奖励</small>
      <h1>今天签到可领取 20 积分</h1>
      <div class="reward">
        <div><strong>3天</strong>加赠券</div>
        <div><strong>7天</strong>翻倍卡</div>
        <div><strong>14天</strong>礼包</div>
      </div>
    </section>
    <section class="panel">
      <strong>本周期进度</strong>
      <div class="days">
        <div class="day done">1</div>
        <div class="day done">2</div>
        <div class="day today">3</div>
        <div class="day">4</div>
        <div class="day">5</div>
        <div class="day">6</div>
        <div class="day">7</div>
      </div>
      <button>立即签到</button>
      <p class="rule">每天 00:00 刷新签到状态，连续签到达到节点奖励后自动发放到用户账户。</p>
    </section>
  </main>
</body>
</html>`;

function createAgentSteps() {
  return AGENT_TEMPLATE.map((step) => ({ ...step }));
}

function getClockTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function formatRelativeTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(Math.floor(diffMs / 60000), 0);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatMessageTime(value?: string) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(Number.isNaN(date.getTime()) ? new Date() : date);
}

function mapProject(project: ApiProject, messages: ChatMessage[] = []): WorkspaceProject {
  const hasGeneratedPreview =
    project.status === "prd_ready" ||
    project.status === "prototype_ready" ||
    project.status === "qa_failed" ||
    project.status === "completed";

  return {
    id: project.id,
    conversationId: project.currentConversationId,
    title: project.title,
    summary: project.latestMessagePreview ?? project.description ?? "新项目，等待输入产品需求",
    updatedAt: formatRelativeTime(project.lastActivityAt),
    status: project.status,
    messages,
    prdState: hasGeneratedPreview ? "ready" : "empty",
    prdSections: hasGeneratedPreview ? DEFAULT_PRD_SECTIONS : [],
    prototypeState:
      project.status === "prototype_ready" ||
      project.status === "qa_failed" ||
      project.status === "completed"
        ? "ready"
        : "empty",
    prototypeHtml:
      project.status === "prototype_ready" ||
      project.status === "qa_failed" ||
      project.status === "completed"
        ? SAMPLE_PROTOTYPE_HTML
        : "",
    qaStatus: project.status === "qa_failed" ? "issues" : "unchecked",
    qaIssues: project.status === "qa_failed" ? DEFAULT_QA_ISSUES : [],
  };
}

function mapMessage(message: ApiMessage): ChatMessage | null {
  if (message.role === "system") return null;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    time: formatMessageTime(message.createdAt),
  };
}

function preservePreviewState(project: WorkspaceProject) {
  return {
    clarificationQuestions: project.clarificationQuestions,
    prdState: project.prdState,
    prdSections: project.prdSections,
    prototypeState: project.prototypeState,
    prototypeHtml: project.prototypeHtml,
    qaStatus: project.qaStatus,
    qaIssues: project.qaIssues,
  };
}

export function WorkspaceClient() {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectEditor, setProjectEditor] = useState<WorkspaceProject | null>(null);
  const [projectTitleDraft, setProjectTitleDraft] = useState("");
  const [projectActionLoading, setProjectActionLoading] = useState<"save" | "archive" | "delete" | null>(null);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [projectListLoading, setProjectListLoading] = useState(true);
  const [projectListError, setProjectListError] = useState<string | null>(null);
  const [projectDetailLoading, setProjectDetailLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("prd");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [localEditEnabled, setLocalEditEnabled] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<SelectedRegion | null>(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>(createAgentSteps);
  const [isRunning, setIsRunning] = useState(false);
  const timersRef = useRef<number[]>([]);

  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId) ?? null,
    [currentProjectId, projects],
  );

  const filteredProjects = useMemo(() => {
    const keyword = projectSearch.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter(
      (project) =>
        project.title.toLowerCase().includes(keyword) ||
        project.summary.toLowerCase().includes(keyword),
    );
  }, [projectSearch, projects]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const loadProjects = async (preferredProjectId = currentProjectId) => {
    setProjectListLoading(true);
    setProjectListError(null);
    try {
      const response = await apiRequest<ListProjectsResponse>(
        `/projects${toQueryString({ page: 1, pageSize: 50 })}`,
      );
      const mappedProjects = response.items.map((project) => mapProject(project));
      setProjects((previousProjects) =>
        mappedProjects.map((project) => {
          const previous = previousProjects.find((item) => item.id === project.id);
          return previous ? { ...project, ...preservePreviewState(previous), messages: previous.messages } : project;
        }),
      );

      if (mappedProjects.length === 0) {
        setCurrentProjectId("");
        return;
      }

      const nextProjectId =
        mappedProjects.find((project) => project.id === preferredProjectId)?.id ?? mappedProjects[0].id;
      setCurrentProjectId(nextProjectId);
      await loadProjectDetail(nextProjectId);
    } catch (error) {
      setProjectListError(error instanceof Error ? error.message : "项目列表加载失败");
    } finally {
      setProjectListLoading(false);
    }
  };

  const loadProjectDetail = async (projectId: string) => {
    setProjectDetailLoading(true);
    setWorkspaceError(null);
    try {
      const detail = await apiRequest<GetProjectResponse>(`/projects/${projectId}`);
      const conversationId =
        detail.project.currentConversationId ?? detail.conversations.find((item) => item.status === "active")?.id;
      let messages: ChatMessage[] = [];

      if (conversationId) {
        const response = await apiRequest<ListMessagesResponse>(
          `/conversations/${conversationId}/messages${toQueryString({ limit: 50 })}`,
        );
        messages = response.items.map(mapMessage).filter((message): message is ChatMessage => Boolean(message));
      }

      setProjects((items) =>
        items.map((project) =>
          project.id === projectId
            ? {
                ...project,
                ...mapProject(
                  {
                    ...detail.project,
                    currentConversationId: conversationId,
                    latestMessagePreview: messages.at(-1)?.content ?? project.summary,
                  },
                  messages,
                ),
                ...preservePreviewState(project),
              }
            : project,
        ),
      );
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "项目详情加载失败");
    } finally {
      setProjectDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  const clearRunTimers = () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  };

  const schedule = (callback: () => void, delay: number) => {
    const timer = window.setTimeout(callback, delay);
    timersRef.current.push(timer);
  };

  const createProject = async () => {
    const title = newProjectName.trim() || "未命名产品项目";
    setWorkspaceError(null);
    setIsCreatingProject(true);

    try {
      const response = await apiRequest<CreateProjectResponse>("/projects", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      const project = mapProject(
        {
          ...response.project,
          currentConversationId: response.defaultConversation.id,
        },
        [],
      );

      setProjects((items) => [project, ...items]);
      setCurrentProjectId(project.id);
      setNewProjectOpen(false);
      setNewProjectName("");
      setComposerValue("");
      setPreviewTab("prd");
      setSelectedRegion(null);
      setLocalEditEnabled(false);
      setAgentSteps(createAgentSteps());
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "项目创建失败");
    } finally {
      setIsCreatingProject(false);
    }
  };

  const openProjectEditor = (project: WorkspaceProject) => {
    setProjectEditor(project);
    setProjectTitleDraft(project.title);
    setProjectActionError(null);
    setProjectActionLoading(null);
  };

  const closeProjectEditor = () => {
    if (projectActionLoading) return;
    resetProjectEditor();
  };

  const resetProjectEditor = () => {
    setProjectEditor(null);
    setProjectTitleDraft("");
    setProjectActionError(null);
  };

  const saveProjectTitle = async () => {
    if (!projectEditor) return;
    const title = projectTitleDraft.trim();
    if (!title) {
      setProjectActionError("项目名称不能为空");
      return;
    }

    setProjectActionLoading("save");
    setProjectActionError(null);
    try {
      const updated = await apiRequest<ApiProject>(`/projects/${projectEditor.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });

      setProjects((items) =>
        items.map((project) =>
          project.id === projectEditor.id
            ? {
                ...project,
                ...mapProject(
                  {
                    ...updated,
                    latestMessagePreview: project.summary,
                  },
                  project.messages,
                ),
                ...preservePreviewState(project),
              }
            : project,
        ),
      );
      resetProjectEditor();
    } catch (error) {
      setProjectActionError(error instanceof Error ? error.message : "项目更新失败");
    } finally {
      setProjectActionLoading(null);
    }
  };

  const archiveProject = async () => {
    if (!projectEditor) return;
    setProjectActionLoading("archive");
    setProjectActionError(null);
    try {
      await apiRequest<ApiProject>(`/projects/${projectEditor.id}/archive`, { method: "POST" });
      const remainingProjects = projects.filter((project) => project.id !== projectEditor.id);
      setProjects(remainingProjects);
      const nextProjectId =
        currentProjectId === projectEditor.id ? remainingProjects[0]?.id ?? "" : currentProjectId;
      setCurrentProjectId(nextProjectId);
      resetProjectEditor();
      if (nextProjectId) void loadProjectDetail(nextProjectId);
    } catch (error) {
      setProjectActionError(error instanceof Error ? error.message : "项目归档失败");
    } finally {
      setProjectActionLoading(null);
    }
  };

  const deleteProject = async () => {
    if (!projectEditor) return;
    const confirmed = window.confirm(`确认删除“${projectEditor.title}”？项目会被软删除，默认列表中不再展示。`);
    if (!confirmed) return;

    setProjectActionLoading("delete");
    setProjectActionError(null);
    try {
      await apiRequest<{ success: true }>(`/projects/${projectEditor.id}`, { method: "DELETE" });
      const remainingProjects = projects.filter((project) => project.id !== projectEditor.id);
      setProjects(remainingProjects);
      const nextProjectId =
        currentProjectId === projectEditor.id ? remainingProjects[0]?.id ?? "" : currentProjectId;
      setCurrentProjectId(nextProjectId);
      resetProjectEditor();
      if (nextProjectId) void loadProjectDetail(nextProjectId);
    } catch (error) {
      setProjectActionError(error instanceof Error ? error.message : "项目删除失败");
    } finally {
      setProjectActionLoading(null);
    }
  };

  const runMockGeneration = (targetProjectId: string, assistantMessage?: ChatMessage) => {
    clearRunTimers();
    setIsRunning(true);
    setAgentSteps(createAgentSteps());
    setPreviewTab("prd");
    setProjects((items) =>
      items.map((project) =>
        project.id === targetProjectId
          ? {
              ...project,
              status: "generating",
              summary: "AI 正在协作生成 PRD、原型和 QA 报告",
              updatedAt: "刚刚",
              clarificationQuestions: undefined,
              prdState: "generating",
              prototypeState: "empty",
              qaStatus: "unchecked",
              qaIssues: [],
            }
          : project,
      ),
    );

    const activeKeys = [
      "intent",
      "knowledge",
      "analyst",
      "designer",
      "prd",
      "prototypeDesigner",
      "prototypeCode",
      "qa",
    ];

    activeKeys.forEach((key, index) => {
      schedule(() => {
        setAgentSteps((steps) =>
          steps.map((step) => (step.key === key ? { ...step, status: "running" } : step)),
        );

        if (key === "prototypeDesigner") {
          setProjects((items) =>
            items.map((project) =>
              project.id === targetProjectId
                ? {
                    ...project,
                    summary: "正在生成 HTML 原型",
                    prototypeState: "generating",
                  }
                : project,
            ),
          );
          setPreviewTab("prototype");
        }

        if (key === "qa") {
          setProjects((items) =>
            items.map((project) =>
              project.id === targetProjectId
                ? {
                    ...project,
                    summary: "正在校验 PRD 与原型一致性",
                    qaStatus: "checking",
                  }
                : project,
            ),
          );
          setPreviewTab("qa");
        }
      }, 360 + index * 760);

      schedule(() => {
        setAgentSteps((steps) =>
          steps.map((step) => (step.key === key ? { ...step, status: "success" } : step)),
        );

        if (key === "prd") {
          setProjects((items) =>
            items.map((project) =>
              project.id === targetProjectId
                ? {
                    ...project,
                    status: "prd_ready",
                    summary: "PRD 已生成，正在继续生成原型",
                    prdState: "ready",
                    prdSections: DEFAULT_PRD_SECTIONS,
                  }
                : project,
            ),
          );
        }

        if (key === "prototypeCode") {
          setProjects((items) =>
            items.map((project) =>
              project.id === targetProjectId
                ? {
                    ...project,
                    status: "prototype_ready",
                    summary: "HTML 原型已生成，正在校验一致性",
                    prototypeState: "ready",
                    prototypeHtml: SAMPLE_PROTOTYPE_HTML,
                  }
                : project,
            ),
          );
          setPreviewTab("prototype");
        }
      }, 820 + index * 760);
    });

    schedule(() => {
      setProjects((items) =>
        items.map((project) =>
          project.id === targetProjectId
            ? {
                ...project,
                status: "qa_failed",
                summary: "已生成 PRD 与原型，QA 提示 2 个待修正点",
                updatedAt: "刚刚",
                qaStatus: "issues",
                qaIssues: DEFAULT_QA_ISSUES,
                messages: assistantMessage
                  ? project.messages.some((message) => message.id === assistantMessage.id)
                    ? project.messages
                    : [...project.messages, assistantMessage]
                  : project.messages,
              }
            : project,
        ),
      );
      setPreviewTab("qa");
      setIsRunning(false);
    }, 7600);
  };

  const sendMessage = async () => {
    const message = composerValue.trim();
    if (!message || isRunning) return;
    if (!currentProject) {
      setWorkspaceError("请先新建项目，再发送产品需求");
      return;
    }

    let targetConversationId = currentProject.conversationId;
    setWorkspaceError(null);

    if (!targetConversationId) {
      try {
        const conversation = await apiRequest<ApiConversation>(
          `/projects/${currentProject.id}/conversations/default`,
          { method: "POST" },
        );
        targetConversationId = conversation.id;
        setProjects((items) =>
          items.map((project) =>
            project.id === currentProject.id
              ? { ...project, conversationId: conversation.id }
              : project,
          ),
        );
      } catch (error) {
        setWorkspaceError(error instanceof Error ? error.message : "默认会话创建失败");
        return;
      }
    }

    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: message,
      time: getClockTime(),
      selectedRegion,
    };

    setProjects((items) =>
      items.map((project) =>
        project.id === currentProject.id
          ? {
              ...project,
              summary: selectedRegion
                ? `正在根据“${selectedRegion.label ?? "选中区域"}”生成局部修改`
                : "正在生成产品设计方案",
              updatedAt: "刚刚",
              status: "generating",
              messages: [...project.messages, userMessage],
            }
          : project,
      ),
    );

    setComposerValue("");
    setSelectedRegion(null);
    setLocalEditEnabled(false);

    try {
      const response = await apiRequest<HandleMessageResponse>("/ai/vibe/handle-message", {
        method: "POST",
        body: JSON.stringify({
          projectId: currentProject.id,
          conversationId: targetConversationId,
          message,
          selectedRegion,
          previewMode: previewTab,
        }),
      });
      const savedUserMessage = mapMessage(response.userMessage);
      const savedAssistantMessage = mapMessage(response.assistantMessage);

      if (savedUserMessage) {
        setProjects((items) =>
          items.map((project) =>
            project.id === currentProject.id
              ? {
                  ...project,
                  conversationId: response.conversationId,
                  messages: project.messages.map((item) =>
                    item.id === userMessage.id ? { ...savedUserMessage, selectedRegion } : item,
                  ),
                }
              : project,
          ),
        );
      }

      runMockGeneration(currentProject.id, savedAssistantMessage ?? undefined);
      void loadProjects(currentProject.id);
    } catch (error) {
      setIsRunning(false);
      setWorkspaceError(error instanceof Error ? error.message : "消息发送失败");
    }
  };

  const replyWithClarification = (answer: string) => {
    setComposerValue(answer);
  };

  const selectPrdSection = (section: PrdSection) => {
    setSelectedRegion({
      type: "document",
      sectionId: section.id,
      targetId: `${section.id}-body`,
      label: section.title,
    });
    setComposerValue((value) => value || `请修改「${section.title}」：`);
  };

  const selectPrototypeRegion = () => {
    if (!localEditEnabled) return;
    setSelectedRegion({
      type: "prototype",
      pageId: "signin-activity-home",
      componentId: "signin-calendar",
      domSelector: ".panel",
      label: "签到活动页 / 本周期进度区域",
    });
    setComposerValue((value) => value || "请把选中区域调整为：");
  };

  const selectProject = (projectId: string) => {
    setCurrentProjectId(projectId);
    setSelectedRegion(null);
    setLocalEditEnabled(false);
    setComposerValue("");
    setAgentSteps(createAgentSteps());
    setIsRunning(false);
    clearRunTimers();
    void loadProjectDetail(projectId);
  };

  return (
    <ProtectedRoute>
      <main className="grid h-[100dvh] max-h-[100dvh] min-h-0 grid-rows-[56px_minmax(0,1fr)] overflow-hidden bg-slate-50 text-gray-950">
        <WorkspaceTopBar currentProject={currentProject} isRunning={isRunning} />
        <div
          className={clsx(
            "grid h-full min-h-0 overflow-x-auto overflow-y-hidden transition-[grid-template-columns] duration-200",
            sidebarCollapsed
              ? "min-w-[1044px] grid-cols-[64px_minmax(460px,520px)_minmax(520px,1fr)]"
              : "min-w-[1260px] grid-cols-[280px_minmax(460px,520px)_minmax(520px,1fr)]",
          )}
        >
          <WorkspaceSidebar
            collapsed={sidebarCollapsed}
            filteredProjects={filteredProjects}
            currentProjectId={currentProjectId}
            projectSearch={projectSearch}
            projectListLoading={projectListLoading}
            projectListError={projectListError}
            onSearchChange={setProjectSearch}
            onCollapseToggle={() => setSidebarCollapsed((value) => !value)}
            onNewProject={() => setNewProjectOpen(true)}
            onRetryProjects={() => void loadProjects(currentProjectId)}
            onSelectProject={selectProject}
            onEditProject={openProjectEditor}
          />
          <ChatPanel
            project={currentProject}
            composerValue={composerValue}
            isRunning={isRunning}
            projectDetailLoading={projectDetailLoading}
            workspaceError={workspaceError}
            agentSteps={agentSteps}
            selectedRegion={selectedRegion}
            onComposerChange={setComposerValue}
            onPromptClick={setComposerValue}
            onNewProject={() => setNewProjectOpen(true)}
            onSend={sendMessage}
            onClarificationClick={replyWithClarification}
            onClearSelectedRegion={() => setSelectedRegion(null)}
          />
          <PreviewPanel
            project={currentProject}
            previewTab={previewTab}
            deviceMode={deviceMode}
            localEditEnabled={localEditEnabled}
            selectedRegion={selectedRegion}
            isRunning={isRunning}
            onPreviewTabChange={setPreviewTab}
            onDeviceModeChange={setDeviceMode}
            onLocalEditToggle={() => setLocalEditEnabled((value) => !value)}
            onSelectPrdSection={selectPrdSection}
            onSelectPrototypeRegion={selectPrototypeRegion}
            onClearSelectedRegion={() => setSelectedRegion(null)}
          />
        </div>
      </main>
      <NewProjectDialog
        open={newProjectOpen}
        value={newProjectName}
        onChange={setNewProjectName}
        onCreate={createProject}
        creating={isCreatingProject}
        onClose={() => {
          if (isCreatingProject) return;
          setNewProjectOpen(false);
          setNewProjectName("");
        }}
      />
      <ProjectEditorDialog
        project={projectEditor}
        titleDraft={projectTitleDraft}
        loading={projectActionLoading}
        error={projectActionError}
        onTitleChange={setProjectTitleDraft}
        onSave={saveProjectTitle}
        onArchive={archiveProject}
        onDelete={deleteProject}
        onClose={closeProjectEditor}
      />
    </ProtectedRoute>
  );
}

function WorkspaceTopBar({
  currentProject,
  isRunning,
}: {
  currentProject: WorkspaceProject | null;
  isRunning: boolean;
}) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-950 text-white">
          <Wand2 className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-950">
            {currentProject?.title ?? "AI产品工作台（内测）"}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
            <span>{currentProject ? STATUS_META[currentProject.status].label : "未选择项目"}</span>
            <span className="h-1 w-1 rounded-full bg-gray-300" />
            <span className={clsx("inline-flex items-center gap-1", isRunning && "text-sky-700")}>
              {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {isRunning ? "Agent 协作中" : "Agent 空闲"}
            </span>
          </div>
        </div>
      </div>
      <UserMenu />
    </header>
  );
}

function WorkspaceSidebar({
  collapsed,
  filteredProjects,
  currentProjectId,
  projectSearch,
  projectListLoading,
  projectListError,
  onSearchChange,
  onCollapseToggle,
  onNewProject,
  onRetryProjects,
  onSelectProject,
  onEditProject,
}: {
  collapsed: boolean;
  filteredProjects: WorkspaceProject[];
  currentProjectId: string;
  projectSearch: string;
  projectListLoading: boolean;
  projectListError: string | null;
  onSearchChange: (value: string) => void;
  onCollapseToggle: () => void;
  onNewProject: () => void;
  onRetryProjects: () => void;
  onSelectProject: (projectId: string) => void;
  onEditProject: (project: WorkspaceProject) => void;
}) {
  return (
    <aside className="flex min-w-0 flex-col border-r border-gray-200 bg-white">
      <div className={clsx("border-b border-gray-200", collapsed ? "px-2 py-3" : "p-4")}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onNewProject}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gray-950 text-white hover:bg-gray-800"
              aria-label="新建项目"
              title="新建"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onCollapseToggle}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
              aria-label="展开侧栏"
              title="展开"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-950">项目</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onNewProject}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-gray-950 px-3 text-sm font-medium text-white hover:bg-gray-800"
                >
                  <Plus className="h-4 w-4" />
                  新建
                </button>
                <button
                  type="button"
                  onClick={onCollapseToggle}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
                  aria-label="收起侧栏"
                  title="收起"
                >
                  <ChevronsLeft className="h-4 w-4" />
                </button>
              </div>
            </div>
            <label className="mt-3 flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-gray-500 focus-within:border-gray-900 focus-within:bg-white focus-within:ring-2 focus-within:ring-gray-900/10">
              <Search className="h-4 w-4 shrink-0" />
              <input
                value={projectSearch}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="搜索项目"
                className="min-w-0 flex-1 border-0 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
              />
            </label>
          </>
        )}
      </div>

      <div className={clsx("min-h-0 flex-1 overflow-y-auto", collapsed ? "px-2 py-3" : "p-3")}>
        {projectListLoading ? (
          <SidebarNotice
            collapsed={collapsed}
            icon={Loader2}
            title="加载中"
            description="正在同步项目列表"
            iconClassName="animate-spin text-sky-600"
          />
        ) : projectListError ? (
          <SidebarNotice
            collapsed={collapsed}
            icon={AlertCircle}
            title="加载失败"
            description={projectListError}
            actionLabel="重试"
            onAction={onRetryProjects}
          />
        ) : filteredProjects.length === 0 ? (
          <SidebarNotice
            collapsed={collapsed}
            icon={FileText}
            title={projectSearch.trim() ? "没有匹配项目" : "暂无项目"}
            description={projectSearch.trim() ? "换个关键词试试" : "先新建项目，再发送产品需求"}
            actionLabel={projectSearch.trim() ? undefined : "新建项目"}
            onAction={projectSearch.trim() ? undefined : onNewProject}
          />
        ) : (
          <div className="space-y-2">
            {filteredProjects.map((project) => (
              <ProjectListItem
                key={project.id}
                project={project}
                selected={project.id === currentProjectId}
                collapsed={collapsed}
                onClick={() => onSelectProject(project.id)}
                onEdit={() => onEditProject(project)}
              />
            ))}
          </div>
        )}
      </div>

      <div className={clsx("border-t border-gray-200", collapsed ? "px-2 py-3" : "p-4")}>
        {collapsed ? (
          <div className="mx-auto h-8 w-8 rounded-lg border border-dashed border-gray-300 bg-gray-50" />
        ) : (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3 text-xs leading-5 text-gray-500">
            内测阶段会优先保存项目、对话、PRD、原型和 QA 状态，知识沉淀能力将在后续模块开放。
          </div>
        )}
      </div>
    </aside>
  );
}

function SidebarNotice({
  collapsed,
  icon: Icon,
  title,
  description,
  actionLabel,
  iconClassName,
  onAction,
}: {
  collapsed: boolean;
  icon: typeof FileText;
  title: string;
  description: string;
  actionLabel?: string;
  iconClassName?: string;
  onAction?: () => void;
}) {
  if (collapsed) {
    return (
      <div className="flex h-10 items-center justify-center rounded-lg border border-gray-200 bg-gray-50">
        <Icon className={clsx("h-4 w-4 text-gray-400", iconClassName)} />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-4 text-center">
      <Icon className={clsx("mx-auto h-5 w-5 text-gray-400", iconClassName)} />
      <div className="mt-2 text-sm font-medium text-gray-900">{title}</div>
      <div className="mt-1 text-xs leading-5 text-gray-500">{description}</div>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 inline-flex h-8 items-center justify-center rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function ProjectListItem({
  project,
  selected,
  collapsed,
  onClick,
  onEdit,
}: {
  project: WorkspaceProject;
  selected: boolean;
  collapsed: boolean;
  onClick: () => void;
  onEdit: () => void;
}) {
  const status = STATUS_META[project.status];

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={project.title}
        className={clsx(
          "flex h-10 w-full items-center justify-center rounded-lg border text-gray-700 hover:bg-gray-50",
          selected ? "border-gray-950 bg-gray-950 text-white" : "border-transparent bg-white",
        )}
      >
        <FileText className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div
      className={clsx(
        "w-full rounded-lg border bg-white p-3 text-left transition hover:bg-gray-50",
        selected ? "border-gray-950 bg-gray-50" : "border-gray-200",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-semibold text-gray-950">{project.title}</div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{project.summary}</div>
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-900"
          aria-label="编辑项目"
          title="编辑项目"
        >
          <Edit3 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={clsx("inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium", status.className)}>
          {status.label}
        </span>
        <span className="text-xs text-gray-400">{project.updatedAt}</span>
      </div>
    </div>
  );
}

function ChatPanel({
  project,
  composerValue,
  isRunning,
  projectDetailLoading,
  workspaceError,
  agentSteps,
  selectedRegion,
  onComposerChange,
  onPromptClick,
  onNewProject,
  onSend,
  onClarificationClick,
  onClearSelectedRegion,
}: {
  project: WorkspaceProject | null;
  composerValue: string;
  isRunning: boolean;
  projectDetailLoading: boolean;
  workspaceError: string | null;
  agentSteps: AgentStep[];
  selectedRegion: SelectedRegion | null;
  onComposerChange: (value: string) => void;
  onPromptClick: (value: string) => void;
  onNewProject: () => void;
  onSend: () => void;
  onClarificationClick: (value: string) => void;
  onClearSelectedRegion: () => void;
}) {
  const messages = project?.messages ?? [];
  const showWelcome = messages.length === 0;
  const showEmptyWorkspace = !project;

  return (
    <section className="relative grid h-full min-h-0 min-w-0 grid-rows-[48px_minmax(0,1fr)] overflow-hidden border-r border-gray-200 bg-slate-50">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
          <MessageSquare className="h-4 w-4" />
          需求对话
        </div>
        <span className="text-xs text-gray-500">{isRunning ? "生成中..." : "可继续输入"}</span>
      </div>

      <div className="min-h-0 overflow-y-auto px-4 pb-[116px] pt-4">
        {workspaceError ? (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700">
            {workspaceError}
          </div>
        ) : null}
        {projectDetailLoading ? (
          <div className="flex min-h-full items-center justify-center py-10 text-sm text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-sky-600" />
            正在加载会话消息...
          </div>
        ) : showEmptyWorkspace ? (
          <EmptyWorkspaceState onNewProject={onNewProject} onPromptClick={onPromptClick} />
        ) : showWelcome ? (
          <WelcomeState onPromptClick={onPromptClick} />
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {project?.clarificationQuestions?.length ? (
              <ClarificationCard
                questions={project.clarificationQuestions}
                onSelectOption={onClarificationClick}
              />
            ) : null}
            {(isRunning || agentSteps.some((step) => step.status !== "pending" && step.status !== "skipped")) ? (
              <AgentTimeline steps={agentSteps} />
            ) : null}
          </div>
        )}
      </div>

      <ChatComposer
        value={composerValue}
        disabled={isRunning || projectDetailLoading}
        selectedRegion={selectedRegion}
        onChange={onComposerChange}
        onSend={onSend}
        onClearSelectedRegion={onClearSelectedRegion}
      />
    </section>
  );
}

function WelcomeState({ onPromptClick }: { onPromptClick: (value: string) => void }) {
  return (
    <div className="flex min-h-full flex-col justify-center py-10">
      <div className="mx-auto w-full max-w-[420px] text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white text-gray-950 shadow-sm ring-1 ring-gray-200">
          <Sparkles className="h-5 w-5" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold leading-tight text-gray-950">你想设计什么产品需求？</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500">
          输入一句需求，AI 会通过多 Agent 协作生成 PRD 和可预览 HTML 原型。
        </p>
        <div className="mt-6 grid gap-2">
          {PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPromptClick(prompt)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-3 text-left text-sm text-gray-700 shadow-sm hover:border-gray-300 hover:bg-gray-50"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyWorkspaceState({
  onNewProject,
  onPromptClick,
}: {
  onNewProject: () => void;
  onPromptClick: (value: string) => void;
}) {
  return (
    <div className="flex min-h-full flex-col justify-center py-10">
      <div className="mx-auto w-full max-w-[420px] text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-white text-gray-950 shadow-sm ring-1 ring-gray-200">
          <Plus className="h-5 w-5" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold leading-tight text-gray-950">先新建一个产品项目</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500">
          一期每次产品设计都归属于一个项目。新建项目后，再在底部输入需求。
        </p>
        <button
          type="button"
          onClick={onNewProject}
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-lg bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800"
        >
          <Plus className="h-4 w-4" />
          新建项目
        </button>
        <div className="mt-6 grid gap-2">
          {PROMPTS.slice(0, 2).map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPromptClick(prompt)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-3 text-left text-sm text-gray-700 shadow-sm hover:border-gray-300 hover:bg-gray-50"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={clsx("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[86%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm",
          isUser
            ? "bg-gray-950 text-white"
            : "border border-gray-200 bg-white text-gray-700",
        )}
      >
        {message.selectedRegion ? (
          <div
            className={clsx(
              "mb-2 rounded-md px-2 py-1 text-xs",
              isUser ? "bg-white/10 text-gray-200" : "bg-sky-50 text-sky-700",
            )}
          >
            局部修改：{message.selectedRegion.label ?? "选中区域"}
          </div>
        ) : null}
        <div>{message.content}</div>
        <div className={clsx("mt-2 text-xs", isUser ? "text-gray-300" : "text-gray-400")}>{message.time}</div>
      </div>
    </div>
  );
}

function ClarificationCard({
  questions,
  onSelectOption,
}: {
  questions: ClarificationQuestion[];
  onSelectOption: (value: string) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <AlertCircle className="h-4 w-4" />
        需要你确认几个关键问题
      </div>
      <div className="mt-3 space-y-3">
        {questions.map((question) => (
          <div key={question.id}>
            <div className="text-sm font-medium text-gray-900">{question.title}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {question.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onSelectOption(option)}
                  className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-gray-700 hover:border-amber-300 hover:bg-amber-100/60"
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentTimeline({ steps }: { steps: AgentStep[] }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
        <Sparkles className="h-4 w-4" />
        Agent 协作时间线
      </div>
      <div className="mt-4 space-y-3">
        {steps.map((step) => (
          <div key={step.key} className="flex gap-3">
            <StepIcon status={step.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-sm font-medium text-gray-900">{step.name}</div>
                <span className="text-xs text-gray-400">{step.status}</span>
              </div>
              <div className="mt-0.5 text-xs leading-5 text-gray-500">{step.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "running") return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-600" />;
  if (status === "success") return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === "failed") return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />;
  if (status === "skipped") return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />;
}

function ChatComposer({
  value,
  disabled,
  selectedRegion,
  onChange,
  onSend,
  onClearSelectedRegion,
}: {
  value: string;
  disabled: boolean;
  selectedRegion: SelectedRegion | null;
  onChange: (value: string) => void;
  onSend: () => void;
  onClearSelectedRegion: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, 150);
    textarea.style.height = `${Math.max(nextHeight, 32)}px`;
  }, [value]);

  useEffect(() => {
    if (!toolsOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (toolsRef.current?.contains(event.target as Node)) return;
      setToolsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setToolsOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toolsOpen]);

  const addActions = [
    { label: "上传文件", icon: FileUp },
    { label: "上传图片", icon: ImagePlus },
    { label: "截取屏幕截图", icon: ScreenShare },
    { label: "拍照", icon: Camera },
  ];

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 shrink-0 border-t border-gray-200 bg-slate-50/95 p-3 shadow-[0_-10px_24px_rgba(15,23,42,0.06)] backdrop-blur">
      {selectedRegion ? (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
          <div className="min-w-0 text-xs text-sky-800">
            已选择：{selectedRegion.type === "document" ? "PRD" : "原型"} /{" "}
            <span className="font-medium">{selectedRegion.label ?? "选中区域"}</span>
          </div>
          <button
            type="button"
            onClick={onClearSelectedRegion}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sky-700 hover:bg-sky-100"
            aria-label="取消选中区域"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      <div className="rounded-[16px] border border-gray-200 bg-white px-3 py-2.5 shadow-sm focus-within:border-gray-300 focus-within:ring-2 focus-within:ring-gray-900/10">
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          rows={1}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="描述你的产品想法，例如：帮我做一个签到活动需求和原型"
          className="max-h-[150px] min-h-8 w-full resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-sm leading-6 text-gray-900 outline-none placeholder:text-gray-400 disabled:text-gray-500"
        />
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <div ref={toolsRef} className="relative">
            {toolsOpen ? (
              <div className="absolute bottom-11 left-0 z-30 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl">
                {addActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => setToolsOpen(false)}
                      className="flex h-10 w-full items-center gap-3 px-3 text-left text-sm text-gray-800 hover:bg-gray-50"
                    >
                      <Icon className="h-4 w-4 text-gray-500" />
                      {action.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setToolsOpen((value) => !value)}
              className={clsx(
                "inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900/20",
                toolsOpen && "bg-gray-100 text-gray-950",
              )}
              aria-expanded={toolsOpen}
              aria-haspopup="menu"
              aria-label="添加内容"
              title="添加"
            >
              <Plus className={clsx("h-5 w-5 transition-transform", toolsOpen && "rotate-45")} />
            </button>
          </div>
          <button
            type="button"
            onClick={onSend}
            disabled={!value.trim() || disabled}
            className="inline-flex h-9 items-center gap-2 rounded-[12px] bg-gray-950 px-3.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
          >
            {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {disabled ? "生成中..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewPanel({
  project,
  previewTab,
  deviceMode,
  localEditEnabled,
  selectedRegion,
  isRunning,
  onPreviewTabChange,
  onDeviceModeChange,
  onLocalEditToggle,
  onSelectPrdSection,
  onSelectPrototypeRegion,
  onClearSelectedRegion,
}: {
  project: WorkspaceProject | null;
  previewTab: PreviewTab;
  deviceMode: DeviceMode;
  localEditEnabled: boolean;
  selectedRegion: SelectedRegion | null;
  isRunning: boolean;
  onPreviewTabChange: (tab: PreviewTab) => void;
  onDeviceModeChange: (mode: DeviceMode) => void;
  onLocalEditToggle: () => void;
  onSelectPrdSection: (section: PrdSection) => void;
  onSelectPrototypeRegion: () => void;
  onClearSelectedRegion: () => void;
}) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-slate-100">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        <PreviewTabs activeTab={previewTab} onChange={onPreviewTabChange} />
        <div className="flex items-center gap-2">
          {previewTab === "prototype" ? (
            <>
              <DeviceSwitch value={deviceMode} onChange={onDeviceModeChange} />
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
                aria-label="刷新原型"
                title="刷新"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onLocalEditToggle}
                className={clsx(
                  "inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm font-medium",
                  localEditEnabled
                    ? "bg-sky-600 text-white hover:bg-sky-700"
                    : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                )}
              >
                <Crosshair className="h-4 w-4" />
                局部编辑
              </button>
            </>
          ) : null}
        </div>
      </div>

      {selectedRegion ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-800">
          <span>
            当前选中：{selectedRegion.type === "document" ? "PRD" : "原型"} /{" "}
            <strong>{selectedRegion.label ?? "选中区域"}</strong>
          </span>
          <button
            type="button"
            onClick={onClearSelectedRegion}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-sky-100"
            aria-label="取消选中"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {previewTab === "prd" ? (
        <PrdPreview
          project={project}
          isRunning={isRunning}
          onSelectSection={onSelectPrdSection}
        />
      ) : null}
      {previewTab === "prototype" ? (
        <PrototypePreview
          project={project}
          deviceMode={deviceMode}
          localEditEnabled={localEditEnabled}
          onSelectPrototypeRegion={onSelectPrototypeRegion}
        />
      ) : null}
      {previewTab === "qa" ? <QaReportPanel project={project} /> : null}
    </section>
  );
}

function PreviewTabs({
  activeTab,
  onChange,
}: {
  activeTab: PreviewTab;
  onChange: (tab: PreviewTab) => void;
}) {
  const tabs: Array<{ key: PreviewTab; label: string; icon: typeof FileText }> = [
    { key: "prd", label: "PRD", icon: FileText },
    { key: "prototype", label: "原型", icon: Code2 },
    { key: "qa", label: "QA", icon: ClipboardCheck },
  ];

  return (
    <div className="flex h-9 items-center rounded-lg bg-gray-100 p-1">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={clsx(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
              activeTab === tab.key ? "bg-white text-gray-950 shadow-sm" : "text-gray-500 hover:text-gray-900",
            )}
          >
            <Icon className="h-4 w-4" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function DeviceSwitch({
  value,
  onChange,
}: {
  value: DeviceMode;
  onChange: (mode: DeviceMode) => void;
}) {
  return (
    <div className="flex h-8 items-center rounded-lg bg-gray-100 p-1">
      <button
        type="button"
        onClick={() => onChange("desktop")}
        className={clsx(
          "inline-flex h-6 w-8 items-center justify-center rounded-md",
          value === "desktop" ? "bg-white text-gray-950 shadow-sm" : "text-gray-500",
        )}
        aria-label="桌面预览"
        title="桌面"
      >
        <Monitor className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onChange("mobile")}
        className={clsx(
          "inline-flex h-6 w-8 items-center justify-center rounded-md",
          value === "mobile" ? "bg-white text-gray-950 shadow-sm" : "text-gray-500",
        )}
        aria-label="移动端预览"
        title="移动端"
      >
        <Smartphone className="h-4 w-4" />
      </button>
    </div>
  );
}

function PrdPreview({
  project,
  isRunning,
  onSelectSection,
}: {
  project: WorkspaceProject | null;
  isRunning: boolean;
  onSelectSection: (section: PrdSection) => void;
}) {
  const state = project?.prdState ?? "empty";

  if (state === "empty") {
    return <PreviewEmpty icon={FileText} title="暂无 PRD" description="输入产品需求后，AI 生成的 PRD 会显示在这里。" />;
  }

  if (state === "generating") {
    return <PreviewLoading title="正在生成 PRD..." description="PRD Writer Agent 会先整理目标、范围、流程和验收标准。" />;
  }

  if (state === "error") {
    return <PreviewError title="PRD 生成失败" description="可以在左侧补充需求后重新发送。" />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
      <article className="mx-auto min-h-full max-w-[760px] rounded-lg bg-white px-10 py-9 shadow-sm ring-1 ring-gray-200">
        <div className="border-b border-gray-200 pb-5">
          <div className="text-xs font-medium text-gray-500">产品需求文档</div>
          <h1 className="mt-2 text-2xl font-semibold leading-tight text-gray-950">
            {project?.title ?? "未命名产品项目"}
          </h1>
          <p className="mt-3 text-sm leading-6 text-gray-500">
            该文档由多 Agent 协作生成，当前为一期可评审版本。
          </p>
        </div>
        <div className="mt-6 space-y-7">
          {project?.prdSections.map((section) => (
            <section key={section.id} className="group">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-gray-950">{section.title}</h2>
                <button
                  type="button"
                  onClick={() => onSelectSection(section)}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 text-xs font-medium text-gray-600 opacity-0 transition group-hover:opacity-100 hover:bg-gray-50"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  修改
                </button>
              </div>
              <div className="mt-3 space-y-3 text-sm leading-7 text-gray-700">
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
        {isRunning ? (
          <div className="mt-8 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
            Agent 正在继续生成，PRD 内容可能会实时更新。
          </div>
        ) : null}
      </article>
    </div>
  );
}

function PrototypePreview({
  project,
  deviceMode,
  localEditEnabled,
  onSelectPrototypeRegion,
}: {
  project: WorkspaceProject | null;
  deviceMode: DeviceMode;
  localEditEnabled: boolean;
  onSelectPrototypeRegion: () => void;
}) {
  const state = project?.prototypeState ?? "empty";

  if (state === "empty") {
    return <PreviewEmpty icon={Code2} title="暂无原型" description="AI 生成的 HTML 原型会显示在这里。" />;
  }

  if (state === "generating") {
    return <PreviewLoading title="正在生成 HTML 原型..." description="Prototype Code Agent 正在把原型规格转换成可预览页面。" />;
  }

  if (state === "error") {
    return <PreviewError title="原型生成失败" description="可以回到对话区补充页面结构或重新生成。" />;
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-auto p-6">
      {localEditEnabled ? (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          请选择要修改的区域，然后在左侧输入修改意见
        </div>
      ) : null}
      <div
        className={clsx(
          "mx-auto overflow-hidden rounded-lg border bg-white shadow-sm transition",
          localEditEnabled ? "border-sky-400 ring-2 ring-sky-200" : "border-gray-200",
          deviceMode === "mobile" ? "h-[720px] w-[390px]" : "h-[720px] max-w-[1120px]",
        )}
      >
        <div className="flex h-9 items-center gap-2 border-b border-gray-200 bg-gray-50 px-3">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="ml-2 truncate text-xs text-gray-500">prototype/signin-activity.html</span>
        </div>
        <div className="relative h-[calc(100%-36px)] bg-white">
          <iframe
            title="HTML 原型预览"
            srcDoc={project?.prototypeHtml ?? ""}
            className="h-full w-full border-0"
          />
          {localEditEnabled ? (
            <button
              type="button"
              onClick={onSelectPrototypeRegion}
              className="absolute inset-0 cursor-crosshair bg-sky-500/0 text-left"
              aria-label="选择原型区域"
            >
              <span className="absolute left-1/2 top-1/2 rounded-lg border border-sky-300 bg-white/95 px-3 py-2 text-sm font-medium text-sky-800 shadow-sm">
                点击选择签到进度区域
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function QaReportPanel({ project }: { project: WorkspaceProject | null }) {
  const status = project?.qaStatus ?? "unchecked";
  const issues = project?.qaIssues ?? [];

  if (status === "unchecked") {
    return <PreviewEmpty icon={ClipboardCheck} title="未校验" description="PRD 和原型生成后，QA 结果会显示在这里。" />;
  }

  if (status === "checking") {
    return <PreviewLoading title="校验中..." description="QA Agent 正在检查 PRD、原型和需求输入的一致性。" />;
  }

  if (status === "failed") {
    return <PreviewError title="校验失败" description="可以稍后重新触发 QA 或补充更多上下文。" />;
  }

  const passed = status === "passed";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-[900px] space-y-4">
        <div
          className={clsx(
            "rounded-lg border bg-white p-5 shadow-sm",
            passed ? "border-emerald-200" : "border-rose-200",
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-base font-semibold text-gray-950">
                {passed ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-rose-600" />
                )}
                {passed ? "通过" : "存在问题"}
              </div>
              <p className="mt-2 text-sm leading-6 text-gray-500">
                {passed
                  ? "PRD、原型和需求输入暂未发现明显冲突。"
                  : "QA Agent 发现以下一致性问题，建议修复后再进入评审。"}
              </p>
            </div>
            <span
              className={clsx(
                "inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium",
                passed
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-rose-200 bg-rose-50 text-rose-700",
              )}
            >
              {passed ? "QA 通过" : `${issues.length} 个问题`}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          {issues.map((issue) => (
            <QaIssueItem key={issue.id} issue={issue} />
          ))}
        </div>
      </div>
    </div>
  );
}

function QaIssueItem({ issue }: { issue: QaIssue }) {
  const levelClassName =
    issue.level === "error"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : issue.level === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-sky-200 bg-sky-50 text-sky-700";

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx("inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium", levelClassName)}>
              {issue.level}
            </span>
            <span className="text-sm font-semibold text-gray-950">{issue.type}</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-gray-600">{issue.description}</p>
          <p className="mt-2 text-sm leading-6 text-gray-500">
            <span className="font-medium text-gray-800">建议：</span>
            {issue.suggestion}
          </p>
        </div>
      </div>
    </div>
  );
}

function PreviewEmpty({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof FileText;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-lg bg-white text-gray-400 shadow-sm ring-1 ring-gray-200">
          <Icon className="h-7 w-7" />
        </div>
        <div className="mt-4 text-sm font-semibold text-gray-900">{title}</div>
        <div className="mt-2 max-w-[360px] text-sm leading-6 text-gray-500">{description}</div>
      </div>
    </div>
  );
}

function PreviewLoading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-lg bg-white text-sky-600 shadow-sm ring-1 ring-gray-200">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
        <div className="mt-4 text-sm font-semibold text-gray-900">{title}</div>
        <div className="mt-2 max-w-[360px] text-sm leading-6 text-gray-500">{description}</div>
      </div>
    </div>
  );
}

function PreviewError({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-[360px] rounded-lg border border-rose-200 bg-white p-5 text-center shadow-sm">
        <AlertCircle className="mx-auto h-7 w-7 text-rose-600" />
        <div className="mt-4 text-sm font-semibold text-gray-900">{title}</div>
        <div className="mt-2 text-sm leading-6 text-gray-500">{description}</div>
      </div>
    </div>
  );
}

function NewProjectDialog({
  open,
  value,
  onChange,
  onCreate,
  creating,
  onClose,
}: {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onCreate: () => void;
  creating: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title="新建产品项目"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={creating}>
            取消
          </Button>
          <Button type="button" onClick={onCreate} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {creating ? "创建中..." : "创建"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <FieldLabel>项目名称</FieldLabel>
        <TextInput
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="例如：签到活动需求与原型"
          disabled={creating}
          autoFocus
        />
      </div>
    </Modal>
  );
}

function ProjectEditorDialog({
  project,
  titleDraft,
  loading,
  error,
  onTitleChange,
  onSave,
  onArchive,
  onDelete,
  onClose,
}: {
  project: WorkspaceProject | null;
  titleDraft: string;
  loading: "save" | "archive" | "delete" | null;
  error: string | null;
  onTitleChange: (value: string) => void;
  onSave: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const busy = Boolean(loading);

  return (
    <Modal
      open={Boolean(project)}
      title="项目设置"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={onArchive} disabled={busy}>
              {loading === "archive" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
              归档
            </Button>
            <Button type="button" variant="danger" onClick={onDelete} disabled={busy}>
              {loading === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              删除
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="button" onClick={onSave} disabled={busy}>
              {loading === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <FieldLabel>项目名称</FieldLabel>
          <TextInput
            value={titleDraft}
            onChange={(event) => onTitleChange(event.target.value)}
            disabled={busy}
            autoFocus
          />
        </div>
        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700">
            {error}
          </div>
        ) : null}
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3 text-xs leading-5 text-gray-500">
          归档项目会从默认列表隐藏；删除为软删除，后续可在后台审计中恢复或追溯。
        </div>
      </div>
    </Modal>
  );
}
