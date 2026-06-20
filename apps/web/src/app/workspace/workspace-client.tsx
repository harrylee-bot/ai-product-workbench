"use client";

import clsx from "clsx";
import {
  AlertCircle,
  Archive,
  Check,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  ClipboardCheck,
  Code2,
  Crosshair,
  Edit3,
  Database,
  FileUp,
  FileText,
  History,
  ImagePlus,
  Loader2,
  MessageSquare,
  Monitor,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
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
import { apiRequest, streamApiEvents, toQueryString } from "@/lib/api";

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
type PreviewTab = "prd" | "prototype" | "qa" | "state";
type PreviewState = "empty" | "generating" | "ready" | "error";
type QaStatus = "unchecked" | "checking" | "passed" | "issues" | "failed";
type DeviceMode = "desktop" | "mobile";
type FileAssetStatus =
  | "uploaded"
  | "parsing"
  | "parsed"
  | "parse_failed"
  | "unsupported"
  | "deleted";

type SelectedRegion =
  | {
      type: "document";
      sectionId: string;
      targetId: string;
      documentId?: string;
      blockId?: string;
      sourcePaths?: string[];
      selectedText?: string;
      label: string;
    }
  | {
      type: "prototype";
      targetId?: string;
      artifactId?: string;
      pageId: string;
      componentId?: string;
      domSelector?: string;
      sourcePaths?: string[];
      label?: string;
    };

type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  time: string;
  selectedRegion?: SelectedRegion | null;
  attachments?: MessageAttachment[];
};

type MessageAttachment = {
  fileId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  parseStatus?: FileAssetStatus;
  summary?: string;
};

type ComposerAttachment = MessageAttachment & {
  id: string;
  status: FileAssetStatus | "uploading";
  error?: string;
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
  type?: string;
  order?: number;
  paragraphs: string[];
  sourcePaths?: string[];
  tags?: string[];
};

type QaIssue = {
  id: string;
  level: "error" | "warning" | "info";
  type: string;
  description: string;
  suggestion: string;
};

type QaReportSummary = {
  id: string;
  status: "running" | "passed" | "failed" | "warning";
  trigger?: string;
  summary: string;
  blockingCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  productDesignStateVersion: number;
  createdAt: string;
};

type VersionTimelineItem = {
  id: string;
  type: "product_design_state" | "prd" | "prototype" | "patch" | "qa" | "rollback";
  version?: number;
  title: string;
  description?: string;
  relatedId: string;
  createdAt: string;
  createdBy?: string;
};

type ProductDesignStateSummary = {
  id: string;
  version: number;
  title: string;
  status: string;
  updatedAt: string;
  counts: {
    pages: number;
    backendConfigs: number;
    frontendRules: number;
    businessRules: number;
    stateRules: number;
    exceptionScenarios: number;
    acceptanceCriteria: number;
    assumptions: number;
    pendingQuestions: number;
    confirmedFacts: number;
  };
  assumptions: Array<{ id: string; content: string; status: string }>;
  pendingQuestions: Array<{ id: string; question: string; status: string }>;
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
  prdDocumentId?: string;
  prdSections: PrdSection[];
  prototypeState: PreviewState;
  prototypeArtifactId?: string;
  prototypeEntryFilePath?: string;
  prototypeSpec?: unknown;
  prototypeHtml: string;
  qaStatus: QaStatus;
  qaIssues: QaIssue[];
  latestQaReport?: QaReportSummary | null;
  versionTimeline: VersionTimelineItem[];
  productDesignState?: ProductDesignStateSummary | null;
};

type PreviewPatch = Partial<
  Pick<
    WorkspaceProject,
    | "clarificationQuestions"
    | "prdState"
    | "prdDocumentId"
    | "prdSections"
    | "prototypeState"
    | "prototypeArtifactId"
    | "prototypeEntryFilePath"
    | "prototypeSpec"
    | "prototypeHtml"
    | "qaStatus"
    | "qaIssues"
    | "latestQaReport"
    | "versionTimeline"
    | "productDesignState"
  >
>;

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
  attachments?: unknown;
  metadata?: unknown;
  createdAt: string;
};

type ApiFileAsset = {
  id: string;
  projectId: string;
  conversationId?: string;
  messageId?: string;
  originalName: string;
  mimeType: string;
  extension: string;
  size: number;
  status: FileAssetStatus;
  parseResultId?: string;
  parseError?: string;
  createdAt: string;
  updatedAt: string;
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
  assistantMessage: ApiMessage | null;
  runId: string;
  status: "running" | "completed";
  patchRecord?: unknown;
  result?: unknown;
};

type AgentStepName =
  | "intent_detection"
  | "knowledge_retrieval"
  | "requirement_analysis"
  | "product_design"
  | "prd_generation"
  | "prototype_design"
  | "prototype_code_generation"
  | "patch_planning"
  | "qa_check"
  | "knowledge_extraction";

type VibeRunEvent = {
  runId: string;
  type:
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "message_delta"
    | "state_updated"
    | "state_version_created"
    | "prd_updated"
    | "prototype_updated"
    | "patch_started"
    | "patch_plan_created"
    | "patch_applying"
    | "patch_completed"
    | "patch_failed"
    | "qa_completed"
    | "rollback_started"
    | "rollback_completed"
    | "rollback_failed"
    | "knowledge_candidate_created"
    | "run_completed"
    | "run_failed";
  step?: AgentStepName;
  content?: string;
  data?: unknown;
  createdAt: string;
};

type UploadFilesResponse = {
  items: ApiFileAsset[];
};

type GetFileResponse = {
  file: ApiFileAsset;
};

type GetProductDesignStateResponse = {
  state: unknown | null;
};

type GetCurrentPrdResponse = {
  document: unknown | null;
};

type GetCurrentPrototypeResponse = {
  artifact: unknown | null;
};

type GetLatestQaResponse = {
  qaReport: unknown | null;
};

type GetVersionTimelineResponse = {
  items: VersionTimelineItem[];
};

type PatchRecordStatus =
  | "planned"
  | "applying"
  | "applied"
  | "failed"
  | "cancelled"
  | "needs_confirmation";

