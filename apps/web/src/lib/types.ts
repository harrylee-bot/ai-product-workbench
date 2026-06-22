export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export type PublicUser = {
  id: string;
  username: string;
  email?: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};

export type Session = {
  accessToken: string;
  user: PublicUser;
};

export type LoginResponse = Session;

export type AdminUser = {
  id: string;
  username: string;
  email?: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type UsersResponse = {
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
};

export type PaginatedResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminDashboardStats = {
  userCount: number;
  projectCount: number;
  todayAgentRunCount: number;
  todayModelCallCount: number;
  todayFailedModelCallCount: number;
  pendingKnowledgeCandidateCount: number;
  failedFileParseCount: number;
  qaFailedProjectCount: number;
};

export type ModelProviderItem = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  defaultHeaders?: Record<string, unknown>;
  timeoutMs: number;
  isDefault: boolean;
  isEnabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelConfigItem = {
  id: string;
  providerId: string;
  providerName?: string;
  providerEnabled?: boolean;
  displayName: string;
  modelName: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  supportsMultimodal: boolean;
  defaultTemperature: number;
  defaultMaxTokens?: number | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModelTaskProfileItem = {
  id: string;
  taskType: string;
  modelConfigId: string;
  modelName?: string;
  providerId?: string;
  providerName?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  responseFormat: string;
  retryCount: number;
  timeoutMs?: number | null;
  isEnabled: boolean;
  createdAt: string;
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
  categoryId?: string;
  tags: string[];
  priority: string;
  source: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeCandidate = {
  id: string;
  projectId: string;
  title: string;
  content: string;
  summary?: string;
  suggestedType: string;
  suggestedCategoryId?: string;
  suggestedTags: string[];
  confidence: number;
  source: string;
  sourceRefId?: string;
  sourcePath?: string;
  reason: string;
  status: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  createdByRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeVaultEntry = {
  name: string;
  path: string;
  type: "directory" | "markdown" | "file";
  size?: number;
  updatedAt?: string;
};

export type KnowledgeVaultStatus = {
  initialized: boolean;
  rootExists: boolean;
  vaultRoot: string;
  folderCount: number;
  markdownCount: number;
  folders: KnowledgeVaultEntry[];
  recentFiles: KnowledgeVaultEntry[];
};

export type KnowledgeVaultSyncResult = {
  markdownFiles: number;
  chunks: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  categories: string[];
};
