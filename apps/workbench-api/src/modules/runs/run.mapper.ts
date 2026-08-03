import {
  runSourceSnapshotSchema,
  runSchema,
  startRunRequestSchema,
  type Run,
  type RunSourceSnapshot,
} from "@workbench/workbench-contracts";

export const orderedRunSourceSnapshots = { orderBy: { position: "asc" as const } };

export function mapRun(run: {
  id: string;
  requestId: string;
  projectId: string;
  threadId: string;
  retryOfRunId: string | null;
  status: Run["status"];
  modelId: string;
  request: unknown;
  sourceSnapshots: Array<{
    id: string;
    runId: string;
    projectId: string;
    position: number;
    sourceId: string;
    kind: RunSourceSnapshot["kind"];
    label: string;
    checksum: string;
    descriptor: unknown;
    snapshot: unknown;
    createdAt: Date;
  }>;
  knowledgeReleaseId: string | null;
  phase: Run["phase"];
  phaseLabel: string | null;
  progress: number | null;
  attempt: number;
  eventSequence: number;
  cancelRequestedAt: Date | null;
  errorCode: string | null;
  errorDetail: string | null;
  errorRetryable: boolean | null;
  cancellationReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): Run {
  const request = startRunRequestSchema.parse(run.request);
  return runSchema.parse({
    id: run.id,
    requestId: run.requestId,
    projectId: run.projectId,
    threadId: run.threadId,
    retryOfRunId: run.retryOfRunId,
    status: run.status,
    modelId: run.modelId,
    workflow: request.workflow,
    generationIntent: request.generationIntent,
    targetSurface: request.targetSurface,
    designStyle: request.designStyle,
    artifactTargets: request.artifactTargets,
    requestedArtifactKinds: request.requestedArtifactKinds,
    sources: run.sourceSnapshots.map(mapRunSourceSnapshot),
    knowledgeReleaseId: run.knowledgeReleaseId,
    phase: run.phase,
    phaseLabel: run.phaseLabel,
    progress: run.progress,
    attempt: run.attempt,
    lastEventSequence: run.eventSequence,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    failure: mapFailure(run),
    cancellationReason: run.cancellationReason,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  });
}

export function mapRunSourceSnapshot(
  snapshot: Parameters<typeof mapRun>[0]["sourceSnapshots"][number],
): RunSourceSnapshot {
  return runSourceSnapshotSchema.parse({
    ...snapshot,
    createdAt: snapshot.createdAt.toISOString(),
  });
}

function mapFailure(run: {
  errorCode: string | null;
  errorDetail: string | null;
  errorRetryable: boolean | null;
}): Run["failure"] {
  if (run.errorCode === null && run.errorDetail === null && run.errorRetryable === null) return null;
  if (run.errorCode === null || run.errorDetail === null || run.errorRetryable === null) {
    throw new Error("Persisted Run failure snapshot is incomplete");
  }
  return {
    code: run.errorCode,
    message: run.errorCode,
    retryable: run.errorRetryable,
  };
}