type PatchRecordItem = {
  id: string;
  userInstruction: string;
  status: PatchRecordStatus;
  selectedRegion?: SelectedRegion | null;
  patchPlan?: unknown;
  operations?: Array<{ op?: string; path?: string; reason?: string }>;
  beforeProductDesignStateVersion?: number;
  afterProductDesignStateVersion?: number;
  affectedPrdDocumentId?: string;
  affectedPrototypeArtifactId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

type ListPatchRecordsResponse = {
  items: PatchRecordItem[];
  total: number;
  page: number;
  pageSize: number;
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

const PATCH_STATUS_META: Record<PatchRecordStatus, { label: string; className: string }> = {
  planned: {
    label: "待应用",
    className: "border-gray-200 bg-gray-50 text-gray-700",
  },
  applying: {
    label: "应用中",
    className: "border-sky-200 bg-sky-50 text-sky-700",
  },
  applied: {
    label: "已完成",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  failed: {
    label: "失败",
    className: "border-rose-200 bg-rose-50 text-rose-700",
  },
  cancelled: {
    label: "已取消",
    className: "border-gray-200 bg-white text-gray-500",
  },
  needs_confirmation: {
    label: "待确认",
    className: "border-amber-200 bg-amber-50 text-amber-700",
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

const STEP_KEY_BY_EVENT_STEP: Record<AgentStepName, string> = {
  intent_detection: "intent",
  knowledge_retrieval: "knowledge",
  requirement_analysis: "analyst",
  product_design: "designer",
  prd_generation: "prd",
  prototype_design: "prototypeDesigner",
  prototype_code_generation: "prototypeCode",
  patch_planning: "patch",
  qa_check: "qa",
  knowledge_extraction: "knowledgeExtractor",
};

const PROMPTS = [
  "帮我做一个签到活动需求和原型",
  "设计一个会员积分商城后台配置页",
  "把上传的初版需求文档补全成 PRD",
  "根据这个活动页面截图生成可演示原型",
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

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function getAttachmentStatusLabel(status?: FileAssetStatus | "uploading") {
  switch (status) {
    case "uploading":
      return "上传中";
    case "uploaded":
      return "已上传";
    case "parsing":
      return "解析中";
    case "parsed":
      return "已解析";
    case "parse_failed":
      return "解析失败";
    case "unsupported":
      return "不支持解析";
    default:
      return "已添加";
  }
}

function mapComposerAttachment(file: ApiFileAsset): ComposerAttachment {
  return {
    id: file.id,
    fileId: file.id,
    fileName: file.originalName,
    fileType: file.extension,
    fileSize: file.size,
    parseStatus: file.status,
    status: file.status,
  };
}

function mapMessageAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: MessageAttachment[] = [];
  value.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const attachment = item as Record<string, unknown>;
    const fileId = typeof attachment.fileId === "string" ? attachment.fileId : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName : "";
    const fileType = typeof attachment.fileType === "string" ? attachment.fileType : "file";
    const size =
      typeof attachment.size === "number"
        ? attachment.size
        : typeof attachment.fileSize === "number"
          ? attachment.fileSize
          : 0;
    if (!fileId || !fileName) return;
    attachments.push({
      fileId,
      fileName,
      fileType,
      fileSize: size,
      parseStatus:
        typeof attachment.parseStatus === "string"
          ? (attachment.parseStatus as FileAssetStatus)
          : undefined,
      summary: typeof attachment.summary === "string" ? attachment.summary : undefined,
    });
  });
  return attachments;
}

function mapProject(project: ApiProject, messages: ChatMessage[] = []): WorkspaceProject {
  return {
    id: project.id,
    conversationId: project.currentConversationId,
    title: project.title,
    summary: project.latestMessagePreview ?? project.description ?? "新项目，等待输入产品需求",
    updatedAt: formatRelativeTime(project.lastActivityAt),
    status: project.status,
    messages,
    prdState: "empty",
    prdSections: [],
    prototypeState:
      project.status === "prototype_ready" ||
      project.status === "qa_failed" ||
      project.status === "completed"
        ? "ready"
        : "empty",
    prototypeHtml: "",
    qaStatus: project.status === "qa_failed" ? "issues" : "unchecked",
    qaIssues: project.status === "qa_failed" ? DEFAULT_QA_ISSUES : [],
    latestQaReport: null,
    versionTimeline: [],
    productDesignState: null,
  };
}

function mapMessage(message: ApiMessage | null): ChatMessage | null {
  if (!message) return null;
  if (message.role === "system") return null;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    time: formatMessageTime(message.createdAt),
    attachments: mapMessageAttachments(message.attachments),
  };
}

function extractPreviewFromApiMessages(messages: ApiMessage[]) {
  const assistantMessages = [...messages].reverse();
  for (const message of assistantMessages) {
    const preview = extractPreviewFromPayload(message.metadata);
    if (preview) return preview;
  }
  return null;
}

function extractPreviewFromPayload(payload: unknown) {
  const data = asRecord(payload);
  if (!data) return null;

  const prdSections = mapPrdSections(data.prdDocument);
  const prdDocument = asRecord(data.prdDocument);
  const prototypeHtml = extractPrototypeHtml(data);
  const qa = mapQaReport(data.qaReport);
  const productDesignState = mapProductDesignStateSummary(data.productDesignState);
  const nextAction = asRecord(data.nextAction);
  const questions = mapClarificationQuestions(nextAction?.questions);

  if (!prdSections.length && !prototypeHtml && !qa && !questions.length && !productDesignState) return null;

  const patch: PreviewPatch = {};
  if (questions.length) patch.clarificationQuestions = questions;
  if (productDesignState) patch.productDesignState = productDesignState;
  if (prdSections.length) {
    patch.prdState = "ready";
    patch.prdDocumentId = asText(prdDocument?.id) || undefined;
    patch.prdSections = prdSections;
  }
  if (prototypeHtml) {
    const artifact = extractPrototypeArtifact(data);
    patch.prototypeState = "ready";
    patch.prototypeArtifactId = artifact?.id;
    patch.prototypeEntryFilePath = artifact?.entryFilePath;
    patch.prototypeSpec = extractPrototypeSpec(data);
    patch.prototypeHtml = prototypeHtml;
  }
  if (qa) {
    patch.qaStatus = qa.status;
    patch.qaIssues = qa.issues;
    patch.latestQaReport = mapQaReportSummary(data.qaReport);
  }
  return patch;
}

function mapProductDesignStateSummary(value: unknown): ProductDesignStateSummary | null {
  const state = asRecord(value);
  if (!state) return null;
  const id = asText(state.id);
  if (!id) return null;
  const counts = asRecord(state.counts);
  const countArray = (key: string) => {
    const counted = counts?.[key];
    if (typeof counted === "number") return counted;
    const arrayValue = state[key];
    return Array.isArray(arrayValue) ? arrayValue.length : 0;
  };
  const assumptions = Array.isArray(state.assumptions) ? state.assumptions : [];
  const pendingQuestions = Array.isArray(state.pendingQuestions) ? state.pendingQuestions : [];
  return {
    id,
    version: typeof state.version === "number" ? state.version : 0,
    title: asText(state.title) || "ProductDesignState",
    status: asText(state.status) || "draft",
    updatedAt: asText(state.updatedAt),
    counts: {
      pages: countArray("pages"),
      backendConfigs: countArray("backendConfigs"),
      frontendRules: countArray("frontendRules"),
      businessRules: countArray("businessRules"),
      stateRules: countArray("stateRules"),
      exceptionScenarios: countArray("exceptionScenarios"),
      acceptanceCriteria: countArray("acceptanceCriteria"),
      assumptions: countArray("assumptions"),
      pendingQuestions: countArray("pendingQuestions"),
      confirmedFacts: countArray("confirmedFacts"),
    },
    assumptions: assumptions.slice(0, 3).flatMap((item) => {
      const assumption = asRecord(item);
      if (!assumption) return [];
      return [
        {
          id: asText(assumption.id),
          content: asText(assumption.content) || asText(assumption.description) || "AI 推断",
          status: asText(assumption.status) || "pending",
        },
      ];
    }),
    pendingQuestions: pendingQuestions.slice(0, 3).flatMap((item) => {
      const question = asRecord(item);
      if (!question) return [];
      return [
        {
          id: asText(question.id),
          question: asText(question.question) || asText(question.title) || "待确认问题",
          status: asText(question.status) || "pending",
        },
      ];
    }),
  };
}

function mapPrdSections(value: unknown): PrdSection[] {
  const doc = asRecord(value);
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];

  return sections.flatMap((item, index) => {
    const section = asRecord(item);
    if (!section) return [];
    const title = asText(section.title) || `第 ${index + 1} 节`;
    const content = asText(section.content);
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    const blockContent = blocks
      .map((block) => asText(asRecord(block)?.content))
      .filter(Boolean)
      .join("\n");
    return [
      {
        id: asText(section.id) || `section-${index + 1}`,
        title,
        type: asText(section.type),
        order: typeof section.order === "number" ? section.order : index + 1,
        paragraphs: splitParagraphs(content || blockContent || "待补充内容"),
        sourcePaths: arrayOfText(section.sourcePaths ?? section.sourceStatePaths),
        tags: arrayOfText(section.tags),
      },
    ];
  }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function splitParagraphs(content: string) {
  const paragraphs = content
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [content];
}

function extractPrototypeHtml(value: unknown) {
  const record = asRecord(value);
  const artifact = asRecord(record?.prototypeArtifact) ?? asRecord(record?.artifact) ?? asRecord(value);
  return asText(artifact?.htmlContent) || asText(artifact?.html);
}

function extractPrototypeArtifact(value: unknown) {
  const record = asRecord(value);
  const artifact = asRecord(record?.prototypeArtifact) ?? asRecord(record?.artifact) ?? asRecord(value);
  if (!artifact) return null;
  const id = asText(artifact.id);
  const html = extractPrototypeHtml(artifact);
  const status = asText(artifact.status);
  if (!id && !html && !status) return null;
  return {
    id: id || undefined,
    html,
    status,
    entryFilePath: asText(artifact.entryFilePath) || asText(artifact.entryFile) || undefined,
  };
}

function extractPrototypeSpec(value: unknown) {
  const record = asRecord(value);
  return record?.prototypeSpec ?? null;
}

function getFirstPrototypeTarget(specValue: unknown) {
  const spec = asRecord(specValue);
  const pages = Array.isArray(spec?.pages) ? spec.pages : [];
  const firstPage = asRecord(pages[0]);
  const components = Array.isArray(firstPage?.components) ? firstPage.components : [];
  const firstComponent = components.map(asRecord).find(Boolean);
  const pageName = asText(firstPage?.name) || "原型页面";
  const componentName = asText(firstComponent?.name) || "主要组件";
  return {
    pageId: asText(firstPage?.id) || "page_main",
    componentId: asText(firstComponent?.id) || undefined,
    sourcePaths: arrayOfText(firstComponent?.sourcePaths ?? firstPage?.sourcePaths),
    label: `${pageName} / ${componentName}`,
  };
}

function mapQaReport(value: unknown): { status: QaStatus; issues: QaIssue[] } | null {
  const report = asRecord(value);
  if (!report) return null;
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const suggestions = Array.isArray(report.suggestions) ? report.suggestions.map(asText) : [];
  const mappedIssues = issues.flatMap((item, index) => {
    const issue = asRecord(item);
    if (!issue) return [];
    const level = asQaLevel(asText(issue.level) || asText(issue.severity));
    return [
      {
        id: asText(issue.id) || `qa-${index + 1}`,
        level,
        type: asText(issue.type) || asText(issue.title) || asText(issue.checkType) || "一致性检查",
        description: asText(issue.message) || asText(issue.description) || "发现一个待确认问题。",
        suggestion: suggestions[index] || asText(issue.suggestion) || "请补充规则后重新生成或触发 QA。",
      },
    ];
  });

  const status = asText(report.status);
  return {
    status:
      status === "running"
        ? "checking"
        : status === "passed" || status === "warning"
          ? "passed"
          : Boolean(report.passed)
            ? "passed"
            : mappedIssues.length
              ? "issues"
              : "failed",
    issues: mappedIssues,
  };
}

function mapQaReportSummary(value: unknown): QaReportSummary | null {
  const report = asRecord(value);
  if (!report) return null;
  const id = asText(report.id);
  if (!id) return null;
  const status = asText(report.status);
  return {
    id,
    status: status === "running" || status === "passed" || status === "failed" || status === "warning"
      ? status
      : Boolean(report.passed) ? "passed" : "failed",
    trigger: asText(report.trigger) || undefined,
    summary: asText(report.summary) || "QA 已完成",
    blockingCount: asNumber(report.blockingCount),
    majorCount: asNumber(report.majorCount),
    minorCount: asNumber(report.minorCount),
    infoCount: asNumber(report.infoCount),
    productDesignStateVersion: asNumber(report.productDesignStateVersion),
    createdAt: asText(report.createdAt),
  };
}

function statusFromRunResult(
  result: Record<string, unknown> | null,
  qa: { status: QaStatus; issues: QaIssue[] } | null,
): ProjectStatus {
  const nextAction = asRecord(result?.nextAction);
  if (nextAction?.type === "ask_clarification") return "clarifying";
  if (qa?.status && qa.status !== "passed") return "qa_failed";
  if (extractPrototypeHtml(result)) return "prototype_ready";
  if (mapPrdSections(result?.prdDocument).length) return "prd_ready";
  return "draft";
}

function mapClarificationQuestions(value: unknown): ClarificationQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const question = asRecord(item);
    if (!question) return [];
    const options = Array.isArray(question.options) ? question.options.map(asText).filter(Boolean) : [];
    return [
      {
        id: asText(question.id) || `clarify-${index + 1}`,
        title: asText(question.title) || "请补充确认信息",
        options: options.length ? options : ["按常规最佳实践先生成", "我补充具体规则", "暂不纳入一期"],
      },
    ];
  });
}

