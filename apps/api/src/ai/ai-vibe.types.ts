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
  question?: string;
  reason: string;
  options: string[];
  recommendedOption?: string;
  recommendation?: string;
  relatedPath?: string;
  status?: "pending" | "answered" | "skipped";
  required?: boolean;
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
  summary?: string;
  businessGoal: string;
  background?: string;
  targetUsers: Array<Record<string, unknown>>;
  userScenarios: Array<Record<string, unknown>>;
  pages: Array<Record<string, unknown>>;
  features: Array<Record<string, unknown>>;
  backendConfigs: Array<Record<string, unknown>>;
  frontendRules: Array<Record<string, unknown>>;
  businessRules: Array<Record<string, unknown>>;
  stateRules: Array<Record<string, unknown>>;
  exceptionScenarios: Array<Record<string, unknown>>;
  acceptanceCriteria: Array<Record<string, unknown>>;
  prototypeOutline?: Record<string, unknown>;
  assumptions: Array<Record<string, unknown>>;
  knowledgeRefs: Array<Record<string, unknown>>;
  pendingQuestions: Array<Record<string, unknown>>;
  confirmedFacts: Array<Record<string, unknown>>;
  prototypeSpec?: PrototypeSpec;
  prdDocument?: RequirementDocument;
  status:
    | "draft"
    | "clarifying"
    | "design_ready"
    | "prd_ready"
    | "prototype_ready"
    | "patching"
    | "qa_failed"
    | "confirmed";
  createdBy: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductDesignDraft = Omit<
  ProductDesignState,
  "id" | "version" | "prototypeSpec" | "prdDocument" | "status" | "createdAt" | "updatedAt"
>;

export type RequirementDocTag =
  | "ai_assumption"
  | "knowledge_base"
  | "user_confirmed"
  | "pending_question";

export type RequirementDocSectionType =
  | "overview"
  | "background"
  | "business_goal"
  | "target_users"
  | "user_scenarios"
  | "scope"
  | "page_requirements"
  | "backend_configs"
  | "frontend_rules"
  | "business_rules"
  | "state_rules"
  | "exception_scenarios"
  | "acceptance_criteria"
  | "assumptions"
  | "knowledge_refs"
  | "pending_questions"
  | "appendix";

export type RequirementDocBlock = {
  id: string;
  type: "paragraph" | "bullet_list" | "table" | "quote" | "warning" | "info";
  content: string;
  sourcePaths?: string[];
  tags?: RequirementDocTag[];
};

export type RequirementDocSection = {
  id: string;
  title: string;
  type: RequirementDocSectionType;
  level: 1 | 2 | 3;
  order: number;
  content: string;
  blocks?: RequirementDocBlock[];
  sourcePaths: string[];
  tags?: RequirementDocTag[];
  createdAt?: string;
  updatedAt?: string;
  sourceStatePaths?: string[];
};

export type AssumptionReference = {
  assumptionId: string;
  content: string;
  relatedSectionIds: string[];
  status: "pending" | "confirmed" | "rejected";
};

export type ClarificationQuestionReference = {
  questionId: string;
  question: string;
  reason: string;
  relatedSectionIds: string[];
  status: "pending" | "answered" | "skipped";
};

export type RequirementDocumentStatus = "draft" | "generating" | "ready" | "failed" | "confirmed";

export type RequirementDocument = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  status: RequirementDocumentStatus;
  sections: RequirementDocSection[];
  assumptions: AssumptionReference[];
  knowledgeRefs: Array<Record<string, unknown>>;
  pendingQuestions: ClarificationQuestionReference[];
  validationNotes: string[];
  generatedByRunId?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type RequirementDocumentDraft = {
  id?: string;
  projectId: string;
  title: string;
  sections: RequirementDocSection[];
  knowledgeRefs: Array<Record<string, unknown>>;
  assumptions: AssumptionReference[];
  pendingQuestions: ClarificationQuestionReference[];
  validationNotes: string[];
};

export type RequirementDocumentVersion = {
  id: string;
  documentId: string;
  projectId: string;
  version: number;
  snapshot: RequirementDocument;
  reason?: string;
  createdBy: string;
  createdAt: string;
};

