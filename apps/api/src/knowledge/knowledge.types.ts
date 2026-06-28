import type {
  KnowledgeCandidateSource,
  KnowledgePriority,
  KnowledgeType,
  ModelTaskType,
} from "@prisma/client";

export type KnowledgeSearchInput = {
  projectId?: string;
  productId?: string;
  conversationId?: string;
  runId?: string;
  runtimeName?: string;
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
  score?: number;
  semanticScore?: number;
  reason?: string;
  relatedPath?: string;
  usedByRuntime?: string;
  sourceType: "knowledge_base";
  sourceId?: string;
};

export type KnowledgeSearchOutput = {
  results: KnowledgeRetrievalResult[];
  references: KnowledgeReference[];
  topScore?: number;
  matchedCount: number;
  selectedCount: number;
  retrievalError?: string;
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