function asQaLevel(value: string): QaIssue["level"] {
  if (value === "error" || value === "warning" || value === "info") return value;
  if (value === "blocking" || value === "major") return "error";
  if (value === "minor") return "warning";
  return "warning";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map(asText).filter(Boolean) : [];
}

function getPatchImpactPaths(record: PatchRecordItem) {
  const plan = asRecord(record.patchPlan);
  const impact = asRecord(plan?.impactAnalysis);
  const paths = arrayOfText(impact?.affectedStatePaths);
  if (paths.length) return paths;
  return (record.operations ?? []).map((operation) => operation.path).filter((path): path is string => Boolean(path));
}

function getSelectedRegionLabel(region?: SelectedRegion | null) {
  if (!region) return "未标记区域";
  if (region.type === "prototype") {
    return region.label || region.componentId || region.pageId || region.targetId || "选中区域";
  }
  return region.label || region.sectionId || region.targetId || "选中区域";
}

function getPrdTagLabel(tag: string) {
  const labels: Record<string, string> = {
    ai_assumption: "AI 推断",
    knowledge_base: "知识库",
    user_confirmed: "已确认",
    pending_question: "待确认",
  };
  return labels[tag] ?? tag;
}

function preservePreviewState(project: WorkspaceProject) {
  return {
    clarificationQuestions: project.clarificationQuestions,
    prdState: project.prdState,
    prdDocumentId: project.prdDocumentId,
    prdSections: project.prdSections,
    prototypeState: project.prototypeState,
    prototypeArtifactId: project.prototypeArtifactId,
    prototypeEntryFilePath: project.prototypeEntryFilePath,
    prototypeSpec: project.prototypeSpec,
    prototypeHtml: project.prototypeHtml,
    qaStatus: project.qaStatus,
    qaIssues: project.qaIssues,
    latestQaReport: project.latestQaReport,
    versionTimeline: project.versionTimeline,
    productDesignState: project.productDesignState,
  };
}

