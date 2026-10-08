import type {
  ArtifactKind,
  CanvasAgentToolDescriptor,
  KnowledgeToolDescriptor,
  JsonValue,
  RuntimeProgressEvent,
  RuntimeMaterializedDesignStyleSnapshot,
  RuntimeOutcome,
  RuntimeResumeDecision,
  StartRunRequest,
  PrototypeAsset,
  PrototypeDocument,
} from "@workbench/workbench-contracts";
import type { RuntimeProviderTextState } from "./runtime-assistant-text.js";

export { runtimeExternalFinalizationEvent } from "./runtime-assistant-text.js";

export type RuntimeThreadMetadata = {
  workbenchProjectId: string;
  workbenchThreadId: string;
  workbenchPrincipalId: string;
};

export type RuntimeContentLocator = {
  storageKey: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
};

export type RuntimeSource = {
  position: number;
  sourceId: string;
  sourceKind: "file" | "design_md" | "url_snapshot" | "github_snapshot" | "figma_snapshot";
  blobId: string;
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  original: RuntimeContentLocator;
  extraction: {
    kind: string;
    position: number;
    content: RuntimeContentLocator;
  } | null;
};

export type RuntimeDesignAsset = {
  assetId: string;
  name: string;
  kind: "image" | "font";
  artifactVersionId: string;
  blobId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  content: RuntimeContentLocator;
};

export type RuntimeArtifactTargetAsset = {
  artifactVersionId: string;
  assetId: string;
  kind: "image" | "font";
  blobId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  metadata: Extract<PrototypeAsset, { kind: "image" | "font" }>;
  content: RuntimeContentLocator;
};

export type RuntimeArtifactTarget = {
  artifactId: string;
  artifactVersionId: string;
  screenIds: string[];
  kind: ArtifactKind;
  schemaVersion: number;
  checksum: string;
  content:
    | { mode: "inline"; value: JsonValue }
    | { mode: "blob"; blobId: string; locator: RuntimeContentLocator };
  assets: RuntimeArtifactTargetAsset[];
};

export type RuntimePrototypePatchBaseline = {
  artifactIndex: number;
  artifactVersionId: string;
  document: PrototypeDocument;
  screens: Array<{
    screenId: string;
    revision: number;
    checksum: string;
    status: "active" | "degraded";
    recoveryRevision: number | null;
  }>;
};

export type RuntimeSubmissionState =
  | {
      mode: "submit";
      providerIdempotencyKey: string;
    }
  | {
      mode: "reconcile";
      providerIdempotencyKey: string;
    }
  | {
      mode: "join";
      providerIdempotencyKey: string;
      externalRunId: string;
      lastExternalEventId: string | null;
    };

export type RuntimeExecution = {
  runId: string;
  runtimeAttemptId: string;
  attempt: number;
  projectId: string;
  threadId: string;
  runtimeTransportOwnerId: string;
  externalThreadId: string;
  request: StartRunRequest;
  artifactTargets: RuntimeArtifactTarget[];
  prototypePatchBaselines: RuntimePrototypePatchBaseline[];
  sources: RuntimeSource[];
  designAssets: RuntimeDesignAsset[];
  knowledgeTool: KnowledgeToolDescriptor | null;
  canvasTool?: CanvasAgentToolDescriptor | null;
  designStyleSnapshot: RuntimeMaterializedDesignStyleSnapshot | null;
  resume: RuntimeResumeDecision[] | null;
  providerTextState: RuntimeProviderTextState;
  submission: RuntimeSubmissionState;
};

export type RuntimeExternalEventPart = {
  externalRunId: string;
  externalEventId: string;
  event: string;
  payload: JsonValue;
};

export type RuntimeExecutionObserver = {
  onSubmissionStarted: () => Promise<void>;
  onExternalRunCreated: (externalRunId: string) => Promise<void>;
  isExternalEventProcessed: (part: RuntimeExternalEventPart) => Promise<boolean>;
  onExternalEvent: (
    part: RuntimeExternalEventPart,
    effects: RuntimeProgressEvent[],
  ) => Promise<void>;
  onExternalFinalization: (
    part: RuntimeExternalEventPart,
    effects: RuntimeProgressEvent[],
  ) => Promise<void>;
};

export const runtimeSubmissionUnknownErrorCodes = [
  "RUNTIME_SUBMISSION_UNKNOWN",
  "RUNTIME_SUBMISSION_RECONCILIATION_UNAVAILABLE",
  "RUNTIME_SUBMISSION_RECONCILIATION_PERSISTENCE_UNKNOWN",
] as const;

export type RuntimeSubmissionUnknownErrorCode =
  typeof runtimeSubmissionUnknownErrorCodes[number];

export class RuntimeSubmissionUnknownError extends Error {
  constructor(
    readonly code: RuntimeSubmissionUnknownErrorCode = "RUNTIME_SUBMISSION_UNKNOWN",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "RuntimeSubmissionUnknownError";
  }
}

export type RuntimeCancellation = {
  runId: string;
  runtimeAttemptId: string;
  runtimeTransportOwnerId: string;
  externalThreadId: string;
  externalRunId: string | null;
};

export type RuntimeCancellationResult =
  | {
      disposition: "not_found";
      externalRunId: null;
      externalStatus: null;
    }
  | {
      disposition: "external_run_absent";
      externalRunId: string;
      externalStatus: null;
    }
  | {
      disposition: "cancelled" | "already_terminal";
      externalRunId: string;
      externalStatus: string;
    };

export interface RuntimePort {
  readonly adapter: string;
  createThread(metadata: RuntimeThreadMetadata, signal?: AbortSignal): Promise<{ externalThreadId: string; metadata: Record<string, unknown> }>;
  execute(
    execution: RuntimeExecution,
    observer: RuntimeExecutionObserver,
    signal?: AbortSignal,
  ): Promise<RuntimeOutcome>;
  cancel(
    cancellation: RuntimeCancellation,
    onExternalRunRecovered: (externalRunId: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<RuntimeCancellationResult>;
}
