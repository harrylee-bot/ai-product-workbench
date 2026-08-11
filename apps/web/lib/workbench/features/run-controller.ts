"use client";

import type { Run, RunEvent } from "@workbench/workbench-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { useWorkbenchRun } from "./runs";

type RunControllerConnectionState = "idle" | RunStreamState;
type TerminalRunStatus = Extract<Run["status"], "succeeded" | "failed" | "cancelled">;

const RUN_RECONCILIATION_INTERVAL_MS = 3_000;
const RUN_STREAM_RECOVERY_DELAY_MS = 3_000;

export function useWorkbenchRunController({
  run,
  enabled = true,
}: {
  run: Run | null | undefined;
  enabled?: boolean;
}) {
  const { baseUrl } = useWorkbenchTransport();
  const queryClient = useQueryClient();
  const runQuery = useWorkbenchRun(run?.id ?? "", {
    enabled: enabled && Boolean(run),
    refetchIntervalMs: RUN_RECONCILIATION_INTERVAL_MS,
  });
  const prototypePatchProjector = useMemo(
    () => createWorkbenchPrototypePatchProjector({ baseUrl }),
    [baseUrl],
  );
  const runIdentity = run
    ? `${run.id}:${run.requestId}:${run.projectId}:${run.threadId}`
    : "none";
  const cachedRun = run
    ? queryClient.getQueryData<Run>(workbenchQueryKeys.run(run.id))
    : undefined;
  const observedRun = selectLatestRun(run, cachedRun, runQuery.data);
  const initialProjection = useMemo(
    () => observedRun
      ? createRunProjectionAtSequence(observedRun, observedRun.lastEventSequence)
      : null,
    // Identity changes reset the stream. Status changes are reconciled without discarding live details.
    [runIdentity],
  );
  const [projection, setProjection] = useState<RunProjectionState | null>(initialProjection);
  const [connectionState, setConnectionState] = useState<RunControllerConnectionState>("idle");
  const [error, setError] = useState<unknown>(null);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const projectionRef = useRef<RunProjectionState | null>(initialProjection);
  const cursorRef = useRef({ runIdentity, sequence: initialProjection?.lastSequence ?? 0 });
  const terminalRefreshRef = useRef<string | null>(null);

  useEffect(() => {
    projectionRef.current = initialProjection;
    cursorRef.current = { runIdentity, sequence: initialProjection?.lastSequence ?? 0 };
    terminalRefreshRef.current = null;
    setProjection(initialProjection);
  }, [initialProjection, runIdentity]);

  useEffect(() => () => prototypePatchProjector.dispose(), [prototypePatchProjector]);

  useEffect(() => {
    if (!observedRun || runIdentity === "none") return;

    const current = projectionRef.current;
    if (current && isTerminalStatus(current.status) && !isTerminalStatus(observedRun.status)) {
      return;
    }

    const observedStatus = observedRun.status;
    const terminal = isTerminalStatus(observedStatus);
    const reconciled = reconcileProjectionWithRun(current, observedRun, terminal);
    if (reconciled !== current) {
      projectionRef.current = reconciled;
      setProjection(reconciled);
    }
    if (!terminal) return;

    cursorRef.current = {
      runIdentity,
      sequence: Math.max(cursorRef.current.sequence, observedRun.lastEventSequence),
    };
    setConnectionState("closed");
    setError(null);
    queryClient.setQueryData<Run>(workbenchQueryKeys.run(observedRun.id), observedRun);
    prototypePatchProjector.settleTerminal(observedStatus);

    const terminalRefreshKey = [
      observedRun.id,
      observedRun.attempt,
      observedRun.status,
      observedRun.lastEventSequence,
    ].join(":");
    if (terminalRefreshRef.current === terminalRefreshKey) return;
    terminalRefreshRef.current = terminalRefreshKey;
    invalidateForTerminalRun(queryClient, observedRun);
  }, [observedRun, prototypePatchProjector, queryClient, runIdentity]);

  const observedRunIsTerminal = observedRun ? isTerminalStatus(observedRun.status) : false;

  useEffect(() => {
    const streamRun = selectLatestRun(
      run,
      run ? queryClient.getQueryData<Run>(workbenchQueryKeys.run(run.id)) : undefined,
    );
    if (!streamRun || !enabled || isTerminalStatus(streamRun.status)) {
      prototypePatchProjector.setScope(streamRun ? {
        attempt: streamRun.attempt,
        projectId: streamRun.projectId,
        requestId: streamRun.requestId,
        runId: streamRun.id,
      } : null);
      setConnectionState(streamRun && isTerminalStatus(streamRun.status) ? "closed" : "idle");
      return;
    }

    const abortController = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const afterSequence = cursorRef.current.runIdentity === runIdentity
      ? cursorRef.current.sequence
      : streamRun.lastEventSequence;
    let current = projectionRef.current?.runId === streamRun.id
      ? projectionRef.current
      : createRunProjectionAtSequence(streamRun, afterSequence);
    if (current.lastSequence !== afterSequence) {
      current = { ...current, lastSequence: afterSequence };
      projectionRef.current = current;
    }
    prototypePatchProjector.setScope({
      attempt: streamRun.attempt,
      projectId: streamRun.projectId,
      requestId: streamRun.requestId,
      runId: streamRun.id,
    });
    if (projectionRef.current !== current) projectionRef.current = current;
    setProjection(current);
    setError(null);

    void subscribeRunEvents({
      runId: streamRun.id,
      afterSequence,
      baseUrl,
      signal: abortController.signal,
      onStateChange: setConnectionState,
      onEvent(event) {
        current = reduceRunEvent(current, event);
        projectionRef.current = current;
        cursorRef.current = { runIdentity, sequence: current.lastSequence };
        prototypePatchProjector.ingest(event);
        const projectionOnlyEvent = isPrototypePatchProjectionEvent(event);
        if (current.lastSequence >= afterSequence && !projectionOnlyEvent) setProjection(current);
        if (!projectionOnlyEvent) updateRunCache(queryClient, streamRun, current);
        invalidateForRunEvent(queryClient, event);
      },
    }).catch((streamError: unknown) => {
      if (abortController.signal.aborted) return;
      setError(streamError);
      setConnectionState("closed");
      reconnectTimer = setTimeout(() => {
        const latest = queryClient.getQueryData<Run>(workbenchQueryKeys.run(streamRun.id));
        if (latest && isTerminalStatus(latest.status)) return;
        setSubscriptionVersion((value) => value + 1);
      }, RUN_STREAM_RECOVERY_DELAY_MS);
    });

    return () => {
      abortController.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [
    baseUrl,
    enabled,
    observedRunIsTerminal,
    prototypePatchProjector,
    queryClient,
    runIdentity,
    subscriptionVersion,
  ]);

  const reconnect = useCallback(() => setSubscriptionVersion((value) => value + 1), []);
  return { projection, prototypePatchProjector, connectionState, error, reconnect };
}

function selectLatestRun(
  ...candidates: Array<Run | null | undefined>
): Run | undefined {
  const identity = candidates.find((candidate): candidate is Run => Boolean(candidate));
  if (!identity) return undefined;

  return candidates.reduce<Run | undefined>((latest, candidate) => {
    if (!candidate || !hasSameRunIdentity(identity, candidate)) return latest;
    if (!latest || candidate.lastEventSequence > latest.lastEventSequence) return candidate;
    if (candidate.lastEventSequence < latest.lastEventSequence) return latest;
    if (isTerminalStatus(latest.status) && !isTerminalStatus(candidate.status)) return latest;
    return candidate;
  }, undefined);
}

function createRunProjectionAtSequence(run: Run, sequence: number): RunProjectionState {
  return {
    ...createRunProjection(run),
    lastSequence: sequence,
  };
}

function reconcileProjectionWithRun(
  current: RunProjectionState | null,
  run: Run,
  adoptSequence: boolean,
): RunProjectionState {
  if (!current || !hasSameProjectionIdentity(current, run)) {
    return createRunProjectionAtSequence(run, run.lastEventSequence);
  }

  const attemptChanged = current.attempt !== run.attempt;
  const terminal = isTerminalStatus(run.status);
  const clearsDrafts = attemptChanged || run.status === "failed" || run.status === "cancelled";
  return {
    ...current,
    status: run.status,
    lastSequence: adoptSequence
      ? Math.max(current.lastSequence, run.lastEventSequence)
      : current.lastSequence,
    phase: run.phase,
    phaseLabel: run.phaseLabel,
    progress: run.status === "succeeded" ? 1 : run.progress,
    attempt: run.attempt,
    generationStage: attemptChanged ? null : current.generationStage,
    generationStageAttempt: attemptChanged ? null : current.generationStageAttempt,
    draftArtifacts: clearsDrafts ? {} : current.draftArtifacts,
    draftArtifactOrder: clearsDrafts ? [] : current.draftArtifactOrder,
    pendingInputs: terminal ? {} : current.pendingInputs,
    pendingInputOrder: terminal ? [] : current.pendingInputOrder,
    failure: run.failure,
    cancellationReason: run.cancellationReason,
  };
}

function hasSameRunIdentity(left: Run, right: Run): boolean {
  return left.id === right.id
    && left.requestId === right.requestId
    && left.projectId === right.projectId
    && left.threadId === right.threadId;
}

function hasSameProjectionIdentity(projection: RunProjectionState, run: Run): boolean {
  return projection.runId === run.id
    && projection.requestId === run.requestId
    && projection.projectId === run.projectId
    && projection.threadId === run.threadId;
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

function invalidateForTerminalRun(
  queryClient: ReturnType<typeof useQueryClient>,
  run: Run,
): void {
  void Promise.all([
    queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.runLists(run.projectId, run.threadId),
    }),
    queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.entryLists(run.projectId, run.threadId),
    }),
    queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.board(run.projectId),
    }),
    queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.artifacts(run.projectId),
    }),
    queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.bootstraps(run.projectId),
    }),
  ]);
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

function isTerminalStatus(status: Run["status"]): status is TerminalRunStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isPrototypePatchProjectionEvent(event: RunEvent): boolean {
  return event.type === "artifact.prototype.patch.created"
    || event.type === "artifact.prototype.patch.degraded";
}
