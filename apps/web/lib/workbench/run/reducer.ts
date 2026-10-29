import type {
  ArtifactVersionReference,
  GenerationPreview,
  Run,
  RunEvent,
  RunGenerationStage,
  RunStatus,
} from "@workbench/workbench-contracts";

import { RunProtocolError } from "./protocol-error";

type RunEventOf<TType extends RunEvent["type"]> = Extract<RunEvent, { type: TType }>;

export type RunMessageProjection = {
  entryId: string;
  text: string;
  status: "streaming" | "completed";
};

export type RunActivityProjection = RunEventOf<"activity.changed">["payload"];
export type RunInputProjection = RunEventOf<"run.input.required">["payload"];
export type RunFailureProjection = RunEventOf<"run.failed">["payload"];
export type RunArtifactDraftProjection = RunEventOf<"artifact.draft.created">["payload"];

export type RunProjectionState = {
  runId: string;
  requestId: string;
  projectId: string;
  threadId: string;
  status: RunStatus;
  lastSequence: number;
  phase: RunEventOf<"run.phase.changed">["payload"]["phase"] | null;
  phaseLabel: string | null;
  progress: number | null;
  queuePosition: number | null;
  attempt: number | null;
  generationStage: RunGenerationStage | null;
  generationStageAttempt: number | null;
  messages: Record<string, RunMessageProjection>;
  messageOrder: string[];
  activities: Record<string, RunActivityProjection>;
  activityOrder: string[];
  artifacts: ArtifactVersionReference[];
  draftArtifacts: Record<string, RunArtifactDraftProjection>;
  draftArtifactOrder: number[];
  generationPreviews: Record<string, GenerationPreview>;
  pendingInputs: Record<string, RunInputProjection>;
  pendingInputOrder: string[];
  failure: RunFailureProjection | null;
  cancellationReason: string | null;
  artifactCount: number | null;
};

export function createRunProjection(run: Run): RunProjectionState {
  return {
    runId: run.id,
    requestId: run.requestId,
    projectId: run.projectId,
    threadId: run.threadId,
    status: run.status,
    lastSequence: 0,
    phase: run.phase,
    phaseLabel: run.phaseLabel,
    progress: run.progress,
    queuePosition: null,
    attempt: run.attempt,
    generationStage: null,
    generationStageAttempt: null,
    messages: {},
    messageOrder: [],
    activities: {},
    activityOrder: [],
    artifacts: [],
    draftArtifacts: {},
    draftArtifactOrder: [],
    generationPreviews: {},
    pendingInputs: {},
    pendingInputOrder: [],
    failure: run.failure,
    cancellationReason: run.cancellationReason,
    artifactCount: null,
  };
}