function mergePreviewPatch(project: WorkspaceProject, patch: PreviewPatch | null | undefined) {
  if (!patch) return project;
  return {
    ...project,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
  } as WorkspaceProject;
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
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("prd");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [localEditEnabled, setLocalEditEnabled] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<SelectedRegion | null>(null);
  const [patchHistoryOpen, setPatchHistoryOpen] = useState(false);
  const [patchHistoryItems, setPatchHistoryItems] = useState<PatchRecordItem[]>([]);
  const [patchHistoryLoading, setPatchHistoryLoading] = useState(false);
  const [patchHistoryError, setPatchHistoryError] = useState<string | null>(null);
  const [patchActionLoadingId, setPatchActionLoadingId] = useState<string | null>(null);
  const [patchConfirmationDrafts, setPatchConfirmationDrafts] = useState<Record<string, string>>({});
  const [qaActionLoading, setQaActionLoading] = useState(false);
  const [versionActionLoading, setVersionActionLoading] = useState(false);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>(createAgentSteps);
  const [isRunning, setIsRunning] = useState(false);
  const timersRef = useRef<number[]>([]);
  const streamAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      streamAbortRef.current?.abort();
    };
  }, []);

  const pollFileStatus = (fileId: string, attempts = 0) => {
    if (attempts >= 12) return;

    schedule(async () => {
      try {
        const response = await apiRequest<GetFileResponse>(`/files/${fileId}`);
        const nextAttachment = mapComposerAttachment(response.file);
        setComposerAttachments((items) =>
          items.map((item) =>
            item.fileId === fileId
              ? {
                  ...item,
                  ...nextAttachment,
                }
              : item,
          ),
        );

        if (["uploaded", "parsing"].includes(response.file.status)) {
          pollFileStatus(fileId, attempts + 1);
        }
      } catch (error) {
        setComposerAttachments((items) =>
          items.map((item) =>
            item.fileId === fileId
              ? {
                  ...item,
                  status: "parse_failed",
                  parseStatus: "parse_failed",
                  error: error instanceof Error ? error.message : "文件状态同步失败",
                }
              : item,
          ),
        );
      }
    }, attempts === 0 ? 900 : 1600);
  };

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
      let previewPatch: PreviewPatch | null = null;

      if (conversationId) {
        const response = await apiRequest<ListMessagesResponse>(
          `/conversations/${conversationId}/messages${toQueryString({ limit: 50 })}`,
        );
        messages = response.items.map(mapMessage).filter((message): message is ChatMessage => Boolean(message));
        previewPatch = extractPreviewFromApiMessages(response.items);
        if (previewPatch) {
          setPreviewTab(previewPatch.prototypeHtml ? "prototype" : previewPatch.qaIssues?.length ? "qa" : "prd");
        }
      }

      const stateResponse = await apiRequest<GetProductDesignStateResponse>(
        `/projects/${projectId}/product-design-state`,
      );
      const stateSummary = mapProductDesignStateSummary(stateResponse.state);
      const prdResponse = await apiRequest<GetCurrentPrdResponse>(
        `/projects/${projectId}/prd/current`,
      );
      const prdDocument = asRecord(prdResponse.document);
      const currentPrdSections = mapPrdSections(prdResponse.document);
      previewPatch = {
        ...(previewPatch ?? {}),
        productDesignState: stateSummary,
        ...(currentPrdSections.length
          ? {
              prdState: "ready" as const,
              prdDocumentId: asText(prdDocument?.id) || undefined,
              prdSections: currentPrdSections,
            }
          : {}),
      };
      const prototypeResponse = await apiRequest<GetCurrentPrototypeResponse>(
        `/projects/${projectId}/prototype/current`,
      );
      const currentArtifact = extractPrototypeArtifact(prototypeResponse.artifact);
      if (currentArtifact?.html || currentArtifact?.status) {
        previewPatch = {
          ...previewPatch,
          prototypeState: currentArtifact.status === "failed" ? "error" : "ready",
          prototypeArtifactId: currentArtifact.id,
          prototypeEntryFilePath: currentArtifact.entryFilePath,
          prototypeHtml: currentArtifact.html,
        };
      }
      const [qaResponse, timelineResponse] = await Promise.all([
        apiRequest<GetLatestQaResponse>(`/projects/${projectId}/qa/latest`).catch(() => ({ qaReport: null })),
        apiRequest<GetVersionTimelineResponse>(`/projects/${projectId}/version-timeline`).catch(() => ({ items: [] })),
      ]);
      const latestQa = mapQaReport(qaResponse.qaReport);
      const latestQaReport = mapQaReportSummary(qaResponse.qaReport);
      previewPatch = {
        ...previewPatch,
        versionTimeline: timelineResponse.items,
        latestQaReport,
        ...(latestQa
          ? {
              qaStatus: latestQa.status,
              qaIssues: latestQa.issues,
            }
          : {}),
      };

      setProjects((items) =>
        items.map((project) =>
          project.id === projectId
            ? mergePreviewPatch(
                {
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
                },
                previewPatch,
              )
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

  useEffect(() => {
    if (!currentProjectId || !patchHistoryOpen) return;
    void loadPatchHistory(currentProjectId);
  }, [currentProjectId, patchHistoryOpen]);

  const clearRunTimers = () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  };

  const loadPatchHistory = async (projectId = currentProjectId) => {
    if (!projectId) return;
    setPatchHistoryLoading(true);
    setPatchHistoryError(null);
    try {
      const response = await apiRequest<ListPatchRecordsResponse>(
        `/projects/${projectId}/patches${toQueryString({ page: 1, pageSize: 30 })}`,
      );
      setPatchHistoryItems(response.items);
    } catch (error) {
      setPatchHistoryError(error instanceof Error ? error.message : "Patch 历史加载失败");
    } finally {
      setPatchHistoryLoading(false);
    }
  };

  const cancelPatch = async (patchId: string) => {
    if (!currentProject) return;
    setPatchActionLoadingId(patchId);
    setPatchHistoryError(null);
    try {
      await apiRequest(`/patches/${patchId}/cancel`, { method: "POST" });
      await loadPatchHistory(currentProject.id);
    } catch (error) {
      setPatchHistoryError(error instanceof Error ? error.message : "取消 Patch 失败");
    } finally {
      setPatchActionLoadingId(null);
    }
  };

  const confirmPatch = async (patchId: string, confirmation: string) => {
    if (!currentProject) return;
    const userConfirmation = confirmation.trim() || "确认应用该局部修改。";
    setPatchActionLoadingId(patchId);
    setPatchHistoryError(null);
    try {
      const response = await apiRequest<HandleMessageResponse>(`/patches/${patchId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ userConfirmation }),
      });
      if (response.result) {
        const previewPatch = extractPreviewFromPayload(response.result);
        updateProject(currentProject.id, (project) => mergePreviewPatch(project, previewPatch));
      }
      if (response.assistantMessage) {
        const savedAssistantMessage = mapMessage(response.assistantMessage);
        if (savedAssistantMessage) {
          updateProject(currentProject.id, (project) => ({
            ...project,
            messages: project.messages.some((item) => item.id === savedAssistantMessage.id)
              ? project.messages
              : [...project.messages, savedAssistantMessage],
          }));
        }
      }
      startRunStream(currentProject.id, response.runId);
      await loadPatchHistory(currentProject.id);
    } catch (error) {
      setPatchHistoryError(error instanceof Error ? error.message : "确认 Patch 失败");
    } finally {
      setPatchActionLoadingId(null);
    }
  };

  const runManualQa = async () => {
    if (!currentProject) return;
    setQaActionLoading(true);
    setWorkspaceError(null);
    updateProject(currentProject.id, (project) => ({
      ...project,
      qaStatus: "checking",
      summary: "正在重新执行 QA",
    }));
    setPreviewTab("qa");
    try {
      const response = await apiRequest<{ qaReport: unknown }>(`/projects/${currentProject.id}/qa/run`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const qa = mapQaReport(response.qaReport);
      const latestQaReport = mapQaReportSummary(response.qaReport);
      updateProject(currentProject.id, (project) => ({
        ...project,
        status: qa?.status && qa.status !== "passed" ? "qa_failed" : project.status === "qa_failed" ? "prototype_ready" : project.status,
        summary: latestQaReport?.summary ?? project.summary,
        qaStatus: qa?.status ?? project.qaStatus,
        qaIssues: qa?.issues ?? project.qaIssues,
        latestQaReport,
      }));
      window.setTimeout(() => void loadProjectDetail(currentProject.id), 250);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "QA 运行失败");
      updateProject(currentProject.id, (project) => ({
        ...project,
        qaStatus: "failed",
        summary: "QA 运行失败",
      }));
    } finally {
      setQaActionLoading(false);
    }
  };

  const rollbackToStateVersion = async (version: number) => {
    if (!currentProject) return;
    if (!window.confirm(`确认回滚到 ProductDesignState v${version}？系统会创建一个新版本并重新生成 PRD、原型和 QA。`)) {
      return;
    }
    setVersionActionLoading(true);
    setWorkspaceError(null);
    setPreviewTab("state");
    try {
      const response = await apiRequest<{
        productDesignState?: unknown;
        prdDocument?: unknown;
        prototypeArtifact?: unknown;
        qaReport?: unknown;
      }>(`/projects/${currentProject.id}/rollback/product-design-state`, {
        method: "POST",
        body: JSON.stringify({
          targetVersion: version,
          reason: `用户从工作台回滚到 ProductDesignState v${version}`,
        }),
      });
      const previewPatch = extractPreviewFromPayload({
        productDesignState: response.productDesignState,
        prdDocument: response.prdDocument,
        prototypeArtifact: response.prototypeArtifact,
        qaReport: response.qaReport,
      });
      updateProject(currentProject.id, (project) =>
        mergePreviewPatch(
          {
            ...project,
            summary: `已回滚到 v${version} 并重新生成`,
            updatedAt: "刚刚",
          },
          previewPatch,
        ),
      );
      window.setTimeout(() => void loadProjectDetail(currentProject.id), 250);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setVersionActionLoading(false);
    }
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
      setComposerAttachments([]);
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

  const stopRunStream = () => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  };

  const updateProject = (
    targetProjectId: string,
    updater: (project: WorkspaceProject) => WorkspaceProject,
  ) => {
    setProjects((items) =>
      items.map((project) => (project.id === targetProjectId ? updater(project) : project)),
    );
  };

  const updateStep = (stepName: AgentStepName | undefined, status: StepStatus, description?: string) => {
    if (!stepName) return;
    const key = STEP_KEY_BY_EVENT_STEP[stepName];
    setAgentSteps((steps) =>
      steps.map((step) =>
        step.key === key
          ? {
              ...step,
              status,
              description: description || step.description,
            }
          : step,
      ),
    );
  };

  const startRunState = (targetProjectId: string, isPatch: boolean) => {
    stopRunStream();
    setIsRunning(true);
    setAgentSteps(createAgentSteps());
    setPreviewTab("prd");
    updateProject(targetProjectId, (project) => ({
      ...project,
      status: "generating",
      summary: isPatch ? "正在分析局部修改影响范围" : "AI 正在协作生成 PRD、原型和 QA 报告",
      updatedAt: "刚刚",
      clarificationQuestions: undefined,
      prdState: "generating",
      prdDocumentId: isPatch ? project.prdDocumentId : undefined,
      prdSections: isPatch ? project.prdSections : [],
      prototypeState: isPatch ? project.prototypeState : "empty",
      prototypeArtifactId: isPatch ? project.prototypeArtifactId : undefined,
      prototypeEntryFilePath: isPatch ? project.prototypeEntryFilePath : undefined,
      prototypeSpec: isPatch ? project.prototypeSpec : undefined,
      prototypeHtml: isPatch ? project.prototypeHtml : "",
      qaStatus: "unchecked",
      qaIssues: [],
    }));
  };

  const startRunStream = (targetProjectId: string, runId: string) => {
    const controller = new AbortController();
    streamAbortRef.current = controller;

    void streamApiEvents<VibeRunEvent>(
      `/ai/vibe/runs/${runId}/stream`,
      (event) => handleRunEvent(targetProjectId, runId, event, controller),
      { signal: controller.signal },
    ).catch((error) => {
      if (controller.signal.aborted) return;
      setIsRunning(false);
      setWorkspaceError(error instanceof Error ? error.message : "Agent 流式连接失败");
      updateProject(targetProjectId, (project) => ({
        ...project,
        status: "qa_failed",
        summary: "Agent 流式连接中断，请稍后重试",
      }));
    });
  };

  const handleRunEvent = (
    targetProjectId: string,
    runId: string,
    event: VibeRunEvent,
    controller: AbortController,
  ) => {
    if (!event || event.runId !== runId) return;

    if (event.type === "message_delta") {
      updateProject(targetProjectId, (project) => ({
        ...project,
        summary: event.content || project.summary,
        updatedAt: "刚刚",
      }));
      return;
    }

    if (event.type === "step_started") {
      updateStep(event.step, "running", event.content);
      applyStartedPreviewState(targetProjectId, event);
      return;
    }

    if (event.type === "step_completed") {
      updateStep(event.step, "success", event.content);
      return;
    }

    if (event.type === "step_failed") {
      updateStep(event.step, "failed", event.content);
      updateProject(targetProjectId, (project) => ({
        ...project,
        status: "qa_failed",
        summary: event.content || "Agent 执行失败",
      }));
      return;
    }

    if (event.type === "state_updated") {
      const stateSummary = mapProductDesignStateSummary(event.data);
      if (!stateSummary) return;
      updateProject(targetProjectId, (project) => ({
        ...project,
        productDesignState: stateSummary,
        summary: `ProductDesignState v${stateSummary.version} 已更新`,
      }));
      return;
    }

    if (event.type === "state_version_created") {
      updateProject(targetProjectId, (project) => ({
        ...project,
        summary: "ProductDesignState 版本快照已保存",
      }));
      return;
    }

    if (event.type === "patch_started" || event.type === "patch_plan_created" || event.type === "patch_applying") {
      updateProject(targetProjectId, (project) => ({
        ...project,
        summary: event.content || "正在执行局部修改",
      }));
      return;
    }

    if (event.type === "prd_updated") {
      const prdSections = mapPrdSections(event.data);
      const prdDocument = asRecord(event.data);
      if (!prdSections.length) return;
      updateProject(targetProjectId, (project) => ({
        ...project,
        status: "prd_ready",
        summary: "PRD 已生成，正在继续生成原型",
        prdState: "ready",
        prdDocumentId: asText(prdDocument?.id) || project.prdDocumentId,
        prdSections,
      }));
      setPreviewTab("prd");
      return;
    }

    if (event.type === "prototype_updated") {
      const prototypeHtml = extractPrototypeHtml(event.data);
      if (!prototypeHtml) return;
      const artifact = extractPrototypeArtifact(event.data);
      updateProject(targetProjectId, (project) => ({
        ...project,
        status: "prototype_ready",
        summary: "HTML 原型已生成，正在校验一致性",
        prototypeState: "ready",
        prototypeArtifactId: artifact?.id ?? project.prototypeArtifactId,
        prototypeEntryFilePath: artifact?.entryFilePath ?? project.prototypeEntryFilePath,
        prototypeSpec: extractPrototypeSpec(event.data) ?? project.prototypeSpec,
        prototypeHtml,
      }));
      setPreviewTab("prototype");
      return;
    }

    if (event.type === "qa_completed") {
      const qa = mapQaReport(event.data);
      if (!qa) return;
      updateProject(targetProjectId, (project) => ({
        ...project,
        status: qa.status === "passed" ? "prototype_ready" : "qa_failed",
        summary: qa.status === "passed" ? "QA 校验通过" : `QA 发现 ${qa.issues.length} 个待确认问题`,
        qaStatus: qa.status,
        qaIssues: qa.issues,
      }));
      setPreviewTab("qa");
      return;
    }

    if (event.type === "patch_completed") {
      const data = asRecord(event.data);
      const result = asRecord(data?.result);
      const previewPatch = extractPreviewFromPayload(result);
      const qa = mapQaReport(result?.qaReport);
      updateProject(targetProjectId, (project) =>
        mergePreviewPatch(
          {
            ...project,
            status: qa?.status && qa.status !== "passed" ? "qa_failed" : "prototype_ready",
            summary: event.content || "局部修改已完成",
            updatedAt: "刚刚",
          },
          previewPatch,
        ),
      );
      setIsRunning(false);
      controller.abort();
      window.setTimeout(() => void loadProjectDetail(targetProjectId), 250);
      if (patchHistoryOpen) window.setTimeout(() => void loadPatchHistory(targetProjectId), 300);
      return;
    }

    if (event.type === "patch_failed") {
      setIsRunning(false);
      updateProject(targetProjectId, (project) => ({
        ...project,
        status: "qa_failed",
        summary: event.content || "局部修改失败",
        prdState: project.prdState === "generating" ? "error" : project.prdState,
        prototypeState: project.prototypeState === "generating" ? "error" : project.prototypeState,
        qaStatus: "failed",
      }));
      controller.abort();
      if (patchHistoryOpen) window.setTimeout(() => void loadPatchHistory(targetProjectId), 300);
      return;
    }

    if (event.type === "run_completed") {
      const result = asRecord(event.data);
      const messageContent = asText(result?.message) || event.content || "Agent 协作已完成。";
      const qa = mapQaReport(result?.qaReport);
      const previewPatch = extractPreviewFromPayload(result);
      const assistantMessage: ChatMessage = {
        id: `assistant-${runId}`,
        role: "assistant",
        content: messageContent,
        time: formatMessageTime(event.createdAt),
      };

      updateProject(targetProjectId, (project) =>
        mergePreviewPatch(
          {
            ...project,
            status: statusFromRunResult(result, qa),
            summary: messageContent,
            updatedAt: "刚刚",
            messages: project.messages.some((message) => message.id === assistantMessage.id)
              ? project.messages
              : [...project.messages, assistantMessage],
          },
          previewPatch,
        ),
      );
      setIsRunning(false);
      controller.abort();
      window.setTimeout(() => void loadProjectDetail(targetProjectId), 250);
      return;
    }

    if (event.type === "run_failed") {
      setIsRunning(false);
      updateProject(targetProjectId, (project) => ({
        ...project,
        status: "qa_failed",
        summary: event.content || "Agent 执行失败",
        prdState: project.prdState === "generating" ? "error" : project.prdState,
        prototypeState: project.prototypeState === "generating" ? "error" : project.prototypeState,
        qaStatus: "failed",
      }));
      controller.abort();
    }
  };

  const applyStartedPreviewState = (targetProjectId: string, event: VibeRunEvent) => {
    if (event.step === "prd_generation") {
      updateProject(targetProjectId, (project) => ({
        ...project,
        summary: event.content || "正在生成 PRD 草案",
        prdState: "generating",
      }));
      setPreviewTab("prd");
    }

    if (event.step === "prototype_design" || event.step === "prototype_code_generation") {
      updateProject(targetProjectId, (project) => ({
        ...project,
        summary: event.content || "正在生成 HTML 原型",
        prototypeState: "generating",
      }));
      setPreviewTab("prototype");
    }

    if (event.step === "qa_check") {
      updateProject(targetProjectId, (project) => ({
        ...project,
        summary: event.content || "正在校验 PRD 与原型一致性",
        qaStatus: "checking",
      }));
      setPreviewTab("qa");
    }
  };

  const uploadComposerFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    if (!currentProject) {
      setWorkspaceError("请先新建项目，再上传资料");
      return;
    }

    const remainingSlots = Math.max(10 - composerAttachments.length, 0);
    if (!remainingSlots) {
      setWorkspaceError("单条消息最多携带 10 个附件");
      return;
    }

    const selectedFiles = files.slice(0, remainingSlots);
    const uploadingItems: ComposerAttachment[] = selectedFiles.map((file) => {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "file";
      return {
        id: createId("upload"),
        fileId: "",
        fileName: file.name,
        fileType: extension,
        fileSize: file.size,
        status: "uploading",
      };
    });

    setWorkspaceError(null);
    setComposerAttachments((items) => [...items, ...uploadingItems]);

    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append("files", file));
      if (currentProject.conversationId) formData.append("conversationId", currentProject.conversationId);

      const response = await apiRequest<UploadFilesResponse>(`/projects/${currentProject.id}/files`, {
        method: "POST",
        body: formData,
      });
      const uploadedItems = response.items.map(mapComposerAttachment);

      setComposerAttachments((items) => {
        const uploadIds = new Set(uploadingItems.map((item) => item.id));
        return [...items.filter((item) => !uploadIds.has(item.id)), ...uploadedItems];
      });

      uploadedItems.forEach((item) => pollFileStatus(item.fileId));
    } catch (error) {
      const uploadIds = new Set(uploadingItems.map((item) => item.id));
      setComposerAttachments((items) =>
        items.map((item) =>
          uploadIds.has(item.id)
            ? {
                ...item,
                status: "parse_failed",
                parseStatus: "parse_failed",
                error: error instanceof Error ? error.message : "上传失败",
              }
            : item,
        ),
      );
      setWorkspaceError(error instanceof Error ? error.message : "文件上传失败");
    }
  };

  const removeComposerAttachment = (attachmentId: string) => {
    setComposerAttachments((items) => items.filter((item) => item.id !== attachmentId));
  };

  const openFilePicker = (accept: string) => {
    if (!currentProject) {
      setWorkspaceError("请先新建项目，再上传资料");
      return;
    }
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = accept;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  };

  const sendMessage = async () => {
    const typedMessage = composerValue.trim();
    const fileIds = composerAttachments
      .filter((attachment) => attachment.fileId && attachment.status !== "uploading")
      .map((attachment) => attachment.fileId);
    const hasUploadingFiles = composerAttachments.some((attachment) => attachment.status === "uploading");
    const message = typedMessage || (fileIds.length ? "请基于上传附件继续分析。" : "");
    if (!message || isRunning) return;
    if (hasUploadingFiles) {
      setWorkspaceError("附件还在上传中，请稍等几秒再发送");
      return;
    }
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
      attachments: composerAttachments
        .filter((attachment) => attachment.fileId)
        .map((attachment) => ({
          fileId: attachment.fileId,
          fileName: attachment.fileName,
          fileType: attachment.fileType,
          fileSize: attachment.fileSize,
          parseStatus: attachment.parseStatus,
        })),
    };

    startRunState(currentProject.id, Boolean(selectedRegion));

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
    setComposerAttachments([]);
    setSelectedRegion(null);
    setLocalEditEnabled(false);

    try {
      const isPatchMessage = Boolean(selectedRegion);
      const response = await apiRequest<HandleMessageResponse>(
        isPatchMessage ? `/projects/${currentProject.id}/patches` : "/ai/vibe/handle-message",
        {
        method: "POST",
        body: JSON.stringify(
          isPatchMessage
            ? {
                conversationId: targetConversationId,
                selectedRegion,
                userInstruction: message,
                attachmentFileIds: fileIds,
              }
            : {
                projectId: currentProject.id,
                conversationId: targetConversationId,
                message,
                selectedRegion,
                previewMode: previewTab === "prototype" ? "prototype" : "prd",
                fileIds,
              },
        ),
      },
      );
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

      if (savedAssistantMessage) {
        updateProject(currentProject.id, (project) => ({
          ...project,
          messages: project.messages.some((item) => item.id === savedAssistantMessage.id)
            ? project.messages
            : [...project.messages, savedAssistantMessage],
        }));
      }

      if (response.result) {
        const previewPatch = extractPreviewFromPayload(response.result);
        updateProject(currentProject.id, (project) => mergePreviewPatch(project, previewPatch));
      }

      startRunStream(currentProject.id, response.runId);
    } catch (error) {
      setIsRunning(false);
      stopRunStream();
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
      targetId: currentProject?.prdDocumentId ?? `${section.id}-body`,
      documentId: currentProject?.prdDocumentId,
      sourcePaths: section.sourcePaths,
      label: section.title,
    });
    setComposerValue((value) => value || `请修改「${section.title}」：`);
  };

  const selectPrototypeRegion = () => {
    if (!localEditEnabled) return;
    const target = getFirstPrototypeTarget(currentProject?.prototypeSpec);
    setSelectedRegion({
      type: "prototype",
      targetId: currentProject?.prototypeArtifactId,
      artifactId: currentProject?.prototypeArtifactId,
      pageId: target.pageId,
      componentId: target.componentId,
      domSelector: target.componentId ? `[data-component-id="${target.componentId}"]` : undefined,
      sourcePaths: target.sourcePaths,
      label: target.label,
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
    stopRunStream();
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
            composerAttachments={composerAttachments}
            isRunning={isRunning}
            projectDetailLoading={projectDetailLoading}
            workspaceError={workspaceError}
            agentSteps={agentSteps}
            selectedRegion={selectedRegion}
            onComposerChange={setComposerValue}
            onUploadFiles={() => openFilePicker(".txt,.md,.docx,.pdf,.zip,.rp")}
            onUploadImages={() => openFilePicker("image/png,image/jpeg,.png,.jpg,.jpeg")}
            onRemoveAttachment={removeComposerAttachment}
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
            patchHistoryItems={patchHistoryItems}
            patchHistoryOpen={patchHistoryOpen}
            patchHistoryLoading={patchHistoryLoading}
            patchHistoryError={patchHistoryError}
            patchActionLoadingId={patchActionLoadingId}
            patchConfirmationDrafts={patchConfirmationDrafts}
            qaActionLoading={qaActionLoading}
            versionActionLoading={versionActionLoading}
            onPreviewTabChange={setPreviewTab}
            onDeviceModeChange={setDeviceMode}
            onLocalEditToggle={() => setLocalEditEnabled((value) => !value)}
            onSelectPrdSection={selectPrdSection}
            onSelectPrototypeRegion={selectPrototypeRegion}
            onClearSelectedRegion={() => setSelectedRegion(null)}
            onPatchHistoryToggle={() => setPatchHistoryOpen((value) => !value)}
            onRefreshPatchHistory={() => void loadPatchHistory(currentProject?.id)}
            onCancelPatch={cancelPatch}
            onPatchConfirmationChange={(patchId, value) =>
              setPatchConfirmationDrafts((drafts) => ({ ...drafts, [patchId]: value }))
            }
            onConfirmPatch={confirmPatch}
            onRunQa={runManualQa}
            onRollbackToVersion={rollbackToStateVersion}
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
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void uploadComposerFiles(event.target.files)}
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
  composerAttachments,
  isRunning,
  projectDetailLoading,
  workspaceError,
  agentSteps,
  selectedRegion,
  onComposerChange,
  onUploadFiles,
  onUploadImages,
  onRemoveAttachment,
  onPromptClick,
  onNewProject,
  onSend,
  onClarificationClick,
  onClearSelectedRegion,
}: {
  project: WorkspaceProject | null;
  composerValue: string;
  composerAttachments: ComposerAttachment[];
  isRunning: boolean;
  projectDetailLoading: boolean;
  workspaceError: string | null;
  agentSteps: AgentStep[];
  selectedRegion: SelectedRegion | null;
  onComposerChange: (value: string) => void;
  onUploadFiles: () => void;
  onUploadImages: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
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

      <div className="min-h-0 overflow-y-auto px-4 pb-[168px] pt-4">
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
        attachments={composerAttachments}
        onChange={onComposerChange}
        onUploadFiles={onUploadFiles}
        onUploadImages={onUploadImages}
        onRemoveAttachment={onRemoveAttachment}
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
        {message.attachments?.length ? (
          <div className="mt-3 grid gap-1.5">
            {message.attachments.map((attachment) => (
              <div
                key={attachment.fileId}
                className={clsx(
                  "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                  isUser ? "bg-white/10 text-gray-200" : "bg-gray-50 text-gray-600",
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{attachment.fileName}</span>
                <span className={clsx("shrink-0", isUser ? "text-gray-300" : "text-gray-400")}>
                  {getAttachmentStatusLabel(attachment.parseStatus)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
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
  attachments,
  onChange,
  onUploadFiles,
  onUploadImages,
  onRemoveAttachment,
  onSend,
  onClearSelectedRegion,
}: {
  value: string;
  disabled: boolean;
  selectedRegion: SelectedRegion | null;
  attachments: ComposerAttachment[];
  onChange: (value: string) => void;
  onUploadFiles: () => void;
  onUploadImages: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
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
    { label: "上传资料", icon: FileUp, onClick: onUploadFiles },
    { label: "上传图片", icon: ImagePlus, onClick: onUploadImages },
  ];
  const canSend = Boolean(value.trim() || attachments.some((attachment) => attachment.fileId));

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
        {attachments.length ? (
          <div className="mb-2 flex max-h-[76px] flex-wrap gap-2 overflow-y-auto pr-1">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={() => onRemoveAttachment(attachment.id)}
              />
            ))}
          </div>
        ) : null}
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
                      onClick={() => {
                        setToolsOpen(false);
                        action.onClick();
                      }}
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
            disabled={!canSend || disabled}
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

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const failed = attachment.status === "parse_failed";
  const parsed = attachment.status === "parsed";
  const busy = attachment.status === "uploading" || attachment.status === "parsing";

  return (
    <div
      className={clsx(
        "flex h-9 max-w-full items-center gap-2 rounded-lg border px-2 text-xs",
        failed
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : parsed
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-gray-200 bg-gray-50 text-gray-600",
      )}
      title={attachment.error ?? attachment.fileName}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : failed ? (
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 max-w-[180px] truncate font-medium">{attachment.fileName}</span>
      <span className="shrink-0 text-gray-400">{formatFileSize(attachment.fileSize)}</span>
      <span className="shrink-0">{getAttachmentStatusLabel(attachment.status)}</span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-white hover:text-gray-900"
        aria-label={`移除 ${attachment.fileName}`}
        title="移除"
      >
        <X className="h-3.5 w-3.5" />
      </button>
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
  patchHistoryItems,
  patchHistoryOpen,
  patchHistoryLoading,
  patchHistoryError,
  patchActionLoadingId,
  patchConfirmationDrafts,
  qaActionLoading,
  versionActionLoading,
  onPreviewTabChange,
  onDeviceModeChange,
  onLocalEditToggle,
  onSelectPrdSection,
  onSelectPrototypeRegion,
  onClearSelectedRegion,
  onPatchHistoryToggle,
  onRefreshPatchHistory,
  onCancelPatch,
  onPatchConfirmationChange,
  onConfirmPatch,
  onRunQa,
  onRollbackToVersion,
}: {
  project: WorkspaceProject | null;
  previewTab: PreviewTab;
  deviceMode: DeviceMode;
  localEditEnabled: boolean;
  selectedRegion: SelectedRegion | null;
  isRunning: boolean;
  patchHistoryItems: PatchRecordItem[];
  patchHistoryOpen: boolean;
  patchHistoryLoading: boolean;
  patchHistoryError: string | null;
  patchActionLoadingId: string | null;
  patchConfirmationDrafts: Record<string, string>;
  qaActionLoading: boolean;
  versionActionLoading: boolean;
  onPreviewTabChange: (tab: PreviewTab) => void;
  onDeviceModeChange: (mode: DeviceMode) => void;
  onLocalEditToggle: () => void;
  onSelectPrdSection: (section: PrdSection) => void;
  onSelectPrototypeRegion: () => void;
  onClearSelectedRegion: () => void;
  onPatchHistoryToggle: () => void;
  onRefreshPatchHistory: () => void;
  onCancelPatch: (patchId: string) => void;
  onPatchConfirmationChange: (patchId: string, value: string) => void;
  onConfirmPatch: (patchId: string, confirmation: string) => void;
  onRunQa: () => void;
  onRollbackToVersion: (version: number) => void;
}) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-slate-100">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        <PreviewTabs activeTab={previewTab} onChange={onPreviewTabChange} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPatchHistoryToggle}
            disabled={!project}
            className={clsx(
              "inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm font-medium",
              patchHistoryOpen
                ? "bg-gray-950 text-white hover:bg-gray-800"
                : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
              !project && "cursor-not-allowed opacity-50",
            )}
          >
            <History className="h-4 w-4" />
            修改历史
          </button>
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
      {previewTab === "qa" ? <QaReportPanel project={project} loading={qaActionLoading} onRunQa={onRunQa} /> : null}
      {previewTab === "state" ? (
        <StatePanel
          project={project}
          rollbackLoading={versionActionLoading}
          onRollbackToVersion={onRollbackToVersion}
        />
      ) : null}
      {patchHistoryOpen ? (
        <PatchHistoryPanel
          items={patchHistoryItems}
          loading={patchHistoryLoading}
          error={patchHistoryError}
          actionLoadingId={patchActionLoadingId}
          confirmationDrafts={patchConfirmationDrafts}
          onRefresh={onRefreshPatchHistory}
          onCancelPatch={onCancelPatch}
          onConfirmationChange={onPatchConfirmationChange}
          onConfirmPatch={onConfirmPatch}
          onClose={onPatchHistoryToggle}
        />
      ) : null}
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
    { key: "state", label: "状态", icon: Database },
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

function PatchHistoryPanel({
  items,
  loading,
  error,
  actionLoadingId,
  confirmationDrafts,
  onRefresh,
  onCancelPatch,
  onConfirmationChange,
  onConfirmPatch,
  onClose,
}: {
  items: PatchRecordItem[];
  loading: boolean;
  error: string | null;
  actionLoadingId: string | null;
  confirmationDrafts: Record<string, string>;
  onRefresh: () => void;
  onCancelPatch: (patchId: string) => void;
  onConfirmationChange: (patchId: string, value: string) => void;
  onConfirmPatch: (patchId: string, confirmation: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="absolute bottom-0 right-0 top-12 z-20 flex w-[360px] flex-col border-l border-gray-200 bg-white shadow-xl">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
          <History className="h-4 w-4" />
          Patch 历史
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
            aria-label="刷新 Patch 历史"
            title="刷新"
          >
            <RefreshCw className={clsx("h-4 w-4", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
            aria-label="关闭 Patch 历史"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-gray-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-sky-600" />
            正在加载 Patch 历史...
          </div>
        ) : items.length ? (
          <div className="space-y-3">
            {items.map((item) => (
              <PatchHistoryItem
                key={item.id}
                item={item}
                loading={actionLoadingId === item.id}
                confirmation={confirmationDrafts[item.id] ?? ""}
                onConfirmationChange={(value) => onConfirmationChange(item.id, value)}
                onConfirm={() => onConfirmPatch(item.id, confirmationDrafts[item.id] ?? "")}
                onCancel={() => onCancelPatch(item.id)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-10 text-center text-sm text-gray-500">
            暂无局部修改记录
          </div>
        )}
      </div>
    </aside>
  );
}

function PatchHistoryItem({
  item,
  loading,
  confirmation,
  onConfirmationChange,
  onConfirm,
  onCancel,
}: {
  item: PatchRecordItem;
  loading: boolean;
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const status = PATCH_STATUS_META[item.status];
  const paths = getPatchImpactPaths(item);
  const canCancel = item.status === "planned" || item.status === "needs_confirmation";
  const needsConfirmation = item.status === "needs_confirmation";

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-gray-950">
            {getSelectedRegionLabel(item.selectedRegion)}
          </div>
          <div className="mt-1 text-xs text-gray-400">{formatRelativeTime(item.createdAt)}</div>
        </div>
        <span className={clsx("inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-xs font-medium", status.className)}>
          {status.label}
        </span>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-gray-600">{item.userInstruction}</p>
      {paths.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {paths.slice(0, 4).map((path) => (
            <span key={path} className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-500">
              {path}
            </span>
          ))}
          {paths.length > 4 ? (
            <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-500">
              +{paths.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-gray-500">
        <span>
          v{item.beforeProductDesignStateVersion ?? "-"} → v{item.afterProductDesignStateVersion ?? "-"}
        </span>
        {canCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            取消
          </button>
        ) : null}
      </div>
      {needsConfirmation ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2">
          <textarea
            value={confirmation}
            onChange={(event) => onConfirmationChange(event.target.value)}
            rows={2}
            placeholder="输入确认说明，留空则按计划应用"
            className="min-h-14 w-full resize-none rounded-md border border-amber-200 bg-white px-2 py-1.5 text-xs leading-5 text-gray-900 outline-none placeholder:text-gray-400 focus:border-amber-300 focus:ring-2 focus:ring-amber-200/60"
          />
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1 rounded-md bg-gray-950 px-2 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            确认并应用
          </button>
        </div>
      ) : null}
      {item.errorMessage ? (
        <div className="mt-3 rounded-md border border-rose-100 bg-rose-50 px-2 py-1.5 text-xs leading-5 text-rose-700">
          {item.errorMessage}
        </div>
      ) : null}
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
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-950">{section.title}</h2>
                  {section.tags?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {section.tags.map((tag) => (
                        <span
                          key={tag}
                          className={clsx(
                            "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
                            tag === "ai_assumption" && "border-amber-200 bg-amber-50 text-amber-700",
                            tag === "knowledge_base" && "border-emerald-200 bg-emerald-50 text-emerald-700",
                            tag === "pending_question" && "border-sky-200 bg-sky-50 text-sky-700",
                            tag === "user_confirmed" && "border-gray-200 bg-gray-50 text-gray-700",
                          )}
                        >
                          {getPrdTagLabel(tag)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
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
              {section.sourcePaths?.length ? (
                <div className="mt-3 text-xs text-gray-400">
                  来源：{section.sourcePaths.join(" / ")}
                </div>
              ) : null}
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

  const target = getFirstPrototypeTarget(project?.prototypeSpec);

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
          <span className="ml-2 truncate text-xs text-gray-500">
            {project?.prototypeEntryFilePath ?? "index.html"}
          </span>
        </div>
        <div className="relative h-[calc(100%-36px)] bg-white">
          <iframe
            title="HTML 原型预览"
            srcDoc={project?.prototypeHtml ?? ""}
            sandbox="allow-scripts"
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
                点击选择{target.label}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatePanel({
  project,
  rollbackLoading,
  onRollbackToVersion,
}: {
  project: WorkspaceProject | null;
  rollbackLoading: boolean;
  onRollbackToVersion: (version: number) => void;
}) {
  const state = project?.productDesignState;

  if (!state) {
    return (
      <PreviewEmpty
        icon={Database}
        title="暂无产品工程状态"
        description="生成需求后，ProductDesignState 的版本、规则和待确认项会显示在这里。"
      />
    );
  }

  const metrics = [
    ["页面", state.counts.pages],
    ["后台配置", state.counts.backendConfigs],
    ["前端规则", state.counts.frontendRules],
    ["业务规则", state.counts.businessRules],
    ["状态规则", state.counts.stateRules],
    ["异常场景", state.counts.exceptionScenarios],
    ["验收标准", state.counts.acceptanceCriteria],
    ["AI 推断", state.counts.assumptions],
    ["待确认", state.counts.pendingQuestions],
    ["已确认事实", state.counts.confirmedFacts],
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-[940px] space-y-4">
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
                <Database className="h-4 w-4" />
                ProductDesignState
              </div>
              <h2 className="mt-2 truncate text-lg font-semibold text-gray-950">{state.title}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1">v{state.version}</span>
                <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1">{state.status}</span>
                {state.updatedAt ? <span>更新于 {formatRelativeTime(state.updatedAt)}</span> : null}
              </div>
            </div>
            <div className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
              单一事实源
            </div>
          </div>
        </div>

        <div className="grid grid-cols-5 gap-3">
          {metrics.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="mt-1 text-xl font-semibold text-gray-950">{value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <StateList
            title="AI 推断"
            empty="暂无 AI 推断"
            items={state.assumptions.map((item) => ({
              id: item.id,
              title: item.content,
              meta: item.status,
            }))}
          />
          <StateList
            title="待确认问题"
            empty="暂无待确认问题"
            items={state.pendingQuestions.map((item) => ({
              id: item.id,
              title: item.question,
              meta: item.status,
            }))}
          />
        </div>
        <VersionTimeline
          items={project?.versionTimeline ?? []}
          currentStateVersion={state.version}
          loading={rollbackLoading}
          onRollbackToVersion={onRollbackToVersion}
        />
      </div>
    </div>
  );
}

function VersionTimeline({
  items,
  currentStateVersion,
  loading,
  onRollbackToVersion,
}: {
  items: VersionTimelineItem[];
  currentStateVersion: number;
  loading: boolean;
  onRollbackToVersion: (version: number) => void;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
          <History className="h-4 w-4" />
          版本时间线
        </div>
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" /> : null}
      </div>
      {items.length ? (
        <div className="mt-4 space-y-3">
          {items.slice(0, 12).map((item) => {
            const canRollback =
              item.type === "product_design_state" &&
              typeof item.version === "number" &&
              item.version < currentStateVersion;
            return (
              <div key={item.id} className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-3">
                <TimelineIcon type={item.type} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-950">{item.title}</span>
                    <span className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-500">
                      {timelineTypeLabel(item.type)}
                    </span>
                  </div>
                  {item.description ? (
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{item.description}</div>
                  ) : null}
                  <div className="mt-1 text-xs text-gray-400">{formatRelativeTime(item.createdAt)}</div>
                </div>
                {canRollback ? (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => onRollbackToVersion(item.version!)}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    回滚
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-8 text-center text-sm text-gray-500">
          暂无版本记录
        </div>
      )}
    </div>
  );
}

function TimelineIcon({ type }: { type: VersionTimelineItem["type"] }) {
  const Icon =
    type === "prd"
      ? FileText
      : type === "prototype"
        ? Code2
        : type === "qa"
          ? ClipboardCheck
          : type === "rollback"
            ? RotateCcw
            : type === "patch"
              ? Edit3
              : Database;
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600">
      <Icon className="h-4 w-4" />
    </div>
  );
}

function timelineTypeLabel(type: VersionTimelineItem["type"]) {
  const labels: Record<VersionTimelineItem["type"], string> = {
    product_design_state: "State",
    prd: "PRD",
    prototype: "原型",
    patch: "Patch",
    qa: "QA",
    rollback: "回滚",
  };
  return labels[type];
}

function StateList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ id: string; title: string; meta: string }>;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-gray-950">{title}</div>
      {items.length ? (
        <div className="mt-3 space-y-2">
          {items.map((item, index) => (
            <div key={item.id || index} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="line-clamp-2 text-sm leading-6 text-gray-800">{item.title}</div>
              <div className="mt-1 text-xs text-gray-500">{item.meta}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
          {empty}
        </div>
      )}
    </div>
  );
}

function QaReportPanel({
  project,
  loading,
  onRunQa,
}: {
  project: WorkspaceProject | null;
  loading: boolean;
  onRunQa: () => void;
}) {
  const status = project?.qaStatus ?? "unchecked";
  const issues = project?.qaIssues ?? [];
  const report = project?.latestQaReport ?? null;

  const action = (
    <button
      type="button"
      onClick={onRunQa}
      disabled={!project || loading}
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      重新 QA
    </button>
  );

  if (status === "unchecked") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[900px]">
          <div className="mb-3 flex justify-end">{action}</div>
          <PreviewEmpty icon={ClipboardCheck} title="未校验" description="PRD 和原型生成后，QA 结果会显示在这里。" />
        </div>
      </div>
    );
  }

  if (status === "checking") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[900px]">
          <div className="mb-3 flex justify-end">{action}</div>
          <PreviewLoading title="校验中..." description="QA Agent 正在检查 PRD、原型和需求输入的一致性。" />
        </div>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[900px]">
          <div className="mb-3 flex justify-end">{action}</div>
          <PreviewError title="校验失败" description="可以稍后重新触发 QA 或补充更多上下文。" />
        </div>
      </div>
    );
  }

  const passed = status === "passed";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-[900px] space-y-4">
        <div className="flex justify-end">{action}</div>
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
                {report?.summary ??
                  (passed
                    ? "PRD、原型和需求输入暂未发现明显冲突。"
                    : "QA Agent 发现以下一致性问题，建议修复后再进入评审。")}
              </p>
              {report ? (
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
                  <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1">State v{report.productDesignStateVersion}</span>
                  {report.trigger ? <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1">{report.trigger}</span> : null}
                  {report.createdAt ? <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1">{formatRelativeTime(report.createdAt)}</span> : null}
                </div>
              ) : null}
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

        {report ? (
          <div className="grid grid-cols-4 gap-3">
            {[
              ["阻塞", report.blockingCount, "text-rose-700"],
              ["重要", report.majorCount, "text-orange-700"],
              ["轻微", report.minorCount, "text-amber-700"],
              ["提示", report.infoCount, "text-sky-700"],
            ].map(([label, value, className]) => (
              <div key={label} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                <div className="text-xs text-gray-500">{label}</div>
                <div className={clsx("mt-1 text-xl font-semibold", className)}>{value}</div>
              </div>
            ))}
          </div>
        ) : null}

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
