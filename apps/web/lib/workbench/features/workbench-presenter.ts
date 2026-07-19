import {
  threadAssistantMessageContentSchema,
  threadUserPromptContentSchema,
  type Artifact,
  type Run,
  type RunStatus,
  type RunWorkflow,
  type RuntimeModel,
  type ThreadEntry,
} from "@workbench/workbench-contracts";
import { z } from "zod";

import type {
  RunActivityProjection,
  RunMessageProjection,
  RunProjectionState,
} from "../run/reducer";

export type WorkbenchModelChoice = {
  description: string;
  key: string;
  label: string;
  modelId: string;
  workflow: RunWorkflow;
};

export function visibleWorkbenchModelChoices(
  choices: readonly WorkbenchModelChoice[],
  { allowEdit }: { allowEdit: boolean },
): WorkbenchModelChoice[] {
  return choices.filter((choice) => allowEdit || choice.workflow !== "edit");
}

export function toWorkbenchModelChoices(models: readonly RuntimeModel[]): WorkbenchModelChoice[] {
  const modelChoices = models.filter((model) => model.supportedWorkflows.includes("generate")).map((model) => ({
    description: model.description ?? "使用当前运行时提供的模型生成设计。",
    key: `model:${model.id}`,
    label: model.displayName,
    modelId: model.id,
    workflow: "generate" as const,
  }));
  const workflowChoices = ([
    {
      description: "重新设计已有应用或网站；提交前需要添加源截图或文件。",
      label: "Redesign",
      workflow: "redesign" as const,
    },
    {
      description: "围绕问题探索方向并产出可继续执行的设计方案。",
      label: "Ideate",
      workflow: "ideate" as const,
    },
    {
      description: "根据明确要求编辑当前选择的不可变产物版本。",
      label: "Edit",
      workflow: "edit" as const,
    },
  ]).flatMap<WorkbenchModelChoice>((definition) => {
    const model = models.find((candidate) => candidate.supportedWorkflows.includes(definition.workflow));
    return model ? [{
      ...definition,
      key: `workflow:${definition.workflow}:${model.id}`,
      modelId: model.id,
    }] : [];
  });

  return [...modelChoices, ...workflowChoices];
}

export type WorkbenchProjectPhase = "idle" | "generating" | "refining" | "complete";
export type WorkbenchProjectMode = "board" | "document" | "generated";
export type WorkbenchRunStatus = RunStatus | "idle";
export type WorkbenchGenerationProgress = 0 | 1 | 2 | 3;

export type WorkbenchRunPresentation = {
  generationProgress: WorkbenchGenerationProgress;
  phase: WorkbenchProjectPhase;
  runId: string | null;
  runStatus: WorkbenchRunStatus;
};

export function toWorkbenchRunPresentation(
  projection: RunProjectionState | null | undefined,
  _previous?: WorkbenchRunPresentation | null,
): WorkbenchRunPresentation {
  if (!projection) {
    return { generationProgress: 0, phase: "idle", runId: null, runStatus: "idle" };
  }

  const projectedPhase = projection.generationStage
    ? generationStageToWorkbenchPhase(projection.generationStage)
    : null;
  const phase = projection.status === "succeeded"
    ? "complete"
    : projectedPhase
      ?? (isActiveRunStatus(projection.status) ? "generating" : "idle");

  const generationProgress = projection.status === "succeeded"
    ? 3
    : generationStageToProgress(projection.generationStage);

  return {
    generationProgress,
    phase,
    runId: projection.runId,
    runStatus: projection.status,
  };
}

export function toWorkbenchProjectMode(
  artifacts: readonly Artifact[],
  run: Run | null | undefined,
): WorkbenchProjectMode {
  if (artifacts.some((artifact) => artifact.kind === "prototype" && artifact.currentVersion)) {
    return "generated";
  }
  if (artifacts.some((artifact) => artifact.kind === "prd" && artifact.currentVersion)) {
    return "document";
  }
  if (run?.requestedArtifactKinds.includes("prototype")) return "generated";
  if (run?.requestedArtifactKinds.includes("prd")) return "document";
  return "board";
}

export type WorkbenchRunMessageItem = {
  id: string;
  status: RunMessageProjection["status"];
  text: string;
  working: boolean;
};