export function reduceRunEvent(state: RunProjectionState, event: RunEvent): RunProjectionState {
  assertEventIdentity(state, event);
  if (event.sequence <= state.lastSequence) return state;
  if (event.sequence !== state.lastSequence + 1) {
    throw new RunProtocolError(
      `Run event sequence gap: expected ${state.lastSequence + 1}, received ${event.sequence}`,
    );
  }

  const next = { ...state, lastSequence: event.sequence };

  switch (event.type) {
    case "run.queued":
      return {
        ...next,
        status: "queued",
        queuePosition: event.payload.position,
        pendingInputs: {},
        pendingInputOrder: [],
      };
    case "run.started":
      return {
        ...next,
        status: "running",
        attempt: event.payload.attempt,
        generationStage: null,
        generationStageAttempt: null,
        draftArtifacts: {},
        draftArtifactOrder: [],
        generationPreviews: {},
        failure: null,
        cancellationReason: null,
        pendingInputs: {},
        pendingInputOrder: [],
      };
    case "run.generation.stage.changed":
      if (event.payload.attempt !== state.attempt) {
        throw new RunProtocolError(
          `Run generation stage attempt mismatch: expected ${state.attempt ?? "none"}, received ${event.payload.attempt}`,
        );
      }
      return {
        ...next,
        status: state.status === "cancelling" ? "cancelling" : "running",
        generationStage: event.payload.stage,
        generationStageAttempt: event.payload.attempt,
      };
    case "run.phase.changed":
      return {
        ...next,
        status: state.status === "cancelling" ? "cancelling" : "running",
        phase: event.payload.phase,
        phaseLabel: event.payload.label,
        progress: event.payload.progress,
      };
    case "run.input.required": {
      const exists = Boolean(state.pendingInputs[event.payload.approvalId]);
      return {
        ...next,
        status: "waiting_input",
        pendingInputs: {
          ...state.pendingInputs,
          [event.payload.approvalId]: event.payload,
        },
        pendingInputOrder: exists
          ? state.pendingInputOrder
          : [...state.pendingInputOrder, event.payload.approvalId],
      };
    }
    case "run.input.submitted": {
      const pendingInputs = { ...state.pendingInputs };
      delete pendingInputs[event.payload.approvalId];
      return {
        ...next,
        pendingInputs,
        pendingInputOrder: state.pendingInputOrder.filter(
          (approvalId) => approvalId !== event.payload.approvalId,
        ),
      };
    }
    case "message.started":
      return upsertMessage(next, event.payload.entryId, "streaming");
    case "message.delta": {
      const current = state.messages[event.payload.entryId];
      return upsertMessage(
        next,
        event.payload.entryId,
        "streaming",
        `${current?.text ?? ""}${event.payload.delta}`,
      );
    }
    case "message.completed":
      return upsertMessage(next, event.payload.entryId, "completed");
    case "activity.changed": {
      const exists = Boolean(state.activities[event.payload.activityId]);
      return {
        ...next,
        activities: {
          ...state.activities,
          [event.payload.activityId]: event.payload,
        },
        activityOrder: exists
          ? state.activityOrder
          : [...state.activityOrder, event.payload.activityId],
      };
    }
    case "artifact.preview.updated": {
      if (event.payload.attempt !== state.attempt) {
        throw new RunProtocolError("Run generation preview attempt mismatch");
      }
      const preview = event.payload.preview;
      if (state.draftArtifacts[String(preview.artifactIndex)]) return next;
      return { ...next, generationPreviews: { ...state.generationPreviews, [String(preview.artifactIndex)]: preview } };
    }
    case "artifact.draft.created": {
      if (event.payload.attempt !== state.attempt) {
        throw new RunProtocolError(
          `Run Artifact draft attempt mismatch: expected ${state.attempt ?? "none"}, received ${event.payload.attempt}`,
        );
      }
      const key = String(event.payload.artifactIndex);
      const exists = Boolean(state.draftArtifacts[key]);
      const generationPreviews = { ...state.generationPreviews };
      delete generationPreviews[key];
      return {
        ...next,
        generationPreviews,
        status: state.status === "cancelling" ? "cancelling" : "running",
        draftArtifacts: {
          ...state.draftArtifacts,
          [key]: event.payload,
        },
        draftArtifactOrder: exists
          ? state.draftArtifactOrder
          : [...state.draftArtifactOrder, event.payload.artifactIndex],
      };
    }
    case "artifact.prototype.patch.created":
    case "artifact.prototype.patch.degraded":
      return next;
    case "artifact.version.created": {
      const exists = state.artifacts.some(
        (artifact) => artifact.artifactVersionId === event.payload.artifactVersionId,
      );
      return {
        ...next,
        artifacts: exists ? state.artifacts : [...state.artifacts, event.payload],
      };
    }
    case "run.cancel.requested":
      return { ...next, status: "cancelling" };
    case "run.cancelled":
      return {
        ...next,
        generationPreviews: {},
        status: "cancelled",
        generationStage: null,
        generationStageAttempt: null,
        draftArtifacts: {},
        draftArtifactOrder: [],
        pendingInputs: {},
        pendingInputOrder: [],
        cancellationReason: event.payload.reason,
      };
    case "run.completed":
      return {
        ...next,
        generationPreviews: {},
        status: "succeeded",
        progress: 1,
        generationStage: null,
        generationStageAttempt: null,
        pendingInputs: {},
        pendingInputOrder: [],
        artifactCount: event.payload.artifactCount,
      };
    case "run.failed":
      return {
        ...next,
        generationPreviews: {},
        status: "failed",
        generationStage: null,
        generationStageAttempt: null,
        draftArtifacts: {},
        draftArtifactOrder: [],
        pendingInputs: {},
        pendingInputOrder: [],
        failure: event.payload,
      };
    default:
      return assertNever(event);
  }
}

function upsertMessage(
  state: RunProjectionState,
  entryId: string,
  status: RunMessageProjection["status"],
  text?: string,
): RunProjectionState {
  const current = state.messages[entryId];
  return {
    ...state,
    messages: {
      ...state.messages,
      [entryId]: {
        entryId,
        text: text ?? current?.text ?? "",
        status,
      },
    },
    messageOrder: current ? state.messageOrder : [...state.messageOrder, entryId],
  };
}

function assertEventIdentity(state: RunProjectionState, event: RunEvent): void {
  if (
    event.runId !== state.runId
    || event.requestId !== state.requestId
    || event.projectId !== state.projectId
    || event.threadId !== state.threadId
  ) {
    throw new RunProtocolError(`Run event ${event.id} does not belong to run ${state.runId}`);
  }
}

function assertNever(value: never): never {
  throw new RunProtocolError(`Unsupported run event: ${JSON.stringify(value)}`);
}
