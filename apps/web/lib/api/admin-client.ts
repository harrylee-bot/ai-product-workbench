"use client";

import { nestFetch } from "@/lib/api/nest-client";
import type { SystemHealth } from "@/lib/api/nest-client";

export type PageResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminDashboardStats = {
  userCount: number;
  conversationCount: number;
  todayRuntimeRunCount: number;
  todayModelCallCount: number;
  todayFailedModelCallCount: number;
  pendingKnowledgeCandidateCount: number;
  failedFileParseCount: number;
  qaFailedReportCount: number;
};

export type { SystemHealth };

export type AdminUser = {
  id: string;
  username: string;
  email?: string;
  displayName: string;
  role: "admin" | "user" | string;
  status: "active" | "disabled" | string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminConversation = {
  id: string;
  title: string;
  summary?: string;
  status: string;
  ownerId: string;
  ownerName: string;
  messageCount: number;
  fileCount: number;
  qaReportCount: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeRunLog = {
  id: string;
  conversationId: string;
  conversationTitle: string;
  userName: string;
  intent?: string;
  status: string;
  inputSummary?: string;
  outputSummary?: string;
  streamEventCount: number;
  traceId?: string;
  errorMessage?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
};

export type ModelCallLog = {
  id: string;
  traceId?: string;
  runId?: string;
  runtimeName?: string;
  taskType: string;
  providerName?: string;
  modelDisplayName?: string;
  modelName: string;
  status: string;
  totalTokens?: number;
  durationMs?: number;
  errorMessage?: string;
  createdAt: string;
};

export type FileParseLog = {
  id: string;
  conversationId: string;
  conversationTitle: string;
  uploaderName: string;
  originalName: string;
  extension?: string;
  size: number;
  status: string;
  parseResult?: {
    parserType?: string;
    parseError?: string;
  } | null;
  chunkCount: number;
  createdAt: string;
};

export type PrototypeConversionBackfillResult = {
  matchedCount: number;
  enqueuedCount: number;
  skippedCount: number;
  runRequested: boolean;
  background: boolean;
  backgroundStarted: boolean;
  converterConfigured: boolean;
};

export type QaReportLog = {
  id: string;
  conversationId: string;
  conversationTitle: string;
  trigger: string;
  generatedByRunId?: string;
  status: string;
  blockingCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  summary?: string;
  createdAt: string;
};

export type AuditLog = {
  id: string;
  adminUserId: string;
  adminUsername?: string;
  adminDisplayName?: string;
  action: string;
  targetType: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  userAgent?: string;
  createdAt: string;
};

export type ModelProvider = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  isDefault: boolean;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModelConfig = {
  id: string;
  providerId: string;
  providerName: string;
  displayName: string;
  modelName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  supportsMultimodal: boolean;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModelTaskProfile = {
  id: string;
  taskType: string;
  modelConfigId: string;
  modelDisplayName: string;
  providerName: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: string;
  retryCount?: number;
  timeoutMs?: number;
  isEnabled: boolean;
  updatedAt: string;
};

export type KnowledgeItem = {
  id: string;
  title: string;
  content: string;
  summary?: string;
  type: string;
  status: string;
  scope: string;
  tags: string[];
  priority: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeCandidate = {
  id: string;
  conversationId: string;
  title: string;
  content: string;
  summary?: string;
  suggestedType: string;
  suggestedTags: string[];
  confidence?: number;
  source: string;
  status: string;
  reason?: string;
  createdAt: string;
};

export type DeerflowSkill = {
  name: string;
  description: string;
  license?: string | null;
  category: "public" | "custom" | string;
  enabled: boolean;
};

export type KnowledgeVaultStatus = {
  enabled?: boolean;
  path?: string;
  exists?: boolean;
  initialized?: boolean;
  itemCount?: number;
  lastSyncAt?: string;
} & Record<string, unknown>;

type QueryParams = Record<string, string | number | undefined>;

export function getSystemHealth() {
  return nestFetch<SystemHealth>("/system/health");
}

export function getAdminDashboardStats() {
  return nestFetch<AdminDashboardStats>("/admin/dashboard/stats");
}

export function getAdminUsers(query?: QueryParams) {
  return nestFetch<PageResponse<AdminUser>>(`/admin/users${queryString(query)}`);
}

export function createAdminUser(input: {
  username: string;
  displayName: string;
  email?: string;
  password: string;
  role: "admin" | "user";
  status?: "active" | "disabled";
}) {
  return nestFetch<AdminUser>("/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAdminUser(id: string, input: Partial<AdminUser>) {
  return nestFetch<AdminUser>(`/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function setAdminUserEnabled(id: string, enabled: boolean) {
  return nestFetch<{ success: true }>(
    `/admin/users/${id}/${enabled ? "enable" : "disable"}`,
    { method: "POST" },
  );
}

export function resetAdminUserPassword(id: string, password: string) {
  return nestFetch<{ success: true }>(`/admin/users/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function getAdminConversations(query?: QueryParams) {
  return nestFetch<PageResponse<AdminConversation>>(`/admin/conversations${queryString(query)}`);
}

export function getRuntimeRuns(query?: QueryParams) {
  return nestFetch<PageResponse<RuntimeRunLog>>(
    `/admin/logs/runtime-runs${queryString(query)}`,
  );
}

export function getModelCalls(query?: QueryParams) {
  return nestFetch<PageResponse<ModelCallLog>>(
    `/admin/logs/model-calls${queryString(query)}`,
  );
}

export function getFileParses(query?: QueryParams) {
  return nestFetch<PageResponse<FileParseLog>>(
    `/admin/logs/file-parses${queryString(query)}`,
  );
}

export function backfillPrototypeConversions(input?: {
  conversationId?: string;
  limit?: number;
  run?: boolean;
  force?: boolean;
  background?: boolean;
}) {
  return nestFetch<PrototypeConversionBackfillResult>("/admin/prototype-conversions/backfill", {
    method: "POST",
    body: JSON.stringify(input ?? { run: true, background: true }),
  });
}

export function getQaReports(query?: QueryParams) {
  return nestFetch<PageResponse<QaReportLog>>(
    `/admin/logs/qa-reports${queryString(query)}`,
  );
}

export function getAuditLogs(query?: QueryParams) {
  return nestFetch<PageResponse<AuditLog>>(`/admin/audit-logs${queryString(query)}`);
}

export function getModelProviders() {
  return nestFetch<{ items: ModelProvider[] }>("/admin/model-providers");
}

export function setModelProviderEnabled(id: string, enabled: boolean) {
  return nestFetch<{ success: true }>(
    `/admin/model-providers/${id}/${enabled ? "enable" : "disable"}`,
    { method: "POST" },
  );
}

export function getModelConfigs() {
  return nestFetch<{ items: ModelConfig[] }>("/admin/model-configs");
}

export function updateModelConfig(id: string, input: Partial<ModelConfig>) {
  return nestFetch<ModelConfig>(`/admin/model-configs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getModelTaskProfiles() {
  return nestFetch<{ items: ModelTaskProfile[] }>("/admin/model-task-profiles");
}

export function getKnowledgeVaultStatus() {
  return nestFetch<KnowledgeVaultStatus>("/admin/knowledge/vault");
}

export function syncKnowledgeVault() {
  return nestFetch<unknown>("/admin/knowledge/vault/sync", { method: "POST" });
}

export function getKnowledgeItems(query?: QueryParams) {
  return nestFetch<PageResponse<KnowledgeItem>>(
    `/admin/knowledge/items${queryString(query)}`,
  );
}

export function setKnowledgeItemEnabled(id: string, enabled: boolean) {
  return nestFetch<{ success: true }>(
    `/admin/knowledge/items/${id}/${enabled ? "enable" : "disable"}`,
    { method: "POST" },
  );
}

export function getKnowledgeCandidates(query?: QueryParams) {
  return nestFetch<PageResponse<KnowledgeCandidate>>(
    `/admin/knowledge/candidates${queryString(query)}`,
  );
}

export function approveKnowledgeCandidate(id: string) {
  return nestFetch<unknown>(`/admin/knowledge/candidates/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function rejectKnowledgeCandidate(id: string, reviewComment: string) {
  return nestFetch<unknown>(`/admin/knowledge/candidates/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ reviewComment }),
  });
}

export function getDeerflowSkills() {
  return nestFetch<{ skills: DeerflowSkill[] }>("/admin/deerflow/skills");
}

export function updateDeerflowSkill(name: string, enabled: boolean) {
  return nestFetch<DeerflowSkill>(
    `/admin/deerflow/skills/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    },
  );
}

function queryString(query?: Record<string, string | number | undefined>) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}