export type WorkbenchRunActivityItem = {
  detail: string | null;
  id: string;
  label: string;
  status: RunActivityProjection["status"];
  terminal: boolean;
  working: boolean;
};

export function toWorkbenchRunMessageItems(projection: RunProjectionState): WorkbenchRunMessageItem[] {
  return projection.messageOrder.map((id) => {
    const message = projection.messages[id];
    if (!message) throw new WorkbenchPresenterInvariantError(`Run message order references missing message ${id}`);
    return {
      id: message.entryId,
      status: message.status,
      text: message.text,
      working: message.status === "streaming",
    };
  });
}

export function toWorkbenchRunActivityItems(projection: RunProjectionState): WorkbenchRunActivityItem[] {
  return projection.activityOrder.map((id) => {
    const activity = projection.activities[id];
    if (!activity) throw new WorkbenchPresenterInvariantError(`Run activity order references missing activity ${id}`);
    const working = activity.status === "pending" || activity.status === "running";
    return {
      detail: activity.detail,
      id: activity.activityId,
      label: activity.label,
      status: activity.status,
      terminal: !working,
      working,
    };
  });
}

const supportedThreadEntrySchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    kind: z.literal("message"),
    content: threadUserPromptContentSchema,
  }).strict(),
  z.object({
    role: z.literal("assistant"),
    kind: z.literal("message"),
    content: threadAssistantMessageContentSchema,
  }).strict(),
]);

export type WorkbenchParsedThreadEntry =
  | ThreadEntryMetadata & {
      role: "user";
      content: z.infer<typeof threadUserPromptContentSchema>;
    }
  | ThreadEntryMetadata & {
      role: "assistant";
      content: z.infer<typeof threadAssistantMessageContentSchema>;
    };

type ThreadEntryMetadata = {
  createdAt: string;
  id: string;
  kind: "message";
  producedByRunId: string | null;
  sequence: number;
  threadId: string;
};

export type WorkbenchThreadEntryParseResult =
  | { success: true; data: WorkbenchParsedThreadEntry }
  | { success: false; error: z.ZodError };

export function safeParseWorkbenchThreadEntry(entry: ThreadEntry): WorkbenchThreadEntryParseResult {
  const parsed = supportedThreadEntrySchema.safeParse({
    role: entry.role,
    kind: entry.kind,
    content: entry.content,
  });
  if (!parsed.success) return parsed;

  const metadata: ThreadEntryMetadata = {
    createdAt: entry.createdAt,
    id: entry.id,
    kind: "message",
    producedByRunId: entry.producedByRunId,
    sequence: entry.sequence,
    threadId: entry.threadId,
  };
  if (parsed.data.role === "user") {
    return { success: true, data: { ...metadata, role: "user", content: parsed.data.content } };
  }
  return { success: true, data: { ...metadata, role: "assistant", content: parsed.data.content } };
}

export function parseWorkbenchThreadEntry(entry: ThreadEntry): WorkbenchParsedThreadEntry {
  const result = safeParseWorkbenchThreadEntry(entry);
  if (!result.success) throw result.error;
  return result.data;
}

export type WorkbenchThreadMessageItem = {
  createdAt: string;
  id: string;
  producedByRunId: string | null;
  role: "user" | "assistant";
  sequence: number;
  text: string;
};

export function toWorkbenchThreadMessageItem(entry: WorkbenchParsedThreadEntry): WorkbenchThreadMessageItem {
  return {
    createdAt: entry.createdAt,
    id: entry.id,
    producedByRunId: entry.producedByRunId,
    role: entry.role,
    sequence: entry.sequence,
    text: entry.content.text,
  };
}

export class WorkbenchPresenterInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchPresenterInvariantError";
  }
}

function generationStageToWorkbenchPhase(
  stage: NonNullable<RunProjectionState["generationStage"]>,
): WorkbenchProjectPhase {
  return stage === "screen-streaming" || stage === "summarizing" || stage === "screen-stable"
    ? "refining"
    : "generating";
}

function isActiveRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_input" || status === "cancelling";
}

function generationStageToProgress(
  stage: RunProjectionState["generationStage"],
): WorkbenchGenerationProgress {
  if (stage === "screen-streaming") return 1;
  if (stage === "summarizing") return 2;
  if (stage === "screen-stable") return 3;
  return 0;
}