export type PrototypeTargetDevice = "desktop" | "mobile" | "both";
export type PrototypeArtifactStatus = "generating" | "ready" | "failed";

export type PrototypeStyleGuide = {
  tone: "professional" | "clean" | "business" | "consumer" | "dashboard" | "mobile_app";
  primaryColor?: string;
  backgroundColor?: string;
  layoutDensity: "compact" | "comfortable" | "spacious";
  borderRadius: "none" | "small" | "medium" | "large";
  typography?: {
    fontFamily?: string;
    titleSize?: string;
    bodySize?: string;
  };
  notes?: string[];
};

export type PrototypeComponentSpec = {
  id: string;
  name: string;
  type:
    | "header"
    | "nav"
    | "hero"
    | "card"
    | "form"
    | "input"
    | "button"
    | "table"
    | "tabs"
    | "modal"
    | "drawer"
    | "list"
    | "empty_state"
    | "status_badge"
    | "calendar"
    | "timeline"
    | "chart_placeholder"
    | "image_placeholder"
    | "custom";
  description?: string;
  content?: string;
  props?: Record<string, unknown>;
  children?: PrototypeComponentSpec[];
  states?: string[];
  interactions?: string[];
  sourcePaths: string[];
};

export type PrototypePageState = {
  id: string;
  name: string;
  description: string;
  visibleComponents?: string[];
  hiddenComponents?: string[];
  disabledComponents?: string[];
  copyChanges?: Record<string, string>;
  sourcePaths: string[];
};

export type PrototypePageSpec = {
  id: string;
  name: string;
  route?: string;
  sourcePageId?: string;
  device: "desktop" | "mobile" | "responsive";
  layout:
    | "single_column"
    | "two_column"
    | "dashboard"
    | "form"
    | "list"
    | "detail"
    | "mobile_page"
    | "custom";
  description?: string;
  components: PrototypeComponentSpec[];
  states?: PrototypePageState[];
  sourcePaths: string[];
  order: number;
};

export type PrototypeNavigation = {
  id: string;
  fromPageId: string;
  toPageId: string;
  triggerComponentId?: string;
  label?: string;
};

export type PrototypeInteraction = {
  id: string;
  pageId: string;
  componentId: string;
  event: "click" | "change" | "submit" | "hover";
  action:
    | "navigate"
    | "open_modal"
    | "close_modal"
    | "toggle_state"
    | "show_toast"
    | "switch_tab"
    | "update_mock_data";
  targetPageId?: string;
  targetComponentId?: string;
  mockResult?: string;
  sourcePaths: string[];
};

export type PrototypeSpec = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  targetDevice: PrototypeTargetDevice;
  styleGuide: PrototypeStyleGuide;
  pages: PrototypePageSpec[];
  navigation: PrototypeNavigation[];
  interactions: PrototypeInteraction[];
  assumptions: AssumptionReference[];
  knowledgeRefs: Array<Record<string, unknown>>;
  generatedByRunId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type PrototypeArtifact = {
  id: string;
  projectId: string;
  prototypeSpecId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  status: PrototypeArtifactStatus;
  htmlContent?: string;
  entryFilePath?: string;
  previewUrl?: string;
  targetDevice: PrototypeTargetDevice;
  pageCount: number;
  generatedByRunId?: string;
  errorMessage?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  html?: string;
  entryFile?: string;
  assets: Array<{ name: string; path: string; type: string }>;
};

export type PrototypeArtifactDraft = {
  id?: string;
  projectId: string;
  prototypeSpecId?: string;
  productDesignStateId?: string;
  productDesignStateVersion?: number;
  title?: string;
  status?: PrototypeArtifactStatus;
  htmlContent?: string;
  html?: string;
  entryFilePath?: string;
  entryFile?: string;
  previewUrl?: string;
  targetDevice?: PrototypeTargetDevice;
  pageCount?: number;
  generatedByRunId?: string;
  errorMessage?: string;
  assets?: Array<{ name: string; path: string; type: string }>;
};

export type PrototypeVersion = {
  id: string;
  projectId: string;
  artifactId: string;
  version: number;
  prototypeSpecSnapshot: PrototypeSpec;
  artifactSnapshot: PrototypeArtifact;
  reason?: string;
  createdBy: string;
  createdAt: string;
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
  | "state_version_created"
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
