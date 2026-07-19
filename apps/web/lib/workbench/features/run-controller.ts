"use client";

import type { Run, RunEvent } from "@workbench/workbench-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { workbenchQueryKeys } from "../query/keys";
import {
  createRunProjection,
  reduceRunEvent,
  type RunProjectionState,
} from "../run/reducer";
import { subscribeRunEvents, type RunStreamState } from "../run/stream";
import { useWorkbenchTransport } from "../transport/context";
import {
  createWorkbenchPrototypePatchProjector,
} from "./prototype-patches";

type RunControllerConnectionState = "idle" | RunStreamState;

export function useWorkbenchRunController({
  run,
  enabled = true,
}: {
  run: Run | null | undefined;
  enabled?: boolean;
}) {
  const { baseUrl } = useWorkbenchTransport();
  const queryClient = useQueryClient();
  const prototypePatchProjector = useMemo(
    () => createWorkbenchPrototypePatchProjector({ baseUrl }),
    [baseUrl],
  );
  const runIdentity = run
    ? `${run.id}:${run.requestId}:${run.projectId}:${run.threadId}`
    : "none";
  const initialProjection = useMemo(
    () => run ? createRunProjection(run) : null,
    // The identity fields define the event stream; status changes are supplied by events/query cache.
    [runIdentity],
  );
  const [projection, setProjection] = useState<RunProjectionState | null>(initialProjection);
  const [connectionState, setConnectionState] = useState<RunControllerConnectionState>("idle");
  const [error, setError] = useState<unknown>(null);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);

  useEffect(() => {
    setProjection(initialProjection);
  }, [initialProjection]);

  useEffect(() => () => prototypePatchProjector.dispose(), [prototypePatchProjector]);

  useEffect(() => {
    if (!run || !enabled || (isTerminalStatus(run.status) && run.lastEventSequence === 0)) {
      prototypePatchProjector.setScope(run ? {
        attempt: run.attempt,
        projectId: run.projectId,
        requestId: run.requestId,
        runId: run.id,
      } : null);
      setConnectionState(run && isTerminalStatus(run.status) ? "closed" : "idle");
      return;
    }

    const abortController = new AbortController();
    let current = createRunProjection(run);
    const recoveryBoundary = run.lastEventSequence;
    prototypePatchProjector.setScope({
      attempt: run.attempt,
      projectId: run.projectId,
      requestId: run.requestId,
      runId: run.id,
    });
    setProjection(current);
    setError(null);

    void subscribeRunEvents({
      runId: run.id,
      baseUrl,
      signal: abortController.signal,
      onStateChange: setConnectionState,
      onEvent(event) {
        current = reduceRunEvent(current, event);
        prototypePatchProjector.ingest(event);
        const projectionOnlyEvent = isPrototypePatchProjectionEvent(event);
        if (
          current.lastSequence >= recoveryBoundary
          && !projectionOnlyEvent
        ) setProjection(current);
        if (!projectionOnlyEvent) updateRunCache(queryClient, run, current);
        invalidateForRunEvent(queryClient, event);
      },
    }).catch((streamError: unknown) => {
      if (abortController.signal.aborted) return;
      setError(streamError);
      setConnectionState("closed");
    });

    return () => abortController.abort();
  }, [baseUrl, enabled, prototypePatchProjector, queryClient, runIdentity, subscriptionVersion]);

  const reconnect = useCallback(() => setSubscriptionVersion((value) => value + 1), []);
  return { projection, prototypePatchProjector, connectionState, error, reconnect };
}

function updateRunCache(
  queryClient: ReturnType<typeof useQueryClient>,
  run: Run,
  projection: RunProjectionState,
): void {
  queryClient.setQueryData<Run>(workbenchQueryKeys.run(run.id), (current) => ({
    ...(current ?? run),
    status: projection.status,
    phase: projection.phase,
    phaseLabel: projection.phaseLabel,
    progress: projection.progress,
    attempt: projection.attempt ?? (current ?? run).attempt,
    lastEventSequence: Math.max((current ?? run).lastEventSequence, projection.lastSequence),
    failure: projection.failure,
    cancellationReason: projection.cancellationReason,
  }));
}

function invalidateForRunEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  event: RunEvent,
): void {
  const invalidations: Promise<unknown>[] = [];
  if (
    event.type === "run.queued"
    || event.type === "run.started"
    || event.type === "run.phase.changed"
    || event.type === "run.input.required"
    || event.type === "run.input.submitted"
    || event.type === "run.cancel.requested"
    || event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled"
  ) {
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.runLists(event.projectId, event.threadId),
    }));
  }
  if (
    event.type === "message.completed"
    || event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled"
  ) {
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.entryLists(event.projectId, event.threadId),
    }));
  }
  if (
    event.type === "run.input.required"
    || event.type === "run.input.submitted"
  ) {
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.approvals(event.runId),
    }));
  }
  if (
    event.type === "artifact.version.created"
    || event.type === "run.completed"
  ) {
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.board(event.projectId),
    }));
  }
  if (event.type === "artifact.version.created") {
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.artifactLists(event.projectId),
    }));
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.artifact(event.projectId, event.payload.artifactId),
    }));
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.artifactVersionLists(
        event.projectId,
        event.payload.artifactId,
      ),
    }));
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.artifactVersion(
        event.projectId,
        event.payload.artifactId,
        event.payload.artifactVersionId,
      ),
    }));
  } else if (event.type === "run.completed") {
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.artifacts(event.projectId),
    }));
  }
  if (
    event.type === "artifact.version.created"
    || event.type === "run.input.required"
    || event.type === "run.input.submitted"
    || event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled"
  ) {
    invalidations.push(queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.bootstrap(event.projectId),
    }));
  }
  void Promise.all(invalidations);
}

function isTerminalStatus(status: Run["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isPrototypePatchProjectionEvent(event: RunEvent): boolean {
  return event.type === "artifact.prototype.patch.created"
    || event.type === "artifact.prototype.patch.degraded";
}
