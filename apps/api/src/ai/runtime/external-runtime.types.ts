import type {
  AttachmentSummary,
  ConversationMessage,
  KnowledgeContext,
  PatchPlan,
  ProductDesignDraft,
  ProductDesignState,
  PrototypeSpec,
  PrototypeTargetDevice,
  QAProtocolOutput,
  RequirementDocument,
  RequirementDocumentDraft,
  SelectedRegion,
} from "../ai-vibe.types";

export type RuntimeProvider = "local" | "codex" | "deerflow";

export type RuntimeTaskType =
  | "intake_requirement"
  | "generate_prd"
  | "generate_prototype"
  | "patch_prd"
  | "patch_prototype"
  | "qa_review"
  | "prototype_code_generation";

export type RuntimeEventType =
  | "runtime_task_started"
  | "runtime_step_started"
  | "runtime_message"
  | "runtime_tool_called"
  | "runtime_file_changed"
  | "runtime_artifact_created"
  | "runtime_warning"
  | "runtime_task_completed"
  | "runtime_task_failed";

export type RuntimeTask<TInput = unknown> = {
  id: string;
  provider: RuntimeProvider;
  taskType: RuntimeTaskType;
  runId: string;
  projectId: string;
  traceId?: string;
  userId?: string;
  input: TInput;
  outputSchema?: unknown;
  workspaceHint?: string;
};

export type RuntimeEvent = {
  id: string;
  provider: RuntimeProvider;
  taskId: string;
  runId: string;
  type: RuntimeEventType;
  step?: string;
  content?: string;
  payload?: unknown;
  createdAt: string;
};

export type RuntimeResult<TOutput = unknown> = {
  provider: RuntimeProvider;
  taskId: string;
  runId: string;
  status: "completed" | "failed";
  output?: TOutput;
  artifacts?: Array<{
    path: string;
    kind: "file" | "directory" | "patch" | "json" | "html";
    content?: string;
  }>;
  events: RuntimeEvent[];
  raw?: unknown;
};

export interface RuntimeAdapter {
  readonly provider: RuntimeProvider;
  runTask<TInput, TOutput>(task: RuntimeTask<TInput>): Promise<RuntimeResult<TOutput>>;
}

export type RequirementRuntimeInput = {
  userInput: string;
  conversationId: string;
  recentMessages: ConversationMessage[];
  attachments: AttachmentSummary[];
  productDesignState?: ProductDesignState;
  selectedRegion?: SelectedRegion;
  previewMode?: string;
};

export type RequirementRuntimeOutput = {
  productDesignDraft: ProductDesignDraft;
  requirementDocumentDraft?: RequirementDocumentDraft;
  message?: string;
  clarificationQuestions?: Array<Record<string, unknown>>;
  risks?: Array<Record<string, unknown>>;
};

export type PrototypeSpecRuntimeInput = {
  productDesignState: ProductDesignState;
  targetDevice: PrototypeTargetDevice;
  generatedByRunId?: string;
};

export type PatchPlanRuntimeInput = {
  userInput: string;
  selectedRegion: SelectedRegion;
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  knowledgeContext?: KnowledgeContext;
};

export type QaRuntimeInput = {
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  patchPlan?: PatchPlan;
  knowledgeContext?: KnowledgeContext;
};

export type PrototypeSpecRuntimeOutput = PrototypeSpec;
export type PatchPlanRuntimeOutput = PatchPlan;
export type QaRuntimeOutput = QAProtocolOutput;
