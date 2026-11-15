"use client";

import type { PrototypeProgress, RunEvent } from "@workbench/workbench-contracts";
import { useEffect, useRef, useState } from "react";
import { createRunProjection, reduceRunEvent, type RunProjectionState } from "../../../run/reducer";
import { subscribeRunEvents } from "../../../run/stream";
import { useWorkbenchTransport } from "../../../transport/context";
import { useWorkbenchPrototypeV2Api } from "../api-adapter";

export function seedPrototypeProgress(snapshot: PrototypeProgress): RunProjectionState | null {
  if (!snapshot.run) return null;
  let state = createRunProjection(snapshot.run);
  for (const event of snapshot.events) state = reduceRunEvent({ ...state, lastSequence: event.sequence - 1 }, event);
  return { ...state, status: snapshot.run.status, lastSequence: snapshot.run.lastEventSequence, phase: snapshot.run.phase, phaseLabel: snapshot.run.phaseLabel, progress: snapshot.run.progress };
}

export function applyPrototypeProgress(state: RunProjectionState, event: RunEvent) {
  // Identity and sequence validation still run for stale attempts; consume their
  // cursor without allowing them to replace current content.
  if (event.runId !== state.runId || event.projectId !== state.projectId || event.requestId !== state.requestId || event.threadId !== state.threadId) throw new Error("PROGRESS_IDENTITY_MISMATCH");
  if (event.sequence <= state.lastSequence) return state;
  if (event.sequence !== state.lastSequence + 1) throw new Error("PROGRESS_SEQUENCE_GAP");
  if ("attempt" in event.payload && typeof event.payload.attempt === "number" && event.payload.attempt < (state.attempt ?? 0)) return { ...state, lastSequence: event.sequence };
  return reduceRunEvent(state, event);
}

export function useWorkbenchPrototypeProgress(projectId: string, planId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const { baseUrl } = useWorkbenchTransport();
  const [snapshot, setSnapshot] = useState<PrototypeProgress | null>(null);
  const [projection, setProjection] = useState<RunProjectionState | null>(null);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const identity = `${projectId}:${planId}`;
  const scope = useRef(identity); scope.current = identity;
  useEffect(() => {
    setSnapshot(null); setProjection(null); setError(undefined);
    if (!projectId || !planId) { setConnection("idle"); return; }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const valid = () => !abort.signal.aborted && scope.current === identity;
    const recover = async () => {
      if (!valid()) return;
      setConnection("connecting");
      try {
        const next = await api.getProgress(projectId, planId);
        if (!valid()) return;
        setSnapshot(next); setError(undefined);
        let state = seedPrototypeProgress(next);
        setProjection(state);
        if (!next.run || !state) {
          setConnection("idle");
          if (["approved", "generating"].includes(next.status)) timer = setTimeout(() => void recover(), 1500);
          return;
        }
        if (["succeeded", "failed", "cancelled"].includes(next.run.status)) {
          setConnection("closed");
          if (["approved", "generating"].includes(next.status)) timer = setTimeout(() => void recover(), 1500);
          return;
        }
        await subscribeRunEvents({ runId: next.run.id, afterSequence: next.run.lastEventSequence, baseUrl, signal: abort.signal, maxReconnectAttempts: 0,
          onStateChange: (value) => { if (valid()) setConnection(value); },
          onEvent: (event) => {
            if (!valid() || !state) return;
            const previous = state;
            state = applyPrototypeProgress(state, event);
            // Retain last valid draft on terminal failure; it remains explicitly a draft.
            if (["run.failed", "run.cancelled", "run.completed"].includes(event.type)) state = { ...state, generationPreviews: previous.generationPreviews };
            setProjection(state);
          },
        });
        if (valid()) timer = setTimeout(() => void recover(), 500);
      } catch (cause) {
        if (!valid()) return;
        const status = (cause as { status?: number }).status;
        setError(cause instanceof Error ? cause.message : "进度暂不可用");
        if (status === 401 || status === 403 || status === 404) { setSnapshot(null); setProjection(null); setConnection("denied"); return; }
        setConnection("reconnecting");
        timer = setTimeout(() => void recover(), 2000);
      }
    };
    void recover();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [api, baseUrl, identity, planId, projectId, retry]);
  return { snapshot: snapshot?.projectId === projectId && snapshot.planId === planId ? snapshot : null, projection: snapshot?.projectId === projectId && snapshot.planId === planId && projection?.runId === snapshot.run?.id ? projection : null, connection, error, reconnect: () => setRetry((value) => value + 1) };
}
