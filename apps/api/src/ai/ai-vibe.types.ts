import type { KnowledgeType } from "@prisma/client";

export type KnowledgeReference = {
  id: string;
  knowledgeId?: string;
  title: string;
  snippet?: string;
  content: string;
  type?: KnowledgeType;
  relatedPath?: string;
  usedByRuntime?: string;
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
  prdWritingRules: KnowledgeReference[];
  prototypeRules: KnowledgeReference[];
  businessConcepts: KnowledgeReference[];
  conflicts: KnowledgeConflict[];
  unknownAreas: string[];
  summary: string;
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
    | "intake"
    | "format_check"
    | "scoring"
    | "optimizing"
    | "clarifying"
    | "design_ready"
    | "doc_ready"
    | "doc_confirmed"
    | "prd_ready"
    | "prototype_ready"
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

export type ExportArtifactFormat = "prd_word" | "prototype_html" | "prd_canvas";

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

export type QACheckType =
  | "state_schema"
  | "prd_completeness"
  | "prototype_completeness"
  | "state_prd_consistency"
  | "state_prototype_consistency"
  | "prd_prototype_consistency"
  | "knowledge_rule_compliance"
  | "assumption_risk";

export type QAIssueSeverity = "blocking" | "major" | "minor" | "info";
export type QAReportStatus = "running" | "passed" | "failed" | "warning";
export type QAReportTrigger = "initial_generation" | "manual" | "rollback" | "pre_confirm";
export type QAIssueStatus = "open" | "resolved" | "ignored";
export type QAGateStatus = "open" | "warning" | "blocked";
export type QAGateAction =
  | "confirm_artifacts"
  | "persist_knowledge"
  | "revise_artifacts"
  | "export_or_publish"
  | "run_qa";

export type QAGateDecision = {
  status: QAGateStatus;
  allowConfirmArtifacts: boolean;
  allowPersistKnowledge: boolean;
  allowExportOrPublish: boolean;
  shouldReviseArtifacts: boolean;
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
  relatedRollbackId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  passed: boolean;
  gate: QAGateDecision;
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
  type: "product_design_state" | "prd" | "prototype" | "qa" | "rollback";
  version?: number;
  title: string;
  description?: string;
  relatedId: string;
  createdAt: string;
  createdBy?: string;
};

export type VibeStreamEventType =
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "message_delta"
  | "tool_call_started"
  | "tool_call_completed"
  | "state_updated"
  | "state_version_created"
  | "prd_updated"
  | "prototype_updated"
  | "qa_completed"
  | "rollback_started"
  | "rollback_completed"
  | "rollback_failed"
  | "knowledge_candidate_created"
  | "export_ready"
  | "run_completed"
  | "run_canceled"
  | "run_failed";

export type VibeStreamLegacyEventType =
  | "agent_started"
  | "agent_completed"
  | "state_updated"
  | "state_version_created"
  | "prd_generated"
  | "prototype_generated"
  | "qa_completed";

export type VibeStreamEventProtocol = "vibe.v1";

export type VibeStreamEventCategory =
  | "runtime"
  | "run"
  | "state"
  | "prd"
  | "prototype"
  | "qa"
  | "rollback"
  | "knowledge"
  | "export";

export type VibeStreamEventPhase =
  | "started"
  | "progress"
  | "completed"
  | "canceled"
  | "failed"
  | "created"
  | "updated"
  | "applying";

export type VibeStreamPayloadKind =
  | "runtime_step"
  | "progress"
  | "state"
  | "prd"
  | "prototype"
  | "qa"
  | "rollback"
  | "knowledge"
  | "export"
  | "run";

export type VibeStreamPayloadMeta = {
  schema: "vibe.stream.payload.v1";
  kind: VibeStreamPayloadKind;
  primaryId?: string;
  secondaryId?: string;
  status?: string;
  title?: string;
  summary?: string;
  action?: string;
  counts?: Record<string, number>;
  refs?: Record<string, string>;
};

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
  step?: RuntimeStreamStepName;
  content?: string;
  payloadMeta?: VibeStreamPayloadMeta;
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
  payloadMeta: VibeStreamPayloadMeta;
};

export type RuntimeStreamStepName =
  | "intent_detection"
  | "knowledge_retrieval"
  | "context_fetch"
  | "requirement_analysis"
  | "requirement_packaging"
  | "product_planning"
  | "requirement_validation"
  | "safety_check"
  | "product_design"
  | "prd_generation"
  | "prototype_design"
  | "prototype_code_generation"
  | "qa_check"
  | "knowledge_extraction";
