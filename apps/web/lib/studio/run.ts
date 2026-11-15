"use client";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Run } from "@workbench/workbench-contracts";
import type { RunProjectionState } from "@/lib/workbench/run/reducer";
import { useWorkbenchRun } from "@/lib/workbench/features/runs";
import { useWorkbenchRunController } from "@/lib/workbench/features/run-controller";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";

export function projectedRun(
  run: Run | null | undefined,
  projection: RunProjectionState | null | undefined,
): Run | null {
  if (!run) return null;
  if (
    !projection ||
    projection.runId !== run.id ||
    projection.projectId !== run.projectId ||
    projection.requestId !== run.requestId ||
    projection.threadId !== run.threadId ||
    projection.lastSequence < run.lastEventSequence ||
    (projection.attempt ?? 0) < run.attempt
  )
    return run;
  return {
    ...run,
    status: projection.status,
    attempt: projection.attempt ?? run.attempt,
    phase: projection.phase,
    phaseLabel: projection.phaseLabel,
    progress: projection.progress,
    lastEventSequence: projection.lastSequence,
    failure: projection.failure,
    cancellationReason: projection.cancellationReason,
  };
}
export function isActiveRun(run: Run | null | undefined) {
  return Boolean(
    run && !["succeeded", "failed", "cancelled"].includes(run.status),
  );
}
export function useStudioRun(projectId: string, runId: string) {
  const client = useQueryClient(),
    query = useWorkbenchRun(runId),
    controller = useWorkbenchRunController({
      run: query.data?.projectId === projectId ? query.data : null,
      enabled: !!runId,
    });
  const run =
    query.data?.projectId === projectId
      ? projectedRun(query.data, controller.projection)
      : null;
  const refreshed = useRef("");
  useEffect(() => {
    if (!run || isActiveRun(run)) return;
    const key = `${run.id}:${run.attempt}:${run.status}:${run.lastEventSequence}`;
    if (refreshed.current === key) return;
    refreshed.current = key;
    void client.invalidateQueries({
      queryKey: workbenchQueryKeys.bootstraps(projectId),
    });
    void client.invalidateQueries({
      queryKey: workbenchQueryKeys.artifacts(projectId),
    });
  }, [run, client, projectId]);
  return {
    run,
    projection: controller.projection,
    connection: controller.connectionState,
    error:
      query.error ??
      (query.data && query.data.projectId !== projectId
        ? new Error("运行不属于当前项目")
        : controller.error),
    reconnect: () => {
      void query.refetch();
      controller.reconnect();
    },
  };
}
