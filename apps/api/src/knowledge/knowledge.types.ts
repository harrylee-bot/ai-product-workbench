import type {
  KnowledgeCandidateSource,
  KnowledgePriority,
  KnowledgeType,
  ModelTaskType,
} from "@prisma/client";
import type { RequirementMode } from "../ai/requirement-mode.helper";

export type KnowledgeSearchInput = {
  conversationId?: string;
  runId?: string;
  runtimeName?: string;
  query: string;
  taskType?: ModelTaskType | string;
  preferredTypes?: KnowledgeType[];
  strictPreferredTypes?: boolean;
  /** 需求模式：驱动模式偏重类型的排序加权（不收缩召回）。 */
  requirementMode?: RequirementMode;
  /**
   * Markdown knowledge-vault 兜底策略。
   * - on_miss: DB 0 命中时兜底（默认）
   * - always: 生成链路总是补主知识，避免线上 DB 未同步或弱命中导致空跑
   * - never: 只查 DB
   */
  vaultPolicy?: "on_miss" | "always" | "never";
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
  relatedPath?: string;
  visualAssets?: Array<{
    kind: "prototype_snapshot" | "image";
    title?: string;
    path: string;
    note?: string;
  }>;
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
  visualAssets?: Array<{
    kind: "prototype_snapshot" | "image";
    title?: string;
    path: string;
    note?: string;
  }>;
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
  retrievalSource?: "database" | "vault_fallback" | "database_and_vault";
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
