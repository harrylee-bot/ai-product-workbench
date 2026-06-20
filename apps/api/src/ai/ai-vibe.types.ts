import type { AgentName, ModelTaskType, UserIntent } from "@prisma/client";

export type SelectedRegion = {
  type: "document" | "prototype";
  targetId?: string;
  pageId?: string;
  componentId?: string;
  sectionId?: string;
  domSelector?: string;
  textRange?: { start: number; end: number };
  bbox?: { x: number; y: number; width: number; height: number };
  screenshotUrl?: string;
  label?: string;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type AttachmentSummary = {
  fileId: string;
  fileName: string;
  fileType: string;
  summary?: string;
  extractedTextPreview?: string;
};

export type KnowledgeReference = {
  id: string;
  title: string;
  content: string;
  sourceType: "knowledge_base" | "attachment" | "conversation" | "ai_assumption";
  sourceId?: string;
};

export type KnowledgeConflict = {
  id: string;
  description: string;
  references: string[];
};

export type KnowledgeContext = {
  query: string;
  strongRules: KnowledgeReference[];
  defaultRules: KnowledgeReference[];
  referenceCases: KnowledgeReference[];
  designPatterns: KnowledgeReference[];
  conflicts: KnowledgeConflict[];
  unknownAreas: string[];
  summary: string;
};

export type ClarificationQuestion = {
  id: string;
  title: string;
  reason: string;
  options: string[];
  recommendedOption?: string;
};

export type IntentResult = {
  intent: UserIntent;
  confidence: number;
  reason: string;
  requiresSelection: boolean;
  isAmbiguous: boolean;
};

export type RequirementAnalysis = {
  completenessScore: number;
  knownFromUser: string[];
  knownFromKnowledge: string[];
  inferredByAI: string[];
  missingCritical: string[];
  missingOptional: string[];
  conflicts: string[];
  shouldAskUser: boolean;
  clarificationQuestions: ClarificationQuestion[];
};

export type ProductDesignState = {
  id: string;
  projectId: string;
  version: number;
  title: string;
  businessGoal: string;
  background?: string;
  targetUsers: string[];
  userScenarios: string[];
  pages: Array<Record<string, unknown>>;
  features: Array<Record<string, unknown>>;
  backendConfigs: Array<Record<string, unknown>>;
  frontendRules: Array<Record<string, unknown>>;
  businessRules: Array<Record<string, unknown>>;
  stateRules: Array<Record<string, unknown>>;
  exceptionScenarios: Array<Record<string, unknown>>;
  acceptanceCriteria: Array<Record<string, unknown>>;
  assumptions: Array<Record<string, unknown>>;
  knowledgeRefs: KnowledgeReference[];
  pendingQuestions: ClarificationQuestion[];
  prototypeSpec?: PrototypeSpec;
  prdDocument?: RequirementDocumentDraft;
  status:
    | "draft"
    | "clarifying"
    | "design_ready"
    | "prd_ready"
    | "prototype_ready"
    | "patching"
    | "qa_failed"
    | "confirmed";
  createdAt: string;
  updatedAt: string;
};

export type ProductDesignDraft = Omit<
  ProductDesignState,
  "id" | "projectId" | "version" | "prototypeSpec" | "prdDocument" | "status" | "createdAt" | "updatedAt"
>;

export type RequirementDocSection = {
  id: string;
  title: string;
  content: string;
  sourceStatePaths: string[];
};

export type RequirementDocumentDraft = {
  id: string;
  projectId: string;
  title: string;
  sections: RequirementDocSection[];
  knowledgeRefs: KnowledgeReference[];
  assumptions: Array<Record<string, unknown>>;
  validationNotes: string[];
};

export type PrototypeSpec = {
  id: string;
  projectId: string;
  pages: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
  states: Array<Record<string, unknown>>;
  interactions: Array<Record<string, unknown>>;
  dialogs: Array<Record<string, unknown>>;
  styleGuide: Record<string, unknown>;
};

export type PrototypeArtifact = {
  id: string;
  projectId: string;
  html: string;
  entryFile: string;
  previewUrl?: string;
  assets: Array<{ name: string; path: string; type: string }>;
};

export type PatchOperation = {
  op: "add" | "update" | "delete";
  path: string;
  value?: unknown;
  reason: string;
};

export type PatchPlan = {
  patchType: "document" | "prototype" | "state" | "global";
  targetNodes: string[];
  impactScope: string[];
  operations: PatchOperation[];
  needUserConfirm: boolean;
  reason: string;
};

export type QAIssue = {
  level: "error" | "warning" | "info";
  type:
    | "prd_prototype_mismatch"
    | "missing_state"
    | "missing_exception"
    | "knowledge_conflict"
    | "implementation_detail_leak"
    | "patch_scope_risk"
    | "missing_knowledge_reference"
    | "unmarked_assumption";
  message: string;
  targetPath?: string;
};

export type QAReport = {
  passed: boolean;
  issues: QAIssue[];
  suggestions: string[];
  autoFixable: boolean;
};

export type KnowledgeCandidate = {
  id: string;
  title: string;
  content: string;
  sourceType: "prd" | "prototype" | "chat" | "patch";
  sourceId: string;
  confidence: number;
  suggestedSection: string;
  tags: string[];
  status: "pending_review";
};

export type VibeStreamEventType =
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "message_delta"
  | "state_updated"
  | "prd_updated"
  | "prototype_updated"
  | "qa_completed"
  | "knowledge_candidate_created"
  | "run_completed"
  | "run_failed";

export type VibeStreamEvent = {
  runId: string;
  type: VibeStreamEventType;
  step?: AgentStepName;
  content?: string;
  data?: unknown;
  createdAt: string;
};

export type AgentStepName =
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

export type AgentRunContext = {
  runId: string;
  projectId: string;
  conversationId: string;
  userId: string;
  userInput: string;
  selectedRegion?: SelectedRegion;
  previewMode?: "prd" | "prototype";
  conversationSummary?: string;
  recentMessages: ConversationMessage[];
  attachments: AttachmentSummary[];
  productDesignState?: ProductDesignState;
  knowledgeContext?: KnowledgeContext;
  intentResult?: IntentResult;
  requirementAnalysis?: RequirementAnalysis;
  traceId: string;
};

export type AgentInvocation<TInput, TOutput> = {
  runId: string;
  projectId: string;
  traceId: string;
  userId: string;
  input: TInput;
};

export type AgentOutput<T> = {
  data: T;
  modelCallLogId?: string;
};

export type ModelBackedAgent = {
  agentName: AgentName;
  taskType: ModelTaskType;
};
