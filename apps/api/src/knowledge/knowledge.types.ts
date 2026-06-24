import type {
  KnowledgeCandidateSource,
  KnowledgePriority,
  KnowledgeStatus,
  KnowledgeType,
  ModelTaskType,
} from "@prisma/client";

export type KnowledgeSearchInput = {
  projectId?: string;
  conversationId?: string;
  runId?: string;
  agentName?: string;
  query: string;
  taskType?: ModelTaskType | string;
  preferredTypes?: KnowledgeType[];
  strictPreferredTypes?: boolean;
  limit?: number;
};

export type KnowledgeRetrievalResult = {
  itemId: string;
  title: string;
  content: string;
  summary?: string;
  type: KnowledgeType;
  priority: KnowledgePriority;
  score: number;
  keywordScore?: number;
  semanticScore?: number;
  reason: string;
};

export type KnowledgeReference = {
  id: string;
  knowledgeId: string;
  title: string;
  snippet: string;
  content: string;
  type: KnowledgeType;
  relatedPath?: string;
  usedByAgent?: string;
  sourceType: "knowledge_base";
  sourceId?: string;
};

export type KnowledgeSearchOutput = {
  results: KnowledgeRetrievalResult[];
  references: KnowledgeReference[];
};

export type KnowledgeCandidateDraft = {
  title: string;
  content: string;
  summary?: string;
  suggestedType: KnowledgeType;
  suggestedCategoryName?: string;
  suggestedCategoryId?: string;
  suggestedTags: string[];
  confidence: number;
  source?: KnowledgeCandidateSource;
  sourceRefId?: string;
  sourcePath?: string;
  reason: string;
};

export type KnowledgeItemView = {
  id: string;
  title: string;
  content: string;
  summary?: string;
  type: KnowledgeType;
  status: KnowledgeStatus;
  scope: string;
  categoryId?: string;
  tags: string[];
  priority: KnowledgePriority;
  source: string;
  sourceProjectId?: string;
  sourceFileId?: string;
  sourcePrdDocumentId?: string;
  sourcePrototypeArtifactId?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};
