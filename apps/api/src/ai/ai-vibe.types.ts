import type {
  AgentName,
  KnowledgeCandidateSource,
  KnowledgeCandidateStatus,
  KnowledgePriority,
  KnowledgeType,
  ModelTaskType,
  ProjectStatus,
  UserIntent,
} from "@prisma/client";
import type { AgentFallbackMetadata } from "./agent-fallback-policy";

export type SelectedRegion = {
  type: "document" | "prototype";
  targetId?: string;
  documentId?: string;
  artifactId?: string;
  pageId?: string;
  componentId?: string;
  sectionId?: string;
  blockId?: string;
  domSelector?: string;
  sourcePaths?: string[];
  selectedText?: string;
  textRange?: { start: number; end: number };
  bbox?: { x: number; y: number; width: number; height: number };
  boundingBox?: { x: number; y: number; width: number; height: number };
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
  knowledgeId?: string;
  title: string;
  snippet?: string;
  content: string;
  type?: KnowledgeType;
  relatedPath?: string;
  usedByAgent?: string;
  sourceType: "knowledge_base" | "attachment" | "conversation" | "ai_assumption";
  sourceId?: string;
};

export type AgentSkillReference = {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  contentPreview: string;
  capabilities: string[];
  triggerHints: string[];
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
  prdWritingRules: KnowledgeReference[];
  prototypeRules: KnowledgeReference[];
  businessConcepts: KnowledgeReference[];
  agentSkills?: AgentSkillReference[];
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

export type ProductBuildPlanPriority = "must" | "should" | "could";

export type ProductBuildPlanStateCoverage =
  | "default"
  | "loading"
  | "success"
  | "empty"
  | "disabled"
  | "error";

export type ProductBuildPlan = {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  summary: string;
  requirementMode: "formal_requirement" | "requirement_completion" | "prd_generation" | "prototype_generation";
  sourceSummary: {
    userFacts: string[];
    knowledgeFacts: string[];
    assumptions: string[];
    openQuestions: string[];
  };
  scope: {
    inScope: string[];
    outOfScope: string[];
    targetUsers: string[];
    coreScenarios: string[];
  };
  pagePlan: Array<{
    id: string;
    name: string;
    purpose: string;
    priority: ProductBuildPlanPriority;
    sourcePaths: string[];
  }>;
  statePlan: Array<{
    id: string;
    name: string;
    coverage: ProductBuildPlanStateCoverage;
    required: boolean;
    sourcePaths: string[];
  }>;
  deliverables: {
    productDesignState: boolean;
    prd: boolean;
    prototypeSpec: boolean;
    htmlPrototype: boolean;
    qa: boolean;
    knowledgeCandidates: boolean;
  };
  agentSequence: Array<{
    agentName: AgentName;
    step: ModelTaskType;
    input: string[];
    output: string;
    gate?: string;
  }>;
  qaFocus: string[];
  risks: Array<{
    id: string;
    level: "low" | "medium" | "high";
    description: string;
    mitigation: string;
  }>;
  assumptions: string[];
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

export type ExportArtifactFormat = "prd_word" | "prototype_html";

export type ExportArtifactSummary = {
  format: ExportArtifactFormat;
  projectId: string;
  title: string;
  sourceType: "requirement_document" | "prototype_artifact";
  sourceId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  fileName: string;
  contentType: string;
  downloadPath: string;
  sizeBytes: number;
  qaGate?: QAGateDecision;
  generatedAt: string;
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
  op: "add" | "update" | "delete" | "replace" | "remove" | "append";
  path: string;
  value?: unknown;
  reason: string;
};

export type PatchIntent =
  | "copy_change"
  | "rule_change"
  | "layout_change"
  | "state_change"
  | "config_change"
  | "flow_change"
  | "add_requirement"
  | "remove_requirement"
  | "clarification"
  | "unknown";

export type PatchImpactAnalysis = {
  affectedStatePaths: string[];
  affectedPrdSectionIds: string[];
  affectedPrototypePageIds: string[];
  affectedPrototypeComponentIds: string[];
  affectedAcceptanceCriteriaIds: string[];
  requiresPrdRegeneration: boolean;
  requiresPrototypeRegeneration: boolean;
  requiresQaCheck: boolean;
  reason: string;
};

export type RegenerationPlan = {
  prd: "none" | "affected_sections" | "full";
  prototypeSpec: "none" | "affected_pages" | "full";
  htmlPrototype: "none" | "affected_pages" | "full";
  qa: "none" | "basic" | "full";
};

export type PatchRisk = {
  level: "low" | "medium" | "high";
  message: string;
  relatedPaths?: string[];
};

export type PatchPlan = {
  id?: string;
  projectId?: string;
  intent?: PatchIntent;
  selectedRegion?: SelectedRegion;
  impactAnalysis?: PatchImpactAnalysis;
  patchType: "document" | "prototype" | "state" | "global";
  targetNodes: string[];
  impactScope: string[];
  operations: PatchOperation[];
  regenerationPlan?: RegenerationPlan;
  risks?: PatchRisk[];
  needUserConfirm: boolean;
  needsUserConfirmation?: boolean;
  clarificationQuestions?: ClarificationQuestion[];
  reason: string;
  summary?: string;
};

export type PatchRecordStatus =
  | "planned"
  | "applying"
  | "applied"
  | "failed"
  | "cancelled"
  | "needs_confirmation";

export type PatchRecord = {
  id: string;
  projectId: string;
  conversationId: string;
  instructionMessageId?: string;
  selectedRegion: SelectedRegion;
  userInstruction: string;
  patchPlan: PatchPlan;
  operations: PatchOperation[];
  status: PatchRecordStatus;
  beforeProductDesignStateVersion: number;
  afterProductDesignStateVersion?: number;
  affectedPrdDocumentId?: string;
  affectedPrototypeArtifactId?: string;
  relatedQaReportId?: string;
  generatedByRunId?: string;
  errorMessage?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type QACheckType =
  | "state_schema"
  | "prd_completeness"
  | "prototype_completeness"
  | "state_prd_consistency"
  | "state_prototype_consistency"
  | "prd_prototype_consistency"
  | "knowledge_rule_compliance"
  | "assumption_risk"
  | "patch_regression";

export type QAIssueSeverity = "blocking" | "major" | "minor" | "info";
export type QAReportStatus = "running" | "passed" | "failed" | "warning";
export type QAReportTrigger = "initial_generation" | "patch" | "manual" | "rollback" | "pre_confirm";
export type QAIssueStatus = "open" | "resolved" | "ignored";
export type QAGateStatus = "open" | "warning" | "blocked";
export type QAGateAction =
  | "confirm_artifacts"
  | "persist_knowledge"
  | "return_to_patch"
  | "export_or_publish"
  | "run_qa";

export type QAGateDecision = {
  status: QAGateStatus;
  allowConfirmArtifacts: boolean;
  allowPersistKnowledge: boolean;
  allowExportOrPublish: boolean;
  shouldReturnToPatch: boolean;
  reportId?: string;
  reportStatus?: QAReportStatus;
  blockingReasons: string[];
  warnings: string[];
  requiredActions: QAGateAction[];
  evaluatedAt: string;
};

export type QAIssue = {
  id: string;
  checkType: QACheckType;
  severity: QAIssueSeverity;
  title: string;
  description: string;
  relatedStatePaths?: string[];
  relatedPrdSectionIds?: string[];
  relatedPrototypePageIds?: string[];
  relatedPrototypeComponentIds?: string[];
  relatedKnowledgeIds?: string[];
  suggestion?: string;
  autoFixable?: boolean;
  status: QAIssueStatus;
  createdAt?: string;
  updatedAt?: string;
};

export type QAReport = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  prdDocumentId?: string;
  prototypeArtifactId?: string;
  prototypeSpecId?: string;
  status: QAReportStatus;
  trigger: QAReportTrigger;
  checkTypes: QACheckType[];
  summary: string;
  issues: QAIssue[];
  blockingCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  generatedByRunId?: string;
  relatedPatchId?: string;
  relatedRollbackId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  passed: boolean;
  gate: QAGateDecision;
};

export type QAAgentOutput = {
  status: QAReportStatus;
  summary: string;
  issues: QAIssue[];
};

export type RollbackRecord = {
  id: string;
  projectId: string;
  rollbackType: "product_design_state";
  fromProductDesignStateVersion: number;
  toProductDesignStateVersion: number;
  beforePrdDocumentId?: string;
  afterPrdDocumentId?: string;
  beforePrototypeArtifactId?: string;
  afterPrototypeArtifactId?: string;
  reason?: string;
  status: "running" | "completed" | "failed";
  generatedByRunId?: string;
  errorMessage?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectVersionTimelineItem = {
  id: string;
  type: "product_design_state" | "prd" | "prototype" | "patch" | "qa" | "rollback";
  version?: number;
  title: string;
  description?: string;
  relatedId: string;
  createdAt: string;
  createdBy?: string;
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

export type KnowledgeExtractorOutput = {
  candidates: KnowledgeCandidateDraft[];
};

export type KnowledgeCandidate = KnowledgeCandidateDraft & {
  id: string;
  projectId: string;
  source: KnowledgeCandidateSource;
  status: KnowledgeCandidateStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  createdByRunId?: string;
  priority?: KnowledgePriority;
  createdAt: string;
  updatedAt: string;
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
  | "fallback_used"
  | "export_ready"
  | "run_completed"
  | "run_failed";

export type VibeStreamLegacyEventType =
  | "agent_started"
  | "agent_completed"
  | "state_updated"
  | "state_version_created"
  | "prd_generated"
  | "prototype_generated"
  | "patch_applied"
  | "qa_completed";

export type VibeStreamEventProtocol = "vibe.v1";

export type VibeStreamEventCategory =
  | "agent"
  | "run"
  | "state"
  | "prd"
  | "prototype"
  | "patch"
  | "qa"
  | "rollback"
  | "knowledge"
  | "export";

export type VibeStreamEventPhase =
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "created"
  | "updated"
  | "applying";

export type VibeStreamEvent = {
  protocol?: VibeStreamEventProtocol;
  eventId?: string;
  runId: string;
  projectId?: string;
  type: VibeStreamEventType;
  eventType?: VibeStreamEventType;
  legacyEventType?: VibeStreamLegacyEventType;
  category?: VibeStreamEventCategory;
  phase?: VibeStreamEventPhase;
  step?: AgentStepName;
  content?: string;
  payload?: unknown;
  data?: unknown;
  createdAt: string;
};

export type VibeStreamEventEnvelope = VibeStreamEvent & {
  protocol: VibeStreamEventProtocol;
  eventId: string;
  projectId: string;
  eventType: VibeStreamEventType;
  legacyEventType: VibeStreamLegacyEventType;
  category: VibeStreamEventCategory;
  phase: VibeStreamEventPhase;
};

export type AgentStepName =
  | "intent_detection"
  | "knowledge_retrieval"
  | "requirement_analysis"
  | "product_planning"
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
  currentProjectStatus?: ProjectStatus;
  knowledgeContext?: KnowledgeContext;
  intentResult?: IntentResult;
  requirementAnalysis?: RequirementAnalysis;
  productBuildPlan?: ProductBuildPlan;
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
  fallback?: AgentFallbackMetadata;
};

export type ModelBackedAgent = {
  agentName: AgentName;
  taskType: ModelTaskType;
};
